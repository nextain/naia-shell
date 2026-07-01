use serde::{Deserialize, Serialize};

use crate::home_dir;

/// Panel manifest stored in ~/.naia/apps/{id}/app.json
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppManifest {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    /// Path to SVG icon file, relative to panel directory (e.g. "icon.svg")
    #[serde(rename = "iconUrl", skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    /// Inline SVG content — populated at load time from iconUrl, not stored in app.json
    #[serde(
        rename = "iconSvg",
        skip_deserializing,
        skip_serializing_if = "Option::is_none"
    )]
    pub icon_svg: Option<String>,
    pub names: Option<std::collections::HashMap<String, String>>,
    pub version: Option<String>,
    /// Tools the panel exposes to Naia. Declared statically in app.json so the
    /// Shell can register proxy stubs with the Agent; actual execution is routed
    /// to the panel iframe via postMessage (GenericInstalledApp).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<AppToolSpec>>,
    /// Absolute path to index.html if present — used for iframe rendering
    #[serde(
        rename = "htmlEntry",
        skip_deserializing,
        skip_serializing_if = "Option::is_none"
    )]
    pub html_entry: Option<String>,
}

/// A tool an installed panel exposes to Naia.
/// Mirrors the shell `NaiaTool` shape — forwarded verbatim to the Agent.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppToolSpec {
    /// Unique skill name with `skill_` prefix, e.g. "skill_memo_read".
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// JSON Schema for parameters (arbitrary JSON object).
    #[serde(default)]
    pub parameters: serde_json::Value,
    /// Permission tier (0=auto, 1=notify, 2=confirm). Defaults to 1.
    #[serde(default = "default_tool_tier")]
    pub tier: u8,
}

fn default_tool_tier() -> u8 {
    1
}

/// List installed panels by scanning ~/.naia/apps/
#[tauri::command]
pub fn app_list_installed() -> Vec<AppManifest> {
    let home = home_dir();
    let apps_dir = std::path::PathBuf::from(&home).join(".naia/apps");

    if !apps_dir.is_dir() {
        return Vec::new();
    }

    let mut panels: Vec<AppManifest> = Vec::new();

    let entries = match std::fs::read_dir(&apps_dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    for entry in entries.flatten() {
        let manifest_path = entry.path().join("app.json");
        if !manifest_path.exists() {
            continue;
        }

        let data = match std::fs::read_to_string(&manifest_path) {
            Ok(d) => d,
            Err(_) => continue,
        };

        let mut manifest: AppManifest = match serde_json::from_str(&data) {
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
/// Called from iframe-bridge.ts → Tauri invoke("app_read_file").
#[tauri::command]
pub fn app_read_file(path: String) -> Result<String, String> {
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
pub struct AppShellResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

/// Allowed commands mapped to absolute paths to prevent PATH hijacking.
/// Note: path-containing arguments are blocked by the '/' restriction below.
/// File access should use app_read_file rather than shell commands.
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
/// Called from iframe-bridge.ts → Tauri invoke("app_run_shell").
#[tauri::command]
pub fn app_run_shell(cmd: String, args: Vec<String>) -> Result<AppShellResult, String> {
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
    // Canonicalize HOME consistently with app_read_file; fall back to raw path if unavailable
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

    Ok(AppShellResult {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        code: output.status.code().unwrap_or(-1),
    })
}

/// Remove an installed panel by its app id.
///
/// Scans `~/.naia/apps/*/app.json` and removes every directory whose
/// manifest `id` matches — this is robust to the directory name differing from
/// the id (e.g. a repo cloned as `naia-memo-panel` but whose app.json
/// declares `id: "memo"`). Mirrors the legacy agent `actionRemove` logic.
#[tauri::command]
pub fn app_remove_installed(panel_id: String) -> Result<(), String> {
    if panel_id.contains('/') || panel_id.contains('\\') || panel_id.contains("..") {
        return Err(format!("Invalid app id: {}", panel_id));
    }

    let home = home_dir();
    let home_path = dunce::canonicalize(&home).map_err(|_| "Access denied".to_string())?;
    let apps_root = std::path::PathBuf::from(&home).join(".naia").join("panels");

    if !apps_root.is_dir() {
        return Ok(()); // nothing installed
    }

    #[derive(Deserialize)]
    struct ManifestLite {
        id: Option<String>,
    }

    for entry in std::fs::read_dir(&apps_root)
        .map_err(|e| format!("Failed to read panels dir: {}", e))?
    {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        // Skip in-flight install temp dirs.
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(".~install-")
        {
            continue;
        }

        let dir = entry.path();
        let manifest_path = dir.join("app.json");
        if !manifest_path.exists() {
            continue;
        }

        let id = std::fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|d| serde_json::from_str::<ManifestLite>(&d).ok())
            .and_then(|m| m.id);
        if id.as_deref() != Some(panel_id.as_str()) {
            continue;
        }

        // Canonicalize to defeat symlinks — never delete outside HOME.
        let canonical =
            dunce::canonicalize(&dir).map_err(|_| "Access denied".to_string())?;
        if !canonical.starts_with(&home_path) {
            return Err("Access denied".to_string());
        }
        std::fs::remove_dir_all(&canonical)
            .map_err(|e| format!("Failed to remove panel {}: {}", panel_id, e))?;
        // Keep scanning — removes every dir bound to this id (dedupe).
    }

    Ok(())
}

/// Result of a successful panel install.
#[derive(Debug, Serialize)]
pub struct AppInstallResult {
    pub id: String,
    pub name: String,
    pub path: String,
}

/// Derive a panel directory name from a Git URL.
/// Strips query/hash, trailing slash and ".git", then takes the last path segment.
fn derive_app_name(source: &str) -> String {
    let s = source.trim();
    // strip query/hash
    let s = s.split(['?', '#']).next().unwrap_or(s);
    // strip trailing slash(es)
    let s = s.trim_end_matches('/');
    // strip .git suffix
    let s = s.trim_end_matches(".git");
    // take last path segment (after last '/' or ':')
    let seg = s.rsplit(['/', ':']).next().unwrap_or(s);
    seg.to_string()
}

/// Install a panel from a Git URL into `~/.naia/apps/{panel-id}/`.
///
/// Ported from the legacy agent skill `agent/src/skills/built-in/panel.ts`
/// (#89, with #257 HTTPS-only hardening) into a shell-side Tauri command —
/// panel install is a filesystem operation, not an AI task, so it belongs in
/// the shell rather than being routed through the agent.
///
/// The directory name is the panel **id** (read from the cloned `app.json`),
/// NOT the repo name. This keeps `app_remove_installed` (which matches by id)
/// consistent: dir name == id == canonical identifier.
///
/// Security:
/// - HTTPS-only (#257): rejects `http://`, `git@`, `file://`, `data:`, bare paths.
/// - The app id (untrusted, from app.json) is sanitized before becoming a
///   path segment, so the destination cannot escape `~/.naia/apps/`.
/// - `git` is invoked with an arg vector (no shell).
/// - On any failure the temp clone is removed.
#[tauri::command]
pub fn app_install(source: String) -> Result<AppInstallResult, String> {
    let source = source.trim();

    // #257: HTTPS-only.
    if !source.starts_with("https://") {
        return Err(format!(
            "지원하지 않는 소스입니다. HTTPS Git URL만 설치할 수 있습니다\n(예: https://github.com/org/panel.git).\n받은 소스: {}",
            source
        ));
    }

    let derived = derive_app_name(source);
    // The derived name is only used for the temp dir; still sanity-check it.
    let derived_ok = !derived.is_empty()
        && derived
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_');
    if !derived_ok {
        return Err(format!("유효하지 않은 저장소 이름이 도출되었습니다: {:?}", derived));
    }

    let home = home_dir();
    let home_path =
        dunce::canonicalize(&home).unwrap_or_else(|_| std::path::PathBuf::from(&home));
    let apps_root = std::path::PathBuf::from(&home).join(".naia").join("panels");
    std::fs::create_dir_all(&apps_root)
        .map_err(|e| format!("앱 디렉토리 생성 실패: {}", e))?;

    // Temp clone target *inside* apps_root (same volume → rename is atomic).
    // Leading-dot prefix keeps it out of the installed-panel list while cloning.
    let tmp = apps_root.join(format!(".~install-{}", derived));
    if tmp.exists() {
        let _ = std::fs::remove_dir_all(&tmp); // clear stale partial clone
    }

    // Clone via arg vector — no shell, no shell injection. --depth 1 for speed.
    let output = std::process::Command::new("git")
        .args(["clone", "--depth", "1", source, &tmp.to_string_lossy()])
        .output()
        .map_err(|e| format!("git 실행 실패 (git이 설치되어 있는지 확인): {}", e))?;

    if !output.status.success() {
        let _ = std::fs::remove_dir_all(&tmp);
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "git clone 실패: {}",
            if stderr.is_empty() {
                "알 수 없는 오류".to_string()
            } else {
                stderr
            }
        ));
    }

    // Verify app.json manifest exists.
    let manifest_path = tmp.join("app.json");
    if !manifest_path.exists() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(
            "설치된 앱에 app.json 매니페스트가 없습니다 — 임시 디렉토리를 제거했습니다."
                .to_string(),
        );
    }

    // Read id (the canonical app id → becomes the directory name).
    #[derive(Deserialize)]
    struct ManifestLite {
        id: Option<String>,
        name: Option<String>,
    }
    let (id, display_name) = std::fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|data| serde_json::from_str::<ManifestLite>(&data).ok())
        .map(|m| {
            (
                m.id.unwrap_or_else(|| derived.clone()),
                m.name.unwrap_or_else(|| derived.clone()),
            )
        })
        .unwrap_or_else(|| (derived.clone(), derived.clone()));

    // The id becomes a path segment — sanitize strictly.
    let id_safe = !id.is_empty()
        && !id.contains('/')
        && !id.contains('\\')
        && !id.contains("..")
        && !id.contains('\0')
        && !id.chars().any(char::is_control)
        && id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_');
    if !id_safe {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!(
            "app.json의 id가 유효하지 않아 설치할 수 없습니다 (영문/숫자/-/_ 만 허용): {:?}",
            id
        ));
    }

    // Final destination keyed by id.
    let dest = apps_root.join(&id);
    if dest.exists() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!(
            "앱 \"{}\" 이(가) 이미 설치되어 있습니다: {}\n먼저 제거한 뒤 다시 설치하세요.",
            id,
            dest.display()
        ));
    }

    // Move temp → final (same volume, so rename is O(1) and atomic).
    std::fs::rename(&tmp, &dest).map_err(|e| {
        let _ = std::fs::remove_dir_all(&tmp);
        format!("설치 마무리 실패 (rename): {}", e)
    })?;

    // Home boundary sanity check (defense in depth).
    if let Ok(canonical_dest) = dunce::canonicalize(&dest) {
        if !canonical_dest.starts_with(&home_path) {
            let _ = std::fs::remove_dir_all(&canonical_dest);
            return Err("Access denied".to_string());
        }
    }

    Ok(AppInstallResult {
        id,
        name: display_name,
        path: dest.to_string_lossy().into_owned(),
    })
}
