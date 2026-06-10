use serde::{Deserialize, Serialize};

use crate::home_dir;

/// Panel manifest stored in ~/.naia/panels/{id}/panel.json
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PanelManifest {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    /// Path to SVG icon file, relative to panel directory (e.g. "icon.svg")
    #[serde(rename = "iconUrl", skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    /// Inline SVG content — populated at load time from iconUrl, not stored in panel.json
    #[serde(
        rename = "iconSvg",
        skip_deserializing,
        skip_serializing_if = "Option::is_none"
    )]
    pub icon_svg: Option<String>,
    pub names: Option<std::collections::HashMap<String, String>>,
    pub version: Option<String>,
    /// Absolute path to index.html if present — used for iframe rendering
    #[serde(
        rename = "htmlEntry",
        skip_deserializing,
        skip_serializing_if = "Option::is_none"
    )]
    pub html_entry: Option<String>,
}

/// List installed panels by scanning ~/.naia/panels/
#[tauri::command]
pub fn panel_list_installed() -> Vec<PanelManifest> {
    let home = home_dir();
    let panels_dir = std::path::PathBuf::from(&home).join(".naia/panels");

    if !panels_dir.is_dir() {
        return Vec::new();
    }

    let mut panels: Vec<PanelManifest> = Vec::new();

    let entries = match std::fs::read_dir(&panels_dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    for entry in entries.flatten() {
        let manifest_path = entry.path().join("panel.json");
        if !manifest_path.exists() {
            continue;
        }

        let data = match std::fs::read_to_string(&manifest_path) {
            Ok(d) => d,
            Err(_) => continue,
        };

        let mut manifest: PanelManifest = match serde_json::from_str(&data) {
            Ok(m) => m,
            Err(_) => continue,
        };

        // Load inline SVG if iconUrl is specified
        if let Some(ref icon_url) = manifest.icon_url.clone() {
            let svg_path = entry.path().join(icon_url);
            if let Ok(svg) = std::fs::read_to_string(&svg_path) {
                manifest.icon_svg = Some(svg);
            }
        }

        // Detect index.html for iframe rendering
        let html_path = entry.path().join("index.html");
        if html_path.exists() {
            manifest.html_entry = html_path.to_string_lossy().into_owned().into();
        }

        panels.push(manifest);
    }

    panels
}

/// Read a file on behalf of an iframe panel.
/// Restricted to files inside the user's HOME directory (max 1 MB).
/// Called from iframe-bridge.ts → Tauri invoke("panel_read_file").
#[tauri::command]
pub fn panel_read_file(path: String) -> Result<String, String> {
    let home = home_dir();
    // Canonicalize HOME itself to handle symlinks in the home path
    let home_path = dunce::canonicalize(&home).map_err(|_| "Access denied".to_string())?;

    // Resolve to canonical path to defeat symlink / path-traversal attacks.
    // Returns a generic "Access denied" to avoid leaking path existence.
    let canonical = dunce::canonicalize(&path).map_err(|_| "Access denied".to_string())?;

    if !canonical.starts_with(&home_path) {
        return Err("Access denied".to_string());
    }

    // Enforce 1 MB read limit to prevent OOM from large/virtual files
    const MAX_BYTES: u64 = 1024 * 1024;
    let metadata = std::fs::metadata(&canonical).map_err(|_| "Access denied".to_string())?;
    if metadata.len() > MAX_BYTES {
        return Err(format!("File too large (max {} bytes)", MAX_BYTES));
    }

    std::fs::read_to_string(&canonical).map_err(|e| format!("Failed to read file: {}", e))
}

/// Shell result returned to the iframe panel.
#[derive(Debug, Serialize)]
pub struct PanelShellResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

/// Allowed commands mapped to absolute paths to prevent PATH hijacking.
/// Note: path-containing arguments are blocked by the '/' restriction below.
/// File access should use panel_read_file rather than shell commands.
#[cfg(unix)]
const SHELL_CMD_MAP: &[(&str, &str)] = &[
    ("ls", "/usr/bin/ls"),
    ("echo", "/usr/bin/echo"),
    ("pwd", "/usr/bin/pwd"),
    ("date", "/usr/bin/date"),
    ("uname", "/usr/bin/uname"),
    ("whoami", "/usr/bin/whoami"),
];

#[cfg(windows)]
const SHELL_CMD_MAP: &[(&str, &str)] = &[
    ("ls", r"C:\Windows\System32\cmd.exe"),    // /C dir
    ("echo", r"C:\Windows\System32\cmd.exe"),  // /C echo
    ("pwd", r"C:\Windows\System32\cmd.exe"),   // /C cd
    ("date", r"C:\Windows\System32\cmd.exe"),  // /C date /t
    ("uname", r"C:\Windows\System32\cmd.exe"), // /C ver
    ("whoami", r"C:\Windows\System32\whoami.exe"),
];

/// Map shell command name to Windows cmd.exe arguments
#[cfg(windows)]
fn windows_cmd_args(cmd: &str, args: &[String]) -> Vec<String> {
    match cmd {
        "ls" => {
            let mut v = vec!["/C".to_string(), "dir".to_string()];
            v.extend(args.iter().cloned());
            v
        }
        "echo" => {
            let mut v = vec!["/C".to_string(), "echo".to_string()];
            v.extend(args.iter().cloned());
            v
        }
        "pwd" => vec!["/C".to_string(), "cd".to_string()],
        "date" => vec!["/C".to_string(), "date".to_string(), "/t".to_string()],
        "uname" => vec!["/C".to_string(), "ver".to_string()],
        _ => args.to_vec(),
    }
}

/// Run an allowlisted shell command on behalf of an iframe panel.
/// Uses absolute command paths (no PATH lookup). cwd is always HOME.
/// Called from iframe-bridge.ts → Tauri invoke("panel_run_shell").
#[tauri::command]
pub fn panel_run_shell(cmd: String, args: Vec<String>) -> Result<PanelShellResult, String> {
    // Resolve command to absolute path — rejects anything not on the allowlist
    let program = SHELL_CMD_MAP
        .iter()
        .find(|(name, _)| *name == cmd.as_str())
        .map(|(_, path)| *path)
        .ok_or_else(|| format!("Command not allowed: {}", cmd))?;

    // Validate args: no shell metacharacters, null bytes, path separators, or traversal
    for arg in &args {
        if arg.contains('\0') {
            return Err("Argument contains null byte".to_string());
        }
        if arg.contains(['|', '&', ';', '$', '`', '\n', '\r']) {
            return Err(format!("Argument contains disallowed characters: {}", arg));
        }
        // Block path separators (both / and \ on all platforms)
        if arg.contains('/') || arg.contains('\\') {
            return Err(format!("Path separator not allowed in argument: {}", arg));
        }
        if arg.contains("..") {
            return Err(format!("Path traversal not allowed in argument: {}", arg));
        }
    }

    let home = home_dir();
    // Canonicalize HOME consistently with panel_read_file; fall back to raw path if unavailable
    let home_path = dunce::canonicalize(&home).unwrap_or_else(|_| std::path::PathBuf::from(&home));

    #[cfg(unix)]
    let final_args = args.clone();
    #[cfg(windows)]
    let final_args = windows_cmd_args(&cmd, &args);

    let mut cmd = std::process::Command::new(program);
    cmd.args(&final_args).current_dir(&home_path); // Always run from HOME, never inheriting Tauri's cwd
    crate::platform::hide_console(&mut cmd);
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run command: {}", e))?;

    Ok(PanelShellResult {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        code: output.status.code().unwrap_or(-1),
    })
}

/// Remove an installed panel directory from ~/.naia/panels/{panelId}/
#[tauri::command]
pub fn panel_remove_installed(panel_id: String) -> Result<(), String> {
    // Validate: no path traversal
    if panel_id.contains('/') || panel_id.contains('\\') || panel_id.contains("..") {
        return Err(format!("Invalid panel id: {}", panel_id));
    }

    let home = home_dir();
    let home_path = dunce::canonicalize(&home).map_err(|_| "Access denied".to_string())?;

    let panel_dir = std::path::PathBuf::from(&home)
        .join(".naia/panels")
        .join(&panel_id);

    if !panel_dir.exists() {
        return Ok(()); // already gone
    }

    // Canonicalize to resolve symlinks — prevents deleting directories outside HOME
    // (mirrors panel_read_file's boundary check)
    let canonical = dunce::canonicalize(&panel_dir).map_err(|_| "Access denied".to_string())?;
    if !canonical.starts_with(&home_path) {
        return Err("Access denied".to_string());
    }

    std::fs::remove_dir_all(&canonical)
        .map_err(|e| format!("Failed to remove panel {}: {}", panel_id, e))
}
