//! Slides "MP4 녹화" — the shell owns one ffmpeg process (FR-SLIDES-REC.1, FR-SLIDES-REC-LINUX.1).
//!
//! Capture source per platform:
//! - Linux (X11 or Xwayland): `x11grab -window_id <XID> -i <DISPLAY>`. The XID
//!   comes from the shell's own GDK toplevel, so it cannot match another window
//!   titled "Naia", it follows the window when it moves, and on a composited
//!   server (Xwayland) it reads the window's own pixmap even when something
//!   overlaps it. A DISPLAY+geometry region would record whatever sits in that
//!   rectangle and go stale as soon as the window moves.
//!   A shell running as a native Wayland client has no XID: that is reported
//!   as a clear error (the PipeWire screencast portal is not supported yet).
//! - Windows: `gdigrab title=Naia` (unchanged).
//!
//! Audio: Linux records the PulseAudio/PipeWire default output monitor
//! (`@DEFAULT_MONITOR@`). Windows has no loopback device ffmpeg can open by
//! default, so it records video only unless `NAIA_RECORDING_AUDIO_SOURCE`
//! names a DirectShow audio device. `NAIA_RECORDING_AUDIO_SOURCE=none`
//! disables audio everywhere; any other value replaces the Linux source.
//!
//! Lifecycle: ffmpeg's stderr is kept (last lines) instead of discarded, a
//! start only succeeds when ffmpeg is still running after a short probe, and a
//! stop sends `q` on stdin so ffmpeg writes the MP4 index; it is killed only
//! when it does not finish within the grace period.
use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// How many stderr lines are kept for the failure log.
pub(crate) const STDERR_TAIL_LINES: usize = 12;
/// ffmpeg must still be running this long after spawn for a start to count.
pub(crate) const STARTUP_PROBE: Duration = Duration::from_millis(1500);
/// How long a graceful stop may take before ffmpeg is killed.
pub(crate) const STOP_GRACE: Duration = Duration::from_secs(8);
/// PulseAudio / pipewire-pulse name for the default sink's monitor source.
pub(crate) const LINUX_DEFAULT_AUDIO: &str = "@DEFAULT_MONITOR@";
/// Env override for the audio source (`none` disables audio).
pub(crate) const AUDIO_SOURCE_ENV: &str = "NAIA_RECORDING_AUDIO_SOURCE";
/// Stop errors that start with this code mean the recording is gone for good:
/// the client must leave the "recording" state instead of offering a retry.
pub(crate) const LOST_CODE: &str = "recording_lost";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Platform {
    Linux,
    Windows,
    Other,
}

impl Platform {
    pub(crate) fn current() -> Self {
        if cfg!(target_os = "linux") {
            Platform::Linux
        } else if cfg!(windows) {
            Platform::Windows
        } else {
            Platform::Other
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CaptureTarget {
    X11Window { display: String, window_id: u64 },
    WindowsTitle(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AudioInput {
    None,
    Pulse(String),
    DirectShow(String),
}

/// What the shell's own toplevel turned out to be on Linux.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LinuxWindow {
    X11 { display: Option<String>, xid: u64 },
    NotX11,
}

/// Choose the capture target for this platform.
pub(crate) fn capture_target(
    platform: Platform,
    linux: Option<LinuxWindow>,
    env_display: Option<String>,
) -> Result<CaptureTarget, String> {
    match platform {
        Platform::Windows => Ok(CaptureTarget::WindowsTitle("Naia".into())),
        Platform::Other => Err("MP4 recording is not supported on this platform yet".into()),
        Platform::Linux => match linux {
            Some(LinuxWindow::X11 { display, xid }) if xid != 0 => {
                let display = display
                    .filter(|d| !d.trim().is_empty())
                    .or_else(|| env_display.filter(|d| !d.trim().is_empty()))
                    .ok_or("MP4 recording needs an X11 DISPLAY, but none is set")?;
                Ok(CaptureTarget::X11Window { display, window_id: xid })
            }
            _ => Err("MP4 recording needs X11 or Xwayland; the shell is running as a native Wayland window (PipeWire screen capture is not supported yet)".into()),
        },
    }
}

/// Choose the audio input for this platform and the env override.
pub(crate) fn audio_input(platform: Platform, configured: Option<&str>) -> AudioInput {
    let configured = configured.map(str::trim).filter(|v| !v.is_empty());
    match (platform, configured) {
        (_, Some(v)) if v.eq_ignore_ascii_case("none") => AudioInput::None,
        (Platform::Linux, Some(v)) => AudioInput::Pulse(v.into()),
        (Platform::Linux, None) => AudioInput::Pulse(LINUX_DEFAULT_AUDIO.into()),
        (Platform::Windows, Some(v)) => AudioInput::DirectShow(v.into()),
        _ => AudioInput::None,
    }
}

/// The full ffmpeg argument list for one recording.
pub(crate) fn ffmpeg_args(
    target: &CaptureTarget,
    audio: &AudioInput,
    output: &Path,
) -> Vec<OsString> {
    let mut args: Vec<OsString> = Vec::new();
    let mut push = |items: &[&str]| args.extend(items.iter().map(OsString::from));
    push(&["-hide_banner", "-nostats", "-loglevel", "warning", "-y"]);
    match target {
        CaptureTarget::X11Window { display, window_id } => {
            let id = window_id.to_string();
            push(&[
                "-thread_queue_size",
                "512",
                "-f",
                "x11grab",
                "-framerate",
                "30",
                "-draw_mouse",
                "0",
                "-window_id",
                &id,
                "-i",
                display,
            ]);
        }
        CaptureTarget::WindowsTitle(title) => {
            let input = format!("title={title}");
            push(&[
                "-thread_queue_size",
                "512",
                "-f",
                "gdigrab",
                "-framerate",
                "30",
                "-draw_mouse",
                "0",
                "-i",
                &input,
            ]);
        }
    }
    match audio {
        AudioInput::None => {}
        AudioInput::Pulse(source) => {
            push(&["-thread_queue_size", "1024", "-f", "pulse", "-i", source])
        }
        AudioInput::DirectShow(device) => {
            let input = format!("audio={device}");
            push(&["-thread_queue_size", "1024", "-f", "dshow", "-i", &input]);
        }
    }
    // libx264 + yuv420p needs even dimensions; a window can be any size.
    push(&[
        "-vf",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
    ]);
    if audio != &AudioInput::None {
        push(&["-c:a", "aac", "-b:a", "160k"]);
    }
    args.push(output.as_os_str().to_os_string());
    args
}

type Tail = Arc<Mutex<VecDeque<String>>>;

fn tail_text(tail: &Tail) -> Vec<String> {
    tail.lock()
        .map(|t| t.iter().cloned().collect())
        .unwrap_or_default()
}

fn last_line(lines: &[String]) -> String {
    lines
        .iter()
        .rev()
        .find(|l| !l.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| "no ffmpeg output".into())
}

fn log_tail(context: &str, lines: &[String]) {
    crate::log_both(&format!(
        "[slides-recording] {context}; ffmpeg stderr tail ({} lines):",
        lines.len()
    ));
    for line in lines {
        crate::log_both(&format!("[slides-recording]   {line}"));
    }
}

/// One running ffmpeg recording.
pub(crate) struct Recorder {
    child: Child,
    stdin: Option<ChildStdin>,
    tail: Tail,
    reader: Option<JoinHandle<()>>,
    output: PathBuf,
}

impl Recorder {
    /// Spawn ffmpeg and confirm it is still running after `probe`.
    pub(crate) fn start(
        ffmpeg: &OsStr,
        args: &[OsString],
        output: PathBuf,
        probe: Duration,
    ) -> Result<Self, String> {
        let mut child = Command::new(ffmpeg)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("could not start ffmpeg for MP4 recording: {error}"))?;
        let tail: Tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LINES)));
        let reader = child.stderr.take().map(|stderr| {
            let tail = Arc::clone(&tail);
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).split(b'\n').map_while(Result::ok) {
                    let line = String::from_utf8_lossy(&line).trim_end().to_string();
                    if let Ok(mut tail) = tail.lock() {
                        if tail.len() == STDERR_TAIL_LINES {
                            tail.pop_front();
                        }
                        tail.push_back(line);
                    }
                }
            })
        });
        let mut recorder = Recorder {
            stdin: child.stdin.take(),
            child,
            tail,
            reader,
            output,
        };
        let deadline = Instant::now() + probe;
        while Instant::now() < deadline {
            if let Ok(Some(status)) = recorder.child.try_wait() {
                let lines = recorder.finish_reader();
                log_tail(&format!("ffmpeg exited during startup ({status})"), &lines);
                return Err(format!(
                    "MP4 recording failed to start: ffmpeg exited ({status}): {}",
                    last_line(&lines)
                ));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        crate::log_both(&format!(
            "[slides-recording] recording to {}",
            recorder.output.display()
        ));
        Ok(recorder)
    }

    fn finish_reader(&mut self) -> Vec<String> {
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        tail_text(&self.tail)
    }

    /// Ask ffmpeg to finish (`q` on stdin), wait up to `grace`, kill after.
    /// Returns the output path only when ffmpeg exited cleanly and wrote a file.
    pub(crate) fn stop(mut self, grace: Duration) -> Result<PathBuf, String> {
        if let Ok(Some(status)) = self.child.try_wait() {
            let lines = self.finish_reader();
            log_tail(
                &format!("ffmpeg had already exited before stop ({status})"),
                &lines,
            );
            return Err(format!(
                "{LOST_CODE}: ffmpeg stopped during recording ({status}): {}",
                last_line(&lines)
            ));
        }
        if let Some(mut stdin) = self.stdin.take() {
            let _ = stdin.write_all(b"q");
            let _ = stdin.flush();
            // Dropping stdin closes it, which ffmpeg also treats as end of input.
        }
        let deadline = Instant::now() + grace;
        let status = loop {
            match self.child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50))
                }
                _ => break None,
            }
        };
        let Some(status) = status else {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let lines = self.finish_reader();
            log_tail(
                &format!(
                    "ffmpeg did not finish within {}s and was killed",
                    grace.as_secs()
                ),
                &lines,
            );
            return Err(format!(
                "{LOST_CODE}: ffmpeg did not finish within {}s; the MP4 was not finalized",
                grace.as_secs()
            ));
        };
        let lines = self.finish_reader();
        let size = std::fs::metadata(&self.output)
            .map(|m| m.len())
            .unwrap_or(0);
        if !status.success() || size == 0 {
            log_tail(
                &format!("ffmpeg finished with {status}, output {size} bytes"),
                &lines,
            );
            return Err(format!(
                "{LOST_CODE}: ffmpeg finished with {status}: {}",
                last_line(&lines)
            ));
        }
        crate::log_both(&format!(
            "[slides-recording] finished {} ({size} bytes)",
            self.output.display()
        ));
        Ok(std::mem::take(&mut self.output))
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        // Never leave an ffmpeg behind (e.g. the shell exits while recording).
        if let Ok(None) = self.child.try_wait() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[cfg(test)]
#[path = "slides_recording_test.rs"]
mod slides_recording_test;
