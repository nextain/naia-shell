//! Steamworks 연동 및 Steam 커맨드 모듈 (#729).
//!
//! Windows 전용으로 `steamworks` SDK를 붙이며, 배포 채널이 "steam"일 때만 초기화한다.
//! 초기화 실패 시 패닉이나 종료 없이 정상 부팅하고 미실행 상태로 보고한다.
//! 순수 로직과 Trait(`SteamBackend`)은 타깃 OS에 무관하게 컴파일·단위 시험된다.

pub mod pending;
pub use pending::*;
pub mod windows;
pub use windows::*;

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::Emitter;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SteamAuthTicket {
    pub ticket_hex: String,
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
impl WindowsSteamBackend {
    pub fn init(app_handle: tauri::AppHandle) -> Result<Self, String> {
        Self::init_with_emitter(STEAM_APP_ID, move |payload| {
            let _ = app_handle.emit("steam_microtxn_authorization", payload);
        })
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

        // #729 지적 1 회귀 테스트 케이스
        assert!(!is_allowed_steam_url(
            "https://store.steampowered.com:443@evil.example/path"
        ));
        assert!(!is_allowed_steam_url(
            "https://store.steampowered.com.evil.example/"
        ));
        assert!(!is_allowed_steam_url(
            "https://evil.example/?u=https://store.steampowered.com"
        ));
        assert!(!is_allowed_steam_url("http://store.steampowered.com/"));
        assert!(!is_allowed_steam_url(
            "https://user:pass@store.steampowered.com/"
        ));
        assert!(!is_allowed_steam_url(
            "https://store.steampowered.com:8080/checkout"
        ));
        assert!(is_allowed_steam_url("HTTPS://STORE.STEAMPOWERED.COM/"));
        assert!(is_allowed_steam_url(
            "https://STORE.STEAMPOWERED.COM/app/5354630"
        ));
        assert!(is_allowed_steam_url(
            "https://CHECKOUT.STEAMPOWERED.COM/checkout/order/12345"
        ));
        assert!(is_allowed_steam_url(
            "https://store.steampowered.com:443/app/5354630"
        ));
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

    #[test]
    fn test_ticket_request_race_with_callback_thread() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use std::sync::Barrier;
        use std::thread;
        use std::time::Duration;

        let registry = TicketRegistry::<u32>::new();
        let barrier_sdk_called = Arc::new(Barrier::new(2));
        let callback_processed = Arc::new(AtomicBool::new(false));

        let reg_for_cb = registry.clone();
        let barrier_for_cb = barrier_sdk_called.clone();
        let cb_processed_clone = callback_processed.clone();

        // 콜백 스레드: SDK 요청 직후, pending 등록 완료 전에 응답 처리를 시도하는 시나리오
        let cb_thread = thread::spawn(move || {
            // SDK 요청이 시작될 때까지 동기화 장벽에서 대기
            barrier_for_cb.wait();
            // SDK 요청 직후 콜백 도착: pending 잠금을 획득하여 complete_ticket 시도
            // 생산 TicketRegistry 잠금 하에서 request_and_register가 끝나기 전까지 대기한 뒤
            // 등록된 티켓을 성공적으로 완료해야 함
            let handled = reg_for_cb.complete_ticket(&42u32, Ok(vec![0xaa, 0xbb, 0xcc]));
            cb_processed_clone.store(handled, Ordering::SeqCst);
        });

        // 티켓 요청 스레드: 생산 TicketRegistry.request_and_register 실행
        let (_ticket, rx) = registry.request_and_register(|| {
            // SDK 요청 시점 재현: 콜백 스레드를 깨움
            barrier_sdk_called.wait();
            // 콜백 스레드가 complete_ticket 락을 시도하도록 지연
            thread::sleep(Duration::from_millis(50));
            42u32
        });

        // 잠금 해제 후 콜백이 전달한 응답 수신 확인
        let res = rx.recv_timeout(Duration::from_secs(2));
        assert!(
            res.is_ok(),
            "Ticket response must be received without timeout"
        );
        let bytes = res.unwrap().unwrap();
        assert_eq!(bytes, vec![0xaa, 0xbb, 0xcc]);
        assert_eq!(bytes_to_hex(&bytes), "aabbcc");
        assert!(callback_processed.load(Ordering::SeqCst));

        cb_thread.join().unwrap();
        assert_eq!(registry.pending_count(), 0);
    }
}
