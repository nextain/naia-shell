//! FR-SLIDES-REC-LINUX.1 — argument construction, platform branching and the
//! ffmpeg lifecycle (fake ffmpeg scripts), plus one real-ffmpeg recording that
//! runs only when an isolated display and audio source are named (`--ignored`).
use super::*;
use std::time::{Duration, Instant};

fn strings(args: &[OsString]) -> Vec<String> {
    args.iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect()
}

fn window_after<'a>(args: &'a [String], flag: &str) -> Vec<&'a str> {
    let i = args
        .iter()
        .position(|a| a == flag)
        .unwrap_or_else(|| panic!("{flag} missing in {args:?}"));
    args[i..].iter().map(String::as_str).take(2).collect()
}

#[test]
fn linux_x11_window_is_captured_by_its_own_xid_and_display() {
    let target = capture_target(
        Platform::Linux,
        Some(LinuxWindow::X11 {
            display: Some(":7".into()),
            xid: 0x4a0000b,
        }),
        Some(":0".into()),
    )
    .unwrap();
    assert_eq!(
        target,
        CaptureTarget::X11Window {
            display: ":7".into(),
            window_id: 0x4a0000b
        }
    );
}

#[test]
fn linux_falls_back_to_env_display_when_gdk_gives_none() {
    let target = capture_target(
        Platform::Linux,
        Some(LinuxWindow::X11 {
            display: None,
            xid: 9,
        }),
        Some(":3".into()),
    )
    .unwrap();
    assert_eq!(
        target,
        CaptureTarget::X11Window {
            display: ":3".into(),
            window_id: 9
        }
    );
    let err = capture_target(
        Platform::Linux,
        Some(LinuxWindow::X11 {
            display: Some(" ".into()),
            xid: 9,
        }),
        None,
    )
    .unwrap_err();
    assert!(err.contains("DISPLAY"), "{err}");
}

#[test]
fn native_wayland_is_a_clear_error_not_a_silent_recording() {
    for linux in [
        Some(LinuxWindow::NotX11),
        None,
        Some(LinuxWindow::X11 {
            display: Some(":0".into()),
            xid: 0,
        }),
    ] {
        let err = capture_target(Platform::Linux, linux, Some(":0".into())).unwrap_err();
        assert!(err.contains("Wayland") && err.contains("X11"), "{err}");
    }
}

#[test]
fn windows_keeps_gdigrab_and_other_platforms_refuse() {
    assert_eq!(
        capture_target(Platform::Windows, None, None).unwrap(),
        CaptureTarget::WindowsTitle("Naia".into())
    );
    assert!(capture_target(Platform::Other, None, None).is_err());
}

#[test]
fn audio_defaults_to_the_linux_output_monitor_and_can_be_overridden() {
    assert_eq!(
        audio_input(Platform::Linux, None),
        AudioInput::Pulse("@DEFAULT_MONITOR@".into())
    );
    assert_eq!(
        audio_input(Platform::Linux, Some("  ")),
        AudioInput::Pulse("@DEFAULT_MONITOR@".into())
    );
    assert_eq!(
        audio_input(Platform::Linux, Some("sink.monitor")),
        AudioInput::Pulse("sink.monitor".into())
    );
    assert_eq!(audio_input(Platform::Linux, Some("NONE")), AudioInput::None);
    assert_eq!(audio_input(Platform::Windows, None), AudioInput::None);
    assert_eq!(
        audio_input(Platform::Windows, Some("Stereo Mix")),
        AudioInput::DirectShow("Stereo Mix".into())
    );
    assert_eq!(audio_input(Platform::Other, Some("x")), AudioInput::None);
}

#[test]
fn linux_args_use_x11grab_window_id_and_pulse_audio() {
    let target = CaptureTarget::X11Window {
        display: ":7".into(),
        window_id: 12345,
    };
    let args = strings(&ffmpeg_args(
        &target,
        &AudioInput::Pulse("@DEFAULT_MONITOR@".into()),
        Path::new("/tmp/out.mp4"),
    ));
    assert!(
        !args
            .iter()
            .any(|a| a.contains("gdigrab") || a.contains("title=")),
        "{args:?}"
    );
    assert_eq!(window_after(&args, "x11grab"), ["x11grab", "-framerate"]);
    assert_eq!(window_after(&args, "-window_id"), ["-window_id", "12345"]);
    let video_input = args.iter().position(|a| a == "-window_id").unwrap() + 2;
    assert_eq!(args[video_input..video_input + 2], ["-i", ":7"]);
    assert_eq!(window_after(&args, "pulse"), ["pulse", "-i"]);
    let audio_input_at = args.iter().position(|a| a == "pulse").unwrap() + 2;
    assert_eq!(args[audio_input_at], "@DEFAULT_MONITOR@");
    assert_eq!(window_after(&args, "-c:a"), ["-c:a", "aac"]);
    assert_eq!(window_after(&args, "-c:v"), ["-c:v", "libx264"]);
    assert_eq!(window_after(&args, "-progress"), ["-progress", "pipe:1"]);
    assert_eq!(args.last().unwrap(), "/tmp/out.mp4");
    // Inputs come before any output option.
    assert!(args.iter().position(|a| a == "-c:v").unwrap() > audio_input_at);
}

#[test]
fn windows_args_keep_gdigrab_and_add_no_audio_by_default() {
    let args = strings(&ffmpeg_args(
        &CaptureTarget::WindowsTitle("Naia".into()),
        &AudioInput::None,
        Path::new("C:/v/o.mp4"),
    ));
    assert_eq!(window_after(&args, "gdigrab"), ["gdigrab", "-framerate"]);
    assert!(args.contains(&"title=Naia".to_string()));
    assert!(
        !args
            .iter()
            .any(|a| a == "-c:a" || a == "pulse" || a == "dshow" || a == "-window_id"),
        "{args:?}"
    );
    let with_mix = strings(&ffmpeg_args(
        &CaptureTarget::WindowsTitle("Naia".into()),
        &AudioInput::DirectShow("Stereo Mix".into()),
        Path::new("o.mp4"),
    ));
    assert_eq!(window_after(&with_mix, "dshow"), ["dshow", "-i"]);
    assert!(with_mix.contains(&"audio=Stereo Mix".to_string()));
}

#[cfg(unix)]
mod lifecycle {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn scratch(name: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("naia-rec-{}-{name}-{unique}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A fake ffmpeg: a shell script; the output path arrives as the last arg.
    fn fake(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("ffmpeg");
        std::fs::write(&path, format!("#!/bin/sh\neval out=\\${{$#}}\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn args(script: &Path, out: &Path) -> Vec<OsString> {
        vec![
            script.as_os_str().to_os_string(),
            out.as_os_str().to_os_string(),
        ]
    }

    #[test]
    fn immediate_exit_is_a_start_failure_with_the_stderr_reason() {
        let dir = scratch("early");
        let out = dir.join("o.mp4");
        let ffmpeg = fake(
            &dir,
            "echo 'first line' >&2\necho 'x11grab: Cannot open display :9' >&2\nexit 234",
        );
        let err = match Recorder::start(
            OsStr::new("/bin/sh"),
            &args(&ffmpeg, &out),
            out.clone(),
            Duration::from_millis(800),
        ) {
            Ok(_) => panic!("start must fail when ffmpeg exits at once"),
            Err(err) => err,
        };
        assert!(
            err.contains("234") && err.contains("Cannot open display"),
            "{err}"
        );
    }

    #[test]
    fn stop_sends_q_and_waits_for_ffmpeg_to_finalize() {
        let dir = scratch("graceful");
        let out = dir.join("o.mp4");
        // Finishes only after reading "q"; a kill would leave no file.
        let ffmpeg = fake(&dir, "printf 'frame=1\\nout_time_us=1000\\nprogress=continue\\n'\nwhile true; do c=$(dd bs=1 count=1 2>/dev/null); [ \"$c\" = q ] && break; [ -z \"$c\" ] && exit 9; done\nsleep 0.3\nprintf finalized > \"$out\"\nexit 0");
        let recorder = Recorder::start(
            OsStr::new("/bin/sh"),
            &args(&ffmpeg, &out),
            out.clone(),
            Duration::from_secs(3),
        )
        .unwrap();
        let started = Instant::now();
        let path = recorder.stop(Duration::from_secs(5)).unwrap();
        assert_eq!(path, out);
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "finalized");
        assert!(started.elapsed() < Duration::from_secs(4));
    }

    #[test]
    fn ffmpeg_that_ignores_q_is_killed_after_the_grace_period() {
        let dir = scratch("stuck");
        let out = dir.join("o.mp4");
        let ffmpeg = fake(
            &dir,
            "printf 'frame=1\\nout_time_us=1000\\nprogress=continue\\n'\nexec sleep 30",
        );
        let recorder = Recorder::start(
            OsStr::new("/bin/sh"),
            &args(&ffmpeg, &out),
            out.clone(),
            Duration::from_secs(3),
        )
        .unwrap();
        let started = Instant::now();
        let err = recorder.stop(Duration::from_millis(400)).unwrap_err();
        assert!(
            err.starts_with(LOST_CODE) && err.contains("not finalized"),
            "{err}"
        );
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn ffmpeg_that_died_while_recording_reports_a_lost_recording() {
        let dir = scratch("died");
        let out = dir.join("o.mp4");
        let ffmpeg = fake(
            &dir,
            "printf 'frame=1\\nout_time_us=1000\\nprogress=continue\\n'\nsleep 0.4\necho 'pulse: connection refused' >&2\nexit 1",
        );
        let recorder = Recorder::start(
            OsStr::new("/bin/sh"),
            &args(&ffmpeg, &out),
            out.clone(),
            Duration::from_secs(3),
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(900));
        let err = recorder.stop(Duration::from_secs(2)).unwrap_err();
        assert!(
            err.starts_with(LOST_CODE) && err.contains("connection refused"),
            "{err}"
        );
    }

    #[test]
    fn waits_for_complete_video_progress() {
        let dir = scratch("delayed");
        let out = dir.join("o.mp4");
        let ffmpeg = fake(&dir, "printf 'frame=1\\nout_time_us=0\\nprogress=continue\\n'\nsleep 0.4\nprintf 'frame=2\\nout_time_us=1000\\nprogress=continue\\n'\nexec sleep 30");
        let started = Instant::now();
        let recorder = Recorder::start(
            OsStr::new("/bin/sh"),
            &args(&ffmpeg, &out),
            out,
            Duration::from_secs(3),
        )
        .unwrap();
        assert!(started.elapsed() >= Duration::from_millis(350));
        drop(recorder);
    }

    #[test]
    fn never_ready_is_killed_and_partial_file_removed() {
        let dir = scratch("never-ready");
        let out = dir.join("o.mp4");
        let pid = dir.join("pid");
        let ffmpeg = fake(
            &dir,
            &format!(
                "echo $$ > '{}'\nprintf partial > \"$out\"\nexec sleep 30",
                pid.display()
            ),
        );
        let err = match Recorder::start(
            OsStr::new("/bin/sh"),
            &args(&ffmpeg, &out),
            out.clone(),
            Duration::from_millis(400),
        ) {
            Ok(_) => panic!("unready process must fail"),
            Err(err) => err,
        };
        assert!(err.contains("not ready"), "{err}");
        assert!(!out.exists());
        let pid = std::fs::read_to_string(pid).unwrap();
        assert!(!Path::new("/proc").join(pid.trim()).exists());
    }

    /// Real ffmpeg against an isolated X display and audio source:
    /// `NAIA_REC_TEST_DISPLAY=:N NAIA_REC_TEST_AUDIO=<sink>.monitor
    ///  NAIA_REC_TEST_OUT=/path.mp4 cargo test real_ffmpeg -- --ignored`.
    #[test]
    #[ignore]
    fn real_ffmpeg_records_an_x11_window_with_audio() {
        use x11rb::connection::Connection;
        use x11rb::protocol::xproto::{
            ChangeWindowAttributesAux, ConnectionExt, CreateWindowAux, WindowClass,
        };
        let display = std::env::var("NAIA_REC_TEST_DISPLAY").expect("NAIA_REC_TEST_DISPLAY");
        let audio = std::env::var("NAIA_REC_TEST_AUDIO").expect("NAIA_REC_TEST_AUDIO");
        let out = PathBuf::from(std::env::var("NAIA_REC_TEST_OUT").expect("NAIA_REC_TEST_OUT"));
        let (conn, screen) = x11rb::connect(Some(&display)).unwrap();
        let root = conn.setup().roots[screen].root;
        let window = conn.generate_id().unwrap();
        // Odd size on purpose: the even-dimension scale must handle it.
        conn.create_window(
            0,
            window,
            root,
            20,
            20,
            641,
            361,
            0,
            WindowClass::INPUT_OUTPUT,
            0,
            &CreateWindowAux::new().background_pixel(0x00ff66cc),
        )
        .unwrap();
        conn.map_window(window).unwrap();
        conn.flush().unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let target = capture_target(
            Platform::Linux,
            Some(LinuxWindow::X11 {
                display: Some(display.clone()),
                xid: window as u64,
            }),
            None,
        )
        .unwrap();
        let args = ffmpeg_args(&target, &audio_input(Platform::Linux, Some(&audio)), &out);
        let ffmpeg = std::env::var_os("NAIA_FFMPEG_PATH").unwrap_or_else(|| "ffmpeg".into());
        let recorder = Recorder::start(&ffmpeg, &args, out.clone(), STARTUP_TIMEOUT).unwrap();
        let started = Instant::now();
        // Switch pink -> green the moment start() returns: every green frame
        // was captured after the user was told recording began.
        conn.change_window_attributes(
            window,
            &ChangeWindowAttributesAux::new().background_pixel(0x0000ff00),
        )
        .unwrap();
        conn.clear_area(false, window, 0, 0, 0, 0).unwrap();
        conn.flush().unwrap();
        std::thread::sleep(Duration::from_secs(3));
        let elapsed = started.elapsed().as_secs_f64();
        let path = recorder.stop(STOP_GRACE).unwrap();
        assert_eq!(path, out);
        assert!(std::fs::metadata(&out).unwrap().len() > 0);
        let streams = Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type",
                "-of",
                "csv=p=0",
            ])
            .arg(&out)
            .output()
            .unwrap();
        assert!(streams.status.success());
        let streams = String::from_utf8(streams.stdout).unwrap();
        assert!(streams.lines().any(|line| line == "video"), "{streams}");
        assert!(streams.lines().any(|line| line == "audio"), "{streams}");
        let probe = Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
            ])
            .arg(&out)
            .output()
            .unwrap();
        assert!(probe.status.success());
        let duration: f64 = String::from_utf8(probe.stdout)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        // Sample one pixel inside the window per frame (30 fps input).
        let pixels = Command::new("ffmpeg")
            .args(["-v", "error", "-i"])
            .arg(&out)
            .args([
                "-vf",
                "crop=40:40:20:20,scale=1:1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "-",
            ])
            .output()
            .unwrap();
        assert!(pixels.status.success());
        let green = pixels
            .stdout
            .chunks_exact(3)
            .filter(|p| p[1] > 180 && p[0] < 100)
            .count();
        let green_secs = green as f64 / 30.0;
        eprintln!("elapsed={elapsed:.3}s duration={duration:.3}s green={green_secs:.3}s");
        // Nothing after start() returned may be lost; pre-roll before it and
        // the stop flush only add footage.
        assert!(
            green_secs >= elapsed - 0.2,
            "elapsed={elapsed} green={green_secs}"
        );
        assert!(
            duration >= elapsed && duration <= elapsed + 4.0,
            "elapsed={elapsed} duration={duration}"
        );
    }
}
