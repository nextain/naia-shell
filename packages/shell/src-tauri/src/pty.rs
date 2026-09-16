use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

// ─── Types ────────────────────────────────────────────────────────────────────

pub(crate) struct PtyHandle {
    pub(crate) master: Box<dyn MasterPty + Send>,
    pub(crate) writer: Box<dyn Write + Send>,
    pub(crate) kind: PtyKind,
    pub(crate) output_attached: bool,
    pub(crate) output_backlog: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PtyKind {
    Shell,
    Herdr,
}

pub type PtyRegistry = Arc<Mutex<HashMap<String, PtyHandle>>>;

pub fn new_registry() -> PtyRegistry {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Cap on the retained pre-attach backlog. Bounds memory for a PTY whose
/// frontend never attaches; a screen's worth of output (including ANSI
/// escapes) comfortably fits well under this.
const OUTPUT_BACKLOG_CAP: usize = 64 * 1024;

/// Decide what to do with a chunk of PTY output, given whether the frontend
/// listener is attached yet. Returns `Some(data)` to emit immediately, or
/// `None` after appending it to the retained (capped) backlog. Pure so the
/// attach/replay behavior is unit-testable without a real PTY or AppHandle.
fn buffer_or_pass_through(attached: bool, backlog: &mut String, data: String) -> Option<String> {
    if attached {
        return Some(data);
    }
    // Retain (do not drain) so a later re-attach — e.g. React StrictMode's
    // double-mount, which installs a fresh event listener after the first
    // one was torn down — can still replay the first frame.
    if backlog.len() < OUTPUT_BACKLOG_CAP {
        backlog.push_str(&data);
    }
    None
}

/// Mark attached and return the retained backlog to replay, if any. Does not
/// drain the backlog, so a subsequent call (a second attach) replays the same
/// retained data again for whatever new listener installed it.
fn attach_replay(attached: &mut bool, backlog: &str) -> Option<String> {
    *attached = true;
    if backlog.is_empty() {
        None
    } else {
        Some(backlog.to_string())
    }
}

/// Preserve PTY output until the frontend confirms that its asynchronous
/// Tauri event listener is installed.
pub(crate) fn emit_or_buffer_pty_output(
    app: &AppHandle,
    registry: &PtyRegistry,
    pty_id: &str,
    data: String,
) {
    let mut handles = registry.lock().unwrap();
    let Some(handle) = handles.get_mut(pty_id) else {
        return;
    };
    let Some(data) =
        buffer_or_pass_through(handle.output_attached, &mut handle.output_backlog, data)
    else {
        return;
    };
    drop(handles);
    let _ = app.emit(&format!("pty:output:{pty_id}"), data);
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyCreated {
    pub pty_id: String,
    pub pid: u32,
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/// Create a new PTY session, spawn `command` in `dir`.
/// Streams output via Tauri event `pty:output:{pty_id}`.
/// Emits `pty:exit:{pty_id}` when the child process exits.
#[tauri::command]
pub async fn pty_create(
    registry: tauri::State<'_, PtyRegistry>,
    app: AppHandle,
    dir: String,
    command: String,
    rows: u16,
    cols: u16,
) -> Result<PtyCreated, String> {
    let registry = Arc::clone(&registry);
    tokio::task::spawn_blocking(move || {
        let pty_system = NativePtySystem::default();
        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = pty_system
            .openpty(size)
            .map_err(|e| format!("openpty failed: {e}"))?;

        // Validate command against an allowlist of known safe shells (CWE-77).
        const ALLOWED_SHELLS: &[&str] = &[
            "bash",
            "/bin/bash",
            "/usr/bin/bash",
            "sh",
            "/bin/sh",
            "/usr/bin/sh",
            "zsh",
            "/bin/zsh",
            "/usr/bin/zsh",
            "fish",
            "/usr/bin/fish",
            "pwsh",
            "powershell",
            "cmd",
            "cmd.exe",
            // Flatpak host shell passthrough
            "flatpak-spawn",
        ];
        let cmd_base = command.split_whitespace().next().unwrap_or("");
        if !ALLOWED_SHELLS.contains(&cmd_base) {
            return Err(format!("Blocked: '{}' is not an allowed shell", cmd_base));
        }

        // Validate dir is absolute and contains no traversal
        let dir_path = std::path::Path::new(&dir);
        if !dir_path.is_absolute() || dir.contains("..") {
            return Err("Invalid working directory".to_string());
        }

        let mut cmd = CommandBuilder::new(&command);
        cmd.cwd(&dir);

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn failed: {e}"))?;

        let pid = child
            .process_id()
            .ok_or_else(|| "failed to get pid".to_string())?;

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take_writer failed: {e}"))?;

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("clone_reader failed: {e}"))?;

        // Generate a unique pty_id
        let pty_id = format!("pty-{pid}");

        // Store handle (master + writer)
        {
            let mut reg = registry.lock().unwrap();
            reg.insert(
                pty_id.clone(),
                PtyHandle {
                    master: pair.master,
                    writer,
                    kind: PtyKind::Shell,
                    output_attached: false,
                    output_backlog: String::new(),
                },
            );
        }

        // Spawn reader task: forward PTY output as Tauri events
        {
            let pty_id_r = pty_id.clone();
            let app_r = app.clone();
            let registry_r = Arc::clone(&registry);
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                let mut reader = reader;
                loop {
                    match std::io::Read::read(&mut *reader, &mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let data = String::from_utf8_lossy(&buf[..n]).to_string();
                            emit_or_buffer_pty_output(&app_r, &registry_r, &pty_id_r, data);
                        }
                    }
                }
                // PTY EOF — child exited; clean up registry and notify frontend
                registry_r.lock().unwrap().remove(&pty_id_r);
                let _ = app_r.emit(&format!("pty:exit:{}", pty_id_r), ());
            });
        }

        // Spawn child-wait thread to handle early exit (before reader EOF)
        {
            let pty_id_w = pty_id.clone();
            let app_w = app.clone();
            let registry_w = Arc::clone(&registry);
            std::thread::spawn(move || {
                // Wait for child exit (blocking)
                let mut child = child;
                let _ = child.wait();
                // Remove if not already removed by reader thread
                let removed = registry_w.lock().unwrap().remove(&pty_id_w).is_some();
                if removed {
                    let _ = app_w.emit(&format!("pty:exit:{}", pty_id_w), ());
                }
            });
        }

        Ok(PtyCreated { pty_id, pid })
    })
    .await
    .map_err(|e| format!("spawn_blocking join: {e}"))?
}

/// Mark the frontend listener ready and replay the retained first-frame
/// backlog. Replays on every call (not just the first) because a second
/// attach — e.g. React StrictMode's double-mount — installs a brand new
/// event listener that never saw the first replay.
#[tauri::command]
pub fn pty_attach(
    registry: tauri::State<'_, PtyRegistry>,
    app: AppHandle,
    pty_id: String,
) -> Result<(), String> {
    let mut handles = registry.lock().unwrap();
    let handle = handles
        .get_mut(&pty_id)
        .ok_or_else(|| format!("pty not found: {pty_id}"))?;
    let backlog = attach_replay(&mut handle.output_attached, &handle.output_backlog);
    drop(handles);
    if let Some(backlog) = backlog {
        app.emit(&format!("pty:output:{pty_id}"), backlog)
            .map_err(|error| format!("PTY attach replay failed: {error}"))?;
    }
    Ok(())
}

/// Write data to PTY stdin (keyboard input).
#[tauri::command]
pub async fn pty_write(
    registry: tauri::State<'_, PtyRegistry>,
    pty_id: String,
    data: String,
) -> Result<(), String> {
    let registry = Arc::clone(&registry);
    tokio::task::spawn_blocking(move || {
        let mut reg = registry.lock().unwrap();
        let handle = reg
            .get_mut(&pty_id)
            .ok_or_else(|| format!("pty not found: {pty_id}"))?;
        handle
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("write failed: {e}"))?;
        handle
            .writer
            .flush()
            .map_err(|e| format!("flush failed: {e}"))
    })
    .await
    .map_err(|e| format!("spawn_blocking join: {e}"))?
}

/// Resize the PTY (called when the terminal container resizes).
#[tauri::command]
pub async fn pty_resize(
    registry: tauri::State<'_, PtyRegistry>,
    pty_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let registry = Arc::clone(&registry);
    tokio::task::spawn_blocking(move || {
        let reg = registry.lock().unwrap();
        let handle = reg
            .get(&pty_id)
            .ok_or_else(|| format!("pty not found: {pty_id}"))?;
        handle
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize failed: {e}"))
    })
    .await
    .map_err(|e| format!("spawn_blocking join: {e}"))?
}

/// Kill the PTY process and remove from registry.
#[tauri::command]
pub async fn pty_kill(
    registry: tauri::State<'_, PtyRegistry>,
    pty_id: String,
) -> Result<(), String> {
    let registry = Arc::clone(&registry);
    tokio::task::spawn_blocking(move || {
        let mut reg = registry.lock().unwrap();
        if reg.remove(&pty_id).is_none() {
            return Err(format!("pty not found: {pty_id}"));
        }
        // The reader/wait threads will notice the master is closed and emit pty:exit
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking join: {e}"))?
}

// ─── Synchronous execute (temporary PTY, capture output) ──────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyExecResult {
    pub success: bool,
    pub output: String,
    pub exit_code: i32,
}

#[tauri::command]
pub async fn pty_execute_sync(
    dir: String,
    command: String,
    timeout_secs: Option<u64>,
) -> Result<PtyExecResult, String> {
    tokio::task::spawn_blocking(move || pty_execute_sync_blocking(dir, command, timeout_secs))
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?
}

fn pty_execute_sync_blocking(
    dir: String,
    command: String,
    timeout_secs: Option<u64>,
) -> Result<PtyExecResult, String> {
    let dir_path = std::path::Path::new(&dir);
    if !dir_path.is_absolute() || dir.contains("..") {
        return Err("Invalid working directory".to_string());
    }
    if command.trim().is_empty() {
        return Err("Command cannot be empty".to_string());
    }

    let timeout = timeout_secs.unwrap_or(60);
    let mut cmd = if cfg!(target_os = "windows") {
        let mut cmd = std::process::Command::new("cmd");
        cmd.arg("/C").arg(&command);
        crate::platform::hide_console(&mut cmd);
        cmd
    } else {
        let mut cmd = std::process::Command::new("bash");
        cmd.arg("-lc").arg(&command);
        cmd
    };
    cmd.current_dir(&dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();

    let stdout_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(ref mut stream) = stdout {
            let _ = stream.read_to_end(&mut buf);
        }
        buf
    });
    let stderr_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(ref mut stream) = stderr {
            let _ = stream.read_to_end(&mut buf);
        }
        buf
    });

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let mut output = stdout_handle.join().unwrap_or_default();
                    let stderr = stderr_handle.join().unwrap_or_default();
                    output.extend_from_slice(&stderr);
                    return Ok(PtyExecResult {
                        success: false,
                        output: String::from_utf8_lossy(&output).to_string(),
                        exit_code: -1,
                    });
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => {
                let _ = child.kill();
                return Err(format!("wait failed: {e}"));
            }
        }
    };

    let mut output = stdout_handle.join().unwrap_or_default();
    let stderr = stderr_handle.join().unwrap_or_default();
    output.extend_from_slice(&stderr);
    let cleaned = String::from_utf8_lossy(&output).to_string();
    let exit_code = status.code().unwrap_or(-1);

    Ok(PtyExecResult {
        success: exit_code == 0,
        output: cleaned,
        exit_code,
    })
}

#[cfg(test)]
mod tests {
    use super::{attach_replay, buffer_or_pass_through};

    /// Regression for #555: React StrictMode double-mounts the Terminal
    /// component, so pty_attach is called twice — once per mounted listener.
    /// The second attach must still receive the PTY's opening frame, not a
    /// silently-drained backlog from the first attach.
    #[test]
    fn second_attach_still_replays_retained_first_output() {
        let mut attached = false;
        let mut backlog = String::new();

        // The reader thread delivers the opening frame before anyone attaches.
        let emitted = buffer_or_pass_through(attached, &mut backlog, "herdr ready\r\n".into());
        assert_eq!(emitted, None, "pre-attach output must be buffered, not emitted");
        assert_eq!(backlog, "herdr ready\r\n");

        // First attach (StrictMode's first mount): replays the opening frame.
        let first = attach_replay(&mut attached, &backlog);
        assert_eq!(first.as_deref(), Some("herdr ready\r\n"));
        assert!(attached);

        // Second attach (StrictMode tears down the first listener and mounts a
        // fresh one): must replay the same retained output again, since the
        // new listener never saw the first replay.
        let second = attach_replay(&mut attached, &backlog);
        assert_eq!(
            second.as_deref(),
            Some("herdr ready\r\n"),
            "second attach must still receive the retained first output"
        );
    }

    #[test]
    fn output_after_attach_passes_through_without_buffering() {
        let attached = true;
        let mut backlog = String::new();

        let emitted = buffer_or_pass_through(attached, &mut backlog, "live output".into());
        assert_eq!(emitted, Some("live output".to_string()));
        assert!(backlog.is_empty(), "attached output must not be buffered");
    }

    #[test]
    fn attach_with_no_output_yet_replays_nothing() {
        let mut attached = false;
        assert_eq!(attach_replay(&mut attached, ""), None);
        assert!(attached);
    }
}
