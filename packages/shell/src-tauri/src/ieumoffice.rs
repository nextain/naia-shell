//! IeumOffice (`pblsketch/ieumoffice`) installation detection, `ieumoffice mcp`
//! auto-connection for Naia Agent & coding agents, and Naia AI provider preset (#870).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const IEUMOFFICE_OFFICIAL_REPO_URL: &str = "https://github.com/pblsketch/ieumoffice";
pub const IEUMOFFICE_OFFICIAL_RELEASES_URL: &str =
    "https://github.com/pblsketch/ieumoffice/releases";
pub const IEUMOFFICE_OFFICIAL_SITE_URL: &str = "https://ieumoffice.com";
pub const IEUMOFFICE_MCP_SERVER_NAME: &str = "ieumoffice";
pub const DEFAULT_NAIA_GATEWAY_V1_URL: &str = "https://api.naia.land/v1";
pub const DEFAULT_NAIA_LOCAL_OLLAMA_V1_URL: &str = "http://127.0.0.1:11434/v1";
pub const DEFAULT_NAIA_MODEL_ID: &str = "naia/solar-pro4";

const MCP_SETTINGS_FILENAME: &str = "ieumoffice-mcp.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IeumOfficeMcpLaunch {
    pub command: String,
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IeumOfficePersistedMcpConfig {
    pub version: u32,
    pub server_name: String,
    pub enabled: bool,
    pub auto_detected: bool,
    pub user_explicit: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected_version: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IeumOfficeNaiaPreset {
    pub cloud_name: String,
    pub cloud_base_url: String,
    pub cloud_model: String,
    pub local_name: String,
    pub local_base_url: String,
    pub local_model: String,
    pub official_repo_url: String,
    pub official_releases_url: String,
    pub official_site_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IeumOfficeStatus {
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub mcp_enabled: bool,
    pub auto_connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_launch: Option<IeumOfficeMcpLaunch>,
    pub official_repo_url: String,
    pub official_releases_url: String,
    pub official_site_url: String,
    pub naia_preset: IeumOfficeNaiaPreset,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IeumOfficeCodingAgentsResult {
    pub ok: bool,
    pub exit_code: Option<i32>,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentMcpSpawnEnv {
    pub mcp_name: String,
    pub mcp_cmd: String,
    pub extra_path_dir: Option<PathBuf>,
    pub electron_run_as_node: bool,
}

#[derive(Debug, Clone, Default)]
pub struct DetectionEnv {
    pub os: String,
    pub path_dirs: Vec<PathBuf>,
    pub user_home: Option<PathBuf>,
    pub local_app_data: Option<PathBuf>,
    pub program_files: Option<PathBuf>,
    pub xdg_bin_home: Option<PathBuf>,
}

impl DetectionEnv {
    pub fn from_system(user_home: Option<PathBuf>) -> Self {
        let os = if cfg!(windows) {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            "linux"
        }
        .to_string();
        let path_dirs = std::env::var_os("PATH")
            .map(|raw| {
                std::env::split_paths(&raw)
                    .filter(|p| !p.as_os_str().is_empty())
                    .collect()
            })
            .unwrap_or_default();
        let local_app_data = std::env::var_os("LOCALAPPDATA")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from);
        let program_files = std::env::var_os("ProgramFiles")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from);
        let xdg_bin_home = std::env::var_os("XDG_BIN_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from);
        Self {
            os,
            path_dirs,
            user_home,
            local_app_data,
            program_files,
            xdg_bin_home,
        }
    }
}

fn now_epoch_secs() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Ordered candidate paths for `ieumoffice` across PATH and standard OS install roots.
pub fn candidate_paths(env: &DetectionEnv) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let names: &[&str] = if env.os == "windows" {
        &["ieumoffice.cmd", "ieumoffice.exe", "ieumoffice"]
    } else {
        &["ieumoffice"]
    };

    for dir in &env.path_dirs {
        for name in names {
            out.push(dir.join(name));
        }
    }

    match env.os.as_str() {
        "windows" => {
            if let Some(local) = &env.local_app_data {
                let root = local.join("Programs").join("IeumOffice");
                out.push(root.join("IeumOffice.exe"));
                out.push(root.join("resources").join("cli").join("ieumoffice.cmd"));
            }
            if let Some(pf) = &env.program_files {
                let root = pf.join("IeumOffice");
                out.push(root.join("IeumOffice.exe"));
                out.push(root.join("resources").join("cli").join("ieumoffice.cmd"));
            }
        }
        "macos" => {
            out.push(PathBuf::from(
                "/Applications/IeumOffice.app/Contents/Resources/cli/ieumoffice",
            ));
            if let Some(home) = &env.user_home {
                out.push(home.join("Applications/IeumOffice.app/Contents/Resources/cli/ieumoffice"));
            }
            out.push(PathBuf::from("/usr/local/bin/ieumoffice"));
            out.push(PathBuf::from("/opt/homebrew/bin/ieumoffice"));
            if let Some(xdg) = &env.xdg_bin_home {
                out.push(xdg.join("ieumoffice"));
            }
            if let Some(home) = &env.user_home {
                out.push(home.join(".local/bin/ieumoffice"));
            }
        }
        _ => {
            if let Some(xdg) = &env.xdg_bin_home {
                out.push(xdg.join("ieumoffice"));
            }
            if let Some(home) = &env.user_home {
                out.push(home.join(".local/bin/ieumoffice"));
            }
            out.push(PathBuf::from("/usr/local/bin/ieumoffice"));
            out.push(PathBuf::from("/usr/bin/ieumoffice"));
            out.push(PathBuf::from("/opt/IeumOffice/resources/cli/ieumoffice"));
            out.push(PathBuf::from("/opt/ieumoffice/resources/cli/ieumoffice"));
        }
    }

    out
}

pub fn find_installed_binary_with<F>(env: &DetectionEnv, mut exists_exec: F) -> Option<PathBuf>
where
    F: FnMut(&Path) -> bool,
{
    for candidate in candidate_paths(env) {
        if exists_exec(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// Build the stdio MCP launch command matching `pblsketch/ieumoffice/packages/cli/src/mcp-launch.ts`.
///
/// On Windows packaged installs (`IeumOffice.exe` + `resources/cli/genoffice.cjs`),
/// MCP clients spawn without a shell, so `.cmd` wrappers break or split paths with spaces.
/// Running `IeumOffice.exe` with `ELECTRON_RUN_AS_NODE=1` on `genoffice.cjs mcp` avoids `.cmd` entirely.
pub fn build_mcp_launch_with<F>(
    detected: &Path,
    os: &str,
    mut file_exists: F,
) -> IeumOfficeMcpLaunch
where
    F: FnMut(&Path) -> bool,
{
    if os == "windows" {
        let file_name = detected
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if file_name == "ieumoffice.exe" {
            if let Some(install_dir) = detected.parent() {
                let bundle = install_dir.join("resources").join("cli").join("genoffice.cjs");
                if file_exists(&bundle) {
                    let mut env = BTreeMap::new();
                    env.insert("ELECTRON_RUN_AS_NODE".to_string(), "1".to_string());
                    return IeumOfficeMcpLaunch {
                        command: detected.to_string_lossy().into_owned(),
                        args: vec![bundle.to_string_lossy().into_owned(), "mcp".to_string()],
                        env,
                    };
                }
            }
        } else if let Some(cli_dir) = detected.parent() {
            // `<InstallDir>/resources/cli/ieumoffice.cmd`
            if let Some(install_dir) = cli_dir.parent().and_then(Path::parent) {
                let app_exe = install_dir.join("IeumOffice.exe");
                let bundle = cli_dir.join("genoffice.cjs");
                if file_exists(&app_exe) && file_exists(&bundle) {
                    let mut env = BTreeMap::new();
                    env.insert("ELECTRON_RUN_AS_NODE".to_string(), "1".to_string());
                    return IeumOfficeMcpLaunch {
                        command: app_exe.to_string_lossy().into_owned(),
                        args: vec![bundle.to_string_lossy().into_owned(), "mcp".to_string()],
                        env,
                    };
                }
            }
        }
    }

    IeumOfficeMcpLaunch {
        command: detected.to_string_lossy().into_owned(),
        args: vec!["mcp".to_string()],
        env: BTreeMap::new(),
    }
}

fn run_with_timeout(
    launch: &IeumOfficeMcpLaunch,
    subcommand_args: &[&str],
    timeout: Duration,
) -> Result<(Option<i32>, String, String), String> {
    let mut cmd = Command::new(&launch.command);
    // Replace trailing "mcp" from launch.args with caller's subcommand args while preserving bundle path if any.
    let prefix_len = launch.args.len().saturating_sub(1);
    for arg in &launch.args[..prefix_len] {
        cmd.arg(arg);
    }
    for arg in subcommand_args {
        cmd.arg(arg);
    }
    for (k, v) in &launch.env {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::platform::hide_console(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn ieumoffice: {e}"))?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = String::new();
                let mut stderr = String::new();
                if let Some(mut out) = child.stdout.take() {
                    let _ = io::Read::read_to_string(&mut out, &mut stdout);
                }
                if let Some(mut err) = child.stderr.take() {
                    let _ = io::Read::read_to_string(&mut err, &mut stderr);
                }
                return Ok((status.code(), stdout, stderr));
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("ieumoffice command timed out".to_string());
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(e) => return Err(format!("ieumoffice wait failed: {e}")),
        }
    }
}

fn probe_version(launch: &IeumOfficeMcpLaunch) -> Option<String> {
    let (code, stdout, stderr) = run_with_timeout(launch, &["--version"], Duration::from_secs(4)).ok()?;
    if code != Some(0) {
        return None;
    }
    stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}

pub fn build_naia_preset(
    gateway_url: Option<&str>,
    model: Option<&str>,
    local_model: Option<&str>,
) -> IeumOfficeNaiaPreset {
    let normalized_gateway = gateway_url
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .map(|u| {
            let trimmed = u.trim_end_matches('/');
            if trimmed.ends_with("/v1") {
                trimmed.to_string()
            } else {
                format!("{trimmed}/v1")
            }
        })
        .unwrap_or_else(|| DEFAULT_NAIA_GATEWAY_V1_URL.to_string());
    let cloud_model = model
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or(DEFAULT_NAIA_MODEL_ID)
        .to_string();
    let local_model = local_model
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or("qwen3:8b")
        .to_string();
    IeumOfficeNaiaPreset {
        cloud_name: "Naia Cloud Gateway".to_string(),
        cloud_base_url: normalized_gateway,
        cloud_model,
        local_name: "Naia Local AI (Ollama)".to_string(),
        local_base_url: DEFAULT_NAIA_LOCAL_OLLAMA_V1_URL.to_string(),
        local_model,
        official_repo_url: IEUMOFFICE_OFFICIAL_REPO_URL.to_string(),
        official_releases_url: IEUMOFFICE_OFFICIAL_RELEASES_URL.to_string(),
        official_site_url: IEUMOFFICE_OFFICIAL_SITE_URL.to_string(),
    }
}

fn settings_file_for_adk(adk_path: &Path) -> Result<PathBuf, String> {
    if !adk_path.is_dir() {
        return Err("adk_path_not_found".to_string());
    }
    let canonical = dunce::canonicalize(adk_path).map_err(|_| "adk_path_invalid".to_string())?;
    let settings_dir = canonical.join("naia-settings");
    if let Ok(meta) = std::fs::symlink_metadata(&settings_dir) {
        if meta.file_type().is_symlink() {
            return Err("naia_settings_symlink_forbidden".to_string());
        }
    }
    let file = settings_dir.join(MCP_SETTINGS_FILENAME);
    if let Ok(meta) = std::fs::symlink_metadata(&file) {
        if meta.file_type().is_symlink() {
            return Err("ieumoffice_mcp_symlink_forbidden".to_string());
        }
    }
    Ok(file)
}

pub fn read_persisted_mcp_config(adk_path: &Path) -> Option<IeumOfficePersistedMcpConfig> {
    let file = settings_file_for_adk(adk_path).ok()?;
    let raw = std::fs::read_to_string(file).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn write_persisted_mcp_config(
    adk_path: &Path,
    cfg: &IeumOfficePersistedMcpConfig,
) -> Result<(), String> {
    let file = settings_file_for_adk(adk_path)?;
    let parent = file
        .parent()
        .ok_or_else(|| "ieumoffice_mcp_invalid_parent".to_string())?;
    std::fs::create_dir_all(parent).map_err(|_| "ieumoffice_mcp_mkdir_failed".to_string())?;
    let json = serde_json::to_vec_pretty(cfg)
        .map_err(|_| "ieumoffice_mcp_serialize_failed".to_string())?;
    let mut tmp =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| "ieumoffice_mcp_tmp_failed".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tmp
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600));
    }
    tmp.write_all(&json)
        .and_then(|_| tmp.flush())
        .map_err(|_| "ieumoffice_mcp_write_failed".to_string())?;
    tmp.persist(&file)
        .map(|_| ())
        .map_err(|_| "ieumoffice_mcp_persist_failed".to_string())
}

/// Detect IeumOffice and synchronize `{adk_path}/naia-settings/ieumoffice-mcp.json`.
///
/// When IeumOffice is installed and the user has not explicitly turned MCP off,
/// `mcp_enabled` defaults to `true` and persists automatically so `naia-agent`
/// connects to `ieumoffice mcp` without manual terminal setup.
pub fn detect_and_sync_status(
    env: &DetectionEnv,
    adk_path: Option<&Path>,
    gateway_url: Option<&str>,
    model: Option<&str>,
) -> IeumOfficeStatus {
    let naia_preset = build_naia_preset(gateway_url, model, None);
    let detected = find_installed_binary_with(env, is_executable_file);
    let Some(binary) = detected else {
        let persisted = adk_path.and_then(read_persisted_mcp_config);
        return IeumOfficeStatus {
            installed: false,
            binary_path: None,
            version: None,
            mcp_enabled: persisted.map(|p| p.enabled && p.user_explicit).unwrap_or(false),
            auto_connected: false,
            mcp_launch: None,
            official_repo_url: IEUMOFFICE_OFFICIAL_REPO_URL.to_string(),
            official_releases_url: IEUMOFFICE_OFFICIAL_RELEASES_URL.to_string(),
            official_site_url: IEUMOFFICE_OFFICIAL_SITE_URL.to_string(),
            naia_preset,
        };
    };

    let launch = build_mcp_launch_with(&binary, &env.os, Path::is_file);
    let version = probe_version(&launch);
    let persisted = adk_path.and_then(read_persisted_mcp_config);
    let (mcp_enabled, user_explicit) = match &persisted {
        Some(prev) if prev.user_explicit => (prev.enabled, true),
        _ => (true, false),
    };

    if let Some(adk) = adk_path {
        let next = IeumOfficePersistedMcpConfig {
            version: 1,
            server_name: IEUMOFFICE_MCP_SERVER_NAME.to_string(),
            enabled: mcp_enabled,
            auto_detected: true,
            user_explicit,
            command: Some(launch.command.clone()),
            args: launch.args.clone(),
            env: launch.env.clone(),
            detected_version: version.clone(),
            updated_at: now_epoch_secs(),
        };
        let _ = write_persisted_mcp_config(adk, &next);
    }

    IeumOfficeStatus {
        installed: true,
        binary_path: Some(binary.to_string_lossy().into_owned()),
        version,
        mcp_enabled,
        auto_connected: mcp_enabled && !user_explicit,
        mcp_launch: Some(launch),
        official_repo_url: IEUMOFFICE_OFFICIAL_REPO_URL.to_string(),
        official_releases_url: IEUMOFFICE_OFFICIAL_RELEASES_URL.to_string(),
        official_site_url: IEUMOFFICE_OFFICIAL_SITE_URL.to_string(),
        naia_preset,
    }
}

pub fn set_mcp_enabled_for_adk(
    env: &DetectionEnv,
    adk_path: &Path,
    enabled: bool,
) -> Result<IeumOfficeStatus, String> {
    let detected = find_installed_binary_with(env, is_executable_file);
    let launch = detected
        .as_ref()
        .map(|bin| build_mcp_launch_with(bin, &env.os, Path::is_file));
    let version = launch.as_ref().and_then(probe_version);
    let cfg = IeumOfficePersistedMcpConfig {
        version: 1,
        server_name: IEUMOFFICE_MCP_SERVER_NAME.to_string(),
        enabled,
        auto_detected: detected.is_some(),
        user_explicit: true,
        command: launch.as_ref().map(|l| l.command.clone()),
        args: launch.as_ref().map(|l| l.args.clone()).unwrap_or_default(),
        env: launch.as_ref().map(|l| l.env.clone()).unwrap_or_default(),
        detected_version: version.clone(),
        updated_at: now_epoch_secs(),
    };
    write_persisted_mcp_config(adk_path, &cfg)?;

    Ok(IeumOfficeStatus {
        installed: detected.is_some(),
        binary_path: detected.map(|p| p.to_string_lossy().into_owned()),
        version,
        mcp_enabled: enabled && launch.is_some(),
        auto_connected: false,
        mcp_launch: launch,
        official_repo_url: IEUMOFFICE_OFFICIAL_REPO_URL.to_string(),
        official_releases_url: IEUMOFFICE_OFFICIAL_RELEASES_URL.to_string(),
        official_site_url: IEUMOFFICE_OFFICIAL_SITE_URL.to_string(),
        naia_preset: build_naia_preset(None, None, None),
    })
}

/// Compute whitespace-safe `NAIA_MCP_CMD` / `NAIA_MCP_NAME` env vars for `naia-agent`.
///
/// `naia-agent`'s `compose-agent-deps.mjs` splits `NAIA_MCP_CMD` on whitespace (`split(/\s+/)`).
/// When `launch.command` has no whitespace (and `args` have no whitespace), we pass the full path;
/// when `launch.command` lives in a directory containing spaces (e.g. `C:\Users\Jane Doe\...`) and
/// `args` are bare `["mcp"]`, we prepend the parent directory to `PATH` and invoke the bare binary name.
pub fn compute_agent_mcp_spawn_env(status: &IeumOfficeStatus) -> Option<AgentMcpSpawnEnv> {
    if !status.installed || !status.mcp_enabled {
        return None;
    }
    let launch = status.mcp_launch.as_ref()?;
    let has_ws = |s: &str| s.chars().any(char::is_whitespace);
    let electron_run_as_node = launch
        .env
        .get("ELECTRON_RUN_AS_NODE")
        .map(|v| v == "1")
        .unwrap_or(false);

    if !has_ws(&launch.command) && launch.args.iter().all(|a| !has_ws(a)) {
        let mut parts = vec![launch.command.clone()];
        parts.extend(launch.args.iter().cloned());
        return Some(AgentMcpSpawnEnv {
            mcp_name: IEUMOFFICE_MCP_SERVER_NAME.to_string(),
            mcp_cmd: parts.join(" "),
            extra_path_dir: None,
            electron_run_as_node,
        });
    }

    // Fallback when installation directory contains spaces: expose binary parent via PATH if args are space-free.
    if launch.args.iter().all(|a| !has_ws(a)) {
        let cmd_path = Path::new(&launch.command);
        let file_name = cmd_path.file_name()?.to_str()?;
        if !has_ws(file_name) {
            let parent = cmd_path.parent()?.to_path_buf();
            let mut parts = vec![file_name.to_string()];
            parts.extend(launch.args.iter().cloned());
            return Some(AgentMcpSpawnEnv {
                mcp_name: IEUMOFFICE_MCP_SERVER_NAME.to_string(),
                mcp_cmd: parts.join(" "),
                extra_path_dir: Some(parent),
                electron_run_as_node,
            });
        }
    }

    None
}

pub fn apply_agent_ieumoffice_mcp_env(
    cmd: &mut Command,
    adk_path: Option<&str>,
    user_home: Option<PathBuf>,
) {
    // Respect explicit maintainer override if already set in host environment.
    if std::env::var_os("NAIA_MCP_CMD").is_some() {
        return;
    }
    let env = DetectionEnv::from_system(user_home);
    let adk = adk_path
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let status = detect_and_sync_status(&env, adk.as_deref(), None, None);
    let Some(mcp_env) = compute_agent_mcp_spawn_env(&status) else {
        return;
    };
    cmd.env("NAIA_MCP_NAME", &mcp_env.mcp_name);
    cmd.env("NAIA_MCP_CMD", &mcp_env.mcp_cmd);
    if mcp_env.electron_run_as_node {
        cmd.env("ELECTRON_RUN_AS_NODE", "1");
    }
    if let Some(extra_dir) = mcp_env.extra_path_dir {
        let mut paths = vec![extra_dir];
        if let Some(existing) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&existing));
        }
        if let Ok(joined) = std::env::join_paths(paths) {
            cmd.env("PATH", joined);
        }
    }
}

pub fn register_coding_agents(env: &DetectionEnv) -> Result<IeumOfficeCodingAgentsResult, String> {
    let binary = find_installed_binary_with(env, is_executable_file)
        .ok_or_else(|| "ieumoffice_not_installed".to_string())?;
    let launch = build_mcp_launch_with(&binary, &env.os, Path::is_file);
    let (code, stdout, stderr) =
        run_with_timeout(&launch, &["mcp", "install"], Duration::from_secs(15))?;
    let ok = code == Some(0);
    let summary = stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .take(6)
        .collect::<Vec<_>>()
        .join("\n");
    Ok(IeumOfficeCodingAgentsResult {
        ok,
        exit_code: code,
        summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_cover_windows_macos_linux_locations() {
        let win = DetectionEnv {
            os: "windows".to_string(),
            path_dirs: vec![PathBuf::from(r"C:\Tools\bin")],
            user_home: None,
            local_app_data: Some(PathBuf::from(r"C:\AppData\Local")),
            program_files: Some(PathBuf::from(r"C:\Program Files")),
            xdg_bin_home: None,
        };
        let win_paths: Vec<String> = candidate_paths(&win)
            .into_iter()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .collect();
        assert!(win_paths.iter().any(|p| p.ends_with("Programs/IeumOffice/IeumOffice.exe")));
        assert!(win_paths
            .iter()
            .any(|p| p.ends_with("Programs/IeumOffice/resources/cli/ieumoffice.cmd")));

        let mac = DetectionEnv {
            os: "macos".to_string(),
            path_dirs: vec![],
            user_home: Some(PathBuf::from("/Users/tester")),
            local_app_data: None,
            program_files: None,
            xdg_bin_home: None,
        };
        let mac_paths: Vec<String> = candidate_paths(&mac)
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        assert!(mac_paths.contains(&"/Applications/IeumOffice.app/Contents/Resources/cli/ieumoffice".to_string()));
        assert!(mac_paths.contains(&"/Users/tester/.local/bin/ieumoffice".to_string()));

        let linux = DetectionEnv {
            os: "linux".to_string(),
            path_dirs: vec![],
            user_home: Some(PathBuf::from("/tmp/fake-user")),
            local_app_data: None,
            program_files: None,
            xdg_bin_home: None,
        };
        let linux_paths: Vec<String> = candidate_paths(&linux)
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        assert!(linux_paths.contains(&"/usr/bin/ieumoffice".to_string()));
        assert!(linux_paths.contains(&"/tmp/fake-user/.local/bin/ieumoffice".to_string()));
    }

    #[test]
    fn windows_packaged_launch_uses_electron_run_as_node_without_cmd() {
        let exe = PathBuf::from(r"C:\AppData\Local\Programs\IeumOffice\IeumOffice.exe");
        let launch = build_mcp_launch_with(&exe, "windows", |p| {
            let norm = p.to_string_lossy().replace('\\', "/");
            norm.ends_with("IeumOffice/resources/cli/genoffice.cjs")
        });
        assert_eq!(launch.env.get("ELECTRON_RUN_AS_NODE").map(String::as_str), Some("1"));
        assert_eq!(launch.args.len(), 2);
        assert!(launch.args[0].ends_with("genoffice.cjs"));
        assert_eq!(launch.args[1], "mcp");
    }

    #[test]
    fn persisted_mcp_config_roundtrip_and_explicit_toggle() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let env = DetectionEnv {
            os: "linux".to_string(),
            path_dirs: vec![],
            user_home: None,
            local_app_data: None,
            program_files: None,
            xdg_bin_home: None,
        };
        let status_off = set_mcp_enabled_for_adk(&env, tmp.path(), false).expect("set off");
        assert!(!status_off.mcp_enabled);
        let read_back = read_persisted_mcp_config(tmp.path()).expect("persisted");
        assert!(!read_back.enabled);
        assert!(read_back.user_explicit);
    }

    #[test]
    fn naia_preset_uses_official_ieumoffice_urls_and_normalizes_v1() {
        let preset = build_naia_preset(Some("https://api.naia.land/"), Some("naia/solar-pro4"), None);
        assert_eq!(preset.cloud_base_url, "https://api.naia.land/v1");
        assert_eq!(preset.official_repo_url, "https://github.com/pblsketch/ieumoffice");
        assert_eq!(
            preset.official_releases_url,
            "https://github.com/pblsketch/ieumoffice/releases"
        );
    }

    #[test]
    fn compute_agent_mcp_spawn_env_handles_standard_and_spaced_paths() {
        let status = IeumOfficeStatus {
            installed: true,
            binary_path: Some("/usr/local/bin/ieumoffice".to_string()),
            version: Some("0.10.0".to_string()),
            mcp_enabled: true,
            auto_connected: true,
            mcp_launch: Some(IeumOfficeMcpLaunch {
                command: "/usr/local/bin/ieumoffice".to_string(),
                args: vec!["mcp".to_string()],
                env: BTreeMap::new(),
            }),
            official_repo_url: IEUMOFFICE_OFFICIAL_REPO_URL.to_string(),
            official_releases_url: IEUMOFFICE_OFFICIAL_RELEASES_URL.to_string(),
            official_site_url: IEUMOFFICE_OFFICIAL_SITE_URL.to_string(),
            naia_preset: build_naia_preset(None, None, None),
        };
        let env = compute_agent_mcp_spawn_env(&status).expect("mcp env");
        assert_eq!(env.mcp_name, "ieumoffice");
        assert_eq!(env.mcp_cmd, "/usr/local/bin/ieumoffice mcp");
        assert!(env.extra_path_dir.is_none());

        let spaced = IeumOfficeStatus {
            mcp_launch: Some(IeumOfficeMcpLaunch {
                command: "/opt/Ieum Office/bin/ieumoffice".to_string(),
                args: vec!["mcp".to_string()],
                env: BTreeMap::new(),
            }),
            ..status
        };
        let spaced_env = compute_agent_mcp_spawn_env(&spaced).expect("spaced mcp env");
        assert_eq!(spaced_env.mcp_cmd, "ieumoffice mcp");
        assert_eq!(
            spaced_env.extra_path_dir,
            Some(PathBuf::from("/opt/Ieum Office/bin"))
        );
    }
}
