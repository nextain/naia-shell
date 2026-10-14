use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::io::Write;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

use crate::project_catalog_runtime::{resolve_project_checkout, ProjectCatalogAuthority};

use super::types::{
    display_path, emit_or_buffer_project_agent_output, find_agent_executable,
    find_project_agent_handle, find_project_agent_handle_mut, normalize_project_session_path,
    project_agent_session, safe_app_id_for_log, CodingApp, ProjectAgentAvailability,
    ProjectAgentExitEvent, ProjectAgentHandle, ProjectAgentKey, ProjectAgentOutputEvent,
    ProjectAgentRegistry, ProjectAgentSession, CODING_APPS, PROJECT_AGENT_SESSION_COUNTER,
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
    let coding_app = CodingApp::parse(&app_id)?;
    let resolved = resolve_project_checkout(&authority, &adapter_root, &project_path)?;
    let normalized_path = resolved.project_path;
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
        let key = ProjectAgentKey {
            project_path: normalized_path,
            app: coding_app,
        };
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
        let session_number = PROJECT_AGENT_SESSION_COUNTER.fetch_add(1, Ordering::Relaxed);
        let pty_id = format!("project-pty-{pid}-{session_number}");
        let canonical_display_path = display_path(&key.project_path);
        let handle = ProjectAgentHandle {
            pty_id: pty_id.clone(),
            master: pair.master,
            writer,
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
    app: AppHandle,
    app_id: String,
    project_path: String,
) -> Result<ProjectAgentSession, String> {
    crate::log_verbose(&format!(
        "[project_agent_pty::project_agent_pty_attach] enter app_id={} project_path_supplied=true",
        safe_app_id_for_log(&app_id)
    ));
    let coding_app = CodingApp::parse(&app_id)?;
    let normalized_path = normalize_project_session_path(&project_path)?;
    let key = ProjectAgentKey {
        project_path: normalized_path,
        app: coding_app,
    };
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
    app_id: String,
    project_path: String,
    data: String,
) -> Result<(), String> {
    crate::log_verbose(&format!(
        "[project_agent_pty::project_agent_pty_write] enter app_id={} data_bytes={}",
        safe_app_id_for_log(&app_id),
        data.len()
    ));
    let coding_app = CodingApp::parse(&app_id)?;
    let normalized_path = normalize_project_session_path(&project_path)?;
    let registry = Arc::clone(&registry);
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let key = ProjectAgentKey {
            project_path: normalized_path,
            app: coding_app,
        };
        let mut state = registry.lock().unwrap();
        let handle = find_project_agent_handle_mut(&mut state, &key)?;
        handle.writer.write_all(data.as_bytes()).map_err(|_| {
            crate::log_verbose("[project_agent_pty::project_agent_pty_write] branch=write_failed");
            "session_missing".to_owned()
        })?;
        handle.writer.flush().map_err(|_| {
            crate::log_verbose("[project_agent_pty::project_agent_pty_write] branch=flush_failed");
            "session_missing".to_owned()
        })
    })
    .await
    .map_err(|_| "session_missing".to_owned())?
}

#[tauri::command]
pub async fn project_agent_pty_resize(
    registry: State<'_, ProjectAgentRegistry>,
    app_id: String,
    project_path: String,
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
    let normalized_path = normalize_project_session_path(&project_path)?;
    let registry = Arc::clone(&registry);
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let key = ProjectAgentKey {
            project_path: normalized_path,
            app: coding_app,
        };
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
