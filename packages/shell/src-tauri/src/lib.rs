mod agent_grpc;
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

fn is_valid_gateway_key(value: &str) -> bool {
    value.starts_with("gw-")
        && value.len() <= 256
        && value
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
}

/// OAuth callback HTTP server bind port (#341 옵션 B — Linux dev:tauri 의
/// `naia://` scheme OS 미등록 우회). 운영 웹은 redirect_uri 로 이 endpoint 를
/// 받아 redirect: `http://127.0.0.1:18792/auth/callback?key=...&state=...&user_id=...`.
/// 동일 query 파라미터 셋이라 `process_deep_link_url` 의 검증 로직 그대로 활용.
pub(crate) const OAUTH_CALLBACK_PORT: u16 = 18792;
pub(crate) const OAUTH_CALLBACK_PATH: &str = "/auth/callback";

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
    // Accept both shapes:
    //   1) Deep link: `naia://auth?...`  →  host_str() == "auth", path() == ""
    //   2) HTTP callback: `http://127.0.0.1:18792/auth/callback?...`
    //                                   →  host_str() == "127.0.0.1",
    //                                      path() starts with "/auth"
    // The old guard only matched (1) and silently rejected (2), which
    // broke #341 옵션 B end-to-end. (Caught by Claude CLI W1.review P0.)
    let is_deep_link_auth = parsed.host_str() == Some("auth");
    let is_http_callback = parsed.path().starts_with("/auth");
    if !is_deep_link_auth && !is_http_callback {
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
    let has_direct_gateway_key = key.as_deref().is_some_and(is_valid_gateway_key)
        || code.as_deref().is_some_and(is_valid_gateway_key);
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
                None if has_direct_gateway_key => {
                    *lock_or_recover(state_mutex, "oauth_state(clear_direct_key)") = None;
                    log_both("[Naia] Deep link accepted without state: direct gateway key");
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
        let is_valid = is_valid_gateway_key(&naia_key);
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

/// Spawn the OAuth callback HTTP server (#341 옵션 B).
///
/// Listens on `127.0.0.1:OAUTH_CALLBACK_PORT` for `GET /auth/callback?key=...`
/// and emits the same `naia_auth_complete` Tauri event as the deep-link path.
/// Designed for Linux dev:tauri where `naia://` URI scheme is not registered
/// with the OS — release builds still use the deep-link path via Tauri plugin.
///
/// **Lifecycle**: best-effort daemon thread. Tauri 종료 시 OS 가 listener
/// 정리. 별도 shutdown signal X — Tauri 자체 종료가 충분.
///
/// **Security**: 127.0.0.1 bind 만 (외부 인터페이스 X). Cross-site request
/// 차단 = `Origin`/`Referer` 검증 없음 (브라우저가 GET / 발신, 어차피 CORS X).
/// 검증은 `state` CSRF token (process_deep_link_url 내부) 으로 한다.
pub(crate) fn spawn_oauth_callback_server(
    app_handle: AppHandle,
    oauth_state: Arc<Mutex<Option<String>>>,
) -> Result<(), String> {
    use tiny_http::{Header, Response, Server};

    let bind_addr = format!("127.0.0.1:{}", OAUTH_CALLBACK_PORT);
    let server = Server::http(&bind_addr).map_err(|e| {
        format!(
            "[Naia] OAuth callback server bind failed ({}): {}",
            bind_addr, e
        )
    })?;

    log_both(&format!(
        "[Naia] OAuth callback server listening on http://{}{}",
        bind_addr, OAUTH_CALLBACK_PATH
    ));

    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            // Only accept GET on the dedicated path. Any other URL → 404.
            let raw_url = request.url().to_string();
            if !raw_url.starts_with(OAUTH_CALLBACK_PATH) {
                let _ = request.respond(Response::from_string("Not Found").with_status_code(404));
                continue;
            }

            // Reuse `process_deep_link_url` so the parameter parsing, state CSRF
            // verification, and event emit stay identical to the deep-link path.
            // The function only inspects scheme-agnostic parts (path + query).
            let url_str = format!(
                "http://127.0.0.1:{}{}",
                OAUTH_CALLBACK_PORT, raw_url
            );
            process_deep_link_url(&url_str, &app_handle, Some(&oauth_state), "http_callback");

            // Send a small HTML page that closes the tab and informs the user.
            // The browser stays on this page until the user closes it manually.
            let body = r#"<!doctype html><html><head><meta charset="utf-8"><title>naia 로그인 완료</title><style>body{font-family:system-ui;background:#0f1117;color:#e5e7eb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#1a1d27;border:1px solid #2c303a;padding:32px 40px;border-radius:12px;text-align:center;max-width:420px}h1{margin:0 0 12px;font-size:20px;font-weight:600}p{margin:0;color:#9ca3af;line-height:1.6}</style></head><body><div class="card"><h1>naia 로그인 완료</h1><p>이 창은 닫아도 됩니다. naia 앱으로 돌아가주세요.</p></div><script>setTimeout(()=>window.close(),1500)</script></body></html>"#;
            let response = Response::from_string(body).with_header(
                Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..])
                    .expect("valid header"),
            );
            let _ = request.respond(response);
        }
    });

    Ok(())
}

#[cfg(target_os = "linux")]
use webkit2gtk::glib::object::ObjectExt;
#[cfg(target_os = "linux")]
use webkit2gtk::PermissionRequestExt;

// agent-core process handle — 정본 transport=gRPC. child=프로세스 lifecycle, tx=메시지를 dispatcher task(gRPC 클라 소유)로.
struct AgentProcess {
    child: Child,
    tx: tokio::sync::mpsc::UnboundedSender<String>,
    /// agent-core gRPC listening addr — 결과 반환형 unary 커맨드(예: compile_knowledge)가 별도 클라로 connect.
    grpc_addr: String,
}

// ⚠️ Rust 는 Child drop 시 프로세스를 죽이지 않음 → restart 로 *guard 교체 시 옛 agent 가 orphan(gRPC 서버 잔류).
// Drop 에서 명시 kill 로 orphan 방지(codex 리뷰 #1). 종료/replace 양쪽 커버.
impl Drop for AgentProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

// Naia Gateway + Node Host process handle
struct GatewayProcess {
    child: Child,
    node_host: Option<Child>,
    we_spawned: bool, // only kill on shutdown if we spawned it
}

// YouTube BGM sidecar HTTP server (port 18791) — #335
// Standalone Node process spawned because the standalone naia-agent submodule
// (preferred over embedded agent/src/index.ts in spawn_agent_core lines 912-928)
// does not contain startYoutubeServer(), so port 18791 was never bound.
struct BgmServerProcess {
    child: Child,
}

struct AppState {
    agent: Mutex<Option<AgentProcess>>,
    bgm_server: Mutex<Option<BgmServerProcess>>,
    gateway: Mutex<Option<GatewayProcess>>,
    health_monitor_shutdown: Mutex<Option<Arc<std::sync::atomic::AtomicBool>>>,
    /// Random state token for OAuth deep link CSRF protection.
    oauth_state: Arc<Mutex<Option<String>>>,
    /// Active Gemini Live WebSocket proxy session.
    gemini_live: gemini_live::SharedHandle,
    /// Last agent-core restart timestamp — debounce to prevent restart storms (#226).
    last_agent_restart: Mutex<Option<std::time::Instant>>,
    /// Startup IPC messages (auth_update / notify_config / creds_update) — replayed
    /// to agent-core after every restart so credentials are never permanently lost.
    /// Deduplicated by type: latest message of each type wins.
    startup_messages: Mutex<Vec<String>>,
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
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
struct WindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Copy)]
struct WindowBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn monitor_bounds(monitor: &tauri::Monitor) -> WindowBounds {
    let work_area = monitor.work_area();
    WindowBounds {
        x: work_area.position.x,
        y: work_area.position.y,
        width: work_area.size.width,
        height: work_area.size.height,
    }
}

fn clamp_window_state_to_bounds(state: WindowState, bounds: WindowBounds) -> WindowState {
    let max_width = bounds.width.max(1);
    let max_height = bounds.height.max(1);
    let width = state.width.clamp(1, max_width);
    let height = state.height.clamp(1, max_height);

    let max_x = bounds
        .x
        .saturating_add(max_width.saturating_sub(width) as i32);
    let max_y = bounds
        .y
        .saturating_add(max_height.saturating_sub(height) as i32);

    WindowState {
        x: state.x.clamp(bounds.x, max_x.max(bounds.x)),
        y: state.y.clamp(bounds.y, max_y.max(bounds.y)),
        width,
        height,
    }
}

fn centered_window_state(size: PhysicalSize<u32>, bounds: WindowBounds) -> WindowState {
    let max_width = bounds.width.max(1);
    let max_height = bounds.height.max(1);
    let width = size.width.clamp(1, max_width);
    let height = size.height.clamp(1, max_height);
    let x = bounds
        .x
        .saturating_add((max_width.saturating_sub(width) / 2) as i32);
    let y = bounds
        .y
        .saturating_add((max_height.saturating_sub(height) / 2) as i32);
    WindowState {
        x,
        y,
        width,
        height,
    }
}

fn monitor_for_window_state(
    app_handle: &AppHandle,
    window: &tauri::WebviewWindow,
    state: &WindowState,
) -> Option<tauri::Monitor> {
    let center_x = state.x as f64 + state.width as f64 / 2.0;
    let center_y = state.y as f64 + state.height as f64 / 2.0;
    app_handle
        .monitor_from_point(center_x, center_y)
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten())
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
                    let normalized = dunce::canonicalize(&bundled).unwrap_or(bundled);
                    return normalized.to_string_lossy().to_string();
                }
            }
        }
        find_node_binary()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "node".to_string())
    });

    // In dev: tsx for TypeScript direct execution; in prod: compiled JS from bundle
    let agent_script = std::env::var("NAIA_AGENT_SCRIPT").unwrap_or_else(|_| {
        // ── Standalone naia-agent detection ──────────────────────────────────
        // Condition A: NAIA_AGENT_STANDALONE=1 env var (explicit opt-in)
        // Condition B: resources/agent-standalone/dist/index.js present (auto)
        //
        // Deployment path:
        //   build naia-agent → copy dist/ to Tauri external-bin or resources/
        //   agent-standalone/ alongside the embedded agent/dist/.
        //   Both share the same node binary and --stdio IPC protocol.
        //
        // No ping/pong: spawn is the handshake — process exits non-zero on fatal
        // init failure, which restart_agent() catches as process death.
        let standalone_requested =
            std::env::var("NAIA_AGENT_STANDALONE").map(|v| v == "1").unwrap_or(false);

        // 1. Explicit path override — activates regardless of NAIA_AGENT_STANDALONE=1.
        //    NAIA_AGENT_STANDALONE_PATH alone is sufficient; setting it without the
        //    flag is intentional (e.g. ad-hoc testing of a custom build).
        if let Ok(sa_path) = std::env::var("NAIA_AGENT_STANDALONE_PATH") {
            let p = std::path::PathBuf::from(&sa_path);
            if p.exists() {
                log_both(&format!(
                    "[Naia] Standalone agent (NAIA_AGENT_STANDALONE_PATH): {}",
                    p.display()
                ));
                return dunce::canonicalize(&p).unwrap_or(p).to_string_lossy().to_string();
            }
        }

        // 2. Bundled standalone in resource dir — auto-activates when present,
        //    regardless of NAIA_AGENT_STANDALONE=1. Bundling agent-standalone/ into
        //    Tauri resources IS the explicit deployment opt-in; the env flag is not
        //    required. If this fires unexpectedly, check for stale build artifacts
        //    in resources/agent-standalone/.
        if let Ok(resource_dir) = app_handle.path().resource_dir() {
            let sa_bundled = resource_dir
                .join("agent-standalone")
                .join("dist")
                .join("index.js");
            if sa_bundled.exists() {
                let normalized = dunce::canonicalize(&sa_bundled).unwrap_or(sa_bundled);
                log_both(&format!(
                    "[Naia] Standalone agent (bundled, auto-activated): {} \
                     — to force embedded agent, remove resources/agent-standalone/",
                    normalized.display()
                ));
                return normalized.to_string_lossy().to_string();
            }
        }

        // 3. Dev TypeScript source — requires NAIA_AGENT_STANDALONE=1. Avoids
        //    accidentally switching to standalone in production without the bundle.
        if standalone_requested {
            let sa_dev_candidates = [
                "../../../naia-agent/bin/naia-agent.ts", // from src-tauri/
                "../../naia-agent/bin/naia-agent.ts",    // from shell/
            ];
            for rel in &sa_dev_candidates {
                let dev_path = std::env::current_dir()
                    .map(|d| d.join(rel))
                    .unwrap_or_default();
                if dev_path.exists() {
                    let normalized = dunce::canonicalize(&dev_path).unwrap_or(dev_path);
                    log_both(&format!(
                        "[Naia] Standalone agent (dev): {}",
                        normalized.display()
                    ));
                    return normalized.to_string_lossy().to_string();
                }
            }
            log_both(
                "[Naia] NAIA_AGENT_STANDALONE=1 set but no standalone agent found \
                 — falling back to embedded agent",
            );
        }
        // ─────────────────────────────────────────────────────────────────────

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

        // Production: bundled agent via Tauri resources.
        // 실 엔트리 = agent/scripts/builds/agent-stdio-entry.mjs (dev 와 동일 진입점 — gRPC 서버를 띄우고
        // stdout 으로 GRPC_LISTENING 핸드셰이크를 보낸다). 엔트리는 ../../dist/main/** + node_modules 를 쓴다.
        // (구 레이아웃의 agent/dist/index.js 는 레거시 폴백으로만 유지 — 현 agent tsc 는 dist/main/... 를 출력.)
        if let Ok(resource_dir) = app_handle.path().resource_dir() {
            for rel in [
                "agent/scripts/builds/agent-stdio-entry.mjs",
                "agent/dist/index.js",
            ] {
                let bundled = resource_dir.join(rel);
                if bundled.exists() {
                    // dunce::canonicalize strips the \\?\ extended-length prefix that
                    // Tauri's resource_dir() produces on Windows — Node.js rejects \\?\ paths.
                    let normalized = dunce::canonicalize(&bundled).unwrap_or(bundled);
                    log_verbose(&format!(
                        "[Naia] Found bundled agent at: {}",
                        normalized.display()
                    ));
                    return normalized.to_string_lossy().to_string();
                }
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
    // Redirect agent stderr to a log file so crashes are visible in GUI mode
    // (without this, stderr goes to the console which doesn't exist in a windowed app)
    let stderr_stdio = {
        let log_path = log_dir().join("agent-stderr.log");
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .ok()
            .map(Stdio::from)
            .unwrap_or_else(Stdio::inherit)
    };
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(stderr_stdio);

    // Pass naia-settings directory to the agent via env var so it can resolve
    // all user-data paths (sessions, memory, identity) without reading files
    // at runtime. Read from ~/.naia/adk-path written by write_naia_path_cache.
    if let Some(home) = dirs::home_dir() {
        let adk_path_file = home.join(".naia").join("adk-path");
        if let Ok(adk_path_str) = std::fs::read_to_string(&adk_path_file) {
            let adk_path_str = adk_path_str.trim();
            if !adk_path_str.is_empty() {
                let settings_dir = std::path::PathBuf::from(adk_path_str)
                    .join("naia-settings");
                cmd.env("NAIA_SETTINGS_DIR", settings_dir.to_string_lossy().as_ref());
                cmd.env("NAIA_ADK_PATH", adk_path_str);
                log_verbose(&format!(
                    "[Naia] agent NAIA_ADK_PATH={} NAIA_SETTINGS_DIR={}",
                    adk_path_str,
                    settings_dir.display()
                ));
            }
        }
    }

    #[cfg(windows)]
    platform::hide_console(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn agent-core: {}", e))?;

    // gRPC: stdin 은 데이터 채널 아님(child 가 보유, 미사용). stdout = GRPC_LISTENING 핸드셰이크 + 로그.
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to get agent stdout".to_string())?;

    // ── gRPC(정본 transport): stdout 의 `GRPC_LISTENING <addr>` 핸드셰이크 1줄만 읽고 나머지는 로그 ──
    // 데이터(요청/응답)는 gRPC. agent_response 이벤트는 dispatcher 의 Chat stream task 가 재구성해 emit.
    let (addr_tx, addr_rx) = std::sync::mpsc::channel::<String>();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut sent = false;
        for line in reader.lines().map_while(Result::ok) {
            if !sent {
                if let Some(rest) = line.strip_prefix("GRPC_LISTENING ") {
                    let _ = addr_tx.send(rest.trim().to_string());
                    sent = true;
                    continue;
                }
            }
            log_verbose(&format!("[agent] {}", line));
        }
        log_verbose("[Naia] agent-core stdout reader ended");
    });

    // gRPC listening addr 수신(timeout) — 기동 핸드셰이크. 실패 = 기동 실패.
    let addr = addr_rx
        .recv_timeout(std::time::Duration::from_secs(20))
        .map_err(|_| "agent gRPC addr handshake timeout".to_string())?;
    log_both(&format!("[Naia] agent-core gRPC @{}", addr));

    // adk_path (SetWorkspace 용) — env(NAIA_ADK_PATH) 와 동일 출처(~/.naia/adk-path).
    let adk_path = dirs::home_dir()
        .and_then(|h| std::fs::read_to_string(h.join(".naia").join("adk-path")).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    // 메시지 채널: send_to_agent(sync) → dispatcher task(async, gRPC 클라 소유). nested runtime 회피.
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    tauri::async_runtime::spawn(agent_dispatcher(
        addr.clone(),
        adk_path,
        rx,
        app_handle.clone(),
        audit_db.clone(),
    ));

    Ok(AgentProcess { child, tx, grpc_addr: addr })
}

/// gRPC dispatcher — connect → SetWorkspace(naia-adk 로딩) → 메시지 루프.
/// chat=Chat stream task(AgentEvent→UI JSON emit + audit + memory backup dispatch, 구 stdout reader 대체),
/// creds/cancel/approval=unary. send_to_agent(sync) 가 mpsc 로 메시지를 흘린다.
async fn agent_dispatcher(
    addr: String,
    adk_path: String,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<String>,
    app: AppHandle,
    audit_db: audit::AuditDb,
) {
    let mut client = match agent_grpc::AgentGrpc::connect(format!("http://{}", addr)).await {
        Ok(c) => c,
        Err(e) => {
            log_both(&format!("[Naia] agent gRPC connect 실패: {}", e));
            return;
        }
    };
    match client.set_workspace(adk_path.clone()).await {
        Ok(r) => log_both(&format!("[Naia] SetWorkspace → loaded={} {}/{}", r.loaded, r.provider, r.model)),
        Err(e) => log_both(&format!("[Naia] SetWorkspace 실패: {}", e)),
    }
    while let Some(msg) = rx.recv().await {
        let v: serde_json::Value = match serde_json::from_str(&msg) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match v.get("type").and_then(|x| x.as_str()).unwrap_or("") {
            "chat_request" => {
                let req = agent_grpc::json_to_chat_request(&v);
                let request_id = v.get("requestId").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let mut c = client.clone();
                let app2 = app.clone();
                let app_err = app.clone(); // emit closure 가 app2 를 move → 에러 경로용 별도 clone
                let db2 = audit_db.clone();
                tauri::async_runtime::spawn(async move {
                    let emit = move |json: String| {
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&json) {
                            audit::maybe_log_event(&db2, &parsed);
                            if memory::dispatch_backup_response(&parsed) {
                                return;
                            }
                        }
                        let _ = app2.emit("agent_response", &json);
                    };
                    if let Err(e) = c.chat(req, emit).await {
                        let err = serde_json::json!({"type":"error","requestId":request_id,"message":format!("grpc chat: {}", e)}).to_string();
                        let _ = app_err.emit("agent_response", &err);
                    }
                });
            }
            "creds_update" => {
                let provider = v.get("provider").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let api_key = v.get("apiKey").and_then(|x| x.as_str()).map(|s| s.to_string());
                let naia_key = v.get("naiaKey").and_then(|x| x.as_str()).map(|s| s.to_string());
                let _ = client.update_creds(provider, api_key, naia_key).await;
            }
            "cancel_stream" => {
                let rid = v.get("requestId").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let _ = client.cancel(rid).await;
            }
            "approval_response" => {
                let approve = v.get("decision").and_then(|x| x.as_str()) == Some("approve");
                let rid = v.get("requestId").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let tcid = v.get("toolCallId").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let _ = client.approval_response(rid, tcid, approve).await;
            }
            "reload_settings" | "set_workspace" => {
                // 사용자가 naia-os 설정에서 모델/프로바이더 교체 → writeNaiaConfig(config.json 기록) 직후 트리거.
                // 에이전트가 naia-settings 재로딩 후 활성 config 를 swap(정본 R1-2: "startup-only 금지", 멱등).
                // 재기동 없이 모델 전환이 실제 반영되게 하는 결선(=사용자 "모델 안 바뀜" 회귀 차단).
                match client.set_workspace(adk_path.clone()).await {
                    Ok(r) => log_both(&format!("[Naia] ReloadSettings → loaded={} {}/{}", r.loaded, r.provider, r.model)),
                    Err(e) => log_verbose(&format!("[Naia] ReloadSettings 실패: {}", e)),
                }
            }
            "tool_request" => {
                // 셸 directToolCall(기동 시 skill_voicewake/skill_config/skill_sessions 등) — new-core 미지원이나
                // 반드시 즉시 error 응답해야 셸이 120s 행에 빠지지 않는다(드롭 금지, 구 stdio 동작 복원).
                let rid = v.get("requestId").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let rid_err = rid.clone();
                let tool = v.get("toolName").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let mut c = client.clone();
                let app2 = app.clone();
                let app_err = app.clone();
                let db2 = audit_db.clone();
                tauri::async_runtime::spawn(async move {
                    let emit = move |json: String| {
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&json) {
                            audit::maybe_log_event(&db2, &parsed);
                            if memory::dispatch_backup_response(&parsed) {
                                return;
                            }
                        }
                        let _ = app2.emit("agent_response", &json);
                    };
                    // transport 에러 시 즉시 error 응답 — 안 그러면 셸 directToolCall 이 타임아웃까지 행(codex #5).
                    if let Err(e) = c.tool_request(rid_err.clone(), tool, emit).await {
                        let err = serde_json::json!({"type":"error","requestId":rid_err,"message":format!("grpc tool_request: {}", e)}).to_string();
                        let _ = app_err.emit("agent_response", &err);
                    }
                });
            }
            // ── UC-PANEL FR-PANEL: 환경 panel skill(BGM·브라우저·workspace) 셸→agent 배선(현 `_=>{}` drop 제거) ──
            "panel_skills" => {
                // FR-PANEL-1 등록: wire tools → pb::ToolSpec(parameters→JSON 문자열, tier→Option<i32>).
                let panel_id = v.get("panelId").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let tools: Vec<agent_grpc::pb::ToolSpec> = v.get("tools").and_then(|t| t.as_array()).map(|arr| {
                    arr.iter().map(|t| agent_grpc::pb::ToolSpec {
                        name: t.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                        description: t.get("description").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                        parameters_json: t.get("parameters").map(|p| p.to_string()).unwrap_or_else(|| "{}".to_string()),
                        tier: t.get("tier").and_then(|x| x.as_i64()).map(|n| n as i32),
                    }).collect()
                }).unwrap_or_default();
                let mut c = client.clone();
                tauri::async_runtime::spawn(async move { let _ = c.register_panel_skills(panel_id, tools).await; });
            }
            "panel_skills_clear" => {
                let panel_id = v.get("panelId").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let mut c = client.clone();
                tauri::async_runtime::spawn(async move { let _ = c.clear_panel_skills(panel_id).await; });
            }
            "skill_list" => {
                // ListSkills → skill_list_response(셸 fetchAgentSkills 기대 형태). parameters_json → parameters 파싱.
                let rid = v.get("requestId").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let mut c = client.clone();
                let app2 = app.clone();
                tauri::async_runtime::spawn(async move {
                    match c.list_skills().await {
                        Ok(list) => {
                            let tools: Vec<serde_json::Value> = list.tools.iter().map(|t| serde_json::json!({
                                "name": t.name, "description": t.description,
                                "parameters": serde_json::from_str::<serde_json::Value>(&t.parameters_json).unwrap_or_else(|_| serde_json::json!({})),
                            })).collect();
                            let _ = app2.emit("agent_response", &serde_json::json!({"type":"skill_list_response","requestId":rid,"tools":tools}).to_string());
                        }
                        Err(e) => { let _ = app2.emit("agent_response", &serde_json::json!({"type":"error","requestId":rid,"message":format!("grpc list_skills: {}", e)}).to_string()); }
                    }
                });
            }
            "panel_tool_result" => {
                // FR-PANEL-3 결과 주입: 셸 panel 실행 결과 → agent chat 루프 pending resolve.
                let rid = v.get("requestId").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let tcid = v.get("toolCallId").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let output = v.get("result").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let success = v.get("success").and_then(|x| x.as_bool()).unwrap_or(false);
                let mut c = client.clone();
                tauri::async_runtime::spawn(async move { let _ = c.panel_tool_result(rid, tcid, output, success).await; });
            }
            "panel_install" => {
                // M1: 패널 설치는 이번 UC-PANEL 스코프 밖(proto RPC 미정의) — PanelInstallDialog 무한 로딩 방지 위해
                //   즉시 미지원 응답(셸 dialog 는 독립 raw listener 라 router 우회 직접 수신). 기능화는 별도 이슈.
                let _ = app.emit("agent_response", &serde_json::json!({"type":"panel_install_result","success":false,"error":"패널 설치는 현재 미지원(new-core 스코프 밖)"}).to_string());
            }
            _ => {}
        }
    }
    log_verbose("[Naia] agent dispatcher ended");
}

/// Spawn the standalone YouTube BGM HTTP server (port 18791) — #335.
///
/// Mirrors `spawn_agent_core`'s tsx-direct resolution pattern (node + tsx
/// cli.mjs from the agent's node_modules, npx fallback). Required because
/// when the standalone naia-agent submodule is preferred (lib.rs:912-928),
/// embedded `agent/src/index.ts::startYoutubeServer()` never runs.
///
/// Safety guarantees mirrored from `spawn_agent_core`:
///  - stderr → ~/.naia/logs/bgm-server-stderr.log (crashes visible in GUI mode)
///  - hide_console on Windows (no console flash in release builds)
///  - kill() called on Tauri WindowEvent::Destroyed (no orphan process)
fn spawn_youtube_bgm_server(app_handle: &AppHandle) -> Result<BgmServerProcess, String> {
    // Node binary — same resolution chain as spawn_agent_core
    let node_path = std::env::var("NAIA_BGM_NODE_PATH").unwrap_or_else(|_| {
        #[cfg(windows)]
        {
            if let Ok(res_dir) = app_handle.path().resource_dir() {
                let bundled = res_dir.join("node.exe");
                if bundled.exists() {
                    let normalized = dunce::canonicalize(&bundled).unwrap_or(bundled);
                    return normalized.to_string_lossy().to_string();
                }
            }
        }
        find_node_binary()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "node".to_string())
    });

    // BGM entry script — 환경 사이드카 `@naia/bgm-sidecar` (packages/bgm-sidecar).
    // 환경(environment) 레이어 표준(docs/brain-body-environment.md): youtube 추출 서버는 셸(substrate)이
    // 소유하는 독립 사이드카다. 과거엔 구 monorepo 의 naia-os/agent/src/ 에 있었으나(=#335 split 누락 원인),
    // 셸 워크스페이스 패키지로 이전. 빌드 산출물(dist/*.js) = plain node(tsx 불요). legacy agent 경로는 fallback.
    let script_path = std::env::var("NAIA_BGM_SCRIPT").unwrap_or_else(|_| {
        let is_flatpak = std::env::var("FLATPAK").map(|v| v == "1").unwrap_or(false);

        // Dev: prefer source tree
        if !is_flatpak {
            let candidates = [
                "../../bgm-sidecar/dist/bgm-server-bin.js", // shell sidecar (from src-tauri/) — 환경 표준
                "../bgm-sidecar/dist/bgm-server-bin.js",    // shell sidecar (from shell/)
                "../../agent/src/bgm-server-bin.ts",        // legacy embedded agent (from src-tauri/)
                "../agent/src/bgm-server-bin.ts",           // legacy (from shell/)
            ];
            for rel in &candidates {
                let dev_path = std::env::current_dir()
                    .map(|d| d.join(rel))
                    .unwrap_or_default();
                if dev_path.exists() {
                    let normalized = dunce::canonicalize(&dev_path).unwrap_or(dev_path);
                    log_verbose(&format!(
                        "[Naia] Found dev BGM server at: {}",
                        normalized.display()
                    ));
                    return normalized.to_string_lossy().to_string();
                }
            }
        }

        // Prod: bundled via Tauri resources (esbuild output, if added later)
        if let Ok(resource_dir) = app_handle.path().resource_dir() {
            let bundled = resource_dir
                .join("agent")
                .join("dist")
                .join("bgm-server-bin.js");
            if bundled.exists() {
                let normalized = dunce::canonicalize(&bundled).unwrap_or(bundled);
                return normalized.to_string_lossy().to_string();
            }
        }

        // Flatpak fallback
        let flatpak_path =
            std::path::PathBuf::from("/app/lib/naia-os/agent/dist/bgm-server-bin.js");
        if flatpak_path.exists() {
            return flatpak_path.to_string_lossy().to_string();
        }

        // Last-resort relative
        "../agent/src/bgm-server-bin.ts".to_string()
    });

    let use_tsx = script_path.ends_with(".ts");

    // tsx-direct resolution (same pattern as spawn_agent_core lines 1018-1024)
    let agent_dir = std::path::Path::new(&script_path)
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
        c.arg(&tsx_cli).arg(&script_path);
        (format!("{} {}", node_bin, tsx_cli), c)
    } else if use_tsx {
        let npx = std::env::var("NAIA_AGENT_RUNNER").unwrap_or_else(|_| platform::resolve_npx());
        let mut c = Command::new(&npx);
        c.arg("tsx").arg(&script_path);
        (npx, c)
    } else {
        let mut c = Command::new(&node_path);
        c.arg(&script_path);
        (node_path.clone(), c)
    };

    log_verbose(&format!(
        "[Naia] Starting BGM server (#335): {} {}",
        runner, script_path
    ));

    // stderr → log file (same pattern as spawn_agent_core lines 1047-1056)
    let stderr_stdio = {
        let log_path = log_dir().join("bgm-server-stderr.log");
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .ok()
            .map(Stdio::from)
            .unwrap_or_else(Stdio::inherit)
    };
    // stdin null (no IPC), stdout inherited (status line on launch),
    // stderr to log file (crash visibility).
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(stderr_stdio);

    #[cfg(windows)]
    platform::hide_console(&mut cmd);

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn BGM server: {}", e))?;

    let pid = child.id();
    log_both(&format!(
        "[Naia] BGM server spawned (pid={}, port=18791)",
        pid
    ));

    // Persist PID so the next session's cleanup_orphan_processes() can kill an
    // orphan if Tauri crashes before WindowEvent::Destroyed fires (#335 codex
    // review finding 1). The on-exit handler calls remove_pid_file("bgm-server").
    write_pid_file("bgm-server", pid);

    // Readiness probe — poll /health for up to 3s (#335 codex review finding
    // 2). Catches EADDRINUSE and other startup failures that the spawn handle
    // can't see (server.on("error") in youtube-server.ts logs but doesn't exit).
    // Non-fatal: BGM is optional; we only log a warning on timeout so users
    // see a recovery hint in ~/.naia/logs/naia.log.
    if !probe_bgm_server_ready(std::time::Duration::from_secs(3)) {
        log_both(
            "[Naia] WARN BGM server did not respond on http://127.0.0.1:18791/health within 3s",
        );
        log_both(
            "[Naia] WARN BGM player may show connection-refused; restart the app or kill any stray Node process bound to 18791",
        );
    }

    Ok(BgmServerProcess { child })
}

/// Poll `http://127.0.0.1:18791/health` every 100 ms for up to `timeout`.
/// Returns `true` as soon as a 2xx response arrives; `false` on timeout.
/// Used by `spawn_youtube_bgm_server` to detect EADDRINUSE / startup failure.
fn probe_bgm_server_ready(timeout: std::time::Duration) -> bool {
    let url = "http://127.0.0.1:18791/health";
    let deadline = std::time::Instant::now() + timeout;
    let interval = std::time::Duration::from_millis(100);
    loop {
        // Short per-request timeout so a stalled probe doesn't burn the budget.
        let agent = ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_millis(200))
            .build();
        if let Ok(resp) = agent.get(url).call() {
            if resp.status() >= 200 && resp.status() < 300 {
                return true;
            }
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(interval);
    }
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

        // gRPC: 메시지를 dispatcher task 로 전달(비차단 mpsc). send 실패 = dispatcher/agent 종료 → restart.
        match process.tx.send(message.to_string()) {
            Ok(_) => Ok(()),
            Err(e) => {
                log_both(&format!("[Naia] agent tx send 실패: {}", e));
                *guard = None;
                drop(guard);
                if let Some(handle) = app_handle {
                    restart_agent(state, handle, message, audit_db)
                } else {
                    Err(format!("Send failed: {}", e))
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
            // Replay cached startup credentials so agent recovers auth state after crash.
            replay_startup_messages_to_agent(state);
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

/// Replay all cached startup messages to agent-core stdin.
/// Call after spawn + startup delay so Node.js readline is ready.
fn replay_startup_messages_to_agent(state: &AppState) {
    let messages = {
        let guard = state.startup_messages.lock().unwrap();
        if guard.is_empty() {
            return;
        }
        guard.clone()
    };
    let agent_guard = lock_or_recover(&state.agent, "state.agent(replay_startup)");
    if let Some(ref process) = *agent_guard {
        for msg in &messages {
            if let Err(e) = process.tx.send(msg.clone()) {
                log_both(&format!("[Naia] startup message replay failed: {}", e));
                break;
            }
        }
        log_verbose(&format!(
            "[Naia] replayed {} startup message(s) to agent-core",
            messages.len()
        ));
    }
}

/// Cache a startup IPC message (auth_update / notify_config / creds_update) so it is
/// replayed to agent-core after every restart — ensuring credentials are never lost on crash.
/// Deduplicates by message type: a newer message of the same type replaces the previous one.
#[tauri::command]
async fn store_startup_message(
    message: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    const CACHEABLE: &[&str] = &["auth_update", "notify_config", "creds_update"];
    let parsed: serde_json::Value = serde_json::from_str(&message)
        .map_err(|_| "store_startup_message: invalid JSON".to_string())?;
    let msg_type = parsed
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "store_startup_message: missing 'type' field".to_string())?;
    if !CACHEABLE.contains(&msg_type) {
        return Err(format!(
            "store_startup_message: type '{}' is not cacheable",
            msg_type
        ));
    }
    let msg_type = msg_type.to_string();
    let mut guard = state.startup_messages.lock().unwrap();
    // Deduplicate: replace any existing entry of the same type
    guard.retain(|existing| {
        serde_json::from_str::<serde_json::Value>(existing)
            .ok()
            .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(|t| t.to_string()))
            .map(|t| t != msg_type)
            .unwrap_or(true)
    });
    guard.push(message);
    Ok(())
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

/// Detect the primary GPU's total VRAM in GB via `nvidia-smi` (NVIDIA only).
///
/// Returns a whole-GB number (marketed VRAM is whole GB; nvidia-smi reports
/// MiB, e.g. an RTX 4070 12 GB = ~12282 MiB ≈ 11.99 GiB → rounds to 12) or null
/// when nvidia-smi is absent / non-NVIDIA / unparseable — the settings UI then
/// falls back to manual tier selection (#2 / FR-VRAM.1).
///
/// NOTE: this reports *capacity only*. Real-time (RTF<1) on a given GPU is a
/// measured gate (windows-manager F1) and is NOT inferred here.
#[tauri::command]
async fn detect_gpu_vram() -> Result<serde_json::Value, String> {
    let output = tokio::task::spawn_blocking(|| {
        std::process::Command::new("nvidia-smi")
            .args(["--query-gpu=memory.total", "--format=csv,noheader,nounits"])
            .output()
    })
    .await
    .map_err(|e| format!("task error: {e}"))?;

    // Absent nvidia-smi / non-NVIDIA host → null (not an error).
    let output = match output {
        Ok(o) if o.status.success() => o,
        _ => return Ok(serde_json::Value::Null),
    };

    let text = String::from_utf8_lossy(&output.stdout);
    // First line = primary GPU's total memory in MiB.
    let mib = text.lines().next().and_then(|l| l.trim().parse::<f64>().ok());

    Ok(match mib {
        Some(m) if m > 0.0 => serde_json::json!((m / 1024.0).round()),
        _ => serde_json::Value::Null,
    })
}

/// Check if Naia Gateway is reachable on localhost
/// Re-enable Korean/CJK IME for the WebView2 child HWND.
/// Called from the frontend when a text input gains focus so the 한/영 toggle
/// works even if the initial startup call was too early.
#[tauri::command]
async fn enable_webview2_ime(_window: tauri::Window) -> Result<(), String> {
    #[cfg(windows)]
    {
        use raw_window_handle::HasWindowHandle;
        if let Ok(handle) = _window.window_handle() {
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
async fn gateway_health(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    // After #201: OpenClaw gateway removed. Report naia-agent process liveness instead.
    let mut guard = state
        .agent
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;
    if let Some(ref mut process) = *guard {
        match process.child.try_wait() {
            Ok(None) => Ok(true),     // still running
            Ok(Some(_)) => Ok(false), // exited
            Err(_) => Ok(false),
        }
    } else {
        Ok(false)
    }
}

/// Returns the path to the Naia log file (~/.naia/logs/naia.log).
#[tauri::command]
fn get_gateway_log_path() -> String {
    log_dir().join("naia.log").to_string_lossy().into_owned()
}

/// Returns the log directory path (~/.naia/logs/).
#[tauri::command]
fn get_log_dir() -> String {
    log_dir().to_string_lossy().into_owned()
}

/// Open a log file in an editor: Notepad on Windows, xdg-open/open on Linux/macOS.
#[tauri::command]
fn open_log_in_editor(path: String) -> Result<(), String> {
    #[cfg(windows)]
    let result = std::process::Command::new("notepad.exe").arg(&path).spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&path).spawn();
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open").arg(&path).spawn();
    result.map(|_| ()).map_err(|e| format!("Failed to open log file: {}", e))
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


/// Read Discord bot token.
/// Priority: Shell local config (naia-discord.json) → Gateway config (openclaw.json).
/// This separates the primary path from Gateway dependency (#154).
#[tauri::command]
async fn read_discord_bot_token() -> Result<String, String> {
    let home = home_dir();

    // 1. Shell local config (primary — no Gateway dependency)
    let shell_candidates = {
        let candidates = vec![
            format!("{}/.local/share/com.naia.shell/naia-discord.json", home),
            format!(
                "{}/.var/app/io.nextain.naia/config/com.naia.shell/naia-discord.json",
                home
            ),
        ];
        #[cfg(windows)]
        {
            let mut candidates = candidates;
            candidates.push(format!(
                "{}\\AppData\\Roaming\\com.naia.shell\\naia-discord.json",
                home
            ));
            candidates
        }
        #[cfg(not(windows))]
        {
            candidates
        }
    };
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
    const ALLOWED: &[&str] = &["vrm-files", "background", "bgm-musics", "nva-files"];
    if !ALLOWED.contains(&subdir.as_str()) {
        return Err(format!("Invalid subdir: {subdir}"));
    }
    let dir = std::path::PathBuf::from(&adk_path)
        .join("naia-settings")
        .join(&subdir);
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    // nva-files: list directories (.nva bundles); others: list files.
    let want_dir = subdir == "nva-files";
    let mut entries = vec![];
    if let Ok(dir_entries) = std::fs::read_dir(&dir) {
        for entry in dir_entries.flatten() {
            if entry.path().is_dir() == want_dir {
                if let Some(name) = entry.file_name().to_str() {
                    entries.push(name.to_string());
                }
            }
        }
    }
    entries.sort();
    Ok(entries)
}

/// Resolve a unique destination path inside `dir`. If `name.ext` exists,
/// appends `_1`, `_2`, etc.
fn unique_dest(dir: &std::path::Path, name: &str, ext: &str) -> std::path::PathBuf {
    // `name` already includes the extension for files (e.g. "foo.vrm");
    // ext is only used for building the counter-suffixed fallback name.
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let stem = if ext.is_empty() {
        name.to_string()
    } else {
        name.trim_end_matches(format!(".{ext}").as_str())
            .to_string()
    };
    let mut i = 1;
    loop {
        let c = if ext.is_empty() {
            dir.join(format!("{stem}_{i}"))
        } else {
            dir.join(format!("{stem}_{i}.{ext}"))
        };
        if !c.exists() {
            return c;
        }
        i += 1;
    }
}

/// Recursively copy a directory tree.
fn copy_dir_recursive(src: &std::path::Path, dest: &std::path::Path) -> Result<String, String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    if let Ok(entries) = std::fs::read_dir(src) {
        for entry in entries.flatten() {
            let src_path = entry.path();
            let dest_path = dest.join(entry.file_name());
            // Skip symlinks to prevent infinite loops / escaping the copy root.
            if src_path.is_symlink() {
                continue;
            }
            if src_path.is_dir() {
                copy_dir_recursive(&src_path, &dest_path)?;
            } else {
                std::fs::copy(&src_path, &dest_path).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(dest
        .to_str()
        .ok_or_else(|| "Invalid destination path".to_string())?
        .to_string())
}

/// Copy a file into `{adk_path}/naia-settings/{subdir}/`. Used by the avatar /
/// background file-import UI (#12). Only whitelisted subdirs + file extensions.
#[tauri::command]
async fn import_naia_asset(
    adk_path: String,
    subdir: String,
    source_path: String,
) -> Result<String, String> {
    const ALLOWED: &[&str] = &["vrm-files", "background", "bgm-musics", "nva-files"];
    if !ALLOWED.contains(&subdir.as_str()) {
        return Err(format!("Invalid subdir: {subdir}"));
    }
    let src = std::path::PathBuf::from(&source_path);

    // nva-files: directory copy (.nva bundle = directory with manifest.json + clips/)
    if subdir == "nva-files" {
        if !src.is_dir() {
            return Err("Source must be a directory for nva-files".to_string());
        }
        let dirname = src
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| "Invalid source directory name".to_string())?
            .to_string();
        let dest_dir = std::path::PathBuf::from(&adk_path)
            .join("naia-settings")
            .join(&subdir);
        std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
        let dest = unique_dest(&dest_dir, &dirname, "");
        copy_dir_recursive(&src, &dest)?;
        return Ok(dest
            .to_str()
            .ok_or_else(|| "Invalid destination path".to_string())?
            .to_string());
    }

    let filename = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid source filename".to_string())?
        .to_string();

    // Extension whitelist (prevent arbitrary file drop).
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    let allowed_exts: &[&str] = match subdir.as_str() {
        "vrm-files" => &["vrm"],
        "background" => &["png", "jpg", "jpeg", "webp", "gif", "bmp"],
        "bgm-musics" => &["mp3", "wav", "ogg", "flac", "m4a"],
        _ => return Err(format!("Invalid subdir: {subdir}")),
    };
    if !allowed_exts.contains(&ext.as_str()) {
        return Err(format!("File type '.{ext}' not allowed for {subdir}"));
    }

    let dir = std::path::PathBuf::from(&adk_path)
        .join("naia-settings")
        .join(&subdir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = unique_dest(&dir, &filename, &ext);

    std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    Ok(dest
        .to_str()
        .ok_or_else(|| "Invalid destination path".to_string())?
        .to_string())
}

/// Delete a file from `{adk_path}/naia-settings/{subdir}/{filename}` (#13).
/// Refuses path traversal (filename must not contain separators).
#[tauri::command]
async fn delete_naia_asset(
    adk_path: String,
    subdir: String,
    filename: String,
) -> Result<(), String> {
    const ALLOWED: &[&str] = &["vrm-files", "background", "bgm-musics", "nva-files"];
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
    if !path.exists() {
        return Err("File not found".to_string());
    }
    // nva-files: remove directory; others: remove file.
    if subdir == "nva-files" {
        std::fs::remove_dir_all(&path).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(&path).map_err(|e| e.to_string())
    }
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

/// Read `{adk_path}/naia-settings/ui-config.json` (워크스페이스별 UI 정체성 — VRM/배경/BGM).
/// agent 미소비(env 오염 방지) — 셸 전용. config.json(agent 소비)과 분리(FR-WS.2). 없으면 빈 문자열.
#[tauri::command]
async fn read_naia_ui_config(adk_path: String) -> Result<String, String> {
    let path = std::path::PathBuf::from(&adk_path)
        .join("naia-settings")
        .join("ui-config.json");
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Write `{adk_path}/naia-settings/ui-config.json` (셸 전용 — agent 미소비).
#[tauri::command]
async fn write_naia_ui_config(adk_path: String, json: String) -> Result<(), String> {
    let dir = std::path::PathBuf::from(&adk_path).join("naia-settings");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("ui-config.json"), json).map_err(|e| e.to_string())
}

/// Read `{adk_path}/naia-settings/knowledge.json` (지식 소스/스코프 설정 — 셸 전용, agent 읽기전용).
/// 설정 불가침(FR-KB-OS.9): 사람이 UI 로만 변경, agent 는 config-write 도구가 없어 못 바꾼다. 없으면 빈 문자열.
#[tauri::command]
async fn read_naia_knowledge_config(adk_path: String) -> Result<String, String> {
    let path = std::path::PathBuf::from(&adk_path)
        .join("naia-settings")
        .join("knowledge.json");
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Write `{adk_path}/naia-settings/knowledge.json` (셸 전용 — 사람이 설정 UI 로만 변경, FR-KB-OS.5/9).
#[tauri::command]
async fn write_naia_knowledge_config(adk_path: String, json: String) -> Result<(), String> {
    let dir = std::path::PathBuf::from(&adk_path).join("naia-settings");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("knowledge.json"), json).map_err(|e| e.to_string())
}

/// Read compiled KB at `{adk_path}/knowledge/{scope}/kb.json` (컴파일 산출 — 통계 표시용, FR-KB-OS.7).
/// scope 는 path-traversal 차단(구분자·`..` 금지). 없으면 빈 문자열(= 미컴파일).
#[tauri::command]
async fn read_naia_knowledge_kb(adk_path: String, scope: String) -> Result<String, String> {
    if scope.is_empty() || scope.contains('/') || scope.contains('\\') || scope.contains("..") {
        return Err("invalid scope".to_string());
    }
    let path = std::path::PathBuf::from(&adk_path)
        .join("knowledge")
        .join(&scope)
        .join("kb.json");
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// UC-KNOWLEDGE-COMPILE(FR-KB-OS.8): 설정 지식 탭 "지금 컴파일" → agent `CompileKnowledge` RPC.
/// spawn 시 보관한 agent gRPC addr 로 별도 unary 클라 connect → 에이전트가 naia-settings/knowledge.json
/// 의 등록 폴더 → kb-compiler compile → knowledge/<scope>/kb.json. agent 미가용 = Err(UI 가 정직 표기).
#[tauri::command]
async fn compile_knowledge(
    adk_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // gRPC addr 추출 — std Mutex 가드는 await 횡단 금지(블록서 해제 후 await).
    let addr = {
        let guard = state.agent.lock().map_err(|_| "agent lock".to_string())?;
        guard.as_ref().map(|a| a.grpc_addr.clone())
    };
    let addr = addr.ok_or_else(|| "agent unavailable".to_string())?;
    let mut client = agent_grpc::AgentGrpc::connect(format!("http://{}", addr))
        .await
        .map_err(|e| format!("agent connect 실패: {}", e))?;
    let r = client
        .compile_knowledge(adk_path)
        .await
        .map_err(|e| format!("compile 실패: {}", e))?;
    Ok(serde_json::json!({
        "ok": r.ok,
        "scope": r.scope,
        "sourceCount": r.source_count,
        "cardCount": r.card_count,
        "entityCount": r.entity_count,
        "relationCount": r.relation_count,
        "error": r.error,
    }))
}

// ── 대화 transcript read(FR-CONV.3) ─────────────────────────────────────────────
// `{adk_path}/conversations/` = agent(전두엽)가 append 하는 verbatim 대화록(런타임 데이터). **content 단일 writer = agent**;
// shell 은 read + delete(세션 lifecycle 관리, UI 삭제버튼)만 — content append/수정 안 함. agent 부재/죽음에도 파일 직접
// read(E1, brain-body-environment). 죽은 게이트웨이 directToolCall 대체. (delete-중-active-append race = 세션 재생성 wart,
// Phase1 허용: 최악도 삭제 세션이 그 턴만 갖고 재등장, 손상 아님.)

fn conversations_dir(adk_path: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(adk_path).join("conversations")
}

/// sessionId → 안전 파일명 베이스(traversal·경로 인젝션 차단; agent conversation-log sessionFileName 과 동형).
/// 영숫자/`_`/`-` 외 치환, 선행 `_`/`.` 제거, 128 cap. 빈/비정상 = "default".
/// ⚠️ 한계: 전부 비-ASCII(순수 한글 등) sessionId 는 치환 후 빈 → "default" 합류. 실 client localSessionId 는
///    ASCII(`chat-<ts>-<rand>`, stores/chat.ts)라 미발생. 비-ASCII 다중 client 도입 시 hash 폴백 필요(Phase2).
fn safe_session_base(session_id: &str) -> String {
    let mapped: String = session_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    let base: String = mapped
        .trim_start_matches(|c| c == '_' || c == '.')
        .chars()
        .take(128)
        .collect();
    if base.is_empty() { "default".to_string() } else { base }
}

/// 세션 transcript 파일 크기 상한(병리적 파일이 list/read 시 IPC·메모리를 폭주시키는 것 차단; 적대적 리뷰 MED).
/// text 대화록 현실 상한(수천 턴 ≈ 수 MB) 훨씬 위. writer=신뢰 agent 라 위협은 낮으나 방어심층(read_local_binary 와 동형).
const MAX_CONV_BYTES: u64 = 16 * 1024 * 1024;

/// List conversation sessions in `{adk_path}/conversations/`.
/// Returns JSON `{"sessions":[{key,label,messageCount,createdAt,updatedAt}]}` (updatedAt desc). Read-only(FR-CONV.3).
#[tauri::command]
async fn list_conversations(adk_path: String) -> Result<String, String> {
    let dir = conversations_dir(&adk_path);
    if !dir.is_dir() {
        return Ok("{\"sessions\":[]}".to_string());
    }
    let mut sessions: Vec<serde_json::Value> = vec![];
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let stem = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            // 병리적 크기 파일 = 전체 파싱 skip(메모리 폭주 차단, 적대적 리뷰 MED). mtime degraded 엔트리로 노출(숨기지 않음).
            if entry.metadata().map(|m| m.len() > MAX_CONV_BYTES).unwrap_or(false) {
                let updated = entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                sessions.push(serde_json::json!({
                    "key": stem, "label": "", "messageCount": 0, "createdAt": updated, "updatedAt": updated,
                }));
                continue;
            }
            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
            if lines.is_empty() {
                continue;
            }
            let parse_ts = |line: &str| -> u64 {
                serde_json::from_str::<serde_json::Value>(line)
                    .ok()
                    .and_then(|v| v.get("timestamp").and_then(serde_json::Value::as_u64))
                    .unwrap_or(0)
            };
            let created = parse_ts(lines[0]);
            let updated = parse_ts(lines[lines.len() - 1]).max(created);
            let label = lines
                .iter()
                .find_map(|l| {
                    let v = serde_json::from_str::<serde_json::Value>(l).ok()?;
                    if v.get("role").and_then(|r| r.as_str()) == Some("user") {
                        Some(
                            v.get("content")
                                .and_then(|c| c.as_str())
                                .unwrap_or("")
                                .chars()
                                .take(40)
                                .collect::<String>(),
                        )
                    } else {
                        None
                    }
                })
                .unwrap_or_default();
            sessions.push(serde_json::json!({
                "key": stem,
                "label": label,
                "messageCount": lines.len(),
                "createdAt": created,
                "updatedAt": updated,
            }));
        }
    }
    sessions.sort_by(|a, b| {
        b.get("updatedAt").and_then(serde_json::Value::as_u64).unwrap_or(0)
            .cmp(&a.get("updatedAt").and_then(serde_json::Value::as_u64).unwrap_or(0))
    });
    Ok(serde_json::json!({ "sessions": sessions }).to_string())
}

/// Read a conversation's raw JSONL (`{adk_path}/conversations/{session}.jsonl`). Empty string if absent. Read-only(FR-CONV.3).
#[tauri::command]
async fn read_conversation(adk_path: String, session_id: String) -> Result<String, String> {
    let file = conversations_dir(&adk_path).join(format!("{}.jsonl", safe_session_base(&session_id)));
    if !file.exists() {
        return Ok(String::new());
    }
    // 병리적 크기 IPC payload 차단(적대적 리뷰 MED) — read_local_binary 의 MAX_BYTES 가드와 동형.
    if let Ok(meta) = std::fs::metadata(&file) {
        if meta.len() > MAX_CONV_BYTES {
            return Err(format!("transcript too large: {} bytes (max {})", meta.len(), MAX_CONV_BYTES));
        }
    }
    std::fs::read_to_string(&file).map_err(|e| e.to_string())
}

/// Delete a conversation session file. session_id sanitized(traversal 차단).
#[tauri::command]
async fn delete_conversation(adk_path: String, session_id: String) -> Result<(), String> {
    let file = conversations_dir(&adk_path).join(format!("{}.jsonl", safe_session_base(&session_id)));
    if file.exists() {
        std::fs::remove_file(&file).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod conversation_path_tests {
    use super::safe_session_base;
    // 보안 경계(traversal/delete) Rust 단위 커버 — agent sessionFileName contract 와 cross-port 동치(적대적 리뷰 MED).
    #[test]
    fn traversal_neutralized() {
        assert_eq!(safe_session_base("../../etc/passwd"), "etc_passwd");
        assert_eq!(safe_session_base("..\\..\\windows"), "windows");
        assert_eq!(safe_session_base("/etc/passwd"), "etc_passwd");
        assert_eq!(safe_session_base("a/b\\c"), "a_b_c");
    }
    #[test]
    fn empty_and_abnormal_to_default() {
        assert_eq!(safe_session_base(""), "default");
        assert_eq!(safe_session_base("___"), "default");
        assert_eq!(safe_session_base(".."), "default");
    }
    #[test]
    fn normal_preserved_and_capped() {
        assert_eq!(safe_session_base("chat-123_abc"), "chat-123_abc");
        assert_eq!(safe_session_base(&"x".repeat(500)).chars().count(), 128);
    }
}

#[cfg(test)]
mod conversation_io_tests {
    // 실 파일시스템 통합 — list/read/delete_conversation 을 agent-format jsonl 실파일에 대해 실행(FR-CONV.3/4).
    use super::{delete_conversation, list_conversations, read_conversation};
    use std::fs;
    use std::path::PathBuf;

    fn temp_adk(tag: &str) -> PathBuf {
        let mut d = std::env::temp_dir();
        d.push(format!("naia-conv-it-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("conversations")).unwrap();
        d
    }
    fn write_jsonl(adk: &PathBuf, name: &str, lines: &[&str]) {
        fs::write(adk.join("conversations").join(name), format!("{}\n", lines.join("\n"))).unwrap();
    }

    #[tokio::test]
    async fn list_read_delete_roundtrip() {
        let adk = temp_adk("rd");
        // agent conversation-log-store 와 동일 포맷(user/assistant + timestamp)
        write_jsonl(&adk, "chat-1.jsonl", &[
            r#"{"role":"user","content":"안녕","timestamp":1000}"#,
            r#"{"role":"assistant","content":"반가워요","timestamp":1001}"#,
        ]);
        write_jsonl(&adk, "chat-2.jsonl", &[
            r#"{"role":"user","content":"날씨","timestamp":2000}"#,
            r#"{"role":"assistant","content":"맑음","timestamp":2001}"#,
        ]);
        let adk_s = adk.to_str().unwrap().to_string();

        // list: 2 세션, updatedAt desc(chat-2 먼저), label=첫 user content, messageCount=2
        let v: serde_json::Value = serde_json::from_str(&list_conversations(adk_s.clone()).await.unwrap()).unwrap();
        let sessions = v["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0]["key"], "chat-2");
        assert_eq!(sessions[0]["label"], "날씨");
        assert_eq!(sessions[0]["messageCount"], 2);

        // read: raw jsonl 그대로
        let raw = read_conversation(adk_s.clone(), "chat-1".into()).await.unwrap();
        assert!(raw.contains("안녕") && raw.contains("반가워요"));

        // read traversal: sanitize → conversations 밖 접근 불가(부재 = 빈문자열)
        assert_eq!(read_conversation(adk_s.clone(), "../../naia-settings/config".into()).await.unwrap(), "");

        // delete: chat-1 → list 1개
        delete_conversation(adk_s.clone(), "chat-1".into()).await.unwrap();
        assert!(!adk.join("conversations").join("chat-1.jsonl").exists());
        let after: serde_json::Value = serde_json::from_str(&list_conversations(adk_s.clone()).await.unwrap()).unwrap();
        assert_eq!(after["sessions"].as_array().unwrap().len(), 1);

        // delete traversal: conversations 밖 파일을 절대 안 지움(보안 핵심)
        fs::write(adk.join("outside.txt"), "secret").unwrap();
        let _ = delete_conversation(adk_s.clone(), "../outside".into()).await;
        assert!(adk.join("outside.txt").exists(), "traversal delete 가 conversations 밖 파일을 지우면 안 됨");

        let _ = fs::remove_dir_all(&adk);
    }

    #[tokio::test]
    async fn empty_and_missing() {
        let adk = temp_adk("empty");
        let adk_s = adk.to_str().unwrap().to_string();
        assert_eq!(list_conversations(adk_s.clone()).await.unwrap(), "{\"sessions\":[]}");
        assert_eq!(read_conversation(adk_s.clone(), "nope".into()).await.unwrap(), "");
        assert!(delete_conversation(adk_s.clone(), "nope".into()).await.is_ok());
        let _ = fs::remove_dir_all(&adk);
    }
}

/// Write an API key to naia-agent's OS keychain storage.
///
/// Mirrors naia-agent's `keychainSet()` so the standalone agent can read back
/// credentials that naia-os saved — without requiring a separate `naia-agent login` run.
///
/// Storage layout (same as naia-agent):
///   Windows : `{adk_path}/naia-settings/.keys/{env_key}.dpapi`  (DPAPI-encrypted)
///   macOS   : OS Keychain via `security` CLI
///   Linux   : Secret Service via `secret-tool`
/// Also updates the credentials manifest at `{adk_path}/naia-settings/credentials`.
#[tauri::command]
async fn write_agent_key(adk_path: String, env_key: String, value: String) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    use std::io::Write as _;
    use std::path::PathBuf;

    if adk_path.is_empty() || env_key.is_empty() {
        return Err("adk_path and env_key must not be empty".to_string());
    }
    // Basic safety: env_key must be alphanumeric + underscore only.
    if !env_key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(format!("invalid env_key: {env_key}"));
    }

    let settings_dir = PathBuf::from(&adk_path).join("naia-settings");
    let keys_dir = settings_dir.join(".keys");
    std::fs::create_dir_all(&keys_dir).map_err(|e| e.to_string())?;

    // ── Platform keychain write ──────────────────────────────────────────────
    #[cfg(target_os = "windows")]
    {
        // DPAPI (CurrentUser scope) via PowerShell — same script as naia-agent keychainSet.
        let out_file = keys_dir.join(format!("{env_key}.dpapi"));
        // Escape for PowerShell single-quoted string: ' → '' and \ → \\
        let out_path = out_file.to_string_lossy().replace('\'', "''").replace('\\', "\\\\");
        let script = format!(
            "Add-Type -AssemblyName System.Security; \
             $v = [Console]::In.ReadLine(); \
             $b = [System.Text.Encoding]::UTF8.GetBytes($v); \
             $e = [System.Security.Cryptography.ProtectedData]::Protect($b, $null, \
               [System.Security.Cryptography.DataProtectionScope]::CurrentUser); \
             [System.IO.File]::WriteAllBytes('{out_path}', $e)"
        );
        let mut ps_cmd = std::process::Command::new("powershell");
        ps_cmd
            .args(["-NonInteractive", "-Command", &script])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        platform::hide_console(&mut ps_cmd);
        let mut child = ps_cmd
            .spawn()
            .map_err(|e| format!("powershell spawn failed: {e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(value.as_bytes()).map_err(|e| e.to_string())?;
            drop(stdin);
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("DPAPI encrypt failed (exit {status})"));
        }
    }

    #[cfg(target_os = "macos")]
    {
        // macOS Keychain — same service name as naia-agent ("naia-agent").
        let status = std::process::Command::new("security")
            .args([
                "add-generic-password",
                "-a", &env_key,
                "-s", "naia-agent",
                "-w", &value,
                "-U", // update if exists
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|e| format!("security CLI failed: {e}"))?;
        if !status.success() {
            return Err(format!("macOS Keychain write failed (exit {status})"));
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        // Linux Secret Service via secret-tool.
        let status = std::process::Command::new("secret-tool")
            .args([
                "store",
                "--label", &format!("naia-agent:{env_key}"),
                "service", "naia-agent",
                "account", &env_key,
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .and_then(|mut c| {
                if let Some(mut s) = c.stdin.take() { let _ = s.write_all(value.as_bytes()); }
                c.wait()
            })
            .map_err(|e| format!("secret-tool failed: {e}"))?;
        if !status.success() {
            return Err(format!("Linux Secret Service write failed (exit {status})"));
        }
    }

    // ── Update credentials manifest ─────────────────────────────────────────
    // Same format as naia-agent: { "keys": ["ENV_KEY_1", ...] }
    let creds_path = settings_dir.join("credentials");
    let existing: Vec<String> = std::fs::read_to_string(&creds_path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("keys").and_then(|k| k.as_array()).cloned())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_owned()))
                .collect()
        })
        .unwrap_or_default();

    if !existing.contains(&env_key) {
        let mut keys = existing;
        keys.push(env_key.clone());
        let manifest = serde_json::json!({ "keys": keys });
        std::fs::write(&creds_path, serde_json::to_string_pretty(&manifest).unwrap() + "\n")
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// 저장된 키 *존재 여부*만 보고한다(값은 절대 반환 안 함 — 비밀을 webview 로 되읽지 않는다, 보안).
/// 근거 = write_agent_key 가 유지하는 비밀-아닌 매니페스트 `{adk}/naia-settings/credentials` = {keys:[env_key…]}.
/// 셸 Settings 가 키 입력란을 `*****`(저장됨)로 마스킹 표기하는 데 사용.
#[tauri::command]
fn agent_key_exists(adk_path: String, env_key: String) -> Result<bool, String> {
    if adk_path.is_empty() || env_key.is_empty() {
        return Ok(false);
    }
    let creds_path = std::path::PathBuf::from(&adk_path)
        .join("naia-settings")
        .join("credentials");
    let keys: Vec<String> = std::fs::read_to_string(&creds_path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("keys").and_then(|k| k.as_array()).cloned())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_owned()))
                .collect()
        })
        .unwrap_or_default();
    Ok(keys.contains(&env_key))
}

/// Check whether `{adk_path}/naia-settings/` already exists.
#[tauri::command]
async fn check_naia_settings(adk_path: String) -> bool {
    std::path::PathBuf::from(&adk_path)
        .join("naia-settings")
        .is_dir()
}

/// Inspect the ADK directory and report its state so the UI can branch
/// correctly (avoid the "Directory is not empty" raw error path).
///
/// Returns one of:
/// - `"missing"`         — path empty / does not exist / not a directory
/// - `"has_settings"`    — `naia-settings/` subdir present (full ADK)
/// - `"has_other_files"` — non-empty directory but no `naia-settings/`
/// - `"empty"`           — directory exists and is empty (clone target)
#[tauri::command]
async fn inspect_adk_dir(adk_path: String) -> String {
    if adk_path.is_empty() {
        return "missing".to_string();
    }
    let dir = std::path::PathBuf::from(&adk_path);
    if !dir.exists() || !dir.is_dir() {
        return "missing".to_string();
    }
    if dir.join("naia-settings").is_dir() {
        return "has_settings".to_string();
    }
    let non_empty = dir
        .read_dir()
        .map(|mut d| d.next().is_some())
        .unwrap_or(false);
    if non_empty {
        "has_other_files".to_string()
    } else {
        "empty".to_string()
    }
}

/// Create `{adk_path}/naia-settings/` and standard subdirectories.
#[tauri::command]
async fn init_naia_settings(adk_path: String) -> Result<(), String> {
    if adk_path.is_empty() {
        return Err("adk_path is empty".to_string());
    }
    let base = std::path::PathBuf::from(&adk_path).join("naia-settings");
    // Visible asset dirs
    for subdir in &["vrm-files", "background", "bgm-musics"] {
        std::fs::create_dir_all(base.join(subdir))
            .map_err(|e| format!("Failed to create {subdir}: {e}"))?;
    }
    // Hidden user-data dirs (dot-prefix keeps them out of file browsers)
    for subdir in &[".sessions", ".memory", ".identity", ".models"] {
        std::fs::create_dir_all(base.join(subdir))
            .map_err(|e| format!("Failed to create {subdir}: {e}"))?;
    }
    Ok(())
}

/// Write `~/.naia/adk-path` so naia-agent can discover the naia-settings
/// directory on next startup without waiting for the shell JS to initialize.
/// Called by setAdkPath() in adk-store.ts whenever the user sets or changes
/// their workspace path.
#[tauri::command]
async fn write_naia_path_cache(adk_path: String) -> Result<(), String> {
    if adk_path.is_empty() {
        return Err("adk_path is empty".to_string());
    }
    let naia_dir = dirs::home_dir()
        .ok_or_else(|| "Cannot determine home directory".to_string())?
        .join(".naia");
    std::fs::create_dir_all(&naia_dir).map_err(|e| e.to_string())?;
    std::fs::write(naia_dir.join("adk-path"), &adk_path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Copy bundled default assets (vrm-files, background, bgm-musics) from the app's
/// resource directory into `{adk_path}/naia-settings/`. Skips files that already exist.
#[tauri::command]
async fn copy_bundled_assets(app_handle: tauri::AppHandle, adk_path: String) -> Result<(), String> {
    // Extend asset:// protocol scope to include this ADK path (#277).
    // Static tauri.conf.json scope (`$HOME/**`, `/var/home/*/naia-adk/**`, …)
    // covers default placements only. Users who put their ADK on
    // `/mnt/external/...`, `/opt/...`, `D:\...`, `/Volumes/...` would
    // otherwise fail to load VRM / BGM / background via asset:// URLs.
    // This is the single chokepoint — every ADK setup path (new /
    // use-existing / recreate / load) calls copy_bundled_assets after the
    // user picks the path. Idempotent: re-adding an already-allowed path
    // is a no-op inside Tauri's scope set.
    // Non-fatal on failure: scope extension may fail under unusual
    // permission conditions, but the asset:// request itself will error
    // visibly to the user instead of silently denying.
    if let Err(e) = app_handle
        .asset_protocol_scope()
        .allow_directory(&adk_path, true)
    {
        log_verbose(&format!(
            "[copy_bundled_assets] asset scope extend failed for {adk_path}: {e}"
        ));
    }
    Ok(())
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
    const ALLOWED: &[&str] = &["vrm-files", "background", "bgm-musics"];
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

/// Delete the entire adk_path directory (full workspace wipe for "delete and reinstall").
///
/// `state` 인자 추가 (cherry-pick 0e7a5960 후 body 가 state.agent / state.gateway
/// lock 호출 — agent/gateway 가 adk_path 안 file handle 잡고 있어 Windows 에서
/// remove_dir_all 실패 방지). Tauri 가 자동 inject 하므로 frontend 호출은 그대로.
#[tauri::command]
async fn delete_naia_adk(
    state: tauri::State<'_, AppState>,
    adk_path: String,
) -> Result<(), String> {
    if adk_path.is_empty() {
        return Err("adk_path is empty".to_string());
    }
    let adk = std::path::PathBuf::from(&adk_path);
    if !adk.exists() {
        return Ok(());
    }
    if !adk.is_dir() {
        return Err(format!("Not a directory: {adk_path}"));
    }

    // E2E mock — bypass agent kill + filesystem delete; e2e specs use
    // disposable temp paths so a best-effort cleanup is enough.
    if std::env::var("NAIA_E2E_MOCK_CLONE")
        .map(|v| v == "1")
        .unwrap_or(false)
    {
        log_verbose("[delete_naia_adk] NAIA_E2E_MOCK_CLONE=1 — best-effort cleanup");
        let _ = std::fs::remove_dir_all(&adk);
        return Ok(());
    }

    // Kill agent first (it holds file handles inside adk_path on Windows)
    if let Ok(mut guard) = state.agent.lock() {
        if let Some(mut process) = guard.take() {
            log_verbose("[Naia] Terminating agent-core before adk delete...");
            let _ = process.child.kill();
        }
    }
    // Kill gateway + node host
    if let Ok(mut guard) = state.gateway.lock() {
        if let Some(mut process) = guard.take() {
            if let Some(ref mut nh) = process.node_host {
                log_verbose("[Naia] Terminating Node Host before adk delete...");
                let _ = nh.kill();
            }
            if process.we_spawned {
                log_verbose("[Naia] Terminating Gateway before adk delete...");
                let _ = process.child.kill();
            }
        }
    }
    // Brief wait for the OS to release file handles before deletion
    tokio::time::sleep(tokio::time::Duration::from_millis(800)).await;

    std::fs::remove_dir_all(&adk)
        .map_err(|e| format!("Failed to delete {adk_path}: {e}"))
}

/// Clone nextain/naia-adk (shallow) into adk_path.
/// Falls back to zip download if git is not installed.
/// Fails if the directory already exists and is non-empty.
///
/// Emits `adk_setup_progress` events so the UI can show what is happening:
///   { phase: "zip_fallback" }                                  — git failed
///   { phase: "zip_progress", downloaded, total }               — bytes received
#[tauri::command]
async fn clone_naia_adk(
    adk_path: String,
    app_handle: AppHandle,
) -> Result<(), String> {
    if adk_path.is_empty() {
        return Err("adk_path is empty".to_string());
    }
    let path = std::path::PathBuf::from(&adk_path);
    if path.is_dir() {
        let non_empty = path.read_dir()
            .map(|mut d| d.next().is_some())
            .unwrap_or(false);
        if non_empty {
            return Err(format!("Directory is not empty: {adk_path}"));
        }
    }

    // E2E mock — bypass network/git/zip and lay down a minimal scaffold.
    // Activated by NAIA_E2E_MOCK_CLONE=1 (set by wdio.conf.ts). This lets
    // the setup UI proceed through clone → init → copy-assets → onboarding
    // in O(ms) instead of O(seconds-to-minutes) and removes network/CI
    // flakiness from #328 e2e.
    if std::env::var("NAIA_E2E_MOCK_CLONE")
        .map(|v| v == "1")
        .unwrap_or(false)
    {
        log_verbose("[clone_naia_adk] NAIA_E2E_MOCK_CLONE=1 — writing mock scaffold");
        std::fs::create_dir_all(&path)
            .map_err(|e| format!("mock create_dir_all: {e}"))?;
        std::fs::write(path.join("README.md"), "# E2E mock naia-adk\n")
            .map_err(|e| format!("mock write README: {e}"))?;
        return Ok(());
    }

    // Try git clone first.
    let mut cmd = std::process::Command::new("git");
    cmd.args(["clone", "--depth", "1", "https://github.com/nextain/naia-adk", &adk_path]);
    platform::hide_console(&mut cmd);
    match cmd.output() {
        Ok(output) if output.status.success() => return Ok(()),
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            log::warn!("[clone_naia_adk] git clone failed ({stderr}), falling back to zip");
        }
        Err(e) => {
            log::warn!("[clone_naia_adk] git not found ({e}), falling back to zip");
        }
    }

    // Fallback: download zip from GitHub and extract — emit progress so UI is not silent.
    let _ = app_handle.emit("adk_setup_progress", serde_json::json!({
        "phase": "zip_fallback"
    }));
    naia_adk_download_zip(&adk_path, &app_handle).await
}

async fn naia_adk_download_zip(adk_path: &str, app_handle: &AppHandle) -> Result<(), String> {
    const ZIP_URL: &str = "https://github.com/nextain/naia-adk/archive/refs/heads/main.zip";

    // Stream the download so we can emit byte progress (~200ms throttle).
    let mut response = reqwest::get(ZIP_URL)
        .await
        .map_err(|e| format!("zip download failed: {e}"))?;
    let total = response.content_length();

    let mut buf: Vec<u8> = Vec::with_capacity(total.unwrap_or(0) as usize);
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("zip read failed: {e}"))?
    {
        downloaded += chunk.len() as u64;
        buf.extend_from_slice(&chunk);
        if last_emit.elapsed() >= std::time::Duration::from_millis(200) {
            let _ = app_handle.emit("adk_setup_progress", serde_json::json!({
                "phase": "zip_progress",
                "downloaded": downloaded,
                "total": total,
            }));
            last_emit = std::time::Instant::now();
        }
    }
    // Final progress emit so UI shows 100% before extraction starts.
    let _ = app_handle.emit("adk_setup_progress", serde_json::json!({
        "phase": "zip_progress",
        "downloaded": downloaded,
        "total": total,
    }));

    // Extract — GitHub zips contain a single top-level "naia-adk-main/" folder.
    let cursor = std::io::Cursor::new(buf);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| format!("zip open failed: {e}"))?;

    let dst = std::path::PathBuf::from(adk_path);
    std::fs::create_dir_all(&dst).map_err(|e| e.to_string())?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let raw = match file.enclosed_name() {
            Some(p) => p,
            None => continue,
        };
        // Strip the top-level "naia-adk-main/" prefix.
        let stripped = raw.components().skip(1).collect::<std::path::PathBuf>();
        if stripped.as_os_str().is_empty() {
            continue;
        }
        let out = dst.join(&stripped);
        if file.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut outfile = std::fs::File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut file, &mut outfile).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
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
            let oauth_state = app
                .try_state::<AppState>()
                .map(|state| state.oauth_state.clone());
            for arg in args {
                if arg.starts_with("naia://") {
                    process_deep_link_url(
                        &arg,
                        app,
                        oauth_state.as_ref(),
                        "single-instance",
                    );
                }
            }
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
            bgm_server: Mutex::new(None),
            gateway: Mutex::new(None),
            health_monitor_shutdown: Mutex::new(None),
            oauth_state: Arc::new(Mutex::new(None)),
            gemini_live: gemini_live::new_shared_handle(),
            last_agent_restart: Mutex::new(None),
            startup_messages: Mutex::new(Vec::new()),
        })
        .manage(workspace::new_shared_watcher())
        .manage(pty::new_registry())
        .invoke_handler(tauri::generate_handler![
            list_skills,
            frontend_log,
            list_stt_models,
            download_stt_model,
            delete_stt_model,
            store_startup_message,
            send_to_agent_command,
            cancel_stream,
            reset_window_state,
            gateway_health,
            get_gateway_log_path,
            get_log_dir,
            open_log_in_editor,
            get_audit_log,
            get_audit_stats,
            memory_get_all_facts,
            memory_delete_fact,
            memory_export_backup,
            memory_import_backup,
            validate_api_key,
            list_audio_output_devices,
            detect_gpu_vram,
            generate_oauth_state,
            read_local_binary,
            write_temp_text,
            read_discord_bot_token,
            write_discord_bot_token,
            discord_api,
            fetch_linked_channels,
            gemini_live_connect,
            gemini_live_send_audio,
            gemini_live_send_text,
            gemini_live_send_tool_response,
            gemini_live_disconnect,
            // naia-settings asset commands
            list_naia_assets,
            import_naia_asset,
            delete_naia_asset,
            read_naia_config,
            write_naia_config,
            write_slots_manifest,
            start_cascade,
            stop_cascade,
            cascade_status,
            read_naia_ui_config,
            write_naia_ui_config,
            read_naia_knowledge_config,
            write_naia_knowledge_config,
            read_naia_knowledge_kb,
            compile_knowledge,
            write_agent_key,
            agent_key_exists,
            check_naia_settings,
            inspect_adk_dir,
            init_naia_settings,
            write_naia_path_cache,
            delete_naia_settings,
            delete_naia_adk,
            clone_naia_adk,
            write_naia_asset,
            copy_bundled_assets,
            // 대화 transcript read-only(FR-CONV.3) — agent write / shell read(E1 agent 독립)
            list_conversations,
            read_conversation,
            delete_conversation,
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
            panel::panel_install,
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
            enable_webview2_ime,
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

            // OAuth callback HTTP server (#341 옵션 B — Linux dev:tauri 의
            // `naia://` 미등록 우회). 동일 query parameter shape 라
            // process_deep_link_url 그대로 활용. Best-effort: bind 실패 시
            // (port 충돌 등) 경고만 + deep-link path 로만 동작.
            let oauth_state_clone = state.oauth_state.clone();
            if let Err(e) =
                spawn_oauth_callback_server(app_handle.clone(), oauth_state_clone)
            {
                log_both(&format!("[Naia] {}", e));
            }

            // Register deep-link handler for naia:// URI scheme.
            // macOS schemes are declared in the app bundle Info.plist; runtime
            // registration is unsupported by tauri-plugin-deep-link.
            #[cfg(all(desktop, not(any(target_os = "macos", target_os = "ios"))))]
            app.deep_link().register_all().unwrap_or_else(|e| {
                log_both(&format!("[Naia] Deep link registration failed: {}", e));
            });
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            log_verbose("[Naia] Deep link dynamic registration skipped on Apple platforms");

            let deep_link_handle = app_handle.clone();
            let deep_link_state: tauri::State<'_, AppState> = app.state();
            let oauth_state_ref = deep_link_state.oauth_state.clone();
            let current_oauth_state_ref = oauth_state_ref.clone();
            app.deep_link().on_open_url(move |event| {
                let urls = event.urls();
                for url in urls {
                    process_deep_link_url(
                        url.as_str(),
                        &deep_link_handle,
                        Some(&oauth_state_ref),
                        "plugin",
                    );
                }
            });
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    process_deep_link_url(
                        url.as_str(),
                        &app_handle,
                        Some(&current_oauth_state_ref),
                        "current",
                    );
                }
            }

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
                    let fitted = monitor_for_window_state(&app_handle, &window, &saved)
                        .map(|monitor| clamp_window_state_to_bounds(saved, monitor_bounds(&monitor)))
                        .unwrap_or(saved);
                    let _ = window.set_size(PhysicalSize::new(fitted.width, fitted.height));
                    let _ = window.set_position(PhysicalPosition::new(fitted.x, fitted.y));
                    if fitted != saved {
                        save_window_state(&app_handle, &fitted);
                        log_verbose(&format!(
                            "[Naia] Window restored and fitted to screen: {}x{} at ({},{}) -> {}x{} at ({},{})",
                            saved.width,
                            saved.height,
                            saved.x,
                            saved.y,
                            fitted.width,
                            fitted.height,
                            fitted.x,
                            fitted.y
                        ));
                    }
                    log_verbose(&format!(
                        "[Naia] Window restored: {}x{} at ({},{})",
                        fitted.width, fitted.height, fitted.x, fitted.y
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
                    if let Some(monitor) = window
                        .current_monitor()
                        .ok()
                        .flatten()
                        .or_else(|| window.primary_monitor().ok().flatten())
                    {
                        if let Ok(size) = window.outer_size() {
                            let fitted = centered_window_state(size, monitor_bounds(&monitor));
                            let _ = window.set_size(PhysicalSize::new(fitted.width, fitted.height));
                            let _ = window.set_position(PhysicalPosition::new(fitted.x, fitted.y));
                            log_verbose(&format!(
                                "[Naia] Window centered: {}x{} at ({},{})",
                                fitted.width, fitted.height, fitted.x, fitted.y
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
            platform::kill_stale_gateway();

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
                    log_both("[Naia] Running without WebSocket gateway (naia-agent handles tools directly)");
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

            // Then spawn Agent (naia-agent replaces OpenClaw gateway — handles all tools directly)
            match spawn_agent_core(&app_handle, &audit_db) {
                Ok(process) => {
                    let mut guard = lock_or_recover(&state.agent, "state.agent(setup)");
                    *guard = Some(process);
                    drop(guard);
                    log_both("[Naia] agent-core started");
                    // Emit running:true — naia-agent is the tool backend after #201
                    let _ = app_handle.emit(
                        "gateway_status",
                        serde_json::json!({ "running": true, "managed": true }),
                    );
                }
                Err(e) => {
                    log_both(&format!("[Naia] agent-core not available: {}", e));
                    log_both("[Naia] Running without agent (chat will be unavailable)");
                }
            }

            // Spawn YouTube BGM HTTP server (port 18791) — #335.
            // Standalone sidecar because the preferred standalone naia-agent
            // submodule (lib.rs:912-928) lacks startYoutubeServer(), so the
            // shell BGM player would otherwise get connection-refused on 18791.
            // Non-fatal: BGM is an optional feature; failure only logs.
            match spawn_youtube_bgm_server(&app_handle) {
                Ok(process) => {
                    let mut guard =
                        lock_or_recover(&state.bgm_server, "state.bgm_server(setup)");
                    *guard = Some(process);
                }
                Err(e) => {
                    log_both(&format!("[Naia] BGM server not available: {}", e));
                    log_both("[Naia] Running without BGM server (port 18791 will be empty)");
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

                    // Kill BGM server sidecar (#335) — independent of agent
                    let bgm_lock = state.bgm_server.lock();
                    if let Ok(mut guard) = bgm_lock {
                        if let Some(mut process) = guard.take() {
                            log_verbose("[Naia] Terminating BGM server...");
                            let _ = process.child.kill();
                        }
                    }
                    remove_pid_file("bgm-server");

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

    #[test]
    fn window_state_clamps_oversized_window_to_bounds() {
        let state = WindowState {
            x: 120,
            y: 80,
            width: 2560,
            height: 1440,
        };
        let bounds = WindowBounds {
            x: 0,
            y: 0,
            width: 1366,
            height: 768,
        };

        let fitted = clamp_window_state_to_bounds(state, bounds);

        assert_eq!(
            fitted,
            WindowState {
                x: 0,
                y: 0,
                width: 1366,
                height: 768,
            }
        );
    }

    #[test]
    fn window_state_clamps_offscreen_position_to_work_area() {
        let state = WindowState {
            x: -300,
            y: 900,
            width: 1000,
            height: 900,
        };
        let bounds = WindowBounds {
            x: 0,
            y: 25,
            width: 1280,
            height: 695,
        };

        let fitted = clamp_window_state_to_bounds(state, bounds);

        assert_eq!(
            fitted,
            WindowState {
                x: 0,
                y: 25,
                width: 1000,
                height: 695,
            }
        );
    }

    #[test]
    fn centered_window_state_shrinks_default_size_to_bounds() {
        let fitted = centered_window_state(
            PhysicalSize::new(1366, 768),
            WindowBounds {
                x: 10,
                y: 20,
                width: 1280,
                height: 720,
            },
        );

        assert_eq!(
            fitted,
            WindowState {
                x: 10,
                y: 20,
                width: 1280,
                height: 720,
            }
        );
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

    // W1.review P0 (#341 옵션 B) — path guard 가 HTTP callback 형식도 받아야 함.
    // 옛 guard 는 host_str=="auth" 만 인정해 HTTP `http://127.0.0.1:18792/auth/callback`
    // 을 silently reject. 수정 = `is_deep_link_auth || is_http_callback` 형식.
    #[test]
    fn path_guard_accepts_http_callback() {
        let url = url::Url::parse(
            "http://127.0.0.1:18792/auth/callback?key=gw-abc&state=xyz",
        )
        .unwrap();
        let is_deep_link_auth = url.host_str() == Some("auth");
        let is_http_callback = url.path().starts_with("/auth");
        assert!(
            !is_deep_link_auth && is_http_callback,
            "HTTP callback URL must pass via is_http_callback branch"
        );
    }

    #[test]
    fn path_guard_accepts_deep_link() {
        let url = url::Url::parse("naia://auth?key=gw-abc&state=xyz").unwrap();
        let is_deep_link_auth = url.host_str() == Some("auth");
        assert!(
            is_deep_link_auth,
            "Deep link naia://auth must pass via is_deep_link_auth branch"
        );
    }

    #[test]
    fn path_guard_rejects_arbitrary_url() {
        let url = url::Url::parse("http://attacker.example.com/foo?evil=1").unwrap();
        let is_deep_link_auth = url.host_str() == Some("auth");
        let is_http_callback = url.path().starts_with("/auth");
        assert!(
            !is_deep_link_auth && !is_http_callback,
            "Arbitrary URLs must be rejected by both branches"
        );
    }

    #[test]
    fn path_guard_rejects_non_auth_path_on_localhost() {
        let url = url::Url::parse("http://127.0.0.1:18792/some/other/path").unwrap();
        let is_deep_link_auth = url.host_str() == Some("auth");
        let is_http_callback = url.path().starts_with("/auth");
        assert!(
            !is_deep_link_auth && !is_http_callback,
            "Localhost paths outside /auth must be rejected (defense-in-depth)"
        );
    }
}
