use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::fs::OpenOptions;
use std::io::Read;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::pty::{emit_or_buffer_pty_output, PtyCreated, PtyHandle, PtyKind, PtyRegistry};

use super::config::{
    herdr_bin, herdr_command, herdr_session_name, validate_herdr, write_embedded_herdr_config,
};

static HERDR_LAUNCH_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
const HERDR_SERVER_START_TIMEOUT: Duration = Duration::from_secs(15);
const HERDR_SERVER_RETRY_INTERVAL: Duration = Duration::from_millis(100);

fn probe_herdr_server(config_path: &Path) -> Result<(), String> {
    let output = herdr_command()
        .args(["api", "snapshot"])
        .env("HERDR_CONFIG_PATH", config_path)
        .output()
        .map_err(|error| format!("Herdr server probe failed: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("Herdr server probe exited with {}", output.status)
    })
}

fn herdr_server_log_tail(path: &Path) -> String {
    const LIMIT: usize = 4096;
    let Ok(bytes) = std::fs::read(path) else {
        return String::new();
    };
    let start = bytes.len().saturating_sub(LIMIT);
    String::from_utf8_lossy(&bytes[start..]).trim().to_string()
}

fn server_start_failure(reason: &str, log_path: &Path) -> String {
    let tail = herdr_server_log_tail(log_path);
    if tail.is_empty() {
        format!(
            "Herdr server failed to start: {reason}. Server log: {}",
            log_path.display()
        )
    } else {
        format!(
            "Herdr server failed to start: {reason}. Server log: {}\n{tail}",
            log_path.display()
        )
    }
}

/// A clean Windows profile has no Herdr socket or resident server. Do not rely
/// on the interactive client's implicit spawn: start the headless server,
/// preserve its output, and wait for the API before attaching the PTY client.
/// The caller holds HERDR_LAUNCH_LOCK, so concurrent Workspace opens start at
/// most one server and reuse one that becomes ready during the initial probe.
fn ensure_herdr_server(config_path: &Path, working_dir: &Path) -> Result<(), String> {
    if probe_herdr_server(config_path).is_ok() {
        return Ok(());
    }

    let log_path = crate::log_dir().join("herdr-server.log");
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("Herdr server log unavailable: {error}"))?;
    let stderr = stdout
        .try_clone()
        .map_err(|error| format!("Herdr server log clone failed: {error}"))?;
    let mut command = herdr_command();
    command
        .arg("server")
        .env("HERDR_CONFIG_PATH", config_path)
        .current_dir(working_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    let mut child = command
        .spawn()
        .map_err(|error| server_start_failure(&format!("spawn failed: {error}"), &log_path))?;

    let deadline = Instant::now() + HERDR_SERVER_START_TIMEOUT;
    loop {
        let last_probe_error = match probe_herdr_server(config_path) {
            Ok(()) => return Ok(()),
            Err(error) => error,
        };
        if let Some(status) = child
            .try_wait()
            .map_err(|error| server_start_failure(&format!("status failed: {error}"), &log_path))?
        {
            return Err(server_start_failure(
                &format!("process exited with {status}; last probe: {last_probe_error}"),
                &log_path,
            ));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(server_start_failure(
                &format!("timed out; last probe: {last_probe_error}"),
                &log_path,
            ));
        }
        std::thread::sleep(HERDR_SERVER_RETRY_INTERVAL);
    }
}

fn existing_herdr_id<'a>(entries: impl IntoIterator<Item = (&'a str, PtyKind)>) -> Option<&'a str> {
    entries
        .into_iter()
        .find_map(|(id, kind)| (kind == PtyKind::Herdr).then_some(id))
}

/// Drain one renderable UTF-8 segment from buffered PTY output.
///
/// A trailing partial code point is retained for the next read, but a genuinely
/// invalid byte must be consumed lossily. Leaving an invalid byte at offset zero
/// would make every later flush return without progress and permanently wedge the
/// embedded terminal even though Herdr and its server are both healthy.
fn drain_pty_output(pending: &mut Vec<u8>, force: bool) -> Option<String> {
    if pending.is_empty() {
        return None;
    }
    let cut = if force {
        pending.len()
    } else {
        match std::str::from_utf8(pending) {
            Ok(_) => pending.len(),
            Err(error) if error.error_len().is_none() => error.valid_up_to(),
            Err(error) => error.valid_up_to() + error.error_len().unwrap_or(1),
        }
    };
    if cut == 0 {
        return None;
    }
    let data = String::from_utf8_lossy(&pending[..cut]).to_string();
    pending.drain(..cut);
    Some(data)
}

/// Emit buffered PTY output as one `pty:output` event, keeping only a trailing
/// incomplete UTF-8 sequence in `pending` for the next flush (unless `force`).
fn flush_pty_output(
    app: &AppHandle,
    registry: &PtyRegistry,
    id: &str,
    pending: &mut Vec<u8>,
    force: bool,
) {
    if let Some(data) = drain_pty_output(pending, force) {
        emit_or_buffer_pty_output(app, registry, id, data);
    }
}

/// Launch the real Herdr client in a dedicated PTY. The frontend cannot choose
/// an executable, argument, or environment variable. Repeated calls reuse the
/// live embedded client rather than attaching a second client.
#[tauri::command]
pub async fn herdr_pty_create(
    registry: tauri::State<'_, PtyRegistry>,
    app: AppHandle,
    dir: String,
    rows: u16,
    cols: u16,
) -> Result<PtyCreated, String> {
    let dir_path =
        dunce::canonicalize(&dir).map_err(|e| format!("Invalid Herdr working directory: {e}"))?;
    if !dir_path.is_dir() {
        return Err("Herdr working directory is not a directory".to_string());
    }
    validate_herdr()?;
    let config_path = write_embedded_herdr_config(&app)?;
    let registry = Arc::clone(&registry);

    tokio::task::spawn_blocking(move || {
        let _launch_guard = HERDR_LAUNCH_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| "Herdr launch lock poisoned".to_string())?;
        let existing_id = {
            let handles = registry.lock().unwrap();
            existing_herdr_id(
                handles
                    .iter()
                    .map(|(id, handle)| (id.as_str(), handle.kind)),
            )
            .map(str::to_owned)
        };
        if let Some(pty_id) = existing_id {
            ensure_herdr_server(&config_path, &dir_path)?;
            let pid = pty_id
                .strip_prefix("pty-")
                .and_then(|value| value.parse().ok())
                .unwrap_or_default();
            return Ok(PtyCreated { pty_id, pid });
        }

        ensure_herdr_server(&config_path, &dir_path)?;

        let pair = NativePtySystem::default()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("open Herdr PTY failed: {e}"))?;
        let mut command = CommandBuilder::new(herdr_bin());
        // 하네스에서는 사람의 herdr 세션에 붙지 않는다 — `herdr_session_name` 을 보라.
        // `--session` 은 전역 옵션이라 다른 인자보다 앞에 온다.
        if let Some(session) = herdr_session_name() {
            command.arg("--session");
            command.arg(session);
        }
        command.cwd(&dir_path);
        command.env("HERDR_CONFIG_PATH", &config_path);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");

        // Inject `naia` CLI interceptor to open files in the GUI viewer
        let wrapper_dir = ensure_naia_wrapper_dir(&config_path);
        let new_path = if let Ok(old_path) = std::env::var("PATH") {
            let mut paths = vec![wrapper_dir];
            paths.extend(std::env::split_paths(&old_path));
            std::env::join_paths(paths)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| old_path)
        } else {
            wrapper_dir.to_string_lossy().to_string()
        };
        command.env("PATH", new_path);
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| format!("Herdr spawn failed: {e}"))?;
        let pid = child
            .process_id()
            .ok_or_else(|| "Herdr PID unavailable".to_string())?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Herdr PTY writer failed: {e}"))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Herdr PTY reader failed: {e}"))?;
        let pty_id = format!("pty-{pid}");
        registry.lock().unwrap().insert(
            pty_id.clone(),
            PtyHandle {
                master: pair.master,
                writer,
                kind: PtyKind::Herdr,
                output_attached: false,
                output_backlog: String::new(),
            },
        );

        let reader_id = pty_id.clone();
        let reader_app = app.clone();
        let reader_registry = Arc::clone(&registry);
        std::thread::spawn(move || {
            // Coalesce PTY output into ~8ms windows so a heavy TUI redraw does not
            // flood the IPC bridge with one event per read. A dedicated read
            // sub-thread feeds raw 64KB chunks; this thread batches and emits them.
            use std::sync::mpsc::{self, RecvTimeoutError};
            use std::time::{Duration, Instant};
            const FLUSH: Duration = Duration::from_millis(8);
            const MAX_PENDING: usize = 256 * 1024;
            let (tx, rx) = mpsc::channel::<Vec<u8>>();
            let read_log_id = reader_id.clone();
            let read_thread = std::thread::spawn(move || {
                let mut reader = reader;
                let mut buffer = [0_u8; 65536];
                let mut first_chunk = true;
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => {
                            crate::log_verbose(&format!(
                                "[herdr_pty] reader eof pty_id={read_log_id}"
                            ));
                            break;
                        }
                        Ok(count) => {
                            if first_chunk {
                                crate::log_verbose(&format!(
                                    "[herdr_pty] first output pty_id={read_log_id} bytes={count}"
                                ));
                                first_chunk = false;
                            }
                            if tx.send(buffer[..count].to_vec()).is_err() {
                                break;
                            }
                        }
                        Err(error) => {
                            crate::log_verbose(&format!(
                                "[herdr_pty] reader error pty_id={read_log_id} error={error}"
                            ));
                            break;
                        }
                    }
                }
            });
            let mut pending: Vec<u8> = Vec::new();
            let mut deadline = Instant::now() + FLUSH;
            loop {
                let timeout = deadline.saturating_duration_since(Instant::now());
                match rx.recv_timeout(timeout) {
                    Ok(chunk) => {
                        pending.extend_from_slice(&chunk);
                        if pending.len() >= MAX_PENDING {
                            flush_pty_output(
                                &reader_app,
                                &reader_registry,
                                &reader_id,
                                &mut pending,
                                false,
                            );
                            deadline = Instant::now() + FLUSH;
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        flush_pty_output(
                            &reader_app,
                            &reader_registry,
                            &reader_id,
                            &mut pending,
                            false,
                        );
                        deadline = Instant::now() + FLUSH;
                    }
                    Err(RecvTimeoutError::Disconnected) => {
                        flush_pty_output(
                            &reader_app,
                            &reader_registry,
                            &reader_id,
                            &mut pending,
                            true,
                        );
                        break;
                    }
                }
            }
            let _ = read_thread.join();
            reader_registry.lock().unwrap().remove(&reader_id);
            let _ = reader_app.emit(&format!("pty:exit:{reader_id}"), ());
        });

        let wait_id = pty_id.clone();
        let wait_app = app;
        let wait_registry = Arc::clone(&registry);
        std::thread::spawn(move || {
            let mut child = child;
            let _ = child.wait();
            if wait_registry.lock().unwrap().remove(&wait_id).is_some() {
                let _ = wait_app.emit(&format!("pty:exit:{wait_id}"), ());
            }
        });
        Ok(PtyCreated { pty_id, pid })
    })
    .await
    .map_err(|e| format!("Herdr spawn task failed: {e}"))?
}

/// Ensure the `naia` CLI interceptor wrapper directory exists and contains
/// the shim script that forwards single-file arguments to the GUI shell.
pub(super) fn ensure_naia_wrapper_dir(config_path: &std::path::Path) -> std::path::PathBuf {
    let wrapper_dir = config_path
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join("bin");
    let _ = std::fs::create_dir_all(&wrapper_dir);
    let wrapper_script = wrapper_dir.join("naia");

    let current_exe = std::env::current_exe()
        .unwrap_or_else(|_| std::path::PathBuf::from("naia-shell"));

    let script_content = format!(
        r#"#!/bin/bash
if [ "$#" -eq 1 ] && [ -f "$1" ]; then
    exec "{}" "$1"
else
    # Find the next naia in PATH and execute it
    NEXT_NAIA=$(which -a naia 2>/dev/null | grep -v "{}" | head -n 1)
    if [ -n "$NEXT_NAIA" ]; then
        exec "$NEXT_NAIA" "$@"
    else
        echo "naia: command not found"
        exit 127
    fi
fi
"#,
        current_exe.display(),
        wrapper_script.display()
    );
    let _ = std::fs::write(&wrapper_script, script_content);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = std::fs::metadata(&wrapper_script) {
            let mut perms = metadata.permissions();
            perms.set_mode(0o755);
            let _ = std::fs::set_permissions(&wrapper_script, perms);
        }
    }

    #[cfg(windows)]
    {
        let cmd_script = wrapper_dir.join("naia.cmd");
        let cmd_content = format!(
            "@echo off\r\n\
if not \"%~1\"==\"\" if \"%~2\"==\"\" if exist \"%~1\" (\r\n\
    \"{}\" \"%~1\"\r\n\
    exit /b %ERRORLEVEL%\r\n\
)\r\n\
for /f \"delims=\" %%%%i in ('where naia 2^>nul ^| findstr /v /i \"{}\"') do (\r\n\
    \"%%%%i\" %*\r\n\
    exit /b %ERRORLEVEL%\r\n\
)\r\n\
echo naia: command not found 1>&2\r\n\
exit /b 127\r\n",
            current_exe.display(),
            wrapper_dir.display()
        );
        let _ = std::fs::write(&cmd_script, cmd_content);
    }

    wrapper_dir
}

#[cfg(test)]
mod tests {
    use super::{drain_pty_output, existing_herdr_id, server_start_failure};
    use crate::pty::PtyKind;
    use std::fs::{create_dir_all, remove_dir_all, write};

    #[test]
    fn reuses_only_herdr_and_never_an_ordinary_shell_pty() {
        let entries = [
            ("pty-11", PtyKind::Shell),
            ("pty-22", PtyKind::Herdr),
            ("pty-33", PtyKind::Shell),
        ];
        assert_eq!(existing_herdr_id(entries), Some("pty-22"));
        assert_eq!(existing_herdr_id([("pty-11", PtyKind::Shell)]), None);
    }

    #[test]
    fn server_failure_preserves_exit_probe_and_log_evidence() {
        let root =
            std::env::temp_dir().join(format!("naia-herdr-server-failure-{}", std::process::id()));
        create_dir_all(&root).unwrap();
        let log = root.join("herdr-server.log");
        write(&log, "server stderr evidence").unwrap();
        let message = server_start_failure(
            "process exited with code 7; last probe: server_not_running",
            &log,
        );
        assert!(message.contains("code 7"));
        assert!(message.contains("server_not_running"));
        assert!(message.contains("server stderr evidence"));
        assert!(message.contains("herdr-server.log"));
        remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_leading_byte_cannot_wedge_later_terminal_frames() {
        let mut pending = vec![0xff];
        pending.extend_from_slice(b"\x1b[2JHerdr");

        let first = drain_pty_output(&mut pending, false).expect("invalid byte is consumed");
        assert_eq!(first, "\u{fffd}");
        let frame = drain_pty_output(&mut pending, false).expect("later frame remains readable");
        assert_eq!(frame, "\x1b[2JHerdr");
        assert!(pending.is_empty());
    }

    #[test]
    fn incomplete_utf8_tail_waits_for_the_next_read() {
        let mut pending = vec![b'A', 0xe2, 0x82];
        assert_eq!(drain_pty_output(&mut pending, false).as_deref(), Some("A"));
        assert_eq!(pending, vec![0xe2, 0x82]);

        pending.push(0xac);
        assert_eq!(drain_pty_output(&mut pending, false).as_deref(), Some("€"));
        assert!(pending.is_empty());
    }

    #[test]
    fn naia_wrapper_generates_executable_interceptor() {
        let root = std::env::temp_dir().join(format!("naia-wrapper-test-{}", std::process::id()));
        let config = root.join("config.toml");
        let wrapper_dir = super::ensure_naia_wrapper_dir(&config);
        assert_eq!(wrapper_dir, root.join("bin"));
        let script = wrapper_dir.join("naia");
        assert!(script.is_file());
        let content = std::fs::read_to_string(&script).unwrap();
        assert!(content.contains("#!/bin/bash"));
        assert!(content.contains(r#"[ "$#" -eq 1 ] && [ -f "$1" ]"#));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&script).unwrap().permissions().mode();
            assert_ne!(mode & 0o111, 0, "wrapper script must be executable");
        }
        let _ = std::fs::remove_dir_all(root);
    }
}
