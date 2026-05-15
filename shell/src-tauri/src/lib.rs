mod audit;
mod browser;
mod browser_webview;
mod capture;
mod gemini_live;
mod memory;
mod panel;
mod platform;
mod pty;
mod stt_models;
mod workspace;

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::thread;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize};
use tauri_plugin_deep_link::DeepLinkExt;

/// Cross-platform home directory: HOME (Unix) or USERPROFILE (Windows).
pub(crate) fn home_dir() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default()
}

/// Search a node version manager directory for the highest Node 22+ version.
pub(crate) fn find_highest_node_version(
    versions_dir: &str,
    bin_subpath: &str,
) -> Option<std::path::PathBuf> {
    let entries = std::fs::read_dir(versions_dir).ok()?;
    let mut versions: Vec<_> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let name = name.trim_start_matches('v').to_string();
            let major: u32 = name.split('.').next()?.parse().ok()?;
            if major >= 22 {
                Some((major, e.path()))
            } else {
                None
            }
        })
        .collect();
    versions.sort_by(|a, b| b.0.cmp(&a.0));
    versions.first().and_then(|(_, path)| {
        let node_bin = path.join(bin_subpath);
        if node_bin.exists() {
            Some(node_bin)
        } else {
            None
        }
    })
}

/// Process a deep-link URL (naia://auth?key=xxx). Extracted as a function
/// so both the Tauri deep-link plugin callback and the Windows file watcher
/// can share the same parsing + validation logic.
pub(crate) fn process_deep_link_url(
    url_str: &str,
    app_handle: &AppHandle,
    oauth_state: Option<&Arc<Mutex<Option<String>>>>,
    source: &str,
) {
    let redacted = url_str.split('?').next().unwrap_or(url_str);
    log_both(&format!(
        "[Naia] Deep link received ({}): {}?[REDACTED]",
        source, redacted
    ));
    let parsed = match url::Url::parse(url_str) {
        Ok(u) => u,
        Err(_) => return,
    };
    if parsed.host_str() != Some("auth") && parsed.path() != "auth" && parsed.path() != "/auth" {
        return;
    }
    let mut key = None;
    let mut code = None;
    let mut user_id = None;
    let mut incoming_state = None;
    let mut channel = None;
    let mut discord_user_id = None;
    let mut discord_channel_id = None;
    let mut discord_target = None;
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "key" => key = Some(v.to_string()),
            "code" => code = Some(v.to_string()),
            "user_id" => user_id = Some(v.to_string()),
            "state" => incoming_state = Some(v.to_string()),
            "channel" => channel = Some(v.to_string()),
            "discord_user_id" | "discordUserId" => discord_user_id = Some(v.to_string()),
            "discord_channel_id" | "discordChannelId" => discord_channel_id = Some(v.to_string()),
            "discord_target" | "discordTarget" => discord_target = Some(v.to_string()),
            _ => {}
        }
    }
    if let Some(state_mutex) = oauth_state {
        let expected = lock_or_recover(state_mutex, "oauth_state(deep_link)").clone();
        if let Some(ref expected_val) = expected {
            match &incoming_state {
                Some(s) if s == expected_val => {
                    *lock_or_recover(state_mutex, "oauth_state(clear)") = None;
                }
                Some(_) => {
                    log_both("[Naia] Deep link rejected: state mismatch");
                    return;
                }
                None => {
                    log_both("[Naia] Deep link rejected: missing state parameter");
                    return;
                }
            }
        }
    }
    let validated_user_id = user_id.filter(|uid| {
        uid.len() <= 256
            && uid
                .chars()
                .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '@')
    });
    let resolved_key = if key.is_some() {
        key
    } else if let Some(code_val) = code {
        if code_val.starts_with("gw-") {
            Some(code_val)
        } else {
            log_both("[Naia] Deep link rejected: code is not a gateway API key");
            None
        }
    } else {
        None
    };
    if let Some(naia_key) = resolved_key {
        let is_valid = naia_key.starts_with("gw-")
            && naia_key.len() <= 256
            && naia_key
                .chars()
                .all(|c| c.is_alphanumeric() || c == '-' || c == '_');
        if is_valid {
            let payload =
                serde_json::json!({ "naiaKey": naia_key, "naiaUserId": validated_user_id });
            let _ = app_handle.emit("naia_auth_complete", payload);
            log_both("[Naia] Naia auth complete — key received via deep link");
        } else {
            log_both("[Naia] Deep link rejected: invalid key format");
        }
    }
    let is_discord_flow = matches!(channel.as_deref(), Some("discord"))
        || discord_user_id.is_some()
        || discord_channel_id.is_some()
        || discord_target.is_some();
    if is_discord_flow {
        let validated_discord_user_id =
            discord_user_id.filter(|uid| is_valid_discord_snowflake(uid));
        let validated_discord_channel_id =
            discord_channel_id.filter(|cid| is_valid_discord_snowflake(cid));
        let normalized_target = discord_target
            .and_then(|t| {
                let t = t.trim().to_string();
                if t.starts_with("user:") || t.starts_with("channel:") {
                    Some(t)
                } else {
                    None
                }
            })
            .or_else(|| {
                validated_discord_user_id
                    .as_ref()
                    .map(|uid| format!("user:{}", uid))
            })
            .or_else(|| {
                validated_discord_channel_id
                    .as_ref()
                    .map(|cid| format!("channel:{}", cid))
            });
        let payload = serde_json::json!({
            "discordUserId": validated_discord_user_id,
            "discordChannelId": validated_discord_channel_id,
            "discordTarget": normalized_target,
        });
        let _ = app_handle.emit("discord_auth_complete", payload);
        log_both("[Naia] Discord auth complete — deep link payload received");
    }
}

#[cfg(target_os = "linux")]
use webkit2gtk::glib::object::ObjectExt;
#[cfg(target_os = "linux")]
use webkit2gtk::PermissionRequestExt;

// agent-core process handle
struct AgentProcess {
    child: Child,
    stdin: std::process::ChildStdin,
}

// Naia Gateway + Node Host process handle
struct GatewayProcess {
    child: Child,
    node_host: Option<Child>,
    we_spawned: bool, // only kill on shutdown if we spawned it
}

struct AppState {
    agent: Mutex<Option<AgentProcess>>,
    gateway: Mutex<Option<GatewayProcess>>,
    health_monitor_shutdown: Mutex<Option<Arc<std::sync::atomic::AtomicBool>>>,
    /// Random state token for OAuth deep link CSRF protection.
    oauth_state: Arc<Mutex<Option<String>>>,
    /// Active Gemini Live WebSocket proxy session.
    gemini_live: gemini_live::SharedHandle,
    /// Last agent-core restart timestamp — debounce to prevent restart storms (#226).
    last_agent_restart: Mutex<Option<std::time::Instant>>,
}

struct AuditState {
    db: audit::AuditDb,
}

fn lock_or_recover<'a, T>(mutex: &'a Mutex<T>, name: &str) -> MutexGuard<'a, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            log_both(&format!(
                "[Naia] Recovered poisoned lock: {} (another task failed)",
                name
            ));
            poisoned.into_inner()
        }
    }
}

fn is_valid_discord_snowflake(value: &str) -> bool {
    let trimmed = value.trim();
    (6..=32).contains(&trimmed.len()) && trimmed.chars().all(|c| c.is_ascii_digit())
}

/// JSON chunk forwarded from agent-core stdout to the frontend
#[derive(Debug, Serialize, Deserialize, Clone)]
#[allow(dead_code)]
struct AgentChunk {
    #[serde(rename = "type")]
    chunk_type: String,
    #[serde(flatten)]
    rest: serde_json::Value,
}

/// Skill manifest info returned from list_skills command
#[derive(Debug, Serialize, Deserialize, Clone)]
struct SkillManifestInfo {
    name: String,
    description: String,
    #[serde(rename = "type")]
    skill_type: String,
    tier: u32,
    source: String,
    #[serde(rename = "gatewaySkill", skip_serializing_if = "Option::is_none")]
    gateway_skill: Option<String>,
}

/// Saved window position/size
#[derive(Debug, Serialize, Deserialize)]
struct WindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn window_state_path(app_handle: &AppHandle) -> Option<std::path::PathBuf> {
    app_handle
        .path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("window-state.json"))
}

fn load_window_state(app_handle: &AppHandle) -> Option<WindowState> {
    let path = window_state_path(app_handle)?;
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

fn save_window_state(app_handle: &AppHandle, state: &WindowState) {
    if let Some(path) = window_state_path(app_handle) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string(state) {
            let _ = std::fs::write(&path, json);
        }
    }
}

/// Get log directory (~/.naia/logs/) and ensure it exists
fn log_dir() -> std::path::PathBuf {
    let dir = std::path::PathBuf::from(home_dir()).join(".naia/logs");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Open a log file for a component (append mode, timestamped per session)
fn open_log_file(component: &str) -> Option<std::fs::File> {
    let path = log_dir().join(format!("{}.log", component));
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok()
}

/// Write to log file with timestamp
fn log_to_file(msg: &str) {
    if let Some(mut f) = open_log_file("naia") {
        use std::io::Write as _;
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{}] {}", secs, msg);
    }
}

/// Important messages — always stderr + file (visible to users in release)
pub(crate) fn log_both(msg: &str) {
    eprintln!("{}", msg);
    log_to_file(msg);
}

/// Verbose/debug messages — file always, stderr only in debug builds
/// Use for progress updates, retries, and diagnostics that users don't need to see
pub(crate) fn log_verbose(msg: &str) {
    if cfg!(debug_assertions) {
        eprintln!("{}", msg);
    }
    log_to_file(msg);
}

fn debug_e2e_enabled() -> bool {
    matches!(
        std::env::var("CAFE_DEBUG_E2E").ok().as_deref(),
        Some("1" | "true" | "TRUE")
    )
}

/// Get the run directory (~/.naia/run/) for PID files
fn run_dir() -> std::path::PathBuf {
    let dir = std::path::PathBuf::from(home_dir()).join(".naia/run");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Write PID file for a managed process
fn write_pid_file(component: &str, pid: u32) {
    let path = run_dir().join(format!("{}.pid", component));
    let _ = std::fs::write(&path, pid.to_string());
    log_verbose(&format!(
        "[Naia] PID file written: {} (PID {})",
        path.display(),
        pid
    ));
}

/// Read PID from a PID file (returns None if file doesn't exist or is invalid)
fn read_pid_file(component: &str) -> Option<u32> {
    let path = run_dir().join(format!("{}.pid", component));
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| s.trim().parse().ok())
}

/// Remove a PID file
fn remove_pid_file(component: &str) {
    let path = run_dir().join(format!("{}.pid", component));
    let _ = std::fs::remove_file(&path);
}

// Note: is_pid_alive, kill_pid, and cleanup_orphan_processes live in the
// platform module so they can use native APIs (windows-sys / libc) instead of
// spawning `tasklist`/`taskkill` — which would flash a console window in a GUI
// Tauri app and intermittently emit `ERROR_NO_DATA (0x800700e8)` on Windows.

/// Start periodic Gateway health monitoring in a background thread.
/// Emits `gateway_status` events to the frontend and attempts restart on failure.
/// Returns an Arc<AtomicBool> that can be set to `true` to stop the monitor.
fn start_gateway_health_monitor(app_handle: AppHandle) -> Arc<std::sync::atomic::AtomicBool> {
    let shutdown = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let shutdown_flag = shutdown.clone();
    thread::spawn(move || {
        let interval = std::time::Duration::from_secs(30);
        let mut consecutive_failures: u32 = 0;

        loop {
            thread::sleep(interval);
            if shutdown_flag.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }

            let healthy = check_gateway_health_sync();

            if healthy {
                if consecutive_failures > 0 {
                    log_both("[Naia] Gateway recovered");
                    consecutive_failures = 0;
                }
                let _ = app_handle.emit(
                    "gateway_status",
                    serde_json::json!({ "running": true, "healthy": true }),
                );
            } else {
                consecutive_failures += 1;
                log_verbose(&format!(
                    "[Naia] Gateway health check failed (consecutive: {})",
                    consecutive_failures
                ));
                let _ = app_handle.emit(
                    "gateway_status",
                    serde_json::json!({
                        "running": false,
                        "healthy": false,
                        "failures": consecutive_failures
                    }),
                );

                // Auto-restart after 3 consecutive failures
                if consecutive_failures >= 3 {
                    log_both("[Naia] Attempting Gateway restart...");
                    let restart_result = {
                        let state = app_handle.state::<AppState>();
                        let guard_result = state.gateway.lock();
                        if let Ok(mut guard) = guard_result {
                            // Kill existing if any
                            if let Some(mut old) = guard.take() {
                                if let Some(ref mut nh) = old.node_host {
                                    let _ = nh.kill();
                                }
                                if old.we_spawned {
                                    let _ = old.child.kill();
                                }
                            }
                            // Try to respawn
                            match spawn_gateway() {
                                Ok(process) => {
                                    let managed = process.we_spawned;
                                    *guard = Some(process);
                                    Some(managed)
                                }
                                Err(e) => {
                                    log_both(&format!("[Naia] Gateway restart failed: {}", e));
                                    None
                                }
                            }
                        } else {
                            None
                        }
                    };
                    if let Some(managed) = restart_result {
                        consecutive_failures = 0;
                        log_both(&format!("[Naia] Gateway restarted (managed={})", managed));
                        let _ = app_handle.emit(
                            "gateway_status",
                            serde_json::json!({
                                "running": true,
                                "managed": managed,
                                "restarted": true
                            }),
                        );
                    }
                }
            }
        }
    });
    shutdown
}

/// Run `<node> -v` with a hidden console and return the parsed major version.
///
/// On Windows GUI apps (no console), `Command::output()` without CREATE_NO_WINDOW
/// triggers `ERROR_NO_DATA (0x800700e8)` — "The pipe is being closed" — because
/// Rust cannot attach the child's stdio to a non-existent console. `hide_console`
/// sets `CREATE_NO_WINDOW` (no-op on Unix), which fixes the pipe setup.
fn node_major_version<P: AsRef<std::ffi::OsStr>>(node_path: P) -> Option<u32> {
    let mut cmd = Command::new(node_path);
    cmd.arg("-v");
    platform::hide_console(&mut cmd);
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|s| s.parse().ok())
}

/// Find Node.js binary (system path first, then nvm fallback)
fn find_node_binary() -> Result<std::path::PathBuf, String> {
    // Flatpak bundled node (Linux only)
    #[cfg(target_os = "linux")]
    {
        let flatpak_node = std::path::PathBuf::from("/app/bin/node");
        if flatpak_node.exists() {
            return Ok(flatpak_node);
        }
    }

    // Check system node first
    let node_cmd = if cfg!(windows) { "node.exe" } else { "node" };
    if let Some(major) = node_major_version(node_cmd) {
        if major >= 22 {
            return Ok(std::path::PathBuf::from(node_cmd));
        }
    }

    let home = home_dir();

    // Windows: check nvm-windows, fnm, and Program Files
    #[cfg(windows)]
    {
        // nvm-windows (NVM_HOME or default AppData\Roaming\nvm)
        let nvm_home = std::env::var("NVM_HOME")
            .unwrap_or_else(|_| format!("{}\\AppData\\Roaming\\nvm", home));
        // fnm (actual installations, not ephemeral multishells)
        let fnm_dir = format!("{}\\AppData\\Local\\fnm_multishells", home);
        let win_dirs = [nvm_home, fnm_dir];
        for dir in &win_dirs {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let node_exe = entry.path().join("node.exe");
                    if node_exe.exists() {
                        if let Some(major) = node_major_version(&node_exe) {
                            if major >= 22 {
                                return Ok(node_exe);
                            }
                        }
                    }
                }
            }
        }
        // Check Program Files (use env var, not hardcoded C:)
        if let Ok(pf) = std::env::var("ProgramFiles") {
            let pf_node = std::path::PathBuf::from(&pf).join("nodejs\\node.exe");
            if pf_node.exists() {
                if let Some(major) = node_major_version(&pf_node) {
                    if major >= 22 {
                        return Ok(pf_node);
                    }
                }
            }
        }
    }

    // Unix: nvm fallback (check both standard ~/.nvm and XDG ~/.config/nvm)
    #[cfg(unix)]
    {
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
                        let name = name.trim_start_matches('v').to_string();
                        let major: u32 = name.split('.').next()?.parse().ok()?;
                        if major >= 22 {
                            Some((major, e.path()))
                        } else {
                            None
                        }
                    })
                    .collect();
                versions.sort_by(|a, b| b.0.cmp(&a.0)); // highest first
                if let Some((_, path)) = versions.first() {
                    let node_bin = path.join("bin/node");
                    if node_bin.exists() {
                        return Ok(node_bin);
                    }
                }
            }
        }
    }

    Err("Node.js 22+ not found (checked system PATH and nvm/fnm)".to_string())
}

/// Check if Naia Gateway is already running (blocking, for setup use)
fn check_gateway_health_sync() -> bool {
    // Gateway (openclaw) removed — naia-agent handles all tools directly.
    false
}

// find_gateway_paths removed — openclaw gateway no longer used (#201)

/// Load bootstrap config from bundled template file, with hardcoded fallback.
/// Single source of truth: config/defaults/gateway-bootstrap.json
fn load_bootstrap_config() -> serde_json::Value {
    // Search: Flatpak bundle → dev-mode relative → hardcoded fallback
    let candidates = [
        "/app/lib/naia-os/gateway-bootstrap.json".to_string(),
        // Dev mode: relative to src-tauri/
        {
            let mut p = std::env::current_exe()
                .unwrap_or_default()
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .to_path_buf();
            // Walk up from target/debug to repo root
            for _ in 0..4 {
                p = p
                    .parent()
                    .unwrap_or(std::path::Path::new("."))
                    .to_path_buf();
            }
            p.join("config/defaults/gateway-bootstrap.json")
                .to_string_lossy()
                .to_string()
        },
    ];
    for candidate in &candidates {
        if let Ok(raw) = std::fs::read_to_string(candidate) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
                log_verbose(&format!(
                    "[Naia] Loaded bootstrap config from {}",
                    candidate
                ));
                return val;
            }
        }
    }
    // Hardcoded fallback (should never be needed if build is correct)
    log_verbose("[Naia] Using hardcoded bootstrap config (template file not found)");
    serde_json::json!({
        "gateway": {
            "mode": "local",
            "port": 18789,
            "bind": "loopback",
            "auth": { "mode": "token" },
            "reload": { "mode": "off" }
        },
        "agents": {
            "defaults": {
                "workspace": "~/.naia/workspace"
            }
        },
        "session": {
            "dmScope": "per-channel-peer"
        },
        "hooks": {
            "internal": {
                "enabled": true,
                "entries": {
                    "session-memory": { "enabled": true }
                }
            }
        }
    })
}

/// Ensure ~/.naia/gateway.json exists with minimal required fields.
/// Reads bootstrap template from config/defaults/gateway-bootstrap.json (SoT).
/// If the file exists but gateway.mode is missing, patches it in.
fn ensure_gateway_config(config_path: &str) {
    let path = std::path::Path::new(config_path);

    if !path.exists() {
        if let Some(parent) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                log_both(&format!(
                    "[Naia] ERROR: Failed to create config dir {:?}: {}",
                    parent, e
                ));
                return;
            }
        }
        let bootstrap = load_bootstrap_config();
        if let Ok(pretty) = serde_json::to_string_pretty(&bootstrap) {
            match std::fs::write(path, pretty.as_bytes()) {
                Ok(_) => log_both(&format!("[Naia] Bootstrap config created: {}", config_path)),
                Err(e) => log_both(&format!(
                    "[Naia] ERROR: Failed to write bootstrap config to {}: {}",
                    config_path, e
                )),
            }
        }
        let home = home_dir();
        let _ = std::fs::create_dir_all(format!("{}/.naia/workspace", home));
        return;
    }

    // Existing file: ensure gateway.mode, session.dmScope, and hooks are set
    if let Ok(raw) = std::fs::read_to_string(path) {
        if let Ok(mut root) = serde_json::from_str::<serde_json::Value>(&raw) {
            let needs_gw_patch = root.get("gateway").and_then(|gw| gw.get("mode")).is_none();
            let needs_session_patch = root.get("session").and_then(|s| s.get("dmScope")).is_none();
            let needs_hooks_patch = root
                .get("hooks")
                .and_then(|h| h.get("internal"))
                .and_then(|i| i.get("enabled"))
                .is_none();
            if needs_gw_patch || needs_session_patch || needs_hooks_patch {
                if let Some(obj) = root.as_object_mut() {
                    let gw = obj
                        .entry("gateway")
                        .or_insert_with(|| serde_json::json!({}));
                    if let Some(gw_obj) = gw.as_object_mut() {
                        gw_obj
                            .entry("mode")
                            .or_insert_with(|| serde_json::Value::String("local".to_string()));
                    }
                    // Isolate DM sessions from Shell chat (prevents Discord DM pollution)
                    let session = obj
                        .entry("session")
                        .or_insert_with(|| serde_json::json!({}));
                    if let Some(session_obj) = session.as_object_mut() {
                        session_obj.entry("dmScope").or_insert_with(|| {
                            serde_json::Value::String("per-channel-peer".to_string())
                        });
                    }
                    // Enable session-memory hook so conversations are saved to workspace/memory/
                    let hooks = obj.entry("hooks").or_insert_with(|| serde_json::json!({}));
                    if let Some(hooks_obj) = hooks.as_object_mut() {
                        let internal = hooks_obj
                            .entry("internal")
                            .or_insert_with(|| serde_json::json!({}));
                        if let Some(internal_obj) = internal.as_object_mut() {
                            internal_obj
                                .entry("enabled")
                                .or_insert_with(|| serde_json::Value::Bool(true));
                            let entries = internal_obj
                                .entry("entries")
                                .or_insert_with(|| serde_json::json!({}));
                            if let Some(entries_obj) = entries.as_object_mut() {
                                let sm = entries_obj
                                    .entry("session-memory")
                                    .or_insert_with(|| serde_json::json!({}));
                                if let Some(sm_obj) = sm.as_object_mut() {
                                    sm_obj
                                        .entry("enabled")
                                        .or_insert_with(|| serde_json::Value::Bool(true));
                                }
                            }
                        }
                    }
                    if let Ok(pretty) = serde_json::to_string_pretty(&root) {
                        match std::fs::write(path, pretty.as_bytes()) {
                            Ok(_) => log_both(
                                "[Naia] Patched config (gateway.mode + session.dmScope + hooks)",
                            ),
                            Err(e) => log_both(&format!(
                                "[Naia] ERROR: Failed to patch config {}: {}",
                                config_path, e
                            )),
                        }
                    }
                }
            }
        }
    }
}

/// Gateway (openclaw) removed in #201 — naia-agent handles all tools directly via stdio.
fn spawn_gateway() -> Result<GatewayProcess, String> {
    Err("Gateway removed: naia-agent handles all tools directly".to_string())
}

// openclaw spawn_node_host and legacy spawn body removed — see #201

/// Spawn the Node.js agent-core process with stdio pipes
fn spawn_agent_core(
    app_handle: &AppHandle,
    audit_db: &audit::AuditDb,
) -> Result<AgentProcess, String> {
    let agent_path = std::env::var("NAIA_AGENT_PATH").unwrap_or_else(|_| {
        // On Windows, check bundled node.exe in resource_dir first
        #[cfg(windows)]
        {
            if let Ok(res_dir) = app_handle.path().resource_dir() {
                let bundled = res_dir.join("node.exe");
                if bundled.exists() {
                    return bundled.to_string_lossy().to_string();
                }
            }
        }
        find_node_binary()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "node".to_string())
    });

    // In dev: tsx for TypeScript direct execution; in prod: compiled JS from bundle
    let agent_script = std::env::var("NAIA_AGENT_SCRIPT").unwrap_or_else(|_| {
        let is_flatpak = std::env::var("FLATPAK").map(|v| v == "1").unwrap_or(false);

        // Flatpak: bundled agent FIRST (--filesystem=home can expose dev paths)
        if is_flatpak {
            let flatpak_path = std::path::PathBuf::from("/app/lib/naia-os/agent/dist/index.js");
            if flatpak_path.exists() {
                log_verbose(&format!(
                    "[Naia] Found Flatpak agent at: {}",
                    flatpak_path.display()
                ));
                return flatpak_path.to_string_lossy().to_string();
            }
        }

        // Dev: tsx for TypeScript direct execution (NOT in Flatpak)
        // Check dev source BEFORE bundled dist — bundled dist in target/debug/
        // often has incomplete node_modules (pnpm hoisting issues)
        if !is_flatpak {
            let candidates = [
                "../../agent/src/index.ts", // from src-tauri/
                "../agent/src/index.ts",    // from shell/
            ];
            for rel in &candidates {
                let dev_path = std::env::current_dir()
                    .map(|d| d.join(rel))
                    .unwrap_or_default();
                if dev_path.exists() {
                    log_verbose(&format!(
                        "[Naia] Found dev agent at: {}",
                        dev_path.display()
                    ));
                    return dunce::canonicalize(&dev_path)
                        .unwrap_or(dev_path)
                        .to_string_lossy()
                        .to_string();
                }
            }
        }

        // Production: bundled agent via Tauri resources
        if let Ok(resource_dir) = app_handle.path().resource_dir() {
            let bundled = resource_dir.join("agent/dist/index.js");
            if bundled.exists() {
                log_verbose(&format!(
                    "[Naia] Found bundled agent at: {}",
                    bundled.display()
                ));
                return bundled.to_string_lossy().to_string();
            }
        }

        // Flatpak fallback (resource_dir didn't work)
        let flatpak_path = std::path::PathBuf::from("/app/lib/naia-os/agent/dist/index.js");
        if flatpak_path.exists() {
            log_verbose(&format!(
                "[Naia] Found Flatpak agent at: {}",
                flatpak_path.display()
            ));
            return flatpak_path.to_string_lossy().to_string();
        }
        // Fallback: relative path (legacy)
        "../agent/dist/index.js".to_string()
    });

    let use_tsx = agent_script.ends_with(".ts");

    // Preferred: invoke tsx via node directly (agent_dir/node_modules/.pnpm/tsx@*/.../cli.mjs).
    // This avoids spawning `npx` or `npx.cmd` — Windows' CreateProcess does not
    // resolve .cmd shims, and batch files fail under CREATE_NO_WINDOW anyway.
    //
    // Fallback: `npx.cmd` (Windows) / `npx` (Unix) via platform::resolve_npx() —
    // only hit when tsx resolution fails (no node_modules, production build, etc.).
    let agent_dir = std::path::Path::new(&agent_script)
        .parent()
        .and_then(|p| p.parent())
        .map(std::path::Path::to_path_buf);

    let tsx_direct = if use_tsx {
        agent_dir
            .as_deref()
            .and_then(platform::resolve_tsx_from_agent)
    } else {
        None
    };

    let (runner, mut cmd) = if let Some((node_bin, tsx_cli)) = tsx_direct {
        let mut c = Command::new(&node_bin);
        c.arg(&tsx_cli).arg(&agent_script).arg("--stdio");
        (format!("{} {}", node_bin, tsx_cli), c)
    } else if use_tsx {
        let npx = std::env::var("NAIA_AGENT_RUNNER").unwrap_or_else(|_| platform::resolve_npx());
        let mut c = Command::new(&npx);
        c.arg("tsx").arg(&agent_script).arg("--stdio");
        (npx, c)
    } else {
        let mut c = Command::new(&agent_path);
        c.arg(&agent_script).arg("--stdio");
        (agent_path.clone(), c)
    };

    log_verbose(&format!(
        "[Naia] Starting agent-core: {} {}",
        runner, agent_script
    ));
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    platform::hide_console(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn agent-core: {}", e))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to get agent stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to get agent stdout".to_string())?;

    // Stdout reader thread: forward JSON lines as Tauri events + audit log
    let handle = app_handle.clone();
    let audit_db_clone = audit_db.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(json_line) => {
                    let trimmed = json_line.trim();
                    if trimmed.is_empty() || !trimmed.starts_with('{') {
                        continue;
                    }
                    // Audit log: parse and record before emitting
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(trimmed) {
                        audit::maybe_log_event(&audit_db_clone, &parsed);
                        if debug_e2e_enabled() {
                            let t = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            match t {
                                "tool_use" => {
                                    let n = parsed
                                        .get("toolName")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("");
                                    log_both(&format!(
                                        "[E2E-DEBUG] agent_response tool_use tool={}",
                                        n
                                    ));
                                }
                                "tool_result" => {
                                    let n = parsed
                                        .get("toolName")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("");
                                    let s = parsed
                                        .get("success")
                                        .and_then(|v| v.as_bool())
                                        .unwrap_or(false);
                                    let out = parsed
                                        .get("output")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .chars()
                                        .take(120)
                                        .collect::<String>();
                                    log_both(&format!(
                                        "[E2E-DEBUG] agent_response tool_result tool={} success={} output_head={}",
                                        n, s, out
                                    ));
                                }
                                "error" => {
                                    let m = parsed
                                        .get("message")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("");
                                    log_both(&format!(
                                        "[E2E-DEBUG] agent_response error msg={}",
                                        m
                                    ));
                                }
                                _ => {}
                            }
                        }
                    }
                    // Intercept memory backup responses — dispatch to waiting Tauri command
                    // (parsed only available inside the if let Ok block above, so we re-parse here)
                    let handled_as_backup = serde_json::from_str::<serde_json::Value>(trimmed)
                        .map(|v| memory::dispatch_backup_response(&v))
                        .unwrap_or(false);
                    if handled_as_backup {
                        continue;
                    }
                    // Forward raw JSON to frontend
                    if let Err(e) = handle.emit("agent_response", trimmed) {
                        log_verbose(&format!("[Naia] Failed to emit agent_response: {}", e));
                    }
                }
                Err(e) => {
                    log_verbose(&format!("[Naia] Error reading agent stdout: {}", e));
                    break;
                }
            }
        }
        log_verbose("[Naia] agent-core stdout reader ended");
    });

    Ok(AgentProcess { child, stdin })
}

/// Send a message to agent-core stdin, with crash recovery
fn send_to_agent(
    state: &AppState,
    message: &str,
    app_handle: Option<&AppHandle>,
    audit_db: Option<&audit::AuditDb>,
) -> Result<(), String> {
    if debug_e2e_enabled() {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(message) {
            let t = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if t == "chat_request" {
                let provider = parsed
                    .get("provider")
                    .and_then(|v| v.get("provider"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let enable_tools = parsed
                    .get("enableTools")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let has_gateway_url = parsed
                    .get("gatewayUrl")
                    .and_then(|v| v.as_str())
                    .map(|s| !s.is_empty())
                    .unwrap_or(false);
                let has_gateway_token = parsed
                    .get("gatewayToken")
                    .and_then(|v| v.as_str())
                    .map(|s| !s.is_empty())
                    .unwrap_or(false);
                let disabled_len = parsed
                    .get("disabledSkills")
                    .and_then(|v| v.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                log_both(&format!(
                    "[E2E-DEBUG] chat_request provider={} enableTools={} hasGatewayUrl={} hasGatewayToken={} disabledSkills={}",
                    provider, enable_tools, has_gateway_url, has_gateway_token, disabled_len
                ));
            }
        }
    }

    // Log approval_decision events (shell→agent direction)
    if let Some(db) = audit_db {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(message) {
            if parsed.get("type").and_then(|v| v.as_str()) == Some("approval_response") {
                let request_id = parsed
                    .get("requestId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let tool_name = parsed.get("toolName").and_then(|v| v.as_str());
                let tool_call_id = parsed.get("toolCallId").and_then(|v| v.as_str());
                let decision = parsed
                    .get("decision")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let payload = serde_json::json!({ "decision": decision }).to_string();
                let _ = audit::insert_event(
                    db,
                    request_id,
                    "approval_decision",
                    tool_name,
                    tool_call_id,
                    None,
                    None,
                    Some(&payload),
                );
            }
        }
    }

    let mut guard = lock_or_recover(&state.agent, "state.agent(send_to_agent)");

    if let Some(ref mut process) = *guard {
        // Check if process is still alive
        match process.child.try_wait() {
            Ok(Some(status)) => {
                log_both(&format!("[Naia] agent-core exited: {:?}", status));
                *guard = None;
                drop(guard);
                if let Some(handle) = app_handle {
                    return restart_agent(state, handle, message, audit_db);
                }
                return Err("agent-core died".to_string());
            }
            Ok(None) => {} // still running
            Err(e) => log_verbose(&format!("[Naia] Failed to check agent status: {}", e)),
        }

        // Write to stdin
        match writeln!(process.stdin, "{}", message) {
            Ok(_) => {
                process
                    .stdin
                    .flush()
                    .map_err(|e| format!("Flush error: {}", e))?;
                Ok(())
            }
            Err(e) => {
                log_both(&format!("[Naia] Write to agent failed: {}", e));
                *guard = None;
                drop(guard);
                if let Some(handle) = app_handle {
                    restart_agent(state, handle, message, audit_db)
                } else {
                    Err(format!("Write failed: {}", e))
                }
            }
        }
    } else {
        drop(guard);
        if let Some(handle) = app_handle {
            restart_agent(state, handle, message, audit_db)
        } else {
            Err("agent-core not running".to_string())
        }
    }
}

fn restart_agent(
    state: &AppState,
    app_handle: &AppHandle,
    message: &str,
    audit_db: Option<&audit::AuditDb>,
) -> Result<(), String> {
    // Debounce: prevent restart storms when agent-core keeps crashing (#226).
    // If we restarted less than 5 seconds ago, refuse to restart again.
    {
        let mut last_restart = lock_or_recover(&state.last_agent_restart, "last_agent_restart");
        if let Some(last) = *last_restart {
            let elapsed = last.elapsed();
            if elapsed < std::time::Duration::from_secs(5) {
                let wait_ms = 5000 - elapsed.as_millis() as u64;
                log_both(&format!(
                    "[Naia] agent-core restart debounced ({}ms cooldown remaining)",
                    wait_ms
                ));
                return Err("agent-core restart debounced — too many restarts".to_string());
            }
        }
        *last_restart = Some(std::time::Instant::now());
    }

    log_both("[Naia] Restarting agent-core...");
    // Use a temporary empty db if none provided (shouldn't happen in practice)
    let empty_db;
    let db = match audit_db {
        Some(db) => db,
        None => {
            empty_db = std::sync::Arc::new(Mutex::new(
                rusqlite::Connection::open_in_memory().map_err(|e| format!("DB error: {}", e))?,
            ));
            &empty_db
        }
    };
    match spawn_agent_core(app_handle, db) {
        Ok(process) => {
            let mut guard = lock_or_recover(&state.agent, "state.agent(restart_agent)");
            *guard = Some(process);
            log_both("[Naia] agent-core restarted");
            drop(guard);
            std::thread::sleep(std::time::Duration::from_millis(300));
            send_to_agent(state, message, None, audit_db)
        }
        Err(e) => Err(format!("Restart failed: {}", e)),
    }
}

/// Scan ~/.naia/skills/ for skill manifests + hardcoded built-in skills
#[tauri::command]
async fn list_skills() -> Result<Vec<SkillManifestInfo>, String> {
    let mut skills: Vec<SkillManifestInfo> = Vec::new();

    // Built-in skills (always present, cannot be disabled)
    // Must match agent/src/gateway/tool-bridge.ts built-in registrations
    let builtins = [
        ("skill_time", "Get current date and time"),
        ("skill_system_status", "Get system status information"),
        ("skill_memo", "Save and retrieve memos"),
        ("skill_weather", "Get weather information for a location"),
        (
            "skill_notify_slack",
            "Send a notification message to Slack via webhook",
        ),
        (
            "skill_notify_discord",
            "Send a notification message to Discord via webhook",
        ),
        (
            "skill_notify_google_chat",
            "Send a notification message to Google Chat via webhook",
        ),
        (
            "skill_skill_manager",
            "Manage skills: list, search, enable, disable",
        ),
        ("skill_agents", "Manage Gateway agents"),
        ("skill_approvals", "Manage Gateway approval rules"),
        (
            "skill_botmadang",
            "Connect with the Botmadang AI Agent community",
        ),
        ("skill_channels", "Manage messaging channels"),
        ("skill_config", "Manage Gateway configuration"),
        ("skill_cron", "Manage scheduled tasks"),
        ("skill_device", "Manage Gateway nodes and device pairings"),
        ("skill_diagnostics", "Gateway diagnostics and health checks"),
        ("skill_naia_discord", "Send and receive Discord messages"),
        ("skill_sessions", "Manage Gateway sub-agent sessions"),
        ("skill_tts", "Manage Gateway TTS (Text-to-Speech)"),
        ("skill_voicewake", "Manage voice wake triggers"),
    ];
    let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (name, desc) in &builtins {
        seen_names.insert(name.to_string());
        skills.push(SkillManifestInfo {
            name: name.to_string(),
            description: desc.to_string(),
            skill_type: "built-in".to_string(),
            tier: 0,
            source: "built-in".to_string(),
            gateway_skill: None,
        });
    }

    // Scan ~/.naia/skills/
    let home = home_dir();
    let skills_dir = std::path::PathBuf::from(&home).join(".naia/skills");
    if skills_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&skills_dir) {
            for entry in entries.flatten() {
                let manifest_path = entry.path().join("skill.json");
                if !manifest_path.exists() {
                    continue;
                }
                let data = match std::fs::read_to_string(&manifest_path) {
                    Ok(d) => d,
                    Err(e) => {
                        log_verbose(&format!(
                            "[list_skills] Failed to read {}: {}",
                            manifest_path.display(),
                            e
                        ));
                        continue;
                    }
                };
                let parsed: serde_json::Value = match serde_json::from_str(&data) {
                    Ok(v) => v,
                    Err(e) => {
                        log_verbose(&format!(
                            "[list_skills] Failed to parse {}: {}",
                            manifest_path.display(),
                            e
                        ));
                        continue;
                    }
                };

                let dir_name = entry.file_name().to_string_lossy().to_string();
                let raw_name = parsed
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&dir_name)
                    .to_string();
                let name = if raw_name.starts_with("skill_") {
                    raw_name
                } else {
                    format!("skill_{}", raw_name)
                };

                // Skip duplicates (e.g. custom skill with same name as built-in)
                if !seen_names.insert(name.clone()) {
                    continue;
                }

                let description = parsed
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                let skill_type = parsed
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("command")
                    .to_string();

                let tier = parsed.get("tier").and_then(|v| v.as_u64()).unwrap_or(2) as u32;

                let gateway_skill = parsed
                    .get("gatewaySkill")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                skills.push(SkillManifestInfo {
                    name,
                    description,
                    skill_type,
                    tier,
                    source: manifest_path.to_string_lossy().to_string(),
                    gateway_skill,
                });
            }
        }
    }

    // Sort: built-in first, then alphabetical
    skills.sort_by(|a, b| {
        let a_builtin = a.skill_type == "built-in";
        let b_builtin = b.skill_type == "built-in";
        b_builtin.cmp(&a_builtin).then(a.name.cmp(&b.name))
    });

    Ok(skills)
}

static DEBUG_LOG_FILE: OnceLock<Mutex<std::fs::File>> = OnceLock::new();

/// Frontend log bridge — prints to Rust stderr AND debug log file (survives crashes).
#[tauri::command]
fn frontend_log(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!("[frontend] {}", message),
        "warn" => log::warn!("[frontend] {}", message),
        "debug" => log::debug!("[frontend] {}", message),
        _ => log::info!("[frontend] {}", message),
    }
    if let Some(mtx) = DEBUG_LOG_FILE.get() {
        if let Ok(mut f) = mtx.lock() {
            let _ = writeln!(f, "{}", message);
            let _ = f.flush();
        }
    }
}

// ── STT model management commands ──────────────────────────────────

#[tauri::command]
async fn list_stt_models(app: AppHandle) -> Vec<stt_models::SttModelInfo> {
    tokio::task::spawn_blocking(move || stt_models::get_model_catalog(&app))
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn download_stt_model(app: AppHandle, model_id: String) -> Result<(), String> {
    stt_models::download_model(app, model_id).await
}

#[tauri::command]
async fn delete_stt_model(app: AppHandle, model_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || stt_models::delete_model(&app, &model_id))
        .await
        .map_err(|e| format!("spawn_blocking join error: {e}"))?
}

#[tauri::command]
async fn send_to_agent_command(
    app: AppHandle,
    message: String,
    state: tauri::State<'_, AppState>,
    audit_state: tauri::State<'_, AuditState>,
) -> Result<(), String> {
    // Validate JSON structure and enforce size limit before forwarding (CWE-20).
    const MAX_MESSAGE_BYTES: usize = 10 * 1024 * 1024; // 10 MB
    if message.len() > MAX_MESSAGE_BYTES {
        return Err(format!("Message too large: {} bytes", message.len()));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&message).map_err(|e| format!("Invalid JSON from frontend: {}", e))?;
    if !parsed.is_object() {
        return Err("Message must be a JSON object".to_string());
    }
    // Require a "type" field
    if parsed.get("type").and_then(|v| v.as_str()).is_none() {
        return Err("Message must have a string 'type' field".to_string());
    }
    send_to_agent(&state, &message, Some(&app), Some(&audit_state.db))
}

#[tauri::command]
async fn cancel_stream(
    app: AppHandle,
    request_id: String,
    state: tauri::State<'_, AppState>,
    audit_state: tauri::State<'_, AuditState>,
) -> Result<(), String> {
    let cancel = serde_json::json!({
        "type": "cancel_stream",
        "requestId": request_id
    });
    send_to_agent(
        &state,
        &cancel.to_string(),
        Some(&app),
        Some(&audit_state.db),
    )
}

#[tauri::command]
async fn get_audit_log(
    filter: audit::AuditFilter,
    audit_state: tauri::State<'_, AuditState>,
) -> Result<Vec<audit::AuditEvent>, String> {
    audit::query_events(&audit_state.db, &filter)
}

#[tauri::command]
async fn get_audit_stats(
    audit_state: tauri::State<'_, AuditState>,
) -> Result<audit::AuditStats, String> {
    audit::query_stats(&audit_state.db)
}

// === Facts commands (sessions/messages now managed by Gateway) ===

#[tauri::command]
async fn memory_get_all_facts() -> Result<Vec<memory::AgentFact>, String> {
    Ok(memory::get_all_agent_facts())
}

#[tauri::command]
async fn memory_delete_fact(fact_id: String) -> Result<bool, String> {
    memory::delete_agent_fact(&fact_id)
}

/// Export an encrypted memory backup via agent IPC (AES-256-GCM + PBKDF2-SHA256).
/// Sends memory_export request to agent and awaits memory_export_result response.
/// The response data field is a JSON number array (agent uses Array.from(Uint8Array)).
#[tauri::command]
async fn memory_export_backup(
    password: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    use tokio::sync::oneshot;

    let request_id = {
        let mut bytes = [0u8; 8];
        getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
        bytes
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>()
    };

    let (tx, rx) = oneshot::channel();
    memory::register_pending(request_id.clone(), tx);

    let message = serde_json::json!({
        "type": "memory_export",
        "requestId": request_id,
        "password": password,
    });
    if let Err(e) = send_to_agent(&state, &message.to_string(), None, None) {
        memory::unregister_pending(&request_id);
        return Err(e);
    }

    match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
        Ok(Ok(Ok(response))) => {
            let data = response
                .get("data")
                .and_then(|v| v.as_array())
                .ok_or_else(|| "No data array in memory_export_result".to_string())?;
            data.iter()
                .map(|v| {
                    v.as_u64()
                        .and_then(|n| u8::try_from(n).ok())
                        .ok_or_else(|| "Invalid byte value in data array".to_string())
                })
                .collect()
        }
        Ok(Ok(Err(err))) => Err(err),
        Ok(Err(_)) => Err("Agent disconnected before sending memory_export_result".to_string()),
        Err(_) => {
            memory::unregister_pending(&request_id);
            Err("Memory export timed out (30s)".to_string())
        }
    }
}

/// Import an encrypted memory backup via agent IPC.
/// Sends memory_import request to agent and awaits memory_import_result response.
/// The data field is sent as a JSON number array matching the protocol's `data: number[]`.
#[tauri::command]
async fn memory_import_backup(
    blob: Vec<u8>,
    password: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    use tokio::sync::oneshot;

    let request_id = {
        let mut bytes = [0u8; 8];
        getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
        bytes
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>()
    };

    let (tx, rx) = oneshot::channel();
    memory::register_pending(request_id.clone(), tx);

    let message = serde_json::json!({
        "type": "memory_import",
        "requestId": request_id,
        "data": blob,
        "password": password,
    });
    if let Err(e) = send_to_agent(&state, &message.to_string(), None, None) {
        memory::unregister_pending(&request_id);
        return Err(e);
    }

    match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
        Ok(Ok(Ok(_))) => Ok(()),
        Ok(Ok(Err(err))) => Err(err),
        Ok(Err(_)) => Err("Agent disconnected before sending memory_import_result".to_string()),
        Err(_) => {
            memory::unregister_pending(&request_id);
            Err("Memory import timed out (30s)".to_string())
        }
    }
}

/// Validate an API key by making a test request to the provider
#[tauri::command]
async fn validate_api_key(provider: String, api_key: String) -> Result<bool, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let result = match provider.as_str() {
        "gemini" => {
            // Use header instead of query parameter to avoid leaking API key
            // in logs, proxy caches, and Referer headers (CWE-598).
            client
                .get("https://generativelanguage.googleapis.com/v1beta/models")
                .header("x-goog-api-key", &api_key)
                .send()
                .await
        }
        "xai" => {
            client
                .get("https://api.x.ai/v1/models")
                .header("Authorization", format!("Bearer {}", api_key))
                .send()
                .await
        }
        "anthropic" => {
            client
                .get("https://api.anthropic.com/v1/models")
                .header("x-api-key", &api_key)
                .header("anthropic-version", "2023-06-01")
                .send()
                .await
        }
        _ => return Err(format!("Unknown provider: {}", provider)),
    };

    match result {
        Ok(res) => Ok(res.status().is_success()),
        Err(_) => Ok(false),
    }
}

/// List available PipeWire output sinks via `pw-dump` (JSON, no env-var setup needed).
/// Filters to idle/running state only — suspended = disconnected HDMI port.
/// Excludes virtual/loopback sinks.
/// Fallback for WebKitGTK which does not enumerate audiooutput via enumerateDevices().
///
/// Linux only — on Windows the WebView2 webview enumerates devices natively via
/// `navigator.mediaDevices.enumerateDevices()` so this command returns an empty list.
#[tauri::command]
async fn list_audio_output_devices() -> Result<Vec<serde_json::Value>, String> {
    #[cfg(not(target_os = "linux"))]
    return Ok(Vec::new());

    #[cfg(target_os = "linux")]
    {
        let output =
            tokio::task::spawn_blocking(|| std::process::Command::new("/usr/bin/pw-dump").output())
                .await
                .map_err(|e| format!("task error: {e}"))?
                .map_err(|e| format!("pw-dump error: {e}"))?;

        let text = String::from_utf8_lossy(&output.stdout);
        let nodes: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("pw-dump parse error: {e}"))?;

        let mut devices: Vec<serde_json::Value> = nodes
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .filter_map(|obj| {
                let info = obj.get("info")?;
                let props = info.get("props")?;
                let media_class = props.get("media.class")?.as_str()?;
                if media_class != "Audio/Sink" {
                    return None;
                }
                let state = info.get("state")?.as_str().unwrap_or("");
                if state != "idle" && state != "running" {
                    return None;
                }
                let name = props.get("node.name")?.as_str().unwrap_or("");
                if name.contains("loopback") || name.contains("naia-virtual") {
                    return None;
                }
                let label = props
                    .get("node.description")
                    .and_then(|v| v.as_str())
                    .unwrap_or(name)
                    .to_string();
                Some(serde_json::json!({ "id": name, "label": label }))
            })
            .collect();

        devices.sort_by(|a, b| {
            a["label"]
                .as_str()
                .unwrap_or("")
                .cmp(b["label"].as_str().unwrap_or(""))
        });
        Ok(devices)
    }
}

/// Check if Naia Gateway is reachable on localhost
/// Re-enable Korean/CJK IME for the WebView2 child HWND.
/// Called from the frontend when a text input gains focus so the 한/영 toggle
/// works even if the initial startup call was too early.
#[tauri::command]
async fn enable_webview2_ime(window: tauri::Window) -> Result<(), String> {
    #[cfg(windows)]
    {
        use raw_window_handle::HasWindowHandle;
        if let Ok(handle) = window.window_handle() {
            if let raw_window_handle::RawWindowHandle::Win32(h) = handle.as_raw() {
                let hwnd_isize = h.hwnd.get() as isize;
                crate::platform::enable_ime_for_window(hwnd_isize);
                log_verbose("[Naia] IME re-enabled for WebView2 (on-demand)");
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn gateway_health() -> Result<bool, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    // Gateway (openclaw) removed — always report not running
    let _ = client;
    Ok(false)
}

/// Restart the Naia Gateway.
/// Kills existing gateway + node host, then respawns both.
/// Call this after writing gateway config to ensure the gateway reads fresh config.
#[tauri::command]
async fn restart_gateway(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    log_verbose("[Naia] restart_gateway requested");
    // spawn_gateway calls check_gateway_health_sync which uses reqwest::blocking::Client.
    // Dropping that client's internal runtime inside an async context panics with
    // "Cannot drop a runtime in a context where blocking is not allowed".
    // block_in_place signals Tokio that this thread may block, preventing the panic.
    tokio::task::block_in_place(|| {
        let guard_result = state.gateway.lock();
        if let Ok(mut guard) = guard_result {
            // Kill existing processes
            if let Some(mut old) = guard.take() {
                if let Some(ref mut nh) = old.node_host {
                    let _ = nh.kill();
                }
                if old.we_spawned {
                    let _ = old.child.kill();
                }
                // Give processes time to exit cleanly
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            // Respawn
            match spawn_gateway() {
                Ok(process) => {
                    let managed = process.we_spawned;
                    *guard = Some(process);
                    log_both(&format!("[Naia] Gateway restarted (managed={})", managed));
                    Ok(true)
                }
                Err(e) => {
                    log_both(&format!("[Naia] Gateway restart failed: {}", e));
                    Err(e)
                }
            }
        } else {
            Err("Failed to acquire gateway lock".to_string())
        }
    })
}

/// Generate a random state token for OAuth deep link CSRF protection.
/// Frontend calls this before opening the OAuth URL and passes state as query param.
#[tauri::command]
async fn generate_oauth_state(state: tauri::State<'_, AppState>) -> Result<String, String> {
    use std::fmt::Write;
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("RNG error: {}", e))?;
    let mut hex = String::with_capacity(64);
    for b in &bytes {
        write!(hex, "{:02x}", b).unwrap();
    }
    *lock_or_recover(
        &state.oauth_state,
        "state.oauth_state(generate_oauth_state)",
    ) = Some(hex.clone());
    Ok(hex)
}

#[tauri::command]
async fn reset_window_state(app: AppHandle) -> Result<(), String> {
    if let Some(path) = window_state_path(&app) {
        let _ = std::fs::remove_file(&path);
        log_verbose("[Naia] Window state reset");
    }
    Ok(())
}

/// Reset Naia Gateway session data (agents/main/sessions + memory).
#[tauri::command]
async fn reset_gateway_data() -> Result<String, String> {
    let home = home_dir();
    let base_dirs = [
        format!("{}/.naia", home),
        format!("{}/.openclaw", home), // legacy fallback
    ];

    let mut removed: Vec<String> = Vec::new();

    for base in &base_dirs {
        // Remove sessions directory
        let sessions_dir = format!("{}/agents/main/sessions", base);
        if std::path::Path::new(&sessions_dir).exists() {
            let _ = std::fs::remove_dir_all(&sessions_dir);
            removed.push(sessions_dir);
        }

        // Remove memory database
        let memory_dir = format!("{}/memory", base);
        if std::path::Path::new(&memory_dir).exists() {
            let _ = std::fs::remove_dir_all(&memory_dir);
            removed.push(memory_dir);
        }
    }

    log_verbose(&format!("[Naia] Gateway data reset: {:?}", removed));
    Ok(serde_json::json!({ "removed": removed }).to_string())
}

/// Read Discord bot token.
/// Priority: Shell local config (naia-discord.json) → Gateway config (openclaw.json).
/// This separates the primary path from Gateway dependency (#154).
#[tauri::command]
async fn read_discord_bot_token() -> Result<String, String> {
    let home = home_dir();

    // 1. Shell local config (primary — no Gateway dependency)
    let mut shell_candidates = vec![
        format!("{}/.local/share/com.naia.shell/naia-discord.json", home),
        format!(
            "{}/.var/app/io.nextain.naia/config/com.naia.shell/naia-discord.json",
            home
        ),
    ];
    #[cfg(windows)]
    shell_candidates.push(format!(
        "{}\\AppData\\Roaming\\com.naia.shell\\naia-discord.json",
        home
    ));
    for path in &shell_candidates {
        if let Ok(bytes) = std::fs::read(path) {
            if let Ok(config) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if let Some(token) = config.get("botToken").and_then(|t| t.as_str()) {
                    if !token.is_empty() {
                        return Ok(token.to_string());
                    }
                }
            }
        }
    }

    // 2. Gateway config (fallback — backward compatibility)
    let gateway_candidates = [
        format!("{}/.naia/gateway.json", home),
        format!("{}/.openclaw/openclaw.json", home), // legacy fallback
    ];
    for path in &gateway_candidates {
        if let Ok(bytes) = std::fs::read(path) {
            if let Ok(config) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if let Some(token) = config
                    .get("channels")
                    .and_then(|c| c.get("discord"))
                    .and_then(|d| d.get("token"))
                    .and_then(|t| t.as_str())
                {
                    if !token.is_empty() {
                        return Ok(token.to_string());
                    }
                }
            }
        }
    }

    Err("Discord bot token not found".to_string())
}

/// Write Discord bot token to Shell local config.
/// Called after login sync to persist token independently of Gateway.
#[tauri::command]
async fn write_discord_bot_token(token: String) -> Result<(), String> {
    let home = home_dir();
    let config_dir = if cfg!(windows) {
        format!("{}\\AppData\\Roaming\\com.naia.shell", home)
    } else {
        format!("{}/.local/share/com.naia.shell", home)
    };
    let config_path = std::path::PathBuf::from(&config_dir).join("naia-discord.json");
    let config_path = config_path.to_string_lossy().to_string();

    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create dir {}: {}", config_dir, e))?;

    // Read-merge-write to preserve existing fields
    let mut content: serde_json::Value = if std::path::Path::new(&config_path).exists() {
        let raw = std::fs::read_to_string(&config_path).unwrap_or_else(|_| "{}".to_string());
        serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    if !content.is_object() {
        content = serde_json::json!({});
    }
    content
        .as_object_mut()
        .expect("content is always a JSON object")
        .insert("botToken".to_string(), serde_json::Value::String(token));
    let pretty =
        serde_json::to_string_pretty(&content).map_err(|e| format!("JSON serialize: {}", e))?;
    std::fs::write(&config_path, pretty.as_bytes())
        .map_err(|e| format!("Failed to write {}: {}", config_path, e))?;

    Ok(())
}

/// Proxy Discord REST API calls through Rust to bypass CORS.
/// Returns the JSON response body as a string.
#[tauri::command]
async fn discord_api(
    endpoint: String,
    method: String,
    body: Option<String>,
) -> Result<String, String> {
    let token = read_discord_bot_token().await?;

    // Validate endpoint to prevent path traversal / URL injection (CWE-94).
    if endpoint.contains("..")
        || endpoint.contains("//")
        || endpoint.contains('@')
        || endpoint.contains('\n')
        || endpoint.contains('\r')
    {
        return Err("Invalid endpoint: suspicious characters".to_string());
    }
    // Must start with / and only contain safe URL chars
    if !endpoint.starts_with('/') {
        return Err("Invalid endpoint: must start with /".to_string());
    }

    let url = format!("https://discord.com/api/v10{}", endpoint);

    let client = reqwest::Client::new();
    let mut req = match method.to_uppercase().as_str() {
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        "PATCH" => client.patch(&url),
        _ => client.get(&url),
    };

    req = req
        .header("Authorization", format!("Bot {}", token))
        .header("Content-Type", "application/json");

    if let Some(b) = body {
        req = req.body(b);
    }

    let res = req
        .send()
        .await
        .map_err(|e| format!("Discord API request failed: {}", e))?;
    let status = res.status().as_u16();
    let text = res
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    if status >= 400 {
        // Use char boundary-safe truncation to avoid panic on multi-byte UTF-8
        let truncated: String = text.chars().take(200).collect();
        return Err(format!("Discord API error {}: {}", status, truncated));
    }

    Ok(text)
}

#[tauri::command]
async fn write_temp_text(filename: String, content: String) -> Result<String, String> {
    let path = std::env::temp_dir().join(&filename);
    std::fs::write(&path, content).map_err(|e| format!("write failed: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn read_local_binary(path: String, allowed_base: Option<String>) -> Result<String, String> {
    let file_path = std::path::PathBuf::from(&path);
    if !file_path.is_absolute() {
        return Err("Path must be absolute".to_string());
    }

    // Canonicalize to resolve symlinks and prevent traversal (CWE-22).
    let canonical = dunce::canonicalize(&file_path)
        .map_err(|e| format!("Cannot resolve path {}: {}", path, e))?;

    // Restrict to user home directory and common safe locations.
    let home = home_dir();
    let mut allowed_roots: Vec<std::path::PathBuf> = vec![std::path::PathBuf::from(&home)];
    #[cfg(unix)]
    {
        allowed_roots.push(std::path::PathBuf::from("/tmp"));
        allowed_roots.push(std::path::PathBuf::from("/usr/share"));
    }
    #[cfg(windows)]
    {
        if let Ok(temp) = std::env::var("TEMP") {
            allowed_roots.push(std::path::PathBuf::from(temp));
        }
    }
    // If the caller provides an explicit allowed base (e.g. the naia-adk path chosen by
    // the user via the OS dialog), canonicalize it and add it as a trusted root.
    if let Some(base) = allowed_base {
        if !base.is_empty() {
            if let Ok(canonical_base) = dunce::canonicalize(&base) {
                allowed_roots.push(canonical_base);
            }
        }
    }
    if !allowed_roots.iter().any(|root| canonical.starts_with(root)) {
        return Err(format!(
            "Access denied: {} is outside allowed directories",
            path
        ));
    }

    // Block sensitive files even within home directory
    let sensitive_dirs: Vec<std::path::PathBuf> = vec![
        std::path::PathBuf::from(&home).join(".ssh"),
        std::path::PathBuf::from(&home).join(".gnupg"),
        std::path::PathBuf::from(&home).join(".config/naia-os/secrets"),
    ];
    if sensitive_dirs.iter().any(|dir| canonical.starts_with(dir)) {
        return Err(format!(
            "Access denied: {} is in a sensitive directory",
            path
        ));
    }

    let metadata = std::fs::metadata(&file_path)
        .map_err(|e| format!("Failed to read metadata for {}: {}", path, e))?;
    if !metadata.is_file() {
        return Err(format!("Not a file: {}", path));
    }

    // Prevent accidental huge payloads over IPC.
    const MAX_BYTES: u64 = 100 * 1024 * 1024;
    if metadata.len() > MAX_BYTES {
        return Err(format!(
            "File too large: {} bytes (max {} bytes)",
            metadata.len(),
            MAX_BYTES
        ));
    }

    let bytes = std::fs::read(&file_path).map_err(|e| format!("Failed to read {}: {}", path, e))?;
    // Return base64 to avoid JSON number-array serialization (14 MB VRM → ~200 MB JS heap).
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// Fetch linked messaging channels for the current user from naia.nextain.io BFF.
/// Returns JSON string: { "channels": [{ "type": "discord", "userId": "..." }] }
#[tauri::command]
async fn fetch_linked_channels(naia_key: String, user_id: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let res = client
        .get("https://naia.nextain.io/api/gateway/linked-channels")
        .header("X-Desktop-Key", &naia_key)
        .header("X-User-Id", &user_id)
        .send()
        .await
        .map_err(|e| format!("linked-channels request failed: {}", e))?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("linked-channels API error {}: {}", status, body));
    }

    res.text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))
}

/// Parameters for syncing Shell provider settings to Naia Gateway config
#[derive(Deserialize)]
#[allow(dead_code)]
struct GatewaySyncParams {
    provider: String,
    model: String,
    api_key: Option<String>,
    persona: Option<String>,
    agent_name: Option<String>,
    user_name: Option<String>,
    locale: Option<String>,
    discord_dm_channel_id: Option<String>,
    discord_default_user_id: Option<String>,
    tts_provider: Option<String>,
    tts_voice: Option<String>,
    tts_auto: Option<String>,
    tts_mode: Option<String>,
    naia_key: Option<String>,
    ollama_host: Option<String>,
    lab_gateway_url: Option<String>,
    // Memory settings — written to config.memory for agent resolveMemorySystem()
    memory_adapter: Option<String>,
    memory_embedding_provider: Option<String>,
    memory_offline_model: Option<String>,
    memory_embedding_base_url: Option<String>,
    memory_embedding_api_key: Option<String>,
    memory_embedding_model: Option<String>,
    qdrant_url: Option<String>,
    qdrant_api_key: Option<String>,
    memory_llm_provider: Option<String>,
    memory_llm_base_url: Option<String>,
    memory_llm_api_key: Option<String>,
    memory_llm_model: Option<String>,
}

/// Sync Shell provider/model/API-key to gateway config file so the
/// Naia Gateway agent uses the same settings (e.g. for Discord DM replies).
#[tauri::command]
async fn sync_gateway_config(params: GatewaySyncParams) -> Result<(), String> {
    // Map Shell ProviderId → Naia Gateway provider name
    let oc_provider = match params.provider.as_str() {
        "gemini" | "nextain" => "google",
        "anthropic" => "anthropic",
        "openai" => "openai",
        "xai" => "xai",
        "zai" => "zai",
        "ollama" => "ollama",
        // claude-code-cli doesn't use gateway config
        _ => return Ok(()),
    };

    let home = home_dir();
    // Use ~/.naia/gateway.json (standard path); fall back to legacy openclaw.json
    let primary = format!("{}/.naia/gateway.json", home);
    let legacy = format!("{}/.openclaw/openclaw.json", home);
    let config_path = if std::path::Path::new(&primary).exists() {
        primary
    } else if std::path::Path::new(&legacy).exists() {
        legacy
    } else {
        // Create in standard location
        primary
    };

    // Ensure config file exists with required gateway fields before reading.
    // Single bootstrap path: ensure_gateway_config handles both creation and patching.
    ensure_gateway_config(&config_path);

    let mut root: serde_json::Value = {
        let raw = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read {}: {}", config_path, e))?;
        serde_json::from_str(&raw).map_err(|e| format!("Failed to parse {}: {}", config_path, e))?
    };

    // Set agents.defaults.model.primary = "{oc_provider}/{model}"
    let model_value = format!("{}/{}", oc_provider, params.model);
    let obj = root.as_object_mut().ok_or("Config root is not an object")?;
    let agents = obj
        .entry("agents")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("agents is not an object")?;
    let defaults = agents
        .entry("defaults")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("defaults is not an object")?;
    let model_obj = defaults
        .entry("model")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("model is not an object")?;
    model_obj.insert(
        "primary".to_string(),
        serde_json::Value::String(model_value.clone()),
    );

    // Write custom Ollama baseUrl into gateway config for Naia Gateway to use.
    // Gateway reads models.providers.ollama.baseUrl (not OLLAMA_HOST env).
    if oc_provider == "ollama" {
        let models_section = obj
            .entry("models")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or("models is not an object")?;
        let providers_section = models_section
            .entry("providers")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or("providers is not an object")?;
        let ollama_cfg = providers_section
            .entry("ollama")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or("ollama provider config is not an object")?;
        if let Some(ref host) = params.ollama_host {
            let clean = host.trim_end_matches('/').trim_end_matches("/v1");
            ollama_cfg.insert(
                "baseUrl".to_string(),
                serde_json::Value::String(clean.to_string()),
            );
        } else {
            ollama_cfg.remove("baseUrl");
        }
    }

    // Always ensure gateway.mode=local (defense-in-depth: ensure_gateway_config may
    // have failed silently, or config was overwritten by another code path).
    let gw = obj
        .entry("gateway")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("gateway is not an object")?;
    gw.entry("mode")
        .or_insert_with(|| serde_json::Value::String("local".to_string()));
    // reload.mode=off prevents file-watcher race conditions.
    let reload = gw
        .entry("reload")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("reload is not an object")?;
    reload.insert(
        "mode".to_string(),
        serde_json::Value::String("off".to_string()),
    );

    // Isolate DM sessions from Shell chat (defense-in-depth, mirrors ensure_gateway_config)
    let session_obj = obj
        .entry("session")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("session is not an object")?;
    session_obj
        .entry("dmScope")
        .or_insert_with(|| serde_json::Value::String("per-channel-peer".to_string()));

    // Sync Discord DM defaults into channels.discord so the gateway knows the DM target
    if let Some(ref user_id) = params.discord_default_user_id {
        let channels = obj
            .entry("channels")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or("channels is not an object")?;
        let discord = channels
            .entry("discord")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or("discord is not an object")?;
        discord.insert(
            "dmPolicy".to_string(),
            serde_json::Value::String("allowlist".to_string()),
        );
        discord.insert("allowFrom".to_string(), serde_json::json!([user_id]));
        let dm = discord
            .entry("dm")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or("dm is not an object")?;
        dm.insert("enabled".to_string(), serde_json::Value::Bool(true));
    }

    // Sync TTS settings into messages.tts so the gateway uses the right provider/voice
    // TTS is handled entirely by Shell (not Naia Gateway).
    // No TTS config sync needed — removed to prevent gateway config schema crashes.

    // Memory settings: written to a separate Naia-managed file so they don't
    // pollute the OpenClaw config schema (which rejects unknown keys). (#226)
    // Agent reads memory config from ~/.naia/memory-config.json instead.
    {
        let has_memory = params.memory_adapter.is_some()
            || params.memory_embedding_provider.is_some()
            || params.memory_offline_model.is_some()
            || params.memory_embedding_base_url.is_some()
            || params.memory_embedding_api_key.is_some()
            || params.memory_embedding_model.is_some()
            || params.qdrant_url.is_some()
            || params.qdrant_api_key.is_some()
            || params.memory_llm_provider.is_some()
            || params.memory_llm_base_url.is_some()
            || params.memory_llm_api_key.is_some()
            || params.memory_llm_model.is_some();
        if has_memory {
            let mut mem_obj = serde_json::Map::new();
            macro_rules! sync_opt {
                ($key:expr, $val:expr) => {
                    if let Some(v) = &$val {
                        mem_obj.insert($key.to_string(), serde_json::Value::String(v.clone()));
                    }
                };
            }
            sync_opt!("adapter", params.memory_adapter);
            sync_opt!("embeddingProvider", params.memory_embedding_provider);
            sync_opt!("offlineModel", params.memory_offline_model);
            sync_opt!("embeddingBaseUrl", params.memory_embedding_base_url);
            sync_opt!("embeddingApiKey", params.memory_embedding_api_key);
            sync_opt!("embeddingModel", params.memory_embedding_model);
            sync_opt!("qdrantUrl", params.qdrant_url);
            sync_opt!("qdrantApiKey", params.qdrant_api_key);
            sync_opt!("llmProvider", params.memory_llm_provider);
            sync_opt!("llmBaseUrl", params.memory_llm_base_url);
            sync_opt!("llmApiKey", params.memory_llm_api_key);
            sync_opt!("llmModel", params.memory_llm_model);
            let home = std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .unwrap_or_default();
            let mem_config_path = format!("{}/.naia/memory-config.json", home);
            let mem_json = serde_json::to_string_pretty(&serde_json::Value::Object(mem_obj))
                .unwrap_or_default();
            // Atomic write: tmp file + rename (mirrors openclaw.json pattern).
            // Prevents torn reads if the agent process restarts during a settings save.
            let tmp_path = format!("{}.tmp", mem_config_path);
            if std::fs::write(&tmp_path, mem_json.as_bytes()).is_ok() {
                let _ = std::fs::rename(&tmp_path, &mem_config_path);
            }
        }
        // Clean up legacy memory keys from openclaw.json to prevent Gateway rejection
        if let Some(mem) = obj.get_mut("memory") {
            if let Some(mem_obj) = mem.as_object_mut() {
                mem_obj.remove("adapter");
                mem_obj.remove("embeddingProvider");
                mem_obj.remove("offlineModel");
                mem_obj.remove("embeddingBaseUrl");
                mem_obj.remove("embeddingApiKey");
                mem_obj.remove("embeddingModel");
                mem_obj.remove("qdrantUrl");
                mem_obj.remove("qdrantApiKey");
            }
        }
    }

    // Atomic write: gateway config file
    let dir = std::path::Path::new(&config_path)
        .parent()
        .ok_or("No parent dir")?;
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Failed to create dir {}: {}", dir.display(), e))?;
    let tmp_path = format!("{}.tmp", config_path);
    let pretty =
        serde_json::to_string_pretty(&root).map_err(|e| format!("JSON serialize: {}", e))?;
    std::fs::write(&tmp_path, pretty.as_bytes())
        .map_err(|e| format!("Failed to write {}: {}", tmp_path, e))?;
    std::fs::rename(&tmp_path, &config_path)
        .map_err(|e| format!("Failed to rename {} → {}: {}", tmp_path, config_path, e))?;

    // Write env file for gateway.
    {
        let gateway_dir = std::path::Path::new(&config_path)
            .parent()
            .ok_or("No parent dir")?;
        let env_path = gateway_dir.join("gateway-env.json");
        let mut env_obj: serde_json::Map<String, serde_json::Value> = if env_path.exists() {
            let raw = std::fs::read_to_string(&env_path).unwrap_or_else(|_| "{}".to_string());
            serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::Map::new())
        } else {
            serde_json::Map::new()
        };
        // TTS handled by Shell, not Gateway — no OPENAI_TTS_BASE_URL needed
        env_obj.remove("OPENAI_TTS_BASE_URL");
        // Write OLLAMA_API_KEY for Naia Gateway to register Ollama as a provider.
        // Gateway requires this env var (any non-empty value) to enable Ollama.
        if params.provider == "ollama" {
            env_obj.insert(
                "OLLAMA_API_KEY".to_string(),
                serde_json::Value::String("ollama-local".to_string()),
            );
        } else {
            env_obj.remove("OLLAMA_API_KEY");
        }
        // Propagate Lab gateway URL override
        if let Some(ref url) = params.lab_gateway_url {
            env_obj.insert(
                "NAIA_GATEWAY_URL".to_string(),
                serde_json::Value::String(url.clone()),
            );
        }
        let env_pretty = serde_json::to_string_pretty(&serde_json::Value::Object(env_obj))
            .map_err(|e| format!("JSON serialize env: {}", e))?;
        std::fs::write(&env_path, env_pretty.as_bytes())
            .map_err(|e| format!("Failed to write gateway-env: {}", e))?;
    }

    // Write Naia Lab key to auth-profiles.json (where Naia Gateway reads credentials).
    // Only naia_key (from Lab login flow) belongs here — api_key is the generic provider key
    // (Google AI Studio key, Anthropic key, etc.) and must NOT touch auth-profiles.
    if let Some(naia_key_val) = params.naia_key.as_deref().filter(|k| !k.is_empty()) {
        let ak = naia_key_val.to_string();
        if !ak.is_empty() {
            let gateway_dir = std::path::Path::new(&config_path)
                .parent()
                .ok_or("No parent dir")?;
            let auth_path = gateway_dir.join("agents/main/agent/auth-profiles.json");
            if let Some(auth_parent) = auth_path.parent() {
                std::fs::create_dir_all(auth_parent).map_err(|e| {
                    format!("Failed to create dir {}: {}", auth_parent.display(), e)
                })?;
            }

            let mut auth_root: serde_json::Value = if auth_path.exists() {
                let raw = std::fs::read_to_string(&auth_path)
                    .map_err(|e| format!("Failed to read auth-profiles: {}", e))?;
                serde_json::from_str(&raw)
                    .map_err(|e| format!("Failed to parse auth-profiles: {}", e))?
            } else {
                serde_json::json!({"version": 1, "profiles": {}})
            };

            let profile_id = format!("{}:naia", oc_provider);
            let profiles = auth_root
                .as_object_mut()
                .ok_or("auth root is not an object")?
                .entry("profiles")
                .or_insert_with(|| serde_json::json!({}))
                .as_object_mut()
                .ok_or("profiles is not an object")?;
            profiles.insert(
                profile_id.clone(),
                serde_json::json!({
                    "type": "api_key",
                    "provider": oc_provider,
                    "key": ak,
                }),
            );

            // Use with_extension to avoid lossy Path::display() on non-UTF-8 paths.
            let auth_tmp = auth_path.with_extension("json.tmp");
            let auth_pretty = serde_json::to_string_pretty(&auth_root)
                .map_err(|e| format!("JSON serialize auth-profiles: {}", e))?;
            std::fs::write(&auth_tmp, auth_pretty.as_bytes())
                .map_err(|e| format!("Failed to write {}: {}", auth_tmp.display(), e))?;
            std::fs::rename(&auth_tmp, &auth_path)
                .map_err(|e| format!("Failed to rename auth-profiles: {}", e))?;

            log_both(&format!(
                "[Naia] Synced Gateway auth-profile: {}",
                profile_id
            ));
        }
    }

    log_both(&format!(
        "[Naia] Synced Gateway config: model={}",
        model_value
    ));

    // --- Workspace bootstrap files (SOUL.md, IDENTITY.md, USER.md) ---
    // Read workspace path from gateway.json → agents.defaults.workspace
    let workspace_path = root
        .get("agents")
        .and_then(|a| a.get("defaults"))
        .and_then(|d| d.get("workspace"))
        .and_then(|w| w.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("{}/.naia/workspace", home));

    let ws_dir = std::path::Path::new(&workspace_path);

    // SOUL.md — persona / character description
    if let Some(ref persona) = params.persona {
        if !persona.trim().is_empty() {
            if let Err(e) = std::fs::create_dir_all(ws_dir) {
                log_both(&format!(
                    "[Naia] Failed to create workspace dir {}: {}",
                    ws_dir.display(),
                    e
                ));
            } else {
                let soul_path = ws_dir.join("SOUL.md");
                let soul_tmp = ws_dir.join("SOUL.md.tmp");
                let content = format!(
                    "# SOUL.md - Who You Are\n\n{}\n\n---\n*Synced from Naia Shell settings.*\n",
                    persona.trim()
                );
                match std::fs::write(&soul_tmp, content.as_bytes()) {
                    Ok(_) => match std::fs::rename(&soul_tmp, &soul_path) {
                        Ok(_) => log_both(&format!(
                            "[Naia] Synced workspace bootstrap: SOUL.md → {}",
                            soul_path.display()
                        )),
                        Err(e) => log_both(&format!("[Naia] Failed to rename SOUL.md: {}", e)),
                    },
                    Err(e) => log_both(&format!("[Naia] Failed to write SOUL.md.tmp: {}", e)),
                }
            }
        }
    }

    // IDENTITY.md — agent name / avatar identity
    if let Some(ref agent_name) = params.agent_name {
        if !agent_name.trim().is_empty() {
            if let Err(e) = std::fs::create_dir_all(ws_dir) {
                log_both(&format!(
                    "[Naia] Failed to create workspace dir {}: {}",
                    ws_dir.display(),
                    e
                ));
            } else {
                let id_path = ws_dir.join("IDENTITY.md");
                let id_tmp = ws_dir.join("IDENTITY.md.tmp");
                let content = format!(
                    "# IDENTITY.md - Who Am I?\n\n\
                     - **Name:** {}\n\
                     - **Creature:** AI avatar\n\
                     - **Vibe:** Personal AI companion\n\
                     - **Emoji:** \u{1f319}\n\n\
                     ---\n\
                     *Synced from Naia Shell settings.*\n",
                    agent_name.trim()
                );
                match std::fs::write(&id_tmp, content.as_bytes()) {
                    Ok(_) => match std::fs::rename(&id_tmp, &id_path) {
                        Ok(_) => log_both(&format!(
                            "[Naia] Synced workspace bootstrap: IDENTITY.md → {}",
                            id_path.display()
                        )),
                        Err(e) => log_both(&format!("[Naia] Failed to rename IDENTITY.md: {}", e)),
                    },
                    Err(e) => log_both(&format!("[Naia] Failed to write IDENTITY.md.tmp: {}", e)),
                }
            }
        }
    }

    // USER.md — human user info
    if let Some(ref user_name) = params.user_name {
        if !user_name.trim().is_empty() {
            if let Err(e) = std::fs::create_dir_all(ws_dir) {
                log_both(&format!(
                    "[Naia] Failed to create workspace dir {}: {}",
                    ws_dir.display(),
                    e
                ));
            } else {
                let user_path = ws_dir.join("USER.md");
                let user_tmp = ws_dir.join("USER.md.tmp");
                let trimmed = user_name.trim();
                let lang = match params.locale.as_deref().unwrap_or("ko") {
                    "ko" => "Korean",
                    "en" => "English",
                    "ja" => "Japanese",
                    "zh" => "Chinese",
                    "fr" => "French",
                    "de" => "German",
                    "ru" => "Russian",
                    "es" => "Spanish",
                    "ar" => "Arabic",
                    "hi" => "Hindi",
                    "bn" => "Bengali",
                    "pt" => "Portuguese",
                    "id" => "Indonesian",
                    "vi" => "Vietnamese",
                    other => other,
                };
                let content = format!(
                    "# USER.md - About Your Human\n\n\
                     - **Name:** {name}\n\
                     - **What to call them:** {name}\n\
                     - **Language:** {lang}\n\
                     - **Notes:** Uses Naia App.\n\n\
                     ---\n\
                     *Synced from Naia Shell settings.*\n",
                    name = trimmed,
                    lang = lang
                );
                match std::fs::write(&user_tmp, content.as_bytes()) {
                    Ok(_) => match std::fs::rename(&user_tmp, &user_path) {
                        Ok(_) => log_both(&format!(
                            "[Naia] Synced workspace bootstrap: USER.md → {}",
                            user_path.display()
                        )),
                        Err(e) => log_both(&format!("[Naia] Failed to rename USER.md: {}", e)),
                    },
                    Err(e) => log_both(&format!("[Naia] Failed to write USER.md.tmp: {}", e)),
                }
            }
        }
    }

    // Clean up BOOTSTRAP.md — no longer needed after SOUL/IDENTITY/USER sync
    let bootstrap_path = ws_dir.join("BOOTSTRAP.md");
    if bootstrap_path.exists() {
        match std::fs::remove_file(&bootstrap_path) {
            Ok(_) => log_both(&format!(
                "[Naia] Removed BOOTSTRAP.md (superseded by SOUL/IDENTITY/USER)"
            )),
            Err(e) => log_both(&format!("[Naia] Failed to remove BOOTSTRAP.md: {}", e)),
        }
    }

    Ok(())
}

// ── Gemini Live WebSocket proxy commands ──
// WebKitGTK cannot directly connect to wss://generativelanguage.googleapis.com
// (silent hang). These commands proxy the WebSocket through Rust.

#[tauri::command]
async fn gemini_live_connect(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    params: gemini_live::GeminiLiveConnectParams,
) -> Result<(), String> {
    gemini_live::connect(app, state.gemini_live.clone(), params).await
}

#[tauri::command]
async fn gemini_live_send_audio(
    state: tauri::State<'_, AppState>,
    pcm_base64: String,
) -> Result<(), String> {
    gemini_live::send_audio(&state.gemini_live, pcm_base64).await
}

#[tauri::command]
async fn gemini_live_send_text(
    state: tauri::State<'_, AppState>,
    text: String,
) -> Result<(), String> {
    gemini_live::send_text(&state.gemini_live, text).await
}

#[tauri::command]
async fn gemini_live_send_tool_response(
    state: tauri::State<'_, AppState>,
    call_id: String,
    result: serde_json::Value,
) -> Result<(), String> {
    gemini_live::send_tool_response(&state.gemini_live, call_id, result).await
}

#[tauri::command]
async fn gemini_live_disconnect(state: tauri::State<'_, AppState>) -> Result<(), String> {
    gemini_live::disconnect(state.gemini_live.clone()).await;
    Ok(())
}

// ── naia-settings asset commands ─────────────────────────────────────────────

/// List filenames inside `{adk_path}/naia-settings/{subdir}/`.
/// Only whitelisted subdirs are allowed.
#[tauri::command]
async fn list_naia_assets(adk_path: String, subdir: String) -> Result<Vec<String>, String> {
    const ALLOWED: &[&str] = &["vrm-files", "background", "bgm-musics", "splash-img"];
    if !ALLOWED.contains(&subdir.as_str()) {
        return Err(format!("Invalid subdir: {subdir}"));
    }
    let dir = std::path::PathBuf::from(&adk_path)
        .join("naia-settings")
        .join(&subdir);
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut files = vec![];
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if entry.path().is_file() {
                if let Some(name) = entry.file_name().to_str() {
                    files.push(name.to_string());
                }
            }
        }
    }
    files.sort();
    Ok(files)
}

/// Read `{adk_path}/naia-settings/config.json`. Returns empty string if not found.
#[tauri::command]
async fn read_naia_config(adk_path: String) -> Result<String, String> {
    let path = std::path::PathBuf::from(&adk_path)
        .join("naia-settings")
        .join("config.json");
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Write `{adk_path}/naia-settings/config.json`.
#[tauri::command]
async fn write_naia_config(adk_path: String, json: String) -> Result<(), String> {
    let dir = std::path::PathBuf::from(&adk_path).join("naia-settings");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("config.json"), json).map_err(|e| e.to_string())
}

/// Check whether `{adk_path}/naia-settings/` already exists.
#[tauri::command]
async fn check_naia_settings(adk_path: String) -> bool {
    std::path::PathBuf::from(&adk_path)
        .join("naia-settings")
        .is_dir()
}

/// Create `{adk_path}/naia-settings/` and standard subdirectories.
#[tauri::command]
async fn init_naia_settings(adk_path: String) -> Result<(), String> {
    if adk_path.is_empty() {
        return Err("adk_path is empty".to_string());
    }
    let base = std::path::PathBuf::from(&adk_path).join("naia-settings");
    for subdir in &["vrm-files", "background", "bgm-musics", "splash-img"] {
        std::fs::create_dir_all(base.join(subdir))
            .map_err(|e| format!("Failed to create {subdir}: {e}"))?;
    }
    Ok(())
}

/// Copy bundled default assets (vrm-files, background, bgm-musics) from the app's
/// resource directory into `{adk_path}/naia-settings/`. Skips files that already exist.
#[tauri::command]
async fn copy_bundled_assets(app_handle: tauri::AppHandle, adk_path: String) -> Result<(), String> {
    // Find the bundled assets base directory.
    // Production: resource_dir()/assets/
    // Dev mode fallback: walk up from binary to find public/assets/
    let assets_base = find_bundled_assets_dir(&app_handle);
    let Some(assets_base) = assets_base else {
        return Err("Bundled assets directory not found".to_string());
    };

    for subdir in &["vrm-files", "background", "bgm-musics"] {
        let src_dir = assets_base.join(subdir);
        let dst_dir = std::path::PathBuf::from(&adk_path)
            .join("naia-settings")
            .join(subdir);

        if !src_dir.is_dir() {
            continue;
        }
        std::fs::create_dir_all(&dst_dir).map_err(|e| e.to_string())?;

        for entry in std::fs::read_dir(&src_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let dst = dst_dir.join(entry.file_name());
            if !dst.exists() {
                std::fs::copy(entry.path(), &dst).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

fn find_bundled_assets_dir(app_handle: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    // 1) Production: resource_dir()/assets/
    if let Ok(rdir) = app_handle.path().resource_dir() {
        let candidate = rdir.join("assets");
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    // 2) Dev mode: binary is at shell/src-tauri/target/debug/
    //    public/assets is at shell/public/assets/ (3 levels up, then public/assets)
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent()?.to_path_buf();
        for _ in 0..4 {
            let candidate = dir.join("public").join("assets");
            if candidate.is_dir() {
                return Some(candidate);
            }
            dir = dir.parent()?.to_path_buf();
        }
    }
    None
}

/// Write binary data to `{adk_path}/naia-settings/{subdir}/{filename}`.
/// Only whitelisted subdirs are allowed.
#[tauri::command]
async fn write_naia_asset(
    adk_path: String,
    subdir: String,
    filename: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    const ALLOWED: &[&str] = &["vrm-files", "background", "bgm-musics", "splash-img"];
    if !ALLOWED.contains(&subdir.as_str()) {
        return Err(format!("Invalid subdir: {subdir}"));
    }
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err("Invalid filename".to_string());
    }
    let path = std::path::PathBuf::from(&adk_path)
        .join("naia-settings")
        .join(&subdir)
        .join(&filename);
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())
}

/// Delete `{adk_path}/naia-settings/` entirely (user data reset).
/// Safety: only removes the `naia-settings` subdirectory, never the adk_path root.
#[tauri::command]
async fn delete_naia_settings(adk_path: String) -> Result<(), String> {
    if adk_path.is_empty() {
        return Err("adk_path is empty".to_string());
    }
    let adk = std::path::PathBuf::from(&adk_path);
    // Guard: must be an existing directory
    if !adk.is_dir() {
        return Err(format!("adk_path is not a directory: {adk_path}"));
    }
    let naia_settings = adk.join("naia-settings");
    if !naia_settings.exists() {
        return Ok(()); // nothing to delete
    }
    std::fs::remove_dir_all(&naia_settings)
        .map_err(|e| format!("Failed to delete naia-settings: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize env_logger so `log` crate macros (info!, debug!, warn!) produce output.
    // Control verbosity with RUST_LOG env var, e.g. RUST_LOG=tauri_plugin_stt=debug
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    // Open debug log file — frontend logs are written here with flush so crashes are captured.
    let log_path = std::env::temp_dir().join("naia-debug.log");
    match std::fs::OpenOptions::new().create(true).write(true).truncate(true).open(&log_path) {
        Ok(f) => {
            DEBUG_LOG_FILE.get_or_init(|| Mutex::new(f));
            log::info!("[naia] debug log file: {}", log_path.display());
        }
        Err(e) => log::warn!("[naia] could not open debug log file: {}", e),
    }

    let is_flatpak = std::env::var("FLATPAK").map(|v| v == "1").unwrap_or(false);

    let mut builder = tauri::Builder::default()
        .register_uri_scheme_protocol("naia-bridge", |_ctx, request| {
            browser_webview::handle_bridge_request(request)
        })
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // When a second instance is launched (e.g. via deep link),
            // focus the existing window instead.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
            let _ = args; // deep link URLs are handled by on_open_url
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_stt::init());

    // Flatpak manages its own updates; skip updater plugin in Flatpak builds
    if !is_flatpak {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder.manage(AppState {
            agent: Mutex::new(None),
            gateway: Mutex::new(None),
            health_monitor_shutdown: Mutex::new(None),
            oauth_state: Arc::new(Mutex::new(None)),
            gemini_live: gemini_live::new_shared_handle(),
            last_agent_restart: Mutex::new(None),
        })
        .manage(workspace::new_shared_watcher())
        .manage(pty::new_registry())
        .invoke_handler(tauri::generate_handler![
            list_skills,
            frontend_log,
            list_stt_models,
            download_stt_model,
            delete_stt_model,
            send_to_agent_command,
            cancel_stream,
            reset_window_state,
            reset_gateway_data,
            gateway_health,
            restart_gateway,
            get_audit_log,
            get_audit_stats,
            memory_get_all_facts,
            memory_delete_fact,
            memory_export_backup,
            memory_import_backup,
            validate_api_key,
            list_audio_output_devices,
            generate_oauth_state,
            read_local_binary,
            write_temp_text,
            read_discord_bot_token,
            write_discord_bot_token,
            discord_api,
            sync_gateway_config,
            fetch_linked_channels,
            gemini_live_connect,
            gemini_live_send_audio,
            gemini_live_send_text,
            gemini_live_send_tool_response,
            gemini_live_disconnect,
            // naia-settings asset commands
            list_naia_assets,
            read_naia_config,
            write_naia_config,
            check_naia_settings,
            init_naia_settings,
            delete_naia_settings,
            write_naia_asset,
            copy_bundled_assets,
            // Login Chrome (standalone auth window, not embedded)
            browser::browser_open_login,
            browser::browser_chrome_testing_ready,
            // Multi-webview browser panel (replaces Chrome embedding)
            browser_webview::browser_wv_check,
            browser_webview::browser_wv_create,
            browser_webview::browser_wv_resize,
            browser_webview::browser_wv_navigate,
            browser_webview::browser_wv_page_info,
            browser_webview::browser_wv_back,
            browser_webview::browser_wv_forward,
            browser_webview::browser_wv_reload,
            browser_webview::browser_wv_show,
            browser_webview::browser_wv_hide,
            browser_webview::browser_wv_snapshot,
            browser_webview::browser_wv_click,
            browser_webview::browser_wv_fill,
            browser_webview::browser_wv_get_text,
            browser_webview::browser_wv_scroll,
            browser_webview::browser_wv_press,
            browser_webview::browser_wv_screenshot,
            browser_webview::browser_wv_eval,
            // Common tab skills
            capture::capture_screen_region,
            panel::panel_list_installed,
            panel::panel_remove_installed,
            panel::panel_read_file,
            panel::panel_run_shell,
            workspace::workspace_list_dirs,
            workspace::workspace_read_file,
            workspace::workspace_read_file_bytes,
            workspace::workspace_file_size,
            workspace::workspace_write_file,
            workspace::workspace_get_git_info,
            workspace::workspace_get_sessions,
            workspace::workspace_get_progress,
            workspace::workspace_start_watch,
            workspace::workspace_stop_watch,
            workspace::workspace_classify_dirs,
            workspace::workspace_set_root,
            workspace::workspace_detect_adk_root,
            workspace::workspace_load_project_index,
            workspace::workspace_discover_skills,
            workspace::workspace_read_skill_content,
            workspace::workspace_check_adk_server,
            workspace::workspace_discover_adk_server,
            workspace::workspace_get_pty_agents,
            pty::pty_create,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_execute_sync,
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();
            let state: tauri::State<'_, AppState> = app.state();

            // Initialize audit DB
            let audit_db_path = app_handle
                .path()
                .app_config_dir()
                .map(|d| d.join("audit.db"))
                .map_err(|e| format!("Failed to get config dir: {}", e))?;
            if let Some(parent) = audit_db_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let audit_db = audit::init_db(&audit_db_path)
                .map_err(|e| -> Box<dyn std::error::Error> { format!("Failed to init audit DB: {}", e).into() })?;
            app.manage(AuditState { db: audit_db.clone() });
            log_verbose(&format!("[Naia] Audit DB initialized at: {}", audit_db_path.display()));

            // Memory: Agent MemorySystem reads/writes ~/.naia/memory/alpha-memory.json directly.
            // Shell reads that file via memory::get_all_agent_facts() — no SQLite DB needed.

            // Migrate legacy vosk-models → stt-models
            stt_models::migrate_legacy_vosk_models(&app_handle);

            // Register deep-link handler for naia:// URI scheme
            #[cfg(desktop)]
            app.deep_link().register_all().unwrap_or_else(|e| {
                log_both(&format!("[Naia] Deep link registration failed: {}", e));
            });

            let deep_link_handle = app_handle.clone();
            let deep_link_state: tauri::State<'_, AppState> = app.state();
            let oauth_state_ref = deep_link_state.oauth_state.clone();
            app.deep_link().on_open_url(move |event| {
                let urls = event.urls();
                for url in urls {
                    let url_str = url.as_str();
                    // Redact query params (may contain lab key)
                    let redacted = url_str.split('?').next().unwrap_or(url_str);
                    log_both(&format!("[Naia] Deep link received: {}?[REDACTED]", redacted));
                    // Parse naia://auth?key=xxx or naia://auth?code=xxx
                    if let Ok(parsed) = url::Url::parse(url_str) {
                        if parsed.host_str() == Some("auth") || parsed.path() == "auth" || parsed.path() == "/auth" {
                            let mut key = None;
                            let mut code = None;
                            let mut user_id = None;
                            let mut incoming_state = None;
                            let mut channel = None;
                            let mut discord_user_id = None;
                            let mut discord_channel_id = None;
                            let mut discord_target = None;
                            for (k, v) in parsed.query_pairs() {
                                match k.as_ref() {
                                    "key" => key = Some(v.to_string()),
                                    "code" => code = Some(v.to_string()),
                                    "user_id" => user_id = Some(v.to_string()),
                                    "state" => incoming_state = Some(v.to_string()),
                                    "channel" => channel = Some(v.to_string()),
                                    "discord_user_id" | "discordUserId" => discord_user_id = Some(v.to_string()),
                                    "discord_channel_id" | "discordChannelId" => {
                                        discord_channel_id = Some(v.to_string())
                                    }
                                    "discord_target" | "discordTarget" => {
                                        discord_target = Some(v.to_string())
                                    }
                                    _ => {}
                                }
                            }

                            // Verify OAuth state to prevent CSRF (CWE-352).
                            // Always require state when one was set; reject if
                            // incoming link omits it entirely to prevent crafted
                            // deep links from bypassing the check.
                            let expected_state = lock_or_recover(
                                &oauth_state_ref,
                                "state.oauth_state(deep_link_expected)",
                            )
                            .clone();
                            match (&expected_state, &incoming_state) {
                                (Some(expected), Some(incoming)) if incoming == expected => {
                                    // State matches — clear it (single-use)
                                    *lock_or_recover(
                                        &oauth_state_ref,
                                        "state.oauth_state(deep_link_clear)",
                                    ) = None;
                                }
                                (Some(_), _) => {
                                    // Expected state set but incoming is missing or wrong
                                    log_both("[Naia] Deep link rejected: state mismatch or missing");
                                    continue;
                                }
                                (None, _) => {
                                    // No expected state — this path is only valid when
                                    // the deep link carries a direct key (manual entry).
                                    // Require the key parameter to be present.
                                    if key.is_none() {
                                        log_both("[Naia] Deep link rejected: no state and no key");
                                        continue;
                                    }
                                }
                            }

                            // Validate user_id if present: alphanumeric, hyphens, underscores, dots, max 256 chars
                            let validated_user_id = user_id.clone().filter(|uid| {
                                uid.len() <= 256
                                    && uid.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '@')
                            });
                            let resolved_key = if key.is_some() {
                                key
                            } else if let Some(code_val) = code {
                                // Some OAuth providers return ?code=. Only accept it when it is already a gateway API key.
                                if code_val.starts_with("gw-") {
                                    Some(code_val)
                                } else {
                                    log_both("[Naia] Deep link rejected: code is not a gateway API key (expected gw-*)");
                                    None
                                }
                            } else {
                                None
                            };

                            if let Some(naia_key) = resolved_key {
                                // Validate key format: gw- prefix + [A-Za-z0-9_-], max 256 chars
                                let is_valid = naia_key.starts_with("gw-")
                                    && naia_key.len() <= 256
                                    && naia_key.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_');
                                if !is_valid {
                                    log_both("[Naia] Deep link rejected: invalid key format");
                                    continue;
                                }
                                let payload = serde_json::json!({
                                    "naiaKey": naia_key,
                                    "naiaUserId": validated_user_id,
                                });
                                let _ = deep_link_handle.emit("naia_auth_complete", payload);
                                log_both("[Naia] Naia auth complete — key received via deep link");
                            }

                            let is_discord_flow = matches!(channel.as_deref(), Some("discord"))
                                || discord_user_id.is_some()
                                || discord_channel_id.is_some()
                                || discord_target.is_some();
                            if is_discord_flow {
                                let validated_discord_user_id = discord_user_id
                                    .filter(|uid| is_valid_discord_snowflake(uid));
                                let validated_discord_channel_id = discord_channel_id
                                    .filter(|cid| is_valid_discord_snowflake(cid));
                                let normalized_target = discord_target
                                    .and_then(|target| {
                                        let t = target.trim().to_string();
                                        if t.starts_with("user:") || t.starts_with("channel:") {
                                            Some(t)
                                        } else {
                                            None
                                        }
                                    })
                                    .or_else(|| {
                                        validated_discord_user_id
                                            .as_ref()
                                            .map(|uid| format!("user:{}", uid))
                                    })
                                    .or_else(|| {
                                        validated_discord_channel_id
                                            .as_ref()
                                            .map(|cid| format!("channel:{}", cid))
                                    });

                                let payload = serde_json::json!({
                                    "discordUserId": validated_discord_user_id,
                                    "discordChannelId": validated_discord_channel_id,
                                    "discordTarget": normalized_target,
                                });
                                let _ = deep_link_handle.emit("discord_auth_complete", payload);
                                log_both("[Naia] Discord auth complete — deep link payload received");
                            }
                        }
                    }
                }
            });

            platform::start_deep_link_file_watcher(app_handle.clone());

            // Set window icon explicitly (prevents default yellow WRY icon on Linux)
            if let Some(window) = app.get_webview_window("main") {
                let icon_bytes = include_bytes!("../icons/icon.png");
                if let Ok(icon) = tauri::image::Image::from_bytes(icon_bytes) {
                    let _ = window.set_icon(icon);
                }
            }

            // Restore saved window state, otherwise leave the tauri.conf.json
            // default size (1366x768) and center on the current monitor.
            //
            // Migration: the legacy side-panel layout saved widths around 380px.
            // Treat any saved width below LEGACY_PANEL_WIDTH_CAP as stale and
            // discard it so the new desktop-window default takes effect.
            const LEGACY_PANEL_WIDTH_CAP: u32 = 600;
            if let Some(window) = app.get_webview_window("main") {
                let restored = load_window_state(&app_handle)
                    .filter(|s| s.width >= LEGACY_PANEL_WIDTH_CAP);

                if let Some(saved) = restored {
                    let _ = window.set_size(PhysicalSize::new(saved.width, saved.height));
                    let _ = window.set_position(PhysicalPosition::new(saved.x, saved.y));
                    log_verbose(&format!(
                        "[Naia] Window restored: {}x{} at ({},{})",
                        saved.width, saved.height, saved.x, saved.y
                    ));
                } else {
                    // Discard any legacy side-panel state so the desktop default
                    // is not overwritten on next start.
                    if let Some(path) = window_state_path(&app_handle) {
                        if path.exists() {
                            let _ = std::fs::remove_file(&path);
                            log_verbose("[Naia] Discarded legacy side-panel window state");
                        }
                    }
                    if let Ok(Some(monitor)) = window.current_monitor() {
                        let monitor_size = monitor.size();
                        let monitor_pos = monitor.position();
                        if let Ok(inner) = window.inner_size() {
                            let x = monitor_pos.x
                                + ((monitor_size.width as i32 - inner.width as i32) / 2).max(0);
                            let y = monitor_pos.y
                                + ((monitor_size.height as i32 - inner.height as i32) / 2).max(0);
                            let _ = window.set_position(PhysicalPosition::new(x, y));
                            log_verbose(&format!(
                                "[Naia] Window centered: {}x{} at ({},{})",
                                inner.width, inner.height, x, y
                            ));
                        }
                    }
                }
                let _ = window.show();
            }

            // Windows: enable Korean/CJK IME for the WebView2 child windows.
            // Must run after the window is visible and WebView2 is initialized.
            #[cfg(windows)]
            {
                let app_handle_ime = app_handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    let wm = crate::platform::window_manager();
                    if let Ok(handle) = wm.find_window_by_name("Naia", 5000) {
                        if let crate::platform::PlatformHandle::Win32(hwnd_isize) = handle {
                            crate::platform::enable_ime_for_window(hwnd_isize);
                            log_verbose("[Naia] IME enabled for WebView2 (startup)");
                        }
                    }
                    drop(app_handle_ime);
                });
            }

            // WebKit GPU/permission settings for Linux
            #[cfg(target_os = "linux")]
            if let Some(webview_window) = app.get_webview_window("main") {
                let _ = webview_window.with_webview(|webview| {
                    use webkit2gtk::WebViewExt;

                    // EGL crash workaround: WEBKIT_DISABLE_DMABUF_RENDERER=1 (set in main.rs)
                    // keeps HW accel enabled for WebGL (VRM/Three.js) while avoiding
                    // EGL_BAD_PARAMETER on Intel iGPU + XWayland.

                    // Allow only microphone/media permissions (deny all others)
                    webview.inner().connect_permission_request(|_, request| {
                        if request.is::<webkit2gtk::UserMediaPermissionRequest>() {
                            request.allow();
                        } else {
                            request.deny();
                        }
                        true
                    });
                });
            }

            // Log session start
            log_both("[Naia] === Session started ===");
            log_verbose(&format!("[Naia] Log files at: {}", log_dir().display()));

            // Minimal startup mode: skip all background process spawning so we
            // can isolate whether keyboard input works with just the bare
            // Tauri + WebView2 shell. Set NAIA_MINIMAL=1 to activate.
            if std::env::var("NAIA_MINIMAL").is_ok() {
                log_both("[Naia] *** MINIMAL MODE — skipping gateway/agent/orphan cleanup ***");
                let _ = app_handle.emit(
                    "gateway_status",
                    serde_json::json!({ "running": false, "managed": false }),
                );
                return Ok(());
            }

            // Clean up orphan processes from previous sessions
            platform::cleanup_orphan_processes();

            // Spawn Gateway first (Agent connects to it via WebSocket)
            let (gateway_running, gateway_managed) = match spawn_gateway() {
                Ok(process) => {
                    let managed = process.we_spawned;
                    let has_node_host = process.node_host.is_some();
                    // Write PID files for managed processes
                    if managed {
                        write_pid_file("gateway", process.child.id());
                    }
                    if let Some(ref nh) = process.node_host {
                        write_pid_file("node-host", nh.id());
                    }
                    let mut guard = lock_or_recover(&state.gateway, "state.gateway(setup)");
                    *guard = Some(process);
                    log_both(&format!(
                        "[Naia] Gateway ready (managed={}, node_host={})",
                        managed, has_node_host
                    ));
                    (true, managed)
                }
                Err(e) => {
                    log_both(&format!("[Naia] Gateway not available: {}", e));
                    log_both("[Naia] Running without Gateway (tools will be unavailable)");
                    (false, false)
                }
            };

            // Emit gateway status to frontend
            let _ = app_handle.emit(
                "gateway_status",
                serde_json::json!({ "running": gateway_running, "managed": gateway_managed }),
            );

            // Start periodic health monitoring
            if gateway_running {
                let shutdown = start_gateway_health_monitor(app_handle.clone());
                if let Ok(mut guard) = state.health_monitor_shutdown.lock() {
                    *guard = Some(shutdown);
                }
            }

            // Then spawn Agent
            match spawn_agent_core(&app_handle, &audit_db) {
                Ok(process) => {
                    let mut guard = lock_or_recover(&state.agent, "state.agent(setup)");
                    *guard = Some(process);
                    log_both("[Naia] agent-core started");
                }
                Err(e) => {
                    log_both(&format!("[Naia] agent-core not available: {}", e));
                    log_both("[Naia] Running without agent (chat will be unavailable)");
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::Moved(pos) => {
                    if let Ok(size) = window.outer_size() {
                        save_window_state(&window.app_handle(), &WindowState {
                            x: pos.x,
                            y: pos.y,
                            width: size.width,
                            height: size.height,
                        });
                    }
                }
                tauri::WindowEvent::Resized(size) => {
                    if let Ok(pos) = window.outer_position() {
                        save_window_state(&window.app_handle(), &WindowState {
                            x: pos.x,
                            y: pos.y,
                            width: size.width,
                            height: size.height,
                        });
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    // Kill Chrome on app exit (not on React component unmount)
                    crate::browser::browser_embed_kill();

                    let state: tauri::State<'_, AppState> = window.state();

                    // Stop health monitor thread
                    if let Ok(guard) = state.health_monitor_shutdown.lock() {
                        if let Some(ref flag) = *guard {
                            flag.store(true, std::sync::atomic::Ordering::Relaxed);
                        }
                    }

                    // Kill agent first (it depends on gateway)
                    let agent_lock = state.agent.lock();
                    if let Ok(mut guard) = agent_lock {
                        if let Some(mut process) = guard.take() {
                            log_verbose("[Naia] Terminating agent-core...");
                            let _ = process.child.kill();
                        }
                    }

                    // Kill Node Host + Gateway (only if we spawned)
                    let gateway_lock = state.gateway.lock();
                    if let Ok(mut guard) = gateway_lock {
                        if let Some(mut process) = guard.take() {
                            // Kill Node Host first
                            if let Some(ref mut nh) = process.node_host {
                                log_verbose("[Naia] Terminating Node Host...");
                                let _ = nh.kill();
                            }
                            remove_pid_file("node-host");
                            // Kill Gateway
                            if process.we_spawned {
                                log_verbose("[Naia] Terminating Gateway (we spawned it)...");
                                let _ = process.child.kill();
                                remove_pid_file("gateway");
                            } else {
                                log_verbose("[Naia] Gateway not managed by us — leaving it running");
                            }
                        }
                    }
                    log_both("[Naia] === Session ended ===");
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_chunk_deserializes() {
        let json = r#"{"type":"text","requestId":"req-1","text":"Hello"}"#;
        let chunk: AgentChunk = serde_json::from_str(json).unwrap();
        assert_eq!(chunk.chunk_type, "text");
    }

    #[test]
    fn agent_chunk_usage_deserializes() {
        let json = r#"{"type":"usage","requestId":"req-1","inputTokens":100,"outputTokens":50,"cost":0.001,"model":"gemini-2.5-flash"}"#;
        let chunk: AgentChunk = serde_json::from_str(json).unwrap();
        assert_eq!(chunk.chunk_type, "usage");
    }

    #[test]
    fn window_state_serializes() {
        let state = WindowState {
            x: 100,
            y: 200,
            width: 380,
            height: 900,
        };
        let json = serde_json::to_string(&state).unwrap();
        let parsed: WindowState = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.x, 100);
        assert_eq!(parsed.width, 380);
    }

    #[tokio::test]
    async fn gateway_health_returns_ok() {
        // Should return Ok(bool), not Err — regardless of gateway state
        let result = gateway_health().await;
        assert!(result.is_ok());
    }

    #[test]
    fn cancel_request_formats_correctly() {
        let request_id = "req-123";
        let cancel = serde_json::json!({
            "type": "cancel_stream",
            "requestId": request_id
        });
        let s = cancel.to_string();
        assert!(s.contains("cancel_stream"));
        assert!(s.contains("req-123"));
    }

    #[test]
    fn find_node_binary_returns_result() {
        // Should find node on dev machine (CI may differ)
        let result = find_node_binary();
        // Either Ok (node found) or Err (not found) — both are valid
        match result {
            Ok(path) => assert!(!path.as_os_str().is_empty()),
            Err(e) => assert!(e.contains("Node.js")),
        }
    }

    #[test]
    fn check_gateway_health_sync_returns_bool() {
        // Should return a bool without panicking, regardless of gateway state
        let _healthy = check_gateway_health_sync();
        // Result is environment-dependent: true if gateway running, false if not
    }

    #[test]
    fn gateway_process_we_spawned_flag() {
        // Verify the struct has the expected fields
        let child = Command::new("true").spawn().unwrap();
        let process = GatewayProcess {
            child,
            node_host: None,
            we_spawned: false,
        };
        assert!(!process.we_spawned);
        assert!(process.node_host.is_none());

        let child2 = Command::new("true").spawn().unwrap();
        let nh = Command::new("true").spawn().unwrap();
        let process2 = GatewayProcess {
            child: child2,
            node_host: Some(nh),
            we_spawned: true,
        };
        assert!(process2.we_spawned);
        assert!(process2.node_host.is_some());
    }

    #[test]
    fn log_dir_creates_directory() {
        let dir = log_dir();
        assert!(dir.exists());
        assert!(dir.ends_with(".naia/logs"));
    }
}
