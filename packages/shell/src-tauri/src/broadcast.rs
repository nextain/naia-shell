use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::ffi::{OsStr, OsString};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

pub const BROADCAST_STATUS_EVENT: &str = "broadcast-status-changed";
pub const MAX_AUTO_RESTARTS: u32 = 3;
pub const AUTO_RESTART_DELAY: Duration = Duration::from_secs(10);
const DEV_PLACEHOLDER_PREFIX: &[u8] = b"#!naia-ffmpeg-dev-placeholder";

/// Swappable screen capture source (Item 3).
/// Windows uses `gdigrab` (`title=Naia`), Linux returns `"미구현 — 실측 대기"` until live Wayland/PipeWire measurement.
pub trait ScreenCaptureSource: Send + Sync {
    fn name(&self) -> &'static str;
    fn video_input_args(&self, fps: u32) -> Result<Vec<String>, String>;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct WindowsGdiGrabCapture;

impl ScreenCaptureSource for WindowsGdiGrabCapture {
    fn name(&self) -> &'static str {
        "gdigrab"
    }

    fn video_input_args(&self, fps: u32) -> Result<Vec<String>, String> {
        Ok(vec![
            "-f".to_string(),
            "gdigrab".to_string(),
            "-framerate".to_string(),
            fps.to_string(),
            "-draw_mouse".to_string(),
            "0".to_string(),
            "-i".to_string(),
            "title=Naia".to_string(),
        ])
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct LinuxStubCapture;

impl ScreenCaptureSource for LinuxStubCapture {
    fn name(&self) -> &'static str {
        "linux-stub"
    }

    fn video_input_args(&self, _fps: u32) -> Result<Vec<String>, String> {
        Err("미구현 — 실측 대기".to_string())
    }
}

pub fn default_screen_capture_source() -> Box<dyn ScreenCaptureSource> {
    #[cfg(target_os = "windows")]
    {
        Box::new(WindowsGdiGrabCapture)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Box::new(LinuxStubCapture)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BroadcastPlatform {
    Youtube,
    Twitch,
    Chzzk,
    Soop,
}

impl BroadcastPlatform {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Youtube => "youtube",
            Self::Twitch => "twitch",
            Self::Chzzk => "chzzk",
            Self::Soop => "soop",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "twitch" => Self::Twitch,
            "chzzk" => Self::Chzzk,
            "soop" | "afreeca" => Self::Soop,
            _ => Self::Youtube,
        }
    }

    pub fn default_server_url(self) -> &'static str {
        match self {
            Self::Youtube => "rtmps://a.rtmp.youtube.com/live2",
            Self::Twitch => "rtmps://live.twitch.tv/app",
            Self::Chzzk => "rtmp://global-rtmp.lip2.navercorp.com:8080/relay",
            Self::Soop => "rtmp://stream.sooplive.co.kr/app",
        }
    }

    /// Keyframe interval in seconds: YouTube/Twitch/SOOP = 2s, Chzzk = 1s.
    pub fn keyframe_interval_seconds(self) -> u32 {
        match self {
            Self::Youtube | Self::Twitch | Self::Soop => 2,
            Self::Chzzk => 1,
        }
    }

    pub fn gop_size(self, fps: u32) -> u32 {
        self.keyframe_interval_seconds() * fps
    }

    /// Default video bitrate: YouTube 6M, Twitch 6M, Chzzk 8M, SOOP 6M.
    pub fn default_bitrate(self) -> &'static str {
        match self {
            Self::Youtube | Self::Twitch | Self::Soop => "6M",
            Self::Chzzk => "8M",
        }
    }

    pub fn default_bufsize(self) -> &'static str {
        match self {
            Self::Youtube | Self::Twitch | Self::Soop => "12M",
            Self::Chzzk => "16M",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BroadcastResolution {
    #[serde(rename = "1080p30")]
    P1080Fps30,
    #[serde(rename = "720p30")]
    P720Fps30,
}

impl BroadcastResolution {
    pub fn parse(raw: Option<&str>) -> Self {
        match raw.map(|s| s.trim()) {
            Some("720p30") => Self::P720Fps30,
            _ => Self::P1080Fps30,
        }
    }

    pub fn dimensions(self) -> (u32, u32) {
        match self {
            Self::P1080Fps30 => (1920, 1080),
            Self::P720Fps30 => (1280, 720),
        }
    }

    pub fn fps(self) -> u32 {
        30
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum VideoEncoder {
    #[serde(rename = "h264_nvenc")]
    H264Nvenc,
    #[serde(rename = "libx264")]
    Libx264,
}

impl VideoEncoder {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::H264Nvenc => "h264_nvenc",
            Self::Libx264 => "libx264",
        }
    }
}

#[derive(Debug, Clone)]
pub struct FfmpegStreamSpec {
    pub platform: BroadcastPlatform,
    pub server_url: String,
    pub stream_key: String,
    pub resolution: BroadcastResolution,
    pub encoder: VideoEncoder,
    pub output_file: Option<PathBuf>,
}

impl FfmpegStreamSpec {
    pub fn destination_target(&self) -> Result<String, String> {
        if let Some(ref file) = self.output_file {
            return Ok(file.to_string_lossy().into_owned());
        }
        let key = self.stream_key.trim();
        if key.is_empty() {
            return Err("방송 키가 설정되지 않았습니다.".to_string());
        }
        let base = if self.server_url.trim().is_empty() {
            self.platform.default_server_url()
        } else {
            self.server_url.trim()
        };
        let normalized_base = base.trim_end_matches('/');
        Ok(format!("{normalized_base}/{key}"))
    }
}

/// Build `ffmpeg` CLI arguments for screen video + stdin PCM audio -> RTMP(S) / FLV file.
pub fn build_ffmpeg_args(
    spec: &FfmpegStreamSpec,
    capture: &dyn ScreenCaptureSource,
) -> Result<Vec<String>, String> {
    let fps = spec.resolution.fps();
    let (width, height) = spec.resolution.dimensions();
    let gop = spec.platform.gop_size(fps);
    let bitrate = spec.platform.default_bitrate();
    let bufsize = spec.platform.default_bufsize();
    let target = spec.destination_target()?;

    let mut args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
        "-y".to_string(),
    ];

    // 1. Video input from screen capture source
    let video_in = capture.video_input_args(fps)?;
    args.extend(video_in);

    // 2. Audio input from stdin (48kHz stereo s16le PCM extracted by WebAudio AudioWorklet)
    args.extend([
        "-f".to_string(),
        "s16le".to_string(),
        "-ar".to_string(),
        "48000".to_string(),
        "-ac".to_string(),
        "2".to_string(),
        "-i".to_string(),
        "pipe:0".to_string(),
    ]);

    // 3. Video encoder: h264_nvenc primary, libx264 veryfast fallback
    match spec.encoder {
        VideoEncoder::H264Nvenc => {
            args.extend([
                "-c:v".to_string(),
                "h264_nvenc".to_string(),
                "-preset".to_string(),
                "p4".to_string(),
            ]);
        }
        VideoEncoder::Libx264 => {
            args.extend([
                "-c:v".to_string(),
                "libx264".to_string(),
                "-preset".to_string(),
                "veryfast".to_string(),
                "-tune".to_string(),
                "zerolatency".to_string(),
            ]);
        }
    }

    args.extend([
        "-vf".to_string(),
        format!("scale={width}:{height}"),
        "-r".to_string(),
        fps.to_string(),
        "-pix_fmt".to_string(),
        "yuv420p".to_string(),
        "-b:v".to_string(),
        bitrate.to_string(),
        "-maxrate".to_string(),
        bitrate.to_string(),
        "-bufsize".to_string(),
        bufsize.to_string(),
        "-g".to_string(),
        gop.to_string(),
        "-keyint_min".to_string(),
        gop.to_string(),
    ]);

    // 4. Audio encoder: AAC 160k 48kHz stereo
    args.extend([
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "160k".to_string(),
        "-ar".to_string(),
        "48000".to_string(),
        "-ac".to_string(),
        "2".to_string(),
    ]);

    // 5. Output FLV muxer -> RTMP(S) or local .flv file
    args.extend(["-f".to_string(), "flv".to_string(), target]);

    Ok(args)
}

/// Redact stream key from a single string or URL so it is NEVER written to logs or stdout.
pub fn redact_stream_key(text: &str, stream_key: &str) -> String {
    let trimmed_key = stream_key.trim();
    let mut masked = if !trimmed_key.is_empty() {
        text.replace(trimmed_key, "***")
    } else {
        text.to_string()
    };

    // Defense-in-depth: if an rtmp:// or rtmps:// URL has a stream key segment at the end, mask it.
    if (masked.starts_with("rtmp://") || masked.starts_with("rtmps://")) && !masked.ends_with("/***")
    {
        let scheme_end = masked.find("://").map(|idx| idx + 3).unwrap_or(0);
        let after_scheme = &masked[scheme_end..];
        // Format is host/app/key -> at least 2 slashes after scheme
        let slash_positions: Vec<usize> = after_scheme
            .char_indices()
            .filter_map(|(i, c)| if c == '/' { Some(scheme_end + i) } else { None })
            .collect();
        if slash_positions.len() >= 2 {
            let last_slash = *slash_positions.last().unwrap();
            masked.replace_range((last_slash + 1).., "***");
        }
    }
    masked
}

/// Redact stream key across all `ffmpeg` CLI arguments (`***`).
pub fn redact_ffmpeg_args(args: &[String], stream_key: &str) -> Vec<String> {
    args.iter()
        .map(|arg| redact_stream_key(arg, stream_key))
        .collect()
}

fn is_usable_ffmpeg_sidecar(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    if let Ok(bytes) = fs::read(path) {
        if bytes.starts_with(DEV_PLACEHOLDER_PREFIX) {
            return false;
        }
    }
    true
}

fn sidecar_candidate_names() -> Vec<String> {
    let mut names = Vec::new();
    #[cfg(target_os = "windows")]
    {
        names.push("binaries/ffmpeg-x86_64-pc-windows-msvc.exe".to_string());
        names.push("ffmpeg-x86_64-pc-windows-msvc.exe".to_string());
        names.push("binaries/ffmpeg.exe".to_string());
        names.push("ffmpeg.exe".to_string());
    }
    #[cfg(not(target_os = "windows"))]
    {
        names.push("binaries/ffmpeg-x86_64-unknown-linux-gnu".to_string());
        names.push("ffmpeg-x86_64-unknown-linux-gnu".to_string());
        names.push("binaries/ffmpeg".to_string());
        names.push("ffmpeg".to_string());
        names.push("binaries/ffmpeg-x86_64-pc-windows-msvc.exe".to_string());
        names.push("ffmpeg.exe".to_string());
    }
    names
}

/// Pure testable resolver for `ffmpeg` binary (Item 1).
/// Resolution order:
/// 1. Bundled sidecar next to the app (`sidecar_dirs`)
/// 2. `NAIA_FFMPEG_PATH` environment variable (`env_override`)
/// 3. `PATH` lookup (`path_env`), falling back to `"ffmpeg"`
pub(crate) fn resolve_ffmpeg_path_from(
    sidecar_dirs: &[&Path],
    env_override: Option<&OsStr>,
    path_env: Option<&OsStr>,
) -> PathBuf {
    let candidates = sidecar_candidate_names();
    for dir in sidecar_dirs {
        for rel in &candidates {
            let candidate = dir.join(rel);
            if is_usable_ffmpeg_sidecar(&candidate) {
                return candidate;
            }
        }
    }

    if let Some(raw_env) = env_override {
        let trimmed = raw_env.to_string_lossy();
        let trimmed = trimmed.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    if let Some(paths) = path_env {
        let bin_names: &[&str] = if cfg!(windows) {
            &["ffmpeg.exe", "ffmpeg"]
        } else {
            &["ffmpeg"]
        };
        for dir in std::env::split_paths(paths) {
            for bin in bin_names {
                let candidate = dir.join(bin);
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
    }

    PathBuf::from("ffmpeg")
}

/// Resolve `ffmpeg` binary in production / command context.
pub(crate) fn resolve_ffmpeg_path(app: Option<&AppHandle>) -> PathBuf {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.to_path_buf());
        }
    }
    if let Some(handle) = app {
        if let Ok(res_dir) = handle.path().resource_dir() {
            if !dirs.iter().any(|d| d == &res_dir) {
                dirs.push(res_dir);
            }
        }
    }
    let dir_refs: Vec<&Path> = dirs.iter().map(PathBuf::as_path).collect();
    let env_override: Option<OsString> = std::env::var_os("NAIA_FFMPEG_PATH");
    let path_env: Option<OsString> = std::env::var_os("PATH");
    resolve_ffmpeg_path_from(&dir_refs, env_override.as_deref(), path_env.as_deref())
}

/// Pack 48kHz stereo float32 channels (`[-1.0, 1.0]`) into interleaved `s16le` bytes.
pub fn pack_f32_stereo_to_s16le(left: &[f32], right: &[f32]) -> Vec<u8> {
    let frames = left.len().min(right.len());
    let mut out = Vec::with_capacity(frames * 4);
    for i in 0..frames {
        let l = (left[i].clamp(-1.0, 1.0) * 32767.0).round() as i16;
        let r = (right[i].clamp(-1.0, 1.0) * 32767.0).round() as i16;
        out.extend_from_slice(&l.to_le_bytes());
        out.extend_from_slice(&r.to_le_bytes());
    }
    out
}

/// Single-line broadcast log entry appended to `<ADK>/data-private/broadcast/log.jsonl` (Item 6).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BroadcastLogEntry {
    pub start: String,
    pub end: String,
    pub minutes: f64,
    pub answers: u32,
    pub credits_used: f64,
    pub brain: String,
    pub platform: String,
    pub encoder: String,
    pub drops: u32,
}

pub fn normalize_brain_label(raw: Option<&str>) -> String {
    match raw.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("local") => "local".to_string(),
        Some("both") => "both".to_string(),
        _ => "gateway".to_string(),
    }
}

pub fn append_broadcast_log(adk_path: &Path, entry: &BroadcastLogEntry) -> Result<PathBuf, String> {
    let dir = adk_path.join("data-private").join("broadcast");
    fs::create_dir_all(&dir).map_err(|e| format!("방송 기록 폴더 생성 실패: {e}"))?;
    let log_file = dir.join("log.jsonl");
    let line = serde_json::to_string(entry).map_err(|e| format!("방송 기록 직렬화 실패: {e}"))?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file)
        .map_err(|e| format!("방송 기록 파일 열기 실패: {e}"))?;
    file.write_all(format!("{line}\n").as_bytes())
        .map_err(|e| format!("방송 기록 쓰기 실패: {e}"))?;
    file.flush()
        .map_err(|e| format!("방송 기록 플러시 실패: {e}"))?;
    Ok(log_file)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastStartRequest {
    pub adk_path: String,
    pub platform: String,
    pub server_url: Option<String>,
    pub stream_key: Option<String>,
    pub resolution: Option<String>,
    pub output_file: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastStopRequest {
    pub adk_path: Option<String>,
    pub answers: Option<u32>,
    pub credits_used: Option<f64>,
    pub brain: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastStatusSnapshot {
    pub state: String,
    pub started_at: Option<String>,
    pub elapsed_seconds: u64,
    pub platform: Option<String>,
    pub encoder: Option<String>,
    pub drops: u32,
    pub restart_count: u32,
    pub last_error: Option<String>,
}

struct BroadcastSession {
    session_id: u64,
    state: String,
    started_at: String,
    started_instant: Instant,
    adk_path: PathBuf,
    spec: FfmpegStreamSpec,
    ffmpeg_path: PathBuf,
    encoder: VideoEncoder,
    drops: u32,
    restart_count: u32,
    last_error: Option<String>,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
}

#[derive(Default)]
struct BroadcastManager {
    next_session_id: u64,
    active: Option<BroadcastSession>,
    last_snapshot: Option<BroadcastStatusSnapshot>,
}

impl BroadcastManager {
    fn snapshot(&self) -> BroadcastStatusSnapshot {
        if let Some(ref session) = self.active {
            BroadcastStatusSnapshot {
                state: session.state.clone(),
                started_at: Some(session.started_at.clone()),
                elapsed_seconds: session.started_instant.elapsed().as_secs(),
                platform: Some(session.spec.platform.as_str().to_string()),
                encoder: Some(session.encoder.as_str().to_string()),
                drops: session.drops,
                restart_count: session.restart_count,
                last_error: session.last_error.clone(),
            }
        } else if let Some(ref last) = self.last_snapshot {
            last.clone()
        } else {
            BroadcastStatusSnapshot {
                state: "idle".to_string(),
                started_at: None,
                elapsed_seconds: 0,
                platform: None,
                encoder: None,
                drops: 0,
                restart_count: 0,
                last_error: None,
            }
        }
    }
}

fn broadcast_manager() -> &'static Arc<Mutex<BroadcastManager>> {
    static MANAGER: OnceLock<Arc<Mutex<BroadcastManager>>> = OnceLock::new();
    MANAGER.get_or_init(|| Arc::new(Mutex::new(BroadcastManager::default())))
}

fn spawn_ffmpeg_with_fallback(
    ffmpeg_path: &Path,
    base_spec: &FfmpegStreamSpec,
    capture: &dyn ScreenCaptureSource,
) -> Result<(Child, ChildStdin, VideoEncoder), String> {
    for encoder in [VideoEncoder::H264Nvenc, VideoEncoder::Libx264] {
        let mut spec = base_spec.clone();
        spec.encoder = encoder;
        let args = build_ffmpeg_args(&spec, capture)?;
        let redacted = redact_ffmpeg_args(&args, &spec.stream_key);
        log::info!(
            "[broadcast] spawning ffmpeg ({}) args={:?}",
            encoder.as_str(),
            redacted
        );

        let mut command = Command::new(ffmpeg_path);
        command
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }

        match command.spawn() {
            Ok(mut child) => {
                // Give NVENC a brief window to fail fast if GPU/driver does not support h264_nvenc
                std::thread::sleep(Duration::from_millis(250));
                match child.try_wait() {
                    Ok(None) => {
                        let stdin = child
                            .stdin
                            .take()
                            .ok_or_else(|| "ffmpeg stdin 파이프를 열지 못했습니다.".to_string())?;
                        return Ok((child, stdin, encoder));
                    }
                    Ok(Some(status)) => {
                        log::warn!(
                            "[broadcast] ffmpeg ({}) exited immediately with status {status}",
                            encoder.as_str()
                        );
                        if encoder == VideoEncoder::Libx264 {
                            return Err(format!("ffmpeg 시작 실패 (종료 코드: {status})"));
                        }
                    }
                    Err(err) => {
                        if encoder == VideoEncoder::Libx264 {
                            return Err(format!("ffmpeg 상태 확인 실패: {err}"));
                        }
                    }
                }
            }
            Err(err) => {
                if encoder == VideoEncoder::Libx264 {
                    return Err(format!("ffmpeg 실행 실패: {err}"));
                }
            }
        }
    }
    Err("사용 가능한 영상 인코더(h264_nvenc / libx264)를 시작하지 못했습니다.".to_string())
}

fn start_supervisor_thread(app: AppHandle, session_id: u64) {
    let manager_arc = Arc::clone(broadcast_manager());
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));

        let mut exited_unexpectedly = false;
        let mut should_retry = false;
        let mut snapshot_to_emit: Option<BroadcastStatusSnapshot> = None;

        {
            let Ok(mut mgr) = manager_arc.lock() else {
                return;
            };
            let Some(ref mut session) = mgr.active else {
                return;
            };
            if session.session_id != session_id {
                return;
            }
            if let Some(ref mut child) = session.child {
                match child.try_wait() {
                    Ok(None) => {}
                    Ok(Some(status)) => {
                        session.child = None;
                        session.stdin = None;
                        session.drops += 1;
                        session.state = "disconnected".to_string();
                        session.last_error =
                            Some(format!(" 방송 연결이 끊겼습니다 (ffmpeg 종료: {status})"));
                        exited_unexpectedly = true;
                        should_retry = session.restart_count < MAX_AUTO_RESTARTS;
                        snapshot_to_emit = Some(mgr.snapshot());
                    }
                    Err(err) => {
                        session.child = None;
                        session.stdin = None;
                        session.drops += 1;
                        session.state = "disconnected".to_string();
                        session.last_error = Some(format!("방송 상태 감시 오류: {err}"));
                        exited_unexpectedly = true;
                        should_retry = session.restart_count < MAX_AUTO_RESTARTS;
                        snapshot_to_emit = Some(mgr.snapshot());
                    }
                }
            }
        }

        if let Some(snap) = snapshot_to_emit {
            let _ = app.emit(BROADCAST_STATUS_EVENT, snap);
        }

        if !exited_unexpectedly {
            continue;
        }

        if !should_retry {
            return;
        }

        // Wait 10 seconds before attempting auto-restart, aborting early if stopped by user.
        let ticks = (AUTO_RESTART_DELAY.as_millis() / 200) as usize;
        for _ in 0..ticks {
            std::thread::sleep(Duration::from_millis(200));
            let Ok(mgr) = manager_arc.lock() else {
                return;
            };
            match mgr.active {
                Some(ref s) if s.session_id == session_id => {}
                _ => return,
            }
        }

        let respawn_inputs = {
            let Ok(mut mgr) = manager_arc.lock() else {
                return;
            };
            let Some(ref mut session) = mgr.active else {
                return;
            };
            if session.session_id != session_id || session.restart_count >= MAX_AUTO_RESTARTS {
                return;
            }
            session.restart_count += 1;
            (session.ffmpeg_path.clone(), session.spec.clone())
        };

        let capture = default_screen_capture_source();
        let respawn_result =
            spawn_ffmpeg_with_fallback(&respawn_inputs.0, &respawn_inputs.1, capture.as_ref());

        let post_retry_snapshot = {
            let Ok(mut mgr) = manager_arc.lock() else {
                return;
            };
            let Some(ref mut session) = mgr.active else {
                return;
            };
            if session.session_id != session_id {
                return;
            }
            match respawn_result {
                Ok((child, stdin, encoder)) => {
                    session.child = Some(child);
                    session.stdin = Some(stdin);
                    session.encoder = encoder;
                    session.state = "live".to_string();
                    session.last_error = None;
                }
                Err(err) => {
                    session.state = "disconnected".to_string();
                    session.last_error = Some(err);
                }
            }
            mgr.snapshot()
        };

        let _ = app.emit(BROADCAST_STATUS_EVENT, post_retry_snapshot);
    });
}

#[tauri::command]
pub fn broadcast_start(
    app: AppHandle,
    request: BroadcastStartRequest,
) -> Result<BroadcastStatusSnapshot, String> {
    let adk_trimmed = request.adk_path.trim();
    if adk_trimmed.is_empty() {
        return Err("워크스페이스(ADK) 경로가 비어 있습니다.".to_string());
    }
    let adk_path = PathBuf::from(adk_trimmed);
    let platform = BroadcastPlatform::parse(&request.platform);
    let resolution = BroadcastResolution::parse(request.resolution.as_deref());
    let server_url = request
        .server_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| platform.default_server_url())
        .to_string();

    let stream_key = request
        .stream_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_default();

    let output_file = request
        .output_file
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);

    if output_file.is_none() && stream_key.is_empty() {
        return Err("방송 키가 설정되지 않았습니다.".to_string());
    }

    let capture = default_screen_capture_source();
    // Validate screen capture availability first (on Linux this returns "미구현 — 실측 대기").
    let _ = capture.video_input_args(resolution.fps())?;

    let ffmpeg_path = resolve_ffmpeg_path(Some(&app));
    let spec = FfmpegStreamSpec {
        platform,
        server_url,
        stream_key,
        resolution,
        encoder: VideoEncoder::H264Nvenc,
        output_file,
    };

    let mut mgr = broadcast_manager()
        .lock()
        .map_err(|_| "방송 상태 잠금 오류".to_string())?;
    if mgr.active.is_some() {
        return Err("이미 방송이 진행 중입니다.".to_string());
    }

    let (child, stdin, encoder) =
        spawn_ffmpeg_with_fallback(&ffmpeg_path, &spec, capture.as_ref())?;

    mgr.next_session_id += 1;
    let session_id = mgr.next_session_id;
    let started_at = utc_now_rfc3339();

    mgr.active = Some(BroadcastSession {
        session_id,
        state: "live".to_string(),
        started_at,
        started_instant: Instant::now(),
        adk_path,
        spec,
        ffmpeg_path,
        encoder,
        drops: 0,
        restart_count: 0,
        last_error: None,
        child: Some(child),
        stdin: Some(stdin),
    });

    let snap = mgr.snapshot();
    drop(mgr);

    let _ = app.emit(BROADCAST_STATUS_EVENT, snap.clone());
    start_supervisor_thread(app, session_id);
    Ok(snap)
}

#[tauri::command]
pub fn broadcast_stop(
    app: AppHandle,
    request: Option<BroadcastStopRequest>,
) -> Result<BroadcastStatusSnapshot, String> {
    let req = request.unwrap_or_default();
    let session = {
        let mut mgr = broadcast_manager()
            .lock()
            .map_err(|_| "방송 상태 잠금 오류".to_string())?;
        mgr.next_session_id += 1;
        mgr.active.take()
    };

    let Some(mut session) = session else {
        let mgr = broadcast_manager()
            .lock()
            .map_err(|_| "방송 상태 잠금 오류".to_string())?;
        return Ok(mgr.snapshot());
    };

    if let Some(mut stdin) = session.stdin.take() {
        let _ = stdin.write_all(b"q\n");
        let _ = stdin.flush();
    }

    if let Some(mut child) = session.child.take() {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
            }
        }
    }

    let end_at = utc_now_rfc3339();
    let elapsed_secs = session.started_instant.elapsed().as_secs_f64();
    let minutes = ((elapsed_secs / 60.0) * 100.0).round() / 100.0;
    let adk_path = req
        .adk_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or(session.adk_path);

    let entry = BroadcastLogEntry {
        start: session.started_at,
        end: end_at,
        minutes,
        answers: req.answers.unwrap_or(0),
        credits_used: ((req.credits_used.unwrap_or(0.0).max(0.0)) * 1000.0).round() / 1000.0,
        brain: normalize_brain_label(req.brain.as_deref()),
        platform: session.spec.platform.as_str().to_string(),
        encoder: session.encoder.as_str().to_string(),
        drops: session.drops,
    };

    if let Err(err) = append_broadcast_log(&adk_path, &entry) {
        log::warn!("[broadcast] failed to append broadcast log: {err}");
    }

    let idle_snap = BroadcastStatusSnapshot {
        state: "idle".to_string(),
        started_at: None,
        elapsed_seconds: 0,
        platform: Some(entry.platform),
        encoder: Some(entry.encoder),
        drops: entry.drops,
        restart_count: session.restart_count,
        last_error: None,
    };

    if let Ok(mut mgr) = broadcast_manager().lock() {
        mgr.last_snapshot = Some(idle_snap.clone());
    }

    let _ = app.emit(BROADCAST_STATUS_EVENT, idle_snap.clone());
    Ok(idle_snap)
}

#[tauri::command]
pub fn broadcast_status() -> Result<BroadcastStatusSnapshot, String> {
    let mgr = broadcast_manager()
        .lock()
        .map_err(|_| "방송 상태 잠금 오류".to_string())?;
    Ok(mgr.snapshot())
}

#[tauri::command]
pub fn broadcast_push_audio(pcm_base64: String) -> Result<(), String> {
    if pcm_base64.is_empty() {
        return Ok(());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(pcm_base64.trim())
        .map_err(|e| format!("PCM base64 디코딩 실패: {e}"))?;
    if bytes.is_empty() {
        return Ok(());
    }
    let mut mgr = broadcast_manager()
        .lock()
        .map_err(|_| "방송 상태 잠금 오류".to_string())?;
    if let Some(ref mut session) = mgr.active {
        if let Some(ref mut stdin) = session.stdin {
            let _ = stdin.write_all(&bytes);
        }
    }
    Ok(())
}

/// UTC now as RFC 3339 (`2026-11-06T02:49:01Z`) without pulling in a time crate.
fn utc_now_rfc3339() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    format_rfc3339_utc(secs)
}

fn format_rfc3339_utc(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        (rem % 3_600) / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn formats_rfc3339_utc_without_time_crate() {
        assert_eq!(super::format_rfc3339_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(super::format_rfc3339_utc(1_793_932_008), "2026-11-06T02:26:48Z");
        assert_eq!(super::format_rfc3339_utc(951_782_400), "2000-02-29T00:00:00Z");
    }

    use super::*;

    #[test]
    fn platform_presets_match_keyframe_and_bitrate_table() {
        let capture = WindowsGdiGrabCapture;

        // YouTube: 2s (-g 60 @ 30fps), 6M
        let yt_spec = FfmpegStreamSpec {
            platform: BroadcastPlatform::Youtube,
            server_url: String::new(),
            stream_key: "yt-secret-key-123".to_string(),
            resolution: BroadcastResolution::P1080Fps30,
            encoder: VideoEncoder::H264Nvenc,
            output_file: None,
        };
        let yt_args = build_ffmpeg_args(&yt_spec, &capture).expect("youtube args");
        assert!(yt_args.windows(2).any(|w| w == ["-g", "60"]));
        assert!(yt_args.windows(2).any(|w| w == ["-b:v", "6M"]));
        assert!(yt_args.windows(2).any(|w| w == ["-c:v", "h264_nvenc"]));
        assert!(yt_args.windows(2).any(|w| w == ["-vf", "scale=1920:1080"]));
        assert!(yt_args.windows(2).any(|w| w == ["-c:a", "aac"]));
        assert!(yt_args.windows(2).any(|w| w == ["-b:a", "160k"]));
        assert!(yt_args.windows(2).any(|w| w == ["-ar", "48000"]));
        assert!(yt_args.windows(2).any(|w| w == ["-ac", "2"]));

        // Chzzk: 1s (-g 30 @ 30fps), 8M, 720p30 + libx264 fallback
        let chzzk_spec = FfmpegStreamSpec {
            platform: BroadcastPlatform::Chzzk,
            server_url: String::new(),
            stream_key: "chzzk-secret-key-456".to_string(),
            resolution: BroadcastResolution::P720Fps30,
            encoder: VideoEncoder::Libx264,
            output_file: None,
        };
        let chzzk_args = build_ffmpeg_args(&chzzk_spec, &capture).expect("chzzk args");
        assert!(chzzk_args.windows(2).any(|w| w == ["-g", "30"]));
        assert!(chzzk_args.windows(2).any(|w| w == ["-b:v", "8M"]));
        assert!(chzzk_args.windows(2).any(|w| w == ["-c:v", "libx264"]));
        assert!(chzzk_args.windows(2).any(|w| w == ["-preset", "veryfast"]));
        assert!(chzzk_args.windows(2).any(|w| w == ["-vf", "scale=1280:720"]));

        // Twitch & SOOP: 2s (-g 60 @ 30fps), 6M
        assert_eq!(BroadcastPlatform::Twitch.gop_size(30), 60);
        assert_eq!(BroadcastPlatform::Twitch.default_bitrate(), "6M");
        assert_eq!(BroadcastPlatform::Soop.gop_size(30), 60);
        assert_eq!(BroadcastPlatform::Soop.default_bitrate(), "6M");
    }

    #[test]
    fn stream_key_is_always_redacted_with_asterisks() {
        let capture = WindowsGdiGrabCapture;
        let secret = "fake-key-123";
        let spec = FfmpegStreamSpec {
            platform: BroadcastPlatform::Twitch,
            server_url: "rtmps://live.twitch.tv/app".to_string(),
            stream_key: secret.to_string(),
            resolution: BroadcastResolution::P1080Fps30,
            encoder: VideoEncoder::H264Nvenc,
            output_file: None,
        };
        let raw_args = build_ffmpeg_args(&spec, &capture).expect("raw args");
        let redacted = redact_ffmpeg_args(&raw_args, &spec.stream_key);

        for arg in &redacted {
            assert!(
                !arg.contains(secret),
                "stream key leaked in redacted arg: {arg}"
            );
        }
        assert_eq!(
            redacted.last().map(String::as_str),
            Some("rtmps://live.twitch.tv/app/***")
        );
    }

    #[test]
    fn linux_stub_capture_returns_expected_placeholder_error() {
        let stub = LinuxStubCapture;
        let err = stub
            .video_input_args(30)
            .expect_err("linux stub must error");
        assert_eq!(err, "미구현 — 실측 대기");
    }

    #[test]
    fn resolve_ffmpeg_path_prefers_sidecar_then_env_then_path() {
        let tmp = std::env::temp_dir().join(format!("naia-ffmpeg-resolve-{}", std::process::id()));
        let sidecar_dir = tmp.join("app");
        let path_dir = tmp.join("path_bin");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(sidecar_dir.join("binaries")).expect("mkdir sidecar");
        fs::create_dir_all(&path_dir).expect("mkdir path_bin");

        let path_ffmpeg = path_dir.join(if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        });
        fs::write(&path_ffmpeg, b"#!/bin/sh\n").expect("write path ffmpeg");

        // 1. Only PATH available -> picks PATH binary
        let resolved_from_path =
            resolve_ffmpeg_path_from(&[&sidecar_dir], None, Some(path_dir.as_os_str()));
        assert_eq!(resolved_from_path, path_ffmpeg);

        // 2. NAIA_FFMPEG_PATH set -> overrides PATH
        let env_val = OsString::from("/custom/env/ffmpeg");
        let resolved_from_env = resolve_ffmpeg_path_from(
            &[&sidecar_dir],
            Some(env_val.as_os_str()),
            Some(path_dir.as_os_str()),
        );
        assert_eq!(resolved_from_env, PathBuf::from("/custom/env/ffmpeg"));

        // 3. Dev placeholder in sidecar_dir is ignored
        let sidecar_bin = sidecar_dir.join("binaries/ffmpeg");
        fs::write(&sidecar_bin, DEV_PLACEHOLDER_PREFIX).expect("write placeholder");
        let resolved_ignoring_placeholder = resolve_ffmpeg_path_from(
            &[&sidecar_dir],
            Some(env_val.as_os_str()),
            Some(path_dir.as_os_str()),
        );
        assert_eq!(
            resolved_ignoring_placeholder,
            PathBuf::from("/custom/env/ffmpeg")
        );

        // 4. Real sidecar binary next to app -> highest priority (overrides NAIA_FFMPEG_PATH and PATH)
        fs::write(&sidecar_bin, b"real-static-ffmpeg-binary").expect("write real sidecar");
        let resolved_from_sidecar = resolve_ffmpeg_path_from(
            &[&sidecar_dir],
            Some(env_val.as_os_str()),
            Some(path_dir.as_os_str()),
        );
        assert_eq!(resolved_from_sidecar, sidecar_bin);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn append_broadcast_log_writes_single_jsonl_record() {
        let tmp = std::env::temp_dir().join(format!("naia-broadcast-log-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);

        let entry = BroadcastLogEntry {
            start: "2026-11-06T01:00:00Z".to_string(),
            end: "2026-11-06T01:30:00Z".to_string(),
            minutes: 30.0,
            answers: 12,
            credits_used: 45.5,
            brain: "both".to_string(),
            platform: "youtube".to_string(),
            encoder: "h264_nvenc".to_string(),
            drops: 0,
        };

        let log_path = append_broadcast_log(&tmp, &entry).expect("append log");
        assert!(log_path.ends_with("data-private/broadcast/log.jsonl"));

        let content = fs::read_to_string(&log_path).expect("read log.jsonl");
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 1);

        let parsed: serde_json::Value = serde_json::from_str(lines[0]).expect("valid json line");
        assert_eq!(parsed["start"], "2026-11-06T01:00:00Z");
        assert_eq!(parsed["end"], "2026-11-06T01:30:00Z");
        assert_eq!(parsed["minutes"], 30.0);
        assert_eq!(parsed["answers"], 12);
        assert_eq!(parsed["credits_used"], 45.5);
        assert_eq!(parsed["brain"], "both");
        assert_eq!(parsed["platform"], "youtube");
        assert_eq!(parsed["encoder"], "h264_nvenc");
        assert_eq!(parsed["drops"], 0);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn pack_f32_stereo_to_s16le_interleaves_and_clamps_samples() {
        let left = [0.0_f32, 1.0, -1.0, 2.5];
        let right = [0.0_f32, -1.0, 1.0, -2.5];
        let bytes = pack_f32_stereo_to_s16le(&left, &right);
        assert_eq!(bytes.len(), 16);

        let samples: Vec<i16> = bytes
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
            .collect();
        assert_eq!(
            samples,
            vec![0, 0, 32767, -32767, -32767, 32767, 32767, -32767]
        );
    }
}
