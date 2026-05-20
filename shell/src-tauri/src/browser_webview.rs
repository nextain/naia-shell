//! Tauri 2 multi-webview browser panel.
//!
//! Replaces Chrome subprocess + Win32 SetParent embedding with a native Tauri
//! child WebView2. Eliminates all IME / focus / flickering issues caused by
//! cross-process window parenting (SetParent + AttachThreadInput).
//!
//! Architecture:
//!   Tauri Window
//!     ├── Webview "main"          — Shell UI (React app)
//!     └── Webview "browser-panel" — Browser (native WebView2 / WebKitGTK)
//!
//! AI interaction: JavaScript injected via an initialization script.
//! Results are returned via a custom URI scheme protocol (naia-bridge://)
//! registered on the Tauri builder, bypassing mixed-content restrictions
//! that would block HTTP fetch from HTTPS pages on WebKitGTK.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::webview::Color;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};
use tokio::sync::oneshot;

// ─── Constants ────────────────────────────────────────────────────────────────

pub const BROWSER_LABEL: &str = "browser-panel";
const DEFAULT_URL: &str = "https://www.google.com";

// ─── State ────────────────────────────────────────────────────────────────────

static CURRENT_URL: Mutex<String> = Mutex::new(String::new());
static CURRENT_TITLE: Mutex<String> = Mutex::new(String::new());
static EVAL_COUNTER: AtomicU64 = AtomicU64::new(0);

static BROWSER_CREATE_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
fn browser_create_lock() -> &'static tokio::sync::Mutex<()> {
    BROWSER_CREATE_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<Result<String, String>>>>>;

static PENDING_EVALS: OnceLock<PendingMap> = OnceLock::new();

fn pending_evals() -> PendingMap {
    PENDING_EVALS
        .get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
        .clone()
}

// ─── Initialization script ────────────────────────────────────────────────────

/// JavaScript injected into every page of the browser webview (before any page
/// script, bypassing CSP via WebView2 AddScriptToExecuteOnDocumentCreated).
///
/// Provides:
///   window.__naia_eval(id, js_body) — async eval bridge called by Rust
///   Automatic URL/title reporting on navigation
///
/// Uses the naia-bridge:// custom protocol registered via
/// register_uri_scheme_protocol — avoids mixed-content blocking on WebKitGTK.
const INIT_SCRIPT_TEMPLATE: &str = r#"(function() {
"use strict";
function _post(path, body) {
    fetch("naia-bridge://localhost" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    }).catch(function() {});
}
window.__naia_eval = function(id, jsBody) {
    Promise.resolve().then(async function() {
        try {
            var result = await (new Function(jsBody))();
            _post("/__naia_result/" + id, {
                result: JSON.stringify(result !== undefined ? result : null),
                error: null
            });
        } catch (e) {
            _post("/__naia_result/" + id, { result: null, error: String(e) });
        }
    });
};
function _nav() {
    _post("/__naia_nav", { url: location.href, title: document.title || "" });
}
function _toUrl(u) {
    try { return new URL(String(u || ""), location.href).href; } catch (_) { return ""; }
}
var _open = window.open;
window.open = function(url) {
    var next = _toUrl(url);
    if (next && next !== "about:blank" && next !== "about:blank/") {
        location.href = next;
        return window;
    }
    return _open.apply(window, arguments);
};
document.addEventListener("click", function(e) {
    var target = e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement;
    var a = target && target.closest ? target.closest("a[target='_blank'], a[target='blank']") : null;
    if (!a) return;
    var next = _toUrl(a.getAttribute("href"));
    if (!next || next === "about:blank" || next === "about:blank/") return;
    e.preventDefault();
    location.href = next;
}, true);
window.addEventListener("load", _nav);
window.addEventListener("hashchange", _nav);
window.addEventListener("popstate", _nav);
var _op = history.pushState, _or = history.replaceState;
history.pushState = function() { _op.apply(history, arguments); setTimeout(_nav, 50); };
history.replaceState = function() { _or.apply(history, arguments); setTimeout(_nav, 50); };
if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(_nav, 100);
}
})();
"#;

// ─── Custom protocol handler ────────────────────────────────────────────────

/// Handle `naia-bridge://` custom protocol requests.
/// Called by the Tauri URI scheme protocol registered in lib.rs.
///
/// Processes eval results and URL/title tracking posted by the init script
/// via `fetch("naia-bridge://localhost/...")`.
pub fn handle_bridge_request(
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    let body = request.into_body();

    let cors_headers = |builder: tauri::http::response::Builder| -> tauri::http::response::Builder {
        builder
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Methods", "POST, OPTIONS")
            .header("Access-Control-Allow-Headers", "Content-Type")
    };

    if method == tauri::http::Method::OPTIONS {
        return cors_headers(tauri::http::Response::builder())
            .status(200)
            .header("Access-Control-Max-Age", "86400")
            .body(Vec::new())
            .unwrap();
    }

    if method == tauri::http::Method::POST {
        if let Some(id) = path.strip_prefix("/__naia_result/") {
            let id = id.trim_end_matches('/').to_string();
            if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&body) {
                let result = if let Some(e) = val["error"].as_str() {
                    Err(e.to_string())
                } else {
                    Ok(val["result"].as_str().unwrap_or("null").to_string())
                };
                if let Some(tx) = pending_evals().lock().unwrap().remove(&id) {
                    let _ = tx.send(result);
                }
            }
        } else if path == "/__naia_nav" || path == "/__naia_nav/" {
            if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&body) {
                if let Some(url) = val["url"].as_str() {
                    *CURRENT_URL.lock().unwrap() = url.to_string();
                }
                if let Some(title) = val["title"].as_str() {
                    *CURRENT_TITLE.lock().unwrap() = title.to_string();
                }
            }
        }
    }

    cors_headers(tauri::http::Response::builder())
        .status(200)
        .body(b"OK".to_vec())
        .unwrap()
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

fn build_init_script() -> String {
    INIT_SCRIPT_TEMPLATE.to_string()
}

fn gen_eval_id() -> String {
    let n = EVAL_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("e{n:016x}")
}

/// Returns the current URL tracked by the init script.
/// Used by `browser_open_login` to detect auth-complete without CDP polling.
pub fn get_current_url() -> String {
    CURRENT_URL.lock().unwrap().clone()
}

/// Update the tracked URL from a native navigation event (CSP-independent).
pub(crate) fn set_current_url(url: String) {
    *CURRENT_URL.lock().unwrap() = url;
}

fn get_wv(app: &AppHandle) -> Result<tauri::Webview, String> {
    app.get_webview(BROWSER_LABEL)
        .ok_or_else(|| "Browser webview not initialized".to_string())
}

/// Eval a JS function body in the browser webview and wait for the result.
/// Uses the HTTP bridge for the callback — works from any page origin.
async fn eval_and_await(app: &AppHandle, js_body: &str) -> Result<String, String> {
    let wv = get_wv(app)?;
    let id = gen_eval_id();

    let (tx, rx) = oneshot::channel();
    pending_evals().lock().unwrap().insert(id.clone(), tx);

    // The init script's window.__naia_eval expects (id, functionBody).
    // If the init script hasn't run yet (very first load), the call is a no-op
    // and the eval will time out — acceptable; callers should retry on error.
    let trigger = format!(
        "if(window.__naia_eval){{window.__naia_eval({id:?},{js_body:?})}}",
        id = id,
        js_body = js_body
    );

    if let Err(e) = wv.eval(&trigger) {
        pending_evals().lock().unwrap().remove(&id);
        return Err(format!("eval dispatch: {e}"));
    }

    match tokio::time::timeout(std::time::Duration::from_secs(20), rx).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Err("eval channel closed".to_string()),
        Err(_) => {
            pending_evals().lock().unwrap().remove(&id);
            Err("eval timeout (20 s)".to_string())
        }
    }
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

/// Always returns true — multi-webview needs no external Chrome binary.
#[tauri::command]
pub fn browser_wv_check() -> bool {
    true
}

/// Create (or re-show and reposition) the browser panel child webview.
///
/// `x`, `y` — panel origin in logical pixels (from getBoundingClientRect)
/// `width`, `height` — panel content area in logical pixels
///
/// MUST be `async` so it runs on a tokio worker thread, not the WebView2
/// message-callback thread (main thread). `add_child` uses
/// `run_on_main_thread` + `rx.recv()` internally — calling it from the
/// main thread deadlocks because the main thread is already blocked.
#[tauri::command]
pub async fn browser_wv_create(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    // Skip in E2E test mode — a second WebView2 in the same window disrupts the
    // WebDriver CDP session (tauri-driver attaches to exactly one WebView per
    // session; a child WebView causes "session deleted as the browser has closed
    // the connection" within seconds of startup).
    if crate::debug_e2e_enabled() {
        crate::log_verbose("[browser_wv] E2E mode — skipping child webview creation");
        return Ok(());
    }

    let _lock = browser_create_lock().lock().await;

    if let Some(wv) = app.get_webview(BROWSER_LABEL) {
        // Already exists — reposition only.
        // Visibility is managed by browser_wv_show / browser_wv_hide from JS.
        wv.set_position(LogicalPosition::new(x, y))
            .map_err(|e| format!("set_position: {e}"))?;
        wv.set_size(LogicalSize::new(width, height))
            .map_err(|e| format!("set_size: {e}"))?;
        return Ok(());
    }

    let window = app.get_window("main").ok_or("Main window not found")?;
    let init_script = build_init_script();
    let start_url = WebviewUrl::External(
        DEFAULT_URL
            .parse::<url::Url>()
            .map_err(|e| format!("URL parse: {e}"))?,
    );

    // Clone for on_navigation closure (emits auth events from the browser panel).
    let app_nav = app.clone();

    // `add_child` blocks (std::sync::mpsc recv) until the main thread processes
    // the webview creation. Use spawn_blocking so we don't starve the tokio
    // worker-thread pool while waiting.
    tokio::task::spawn_blocking(move || {
        window
            .add_child(
                WebviewBuilder::new(BROWSER_LABEL, start_url)
                    .initialization_script(&init_script)
                    // Many websites assume the root background is white. If a
                    // page leaves areas transparent, a dark webview background
                    // makes normal black text unreadable.
                    .background_color(Color(255, 255, 255, 255))
                    // Track URL changes at the native level (CSP-independent backup for
                    // init script _nav() reports). Also intercepts naia://auth redirects
                    // that the WebView cannot navigate to.
                    .on_navigation(move |url| {
                        let url_str = url.to_string();
                        // Update CURRENT_URL so browser_open_login monitor always
                        // sees the correct URL regardless of page CSP.
                        set_current_url(url_str.clone());
                        // naia://auth — deep-link redirect from login page.
                        // Process it like a deep link then block navigation (no handler).
                        if url_str.starts_with("naia://") {
                            crate::process_deep_link_url(
                                &url_str,
                                &app_nav,
                                None, // no CSRF state for in-panel login
                                "browser-panel",
                            );
                            return false; // block: WebView can't navigate to naia://
                        }
                        true // allow all other navigations
                    }),
                LogicalPosition::new(x, y),
                LogicalSize::new(width, height),
            )
            .map(|_| ())
            .map_err(|e| format!("add_child: {e}"))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))??;

    crate::log_verbose("[browser_wv] child webview created");
    Ok(())
}

/// Resize / reposition the browser webview (called on panel resize).
#[tauri::command]
pub async fn browser_wv_resize(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let wv = get_wv(&app)?;
    wv.set_position(LogicalPosition::new(x, y))
        .map_err(|e| format!("set_position: {e}"))?;
    wv.set_size(LogicalSize::new(width, height))
        .map_err(|e| format!("set_size: {e}"))?;
    Ok(())
}

/// Show the browser webview (panel activated).
#[tauri::command]
pub async fn browser_wv_show(app: AppHandle) -> Result<(), String> {
    get_wv(&app)?.show().map_err(|e| format!("show: {e}"))
}

/// Hide the browser webview (panel deactivated or unmounted).
#[tauri::command]
pub async fn browser_wv_hide(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = app.get_webview(BROWSER_LABEL) {
        wv.hide().map_err(|e| format!("hide: {e}"))?;
    }
    Ok(())
}

/// Navigate the browser webview to a URL.
#[tauri::command]
pub async fn browser_wv_navigate(app: AppHandle, url: String) -> Result<(), String> {
    // Validate URL before passing to eval.
    let _ = url
        .parse::<url::Url>()
        .map_err(|e| format!("Invalid URL: {e}"))?;
    let wv = get_wv(&app)?;
    wv.eval(&format!("window.location.href = {:?};", url))
        .map_err(|e| format!("navigate: {e}"))
}

/// Navigate back.
#[tauri::command]
pub async fn browser_wv_back(app: AppHandle) -> Result<(), String> {
    get_wv(&app)?
        .eval("history.back();")
        .map_err(|e| format!("back: {e}"))
}

/// Navigate forward.
#[tauri::command]
pub async fn browser_wv_forward(app: AppHandle) -> Result<(), String> {
    get_wv(&app)?
        .eval("history.forward();")
        .map_err(|e| format!("forward: {e}"))
}

/// Reload the current page.
#[tauri::command]
pub async fn browser_wv_reload(app: AppHandle) -> Result<(), String> {
    get_wv(&app)?
        .eval("location.reload();")
        .map_err(|e| format!("reload: {e}"))
}

/// Get current URL and title (tracked by the init script on every navigation).
#[tauri::command]
pub fn browser_wv_page_info() -> (String, String) {
    (
        CURRENT_URL.lock().unwrap().clone(),
        CURRENT_TITLE.lock().unwrap().clone(),
    )
}

/// Evaluate JavaScript and return the serialized result (for Naia AI).
#[tauri::command]
pub async fn browser_wv_eval(app: AppHandle, js: String) -> Result<String, String> {
    eval_and_await(&app, &format!("return (async()=>{{ {js} }})()")).await
}

/// Get an accessibility tree snapshot of the current page (for Naia AI).
/// Also populates `window.__naia_refs` so @eN refs can be used in click/fill.
#[tauri::command]
pub async fn browser_wv_snapshot(app: AppHandle) -> Result<String, String> {
    eval_and_await(
		&app,
		r#"return (function() {
var out = [], n = {c: 0};
window.__naia_refs = {};
function esc(s) { return String(s || "").slice(0, 200).replace(/\n/g, " "); }
function walk(node, d) {
    if (!node || d > 20 || n.c > 600) return;
    if (node.nodeType === 3) {
        var t = (node.textContent || "").trim();
        if (t) out.push("  ".repeat(d) + "- text: " + esc(t));
        return;
    }
    if (node.nodeType !== 1) return;
    var tag = node.tagName.toLowerCase();
    if (["script","style","noscript","head","meta","link","template","svg","path"].includes(tag)) return;
    n.c++;
    var ref_ = "@e" + n.c;
    window.__naia_refs[ref_] = node;
    var role = node.getAttribute("role") || tag;
    var name = node.getAttribute("aria-label") || node.getAttribute("title") ||
        node.getAttribute("alt") || node.getAttribute("placeholder") || "";
    var line = "  ".repeat(d) + "- " + ref_ + " [" + role + "]";
    if (name) line += " \"" + esc(name) + "\"";
    var val = node.value;
    if (val !== undefined && val !== null && val !== "") line += " value=\"" + esc(String(val)) + "\"";
    out.push(line);
    for (var c of node.childNodes) walk(c, d + 1);
}
walk(document.body, 0);
return out.join("\n");
})()"#,
	)
	.await
}

/// Click an element by @eN ref (from snapshot), CSS selector, or text (for Naia AI).
#[tauri::command]
pub async fn browser_wv_click(app: AppHandle, selector: String) -> Result<(), String> {
    let js = format!(
        r#"return (function() {{
var s = {sel:?};
// 1. @eN ref from most recent snapshot
var el = (window.__naia_refs && window.__naia_refs[s]) || null;
// 2. CSS selector
if (!el) {{ try {{ el = document.querySelector(s); }} catch(e) {{}} }}
// 3. Text / aria-label fallback
if (!el) {{
    var candidates = document.querySelectorAll("button,a,input,[role='button'],[role='link']");
    for (var x of candidates) {{
        if ((x.textContent || "").trim() === s || (x.getAttribute("aria-label") || "") === s) {{
            el = x; break;
        }}
    }}
}}
if (!el) throw new Error("Element not found: " + s);
el.scrollIntoView({{ block: "center", behavior: "instant" }});
el.focus();
el.click();
return null;
}})()"#,
        sel = selector
    );
    eval_and_await(&app, &js).await?;
    Ok(())
}

/// Fill a text input by @eN ref (from snapshot) or CSS selector (for Naia AI).
#[tauri::command]
pub async fn browser_wv_fill(app: AppHandle, selector: String, text: String) -> Result<(), String> {
    let js = format!(
        r#"return (function() {{
var s = {sel:?};
var el = (window.__naia_refs && window.__naia_refs[s]) || null;
if (!el) {{ try {{ el = document.querySelector(s); }} catch(e) {{}} }}
if (!el) throw new Error("Element not found: " + s);
el.focus();
el.value = {text:?};
el.dispatchEvent(new Event("input", {{ bubbles: true }}));
el.dispatchEvent(new Event("change", {{ bubbles: true }}));
return null;
}})()"#,
        sel = selector,
        text = text
    );
    eval_and_await(&app, &js).await?;
    Ok(())
}

/// Get text content of an element or the full page (for Naia AI).
#[tauri::command]
pub async fn browser_wv_get_text(app: AppHandle, selector: String) -> Result<String, String> {
    let js = if selector.is_empty() {
        "return document.body.innerText".to_string()
    } else {
        format!(
            "return (document.querySelector({sel:?}) || document.body).innerText",
            sel = selector
        )
    };
    eval_and_await(&app, &js).await
}

/// Scroll the page (for Naia AI).
#[tauri::command]
pub async fn browser_wv_scroll(
    app: AppHandle,
    direction: String,
    pixels: i32,
) -> Result<(), String> {
    let (dx, dy) = match direction.as_str() {
        "up" => (0, -pixels),
        "down" => (0, pixels),
        "left" => (-pixels, 0),
        "right" => (pixels, 0),
        _ => (0, pixels),
    };
    let js = format!("window.scrollBy({dx}, {dy}); return null;");
    eval_and_await(&app, &js).await?;
    Ok(())
}

/// Press a keyboard key (for Naia AI).
#[tauri::command]
pub async fn browser_wv_press(app: AppHandle, key: String) -> Result<(), String> {
    let js = format!(
        r#"return (function() {{
var key = {key:?};
var el = document.activeElement || document.body;
var opts = {{ key: key, bubbles: true, cancelable: true }};
el.dispatchEvent(new KeyboardEvent("keydown", opts));
el.dispatchEvent(new KeyboardEvent("keypress", opts));
el.dispatchEvent(new KeyboardEvent("keyup", opts));
return null;
}})()"#,
        key = key
    );
    eval_and_await(&app, &js).await?;
    Ok(())
}

/// Screenshot — not yet implemented in multi-webview mode.
#[tauri::command]
pub fn browser_wv_screenshot() -> Result<String, String> {
    Err("Screenshot not yet available in multi-webview mode".to_string())
}
