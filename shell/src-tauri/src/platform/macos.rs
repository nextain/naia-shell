//! macOS platform implementations.
#![allow(dead_code)]

use super::{PlatformHandle, PlatformWindowManager, WindowRect};
use std::path::PathBuf;
use std::process::{Child, Command};

/// Check if a process with the given PID is still running (Unix: kill(pid, 0)).
pub(crate) fn is_pid_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
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
    for component in &["gateway", "node-host"] {
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

/// Find bundled node binary (macOS: not bundled yet).
pub(crate) fn find_bundled_node(_app_handle: &tauri::AppHandle) -> Option<PathBuf> {
    None
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

/// Start deep link file watcher (macOS: single-instance IPC handles this).
pub(crate) fn start_deep_link_file_watcher(_app_handle: tauri::AppHandle) {}

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
