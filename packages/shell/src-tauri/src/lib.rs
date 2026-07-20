mod agent_grpc;
mod app;
mod audit;
mod browser;
mod browser_webview;
mod capture;
mod gemini_live;
mod memory;
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

/// OAuth callback HTTP server bind port (#341 ?듭뀡 B ??Linux dev:tauri ??
/// `naia://` scheme OS 誘몃벑濡??고쉶). ?댁쁺 ?뱀? redirect_uri 濡???endpoint 瑜?
/// 諛쏆븘 redirect: `http://127.0.0.1:18792/auth/callback?key=...&state=...&user_id=...`.
/// ?숈씪 query ?뚮씪誘명꽣 ?뗭씠??`process_deep_link_url` ??寃利?濡쒖쭅 洹몃?濡??쒖슜.
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
    //   1) Deep link: `naia://auth?...`  ?? host_str() == "auth", path() == ""
    //   2) HTTP callback: `http://127.0.0.1:18792/auth/callback?...`
    //                                   ?? host_str() == "127.0.0.1",
    //                                      path() starts with "/auth"
    // The old guard only matched (1) and silently rejected (2), which
    // broke #341 ?듭뀡 B end-to-end. (Caught by Claude CLI W1.review P0.)
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
            log_both("[Naia] Naia auth complete ??key received via deep link");
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
        log_both("[Naia] Discord auth complete ??deep link payload received");
    }
}

/// Spawn the OAuth callback HTTP server (#341 ?듭뀡 B).
///
/// Listens on `127.0.0.1:OAUTH_CALLBACK_PORT` for `GET /auth/callback?key=...`
/// and emits the same `naia_auth_complete` Tauri event as the deep-link path.
/// Designed for Linux dev:tauri where `naia://` URI scheme is not registered
/// with the OS ??release builds still use the deep-link path via Tauri plugin.
///
/// **Lifecycle**: best-effort daemon thread. Tauri 醫낅즺 ??OS 媛 listener
/// ?뺣━. 蹂꾨룄 shutdown signal X ??Tauri ?먯껜 醫낅즺媛 異⑸텇.
///
/// **Security**: 127.0.0.1 bind 留?(?몃? ?명꽣?섏씠??X). Cross-site request
/// 李⑤떒 = `Origin`/`Referer` 寃利??놁쓬 (釉뚮씪?곗?媛 GET / 諛쒖떊, ?댁감??CORS X).
/// 寃利앹? `state` CSRF token (process_deep_link_url ?대?) ?쇰줈 ?쒕떎.
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
            // Only accept GET on the dedicated path. Any other URL ??404.
            let raw_url = request.url().to_string();
            if !raw_url.starts_with(OAUTH_CALLBACK_PATH) {
                let _ = request.respond(Response::from_string("Not Found").with_status_code(404));
                continue;
            }

            // Reuse `process_deep_link_url` so the parameter parsing, state CSRF
            // verification, and event emit stay identical to the deep-link path.
            // The function only inspects scheme-agnostic parts (path + query).
            let url_str = format!("http://127.0.0.1:{}{}", OAUTH_CALLBACK_PORT, raw_url);
            process_deep_link_url(&url_str, &app_handle, Some(&oauth_state), "http_callback");

            // Send a small HTML page that closes the tab and informs the user.
            // The browser stays on this page until the user closes it manually.
            let body = r#"<!doctype html><html><head><meta charset="utf-8"><title>naia 濡쒓렇???꾨즺</title><style>body{font-family:system-ui;background:#0f1117;color:#e5e7eb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#1a1d27;border:1px solid #2c303a;padding:32px 40px;border-radius:12px;text-align:center;max-width:420px}h1{margin:0 0 12px;font-size:20px;font-weight:600}p{margin:0;color:#9ca3af;line-height:1.6}</style></head><body><div class="card"><h1>naia 濡쒓렇???꾨즺</h1><p>??李쎌? ?レ븘???⑸땲?? naia ?깆쑝濡??뚯븘媛二쇱꽭??</p></div><script>setTimeout(()=>window.close(),1500)</script></body></html>"#;
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

// agent-core process handle ???뺣낯 transport=gRPC. child=?꾨줈?몄뒪 lifecycle, tx=硫붿떆吏瑜?dispatcher task(gRPC ?대씪 ?뚯쑀)濡?
struct AgentProcess {
    child: Child,
    lease: Option<AgentChildLease>,
    discord_cleanup: Option<DiscordSpawnCleanup>,
    tx: tokio::sync::mpsc::UnboundedSender<String>,
    /// agent-core gRPC listening addr ??寃곌낵 諛섑솚??unary 而ㅻ㎤???? compile_knowledge)媛 蹂꾨룄 ?대씪濡?connect.
    grpc_addr: String,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct AgentChildLease {
    version: u8,
    pid: Option<u32>,
    nonce: String,
    marker: String,
    started_at_ms: u64,
    runtime: Option<std::path::PathBuf>,
}

struct AgentChildLeaseLock {
    _file: std::fs::File,
}

fn agent_child_lease_path() -> Result<std::path::PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "agent_lease_home_unavailable".to_string())?
        .join(".naia")
        .join("agent-child-lease.json"))
}

fn agent_child_lease_lock_path() -> Result<std::path::PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "agent_lease_home_unavailable".to_string())?
        .join(".naia")
        .join("agent-child-lease.lock"))
}

fn acquire_agent_child_lease_lock() -> Result<AgentChildLeaseLock, String> {
    acquire_agent_child_lease_lock_at(&agent_child_lease_lock_path()?)
}

fn acquire_agent_child_lease_lock_at(
    path: &std::path::Path,
) -> Result<AgentChildLeaseLock, String> {
    use fs2::FileExt;
    let parent = path
        .parent()
        .ok_or_else(|| "agent_lease_lock_failed".to_string())?;
    std::fs::create_dir_all(parent).map_err(|_| "agent_lease_lock_failed".to_string())?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|_| "agent_lease_lock_failed".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "agent_lease_lock_failed".to_string())?;
    }
    file.lock_exclusive()
        .map_err(|_| "agent_lease_lock_failed".to_string())?;
    Ok(AgentChildLeaseLock { _file: file })
}

fn read_agent_child_lease_locked(
    _lock: &AgentChildLeaseLock,
) -> Result<Option<AgentChildLease>, String> {
    let path = agent_child_lease_path()?;
    let metadata = match std::fs::metadata(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("agent_lease_read_failed".to_string()),
    };
    if !metadata.is_file() || metadata.len() > 16 * 1024 {
        return Err("agent_lease_invalid".to_string());
    }
    let bytes = std::fs::read(path).map_err(|_| "agent_lease_read_failed".to_string())?;
    let lease = serde_json::from_slice::<AgentChildLease>(&bytes)
        .map_err(|_| "agent_lease_invalid".to_string())?;
    let nonce_valid = lease.nonce.len() == 32
        && lease.nonce.bytes().all(|byte| byte.is_ascii_hexdigit());
    if lease.version != 1
        || !nonce_valid
        || lease.marker != format!("--naia-agent-child={}", lease.nonce)
        || lease.pid == Some(0)
    {
        return Err("agent_lease_invalid".to_string());
    }
    Ok(Some(lease))
}

fn write_agent_child_lease_locked(
    _lock: &AgentChildLeaseLock,
    lease: &AgentChildLease,
) -> Result<(), String> {
    persist_agent_child_lease_with(lease, |path, bytes| {
        write_owner_only_atomic(path, bytes)
    })
}

fn persist_agent_child_lease_before<T, W, N>(
    lease: &AgentChildLease,
    write: W,
    next: N,
) -> Result<T, String>
where
    W: FnOnce(&AgentChildLease) -> Result<(), String>,
    N: FnOnce() -> Result<T, String>,
{
    write(lease)?;
    next()
}

fn persist_agent_child_lease_with<W>(
    lease: &AgentChildLease,
    write: W,
) -> Result<(), String>
where
    W: FnOnce(&std::path::Path, &[u8]) -> Result<(), String>,
{
    let bytes = serde_json::to_vec(lease).map_err(|_| "agent_lease_invalid".to_string())?;
    write(&agent_child_lease_path()?, &bytes)
        .map_err(|_| "agent_lease_write_failed".to_string())
}

fn remove_matching_agent_child_lease_locked(
    lock: &AgentChildLeaseLock,
    lease: &AgentChildLease,
) -> Result<bool, String> {
    remove_matching_agent_child_lease_with(
        lease,
        || read_agent_child_lease_locked(lock),
        || match std::fs::remove_file(agent_child_lease_path()?) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("agent_lease_remove_failed".to_string()),
        },
    )
}

fn remove_matching_agent_child_lease_with<R, D>(
    lease: &AgentChildLease,
    read: R,
    remove: D,
) -> Result<bool, String>
where
    R: FnOnce() -> Result<Option<AgentChildLease>, String>,
    D: FnOnce() -> Result<(), String>,
{
    if read()?.as_ref().map(|current| current.nonce.as_str()) != Some(lease.nonce.as_str()) {
        return Ok(false);
    }
    remove()?;
    Ok(true)
}

fn new_agent_child_lease(
    runtime: Option<std::path::PathBuf>,
) -> Result<AgentChildLease, String> {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|_| "agent_lease_rng_failed".to_string())?;
    let nonce = random.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(AgentChildLease {
        version: 1,
        pid: None,
        marker: format!("--naia-agent-child={nonce}"),
        nonce,
        started_at_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        runtime,
    })
}

fn reconcile_agent_child_lease_locked(lock: &AgentChildLeaseLock) -> Result<(), String> {
    let Some(lease) = read_agent_child_lease_locked(lock)? else {
        return Ok(());
    };
    reconcile_agent_child_lease_with(
        &lease,
        |pid| platform::agent_process_marker(pid, &lease.marker),
        || platform::find_agent_process_by_marker(&lease.marker),
        || {
            if let Some(runtime) = lease.runtime.as_deref() {
                quarantine_discord_runtime_files(runtime)
            } else {
                Ok(())
            }
        },
        || remove_matching_agent_child_lease_locked(lock, &lease).map(|_| ()),
    )
}

fn reconcile_agent_child_lease_with<Q, E, C, D>(
    lease: &AgentChildLease,
    query: Q,
    enumerate: E,
    cleanup: C,
    remove: D,
) -> Result<(), String>
where
    Q: FnOnce(u32) -> Result<Option<bool>, String>,
    E: FnOnce() -> Result<bool, String>,
    C: FnOnce() -> Result<(), String>,
    D: FnOnce() -> Result<(), String>,
{
    let live = match lease.pid {
        Some(pid) => match query(pid)? {
            Some(true) => true,
            Some(false) | None => enumerate()?,
        },
        None => enumerate()?,
    };
    if live {
        return Err("agent_lease_live_blocked".to_string());
    }
    cleanup()?;
    remove()?;
    Ok(())
}

/// Owns a freshly spawned child until every startup handshake has succeeded.
/// Any early return after `Command::spawn` either confirms bounded termination
/// or transfers the child and exact Discord runtime to a background reaper.
struct SpawnedAgentChild {
    child: Option<Child>,
    lease: AgentChildLease,
    discord_cleanup: Option<DiscordSpawnCleanup>,
    pending_reapers: Arc<std::sync::atomic::AtomicUsize>,
}

struct DiscordSpawnCleanup {
    runtime: std::path::PathBuf,
    quarantined: Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Clone, Copy)]
enum OwnedAgentCleanupMode {
    Normal,
    Quarantine,
}

#[derive(Default)]
struct OwnedAgentCleanupOutcome {
    superseded: bool,
    runtime_confirmed: bool,
    lease_removed: bool,
}

impl OwnedAgentCleanupOutcome {
    fn complete(&self, child_reaped: bool) -> bool {
        child_reaped && (self.superseded || (self.runtime_confirmed && self.lease_removed))
    }
}

fn cleanup_owned_agent_child_locked(
    lock: &AgentChildLeaseLock,
    lease: &AgentChildLease,
    child_reaped: bool,
    cleanup: Option<&DiscordSpawnCleanup>,
    mode: OwnedAgentCleanupMode,
) -> OwnedAgentCleanupOutcome {
    cleanup_owned_agent_child_with(
        lease,
        child_reaped,
        cleanup.is_some(),
        mode,
        || read_agent_child_lease_locked(lock),
        |lease| write_agent_child_lease_locked(lock, lease),
        || platform::find_agent_process_by_marker(&lease.marker),
        || {
            if let Some(cleanup) = cleanup {
                revoke_discord_runtime_files(&cleanup.runtime)
            } else {
                Ok(())
            }
        },
        || {
            if let Some(cleanup) = cleanup {
                cleanup
                    .quarantined
                    .store(true, std::sync::atomic::Ordering::Release);
                quarantine_discord_runtime_files(&cleanup.runtime)
            } else {
                Ok(())
            }
        },
        || remove_matching_agent_child_lease_locked(lock, lease),
    )
}

fn cleanup_owned_agent_child_with<R, W, E, V, Q, D>(
    lease: &AgentChildLease,
    child_reaped: bool,
    runtime_cleanup_required: bool,
    mode: OwnedAgentCleanupMode,
    read: R,
    restore: W,
    enumerate: E,
    revoke: V,
    quarantine: Q,
    remove: D,
) -> OwnedAgentCleanupOutcome
where
    R: FnOnce() -> Result<Option<AgentChildLease>, String>,
    W: FnOnce(&AgentChildLease) -> Result<(), String>,
    E: FnOnce() -> Result<bool, String>,
    V: FnOnce() -> Result<(), String>,
    Q: FnOnce() -> Result<(), String>,
    D: FnOnce() -> Result<bool, String>,
{
    let current = match read() {
        Ok(value) => value,
        Err(_) => return OwnedAgentCleanupOutcome::default(),
    };
    match current.as_ref() {
        Some(value) if value.nonce != lease.nonce => {
            return OwnedAgentCleanupOutcome {
                superseded: true,
                ..OwnedAgentCleanupOutcome::default()
            };
        }
        Some(_) => {}
        None if restore(lease).is_ok() => {}
        None => return OwnedAgentCleanupOutcome::default(),
    }
    let fully_reaped = child_reaped && matches!(enumerate(), Ok(false));
    let runtime_result = if !runtime_cleanup_required {
        Ok(())
    } else if fully_reaped && matches!(mode, OwnedAgentCleanupMode::Normal) {
        revoke()
    } else {
        quarantine()
    };
    if runtime_result.is_err() {
        return OwnedAgentCleanupOutcome::default();
    }
    let mut outcome = OwnedAgentCleanupOutcome {
        runtime_confirmed: true,
        ..OwnedAgentCleanupOutcome::default()
    };
    if fully_reaped {
        outcome.lease_removed = remove().unwrap_or(false);
    }
    outcome
}

fn cleanup_owned_agent_child(
    lease: &AgentChildLease,
    child_reaped: bool,
    cleanup: Option<&DiscordSpawnCleanup>,
    mode: OwnedAgentCleanupMode,
) -> OwnedAgentCleanupOutcome {
    let Ok(lock) = acquire_agent_child_lease_lock() else {
        return OwnedAgentCleanupOutcome::default();
    };
    cleanup_owned_agent_child_locked(&lock, lease, child_reaped, cleanup, mode)
}

impl SpawnedAgentChild {
    fn new(
        child: Child,
        lease: AgentChildLease,
        discord_cleanup: Option<DiscordSpawnCleanup>,
        pending_reapers: Arc<std::sync::atomic::AtomicUsize>,
    ) -> Self {
        Self {
            child: Some(child),
            lease,
            discord_cleanup,
            pending_reapers,
        }
    }

    fn child_mut(&mut self) -> &mut Child {
        self.child.as_mut().expect("spawned child must be present")
    }

    fn into_inner(mut self) -> (Child, AgentChildLease, Option<DiscordSpawnCleanup>) {
        (
            self.child.take().expect("spawned child must be present"),
            self.lease.clone(),
            self.discord_cleanup.take(),
        )
    }

    fn finish_explicit_cleanup(&mut self, child_reaped: bool) -> OwnedAgentCleanupOutcome {
        let outcome = cleanup_owned_agent_child(
            &self.lease,
            child_reaped,
            self.discord_cleanup.as_ref(),
            OwnedAgentCleanupMode::Quarantine,
        );
        let runtime_confirmed = outcome.superseded || outcome.runtime_confirmed;
        let cleanup = discord_cleanup_retry(self.discord_cleanup.take(), runtime_confirmed);
        let child = self.child.take();
        if outcome.complete(child_reaped) {
            return outcome;
        }
        if child.is_some() || cleanup.is_some() {
            spawn_background_discord_reaper(
                child,
                cleanup,
                self.lease.clone(),
                Arc::clone(&self.pending_reapers),
            );
        } else {
            spawn_background_discord_reaper(
                None,
                cleanup,
                self.lease.clone(),
                Arc::clone(&self.pending_reapers),
            );
        }
        outcome
    }
}

impl Drop for SpawnedAgentChild {
    fn drop(&mut self) {
        let outcome = cleanup_owned_agent_child(
            &self.lease,
            false,
            self.discord_cleanup.as_ref(),
            OwnedAgentCleanupMode::Quarantine,
        );
        let runtime_confirmed = outcome.superseded || outcome.runtime_confirmed;
        let cleanup = discord_cleanup_retry(self.discord_cleanup.take(), runtime_confirmed);
        if let Some(child) = self.child.take() {
            spawn_background_discord_reaper(
                Some(child),
                cleanup,
                self.lease.clone(),
                Arc::clone(&self.pending_reapers),
            );
        } else if cleanup.is_some() {
            spawn_background_discord_reaper(
                None,
                cleanup,
                self.lease.clone(),
                Arc::clone(&self.pending_reapers),
            );
        }
    }
}

fn discord_cleanup_retry(
    cleanup: Option<DiscordSpawnCleanup>,
    runtime_quarantined: bool,
) -> Option<DiscordSpawnCleanup> {
    if runtime_quarantined {
        None
    } else {
        cleanup
    }
}

struct PendingDiscordReaper {
    pending: Arc<std::sync::atomic::AtomicUsize>,
}

impl PendingDiscordReaper {
    fn begin(pending: Arc<std::sync::atomic::AtomicUsize>) -> Self {
        pending.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        Self { pending }
    }
}

impl Drop for PendingDiscordReaper {
    fn drop(&mut self) {
        self.pending
            .fetch_sub(1, std::sync::atomic::Ordering::Release);
    }
}

#[cfg(test)]
fn run_pending_discord_reaper<R, Q>(
    pending: PendingDiscordReaper,
    reap_child: R,
    retry_cleanup: Q,
) where
    R: FnOnce(),
    Q: FnOnce(),
{
    reap_child();
    retry_cleanup();
    drop(pending);
}

fn confirm_background_reap_with<W>(mut wait: W) -> bool
where
    W: FnMut() -> std::io::Result<()>,
{
    loop {
        match wait() {
            Ok(()) => return true,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return false,
        }
    }
}

fn reap_discord_child_in_background(child: &mut Child) -> bool {
    let _ = child.kill();
    confirm_background_reap_with(|| child.wait().map(|_| ()))
}

struct DiscordReaperOwnership {
    child: Option<Child>,
    cleanup: Option<DiscordSpawnCleanup>,
    lease: AgentChildLease,
    _pending: Option<PendingDiscordReaper>,
}

impl DiscordReaperOwnership {
    fn retry_cleanup(&mut self, child_reaped: bool) -> bool {
        let outcome = cleanup_owned_agent_child(
            &self.lease,
            child_reaped,
            self.cleanup.as_ref(),
            OwnedAgentCleanupMode::Quarantine,
        );
        if outcome.superseded || outcome.runtime_confirmed {
            self.cleanup = None;
        }
        outcome.complete(child_reaped)
    }
}

type DiscordReaperContainer = Arc<Mutex<Option<DiscordReaperOwnership>>>;
type DiscordReaperTask = Box<dyn FnOnce() + Send + 'static>;

fn finish_owned_discord_reaper<T>(
    ownership: T,
    confirmed: bool,
    diagnostic: &'static str,
) {
    if confirmed {
        drop(ownership);
    } else {
        log_both(&format!("[Naia] {diagnostic}"));
        std::mem::forget(ownership);
    }
}

fn take_discord_reaper_ownership(
    container: &DiscordReaperContainer,
) -> DiscordReaperOwnership {
    lock_or_recover(container, "discord_reaper_ownership")
        .take()
        .expect("reaper ownership must be present")
}

fn run_background_discord_reaper(container: DiscordReaperContainer) {
    let mut ownership = take_discord_reaper_ownership(&container);
    let child_reaped = ownership
        .child
        .as_mut()
        .map(reap_discord_child_in_background)
        .unwrap_or(true);
    if child_reaped {
        ownership.child = None;
    }
    let cleanup_confirmed = ownership.retry_cleanup(child_reaped);
    finish_owned_discord_reaper(
        ownership,
        child_reaped && cleanup_confirmed,
        "discord_reaper_wait_or_cleanup_unconfirmed_pending",
    );
}

fn spawn_discord_reaper_task_with<S>(
    container: &DiscordReaperContainer,
    spawn_task: S,
) -> Result<(), String>
where
    S: FnOnce(DiscordReaperTask) -> Result<(), String>,
{
    let thread_container = Arc::clone(container);
    spawn_task(Box::new(move || {
        run_background_discord_reaper(thread_container);
    }))
}

fn recover_failed_discord_reaper_handoff_with<T>(
    container: DiscordReaperContainer,
    terminate_child: T,
) where
    T: FnOnce(&mut Child) -> Result<(), String>,
{
    recover_failed_discord_reaper_handoff_and_cleanup_with(
        container,
        terminate_child,
        |ownership, child_reaped| ownership.retry_cleanup(child_reaped),
    )
}

fn recover_failed_discord_reaper_handoff_and_cleanup_with<T, C>(
    container: DiscordReaperContainer,
    terminate_child: T,
    finish_cleanup: C,
) where
    T: FnOnce(&mut Child) -> Result<(), String>,
    C: FnOnce(&mut DiscordReaperOwnership, bool) -> bool,
{
    let mut ownership = take_discord_reaper_ownership(&container);
    let child_reaped = ownership
        .child
        .as_mut()
        .map(terminate_child)
        .transpose()
        .is_ok();
    if child_reaped {
        ownership.child = None;
    }
    let cleanup_confirmed = finish_cleanup(&mut ownership, child_reaped);
    finish_owned_discord_reaper(
        ownership,
        child_reaped && cleanup_confirmed,
        "discord_reaper_thread_spawn_failed_pending",
    );
}

fn spawn_background_discord_reaper(
    child: Option<Child>,
    cleanup: Option<DiscordSpawnCleanup>,
    lease: AgentChildLease,
    pending_reapers: Arc<std::sync::atomic::AtomicUsize>,
) {
    let container = Arc::new(Mutex::new(Some(DiscordReaperOwnership {
        child,
        cleanup,
        lease,
        _pending: Some(PendingDiscordReaper::begin(pending_reapers)),
    })));
    let spawn_result = spawn_discord_reaper_task_with(&container, |task| {
        std::thread::Builder::new()
            .name("naia-discord-reaper".to_string())
            .spawn(move || task())
            .map(|_| ())
            .map_err(|_| "discord_reaper_thread_spawn_failed".to_string())
    });
    if spawn_result.is_err() {
        log_both("[Naia] discord_reaper_thread_spawn_failed_fallback");
        recover_failed_discord_reaper_handoff_with(container, |child| {
            terminate_and_reap_discord_child(child)
        });
    }
}

// ?좑툘 Rust ??Child drop ???꾨줈?몄뒪瑜?二쎌씠吏 ?딆쓬 ??restart 濡?*guard 援먯껜 ????agent 媛 orphan(gRPC ?쒕쾭 ?붾쪟).
// Drop ?먯꽌 紐낆떆 kill 濡?orphan 諛⑹?(codex 由щ럭 #1). 醫낅즺/replace ?묒そ 而ㅻ쾭.
impl Drop for AgentProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let child_reaped = self.child.wait().is_ok();
        let _ = self.finish_owned_cleanup(child_reaped);
    }
}

impl AgentProcess {
    fn finish_owned_cleanup(&mut self, child_reaped: bool) -> OwnedAgentCleanupOutcome {
        let Some(lease) = self.lease.as_ref() else {
            return OwnedAgentCleanupOutcome {
                superseded: true,
                ..OwnedAgentCleanupOutcome::default()
            };
        };
        let outcome = cleanup_owned_agent_child(
            lease,
            child_reaped,
            self.discord_cleanup.as_ref(),
            OwnedAgentCleanupMode::Normal,
        );
        if outcome.superseded || outcome.runtime_confirmed {
            self.discord_cleanup = None;
        }
        if outcome.complete(child_reaped) {
            self.lease = None;
        }
        outcome
    }
}

// Naia Gateway + Node Host process handle
struct GatewayProcess {
    child: Child,
    node_host: Option<Child>,
    we_spawned: bool, // only kill on shutdown if we spawned it
}

// YouTube BGM sidecar HTTP server (port 18791) ??#335
// Standalone Node process spawned because the standalone naia-agent submodule
// (preferred over embedded agent/src/index.ts in spawn_agent_core lines 912-928)
// does not contain startYoutubeServer(), so port 18791 was never bound.
struct BgmServerProcess {
    child: Child,
}

// Local cascade supervisor (R2.2b) ??naia-os媛 windows-manager loader(`python -m loader
// launch`)瑜?1媛??ъ씠?쒖뭅濡?援щ룞?쒕떎. loader 媛 VoxCPM2 ???ㅼ젣 ?쒕퉬?ㅻ? spawn쨌媛먮룆?섍퀬,
// ???꾨줈?몄뒪瑜?kill ?섎㈃ loader 媛 ?먯떇?ㅼ쓣 teardown ?쒕떎(?먭꺽 湲덉?쨌濡쒖뺄 ?꾨쿋??.
// Rust ??Child drop ??二쎌씠吏 ?딆쑝誘濡?Drop ?먯꽌 紐낆떆 kill(AgentProcess ?숉삎, orphan 諛⑹?).
struct CascadeProcess {
    child: Child,
    /// stdout `CASCADE_READY {json}` ?섏씠濡쒕뱶(facade_port + services). UI ?곹깭?쒖떆??
    ready: String,
}
impl Drop for CascadeProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        // kill()? ?쒓렇?먮쭔 ??wait()濡?reap ?댁빞 Unix(Bazzite)?먯꽌 醫鍮?<defunct>)媛 ???⑥쓬.
        // stop_cascade/WindowEvent ??take()?묭rop 寃쎌쑀??????怨녹씠 ??寃쎈줈瑜?而ㅻ쾭.
        let _ = self.child.wait();
    }
}

struct AppState {
    agent: Mutex<Option<AgentProcess>>,
    /// Serializes every agent spawn/publication with Discord repair and quarantine.
    discord_lifecycle: Mutex<()>,
    /// Process-local fail-closed latch. Only verified explicit repair clears it.
    discord_quarantined: Arc<std::sync::atomic::AtomicBool>,
    /// Blocks every spawn while an unconfirmed child is owned by a background reaper.
    discord_pending_reapers: Arc<std::sync::atomic::AtomicUsize>,
    /// Serializes Discord credential and binding mutations across async Tauri commands.
    /// A single operation owns manifest/key rollback and the corresponding agent restart.
    discord_config_operation: tokio::sync::Mutex<()>,
    /// Server-side cache of binding ids proven usable by the latest live
    /// discovery. The WebView may narrow this set but can never broaden it.
    discord_inbox_authorized_bindings:
        tokio::sync::Mutex<Option<(u64, std::collections::BTreeSet<String>)>>,
    bgm_server: Mutex<Option<BgmServerProcess>>,
    cascade: Mutex<Option<CascadeProcess>>,
    gateway: Mutex<Option<GatewayProcess>>,
    health_monitor_shutdown: Mutex<Option<Arc<std::sync::atomic::AtomicBool>>>,
    /// Random state token for OAuth deep link CSRF protection.
    oauth_state: Arc<Mutex<Option<String>>>,
    /// Active Gemini Live WebSocket proxy session.
    gemini_live: gemini_live::SharedHandle,
    /// Last agent-core restart timestamp ??debounce to prevent restart storms (#226).
    last_agent_restart: Mutex<Option<std::time::Instant>>,
    /// Startup IPC messages (auth_update / notify_config / creds_update) ??replayed
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

fn with_discord_lifecycle<T, F>(lifecycle: &Mutex<()>, operation: F) -> T
where
    F: FnOnce() -> T,
{
    let _guard = lock_or_recover(lifecycle, "state.discord_lifecycle");
    operation()
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

/// Important messages ??always stderr + file (visible to users in release)
pub(crate) fn log_both(msg: &str) {
    eprintln!("{}", msg);
    log_to_file(msg);
}

/// Verbose/debug messages ??file always, stderr only in debug builds
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
// spawning `tasklist`/`taskkill` ??which would flash a console window in a GUI
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
/// triggers `ERROR_NO_DATA (0x800700e8)` ??"The pipe is being closed" ??because
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

fn absolute_executable_path(path: std::path::PathBuf) -> std::path::PathBuf {
    if let Ok(canonical) = dunce::canonicalize(&path) {
        return canonical;
    }
    if path.is_absolute() || path.components().count() != 1 {
        return path;
    }

    let mut names = vec![path.clone()];
    if cfg!(windows) && path.extension().is_none() {
        names.push(path.with_extension("exe"));
        names.push(path.with_extension("cmd"));
    }
    if let Some(search_path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&search_path) {
            for name in &names {
                let candidate = directory.join(name);
                if candidate.is_file() {
                    return dunce::canonicalize(&candidate).unwrap_or(candidate);
                }
            }
        }
    }
    path
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
            return Ok(absolute_executable_path(std::path::PathBuf::from(node_cmd)));
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

/// Resolve the Node.js binary used by a child process.
///
/// Explicit environment overrides remain highest priority. Installed builds then
/// use the runtime staged in Tauri's resource directory, while development builds
/// retain the existing system/nvm/fnm fallback chain.
fn select_node_binary<F, G>(
    env_override: Option<std::ffi::OsString>,
    find_bundled: F,
    find_system: G,
) -> std::path::PathBuf
where
    F: FnOnce() -> Option<std::path::PathBuf>,
    G: FnOnce() -> Result<std::path::PathBuf, String>,
{
    if let Some(path) = env_override {
        return absolute_executable_path(std::path::PathBuf::from(path));
    }
    if let Some(path) = find_bundled() {
        return path;
    }
    find_system().unwrap_or_else(|_| {
        std::path::PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" })
    })
}

fn resolve_spawn_node(app_handle: &AppHandle, env_name: &str) -> String {
    select_node_binary(
        std::env::var_os(env_name),
        || platform::find_bundled_node(app_handle),
        find_node_binary,
    )
    .to_string_lossy()
    .to_string()
}

/// Check if Naia Gateway is already running (blocking, for setup use)
fn check_gateway_health_sync() -> bool {
    // Gateway (openclaw) removed ??naia-agent handles all tools directly.
    false
}

// find_gateway_paths removed ??openclaw gateway no longer used (#201)

/// Load bootstrap config from bundled template file, with hardcoded fallback.
/// Single source of truth: config/defaults/gateway-bootstrap.json
fn load_bootstrap_config() -> serde_json::Value {
    // Search: Flatpak bundle ??dev-mode relative ??hardcoded fallback
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

/// Gateway (openclaw) removed in #201 ??naia-agent handles all tools directly via stdio.
fn spawn_gateway() -> Result<GatewayProcess, String> {
    Err("Gateway removed: naia-agent handles all tools directly".to_string())
}

// openclaw spawn_node_host and legacy spawn body removed ??see #201

fn normalize_paired_path(path: &std::path::Path) -> String {
    dunce::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
}

fn runtime_git_output(dir: &std::path::Path, args: &[&str]) -> Result<String, String> {
    let dir_string = dir.to_string_lossy().to_string();
    let output = std::process::Command::new("git")
        .args(["-C", dir_string.as_str()])
        .args(args)
        .output()
        .map_err(|e| format!("git invocation failed for {}: {e}", dir.display()))?;
    if !output.status.success() {
        return Err(format!(
            "git {:?} failed for {}",
            args,
            dir.display()
        ));
    }
    String::from_utf8(output.stdout)
        .map(|value| value.trim().to_string())
        .map_err(|e| format!("git output was not UTF-8: {e}"))
}

fn sha256_file_hex(path: &std::path::Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(path)
        .map_err(|e| format!("failed to read {} for SHA256: {e}", path.display()))?;
    Ok(format!("{:x}", Sha256::digest(&bytes)))
}

fn validate_runtime_agent_script_override(agent_script: &str) -> Result<(), String> {
    let expected = option_env!("NAIA_AGENT_PAIRED_SCRIPT")
        .ok_or_else(|| "NAIA_AGENT_PAIRED_SCRIPT build evidence missing".to_string())?
        .replace('\\', "/");
    let actual = normalize_paired_path(std::path::Path::new(agent_script));
    if actual != expected {
        return Err(format!(
            "NAIA_AGENT_SCRIPT must match paired build script {expected}; got {actual}"
        ));
    }
    let paired_root = option_env!("NAIA_AGENT_PAIRED_ROOT")
        .ok_or_else(|| "NAIA_AGENT_PAIRED_ROOT build evidence missing".to_string())?;
    let root_path = std::path::Path::new(paired_root);
    let expected_commit = option_env!("NAIA_AGENT_REQUIRED_COMMIT")
        .ok_or_else(|| "NAIA_AGENT_REQUIRED_COMMIT build evidence missing".to_string())?;
    let actual_commit = runtime_git_output(root_path, &["rev-parse", "HEAD"])?;
    if actual_commit != expected_commit {
        return Err(format!(
            "NAIA_AGENT_SCRIPT checkout commit must remain {expected_commit}; got {actual_commit}"
        ));
    }
    let dirty = runtime_git_output(root_path, &["status", "--porcelain"])?;
    if !dirty.is_empty() {
        return Err("NAIA_AGENT_SCRIPT checkout must remain clean at runtime".to_string());
    }
    let expected_script_hash = option_env!("NAIA_AGENT_PAIRED_SCRIPT_SHA256")
        .ok_or_else(|| "NAIA_AGENT_PAIRED_SCRIPT_SHA256 build evidence missing".to_string())?;
    let actual_script_hash = sha256_file_hex(std::path::Path::new(agent_script))?;
    if actual_script_hash != expected_script_hash {
        return Err(format!(
            "NAIA_AGENT_SCRIPT hash must remain {expected_script_hash}; got {actual_script_hash}"
        ));
    }
    let expected_proto_hash = option_env!("NAIA_AGENT_PAIRED_PROTO_SHA256")
        .ok_or_else(|| "NAIA_AGENT_PAIRED_PROTO_SHA256 build evidence missing".to_string())?;
    let proto_path = root_path.join("src/main/adapters/grpc/naia_agent.proto");
    let actual_proto_hash = sha256_file_hex(&proto_path)?;
    if actual_proto_hash != expected_proto_hash {
        return Err(format!(
            "NAIA_AGENT_PROTO hash must remain {expected_proto_hash}; got {actual_proto_hash}"
        ));
    }
    Ok(())
}

fn resolve_paired_bundled_agent_script(app_handle: &AppHandle) -> Result<String, String> {
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir unavailable for bundled paired agent: {e}"))?;
    let bundled = resource_dir.join("agent/scripts/builds/agent-stdio-entry.mjs");
    if !bundled.exists() {
        return Err(format!(
            "NAIA_AGENT_SCRIPT is required unless paired bundled agent exists at {}",
            bundled.display()
        ));
    }
    let expected_script_hash = option_env!("NAIA_AGENT_PAIRED_SCRIPT_SHA256")
        .ok_or_else(|| "NAIA_AGENT_PAIRED_SCRIPT_SHA256 build evidence missing".to_string())?;
    let actual_script_hash = sha256_file_hex(&bundled)?;
    if actual_script_hash != expected_script_hash {
        return Err(format!(
            "bundled paired agent script hash must remain {expected_script_hash}; got {actual_script_hash}"
        ));
    }

    let bundled_proto = resource_dir.join("agent/dist/main/adapters/grpc/naia_agent.proto");
    if !bundled_proto.exists() {
        return Err(format!(
            "paired bundled agent proto is required at {}",
            bundled_proto.display()
        ));
    }
    let expected_proto_hash = option_env!("NAIA_AGENT_PAIRED_PROTO_SHA256")
        .ok_or_else(|| "NAIA_AGENT_PAIRED_PROTO_SHA256 build evidence missing".to_string())?;
    let actual_proto_hash = sha256_file_hex(&bundled_proto)?;
    if actual_proto_hash != expected_proto_hash {
        return Err(format!(
            "bundled paired agent proto hash must remain {expected_proto_hash}; got {actual_proto_hash}"
        ));
    }

    let normalized = dunce::canonicalize(&bundled).unwrap_or(bundled);
    log_verbose(&format!(
        "[Naia] Found paired bundled agent at: {}",
        normalized.display()
    ));
    Ok(normalized.to_string_lossy().to_string())
}

/// Spawn the Node.js agent-core process with stdio pipes
fn spawn_adk_path_snapshot_with<R>(read_cache: R) -> Option<String>
where
    R: FnOnce() -> Option<String>,
{
    read_cache()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn spawn_adk_path_snapshot() -> Option<String> {
    spawn_adk_path_snapshot_with(|| {
        dirs::home_dir()
            .and_then(|home| std::fs::read_to_string(home.join(".naia").join("adk-path")).ok())
    })
}

fn ensure_no_pending_discord_reaper(
    pending_reapers: &std::sync::atomic::AtomicUsize,
    _discord_repair_bypass: bool,
) -> Result<(), String> {
    if pending_reapers.load(std::sync::atomic::Ordering::Acquire) == 0 {
        Ok(())
    } else {
        Err("discord_agent_reap_pending".to_string())
    }
}

fn spawn_agent_core(
    app_handle: &AppHandle,
    audit_db: &audit::AuditDb,
    discord_quarantined: &Arc<std::sync::atomic::AtomicBool>,
    discord_pending_reapers: &Arc<std::sync::atomic::AtomicUsize>,
    discord_repair_bypass: bool,
) -> Result<AgentProcess, String> {
    use std::io::Write as _;

    ensure_no_pending_discord_reaper(discord_pending_reapers, discord_repair_bypass)?;
    let lease_lock = acquire_agent_child_lease_lock()?;
    reconcile_agent_child_lease_locked(&lease_lock)?;
    let mut child_lease = new_agent_child_lease(None)?;
    persist_agent_child_lease_before(
        &child_lease,
        |lease| write_agent_child_lease_locked(&lease_lock, lease),
        || Ok(()),
    )?;

    let agent_path = resolve_spawn_node(app_handle, "NAIA_AGENT_PATH");
    log_both(&format!("[Naia] node = {}", agent_path));

    // In dev: tsx for TypeScript direct execution; in prod: compiled JS from bundle
    let agent_script_env = std::env::var("NAIA_AGENT_SCRIPT");
    let agent_script = match &agent_script_env {
        Ok(value) => {
            validate_runtime_agent_script_override(value)?;
            value.clone()
        }
        Err(_) => resolve_paired_bundled_agent_script(app_handle)?,
    };
    let use_tsx = agent_script.ends_with(".ts");
    // Preferred: invoke tsx via node directly (agent_dir/node_modules/.pnpm/tsx@*/.../cli.mjs).
    // This avoids spawning `npx` or `npx.cmd` ??Windows' CreateProcess does not
    // resolve .cmd shims, and batch files fail under CREATE_NO_WINDOW anyway.
    //
    // Fallback: `npx.cmd` (Windows) / `npx` (Unix) via platform::resolve_npx() ??
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
    cmd.arg(&child_lease.marker);

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

    let mut discord_token_frame: Option<zeroize::Zeroizing<Vec<u8>>> = None;
    let mut discord_runtime_cleanup: Option<std::path::PathBuf> = None;
    let spawn_adk_path = spawn_adk_path_snapshot();

    // Pass naia-settings directory to the agent via env var so it can resolve
    // all user-data paths (sessions, memory, identity) without reading files
    // at runtime. The cache is captured exactly once so a concurrent path
    // update cannot mix settings, Discord runtime, and dispatcher workspaces.
    if let Some(adk_path_str) = spawn_adk_path.as_deref() {
        let settings_dir = std::path::PathBuf::from(adk_path_str).join("naia-settings");
        cmd.env("NAIA_SETTINGS_DIR", settings_dir.to_string_lossy().as_ref());
        cmd.env("NAIA_ADK_PATH", adk_path_str);
        let bindings_path = settings_dir.join("discord-bindings.json");
        let runtime_dir = settings_dir.join("discord-runtime");
        if discord_runtime_activation_allowed(
            discord_quarantined,
            &runtime_dir,
            discord_repair_bypass,
        ) {
            if let Ok(metadata) = std::fs::metadata(&bindings_path) {
                if metadata.is_file() && metadata.len() <= 512 * 1024 {
                    if let Ok(bindings_json) = std::fs::read_to_string(&bindings_path) {
                        let generation =
                            serde_json::from_str::<serde_json::Value>(&bindings_json)
                                .ok()
                                .and_then(|value| {
                                    value
                                        .get("generation")
                                        .and_then(|item| item.as_u64())
                                });
                        if let Some(generation) = generation {
                            if let Ok(token) = read_discord_bot_token() {
                                if validate_discord_token(&token).is_ok() {
                                    std::fs::create_dir_all(&runtime_dir).map_err(|_| {
                                        "discord_runtime_dir_unavailable".to_string()
                                    })?;
                                    child_lease.runtime = Some(runtime_dir.clone());
                                    let generation = generation.to_string();
                                    let authority_path = runtime_dir.join("authority.json");
                                    let authority = serde_json::json!({
                                        "version": 1,
                                        "generation": generation.clone(),
                                    });
                                    let authority_bytes = serde_json::to_vec(&authority)
                                        .map_err(|_| {
                                            "discord_authority_invalid".to_string()
                                        })?;
                                    persist_agent_child_lease_before(
                                        &child_lease,
                                        |lease| {
                                            write_agent_child_lease_locked(&lease_lock, lease)
                                        },
                                        || {
                                            issue_discord_runtime_authority(
                                                discord_quarantined,
                                                || {
                                                    write_owner_only_atomic(
                                                        &authority_path,
                                                        &authority_bytes,
                                                    )
                                                },
                                                || {
                                                    quarantine_discord_runtime_files(&runtime_dir)
                                                },
                                            )
                                        },
                                    )?;
                                    cmd.env("NAIA_DISCORD_TOKEN_PIPE", "stdin");
                                    cmd.env("NAIA_DISCORD_BINDINGS_JSON", bindings_json);
                                    cmd.env("NAIA_DISCORD_GENERATION", &generation);
                                    cmd.env(
                                        "NAIA_DISCORD_STATUS_PATH",
                                        runtime_dir.join("status.json"),
                                    );
                                    cmd.env(
                                        "NAIA_DISCORD_AUTHORITY_PATH",
                                        &authority_path,
                                    );
                                    cmd.env(
                                        "NAIA_DISCORD_DEDUPE_PATH",
                                        runtime_dir.join("dedupe.json"),
                                    );
                                    cmd.env(
                                        "NAIA_DISCORD_INBOX_PATH",
                                        runtime_dir.join("inbox.json"),
                                    );
                                    discord_runtime_cleanup = Some(runtime_dir.clone());
                                    discord_token_frame = Some(token);
                                }
                            }
                        }
                    }
                }
            }
        }
        log_verbose(&format!(
            "[Naia] agent NAIA_ADK_PATH={} NAIA_SETTINGS_DIR={}",
            adk_path_str,
            settings_dir.display()
        ));
    }

    #[cfg(windows)]
    platform::hide_console(&mut cmd);
    let discord_runtime_armed = discord_token_frame.is_some();
    let discord_cleanup = discord_runtime_cleanup
        .as_ref()
        .map(|runtime| DiscordSpawnCleanup {
            runtime: runtime.clone(),
            quarantined: Arc::clone(discord_quarantined),
        });
    let child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            let outcome = cleanup_owned_agent_child_locked(
                &lease_lock,
                &child_lease,
                true,
                discord_cleanup.as_ref(),
                OwnedAgentCleanupMode::Quarantine,
            );
            let runtime_confirmed = outcome.superseded || outcome.runtime_confirmed;
            return finalize_discord_startup_failure(
                format!("Failed to spawn agent-core: {error}"),
                discord_runtime_armed && !outcome.superseded,
                discord_quarantined,
                true,
                runtime_confirmed,
                |_, _| {},
            );
        }
    };
    child_lease.pid = Some(child.id());
    let mut spawned = SpawnedAgentChild::new(
        child,
        child_lease,
        discord_cleanup,
        Arc::clone(discord_pending_reapers),
    );

    let lease_update = write_agent_child_lease_locked(&lease_lock, &spawned.lease);
    drop(lease_lock);
    if let Err(error) = lease_update {
        return fail_spawned_discord_agent_startup(
            error,
            discord_runtime_armed,
            discord_quarantined,
            &mut spawned,
        );
    }

    if let Some(frame) = discord_token_frame {
        let Some(mut stdin) = spawned.child_mut().stdin.take() else {
            return fail_spawned_discord_agent_startup(
                "discord_token_pipe_unavailable".to_string(),
                discord_runtime_armed,
                discord_quarantined,
                &mut spawned,
            );
        };
        let write_result = stdin
            .write_all(&frame)
            .and_then(|_| stdin.flush());
        drop(stdin);
        if write_result.is_err() {
            return fail_spawned_discord_agent_startup(
                "discord_token_pipe_failed".to_string(),
                discord_runtime_armed,
                discord_quarantined,
                &mut spawned,
            );
        }
    }

    // gRPC: stdin ? ?곗씠??梨꾨꼸 ?꾨떂(child 媛 蹂댁쑀, 誘몄궗??. stdout = GRPC_LISTENING ?몃뱶?곗씠??+ 濡쒓렇.
    let stdout = match spawned.child_mut().stdout.take() {
        Some(stdout) => stdout,
        None => {
            return fail_spawned_discord_agent_startup(
                "Failed to get agent stdout".to_string(),
                discord_runtime_armed,
                discord_quarantined,
                &mut spawned,
            );
        }
    };

    // ?? gRPC(?뺣낯 transport): stdout ??`GRPC_LISTENING <addr>` ?몃뱶?곗씠??1以꾨쭔 ?쎄퀬 ?섎㉧吏??濡쒓렇 ??
    // ?곗씠???붿껌/?묐떟)??gRPC. agent_response ?대깽?몃뒗 dispatcher ??Chat stream task 媛 ?ш뎄?깊빐 emit.
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

    // gRPC listening addr ?섏떊(timeout) ??湲곕룞 ?몃뱶?곗씠?? ?ㅽ뙣 = 湲곕룞 ?ㅽ뙣.
    let addr = match addr_rx.recv_timeout(std::time::Duration::from_secs(20)) {
        Ok(addr) => addr,
        Err(_) => {
            return fail_spawned_discord_agent_startup(
                "agent gRPC addr handshake timeout".to_string(),
                discord_runtime_armed,
                discord_quarantined,
                &mut spawned,
            );
        }
    };
    log_both(&format!("[Naia] agent-core gRPC @{}", addr));

    // adk_path (SetWorkspace ?? ??env(NAIA_ADK_PATH) ? ?숈씪 異쒖쿂(~/.naia/adk-path).
    let adk_path = spawn_adk_path.unwrap_or_default();

    // 硫붿떆吏 梨꾨꼸: send_to_agent(sync) ??dispatcher task(async, gRPC ?대씪 ?뚯쑀). nested runtime ?뚰뵾.
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    tauri::async_runtime::spawn(agent_dispatcher(
        addr.clone(),
        adk_path,
        rx,
        app_handle.clone(),
        audit_db.clone(),
    ));

    let (child, lease, discord_cleanup) = spawned.into_inner();
    Ok(AgentProcess {
        child,
        lease: Some(lease),
        discord_cleanup,
        tx,
        grpc_addr: addr,
    })
}

/// gRPC dispatcher ??connect ??SetWorkspace(naia-adk 濡쒕뵫) ??硫붿떆吏 猷⑦봽.
/// chat=Chat stream task(AgentEvent?뭊I JSON emit + audit + memory backup dispatch, 援?stdout reader ?泥?,
/// creds/cancel/approval=unary. send_to_agent(sync) 媛 mpsc 濡?硫붿떆吏瑜??섎┛??
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
            log_both(&format!("[Naia] agent gRPC connect ?ㅽ뙣: {}", e));
            return;
        }
    };
    match client.set_workspace(adk_path.clone()).await {
        Ok(r) => log_both(&format!(
            "[Naia] SetWorkspace ??loaded={} {}/{}",
            r.loaded, r.provider, r.model
        )),
        Err(e) => log_both(&format!("[Naia] SetWorkspace ?ㅽ뙣: {}", e)),
    }
    // Proactive speech is a session-level server stream, independent from an
    // ordinary chat request. Keep one subscription alive for the shell's main
    // session so activity events can arrive while the input box is idle.
    let (activity_shutdown_tx, mut activity_shutdown_rx) = tokio::sync::watch::channel(false);
    {
        let mut activity_client = client.clone();
        let activity_app = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let emit_app = activity_app.clone();
                let emit = move |json: String| {
                    let _ = emit_app.emit("agent_response", &json);
                };
                let result = tokio::select! {
                    result = activity_client.subscribe_speech_activities(
                        "agent:main:main".to_string(),
                        emit,
                    ) => result,
                    _ = activity_shutdown_rx.changed() => break,
                };
                let err = serde_json::json!({
                    "type": "speech_activity_subscription_error",
                    "message": match result {
                        Ok(()) => "grpc speech activity subscription ended".to_string(),
                        Err(e) => format!("grpc speech activity subscription: {}", e),
                    },
                    "retrying": true,
                })
                .to_string();
                let _ = activity_app.emit("agent_response", &err);
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {},
                    _ = activity_shutdown_rx.changed() => break,
                }
            }
        });
    }
    while let Some(msg) = rx.recv().await {
        let v: serde_json::Value = match serde_json::from_str(&msg) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match v.get("type").and_then(|x| x.as_str()).unwrap_or("") {
            "chat_request" => {
                let request_id = v.get("requestId").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let req = match agent_grpc::try_json_to_chat_request(&v) {
                    Ok(req) => req,
                    Err(e) => {
                        let err = serde_json::json!({
                            "type": "error",
                            "requestId": request_id,
                            "message": e.message,
                            "code": e.code,
                        })
                        .to_string();
                        let _ = app.emit("agent_response", &err);
                        continue;
                    }
                };
                let mut c = client.clone();
                let app2 = app.clone();
                let app_err = app.clone(); // emit closure 媛 app2 瑜?move ???먮윭 寃쎈줈??蹂꾨룄 clone
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
                let provider = v
                    .get("provider")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let api_key = v
                    .get("apiKey")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string());
                let naia_key = v
                    .get("naiaKey")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string());
                let _ = client.update_creds(provider, api_key, naia_key).await;
            }
            "cancel_stream" => {
                let rid = v
                    .get("requestId")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let activity_id = v
                    .get("activityId")
                    .and_then(|x| x.as_str())
                    .map(str::to_string);
                let _ = client.cancel(rid, activity_id).await;
            }
            "configure_speech_profile" => {
                use agent_grpc::pb::configure_speech_profile_request::Profile;

                let session_id = v
                    .get("sessionId")
                    .and_then(|x| x.as_str())
                    .unwrap_or("agent:main:main")
                    .to_string();
                let profile_name = v
                    .get("profile")
                    .and_then(|x| x.as_str())
                    .unwrap_or("disabled");
                let bounded = |key: &str, default: i64, min: i64, max: i64| {
                    v.get(key)
                        .and_then(|x| x.as_i64())
                        .unwrap_or(default)
                        .clamp(min, max)
                };
                let profile = match profile_name {
                    "personal_radio_dj" => {
                        Profile::PersonalRadioDj(agent_grpc::pb::PersonalRadioDjProfile {
                            idle_ms: bounded("idleMs", 120_000, 5_000, 86_400_000),
                            dj_interval_ms: bounded("djIntervalMs", 900_000, 30_000, 86_400_000),
                            timezone: v
                                .get("timezone")
                                .and_then(|x| x.as_str())
                                .unwrap_or("Asia/Seoul")
                                .to_string(),
                            bgm_auto_play_opt_in: v
                                .get("bgmAutoPlayOptIn")
                                .and_then(|x| x.as_bool())
                                .unwrap_or(false),
                            weather_latitude: v.get("weatherLatitude").and_then(|x| x.as_f64()),
                            weather_longitude: v.get("weatherLongitude").and_then(|x| x.as_f64()),
                            weather_consented: v
                                .get("weatherConsented")
                                .and_then(|x| x.as_bool())
                                .unwrap_or(false),
                        })
                    }
                    "exhibition_intro" => {
                        Profile::ExhibitionIntro(agent_grpc::pb::ExhibitionIntroProfile {
                            knowledge_scope: v
                                .get("knowledgeScope")
                                .and_then(|x| x.as_str())
                                .unwrap_or("exhibition")
                                .to_string(),
                            idle_ms: bounded("idleMs", 15_000, 1_000, 3_600_000),
                            intro_interval_ms: bounded("introIntervalMs", 20_000, 2_000, 3_600_000),
                        })
                    }
                    _ => Profile::Disabled(agent_grpc::pb::DisabledSpeechProfile {}),
                };
                let request = agent_grpc::pb::ConfigureSpeechProfileRequest {
                    session_id,
                    profile: Some(profile),
                };
                let request_id = v
                    .get("requestId")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let result = client.configure_speech_profile(request).await;
                let payload = match result {
                    Ok(ok) => serde_json::json!({
                        "type": "speech_profile_configured",
                        "requestId": request_id,
                        "ok": ok,
                        "profile": profile_name,
                    }),
                    Err(e) => serde_json::json!({
                        "type": "error",
                        "requestId": request_id,
                        "message": format!("grpc configure speech profile: {}", e),
                    }),
                };
                let _ = app.emit("agent_response", &payload.to_string());
            }
            "yield_speech_activity" => {
                let session_id = v
                    .get("sessionId")
                    .and_then(|x| x.as_str())
                    .unwrap_or("agent:main:main")
                    .to_string();
                let activity_id = v
                    .get("activityId")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let request_id = v
                    .get("requestId")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let payload = match client
                    .yield_speech_activity(session_id, activity_id.clone())
                    .await
                {
                    Ok(result) => serde_json::json!({
                        "type": "speech_activity_yielded",
                        "requestId": request_id,
                        "activityId": activity_id,
                        "ok": result.ok,
                        "resumeToken": result.resume_token,
                        "profileGeneration": result.profile_generation,
                        "yieldGeneration": result.yield_generation,
                    }),
                    Err(e) => serde_json::json!({
                        "type": "error",
                        "requestId": request_id,
                        "activityId": activity_id,
                        "message": format!("grpc yield speech activity: {}", e),
                    }),
                };
                let _ = app.emit("agent_response", &payload.to_string());
            }
            "stop_speech_activity" => {
                let session_id = v
                    .get("sessionId")
                    .and_then(|x| x.as_str())
                    .unwrap_or("agent:main:main")
                    .to_string();
                let activity_id = v
                    .get("activityId")
                    .and_then(|x| x.as_str())
                    .map(str::to_string);
                let request_id = v
                    .get("requestId")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let result = client
                    .stop_speech_activity(session_id, activity_id.clone())
                    .await;
                let payload = match result {
                    Ok(ok) => serde_json::json!({
                        "type": "speech_activity_stopped",
                        "requestId": request_id,
                        "activityId": activity_id,
                        "ok": ok,
                    }),
                    Err(e) => serde_json::json!({
                        "type": "error",
                        "requestId": request_id,
                        "activityId": activity_id,
                        "message": format!("grpc stop speech activity: {}", e),
                    }),
                };
                let _ = app.emit("agent_response", &payload.to_string());
            }
            "control_speech_activity" => {
                let session_id = v
                    .get("sessionId")
                    .and_then(|x| x.as_str())
                    .unwrap_or("agent:main:main")
                    .to_string();
                let activity_id = v
                    .get("activityId")
                    .and_then(|x| x.as_str())
                    .map(str::to_string);
                let action = v
                    .get("action")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let request_id = v
                    .get("requestId")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let result = client
                    .control_speech_activity(session_id, activity_id.clone(), action.clone())
                    .await;
                let payload = match result {
                    Ok(ok) => serde_json::json!({
                        "type": "speech_activity_controlled",
                        "requestId": request_id,
                        "activityId": activity_id,
                        "action": action,
                        "ok": ok,
                    }),
                    Err(e) => serde_json::json!({
                        "type": "error",
                        "requestId": request_id,
                        "activityId": activity_id,
                        "message": format!("grpc control speech activity: {}", e),
                    }),
                };
                let _ = app.emit("agent_response", &payload.to_string());
            }
            "approval_response" => {
                let approve = v.get("decision").and_then(|x| x.as_str()) == Some("approve");
                let rid = v
                    .get("requestId")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let tcid = v
                    .get("toolCallId")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let _ = client.approval_response(rid, tcid, approve).await;
            }
            "reload_settings" | "set_workspace" => {
                // ?ъ슜?먭? naia-os ?ㅼ젙?먯꽌 紐⑤뜽/?꾨줈諛붿씠??援먯껜 ??writeNaiaConfig(config.json 湲곕줉) 吏곹썑 ?몃━嫄?
                // ?먯씠?꾪듃媛 naia-settings ?щ줈?????쒖꽦 config 瑜?swap(?뺣낯 R1-2: "startup-only 湲덉?", 硫깅벑).
                // ?ш린???놁씠 紐⑤뜽 ?꾪솚???ㅼ젣 諛섏쁺?섍쾶 ?섎뒗 寃곗꽑(=?ъ슜??"紐⑤뜽 ??諛붾? ?뚭? 李⑤떒).
                match client.set_workspace(adk_path.clone()).await {
                    Ok(r) => log_both(&format!(
                        "[Naia] ReloadSettings ??loaded={} {}/{}",
                        r.loaded, r.provider, r.model
                    )),
                    Err(e) => log_verbose(&format!("[Naia] ReloadSettings ?ㅽ뙣: {}", e)),
                }
            }
            "tool_request" => {
                // ??directToolCall(湲곕룞 ??skill_voicewake/skill_config/skill_sessions ?? ??new-core 誘몄??먯씠??
                // 諛섎뱶??利됱떆 error ?묐떟?댁빞 ?몄씠 120s ?됱뿉 鍮좎?吏 ?딅뒗???쒕∼ 湲덉?, 援?stdio ?숈옉 蹂듭썝).
                let rid = v
                    .get("requestId")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let rid_err = rid.clone();
                let tool = v
                    .get("toolName")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
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
                    // transport ?먮윭 ??利됱떆 error ?묐떟 ????洹몃윭硫???directToolCall ????꾩븘?껉퉴吏 ??codex #5).
                    if let Err(e) = c.tool_request(rid_err.clone(), tool, emit).await {
                        let err = serde_json::json!({"type":"error","requestId":rid_err,"message":format!("grpc tool_request: {}", e)}).to_string();
                        let _ = app_err.emit("agent_response", &err);
                    }
                });
            }
            // ?? UC-PANEL FR-PANEL: ?섍꼍 panel skill(BGM쨌釉뚮씪?곗?쨌workspace) ?멤넂agent 諛곗꽑(??`_=>{}` drop ?쒓굅) ??
            "panel_skills" => {
                // FR-PANEL-1 ?깅줉: wire tools ??pb::ToolSpec(parameters?묳SON 臾몄옄?? tier?뭀ption<i32>).
                let panel_id = v
                    .get("appId")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let tools: Vec<agent_grpc::pb::ToolSpec> = v
                    .get("tools")
                    .and_then(|t| t.as_array())
                    .map(|arr| {
                        arr.iter()
                            .map(|t| agent_grpc::pb::ToolSpec {
                                name: t
                                    .get("name")
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                                description: t
                                    .get("description")
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                                parameters_json: t
                                    .get("parameters")
                                    .map(|p| p.to_string())
                                    .unwrap_or_else(|| "{}".to_string()),
                                tier: t.get("tier").and_then(|x| x.as_i64()).map(|n| n as i32),
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let mut c = client.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = c.register_panel_skills(panel_id, tools).await;
                });
            }
            "panel_skills_clear" => {
                let panel_id = v
                    .get("appId")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let mut c = client.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = c.clear_panel_skills(panel_id).await;
                });
            }
            "skill_list" => {
                // ListSkills ??skill_list_response(??fetchAgentSkills 湲곕? ?뺥깭). parameters_json ??parameters ?뚯떛.
                let rid = v
                    .get("requestId")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
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
                        Err(e) => {
                            let _ = app2.emit("agent_response", &serde_json::json!({"type":"error","requestId":rid,"message":format!("grpc list_skills: {}", e)}).to_string());
                        }
                    }
                });
            }
            "panel_tool_result" => {
                // FR-PANEL-3 寃곌낵 二쇱엯: ??panel ?ㅽ뻾 寃곌낵 ??agent chat 猷⑦봽 pending resolve.
                let rid = v
                    .get("requestId")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let tcid = v
                    .get("toolCallId")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let output = v
                    .get("result")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let success = v.get("success").and_then(|x| x.as_bool()).unwrap_or(false);
                let activity_id = v
                    .get("activityId")
                    .and_then(|x| x.as_str())
                    .map(str::to_string);
                let mut c = client.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = c
                        .panel_tool_result(rid, tcid, output, success, activity_id)
                        .await;
                });
            }
            "app_install" => {
                // M1: ?⑤꼸 ?ㅼ튂???대쾲 UC-PANEL ?ㅼ퐫??諛?proto RPC 誘몄젙?? ??AppInstallDialog 臾댄븳 濡쒕뵫 諛⑹? ?꾪빐
                //   利됱떆 誘몄????묐떟(??dialog ???낅┰ raw listener ??router ?고쉶 吏곸젒 ?섏떊). 湲곕뒫?붾뒗 蹂꾨룄 ?댁뒋.
                let _ = app.emit("agent_response", &serde_json::json!({"type":"app_install_result","success":false,"error":"???ㅼ튂???꾩옱 誘몄???new-core ?ㅼ퐫??諛?"}).to_string());
            }
            _ => {}
        }
    }
    let _ = activity_shutdown_tx.send(true);
    log_verbose("[Naia] agent dispatcher ended");
}

/// Spawn the standalone YouTube BGM HTTP server (port 18791) ??#335.
///
/// Mirrors `spawn_agent_core`'s tsx-direct resolution pattern (node + tsx
/// cli.mjs from the agent's node_modules, npx fallback). Required because
/// when the standalone naia-agent submodule is preferred (lib.rs:912-928),
/// embedded `agent/src/index.ts::startYoutubeServer()` never runs.
///
/// Safety guarantees mirrored from `spawn_agent_core`:
///  - stderr ??~/.naia/logs/bgm-server-stderr.log (crashes visible in GUI mode)
///  - hide_console on Windows (no console flash in release builds)
///  - kill() called on Tauri WindowEvent::Destroyed (no orphan process)
fn spawn_youtube_bgm_server(app_handle: &AppHandle) -> Result<BgmServerProcess, String> {
    // Node binary ??same resolution chain as spawn_agent_core
    let node_path = resolve_spawn_node(app_handle, "NAIA_BGM_NODE_PATH");
    log_both(&format!("[Naia] node = {}", node_path));

    // BGM entry script ???섍꼍 ?ъ씠?쒖뭅 `@naia/bgm-sidecar` (packages/bgm-sidecar).
    // ?섍꼍(environment) ?덉씠???쒖?(docs/brain-body-environment.md): youtube 異붿텧 ?쒕쾭????substrate)??
    // ?뚯쑀?섎뒗 ?낅┰ ?ъ씠?쒖뭅?? 怨쇨굅??援?monorepo ??naia-os/agent/src/ ???덉뿀?쇰굹(=#335 split ?꾨씫 ?먯씤),
    // ???뚰겕?ㅽ럹?댁뒪 ?⑦궎吏濡??댁쟾. 鍮뚮뱶 ?곗텧臾?dist/*.js) = plain node(tsx 遺덉슂). legacy agent 寃쎈줈??fallback.
    let script_path = std::env::var("NAIA_BGM_SCRIPT").unwrap_or_else(|_| {
        let is_flatpak = std::env::var("FLATPAK").map(|v| v == "1").unwrap_or(false);

        // Dev: prefer source tree
        if !is_flatpak {
            let candidates = [
                "../../bgm-sidecar/dist/bgm-server-bin.js", // shell sidecar (from src-tauri/) ???섍꼍 ?쒖?
                "../bgm-sidecar/dist/bgm-server-bin.js",    // shell sidecar (from shell/)
                "../../agent/src/bgm-server-bin.ts", // legacy embedded agent (from src-tauri/)
                "../agent/src/bgm-server-bin.ts",    // legacy (from shell/)
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
                .join("bgm-sidecar")
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

    // stderr ??log file (same pattern as spawn_agent_core lines 1047-1056)
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
    let health_nonce = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("Failed to create BGM health nonce: {e}"))?
            .as_nanos()
    );
    cmd.env("NAIA_BGM_HEALTH_NONCE", &health_nonce);

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

    // Readiness probe ??poll /health for up to 3s (#335 codex review finding
    // 2). Catches EADDRINUSE and other startup failures that the spawn handle
    // can't see (server.on("error") in youtube-server.ts logs but doesn't exit).
    // Non-fatal: BGM is optional; we only log a warning on timeout so users
    // see a recovery hint in ~/.naia/logs/naia.log.
    if !probe_bgm_server_ready(std::time::Duration::from_secs(3), &health_nonce) {
        log_both(
            "[Naia] WARN BGM server did not respond on http://127.0.0.1:18791/health within 3s",
        );
        log_both(
            "[Naia] WARN BGM player may show connection-refused; restart the app or kill any stray Node process bound to 18791",
        );
    } else {
        log_both("[Naia] BGM server ready @ http://127.0.0.1:18791/health");
    }

    Ok(BgmServerProcess { child })
}

/// Poll `http://127.0.0.1:18791/health` every 100 ms for up to `timeout`.
/// Returns `true` as soon as a 2xx response arrives; `false` on timeout.
/// Used by `spawn_youtube_bgm_server` to detect EADDRINUSE / startup failure.
fn bgm_health_matches(body: &serde_json::Value, expected_nonce: &str) -> bool {
    body.get("ok").and_then(|value| value.as_bool()) == Some(true)
        && body.get("nonce").and_then(|value| value.as_str()) == Some(expected_nonce)
}

fn probe_bgm_server_ready(timeout: std::time::Duration, expected_nonce: &str) -> bool {
    let url = "http://127.0.0.1:18791/health";
    let deadline = std::time::Instant::now() + timeout;
    let interval = std::time::Duration::from_millis(100);
    loop {
        // Short per-request timeout so a stalled probe doesn't burn the budget.
        let agent = ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_millis(200))
            .build();
        if let Ok(resp) = agent.get(url).call() {
            if resp.status() >= 200
                && resp.status() < 300
                && resp
                    .into_json::<serde_json::Value>()
                    .map(|body| bgm_health_matches(&body, expected_nonce))
                    .unwrap_or(false)
            {
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

    // Log approval_decision events (shell?뭓gent direction)
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

        // gRPC: 硫붿떆吏瑜?dispatcher task 濡??꾨떖(鍮꾩감??mpsc). send ?ㅽ뙣 = dispatcher/agent 醫낅즺 ??restart.
        match process.tx.send(message.to_string()) {
            Ok(_) => Ok(()),
            Err(e) => {
                log_both(&format!("[Naia] agent tx send ?ㅽ뙣: {}", e));
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
                return Err("agent-core restart debounced ??too many restarts".to_string());
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
    let restarted = with_discord_lifecycle(&state.discord_lifecycle, || {
        let mut previous = {
            let mut guard = lock_or_recover(&state.agent, "state.agent(restart_agent)");
            guard.take()
        };
        if let Some(process) = previous.as_mut() {
            if let Err(error) = terminate_and_reap_discord_child(&mut process.child) {
                let mut guard = lock_or_recover(&state.agent, "state.agent(restart_agent)");
                *guard = previous;
                return Err(error);
            }
            if !process.finish_owned_cleanup(true).complete(true) {
                drop(previous);
                return Err("agent_owned_cleanup_incomplete".to_string());
            }
        }
        drop(previous);
        match spawn_agent_core(
            app_handle,
            db,
            &state.discord_quarantined,
            &state.discord_pending_reapers,
            false,
        ) {
            Ok(process) => {
                let mut guard = lock_or_recover(&state.agent, "state.agent(restart_agent)");
                *guard = Some(process);
                log_both("[Naia] agent-core restarted");
                Ok(())
            }
            Err(e) => Err(format!("Restart failed: {}", e)),
        }
    });
    restarted?;
    std::thread::sleep(std::time::Duration::from_millis(300));
    // Replay cached startup credentials so agent recovers auth state after crash.
    replay_startup_messages_to_agent(state);
    send_to_agent(state, message, None, audit_db)
}

fn restart_agent_for_discord_config(
    state: &AppState,
    app_handle: &AppHandle,
    audit_db: &audit::AuditDb,
    expected_generation: Option<u64>,
) -> Result<(), String> {
    with_discord_lifecycle(&state.discord_lifecycle, || {
        run_discord_repair_activation(
            &state.discord_quarantined,
            || clear_discord_quarantine_marker(&discord_runtime_dir()?),
            || {
                restart_agent_for_discord_config_unmarked(
                    state,
                    app_handle,
                    audit_db,
                    expected_generation,
                )
            },
            || write_discord_quarantine_marker(&discord_runtime_dir()?),
        )
    })
}

fn restart_agent_for_discord_config_unmarked(
    state: &AppState,
    app_handle: &AppHandle,
    audit_db: &audit::AuditDb,
    expected_generation: Option<u64>,
) -> Result<(), String> {
    log_both("[Naia] Restarting agent-core for Discord configuration...");
    revoke_discord_runtime_authority()?;
    let mut previous = {
        let mut guard =
            lock_or_recover(&state.agent, "state.agent(restart_agent_for_discord_config)");
        guard.take()
    };
    if let Some(process) = previous.as_mut() {
        if let Err(error) = terminate_and_reap_discord_child(&mut process.child) {
            let mut guard =
                lock_or_recover(&state.agent, "state.agent(restart_agent_for_discord_config)");
            *guard = previous;
            return Err(error);
        }
    }
    drop(previous);
    // The old process may have raced the first tombstone and rewritten status
    // while it was terminating. Reassert revocation after it is fully reaped.
    revoke_discord_runtime_authority()?;
    match spawn_agent_core(
        app_handle,
        audit_db,
        &state.discord_quarantined,
        &state.discord_pending_reapers,
        true,
    ) {
        Ok(process) => {
            let mut guard =
                lock_or_recover(&state.agent, "state.agent(restart_agent_for_discord_config)");
            *guard = Some(process);
            drop(guard);
            replay_startup_messages_to_agent(state);
            if let Err(error) = wait_for_discord_runtime_ready(expected_generation) {
                let mut failed = {
                    let mut guard = lock_or_recover(
                        &state.agent,
                        "state.agent(restart_agent_for_discord_config)",
                    );
                    guard.take()
                };
                if let Some(process) = failed.as_mut() {
                    if let Err(cleanup_error) =
                        terminate_and_reap_discord_child(&mut process.child)
                    {
                        let mut guard = lock_or_recover(
                            &state.agent,
                            "state.agent(restart_agent_for_discord_config)",
                        );
                        *guard = failed;
                        let _ = revoke_discord_runtime_authority();
                        return Err(format!("{error}; {cleanup_error}"));
                    }
                }
                drop(failed);
                revoke_discord_runtime_authority()?;
                return Err(error);
            }
            log_both("[Naia] agent-core restarted for Discord configuration");
            Ok(())
        }
        Err(error) => {
            revoke_discord_runtime_authority()?;
            Err(format!("discord_agent_restart_failed: {error}"))
        }
    }
}

trait DiscordChildLifecycle {
    fn request_termination(&mut self) -> std::io::Result<()>;
    fn has_exited(&mut self) -> std::io::Result<bool>;
}

impl DiscordChildLifecycle for Child {
    fn request_termination(&mut self) -> std::io::Result<()> {
        self.kill()
    }

    fn has_exited(&mut self) -> std::io::Result<bool> {
        self.try_wait().map(|status| status.is_some())
    }
}

fn terminate_and_reap_discord_child(child: &mut Child) -> Result<(), String> {
    let started = std::time::Instant::now();
    terminate_and_reap_discord_child_with(
        child,
        std::time::Duration::from_secs(5),
        move || started.elapsed(),
        std::thread::sleep,
    )
}

fn terminate_and_reap_discord_child_with<C, N, S>(
    child: &mut C,
    timeout: std::time::Duration,
    mut now: N,
    mut sleep: S,
) -> Result<(), String>
where
    C: DiscordChildLifecycle,
    N: FnMut() -> std::time::Duration,
    S: FnMut(std::time::Duration),
{
    if child
        .has_exited()
        .map_err(|_| "discord_agent_reap_failed".to_string())?
    {
        return Ok(());
    }
    child
        .request_termination()
        .map_err(|_| "discord_agent_terminate_failed".to_string())?;
    let started = now();
    let poll = std::time::Duration::from_millis(10);
    loop {
        if child
            .has_exited()
            .map_err(|_| "discord_agent_reap_failed".to_string())?
        {
            return Ok(());
        }
        let elapsed = now().saturating_sub(started);
        if elapsed >= timeout {
            return Err("discord_agent_reap_timeout".to_string());
        }
        sleep(poll.min(timeout.saturating_sub(elapsed)));
    }
}

fn revoke_discord_runtime_files(runtime: &std::path::Path) -> Result<(), String> {
    let tombstone = serde_json::to_vec(&serde_json::json!({
        "version": 1,
        // Binding generations are numeric. This value can never authorize an
        // old or future configured generation.
        "generation": "revoked",
    }))
    .map_err(|_| "discord_authority_invalid".to_string())?;
    let authority_result = write_owner_only_atomic(&runtime.join("authority.json"), &tombstone);
    let status_result = match std::fs::remove_file(runtime.join("status.json")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("discord_status_revoke_failed".to_string()),
    };
    authority_result.and(status_result)
}

fn discord_quarantine_marker_path(runtime: &std::path::Path) -> std::path::PathBuf {
    runtime.join("quarantine.json")
}

fn write_discord_quarantine_marker(runtime: &std::path::Path) -> Result<(), String> {
    let marker = serde_json::to_vec(&serde_json::json!({
        "version": 1,
        "state": "quarantined",
    }))
    .map_err(|_| "discord_quarantine_marker_invalid".to_string())?;
    write_owner_only_atomic(&discord_quarantine_marker_path(runtime), &marker)
        .map_err(|_| "discord_quarantine_marker_write_failed".to_string())
}

fn quarantine_discord_runtime_files(runtime: &std::path::Path) -> Result<(), String> {
    let marker_result = write_discord_quarantine_marker(runtime);
    let revoke_result = revoke_discord_runtime_files(runtime);
    marker_result.and(revoke_result)
}

fn issue_discord_runtime_authority<W, Q>(
    quarantined: &std::sync::atomic::AtomicBool,
    write_authority: W,
    quarantine_runtime: Q,
) -> Result<(), String>
where
    W: FnOnce() -> Result<(), String>,
    Q: FnOnce() -> Result<(), String>,
{
    if write_authority().is_ok() {
        return Ok(());
    }
    quarantined.store(true, std::sync::atomic::Ordering::Release);
    match quarantine_runtime() {
        Ok(()) => Err("discord_authority_write_failed".to_string()),
        Err(_) => Err("discord_authority_write_quarantine_uncertain".to_string()),
    }
}

#[cfg(test)]
fn fail_discord_agent_startup<T, K, Q>(
    startup_error: String,
    discord_runtime_armed: bool,
    quarantined: &std::sync::atomic::AtomicBool,
    terminate_child: K,
    quarantine_runtime: Q,
) -> Result<T, String>
where
    K: FnOnce() -> Result<(), String>,
    Q: FnOnce() -> Result<(), String>,
{
    if discord_runtime_armed {
        quarantined.store(true, std::sync::atomic::Ordering::Release);
    }
    let terminate_result = terminate_child();
    let quarantine_result = if discord_runtime_armed {
        quarantine_runtime()
    } else {
        Ok(())
    };
    finalize_discord_startup_failure(
        startup_error,
        discord_runtime_armed,
        quarantined,
        terminate_result.is_ok(),
        quarantine_result.is_ok(),
        |_, _| {},
    )
}

fn finalize_discord_startup_failure<T, F>(
    startup_error: String,
    discord_runtime_armed: bool,
    quarantined: &std::sync::atomic::AtomicBool,
    child_reaped: bool,
    runtime_quarantined: bool,
    finish_ownership: F,
) -> Result<T, String>
where
    F: FnOnce(bool, bool),
{
    if discord_runtime_armed {
        quarantined.store(true, std::sync::atomic::Ordering::Release);
    }
    finish_ownership(child_reaped, runtime_quarantined);
    if discord_runtime_armed && (!child_reaped || !runtime_quarantined) {
        Err("discord_startup_quarantine_uncertain".to_string())
    } else {
        Err(startup_error)
    }
}

fn fail_spawned_discord_agent_startup<T>(
    startup_error: String,
    discord_runtime_armed: bool,
    quarantined: &std::sync::atomic::AtomicBool,
    spawned: &mut SpawnedAgentChild,
) -> Result<T, String> {
    let terminate_result = terminate_and_reap_discord_child(spawned.child_mut());
    let child_reaped = terminate_result.is_ok();
    let outcome = spawned.finish_explicit_cleanup(child_reaped);
    let runtime_quarantined = outcome.superseded || outcome.runtime_confirmed;
    finalize_discord_startup_failure(
        startup_error,
        discord_runtime_armed && !outcome.superseded,
        quarantined,
        child_reaped,
        runtime_quarantined,
        |_, _| {},
    )
}

fn clear_discord_quarantine_marker(runtime: &std::path::Path) -> Result<(), String> {
    match std::fs::remove_file(discord_quarantine_marker_path(runtime)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("discord_quarantine_marker_clear_failed".to_string()),
    }
}

fn discord_runtime_activation_allowed(
    quarantined: &std::sync::atomic::AtomicBool,
    runtime: &std::path::Path,
    repair_bypass: bool,
) -> bool {
    if repair_bypass {
        return true;
    }
    if quarantined.load(std::sync::atomic::Ordering::Acquire) {
        return false;
    }
    let marker_allows = discord_quarantine_marker_path(runtime)
        .try_exists()
        .map(|exists| !exists)
        .unwrap_or(false);
    if !marker_allows {
        quarantined.store(true, std::sync::atomic::Ordering::Release);
    }
    marker_allows
}

fn run_discord_repair_activation<C, A, M>(
    quarantined: &std::sync::atomic::AtomicBool,
    clear_marker: C,
    activate: A,
    restore_marker: M,
) -> Result<(), String>
where
    C: FnOnce() -> Result<(), String>,
    A: FnOnce() -> Result<(), String>,
    M: FnOnce() -> Result<(), String>,
{
    if let Err(error) = clear_marker() {
        quarantined.store(true, std::sync::atomic::Ordering::Release);
        return Err(error);
    }
    match activate() {
        Ok(()) => {
            quarantined.store(false, std::sync::atomic::Ordering::Release);
            Ok(())
        }
        Err(error) => {
            quarantined.store(true, std::sync::atomic::Ordering::Release);
            match restore_marker() {
                Ok(()) => Err(error),
                Err(_) => Err("discord_activation_quarantine_uncertain".to_string()),
            }
        }
    }
}

fn revoke_discord_runtime_authority() -> Result<(), String> {
    revoke_discord_runtime_files(&discord_runtime_dir()?)
}

fn wait_for_discord_runtime_ready(expected_generation: Option<u64>) -> Result<(), String> {
    let token_readable = expected_generation.is_none() || read_discord_bot_token().is_ok();
    let Some(expected_generation) =
        discord_runtime_token_prerequisite(expected_generation, token_readable)?
    else {
        return Ok(());
    };
    let settings = std::path::PathBuf::from(current_adk_path()?).join("naia-settings");
    let expected = expected_generation.to_string();
    let runtime = settings.join("discord-runtime");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let status = read_bounded_json::<DiscordRuntimeStatusFile>(
            &runtime.join("status.json"),
            16 * 1024,
        )?;
        let authority = read_bounded_json::<DiscordRuntimeAuthorityFile>(
            &runtime.join("authority.json"),
            16 * 1024,
        )?;
        if discord_runtime_matches_generation(
            &expected,
            status.as_ref(),
            authority.as_ref(),
        ) {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err("discord_agent_ready_timeout".to_string());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
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

/// Frontend log bridge ??prints to Rust stderr AND debug log file (survives crashes).
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

// ?? STT model management commands ??????????????????????????????????

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
/// replayed to agent-core after every restart ??ensuring credentials are never lost on crash.
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
            .and_then(|v| {
                v.get("type")
                    .and_then(|t| t.as_str())
                    .map(|t| t.to_string())
            })
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
/// Filters to idle/running state only ??suspended = disconnected HDMI port.
/// Excludes virtual/loopback sinks.
/// Fallback for WebKitGTK which does not enumerate audiooutput via enumerateDevices().
///
/// Linux only ??on Windows the WebView2 webview enumerates devices natively via
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

/// 濡쒖뺄 cascade VRAM(GB) ?숆린 媛먯? ??start_cascade 媛 loader `--gpu` 濡??섍?.
/// **primary GPU(nvidia-smi 泥?以?留?* 蹂몃떎 ??硫??GPU ?⑹궛 ?????⑥씪 紐⑤뜽? GPU 媛?
/// 遺꾩궛 遺덇?, TP ??蹂꾨룄). 利?3090횞2 硫?48 ???꾨땶 24(per-GPU ?덉궛??留욎쓬).
/// detect_gpu_vram(async, capacity-only)怨??숈씪 nvidia-smi, 釉붾줈??而⑦뀓?ㅽ듃??
fn detect_vram_gb_blocking() -> Option<f64> {
    let output = std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=memory.total", "--format=csv,noheader,nounits"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mib = text.lines().next()?.trim().parse::<f64>().ok()?;
    if mib > 0.0 {
        Some((mib / 1024.0).round())
    } else {
        None
    }
}

fn path_to_string(path: std::path::PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

fn infer_repos_adk_root(adk_path: &str) -> Option<String> {
    let start = std::path::PathBuf::from(adk_path);
    std::iter::once(start.as_path())
        .chain(start.ancestors().skip(1))
        .find(|candidate| {
            candidate
                .join("projects")
                .join("naia-omni-windows-manager")
                .join("loader")
                .exists()
        })
        .map(|candidate| {
            let normalized =
                dunce::canonicalize(candidate).unwrap_or_else(|_| candidate.to_path_buf());
            path_to_string(normalized)
        })
}

/// windows-manager loader ?붾젆?곕━ ?댁꽍(`loader/` 瑜??댁?, `python -m loader` 媛?ν븳 dir).
/// **?꾨쿋??*: ?⑦궎吏 ?깆? 踰덈뱾??loader(resource_dir/cascade-loader)瑜??대떎 ???몃? adk
/// 泥댄겕?꾩썐???섏〈?섏? ?딅뒗??stage-cascade-loader.mjs 媛 鍮뚮뱶???숇큺, agent ?⑦꽩 ?숉삎).
/// ?곗꽑?쒖쐞: NAIA_CASCADE_LOADER_DIR(dev env) > resource_dir/cascade-loader(踰덈뱾) > adk ?대갚.
fn resolve_cascade_loader_dir(app: &tauri::AppHandle, adk_path: &str) -> String {
    if let Ok(d) = std::env::var("NAIA_CASCADE_LOADER_DIR") {
        if !d.trim().is_empty() {
            return d;
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        let bundled = res.join("cascade-loader");
        if bundled.join("loader").exists() {
            let n = dunce::canonicalize(&bundled).unwrap_or(bundled);
            return n.to_string_lossy().to_string();
        }
    }
    // dev ?대갚(踰덈뱾 誘몄〈??+ env 誘몄꽕??: sibling 泥댄겕?꾩썐.
    let repos_adk = infer_repos_adk_root(adk_path)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(adk_path));
    path_to_string(repos_adk.join("projects").join("naia-omni-windows-manager"))
}

/// cascade-stderr.log ??留덉?留?紐?以?loader ?ㅽ뙣 ?ъ쑀 ??venv 誘몄꽕移??????쎌뼱 UI ???꾨떖.
fn read_cascade_stderr_tail() -> String {
    let path = log_dir().join("cascade-stderr.log");
    match std::fs::read_to_string(&path) {
        Ok(c) => c
            .lines()
            .rev()
            .take(6)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string(),
        Err(_) => String::new(),
    }
}

fn read_cascade_loader_profile(manifest: &std::path::Path) -> Option<String> {
    let raw = std::fs::read_to_string(manifest).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let profile = parsed
        .get("gpu")
        .and_then(|gpu| gpu.get("loaderProfile"))
        .and_then(serde_json::Value::as_str)?
        .trim();
    if profile.is_empty()
        || !profile
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    Some(profile.to_string())
}

/// 濡쒖뺄 cascade loader supervisor 瑜??ъ씠?쒖뭅濡?spawn. stdout `CASCADE_READY {json}`
/// ?몃뱶?곗씠?щ줈 以鍮꾩셿猷??먯젙(紐⑤뜽 濡쒕뱶媛 湲몄뼱 timeout ?됰꼮??. ???꾨줈?몄뒪瑜?kill ?섎㈃
/// loader 媛 VoxCPM2 ???먯떇 ?쒕퉬?ㅻ? teardown ?쒕떎(?먭꺽 湲덉?쨌濡쒖뺄 ?꾨쿋??.
fn spawn_cascade(
    loader_dir: &str,
    adk_path: &str,
    vram_gb: Option<f64>,
) -> Result<CascadeProcess, String> {
    let python = std::env::var("NAIA_CASCADE_PYTHON").unwrap_or_else(|_| {
        if cfg!(windows) {
            "python".to_string()
        } else {
            "python3".to_string()
        }
    });
    let manifest = std::path::PathBuf::from(adk_path)
        .join("naia-settings")
        .join("slots-manifest.json");
    let loader_profile = read_cascade_loader_profile(&manifest);
    let inferred_repos_adk = infer_repos_adk_root(adk_path);

    let mut cmd = Command::new(&python);
    cmd.arg("-m")
        .arg("loader")
        .arg("launch")
        .arg("--manifest")
        .arg(manifest.to_string_lossy().as_ref())
        .arg("--adk-root")
        .arg(adk_path)
        .current_dir(loader_dir);
    if std::env::var_os("NAIA_REPOS_ADK").is_none() {
        if let Some(repos_adk) = &inferred_repos_adk {
            cmd.env("NAIA_REPOS_ADK", repos_adk);
        }
    }
    if let Some(profile) = &loader_profile {
        cmd.arg("--profile").arg(profile);
    }
    // 媛먯???primary GPU VRAM ??紐낆떆 ??loader ??蹂댁닔??85% ?먮룞異붿젙 ????ㅺ컪 ?ъ슜
    // (8GB ?뚯꽦 ?⑤룆 6.9G ?곹빀 蹂댁옣). 誘멸컧吏硫?loader 媛 ?먯껜 異붿젙.
    if let Some(v) = vram_gb {
        cmd.arg("--gpu").arg(format!("{}", v));
    }

    let stderr_stdio = {
        let log_path = log_dir().join("cascade-stderr.log");
        // truncate(append ?꾨떂) ??留?湲곕룞留덈떎 ??濡쒓렇. read_cascade_stderr_tail ??
        // ?댁쟾 ?ㅽ뻾??stale 以??? ??"0 ?쒕퉬??)??媛숈씠 蹂댁뿬二쇱? ?딄쾶.
        std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&log_path)
            .ok()
            .map(Stdio::from)
            .unwrap_or_else(Stdio::inherit)
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(stderr_stdio);
    #[cfg(windows)]
    platform::hide_console(&mut cmd);

    log_both(&format!(
        "[Naia] Starting local cascade: {} -m loader launch (cwd={}, profile={}, repos_adk={})",
        python,
        loader_dir,
        loader_profile.as_deref().unwrap_or("manifest"),
        std::env::var("NAIA_REPOS_ADK")
            .ok()
            .or(inferred_repos_adk)
            .as_deref()
            .unwrap_or("manifest")
    ));
    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "Failed to spawn cascade loader: {} (loader_dir={})",
            e, loader_dir
        )
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to get cascade stdout".to_string())?;
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<String>();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut sent = false;
        for line in reader.lines().map_while(Result::ok) {
            if !sent {
                if let Some(rest) = line.strip_prefix("CASCADE_READY ") {
                    let _ = ready_tx.send(rest.trim().to_string());
                    sent = true;
                    continue;
                }
            }
            log_verbose(&format!("[cascade] {}", line));
        }
        log_verbose("[Naia] cascade loader stdout reader ended");
    });

    // CASCADE_READY ?몃뱶?곗씠?????? loader 媛 議곌린 醫낅즺(venv/紐⑤뜽 遺??톚lan 0?쒕퉬?????섎㈃
    // 180s 湲곕떎由ъ? ?딄퀬 **利됱떆** stderr 瑗щ━瑜??쎌뼱 紐낇솗???ㅽ뙣?쒕떎(?섏걶 UX ?뚰뵾).
    // ?뺤긽 湲곕룞(紐⑤뜽 濡쒕뱶 ~77s)? 理쒕? 180s 源뚯? ?湲?
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(180);
    let ready = loop {
        match ready_rx.recv_timeout(std::time::Duration::from_millis(400)) {
            Ok(r) => break r,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                // stdout reader 醫낅즺 = loader ?꾨줈?몄뒪 exit(ready 誘몄닔??.
                let _ = child.try_wait();
                let tail = read_cascade_stderr_tail();
                return Err(format!(
                    "濡쒖뺄 ?뚯꽦 ?붿쭊???쒖옉?섏? 紐삵뻽?듬땲??loader 醫낅즺).{}",
                    if tail.is_empty() {
                        String::new()
                    } else {
                        format!("\n{}", tail)
                    }
                ));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if let Ok(Some(status)) = child.try_wait() {
                    let tail = read_cascade_stderr_tail();
                    return Err(format!(
                        "濡쒖뺄 ?뚯꽦 ?붿쭊???쒖옉?섏? 紐삵뻽?듬땲??loader 醫낅즺 code={:?}).{}",
                        status.code(),
                        if tail.is_empty() {
                            String::new()
                        } else {
                            format!("\n{}", tail)
                        }
                    ));
                }
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    return Err(
                        "cascade readiness handshake timeout (CASCADE_READY 誘몄닔??".to_string()
                    );
                }
            }
        }
    };

    write_pid_file("cascade", child.id());
    log_both(&format!("[Naia] local cascade ready: {}", ready));
    Ok(CascadeProcess { child, ready })
}

/// R2.2b: ?ㅼ젙?먯꽌 "濡쒖뺄 ?뚯꽦/cascade ?쒖옉". manifest(R2.2a 媛 write) + 媛먯? VRAM(total)?쇰줈
/// loader supervisor 瑜??꾩슫?? ?대? 媛??以묒씠硫?湲곗〈 ready 諛섑솚(硫깅벑).
#[tauri::command]
async fn start_cascade(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    {
        let mut guard = lock_or_recover(&state.cascade, "cascade");
        if let Some(c) = guard.as_mut() {
            if matches!(c.child.try_wait(), Ok(None)) {
                return Ok(c.ready.clone());
            }
            let _ = guard.take(); // 二쎌뼱?덉쑝硫??뺣━ ???ш린??
        }
    }
    let adk_path = dirs::home_dir()
        .and_then(|h| std::fs::read_to_string(h.join(".naia").join("adk-path")).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "adk path not set (naia-settings ?뚰겕?ㅽ럹?댁뒪 誘몄꽕??".to_string())?;
    // ?꾨쿋?? 踰덈뱾??loader(resource_dir) ?곗꽑 ???몃? adk 泥댄겕?꾩썐 誘몄쓽議?
    let loader_dir = resolve_cascade_loader_dir(&app, &adk_path);

    let proc = tokio::task::spawn_blocking(move || {
        let vram = detect_vram_gb_blocking();
        spawn_cascade(&loader_dir, &adk_path, vram)
    })
    .await
    .map_err(|e| format!("task error: {e}"))??;

    let ready = proc.ready.clone();
    *lock_or_recover(&state.cascade, "cascade") = Some(proc);
    Ok(ready)
}

/// R2.2b: 濡쒖뺄 cascade 以묒?(supervisor kill ??loader 媛 ?먯떇 ?쒕퉬??teardown).
#[tauri::command]
async fn stop_cascade(state: tauri::State<'_, AppState>) -> Result<(), String> {
    if let Some(mut c) = lock_or_recover(&state.cascade, "cascade").take() {
        log_verbose("[Naia] Terminating local cascade...");
        let _ = c.child.kill();
    }
    // Child::kill force-terminates the Python supervisor on Windows, so its
    // finally block cannot reliably release GPU-owning grandchildren.
    platform::kill_stale_cascade();
    remove_pid_file("cascade");
    Ok(())
}

/// R2.2b: 濡쒖뺄 cascade 媛???곹깭(?ㅼ젙 ?좉? ?쒖떆??.
#[tauri::command]
async fn cascade_status(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let mut guard = lock_or_recover(&state.cascade, "cascade");
    Ok(match guard.as_mut() {
        Some(c) => matches!(c.child.try_wait(), Ok(None)),
        None => false,
    })
}

/// R2.2a: slots-manifest.json write(`{adk}/naia-settings/slots-manifest.json`).
/// naia-os 媛 write, windows-manager loader 媛 read(Phase 2 怨꾩빟). 鍮꾨? 0(鍮뚮뜑媛 strip).
#[tauri::command]
async fn write_slots_manifest(adk_path: String, json: String) -> Result<(), String> {
    let dir = std::path::PathBuf::from(&adk_path).join("naia-settings");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("slots-manifest.json"), json).map_err(|e| e.to_string())
}

/// Detect the primary GPU's total VRAM in GB via `nvidia-smi` (NVIDIA only).
///
/// Returns a whole-GB number (marketed VRAM is whole GB; nvidia-smi reports
/// MiB, e.g. an RTX 4070 12 GB = ~12282 MiB ??11.99 GiB ??rounds to 12) or null
/// when nvidia-smi is absent / non-NVIDIA / unparseable ??the settings UI then
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

    // Absent nvidia-smi / non-NVIDIA host ??null (not an error).
    let output = match output {
        Ok(o) if o.status.success() => o,
        _ => return Ok(serde_json::Value::Null),
    };

    let text = String::from_utf8_lossy(&output.stdout);
    // First line = primary GPU's total memory in MiB.
    let mib = text
        .lines()
        .next()
        .and_then(|l| l.trim().parse::<f64>().ok());

    Ok(match mib {
        Some(m) if m > 0.0 => serde_json::json!((m / 1024.0).round()),
        _ => serde_json::Value::Null,
    })
}

/// Check if Naia Gateway is reachable on localhost
/// Re-enable Korean/CJK IME for the WebView2 child HWND.
/// Called from the frontend when a text input gains focus so the ????toggle
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
    result
        .map(|_| ())
        .map_err(|e| format!("Failed to open log file: {}", e))
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

const DISCORD_TOKEN_KEY: &str = "NAIA_DISCORD_BOT_TOKEN";

fn current_adk_path() -> Result<String, String> {
    let path = dirs::home_dir()
        .and_then(|home| std::fs::read_to_string(home.join(".naia").join("adk-path")).ok())
        .ok_or_else(|| "adk_path_unavailable".to_string())?;
    let path = path.trim();
    if path.is_empty() {
        Err("adk_path_unavailable".to_string())
    } else {
        Ok(path.to_string())
    }
}

fn trim_secret_newline(value: &mut zeroize::Zeroizing<Vec<u8>>) {
    while matches!(value.last(), Some(b'\n' | b'\r')) {
        value.pop();
    }
}

#[cfg(any(not(target_os = "windows"), test))]
#[derive(Clone, Copy)]
enum AgentSecretLookupPlatform {
    #[cfg(any(target_os = "macos", test))]
    MacOs,
    #[cfg(any(not(any(target_os = "windows", target_os = "macos")), test))]
    Linux,
}

#[cfg(any(not(target_os = "windows"), test))]
fn classify_agent_secret_lookup(
    platform: AgentSecretLookupPlatform,
    success: bool,
    _exit_code: Option<i32>,
    _stderr: &[u8],
) -> Result<(), String> {
    if success {
        return Ok(());
    }
    let absent = match platform {
        #[cfg(any(target_os = "macos", test))]
        AgentSecretLookupPlatform::MacOs => _exit_code == Some(44),
        #[cfg(any(not(any(target_os = "windows", target_os = "macos")), test))]
        AgentSecretLookupPlatform::Linux => _exit_code == Some(1) && _stderr.is_empty(),
    };
    if absent {
        Err("token_not_found".to_string())
    } else {
        Err("keychain_unavailable".to_string())
    }
}

#[cfg(any(target_os = "windows", test))]
fn classify_agent_secret_file_presence(
    presence: std::io::Result<bool>,
) -> Result<bool, String> {
    presence.map_err(|_| "keychain_unavailable".to_string())
}

fn read_agent_secret(
    adk_path: &str,
    env_key: &str,
) -> Result<zeroize::Zeroizing<Vec<u8>>, String> {
    #[cfg(not(target_os = "windows"))]
    let _ = adk_path;
    #[cfg(target_os = "windows")]
    {
        let file = std::path::PathBuf::from(adk_path)
            .join("naia-settings")
            .join(".keys")
            .join(format!("{env_key}.dpapi"));
        if !classify_agent_secret_file_presence(file.try_exists())? {
            return Err("token_not_found".to_string());
        }
        let path = file.to_string_lossy().replace('\'', "''").replace('\\', "\\\\");
        let script = format!(
            "Add-Type -AssemblyName System.Security; $e=[IO.File]::ReadAllBytes('{path}'); \
             $b=[Security.Cryptography.ProtectedData]::Unprotect($e,$null,\
             [Security.Cryptography.DataProtectionScope]::CurrentUser); \
             [Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))"
        );
        let mut command = std::process::Command::new("powershell");
        command.args(["-NonInteractive", "-Command", &script]);
        platform::hide_console(&mut command);
        let output = command.output().map_err(|_| "keychain_unavailable".to_string())?;
        if !output.status.success() {
            return Err("keychain_unavailable".to_string());
        }
        std::str::from_utf8(&output.stdout)
            .map_err(|_| "keychain_value_invalid".to_string())?;
        return Ok(zeroize::Zeroizing::new(output.stdout));
    }
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("security")
            .args(["find-generic-password", "-a", env_key, "-s", "naia-agent", "-w"])
            .output()
            .map_err(|_| "keychain_unavailable".to_string())?;
        classify_agent_secret_lookup(
            AgentSecretLookupPlatform::MacOs,
            output.status.success(),
            output.status.code(),
            &output.stderr,
        )?;
        let mut value = zeroize::Zeroizing::new(output.stdout);
        trim_secret_newline(&mut value);
        return Ok(value);
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let output = std::process::Command::new("secret-tool")
            .args(["lookup", "service", "naia-agent", "account", env_key])
            .output()
            .map_err(|_| "keychain_unavailable".to_string())?;
        classify_agent_secret_lookup(
            AgentSecretLookupPlatform::Linux,
            output.status.success(),
            output.status.code(),
            &output.stderr,
        )?;
        let mut value = zeroize::Zeroizing::new(output.stdout);
        trim_secret_newline(&mut value);
        Ok(value)
    }
}

fn read_discord_bot_token() -> Result<zeroize::Zeroizing<Vec<u8>>, String> {
    read_agent_secret(&current_adk_path()?, DISCORD_TOKEN_KEY)
}

fn validate_discord_token(token: &[u8]) -> Result<(), String> {
    if token.is_empty()
        || token.len() > 512
        || !token.iter().all(|byte| (b'!'..=b'~').contains(byte))
    {
        Err("token_invalid".to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
async fn discord_bot_token_available() -> Result<bool, String> {
    match read_discord_bot_token() {
        Ok(token) => {
            validate_discord_token(&token)?;
            Ok(true)
        }
        Err(error) if error == "token_not_found" => Ok(false),
        Err(error) => Err(error),
    }
}

#[derive(serde::Deserialize)]
struct DiscordRuntimeStatusFile {
    generation: String,
    state: String,
    code: Option<String>,
}

#[derive(serde::Deserialize)]
struct DiscordRuntimeAuthorityFile {
    generation: String,
}

fn discord_runtime_matches_generation(
    expected: &str,
    status: Option<&DiscordRuntimeStatusFile>,
    authority: Option<&DiscordRuntimeAuthorityFile>,
) -> bool {
    status.is_some_and(|value| value.generation == expected && value.state == "ready")
        && authority.is_some_and(|value| value.generation == expected)
}

fn discord_runtime_status_for_generation<'a>(
    expected: Option<&str>,
    status: Option<&'a DiscordRuntimeStatusFile>,
) -> Option<&'a DiscordRuntimeStatusFile> {
    status.filter(|status| expected.is_some_and(|value| status.generation == value))
}

fn discord_runtime_token_prerequisite(
    expected_generation: Option<u64>,
    token_readable: bool,
) -> Result<Option<u64>, String> {
    match (expected_generation, token_readable) {
        (Some(generation), true) => Ok(Some(generation)),
        (Some(_), false) => Err("discord_token_unavailable".to_string()),
        (None, _) => Ok(None),
    }
}

fn discord_runtime_is_authoritative(
    token_configured: bool,
    expected: Option<&str>,
    status: Option<&DiscordRuntimeStatusFile>,
    authority: Option<&DiscordRuntimeAuthorityFile>,
) -> bool {
    token_configured
        && expected.is_some_and(|value| {
            discord_runtime_matches_generation(value, status, authority)
        })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscordConnectionStatus {
    token_configured: bool,
    generation: Option<u64>,
    state: String,
    code: Option<String>,
    authoritative: bool,
}

#[tauri::command]
async fn discord_connection_status() -> Result<DiscordConnectionStatus, String> {
    let token_configured = discord_bot_token_available().await?;
    let settings = std::path::PathBuf::from(current_adk_path()?).join("naia-settings");
    let manifest =
        read_discord_binding_manifest(&settings.join("discord-bindings.json"))?;
    let generation = manifest.as_ref().map(|value| value.generation);
    let runtime = settings.join("discord-runtime");
    let status =
        read_bounded_json::<DiscordRuntimeStatusFile>(&runtime.join("status.json"), 16 * 1024)?;
    let authority = read_bounded_json::<DiscordRuntimeAuthorityFile>(
        &runtime.join("authority.json"),
        16 * 1024,
    )?;
    let expected = generation.map(|value| value.to_string());
    let current_status =
        discord_runtime_status_for_generation(expected.as_deref(), status.as_ref());
    let authoritative = discord_runtime_is_authoritative(
        token_configured,
        expected.as_deref(),
        status.as_ref(),
        authority.as_ref(),
    );
    let state = if !token_configured {
        "disconnected".to_string()
    } else if authoritative {
        "ready".to_string()
    } else {
        current_status
            .map(|status| status.state.clone())
            .unwrap_or_else(|| "configured".to_string())
    };
    Ok(DiscordConnectionStatus {
        token_configured,
        generation,
        state,
        code: token_configured
            .then(|| current_status.and_then(|value| value.code.clone()))
            .flatten(),
        authoritative,
    })
}

fn capture_discord_token_native() -> Result<zeroize::Zeroizing<String>, String> {
    #[cfg(target_os = "linux")]
    let candidates: &[(&str, &[&str])] = &[
        ("kdialog", &["--password", "Discord bot token"]),
        ("zenity", &["--password", "--title=Discord bot token"]),
    ];
    #[cfg(target_os = "linux")]
    {
        for (program, args) in candidates {
            if let Ok(output) = std::process::Command::new(program).args(*args).output() {
                if output.status.success() {
                    let mut bytes = zeroize::Zeroizing::new(output.stdout);
                    trim_secret_newline(&mut bytes);
                    validate_discord_token(&bytes)?;
                    let value = String::from_utf8(std::mem::take(&mut *bytes))
                        .map_err(|_| "token_invalid".to_string())?;
                    return Ok(zeroize::Zeroizing::new(value));
                }
                return Err("capture_cancelled".to_string());
            }
        }
        return Err("native_prompt_unavailable".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("osascript")
            .args([
                "-e",
                "display dialog \"Discord bot token\" default answer \"\" with hidden answer buttons {\"Cancel\", \"Save\"} default button \"Save\"",
                "-e",
                "text returned of result",
            ])
            .output()
            .map_err(|_| "native_prompt_unavailable".to_string())?;
        if !output.status.success() {
            return Err("capture_cancelled".to_string());
        }
        let mut bytes = zeroize::Zeroizing::new(output.stdout);
        trim_secret_newline(&mut bytes);
        validate_discord_token(&bytes)?;
        return String::from_utf8(std::mem::take(&mut *bytes))
            .map(zeroize::Zeroizing::new)
            .map_err(|_| "token_invalid".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        let script = "Add-Type -AssemblyName PresentationFramework; \
          $w=New-Object Windows.Window; $w.Title='Discord bot token'; \
          $w.Width=520; $w.Height=170; $w.WindowStartupLocation='CenterScreen'; \
          $g=New-Object Windows.Controls.Grid; $g.Margin='16'; \
          $g.RowDefinitions.Add((New-Object Windows.Controls.RowDefinition)); \
          $g.RowDefinitions.Add((New-Object Windows.Controls.RowDefinition)); \
          $p=New-Object Windows.Controls.PasswordBox; $p.Margin='0,0,0,12'; \
          [Windows.Controls.Grid]::SetRow($p,0); $g.Children.Add($p) | Out-Null; \
          $b=New-Object Windows.Controls.Button; $b.Content='Save'; $b.Width=90; \
          $b.HorizontalAlignment='Right'; [Windows.Controls.Grid]::SetRow($b,1); \
          $b.Add_Click({$w.DialogResult=$true; $w.Close()}); $g.Children.Add($b) | Out-Null; \
          $w.Content=$g; $ok=$w.ShowDialog(); \
          if($ok -ne $true){exit 2}; [Console]::Out.Write($p.Password)";
        let mut command = std::process::Command::new("powershell");
        command.args(["-NoProfile", "-Command", script]);
        platform::hide_console(&mut command);
        let output = command.output().map_err(|_| "native_prompt_unavailable".to_string())?;
        if !output.status.success() {
            return Err("capture_cancelled".to_string());
        }
        validate_discord_token(&output.stdout)?;
        return String::from_utf8(output.stdout)
            .map(zeroize::Zeroizing::new)
            .map_err(|_| "token_invalid".to_string());
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscordCredentialStatus {
    configured: bool,
    code: &'static str,
}

#[derive(Debug)]
enum DiscordRollbackFailure {
    Restore,
    Recovery,
}

fn discord_token_preimage() -> Result<Option<zeroize::Zeroizing<String>>, String> {
    match read_discord_bot_token() {
        Ok(value) => String::from_utf8(value.to_vec())
            .map(zeroize::Zeroizing::new)
            .map(Some)
            .map_err(|_| "discord_credential_snapshot_failed".to_string()),
        Err(error) if error == "token_not_found" => Ok(None),
        Err(_) => Err("discord_credential_snapshot_failed".to_string()),
    }
}

async fn rollback_discord_credential<W, WF, D, DF, R>(
    previous: Option<zeroize::Zeroizing<String>>,
    restore_previous: W,
    remove_current: D,
    recover_runtime: R,
) -> Result<(), DiscordRollbackFailure>
where
    W: FnOnce(String) -> WF,
    WF: std::future::Future<Output = Result<(), String>>,
    D: FnOnce() -> DF,
    DF: std::future::Future<Output = Result<(), String>>,
    R: FnOnce() -> Result<(), String>,
{
    match previous {
        Some(previous) => restore_previous(previous.to_string())
            .await
            .map_err(|_| DiscordRollbackFailure::Restore)?,
        None => remove_current()
            .await
            .map_err(|_| DiscordRollbackFailure::Restore)?,
    }
    recover_runtime().map_err(|_| DiscordRollbackFailure::Recovery)
}

fn quarantine_discord_runtime(state: &AppState) -> Result<(), String> {
    with_discord_lifecycle(&state.discord_lifecycle, || {
        quarantine_discord_runtime_locked(state)
    })
}

fn quarantine_discord_runtime_locked(state: &AppState) -> Result<(), String> {
    state
        .discord_quarantined
        .store(true, std::sync::atomic::Ordering::Release);
    let marker_result =
        discord_runtime_dir().and_then(|runtime| write_discord_quarantine_marker(&runtime));
    let initial_revoke_result = revoke_discord_runtime_authority();
    let mut process = {
        let mut guard =
            lock_or_recover(&state.agent, "state.agent(quarantine_discord_runtime)");
        guard.take()
    };
    let process_result = if let Some(process) = process.as_mut() {
        terminate_and_reap_discord_child(&mut process.child)
    } else {
        Ok(())
    };
    if process_result.is_err() {
        let mut guard =
            lock_or_recover(&state.agent, "state.agent(quarantine_discord_runtime)");
        *guard = process;
    }
    let final_revoke_result = revoke_discord_runtime_authority();
    marker_result
        .and(initial_revoke_result)
        .and(process_result)
        .and(final_revoke_result)
}

fn discord_credential_rollback_error(
    failure: DiscordRollbackFailure,
    quarantine_result: Result<(), String>,
) -> String {
    if quarantine_result.is_err() {
        return "discord_credential_restart_failed_rollback_uncertain".to_string();
    }
    match failure {
        DiscordRollbackFailure::Restore => {
            "discord_credential_restart_failed_rollback_failed".to_string()
        }
        DiscordRollbackFailure::Recovery => {
            "discord_credential_restart_failed_recovery_failed".to_string()
        }
    }
}

#[tauri::command]
async fn discord_capture_bot_token(
    state: tauri::State<'_, AppState>,
    app_handle: AppHandle,
    audit_state: tauri::State<'_, AuditState>,
) -> Result<DiscordCredentialStatus, String> {
    let _operation = state.discord_config_operation.lock().await;
    let adk_path = current_adk_path()?;
    let previous = discord_token_preimage()?;
    let expected_generation =
        read_discord_binding_manifest(&discord_settings_dir()?.join("discord-bindings.json"))?
    .map(|manifest| manifest.generation);
    let token = capture_discord_token_native()?;
    let mutation = write_agent_key(
        adk_path.clone(),
        DISCORD_TOKEN_KEY.to_string(),
        token.to_string(),
    )
    .await;
    let activation = mutation.and_then(|()| {
        restart_agent_for_discord_config(
            &state,
            &app_handle,
            &audit_state.db,
            expected_generation,
        )
    });
    if let Err(error) = activation {
        let restore_path = adk_path.clone();
        let remove_path = adk_path.clone();
        let rollback = rollback_discord_credential(
            previous,
            move |previous| {
                write_agent_key(restore_path, DISCORD_TOKEN_KEY.to_string(), previous)
            },
            move || async move { remove_agent_key(&remove_path, DISCORD_TOKEN_KEY).await },
            || {
                let expected_generation = read_discord_binding_manifest(
                    &discord_settings_dir()?.join("discord-bindings.json"),
                )?
                .map(|manifest| manifest.generation);
                restart_agent_for_discord_config(
                    &state,
                    &app_handle,
                    &audit_state.db,
                    expected_generation,
                )
            },
        )
        .await;
        if let Err(failure) = rollback {
            return Err(discord_credential_rollback_error(
                failure,
                quarantine_discord_runtime(&state),
            ));
        }
        return Err(error);
    }
    Ok(DiscordCredentialStatus {
        configured: true,
        code: "stored",
    })
}

#[tauri::command]
async fn discord_remove_bot_token(
    state: tauri::State<'_, AppState>,
    app_handle: AppHandle,
    audit_state: tauri::State<'_, AuditState>,
) -> Result<(), String> {
    let _operation = state.discord_config_operation.lock().await;
    let adk_path = current_adk_path()?;
    let previous = discord_token_preimage()?
        .ok_or_else(|| "token_not_found".to_string())?;
    let expected_generation =
        read_discord_binding_manifest(&discord_settings_dir()?.join("discord-bindings.json"))?
            .map(|manifest| manifest.generation);
    let activation = remove_agent_key(&adk_path, DISCORD_TOKEN_KEY)
        .await
        .and_then(|()| {
            restart_agent_for_discord_config(&state, &app_handle, &audit_state.db, None)
        });
    if let Err(error) = activation {
        let restore_path = adk_path.clone();
        let remove_path = adk_path.clone();
        let rollback = rollback_discord_credential(
            Some(previous),
            move |previous| {
                write_agent_key(restore_path, DISCORD_TOKEN_KEY.to_string(), previous)
            },
            move || async move { remove_agent_key(&remove_path, DISCORD_TOKEN_KEY).await },
            || {
                restart_agent_for_discord_config(
                    &state,
                    &app_handle,
                    &audit_state.db,
                    expected_generation,
                )
            },
        )
        .await;
        if let Err(failure) = rollback {
            return Err(discord_credential_rollback_error(
                failure,
                quarantine_discord_runtime(&state),
            ));
        }
        return Err(error);
    }
    Ok(())
}

const DISCORD_VIEW_CHANNEL: u64 = 1 << 10;
const DISCORD_SEND_MESSAGES: u64 = 1 << 11;
const DISCORD_READ_MESSAGE_HISTORY: u64 = 1 << 16;
const DISCORD_ADMINISTRATOR: u64 = 1 << 3;
const DISCORD_REQUIRED_PERMISSIONS: u64 =
    DISCORD_VIEW_CHANNEL | DISCORD_SEND_MESSAGES | DISCORD_READ_MESSAGE_HISTORY;

#[derive(serde::Deserialize)]
struct DiscordApiUser {
    id: String,
    username: String,
}

#[derive(serde::Deserialize)]
struct DiscordApiApplication {
    #[serde(default)]
    flags: u64,
}

#[derive(serde::Deserialize)]
struct DiscordApiGuild {
    id: String,
    name: String,
    permissions: String,
}

#[derive(serde::Deserialize)]
struct DiscordApiMember {
    roles: Vec<String>,
}

#[derive(serde::Deserialize)]
struct DiscordApiMessageAuthor {
    id: String,
}

#[derive(serde::Deserialize)]
struct DiscordApiMessage {
    id: String,
    content: String,
    author: DiscordApiMessageAuthor,
}

#[derive(serde::Deserialize)]
struct DiscordApiOverwrite {
    id: String,
    #[serde(rename = "type")]
    kind: u8,
    allow: String,
    deny: String,
}

#[derive(serde::Deserialize)]
struct DiscordApiChannel {
    id: String,
    name: String,
    #[serde(rename = "type")]
    kind: u8,
    position: Option<i64>,
    permission_overwrites: Option<Vec<DiscordApiOverwrite>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscordPermissionSummary {
    view_channel: bool,
    send_messages: bool,
    read_message_history: bool,
    usable: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscordDiscoveredChannel {
    id: String,
    name: String,
    kind: u8,
    position: i64,
    permissions: DiscordPermissionSummary,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscordDiscoveredGuild {
    id: String,
    name: String,
    channels: Vec<DiscordDiscoveredChannel>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscordDiscovery {
    bot_id: String,
    bot_username: String,
    message_content_intent: bool,
    intent_code: &'static str,
    guilds: Vec<DiscordDiscoveredGuild>,
    degraded_guild_ids: Vec<String>,
    discovery_truncated: bool,
}

const DISCORD_GATEWAY_MESSAGE_CONTENT: u64 = 1 << 18;
const DISCORD_GATEWAY_MESSAGE_CONTENT_LIMITED: u64 = 1 << 19;
const DISCORD_GUILD_DISCOVERY_PAGE_SIZE: usize = 100;
const DISCORD_GUILD_DISCOVERY_LIMIT: usize = 200;

fn parse_discord_permissions(value: &str) -> u64 {
    value.parse::<u64>().unwrap_or(0)
}

fn apply_discord_overwrites(
    guild_id: &str,
    bot_id: &str,
    role_ids: &[String],
    base: u64,
    overwrites: &[DiscordApiOverwrite],
) -> u64 {
    if base & DISCORD_ADMINISTRATOR != 0 {
        return u64::MAX;
    }
    let mut result = base;
    if let Some(everyone) = overwrites
        .iter()
        .find(|entry| entry.kind == 0 && entry.id == guild_id)
    {
        result &= !parse_discord_permissions(&everyone.deny);
        result |= parse_discord_permissions(&everyone.allow);
    }
    let mut role_allow = 0;
    let mut role_deny = 0;
    for overwrite in overwrites
        .iter()
        .filter(|entry| entry.kind == 0 && role_ids.contains(&entry.id))
    {
        role_allow |= parse_discord_permissions(&overwrite.allow);
        role_deny |= parse_discord_permissions(&overwrite.deny);
    }
    result &= !role_deny;
    result |= role_allow;
    if let Some(member) = overwrites
        .iter()
        .find(|entry| entry.kind == 1 && entry.id == bot_id)
    {
        result &= !parse_discord_permissions(&member.deny);
        result |= parse_discord_permissions(&member.allow);
    }
    result
}

fn discord_permission_summary(value: u64) -> DiscordPermissionSummary {
    let view_channel = value & DISCORD_VIEW_CHANNEL != 0;
    let send_messages = value & DISCORD_SEND_MESSAGES != 0;
    let read_message_history = value & DISCORD_READ_MESSAGE_HISTORY != 0;
    DiscordPermissionSummary {
        view_channel,
        send_messages,
        read_message_history,
        usable: value & DISCORD_REQUIRED_PERMISSIONS == DISCORD_REQUIRED_PERMISSIONS,
    }
}

fn discord_bot_member_endpoint(guild_id: &str, bot_id: &str) -> String {
    format!("/guilds/{guild_id}/members/{bot_id}")
}

fn discord_guilds_endpoint(after: Option<&str>) -> String {
    match after {
        Some(after) => format!(
            "/users/@me/guilds?limit={DISCORD_GUILD_DISCOVERY_PAGE_SIZE}&after={after}"
        ),
        None => format!(
            "/users/@me/guilds?limit={DISCORD_GUILD_DISCOVERY_PAGE_SIZE}"
        ),
    }
}

fn discord_guild_discovery_truncated(total: usize, last_page_len: usize) -> bool {
    total >= DISCORD_GUILD_DISCOVERY_LIMIT
        && last_page_len == DISCORD_GUILD_DISCOVERY_PAGE_SIZE
}

fn discord_channel_history_endpoint(channel_id: &str) -> String {
    format!("/channels/{channel_id}/messages?limit=50")
}

fn discord_snowflake_timestamp_ms(value: &str) -> Option<u64> {
    let snowflake = value.parse::<u64>().ok()?;
    Some((snowflake >> 22).saturating_add(1_420_070_400_000))
}

fn discord_http_client(token: &[u8]) -> Result<reqwest::Client, String> {
    use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
    let mut authorization = zeroize::Zeroizing::new(Vec::with_capacity(token.len() + 4));
    authorization.extend_from_slice(b"Bot ");
    authorization.extend_from_slice(token);
    let mut value =
        HeaderValue::from_bytes(&authorization).map_err(|_| "token_invalid".to_string())?;
    value.set_sensitive(true);
    let mut headers = HeaderMap::new();
    headers.insert(AUTHORIZATION, value);
    reqwest::Client::builder()
        .default_headers(headers)
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|_| "discord_client_unavailable".to_string())
}

async fn discord_get_json<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    endpoint: &str,
) -> Result<T, String> {
    const MAX_BODY_BYTES: usize = 1024 * 1024;
    static DISCORD_REST_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> =
        std::sync::OnceLock::new();
    let _request = DISCORD_REST_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    for attempt in 0..3 {
        let response = client
            .get(format!("https://discord.com/api/v10{endpoint}"))
            .send()
            .await
            .map_err(|_| "discord_network_unavailable".to_string())?;
        let status = response.status().as_u16();
        if status == 429 {
            if attempt == 2 {
                return Err("discord_rate_limited".to_string());
            }
            let base_delay_ms = response
                .headers()
                .get("retry-after")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<f64>().ok())
                .map(|seconds| (seconds * 1000.0).ceil() as u64)
                .unwrap_or(1000)
                .clamp(100, 5000);
            let jitter_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| u64::from(duration.subsec_nanos()) % 251)
                .unwrap_or(0);
            let delay_ms = base_delay_ms.saturating_add(jitter_ms).min(5250);
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            continue;
        }
        match status {
            200..=299 => {
                let bytes = discord_read_bounded_body(response, MAX_BODY_BYTES).await?;
                return serde_json::from_slice::<T>(&bytes)
                    .map_err(|_| "discord_response_invalid".to_string());
            }
            401 => return Err("discord_auth_failed".to_string()),
            403 => return Err("discord_permission_denied".to_string()),
            _ => return Err("discord_api_unavailable".to_string()),
        }
    }
    Err("discord_rate_limited".to_string())
}

async fn discord_read_bounded_body(
    mut response: reqwest::Response,
    max_body_bytes: usize,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > max_body_bytes as u64)
    {
        return Err("discord_response_too_large".to_string());
    }
    let capped_len = max_body_bytes.saturating_add(1);
    let mut body = Vec::with_capacity(
        response
            .content_length()
            .and_then(|length| usize::try_from(length).ok())
            .unwrap_or(0)
            .min(capped_len),
    );
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "discord_response_invalid".to_string())?
    {
        let remaining = capped_len.saturating_sub(body.len());
        body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if body.len() > max_body_bytes {
            return Err("discord_response_too_large".to_string());
        }
    }
    Ok(body)
}

/// Discover only bounded public Discord metadata. The token remains in native
/// memory and is installed as a sensitive HTTP header; it never crosses IPC.
#[tauri::command]
async fn discord_discover_channels() -> Result<DiscordDiscovery, String> {
    let token = read_discord_bot_token()?;
    validate_discord_token(&token)?;
    let client = discord_http_client(&token)?;
    let bot = discord_get_json::<DiscordApiUser>(&client, "/users/@me").await?;
    let application =
        discord_get_json::<DiscordApiApplication>(&client, "/oauth2/applications/@me").await?;
    let message_content_intent = application.flags & (DISCORD_GATEWAY_MESSAGE_CONTENT
        | DISCORD_GATEWAY_MESSAGE_CONTENT_LIMITED)
        != 0;
    if !is_valid_discord_snowflake(&bot.id) {
        return Err("discord_response_invalid".to_string());
    }
    let mut guilds = Vec::with_capacity(DISCORD_GUILD_DISCOVERY_LIMIT);
    let mut after: Option<String> = None;
    let mut discovery_truncated = false;
    while guilds.len() < DISCORD_GUILD_DISCOVERY_LIMIT {
        let mut page = discord_get_json::<Vec<DiscordApiGuild>>(
            &client,
            &discord_guilds_endpoint(after.as_deref()),
        )
        .await?;
        if page.len() > DISCORD_GUILD_DISCOVERY_PAGE_SIZE {
            return Err("discord_response_invalid".to_string());
        }
        if page.is_empty() {
            break;
        }
        let page_len = page.len();
        let next_after = page
            .last()
            .map(|guild| guild.id.clone())
            .filter(|id| is_valid_discord_snowflake(id))
            .ok_or_else(|| "discord_response_invalid".to_string())?;
        let remaining = DISCORD_GUILD_DISCOVERY_LIMIT - guilds.len();
        guilds.extend(page.drain(..page.len().min(remaining)));
        discovery_truncated = discord_guild_discovery_truncated(guilds.len(), page_len);
        if page_len < DISCORD_GUILD_DISCOVERY_PAGE_SIZE
            || guilds.len() == DISCORD_GUILD_DISCOVERY_LIMIT
        {
            break;
        }
        after = Some(next_after);
    }
    let mut discovered = Vec::with_capacity(guilds.len());
    let mut degraded_guild_ids = Vec::new();
    for guild in guilds {
        if !is_valid_discord_snowflake(&guild.id) {
            return Err("discord_response_invalid".to_string());
        }
        let Ok(member) = discord_get_json::<DiscordApiMember>(
            &client,
            &discord_bot_member_endpoint(&guild.id, &bot.id),
        )
        .await
        else {
            degraded_guild_ids.push(guild.id);
            continue;
        };
        let Ok(mut channels) = discord_get_json::<Vec<DiscordApiChannel>>(
            &client,
            &format!("/guilds/{}/channels", guild.id),
        )
        .await
        else {
            degraded_guild_ids.push(guild.id);
            continue;
        };
        if channels.len() > 500 {
            channels.truncate(500);
        }
        let base = parse_discord_permissions(&guild.permissions);
        let mut channel_rows = channels
            .into_iter()
            .filter(|channel| {
                (channel.kind == 0 || channel.kind == 5)
                    && is_valid_discord_snowflake(&channel.id)
            })
            .map(|channel| {
                let effective = apply_discord_overwrites(
                    &guild.id,
                    &bot.id,
                    &member.roles,
                    base,
                    channel.permission_overwrites.as_deref().unwrap_or_default(),
                );
                DiscordDiscoveredChannel {
                    id: channel.id,
                    name: channel.name.chars().take(100).collect(),
                    kind: channel.kind,
                    position: channel.position.unwrap_or(0),
                    permissions: discord_permission_summary(effective),
                }
            })
            .filter(|channel| channel.permissions.view_channel)
            .collect::<Vec<_>>();
        channel_rows.sort_by_key(|channel| channel.position);
        discovered.push(DiscordDiscoveredGuild {
            id: guild.id,
            name: guild.name.chars().take(100).collect(),
            channels: channel_rows,
        });
    }
    discovered.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(DiscordDiscovery {
        bot_id: bot.id,
        bot_username: bot.username.chars().take(100).collect(),
        message_content_intent,
        intent_code: if message_content_intent {
            "message_content_enabled"
        } else {
            "message_content_disabled"
        },
        guilds: discovered,
        degraded_guild_ids,
        discovery_truncated,
    })
}

async fn discord_usable_channel_keys(
) -> Result<std::collections::BTreeSet<(String, String)>, String> {
    let discovery = discord_discover_channels().await?;
    if !discovery.message_content_intent {
        return Err("discord_message_content_intent_missing".to_string());
    }
    if !discovery.degraded_guild_ids.is_empty() || discovery.discovery_truncated {
        return Err("discord_discovery_incomplete".to_string());
    }
    Ok(discovery
        .guilds
        .into_iter()
        .flat_map(|guild| {
            guild.channels.into_iter().filter_map(move |channel| {
                channel
                    .permissions
                    .usable
                    .then_some((guild.id.clone(), channel.id))
            })
        })
        .collect())
}

fn discord_binding_is_usable(
    binding: &DiscordBindingInput,
    usable: &std::collections::BTreeSet<(String, String)>,
) -> bool {
    usable.contains(&(binding.guild_id.clone(), binding.channel_id.clone()))
}

#[derive(Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiscordBindingInput {
    binding_id: String,
    guild_id: String,
    guild_name: Option<String>,
    channel_id: String,
    channel_name: Option<String>,
    allowed_user_ids: Vec<String>,
    processing_profile_ref: String,
    participation: String,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiscordBindingManifest {
    version: u8,
    generation: u64,
    bindings: Vec<DiscordBindingInput>,
    processing_profiles: std::collections::BTreeMap<String, String>,
}

const DISCORD_MAX_SAFE_GENERATION: u64 = 9_007_199_254_740_991;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscordBindingSnapshot {
    generation: Option<u64>,
    bindings: Vec<DiscordBindingInput>,
}

fn discord_binding_snapshot_from_manifest(
    manifest: Option<DiscordBindingManifest>,
) -> DiscordBindingSnapshot {
    match manifest {
        Some(value) => DiscordBindingSnapshot {
            generation: Some(value.generation),
            bindings: value.bindings,
        },
        None => DiscordBindingSnapshot {
            generation: None,
            bindings: Vec::new(),
        },
    }
}

fn discord_binding_generation_matches(
    current_generation: Option<u64>,
    expected_generation: Option<u64>,
) -> bool {
    current_generation == expected_generation
}

async fn discord_binding_save_if_generation_matches<T, F, Fut>(
    current_generation: Option<u64>,
    expected_generation: Option<u64>,
    operation: F,
) -> Result<T, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    if !discord_binding_generation_matches(current_generation, expected_generation) {
        return Err("discord_bindings_generation_conflict".to_string());
    }
    operation().await
}

fn discord_bindings_have_unique_identity(bindings: &[DiscordBindingInput]) -> bool {
    let mut binding_ids = std::collections::BTreeSet::new();
    let mut tuples = std::collections::BTreeSet::new();
    bindings.iter().all(|binding| {
        binding_ids.insert(binding.binding_id.as_str())
            && tuples.insert((binding.guild_id.as_str(), binding.channel_id.as_str()))
    })
}

fn read_discord_binding_manifest(
    path: &std::path::Path,
) -> Result<Option<DiscordBindingManifest>, String> {
    let manifest = read_bounded_json::<DiscordBindingManifest>(path, 512 * 1024)?;
    if manifest
        .as_ref()
        .is_some_and(|value| value.version != 1)
    {
        return Err("discord_bindings_upgrade_required".to_string());
    }
    if manifest
        .as_ref()
        .is_some_and(|value| {
            value.generation == 0 || value.generation > DISCORD_MAX_SAFE_GENERATION
        })
    {
        return Err("discord_bindings_generation_invalid".to_string());
    }
    if manifest
        .as_ref()
        .is_some_and(|value| !discord_bindings_have_unique_identity(&value.bindings))
    {
        return Err("discord_bindings_invalid".to_string());
    }
    Ok(manifest)
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscordUiPreference {
    version: u8,
    last_binding_id: Option<String>,
}

fn discord_settings_dir() -> Result<std::path::PathBuf, String> {
    Ok(std::path::PathBuf::from(current_adk_path()?).join("naia-settings"))
}

#[tauri::command]
async fn discord_binding_snapshot() -> Result<DiscordBindingSnapshot, String> {
    let manifest =
        read_discord_binding_manifest(&discord_settings_dir()?.join("discord-bindings.json"))?;
    Ok(discord_binding_snapshot_from_manifest(manifest))
}

#[tauri::command]
async fn discord_get_last_binding() -> Result<Option<String>, String> {
    let settings = discord_settings_dir()?;
    let preference = read_bounded_json::<DiscordUiPreference>(
        &settings.join("discord-ui.json"),
        16 * 1024,
    )?;
    let Some(binding_id) = preference.and_then(|value| value.last_binding_id) else {
        return Ok(None);
    };
    let manifest =
        read_discord_binding_manifest(&settings.join("discord-bindings.json"))?;
    let usable = discord_usable_channel_keys().await?;
    Ok(manifest
        .is_some_and(|value| {
            value
                .bindings
                .iter()
                .any(|binding| {
                    binding.binding_id == binding_id && discord_binding_is_usable(binding, &usable)
                })
        })
        .then_some(binding_id))
}

#[tauri::command]
async fn discord_set_last_binding(
    binding_id: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let _operation = state.discord_config_operation.lock().await;
    let settings = discord_settings_dir()?;
    if let Some(value) = binding_id.as_ref() {
        if value.is_empty() || value.len() > 128 {
            return Err("discord_binding_invalid".to_string());
        }
        let manifest =
            read_discord_binding_manifest(&settings.join("discord-bindings.json"))?
        .ok_or_else(|| "discord_bindings_unavailable".to_string())?;
        let binding = manifest
            .bindings
            .iter()
            .find(|binding| binding.binding_id == *value)
            .ok_or_else(|| "discord_binding_not_allowed".to_string())?;
        let usable = discord_usable_channel_keys().await?;
        if !discord_binding_is_usable(binding, &usable) {
            return Err("discord_binding_not_allowed".to_string());
        }
    }
    let preference = DiscordUiPreference {
        version: 1,
        last_binding_id: binding_id,
    };
    let bytes = serde_json::to_vec(&preference)
        .map_err(|_| "discord_preference_invalid".to_string())?;
    write_owner_only_atomic(&settings.join("discord-ui.json"), &bytes)
}

fn write_owner_only_atomic(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let parent = path
        .parent()
        .ok_or_else(|| "discord_config_path_invalid".to_string())?;
    std::fs::create_dir_all(parent).map_err(|_| "discord_config_write_failed".to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "discord_config_write_failed".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "discord_config_write_failed".to_string())?;
    }
    file.write_all(bytes)
        .map_err(|_| "discord_config_write_failed".to_string())?;
    file.as_file()
        .sync_all()
        .map_err(|_| "discord_config_write_failed".to_string())?;
    file.persist(path)
        .map_err(|_| "discord_config_write_failed".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "discord_config_write_failed".to_string())?;
    }
    #[cfg(unix)]
    sync_parent_directory_with(
        || std::fs::File::open(parent),
        |directory| directory.sync_all(),
    )
    .map_err(|_| "discord_config_write_failed".to_string())?;
    #[cfg(not(unix))]
    if let Ok(directory) = std::fs::File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

#[cfg(any(unix, test))]
fn sync_parent_directory_with<T, O, S>(open_directory: O, sync_directory: S) -> std::io::Result<()>
where
    O: FnOnce() -> std::io::Result<T>,
    S: FnOnce(&T) -> std::io::Result<()>,
{
    let directory = open_directory()?;
    sync_directory(&directory)
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum DiscordFilePreimage {
    Absent,
    Present(Vec<u8>),
}

fn read_discord_file_preimage(path: &std::path::Path) -> Result<DiscordFilePreimage, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(DiscordFilePreimage::Present(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(DiscordFilePreimage::Absent)
        }
        Err(_) => Err("discord_bindings_snapshot_failed".to_string()),
    }
}

fn rollback_discord_binding_file<W, D, R>(
    preimage: DiscordFilePreimage,
    restore_present: W,
    restore_absent: D,
    recover_runtime: R,
) -> Result<(), DiscordRollbackFailure>
where
    W: FnOnce(Vec<u8>) -> Result<(), String>,
    D: FnOnce() -> Result<(), String>,
    R: FnOnce() -> Result<(), String>,
{
    match preimage {
        DiscordFilePreimage::Present(bytes) => {
            restore_present(bytes).map_err(|_| DiscordRollbackFailure::Restore)?
        }
        DiscordFilePreimage::Absent => {
            restore_absent().map_err(|_| DiscordRollbackFailure::Restore)?
        }
    }
    recover_runtime().map_err(|_| DiscordRollbackFailure::Recovery)
}

fn remove_discord_binding_manifest(path: &std::path::Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("discord_bindings_restore_failed".to_string()),
    }
}

fn discord_binding_rollback_error(
    failure: DiscordRollbackFailure,
    quarantine_result: Result<(), String>,
) -> String {
    if quarantine_result.is_err() {
        return "discord_bindings_restart_failed_rollback_uncertain".to_string();
    }
    match failure {
        DiscordRollbackFailure::Restore => {
            "discord_bindings_restart_failed_rollback_failed".to_string()
        }
        DiscordRollbackFailure::Recovery => {
            "discord_bindings_restart_failed_recovery_failed".to_string()
        }
    }
}

fn finish_discord_clear_activation<Q>(
    activation: Result<(), String>,
    quarantine_runtime: Q,
) -> Result<(), String>
where
    Q: FnOnce() -> Result<(), String>,
{
    match activation {
        Ok(()) => Ok(()),
        Err(_) => match quarantine_runtime() {
            Ok(()) => Err("discord_bindings_clear_failed".to_string()),
            Err(_) => Err("discord_bindings_clear_quarantine_uncertain".to_string()),
        },
    }
}

#[tauri::command]
async fn discord_save_bindings(
    bindings: Vec<DiscordBindingInput>,
    expected_generation: Option<u64>,
    state: tauri::State<'_, AppState>,
    app_handle: AppHandle,
    audit_state: tauri::State<'_, AuditState>,
) -> Result<u64, String> {
    let app_state = state.inner();
    let _operation = state.discord_config_operation.lock().await;
    if bindings.len() > 256 {
        return Err("discord_bindings_invalid".to_string());
    }
    if !discord_bindings_have_unique_identity(&bindings) {
        return Err("discord_bindings_invalid".to_string());
    }
    for binding in &bindings {
        if binding.binding_id.is_empty()
            || binding.binding_id.len() > 128
            || !is_valid_discord_snowflake(&binding.guild_id)
            || !is_valid_discord_snowflake(&binding.channel_id)
            || binding
                .guild_name
                .as_ref()
                .is_some_and(|name| name.is_empty() || name.chars().count() > 100)
            || binding
                .channel_name
                .as_ref()
                .is_some_and(|name| name.is_empty() || name.chars().count() > 100)
            || binding.allowed_user_ids.is_empty()
            || binding.allowed_user_ids.len() > 256
            || !binding
                .allowed_user_ids
                .iter()
                .all(|id| is_valid_discord_snowflake(id))
            || binding.processing_profile_ref != "default"
            || !matches!(
                binding.participation.as_str(),
                "mentions" | "all" | "paused"
            )
        {
            return Err("discord_bindings_invalid".to_string());
        }
    }
    let path = discord_settings_dir()?.join("discord-bindings.json");
    let previous_manifest = read_discord_binding_manifest(&path)?;
    let previous_generation = previous_manifest
        .as_ref()
        .map(|manifest| manifest.generation);
    discord_binding_save_if_generation_matches(
        previous_generation,
        expected_generation,
        || async move {
            if !bindings.is_empty() {
                let discovery = discord_discover_channels().await?;
                if !discovery.message_content_intent {
                    return Err("discord_message_content_intent_missing".to_string());
                }
                let usable = discovery
                    .guilds
                    .iter()
                    .flat_map(|guild| {
                        guild
                            .channels
                            .iter()
                            .filter(|channel| channel.permissions.usable)
                            .map(|channel| (guild.id.as_str(), channel.id.as_str()))
                    })
                    .collect::<std::collections::BTreeSet<_>>();
                let preserved_stale = previous_manifest
                    .as_ref()
                    .map(|manifest| manifest.bindings.iter().collect::<Vec<_>>());
                if bindings.iter().any(|binding| {
                    !usable.contains(&(binding.guild_id.as_str(), binding.channel_id.as_str()))
                        && !preserved_stale
                            .as_ref()
                            .is_some_and(|existing| existing.iter().any(|value| *value == binding))
                }) {
                    return Err("discord_binding_permission_denied".to_string());
                }
            }
            let generation = next_discord_generation(previous_generation)?;
            let clearing_all_bindings = bindings.is_empty();
            let manifest = DiscordBindingManifest {
                version: 1,
                generation,
                bindings,
                processing_profiles: std::collections::BTreeMap::from([(
                    "default".to_string(),
                    "local_only".to_string(),
                )]),
            };
            let bytes = serde_json::to_vec_pretty(&manifest)
                .map_err(|_| "discord_bindings_invalid".to_string())?;
            if bytes.len() > 512 * 1024 {
                return Err("discord_bindings_too_large".to_string());
            }
            let previous = read_discord_file_preimage(&path)?;
            let activation = write_owner_only_atomic(&path, &bytes).and_then(|()| {
                restart_agent_for_discord_config(
                    app_state,
                    &app_handle,
                    &audit_state.db,
                    (!clearing_all_bindings).then_some(generation),
                )
            });
            if clearing_all_bindings {
                finish_discord_clear_activation(activation, || {
                    quarantine_discord_runtime(app_state)
                })?;
                return Ok(generation);
            }
            if let Err(error) = activation {
                let restore_path = path.clone();
                let remove_path = path.clone();
                let rollback = rollback_discord_binding_file(
                    previous,
                    move |bytes| write_owner_only_atomic(&restore_path, &bytes),
                    move || remove_discord_binding_manifest(&remove_path),
                    || {
                        restart_agent_for_discord_config(
                            app_state,
                            &app_handle,
                            &audit_state.db,
                            previous_generation,
                        )
                    },
                );
                if let Err(failure) = rollback {
                    return Err(discord_binding_rollback_error(
                        failure,
                        quarantine_discord_runtime(app_state),
                    ));
                }
                return Err(error);
            }
            Ok(generation)
        }
    )
    .await
}

fn next_discord_generation(previous: Option<u64>) -> Result<u64, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "clock_unavailable".to_string())?
        .as_millis() as u64;
    let generation = match previous {
        Some(value) => value
            .checked_add(1)
            .map(|minimum| now.max(minimum))
            .ok_or_else(|| "discord_bindings_generation_invalid".to_string())?,
        None => now,
    };
    if generation > DISCORD_MAX_SAFE_GENERATION {
        return Err("discord_bindings_generation_invalid".to_string());
    }
    Ok(generation)
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscordInboxRecordNative {
    record_id: String,
    direction: String,
    binding_id: String,
    guild_id: String,
    channel_id: String,
    source_message_id: String,
    author_id: Option<String>,
    content: String,
    created_at: u64,
}

#[derive(serde::Deserialize)]
struct DiscordInboxDocumentNative {
    version: u8,
    generation: String,
    channels: std::collections::BTreeMap<String, Vec<DiscordInboxRecordNative>>,
}

#[derive(serde::Deserialize, serde::Serialize, Default)]
struct DiscordInboxCursors {
    version: u8,
    #[serde(default)]
    generation: String,
    cursors: std::collections::BTreeMap<String, u64>,
}

fn update_discord_inbox_cursor(
    mut cursors: DiscordInboxCursors,
    generation: &str,
    active_keys: &std::collections::BTreeSet<String>,
    cursor_key: String,
    created_at: u64,
) -> Result<DiscordInboxCursors, String> {
    if cursors.version != 1 || cursors.generation != generation {
        cursors = DiscordInboxCursors {
            version: 1,
            generation: generation.to_string(),
            cursors: std::collections::BTreeMap::new(),
        };
    }
    cursors.version = 1;
    cursors.generation = generation.to_string();
    cursors.cursors.retain(|key, _| active_keys.contains(key));
    let current = cursors.cursors.entry(cursor_key).or_insert(0);
    *current = (*current).max(created_at);
    if cursors.cursors.len() > 256 {
        return Err("discord_cursor_invalid".to_string());
    }
    Ok(cursors)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscordInboxChannelSnapshot {
    binding_id: String,
    guild_id: String,
    guild_name: String,
    channel_id: String,
    channel_name: String,
    participation: String,
    records: Vec<DiscordInboxRecordNative>,
    unread: usize,
    last_activity: Option<u64>,
}

fn read_bounded_json<T: serde::de::DeserializeOwned>(
    path: &std::path::Path,
    max_bytes: u64,
) -> Result<Option<T>, String> {
    let metadata = match std::fs::metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("discord_cache_read_failed".to_string()),
    };
    if !metadata.is_file() || metadata.len() > max_bytes {
        return Err("discord_cache_invalid".to_string());
    }
    let bytes = std::fs::read(path).map_err(|_| "discord_cache_read_failed".to_string())?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "discord_cache_invalid".to_string())
}

fn discord_runtime_dir() -> Result<std::path::PathBuf, String> {
    Ok(std::path::PathBuf::from(current_adk_path()?)
        .join("naia-settings")
        .join("discord-runtime"))
}

fn discord_binding_cache_key(binding: &DiscordBindingInput) -> String {
    format!(
        "{}:{}:{}",
        binding.binding_id, binding.guild_id, binding.channel_id
    )
}

fn read_discord_inbox_snapshot(
    settings: &std::path::Path,
    manifest: DiscordBindingManifest,
    allowed_binding_ids: &std::collections::BTreeSet<String>,
) -> Result<Vec<DiscordInboxChannelSnapshot>, String> {
    let runtime = settings.join("discord-runtime");
    let inbox =
        read_bounded_json::<DiscordInboxDocumentNative>(&runtime.join("inbox.json"), 16 * 1024 * 1024)?
            .unwrap_or(DiscordInboxDocumentNative {
                version: 1,
                generation: manifest.generation.to_string(),
                channels: std::collections::BTreeMap::new(),
            });
    if inbox.version != 1 || inbox.generation != manifest.generation.to_string() {
        return Err("discord_cache_generation_mismatch".to_string());
    }
    let mut cursors = read_bounded_json::<DiscordInboxCursors>(
        &runtime.join("inbox-cursors.json"),
        512 * 1024,
    )?
    .unwrap_or_default();
    let generation = manifest.generation.to_string();
    if cursors.version != 1 || cursors.generation != generation {
        cursors = DiscordInboxCursors {
            version: 1,
            generation,
            cursors: std::collections::BTreeMap::new(),
        };
    }
    let mut result = Vec::with_capacity(manifest.bindings.len());
    for binding in manifest
        .bindings
        .into_iter()
        .filter(|binding| allowed_binding_ids.contains(&binding.binding_id))
    {
        let key = discord_binding_cache_key(&binding);
        let mut records = inbox.channels.get(&key).cloned().unwrap_or_default();
        records.sort_by_key(|record| record.created_at);
        let cursor = cursors.cursors.get(&key).copied().unwrap_or(0);
        let unread = records
            .iter()
            .filter(|record| record.direction == "incoming" && record.created_at > cursor)
            .count();
        result.push(DiscordInboxChannelSnapshot {
            binding_id: binding.binding_id,
            guild_id: binding.guild_id.clone(),
            guild_name: binding.guild_name.unwrap_or(binding.guild_id),
            channel_id: binding.channel_id.clone(),
            channel_name: binding.channel_name.unwrap_or(binding.channel_id),
            participation: binding.participation,
            last_activity: records.last().map(|record| record.created_at),
            records,
            unread,
        });
    }
    result.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
    Ok(result)
}

#[tauri::command]
async fn discord_inbox_snapshot(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<DiscordInboxChannelSnapshot>, String> {
    let settings = std::path::PathBuf::from(current_adk_path()?).join("naia-settings");
    let manifest =
        read_discord_binding_manifest(&settings.join("discord-bindings.json"))?
            .ok_or_else(|| "discord_bindings_unavailable".to_string())?;
    let usable = discord_usable_channel_keys().await?;
    let allowed_binding_ids: std::collections::BTreeSet<String> = manifest
        .bindings
        .iter()
        .filter(|binding| discord_binding_is_usable(binding, &usable))
        .map(|binding| binding.binding_id.clone())
        .collect();
    *state.discord_inbox_authorized_bindings.lock().await =
        Some((manifest.generation, allowed_binding_ids.clone()));
    read_discord_inbox_snapshot(&settings, manifest, &allowed_binding_ids)
}

/// Reads only local runtime files for bindings already authorized by the most
/// recent live snapshot. File watcher events must never trigger Discord REST
/// discovery, especially during an outage or an atomic cursor/status write.
#[tauri::command]
async fn discord_inbox_snapshot_cached(
    binding_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<DiscordInboxChannelSnapshot>, String> {
    if binding_ids.len() > 256
        || binding_ids
            .iter()
            .any(|binding_id| binding_id.is_empty() || binding_id.len() > 128)
    {
        return Err("discord_binding_invalid".to_string());
    }
    let settings = std::path::PathBuf::from(current_adk_path()?).join("naia-settings");
    let manifest =
        read_discord_binding_manifest(&settings.join("discord-bindings.json"))?
            .ok_or_else(|| "discord_bindings_unavailable".to_string())?;
    let requested_binding_ids = binding_ids.into_iter().collect::<std::collections::BTreeSet<_>>();
    let authorized = state.discord_inbox_authorized_bindings.lock().await;
    let allowed_binding_ids = authorized
        .as_ref()
        .filter(|(generation, _)| *generation == manifest.generation)
        .map(|(_, binding_ids)| {
            binding_ids
                .intersection(&requested_binding_ids)
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    drop(authorized);
    read_discord_inbox_snapshot(&settings, manifest, &allowed_binding_ids)
}

#[tauri::command]
async fn discord_fetch_channel_history(
    binding_id: String,
) -> Result<Vec<DiscordInboxRecordNative>, String> {
    if binding_id.is_empty() || binding_id.len() > 128 {
        return Err("discord_binding_invalid".to_string());
    }
    let settings = discord_settings_dir()?;
    let manifest =
        read_discord_binding_manifest(&settings.join("discord-bindings.json"))?
    .ok_or_else(|| "discord_bindings_unavailable".to_string())?;
    let binding = manifest
        .bindings
        .iter()
        .find(|binding| binding.binding_id == binding_id)
        .ok_or_else(|| "discord_binding_not_allowed".to_string())?;
    let usable = discord_usable_channel_keys().await?;
    if !discord_binding_is_usable(binding, &usable) {
        return Err("discord_binding_not_allowed".to_string());
    }

    let token = read_discord_bot_token()?;
    validate_discord_token(&token)?;
    let client = discord_http_client(&token)?;
    let bot = discord_get_json::<DiscordApiUser>(&client, "/users/@me").await?;
    let mut messages = discord_get_json::<Vec<DiscordApiMessage>>(
        &client,
        &discord_channel_history_endpoint(&binding.channel_id),
    )
    .await?;
    if messages.len() > 50 {
        messages.truncate(50);
    }
    let mut records = messages
        .into_iter()
        .filter_map(|message| {
            if !is_valid_discord_snowflake(&message.id)
                || !is_valid_discord_snowflake(&message.author.id)
            {
                return None;
            }
            let created_at = discord_snowflake_timestamp_ms(&message.id)?;
            Some(DiscordInboxRecordNative {
                record_id: format!("history_{}", message.id),
                direction: if message.author.id == bot.id {
                    "outgoing".to_string()
                } else {
                    "incoming".to_string()
                },
                binding_id: binding.binding_id.clone(),
                guild_id: binding.guild_id.clone(),
                channel_id: binding.channel_id.clone(),
                source_message_id: message.id,
                author_id: Some(message.author.id),
                content: message.content.chars().take(4_000).collect(),
                created_at,
            })
        })
        .collect::<Vec<_>>();
    records.sort_by_key(|record| record.created_at);
    Ok(records)
}

#[tauri::command]
async fn discord_mark_inbox_read(
    binding_id: String,
    created_at: u64,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let _operation = state.discord_config_operation.lock().await;
    if binding_id.is_empty() || binding_id.len() > 128 || created_at == 0 {
        return Err("discord_cursor_invalid".to_string());
    }
    let settings = std::path::PathBuf::from(current_adk_path()?).join("naia-settings");
    let manifest =
        read_discord_binding_manifest(&settings.join("discord-bindings.json"))?
    .ok_or_else(|| "discord_bindings_unavailable".to_string())?;
    let binding = manifest
        .bindings
        .iter()
        .find(|binding| binding.binding_id == binding_id)
        .ok_or_else(|| "discord_cursor_invalid".to_string())?;
    let usable = discord_usable_channel_keys().await?;
    if !discord_binding_is_usable(binding, &usable) {
        return Err("discord_cursor_invalid".to_string());
    }
    let cursor_key = discord_binding_cache_key(binding);
    let active_keys = manifest
        .bindings
        .iter()
        .map(discord_binding_cache_key)
        .collect::<std::collections::BTreeSet<_>>();
    let generation = manifest.generation.to_string();
    let runtime = discord_runtime_dir()?;
    let path = runtime.join("inbox-cursors.json");
    let cursors =
        read_bounded_json::<DiscordInboxCursors>(&path, 512 * 1024)?.unwrap_or(DiscordInboxCursors {
            version: 1,
            generation: generation.clone(),
            cursors: std::collections::BTreeMap::new(),
        });
    let cursors =
        update_discord_inbox_cursor(cursors, &generation, &active_keys, cursor_key, created_at)?;
    let bytes =
        serde_json::to_vec(&cursors).map_err(|_| "discord_cursor_invalid".to_string())?;
    write_owner_only_atomic(&path, &bytes)
}

fn start_discord_inbox_watcher(app: AppHandle) {
    use notify::Watcher as _;
    let Ok(runtime) = discord_runtime_dir() else {
        return;
    };
    if std::fs::create_dir_all(&runtime).is_err() {
        return;
    }
    std::thread::spawn(move || {
        let (sender, receiver) = std::sync::mpsc::channel();
        let Ok(mut watcher) = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        }) else {
            return;
        };
        if watcher
            .watch(&runtime, notify::RecursiveMode::NonRecursive)
            .is_err()
        {
            return;
        }
        for event in receiver.into_iter().flatten() {
            if event.paths.iter().any(|path| {
                matches!(
                    path.file_name().and_then(|name| name.to_str()),
                    Some("inbox.json" | "inbox-cursors.json")
                )
            }) {
                let _ = app.emit("discord_inbox_changed", ());
            }
            if event.paths.iter().any(|path| {
                matches!(
                    path.file_name().and_then(|name| name.to_str()),
                    Some("status.json")
                )
            }) {
                let _ = app.emit("discord_status_changed", ());
            }
        }
    });
}

#[derive(serde::Deserialize)]
struct DiscordOpenDmResponse {
    id: String,
}

/// Legacy account-link compatibility surface. It can only open a DM for one
/// validated Discord user id; the WebView cannot choose routes, methods, or bodies.
#[tauri::command]
async fn discord_open_dm_channel(recipient_user_id: String) -> Result<String, String> {
    if !is_valid_discord_snowflake(&recipient_user_id) {
        return Err("discord_recipient_invalid".to_string());
    }
    let token = read_discord_bot_token()?;
    validate_discord_token(&token)?;
    let client = discord_http_client(&token)?;
    for attempt in 0..3 {
        let response = client
            .post("https://discord.com/api/v10/users/@me/channels")
            .json(&serde_json::json!({ "recipient_id": recipient_user_id }))
            .send()
            .await
            .map_err(|_| "discord_network_unavailable".to_string())?;
        let status = response.status().as_u16();
        if status == 429 {
            if attempt == 2 {
                return Err("discord_rate_limited".to_string());
            }
            let delay_ms = response
                .headers()
                .get("retry-after")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<f64>().ok())
                .map(|seconds| (seconds * 1000.0).ceil() as u64)
                .unwrap_or(1000)
                .clamp(100, 5000);
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            continue;
        }
        match status {
            200..=299 => {
                let bytes = discord_read_bounded_body(response, 64 * 1024).await?;
                let value = serde_json::from_slice::<DiscordOpenDmResponse>(&bytes)
                    .map_err(|_| "discord_response_invalid".to_string())?;
                if !is_valid_discord_snowflake(&value.id) {
                    return Err("discord_response_invalid".to_string());
                }
                return Ok(value.id);
            }
            401 => return Err("discord_auth_failed".to_string()),
            403 => return Err("discord_permission_denied".to_string()),
            _ => return Err("discord_api_unavailable".to_string()),
        }
    }
    Err("discord_rate_limited".to_string())
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
    // Return base64 to avoid JSON number-array serialization (14 MB VRM ??~200 MB JS heap).
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

// ?? Gemini Live WebSocket proxy commands ??
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

// ?? naia-settings asset commands ?????????????????????????????????????????????

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

/// Extract a .nva ZIP archive to `dest` directory.
fn extract_nva_zip(src: &std::path::Path, dest: &std::path::Path) -> Result<String, String> {
    let file = std::fs::File::open(src).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        // Path traversal guard
        if name.contains("..") {
            continue;
        }
        let out_path = dest.join(&name);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out_file = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out_file).map_err(|e| e.to_string())?;
        }
    }
    Ok(dest
        .to_str()
        .ok_or_else(|| "Invalid destination path".to_string())?
        .to_string())
}

/// Recursively collect `(forward-slash relative name, absolute path)` for every file
/// under `root`, relative to `base`. Separators are normalized to `/` so the produced
/// ZIP is portable: the cascade server (Linux python `zipfile`) reconstructs the
/// `clips/` folder correctly. Backslash entries (PowerShell `Compress-Archive`) flatten
/// on Linux and drop `clips/*` ??a silent 0-byte idle. Matches the nva editor
/// `buildNvaZip()` / cascade `/upload_nva` contract.
fn collect_bundle_files(
    root: &std::path::Path,
    base: &std::path::Path,
    out: &mut Vec<(String, std::path::PathBuf)>,
) -> Result<(), String> {
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            collect_bundle_files(&path, base, out)?;
        } else if path.is_file() {
            let rel = path
                .strip_prefix(base)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            out.push((rel, path));
        }
    }
    Ok(())
}

/// Zip a local NVA bundle directory in memory (forward-slash entries) and POST it to the
/// remote cascade `POST /upload_nva` (`Content-Type: application/zip`). Mirrors the nva
/// editor `casUpload()` so the shell auto-registers a locally-selected character on a
/// remote server that doesn't have it ??e.g. after a server reboot wipes the `/tmp`
/// extract, the shell re-uploads on the next select. Returns the server-assigned
/// `bundle_id`.
#[tauri::command]
async fn upload_nva_bundle(runtime_url: String, bundle_dir: String) -> Result<String, String> {
    use std::io::Write as _;

    let dir = std::path::PathBuf::from(&bundle_dir);
    if !dir.is_dir() {
        return Err(format!("Bundle dir not found: {bundle_dir}"));
    }
    // Guard: only zip real NVA bundles (must live under naia-settings/nva-files/).
    if !bundle_dir
        .replace('\\', "/")
        .contains("naia-settings/nva-files/")
    {
        return Err("Refusing to zip: not an nva-files bundle path".to_string());
    }

    // Collect files with forward-slash relative names.
    let mut files: Vec<(String, std::path::PathBuf)> = vec![];
    collect_bundle_files(&dir, &dir, &mut files)?;
    if files.is_empty() {
        return Err("Bundle dir is empty".to_string());
    }
    if !files.iter().any(|(n, _)| n == "manifest.json") {
        return Err("Bundle missing manifest.json".to_string());
    }

    // Build the ZIP in memory. Stored (no deflate): webm/png are already compressed, so
    // deflate barely helps, and Stored avoids any compression feature-gate risk.
    let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
    {
        let mut zw = zip::ZipWriter::new(&mut cursor);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, path) in &files {
            let bytes = std::fs::read(path).map_err(|e| format!("read {name}: {e}"))?;
            zw.start_file(name.as_str(), opts)
                .map_err(|e| e.to_string())?;
            zw.write_all(&bytes).map_err(|e| e.to_string())?;
        }
        zw.finish().map_err(|e| e.to_string())?;
    }
    let zip_bytes = cursor.into_inner();

    // POST to {runtime_url}/upload_nva. Tailnet (.ts.net) certs are real Let's Encrypt,
    // so rustls trusts them without any danger-accept override.
    let base = runtime_url.trim_end_matches('/');
    let url = format!("{base}/upload_nva");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;
    let res = client
        .post(&url)
        .header("Content-Type", "application/zip")
        .body(zip_bytes)
        .send()
        .await
        .map_err(|e| format!("upload_nva request failed: {e}"))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("upload_nva HTTP {}: {text}", status.as_u16()));
    }
    // Parse { ok, bundle_id, detail? }.
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("upload_nva bad JSON: {e} ({text})"))?;
    if json.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let detail = json
            .get("detail")
            .or_else(|| json.get("error"))
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error");
        return Err(format!("upload_nva rejected: {detail}"));
    }
    Ok(json
        .get("bundle_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
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

    // nva-files: .nva is a ZIP archive (manifest.json + clips/). Extract it.
    if subdir == "nva-files" {
        if !src.is_file() {
            return Err("Source must be a .nva file for nva-files".to_string());
        }
        let stem = src
            .file_stem()
            .and_then(|n| n.to_str())
            .ok_or_else(|| "Invalid source filename".to_string())?
            .to_string();
        let dest_dir = std::path::PathBuf::from(&adk_path)
            .join("naia-settings")
            .join(&subdir);
        std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
        let dest = unique_dest(&dest_dir, &stem, "");
        extract_nva_zip(&src, &dest)?;
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

/// Read `{adk_path}/naia-settings/ui-config.json` (?뚰겕?ㅽ럹?댁뒪蹂?UI ?뺤껜????VRM/諛곌꼍/BGM).
/// agent 誘몄냼鍮?env ?ㅼ뿼 諛⑹?) ?????꾩슜. config.json(agent ?뚮퉬)怨?遺꾨━(FR-WS.2). ?놁쑝硫?鍮?臾몄옄??
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

/// Write `{adk_path}/naia-settings/ui-config.json` (???꾩슜 ??agent 誘몄냼鍮?.
#[tauri::command]
async fn write_naia_ui_config(adk_path: String, json: String) -> Result<(), String> {
    let dir = std::path::PathBuf::from(&adk_path).join("naia-settings");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("ui-config.json"), json).map_err(|e| e.to_string())
}

/// Read `{adk_path}/naia-settings/knowledge.json` (吏???뚯뒪/?ㅼ퐫???ㅼ젙 ?????꾩슜, agent ?쎄린?꾩슜).
/// ?ㅼ젙 遺덇?移?FR-KB-OS.9): ?щ엺??UI 濡쒕쭔 蹂寃? agent ??config-write ?꾧뎄媛 ?놁뼱 紐?諛붽씔?? ?놁쑝硫?鍮?臾몄옄??
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

/// Write `{adk_path}/naia-settings/knowledge.json` (???꾩슜 ???щ엺???ㅼ젙 UI 濡쒕쭔 蹂寃? FR-KB-OS.5/9).
#[tauri::command]
async fn write_naia_knowledge_config(adk_path: String, json: String) -> Result<(), String> {
    let dir = std::path::PathBuf::from(&adk_path).join("naia-settings");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("knowledge.json"), json).map_err(|e| e.to_string())
}

/// Read compiled KB at `{adk_path}/knowledge/{scope}/kb.json` (而댄뙆???곗텧 ???듦퀎 ?쒖떆?? FR-KB-OS.7).
/// scope ??path-traversal 李⑤떒(援щ텇?먃?..` 湲덉?). ?놁쑝硫?鍮?臾몄옄??= 誘몄뺨?뚯씪).
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

/// UC-KNOWLEDGE-COMPILE(FR-KB-OS.8): ?ㅼ젙 吏????"吏湲?而댄뙆?? ??agent `CompileKnowledge` RPC.
/// spawn ??蹂닿???agent gRPC addr 濡?蹂꾨룄 unary ?대씪 connect ???먯씠?꾪듃媛 naia-settings/knowledge.json
/// ???깅줉 ?대뜑 ??kb-compiler compile ??knowledge/<scope>/kb.json. agent 誘멸???= Err(UI 媛 ?뺤쭅 ?쒓린).
#[tauri::command]
async fn compile_knowledge(
    adk_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // gRPC addr 異붿텧 ??std Mutex 媛?쒕뒗 await ?〓떒 湲덉?(釉붾줉???댁젣 ??await).
    let addr = {
        let guard = state.agent.lock().map_err(|_| "agent lock".to_string())?;
        guard.as_ref().map(|a| a.grpc_addr.clone())
    };
    let addr = addr.ok_or_else(|| "agent unavailable".to_string())?;
    let mut client = agent_grpc::AgentGrpc::connect(format!("http://{}", addr))
        .await
        .map_err(|e| format!("agent connect ?ㅽ뙣: {}", e))?;
    let r = client
        .compile_knowledge(adk_path)
        .await
        .map_err(|e| format!("compile ?ㅽ뙣: {}", e))?;
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

// ?? ???transcript read(FR-CONV.3) ?????????????????????????????????????????????
// `{adk_path}/conversations/` = agent(?꾨몢??媛 append ?섎뒗 verbatim ??붾줉(?고????곗씠??. **content ?⑥씪 writer = agent**;
// shell ? read + delete(?몄뀡 lifecycle 愿由? UI ??젣踰꾪듉)留???content append/?섏젙 ???? agent 遺??二쎌쓬?먮룄 ?뚯씪 吏곸젒
// read(E1, brain-body-environment). 二쎌? 寃뚯씠?몄썾??directToolCall ?泥? (delete-以?active-append race = ?몄뀡 ?ъ깮??wart,
// Phase1 ?덉슜: 理쒖븙????젣 ?몄뀡??洹??대쭔 媛뽮퀬 ?щ벑?? ?먯긽 ?꾨떂.)

fn conversations_dir(adk_path: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(adk_path).join("conversations")
}

/// sessionId ???덉쟾 ?뚯씪紐?踰좎씠??traversal쨌寃쎈줈 ?몄젥??李⑤떒; agent conversation-log sessionFileName 怨??숉삎).
/// ?곸닽??`_`/`-` ??移섑솚, ?좏뻾 `_`/`.` ?쒓굅, 128 cap. 鍮?鍮꾩젙??= "default".
/// ?좑툘 ?쒓퀎: ?꾨? 鍮?ASCII(?쒖닔 ?쒓? ?? sessionId ??移섑솚 ??鍮???"default" ?⑸쪟. ??client localSessionId ??
///    ASCII(`chat-<ts>-<rand>`, stores/chat.ts)??誘몃컻?? 鍮?ASCII ?ㅼ쨷 client ?꾩엯 ??hash ?대갚 ?꾩슂(Phase2).
fn safe_session_base(session_id: &str) -> String {
    let mapped: String = session_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let base: String = mapped
        .trim_start_matches(|c| c == '_' || c == '.')
        .chars()
        .take(128)
        .collect();
    if base.is_empty() {
        "default".to_string()
    } else {
        base
    }
}

/// ?몄뀡 transcript ?뚯씪 ?ш린 ?곹븳(蹂묐━???뚯씪??list/read ??IPC쨌硫붾え由щ? ??＜?쒗궎??寃?李⑤떒; ?곷???由щ럭 MED).
/// text ??붾줉 ?꾩떎 ?곹븳(?섏쿇 ??????MB) ?⑥뵮 ?? writer=?좊ː agent ???꾪삊? ??쑝??諛⑹뼱?ъ링(read_local_binary ? ?숉삎).
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
            // 蹂묐━???ш린 ?뚯씪 = ?꾩껜 ?뚯떛 skip(硫붾え由???＜ 李⑤떒, ?곷???由щ럭 MED). mtime degraded ?뷀듃由щ줈 ?몄텧(?④린吏 ?딆쓬).
            if entry
                .metadata()
                .map(|m| m.len() > MAX_CONV_BYTES)
                .unwrap_or(false)
            {
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
        b.get("updatedAt")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0)
            .cmp(
                &a.get("updatedAt")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
            )
    });
    Ok(serde_json::json!({ "sessions": sessions }).to_string())
}

/// Read a conversation's raw JSONL (`{adk_path}/conversations/{session}.jsonl`). Empty string if absent. Read-only(FR-CONV.3).
#[tauri::command]
async fn read_conversation(adk_path: String, session_id: String) -> Result<String, String> {
    let file =
        conversations_dir(&adk_path).join(format!("{}.jsonl", safe_session_base(&session_id)));
    if !file.exists() {
        return Ok(String::new());
    }
    // 蹂묐━???ш린 IPC payload 李⑤떒(?곷???由щ럭 MED) ??read_local_binary ??MAX_BYTES 媛?쒖? ?숉삎.
    if let Ok(meta) = std::fs::metadata(&file) {
        if meta.len() > MAX_CONV_BYTES {
            return Err(format!(
                "transcript too large: {} bytes (max {})",
                meta.len(),
                MAX_CONV_BYTES
            ));
        }
    }
    std::fs::read_to_string(&file).map_err(|e| e.to_string())
}

/// Delete a conversation session file. session_id sanitized(traversal 李⑤떒).
#[tauri::command]
async fn delete_conversation(adk_path: String, session_id: String) -> Result<(), String> {
    let file =
        conversations_dir(&adk_path).join(format!("{}.jsonl", safe_session_base(&session_id)));
    if file.exists() {
        std::fs::remove_file(&file).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod conversation_path_tests {
    use super::safe_session_base;
    // 蹂댁븞 寃쎄퀎(traversal/delete) Rust ?⑥쐞 而ㅻ쾭 ??agent sessionFileName contract ? cross-port ?숈튂(?곷???由щ럭 MED).
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
    // ???뚯씪?쒖뒪???듯빀 ??list/read/delete_conversation ??agent-format jsonl ?ㅽ뙆?쇱뿉 ????ㅽ뻾(FR-CONV.3/4).
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
        fs::write(
            adk.join("conversations").join(name),
            format!("{}\n", lines.join("\n")),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn list_read_delete_roundtrip() {
        let adk = temp_adk("rd");
        // agent conversation-log-store ? ?숈씪 ?щ㎎(user/assistant + timestamp)
        write_jsonl(
            &adk,
            "chat-1.jsonl",
            &[
                r#"{"role":"user","content":"?덈뀞","timestamp":1000}"#,
                r#"{"role":"assistant","content":"諛섍??뚯슂","timestamp":1001}"#,
            ],
        );
        write_jsonl(
            &adk,
            "chat-2.jsonl",
            &[
                r#"{"role":"user","content":"?좎뵪","timestamp":2000}"#,
                r#"{"role":"assistant","content":"留묒쓬","timestamp":2001}"#,
            ],
        );
        let adk_s = adk.to_str().unwrap().to_string();

        // list: 2 ?몄뀡, updatedAt desc(chat-2 癒쇱?), label=泥?user content, messageCount=2
        let v: serde_json::Value =
            serde_json::from_str(&list_conversations(adk_s.clone()).await.unwrap()).unwrap();
        let sessions = v["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0]["key"], "chat-2");
        assert_eq!(sessions[0]["label"], "?좎뵪");
        assert_eq!(sessions[0]["messageCount"], 2);

        // read: raw jsonl 洹몃?濡?
        let raw = read_conversation(adk_s.clone(), "chat-1".into())
            .await
            .unwrap();
        assert!(raw.contains("?덈뀞") && raw.contains("諛섍??뚯슂"));

        // read traversal: sanitize ??conversations 諛??묎렐 遺덇?(遺??= 鍮덈Ц?먯뿴)
        assert_eq!(
            read_conversation(adk_s.clone(), "../../naia-settings/config".into())
                .await
                .unwrap(),
            ""
        );

        // delete: chat-1 ??list 1媛?
        delete_conversation(adk_s.clone(), "chat-1".into())
            .await
            .unwrap();
        assert!(!adk.join("conversations").join("chat-1.jsonl").exists());
        let after: serde_json::Value =
            serde_json::from_str(&list_conversations(adk_s.clone()).await.unwrap()).unwrap();
        assert_eq!(after["sessions"].as_array().unwrap().len(), 1);

        // delete traversal: conversations 諛??뚯씪???덈? ??吏?(蹂댁븞 ?듭떖)
        fs::write(adk.join("outside.txt"), "secret").unwrap();
        let _ = delete_conversation(adk_s.clone(), "../outside".into()).await;
        assert!(
            adk.join("outside.txt").exists(),
            "traversal delete must not remove files outside conversations"
        );

        let _ = fs::remove_dir_all(&adk);
    }

    #[tokio::test]
    async fn empty_and_missing() {
        let adk = temp_adk("empty");
        let adk_s = adk.to_str().unwrap().to_string();
        assert_eq!(
            list_conversations(adk_s.clone()).await.unwrap(),
            "{\"sessions\":[]}"
        );
        assert_eq!(
            read_conversation(adk_s.clone(), "nope".into())
                .await
                .unwrap(),
            ""
        );
        assert!(delete_conversation(adk_s.clone(), "nope".into())
            .await
            .is_ok());
        let _ = fs::remove_dir_all(&adk);
    }
}

/// Write an API key to naia-agent's OS keychain storage.
///
/// Mirrors naia-agent's `keychainSet()` so the standalone agent can read back
/// credentials that naia-os saved ??without requiring a separate `naia-agent login` run.
///
/// Storage layout (same as naia-agent):
///   Windows : `{adk_path}/naia-settings/.keys/{env_key}.dpapi`  (DPAPI-encrypted)
///   macOS   : OS Keychain via `security` CLI
///   Linux   : Secret Service via `secret-tool`
/// Also updates the credentials manifest at `{adk_path}/naia-settings/credentials`.
#[tauri::command]
async fn write_agent_key(adk_path: String, env_key: String, value: String) -> Result<(), String> {
    let value = zeroize::Zeroizing::new(value);
    #[cfg(not(target_os = "macos"))]
    use std::io::Write as _;
    use std::path::PathBuf;

    if adk_path.is_empty() || env_key.is_empty() {
        return Err("adk_path and env_key must not be empty".to_string());
    }
    // Basic safety: env_key must be alphanumeric + underscore only.
    if !env_key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err(format!("invalid env_key: {env_key}"));
    }

    let settings_dir = PathBuf::from(&adk_path).join("naia-settings");
    let keys_dir = settings_dir.join(".keys");
    std::fs::create_dir_all(&keys_dir).map_err(|e| e.to_string())?;

    // ?? Platform keychain write ??????????????????????????????????????????????
    #[cfg(target_os = "windows")]
    {
        // DPAPI (CurrentUser scope) via PowerShell ??same script as naia-agent keychainSet.
        let out_file = keys_dir.join(format!("{env_key}.dpapi"));
        // Escape for PowerShell single-quoted string: ' ??'' and \ ??\\
        let out_path = out_file
            .to_string_lossy()
            .replace('\'', "''")
            .replace('\\', "\\\\");
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
            stdin
                .write_all(value.as_bytes())
                .map_err(|e| e.to_string())?;
            drop(stdin);
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("DPAPI encrypt failed (exit {status})"));
        }
    }

    #[cfg(target_os = "macos")]
    {
        // macOS Keychain ??same service name as naia-agent ("naia-agent").
        let mut child = std::process::Command::new("security")
            .args([
                "add-generic-password",
                "-a",
                &env_key,
                "-s",
                "naia-agent",
                "-U", // update if exists
                "-w", // final flag prompts on stdin; never expose the token in argv
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("security CLI failed: {e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(value.as_bytes())
                .and_then(|_| stdin.write_all(b"\n"))
                .map_err(|e| format!("security stdin failed: {e}"))?;
        }
        let status = child
            .wait()
            .map_err(|e| format!("security CLI wait failed: {e}"))?;
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
                "--label",
                &format!("naia-agent:{env_key}"),
                "service",
                "naia-agent",
                "account",
                &env_key,
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .and_then(|mut c| {
                if let Some(mut s) = c.stdin.take() {
                    let _ = s.write_all(value.as_bytes());
                }
                c.wait()
            })
            .map_err(|e| format!("secret-tool failed: {e}"))?;
        if !status.success() {
            return Err(format!("Linux Secret Service write failed (exit {status})"));
        }
    }

    // ?? Update credentials manifest ?????????????????????????????????????????
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
        std::fs::write(
            &creds_path,
            serde_json::to_string_pretty(&manifest).unwrap() + "\n",
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

async fn remove_agent_key(adk_path: &str, env_key: &str) -> Result<(), String> {
    let settings_dir = std::path::PathBuf::from(adk_path).join("naia-settings");
    #[cfg(target_os = "windows")]
    {
        let path = settings_dir.join(".keys").join(format!("{env_key}.dpapi"));
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("DPAPI delete failed: {error}")),
        }
    }
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("security")
            .args(["delete-generic-password", "-a", env_key, "-s", "naia-agent"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|error| format!("security CLI failed: {error}"))?;
        if !status.success() {
            return Err("macOS Keychain delete failed".to_string());
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let status = std::process::Command::new("secret-tool")
            .args(["clear", "service", "naia-agent", "account", env_key])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|error| format!("secret-tool failed: {error}"))?;
        if !status.success() {
            return Err("Linux Secret Service delete failed".to_string());
        }
    }
    let credentials = settings_dir.join("credentials");
    let keys = std::fs::read_to_string(&credentials)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value.get("keys").and_then(|keys| keys.as_array()).cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(str::to_string))
        .filter(|key| key != env_key)
        .collect::<Vec<_>>();
    write_owner_only_atomic(
        &credentials,
        &(serde_json::to_vec_pretty(&serde_json::json!({ "keys": keys }))
            .map_err(|_| "credentials_manifest_invalid".to_string())?),
    )
}

/// ??λ맂 ??*議댁옱 ?щ?*留?蹂닿퀬?쒕떎(媛믪? ?덈? 諛섑솚 ??????鍮꾨???webview 濡??섏씫吏 ?딅뒗?? 蹂댁븞).
/// 洹쇨굅 = write_agent_key 媛 ?좎??섎뒗 鍮꾨?-?꾨땶 留ㅻ땲?섏뒪??`{adk}/naia-settings/credentials` = {keys:[env_key??}.
/// ??Settings 媛 ???낅젰???`*****`(??λ맖)濡?留덉뒪???쒓린?섎뒗 ???ъ슜.
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
/// - `"missing"`         ??path empty / does not exist / not a directory
/// - `"has_settings"`    ??`naia-settings/` subdir present (full ADK)
/// - `"has_other_files"` ??non-empty directory but no `naia-settings/`
/// - `"empty"`           ??directory exists and is empty (clone target)
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
async fn write_naia_path_cache(
    adk_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    with_discord_lifecycle(&state.discord_lifecycle, || {
        if adk_path.is_empty() {
            return Err("adk_path is empty".to_string());
        }
        let naia_dir = dirs::home_dir()
            .ok_or_else(|| "Cannot determine home directory".to_string())?
            .join(".naia");
        std::fs::create_dir_all(&naia_dir).map_err(|e| e.to_string())?;
        std::fs::write(naia_dir.join("adk-path"), &adk_path).map_err(|e| e.to_string())?;
        Ok(())
    })
}

/// Copy bundled default assets (vrm-files, background, bgm-musics) from the app's
/// resource directory into `{adk_path}/naia-settings/`. Skips files that already exist.
#[tauri::command]
async fn copy_bundled_assets(app_handle: tauri::AppHandle, adk_path: String) -> Result<(), String> {
    // Extend asset:// protocol scope to include this ADK path (#277).
    // Static tauri.conf.json scope (`$HOME/**`, `/var/home/*/naia-adk/**`, ??
    // covers default placements only. Users who put their ADK on
    // `/mnt/external/...`, `/opt/...`, `D:\...`, `/Volumes/...` would
    // otherwise fail to load VRM / BGM / background via asset:// URLs.
    // This is the single chokepoint ??every ADK setup path (new /
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
/// `state` ?몄옄 異붽? (cherry-pick 0e7a5960 ??body 媛 state.agent / state.gateway
/// lock ?몄텧 ??agent/gateway 媛 adk_path ??file handle ?↔퀬 ?덉뼱 Windows ?먯꽌
/// remove_dir_all ?ㅽ뙣 諛⑹?). Tauri 媛 ?먮룞 inject ?섎?濡?frontend ?몄텧? 洹몃?濡?
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

    // E2E mock ??bypass agent kill + filesystem delete; e2e specs use
    // disposable temp paths so a best-effort cleanup is enough.
    if std::env::var("NAIA_E2E_MOCK_CLONE")
        .map(|v| v == "1")
        .unwrap_or(false)
    {
        log_verbose("[delete_naia_adk] NAIA_E2E_MOCK_CLONE=1 ??best-effort cleanup");
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

    std::fs::remove_dir_all(&adk).map_err(|e| format!("Failed to delete {adk_path}: {e}"))
}

/// Clone nextain/naia-adk (shallow) into adk_path.
/// Falls back to zip download if git is not installed.
/// Fails if the directory already exists and is non-empty.
///
/// Emits `adk_setup_progress` events so the UI can show what is happening:
///   { phase: "zip_fallback" }                                  ??git failed
///   { phase: "zip_progress", downloaded, total }               ??bytes received
#[tauri::command]
async fn clone_naia_adk(adk_path: String, app_handle: AppHandle) -> Result<(), String> {
    if adk_path.is_empty() {
        return Err("adk_path is empty".to_string());
    }
    let path = std::path::PathBuf::from(&adk_path);
    if path.is_dir() {
        let non_empty = path
            .read_dir()
            .map(|mut d| d.next().is_some())
            .unwrap_or(false);
        if non_empty {
            return Err(format!("Directory is not empty: {adk_path}"));
        }
    }

    // E2E mock ??bypass network/git/zip and lay down a minimal scaffold.
    // Activated by NAIA_E2E_MOCK_CLONE=1 (set by wdio.conf.ts). This lets
    // the setup UI proceed through clone ??init ??copy-assets ??onboarding
    // in O(ms) instead of O(seconds-to-minutes) and removes network/CI
    // flakiness from #328 e2e.
    if std::env::var("NAIA_E2E_MOCK_CLONE")
        .map(|v| v == "1")
        .unwrap_or(false)
    {
        log_verbose("[clone_naia_adk] NAIA_E2E_MOCK_CLONE=1 ??writing mock scaffold");
        std::fs::create_dir_all(&path).map_err(|e| format!("mock create_dir_all: {e}"))?;
        std::fs::write(path.join("README.md"), "# E2E mock naia-adk\n")
            .map_err(|e| format!("mock write README: {e}"))?;
        return Ok(());
    }

    // Try git clone first.
    let mut cmd = std::process::Command::new("git");
    cmd.args([
        "clone",
        "--depth",
        "1",
        "https://github.com/nextain/naia-adk",
        &adk_path,
    ]);
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

    // Fallback: download zip from GitHub and extract ??emit progress so UI is not silent.
    let _ = app_handle.emit(
        "adk_setup_progress",
        serde_json::json!({
            "phase": "zip_fallback"
        }),
    );
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
            let _ = app_handle.emit(
                "adk_setup_progress",
                serde_json::json!({
                    "phase": "zip_progress",
                    "downloaded": downloaded,
                    "total": total,
                }),
            );
            last_emit = std::time::Instant::now();
        }
    }
    // Final progress emit so UI shows 100% before extraction starts.
    let _ = app_handle.emit(
        "adk_setup_progress",
        serde_json::json!({
            "phase": "zip_progress",
            "downloaded": downloaded,
            "total": total,
        }),
    );

    // Extract ??GitHub zips contain a single top-level "naia-adk-main/" folder.
    let cursor = std::io::Cursor::new(buf);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("zip open failed: {e}"))?;

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

    // Open debug log file ??frontend logs are written here with flush so crashes are captured.
    let log_path = std::env::temp_dir().join("naia-debug.log");
    match std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)
    {
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
                    process_deep_link_url(&arg, app, oauth_state.as_ref(), "single-instance");
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
            discord_lifecycle: Mutex::new(()),
            discord_quarantined: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            discord_pending_reapers: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            discord_config_operation: tokio::sync::Mutex::new(()),
            discord_inbox_authorized_bindings:
                tokio::sync::Mutex::new(None),
            bgm_server: Mutex::new(None),
            cascade: Mutex::new(None),
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
            discord_bot_token_available,
            discord_connection_status,
            discord_capture_bot_token,
            discord_remove_bot_token,
            discord_discover_channels,
            discord_binding_snapshot,
            discord_save_bindings,
            discord_get_last_binding,
            discord_set_last_binding,
            discord_inbox_snapshot,
            discord_inbox_snapshot_cached,
            discord_fetch_channel_history,
            discord_mark_inbox_read,
            discord_open_dm_channel,
            fetch_linked_channels,
            gemini_live_connect,
            gemini_live_send_audio,
            gemini_live_send_text,
            gemini_live_send_tool_response,
            gemini_live_disconnect,
            // naia-settings asset commands
            list_naia_assets,
            upload_nva_bundle,
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
            // ???transcript read-only(FR-CONV.3) ??agent write / shell read(E1 agent ?낅┰)
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
            app::app_list_installed,
            app::app_remove_installed,
            app::app_read_file,
            app::app_run_shell,
            app::app_install,
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
            // Shell reads that file via memory::get_all_agent_facts() ??no SQLite DB needed.

            // Migrate legacy vosk-models ??stt-models
            stt_models::migrate_legacy_vosk_models(&app_handle);

            // OAuth callback HTTP server (#341 ?듭뀡 B ??Linux dev:tauri ??
            // `naia://` 誘몃벑濡??고쉶). ?숈씪 query parameter shape ??
            // process_deep_link_url 洹몃?濡??쒖슜. Best-effort: bind ?ㅽ뙣 ??
            // (port 異⑸룎 ?? 寃쎄퀬留?+ deep-link path 濡쒕쭔 ?숈옉.
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
            start_discord_inbox_watcher(app_handle.clone());

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
                log_both("[Naia] *** MINIMAL MODE ??skipping gateway/agent/orphan cleanup ***");
                let _ = app_handle.emit(
                    "gateway_status",
                    serde_json::json!({ "running": false, "managed": false }),
                );
                return Ok(());
            }

            // Clean up orphan processes from previous sessions
            platform::cleanup_orphan_processes();
            platform::kill_stale_gateway();
            // ?꿤ascade 怨좎븘(uvicorn facade ?먯옄, PID 誘몄텛?? ?뺣━ ??8910 EADDRINUSE 諛⑹?(R2.2b).
            // dev 諛섎났 湲곕룞 ???댁쟾 ?몄뀡??cascade 媛 ??二쎄퀬 ?⑥븘 ?ㅼ쓬 start_cascade 瑜?留됰뒗??
            platform::kill_stale_cascade();

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

            // Then spawn Agent (naia-agent replaces OpenClaw gateway ??handles all tools directly)
            let agent_spawn = with_discord_lifecycle(&state.discord_lifecycle, || {
                let process = spawn_agent_core(
                    &app_handle,
                    &audit_db,
                    &state.discord_quarantined,
                    &state.discord_pending_reapers,
                    false,
                )?;
                let mut guard = lock_or_recover(&state.agent, "state.agent(setup)");
                *guard = Some(process);
                Ok::<(), String>(())
            });
            match agent_spawn {
                Ok(()) => {
                    log_both("[Naia] agent-core started");
                    // Emit running:true ??naia-agent is the tool backend after #201
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

            // Spawn YouTube BGM HTTP server (port 18791) ??#335.
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

                    // Kill BGM server sidecar (#335) ??independent of agent
                    let bgm_lock = state.bgm_server.lock();
                    if let Ok(mut guard) = bgm_lock {
                        if let Some(mut process) = guard.take() {
                            log_verbose("[Naia] Terminating BGM server...");
                            let _ = process.child.kill();
                        }
                    }
                    remove_pid_file("bgm-server");

                    // Kill local cascade supervisor (R2.2b) ??loader teardowns its
                    // children. Drop also kills, but take()+kill here is explicit.
                    if let Ok(mut guard) = state.cascade.lock() {
                        if let Some(mut process) = guard.take() {
                            log_verbose("[Naia] Terminating local cascade...");
                            let _ = process.child.kill();
                        }
                    }
                    remove_pid_file("cascade");

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
                                log_verbose("[Naia] Gateway not managed by us ??leaving it running");
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

    fn unknown_length_response(body: Vec<u8>) -> (String, std::thread::JoinHandle<()>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let address = server.server_addr().to_ip().unwrap();
        let handle = std::thread::spawn(move || {
            let request = server.recv().unwrap();
            let response = tiny_http::Response::new(
                tiny_http::StatusCode(200),
                Vec::new(),
                std::io::Cursor::new(body),
                None,
                None,
            );
            let _ = request.respond(response);
        });
        (format!("http://{address}"), handle)
    }

    #[tokio::test]
    async fn discord_bounded_body_rejects_unknown_length_oversize() {
        let (url, server) = unknown_length_response(vec![b'x'; 65]);
        let response = reqwest::Client::new().get(url).send().await.unwrap();

        let result = discord_read_bounded_body(response, 64).await;

        assert_eq!(result.unwrap_err(), "discord_response_too_large");
        server.join().unwrap();
    }

    #[tokio::test]
    async fn discord_bounded_body_accepts_unknown_length_at_limit() {
        let expected = vec![b'x'; 64];
        let (url, server) = unknown_length_response(expected.clone());
        let response = reqwest::Client::new().get(url).send().await.unwrap();

        let result = discord_read_bounded_body(response, 64).await.unwrap();

        assert_eq!(result, expected);
        server.join().unwrap();
    }

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
        // Either Ok (node found) or Err (not found) ??both are valid
        match result {
            Ok(path) => assert!(
                path.is_absolute(),
                "successful Node resolution must be observable as an absolute path: {}",
                path.display()
            ),
            Err(e) => assert!(e.contains("Node.js")),
        }
    }

    #[test]
    fn select_node_binary_prefers_environment_override() {
        let selected = select_node_binary(
            Some(std::ffi::OsString::from("C:\\custom\\node.exe")),
            || panic!("bundled lookup must not run after an explicit override"),
            || panic!("system lookup must not run after an explicit override"),
        );
        assert_eq!(selected, std::path::PathBuf::from("C:\\custom\\node.exe"));
    }

    #[test]
    fn select_node_binary_prefers_bundle_over_system() {
        let bundled = std::path::PathBuf::from("/installed/resources/node");
        let selected = select_node_binary(
            None,
            || Some(bundled.clone()),
            || panic!("system lookup must not run when bundled Node exists"),
        );
        assert_eq!(selected, bundled);
    }

    #[test]
    fn select_node_binary_preserves_system_fallback() {
        let system = std::path::PathBuf::from("/usr/local/bin/node");
        let selected = select_node_binary(None, || None, || Ok(system.clone()));
        assert_eq!(selected, system);
    }

    #[test]
    fn check_gateway_health_sync_returns_bool() {
        // Should return a bool without panicking, regardless of gateway state
        let _healthy = check_gateway_health_sync();
        // Result is environment-dependent: true if gateway running, false if not
    }

    #[test]
    fn infer_repos_adk_root_finds_workspace_from_nested_naia_adk() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("alpha-adk");
        let user_adk = workspace.join("projects").join("naia-adk");
        let loader = workspace
            .join("projects")
            .join("naia-omni-windows-manager")
            .join("loader");
        std::fs::create_dir_all(&user_adk).unwrap();
        std::fs::create_dir_all(&loader).unwrap();

        let resolved = infer_repos_adk_root(user_adk.to_str().unwrap()).unwrap();

        assert_eq!(
            std::path::PathBuf::from(resolved),
            dunce::canonicalize(&workspace).unwrap()
        );
    }

    #[test]
    fn infer_repos_adk_root_accepts_workspace_root_directly() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("alpha-adk");
        let loader = workspace
            .join("projects")
            .join("naia-omni-windows-manager")
            .join("loader");
        std::fs::create_dir_all(&loader).unwrap();

        let resolved = infer_repos_adk_root(workspace.to_str().unwrap()).unwrap();

        assert_eq!(
            std::path::PathBuf::from(resolved),
            dunce::canonicalize(&workspace).unwrap()
        );
    }

    #[test]
    fn infer_repos_adk_root_returns_none_without_workspace_checkout() {
        let dir = tempfile::tempdir().unwrap();
        let user_adk = dir.path().join("naia-adk");
        std::fs::create_dir_all(&user_adk).unwrap();

        assert_eq!(infer_repos_adk_root(user_adk.to_str().unwrap()), None);
    }
    #[test]
    fn read_cascade_loader_profile_reads_manifest_gpu_profile() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = dir.path().join("slots-manifest.json");
        std::fs::write(&manifest, r#"{"gpu":{"loaderProfile":" laptop_4060_8g "}}"#).unwrap();

        assert_eq!(
            read_cascade_loader_profile(&manifest).as_deref(),
            Some("laptop_4060_8g")
        );
    }

    #[test]
    fn read_cascade_loader_profile_rejects_invalid_profile() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = dir.path().join("slots-manifest.json");
        std::fs::write(&manifest, r#"{"gpu":{"loaderProfile":"laptop;rm"}}"#).unwrap();

        assert_eq!(read_cascade_loader_profile(&manifest), None);
    }

    #[test]
    fn bgm_health_requires_current_launch_nonce() {
        let current = serde_json::json!({ "ok": true, "nonce": "current" });
        let stale = serde_json::json!({ "ok": true, "nonce": "stale" });
        let legacy = serde_json::json!({ "ok": true });
        assert!(bgm_health_matches(&current, "current"));
        assert!(!bgm_health_matches(&stale, "current"));
        assert!(!bgm_health_matches(&legacy, "current"));
    }

    #[test]
    fn gateway_process_we_spawned_flag() {
        let spawn_success = || {
            #[cfg(windows)]
            let mut command = {
                let mut command = Command::new("cmd");
                command.args(["/C", "exit", "0"]);
                command
            };
            #[cfg(not(windows))]
            let mut command = Command::new("true");
            command.spawn().unwrap()
        };

        // Verify the struct has the expected fields
        let child = spawn_success();
        let process = GatewayProcess {
            child,
            node_host: None,
            we_spawned: false,
        };
        assert!(!process.we_spawned);
        assert!(process.node_host.is_none());

        let child2 = spawn_success();
        let nh = spawn_success();
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

    // W1.review P0 (#341 ?듭뀡 B) ??path guard 媛 HTTP callback ?뺤떇??諛쏆븘????
    // ??guard ??host_str=="auth" 留??몄젙??HTTP `http://127.0.0.1:18792/auth/callback`
    // ??silently reject. ?섏젙 = `is_deep_link_auth || is_http_callback` ?뺤떇.
    #[test]
    fn path_guard_accepts_http_callback() {
        let url =
            url::Url::parse("http://127.0.0.1:18792/auth/callback?key=gw-abc&state=xyz").unwrap();
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

    #[test]
    fn discord_token_validation_is_bounded_and_printable() {
        assert!(validate_discord_token(b"abc.DEF-123").is_ok());
        assert_eq!(validate_discord_token(b""), Err("token_invalid".to_string()));
        assert_eq!(
            validate_discord_token(b"contains space"),
            Err("token_invalid".to_string())
        );
        assert_eq!(
            validate_discord_token(&vec![b'x'; 513]),
            Err("token_invalid".to_string())
        );
    }

    #[test]
    fn agent_secret_lookup_classifies_absence_without_hiding_backend_errors() {
        assert_eq!(classify_agent_secret_file_presence(Ok(false)), Ok(false));
        assert_eq!(classify_agent_secret_file_presence(Ok(true)), Ok(true));
        assert_eq!(
            classify_agent_secret_file_presence(Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "metadata denied",
            ))),
            Err("keychain_unavailable".to_string())
        );
        assert_eq!(
            classify_agent_secret_lookup(
                AgentSecretLookupPlatform::MacOs,
                false,
                Some(44),
                b"item not found",
            ),
            Err("token_not_found".to_string())
        );
        assert_eq!(
            classify_agent_secret_lookup(
                AgentSecretLookupPlatform::MacOs,
                false,
                Some(36),
                b"interaction not allowed",
            ),
            Err("keychain_unavailable".to_string())
        );
        assert_eq!(
            classify_agent_secret_lookup(
                AgentSecretLookupPlatform::Linux,
                false,
                Some(1),
                b"",
            ),
            Err("token_not_found".to_string())
        );
        assert_eq!(
            classify_agent_secret_lookup(
                AgentSecretLookupPlatform::Linux,
                false,
                None,
                b"",
            ),
            Err("keychain_unavailable".to_string())
        );
        assert_eq!(
            classify_agent_secret_lookup(
                AgentSecretLookupPlatform::Linux,
                false,
                Some(2),
                b"",
            ),
            Err("keychain_unavailable".to_string())
        );
        assert_eq!(
            classify_agent_secret_lookup(
                AgentSecretLookupPlatform::Linux,
                false,
                Some(1),
                b"secret service unavailable",
            ),
            Err("keychain_unavailable".to_string())
        );
        assert_eq!(
            classify_agent_secret_lookup(
                AgentSecretLookupPlatform::Linux,
                true,
                Some(0),
                b"",
            ),
            Ok(())
        );
    }

    struct DeferredDiscordChild {
        terminate_calls: usize,
        exit_checks: usize,
        exit_after_checks: Option<usize>,
    }

    impl DiscordChildLifecycle for DeferredDiscordChild {
        fn request_termination(&mut self) -> std::io::Result<()> {
            self.terminate_calls += 1;
            Ok(())
        }

        fn has_exited(&mut self) -> std::io::Result<bool> {
            self.exit_checks += 1;
            Ok(self
                .exit_after_checks
                .is_some_and(|required| self.exit_checks >= required))
        }
    }

    #[test]
    fn discord_restart_waits_until_deferred_child_is_reaped() {
        let clock = std::cell::Cell::new(std::time::Duration::ZERO);
        let mut child = DeferredDiscordChild {
            terminate_calls: 0,
            exit_checks: 0,
            exit_after_checks: Some(4),
        };

        let result = terminate_and_reap_discord_child_with(
            &mut child,
            std::time::Duration::from_millis(100),
            || clock.get(),
            |duration| clock.set(clock.get() + duration),
        );

        assert_eq!(result, Ok(()));
        assert_eq!(child.terminate_calls, 1);
        assert_eq!(child.exit_checks, 4);
        assert!(
            clock.get() >= std::time::Duration::from_millis(20),
            "restart must not continue before the deferred child reports exit"
        );
    }

    #[test]
    fn discord_restart_reaps_already_exited_child_without_terminating_again() {
        let clock = std::cell::Cell::new(std::time::Duration::ZERO);
        let mut child = DeferredDiscordChild {
            terminate_calls: 0,
            exit_checks: 0,
            exit_after_checks: Some(1),
        };

        let result = terminate_and_reap_discord_child_with(
            &mut child,
            std::time::Duration::from_millis(100),
            || clock.get(),
            |duration| clock.set(clock.get() + duration),
        );

        assert_eq!(result, Ok(()));
        assert_eq!(child.terminate_calls, 0);
        assert_eq!(child.exit_checks, 1);
        assert_eq!(clock.get(), std::time::Duration::ZERO);
    }

    #[test]
    fn discord_restart_fails_closed_when_child_cannot_be_reaped() {
        let clock = std::cell::Cell::new(std::time::Duration::ZERO);
        let mut child = DeferredDiscordChild {
            terminate_calls: 0,
            exit_checks: 0,
            exit_after_checks: None,
        };

        let result = terminate_and_reap_discord_child_with(
            &mut child,
            std::time::Duration::from_millis(25),
            || clock.get(),
            |duration| clock.set(clock.get() + duration),
        );

        assert_eq!(result, Err("discord_agent_reap_timeout".to_string()));
        assert_eq!(child.terminate_calls, 1);
        assert!(child.exit_checks >= 3);
    }

    #[test]
    fn discord_restart_revokes_authority_and_stale_status_before_spawn() {
        let dir = tempfile::tempdir().unwrap();
        let authority = dir.path().join("authority.json");
        let status = dir.path().join("status.json");
        std::fs::write(&authority, r#"{"version":1,"generation":"42"}"#).unwrap();
        std::fs::write(
            &status,
            r#"{"version":1,"generation":"42","state":"ready"}"#,
        )
        .unwrap();

        revoke_discord_runtime_files(dir.path()).unwrap();

        let revoked: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&authority).unwrap()).unwrap();
        assert_eq!(revoked["version"], 1);
        assert_eq!(revoked["generation"], "revoked");
        assert!(!status.exists(), "stale ready status must be removed");
    }

    #[test]
    fn discord_runtime_requires_matching_ready_status_and_authority() {
        let ready = DiscordRuntimeStatusFile {
            generation: "42".to_string(),
            state: "ready".to_string(),
            code: None,
        };
        let starting = DiscordRuntimeStatusFile {
            generation: "42".to_string(),
            state: "starting".to_string(),
            code: None,
        };
        let authority = DiscordRuntimeAuthorityFile {
            generation: "42".to_string(),
        };
        let stale_authority = DiscordRuntimeAuthorityFile {
            generation: "41".to_string(),
        };
        assert!(discord_runtime_matches_generation(
            "42",
            Some(&ready),
            Some(&authority),
        ));
        assert!(!discord_runtime_matches_generation(
            "42",
            Some(&starting),
            Some(&authority),
        ));
        assert!(discord_runtime_is_authoritative(
            true,
            Some("42"),
            Some(&ready),
            Some(&authority),
        ));
        assert!(
            !discord_runtime_is_authoritative(
                false,
                Some("42"),
                Some(&ready),
                Some(&authority),
            ),
            "a matching stale tuple cannot be authoritative without a token"
        );
        assert!(!discord_runtime_matches_generation(
            "42",
            Some(&ready),
            Some(&stale_authority),
        ));
        assert!(!discord_runtime_matches_generation(
            "42",
            None,
            Some(&authority),
        ));
        let stale = DiscordRuntimeStatusFile {
            generation: "41".to_string(),
            state: "failed".to_string(),
            code: Some("stale_failure".to_string()),
        };
        assert!(
            discord_runtime_status_for_generation(Some("42"), Some(&stale)).is_none(),
            "a stale runtime generation must not surface its state or diagnostic code"
        );
        assert_eq!(
            discord_runtime_status_for_generation(Some("42"), Some(&ready))
                .map(|status| status.state.as_str()),
            Some("ready")
        );
    }

    #[test]
    fn discord_expected_generation_fails_when_token_cannot_be_read() {
        assert_eq!(
            discord_runtime_token_prerequisite(Some(42), false),
            Err("discord_token_unavailable".to_string())
        );
        assert_eq!(
            discord_runtime_token_prerequisite(Some(42), true),
            Ok(Some(42))
        );
        assert_eq!(discord_runtime_token_prerequisite(None, false), Ok(None));
    }

    #[test]
    fn discord_generation_is_strictly_monotonic_even_with_same_clock_tick() {
        let first = next_discord_generation(None).unwrap();
        let second = next_discord_generation(Some(first)).unwrap();
        assert!(second > first);

        let future = first.saturating_add(10_000);
        let after_future = next_discord_generation(Some(future)).unwrap();
        assert_eq!(after_future, future + 1);
        assert_eq!(
            next_discord_generation(Some(DISCORD_MAX_SAFE_GENERATION)),
            Err("discord_bindings_generation_invalid".to_string())
        );
    }

    #[test]
    fn discord_binding_snapshot_serializes_generation_with_its_bindings() {
        let snapshot = discord_binding_snapshot_from_manifest(Some(DiscordBindingManifest {
            version: 1,
            generation: 42,
            bindings: vec![DiscordBindingInput {
                binding_id: "binding_1".to_string(),
                guild_id: "100".to_string(),
                guild_name: Some("Guild".to_string()),
                channel_id: "200".to_string(),
                channel_name: Some("general".to_string()),
                allowed_user_ids: vec!["300".to_string()],
                processing_profile_ref: "default".to_string(),
                participation: "mentions".to_string(),
            }],
            processing_profiles: std::collections::BTreeMap::from([(
                "default".to_string(),
                "local_only".to_string(),
            )]),
        }));
        let value = serde_json::to_value(snapshot).unwrap();
        assert_eq!(value["generation"], 42);
        assert_eq!(value["bindings"][0]["bindingId"], "binding_1");

        let empty = serde_json::to_value(discord_binding_snapshot_from_manifest(None)).unwrap();
        assert!(empty["generation"].is_null());
        assert_eq!(empty["bindings"], serde_json::json!([]));
    }

    #[test]
    fn discord_binding_generation_distinguishes_present_empty_from_absent() {
        assert!(discord_binding_generation_matches(Some(42), Some(42)));
        assert!(!discord_binding_generation_matches(Some(42), None));
        assert!(discord_binding_generation_matches(None, None));
        assert!(!discord_binding_generation_matches(None, Some(42)));
    }

    #[tokio::test]
    async fn discord_binding_generation_conflict_runs_no_save_side_effects() {
        async fn assert_conflict_is_side_effect_free(
            path: &std::path::Path,
            current_generation: Option<u64>,
            expected_generation: Option<u64>,
        ) {
            let discovery_calls = std::cell::Cell::new(0);
            let write_calls = std::cell::Cell::new(0);
            let restart_calls = std::cell::Cell::new(0);
            let before = std::fs::read(path).ok();

            let result = discord_binding_save_if_generation_matches(
                current_generation,
                expected_generation,
                || async {
                    discovery_calls.set(discovery_calls.get() + 1);
                    write_calls.set(write_calls.get() + 1);
                    std::fs::write(path, b"mutated").unwrap();
                    restart_calls.set(restart_calls.get() + 1);
                    Ok(())
                },
            )
            .await;

            assert_eq!(
                result,
                Err("discord_bindings_generation_conflict".to_string())
            );
            assert_eq!(discovery_calls.get(), 0);
            assert_eq!(write_calls.get(), 0);
            assert_eq!(restart_calls.get(), 0);
            assert_eq!(std::fs::read(path).ok(), before);
        }

        let present = tempfile::tempdir().unwrap();
        let present_path = present.path().join("discord-bindings.json");
        std::fs::write(
            &present_path,
            r#"{"version":1,"generation":42,"bindings":[],"processingProfiles":{"default":"local_only"}}"#,
        )
        .unwrap();
        assert_conflict_is_side_effect_free(&present_path, Some(42), Some(41)).await;

        let absent = tempfile::tempdir().unwrap();
        let absent_path = absent.path().join("discord-bindings.json");
        assert_conflict_is_side_effect_free(&absent_path, None, Some(42)).await;
        assert!(!absent_path.exists());
    }

    #[test]
    fn discord_binding_preimage_distinguishes_absence_from_read_failure() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing.json");
        assert_eq!(
            read_discord_file_preimage(&missing),
            Ok(DiscordFilePreimage::Absent)
        );

        let present = dir.path().join("present.json");
        std::fs::write(&present, b"before").unwrap();
        assert_eq!(
            read_discord_file_preimage(&present),
            Ok(DiscordFilePreimage::Present(b"before".to_vec()))
        );

        assert_eq!(
            read_discord_file_preimage(dir.path()),
            Err("discord_bindings_snapshot_failed".to_string())
        );
    }

    #[test]
    fn discord_binding_rollback_reports_restore_and_recovery_failures() {
        let restore_calls = std::cell::Cell::new(0);
        let recovery_calls = std::cell::Cell::new(0);
        let restore_failed = rollback_discord_binding_file(
            DiscordFilePreimage::Present(b"before".to_vec()),
            |_| {
                restore_calls.set(restore_calls.get() + 1);
                Err("restore failed".to_string())
            },
            || panic!("present preimage must not remove"),
            || {
                recovery_calls.set(recovery_calls.get() + 1);
                Ok(())
            },
        );
        assert!(matches!(
            restore_failed,
            Err(DiscordRollbackFailure::Restore)
        ));
        assert_eq!(restore_calls.get(), 1);
        assert_eq!(recovery_calls.get(), 0);

        let removed = std::cell::Cell::new(0);
        let recovery_failed = rollback_discord_binding_file(
            DiscordFilePreimage::Absent,
            |_| panic!("absent preimage must not write"),
            || {
                removed.set(removed.get() + 1);
                Ok(())
            },
            || Err("restart failed".to_string()),
        );
        assert!(matches!(
            recovery_failed,
            Err(DiscordRollbackFailure::Recovery)
        ));
        assert_eq!(removed.get(), 1);
    }

    #[tokio::test]
    async fn discord_credential_rollback_covers_present_absent_and_recovery_failure() {
        let restore_calls = std::cell::Cell::new(0);
        let recovery_calls = std::cell::Cell::new(0);
        let restore_failed = rollback_discord_credential(
            Some(zeroize::Zeroizing::new("previous".to_string())),
            |_| {
                restore_calls.set(restore_calls.get() + 1);
                async { Err("keyring restore failed".to_string()) }
            },
            || async { panic!("present credential must not remove") },
            || {
                recovery_calls.set(recovery_calls.get() + 1);
                Ok(())
            },
        )
        .await;
        assert!(matches!(
            restore_failed,
            Err(DiscordRollbackFailure::Restore)
        ));
        assert_eq!(restore_calls.get(), 1);
        assert_eq!(recovery_calls.get(), 0);

        let remove_calls = std::cell::Cell::new(0);
        let absent_failed = rollback_discord_credential(
            None,
            |_| async { panic!("absent credential must not restore") },
            || {
                remove_calls.set(remove_calls.get() + 1);
                async { Err("keyring remove failed".to_string()) }
            },
            || Ok(()),
        )
        .await;
        assert!(matches!(
            absent_failed,
            Err(DiscordRollbackFailure::Restore)
        ));
        assert_eq!(remove_calls.get(), 1);

        let restored_value = std::cell::RefCell::new(String::new());
        let recovery_failed = rollback_discord_credential(
            Some(zeroize::Zeroizing::new("previous".to_string())),
            |value| {
                *restored_value.borrow_mut() = value;
                async { Ok(()) }
            },
            || async { Ok(()) },
            || Err("recovery restart failed".to_string()),
        )
        .await;
        assert!(matches!(
            recovery_failed,
            Err(DiscordRollbackFailure::Recovery)
        ));
        assert_eq!(restored_value.borrow().as_str(), "previous");
    }

    #[test]
    fn discord_rollback_errors_are_stable_and_expose_quarantine_uncertainty() {
        assert_eq!(
            discord_binding_rollback_error(DiscordRollbackFailure::Restore, Ok(())),
            "discord_bindings_restart_failed_rollback_failed"
        );
        assert_eq!(
            discord_binding_rollback_error(DiscordRollbackFailure::Recovery, Ok(())),
            "discord_bindings_restart_failed_recovery_failed"
        );
        assert_eq!(
            discord_binding_rollback_error(
                DiscordRollbackFailure::Restore,
                Err("revoke failed".to_string())
            ),
            "discord_bindings_restart_failed_rollback_uncertain"
        );
        assert_eq!(
            discord_credential_rollback_error(DiscordRollbackFailure::Restore, Ok(())),
            "discord_credential_restart_failed_rollback_failed"
        );
        assert_eq!(
            discord_credential_rollback_error(DiscordRollbackFailure::Recovery, Ok(())),
            "discord_credential_restart_failed_recovery_failed"
        );
        assert_eq!(
            discord_credential_rollback_error(
                DiscordRollbackFailure::Recovery,
                Err("reap failed".to_string())
            ),
            "discord_credential_restart_failed_rollback_uncertain"
        );
    }

    #[test]
    fn discord_clear_activation_failure_always_quarantines_and_classifies_uncertainty() {
        let successful_quarantine_calls = std::cell::Cell::new(0);
        assert_eq!(
            finish_discord_clear_activation(
                Err("initial authority revoke failed".to_string()),
                || {
                    successful_quarantine_calls
                        .set(successful_quarantine_calls.get() + 1);
                    Ok(())
                },
            ),
            Err("discord_bindings_clear_failed".to_string())
        );
        assert_eq!(successful_quarantine_calls.get(), 1);

        let uncertain_quarantine_calls = std::cell::Cell::new(0);
        assert_eq!(
            finish_discord_clear_activation(
                Err("restart failed".to_string()),
                || {
                    uncertain_quarantine_calls
                        .set(uncertain_quarantine_calls.get() + 1);
                    Err("reap failed".to_string())
                },
            ),
            Err("discord_bindings_clear_quarantine_uncertain".to_string())
        );
        assert_eq!(uncertain_quarantine_calls.get(), 1);

        let success_quarantine_calls = std::cell::Cell::new(0);
        assert_eq!(
            finish_discord_clear_activation(Ok(()), || {
                success_quarantine_calls.set(success_quarantine_calls.get() + 1);
                Ok(())
            }),
            Ok(())
        );
        assert_eq!(success_quarantine_calls.get(), 0);
    }

    #[test]
    fn discord_quarantine_marker_blocks_later_spawn_until_explicit_repair() {
        let dir = tempfile::tempdir().unwrap();
        let quarantined = std::sync::atomic::AtomicBool::new(false);
        assert!(discord_runtime_activation_allowed(
            &quarantined,
            dir.path(),
            false,
        ));

        write_discord_quarantine_marker(dir.path()).unwrap();
        assert!(!discord_runtime_activation_allowed(
            &quarantined,
            dir.path(),
            false,
        ));
        assert!(quarantined.load(std::sync::atomic::Ordering::Acquire));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(discord_quarantine_marker_path(dir.path()))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }

        clear_discord_quarantine_marker(dir.path()).unwrap();
        assert!(!discord_runtime_activation_allowed(
            &quarantined,
            dir.path(),
            false,
        ));
        assert!(discord_runtime_activation_allowed(
            &quarantined,
            dir.path(),
            true,
        ));
    }

    #[test]
    fn discord_authority_partial_write_failure_latches_and_cleans_stale_status() {
        let quarantined = std::sync::atomic::AtomicBool::new(false);
        let authority_persisted = std::cell::Cell::new(false);
        let stale_status_present = std::cell::Cell::new(true);
        assert_eq!(
            issue_discord_runtime_authority(
                &quarantined,
                || {
                    authority_persisted.set(true);
                    Err("parent fsync failed".to_string())
                },
                || {
                    assert!(authority_persisted.get());
                    stale_status_present.set(false);
                    Ok(())
                },
            ),
            Err("discord_authority_write_failed".to_string())
        );
        assert!(quarantined.load(std::sync::atomic::Ordering::Acquire));
        assert!(!stale_status_present.get());

        assert_eq!(
            issue_discord_runtime_authority(
                &quarantined,
                || Err("write failed".to_string()),
                || Err("tombstone durability failed".to_string()),
            ),
            Err("discord_authority_write_quarantine_uncertain".to_string())
        );
    }

    #[test]
    fn discord_authority_revoke_removes_status_even_when_tombstone_write_fails() {
        let runtime = tempfile::tempdir().unwrap();
        std::fs::create_dir(runtime.path().join("authority.json")).unwrap();
        std::fs::write(runtime.path().join("status.json"), b"stale ready").unwrap();
        assert!(revoke_discord_runtime_files(runtime.path()).is_err());
        assert!(!runtime.path().join("status.json").exists());
    }

    #[test]
    fn discord_startup_failures_explicitly_quarantine_before_and_after_spawn() {
        let quarantined = std::sync::atomic::AtomicBool::new(false);
        let pre_spawn_cleanup_calls = std::cell::Cell::new(0);
        let pre_spawn: Result<(), String> = fail_discord_agent_startup(
            "command spawn failed".to_string(),
            true,
            &quarantined,
            || Ok(()),
            || {
                pre_spawn_cleanup_calls.set(pre_spawn_cleanup_calls.get() + 1);
                Ok(())
            },
        );
        assert_eq!(pre_spawn, Err("command spawn failed".to_string()));
        assert_eq!(pre_spawn_cleanup_calls.get(), 1);
        assert!(quarantined.load(std::sync::atomic::Ordering::Acquire));

        let terminate_calls = std::cell::Cell::new(0);
        let post_spawn_cleanup_calls = std::cell::Cell::new(0);
        let post_spawn: Result<(), String> = fail_discord_agent_startup(
            "gRPC handshake failed".to_string(),
            true,
            &quarantined,
            || {
                terminate_calls.set(terminate_calls.get() + 1);
                Err("reap failed".to_string())
            },
            || {
                post_spawn_cleanup_calls.set(post_spawn_cleanup_calls.get() + 1);
                Err("status cleanup failed".to_string())
            },
        );
        assert_eq!(
            post_spawn,
            Err("discord_startup_quarantine_uncertain".to_string())
        );
        assert_eq!(terminate_calls.get(), 1);
        assert_eq!(post_spawn_cleanup_calls.get(), 1);
    }

    #[test]
    fn spawn_adk_path_snapshot_is_reused_across_cache_interleaving() {
        let cache = std::cell::RefCell::new(Some(" /workspace/a ".to_string()));
        let snapshot = spawn_adk_path_snapshot_with(|| cache.borrow().clone()).unwrap();
        *cache.borrow_mut() = Some("/workspace/b".to_string());

        let settings_path = std::path::PathBuf::from(&snapshot).join("naia-settings");
        let discord_runtime = settings_path.join("discord-runtime");
        let dispatcher_path = snapshot.clone();

        assert_eq!(snapshot, "/workspace/a");
        assert_eq!(
            discord_runtime,
            std::path::PathBuf::from("/workspace/a/naia-settings/discord-runtime")
        );
        assert_eq!(dispatcher_path, "/workspace/a");
        assert_eq!(cache.borrow().as_deref(), Some("/workspace/b"));
    }

    #[test]
    fn path_cache_mutation_waits_for_spawn_lifecycle() {
        let lifecycle = std::sync::Arc::new(std::sync::Mutex::new(()));
        let cache = std::sync::Arc::new(std::sync::Mutex::new("workspace-a".to_string()));
        let (spawn_entered_tx, spawn_entered_rx) = std::sync::mpsc::channel();
        let (release_spawn_tx, release_spawn_rx) = std::sync::mpsc::channel();
        let spawn_lifecycle = lifecycle.clone();
        let spawn = std::thread::spawn(move || {
            with_discord_lifecycle(&spawn_lifecycle, || {
                spawn_entered_tx.send(()).unwrap();
                release_spawn_rx.recv().unwrap();
            });
        });
        spawn_entered_rx.recv().unwrap();

        let (write_done_tx, write_done_rx) = std::sync::mpsc::channel();
        let write_lifecycle = lifecycle.clone();
        let write_cache = cache.clone();
        let writer = std::thread::spawn(move || {
            with_discord_lifecycle(&write_lifecycle, || {
                *write_cache.lock().unwrap() = "workspace-b".to_string();
            });
            write_done_tx.send(()).unwrap();
        });
        assert!(
            write_done_rx
                .recv_timeout(std::time::Duration::from_millis(20))
                .is_err(),
            "path cache mutation must not interleave with a spawn"
        );
        assert_eq!(cache.lock().unwrap().as_str(), "workspace-a");

        release_spawn_tx.send(()).unwrap();
        spawn.join().unwrap();
        write_done_rx.recv().unwrap();
        writer.join().unwrap();
        assert_eq!(cache.lock().unwrap().as_str(), "workspace-b");
    }

    #[test]
    fn discord_cleanup_timeout_transfers_ownership_without_double_cleanup() {
        let quarantined = std::sync::atomic::AtomicBool::new(false);
        let finish_calls = std::cell::Cell::new(0);
        let handed_off = std::cell::Cell::new(None);
        let result: Result<(), String> = finalize_discord_startup_failure(
            "gRPC handshake failed".to_string(),
            true,
            &quarantined,
            false,
            true,
            |child_reaped, runtime_quarantined| {
                finish_calls.set(finish_calls.get() + 1);
                handed_off.set(Some((child_reaped, runtime_quarantined)));
            },
        );

        assert_eq!(
            result,
            Err("discord_startup_quarantine_uncertain".to_string())
        );
        assert_eq!(finish_calls.get(), 1);
        assert_eq!(handed_off.get(), Some((false, true)));
        assert!(quarantined.load(std::sync::atomic::Ordering::Acquire));
    }

    #[test]
    fn discord_cleanup_success_disarms_drop_ownership_exactly_once() {
        let quarantined = std::sync::atomic::AtomicBool::new(false);
        let finish_calls = std::cell::Cell::new(0);
        let result: Result<(), String> = finalize_discord_startup_failure(
            "token pipe failed".to_string(),
            true,
            &quarantined,
            true,
            true,
            |child_reaped, runtime_quarantined| {
                finish_calls.set(finish_calls.get() + 1);
                assert!(child_reaped);
                assert!(runtime_quarantined);
            },
        );

        assert_eq!(result, Err("token pipe failed".to_string()));
        assert_eq!(finish_calls.get(), 1);
    }

    #[test]
    fn pending_reaper_blocks_spawn_until_reap_and_cleanup_finish() {
        let pending = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let phases = std::cell::RefCell::new(Vec::new());
        let ownership = PendingDiscordReaper::begin(pending.clone());

        assert_eq!(
            ensure_no_pending_discord_reaper(&pending, false),
            Err("discord_agent_reap_pending".to_string())
        );
        assert_eq!(
            ensure_no_pending_discord_reaper(&pending, true),
            Err("discord_agent_reap_pending".to_string()),
            "explicit repair must not bypass an owned old child"
        );
        run_pending_discord_reaper(
            ownership,
            || {
                assert_eq!(pending.load(std::sync::atomic::Ordering::Acquire), 1);
                phases.borrow_mut().push("reap");
            },
            || {
                assert_eq!(pending.load(std::sync::atomic::Ordering::Acquire), 1);
                phases.borrow_mut().push("cleanup");
            },
        );

        assert_eq!(phases.into_inner(), vec!["reap", "cleanup"]);
        assert_eq!(pending.load(std::sync::atomic::Ordering::Acquire), 0);
        assert_eq!(ensure_no_pending_discord_reaper(&pending, false), Ok(()));
        assert_eq!(ensure_no_pending_discord_reaper(&pending, true), Ok(()));
    }

    fn exited_reaper_test_child() -> Child {
        #[cfg(windows)]
        let mut child = Command::new("cmd")
            .args(["/C", "exit", "0"])
            .spawn()
            .unwrap();
        #[cfg(not(windows))]
        let mut child = Command::new("true").spawn().unwrap();
        child.wait().unwrap();
        child
    }

    fn test_agent_child_lease(pid: u32) -> AgentChildLease {
        AgentChildLease {
            version: 1,
            pid: Some(pid),
            nonce: "test-nonce".to_string(),
            marker: "--naia-agent-child=test-nonce".to_string(),
            started_at_ms: 1,
            runtime: None,
        }
    }

    #[test]
    fn restart_reconcile_blocks_alive_matching_agent() {
        let lease = test_agent_child_lease(42);
        let cleaned = std::cell::Cell::new(0);
        let removed = std::cell::Cell::new(0);
        assert_eq!(
            reconcile_agent_child_lease_with(
                &lease,
                |pid| {
                    assert_eq!(pid, 42);
                    Ok(Some(true))
                },
                || panic!("pid lease must not enumerate"),
                || {
                    cleaned.set(cleaned.get() + 1);
                    Ok(())
                },
                || {
                    removed.set(removed.get() + 1);
                    Ok(())
                },
            ),
            Err("agent_lease_live_blocked".to_string())
        );
        assert_eq!((cleaned.get(), removed.get()), (0, 0));
    }

    #[test]
    fn dead_or_pid_reuse_mismatch_is_cleaned_before_remove() {
        let lease = test_agent_child_lease(42);
        let phases = std::cell::RefCell::new(Vec::new());
        let removed = std::cell::Cell::new(0);
        assert_eq!(
            reconcile_agent_child_lease_with(
                &lease,
                |_| Ok(Some(false)),
                || Ok(false),
                || {
                    phases.borrow_mut().push("cleanup");
                    Ok(())
                },
                || {
                    phases.borrow_mut().push("remove");
                    removed.set(removed.get() + 1);
                    Ok(())
                },
            ),
            Ok(())
        );
        assert_eq!(phases.into_inner(), vec!["cleanup", "remove"]);
        assert_eq!(removed.get(), 1);
    }

    #[test]
    fn wrapper_pid_gone_but_marker_descendant_alive_blocks_reconcile() {
        let lease = test_agent_child_lease(42);
        let cleaned = std::cell::Cell::new(0);
        let removed = std::cell::Cell::new(0);
        assert_eq!(
            reconcile_agent_child_lease_with(
                &lease,
                |_| Ok(None),
                || Ok(true),
                || {
                    cleaned.set(cleaned.get() + 1);
                    Ok(())
                },
                || {
                    removed.set(removed.get() + 1);
                    Ok(())
                },
            ),
            Err("agent_lease_live_blocked".to_string())
        );
        assert_eq!((cleaned.get(), removed.get()), (0, 0));
    }

    #[test]
    fn preintent_crash_window_enumerates_marker_and_blocks_or_cleans() {
        let mut lease = test_agent_child_lease(42);
        lease.pid = None;
        assert_eq!(
            reconcile_agent_child_lease_with(
                &lease,
                |_| panic!("preintent must not query a pid"),
                || Ok(true),
                || panic!("live preintent must not clean runtime"),
                || panic!("live preintent must not remove lease"),
            ),
            Err("agent_lease_live_blocked".to_string())
        );

        let phases = std::cell::RefCell::new(Vec::new());
        assert_eq!(
            reconcile_agent_child_lease_with(
                &lease,
                |_| panic!("preintent must not query a pid"),
                || Ok(false),
                || {
                    phases.borrow_mut().push("cleanup");
                    Ok(())
                },
                || {
                    phases.borrow_mut().push("remove");
                    Ok(())
                },
            ),
            Ok(())
        );
        assert_eq!(phases.into_inner(), vec!["cleanup", "remove"]);
    }

    #[test]
    fn durable_intent_and_runtime_update_always_precede_authority() {
        let mut lease = test_agent_child_lease(42);
        lease.pid = None;
        let phases = std::cell::RefCell::new(Vec::new());
        persist_agent_child_lease_before(
            &lease,
            |value| {
                assert!(value.pid.is_none());
                phases.borrow_mut().push("intent");
                Ok(())
            },
            || {
                phases.borrow_mut().push("continue");
                Ok(())
            },
        )
        .unwrap();
        lease.runtime = Some(std::path::PathBuf::from("/exact/runtime"));
        persist_agent_child_lease_before(
            &lease,
            |value| {
                assert_eq!(value.runtime.as_deref(), Some(std::path::Path::new("/exact/runtime")));
                phases.borrow_mut().push("runtime-intent");
                Ok(())
            },
            || {
                phases.borrow_mut().push("authority");
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(
            phases.into_inner(),
            vec!["intent", "continue", "runtime-intent", "authority"]
        );
    }

    #[test]
    fn intent_write_crash_point_never_reaches_authority() {
        let lease = test_agent_child_lease(42);
        let authority_calls = std::cell::Cell::new(0);
        let result: Result<(), String> = persist_agent_child_lease_before(
            &lease,
            |_| Err("injected intent write failure".to_string()),
            || {
                authority_calls.set(authority_calls.get() + 1);
                Ok(())
            },
        );
        assert_eq!(result, Err("injected intent write failure".to_string()));
        assert_eq!(authority_calls.get(), 0);
    }

    #[test]
    fn lease_cas_prevents_old_cleanup_removing_new_nonce() {
        let old = test_agent_child_lease(42);
        let mut new = old.clone();
        new.nonce = "new-nonce".to_string();
        new.marker = "--naia-agent-child=new-nonce".to_string();
        let removed = std::cell::Cell::new(0);
        assert_eq!(
            remove_matching_agent_child_lease_with(
                &old,
                || Ok(Some(new)),
                || {
                    removed.set(removed.get() + 1);
                    Ok(())
                },
            ),
            Ok(false)
        );
        assert_eq!(removed.get(), 0);
    }

    #[test]
    fn delayed_old_cleanup_never_touches_replacement_runtime_or_lease() {
        let old = test_agent_child_lease(42);
        let mut replacement = old.clone();
        replacement.nonce = "replacement-nonce".to_string();
        replacement.marker = "--naia-agent-child=replacement-nonce".to_string();
        let runtime_calls = std::cell::Cell::new(0);
        let remove_calls = std::cell::Cell::new(0);
        let outcome = cleanup_owned_agent_child_with(
            &old,
            true,
            true,
            OwnedAgentCleanupMode::Normal,
            || Ok(Some(replacement)),
            |_| panic!("superseded lease must not be restored"),
            || panic!("superseded lease must not enumerate"),
            || {
                runtime_calls.set(runtime_calls.get() + 1);
                Ok(())
            },
            || {
                runtime_calls.set(runtime_calls.get() + 1);
                Ok(())
            },
            || {
                remove_calls.set(remove_calls.get() + 1);
                Ok(true)
            },
        );
        assert!(outcome.superseded);
        assert!(outcome.complete(true));
        assert_eq!(runtime_calls.get(), 0);
        assert_eq!(remove_calls.get(), 0);
    }

    #[test]
    fn uncertain_termination_quarantines_owned_runtime_but_retains_lease() {
        let lease = test_agent_child_lease(42);
        let runtime_calls = std::cell::Cell::new(0);
        let remove_calls = std::cell::Cell::new(0);
        let outcome = cleanup_owned_agent_child_with(
            &lease,
            false,
            true,
            OwnedAgentCleanupMode::Normal,
            || Ok(Some(lease.clone())),
            |_| panic!("present lease must not be restored"),
            || panic!("unreaped child must not enumerate"),
            || panic!("uncertain termination must not cleanly revoke"),
            || {
                runtime_calls.set(runtime_calls.get() + 1);
                Ok(())
            },
            || {
                remove_calls.set(remove_calls.get() + 1);
                Ok(true)
            },
        );
        assert!(!outcome.complete(false));
        assert!(outcome.runtime_confirmed);
        assert!(!outcome.lease_removed);
        assert_eq!(runtime_calls.get(), 1);
        assert_eq!(remove_calls.get(), 0);
    }

    #[test]
    fn wrapper_reaped_but_marker_descendant_alive_quarantines_and_retains_lease() {
        let lease = test_agent_child_lease(42);
        let runtime_calls = std::cell::Cell::new(0);
        let remove_calls = std::cell::Cell::new(0);
        let outcome = cleanup_owned_agent_child_with(
            &lease,
            true,
            true,
            OwnedAgentCleanupMode::Normal,
            || Ok(Some(lease.clone())),
            |_| panic!("present lease must not be restored"),
            || Ok(true),
            || panic!("live descendant must not cleanly revoke"),
            || {
                runtime_calls.set(runtime_calls.get() + 1);
                Ok(())
            },
            || {
                remove_calls.set(remove_calls.get() + 1);
                Ok(true)
            },
        );
        assert!(!outcome.complete(true));
        assert!(outcome.runtime_confirmed);
        assert!(!outcome.lease_removed);
        assert_eq!(runtime_calls.get(), 1);
        assert_eq!(remove_calls.get(), 0);
    }

    #[test]
    fn missing_owned_lease_is_restored_before_quarantine_and_remove() {
        let lease = test_agent_child_lease(42);
        let phases = std::cell::RefCell::new(Vec::new());
        let outcome = cleanup_owned_agent_child_with(
            &lease,
            true,
            true,
            OwnedAgentCleanupMode::Quarantine,
            || Ok(None),
            |restored| {
                assert_eq!(restored.nonce, lease.nonce);
                phases.borrow_mut().push("restore");
                Ok(())
            },
            || {
                phases.borrow_mut().push("enumerate");
                Ok(false)
            },
            || panic!("quarantine mode must not cleanly revoke"),
            || {
                phases.borrow_mut().push("quarantine");
                Ok(())
            },
            || {
                phases.borrow_mut().push("remove");
                Ok(true)
            },
        );
        assert!(!outcome.superseded);
        assert!(outcome.complete(true));
        assert_eq!(
            phases.into_inner(),
            vec!["restore", "enumerate", "quarantine", "remove"]
        );
    }

    #[test]
    fn normal_shutdown_revokes_runtime_without_quarantine_before_lease_remove() {
        let lease = test_agent_child_lease(42);
        let phases = std::cell::RefCell::new(Vec::new());
        let outcome = cleanup_owned_agent_child_with(
            &lease,
            true,
            true,
            OwnedAgentCleanupMode::Normal,
            || Ok(Some(lease.clone())),
            |_| panic!("present lease must not be restored"),
            || {
                phases.borrow_mut().push("enumerate");
                Ok(false)
            },
            || {
                phases.borrow_mut().push("revoke");
                Ok(())
            },
            || panic!("confirmed normal shutdown must not quarantine"),
            || {
                phases.borrow_mut().push("remove");
                Ok(true)
            },
        );
        assert!(outcome.complete(true));
        assert_eq!(phases.into_inner(), vec!["enumerate", "revoke", "remove"]);
    }

    #[test]
    fn failed_generic_replacement_cannot_leave_stale_discord_status() {
        let runtime = tempfile::tempdir().unwrap();
        std::fs::write(runtime.path().join("authority.json"), b"authority").unwrap();
        std::fs::write(runtime.path().join("status.json"), b"status").unwrap();
        let lease = test_agent_child_lease(42);
        let outcome = cleanup_owned_agent_child_with(
            &lease,
            true,
            true,
            OwnedAgentCleanupMode::Normal,
            || Ok(Some(lease.clone())),
            |_| panic!("present lease must not be restored"),
            || Ok(false),
            || revoke_discord_runtime_files(runtime.path()),
            || panic!("confirmed normal restart must not quarantine"),
            || Ok(true),
        );
        assert!(outcome.complete(true));

        let replacement: Result<(), String> = Err("replacement failed".to_string());
        assert!(replacement.is_err());
        let authority: serde_json::Value = serde_json::from_slice(
            &std::fs::read(runtime.path().join("authority.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(authority["generation"], "revoked");
        assert!(!runtime.path().join("status.json").exists());
        assert!(!runtime.path().join("quarantine.json").exists());
    }

    #[test]
    fn missing_owned_lease_restore_failure_is_incomplete_and_touches_no_runtime() {
        let lease = test_agent_child_lease(42);
        let runtime_calls = std::cell::Cell::new(0);
        let outcome = cleanup_owned_agent_child_with(
            &lease,
            true,
            true,
            OwnedAgentCleanupMode::Normal,
            || Ok(None),
            |_| Err("restore failed".to_string()),
            || panic!("failed restore must not enumerate"),
            || panic!("failed restore must not revoke"),
            || {
                runtime_calls.set(runtime_calls.get() + 1);
                Ok(())
            },
            || panic!("failed restore must not remove"),
        );
        assert!(!outcome.superseded);
        assert!(!outcome.complete(true));
        assert_eq!(runtime_calls.get(), 0);
    }

    #[test]
    fn lease_write_failure_is_fail_closed() {
        let lease = test_agent_child_lease(42);
        assert_eq!(
            persist_agent_child_lease_with(&lease, |_path, _bytes| {
                Err("injected write failure".to_string())
            }),
            Err("agent_lease_write_failed".to_string())
        );
    }

    #[test]
    fn lease_file_lock_excludes_a_second_file_handle() {
        use fs2::FileExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lease.lock");
        let first = acquire_agent_child_lease_lock_at(&path).unwrap();
        let second = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        assert!(second.try_lock_exclusive().is_err());
        drop(first);
        second.try_lock_exclusive().unwrap();
        second.unlock().unwrap();
    }

    #[test]
    fn lease_file_lock_acquisition_failure_is_stable() {
        let dir = tempfile::tempdir().unwrap();
        let not_a_directory = dir.path().join("not-a-directory");
        std::fs::write(&not_a_directory, b"file").unwrap();
        assert!(matches!(
            acquire_agent_child_lease_lock_at(&not_a_directory.join("lease.lock")),
            Err(error) if error == "agent_lease_lock_failed"
        ));
    }

    #[test]
    fn lease_file_lock_child_probe() {
        let Ok(path) = std::env::var("NAIA_TEST_LEASE_LOCK_PATH") else {
            return;
        };
        let ready = std::env::var("NAIA_TEST_LEASE_LOCK_READY").unwrap();
        let _lock = acquire_agent_child_lease_lock_at(std::path::Path::new(&path)).unwrap();
        std::fs::write(ready, b"locked").unwrap();
    }

    #[test]
    fn lease_file_lock_excludes_another_process_until_release() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lease.lock");
        let ready = dir.path().join("child-ready");
        let lock = acquire_agent_child_lease_lock_at(&path).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "tests::lease_file_lock_child_probe"])
            .env("NAIA_TEST_LEASE_LOCK_PATH", &path)
            .env("NAIA_TEST_LEASE_LOCK_READY", &ready)
            .spawn()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(!ready.exists());
        assert!(child.try_wait().unwrap().is_none());
        drop(lock);
        assert!(child.wait().unwrap().success());
        assert!(ready.is_file());
    }

    #[test]
    fn reaper_thread_spawn_failure_retains_unconfirmed_owner_and_pending_barrier() {
        let pending = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let container = Arc::new(Mutex::new(Some(DiscordReaperOwnership {
            child: Some(exited_reaper_test_child()),
            cleanup: None,
            lease: test_agent_child_lease(u32::MAX),
            _pending: Some(PendingDiscordReaper::begin(pending.clone())),
        })));

        let spawn_result = spawn_discord_reaper_task_with(&container, |_task| {
            Err("injected_thread_spawn_failure".to_string())
        });
        assert_eq!(
            spawn_result,
            Err("injected_thread_spawn_failure".to_string())
        );
        recover_failed_discord_reaper_handoff_and_cleanup_with(
            container,
            |_child| Err("injected_reap_unconfirmed".to_string()),
            |_ownership, child_reaped| child_reaped,
        );

        assert_eq!(pending.load(std::sync::atomic::Ordering::Acquire), 1);
        assert_eq!(
            ensure_no_pending_discord_reaper(&pending, true),
            Err("discord_agent_reap_pending".to_string())
        );
    }

    #[test]
    fn reaper_thread_spawn_failure_releases_confirmed_fallback() {
        let pending = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let container = Arc::new(Mutex::new(Some(DiscordReaperOwnership {
            child: Some(exited_reaper_test_child()),
            cleanup: None,
            lease: test_agent_child_lease(u32::MAX),
            _pending: Some(PendingDiscordReaper::begin(pending.clone())),
        })));

        assert!(spawn_discord_reaper_task_with(&container, |_task| {
            Err("injected_thread_spawn_failure".to_string())
        })
        .is_err());
        recover_failed_discord_reaper_handoff_and_cleanup_with(
            container,
            |_child| Ok(()),
            |_ownership, child_reaped| child_reaped,
        );

        assert_eq!(pending.load(std::sync::atomic::Ordering::Acquire), 0);
        assert_eq!(ensure_no_pending_discord_reaper(&pending, true), Ok(()));
    }

    #[test]
    fn permanent_background_wait_error_retains_owner_and_pending() {
        let wait_calls = std::cell::Cell::new(0);
        let confirmed = confirm_background_reap_with(|| {
            let call = wait_calls.get();
            wait_calls.set(call + 1);
            if call == 0 {
                Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "injected interrupt",
                ))
            } else {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected permanent wait failure",
                ))
            }
        });
        assert!(!confirmed);
        assert_eq!(wait_calls.get(), 2);

        let pending = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        finish_owned_discord_reaper(
            PendingDiscordReaper::begin(pending.clone()),
            confirmed,
            "injected_permanent_wait_failure_pending",
        );
        assert_eq!(pending.load(std::sync::atomic::Ordering::Acquire), 1);
    }

    #[test]
    fn successful_quarantine_strips_late_runtime_cleanup() {
        let runtime = std::path::PathBuf::from("/exact/runtime");
        let quarantined = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let cleanup = DiscordSpawnCleanup {
            runtime: runtime.clone(),
            quarantined,
        };

        assert!(discord_cleanup_retry(Some(cleanup), true).is_none());

        let retry = discord_cleanup_retry(
            Some(DiscordSpawnCleanup {
                runtime: runtime.clone(),
                quarantined: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            }),
            false,
        )
        .expect("failed quarantine must retain exact cleanup");
        assert_eq!(retry.runtime, runtime);
    }

    #[test]
    fn discord_repair_activation_restores_marker_on_failure_and_uncertainty() {
        let restore_calls = std::cell::Cell::new(0);
        let quarantined = std::sync::atomic::AtomicBool::new(false);
        assert_eq!(
            run_discord_repair_activation(
                &quarantined,
                || Ok(()),
                || Err("activation failed".to_string()),
                || {
                    restore_calls.set(restore_calls.get() + 1);
                    Ok(())
                },
            ),
            Err("activation failed".to_string())
        );
        assert_eq!(restore_calls.get(), 1);
        assert!(quarantined.load(std::sync::atomic::Ordering::Acquire));

        let uncertain_restore_calls = std::cell::Cell::new(0);
        assert_eq!(
            run_discord_repair_activation(
                &quarantined,
                || Ok(()),
                || Err("activation failed".to_string()),
                || {
                    uncertain_restore_calls.set(uncertain_restore_calls.get() + 1);
                    Err("marker write failed".to_string())
                },
            ),
            Err("discord_activation_quarantine_uncertain".to_string())
        );
        assert_eq!(uncertain_restore_calls.get(), 1);

        let success_restore_calls = std::cell::Cell::new(0);
        assert_eq!(
            run_discord_repair_activation(
                &quarantined,
                || Ok(()),
                || Ok(()),
                || {
                    success_restore_calls.set(success_restore_calls.get() + 1);
                    Ok(())
                },
            ),
            Ok(())
        );
        assert_eq!(success_restore_calls.get(), 0);
        assert!(!quarantined.load(std::sync::atomic::Ordering::Acquire));
    }

    #[test]
    fn discord_lifecycle_lock_blocks_normal_spawn_during_repair_or_quarantine() {
        let lifecycle = std::sync::Arc::new(std::sync::Mutex::new(()));
        let quarantined = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let runtime = tempfile::tempdir().unwrap().path().to_path_buf();
        let (locked_tx, locked_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();

        let quarantine_lifecycle = lifecycle.clone();
        let quarantine_latch = quarantined.clone();
        let quarantine = std::thread::spawn(move || {
            with_discord_lifecycle(&quarantine_lifecycle, || {
                quarantine_latch.store(true, std::sync::atomic::Ordering::Release);
                locked_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            });
        });

        locked_rx.recv().unwrap();
        assert!(
            lifecycle.try_lock().is_err(),
            "normal spawn must not enter while quarantine owns the lifecycle"
        );
        release_tx.send(()).unwrap();
        quarantine.join().unwrap();

        let (repair_locked_tx, repair_locked_rx) = std::sync::mpsc::channel();
        let (repair_release_tx, repair_release_rx) = std::sync::mpsc::channel();
        let repair_lifecycle = lifecycle.clone();
        let repair = std::thread::spawn(move || {
            with_discord_lifecycle(&repair_lifecycle, || {
                repair_locked_tx.send(()).unwrap();
                repair_release_rx.recv().unwrap();
            });
        });
        repair_locked_rx.recv().unwrap();
        assert!(
            lifecycle.try_lock().is_err(),
            "normal spawn must not enter while explicit repair owns the lifecycle"
        );
        repair_release_tx.send(()).unwrap();
        repair.join().unwrap();

        with_discord_lifecycle(&lifecycle, || {
            assert!(
                !discord_runtime_activation_allowed(&quarantined, &runtime, false),
                "normal spawn after quarantine may start Agent but must not arm Discord"
            );
            assert!(
                discord_runtime_activation_allowed(&quarantined, &runtime, true),
                "only explicit repair may bypass the fail-closed latch"
            );
        });
    }

    #[test]
    fn parent_directory_persistence_errors_are_propagated() {
        assert!(sync_parent_directory_with(
            || Err::<(), _>(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "open")),
            |_| Ok(()),
        )
        .is_err());
        assert!(sync_parent_directory_with(
            || Ok(()),
            |_| Err(std::io::Error::new(std::io::ErrorKind::Other, "sync")),
        )
        .is_err());
    }

    #[test]
    fn discord_binding_manifest_rejects_generation_outside_agent_range() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("discord-bindings.json");
        std::fs::write(
            &path,
            r#"{"version":1,"generation":0,"bindings":[],"processingProfiles":{"default":"local_only"}}"#,
        )
        .unwrap();
        assert!(matches!(
            read_discord_binding_manifest(&path),
            Err(code) if code == "discord_bindings_generation_invalid"
        ));

        std::fs::write(
            &path,
            format!(
                r#"{{"version":1,"generation":{},"bindings":[],"processingProfiles":{{"default":"local_only"}}}}"#,
                DISCORD_MAX_SAFE_GENERATION + 1
            ),
        )
        .unwrap();
        assert!(matches!(
            read_discord_binding_manifest(&path),
            Err(code) if code == "discord_bindings_generation_invalid"
        ));
    }

    #[test]
    fn discord_binding_manifest_rejects_unsupported_schema_versions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("discord-bindings.json");
        std::fs::write(
            &path,
            r#"{"version":2,"generation":1,"bindings":[],"processingProfiles":{"default":"local_only"}}"#,
        )
        .unwrap();

        assert!(matches!(
            read_discord_binding_manifest(&path),
            Err(code) if code == "discord_bindings_upgrade_required"
        ));
    }

    #[test]
    fn discord_binding_manifest_rejects_unknown_fields_and_duplicate_ids() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("discord-bindings.json");
        std::fs::write(
            &path,
            r#"{"version":1,"generation":1,"bindings":[],"processingProfiles":{"default":"local_only"},"unexpected":true}"#,
        )
        .unwrap();
        assert!(matches!(
            read_discord_binding_manifest(&path),
            Err(code) if code == "discord_cache_invalid"
        ));

        std::fs::write(
            &path,
            r#"{"version":1,"generation":1,"bindings":[{"bindingId":"same","guildId":"100","channelId":"200","allowedUserIds":["300"],"processingProfileRef":"default","participation":"mentions"},{"bindingId":"same","guildId":"101","channelId":"201","allowedUserIds":["301"],"processingProfileRef":"default","participation":"all"}],"processingProfiles":{"default":"local_only"}}"#,
        )
        .unwrap();
        assert!(matches!(
            read_discord_binding_manifest(&path),
            Err(code) if code == "discord_bindings_invalid"
        ));

        std::fs::write(
            &path,
            r#"{"version":1,"generation":1,"bindings":[{"bindingId":"one","guildId":"100","channelId":"200","allowedUserIds":["300"],"processingProfileRef":"default","participation":"mentions","unexpected":true}],"processingProfiles":{"default":"local_only"}}"#,
        )
        .unwrap();
        assert!(matches!(
            read_discord_binding_manifest(&path),
            Err(code) if code == "discord_cache_invalid"
        ));
    }

    #[test]
    fn discord_cursor_updates_preserve_other_channels_and_monotonic_max() {
        let active_keys =
            std::collections::BTreeSet::from(["one".to_string(), "two".to_string()]);
        let cursors = DiscordInboxCursors {
            version: 1,
            generation: "42".to_string(),
            cursors: std::collections::BTreeMap::from([("two".to_string(), 7)]),
        };
        let cursors =
            update_discord_inbox_cursor(cursors, "42", &active_keys, "one".to_string(), 10)
                .unwrap();
        let cursors =
            update_discord_inbox_cursor(cursors, "42", &active_keys, "one".to_string(), 5)
                .unwrap();
        assert_eq!(cursors.cursors.get("one"), Some(&10));
        assert_eq!(cursors.cursors.get("two"), Some(&7));
    }

    #[test]
    fn discord_stale_binding_is_not_usable_for_preference_or_inbox() {
        let binding = DiscordBindingInput {
            binding_id: "binding_1".to_string(),
            guild_id: "100".to_string(),
            guild_name: Some("Guild".to_string()),
            channel_id: "200".to_string(),
            channel_name: Some("channel".to_string()),
            allowed_user_ids: vec!["300".to_string()],
            processing_profile_ref: "default".to_string(),
            participation: "mentions".to_string(),
        };
        let mut usable = std::collections::BTreeSet::new();
        assert!(!discord_binding_is_usable(&binding, &usable));
        usable.insert(("100".to_string(), "200".to_string()));
        assert!(discord_binding_is_usable(&binding, &usable));
    }

    #[test]
    fn discord_bot_member_and_bounded_history_use_bot_endpoints() {
        assert_eq!(
            discord_bot_member_endpoint("100", "200"),
            "/guilds/100/members/200"
        );
        assert_eq!(
            discord_channel_history_endpoint("300"),
            "/channels/300/messages?limit=50"
        );
        assert!(!discord_bot_member_endpoint("100", "200").contains("/users/@me/"));
        assert_eq!(
            discord_guilds_endpoint(None),
            "/users/@me/guilds?limit=100"
        );
        assert_eq!(
            discord_guilds_endpoint(Some("999")),
            "/users/@me/guilds?limit=100&after=999"
        );
        assert_eq!(DISCORD_GUILD_DISCOVERY_LIMIT, 200);
        assert!(discord_guild_discovery_truncated(200, 100));
        assert!(!discord_guild_discovery_truncated(199, 100));
        assert!(!discord_guild_discovery_truncated(200, 99));
    }

    #[test]
    fn discord_snowflake_timestamp_is_bounded_and_deterministic() {
        assert_eq!(
            discord_snowflake_timestamp_ms("0"),
            Some(1_420_070_400_000)
        );
        assert!(discord_snowflake_timestamp_ms("not-a-snowflake").is_none());
    }

    #[test]
    fn discord_channel_overwrites_follow_discord_precedence() {
        let base = DISCORD_VIEW_CHANNEL | DISCORD_READ_MESSAGE_HISTORY;
        let overwrites = vec![
            DiscordApiOverwrite {
                id: "100".to_string(),
                kind: 0,
                allow: "0".to_string(),
                deny: DISCORD_READ_MESSAGE_HISTORY.to_string(),
            },
            DiscordApiOverwrite {
                id: "200".to_string(),
                kind: 0,
                allow: (DISCORD_SEND_MESSAGES | DISCORD_READ_MESSAGE_HISTORY).to_string(),
                deny: "0".to_string(),
            },
            DiscordApiOverwrite {
                id: "300".to_string(),
                kind: 1,
                allow: "0".to_string(),
                deny: DISCORD_SEND_MESSAGES.to_string(),
            },
        ];
        let effective = apply_discord_overwrites(
            "100",
            "300",
            &["200".to_string()],
            base,
            &overwrites,
        );
        let summary = discord_permission_summary(effective);
        assert!(summary.view_channel);
        assert!(summary.read_message_history);
        assert!(!summary.send_messages);
        assert!(!summary.usable);
    }

    #[test]
    fn discord_administrator_bypasses_channel_overwrites() {
        let effective = apply_discord_overwrites(
            "100",
            "300",
            &[],
            DISCORD_ADMINISTRATOR,
            &[DiscordApiOverwrite {
                id: "100".to_string(),
                kind: 0,
                allow: "0".to_string(),
                deny: u64::MAX.to_string(),
            }],
        );
        assert!(discord_permission_summary(effective).usable);
    }
}
