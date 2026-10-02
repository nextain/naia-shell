//! Steamworks 연동 및 Steam 커맨드 모듈 (#729).
//!
//! Windows 전용으로 `steamworks` SDK를 붙이며, 배포 채널이 "steam"일 때만 초기화한다.
//! 초기화 실패 시 패닉이나 종료 없이 정상 부팅하고 미실행 상태로 보고한다.
//! 순수 로직과 Trait(`SteamBackend`)은 타깃 OS에 무관하게 컴파일·단위 시험된다.

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::Emitter;

pub const STEAM_APP_ID: u32 = 5354630;
pub const GATEWAY_IDENTITY: &str = "naia-gateway";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct SteamStatus {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub steam_id_present: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SteamAuthTicket {
    pub ticket_hex: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SteamMicrotxnAuthPayload {
    pub app_id: u32,
    pub order_id: String,
    pub authorized: bool,
}

/// URL 허용 목록 검증:
/// https:// 프로토콜이어야 하며, 호스트는 store.steampowered.com 또는 checkout.steampowered.com이어야 한다.
pub fn is_allowed_steam_url(url_str: &str) -> bool {
    if let Ok(parsed) = url::Url::parse(url_str) {
        if parsed.scheme() == "https" {
            if let Some(host) = parsed.host_str() {
                return host == "store.steampowered.com" || host == "checkout.steampowered.com";
            }
        }
    }
    false
}

/// 바이트 슬라이스를 16진수 문자열로 변환 (소문자).
pub fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut hex = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(hex, "{:02x}", b);
    }
    hex
}

pub trait SteamBackend: Send + Sync {
    fn status(&self) -> SteamStatus;
    fn get_web_api_ticket(&self, identity: &str) -> Result<String, String>;
    fn open_url(&self, url: &str) -> Result<(), String>;
}

/// Steam 기능을 사용할 수 없을 때의 백엔드
pub struct UnavailableSteamBackend {
    pub reason: String,
}

impl SteamBackend for UnavailableSteamBackend {
    fn status(&self) -> SteamStatus {
        SteamStatus {
            available: false,
            reason: Some(self.reason.clone()),
            steam_id_present: false,
        }
    }

    fn get_web_api_ticket(&self, _identity: &str) -> Result<String, String> {
        Err(format!("Steam is not available: {}", self.reason))
    }

    fn open_url(&self, _url: &str) -> Result<(), String> {
        Err(format!("Steam is not available: {}", self.reason))
    }
}

/// 단위 테스트 및 인터랙션 모의용 백엔드
#[derive(Default)]
pub struct MockSteamBackend {
    pub status: std::sync::Mutex<SteamStatus>,
    pub ticket_result: std::sync::Mutex<Option<Result<String, String>>>,
    pub opened_urls: std::sync::Mutex<Vec<String>>,
}

impl MockSteamBackend {
    pub fn new(available: bool, reason: Option<String>, steam_id_present: bool) -> Self {
        Self {
            status: std::sync::Mutex::new(SteamStatus {
                available,
                reason,
                steam_id_present,
            }),
            ticket_result: std::sync::Mutex::new(None),
            opened_urls: std::sync::Mutex::new(Vec::new()),
        }
    }

    pub fn set_ticket_result(&self, result: Result<String, String>) {
        *self.ticket_result.lock().unwrap() = Some(result);
    }

    pub fn get_opened_urls(&self) -> Vec<String> {
        self.opened_urls.lock().unwrap().clone()
    }
}

impl SteamBackend for MockSteamBackend {
    fn status(&self) -> SteamStatus {
        self.status.lock().unwrap().clone()
    }

    fn get_web_api_ticket(&self, _identity: &str) -> Result<String, String> {
        if let Some(res) = self.ticket_result.lock().unwrap().as_ref() {
            res.clone()
        } else {
            Err("No mock ticket configured".to_string())
        }
    }

    fn open_url(&self, url: &str) -> Result<(), String> {
        if !is_allowed_steam_url(url) {
            return Err(format!("URL is not allowed: {url}"));
        }
        self.opened_urls.lock().unwrap().push(url.to_string());
        Ok(())
    }
}

#[cfg(windows)]
pub struct WindowsSteamBackend {
    client: steamworks::Client,
    _callback_thread: std::thread::JoinHandle<()>,
    pending_tickets: Arc<
        std::sync::Mutex<
            std::collections::HashMap<
                steamworks::AuthTicket,
                std::sync::mpsc::Sender<Result<Vec<u8>, String>>,
            >,
        >,
    >,
}

#[cfg(windows)]
impl WindowsSteamBackend {
    pub fn init(app_handle: tauri::AppHandle) -> Result<Self, String> {
        let (client, single) = steamworks::Client::init_app(STEAM_APP_ID)
            .map_err(|e| format!("Failed to initialize Steamworks SDK: {e}"))?;

        let handle_for_auth = app_handle.clone();
        client.register_callback::<steamworks::MicroTxnAuthorizationResponse, _>(move |resp| {
            let payload = SteamMicrotxnAuthPayload {
                app_id: resp.app_id.0,
                order_id: resp.order_id.to_string(),
                authorized: resp.authorized,
            };
            let _ = handle_for_auth.emit("steam_microtxn_authorization", payload);
        });

        let pending_tickets = Arc::new(std::sync::Mutex::new(std::collections::HashMap::<
            steamworks::AuthTicket,
            std::sync::mpsc::Sender<Result<Vec<u8>, String>>,
        >::new()));

        let pending_clone = pending_tickets.clone();
        client.register_callback::<steamworks::TicketForWebApiResponse, _>(move |resp| {
            let mut map = pending_clone.lock().unwrap();
            if let Some(tx) = map.remove(&resp.ticket_handle) {
                if resp.result.is_ok() {
                    let len = resp.ticket_len.max(0) as usize;
                    let slice = if len <= resp.ticket.len() {
                        &resp.ticket[..len]
                    } else {
                        &resp.ticket[..]
                    };
                    let _ = tx.send(Ok(slice.to_vec()));
                } else {
                    let _ = tx.send(Err(format!(
                        "Steam web API ticket callback failed: {:?}",
                        resp.result
                    )));
                }
            }
        });

        let callback_thread = std::thread::spawn(move || {
            loop {
                single.run_callbacks();
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        });

        Ok(Self {
            client,
            _callback_thread: callback_thread,
            pending_tickets,
        })
    }
}

#[cfg(windows)]
impl SteamBackend for WindowsSteamBackend {
    fn status(&self) -> SteamStatus {
        let steam_id_present = self.client.user().logged_on();
        SteamStatus {
            available: true,
            reason: None,
            steam_id_present,
        }
    }

    fn get_web_api_ticket(&self, identity: &str) -> Result<String, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        let auth_ticket = self
            .client
            .user()
            .authentication_session_ticket_for_webapi(identity);
        {
            let mut map = self.pending_tickets.lock().unwrap();
            map.insert(auth_ticket, tx);
        }

        match rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(Ok(bytes)) => Ok(bytes_to_hex(&bytes)),
            Ok(Err(err)) => Err(err),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                let mut map = self.pending_tickets.lock().unwrap();
                map.remove(&auth_ticket);
                Err("Timed out waiting for Steam Web API ticket callback (10s)".to_string())
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                Err("Steam Web API ticket channel disconnected".to_string())
            }
        }
    }

    fn open_url(&self, url: &str) -> Result<(), String> {
        if !is_allowed_steam_url(url) {
            return Err(format!("URL is not allowed: {url}"));
        }
        if self.client.utils().is_overlay_enabled() {
            self.client
                .friends()
                .activate_game_overlay_to_web_page(url);
            Ok(())
        } else {
            open::that(url).map_err(|e| format!("Failed to open system browser: {e}"))
        }
    }
}

pub struct SteamState {
    pub backend: Arc<dyn SteamBackend>,
}

pub fn init_steam_state(
    channel: crate::distribution::Channel,
    #[allow(unused_variables)] app_handle: Option<&tauri::AppHandle>,
) -> SteamState {
    if channel != crate::distribution::Channel::Steam {
        return SteamState {
            backend: Arc::new(UnavailableSteamBackend {
                reason: "Not running on Steam distribution channel".to_string(),
            }),
        };
    }

    #[cfg(windows)]
    {
        if let Some(handle) = app_handle {
            match WindowsSteamBackend::init(handle.clone()) {
                Ok(backend) => {
                    return SteamState {
                        backend: Arc::new(backend),
                    };
                }
                Err(err) => {
                    eprintln!("[Steam] Initialization failed: {err}");
                    return SteamState {
                        backend: Arc::new(UnavailableSteamBackend {
                            reason: "Steam is not running or failed to initialize".to_string(),
                        }),
                    };
                }
            }
        }
    }

    SteamState {
        backend: Arc::new(UnavailableSteamBackend {
            reason: "Steam integration is only supported on Windows".to_string(),
        }),
    }
}

// ───────────────────────── Tauri 커맨드 ─────────────────────────

#[tauri::command]
pub fn steam_status(state: tauri::State<SteamState>) -> SteamStatus {
    state.backend.status()
}

#[tauri::command]
pub async fn steam_get_web_api_ticket(
    state: tauri::State<'_, SteamState>,
) -> Result<SteamAuthTicket, String> {
    let backend = state.backend.clone();
    let ticket_hex = tokio::task::spawn_blocking(move || {
        backend.get_web_api_ticket(GATEWAY_IDENTITY)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

    Ok(SteamAuthTicket { ticket_hex })
}

#[tauri::command]
pub fn steam_open_url(state: tauri::State<SteamState>, url: String) -> Result<(), String> {
    if !is_allowed_steam_url(&url) {
        return Err("URL host or scheme not allowed".to_string());
    }
    state.backend.open_url(&url)
}

#[tauri::command]
pub fn complete_naia_auth(
    app_handle: tauri::AppHandle,
    naia_key: String,
    naia_user_id: Option<String>,
) -> Result<(), String> {
    let key = naia_key.trim();
    if !crate::is_valid_gateway_key(key) {
        return Err("Invalid gateway key format".to_string());
    }
    let payload = serde_json::json!({
        "naiaKey": key,
        "naiaUserId": naia_user_id,
    });
    let _ = app_handle.emit("naia_auth_complete", payload);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bytes_to_hex() {
        let bytes = [0x01, 0x02, 0x0a, 0xff, 0x00, 0x5a];
        assert_eq!(bytes_to_hex(&bytes), "01020aff005a");
        assert_eq!(bytes_to_hex(&[]), "");
    }

    #[test]
    fn test_steam_microtxn_auth_payload_order_id_is_string() {
        let payload = SteamMicrotxnAuthPayload {
            app_id: 5354630,
            order_id: u64::MAX.to_string(),
            authorized: true,
        };
        assert_eq!(payload.order_id, "18446744073709551615");

        let serialized = serde_json::to_string(&payload).unwrap();
        assert!(serialized.contains(r#""order_id":"18446744073709551615""#));

        let parsed: serde_json::Value = serde_json::from_str(&serialized).unwrap();
        assert!(parsed["order_id"].is_string());
        assert_eq!(
            parsed["order_id"].as_str().unwrap(),
            "18446744073709551615"
        );
    }

    #[test]
    fn test_is_allowed_steam_url() {
        assert!(is_allowed_steam_url(
            "https://store.steampowered.com/app/5354630"
        ));
        assert!(is_allowed_steam_url(
            "https://checkout.steampowered.com/checkout/order/12345"
        ));
        assert!(!is_allowed_steam_url(
            "http://store.steampowered.com/app/5354630"
        ));
        assert!(!is_allowed_steam_url("https://steampowered.com/"));
        assert!(!is_allowed_steam_url("https://google.com"));
        assert!(!is_allowed_steam_url(
            "https://store.steampowered.com.attacker.com"
        ));
        assert!(!is_allowed_steam_url("invalid-url"));
    }

    #[test]
    fn test_mock_steam_backend() {
        let mock = MockSteamBackend::new(true, None, true);
        assert_eq!(
            mock.status(),
            SteamStatus {
                available: true,
                reason: None,
                steam_id_present: true,
            }
        );

        mock.set_ticket_result(Ok("aabbcc112233".to_string()));
        let ticket = mock.get_web_api_ticket(GATEWAY_IDENTITY).unwrap();
        assert_eq!(ticket, "aabbcc112233");

        assert!(mock
            .open_url("https://store.steampowered.com/checkout")
            .is_ok());
        assert_eq!(
            mock.get_opened_urls(),
            vec!["https://store.steampowered.com/checkout"]
        );

        assert!(mock.open_url("https://malicious.com").is_err());
    }

    #[test]
    fn test_non_steam_channel_does_not_initialize_steam() {
        let state = init_steam_state(crate::distribution::Channel::Standard, None);
        let status = state.backend.status();
        assert!(!status.available);
        assert_eq!(
            status.reason.as_deref(),
            Some("Not running on Steam distribution channel")
        );
        assert!(!status.steam_id_present);

        let ticket_res = state.backend.get_web_api_ticket(GATEWAY_IDENTITY);
        assert!(ticket_res.is_err());
    }
}
