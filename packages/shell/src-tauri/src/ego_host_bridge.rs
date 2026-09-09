//! #582 S6c — 웹뷰에서 Node 감독자까지의 다리 (계약 4.2·4.8, 9절 S6c).
//!
//! S6a 가 도구를, S6b 가 회수를 놓았지만 그 사이가 비어 있었다. 셸 웹뷰에는 node 가 없어
//! 코어 어댑터가 `packages/ego-host/src/host-api.mjs` 를 동적 import 하려다 실패했고,
//! 그래서 **테스트가 초록이어도 사용자는 도구를 쓸 수 없었다.** 이 모듈이 그 사이다.
//!
//! ```text
//!   웹뷰(코어 어댑터)  --invoke("ego_host_*")-->  Rust(이 파일)
//!        ▲                                            │  길이 접두 프레임(4바이트 BE)
//!        └──── emit("ego-host://frame") ──────────────┤  unix 소켓 / named pipe
//!                                                     ▼
//!                     bin/supervisord.mjs (소유 자식) → 감독자 → Chromium
//! ```
//!
//! ## 판정은 여기서 하지 않는다
//!
//! 등급·승인 판정은 웹뷰의 `EnvironmentToolService` 가 이미 한다(S6a). Rust 는 형식 있는
//! JSON 을 **그대로** 나른다. 여기서 한 번 더 판정하면 두 판정이 갈라지는 날 어느 쪽이
//! 진짜인지 아무도 모른다.
//!
//! ## 관리 비밀
//!
//! 감독자를 띄울 때 이 프로세스가 만든 난수를 `EGO_HOST_ADMIN_SECRET` 환경으로만 넘긴다.
//! 그 비밀을 아는 연결만 토큰을 발급하고 감독자를 내릴 수 있다(ego-host 의 관리 연결).
//! **파일·로그·lease 어디에도 적지 않는다.** 적는 순간 소유자 전용 통로가 파일 하나로 열린다.
//!
//! ## 소켓 경로
//!
//! 경로 규칙은 `packages/ego-host/src/supervisor/socket-path.mjs` 와 **같은 값**이어야 한다.
//! 두 구현이 갈라지면 Rust 는 아무도 없는 자리에 붙고, 그 실패는 "감독자가 안 뜬다"로 보인다.
//! 단위 테스트가 그 모듈을 실제로 실행해 세 플랫폼의 값을 대조한다.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};

/// 소켓 이름 접두. `socket-path.mjs` 의 `SOCKET_NAME_PREFIX` 와 같다.
const SOCKET_NAME_PREFIX: &str = "naia-ego-host-";
/// named pipe 이름공간. `socket-path.mjs` 의 `PIPE_PREFIX` 와 같다.
const PIPE_PREFIX: &str = r"\\.\pipe\";
/// unix 소켓 경로 상한. macOS(104)를 기준으로 세 OS 를 한 값으로 덮는다.
const UNIX_SOCKET_PATH_MAX: usize = 104;
/// 프레임 상한. `rpc-framing.mjs` 의 `MAX_FRAME_BYTES` 와 같다.
const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
/// 데몬이 준비 줄을 내놓기까지 기다리는 시간. 첫 Chromium 기동이 들어 있어 넉넉해야 한다.
const READY_TIMEOUT_MS: u64 = 90_000;
/// 관리 RPC 하나의 상한. 감독자 상한(13초)보다 길게 둔다 — `stop` 은 브라우저 종료를 기다린다.
const ADMIN_CALL_TIMEOUT_MS: u64 = 30_000;
/// 데몬이 SIGTERM 에 나갈 때까지 기다리는 시간.
const DAEMON_TERM_GRACE_MS: u64 = 8_000;
/// 웹뷰가 받는 이벤트 이름. 작업 연결에서 올라온 프레임이 이 이름으로 간다.
pub(crate) const FRAME_EVENT: &str = "ego-host://frame";

// ── 소켓 경로 (순수) ─────────────────────────────────────────────────────────

/// ADK 경로를 짧고 안정적인 이름 조각으로. `socket-path.mjs` 의 `adkHash` 와 같은 규칙이다.
pub(crate) fn adk_hash(adk_root: &str) -> String {
    let digest = Sha256::digest(adk_root.as_bytes());
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    hex[..12].to_string()
}

/// 소켓 종류. named pipe 는 파일이 아니라 지울 것이 없다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SocketKind {
    Unix,
    Pipe,
}

impl SocketKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            SocketKind::Unix => "unix",
            SocketKind::Pipe => "pipe",
        }
    }
}

/// 감독자 소켓 경로. 값은 `socket-path.mjs` 의 `supervisorSocketPath` 와 **같아야 한다.**
///
/// `platform` 을 인자로 받는 이유는 계약 4.9 가 "플랫폼 값을 주입해 세 OS 를 이 머신에서
/// 검증" 하라고 적었기 때문이다. `#[cfg]` 로 갈라 두면 리눅스에서 윈도우 값을 잴 수 없다.
pub(crate) fn supervisor_socket_path(
    adk_root: &str,
    platform: &str,
    runtime_dir: Option<&str>,
    xdg_runtime_dir: Option<&str>,
) -> Result<(String, SocketKind), String> {
    if adk_root.is_empty() {
        return Err("supervisorSocketPath 에 adkRoot 가 필요하다".to_string());
    }
    let name = format!("{SOCKET_NAME_PREFIX}{}", adk_hash(adk_root));
    if platform == "win32" {
        return Ok((format!("{PIPE_PREFIX}{name}"), SocketKind::Pipe));
    }
    let dir = runtime_dir
        .filter(|value| !value.is_empty())
        .or(xdg_runtime_dir.filter(|value| !value.is_empty()))
        .map(|value| value.to_string())
        .unwrap_or_else(|| std::env::temp_dir().to_string_lossy().to_string());
    // Node 의 `path.join` 은 구분자를 하나로 만든다. 끝의 `/` 하나만 다뤄도 같은 값이 나온다.
    let trimmed = dir.trim_end_matches('/');
    let path = format!("{trimmed}/{name}.sock");
    if path.len() > UNIX_SOCKET_PATH_MAX {
        return Err(format!(
            "unix 소켓 경로가 상한 {UNIX_SOCKET_PATH_MAX}바이트를 넘었다({}): {path}",
            path.len()
        ));
    }
    Ok((path, SocketKind::Unix))
}

// ── 프레이밍 ────────────────────────────────────────────────────────────────

/// 프레임 하나. `[4바이트 BE 길이][UTF-8 JSON]` — `rpc-framing.mjs` 와 같은 규칙이다.
pub(crate) fn encode_frame(value: &Value) -> Result<Vec<u8>, String> {
    let body = serde_json::to_vec(value).map_err(|error| format!("프레임 직렬화 실패: {error}"))?;
    if body.len() > MAX_FRAME_BYTES {
        return Err(format!(
            "프레임 {}바이트가 상한 {MAX_FRAME_BYTES}바이트를 넘었다",
            body.len()
        ));
    }
    let mut frame = Vec::with_capacity(4 + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

/// 스트림 디코더. 한 청크에 프레임이 여럿이거나 하나가 여러 청크에 걸쳐도 된다.
#[derive(Default)]
pub(crate) struct FrameDecoder {
    buffer: Vec<u8>,
    broken: bool,
}

impl FrameDecoder {
    pub(crate) fn new() -> Self {
        FrameDecoder::default()
    }

    /// 받은 바이트를 넣고 완성된 프레임을 꺼낸다. 상한을 넘는 길이 헤더는 본문을 기다리지
    /// 않고 즉시 오류다 — 기다리는 것이 곧 메모리 폭탄이다.
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Result<Vec<Value>, String> {
        if self.broken {
            return Err("프레임 스트림이 이미 깨졌다".to_string());
        }
        self.buffer.extend_from_slice(chunk);
        let mut out = Vec::new();
        loop {
            if self.buffer.len() < 4 {
                return Ok(out);
            }
            let length = u32::from_be_bytes([
                self.buffer[0],
                self.buffer[1],
                self.buffer[2],
                self.buffer[3],
            ]) as usize;
            if length > MAX_FRAME_BYTES {
                self.broken = true;
                return Err(format!(
                    "수신 프레임 길이 {length}바이트가 상한 {MAX_FRAME_BYTES}바이트를 넘었다"
                ));
            }
            if self.buffer.len() < 4 + length {
                return Ok(out);
            }
            let body = self.buffer[4..4 + length].to_vec();
            self.buffer.drain(..4 + length);
            match serde_json::from_slice::<Value>(&body) {
                Ok(value) => out.push(value),
                Err(error) => {
                    self.broken = true;
                    return Err(format!("프레임 JSON 파싱 실패: {error}"));
                }
            }
        }
    }
}

// ── 전송 (OS 분기는 이 두 함수에만) ─────────────────────────────────────────
//
// unix 도메인 소켓과 named pipe 는 같은 API 로 다룰 수 없다. `platform/` 밖에 `#[cfg]` 를
// 두지 않는 것이 이 저장소의 규칙이지만, `platform/linux.rs` 는 다른 세션이 고치는 중이라
// 새 함수를 더할 수 없다(브리프의 충돌 최소화 목록). 그래서 분기를 **이 두 함수 안**에만
// 가둔다 — 다른 곳은 전부 `AsyncRead + AsyncWrite` 로만 말한다.

#[cfg(unix)]
async fn connect_stream(path: &str) -> Result<tokio::net::UnixStream, String> {
    tokio::net::UnixStream::connect(path)
        .await
        .map_err(|error| format!("감독자 소켓에 붙지 못했다({path}): {error}"))
}

#[cfg(windows)]
async fn connect_stream(
    path: &str,
) -> Result<tokio::net::windows::named_pipe::NamedPipeClient, String> {
    // ⚠️ windows4060 게이트 전까지 **미실측**이다(계약 4.9). 코드는 있으나 실기로 재지 않았다.
    tokio::net::windows::named_pipe::ClientOptions::new()
        .open(path)
        .map_err(|error| format!("감독자 named pipe 에 붙지 못했다({path}): {error}"))
}

// ── 관리 연결 (요청 하나마다 열고 닫는다) ───────────────────────────────────

/// 관리 연결 하나로 RPC 하나. 소유자 전용 통로다.
///
/// 연결을 재사용하지 않는 이유: 관리 호출은 드물고(토큰 발급·전환·종료), 오래 든 연결은
/// 감독자가 죽었을 때 "붙어 있는데 아무 응답도 없는" 상태를 만든다. 매번 여는 편이 실패를
/// 그 자리에서 드러낸다.
pub(crate) async fn admin_call_at(
    socket_path: &str,
    secret: &str,
    method: &str,
    params: Value,
    wait_for_reply: bool,
) -> Result<Value, String> {
    let mut stream = connect_stream(socket_path).await?;
    stream
        .write_all(&encode_frame(&json!({ "type": "hello", "admin": secret }))?)
        .await
        .map_err(|error| format!("관리 핸드셰이크를 보내지 못했다: {error}"))?;

    let mut decoder = FrameDecoder::new();
    let mut pending: Vec<Value> = Vec::new();
    let mut chunk = [0u8; 8192];

    // 1) welcome 을 먼저 받는다. 비밀이 틀리면 `fatal` 이 온다.
    let greeting = loop {
        if let Some(frame) = pending.first().cloned() {
            pending.remove(0);
            break frame;
        }
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|error| format!("관리 연결 읽기 실패: {error}"))?;
        if read == 0 {
            return Err("관리 연결이 인사 전에 닫혔다".to_string());
        }
        pending.extend(decoder.push(&chunk[..read])?);
    };
    if greeting.get("type").and_then(Value::as_str) != Some("welcome") {
        let message = greeting
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("관리 연결이 거부됐다");
        let code = greeting
            .get("error_code")
            .and_then(Value::as_str)
            .unwrap_or("EGO_HOST_ADMIN_DENIED");
        return Err(format!("{message} ({code})"));
    }

    // 2) RPC 하나.
    stream
        .write_all(&encode_frame(&json!({
            "type": "rpc",
            "id": 1,
            "method": method,
            "params": params,
        }))?)
        .await
        .map_err(|error| format!("관리 RPC 를 보내지 못했다: {error}"))?;

    if !wait_for_reply {
        // `stop` 이 그렇다 — 감독자를 내리는 일이 소켓 서버를 함께 닫으므로 응답이 돌아올
        // 통로가 처리 도중에 사라진다. 판정은 응답이 아니라 프로세스가 한다.
        return Ok(json!({ "sent": true }));
    }

    loop {
        if let Some(frame) = pending.first().cloned() {
            pending.remove(0);
            if frame.get("type").and_then(Value::as_str) == Some("rpc-result") {
                return Ok(frame.get("value").cloned().unwrap_or(Value::Null));
            }
            if frame.get("type").and_then(Value::as_str) == Some("fatal") {
                return Err(format!(
                    "관리 연결이 끊겼다: {}",
                    frame.get("error").and_then(Value::as_str).unwrap_or("설명 없음")
                ));
            }
            continue;
        }
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|error| format!("관리 연결 읽기 실패: {error}"))?;
        if read == 0 {
            return Err(format!("관리 RPC {method} 의 응답 전에 연결이 닫혔다"));
        }
        pending.extend(decoder.push(&chunk[..read])?);
    }
}

// ── 데몬 소유 ───────────────────────────────────────────────────────────────

/// 지금 이 셸이 소유한 감독자 데몬. 하나뿐이다 — 둘이면 어느 쪽도 상대를 회수하지 못한다.
struct Daemon {
    child: std::process::Child,
    stdin: Option<std::process::ChildStdin>,
    adk_dir: String,
    socket_path: String,
    secret: String,
    browser_pid: Option<u32>,
}

static DAEMON: OnceLock<Arc<AsyncMutex<Option<Daemon>>>> = OnceLock::new();

fn daemon_slot() -> &'static Arc<AsyncMutex<Option<Daemon>>> {
    DAEMON.get_or_init(|| Arc::new(AsyncMutex::new(None)))
}

/// 데몬 진입점을 찾는다. dev 는 워크스페이스, 번들은 Tauri 리소스다.
///
/// 순서에 뜻이 있다. 사람이 지정한 자리(`NAIA_EGO_HOST_DIR`)가 가장 세고, 그다음이 번들
/// 리소스, 마지막이 소스 트리다. 소스 트리를 먼저 보면 설치된 앱이 개발자의 체크아웃을 물고
/// 도는 일이 생긴다.
pub(crate) fn resolve_supervisord(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(explicit) = std::env::var("NAIA_EGO_HOST_DIR") {
        let explicit = explicit.trim().to_string();
        if !explicit.is_empty() {
            roots.push(PathBuf::from(explicit));
        }
    }
    if let Some(dir) = resource_dir {
        roots.push(dir.join("ego-host"));
    }
    if let Ok(cwd) = std::env::current_dir() {
        // src-tauri 에서 돌 때와 shell 에서 돌 때 둘 다 덮는다(BGM 사이드카와 같은 규율).
        roots.push(cwd.join("../../ego-host"));
        roots.push(cwd.join("../ego-host"));
        roots.push(cwd.join("packages/ego-host"));
    }
    for root in roots {
        let entry = root.join("bin").join("supervisord.mjs");
        if entry.exists() {
            return Some(dunce::canonicalize(&entry).unwrap_or(entry));
        }
    }
    None
}

/// 관리 비밀 하나. 프로세스 안에서만 살고 어디에도 적히지 않는다.
fn new_admin_secret() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).ok();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 감독자를 띄운다. 이미 같은 ADK 로 떠 있으면 아무것도 하지 않는다.
async fn ensure_daemon(adk_dir: &str, resource_dir: Option<PathBuf>) -> Result<Value, String> {
    let adk_dir = adk_dir.trim();
    if adk_dir.is_empty() {
        return Err("ego_host_ensure 에 ADK 경로가 필요하다".to_string());
    }
    let slot = daemon_slot().clone();
    let mut guard = slot.lock().await;

    if let Some(daemon) = guard.as_mut() {
        if daemon.adk_dir == adk_dir {
            match daemon.child.try_wait() {
                Ok(None) => {
                    return Ok(json!({
                        "socketPath": daemon.socket_path,
                        "browserPid": daemon.browser_pid,
                        "adkDir": daemon.adk_dir,
                        "started": false,
                    }))
                }
                // 죽은 데몬은 되살리지 않고 자리를 비운 뒤 새로 띄운다. 조용히 이어 쓰면
                // 그 사이 사라진 작업 공간·탭을 아무도 모른 채 다음 작업이 돈다.
                _ => {
                    *guard = None;
                }
            }
        } else {
            return Err(format!(
                "다른 ADK({})의 감독자가 떠 있다. 전환은 ego_host_switch_adk 로만 한다",
                daemon.adk_dir
            ));
        }
    }

    let entry = resolve_supervisord(resource_dir.as_deref()).ok_or_else(|| {
        "감독자 진입점(packages/ego-host/bin/supervisord.mjs)을 찾지 못했다".to_string()
    })?;
    let node = crate::find_node_binary()?;
    let secret = new_admin_secret();

    let mut command = std::process::Command::new(&node);
    command
        .arg(&entry)
        .arg("--adk")
        .arg(adk_dir)
        .env("EGO_HOST_ADMIN_SECRET", &secret)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("감독자 데몬을 띄우지 못했다({}): {error}", entry.display()))?;

    let stdin = child.stdin.take();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "감독자 데몬의 stdout 을 잡지 못했다".to_string())?;
    // 데몬의 stderr 는 로그로도 가고 **여기 버퍼에도** 쌓인다. 기동 실패의 이유가 그 안에
    // 있는데 로그 파일에만 두면, 웹뷰가 받는 것은 "준비되지 않았다" 한 줄뿐이다.
    let diagnostics: Arc<StdMutex<String>> = Arc::new(StdMutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let sink = diagnostics.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                crate::log_both(&format!("[Naia] ego-host daemon: {line}"));
                if let Ok(mut buffer) = sink.lock() {
                    if buffer.len() < 4096 {
                        buffer.push_str(&line);
                        buffer.push('\n');
                    }
                }
            }
        });
    }

    // 준비 줄 하나를 읽는다. 그 뒤의 출력은 계속 흘려보낸다 — 파이프가 차면 데몬이 멈춘다.
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut first = String::new();
        if reader.read_line(&mut first).unwrap_or(0) > 0 {
            let _ = ready_tx.send(first);
        }
        for line in reader.lines().map_while(Result::ok) {
            crate::log_both(&format!("[Naia] ego-host daemon: {line}"));
        }
    });

    let ready_line = tokio::task::spawn_blocking(move || {
        ready_rx.recv_timeout(Duration::from_millis(READY_TIMEOUT_MS))
    })
    .await
    .map_err(|error| format!("준비 줄 대기가 깨졌다: {error}"))?;

    let ready_line = match ready_line {
        Ok(line) => line,
        Err(reason) => {
            // 상한 초과와 "그 전에 죽었다"는 다른 사실이다. 뭉치면 원인을 못 짚는다.
            let cause = match reason {
                std::sync::mpsc::RecvTimeoutError::Timeout => {
                    format!("{READY_TIMEOUT_MS}ms 안에 준비 줄이 오지 않았다")
                }
                std::sync::mpsc::RecvTimeoutError::Disconnected => {
                    "준비 줄 없이 stdout 이 닫혔다(데몬이 그 전에 죽었다)".to_string()
                }
            };
            let status = child
                .try_wait()
                .ok()
                .flatten()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "아직 살아 있다".to_string());
            let noise = diagnostics
                .lock()
                .map(|buffer| buffer.clone())
                .unwrap_or_default();
            let _ = child.kill();
            return Err(format!(
                "감독자 데몬이 서지 못했다: {cause} (node={}, 진입점={}, 종료={status})\n{noise}",
                node.display(),
                entry.display()
            ));
        }
    };
    let ready: Value = serde_json::from_str(ready_line.trim())
        .map_err(|error| format!("감독자 준비 줄이 JSON 이 아니다: {ready_line} ({error})"))?;
    if ready.get("ready").and_then(Value::as_bool) != Some(true) {
        let _ = child.kill();
        return Err(format!(
            "감독자가 서지 못했다: {}",
            ready.get("error").and_then(Value::as_str).unwrap_or("설명 없음")
        ));
    }
    let socket_path = ready
        .get("socketPath")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let browser_pid = ready.get("browserPid").and_then(Value::as_u64).map(|v| v as u32);
    crate::log_both(&format!(
        "[Naia] ego-host daemon ready adk={adk_dir} browser_pid={:?}",
        browser_pid
    ));
    *guard = Some(Daemon {
        child,
        stdin,
        adk_dir: adk_dir.to_string(),
        socket_path: socket_path.clone(),
        secret,
        browser_pid,
    });
    Ok(json!({
        "socketPath": socket_path,
        "browserPid": browser_pid,
        "adkDir": adk_dir,
        "started": true,
    }))
}

/// 지금 소켓 경로와 비밀. 감독자가 없으면 형식 있는 오류다.
async fn admin_target() -> Result<(String, String), String> {
    let slot = daemon_slot().clone();
    let guard = slot.lock().await;
    let daemon = guard
        .as_ref()
        .ok_or_else(|| "감독자가 떠 있지 않다. ego_host_ensure 를 먼저 부른다".to_string())?;
    Ok((daemon.socket_path.clone(), daemon.secret.clone()))
}

async fn admin_call(method: &str, params: Value, wait_for_reply: bool) -> Result<Value, String> {
    let (socket_path, secret) = admin_target().await?;
    match tokio::time::timeout(
        Duration::from_millis(ADMIN_CALL_TIMEOUT_MS),
        admin_call_at(&socket_path, &secret, method, params, wait_for_reply),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(format!("관리 RPC {method} 가 {ADMIN_CALL_TIMEOUT_MS}ms 를 넘겼다")),
    }
}

/// 데몬을 내린다. stdin 을 닫아 EOF 를 주고, 그래도 남으면 신호를 보낸다.
///
/// 동기 함수다 — 셸 종료·Reset·재시작 경로가 전부 동기 자리이기 때문이다. 그 자리에서
/// 비동기 런타임을 새로 세우면 종료 중인 프로세스에 런타임이 하나 더 생긴다.
pub(crate) fn stop_blocking(label: &str) {
    let slot = daemon_slot().clone();
    let mut guard = match slot.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            crate::log_both(&format!(
                "[Naia] ego-host bridge {label}: 다른 호출이 쓰는 중이라 내리지 못했다"
            ));
            return;
        }
    };
    let Some(mut daemon) = guard.take() else {
        return;
    };
    // 1) stdin 닫기 = EOF. 데몬은 이것을 부모 소멸로 읽고 `stop()` 한다.
    drop(daemon.stdin.take());
    let deadline = std::time::Instant::now() + Duration::from_millis(DAEMON_TERM_GRACE_MS);
    let mut exited = false;
    while std::time::Instant::now() < deadline {
        match daemon.child.try_wait() {
            Ok(Some(_)) => {
                exited = true;
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    // 2) 그래도 남으면 죽인다. 우리가 띄운 자식이라 PID 추측이 아니다.
    if !exited {
        let _ = daemon.child.kill();
        let _ = daemon.child.wait();
    }
    crate::log_both(&format!(
        "[Naia] ego-host bridge {label}: 데몬 내림 (graceful={exited})"
    ));
}

// ── 작업 연결(세션) ─────────────────────────────────────────────────────────

struct Session {
    writer: mpsc::UnboundedSender<Vec<u8>>,
    pending: Arc<StdMutex<HashMap<u64, oneshot::Sender<Value>>>>,
    next_rpc_id: AtomicU64,
    /// 이 연결의 등급. **부른 명령의 이름으로 Rust 가 정한 값**이며 웹뷰의 선언이 아니다(S7).
    tier: &'static str,
}

static SESSIONS: OnceLock<Arc<StdMutex<HashMap<u64, Arc<Session>>>>> = OnceLock::new();
static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

fn sessions() -> &'static Arc<StdMutex<HashMap<u64, Arc<Session>>>> {
    SESSIONS.get_or_init(|| Arc::new(StdMutex::new(HashMap::new())))
}

fn session_of(id: u64) -> Result<Arc<Session>, String> {
    sessions()
        .lock()
        .map_err(|_| "세션 장부가 깨졌다".to_string())?
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("그런 세션이 없다: {id}"))
}

/// 작업 연결 하나를 연다. 핸드셰이크까지 마친 뒤에야 세션 id 를 돌려준다.
///
/// `welcome` 은 **여기서 삼킨다.** 웹뷰가 듣기 전에 나가면 아무도 못 받고, 웹뷰는 연결이
/// 섰다는 사실을 `session_open` 의 성공으로 이미 안다.
async fn open_session(app: AppHandle, hello: Value, tier: &'static str) -> Result<u64, String> {
    let (socket_path, _secret) = admin_target().await?;
    let mut stream = connect_stream(&socket_path).await?;
    stream
        .write_all(&encode_frame(&hello)?)
        .await
        .map_err(|error| format!("작업 핸드셰이크를 보내지 못했다: {error}"))?;

    let mut decoder = FrameDecoder::new();
    let mut chunk = [0u8; 8192];
    let mut leftover: Vec<Value> = Vec::new();
    let greeting = loop {
        if !leftover.is_empty() {
            break leftover.remove(0);
        }
        let read = tokio::time::timeout(Duration::from_millis(15_000), stream.read(&mut chunk))
            .await
            .map_err(|_| "작업 연결의 인사가 15초 안에 오지 않았다".to_string())?
            .map_err(|error| format!("작업 연결 읽기 실패: {error}"))?;
        if read == 0 {
            return Err("작업 연결이 인사 전에 닫혔다".to_string());
        }
        leftover.extend(decoder.push(&chunk[..read])?);
    };
    if greeting.get("type").and_then(Value::as_str) != Some("welcome") {
        return Err(format!(
            "작업 연결이 거부됐다: {} ({})",
            greeting.get("error").and_then(Value::as_str).unwrap_or("설명 없음"),
            greeting
                .get("error_code")
                .and_then(Value::as_str)
                .unwrap_or("EGO_HOST_HANDSHAKE_INVALID")
        ));
    }

    let id = NEXT_SESSION_ID.fetch_add(1, Ordering::SeqCst);
    let pending: Arc<StdMutex<HashMap<u64, oneshot::Sender<Value>>>> =
        Arc::new(StdMutex::new(HashMap::new()));
    let (writer_tx, mut writer_rx) = mpsc::unbounded_channel::<Vec<u8>>();

    let (mut read_half, mut write_half) = tokio::io::split(stream);
    tokio::spawn(async move {
        while let Some(frame) = writer_rx.recv().await {
            if write_half.write_all(&frame).await.is_err() {
                break;
            }
        }
        let _ = write_half.shutdown().await;
    });

    let reader_pending = pending.clone();
    let reader_app = app.clone();
    tokio::spawn(async move {
        let mut decoder = decoder;
        let mut buffered = leftover;
        let mut chunk = [0u8; 65536];
        loop {
            // 인사와 같은 청크에 실려 온 프레임이 있으면 먼저 흘린다.
            while !buffered.is_empty() {
                let frame = buffered.remove(0);
                deliver_frame(&reader_app, id, &reader_pending, frame);
            }
            let read = match read_half.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            match decoder.push(&chunk[..read]) {
                Ok(frames) => buffered = frames,
                Err(error) => {
                    let _ = reader_app.emit(
                        FRAME_EVENT,
                        json!({ "session": id, "type": "fatal", "error": error }),
                    );
                    break;
                }
            }
        }
        // 연결이 죽으면 대기 중인 RPC 를 형식 있는 실패로 끊는다. 안 그러면 각자 자기
        // 상한을 다 채우고 나서야 실패해 ADK 전환이 몇 분씩 매달린다(S3b 가 겪은 자리).
        if let Ok(mut map) = reader_pending.lock() {
            for (_, sender) in map.drain() {
                let _ = sender.send(json!({
                    "error": "감독자 연결이 닫혔다",
                    "error_code": "EGO_HOST_DISCONNECTED",
                }));
            }
        }
        if let Ok(mut map) = sessions().lock() {
            map.remove(&id);
        }
        let _ = reader_app.emit(FRAME_EVENT, json!({ "session": id, "type": "closed" }));
    });

    sessions()
        .lock()
        .map_err(|_| "세션 장부가 깨졌다".to_string())?
        .insert(
            id,
            Arc::new(Session {
                writer: writer_tx,
                pending,
                next_rpc_id: AtomicU64::new(1),
                tier,
            }),
        );
    Ok(id)
}

/// 프레임 하나를 제 자리로. `rpc-result` 는 기다리는 쪽에, 나머지는 웹뷰로.
fn deliver_frame(
    app: &AppHandle,
    session: u64,
    pending: &Arc<StdMutex<HashMap<u64, oneshot::Sender<Value>>>>,
    frame: Value,
) {
    if frame.get("type").and_then(Value::as_str) == Some("rpc-result") {
        let id = frame.get("id").and_then(Value::as_u64).unwrap_or(0);
        let value = frame.get("value").cloned().unwrap_or(Value::Null);
        if let Ok(mut map) = pending.lock() {
            if let Some(sender) = map.remove(&id) {
                let _ = sender.send(value);
                return;
            }
        }
        return;
    }
    let mut payload = frame;
    if let Some(object) = payload.as_object_mut() {
        object.insert("session".to_string(), json!(session));
    }
    let _ = app.emit(FRAME_EVENT, payload);
}

// ── Tauri 명령 ──────────────────────────────────────────────────────────────
//
// ## 웹뷰가 부를 수 있는 것은 효과가 고정된 작업뿐이다 (S7, P0)
//
// S6c 까지 이 자리에는 세 개의 넓은 문이 있었다. 임의 grant 로 토큰을 만드는 문
// (`ego_host_issue_token`), 아무 관리 RPC 나 부르는 문(`ego_host_rpc`), 그리고 그 토큰으로
// 아무 등급 연결이나 여는 문(`ego_host_session_open`). 판정은 웹뷰의 `EnvironmentToolService`
// 가 한다고 적어 두었지만, **판정하는 쪽과 판정을 지나지 않고도 닿는 쪽이 같은 웹뷰**였다.
// 그래서 웹뷰 하나가 뚫리면 등급표·승인 장부가 통째로 장식이 된다.
//
// 이제 웹뷰가 부를 수 있는 것은 `ego_host_op_*` 뿐이고, 각 명령의 **등급은 그 명령의 이름이
// 정한다.** 클라이언트가 실은 `grant`·`approvalRef` 는 받자마자 버린다. 토큰 발급과 관리
// 채널은 이 파일 안에서만 쓰인다.

/// 웹뷰에 노출하는 효과 고정 RPC 의 등급표 (계약 4.4).
///
/// **정본이 아니다.** 정본은 서비스의 `BROWSER_RPC_TIERS`
/// (`src/main/app/control/env-tool.ts`)이고, 이 표는 그것과 같은 값이어야 한다 — 단위 테스트가
/// 그 파일을 실제로 읽어 칸마다 대조한다. 하드코딩한 기대값을 적으면 두 표가 갈라진 사실을
/// 아무도 잡지 못한다(같은 이유로 소켓 경로도 Node 모듈을 실행해 대조한다).
pub(crate) const OP_TIERS: &[(&str, &str)] = &[
    ("snapshot", "observe"),
    ("screenshot", "observe"),
    ("listWorkspaces", "observe"),
    ("createWorkspace", "workspace-write"),
    ("closeWorkspace", "workspace-write"),
    ("open", "workspace-write"),
    ("navigate", "workspace-write"),
    ("click", "workspace-write"),
    ("fill", "workspace-write"),
    ("evaluate", "workspace-write"),
    ("close", "workspace-write"),
];

/// 웹뷰에서 **언제나 거부**하는 RPC.
///
/// `script` 는 임의 자바스크립트 heredoc 이고 건별 승인을 요구하는데(계약 3절 4번),
/// 그 승인을 남기는 자리가 Rust 에 없다. 승인 기록 없이 통과시키면 "승인이 필요하다"가
/// 웹뷰의 자기 신고 하나에 걸린다. FR-ENV-TOOL.14b(승인 UI)가 닫히기 전까지 여기서 끝낸다.
pub(crate) const OP_ALWAYS_REFUSED: &[&str] = &["script"];

/// 거부 문구. 서비스의 `approval-missing` 거부와 같은 코드를 문구 앞에 둔다 —
/// 벤더·Tauri 경계를 지나며 구조가 문자열로 납작해지므로 코드가 문구 안에 있어야 읽힌다.
pub(crate) const SCRIPT_REFUSAL: &str =
    "approval-missing: script 는 Rust 쪽 승인 기록이 없어 웹뷰에서 거부한다 — 승인 UI 미구현 (FR-ENV-TOOL.14b)";

/// 명령 이름 → 등급. 표에 없으면 거부다(기본 거부).
pub(crate) fn op_tier(rpc: &str) -> Result<&'static str, String> {
    if OP_ALWAYS_REFUSED.contains(&rpc) {
        return Err(SCRIPT_REFUSAL.to_string());
    }
    OP_TIERS
        .iter()
        .find(|(name, _)| *name == rpc)
        .map(|(_, tier)| *tier)
        .ok_or_else(|| format!("effect-unknown: 등급표에 없는 RPC 다: {rpc}"))
}

/// 등급 하나를 감독자 grant 로. 관측 등급은 grant 없이 붙어 **원시 CDP 를 아예 못 보낸다**.
pub(crate) fn grant_of_tier(tier: &str) -> Option<Value> {
    if tier == "observe" {
        None
    } else {
        // `approvalRef` 를 넣지 않는다. Rust 에 승인 기록이 없으므로 없는 승인을 지어내지 않는다.
        Some(json!({ "tier": tier }))
    }
}

/// 작업 하나를 연다. 토큰 발급도 여기서 한다 — 웹뷰는 토큰을 보지도, 만들지도 못한다.
async fn begin_op(
    app: AppHandle,
    rpc: &'static str,
    operation_id: String,
    workspace_id: Option<String>,
    deadline: Option<u64>,
    grant: Option<Value>,
) -> Result<u64, String> {
    // 클라이언트가 실은 등급 선언은 **여기서 버린다.** 이름이 정한 것만 쓴다.
    drop(grant);
    let tier = op_tier(rpc)?;
    let grant = grant_of_tier(tier);
    let issued = admin_call(
        "issueToken",
        json!({
            "operationId": operation_id,
            "workspaceId": workspace_id,
            "grant": grant,
        }),
        true,
    )
    .await?;
    if let Some(error) = issued.get("error").and_then(Value::as_str) {
        return Err(format!("토큰 발급이 거부됐다: {error}"));
    }
    let token = issued
        .get("token")
        .and_then(Value::as_str)
        .ok_or_else(|| "토큰 발급 응답에 토큰이 없다".to_string())?
        .to_string();
    open_session(
        app,
        json!({
            "type": "hello",
            "token": token,
            "grant": grant,
            "operationId": operation_id,
            "workspaceId": workspace_id,
            "deadline": deadline,
        }),
        tier,
    )
    .await
}

/// 효과가 고정된 명령 하나하나. 이름이 곧 등급이므로 인자에 등급이 없다.
///
/// 매크로로 찍는 이유는 열두 벌의 몸통이 **정확히 같아야** 하기 때문이다. 손으로 적으면
/// 한 벌에서 `drop(grant)` 하나가 빠지는 날 그 명령만 클라이언트 선언을 받는다.
macro_rules! fixed_effect_ops {
    ($($name:ident => $rpc:literal),+ $(,)?) => {$(
        #[tauri::command]
        pub async fn $name(
            app: AppHandle,
            operation_id: String,
            workspace_id: Option<String>,
            deadline: Option<u64>,
            grant: Option<Value>,
        ) -> Result<u64, String> {
            begin_op(app, $rpc, operation_id, workspace_id, deadline, grant).await
        }
    )+};
}

fixed_effect_ops! {
    ego_host_op_open => "open",
    ego_host_op_navigate => "navigate",
    ego_host_op_snapshot => "snapshot",
    ego_host_op_click => "click",
    ego_host_op_fill => "fill",
    ego_host_op_evaluate => "evaluate",
    ego_host_op_screenshot => "screenshot",
    ego_host_op_close => "close",
    ego_host_op_create_workspace => "createWorkspace",
    ego_host_op_list_workspaces => "listWorkspaces",
    ego_host_op_close_workspace => "closeWorkspace",
}

/// heredoc 은 여기서 끝난다. 명령은 **있지만** 어떤 인자로도 통과하지 않는다.
///
/// 명령을 아예 두지 않으면 "없는 명령"과 "거부된 명령"이 같은 실패로 보여, 승인 UI 가 생긴
/// 뒤 무엇이 바뀌어야 하는지 실패 문구가 말해 주지 못한다.
#[tauri::command]
pub async fn ego_host_op_script() -> Result<u64, String> {
    Err(SCRIPT_REFUSAL.to_string())
}

/// 감독자를 띄우거나 이미 떠 있음을 확인한다.
#[tauri::command]
pub async fn ego_host_ensure(app: AppHandle, adk_dir: String) -> Result<Value, String> {
    let resource_dir = tauri::Manager::path(&app).resource_dir().ok();
    ensure_daemon(&adk_dir, resource_dir).await
}

/// 작업 연결의 RPC 하나. 감독자는 실패를 던지지 않고 `{error, error_code}` 로 답한다.
///
/// `method` 가 자유롭지만 등급을 넘지 못한다: 감독자가 관리 RPC(`issueToken`·`stop`…)를
/// **작업 연결에서는 거부**하고(`ADMIN_RPCS`), grant 없는 연결에는 관측 RPC 만 허용한다.
#[tauri::command]
pub async fn ego_host_op_rpc(
    session: u64,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    let handle = session_of(session)?;
    let id = handle.next_rpc_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel::<Value>();
    handle
        .pending
        .lock()
        .map_err(|_| "세션 장부가 깨졌다".to_string())?
        .insert(id, tx);
    let frame = encode_frame(&json!({
        "type": "rpc",
        "id": id,
        "method": method,
        "params": params.unwrap_or_else(|| json!({})),
    }))?;
    handle
        .writer
        .send(frame)
        .map_err(|_| format!("세션 {session} 의 송신 통로가 닫혔다"))?;
    rx.await
        .map_err(|_| format!("세션 {session} 의 RPC {method} 응답이 사라졌다"))
}

/// CDP 한 통. 응답은 이벤트로 올라간다 — 벤더 런타임과 같은 비동기 통로다.
///
/// 이중 방어다. 관측 등급 연결은 감독자가 grant 없이 세웠으므로 감독자가 이미 거부하지만,
/// 여기서도 먼저 거부한다. 두 겹 중 하나가 깨져도 다른 하나가 남는다.
#[tauri::command]
pub async fn ego_host_op_cdp(
    session: u64,
    payload: String,
    operation_id: Option<String>,
) -> Result<(), String> {
    let handle = session_of(session)?;
    if handle.tier == "observe" {
        return Err(format!(
            "grant-required: 관측 등급 작업({})은 원시 CDP 를 보낼 수 없다",
            handle.tier
        ));
    }
    let mut frame = json!({ "type": "cdp", "payload": payload });
    if let Some(operation) = operation_id.filter(|value| !value.is_empty()) {
        frame["operationId"] = json!(operation);
    }
    handle
        .writer
        .send(encode_frame(&frame)?)
        .map_err(|_| format!("세션 {session} 의 송신 통로가 닫혔다"))
}

/// 작업 연결 하나를 닫는다. 작업의 **종결**은 `ego_host_op_complete` 가 적는다.
#[tauri::command]
pub async fn ego_host_op_end(session: u64) -> Result<(), String> {
    if let Ok(mut map) = sessions().lock() {
        map.remove(&session);
    }
    Ok(())
}

/// 작업 하나를 취소한다. 메서드 이름은 고정이며 웹뷰가 고르지 않는다.
#[tauri::command]
pub async fn ego_host_op_cancel(operation_id: String, reason: Option<String>) -> Result<Value, String> {
    admin_call(
        "cancelOperationOwned",
        json!({ "operationId": operation_id, "reason": reason }),
        true,
    )
    .await
}

/// 작업 하나를 종결로 적는다. 상태·사유는 형식이 있는 값만 지난다.
#[tauri::command]
pub async fn ego_host_op_complete(
    operation_id: String,
    status: Option<String>,
    reason: Option<String>,
) -> Result<Value, String> {
    admin_call(
        "endOperationOwned",
        json!({ "operationId": operation_id, "status": status, "reason": reason }),
        true,
    )
    .await
}

/// lease 조정. 감독자 소유는 Rust 의 사실이므로 메서드가 고정이다.
#[tauri::command]
pub async fn ego_host_reconcile_lease(adk_dir: Option<String>) -> Result<Value, String> {
    admin_call("reconcileLease", json!({ "adkDir": adk_dir }), true).await
}

/// 작업 공간 자리 만들기. 경로 목록만 지난다.
#[tauri::command]
pub async fn ego_host_ensure_dirs(dirs: Vec<String>) -> Result<Value, String> {
    admin_call("ensureDirs", json!({ "dirs": dirs }), true).await
}

/// 작업 공간 `.env` 쓰기. 감독자가 자기 자리 안으로만 쓴다.
#[tauri::command]
pub async fn ego_host_write_env_files(files: Value) -> Result<Value, String> {
    admin_call("writeEnvFiles", json!({ "files": files }), true).await
}

/// PID 소멸 대기. 프로세스는 Rust 쪽 사실이지만 감독자가 자기 자식을 안다.
#[tauri::command]
pub async fn ego_host_wait_pid_exit(pid: u32, timeout_ms: Option<u64>) -> Result<Value, String> {
    admin_call(
        "waitForPidExit",
        json!({ "pid": pid, "timeoutMs": timeout_ms.unwrap_or(10_000) }),
        true,
    )
    .await
}

/// 감독자를 내린다. 관리 통로로 알린 뒤 데몬 프로세스까지 확실히 회수한다.
#[tauri::command]
pub async fn ego_host_stop() -> Result<Value, String> {
    // 응답을 기다리지 않는다 — `stop` 은 자기 소켓 서버를 함께 닫는다.
    let notified = admin_call("stop", json!({}), false).await.is_ok();
    tokio::task::spawn_blocking(|| stop_blocking("stop(command)"))
        .await
        .map_err(|error| format!("데몬 회수가 깨졌다: {error}"))?;
    Ok(json!({ "stopped": true, "notified": notified }))
}


#[cfg(test)]
mod tests {
    use super::*;

    /// Node 쪽 `socket-path.mjs` 를 **실제로 실행해** 값을 받는다.
    ///
    /// 하드코딩한 기대값은 두 구현이 갈라진 사실을 잡지 못한다 — 갈라지는 쪽이 Node 여도
    /// Rust 의 상수는 그대로이기 때문이다. 그래서 정본을 그 자리에서 물어본다.
    fn node_socket_path(adk_root: &str, platform: &str, xdg: Option<&str>) -> Option<String> {
        let module = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../ego-host/src/supervisor/socket-path.mjs");
        let module = dunce::canonicalize(&module).unwrap_or(module);
        if !module.exists() {
            return None;
        }
        let script = format!(
            "import {{ supervisorSocketPath }} from {module:?};\
             const out = supervisorSocketPath({{ adkRoot: {adk:?}, platform: {platform:?}, env: {env} }});\
             process.stdout.write(out.path + '\\n' + out.kind);",
            module = module.to_string_lossy(),
            adk = adk_root,
            platform = platform,
            env = match xdg {
                Some(dir) => format!("{{ XDG_RUNTIME_DIR: {dir:?} }}"),
                None => "{}".to_string(),
            }
        );
        let output = std::process::Command::new("node")
            .arg("--input-type=module")
            .arg("--eval")
            .arg(script)
            .output()
            .ok()?;
        if !output.status.success() {
            panic!(
                "socket-path.mjs 실행이 실패했다: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        Some(String::from_utf8_lossy(&output.stdout).to_string())
    }

    #[test]
    fn socket_path_matches_the_node_rule_on_three_platforms() {
        let adk = "/var/home/luke/naia-adk";
        let cases = [
            ("linux", Some("/run/user/1000")),
            ("darwin", Some("/tmp")),
            ("win32", None),
        ];
        let mut compared = 0;
        for (platform, xdg) in cases {
            let (path, kind) = supervisor_socket_path(adk, platform, None, xdg).expect(platform);
            let Some(expected) = node_socket_path(adk, platform, xdg) else {
                panic!("socket-path.mjs 를 찾지 못했다 — 대조할 정본이 없으면 이 검사는 공허하다");
            };
            let mut lines = expected.split('\n');
            assert_eq!(path, lines.next().unwrap_or_default(), "{platform} 경로가 다르다");
            assert_eq!(
                kind.as_str(),
                lines.next().unwrap_or_default(),
                "{platform} 소켓 종류가 다르다"
            );
            compared += 1;
        }
        assert_eq!(compared, 3, "세 플랫폼을 다 대조하지 않았다");
    }

    /// 서비스의 등급표(`BROWSER_RPC_TIERS`)를 **파일에서 읽어** 칸마다 뜯는다.
    ///
    /// 기대값을 여기 적으면 두 표가 갈라진 사실을 못 잡는다 — 갈라지는 쪽이 TS 여도 Rust 의
    /// 상수는 그대로이기 때문이다. 소켓 경로를 Node 모듈을 실행해 대조하는 것과 같은 이유다.
    fn service_rpc_tiers() -> Vec<(String, String)> {
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../src/main/app/control/env-tool.ts");
        let text = std::fs::read_to_string(&file)
            .unwrap_or_else(|error| panic!("서비스 등급표를 읽지 못했다({}): {error}", file.display()));
        let start = text
            .find("BROWSER_RPC_TIERS: Readonly<Record<BrowserRpc, CapabilityTier>> = {")
            .expect("BROWSER_RPC_TIERS 선언을 찾지 못했다 — 이름이 바뀌었으면 이 검사부터 고친다");
        let body = &text[start..];
        let end = body.find("\n};").expect("등급표의 끝을 찾지 못했다");
        let mut rows = Vec::new();
        for line in body[..end].lines().skip(1) {
            let line = line.trim();
            if line.is_empty() || line.starts_with("//") || line.starts_with("*") {
                continue;
            }
            let Some((name, rest)) = line.split_once(':') else { continue };
            let tier = rest.trim().trim_end_matches(',').trim_matches('"');
            rows.push((name.trim().to_string(), tier.to_string()));
        }
        assert!(rows.len() >= 12, "등급표를 {}칸밖에 못 읽었다 — 파싱이 깨졌다", rows.len());
        rows
    }

    #[test]
    fn the_rust_tier_table_matches_the_service_table_cell_by_cell() {
        let service = service_rpc_tiers();
        let mut checked = 0;
        for (rpc, tier) in &service {
            if OP_ALWAYS_REFUSED.contains(&rpc.as_str()) {
                let error = op_tier(rpc).unwrap_err();
                assert!(error.contains("approval-missing"), "{rpc}: {error}");
                checked += 1;
                continue;
            }
            assert_eq!(
                op_tier(rpc).unwrap_or_else(|error| panic!("{rpc} 가 Rust 표에 없다: {error}")),
                tier.as_str(),
                "{rpc} 의 등급이 서비스와 다르다"
            );
            checked += 1;
        }
        assert_eq!(checked, service.len());
        // 반대 방향도 본다. Rust 에만 있는 이름은 서비스가 판정하지 않는 문이 된다.
        for (rpc, _) in OP_TIERS {
            assert!(
                service.iter().any(|(name, _)| name == rpc),
                "{rpc} 가 Rust 표에만 있다"
            );
        }
    }

    #[test]
    fn a_client_declared_grant_never_reaches_the_tier_decision() {
        // 이름이 정한다. 인자로 무엇이 오든 `begin_op` 는 그것을 버리고 표를 본다.
        assert_eq!(op_tier("snapshot").unwrap(), "observe");
        assert_eq!(op_tier("click").unwrap(), "workspace-write");
        assert_eq!(grant_of_tier("observe"), None);
        assert_eq!(
            grant_of_tier("workspace-write"),
            Some(json!({ "tier": "workspace-write" }))
        );
        // 승인 참조를 지어내지 않는다 — Rust 에 승인 기록이 없다.
        let grant = grant_of_tier("workspace-write").unwrap();
        assert!(grant.get("approvalRef").is_none());
    }

    #[test]
    fn script_is_refused_and_unknown_rpcs_are_refused_too() {
        let refused = op_tier("script").unwrap_err();
        assert!(refused.contains("approval-missing"), "{refused}");
        assert!(refused.contains("FR-ENV-TOOL.14b"), "{refused}");
        assert_eq!(refused, SCRIPT_REFUSAL);
        let unknown = op_tier("Runtime.evaluate").unwrap_err();
        assert!(unknown.contains("effect-unknown"), "{unknown}");
    }

    #[tokio::test]
    async fn the_script_command_refuses_before_it_can_reach_the_supervisor() {
        let error = ego_host_op_script().await.unwrap_err();
        assert_eq!(error, SCRIPT_REFUSAL);
    }

    #[test]
    fn the_adk_hash_is_twelve_hex_characters() {
        let hash = adk_hash("/var/home/luke/naia-adk");
        assert_eq!(hash.len(), 12);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(hash, adk_hash("/var/home/luke/naia-adk2"));
    }

    #[test]
    fn a_long_runtime_directory_is_refused_before_bind() {
        let long = format!("/{}", "a".repeat(120));
        let error = supervisor_socket_path("/adk", "linux", Some(&long), None).unwrap_err();
        assert!(error.contains("상한"), "{error}");
    }

    #[test]
    fn frames_round_trip_through_the_decoder() {
        let first = json!({ "type": "hello", "admin": "비밀" });
        let second = json!({ "type": "rpc", "id": 1, "method": "hostInfo" });
        let mut bytes = encode_frame(&first).unwrap();
        bytes.extend(encode_frame(&second).unwrap());

        // 한 바이트씩 밀어 넣는다. 프레임 하나가 여러 청크에 걸치는 경우가 실제 소켓의 기본이다.
        let mut decoder = FrameDecoder::new();
        let mut seen = Vec::new();
        for byte in &bytes {
            seen.extend(decoder.push(&[*byte]).unwrap());
        }
        assert_eq!(seen, vec![first, second]);
    }

    #[test]
    fn an_oversized_length_header_fails_without_waiting_for_the_body() {
        let mut decoder = FrameDecoder::new();
        let mut header = ((MAX_FRAME_BYTES + 1) as u32).to_be_bytes().to_vec();
        header.push(b'{');
        let error = decoder.push(&header).unwrap_err();
        assert!(error.contains("상한"), "{error}");
    }

    #[test]
    fn malformed_json_breaks_the_stream_instead_of_being_ignored() {
        let mut decoder = FrameDecoder::new();
        let body = b"not json";
        let mut frame = (body.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(body);
        assert!(decoder.push(&frame).is_err());
        assert!(decoder.push(&frame).is_err(), "깨진 뒤에도 계속 받았다");
    }

    /// 가짜 감독자 하나. 관리 비밀이 맞을 때만 `welcome` 을 준다.
    #[cfg(unix)]
    async fn fake_supervisor(path: String, secret: String) {
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        while let Ok((mut stream, _)) = listener.accept().await {
            let secret = secret.clone();
            tokio::spawn(async move {
                let mut decoder = FrameDecoder::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let read = match stream.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(read) => read,
                    };
                    let frames = match decoder.push(&chunk[..read]) {
                        Ok(frames) => frames,
                        Err(_) => return,
                    };
                    for frame in frames {
                        if frame.get("type").and_then(Value::as_str) == Some("hello") {
                            let given = frame.get("admin").and_then(Value::as_str).unwrap_or("");
                            let reply = if given == secret {
                                json!({ "type": "welcome", "admin": true })
                            } else {
                                json!({
                                    "type": "fatal",
                                    "error": "관리 연결의 비밀이 맞지 않는다",
                                    "error_code": "EGO_HOST_ADMIN_DENIED",
                                })
                            };
                            let _ = stream.write_all(&encode_frame(&reply).unwrap()).await;
                            if given != secret {
                                return;
                            }
                            continue;
                        }
                        if frame.get("type").and_then(Value::as_str) == Some("rpc") {
                            let reply = json!({
                                "type": "rpc-result",
                                "id": frame.get("id").cloned().unwrap_or(json!(1)),
                                "value": { "echo": frame.get("method").cloned().unwrap_or(Value::Null) },
                            });
                            let _ = stream.write_all(&encode_frame(&reply).unwrap()).await;
                        }
                    }
                }
            });
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_admin_secret_must_match_or_the_connection_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.sock").to_string_lossy().to_string();
        let server = tokio::spawn(fake_supervisor(path.clone(), "옳은-비밀".to_string()));
        // 소켓이 설 때까지 잠깐 기다린다.
        for _ in 0..100 {
            if std::path::Path::new(&path).exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let ok = admin_call_at(&path, "옳은-비밀", "hostInfo", json!({}), true)
            .await
            .expect("맞는 비밀이 거부됐다");
        assert_eq!(ok["echo"], json!("hostInfo"));

        let denied = admin_call_at(&path, "틀린-비밀", "hostInfo", json!({}), true)
            .await
            .unwrap_err();
        assert!(denied.contains("EGO_HOST_ADMIN_DENIED"), "{denied}");
        server.abort();
    }
}
