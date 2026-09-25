use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

static RECORDING: OnceLock<Mutex<Option<crate::slides_recording::Recorder>>> = OnceLock::new();

fn root(adk_path: &str, app_id: &str) -> Result<PathBuf, String> {
    // app_id is a single path component; '.'/'..' would traverse out of apps/ (the
    // char whitelist permits '.'). Reject them, and defense-in-depth: verify the
    // canonical root stays under the canonical apps dir so no traversal can escape.
    if app_id.is_empty() || app_id.len() > 160 || app_id == "." || app_id == ".." || !app_id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')) {
        return Err("invalid app id".into());
    }
    let apps = Path::new(adk_path).join("data-private").join("apps");
    std::fs::create_dir_all(&apps).map_err(|error| error.to_string())?;
    let apps = apps.canonicalize().map_err(|error| error.to_string())?;
    let root = apps.join(app_id);
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    if !root.starts_with(&apps) {
        return Err("app id escapes the sandbox root".into());
    }
    Ok(root)
}

/// 파일시스템을 만지지 않고 경로가 뿌리 안인지 본다.
///
/// `canonicalize` 는 존재하는 경로에만 쓸 수 있어서, 만들기 전에는 쓸 수 없다.
/// 그래서 논리적으로 먼저 본다 — `..` 를 걷어 낸 결과가 뿌리 밖이면 그 자리는
/// 만들지도 않는다.
fn lexically_inside(root: &Path, candidate: &Path) -> bool {
    let mut depth: i32 = 0;
    let Ok(tail) = candidate.strip_prefix(root) else {
        return false;
    };
    for part in tail.components() {
        match part {
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => return false,
        }
    }
    true
}

fn file(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative_path.is_empty() || relative.is_absolute() || relative.components().any(|part| !matches!(part, Component::Normal(_))) {
        return Err("sandbox paths must be relative".into());
    }
    let output = root.join(relative);
    let parent = output.parent().ok_or("sandbox path has no parent")?;
    // 만들기 **전에** 자리를 확인한다. 예전에는 create_dir_all 이 봉인 검사보다
    // 먼저 돌아서, 거부되기 전에 샌드박스 밖에 디렉터리가 실제로 만들어졌다.
    // 반환값은 Err 였으므로 부르는 쪽은 막혔다고 믿지만 흔적은 남았다.
    if !lexically_inside(root, parent) {
        return Err("sandbox path escape rejected".into());
    }
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    // 만든 뒤 다시 본다. 중간에 symlink 가 끼어 있으면 논리적 검사만으로는
    // 잡히지 않는다.
    if !parent.canonicalize().map_err(|error| error.to_string())?.starts_with(root) {
        return Err("sandbox path escape rejected".into());
    }
    // A pre-planted symlink at the final component would be followed out of the sandbox
    // (parent canonicalize does not cover it). Reject it when present.
    if let Ok(meta) = std::fs::symlink_metadata(&output) {
        if meta.file_type().is_symlink() {
            return Err("sandbox path must not be a symlink".into());
        }
    }
    Ok(output)
}

#[tauri::command]
pub fn app_sandbox_root(adk_path: String, app_id: String) -> Result<String, String> {
    Ok(root(&adk_path, &app_id)?.to_string_lossy().into_owned())
}
#[tauri::command]
pub fn app_sandbox_write_file(adk_path: String, app_id: String, relative_path: String, bytes: Vec<u8>) -> Result<String, String> {
    let output = file(&root(&adk_path, &app_id)?, &relative_path)?;
    write_atomically(&output, &bytes)?;
    Ok(output.to_string_lossy().into_owned())
}

/// 옆에 쓰고 제자리로 옮긴다.
///
/// 왜 필요한가: `fs::write` 는 자르고 나서 쓴다. 두 곳이 같은 파일을 동시에
/// 저장하면 자른 직후와 쓰기 완료 사이에 빈 파일이 보인다 — 앱이 자기 상태를
/// 저장하다 그 순간에 읽으면 빈 것을 얻는다. 동시성 테스트가 실제로 그 빈
/// 내용을 잡았다(2026-09-05).
///
/// 같은 디렉터리에 쓰고 rename 하면 읽는 쪽은 옛 내용이나 새 내용 중 하나만
/// 본다. 마지막에 쓴 쪽이 이기는 것은 그대로이고, 찢어진 중간 상태가
/// 사라진다.
fn write_atomically(output: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = output.parent().ok_or("sandbox path has no parent")?;
    let unique = format!(
        ".{}.{}.tmp",
        output.file_name().and_then(|n| n.to_str()).unwrap_or("out"),
        std::process::id() as u64 * 1_000_000
            + (std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.subsec_nanos() as u64)
                .unwrap_or(0)
                % 1_000_000)
    );
    let staging = parent.join(unique);
    std::fs::write(&staging, bytes).map_err(|error| error.to_string())?;
    match std::fs::rename(&staging, output) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = std::fs::remove_file(&staging);
            Err(error.to_string())
        }
    }
}
#[tauri::command]
pub fn app_sandbox_read_file(adk_path: String, app_id: String, relative_path: String) -> Result<Vec<u8>, String> {
    let output = file(&root(&adk_path, &app_id)?, &relative_path)?;
    if !output.is_file() { return Err("sandbox file does not exist".into()); }
    std::fs::read(&output).map_err(|error| error.to_string())
}
#[tauri::command]
pub fn app_sandbox_open_in_workspace(app: AppHandle, adk_path: String, app_id: String, relative_path: String) -> Result<String, String> {
    let output = file(&root(&adk_path, &app_id)?, &relative_path)?;
    if !output.is_file() { return Err("sandbox file does not exist".into()); }
    let path = output.to_string_lossy().into_owned();
    // Sandbox lives under <adkPath>/data-private/apps, outside the git workspace root,
    // so grant this exact file a session read/write grant (as CLI/drag-drop do) or the
    // workspace viewer rejects it. Emit the granted (canonical) path.
    let granted = crate::workspace::grant_open_file(&path).unwrap_or(path);
    app.emit("workspace-open-file-request", granted.clone()).map_err(|error| error.to_string())?;
    Ok(granted)
}
/// The shell's own toplevel on Linux: its X11 XID and display, or `NotX11`
/// when GTK runs as a native Wayland client. Read on the GTK main thread.
///
/// Takes the calling `Webview`, not a `WebviewWindow`: once the browser app's
/// child webview is attached to the main window, Tauri no longer treats that
/// window as a WebviewWindow (`Window::is_webview_window` requires every
/// webview to share the window label), so a `WebviewWindow` command argument
/// fails with "current webview is not a WebviewWindow" before the command runs.
#[cfg(target_os = "linux")]
fn linux_shell_window(webview: &tauri::Webview) -> Result<crate::slides_recording::LinuxWindow, String> {
    use crate::slides_recording::LinuxWindow;
    let (sender, receiver) = std::sync::mpsc::channel();
    webview
        .with_webview(move |platform| {
            use gtk::prelude::*;
            let found = platform
                .inner()
                .toplevel()
                .and_then(|toplevel| toplevel.window())
                .and_then(|gdk_window| {
                    let display = gdk_window.display().name().to_string();
                    gdk_window
                        .downcast::<gdkx11::X11Window>()
                        .ok()
                        .map(|x11| LinuxWindow::X11 { display: Some(display), xid: x11.xid() as u64 })
                })
                .unwrap_or(LinuxWindow::NotX11);
            let _ = sender.send(found);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "could not read the shell window for MP4 recording".to_string())
}

#[tauri::command]
pub async fn slides_recording_start(webview: tauri::Webview, adk_path: String) -> Result<(), String> {
    let result = slides_recording_start_inner(webview, adk_path).await;
    if let Err(error) = &result {
        crate::log_both(&format!("[slides-recording] start failed: {error}"));
    }
    result
}

async fn slides_recording_start_inner(webview: tauri::Webview, adk_path: String) -> Result<(), String> {
    use crate::slides_recording::{audio_input, capture_target, ffmpeg_args, Platform, Recorder, AUDIO_SOURCE_ENV, STARTUP_PROBE};
    let recording = RECORDING.get_or_init(|| Mutex::new(None));
    if recording.lock().map_err(|_| "recording lock poisoned")?.is_some() {
        return Err("recording already active".into());
    }
    #[cfg(target_os = "linux")]
    let linux = Some(linux_shell_window(&webview)?);
    #[cfg(not(target_os = "linux"))]
    let linux = { let _ = &webview; None };
    let platform = Platform::current();
    let target = capture_target(platform, linux, std::env::var("DISPLAY").ok())?;
    let audio = audio_input(platform, std::env::var(AUDIO_SOURCE_ENV).ok().as_deref());
    let folder = root(&adk_path, "land.naia.slides")?.join("video");
    std::fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_secs();
    let output = folder.join(format!("naia-presentation-{timestamp}.mp4"));
    let ffmpeg = std::env::var_os("NAIA_FFMPEG_PATH").unwrap_or_else(|| "ffmpeg".into());
    let args = ffmpeg_args(&target, &audio, &output);
    crate::log_both(&format!("[slides-recording] start {target:?} audio={audio:?}"));
    tauri::async_runtime::spawn_blocking(move || {
        let recording = RECORDING.get_or_init(|| Mutex::new(None));
        let mut recording = recording.lock().map_err(|_| "recording lock poisoned")?;
        if recording.is_some() { return Err("recording already active".into()); }
        *recording = Some(Recorder::start(&ffmpeg, &args, output, STARTUP_PROBE)?);
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn slides_recording_stop() -> Result<String, String> {
    let result = slides_recording_stop_inner().await;
    if let Err(error) = &result {
        crate::log_both(&format!("[slides-recording] stop failed: {error}"));
    }
    result
}

async fn slides_recording_stop_inner() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let recording = RECORDING.get_or_init(|| Mutex::new(None));
        let recorder = recording.lock().map_err(|_| "recording lock poisoned")?.take().ok_or("recording is not active")?;
        recorder.stop(crate::slides_recording::STOP_GRACE).map(|output| output.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod app_sandbox_escape_tests {
    use super::{file, root, write_atomically};
    // Distinct temp ADK per test process; leaves dirs (test scratch) — acceptable.
    fn adk() -> String {
        std::env::temp_dir()
            .join(format!("naia-sbx-{}", std::process::id()))
            .to_string_lossy()
            .into_owned()
    }
    #[test]
    fn rejects_parent_traversal_app_id() {
        // ".." would escape <adk>/data-private/apps into data-private (codex #1).
        assert!(root(&adk(), "..").is_err());
        assert!(root(&adk(), ".").is_err());
    }
    #[test]
    fn allows_normal_dotted_app_id_and_contains_it() {
        let r = root(&adk(), "land.naia.shell").expect("normal app id ok");
        assert!(r.ends_with("land.naia.shell"));
        assert!(r.to_string_lossy().replace('\\', "/").contains("data-private/apps/land.naia.shell"));
    }

    // root() 만 잠겨 있고 file() 은 잠겨 있지 않았다. 상대경로 강제·부모 탈출
    // 거부·최종 symlink 거부는 각각 다른 공격을 막으므로 따로 고정한다.
    #[test]
    fn rejects_absolute_and_parent_relative_paths() {
        let r = root(&adk(), "sbx.file.tests").expect("root ok");
        assert!(file(&r, "").is_err(), "빈 경로");
        assert!(file(&r, "../escape.txt").is_err(), "부모 탈출");
        assert!(file(&r, "a/../../escape.txt").is_err(), "중간 부모 탈출");
        #[cfg(unix)]
        assert!(file(&r, "/etc/passwd").is_err(), "절대 경로");
    }

    // 거부하는 것만으로는 부족하다. 거부되기 **전에** 무엇이 만들어졌는지도
    // 봐야 한다. 예전에는 디렉터리를 먼저 만들고 나서 자리를 확인했기
    // 때문에, 반환값은 Err 인데 샌드박스 밖에 디렉터리가 실제로 남았다.
    // 앞의 테스트는 반환값만 보아 그 사실을 잡지 못했다.
    //
    // 한 단계만 나간다. 루트를 넘도록 올라가면 `/..` 가 `/` 로 접혀 검사하려던
    // 자리와 실제로 만들어지는 자리가 달라진다 — 처음에 그 탓에 이 테스트가
    // 아무것도 잡지 못했다.
    #[test]
    fn rejected_paths_leave_nothing_behind() {
        let adk = adk();
        let r = root(&adk, "sbx.escape.sideeffect").expect("root ok");
        let outside = r
            .parent()
            .expect("root has a parent")
            .join("naia-sandbox-escape-witness");
        let _ = std::fs::remove_dir_all(&outside);

        let outcome = file(&r, "../naia-sandbox-escape-witness/x.txt");
        assert!(outcome.is_err(), "샌드박스 밖 경로는 거부해야 한다");
        let left_behind = outside.exists();
        let _ = std::fs::remove_dir_all(&outside);
        assert!(
            !left_behind,
            "거부했지만 샌드박스 밖에 자리를 만들었다: {}",
            outside.display()
        );
    }



    #[test]
    fn allows_nested_relative_path_inside_root() {
        let r = root(&adk(), "sbx.file.tests").expect("root ok");
        let out = file(&r, "nested/dir/out.txt").expect("정상 상대경로");
        assert!(out.starts_with(&r), "샌드박스 안에 있어야 한다");
        assert!(out.ends_with("out.txt"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_at_final_component() {
        let r = root(&adk(), "sbx.symlink.tests").expect("root ok");
        let link = r.join("planted.txt");
        let _ = std::fs::remove_file(&link);
        // 미리 심어 둔 symlink 는 parent canonicalize 로 잡히지 않는다.
        std::os::unix::fs::symlink("/etc/passwd", &link).expect("symlink 생성");
        let outcome = file(&r, "planted.txt");
        let _ = std::fs::remove_file(&link);
        assert!(outcome.is_err(), "최종 구성요소 symlink 는 거부해야 한다");
    }

    // 중간 경로에 심어 둔 **디렉터리 symlink** 로 나가려는 시도.
    //
    // 앞의 세 검사는 각각 다른 것을 막는다. 첫째는 `..` 같은 구성요소를,
    // 둘째(lexically_inside)는 만들기 전에 논리적으로 밖인 자리를, 셋째
    // (parent canonicalize)는 **만든 뒤에 symlink 를 따라 밖으로 나간** 자리를
    // 막는다. 그런데 첫째가 `../` 를 먼저 걷어내기 때문에, 앞선 테스트들만으로는
    // 뒤의 둘을 한 번도 지나가지 않는다 — 둘을 통째로 지워도 전부 통과했다.
    //
    // symlink 는 `..` 없이도 밖으로 나가므로 첫 검사를 지나 뒤의 둘에 도달한다.
    // 이 테스트가 그 둘을 고정한다.
    #[cfg(unix)]
    #[test]
    fn rejects_directory_symlink_that_leads_outside() {
        let adk = adk();
        let r = root(&adk, "sbx.symlink.dir").expect("root ok");
        let outside = std::env::temp_dir().join("naia-sandbox-symlink-target");
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&outside).expect("바깥 자리 생성");

        let link = r.join("linked");
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir_all(&link);
        std::os::unix::fs::symlink(&outside, &link).expect("디렉터리 symlink 생성");

        let outcome = file(&r, "linked/pwned.txt");
        let escaped = outside.join("pwned.txt");
        // 경로만 돌려받아도 부르는 쪽이 거기에 쓴다. 승인 자체가 탈출이다.
        let approved = outcome.is_ok();

        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir_all(&outside);
        assert!(
            !approved,
            "샌드박스 안의 symlink 를 따라 밖으로 나가는 경로를 승인했다: {}",
            escaped.display()
        );
    }

    // 안정성 축의 동시성 자리. 앱 두 개가 같은 순간에 자기 구역에 쓰면 서로의
    // 파일을 밟지 않아야 하고, 같은 앱이 같은 파일을 동시에 써도 읽는 쪽이
    // 반쪽짜리를 보지 않아야 한다. 실제로 스레드를 띄워 경쟁시킨다 — 논리만
    // 보는 테스트는 경합을 재지 못한다.
    //
    // 감도에 관하여: 처음에는 한 글자만 썼는데, 그 정도로는 찢어지는 순간이
    // 너무 짧아 비원자적 구현으로 되돌려도 절반쯤은 초록이 나왔다. CI 는 대개
    // 한 번만 돌므로 그런 테스트는 회귀를 절반만 잡는다. 그래서 두 가지를
    // 바꿨다 — 쓰는 내용을 충분히 키우고, 쓰는 **도중에** 읽는 스레드를 함께
    // 돌린다.
    const CONTENDED_ROUNDS: usize = 40;
    const PAYLOAD_BYTES: usize = 64 * 1024;

    fn payload(index: usize) -> Vec<u8> {
        // 한 글자로 가득 채운다. 반쪽만 읽히면 길이가 어긋나고, 다른 스레드의
        // 내용이 섞이면 글자가 어긋난다.
        vec![b'a' + (index as u8 % 8); PAYLOAD_BYTES]
    }

    #[test]
    fn concurrent_writes_stay_in_their_own_sandbox() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use std::thread;

        let adk = adk();
        let done = Arc::new(AtomicBool::new(false));

        // 읽는 쪽. 쓰기가 도는 동안 계속 읽으면서 반쪽짜리를 보는지 감시한다.
        let readers: Vec<_> = (0..2)
            .map(|_| {
                let adk = adk.clone();
                let done = Arc::clone(&done);
                thread::spawn(move || {
                    let r = root(&adk, "sbx.concurrent.0").expect("root ok");
                    let target = file(&r, "shared/contended.bin").expect("path ok");
                    let mut torn: Option<usize> = None;
                    while !done.load(Ordering::Relaxed) {
                        if let Ok(body) = std::fs::read(&target) {
                            if body.len() != PAYLOAD_BYTES
                                || body.iter().any(|byte| *byte != body[0])
                            {
                                torn = Some(body.len());
                                break;
                            }
                        }
                    }
                    torn
                })
            })
            .collect();

        // 쓰는 쪽. 두 앱 구역에서 같은 이름의 파일을 두고 다툰다.
        let writers: Vec<_> = (0..8)
            .map(|index| {
                let adk = adk.clone();
                thread::spawn(move || {
                    let app_id = format!("sbx.concurrent.{}", index % 2);
                    let r = root(&adk, &app_id).expect("root ok");
                    let target = file(&r, "shared/contended.bin").expect("path ok");
                    for _ in 0..CONTENDED_ROUNDS {
                        write_atomically(&target, &payload(index)).expect("write ok");
                    }
                    (app_id, target)
                })
            })
            .collect();

        let written: Vec<_> = writers
            .into_iter()
            .map(|handle| handle.join().expect("writer ok"))
            .collect();
        done.store(true, Ordering::Relaxed);

        for reader in readers {
            let torn = reader.join().expect("reader ok");
            assert!(
                torn.is_none(),
                "쓰는 도중에 반쪽짜리가 읽혔다({} 바이트) — 쓰기가 원자적이지 않다",
                torn.unwrap_or(0)
            );
        }

        for (app_id, path) in written {
            let text = path.to_string_lossy().replace('\\', "/");
            assert!(
                text.contains(&format!("data-private/apps/{app_id}/")),
                "다른 앱 구역으로 샜다: {text}"
            );
            assert!(path.is_file(), "쓰기가 남지 않았다: {text}");
            let body = std::fs::read(&path).expect("read ok");
            assert_eq!(
                body.len(),
                PAYLOAD_BYTES,
                "마지막 쓰기가 온전하지 않다: {} 바이트",
                body.len()
            );
            assert!(
                body.iter().all(|byte| *byte == body[0]),
                "여러 스레드의 내용이 한 파일에 섞였다"
            );
        }
    }
}

/// A `WebviewWindow` command argument only resolves while every webview in
/// the window shares its label (tauri `Window::is_webview_window`). The main
/// window gains the browser app's child webview at startup, after which such a
/// command fails with "current webview is not a WebviewWindow" before its body
/// runs — the 2026-09-24 MP4 recording failure. Commands take `Webview` or
/// `Window` instead.
#[cfg(test)]
mod command_argument_tests {
    fn command_signatures(source: &str) -> Vec<String> {
        let mut signatures = Vec::new();
        let mut rest = source;
        while let Some(at) = rest.find("#[tauri::command]") {
            rest = &rest[at + "#[tauri::command]".len()..];
            let Some(fn_at) = rest.find("fn ") else { break };
            let signature_end = rest[fn_at..].find('{').map(|end| fn_at + end).unwrap_or(rest.len());
            signatures.push(rest[fn_at..signature_end].to_string());
        }
        signatures
    }

    #[test]
    fn no_command_takes_a_webview_window_argument() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        let mut commands = 0;
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
                continue;
            }
            let source = std::fs::read_to_string(&path).unwrap();
            for signature in command_signatures(&source) {
                commands += 1;
                if signature.contains("WebviewWindow") {
                    offenders.push(format!("{}: {}", path.display(), signature.lines().next().unwrap_or("")));
                }
            }
        }
        assert!(commands > 50, "command scan found only {commands} commands");
        assert!(offenders.is_empty(), "commands taking WebviewWindow: {offenders:#?}");
    }

    #[test]
    fn signature_scan_sees_a_webview_window_argument() {
        // Split so this fixture is not itself a command in the scanned source.
        let source = concat!("#[tauri::", "command]\npub async fn f(window: tauri::Webview", "Window, a: String) -> Result<(), String> {\n}");
        assert!(command_signatures(source)[0].contains("WebviewWindow"));
    }
}
