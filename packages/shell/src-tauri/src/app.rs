use base64::Engine as _;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;

use crate::data_home::{self, DataHomeChild};

#[path = "app_assets.rs"]
mod app_assets;

#[derive(Debug, Deserialize)]
struct StoreArtifact {
    sha256: String,
    signature: String,
    size: u64,
    manifest: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct StoreEntitlement {
    app_id: String,
    status: String,
    download_path: String,
    artifact: StoreArtifact,
}

// The Ed25519 public key the published app artifacts are actually signed with —
// the gateway's configured APP_SIGNING_PUBLIC_KEY (it verifies at seed time, so
// a served artifact is guaranteed signed by this key's private half). The prior
// stale placeholder ("Zs6y…") failed verification for the real Naia Slides
// artifact ("Artifact signature verification failed", 2026-08-31 rehearsal).
// Release builds should still inject NAIA_APP_SIGNING_PUBLIC_KEY explicitly.
const DEVELOPMENT_SIGNING_PUBLIC_KEY: &str = "GCqIQ1dXU07erJixc6UjAaDMgnSfh+GB3ZSRxb+VH2g=";

fn verify_artifact_signature(digest: &[u8], value: &str) -> Result<(), String> {
    let encoded_key = option_env!("NAIA_APP_SIGNING_PUBLIC_KEY")
        .or_else(|| cfg!(debug_assertions).then_some(DEVELOPMENT_SIGNING_PUBLIC_KEY))
        .ok_or_else(|| "App signing public key is not configured".to_string())?;
    verify_artifact_signature_with_key(encoded_key, digest, value)
}

/// 어느 키로 검증할지를 밖에서 준다. 기본 키 해석과 검증 자체를 나눠 두면,
/// 검증 규칙을 배포 키에 묶인 벡터 없이 확인할 수 있다.
fn verify_artifact_signature_with_key(
    encoded_key: &str,
    digest: &[u8],
    value: &str,
) -> Result<(), String> {
    let key_bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded_key)
        .map_err(|_| "Invalid app signing public key".to_string())?;
    let key_array: [u8; 32] = key_bytes
        .try_into()
        .map_err(|_| "Invalid app signing public key".to_string())?;
    let signature_bytes = value
        .strip_prefix("ed25519:")
        .ok_or_else(|| "Artifact signature must use Ed25519".to_string())
        .and_then(|encoded| {
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| "Invalid artifact signature".to_string())
        })?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| "Invalid artifact signature".to_string())?;
    VerifyingKey::from_bytes(&key_array)
        .map_err(|_| "Invalid app signing public key".to_string())?
        .verify(digest, &signature)
        .map_err(|_| "Artifact signature verification failed".to_string())
}

#[cfg(test)]
mod store_signature_tests {
    use super::*;

    /// 검증 경로가 옳은 서명을 받고 건드려진 것을 거절하는가.
    ///
    /// 예전에는 실제 배포 산출물의 서명을 그대로 박아 두었다. 그런데
    /// 2026-08-31 에 기본 공개키를 게이트웨이의 실제 키로 바꾸면서(96394eee)
    /// 옛 키로 서명된 그 벡터를 그대로 두어, 그때부터 이 테스트가 계속
    /// 실패했다. 벡터와 키가 따로 움직이면 언제든 다시 어긋난다.
    ///
    /// 그래서 여기서는 키와 서명을 이 테스트 안에서 함께 만든다. 씨앗이
    /// 고정이라 결과도 고정이고, 키를 바꿔도 벡터를 다시 만들 일이 없다.
    /// 기본 공개키가 실제 배포 산출물과 맞는지는 여기서 잴 수 없다 — 그것은
    /// 게이트웨이가 배포 시점에 확인한다.
    #[test]
    fn verifies_reviewed_artifact_and_rejects_tampering() {
        use ed25519_dalek::{Signer as _, SigningKey};

        let signing_key = SigningKey::from_bytes(&[7u8; 32]);
        let public_key = base64::engine::general_purpose::STANDARD
            .encode(signing_key.verifying_key().to_bytes());
        let digest = hex_digest("c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c");
        let signature = format!(
            "ed25519:{}",
            base64::engine::general_purpose::STANDARD.encode(signing_key.sign(&digest).to_bytes())
        );

        assert!(verify_artifact_signature_with_key(&public_key, &digest, &signature).is_ok());
        let mut tampered = digest;
        tampered[0] ^= 1;
        assert!(verify_artifact_signature_with_key(&public_key, &tampered, &signature).is_err());
        // 서명이 Ed25519 임을 밝히지 않으면 받지 않는다.
        assert!(verify_artifact_signature_with_key(&public_key, &digest, "MAfl").is_err());
    }

    fn hex_digest(value: &str) -> [u8; 32] {
        let decoded = (0..value.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&value[index..index + 2], 16).unwrap())
            .collect::<Vec<_>>();
        decoded.try_into().unwrap()
    }
}

fn apps_root(home: &std::path::Path) -> std::path::PathBuf {
    data_home::direct_child_of(home, DataHomeChild::Apps)
}

fn legacy_apps_root(home: &std::path::Path) -> std::path::PathBuf {
    data_home::direct_child_of(home, DataHomeChild::Panels)
}

fn is_safe_app_id(id: &str) -> bool {
    !id.is_empty()
        && !id.contains("..")
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

#[derive(Deserialize)]
struct ManifestIdentity {
    id: String,
}

fn manifest_id(dir: &std::path::Path) -> Result<String, String> {
    let path = dir.join("app.json");
    let data = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    let manifest: ManifestIdentity =
        serde_json::from_str(&data).map_err(|e| format!("Invalid {}: {}", path.display(), e))?;
    if !is_safe_app_id(&manifest.id) {
        return Err(format!(
            "Invalid app id in {}: {:?}",
            path.display(),
            manifest.id
        ));
    }
    Ok(manifest.id)
}

fn ensure_directory(path: &std::path::Path, label: &str) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => Err(format!(
            "{} must be a real directory: {}",
            label,
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(path).map_err(|e| format!("Failed to create {}: {}", label, e))
        }
        Err(error) => Err(format!("Failed to inspect {}: {}", label, error)),
    }
}

/// Establish the canonical app root and migrate the pre-#472 `panels` root.
/// Refuse ambiguity instead of overwriting either copy.
fn prepare_apps_root(home: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let root = apps_root(home);
    // 앱 자리의 부모가 곧 데이터 홈이다. 데이터 홈 경로를 따로 받아 오지
    // 않는다 — 그 디렉터리를 손에 쥐면 이름표 없는 자리를 만들 수 있다.
    if let Some(naia_root) = root.parent() {
        ensure_directory(naia_root, "Naia data directory")?;
    }
    ensure_directory(&root, "apps directory")?;
    let canonical_home = dunce::canonicalize(home).map_err(|e| format!("Invalid home: {}", e))?;
    let canonical_root =
        dunce::canonicalize(&root).map_err(|e| format!("Invalid apps directory: {}", e))?;
    if !canonical_root.starts_with(&canonical_home) {
        return Err("Apps directory escapes the user home".to_string());
    }

    let legacy = legacy_apps_root(home);
    match std::fs::symlink_metadata(&legacy) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(root),
        Err(error) => {
            return Err(format!(
                "Failed to inspect legacy apps directory: {}",
                error
            ))
        }
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(format!(
                "Legacy apps path must be a real directory: {}",
                legacy.display()
            ));
        }
        Ok(_) => {}
    }

    let mut migrations = Vec::new();
    let mut ids = std::collections::HashSet::new();
    for entry in std::fs::read_dir(&legacy)
        .map_err(|e| format!("Failed to read legacy apps directory: {}", e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read legacy app entry: {}", e))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to inspect legacy app entry: {}", e))?;
        if !file_type.is_dir() {
            return Err(format!(
                "Refusing to migrate non-directory legacy app entry: {}",
                entry.path().display()
            ));
        }
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(".~install-")
        {
            return Err(format!(
                "Incomplete legacy app install requires cleanup: {}",
                entry.path().display()
            ));
        }

        let id = manifest_id(&entry.path())?;
        let destination = root.join(&id);
        if destination.exists() || !ids.insert(id.clone()) {
            return Err(format!(
                "Cannot migrate app {:?}: duplicate canonical destination",
                id
            ));
        }
        migrations.push((entry.path(), destination, id));
    }

    let mut moved = Vec::new();
    for (source, destination, id) in &migrations {
        if let Err(error) = std::fs::rename(source, destination) {
            let mut rollback_errors = Vec::new();
            for (moved_source, moved_destination) in moved.iter().rev() {
                if let Err(rollback_error) = std::fs::rename(moved_destination, moved_source) {
                    rollback_errors.push(rollback_error.to_string());
                }
            }
            let rollback = if rollback_errors.is_empty() {
                "migration rolled back".to_string()
            } else {
                format!("rollback also failed: {}", rollback_errors.join("; "))
            };
            return Err(format!(
                "Failed to migrate app {:?}: {}; {}",
                id, error, rollback
            ));
        }
        moved.push((source, destination));
    }

    std::fs::remove_dir(&legacy)
        .map_err(|e| format!("Failed to remove empty legacy apps directory: {}", e))?;
    Ok(root)
}

/// Panel manifest stored in ~/.naia/apps/{id}/app.json
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppManifest {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    /// Path to SVG icon file, relative to app directory (e.g. "icon.svg")
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
    /// Tools the app exposes to Naia. Declared statically in app.json so the
    /// Shell can register proxy stubs with the Agent; actual execution is routed
    /// to the app iframe via postMessage (GenericInstalledApp).
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

/// A tool an installed app exposes to Naia.
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
fn list_installed_from(home: &std::path::Path) -> Result<Vec<AppManifest>, String> {
    let apps_dir = prepare_apps_root(home)?;

    let mut apps: Vec<AppManifest> = Vec::new();

    let entries = match std::fs::read_dir(&apps_dir) {
        Ok(e) => e,
        Err(e) => return Err(format!("Failed to read apps directory: {}", e)),
    };

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read app entry: {}", e))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to inspect app entry: {}", e))?;
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(".~install-")
        {
            continue;
        }
        if !file_type.is_dir() || file_type.is_symlink() {
            return Err(format!("Invalid app entry: {}", entry.path().display()));
        }
        let manifest_path = entry.path().join("app.json");
        let data = std::fs::read_to_string(&manifest_path)
            .map_err(|e| format!("Failed to read {}: {}", manifest_path.display(), e))?;
        let mut manifest: AppManifest = serde_json::from_str(&data)
            .map_err(|e| format!("Invalid {}: {}", manifest_path.display(), e))?;
        let directory_id = entry.file_name().to_string_lossy().into_owned();
        if !is_safe_app_id(&manifest.id) || manifest.id != directory_id {
            return Err(format!(
                "App manifest id does not match directory: {}",
                entry.path().display()
            ));
        }

        // Load inline SVG if iconUrl is specified
        if let Some(ref icon_url) = manifest.icon_url.clone() {
            let svg_path = entry.path().join(icon_url);
            if let Ok(svg) = std::fs::read_to_string(&svg_path) {
                manifest.icon_svg = Some(svg);
            }
        }

        // Repair pre-existing packages as well as freshly installed ones.
        rewrite_installed_app_asset_urls(&entry.path());

        // Detect index.html for iframe rendering
        let html_path = entry.path().join("index.html");
        if html_path.exists() {
            manifest.html_entry = html_path.to_string_lossy().into_owned().into();
        }

        apps.push(manifest);
    }

    Ok(apps)
}

#[tauri::command]
pub fn app_list_installed() -> Result<Vec<AppManifest>, String> {
    list_installed_from(std::path::Path::new(&data_home::user_home()))
}

/// Read a file on behalf of an iframe panel.
/// Restricted to files inside the user's HOME directory (max 1 MB).
/// Called from iframe-bridge.ts → Tauri invoke("app_read_file").
#[tauri::command]
pub fn app_read_file(path: String) -> Result<String, String> {
    let home = data_home::user_home();
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

/// Shell result returned to the iframe app.
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

/// Run an allowlisted shell command on behalf of an iframe app.
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

    let home = data_home::user_home();
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

/// Remove an installed app by its app id.
///
/// Removes exactly `~/.naia/apps/{id}` after validating that its manifest id
/// matches its canonical directory name.
#[tauri::command]
pub fn app_remove_installed(app_id: String) -> Result<(), String> {
    // The frontend invokes this with { appId } (removeInstalledApp). Tauri binds
    // by exact camelCase name, so the old `panel_id` (→ panelId) never received
    // the value and every removal failed ("제거하지 못했습니다", 2026-08-31).
    remove_installed_from(std::path::Path::new(&data_home::user_home()), &app_id)
}

fn remove_installed_from(home: &std::path::Path, panel_id: &str) -> Result<(), String> {
    if !is_safe_app_id(panel_id) {
        return Err(format!("Invalid app id: {}", panel_id));
    }

    let root = prepare_apps_root(home)?;
    let dir = root.join(&panel_id);
    if !dir.exists() {
        return Ok(());
    }
    let file_type = std::fs::symlink_metadata(&dir)
        .map_err(|e| format!("Failed to inspect app {}: {}", panel_id, e))?
        .file_type();
    if !file_type.is_dir() || file_type.is_symlink() {
        return Err("Access denied".to_string());
    }
    if manifest_id(&dir)? != panel_id {
        return Err(format!(
            "App manifest id does not match directory: {}",
            panel_id
        ));
    }
    let canonical_root = dunce::canonicalize(&root).map_err(|_| "Access denied".to_string())?;
    let canonical = dunce::canonicalize(&dir).map_err(|_| "Access denied".to_string())?;
    if canonical.parent() != Some(canonical_root.as_path()) {
        return Err("Access denied".to_string());
    }
    std::fs::remove_dir_all(&canonical)
        .map_err(|e| format!("Failed to remove app {}: {}", panel_id, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_app(root: &std::path::Path, dir: &str, id: &str) -> std::path::PathBuf {
        let app_dir = root.join(dir);
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::write(
            app_dir.join("app.json"),
            format!(r#"{{"id":"{}","name":"Test App"}}"#, id),
        )
        .unwrap();
        std::fs::write(app_dir.join("index.html"), "<!doctype html>").unwrap();
        app_dir
    }

    #[test]
    fn canonical_lifecycle_lists_after_restart_and_removes() {
        let home = tempfile::tempdir().unwrap();
        write_app(&apps_root(home.path()), "slides", "slides");

        let first = list_installed_from(home.path()).unwrap();
        let restarted = list_installed_from(home.path()).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(restarted[0].id, "slides");
        let expected_entry = apps_root(home.path()).join("slides/index.html");
        assert_eq!(
            std::path::Path::new(restarted[0].html_entry.as_deref().unwrap()),
            expected_entry
        );

        remove_installed_from(home.path(), "slides").unwrap();
        assert!(list_installed_from(home.path()).unwrap().is_empty());
    }

    #[test]
    fn migrates_legacy_panels_once() {
        let home = tempfile::tempdir().unwrap();
        write_app(&legacy_apps_root(home.path()), "old-repo-name", "slides");

        let installed = list_installed_from(home.path()).unwrap();
        assert_eq!(installed[0].id, "slides");
        assert!(apps_root(home.path()).join("slides/app.json").is_file());
        assert!(!legacy_apps_root(home.path()).exists());
    }

    #[test]
    fn migration_refuses_duplicate_without_moving_legacy_app() {
        let home = tempfile::tempdir().unwrap();
        let legacy = write_app(&legacy_apps_root(home.path()), "legacy", "slides");
        write_app(&apps_root(home.path()), "slides", "slides");

        let error = list_installed_from(home.path()).unwrap_err();
        assert!(error.contains("duplicate canonical destination"));
        assert!(legacy.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn migration_refuses_symlink_without_touching_target() {
        use std::os::unix::fs::symlink;

        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        write_app(outside.path(), "target", "slides");
        let legacy = legacy_apps_root(home.path());
        std::fs::create_dir_all(&legacy).unwrap();
        symlink(outside.path().join("target"), legacy.join("slides")).unwrap();

        assert!(list_installed_from(home.path()).is_err());
        assert!(outside.path().join("target/app.json").is_file());
    }

    #[test]
    fn removal_refuses_manifest_id_mismatch_and_traversal() {
        let home = tempfile::tempdir().unwrap();
        let app = write_app(&apps_root(home.path()), "slides", "different-id");

        assert!(remove_installed_from(home.path(), "../slides").is_err());
        assert!(remove_installed_from(home.path(), "slides").is_err());
        assert!(app.is_dir());
    }

    #[test]
    fn listing_rejects_invalid_canonical_manifest() {
        let home = tempfile::tempdir().unwrap();
        let app = apps_root(home.path()).join("slides");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("app.json"), r#"{"name":"Missing id"}"#).unwrap();

        let error = list_installed_from(home.path()).unwrap_err();
        assert!(error.contains("Invalid"));
    }

    #[cfg(unix)]
    #[test]
    fn listing_rejects_symlinked_naia_data_root() {
        use std::os::unix::fs::symlink;

        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(
            outside.path(),
            data_home::direct_child_of(home.path(), DataHomeChild::Apps)
                .parent()
                .unwrap(),
        )
        .unwrap();

        assert!(list_installed_from(home.path()).is_err());
        assert!(!outside.path().join("apps").exists());
    }
}

/// Result of a successful app install.
#[derive(Debug, Serialize)]
pub struct AppInstallResult {
    pub id: String,
    pub name: String,
    pub path: String,
}

/// Log a recoverable package error without hiding other installed apps.
fn rewrite_installed_app_asset_urls(app_dir: &std::path::Path) {
    if let Err(error) = app_assets::rewrite_installed_app_asset_urls(app_dir) {
        log::warn!("Failed to prepare installed app assets: {error}");
    }
}

/// Derive a app directory name from a Git URL.
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

/// Install a app from a Git URL into `~/.naia/apps/{app-id}/`.
///
/// Ported from the legacy agent skill `agent/src/skills/built-in/app.ts`
/// (#89, with #257 HTTPS-only hardening) into a shell-side Tauri command —
/// app install is a filesystem operation, not an AI task, so it belongs in
/// the shell rather than being routed through the agent.
///
/// The directory name is the app **id** (read from the cloned `app.json`),
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
            "지원하지 않는 소스입니다. HTTPS Git URL만 설치할 수 있습니다\n(예: https://github.com/org/app.git).\n받은 소스: {}",
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
        return Err(format!(
            "유효하지 않은 저장소 이름이 도출되었습니다: {:?}",
            derived
        ));
    }

    let home = data_home::user_home();
    let apps_root = prepare_apps_root(std::path::Path::new(&home))?;
    let canonical_apps_root =
        dunce::canonicalize(&apps_root).map_err(|_| "Access denied".to_string())?;

    // Temp clone target *inside* apps_root (same volume → rename is atomic).
    // Leading-dot prefix keeps it out of the installed-app list while cloning.
    let tmp = apps_root.join(format!(".~install-{}", derived));
    if tmp.exists() {
        let _ = std::fs::remove_dir_all(&tmp); // clear stale partial clone
    }

    // Clone via arg vector — no shell, no shell injection. --depth 1 for speed.
    let mut command = std::process::Command::new("git");
    command.args(["clone", "--depth", "1", source, &tmp.to_string_lossy()]);
    crate::platform::hide_console(&mut command);
    let output = command
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
        id: String,
        name: Option<String>,
    }
    let manifest_data = std::fs::read_to_string(&manifest_path).map_err(|error| {
        let _ = std::fs::remove_dir_all(&tmp);
        format!("app.json을 읽을 수 없습니다: {}", error)
    })?;
    let manifest: ManifestLite = serde_json::from_str(&manifest_data).map_err(|error| {
        let _ = std::fs::remove_dir_all(&tmp);
        format!("app.json 형식이 유효하지 않습니다: {}", error)
    })?;
    let id = manifest.id;
    let display_name = manifest.name.unwrap_or_else(|| derived.clone());

    // The id becomes a path segment — sanitize strictly.
    let id_safe = is_safe_app_id(&id);
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
        if canonical_dest.parent() != Some(canonical_apps_root.as_path()) {
            let _ = std::fs::remove_dir_all(&canonical_dest);
            return Err("Access denied".to_string());
        }
    }

    // Absolutize relative asset URLs so the iframe renders (see fn docs).
    rewrite_installed_app_asset_urls(&dest);

    Ok(AppInstallResult {
        id,
        name: display_name,
        path: dest.to_string_lossy().into_owned(),
    })
}

fn validated_store_gateway(raw: &str) -> Result<url::Url, String> {
    let normalized = raw
        .trim()
        .replace("ws://", "http://")
        .replace("wss://", "https://");
    let mut url =
        url::Url::parse(&normalized).map_err(|_| "Invalid App Store Gateway URL".to_string())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Invalid App Store Gateway URL".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Invalid App Store Gateway URL".to_string())?;
    let production = url.scheme() == "https"
        && host == "api.nextain.io"
        && url.port_or_known_default() == Some(443);
    let loopback = cfg!(debug_assertions)
        && url.scheme() == "http"
        && matches!(host, "localhost" | "127.0.0.1" | "::1");
    if !production && !loopback {
        return Err("Untrusted App Store Gateway origin".to_string());
    }
    url.set_path("/");
    Ok(url)
}

fn store_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

fn store_key(app: &tauri::AppHandle) -> Result<String, String> {
    crate::read_secure_naia_credential(app).ok_or_else(|| "Naia login required".to_string())
}

#[tauri::command]
pub fn app_store_has_entitlement(
    app: tauri::AppHandle,
    app_id: String,
    gateway_url: String,
) -> Result<bool, String> {
    validate_store_app_id(&app_id)?;
    let endpoint = validated_store_gateway(&gateway_url)?
        .join(&format!("v1/apps/entitlements/{app_id}"))
        .map_err(|_| "Invalid entitlement endpoint".to_string())?;
    let response = store_client()?
        .get(endpoint)
        .bearer_auth(store_key(&app)?)
        .send()
        .map_err(|e| format!("Entitlement check failed: {e}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(false);
    }
    if !response.status().is_success() {
        return Err(format!("Entitlement check failed ({})", response.status()));
    }
    let entitlement: StoreEntitlement = response
        .json()
        .map_err(|e| format!("Invalid entitlement: {e}"))?;
    Ok(entitlement.app_id == app_id && entitlement.status == "GRANTED")
}

fn validate_store_app_id(app_id: &str) -> Result<(), String> {
    let id_ok = !app_id.is_empty()
        && app_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !app_id.contains("..");
    if id_ok {
        Ok(())
    } else {
        Err("Invalid app id".to_string())
    }
}

/// Install a reviewed Store ZIP only after the Gateway confirms ownership.
#[tauri::command]
pub fn app_install_store(
    app: tauri::AppHandle,
    app_id: String,
    gateway_url: String,
) -> Result<AppInstallResult, String> {
    validate_store_app_id(&app_id)?;
    let base = validated_store_gateway(&gateway_url)?;
    let client = store_client()?;
    let naia_key = store_key(&app)?;
    let entitlement_url = base
        .join(&format!("v1/apps/entitlements/{app_id}"))
        .map_err(|_| "Invalid entitlement endpoint".to_string())?;
    let entitlement: StoreEntitlement = client
        .get(entitlement_url)
        .bearer_auth(&naia_key)
        .send()
        .map_err(|e| format!("Entitlement check failed: {}", e))?
        .error_for_status()
        .map_err(|e| format!("No install entitlement: {}", e))?
        .json()
        .map_err(|e| format!("Invalid entitlement: {}", e))?;
    if entitlement.app_id != app_id || entitlement.status != "GRANTED" {
        return Err("App entitlement was not granted".to_string());
    }
    let expected_download_path = format!("/v1/apps/entitlements/{app_id}/artifact");
    if entitlement.download_path != expected_download_path {
        return Err("Invalid artifact download path".to_string());
    }
    let artifact = entitlement.artifact;
    if artifact.manifest.get("id").and_then(|v| v.as_str()) != Some(app_id.as_str()) {
        return Err("Artifact manifest mismatch".to_string());
    }
    const MAX_ARTIFACT_BYTES: u64 = 50 * 1024 * 1024;
    const MAX_EXTRACTED_BYTES: u64 = 200 * 1024 * 1024;
    const MAX_ARCHIVE_ENTRIES: usize = 4096;
    if artifact.size == 0 || artifact.size > MAX_ARTIFACT_BYTES {
        return Err("Artifact size is outside policy limits".to_string());
    }
    let artifact_url = base
        .join(entitlement.download_path.trim_start_matches('/'))
        .map_err(|_| "Invalid artifact download path".to_string())?;
    let mut response = client
        .get(artifact_url)
        .bearer_auth(&naia_key)
        .send()
        .map_err(|e| format!("Artifact download failed: {}", e))?
        .error_for_status()
        .map_err(|e| format!("Artifact download failed: {}", e))?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_ARTIFACT_BYTES || length != artifact.size)
    {
        return Err("Artifact size verification failed".to_string());
    }
    let mut bytes = Vec::with_capacity(artifact.size as usize);
    response
        .by_ref()
        .take(MAX_ARTIFACT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 != artifact.size {
        return Err("Artifact size verification failed".to_string());
    }
    let digest_bytes = Sha256::digest(&bytes);
    let digest = format!("{:x}", digest_bytes);
    if !digest.eq_ignore_ascii_case(&artifact.sha256) {
        return Err("Artifact SHA-256 verification failed".to_string());
    }
    verify_artifact_signature(digest_bytes.as_slice(), &artifact.signature)?;

    // 설치·목록·삭제가 같은 자리 함수를 쓰게 한다.
    //
    // 이 자리만 `direct_child_of` 를 직접 불렀다. 그러면 옛 `panels` 자리를
    // 옮기는 이주도, 홈 밖으로 새는지 보는 검사도 건너뛴다 — 설치는 성공했다고
    // 말하는데 목록·탭에는 안 보이던 #472 가 정확히 그 갈라짐이었다. 스토어
    // 설치가 그 자리에 다시 서면 같은 사고가 다시 난다.
    let apps_root = prepare_apps_root(std::path::Path::new(&data_home::user_home()))?;
    let temp = tempfile::Builder::new()
        .prefix(".store-install-")
        .tempdir_in(&apps_root)
        .map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("Invalid app ZIP: {}", e))?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("App ZIP contains too many entries".to_string());
    }
    let mut extracted_bytes = 0_u64;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|e| e.to_string())?;
        if file
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("Symlinks are not allowed in app ZIPs".to_string());
        }
        extracted_bytes = extracted_bytes
            .checked_add(file.size())
            .ok_or_else(|| "App ZIP size overflow".to_string())?;
        if extracted_bytes > MAX_EXTRACTED_BYTES {
            return Err("Expanded app exceeds policy limits".to_string());
        }
        let relative = file
            .enclosed_name()
            .ok_or_else(|| "Unsafe path in app ZIP".to_string())?;
        let output = temp.path().join(relative);
        if file.is_dir() {
            std::fs::create_dir_all(&output).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut target = std::fs::File::create(&output).map_err(|e| e.to_string())?;
        std::io::copy(&mut file, &mut target).map_err(|e| e.to_string())?;
    }
    let manifest_path = temp.path().join("app.json");
    let manifest: AppManifest = serde_json::from_reader(
        std::fs::File::open(&manifest_path).map_err(|_| "app.json missing".to_string())?,
    )
    .map_err(|e| format!("Invalid app.json: {}", e))?;
    if manifest.id != app_id {
        return Err("Installed manifest id mismatch".to_string());
    }
    if !temp.path().join("index.html").is_file() {
        return Err("index.html missing".to_string());
    }
    let destination = apps_root.join(&app_id);
    if destination.exists() {
        return Err("App is already installed; remove it before reinstalling".to_string());
    }
    let kept = temp.keep();
    std::fs::rename(&kept, &destination).map_err(|e| format!("Install finalize failed: {}", e))?;
    // Absolutize relative asset URLs so the iframe renders (see fn docs).
    rewrite_installed_app_asset_urls(&destination);
    Ok(AppInstallResult {
        id: app_id,
        name: manifest.name,
        path: destination.to_string_lossy().into_owned(),
    })
}
