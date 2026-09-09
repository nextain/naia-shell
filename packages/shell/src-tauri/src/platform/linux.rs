//! Linux/Unix platform implementations.

use super::{PlatformHandle, PlatformWindowManager, WindowRect};
use std::path::PathBuf;
use std::process::{Child, Command};
use tauri::Manager;

/// Check if a process with the given PID is still running (Unix: kill(pid, 0)).
///
/// Permission errors mean the process exists but is not inspectable by this
/// Shell.  Treat those as alive so an inaccessible owner can never authorize
/// orphan cleanup by accident.
pub(crate) fn is_pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let result = unsafe { libc::kill(pid as i32, 0) };
    result == 0
        || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

/// Linux process start identity from boot ID plus `/proc/<pid>/stat`.
///
/// The command name is wrapped in parentheses and may itself contain a `)`;
/// split at the final closing parenthesis before indexing fields.  Field 22
/// (`starttime`) is stable for one PID lifetime and changes when the kernel
/// reuses that PID.  Including the boot ID prevents a persisted record from
/// matching a coincidentally identical PID/start-time pair after reboot.
pub(crate) fn process_identity(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    let boot_id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .ok()?
        .trim()
        .to_string();
    if boot_id.is_empty() {
        return None;
    }
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (_, fields) = stat.rsplit_once(')')?;
    let start_time = fields.split_whitespace().nth(19)?;
    start_time
        .parse::<u64>()
        .ok()
        .map(|value| format!("{boot_id}:{value}"))
}

pub(crate) fn replace_file_atomically(
    temporary: &std::path::Path,
    destination: &std::path::Path,
) -> std::io::Result<()> {
    std::fs::rename(temporary, destination)
}

#[derive(Debug, PartialEq, Eq)]
enum AgentProcessMarkerRead {
    Match,
    NoMatch,
    Missing,
    Inaccessible,
}

fn classify_agent_process_marker_read(
    result: std::io::Result<Vec<u8>>,
    marker: &str,
) -> Result<AgentProcessMarkerRead, String> {
    match result {
        Ok(bytes)
            if bytes
                .split(|byte| *byte == 0)
                .any(|arg| arg == marker.as_bytes()) =>
        {
            Ok(AgentProcessMarkerRead::Match)
        }
        Ok(_) => Ok(AgentProcessMarkerRead::NoMatch),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(AgentProcessMarkerRead::Missing)
        }
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            Ok(AgentProcessMarkerRead::Inaccessible)
        }
        Err(_) => Err("agent_lease_identity_query_failed".to_string()),
    }
}

fn agent_process_marker_with<R>(pid: u32, marker: &str, read: R) -> Result<Option<bool>, String>
where
    R: FnOnce(u32) -> std::io::Result<Vec<u8>>,
{
    match classify_agent_process_marker_read(read(pid), marker)? {
        AgentProcessMarkerRead::Match => Ok(Some(true)),
        AgentProcessMarkerRead::NoMatch => Ok(Some(false)),
        AgentProcessMarkerRead::Missing => Ok(None),
        // The known lease PID is an ownership boundary. Never treat an
        // inaccessible identity as absent or allow PID reuse to pass silently.
        AgentProcessMarkerRead::Inaccessible => {
            Err("agent_lease_identity_query_failed".to_string())
        }
    }
}

pub(crate) fn agent_process_marker(pid: u32, marker: &str) -> Result<Option<bool>, String> {
    agent_process_marker_with(pid, marker, |pid| {
        std::fs::read(format!("/proc/{pid}/cmdline"))
    })
}

pub(crate) fn reap_orphaned_agent_process(_pid: u32, _marker: &str) -> Result<bool, String> {
    Ok(false)
}

fn find_agent_process_by_marker_with<I, R>(
    pids: I,
    marker: &str,
    mut read: R,
) -> Result<bool, String>
where
    I: IntoIterator<Item = u32>,
    R: FnMut(u32) -> std::io::Result<Vec<u8>>,
{
    for pid in pids {
        match classify_agent_process_marker_read(read(pid), marker)? {
            AgentProcessMarkerRead::Match => return Ok(true),
            AgentProcessMarkerRead::NoMatch
            | AgentProcessMarkerRead::Missing
            | AgentProcessMarkerRead::Inaccessible => {}
        }
    }
    Ok(false)
}

pub(crate) fn find_agent_process_by_marker(marker: &str) -> Result<bool, String> {
    let entries =
        std::fs::read_dir("/proc").map_err(|_| "agent_lease_identity_query_failed".to_string())?;
    let pids = entries
        .map(|entry| {
            entry
                .map_err(|_| "agent_lease_identity_query_failed".to_string())
                .map(|entry| {
                    entry
                        .file_name()
                        .to_str()
                        .and_then(|value| value.parse::<u32>().ok())
                })
        })
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten();
    find_agent_process_by_marker_with(pids, marker, |pid| {
        std::fs::read(format!("/proc/{pid}/cmdline"))
    })
}

#[cfg(test)]
mod agent_process_marker_tests {
    use super::*;

    #[test]
    fn enumeration_skips_inaccessible_and_missing_unrelated_processes() {
        let result = find_agent_process_by_marker_with([10, 11, 12], "--owned", |pid| match pid {
            10 => Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "hidden",
            )),
            11 => Err(std::io::Error::new(std::io::ErrorKind::NotFound, "exited")),
            _ => Ok(b"node\0--other\0".to_vec()),
        });
        assert_eq!(result, Ok(false));
    }

    #[test]
    fn enumeration_finds_owned_marker_after_inaccessible_process() {
        let result = find_agent_process_by_marker_with([10, 11], "--owned", |pid| {
            if pid == 10 {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "hidden",
                ))
            } else {
                Ok(b"node\0--owned\0".to_vec())
            }
        });
        assert_eq!(result, Ok(true));
    }

    #[test]
    fn known_owned_pid_remains_fail_closed_when_inaccessible() {
        let result = agent_process_marker_with(10, "--owned", |_| {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "hidden",
            ))
        });
        assert_eq!(result, Err("agent_lease_identity_query_failed".to_string()));
    }

    #[test]
    fn enumeration_propagates_unexpected_proc_errors() {
        let result = find_agent_process_by_marker_with([10], "--owned", |_| {
            Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "broken",
            ))
        });
        assert_eq!(result, Err("agent_lease_identity_query_failed".to_string()));
    }
}

/// Spawn a no-op child process (Unix: /bin/true).
pub(crate) fn dummy_child() -> Result<Child, String> {
    Command::new("true")
        .spawn()
        .map_err(|e| format!("Failed to create dummy process: {}", e))
}

/// Suppress console window (Unix: no-op — Unix processes don't create console windows).
pub(crate) fn hide_console(_cmd: &mut Command) {}

/// Clean up orphan processes from a previous session (Unix: SIGTERM → SIGKILL).
/// Force-terminate a process by PID using SIGKILL (libc::kill).
pub(crate) fn terminate_pid(pid: u32) {
    let signed_pid = match i32::try_from(pid) {
        Ok(p) if p > 0 => p,
        _ => return,
    };
    unsafe {
        libc::kill(signed_pid, libc::SIGTERM);
    }
}

pub(crate) fn kill_pid(pid: u32) {
    let signed_pid = match i32::try_from(pid) {
        Ok(p) if p > 0 => p,
        _ => return,
    };
    unsafe {
        libc::kill(signed_pid, libc::SIGKILL);
    }
}

/// Put the Cascade supervisor in a private process group before it is
/// started.  The loader inherits this group, so teardown can be scoped to the
/// one Shell-owned tree without matching a process name or killing a shared
/// Cascade adopted by another Shell.
pub(crate) fn prepare_cascade_command(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;

    // SAFETY: `pre_exec` runs in the child between fork and exec.  The closure
    // only calls the async-signal-safe setpgid(2) operation and reports its
    // errno back through spawn().
    unsafe {
        cmd.pre_exec(|| {
            if libc::setpgid(0, 0) == -1 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
}

pub(crate) struct CascadeOwnership {
    pgid: libc::pid_t,
}

/// Confirm that the supervisor owns a process group whose id is its PID.  A
/// failed check refuses the launch rather than leaving descendants untracked.
pub(crate) fn claim_cascade_process(pid: u32) -> Result<CascadeOwnership, String> {
    let signed_pid = i32::try_from(pid).map_err(|_| "invalid Cascade PID".to_string())?;
    if signed_pid <= 1 {
        return Err("invalid Cascade process-group PID".to_string());
    }
    let pgid = unsafe { libc::getpgid(signed_pid) };
    if pgid != signed_pid {
        return Err(format!(
            "Cascade supervisor did not enter its private process group (pid={pid})"
        ));
    }
    Ok(CascadeOwnership { pgid })
}

fn cascade_signal(ownership: Option<&CascadeOwnership>, pid: u32, signal: libc::c_int) {
    let signed_pid = match i32::try_from(pid) {
        Ok(value) if value > 1 => value,
        _ => return,
    };
    let group = ownership
        .map(|value| value.pgid)
        .filter(|value| *value == signed_pid)
        .or_else(|| {
            let observed = unsafe { libc::getpgid(signed_pid) };
            (observed == signed_pid).then_some(observed)
        });
    unsafe {
        if let Some(pgid) = group {
            // A negative PID targets one process group.  The group identity is
            // checked above, so this cannot fan out to an unrelated group.
            libc::kill(-pgid, signal);
        } else {
            // Records written by an older build may predate process groups;
            // retain exact-PID cleanup for those records only.
            libc::kill(signed_pid, signal);
        }
    }
}

pub(crate) fn terminate_cascade(ownership: Option<&CascadeOwnership>, pid: u32) {
    cascade_signal(ownership, pid, libc::SIGTERM);
}

pub(crate) fn kill_cascade(ownership: Option<&CascadeOwnership>, pid: u32) {
    cascade_signal(ownership, pid, libc::SIGKILL);
}

/// PID of the process listening on a local TCP port, if any (FR-BGM.13 #517).
/// Parses `ss -ltnpH` (iproute2): `... users:(("node",pid=1234,fd=18))`.
pub(crate) fn pid_listening_on_port(port: u16) -> Option<u32> {
    let output = Command::new("ss")
        .args(["-ltnpH", &format!("sport = :{port}")])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let idx = text.find("pid=")?;
    text[idx + 4..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .ok()
}

/// Full command line of a PID, if the process exists (NUL args joined by spaces).
pub(crate) fn pid_command_line(pid: u32) -> Option<String> {
    let bytes = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let text = bytes
        .split(|byte| *byte == 0)
        .filter(|arg| !arg.is_empty())
        .map(|arg| String::from_utf8_lossy(arg).to_string())
        .collect::<Vec<_>>()
        .join(" ");
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

pub(crate) fn cleanup_orphan_processes() {
    for component in &["gateway", "node-host", "bgm-server", "cascade", "voxcpm2"] {
        let _ = crate::with_process_record_lock(component, || {
            let Some(record) = crate::read_process_record(component) else {
                // Legacy bare PID files and malformed/unverifiable records
                // are deliberately left for diagnostics; they authorize no
                // process operation.
                return;
            };
            if !crate::process_record_owner_is_dead(&record)
                || !crate::process_record_matches(component, &record)
                // Re-read both identities after the record check and right
                // before the first signal; the PID may have been reused
                // between the initial observation and this operation.
                || !crate::process_record_can_be_reaped(&record)
            {
                return;
            }

            let pid = record.child_pid;
            crate::log_verbose(&format!(
                "[Naia] Orphan {component} found (PID {pid}) — sending SIGTERM"
            ));
            if *component == "cascade" {
                // Persisted Cascade records have no live ownership handle, so
                // recover the supervisor's private process group from its PID.
                terminate_cascade(None, pid);
            } else {
                terminate_pid(pid);
            }
            std::thread::sleep(std::time::Duration::from_millis(500));

            // Revalidate owner and record before escalation.  Never escalate
            // a PID that was reused meanwhile.  If TERM already made the
            // exact child disappear, remove only the still-matching record;
            // an inaccessible/live PID remains protected.
            if !crate::process_record_matches(component, &record)
                || !crate::process_record_owner_is_dead(&record)
            {
                return;
            }
            if !crate::process_record_can_be_reaped(&record) {
                if !is_pid_alive(pid)
                    && !crate::process_record_child_is_exact(&record)
                    && crate::process_record_matches(component, &record)
                {
                    let _ = crate::remove_process_record_if_matches_locked(component, &record);
                }
                return;
            }
            if is_pid_alive(pid) {
                crate::log_verbose(&format!(
                    "[Naia] Orphan {component} still alive (PID {pid}) — sending SIGKILL"
                ));
                if *component == "cascade" {
                    kill_cascade(None, pid);
                } else {
                    kill_pid(pid);
                }
            }
            // The exact identity was observed before termination.  Removal is
            // safe only once that identity is gone and the PID is not alive.
            if !is_pid_alive(pid)
                && !crate::process_record_child_is_exact(&record)
                && crate::process_record_matches(component, &record)
            {
                let _ = crate::remove_process_record_if_matches_locked(component, &record);
            }
        });
    }
}

/// Name-based orphan cleanup is intentionally disabled.  Only an exact,
/// owner-dead PID record can authorize a process operation.
pub(crate) fn kill_stale_gateway() {
    crate::log_verbose("[Naia] Skipping global gateway process matching");
}

/// Name-based Cascade cleanup is intentionally disabled.  A healthy Cascade
/// can be shared by another Shell (FR-SHELL-ISO.1), and crash-grandchild
/// cleanup remains a later process-group design task.
pub(crate) fn kill_stale_cascade() {
    crate::log_verbose("[Naia] Skipping global Cascade process matching");
}

pub(crate) fn kill_stale_voxcpm2() {
    crate::log_verbose("[Naia] Skipping global VoxCPM2 process matching");
}

/// Find Node.js via Unix version managers (nvm).
pub(crate) fn find_node_version_manager(home: &str) -> Option<PathBuf> {
    let nvm_dirs = [
        format!("{}/.nvm/versions/node", home),
        format!("{}/.config/nvm/versions/node", home),
    ];
    for nvm_dir in &nvm_dirs {
        if let Ok(entries) = std::fs::read_dir(nvm_dir) {
            let mut versions: Vec<_> = entries
                .filter_map(|e| e.ok())
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    let major: u32 = name
                        .trim_start_matches('v')
                        .split('.')
                        .next()?
                        .parse()
                        .ok()?;
                    if major >= 22 {
                        Some((major, e.path()))
                    } else {
                        None
                    }
                })
                .collect();
            versions.sort_by(|a, b| b.0.cmp(&a.0));
            if let Some((_, path)) = versions.first() {
                let node_bin = path.join("bin/node");
                if node_bin.exists() {
                    return Some(node_bin);
                }
            }
        }
    }
    None
}

/// Well-known Node.js install paths (Linux: not applicable — relies on PATH).
pub(crate) fn find_node_well_known_paths() -> Option<PathBuf> {
    None
}

/// Platform npm command name.
pub(crate) fn npm_command() -> &'static str {
    "npm"
}

/// Find the Node.js runtime staged beside the installed application resources.
pub(crate) fn find_bundled_node(app_handle: &tauri::AppHandle) -> Option<PathBuf> {
    let candidate = app_handle.path().resource_dir().ok()?.join("node");
    candidate
        .exists()
        .then(|| dunce::canonicalize(&candidate).unwrap_or(candidate))
}

/// Platform-specific gateway spawn (Linux: use default flow).
/// Resolve `npx` command name (Linux: just "npx").
pub(crate) fn resolve_npx() -> String {
    "npx".to_string()
}

/// Snapshot currently-visible Chrome window IDs (Linux: no-op, X11 handles reparent reliably).
pub(crate) fn snapshot_chrome_hwnds() -> Vec<isize> {
    Vec::new()
}

/// Find the newly-spawned Chrome window — on Linux we delegate to the existing
/// PID-based lookup since X11 process→window mapping is reliable via xdotool.
/// The `baseline` parameter is ignored (only Windows needs the diff).
pub(crate) fn find_new_chrome_window(
    _baseline: &[isize],
    timeout_ms: u64,
) -> Result<super::PlatformHandle, String> {
    let wm = X11WindowManager;
    super::PlatformWindowManager::find_window_by_pid(&wm, 0, timeout_ms).or_else(|_| {
        for frag in &["google-chrome", "chromium"] {
            if let Some(xid) = find_by_class(frag) {
                return Ok(super::PlatformHandle::X11(xid));
            }
        }
        Err("No Chrome window found".to_string())
    })
}

/// Resolve tsx as a direct node invocation from agent's node_modules.
/// Returns `(node_exe, tsx_cli_mjs_path)` if found, `None` otherwise.
///
/// Mirrors the Windows implementation so `spawn_agent_core` has one cross-platform
/// code path. Using node directly avoids `npx`'s shell lookup entirely.
pub(crate) fn resolve_tsx_from_agent(agent_dir: &std::path::Path) -> Option<(String, String)> {
    let pnpm_dir = agent_dir.join("node_modules").join(".pnpm");
    if pnpm_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&pnpm_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("tsx@") {
                    let cli_mjs = entry
                        .path()
                        .join("node_modules")
                        .join("tsx")
                        .join("dist")
                        .join("cli.mjs");
                    if cli_mjs.exists() {
                        return Some(("node".to_string(), cli_mjs.to_string_lossy().to_string()));
                    }
                }
            }
        }
    }
    None
}

/// Start deep link file watcher (Linux: no-op — single-instance IPC works).
pub(crate) fn start_deep_link_file_watcher(_app_handle: tauri::AppHandle) {}

/// Normalize a path (Linux: no-op, no extended-length prefix issues).
pub(crate) fn normalize_path(path: &std::path::Path) -> PathBuf {
    path.to_path_buf()
}

// ─── Browser window embedding (X11) ──────────────────────────────────────────

pub struct X11WindowManager;

fn x11_connect() -> Result<(x11rb::rust_connection::RustConnection, usize), String> {
    x11rb::rust_connection::RustConnection::connect(Some(":0"))
        .map_err(|e| format!("X11 connect failed: {e}"))
}

fn x11_window_area(conn: &x11rb::rust_connection::RustConnection, xid: u32) -> Option<u32> {
    use x11rb::protocol::xproto::ConnectionExt as _;
    let geom = conn.get_geometry(xid).ok()?.reply().ok()?;
    Some(geom.width as u32 * geom.height as u32)
}

fn find_by_class(fragment: &str) -> Option<u32> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::*;
    let (conn, sn) = x11rb::rust_connection::RustConnection::connect(Some(":0")).ok()?;
    let root = conn.setup().roots[sn].root;
    let net_list = conn
        .intern_atom(false, b"_NET_CLIENT_LIST")
        .ok()?
        .reply()
        .ok()?
        .atom;
    let wm_class = conn
        .intern_atom(false, b"WM_CLASS")
        .ok()?
        .reply()
        .ok()?
        .atom;
    let windows: Vec<u32> = conn
        .get_property(false, root, net_list, AtomEnum::ANY, 0, 4096)
        .ok()?
        .reply()
        .ok()?
        .value32()?
        .collect();
    let frag = fragment.to_lowercase();
    let mut best: Option<(u32, u32)> = None;
    for w in windows {
        if let Some(p) = conn
            .get_property(false, w, wm_class, AtomEnum::STRING, 0, 256)
            .ok()
            .and_then(|c| c.reply().ok())
        {
            if String::from_utf8_lossy(&p.value)
                .to_lowercase()
                .contains(&frag)
            {
                let area = x11_window_area(&conn, w).unwrap_or(0);
                if best.map_or(true, |(_, a)| area > a) {
                    best = Some((w, area));
                }
            }
        }
    }
    best.map(|(xid, _)| xid)
}

fn find_by_name(name: &str) -> Option<u32> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::*;
    let (conn, sn) = x11rb::rust_connection::RustConnection::connect(Some(":0")).ok()?;
    let root = conn.setup().roots[sn].root;
    let net_list = conn
        .intern_atom(false, b"_NET_CLIENT_LIST")
        .ok()?
        .reply()
        .ok()?
        .atom;
    let wm_name = conn.intern_atom(false, b"WM_NAME").ok()?.reply().ok()?.atom;
    let net_wm_name = conn
        .intern_atom(false, b"_NET_WM_NAME")
        .ok()?
        .reply()
        .ok()?
        .atom;
    let utf8 = conn
        .intern_atom(false, b"UTF8_STRING")
        .ok()?
        .reply()
        .ok()?
        .atom;
    let windows: Vec<u32> = conn
        .get_property(false, root, net_list, AtomEnum::ANY, 0, 4096)
        .ok()?
        .reply()
        .ok()?
        .value32()?
        .collect();
    let mut best: Option<(u32, u32)> = None;
    for w in windows {
        let title = conn
            .get_property(false, w, net_wm_name, utf8, 0, 256)
            .ok()
            .and_then(|c| c.reply().ok())
            .filter(|p| !p.value.is_empty())
            .or_else(|| {
                conn.get_property(false, w, wm_name, AtomEnum::STRING, 0, 256)
                    .ok()
                    .and_then(|c| c.reply().ok())
            })
            .map(|p| String::from_utf8_lossy(&p.value).trim().to_string());
        if title.as_deref() == Some(name) {
            let area = x11_window_area(&conn, w).unwrap_or(0);
            if best.map_or(true, |(_, a)| area > a) {
                best = Some((w, area));
            }
        }
    }
    best.map(|(xid, _)| xid)
}

impl PlatformWindowManager for X11WindowManager {
    fn find_window_by_pid(&self, pid: u32, timeout_ms: u64) -> Result<PlatformHandle, String> {
        let attempts = (timeout_ms / 500).max(1);
        for _ in 0..attempts {
            if let Ok(out) = Command::new("xdotool")
                .args(["search", "--pid", &pid.to_string()])
                .env("DISPLAY", ":0")
                .output()
            {
                let ids: Vec<u32> = String::from_utf8_lossy(&out.stdout)
                    .split_whitespace()
                    .filter_map(|t| t.parse().ok())
                    .collect();
                if let Some(&xid) = ids.first() {
                    return Ok(PlatformHandle::X11(xid));
                }
            }
            for frag in &["google-chrome", "chromium"] {
                if let Some(xid) = find_by_class(frag) {
                    return Ok(PlatformHandle::X11(xid));
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        Err(format!(
            "Chrome X11 window not found for PID {pid} within {timeout_ms} ms"
        ))
    }

    fn find_window_by_name(&self, name: &str, timeout_ms: u64) -> Result<PlatformHandle, String> {
        let attempts = (timeout_ms / 500).max(1);
        for attempt in 0..attempts {
            if let Ok(out) = Command::new("xdotool")
                .args(["search", "--name", &format!("^{name}$")])
                .env("DISPLAY", ":0")
                .output()
            {
                let ids: Vec<u32> = String::from_utf8_lossy(&out.stdout)
                    .split_whitespace()
                    .filter_map(|t| t.parse().ok())
                    .collect();
                if !ids.is_empty() {
                    if let Ok((conn, _)) = x11_connect() {
                        if let Some(xid) = ids
                            .iter()
                            .copied()
                            .max_by_key(|&x| x11_window_area(&conn, x).unwrap_or(0))
                        {
                            return Ok(PlatformHandle::X11(xid));
                        }
                    } else if let Some(&xid) = ids.first() {
                        return Ok(PlatformHandle::X11(xid));
                    }
                }
            }
            if let Some(xid) = find_by_name(name) {
                return Ok(PlatformHandle::X11(xid));
            }
            std::thread::sleep(std::time::Duration::from_millis(if attempt == 0 {
                1000
            } else {
                500
            }));
        }
        Err(format!("Window '{name}' not found within {timeout_ms} ms"))
    }

    fn embed(
        &self,
        parent: PlatformHandle,
        child: PlatformHandle,
        rect: WindowRect,
    ) -> Result<(), String> {
        use x11rb::connection::Connection;
        use x11rb::protocol::xproto::*;
        let PlatformHandle::X11(parent_xid) = parent else {
            return Err("not X11".into());
        };
        let PlatformHandle::X11(child_xid) = child else {
            return Err("not X11".into());
        };
        let (conn, _) = x11_connect()?;
        let bg = ChangeWindowAttributesAux::new().background_pixel(0x00202124);
        conn.change_window_attributes(parent_xid, &bg).ok();
        conn.change_window_attributes(child_xid, &bg).ok();
        conn.unmap_window(child_xid)
            .map_err(|e| format!("unmap: {e}"))?;
        conn.flush().ok();
        std::thread::sleep(std::time::Duration::from_millis(50));
        conn.reparent_window(child_xid, parent_xid, rect.x as i16, rect.y as i16)
            .map_err(|e| format!("reparent: {e}"))?;
        conn.configure_window(
            child_xid,
            &ConfigureWindowAux::new()
                .x(rect.x)
                .y(rect.y)
                .width(rect.width)
                .height(rect.height)
                .border_width(0u32),
        )
        .map_err(|e| format!("configure: {e}"))?;
        conn.map_window(child_xid)
            .map_err(|e| format!("map: {e}"))?;
        conn.set_input_focus(InputFocus::PARENT, child_xid, x11rb::CURRENT_TIME)
            .map_err(|e| format!("focus: {e}"))?;
        conn.flush().map_err(|e| format!("flush: {e}"))?;
        Ok(())
    }

    fn remap(&self, handle: PlatformHandle, rect: WindowRect) -> Result<(), String> {
        use x11rb::connection::Connection;
        use x11rb::protocol::xproto::*;
        let PlatformHandle::X11(xid) = handle else {
            return Err("not X11".into());
        };
        let (conn, _) = x11_connect()?;
        conn.configure_window(
            xid,
            &ConfigureWindowAux::new()
                .x(rect.x)
                .y(rect.y)
                .width(rect.width)
                .height(rect.height)
                .border_width(0u32),
        )
        .map_err(|e| format!("configure: {e}"))?;
        conn.map_window(xid).map_err(|e| format!("map: {e}"))?;
        conn.set_input_focus(InputFocus::PARENT, xid, x11rb::CURRENT_TIME)
            .map_err(|e| format!("focus: {e}"))?;
        conn.flush().map_err(|e| format!("flush: {e}"))?;
        Ok(())
    }

    fn resize(&self, handle: PlatformHandle, rect: WindowRect) -> Result<(), String> {
        use x11rb::connection::Connection;
        use x11rb::protocol::xproto::*;
        let PlatformHandle::X11(xid) = handle else {
            return Err("not X11".into());
        };
        let (conn, _) = x11_connect()?;
        conn.configure_window(
            xid,
            &ConfigureWindowAux::new()
                .x(rect.x)
                .y(rect.y)
                .width(rect.width)
                .height(rect.height),
        )
        .map_err(|e| format!("configure: {e}"))?;
        conn.flush().map_err(|e| format!("flush: {e}"))?;
        Ok(())
    }

    fn focus(&self, handle: PlatformHandle) -> Result<(), String> {
        use x11rb::connection::Connection;
        use x11rb::protocol::xproto::*;
        let PlatformHandle::X11(xid) = handle else {
            return Ok(());
        };
        let (conn, _) = x11_connect()?;
        conn.set_input_focus(InputFocus::PARENT, xid, x11rb::CURRENT_TIME)
            .map_err(|e| format!("{e}"))?;
        conn.flush().map_err(|e| format!("{e}"))?;
        Ok(())
    }

    fn show(&self, handle: PlatformHandle) -> Result<(), String> {
        use x11rb::connection::Connection;
        use x11rb::protocol::xproto::*;
        let PlatformHandle::X11(xid) = handle else {
            return Ok(());
        };
        if let Ok((conn, _)) = x11_connect() {
            let _ = conn.map_window(xid);
            let _ = conn.set_input_focus(InputFocus::PARENT, xid, x11rb::CURRENT_TIME);
            let _ = conn.flush();
        }
        Ok(())
    }

    fn hide(&self, handle: PlatformHandle) -> Result<(), String> {
        use x11rb::connection::Connection;
        use x11rb::protocol::xproto::ConnectionExt as _;
        let PlatformHandle::X11(xid) = handle else {
            return Ok(());
        };
        if let Ok((conn, _)) = x11_connect() {
            let _ = conn.unmap_window(xid);
            let _ = conn.flush();
        }
        Ok(())
    }

    fn chrome_bin(&self) -> Option<String> {
        // 1. Chrome for Testing (installed by agent-browser install) — preferred
        let home = crate::data_home::unix_home();
        if !home.is_empty() {
            let base = std::path::PathBuf::from(&home)
                .join(".agent-browser")
                .join("browsers");
            if let Ok(entries) = std::fs::read_dir(&base) {
                let mut dirs: Vec<_> = entries
                    .flatten()
                    .filter(|e| e.file_name().to_string_lossy().starts_with("chrome-"))
                    .collect();
                dirs.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
                for entry in dirs {
                    #[cfg(target_os = "macos")]
                    let bin = entry.path().join(
                        "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
                    );
                    #[cfg(not(target_os = "macos"))]
                    let bin = entry.path().join("chrome");
                    if bin.exists() {
                        return Some(bin.to_string_lossy().to_string());
                    }
                }
            }
        }

        // 2. Check native PATH (works for RPM/deb installed Chrome)
        for name in &["google-chrome", "chromium", "chromium-browser"] {
            if let Ok(out) = Command::new("which").arg(name).output() {
                if out.status.success() {
                    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !p.is_empty() {
                        return Some(p);
                    }
                }
            }
        }
        // 2. Flatpak Chrome — checked regardless of whether Naia itself is a Flatpak.
        //    On immutable distros (Bazzite, Silverblue) Chrome is typically installed
        //    via Flatpak even when Naia runs natively.
        let is_naia_flatpak = std::env::var("FLATPAK").is_ok();
        if is_naia_flatpak {
            // Inside Flatpak sandbox: must use flatpak-spawn --host to reach the host
            for name in &["google-chrome", "chromium", "chromium-browser"] {
                if let Ok(out) = Command::new("flatpak-spawn")
                    .args(["--host", "which", name])
                    .output()
                {
                    if out.status.success() {
                        let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
                        if !p.is_empty() {
                            return Some(p);
                        }
                    }
                }
            }
            for app_id in &["com.google.Chrome", "org.chromium.Chromium"] {
                let installed = Command::new("flatpak-spawn")
                    .args(["--host", "flatpak", "info", app_id])
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false);
                if installed {
                    return Some(format!("flatpak::{app_id}"));
                }
            }
        } else {
            // Native mode: query Flatpak directly
            for app_id in &["com.google.Chrome", "org.chromium.Chromium"] {
                let installed = Command::new("flatpak")
                    .args(["info", app_id])
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false);
                if installed {
                    return Some(format!("flatpak::{app_id}"));
                }
            }
        }
        None
    }

    fn supports_native_embed(&self) -> bool {
        true
    }

    fn chrome_spawn_args(&self) -> (Vec<String>, Vec<(String, String)>) {
        (
            vec!["--ozone-platform=x11".into()],
            vec![
                ("DISPLAY".into(), ":0".into()),
                ("GDK_BACKEND".into(), "x11".into()),
            ],
        )
    }

    fn kill_lingering_chrome(&self) {
        // Never terminate browser processes by command-line name: a second
        // Shell or a user-owned browser may share the same profile pattern.
        crate::log_verbose("[Naia] Skipping global Chrome process matching");
    }
}
