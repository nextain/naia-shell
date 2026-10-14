use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

use crate::project_catalog_runtime::{resolve_project_checkout, ProjectCatalogAuthority};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum CodingApp {
    Claude,
    Codex,
    Muse,
    OpenCode,
}

#[derive(Debug, Clone, Copy)]
struct CodingAppSpec {
    app: CodingApp,
    app_id: &'static str,
    executable: &'static str,
    argv: &'static [&'static str],
}

const CODING_APPS: &[CodingAppSpec] = &[
    CodingAppSpec {
        app: CodingApp::Claude,
        app_id: "claude",
        executable: "claude",
        argv: &[],
    },
    CodingAppSpec {
        app: CodingApp::Codex,
        app_id: "codex",
        executable: "codex",
        argv: &[],
    },
    CodingAppSpec {
        app: CodingApp::Muse,
        app_id: "muse",
        executable: "muse",
        argv: &[],
    },
    CodingAppSpec {
        app: CodingApp::OpenCode,
        app_id: "opencode",
        executable: "opencode",
        argv: &[],
    },
];

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ProjectAgentKey {
    project_path: PathBuf,
    app: CodingApp,
}

struct ProjectAgentHandle {
    pty_id: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    output_attached: bool,
    output_backlog: String,
}

#[derive(Default)]
pub(crate) struct ProjectAgentState {
    sessions: HashMap<ProjectAgentKey, ProjectAgentHandle>,
}

pub(crate) type ProjectAgentRegistry = Arc<Mutex<ProjectAgentState>>;

pub fn new_project_agent_registry() -> ProjectAgentRegistry {
    crate::log_verbose("[project_agent_pty::new_project_agent_registry] enter");
    Arc::new(Mutex::new(ProjectAgentState::default()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAgentAvailability {
    app_id: String,
    available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAgentSession {
    app_id: String,
    project_path: String,
    pty_id: String,
    running: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectAgentOutputEvent {
    app_id: String,
    project_path: String,
    pty_id: String,
    data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectAgentExitEvent {
    app_id: String,
    project_path: String,
    pty_id: String,
    exit_code: Option<i32>,
}

const PROJECT_AGENT_OUTPUT_BACKLOG_CAP: usize = 64 * 1024;
static PROJECT_AGENT_SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);

impl CodingApp {
    fn parse(app_id: &str) -> Result<Self, String> {
        crate::log_verbose(&format!(
            "[project_agent_pty::CodingApp::parse] enter app_id={}",
            safe_app_id_for_log(app_id)
        ));
        CODING_APPS
            .iter()
            .find(|spec| spec.app_id == app_id)
            .map(|spec| spec.app)
            .ok_or_else(|| {
                crate::log_verbose(
                    "[project_agent_pty::CodingApp::parse] branch=reject_unknown_app_id",
                );
                "agent_invalid".to_owned()
            })
    }

    fn spec(self) -> &'static CodingAppSpec {
        crate::log_verbose(&format!(
            "[project_agent_pty::CodingApp::spec] enter app_id={}",
            self.app_id()
        ));
        CODING_APPS
            .iter()
            .find(|spec| spec.app == self)
            .expect("all coding app IDs have a fixed specification")
    }

    fn app_id(self) -> &'static str {
        crate::log_verbose("[project_agent_pty::CodingApp::app_id] enter");
        CODING_APPS
            .iter()
            .find(|spec| spec.app == self)
            .map(|spec| spec.app_id)
            .unwrap_or("<invalid>")
    }
}

fn safe_app_id_for_log(app_id: &str) -> &str {
    crate::log_verbose(&format!(
        "[project_agent_pty::safe_app_id_for_log] enter app_id_valid={}",
        CODING_APPS.iter().any(|spec| spec.app_id == app_id)
    ));
    CODING_APPS
        .iter()
        .find(|spec| spec.app_id == app_id)
        .map(|spec| spec.app_id)
        .unwrap_or("<invalid>")
}

fn project_agent_session(
    key: &ProjectAgentKey,
    handle: &ProjectAgentHandle,
) -> ProjectAgentSession {
    crate::log_verbose(&format!(
        "[project_agent_pty::project_agent_session] enter app_id={} running=true",
        key.app.spec().app_id
    ));
    ProjectAgentSession {
        app_id: key.app.spec().app_id.to_owned(),
        project_path: display_path(&key.project_path),
        pty_id: handle.pty_id.clone(),
        running: true,
    }
}

fn display_path(path: &Path) -> String {
    crate::log_verbose("[project_agent_pty::display_path] enter path_supplied=true");
    path.to_string_lossy().replace('\\', "/")
}

fn normalize_project_session_path(project_path: &str) -> Result<PathBuf, String> {
    crate::log_verbose(
        "[project_agent_pty::normalize_project_session_path] enter project_path_supplied=true",
    );
    let path = PathBuf::from(project_path);
    if !path.is_absolute() {
        crate::log_verbose(
            "[project_agent_pty::normalize_project_session_path] branch=reject_relative_project_path",
        );
        return Err("project_unverified".to_owned());
    }
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            crate::log_verbose(
                "[project_agent_pty::normalize_project_session_path] branch=reject_symlink_or_non_directory",
            );
            return Err("project_unverified".to_owned());
        }
        Err(_) => {
            crate::log_verbose(
                "[project_agent_pty::normalize_project_session_path] branch=project_path_unavailable",
            );
            return Err("project_unverified".to_owned());
        }
        Ok(_) => {}
    }
    dunce::canonicalize(path).map_err(|_| {
        crate::log_verbose(
            "[project_agent_pty::normalize_project_session_path] branch=canonicalize_failed",
        );
        "project_unverified".to_owned()
    })
}

fn find_agent_executable(app: CodingApp, path_value: Option<&OsStr>) -> Option<PathBuf> {
    let spec = app.spec();
    crate::log_verbose(&format!(
        "[project_agent_pty::find_agent_executable] enter app_id={} path_supplied={}",
        spec.app_id,
        path_value.is_some()
    ));
    let Some(path_value) = path_value else {
        crate::log_verbose("[project_agent_pty::find_agent_executable] branch=path_missing");
        return None;
    };
    for directory in std::env::split_paths(path_value) {
        let candidate = directory.join(spec.executable);
        if is_direct_executable(&candidate) {
            crate::log_verbose(&format!(
                "[project_agent_pty::find_agent_executable] branch=found app_id={}",
                spec.app_id
            ));
            return dunce::canonicalize(candidate).ok();
        }
        #[cfg(windows)]
        for extension in ["exe", "com"] {
            let candidate = directory.join(format!("{}.{}", spec.executable, extension));
            if is_direct_executable(&candidate) {
                crate::log_verbose(&format!(
                    "[project_agent_pty::find_agent_executable] branch=found app_id={}",
                    spec.app_id
                ));
                return dunce::canonicalize(candidate).ok();
            }
        }
    }
    crate::log_verbose(&format!(
        "[project_agent_pty::find_agent_executable] branch=not_found app_id={}",
        spec.app_id
    ));
    None
}

fn is_direct_executable(path: &Path) -> bool {
    crate::log_verbose("[project_agent_pty::is_direct_executable] enter candidate_supplied=true");
    let Ok(metadata) = std::fs::metadata(path) else {
        crate::log_verbose("[project_agent_pty::is_direct_executable] branch=not_found");
        return false;
    };
    if !metadata.is_file() {
        crate::log_verbose("[project_agent_pty::is_direct_executable] branch=not_regular_file");
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let executable = metadata.permissions().mode() & 0o111 != 0;
        crate::log_verbose(&format!(
            "[project_agent_pty::is_direct_executable] branch=unix_permission_check executable={executable}"
        ));
        executable
    }
    #[cfg(not(unix))]
    {
        crate::log_verbose(
            "[project_agent_pty::is_direct_executable] branch=regular_file_accepted",
        );
        true
    }
}

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

fn find_project_agent_handle<'a>(
    state: &'a ProjectAgentState,
    key: &ProjectAgentKey,
) -> Result<&'a ProjectAgentHandle, String> {
    crate::log_verbose(&format!(
        "[project_agent_pty::find_project_agent_handle] enter app_id={}",
        key.app.app_id()
    ));
    if let Some(handle) = state.sessions.get(key) {
        return Ok(handle);
    }
    let exists_for_project = state
        .sessions
        .keys()
        .any(|other| other.project_path == key.project_path);
    crate::log_verbose(&format!(
        "[project_agent_pty::find_project_agent_handle] branch=session_not_found app_id={} other_app_for_project={exists_for_project}",
        key.app.spec().app_id
    ));
    if exists_for_project {
        Err("session_mismatch".to_owned())
    } else {
        Err("session_missing".to_owned())
    }
}

fn find_project_agent_handle_mut<'a>(
    state: &'a mut ProjectAgentState,
    key: &ProjectAgentKey,
) -> Result<&'a mut ProjectAgentHandle, String> {
    crate::log_verbose(&format!(
        "[project_agent_pty::find_project_agent_handle_mut] enter app_id={}",
        key.app.app_id()
    ));
    if state.sessions.contains_key(key) {
        return Ok(state.sessions.get_mut(key).expect("key checked above"));
    }
    let exists_for_project = state
        .sessions
        .keys()
        .any(|other| other.project_path == key.project_path);
    crate::log_verbose(&format!(
        "[project_agent_pty::find_project_agent_handle_mut] branch=session_not_found app_id={} other_app_for_project={exists_for_project}",
        key.app.spec().app_id
    ));
    if exists_for_project {
        Err("session_mismatch".to_owned())
    } else {
        Err("session_missing".to_owned())
    }
}

fn emit_or_buffer_project_agent_output(
    app: &AppHandle,
    registry: &ProjectAgentRegistry,
    key: &ProjectAgentKey,
    pty_id: &str,
    data: String,
) {
    crate::log_verbose(&format!(
        "[project_agent_pty::emit_or_buffer_project_agent_output] enter app_id={} pty_id_supplied=true data_bytes={}",
        key.app.app_id(),
        data.len()
    ));
    let mut state = registry.lock().unwrap();
    let Some(handle) = state.sessions.get_mut(key) else {
        crate::log_verbose(
            "[project_agent_pty::emit_or_buffer_project_agent_output] branch=session_removed_before_output",
        );
        return;
    };
    if handle.pty_id != pty_id {
        crate::log_verbose(
            "[project_agent_pty::emit_or_buffer_project_agent_output] branch=reject_stale_pty_id",
        );
        return;
    }
    if !handle.output_attached {
        if handle.output_backlog.len() < PROJECT_AGENT_OUTPUT_BACKLOG_CAP {
            handle.output_backlog.push_str(&data);
        }
        crate::log_verbose(
            "[project_agent_pty::emit_or_buffer_project_agent_output] branch=buffered_until_attach",
        );
        return;
    }
    let event = ProjectAgentOutputEvent {
        app_id: key.app.spec().app_id.to_owned(),
        project_path: display_path(&key.project_path),
        pty_id: pty_id.to_owned(),
        data,
    };
    drop(state);
    if app.emit("project-agent-pty-output", event).is_err() {
        crate::log_verbose(
            "[project_agent_pty::emit_or_buffer_project_agent_output] branch=event_emit_failed",
        );
    } else {
        crate::log_verbose(
            "[project_agent_pty::emit_or_buffer_project_agent_output] branch=output_emitted",
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_agent_pty_fixed_mapping_accepts_only_four_ids() {
        assert_eq!(CODING_APPS.len(), 4);
        let identities = CODING_APPS
            .iter()
            .map(|spec| (spec.app_id, spec.executable, spec.argv))
            .collect::<Vec<_>>();
        assert_eq!(
            identities,
            vec![
                ("claude", "claude", &[][..]),
                ("codex", "codex", &[][..]),
                ("muse", "muse", &[][..]),
                ("opencode", "opencode", &[][..]),
            ]
        );
        assert!(CodingApp::parse("claude; echo unsafe").is_err());
        assert!(CodingApp::parse("shell").is_err());
    }

    #[test]
    fn project_agent_pty_keys_are_isolated_by_project_and_app() {
        let project_a = ProjectAgentKey {
            project_path: PathBuf::from("/adapter/projects/a"),
            app: CodingApp::Claude,
        };
        let project_b = ProjectAgentKey {
            project_path: PathBuf::from("/adapter/projects/b"),
            app: CodingApp::Claude,
        };
        let project_a_codex = ProjectAgentKey {
            project_path: PathBuf::from("/adapter/projects/a"),
            app: CodingApp::Codex,
        };

        assert_ne!(project_a, project_b);
        assert_ne!(project_a, project_a_codex);
    }

    #[test]
    fn project_agent_pty_path_lookup_requires_a_direct_executable_in_path() {
        let temp = tempfile::tempdir().unwrap();
        let claude_path = temp.path().join("claude");
        std::fs::write(&claude_path, "test executable").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&claude_path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }

        assert_eq!(
            find_agent_executable(CodingApp::Claude, Some(temp.path().as_os_str())),
            dunce::canonicalize(&claude_path).ok()
        );
        assert_eq!(
            find_agent_executable(CodingApp::Codex, Some(temp.path().as_os_str())),
            None
        );
        assert_eq!(find_agent_executable(CodingApp::Muse, None), None);
    }

    #[test]
    fn project_agent_pty_rejects_relative_session_paths() {
        assert_eq!(
            normalize_project_session_path("checkouts/sample"),
            Err("project_unverified".to_owned())
        );
    }
}
