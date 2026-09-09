//! macOS platform implementations.
#![allow(dead_code)]

use super::{PlatformHandle, PlatformWindowManager, WindowRect};
use std::path::{Path, PathBuf};
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

/// macOS process start identity from `proc_pidinfo`.
pub(crate) fn process_identity(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_bsdinfo>();
    let result = unsafe {
        libc::proc_pidinfo(
            i32::try_from(pid).ok()?,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            i32::try_from(size).ok()?,
        )
    };
    if result != i32::try_from(size).ok()? {
        return None;
    }
    let info = unsafe { info.assume_init() };
    Some(format!("{}:{}", info.pbi_start_tvsec, info.pbi_start_tvusec))
}

pub(crate) fn replace_file_atomically(
    temporary: &Path,
    destination: &Path,
) -> std::io::Result<()> {
    std::fs::rename(temporary, destination)
}

pub(crate) fn agent_process_marker(pid: u32, marker: &str) -> Result<Option<bool>, String> {
    let output = Command::new("ps")
        .args(["-ww", "-p", &pid.to_string(), "-o", "command="])
        .output()
        .map_err(|_| "agent_lease_identity_query_failed".to_string())?;
    if output.status.success() {
        return Ok(Some(
            String::from_utf8_lossy(&output.stdout)
                .split_whitespace()
                .any(|arg| arg == marker),
        ));
    }
    if unsafe { libc::kill(pid as i32, 0) } != 0
        && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    {
        Ok(None)
    } else {
        Err("agent_lease_identity_query_failed".to_string())
    }
}

pub(crate) fn reap_orphaned_agent_process(_pid: u32, _marker: &str) -> Result<bool, String> {
    Ok(false)
}

pub(crate) fn find_agent_process_by_marker(marker: &str) -> Result<bool, String> {
    let output = Command::new("ps")
        .args(["-ww", "-axo", "pid=,command="])
        .output()
        .map_err(|_| "agent_lease_identity_query_failed".to_string())?;
    if !output.status.success() {
        return Err("agent_lease_identity_query_failed".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .any(|line| line.split_whitespace().skip(1).any(|arg| arg == marker)))
}

/// Spawn a no-op child process (Unix: /usr/bin/true).
pub(crate) fn dummy_child() -> Result<Child, String> {
    Command::new("true")
        .spawn()
        .map_err(|e| format!("Failed to create dummy process: {}", e))
}

/// Suppress console window (macOS: no-op).
pub(crate) fn hide_console(_cmd: &mut Command) {}

/// Force-terminate a process by PID using SIGKILL.
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

/// Keep the Cascade supervisor and its loader children in one private process
/// group so teardown remains scoped to this Shell instance.
pub(crate) fn prepare_cascade_command(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;

    // SAFETY: `pre_exec` only invokes the async-signal-safe setpgid(2) call in
    // the child between fork and exec.
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
            libc::kill(-pgid, signal);
        } else {
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
pub(crate) fn pid_listening_on_port(port: u16) -> Option<u32> {
    let output = Command::new("lsof")
        .args([
            "-nP",
            "-t",
            &format!("-iTCP:{port}"),
            "-sTCP:LISTEN",
        ])
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()?
        .trim()
        .parse()
        .ok()
}

/// Full command line of a PID, if the process exists.
pub(crate) fn pid_command_line(pid: u32) -> Option<String> {
    let output = Command::new("ps")
        .args(["-ww", "-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Clean up orphan processes from a previous session.
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

/// Find Node.js via Unix version managers.
pub(crate) fn find_node_version_manager(_home: &str) -> Option<PathBuf> {
    None
}

/// Well-known Node.js install paths for macOS GUI contexts.
pub(crate) fn find_node_well_known_paths() -> Option<PathBuf> {
    for candidate in &[
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ] {
        let path = PathBuf::from(candidate);
        if path.exists() {
            return Some(path);
        }
    }
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

/// Get platform tier info.
pub(crate) fn get_platform_tier_info() -> serde_json::Value {
    serde_json::json!({
        "platform": "macos",
        "tier": 2,
        "wsl": false,
        "distro": false
    })
}

/// Auto-setup WSL (macOS: not applicable).
pub(crate) fn setup_wsl_environment(_app_handle: &tauri::AppHandle) -> Result<String, String> {
    Err("WSL setup is only available on Windows".to_string())
}

/// Kill Naia Gateway processes inside WSL (macOS: no-op).
pub(crate) fn kill_wsl_gateway_processes() {}

/// Whether to skip Gateway config sync.
pub(crate) fn should_skip_gateway_sync() -> bool {
    false
}

/// Resolve `npx` command name.
pub(crate) fn resolve_npx() -> String {
    "npx".to_string()
}

/// Snapshot currently-visible Chrome windows (macOS embedding is not implemented).
pub(crate) fn snapshot_chrome_hwnds() -> Vec<isize> {
    Vec::new()
}

/// Find newly-spawned Chrome window (macOS embedding is not implemented).
pub(crate) fn find_new_chrome_window(
    _baseline: &[isize],
    _timeout_ms: u64,
) -> Result<super::PlatformHandle, String> {
    Err("Chrome window embedding is not implemented on macOS".to_string())
}

/// Resolve tsx as a direct node invocation from agent's node_modules.
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

fn pending_deep_link_path() -> PathBuf {
    crate::data_home::direct_child(crate::data_home::DataHomeChild::DeepLinkPending)
}

#[cfg(debug_assertions)]
fn ensure_dev_deep_link_helper() {
    let home = crate::data_home::user_home();
    if home.is_empty() {
        return;
    }
    let helper_root =
        crate::data_home::direct_child(crate::data_home::DataHomeChild::DevDeepLink);
    let helper_app = helper_root.join("NaiaDevDeepLink.app");
    let script_path = helper_root.join("NaiaDevDeepLink.applescript");
    let _ = std::fs::create_dir_all(&helper_root);

    // 스크립트 안의 자리 이름도 이름표에서 받는다 — 여기만 문자열로 적으면
    // 데이터 홈 경계 검사가 못 보는 자리가 하나 남는다. 데이터 홈 이름은
    // 깔때기 밖에 없으므로 두 조각을 통째로 받는다.
    let (data_home_dir, pending) = crate::data_home::deep_link_helper_script_paths();
    let script = format!(
        r#"on open location this_URL
    set homePath to POSIX path of (path to home folder)
    set naiaDir to homePath & "{data_home_dir}"
    set pendingPath to homePath & "{pending}"
    do shell script "/bin/mkdir -p " & quoted form of naiaDir
    do shell script "/bin/chmod 700 " & quoted form of naiaDir
    do shell script "/usr/bin/printf %s " & quoted form of this_URL & " > " & quoted form of pendingPath
    do shell script "/bin/chmod 600 " & quoted form of pendingPath
end open location
"#
    );
    if std::fs::write(&script_path, script).is_err() {
        return;
    }

    let _ = std::fs::remove_dir_all(&helper_app);
    let compiled = Command::new("osacompile")
        .arg("-o")
        .arg(&helper_app)
        .arg(&script_path)
        .output();
    if !matches!(compiled, Ok(output) if output.status.success()) {
        crate::log_verbose("[Naia] macOS dev deep-link helper compile skipped");
        return;
    }

    let plist = helper_app.join("Contents").join("Info.plist");
    let run_plist = |command: &str| {
        let _ = Command::new("/usr/libexec/PlistBuddy")
            .arg("-c")
            .arg(command)
            .arg(&plist)
            .output();
    };
    run_plist("Set :CFBundleIdentifier com.naia.shell.deeplink-helper");
    run_plist("Delete :CFBundleURLTypes");
    run_plist("Add :CFBundleURLTypes array");
    run_plist("Add :CFBundleURLTypes:0 dict");
    run_plist("Add :CFBundleURLTypes:0:CFBundleTypeRole string Viewer");
    run_plist("Add :CFBundleURLTypes:0:CFBundleURLName string com.naia.shell");
    run_plist("Add :CFBundleURLTypes:0:CFBundleURLSchemes array");
    run_plist("Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string naia");

    let lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
    let registered = Command::new(lsregister).arg("-f").arg(&helper_app).output();
    if matches!(registered, Ok(output) if output.status.success()) {
        crate::log_verbose(&format!(
            "[Naia] macOS dev deep-link helper registered: {}",
            helper_app.display()
        ));
    }
}

/// Start a background thread that watches for deep-link URLs written by the
/// macOS dev helper. Bundled release builds receive links through RunEvent.
pub(crate) fn start_deep_link_file_watcher(app_handle: tauri::AppHandle) {
    #[cfg(debug_assertions)]
    ensure_dev_deep_link_helper();

    let oauth_state = app_handle
        .try_state::<crate::AppState>()
        .map(|state| state.oauth_state.clone());
    std::thread::spawn(move || {
        let pending_path = pending_deep_link_path();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if !pending_path.exists() {
                continue;
            }
            if let Ok(raw) = std::fs::read_to_string(&pending_path) {
                let _ = std::fs::remove_file(&pending_path);
                let url_str = raw.trim();
                if !url_str.is_empty() {
                    crate::process_deep_link_url(
                        url_str,
                        &app_handle,
                        oauth_state.as_ref(),
                        "file",
                    );
                }
            }
        }
    });
    crate::log_both("[Naia] Deep link file watcher started");
}

/// Normalize a path.
pub(crate) fn normalize_path(path: &std::path::Path) -> PathBuf {
    path.to_path_buf()
}

/// Configure WebView settings (macOS: no special configuration needed).
pub(crate) fn configure_webview(_app: &tauri::App) {}

pub struct MacWindowManager;

impl MacWindowManager {
    fn chrome_for_testing_bin() -> Option<String> {
        let home = crate::data_home::unix_home();
        if home.is_empty() {
            return None;
        }

        let base = PathBuf::from(&home).join(".agent-browser").join("browsers");
        let mut dirs: Vec<_> = std::fs::read_dir(&base)
            .ok()?
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("chrome-"))
            .collect();
        dirs.sort_by(|a, b| b.file_name().cmp(&a.file_name()));

        for entry in dirs {
            let bin = entry
                .path()
                .join("Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
            if bin.exists() {
                return Some(bin.to_string_lossy().to_string());
            }
        }
        None
    }

    fn system_chrome_bin() -> Option<String> {
        let home = crate::data_home::unix_home();
        let mut candidates = vec![
            PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            PathBuf::from("/Applications/Chromium.app/Contents/MacOS/Chromium"),
        ];
        if !home.is_empty() {
            candidates.push(
                PathBuf::from(&home)
                    .join("Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            );
            candidates.push(
                PathBuf::from(&home).join("Applications/Chromium.app/Contents/MacOS/Chromium"),
            );
        }

        for candidate in candidates {
            if candidate.exists() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
        None
    }
}

impl PlatformWindowManager for MacWindowManager {
    fn find_window_by_pid(&self, _pid: u32, _timeout_ms: u64) -> Result<PlatformHandle, String> {
        Err("Window lookup by PID is not implemented on macOS".to_string())
    }

    fn find_window_by_name(&self, _name: &str, _timeout_ms: u64) -> Result<PlatformHandle, String> {
        Err("Window lookup by name is not implemented on macOS".to_string())
    }

    fn embed(
        &self,
        _parent: PlatformHandle,
        _child: PlatformHandle,
        _rect: WindowRect,
    ) -> Result<(), String> {
        Err("Native browser embedding is not implemented on macOS".to_string())
    }

    fn remap(&self, _handle: PlatformHandle, _rect: WindowRect) -> Result<(), String> {
        Ok(())
    }

    fn resize(&self, _handle: PlatformHandle, _rect: WindowRect) -> Result<(), String> {
        Ok(())
    }

    fn focus(&self, _handle: PlatformHandle) -> Result<(), String> {
        Ok(())
    }

    fn show(&self, _handle: PlatformHandle) -> Result<(), String> {
        Ok(())
    }

    fn hide(&self, _handle: PlatformHandle) -> Result<(), String> {
        Ok(())
    }

    fn chrome_bin(&self) -> Option<String> {
        Self::chrome_for_testing_bin().or_else(Self::system_chrome_bin)
    }

    fn chrome_spawn_args(&self) -> (Vec<String>, Vec<(String, String)>) {
        (Vec::new(), Vec::new())
    }

    fn kill_lingering_chrome(&self) {
        // Keep this conservative on macOS so Naia never terminates the user's normal Chrome.
    }
}
