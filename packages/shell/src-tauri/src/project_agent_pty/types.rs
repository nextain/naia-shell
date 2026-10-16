use portable_pty::{ChildKiller, MasterPty};
use serde::Serialize;
use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(super) enum CodingApp {
    Claude,
    Codex,
    Muse,
    OpenCode,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct CodingAppSpec {
    pub(super) app: CodingApp,
    pub(super) app_id: &'static str,
    pub(super) executable: &'static str,
    pub(super) argv: &'static [&'static str],
}

pub(super) const CODING_APPS: &[CodingAppSpec] = &[
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
pub(super) struct ProjectAgentKey {
    pub(super) project_path: PathBuf,
    pub(super) app: CodingApp,
}

pub(super) struct ProjectAgentHandle {
    pub(super) pty_id: String,
    pub(super) pid: u32,
    pub(super) master: Box<dyn MasterPty + Send>,
    pub(super) writer: Box<dyn Write + Send>,
    pub(super) killer: Box<dyn ChildKiller + Send + Sync>,
    pub(super) termination_requested: bool,
    pub(super) output_attached: bool,
    pub(super) output_backlog: String,
}

#[derive(Default)]
pub(crate) struct ProjectAgentState {
    pub(super) sessions: HashMap<ProjectAgentKey, ProjectAgentHandle>,
}

pub(crate) type ProjectAgentRegistry = Arc<Mutex<ProjectAgentState>>;

pub fn new_project_agent_registry() -> ProjectAgentRegistry {
    crate::log_verbose("[project_agent_pty::new_project_agent_registry] enter");
    Arc::new(Mutex::new(ProjectAgentState::default()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAgentAvailability {
    pub(super) app_id: String,
    pub(super) available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAgentSession {
    pub(super) app_id: String,
    pub(super) project_path: String,
    pub(super) pty_id: String,
    pub(super) running: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectAgentOutputEvent {
    pub(super) app_id: String,
    pub(super) project_path: String,
    pub(super) pty_id: String,
    pub(super) data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectAgentExitEvent {
    pub(super) app_id: String,
    pub(super) project_path: String,
    pub(super) pty_id: String,
    pub(super) exit_code: Option<i32>,
}

pub(super) const PROJECT_AGENT_OUTPUT_BACKLOG_CAP: usize = 64 * 1024;
pub(super) static PROJECT_AGENT_SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);

impl CodingApp {
    pub(super) fn parse(app_id: &str) -> Result<Self, String> {
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

    pub(super) fn spec(self) -> &'static CodingAppSpec {
        crate::log_verbose(&format!(
            "[project_agent_pty::CodingApp::spec] enter app_id={}",
            self.app_id()
        ));
        CODING_APPS
            .iter()
            .find(|spec| spec.app == self)
            .expect("all coding app IDs have a fixed specification")
    }

    pub(super) fn app_id(self) -> &'static str {
        crate::log_verbose("[project_agent_pty::CodingApp::app_id] enter");
        CODING_APPS
            .iter()
            .find(|spec| spec.app == self)
            .map(|spec| spec.app_id)
            .unwrap_or("<invalid>")
    }
}

pub(super) fn safe_app_id_for_log(app_id: &str) -> &str {
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

pub(super) fn project_agent_session(
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

pub(super) fn display_path(path: &Path) -> String {
    crate::log_verbose("[project_agent_pty::display_path] enter path_supplied=true");
    path.to_string_lossy().replace('\\', "/")
}

pub(super) fn project_agent_key(
    project_path: &Path,
    app: CodingApp,
) -> Result<ProjectAgentKey, String> {
    crate::log_verbose("[project_agent_pty::project_agent_key] enter project_path_supplied=true");
    Ok(ProjectAgentKey {
        project_path: normalize_project_session_path(&project_path.to_string_lossy())?,
        app,
    })
}

pub(super) fn normalize_project_session_path(project_path: &str) -> Result<PathBuf, String> {
    crate::log_verbose(
        "[project_agent_pty::normalize_project_session_path] enter project_path_supplied=true",
    );
    // Windows may spell the same filesystem object with a Win32 verbatim
    // prefix (`\\?\`). Normalize that spelling before building the session
    // key so start and write cannot disagree on the PathBuf identity.
    let supplied_path = PathBuf::from(project_path);
    let path = dunce::simplified(&supplied_path).to_path_buf();
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

pub(super) fn find_agent_executable(app: CodingApp, path_value: Option<&OsStr>) -> Option<PathBuf> {
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

pub(super) fn is_direct_executable(path: &Path) -> bool {
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

pub(super) fn find_project_agent_handle<'a>(
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
    Err(project_session_lookup_error(exists_for_project).to_owned())
}

pub(super) fn project_session_lookup_error(exists_for_project: bool) -> &'static str {
    if exists_for_project {
        "session_mismatch"
    } else {
        "session_missing"
    }
}

pub(super) fn find_project_agent_handle_mut<'a>(
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
    Err(project_session_lookup_error(exists_for_project).to_owned())
}

pub(super) fn emit_or_buffer_project_agent_output(
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

    #[test]
    fn project_agent_session_key_normalizes_all_path_forms() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("projects/sample");
        std::fs::create_dir_all(&project).unwrap();
        let canonical_path = dunce::canonicalize(&project).unwrap();
        let supplied_key = project_agent_key(&project, CodingApp::Claude).unwrap();
        let canonical_key = project_agent_key(&canonical_path, CodingApp::Claude).unwrap();
        let simplified_key =
            project_agent_key(&dunce::simplified(&canonical_path), CodingApp::Claude).unwrap();

        assert_eq!(canonical_key, supplied_key);
        assert_eq!(simplified_key, supplied_key);
    }

    #[cfg(windows)]
    #[test]
    fn project_agent_session_key_normalizes_windows_verbatim_prefix() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("projects/sample");
        std::fs::create_dir_all(&project).unwrap();
        let canonical = dunce::canonicalize(&project).unwrap();
        let verbatim = PathBuf::from(format!(r"\\?\{}", canonical.display()));

        let canonical_key = project_agent_key(&canonical, CodingApp::Claude).unwrap();
        let verbatim_key = project_agent_key(&verbatim, CodingApp::Claude).unwrap();

        assert_eq!(verbatim_key, canonical_key);
    }

    #[test]
    fn project_agent_lookup_error_preserves_missing_and_mismatch_codes() {
        assert_eq!(project_session_lookup_error(false), "session_missing");
        assert_eq!(project_session_lookup_error(true), "session_mismatch");
    }
}
