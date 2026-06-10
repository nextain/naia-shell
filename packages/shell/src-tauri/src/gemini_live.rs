//! Gemini Live WebSocket proxy.
//!
//! WebKitGTK cannot connect to `wss://generativelanguage.googleapis.com` directly
//! (connection hangs silently). This module proxies the WebSocket through Rust,
//! forwarding messages between the frontend (via Tauri events/commands) and Google.

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const GEMINI_WS_BASE: &str =
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const CONNECT_TIMEOUT_SECS: u64 = 15;

// ── Types ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GeminiLiveConnectParams {
    pub api_key: String,
    pub model: Option<String>,
    pub voice: Option<String>,
    pub system_instruction: Option<String>,
}

/// Handle for an active session; holds the sender half so commands can forward messages.
pub struct GeminiLiveHandle {
    tx: mpsc::UnboundedSender<String>,
}

/// Extract text payload from both Text and Binary WebSocket frames.
/// Gemini Live API sends JSON as Binary frames via tokio-tungstenite.
fn msg_to_text(msg: &Message) -> Option<String> {
    match msg {
        Message::Text(t) => Some(t.to_string()),
        Message::Binary(b) => String::from_utf8(b.to_vec()).ok(),
        _ => None,
    }
}

pub type SharedHandle = Arc<Mutex<Option<GeminiLiveHandle>>>;

pub fn new_shared_handle() -> SharedHandle {
    Arc::new(Mutex::new(None))
}

// ── Connect ──

pub async fn connect(
    app: AppHandle,
    handle: SharedHandle,
    params: GeminiLiveConnectParams,
) -> Result<(), String> {
    // Ensure rustls crypto provider is available (ring, pulled in by reqwest)
    let _ = rustls::crypto::ring::default_provider().install_default();

    // Close any existing session
    disconnect(handle.clone()).await;

    let model = params
        .model
        .unwrap_or_else(|| "gemini-2.5-flash-native-audio-preview-12-2025".into());
    let voice = params.voice.unwrap_or_else(|| "Kore".into());

    let url = format!("{}?key={}", GEMINI_WS_BASE, params.api_key);
    log_both("[GeminiLiveProxy] connecting...");

    // Connect with timeout
    let ws_stream = tokio::time::timeout(
        std::time::Duration::from_secs(CONNECT_TIMEOUT_SECS),
        connect_async(&url),
    )
    .await
    .map_err(|_| "Connection timeout".to_string())?
    .map_err(|e| format!("WebSocket error: {}", e))?
    .0;

    log_both("[GeminiLiveProxy] WebSocket connected, sending setup");

    let (mut sink, mut stream) = ws_stream.split();

    // Send setup message
    let generation_config = serde_json::json!({
        "responseModalities": ["AUDIO"],
        "speechConfig": {
            "voiceConfig": {
                "prebuiltVoiceConfig": {
                    "voiceName": voice
                }
            }
        }
    });

    let mut setup = serde_json::json!({
        "setup": {
            "model": format!("models/{}", model),
            "generationConfig": generation_config,
            "inputAudioTranscription": {},
            "outputAudioTranscription": {}
        }
    });

    if let Some(ref instruction) = params.system_instruction {
        setup["setup"]["systemInstruction"] =
            serde_json::json!({ "parts": [{ "text": instruction }] });
    }

    sink.send(Message::Text(setup.to_string().into()))
        .await
        .map_err(|e| format!("Failed to send setup: {}", e))?;

    // Wait for setupComplete
    let setup_complete = tokio::time::timeout(
        std::time::Duration::from_secs(CONNECT_TIMEOUT_SECS),
        wait_for_setup(&mut stream, &app),
    )
    .await
    .map_err(|_| "Setup timeout".to_string())?;

    setup_complete?;

    log_both("[GeminiLiveProxy] setup complete");
    let _ = app.emit("gemini-live:setup-complete", ());

    // Create channel for frontend → Google messages
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    // Store handle
    {
        let mut h = handle.lock().await;
        *h = Some(GeminiLiveHandle { tx });
    }

    let handle_clone = handle.clone();
    let app_clone = app.clone();

    // Spawn bidirectional relay
    tokio::spawn(async move {
        loop {
            tokio::select! {
                // Frontend → Google
                msg = rx.recv() => {
                    match msg {
                        Some(text) => {
                            if sink.send(Message::Text(text.into())).await.is_err() {
                                break;
                            }
                        }
                        None => break, // channel closed
                    }
                }
                // Google → Frontend
                msg = stream.next() => {
                    match msg {
                        Some(Ok(m)) => {
                            if let Some(text) = msg_to_text(&m) {
                                if let Err(e) = handle_server_message(&app_clone, &text) {
                                    log_both(&format!("[GeminiLiveProxy] message error: {}", e));
                                }
                            } else if matches!(m, Message::Close(_)) {
                                log_both("[GeminiLiveProxy] server closed connection");
                                break;
                            }
                            // Ping, Pong — ignore
                        }
                        None => {
                            log_both("[GeminiLiveProxy] server closed connection");
                            break;
                        }
                        Some(Err(e)) => {
                            log_both(&format!("[GeminiLiveProxy] stream error: {}", e));
                            let _ = app_clone.emit("gemini-live:error", e.to_string());
                            break;
                        }
                    }
                }
            }
        }

        // Cleanup
        {
            let mut h = handle_clone.lock().await;
            *h = None;
        }
        let _ = app_clone.emit("gemini-live:disconnected", ());
        log_both("[GeminiLiveProxy] relay ended");
    });

    Ok(())
}

async fn wait_for_setup(
    stream: &mut futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
    app: &AppHandle,
) -> Result<(), String> {
    while let Some(msg) = stream.next().await {
        match msg {
            Ok(m) => {
                if let Some(text) = msg_to_text(&m) {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                        if json.get("setupComplete").is_some() {
                            return Ok(());
                        }
                        if let Some(err) = json.get("error") {
                            let msg = err
                                .get("message")
                                .and_then(|m| m.as_str())
                                .unwrap_or("Setup failed");
                            let _ = app.emit("gemini-live:error", msg.to_string());
                            return Err(msg.to_string());
                        }
                    }
                } else if let Message::Close(frame) = m {
                    let reason = frame
                        .map(|f| format!("code={} reason={}", f.code, f.reason))
                        .unwrap_or_else(|| "unknown".into());
                    return Err(format!("Closed during setup: {}", reason));
                }
            }
            Err(e) => return Err(format!("WebSocket error during setup: {}", e)),
        }
    }
    Err("Connection closed before setup".into())
}

// ── Server → Frontend event dispatch ──

fn handle_server_message(app: &AppHandle, text: &str) -> Result<(), String> {
    let msg: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("JSON parse: {}", e))?;

    if let Some(sc) = msg.get("serverContent") {
        // Audio data
        if let Some(mt) = sc.get("modelTurn") {
            if let Some(parts) = mt.get("parts").and_then(|p| p.as_array()) {
                for part in parts {
                    if let Some(data) = part
                        .get("inlineData")
                        .and_then(|d| d.get("data"))
                        .and_then(|d| d.as_str())
                    {
                        let _ = app.emit("gemini-live:audio", data);
                    }
                }
            }
        }

        // Input transcription
        if let Some(itx) = sc.get("inputTranscription") {
            if let Some(text) = itx.get("text").and_then(|t| t.as_str()) {
                let _ = app.emit("gemini-live:input-transcript", text);
            }
        }

        // Output transcription
        if let Some(otx) = sc.get("outputTranscription") {
            if let Some(text) = otx.get("text").and_then(|t| t.as_str()) {
                let _ = app.emit("gemini-live:output-transcript", text);
            }
        }

        // Turn complete
        if sc.get("turnComplete").and_then(|v| v.as_bool()) == Some(true) {
            let _ = app.emit("gemini-live:turn-end", ());
        }

        // Interrupted
        if sc.get("interrupted").and_then(|v| v.as_bool()) == Some(true) {
            let _ = app.emit("gemini-live:interrupted", ());
        }
    }

    // Tool calls
    if let Some(tc) = msg.get("toolCall") {
        if let Some(calls) = tc.get("functionCalls").and_then(|c| c.as_array()) {
            for call in calls {
                let payload = serde_json::json!({
                    "id": call.get("id"),
                    "name": call.get("name"),
                    "args": call.get("args").unwrap_or(&serde_json::json!({}))
                });
                let _ = app.emit("gemini-live:tool-call", payload);
            }
        }
    }

    Ok(())
}

// ── Commands: Frontend → Google ──

pub async fn send_audio(handle: &SharedHandle, pcm_base64: String) -> Result<(), String> {
    let guard = handle.lock().await;
    let h = guard.as_ref().ok_or("Not connected")?;
    let msg = serde_json::json!({
        "realtimeInput": {
            "mediaChunks": [{
                "mimeType": "audio/pcm;rate=16000",
                "data": pcm_base64
            }]
        }
    });
    h.tx.send(msg.to_string())
        .map_err(|_| "Channel closed".into())
}

pub async fn send_text(handle: &SharedHandle, text: String) -> Result<(), String> {
    let guard = handle.lock().await;
    let h = guard.as_ref().ok_or("Not connected")?;
    let msg = serde_json::json!({
        "clientContent": {
            "turns": [{ "role": "user", "parts": [{ "text": text }] }],
            "turnComplete": true
        }
    });
    h.tx.send(msg.to_string())
        .map_err(|_| "Channel closed".into())
}

pub async fn send_tool_response(
    handle: &SharedHandle,
    call_id: String,
    result: serde_json::Value,
) -> Result<(), String> {
    let guard = handle.lock().await;
    let h = guard.as_ref().ok_or("Not connected")?;
    let msg = serde_json::json!({
        "toolResponse": {
            "functionResponses": [{
                "id": call_id,
                "response": { "result": result }
            }]
        }
    });
    h.tx.send(msg.to_string())
        .map_err(|_| "Channel closed".into())
}

pub async fn disconnect(handle: SharedHandle) {
    let mut h = handle.lock().await;
    if h.is_some() {
        log_both("[GeminiLiveProxy] disconnecting");
    }
    *h = None; // drops the sender, which will cause the relay task to end
}

fn log_both(msg: &str) {
    eprintln!("{}", msg);
}
