use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{OsStr, OsString};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

pub const BROADCAST_STATUS_EVENT: &str = "broadcast-status-changed";
pub const MAX_AUTO_RESTARTS: u32 = 3;
pub const AUTO_RESTART_DELAY: Duration = Duration::from_secs(10);
pub const NAIA_BROADCAST_SINK_NAME: &str = "naia-broadcast-mix";
pub const NAIA_BROADCAST_MONITOR_DEVICE: &str = "naia-broadcast-mix.monitor";
pub const PIPEWIRE_RESCAN_INTERVAL: Duration = Duration::from_secs(2);
pub const PORTAL_SOURCE_TYPE_WINDOW: u32 = 2;
pub const PORTAL_CURSOR_MODE_HIDDEN: u32 = 1;
pub const PORTAL_PERSIST_MODE_UNTIL_REVOKED: u32 = 2;
const DEV_PLACEHOLDER_PREFIX: &[u8] = b"#!naia-ffmpeg-dev-placeholder";

/// Swappable screen capture and pipeline source (Items 3 & 4).
/// Windows uses `ffmpeg` with `gdigrab` (`title=Naia`).
/// Linux uses XDG Desktop Portal ScreenCast (`persist_mode=2`, `restore_token`) -> PipeWire node
/// and streams via GStreamer (`pipewiresrc` + `pulsesrc device=naia-broadcast-mix.monitor`).
pub trait ScreenCaptureSource: Send + Sync {
    fn name(&self) -> &'static str;
    fn video_input_args(&self, fps: u32) -> Result<Vec<String>, String>;
    fn uses_gstreamer_pipeline(&self) -> bool {
        false
    }
    fn pipewire_fd(&self) -> Option<i32> {
        None
    }
    fn audio_monitor_device(&self) -> &'static str {
        NAIA_BROADCAST_MONITOR_DEVICE
    }
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

/// Linux Wayland Portal ScreenCast -> PipeWire capture source (Item 4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinuxPortalPipeWireCapture {
    pub pipewire_fd: Option<i32>,
    pub pipewire_node_id: Option<u32>,
}

impl Default for LinuxPortalPipeWireCapture {
    fn default() -> Self {
        Self {
            pipewire_fd: None,
            pipewire_node_id: None,
        }
    }
}

impl LinuxPortalPipeWireCapture {
    pub fn new(pipewire_fd: Option<i32>, pipewire_node_id: u32) -> Self {
        Self {
            pipewire_fd,
            pipewire_node_id: Some(pipewire_node_id),
        }
    }
}

impl ScreenCaptureSource for LinuxPortalPipeWireCapture {
    fn name(&self) -> &'static str {
        "portal-pipewire-gstreamer"
    }

    fn video_input_args(&self, _fps: u32) -> Result<Vec<String>, String> {
        let Some(node_id) = self.pipewire_node_id else {
            return Err(
                "포털 ScreenCast 창 선택(PipeWire node_id)이 필요합니다.".to_string(),
            );
        };
        let mut args = vec!["pipewiresrc".to_string()];
        if let Some(fd) = self.pipewire_fd.filter(|&fd| fd >= 0) {
            args.push(format!("fd={fd}"));
        }
        args.push(format!("path={node_id}"));
        args.push("do-timestamp=true".to_string());
        Ok(args)
    }

    fn uses_gstreamer_pipeline(&self) -> bool {
        true
    }

    fn pipewire_fd(&self) -> Option<i32> {
        self.pipewire_fd.filter(|&fd| fd >= 0)
    }
}

pub fn default_screen_capture_source() -> Box<dyn ScreenCaptureSource> {
    #[cfg(target_os = "windows")]
    {
        Box::new(WindowsGdiGrabCapture)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Box::new(LinuxPortalPipeWireCapture::default())
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

    pub fn default_bitrate_kbps(self) -> u32 {
        match self {
            Self::Youtube | Self::Twitch | Self::Soop => 6_000,
            Self::Chzzk => 8_000,
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

    pub fn gstreamer_element_name(self) -> &'static str {
        match self {
            Self::H264Nvenc => "nvh264enc",
            Self::Libx264 => "x264enc",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GstAudioEncoder {
    AvencAac,
    Voaacenc,
}

impl GstAudioEncoder {
    pub fn element_name(self) -> &'static str {
        match self {
            Self::AvencAac => "avenc_aac",
            Self::Voaacenc => "voaacenc",
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

/// Build `ffmpeg` CLI arguments for screen video + stdin PCM audio -> RTMP(S) / FLV file (Windows path).
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

    // 2. Audio input from stdin (48kHz stereo s16le PCM)
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

/// Build GStreamer pipeline arguments for Linux Wayland (Item 4):
/// `pipewiresrc fd=… path=…` + `pulsesrc device=naia-broadcast-mix.monitor`
/// -> `nvh264enc` (or `x264enc`) + `avenc_aac` (or `voaacenc`) -> `flvmux` -> `rtmp2sink` (or `filesink`).
pub fn build_gstreamer_pipeline_args(
    spec: &FfmpegStreamSpec,
    capture: &dyn ScreenCaptureSource,
    audio_encoder: GstAudioEncoder,
) -> Result<Vec<String>, String> {
    let fps = spec.resolution.fps();
    let (width, height) = spec.resolution.dimensions();
    let gop = spec.platform.gop_size(fps);
    let bitrate_kbps = spec.platform.default_bitrate_kbps();
    let target = spec.destination_target()?;

    let mut args = vec!["-q".to_string(), "-e".to_string()];

    // 1. Video branch: pipewiresrc fd=... path=... -> scale/rate -> nvh264enc/x264enc -> h264parse -> flvmux0.
    let video_in = capture.video_input_args(fps)?;
    args.extend(video_in);
    args.extend([
        "!".to_string(),
        "videoconvert".to_string(),
        "!".to_string(),
        "videoscale".to_string(),
        "!".to_string(),
        "videorate".to_string(),
        "!".to_string(),
        format!("video/x-raw,width={width},height={height},framerate={fps}/1"),
        "!".to_string(),
        "videoconvert".to_string(),
        "!".to_string(),
    ]);

    match spec.encoder {
        VideoEncoder::H264Nvenc => {
            args.extend([
                "nvh264enc".to_string(),
                format!("bitrate={bitrate_kbps}"),
                format!("gop-size={gop}"),
            ]);
        }
        VideoEncoder::Libx264 => {
            args.extend([
                "x264enc".to_string(),
                format!("bitrate={bitrate_kbps}"),
                format!("key-int-max={gop}"),
                "speed-preset=veryfast".to_string(),
                "tune=zerolatency".to_string(),
            ]);
        }
    }

    args.extend([
        "!".to_string(),
        "h264parse".to_string(),
        "!".to_string(),
        "flvmux0.".to_string(),
    ]);

    // 2. Audio branch: pulsesrc device=naia-broadcast-mix.monitor -> 48kHz stereo -> avenc_aac/voaacenc -> aacparse -> flvmux0.
    args.extend([
        "pulsesrc".to_string(),
        format!("device={}", capture.audio_monitor_device()),
        "do-timestamp=true".to_string(),
        "!".to_string(),
        "audioconvert".to_string(),
        "!".to_string(),
        "audioresample".to_string(),
        "!".to_string(),
        "audio/x-raw,rate=48000,channels=2".to_string(),
        "!".to_string(),
        audio_encoder.element_name().to_string(),
        "bitrate=160000".to_string(),
        "!".to_string(),
        "aacparse".to_string(),
        "!".to_string(),
        "flvmux0.".to_string(),
    ]);

    // 3. FLV muxer -> rtmp2sink (or filesink when output_file is set)
    args.extend([
        "flvmux".to_string(),
        "name=flvmux0".to_string(),
        "streamable=true".to_string(),
        "!".to_string(),
        "queue".to_string(),
        "!".to_string(),
    ]);

    if spec.output_file.is_some() {
        args.extend(["filesink".to_string(), format!("location={target}")]);
    } else {
        args.extend(["rtmp2sink".to_string(), format!("location={target}")]);
    }

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

    // Defense-in-depth: if an rtmp:// or rtmps:// URL (including GStreamer `location=rtmp...`)
    // has a stream key segment at the end, mask it with `***`.
    let has_rtmp_scheme = masked.starts_with("rtmp://")
        || masked.starts_with("rtmps://")
        || masked.starts_with("location=rtmp://")
        || masked.starts_with("location=rtmps://");
    if has_rtmp_scheme && !masked.ends_with("/***") {
        let scheme_end = masked.find("://").map(|idx| idx + 3).unwrap_or(0);
        let after_scheme = &masked[scheme_end..];
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

/// Encoder stderr goes to this file (truncated on each spawn) so an exit can say why.
fn encoder_log_path() -> PathBuf {
    std::env::temp_dir().join("naia-broadcast-encoder.log")
}

fn encoder_stderr() -> Stdio {
    fs::File::create(encoder_log_path())
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null())
}

/// Last few non-empty encoder stderr lines, stream key masked, for logs and the UI.
pub fn encoder_log_tail(stream_key: &str) -> Option<String> {
    let text = fs::read_to_string(encoder_log_path()).ok()?;
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let tail = lines[lines.len().saturating_sub(3)..]
        .iter()
        .map(|line| {
            line.split_whitespace()
                .map(|word| redact_stream_key(word, stream_key))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>()
        .join(" / ");
    if tail.is_empty() {
        return None;
    }
    Some(tail.chars().take(400).collect())
}

/// Redact stream key across all `ffmpeg` / `gst-launch-1.0` CLI arguments (`***`).
pub fn redact_ffmpeg_args(args: &[String], stream_key: &str) -> Vec<String> {
    args.iter()
        .map(|arg| redact_stream_key(arg, stream_key))
        .collect()
}

/// Pure helper: given a root PID and a `(pid, ppid)` table, compute the full transitive
/// set of PIDs in the process tree (root + all children/descendants such as `WebKitWebProcess`).
pub fn collect_descendant_pids(root_pid: u32, proc_table: &[(u32, u32)]) -> BTreeSet<u32> {
    let mut tree = BTreeSet::new();
    tree.insert(root_pid);
    let mut changed = true;
    while changed {
        changed = false;
        for &(pid, ppid) in proc_table {
            if tree.contains(&ppid) && tree.insert(pid) {
                changed = true;
            }
        }
    }
    tree
}

/// Read `/proc` on Linux to collect all PIDs in the Naia process tree (`root_pid` + descendants).
pub fn collect_process_tree_pids(root_pid: u32) -> BTreeSet<u32> {
    let mut table = Vec::new();
    if let Ok(entries) = fs::read_dir("/proc") {
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            let Some(pid_str) = file_name.to_str() else {
                continue;
            };
            let Ok(pid) = pid_str.parse::<u32>() else {
                continue;
            };
            let status_path = entry.path().join("status");
            let Ok(status_text) = fs::read_to_string(status_path) else {
                continue;
            };
            let mut ppid: Option<u32> = None;
            for line in status_text.lines() {
                if let Some(rest) = line.strip_prefix("PPid:") {
                    ppid = rest.trim().parse::<u32>().ok();
                    break;
                }
            }
            if let Some(parent_pid) = ppid {
                table.push((pid, parent_pid));
            }
        }
    }
    collect_descendant_pids(root_pid, &table)
}

fn json_u32(val: Option<&serde_json::Value>) -> Option<u32> {
    let v = val?;
    if let Some(n) = v.as_u64() {
        u32::try_from(n).ok()
    } else if let Some(s) = v.as_str() {
        s.trim().parse::<u32>().ok()
    } else {
        None
    }
}

/// Pure planner for Item 3 (Linux PipeWire audio):
/// Given `pw-dump` JSON output, the Naia process tree PIDs, and the virtual sink name (`naia-broadcast-mix`),
/// returns the list of `(output_port_id, sink_input_port_id)` pairs to connect with `pw-link`,
/// skipping any pair that is already linked in `PipeWire:Interface:Link`.
pub fn plan_pipewire_broadcast_links(
    pw_dump_json: &str,
    target_pids: &BTreeSet<u32>,
    sink_name: &str,
) -> Result<Vec<(u32, u32)>, String> {
    let items: Vec<serde_json::Value> = serde_json::from_str(pw_dump_json)
        .map_err(|e| format!("pw-dump JSON 파싱 실패: {e}"))?;

    // 1. Map Client ID -> process PID (`application.process.id` or `pipewire.sec.pid`).
    let mut client_pids: BTreeMap<u32, u32> = BTreeMap::new();
    for obj in &items {
        if obj.get("type").and_then(|v| v.as_str()) != Some("PipeWire:Interface:Client") {
            continue;
        }
        let Some(client_id) = json_u32(obj.get("id")) else {
            continue;
        };
        let props = obj.get("info").and_then(|i| i.get("props"));
        let pid = json_u32(props.and_then(|p| p.get("application.process.id")))
            .or_else(|| json_u32(props.and_then(|p| p.get("pipewire.sec.pid"))));
        if let Some(p) = pid {
            client_pids.insert(client_id, p);
        }
    }

    // 2. Locate the virtual sink node (`naia-broadcast-mix`) and matching `Stream/Output/Audio` nodes.
    let mut sink_node_id: Option<u32> = None;
    let mut stream_node_ids: BTreeSet<u32> = BTreeSet::new();

    for obj in &items {
        if obj.get("type").and_then(|v| v.as_str()) != Some("PipeWire:Interface:Node") {
            continue;
        }
        let Some(node_id) = json_u32(obj.get("id")) else {
            continue;
        };
        let Some(props) = obj.get("info").and_then(|i| i.get("props")) else {
            continue;
        };
        let node_name = props.get("node.name").and_then(|v| v.as_str()).unwrap_or("");
        let media_class = props
            .get("media.class")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if node_name == sink_name && media_class == "Audio/Sink" {
            sink_node_id = Some(node_id);
            continue;
        }

        if media_class == "Stream/Output/Audio" {
            let direct_pid = json_u32(props.get("application.process.id"))
                .or_else(|| json_u32(props.get("pipewire.sec.pid")));
            let client_pid = json_u32(props.get("client.id"))
                .and_then(|cid| client_pids.get(&cid).copied());
            if let Some(pid) = direct_pid.or(client_pid) {
                if target_pids.contains(&pid) {
                    stream_node_ids.insert(node_id);
                }
            }
        }
    }

    let Some(sink_id) = sink_node_id else {
        return Err(format!("가상 싱크 '{sink_name}' 노드를 찾지 못했습니다."));
    };

    // 3. Collect input ports of `naia-broadcast-mix` and output ports of matching audio streams.
    let mut sink_fl_port: Option<u32> = None;
    let mut sink_fr_port: Option<u32> = None;
    let mut stream_ports: BTreeMap<u32, (Option<u32>, Option<u32>, Vec<u32>)> = BTreeMap::new();

    for obj in &items {
        if obj.get("type").and_then(|v| v.as_str()) != Some("PipeWire:Interface:Port") {
            continue;
        }
        let Some(port_id) = json_u32(obj.get("id")) else {
            continue;
        };
        let Some(info) = obj.get("info") else {
            continue;
        };
        let direction = info.get("direction").and_then(|v| v.as_str()).unwrap_or("");
        let Some(props) = info.get("props") else {
            continue;
        };
        let Some(node_id) = json_u32(props.get("node.id")) else {
            continue;
        };
        let channel = props
            .get("audio.channel")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let port_name = props
            .get("port.name")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if node_id == sink_id && direction == "input" {
            if channel.eq_ignore_ascii_case("FL") || port_name.ends_with("_FL") {
                sink_fl_port = Some(port_id);
            } else if channel.eq_ignore_ascii_case("FR") || port_name.ends_with("_FR") {
                sink_fr_port = Some(port_id);
            }
        } else if stream_node_ids.contains(&node_id) && direction == "output" {
            let entry = stream_ports.entry(node_id).or_insert((None, None, Vec::new()));
            if channel.eq_ignore_ascii_case("FL") || port_name.ends_with("_FL") {
                entry.0 = Some(port_id);
            } else if channel.eq_ignore_ascii_case("FR") || port_name.ends_with("_FR") {
                entry.1 = Some(port_id);
            } else {
                entry.2.push(port_id);
            }
        }
    }

    let (Some(in_fl), Some(in_fr)) = (sink_fl_port, sink_fr_port) else {
        return Err(format!(
            "가상 싱크 '{sink_name}'의 입력 포트(FL/FR)를 찾지 못했습니다."
        ));
    };

    // 4. Collect existing links so we never duplicate an active link.
    let mut existing_links: BTreeSet<(u32, u32)> = BTreeSet::new();
    for obj in &items {
        if obj.get("type").and_then(|v| v.as_str()) != Some("PipeWire:Interface:Link") {
            continue;
        }
        let Some(info) = obj.get("info") else {
            continue;
        };
        let out_port = json_u32(info.get("output-port-id"))
            .or_else(|| json_u32(info.get("props").and_then(|p| p.get("link.output.port"))));
        let in_port = json_u32(info.get("input-port-id"))
            .or_else(|| json_u32(info.get("props").and_then(|p| p.get("link.input.port"))));
        if let (Some(o), Some(i)) = (out_port, in_port) {
            existing_links.insert((o, i));
        }
    }

    // 5. Plan new links for each matching stream node.
    let mut planned: Vec<(u32, u32)> = Vec::new();
    for (_node_id, (fl_opt, fr_opt, other_ports)) in stream_ports {
        match (fl_opt, fr_opt) {
            (Some(out_fl), Some(out_fr)) => {
                if !existing_links.contains(&(out_fl, in_fl)) {
                    planned.push((out_fl, in_fl));
                }
                if !existing_links.contains(&(out_fr, in_fr)) {
                    planned.push((out_fr, in_fr));
                }
            }
            (Some(mono), None) | (None, Some(mono)) => {
                if !existing_links.contains(&(mono, in_fl)) {
                    planned.push((mono, in_fl));
                }
                if !existing_links.contains(&(mono, in_fr)) {
                    planned.push((mono, in_fr));
                }
            }
            (None, None) => {
                if let Some(&first_port) = other_ports.first() {
                    if !existing_links.contains(&(first_port, in_fl)) {
                        planned.push((first_port, in_fl));
                    }
                    let second_port = other_ports.get(1).copied().unwrap_or(first_port);
                    if !existing_links.contains(&(second_port, in_fr)) {
                        planned.push((second_port, in_fr));
                    }
                }
            }
        }
    }

    Ok(planned)
}

/// Create the PipeWire virtual null audio sink (`naia-broadcast-mix`) using `pw-cli` (Item 3).
pub fn create_pipewire_broadcast_sink(sink_name: &str) -> Result<(), String> {
    let _ = Command::new("pw-cli")
        .args(["destroy", sink_name])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    let props = format!(
        "{{ factory.name=support.null-audio-sink node.name={sink_name} node.description=\"Naia Broadcast Mix\" media.class=Audio/Sink object.linger=true audio.position=[FL FR] }}"
    );
    let output = Command::new("pw-cli")
        .args(["create-node", "adapter", &props])
        .output()
        .map_err(|e| format!("pw-cli 가상 싱크 생성 실행 실패: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("pw-cli 가상 싱크 생성 실패: {}", stderr.trim()));
    }

    // Wait up to 1.5s for the virtual sink input ports to appear in pw-dump.
    let deadline = Instant::now() + Duration::from_millis(1500);
    let empty_pids = BTreeSet::new();
    while Instant::now() < deadline {
        if let Ok(dump) = Command::new("pw-dump").output() {
            if dump.status.success() {
                let text = String::from_utf8_lossy(&dump.stdout);
                if plan_pipewire_broadcast_links(&text, &empty_pids, sink_name).is_ok() {
                    return Ok(());
                }
            }
        }
        std::thread::sleep(Duration::from_millis(75));
    }

    Ok(())
}

/// Find `Stream/Output/Audio` nodes belonging to `target_pids` and connect their output ports
/// to `sink_name` input ports while keeping speaker links intact (Item 3).
pub fn sync_pipewire_broadcast_links_once(
    target_pids: &BTreeSet<u32>,
    sink_name: &str,
) -> Result<Vec<(u32, u32)>, String> {
    let output = Command::new("pw-dump")
        .output()
        .map_err(|e| format!("pw-dump 실행 실패: {e}"))?;
    if !output.status.success() {
        return Err("pw-dump 상태 조회 실패".to_string());
    }
    let json_text = String::from_utf8_lossy(&output.stdout);
    let pairs = plan_pipewire_broadcast_links(&json_text, target_pids, sink_name)?;
    let mut connected = Vec::new();
    for (out_port, in_port) in pairs {
        let status = Command::new("pw-link")
            .args([out_port.to_string(), in_port.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if let Ok(s) = status {
            if s.success() {
                connected.push((out_port, in_port));
            }
        }
    }
    Ok(connected)
}

/// Remove links created for the broadcast mix sink and destroy the virtual sink (Item 3).
pub fn cleanup_pipewire_broadcast_sink(sink_name: &str, created_links: &[(u32, u32)]) {
    for &(out_port, in_port) in created_links {
        let _ = Command::new("pw-link")
            .args(["-d", &out_port.to_string(), &in_port.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = Command::new("pw-cli")
        .args(["destroy", sink_name])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Read persisted Portal ScreenCast `restore_token` from `<adk_path>/naia-settings/ui-config.json` (Item 4).
pub fn load_broadcast_restore_token(adk_path: &Path) -> Option<String> {
    for filename in ["ui-config.json", "config.json"] {
        let path = adk_path.join("naia-settings").join(filename);
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        if let Some(token) = val
            .get("broadcastRestoreToken")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(token.to_string());
        }
    }
    None
}

/// Persist Portal ScreenCast `restore_token` into `<adk_path>/naia-settings/ui-config.json` (Item 4).
pub fn save_broadcast_restore_token(adk_path: &Path, restore_token: &str) -> Result<PathBuf, String> {
    let trimmed = restore_token.trim();
    let settings_dir = adk_path.join("naia-settings");
    fs::create_dir_all(&settings_dir)
        .map_err(|e| format!("naia-settings 폴더 생성 실패: {e}"))?;
    let ui_config_path = settings_dir.join("ui-config.json");

    let mut root_obj = if let Ok(existing) = fs::read_to_string(&ui_config_path) {
        serde_json::from_str::<serde_json::Value>(&existing)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    } else {
        serde_json::Map::new()
    };

    if trimmed.is_empty() {
        root_obj.remove("broadcastRestoreToken");
    } else {
        root_obj.insert(
            "broadcastRestoreToken".to_string(),
            serde_json::Value::String(trimmed.to_string()),
        );
    }

    let serialized = serde_json::to_string_pretty(&serde_json::Value::Object(root_obj))
        .map_err(|e| format!("ui-config.json 직렬화 실패: {e}"))?;
    fs::write(&ui_config_path, format!("{serialized}\n"))
        .map_err(|e| format!("ui-config.json 저장 실패: {e}"))?;
    Ok(ui_config_path)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortalSelectSourcesConfig {
    pub handle_token: String,
    pub types: u32,
    pub multiple: bool,
    pub cursor_mode: u32,
    pub persist_mode: u32,
    pub restore_token: Option<String>,
}

/// Build the exact `SelectSources` options dictionary contract for XDG Desktop Portal ScreenCast:
/// single window (`types=2`, `multiple=false`), hidden cursor (`cursor_mode=1`),
/// `persist_mode=2` (persist until revoked), and optional `restore_token` so approval is only needed once.
pub fn build_portal_select_sources_config(
    handle_token: &str,
    restore_token: Option<&str>,
) -> PortalSelectSourcesConfig {
    PortalSelectSourcesConfig {
        handle_token: handle_token.to_string(),
        types: PORTAL_SOURCE_TYPE_WINDOW,
        multiple: false,
        cursor_mode: PORTAL_CURSOR_MODE_HIDDEN,
        persist_mode: PORTAL_PERSIST_MODE_UNTIL_REVOKED,
        restore_token: restore_token
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned),
    }
}

#[derive(Debug)]
pub struct PortalScreenCastSelection {
    pub node_id: u32,
    pub pipewire_fd: Option<i32>,
    pub restore_token: Option<String>,
    #[cfg(target_os = "linux")]
    pub dbus_connection: Option<gtk::gio::DBusConnection>,
}

#[cfg(target_os = "linux")]
fn portal_sender_token(conn: &gtk::gio::DBusConnection) -> Result<String, String> {
    let unique = conn
        .unique_name()
        .ok_or_else(|| "D-Bus 세션 버스 unique_name을 가져오지 못했습니다.".to_string())?;
    Ok(unique
        .as_str()
        .trim_start_matches(':')
        .replace('.', "_"))
}

#[cfg(target_os = "linux")]
fn next_portal_token(prefix: &str) -> String {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{}_{}", std::process::id(), n)
}

#[cfg(target_os = "linux")]
fn call_portal_request(
    conn: &gtk::gio::DBusConnection,
    method: &str,
    parameters: &gtk::glib::Variant,
    handle_token: &str,
    timeout: Duration,
) -> Result<(u32, gtk::glib::Variant), String> {
    use gtk::glib;
    let sender = portal_sender_token(conn)?;
    let expected_request_path =
        format!("/org/freedesktop/portal/desktop/request/{sender}/{handle_token}");

    let (tx, rx) = std::sync::mpsc::channel::<(u32, glib::Variant)>();
    let tx_mutex = Arc::new(Mutex::new(Some(tx)));
    let tx_clone = Arc::clone(&tx_mutex);

    let sub_id = conn.signal_subscribe(
        Some("org.freedesktop.portal.Desktop"),
        Some("org.freedesktop.portal.Request"),
        Some("Response"),
        Some(&expected_request_path),
        None,
        gtk::gio::DBusSignalFlags::NO_MATCH_RULE,
        move |_conn, _sender, _path, _iface, _signal, params| {
            if params.n_children() >= 2 {
                let code = params.child_value(0).get::<u32>().unwrap_or(2);
                let results = params.child_value(1);
                if let Ok(mut guard) = tx_clone.lock() {
                    if let Some(sender_ch) = guard.take() {
                        let _ = sender_ch.send((code, results));
                    }
                }
            }
        },
    );

    let call_res = conn.call_sync(
        Some("org.freedesktop.portal.Desktop"),
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.ScreenCast",
        method,
        Some(parameters),
        Some(glib::VariantTy::new("(o)").unwrap()),
        gtk::gio::DBusCallFlags::NONE,
        30_000,
        gtk::gio::Cancellable::NONE,
    );

    if let Err(err) = call_res {
        conn.signal_unsubscribe(sub_id);
        return Err(format!("ScreenCast.{method} D-Bus 호출 실패: {err}"));
    }

    let main_ctx = glib::MainContext::default();
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(reply) = rx.try_recv() {
            conn.signal_unsubscribe(sub_id);
            return Ok(reply);
        }
        if Instant::now() >= deadline {
            conn.signal_unsubscribe(sub_id);
            // Close the pending request so the portal dialog does not linger with no one waiting on it.
            let _ = conn.call_sync(
                Some("org.freedesktop.portal.Desktop"),
                &expected_request_path,
                "org.freedesktop.portal.Request",
                "Close",
                None,
                None,
                gtk::gio::DBusCallFlags::NONE,
                5_000,
                gtk::gio::Cancellable::NONE,
            );
            return Err(format!("ScreenCast.{method} 포털 응답 대기 시간 초과"));
        }
        while main_ctx.pending() {
            main_ctx.iteration(false);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Request a single-window PipeWire stream from `org.freedesktop.portal.ScreenCast` on Linux (Item 4).
/// Uses `persist_mode=2` and passes any saved `restore_token` so interactive approval is only required once.
pub fn request_portal_screencast_window(
    restore_token: Option<&str>,
) -> Result<PortalScreenCastSelection, String> {
    if let Ok(env_node) = std::env::var("NAIA_LINUX_PIPEWIRE_NODE_ID") {
        if let Ok(node_id) = env_node.trim().parse::<u32>() {
            let pipewire_fd = std::env::var("NAIA_LINUX_PIPEWIRE_FD")
                .ok()
                .and_then(|s| s.trim().parse::<i32>().ok());
            return Ok(PortalScreenCastSelection {
                node_id,
                pipewire_fd,
                restore_token: restore_token.map(ToOwned::to_owned),
                #[cfg(target_os = "linux")]
                dbus_connection: None,
            });
        }
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = restore_token;
        Err("포털 ScreenCast는 리눅스에서만 지원됩니다.".to_string())
    }

    #[cfg(target_os = "linux")]
    {
        use gtk::glib::{self, ToVariant};
        use gtk::prelude::UnixFDListExtManual;

        let conn = gtk::gio::bus_get_sync(gtk::gio::BusType::Session, gtk::gio::Cancellable::NONE)
            .map_err(|e| format!("D-Bus 세션 버스 연결 실패: {e}"))?;

        // 1. CreateSession
        let create_token = next_portal_token("naia_sc_create");
        let session_token = next_portal_token("naia_sc_sess");
        let mut create_opts: HashMap<&str, glib::Variant> = HashMap::new();
        create_opts.insert("handle_token", create_token.to_variant());
        create_opts.insert("session_handle_token", session_token.to_variant());
        let create_params = glib::Variant::tuple_from_iter([create_opts.to_variant()]);

        let (create_code, create_results) = call_portal_request(
            &conn,
            "CreateSession",
            &create_params,
            &create_token,
            Duration::from_secs(30),
        )?;
        if create_code != 0 {
            return Err(format!(
                "포털 ScreenCast 세션 생성 실패 (코드: {create_code})"
            ));
        }

        let session_dict = create_results
            .get::<HashMap<String, glib::Variant>>()
            .ok_or_else(|| "CreateSession 응답 형식이 올바르지 않습니다.".to_string())?;
        let session_handle_str = session_dict
            .get("session_handle")
            .and_then(|v| v.get::<String>())
            .ok_or_else(|| "CreateSession 응답에 session_handle이 없습니다.".to_string())?;
        let session_path = glib::variant::ObjectPath::try_from(session_handle_str.as_str())
            .map_err(|e| format!("유효하지 않은 session_handle 경로: {e}"))?;

        // 2. SelectSources (types=2 Window only, multiple=false, cursor_mode=1, persist_mode=2, restore_token)
        let select_token = next_portal_token("naia_sc_select");
        let select_cfg = build_portal_select_sources_config(&select_token, restore_token);
        let mut select_opts: HashMap<&str, glib::Variant> = HashMap::new();
        select_opts.insert("handle_token", select_cfg.handle_token.to_variant());
        select_opts.insert("types", select_cfg.types.to_variant());
        select_opts.insert("multiple", select_cfg.multiple.to_variant());
        select_opts.insert("cursor_mode", select_cfg.cursor_mode.to_variant());
        select_opts.insert("persist_mode", select_cfg.persist_mode.to_variant());
        if let Some(ref token) = select_cfg.restore_token {
            select_opts.insert("restore_token", token.to_variant());
        }
        let select_params =
            glib::Variant::tuple_from_iter([session_path.to_variant(), select_opts.to_variant()]);

        let (select_code, _) = call_portal_request(
            &conn,
            "SelectSources",
            &select_params,
            &select_token,
            Duration::from_secs(30),
        )?;
        if select_code != 0 {
            return Err(format!(
                "포털 ScreenCast 창 원본 설정 실패 (코드: {select_code})"
            ));
        }

        // 3. Start (if restore_token is valid, skips prompt; otherwise prompts user once to pick the window)
        let start_token = next_portal_token("naia_sc_start");
        let mut start_opts: HashMap<&str, glib::Variant> = HashMap::new();
        start_opts.insert("handle_token", start_token.to_variant());
        let start_params = glib::Variant::tuple_from_iter([
            session_path.to_variant(),
            "".to_variant(),
            start_opts.to_variant(),
        ]);

        let (start_code, start_results) = call_portal_request(
            &conn,
            "Start",
            &start_params,
            &start_token,
            Duration::from_secs(300),
        )?;
        if start_code != 0 {
            return Err("화면 공유 포털 창 선택이 취소되었거나 거부되었습니다.".to_string());
        }

        let start_dict = start_results
            .get::<HashMap<String, glib::Variant>>()
            .ok_or_else(|| "Start 응답 형식이 올바르지 않습니다.".to_string())?;
        let new_restore_token = start_dict
            .get("restore_token")
            .and_then(|v| v.get::<String>())
            .filter(|s| !s.trim().is_empty());

        let streams_variant = start_dict
            .get("streams")
            .ok_or_else(|| "포털 Start 응답에 streams 항목이 없습니다.".to_string())?;
        if streams_variant.n_children() == 0 {
            return Err("선택된 포털 화면 스트림이 없습니다.".to_string());
        }
        let first_stream = streams_variant.child_value(0);
        let node_id = first_stream
            .child_value(0)
            .get::<u32>()
            .ok_or_else(|| "포털 스트림 PipeWire node_id를 읽지 못했습니다.".to_string())?;

        // 4. OpenPipeWireRemote -> RawFd
        let empty_opts: HashMap<&str, glib::Variant> = HashMap::new();
        let remote_params =
            glib::Variant::tuple_from_iter([session_path.to_variant(), empty_opts.to_variant()]);
        let (reply, fd_list) = conn
            .call_with_unix_fd_list_sync(
                Some("org.freedesktop.portal.Desktop"),
                "/org/freedesktop/portal/desktop",
                "org.freedesktop.portal.ScreenCast",
                "OpenPipeWireRemote",
                Some(&remote_params),
                Some(glib::VariantTy::new("(h)").unwrap()),
                gtk::gio::DBusCallFlags::NONE,
                30_000,
                gtk::gio::UnixFDList::NONE,
                gtk::gio::Cancellable::NONE,
            )
            .map_err(|e| format!("OpenPipeWireRemote 호출 실패: {e}"))?;

        let fd_index = reply
            .child_value(0)
            .get::<i32>()
            .unwrap_or(0);
        let raw_fd = fd_list
            .get(fd_index)
            .map_err(|e| format!("PipeWire 원격 FD 추출 실패: {e}"))?;

        Ok(PortalScreenCastSelection {
            node_id,
            pipewire_fd: Some(raw_fd),
            restore_token: new_restore_token,
            dbus_connection: Some(conn),
        })
    }
}

#[cfg(target_os = "linux")]
use std::collections::HashMap;

/// Probe whether a GStreamer element factory exists via system `libgstreamer-1.0.so.0` (loaded by WebKitGTK)
/// with a fallback to `gst-inspect-1.0`.
pub fn gstreamer_has_element(element_name: &str) -> bool {
    #[cfg(target_os = "linux")]
    {
        if let Some(found) = probe_gstreamer_element_via_libgstreamer(element_name) {
            return found;
        }
    }
    Command::new("gst-inspect-1.0")
        .arg("--exists")
        .arg(element_name)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn probe_gstreamer_element_via_libgstreamer(element_name: &str) -> Option<bool> {
    use std::ffi::CString;
    type GstInitCheckFn = unsafe extern "C" fn(
        argc: *mut libc::c_int,
        argv: *mut *mut *mut libc::c_char,
        err: *mut *mut libc::c_void,
    ) -> libc::c_int;
    type GstElementFactoryFindFn =
        unsafe extern "C" fn(name: *const libc::c_char) -> *mut libc::c_void;
    type GstObjectUnrefFn = unsafe extern "C" fn(obj: *mut libc::c_void);

    let c_lib = CString::new("libgstreamer-1.0.so.0").ok()?;
    let c_elem = CString::new(element_name).ok()?;
    unsafe {
        let handle = libc::dlopen(c_lib.as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL);
        if handle.is_null() {
            return None;
        }
        let init_sym = libc::dlsym(handle, b"gst_init_check\0".as_ptr() as *const libc::c_char);
        let find_sym = libc::dlsym(
            handle,
            b"gst_element_factory_find\0".as_ptr() as *const libc::c_char,
        );
        let unref_sym =
            libc::dlsym(handle, b"gst_object_unref\0".as_ptr() as *const libc::c_char);
        if init_sym.is_null() || find_sym.is_null() || unref_sym.is_null() {
            return None;
        }
        let gst_init_check: GstInitCheckFn = std::mem::transmute(init_sym);
        let gst_element_factory_find: GstElementFactoryFindFn = std::mem::transmute(find_sym);
        let gst_object_unref: GstObjectUnrefFn = std::mem::transmute(unref_sym);

        if gst_init_check(
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        ) == 0
        {
            return None;
        }
        let factory = gst_element_factory_find(c_elem.as_ptr());
        if factory.is_null() {
            Some(false)
        } else {
            gst_object_unref(factory);
            Some(true)
        }
    }
}

pub fn select_gstreamer_audio_encoder() -> GstAudioEncoder {
    if gstreamer_has_element("avenc_aac") || !gstreamer_has_element("voaacenc") {
        GstAudioEncoder::AvencAac
    } else {
        GstAudioEncoder::Voaacenc
    }
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
    #[serde(default)]
    pub adk_path: String,
    pub platform: String,
    pub server_url: Option<String>,
    pub stream_key: Option<String>,
    pub resolution: Option<String>,
    pub output_file: Option<String>,
    pub restore_token: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restore_token: Option<String>,
}

struct LinuxBroadcastResources {
    sink_name: String,
    created_links: Vec<(u32, u32)>,
    pipewire_fd: Option<i32>,
    pipewire_node_id: u32,
    #[cfg(target_os = "linux")]
    _dbus_connection: Option<gtk::gio::DBusConnection>,
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
    restore_token: Option<String>,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    linux_resources: Option<LinuxBroadcastResources>,
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
                restore_token: session.restore_token.clone(),
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
                restore_token: None,
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
) -> Result<(Child, Option<ChildStdin>, VideoEncoder), String> {
    for encoder in [VideoEncoder::H264Nvenc, VideoEncoder::Libx264] {
        let mut spec = base_spec.clone();
        spec.encoder = encoder;
        let args = build_ffmpeg_args(&spec, capture)?;
        let redacted = redact_ffmpeg_args(&args, &spec.stream_key);
        log::info!(
            "[broadcast] spawning ffmpeg ({}/{}) args={:?}",
            capture.name(),
            encoder.as_str(),
            redacted
        );

        let mut command = Command::new(ffmpeg_path);
        command
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(encoder_stderr());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }

        match command.spawn() {
            Ok(mut child) => {
                std::thread::sleep(Duration::from_millis(250));
                match child.try_wait() {
                    Ok(None) => {
                        let stdin = child
                            .stdin
                            .take()
                            .ok_or_else(|| "ffmpeg stdin 파이프를 열지 못했습니다.".to_string())?;
                        return Ok((child, Some(stdin), encoder));
                    }
                    Ok(Some(status)) => {
                        log::warn!(
                            "[broadcast] ffmpeg ({}) exited immediately with status {status}: {}",
                            encoder.as_str(),
                            encoder_log_tail(&spec.stream_key).unwrap_or_default()
                        );
                        if encoder == VideoEncoder::Libx264 {
                            return Err(format!(
                                "ffmpeg 시작 실패 (종료 코드: {status}) {}",
                                encoder_log_tail(&spec.stream_key).unwrap_or_default()
                            ));
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

fn spawn_gstreamer_with_fallback(
    base_spec: &FfmpegStreamSpec,
    capture: &dyn ScreenCaptureSource,
) -> Result<(Child, Option<ChildStdin>, VideoEncoder), String> {
    let audio_encoder = select_gstreamer_audio_encoder();
    let mut candidate_encoders = Vec::new();
    if gstreamer_has_element(VideoEncoder::H264Nvenc.gstreamer_element_name()) {
        candidate_encoders.push(VideoEncoder::H264Nvenc);
    }
    if gstreamer_has_element(VideoEncoder::Libx264.gstreamer_element_name())
        || candidate_encoders.is_empty()
    {
        candidate_encoders.push(VideoEncoder::Libx264);
    }

    for encoder in candidate_encoders {
        let mut spec = base_spec.clone();
        spec.encoder = encoder;
        let args = build_gstreamer_pipeline_args(&spec, capture, audio_encoder)?;
        let redacted = redact_ffmpeg_args(&args, &spec.stream_key);
        log::info!(
            "[broadcast] spawning gst-launch-1.0 ({}/{}/{}) args={:?}",
            capture.name(),
            encoder.gstreamer_element_name(),
            audio_encoder.element_name(),
            redacted
        );

        let mut command = Command::new("gst-launch-1.0");
        command
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(encoder_stderr());

        #[cfg(unix)]
        if let Some(fd) = capture.pipewire_fd() {
            use std::os::unix::process::CommandExt;
            unsafe {
                command.pre_exec(move || {
                    let flags = libc::fcntl(fd, libc::F_GETFD);
                    if flags >= 0 {
                        let _ = libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC);
                    }
                    Ok(())
                });
            }
        }

        match command.spawn() {
            Ok(mut child) => {
                std::thread::sleep(Duration::from_millis(250));
                match child.try_wait() {
                    Ok(None) => return Ok((child, None, encoder)),
                    Ok(Some(status)) => {
                        log::warn!(
                            "[broadcast] gst-launch-1.0 ({}) exited immediately with status {status}: {}",
                            encoder.gstreamer_element_name(),
                            encoder_log_tail(&spec.stream_key).unwrap_or_default()
                        );
                        if encoder == VideoEncoder::Libx264 {
                            return Err(format!(
                                "GStreamer 송출 시작 실패 (종료 코드: {status}) {}",
                                encoder_log_tail(&spec.stream_key).unwrap_or_default()
                            ));
                        }
                    }
                    Err(err) => {
                        if encoder == VideoEncoder::Libx264 {
                            return Err(format!("GStreamer 상태 확인 실패: {err}"));
                        }
                    }
                }
            }
            Err(err) => {
                if encoder == VideoEncoder::Libx264 {
                    return Err(format!("gst-launch-1.0 실행 실패: {err}"));
                }
            }
        }
    }

    Err("사용 가능한 GStreamer 영상 인코더(nvh264enc / x264enc)를 시작하지 못했습니다.".to_string())
}

fn spawn_stream_for_capture(
    ffmpeg_path: &Path,
    spec: &FfmpegStreamSpec,
    capture: &dyn ScreenCaptureSource,
) -> Result<(Child, Option<ChildStdin>, VideoEncoder), String> {
    if capture.uses_gstreamer_pipeline() {
        spawn_gstreamer_with_fallback(spec, capture)
    } else {
        spawn_ffmpeg_with_fallback(ffmpeg_path, spec, capture)
    }
}

fn start_pipewire_audio_linker_thread(session_id: u64, root_pid: u32) {
    let manager_arc = Arc::clone(broadcast_manager());
    std::thread::spawn(move || loop {
        std::thread::sleep(PIPEWIRE_RESCAN_INTERVAL);
        let is_active = {
            let Ok(mgr) = manager_arc.lock() else {
                return;
            };
            matches!(mgr.active, Some(ref s) if s.session_id == session_id && s.linux_resources.is_some())
        };
        if !is_active {
            return;
        }

        let pids = collect_process_tree_pids(root_pid);
        if let Ok(new_links) = sync_pipewire_broadcast_links_once(&pids, NAIA_BROADCAST_SINK_NAME) {
            if !new_links.is_empty() {
                if let Ok(mut mgr) = manager_arc.lock() {
                    if let Some(ref mut session) = mgr.active {
                        if session.session_id == session_id {
                            if let Some(ref mut res) = session.linux_resources {
                                for pair in new_links {
                                    if !res.created_links.contains(&pair) {
                                        res.created_links.push(pair);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    });
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
                        let reason = encoder_log_tail(&session.spec.stream_key);
                        log::warn!(
                            "[broadcast] encoder exited with status {status}: {}",
                            reason.as_deref().unwrap_or("-")
                        );
                        session.last_error = Some(match reason {
                            Some(reason) => {
                                format!("방송 연결이 끊겼습니다 (종료: {status}) {reason}")
                            }
                            None => format!("방송 연결이 끊겼습니다 (종료: {status})"),
                        });
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
            let linux_target = session
                .linux_resources
                .as_ref()
                .map(|r| (r.pipewire_fd, r.pipewire_node_id));
            (
                session.ffmpeg_path.clone(),
                session.spec.clone(),
                linux_target,
            )
        };

        let capture: Box<dyn ScreenCaptureSource> =
            if let Some((pw_fd, pw_node_id)) = respawn_inputs.2 {
                Box::new(LinuxPortalPipeWireCapture::new(pw_fd, pw_node_id))
            } else {
                default_screen_capture_source()
            };
        let respawn_result =
            spawn_stream_for_capture(&respawn_inputs.0, &respawn_inputs.1, capture.as_ref());

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
                    session.stdin = stdin;
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
    let resolved_adk = if !request.adk_path.trim().is_empty() {
        request.adk_path.trim().to_string()
    } else {
        crate::current_adk_path().unwrap_or_default()
    };
    if resolved_adk.trim().is_empty() {
        return Err("워크스페이스(ADK) 경로가 비어 있습니다.".to_string());
    }
    let adk_path = PathBuf::from(resolved_adk.trim());
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

    {
        let mgr = broadcast_manager()
            .lock()
            .map_err(|_| "방송 상태 잠금 오류".to_string())?;
        if mgr.active.is_some() {
            return Err("이미 방송이 진행 중입니다.".to_string());
        }
    }

    let base_capture = default_screen_capture_source();
    let mut linux_resources: Option<LinuxBroadcastResources> = None;
    let mut active_restore_token = request
        .restore_token
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| load_broadcast_restore_token(&adk_path));

    let capture: Box<dyn ScreenCaptureSource> = if base_capture.uses_gstreamer_pipeline() {
        create_pipewire_broadcast_sink(NAIA_BROADCAST_SINK_NAME)?;
        let pids = collect_process_tree_pids(std::process::id());
        let initial_links =
            sync_pipewire_broadcast_links_once(&pids, NAIA_BROADCAST_SINK_NAME).unwrap_or_default();

        let portal_selection =
            match request_portal_screencast_window(active_restore_token.as_deref()) {
                Ok(sel) => sel,
                Err(err) => {
                    cleanup_pipewire_broadcast_sink(NAIA_BROADCAST_SINK_NAME, &initial_links);
                    return Err(err);
                }
            };

        if let Some(ref token) = portal_selection.restore_token {
            let _ = save_broadcast_restore_token(&adk_path, token);
            active_restore_token = Some(token.clone());
        }

        let pw_fd = portal_selection.pipewire_fd;
        let pw_node_id = portal_selection.node_id;
        linux_resources = Some(LinuxBroadcastResources {
            sink_name: NAIA_BROADCAST_SINK_NAME.to_string(),
            created_links: initial_links,
            pipewire_fd: pw_fd,
            pipewire_node_id: pw_node_id,
            #[cfg(target_os = "linux")]
            _dbus_connection: portal_selection.dbus_connection,
        });
        Box::new(LinuxPortalPipeWireCapture::new(pw_fd, pw_node_id))
    } else {
        base_capture
    };

    if let Err(err) = capture.video_input_args(resolution.fps()) {
        if let Some(ref res) = linux_resources {
            cleanup_pipewire_broadcast_sink(&res.sink_name, &res.created_links);
            #[cfg(unix)]
            if let Some(fd) = res.pipewire_fd {
                unsafe {
                    let _ = libc::close(fd);
                }
            }
        }
        return Err(err);
    }

    let ffmpeg_path = resolve_ffmpeg_path(Some(&app));
    let spec = FfmpegStreamSpec {
        platform,
        server_url,
        stream_key,
        resolution,
        encoder: VideoEncoder::H264Nvenc,
        output_file,
    };

    let (child, stdin, encoder) =
        match spawn_stream_for_capture(&ffmpeg_path, &spec, capture.as_ref()) {
            Ok(started) => started,
            Err(err) => {
                if let Some(ref res) = linux_resources {
                    cleanup_pipewire_broadcast_sink(&res.sink_name, &res.created_links);
                    #[cfg(unix)]
                    if let Some(fd) = res.pipewire_fd {
                        unsafe {
                            let _ = libc::close(fd);
                        }
                    }
                }
                return Err(err);
            }
        };

    let mut mgr = broadcast_manager()
        .lock()
        .map_err(|_| "방송 상태 잠금 오류".to_string())?;
    mgr.next_session_id += 1;
    let session_id = mgr.next_session_id;
    let started_at = utc_now_rfc3339();
    let has_linux_audio = linux_resources.is_some();

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
        restore_token: active_restore_token,
        child: Some(child),
        stdin,
        linux_resources,
    });

    let snap = mgr.snapshot();
    drop(mgr);

    let _ = app.emit(BROADCAST_STATUS_EVENT, snap.clone());
    if has_linux_audio {
        start_pipewire_audio_linker_thread(session_id, std::process::id());
    }
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
        #[cfg(unix)]
        unsafe {
            let _ = libc::kill(child.id() as i32, libc::SIGINT);
        }
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

    if let Some(res) = session.linux_resources.take() {
        cleanup_pipewire_broadcast_sink(&res.sink_name, &res.created_links);
        #[cfg(unix)]
        if let Some(fd) = res.pipewire_fd {
            unsafe {
                let _ = libc::close(fd);
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
        restore_token: session.restore_token,
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
    use super::*;

    #[test]
    fn formats_rfc3339_utc_without_time_crate() {
        assert_eq!(format_rfc3339_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_rfc3339_utc(1_793_932_008), "2026-11-06T02:26:48Z");
        assert_eq!(format_rfc3339_utc(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn platform_presets_match_keyframe_and_bitrate_table() {
        let capture = WindowsGdiGrabCapture;
        assert_eq!(capture.name(), "gdigrab");

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
    fn encoder_log_tail_keeps_last_lines_and_masks_key() {
        let secret = "tail-secret-key-789";
        fs::write(
            encoder_log_path(),
            format!(
                "line one\n\nWARNING: erroneous pipeline: no element \"pipewiresrc\"\nERROR: rtmp://a.example/live2/{secret} refused\n"
            ),
        )
        .unwrap();
        let tail = encoder_log_tail(secret).unwrap();
        assert!(!tail.contains(secret));
        assert!(tail.contains("no element"));
        assert!(tail.starts_with("line one"));
        let _ = fs::remove_file(encoder_log_path());
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
    fn linux_gstreamer_pipeline_args_and_redaction() {
        let uninitialized = LinuxPortalPipeWireCapture::default();
        assert_eq!(uninitialized.name(), "portal-pipewire-gstreamer");
        assert!(uninitialized.uses_gstreamer_pipeline());
        assert!(uninitialized.video_input_args(30).is_err());

        let capture = LinuxPortalPipeWireCapture::new(Some(17), 92);
        let secret = "yt-key-987";
        let spec = FfmpegStreamSpec {
            platform: BroadcastPlatform::Youtube,
            server_url: String::new(),
            stream_key: secret.to_string(),
            resolution: BroadcastResolution::P1080Fps30,
            encoder: VideoEncoder::H264Nvenc,
            output_file: None,
        };
        let gst_args = build_gstreamer_pipeline_args(&spec, &capture, GstAudioEncoder::AvencAac)
            .expect("gst args");
        assert!(gst_args.contains(&"pipewiresrc".to_string()));
        assert!(gst_args.contains(&"fd=17".to_string()));
        assert!(gst_args.contains(&"path=92".to_string()));
        assert!(gst_args.contains(&"pulsesrc".to_string()));
        assert!(gst_args.contains(&"device=naia-broadcast-mix.monitor".to_string()));
        assert!(gst_args.contains(&"nvh264enc".to_string()));
        assert!(gst_args.contains(&"bitrate=6000".to_string()));
        assert!(gst_args.contains(&"gop-size=60".to_string()));
        assert!(gst_args.contains(&"avenc_aac".to_string()));
        assert!(gst_args.contains(&"bitrate=160000".to_string()));
        assert!(gst_args.contains(&"flvmux".to_string()));
        assert!(gst_args.contains(&"rtmp2sink".to_string()));

        let redacted = redact_ffmpeg_args(&gst_args, &spec.stream_key);
        for arg in &redacted {
            assert!(!arg.contains(secret), "secret leaked in gst arg: {arg}");
        }
        assert_eq!(
            redacted.last().map(String::as_str),
            Some("location=rtmps://a.rtmp.youtube.com/live2/***")
        );

        // Chzzk x264enc + voaacenc fallback
        let chzzk_spec = FfmpegStreamSpec {
            platform: BroadcastPlatform::Chzzk,
            server_url: String::new(),
            stream_key: secret.to_string(),
            resolution: BroadcastResolution::P720Fps30,
            encoder: VideoEncoder::Libx264,
            output_file: None,
        };
        let chzzk_gst =
            build_gstreamer_pipeline_args(&chzzk_spec, &capture, GstAudioEncoder::Voaacenc)
                .expect("chzzk gst args");
        assert!(chzzk_gst.contains(&"x264enc".to_string()));
        assert!(chzzk_gst.contains(&"bitrate=8000".to_string()));
        assert!(chzzk_gst.contains(&"key-int-max=30".to_string()));
        assert!(chzzk_gst.contains(&"voaacenc".to_string()));
    }

    #[test]
    fn pipewire_process_tree_audio_port_matching() {
        // 1. Descendant PID resolution (shell 1000 -> bwrap 1010 -> WebKitWebProcess 1020)
        let proc_table = [(1000, 1), (1010, 1000), (1020, 1010), (2000, 1)];
        let tree = collect_descendant_pids(1000, &proc_table);
        assert!(tree.contains(&1000));
        assert!(tree.contains(&1010));
        assert!(tree.contains(&1020));
        assert!(!tree.contains(&2000));

        // 2. pw-dump link planning: matches node 192 (client 145 -> pid 1020), ignores node 199 (client 146 -> pid 2000)
        let sample_dump = r#"[
          {
            "id": 145,
            "type": "PipeWire:Interface:Client",
            "info": { "props": { "application.process.id": 1020 } }
          },
          {
            "id": 146,
            "type": "PipeWire:Interface:Client",
            "info": { "props": { "application.process.id": 2000 } }
          },
          {
            "id": 170,
            "type": "PipeWire:Interface:Node",
            "info": { "props": { "node.name": "naia-broadcast-mix", "media.class": "Audio/Sink" } }
          },
          {
            "id": 192,
            "type": "PipeWire:Interface:Node",
            "info": { "props": { "node.name": "WebKitWebProcess", "media.class": "Stream/Output/Audio", "client.id": 145 } }
          },
          {
            "id": 199,
            "type": "PipeWire:Interface:Node",
            "info": { "props": { "node.name": "OtherBrowser", "media.class": "Stream/Output/Audio", "client.id": 146 } }
          },
          {
            "id": 171,
            "type": "PipeWire:Interface:Port",
            "info": { "direction": "input", "props": { "node.id": 170, "port.name": "playback_FL", "audio.channel": "FL" } }
          },
          {
            "id": 172,
            "type": "PipeWire:Interface:Port",
            "info": { "direction": "input", "props": { "node.id": 170, "port.name": "playback_FR", "audio.channel": "FR" } }
          },
          {
            "id": 139,
            "type": "PipeWire:Interface:Port",
            "info": { "direction": "output", "props": { "node.id": 192, "port.name": "output_FL", "audio.channel": "FL" } }
          },
          {
            "id": 151,
            "type": "PipeWire:Interface:Port",
            "info": { "direction": "output", "props": { "node.id": 192, "port.name": "output_FR", "audio.channel": "FR" } }
          },
          {
            "id": 239,
            "type": "PipeWire:Interface:Port",
            "info": { "direction": "output", "props": { "node.id": 199, "port.name": "output_FL", "audio.channel": "FL" } }
          },
          {
            "id": 300,
            "type": "PipeWire:Interface:Link",
            "info": { "output-port-id": 139, "input-port-id": 55 }
          }
        ]"#;

        let links =
            plan_pipewire_broadcast_links(sample_dump, &tree, NAIA_BROADCAST_SINK_NAME).unwrap();
        assert_eq!(links, vec![(139, 171), (151, 172)]);
    }

    #[test]
    fn live_pipewire_virtual_sink_and_port_linking_when_enabled() {
        if std::env::var("NAIA_LIVE_PIPEWIRE_TEST").as_deref() != Ok("1") {
            return;
        }
        create_pipewire_broadcast_sink(NAIA_BROADCAST_SINK_NAME).expect("create live sink");
        let pids = collect_process_tree_pids(std::process::id());
        assert!(pids.contains(&std::process::id()));
        let links = sync_pipewire_broadcast_links_once(&pids, NAIA_BROADCAST_SINK_NAME)
            .expect("sync live links");
        cleanup_pipewire_broadcast_sink(NAIA_BROADCAST_SINK_NAME, &links);
    }

    #[test]
    fn portal_screencast_restore_token_roundtrip() {
        let cfg = build_portal_select_sources_config("req_1", Some("  tok-abc-123  "));
        assert_eq!(cfg.types, 2);
        assert!(!cfg.multiple);
        assert_eq!(cfg.persist_mode, 2);
        assert_eq!(cfg.restore_token.as_deref(), Some("tok-abc-123"));

        let tmp = std::env::temp_dir().join(format!("naia-portal-token-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        assert_eq!(load_broadcast_restore_token(&tmp), None);

        save_broadcast_restore_token(&tmp, "portal-restore-xyz").expect("save token");
        assert_eq!(
            load_broadcast_restore_token(&tmp).as_deref(),
            Some("portal-restore-xyz")
        );

        let _ = fs::remove_dir_all(&tmp);
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
