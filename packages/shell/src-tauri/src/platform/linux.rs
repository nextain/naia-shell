//! Linux/Unix platform implementations.

use super::{PlatformHandle, PlatformWindowManager, WindowRect};
use std::path::PathBuf;
use std::process::{Child, Command};
use tauri::Manager;

/// Check if a process with the given PID is still running (Unix: kill(pid, 0)).
pub(crate) fn is_pid_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
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
pub(crate) fn kill_pid(pid: u32) {
    let signed_pid = match i32::try_from(pid) {
        Ok(p) if p > 0 => p,
        _ => return,
    };
    unsafe {
        libc::kill(signed_pid, libc::SIGKILL);
    }
}

pub(crate) fn cleanup_orphan_processes() {
    for component in &["gateway", "node-host", "bgm-server", "cascade"] {
        if let Some(pid) = crate::read_pid_file(component) {
            let signed_pid = match i32::try_from(pid) {
                Ok(p) if p > 0 => p,
                _ => {
                    crate::log_verbose(&format!(
                        "[Naia] Invalid PID {} for {} — skipping",
                        pid, component
                    ));
                    crate::remove_pid_file(component);
                    continue;
                }
            };
            if is_pid_alive(pid) {
                crate::log_verbose(&format!(
                    "[Naia] Orphan {} found (PID {}) — sending SIGTERM",
                    component, pid
                ));
                unsafe {
                    libc::kill(signed_pid, libc::SIGTERM);
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
                if is_pid_alive(pid) {
                    crate::log_verbose(&format!(
                        "[Naia] Orphan {} still alive (PID {}) — sending SIGKILL",
                        component, pid
                    ));
                    unsafe {
                        libc::kill(signed_pid, libc::SIGKILL);
                    }
                }
            }
            crate::remove_pid_file(component);
        }
    }
}

/// Kill stale gateway process (Unix: pkill -f).
pub(crate) fn kill_stale_gateway() {
    let _ = Command::new("pkill")
        .arg("-f")
        .arg("naia.*gateway")
        .output();
}

/// Kill stale cascade (output_cascade uvicorn + loader + trt/voxcpm2 children) — Unix.
/// PID-tracked loader 는 cleanup_orphan_processes 가 잡고, 여긴 손자(facade uvicorn 등)를 커맨드 매칭(R2.2b).
pub(crate) fn kill_stale_cascade() {
    for pat in &[
        "output_cascade.app:app",
        "loader.*launch",
        "trt_native_stream_server",
        "voxcpm2_service",
    ] {
        let _ = Command::new("pkill").arg("-f").arg(*pat).output();
    }
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
        let home = std::env::var("HOME").unwrap_or_default();
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
        // Match both native (.naia/chrome-profile) and Flatpak (naia-profile) paths
        let _ = Command::new("pkill").args(["-f", "naia.*profile"]).output();
    }
}
