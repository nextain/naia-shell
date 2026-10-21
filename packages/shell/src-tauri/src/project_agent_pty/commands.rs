use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::io::Write;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use crate::project_catalog_runtime::{resolve_project_checkout, ProjectCatalogAuthority};

use super::lifecycle::{authorized_project_session_path, stop_project_agent_handle};
use super::types::{
    display_path, emit_or_buffer_project_agent_output, find_agent_executable,
    find_project_agent_handle, find_project_agent_handle_mut, project_agent_key,
    project_agent_session, safe_app_id_for_log, CodingApp, ProjectAgentAvailability,
    ProjectAgentExitEvent, ProjectAgentHandle, ProjectAgentOutputEvent, ProjectAgentRegistry,
    ProjectAgentSession, CODING_APPS, PROJECT_AGENT_SESSION_COUNTER,
};

#[tauri::command]
pub fn project_agent_availability() -> Vec<ProjectAgentAvailability> {
    crate::log_verbose("[project_agent_pty::project_agent_availability] enter");
    let path = std::env::var_os("PATH");
    let available = CODING_APPS
        .iter()
        .map(|spec| ProjectAgentAvailability {
            app_id: spec.app_id.to_owned(),
            available: find_agent_executable(spec.app, path.as_deref()).is_some(),
        })
        .collect::<Vec<_>>();
    crate::log_verbose(&format!(
        "[project_agent_pty::project_agent_availability] branch=availability_checked app_count={} available_count={}",
        available.len(),
        available.iter().filter(|entry| entry.available).count()
    ));
    available
}

#[tauri::command]
pub async fn project_agent_pty_start(
    registry: State<'_, ProjectAgentRegistry>,
    authority: State<'_, ProjectCatalogAuthority>,
    app: AppHandle,
    app_id: String,
    project_path: String,
    adapter_root: String,
) -> Result<ProjectAgentSession, String> {
    crate::log_verbose(&format!(
        "[project_agent_pty::project_agent_pty_start] enter app_id={} project_path_supplied=true",
        safe_app_id_for_log(&app_id)
    ));
    let coding_app = CodingApp::parse(&app_id).map_err(|error| {
        log::warn!("[project_agent_pty::project_agent_pty_start] branch=agent_invalid");
        error
    })?;
    let resolved = resolve_project_checkout(&authority, &adapter_root, &project_path)?;
    let key = project_agent_key(&resolved.project_path, coding_app)?;
    let executable = find_agent_executable(coding_app, std::env::var_os("PATH").as_deref())
        .ok_or_else(|| {
            crate::log_verbose(&format!(
                "[project_agent_pty::project_agent_pty_start] branch=agent_not_available app_id={}",
                coding_app.spec().app_id
            ));
            "agent_unavailable".to_owned()
        })?;
    let checkout_path = resolved.checkout_path;
    let registry = Arc::clone(&registry);
    let session_app_id = coding_app.spec().app_id.to_owned();
    tokio::task::spawn_blocking(move || -> Result<ProjectAgentSession, String> {
        let mut state = registry.lock().unwrap();
        if let Some(handle) = state.sessions.get(&key) {
            crate::log_verbose(&format!(
                "[project_agent_pty::project_agent_pty_start] branch=reuse_existing app_id={}",
                session_app_id
            ));
            return Ok(project_agent_session(&key, handle));
        }

        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize {
                rows: 30,
                cols: 100,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|_| {
                crate::log_verbose("[project_agent_pty::project_agent_pty_start] branch=openpty_failed");
                "agent_unavailable".to_owned()
            })?;
        let writer = pair.master.take_writer().map_err(|_| {
            crate::log_verbose("[project_agent_pty::project_agent_pty_start] branch=writer_unavailable");
            "agent_unavailable".to_owned()
        })?;
        let reader = pair.master.try_clone_reader().map_err(|_| {
            crate::log_verbose("[project_agent_pty::project_agent_pty_start] branch=reader_unavailable");
            "agent_unavailable".to_owned()
        })?;
        let mut command = CommandBuilder::new(&executable);
        for argument in coding_app.spec().argv {
            command.arg(argument);
        }
        command.cwd(&checkout_path);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        let mut child = pair.slave.spawn_command(command).map_err(|_| {
            crate::log_verbose(&format!(
                "[project_agent_pty::project_agent_pty_start] branch=spawn_failed app_id={}",
                session_app_id
            ));
            "agent_unavailable".to_owned()
        })?;
        let Some(pid) = child.process_id() else {
            crate::log_verbose("[project_agent_pty::project_agent_pty_start] branch=pid_unavailable");
            let _ = child.kill();
            let _ = child.wait();
            return Err("agent_unavailable".to_owned());
        };
        let killer = child.clone_killer();
        let session_number = PROJECT_AGENT_SESSION_COUNTER.fetch_add(1, Ordering::Relaxed);
        let pty_id = format!("project-pty-{pid}-{session_number}");
        let canonical_display_path = display_path(&key.project_path);
        let handle = ProjectAgentHandle {
            pty_id: pty_id.clone(),
            pid,
            master: pair.master,
            writer,
            killer,
            termination_requested: false,
            // The frontend installs its global event listeners before invoking
            // this command, so output may be emitted immediately.
            output_attached: true,
            output_backlog: String::new(),
        };
        state.sessions.insert(key.clone(), handle);
        drop(state);

        let reader_key = key.clone();
        let reader_pty_id = pty_id.clone();
        let reader_app = app.clone();
        let reader_registry = Arc::clone(&registry);
        std::thread::spawn(move || {
            crate::log_verbose(&format!(
                "[project_agent_pty::project_agent_output_reader] enter app_id={}",
                reader_key.app.spec().app_id
            ));
            let mut bytes = [0u8; 4096];
            let mut reader = reader;
            loop {
                match reader.read(&mut bytes) {
                    Ok(0) => {
                        crate::log_verbose("[project_agent_pty::project_agent_output_reader] branch=pty_eof");
                        break;
                    }
                    Ok(length) => {
                        let data = String::from_utf8_lossy(&bytes[..length]).to_string();
                        emit_or_buffer_project_agent_output(
                            &reader_app,
                            &reader_registry,
                            &reader_key,
                            &reader_pty_id,
                            data,
                        );
                    }
                    Err(_) => {
                        crate::log_verbose("[project_agent_pty::project_agent_output_reader] branch=read_failed");
                        break;
                    }
                }
            }
        });

        let wait_key = key.clone();
        let wait_pty_id = pty_id.clone();
        let wait_app_id = session_app_id.clone();
        let wait_registry = Arc::clone(&registry);
        std::thread::spawn(move || {
            crate::log_verbose(&format!(
                "[project_agent_pty::project_agent_waiter] enter app_id={}",
                wait_app_id
            ));
            let mut child = child;
            let exit_code = child.wait().ok().map(|status| status.exit_code() as i32);
            let removed = {
                let mut state = wait_registry.lock().unwrap();
                if state
                    .sessions
                    .get(&wait_key)
                    .is_some_and(|handle| handle.pty_id == wait_pty_id)
                {
                    state.sessions.remove(&wait_key);
                    true
                } else {
                    false
                }
            };
            if removed {
                crate::log_verbose(&format!(
                    "[project_agent_pty::project_agent_waiter] branch=session_exited app_id={} exit_known={}",
                    wait_app_id,
                    exit_code.is_some()
                ));
                let event = ProjectAgentExitEvent {
                    app_id: wait_key.app.spec().app_id.to_owned(),
                    project_path: display_path(&wait_key.project_path),
                    pty_id: wait_pty_id,
                    exit_code,
                };
                let _ = app.emit("project-agent-pty-exit", event);
            }
        });

        crate::log_verbose(&format!(
            "[project_agent_pty::project_agent_pty_start] branch=session_started app_id={} pid={}",
            session_app_id, pid
        ));
        Ok(ProjectAgentSession {
            app_id: session_app_id,
            project_path: canonical_display_path,
            pty_id,
            running: true,
        })
    })
    .await
    .map_err(|_| "agent_unavailable".to_owned())?
}

#[tauri::command]
pub fn project_agent_pty_attach(
    registry: State<'_, ProjectAgentRegistry>,
    authority: State<'_, ProjectCatalogAuthority>,
    app: AppHandle,
    app_id: String,
    project_path: String,
    adapter_root: String,
) -> Result<ProjectAgentSession, String> {
    crate::log_verbose(&format!(
        "[project_agent_pty::project_agent_pty_attach] enter app_id={} project_path_supplied=true",
        safe_app_id_for_log(&app_id)
    ));
    let coding_app = CodingApp::parse(&app_id)?;
    let authorized_path = authorized_project_session_path(
        &authority,
        &adapter_root,
        &project_path,
    )
    .map_err(|error| {
        crate::log_verbose(&format!(
            "[project_agent_pty::project_agent_pty_attach] branch=project_authority_rejected app_id={}",
            safe_app_id_for_log(&app_id)
        ));
        error
    })?;
    let key = project_agent_key(&authorized_path, coding_app)?;
    let mut state = registry.lock().unwrap();
    let handle = find_project_agent_handle_mut(&mut state, &key)?;
    handle.output_attached = true;
    let replay = (!handle.output_backlog.is_empty()).then(|| handle.output_backlog.clone());
    let backlog_replayed = replay.is_some();
    let session = project_agent_session(&key, handle);
    drop(state);
    if let Some(data) = replay {
        let event = ProjectAgentOutputEvent {
            app_id: session.app_id.clone(),
            project_path: session.project_path.clone(),
            pty_id: session.pty_id.clone(),
            data,
        };
        app.emit("project-agent-pty-output", event)
            .map_err(|_| "session_mismatch".to_owned())?;
    }
    crate::log_verbose(&format!(
        "[project_agent_pty::project_agent_pty_attach] branch=attached app_id={} backlog_replayed={}",
        coding_app.spec().app_id,
        backlog_replayed
    ));
    Ok(session)
}

#[tauri::command]
pub async fn project_agent_pty_write(
    registry: State<'_, ProjectAgentRegistry>,
    authority: State<'_, ProjectCatalogAuthority>,
    app_id: String,
    project_path: String,
    adapter_root: String,
    data: String,
) -> Result<(), String> {
    crate::log_verbose(&format!(
        "[project_agent_pty::project_agent_pty_write] enter app_id={} data_bytes={}",
        safe_app_id_for_log(&app_id),
        data.len()
    ));
    let coding_app = CodingApp::parse(&app_id).map_err(|error| {
        log::warn!("[project_agent_pty::project_agent_pty_write] branch=agent_invalid");
        error
    })?;
    let authorized_path = authorized_project_session_path(
        &authority,
        &adapter_root,
        &project_path,
    )
    .map_err(|error| {
        log::warn!(
            "[project_agent_pty::project_agent_pty_write] branch=project_authority_rejected error_code=project_unverified"
        );
        error
    })?;
    let key = project_agent_key(&authorized_path, coding_app).map_err(|error| {
        log::warn!(
            "[project_agent_pty::project_agent_pty_write] branch=session_key_normalization_failed error_code=project_unverified"
        );
        error
    })?;
    let registry = Arc::clone(&registry);
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut state = registry.lock().unwrap();
        let handle = match find_project_agent_handle_mut(&mut state, &key) {
            Ok(handle) => handle,
            Err(error_code) => {
                log::warn!("[project_agent_pty::project_agent_pty_write] branch={error_code}");
                return Err(error_code);
            }
        };
        write_project_agent_input(handle.writer.as_mut(), data.as_bytes())
    })
    .await
    .map_err(map_project_agent_write_join_error)?
}

fn write_project_agent_input(writer: &mut dyn Write, data: &[u8]) -> Result<(), String> {
    writer.write_all(data).map_err(|error| {
        let code = format!("write_failed:{:?}", error.kind());
        log::warn!(
            "[project_agent_pty::project_agent_pty_write] branch=write_failed error_kind={:?}",
            error.kind()
        );
        code
    })?;
    writer.flush().map_err(|error| {
        let code = format!("flush_failed:{:?}", error.kind());
        log::warn!(
            "[project_agent_pty::project_agent_pty_write] branch=flush_failed error_kind={:?}",
            error.kind()
        );
        code
    })
}

fn map_project_agent_write_join_error(error: tokio::task::JoinError) -> String {
    log::warn!(
        "[project_agent_pty::project_agent_pty_write] branch=join_failed task_panicked={}",
        error.is_panic()
    );
    "join_failed".to_owned()
}

#[tauri::command]
pub async fn project_agent_pty_resize(
    registry: State<'_, ProjectAgentRegistry>,
    authority: State<'_, ProjectCatalogAuthority>,
    app_id: String,
    project_path: String,
    adapter_root: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    crate::log_verbose(&format!(
        "[project_agent_pty::project_agent_pty_resize] enter app_id={} rows={} cols={}",
        safe_app_id_for_log(&app_id),
        rows,
        cols
    ));
    let coding_app = CodingApp::parse(&app_id)?;
    let normalized_path = authorized_project_session_path(
        &authority,
        &adapter_root,
        &project_path,
    )
    .map_err(|error| {
        crate::log_verbose(&format!(
            "[project_agent_pty::project_agent_pty_resize] branch=project_authority_rejected app_id={}",
            safe_app_id_for_log(&app_id)
        ));
        error
    })?;
    let key = project_agent_key(&normalized_path, coding_app)?;
    let registry = Arc::clone(&registry);
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let state = registry.lock().unwrap();
        let handle = find_project_agent_handle(&state, &key)?;
        handle
            .master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|_| {
                crate::log_verbose(
                    "[project_agent_pty::project_agent_pty_resize] branch=resize_failed",
                );
                "session_missing".to_owned()
            })
    })
    .await
    .map_err(|_| "session_missing".to_owned())?
}

#[tauri::command]
pub async fn project_agent_pty_stop(
    registry: State<'_, ProjectAgentRegistry>,
    authority: State<'_, ProjectCatalogAuthority>,
    app_id: String,
    project_path: String,
    adapter_root: String,
) -> Result<(), String> {
    crate::log_verbose(&format!(
        "[project_agent_pty::project_agent_pty_stop] enter app_id={} project_path_supplied=true",
        safe_app_id_for_log(&app_id)
    ));
    let coding_app = CodingApp::parse(&app_id)?;
    let normalized_path = authorized_project_session_path(
        &authority,
        &adapter_root,
        &project_path,
    )
    .map_err(|error| {
        crate::log_verbose(&format!(
            "[project_agent_pty::project_agent_pty_stop] branch=project_authority_rejected app_id={}",
            safe_app_id_for_log(&app_id)
        ));
        error
    })?;
    let key = project_agent_key(&normalized_path, coding_app)?;
    let registry = Arc::clone(&registry);
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut state = registry.lock().unwrap();
        let handle = find_project_agent_handle_mut(&mut state, &key)?;
        stop_project_agent_handle(handle)
    })
    .await
    .map_err(|_| "session_missing".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    #[test]
    fn stop_and_resize_session_keys_match_start_and_write_keys() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("projects/sample");
        std::fs::create_dir_all(&project).unwrap();
        let resolved = dunce::canonicalize(&project).unwrap();

        let start_write_key = project_agent_key(&project, CodingApp::Claude).unwrap();
        let resize_key = project_agent_key(&resolved, CodingApp::Claude).unwrap();
        let stop_key = project_agent_key(&dunce::simplified(&resolved), CodingApp::Claude).unwrap();

        assert_eq!(resize_key, start_write_key);
        assert_eq!(stop_key, start_write_key);
    }

    struct FaultyWriter {
        write_error: Option<io::ErrorKind>,
        flush_error: Option<io::ErrorKind>,
    }

    impl Write for FaultyWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if let Some(kind) = self.write_error {
                return Err(io::Error::new(kind, "test write failure"));
            }
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            if let Some(kind) = self.flush_error {
                return Err(io::Error::new(kind, "test flush failure"));
            }
            Ok(())
        }
    }

    #[test]
    fn project_agent_write_returns_distinct_write_and_flush_error_codes() {
        let mut write_failure = FaultyWriter {
            write_error: Some(io::ErrorKind::BrokenPipe),
            flush_error: None,
        };
        let mut flush_failure = FaultyWriter {
            write_error: None,
            flush_error: Some(io::ErrorKind::WouldBlock),
        };

        assert_eq!(
            write_project_agent_input(&mut write_failure, b"input"),
            Err("write_failed:BrokenPipe".to_owned())
        );
        assert_eq!(
            write_project_agent_input(&mut flush_failure, b"input"),
            Err("flush_failed:WouldBlock".to_owned())
        );
    }

    #[tokio::test]
    async fn project_agent_write_returns_a_distinct_join_error_code() {
        let join_error = tokio::task::spawn_blocking(|| panic!("test worker panic"))
            .await
            .unwrap_err();

        assert_eq!(
            map_project_agent_write_join_error(join_error),
            "join_failed"
        );
    }

    #[cfg(windows)]
    #[test]
    fn project_agent_conpty_writer_roundtrips_line_without_interactive_session() {
        use portable_pty::{NativePtySystem, PtySize, PtySystem};
        use std::io::Read;
        use std::sync::mpsc;
        use std::time::Duration;

        const MARKER: &str = "PTY_INPUT_756_PROBE";
        let pair = NativePtySystem::default()
            .openpty(PtySize {
                rows: 25,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open Windows ConPTY");
        let mut command = CommandBuilder::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-Command",
            "$line=[Console]::In.ReadLine(); Write-Output ('ECHO:'+$line)",
        ]);
        let mut child = pair.slave.spawn_command(command).expect("spawn PowerShell");
        let mut reader = pair.master.try_clone_reader().expect("clone ConPTY reader");
        let writer = std::sync::Arc::new(std::sync::Mutex::new(
            pair.master.take_writer().expect("take ConPTY writer"),
        ));
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let (output_tx, output_rx) = mpsc::sync_channel(1);
        let reply_writer = std::sync::Arc::clone(&writer);
        let reader_seen = std::sync::Arc::clone(&seen);
        std::thread::spawn(move || {
            // ConPTY starts with a cursor-position request (ESC[6n) and waits
            // for the terminal's answer. xterm.js answers it in the app; this
            // test stands in for that terminal so the console does not stall.
            let mut answered = 0usize;
            let mut buffer = [0u8; 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        let bytes = reader_seen.lock().unwrap().clone();
                        let _ = output_tx.send(String::from_utf8_lossy(&bytes).into_owned());
                        return;
                    }
                    Ok(length) => {
                        let output = {
                            let mut bytes = reader_seen.lock().unwrap();
                            bytes.extend_from_slice(&buffer[..length]);
                            String::from_utf8_lossy(&bytes).into_owned()
                        };
                        let requests = output.matches("\x1b[6n").count();
                        while answered < requests {
                            let mut terminal = reply_writer.lock().unwrap();
                            let _ = write_project_agent_input(&mut **terminal, b"\x1b[1;1R");
                            answered += 1;
                        }
                        let _ = ready_tx.try_send(());
                        if output.contains(&format!("ECHO:{MARKER}")) {
                            let _ = output_tx.send(output);
                            return;
                        }
                    }
                    Err(error) => {
                        let _ = output_tx.send(format!("reader_error:{:?}", error.kind()));
                        return;
                    }
                }
            }
        });

        // Type the line once the console has produced its first output (or
        // after a short grace period), like a user typing into a live terminal.
        let _ = ready_rx.recv_timeout(Duration::from_secs(5));
        {
            let mut terminal = writer.lock().unwrap();
            write_project_agent_input(&mut **terminal, format!("{MARKER}\r").as_bytes())
                .expect("write a line through the production ConPTY writer");
        }
        let output = output_rx.recv_timeout(Duration::from_secs(20));
        let _ = child.kill();
        let _ = child.wait();
        let output = output.unwrap_or_else(|_| {
            let bytes = seen.lock().unwrap().clone();
            panic!(
                "receive ConPTY output within 20 seconds; partial output: {:?}",
                String::from_utf8_lossy(&bytes)
            )
        });
        assert!(
            output.contains(&format!("ECHO:{MARKER}")),
            "PowerShell did not echo the line through ConPTY: {output:?}"
        );
    }
}
