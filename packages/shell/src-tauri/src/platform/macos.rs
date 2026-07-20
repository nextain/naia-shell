//! macOS platform implementations.
#![allow(dead_code)]

use super::{PlatformHandle, PlatformWindowManager, WindowRect};
use std::path::PathBuf;
use std::process::{Child, Command};
use tauri::Manager;

/// Check if a process with the given PID is still running (Unix: kill(pid, 0)).
pub(crate) fn is_pid_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

pub(crate) fn agent_process_marker(pid: u32, marker: &str) -> Result<Option<bool>, String> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
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

pub(crate) fn terminate_agent_pid(pid: u32) -> Result<(), String> {
    let pid = i32::try_from(pid).map_err(|_| "agent_lease_pid_invalid".to_string())?;
    if unsafe { libc::kill(pid, libc::SIGKILL) } == 0 {
        Ok(())
    } else if std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err("agent_lease_terminate_failed".to_string())
    }
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
pub(crate) fn kill_pid(pid: u32) {
    let signed_pid = match i32::try_from(pid) {
        Ok(p) if p > 0 => p,
        _ => return,
    };
    unsafe {
        libc::kill(signed_pid, libc::SIGKILL);
    }
}

/// Clean up orphan processes from a previous session.
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

/// Kill stale gateway process.
pub(crate) fn kill_stale_gateway() {
    if let Ok(uid) = std::env::var("UID").or_else(|_| {
        Command::new("id")
            .arg("-u")
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
    }) {
        let domain_target = format!("gui/{uid}/ai.openclaw.gateway");
        let _ = Command::new("launchctl")
            .arg("bootout")
            .arg(domain_target)
            .output();
        let plist = format!(
            "{}/Library/LaunchAgents/ai.openclaw.gateway.plist",
            std::env::var("HOME").unwrap_or_default()
        );
        let _ = Command::new("launchctl")
            .arg("bootout")
            .arg(format!("gui/{uid}"))
            .arg(plist)
            .output();
    }
    let _ = Command::new("pkill")
        .arg("-f")
        .arg("openclaw.*gateway|naia.*gateway")
        .output();
}

/// Kill stale cascade (output_cascade uvicorn + loader + children) — macOS (R2.2b).
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
    PathBuf::from(crate::home_dir())
        .join(".naia")
        .join("deep-link-pending.txt")
}

#[cfg(debug_assertions)]
fn ensure_dev_deep_link_helper() {
    let home = crate::home_dir();
    if home.is_empty() {
        return;
    }
    let naia_dir = PathBuf::from(&home).join(".naia");
    let helper_root = naia_dir.join("dev-deeplink");
    let helper_app = helper_root.join("NaiaDevDeepLink.app");
    let script_path = helper_root.join("NaiaDevDeepLink.applescript");
    let _ = std::fs::create_dir_all(&helper_root);

    let script = r#"on open location this_URL
    set homePath to POSIX path of (path to home folder)
    set naiaDir to homePath & ".naia"
    set pendingPath to naiaDir & "/deep-link-pending.txt"
    do shell script "/bin/mkdir -p " & quoted form of naiaDir
    do shell script "/bin/chmod 700 " & quoted form of naiaDir
    do shell script "/usr/bin/printf %s " & quoted form of this_URL & " > " & quoted form of pendingPath
    do shell script "/bin/chmod 600 " & quoted form of pendingPath
end open location
"#;
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
        let home = std::env::var("HOME").unwrap_or_default();
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
        let home = std::env::var("HOME").unwrap_or_default();
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
