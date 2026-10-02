#[cfg(windows)]
use std::sync::Arc;

pub const STEAM_APP_ID: u32 = 5354630;
pub const GATEWAY_IDENTITY: &str = "naia-gateway";

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq, Eq, Default)]
pub struct SteamStatus {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub steam_id_present: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct SteamMicrotxnAuthPayload {
    pub app_id: u32,
    pub order_id: String,
    pub authorized: bool,
}

pub trait SteamBackend: Send + Sync {
    fn status(&self) -> SteamStatus;
    fn get_web_api_ticket(&self, identity: &str) -> Result<String, String>;
    fn open_url(&self, url: &str) -> Result<(), String>;
}

pub fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(s, "{:02x}", b);
    }
    s
}

pub fn is_allowed_steam_url(url: &str) -> bool {
    let parsed = match url::Url::parse(url.trim()) {
        Ok(u) => u,
        Err(_) => return false,
    };
    if parsed.scheme() != "https" {
        return false;
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return false;
    }
    if !parsed.port().map_or(true, |p| p == 443) {
        return false;
    }
    match parsed.host_str() {
        Some(h) => {
            h.eq_ignore_ascii_case("store.steampowered.com")
                || h.eq_ignore_ascii_case("checkout.steampowered.com")
        }
        None => false,
    }
}

use super::pending::TicketRegistry;

#[cfg(windows)]
pub struct WindowsSteamBackend {
    client: steamworks::Client,
    _callback_thread: std::thread::JoinHandle<()>,
    _auth_callback: steamworks::CallbackHandle,
    _ticket_callback: steamworks::CallbackHandle,
    pending_tickets: TicketRegistry<steamworks::AuthTicket>,
}

#[cfg(windows)]
impl WindowsSteamBackend {
    pub fn init_with_emitter<F>(app_id: u32, emit_auth: F) -> Result<Self, String>
    where
        F: Fn(SteamMicrotxnAuthPayload) + Send + Sync + 'static,
    {
        let emit_auth = Arc::new(emit_auth);
        let client = steamworks::Client::init_app(app_id)
            .map_err(|e| format!("Failed to initialize Steamworks SDK: {e}"))?;

        let emit_clone = emit_auth.clone();
        let auth_callback = client.register_callback(
            move |resp: steamworks::MicroTxnAuthorizationResponse| {
                let payload = SteamMicrotxnAuthPayload {
                    app_id: resp.app_id.0,
                    order_id: resp.order_id.to_string(),
                    authorized: resp.authorized,
                };
                emit_clone(payload);
            },
        );

        let pending_tickets = TicketRegistry::<steamworks::AuthTicket>::new();
        let pending_clone = pending_tickets.clone();
        let ticket_callback = client.register_callback(
            move |resp: steamworks::TicketForWebApiResponse| {
                let res = if resp.result.is_ok() {
                    let len = resp.ticket_len.max(0) as usize;
                    let slice = if len <= resp.ticket.len() {
                        &resp.ticket[..len]
                    } else {
                        &resp.ticket[..]
                    };
                    Ok(slice.to_vec())
                } else {
                    Err(format!(
                        "Steam web API ticket callback failed: {:?}",
                        resp.result
                    ))
                };
                pending_clone.complete_ticket(&resp.ticket_handle, res);
            },
        );

        let client_for_cb = client.clone();
        let callback_thread = std::thread::spawn(move || loop {
            client_for_cb.run_callbacks();
            std::thread::sleep(std::time::Duration::from_millis(100));
        });

        Ok(Self {
            client,
            _callback_thread: callback_thread,
            _auth_callback: auth_callback,
            _ticket_callback: ticket_callback,
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
        let (auth_ticket, rx) = self.pending_tickets.request_and_register(|| {
            self.client
                .user()
                .authentication_session_ticket_for_webapi(identity)
        });

        match rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(Ok(bytes)) => Ok(bytes_to_hex(&bytes)),
            Ok(Err(err)) => Err(err),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                self.pending_tickets.cancel_ticket(&auth_ticket);
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
