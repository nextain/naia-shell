use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

// ─── Types ────────────────────────────────────────────────────────────────────

pub(crate) struct PtyHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}

pub type PtyRegistry = Arc<Mutex<HashMap<String, PtyHandle>>>;

pub fn new_registry() -> PtyRegistry {
    Arc::new(Mutex::new(HashMap::new()))
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
pub fn pty_create(
    registry: tauri::State<'_, PtyRegistry>,
    app: AppHandle,
    dir: String,
    command: String,
    rows: u16,
    cols: u16,
) -> Result<PtyCreated, String> {
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
                        let _ = app_r.emit(&format!("pty:output:{}", pty_id_r), data);
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
}

/// Write data to PTY stdin (keyboard input).
#[tauri::command]
pub fn pty_write(
    registry: tauri::State<'_, PtyRegistry>,
    pty_id: String,
    data: String,
) -> Result<(), String> {
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
}

/// Resize the PTY (called when the terminal container resizes).
#[tauri::command]
pub fn pty_resize(
    registry: tauri::State<'_, PtyRegistry>,
    pty_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
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
}

/// Kill the PTY process and remove from registry.
#[tauri::command]
pub fn pty_kill(registry: tauri::State<'_, PtyRegistry>, pty_id: String) -> Result<(), String> {
    let mut reg = registry.lock().unwrap();
    if reg.remove(&pty_id).is_none() {
        return Err(format!("pty not found: {pty_id}"));
    }
    // The reader/wait threads will notice the master is closed and emit pty:exit
    Ok(())
}
