use portable_pty::{ChildKiller, CommandBuilder, MasterPty};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
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
pub(crate) struct ProjectAgentKey {
    pub(crate) project_path: PathBuf,
    pub(super) app: CodingApp,
}

pub(crate) struct ProjectAgentHandle {
    pub(super) pty_id: String,
    pub(super) pid: u32,
    pub(super) master: Box<dyn MasterPty + Send>,
    pub(super) writer: Box<dyn Write + Send>,
    pub(super) killer: Box<dyn ChildKiller + Send + Sync>,
    pub(crate) termination_requested: bool,
    pub(super) output_attached: bool,
    pub(super) output_backlog: String,
}

#[derive(Default)]
pub(crate) struct ProjectAgentState {
    pub(crate) sessions: HashMap<ProjectAgentKey, ProjectAgentHandle>,
    pub(crate) resetting_checkouts: HashSet<PathBuf>,
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

pub(crate) fn project_checkout_reset_key(checkout_path: &Path) -> Result<PathBuf, String> {
    crate::log_verbose(
        "[project_agent_pty::project_checkout_reset_key] enter checkout_path_supplied=true",
    );
    normalize_project_session_path(&checkout_path.to_string_lossy())
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ExecutableRules {
    Unix,
    Windows,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum AgentLaunch {
    Direct(PathBuf),
    WindowsBatch(PathBuf),
}

pub(super) fn find_agent_executable(
    app: CodingApp,
    path_value: Option<&OsStr>,
) -> Option<AgentLaunch> {
    let rules = if cfg!(windows) {
        ExecutableRules::Windows
    } else {
        ExecutableRules::Unix
    };
    find_agent_launch(app, path_value, rules)
}

pub(super) fn find_agent_launch(
    app: CodingApp,
    path_value: Option<&OsStr>,
    rules: ExecutableRules,
) -> Option<AgentLaunch> {
    let spec = app.spec();
    crate::log_verbose(&format!(
        "[project_agent_pty::find_agent_launch] enter app_id={} path_supplied={} rules={rules:?}",
        spec.app_id,
        path_value.is_some()
    ));
    let Some(path_value) = path_value else {
        crate::log_verbose("[project_agent_pty::find_agent_launch] branch=path_missing");
        return None;
    };
    for directory in std::env::split_paths(path_value) {
        match rules {
            ExecutableRules::Unix => {
                let candidate = directory.join(spec.executable);
                if is_direct_executable(&candidate) {
                    if let Ok(canonical) = dunce::canonicalize(candidate) {
                        crate::log_verbose(&format!(
                            "[project_agent_pty::find_agent_launch] branch=found_unix_direct app_id={}",
                            spec.app_id
                        ));
                        return Some(AgentLaunch::Direct(canonical));
                    }
                }
            }
            ExecutableRules::Windows => {
                for extension in ["exe", "com", "cmd", "bat"] {
                    let candidate = directory.join(format!("{}.{}", spec.executable, extension));
                    if is_windows_executable_file(&candidate) {
                        if let Ok(canonical) = dunce::canonicalize(candidate) {
                            let launch = match extension {
                                "exe" | "com" => {
                                    crate::log_verbose(&format!(
                                        "[project_agent_pty::find_agent_launch] branch=found_windows_direct app_id={} ext={extension}",
                                        spec.app_id
                                    ));
                                    AgentLaunch::Direct(canonical)
                                }
                                "cmd" | "bat" => {
                                    crate::log_verbose(&format!(
                                        "[project_agent_pty::find_agent_launch] branch=found_windows_batch app_id={} ext={extension}",
                                        spec.app_id
                                    ));
                                    AgentLaunch::WindowsBatch(canonical)
                                }
                                _ => unreachable!(),
                            };
                            return Some(launch);
                        }
                    }
                }
            }
        }
    }
    crate::log_verbose(&format!(
        "[project_agent_pty::find_agent_launch] branch=not_found app_id={}",
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

fn is_windows_executable_file(path: &Path) -> bool {
    crate::log_verbose(
        "[project_agent_pty::is_windows_executable_file] enter candidate_supplied=true",
    );
    let Ok(metadata) = std::fs::metadata(path) else {
        crate::log_verbose("[project_agent_pty::is_windows_executable_file] branch=not_found");
        return false;
    };
    if !metadata.is_file() {
        crate::log_verbose(
            "[project_agent_pty::is_windows_executable_file] branch=not_regular_file",
        );
        return false;
    }
    crate::log_verbose(
        "[project_agent_pty::is_windows_executable_file] branch=regular_file_accepted",
    );
    true
}

/// Builds the PTY command; WindowsBatch uses CommandBuilder's default PATH first and falls back to `base_path` only when unset.
pub(super) fn build_agent_command(
    launch: &AgentLaunch,
    argv: &[&str],
    checkout_path: &Path,
    base_path: Option<&OsStr>,
    system_root: Option<&OsStr>,
) -> Result<CommandBuilder, &'static str> {
    crate::log_verbose("[project_agent_pty::build_agent_command] enter");
    match launch {
        AgentLaunch::Direct(executable) => {
            crate::log_verbose("[project_agent_pty::build_agent_command] branch=direct");
            let mut command = CommandBuilder::new(executable);
            for argument in argv {
                command.arg(argument);
            }
            command.cwd(checkout_path);
            command.env("TERM", "xterm-256color");
            command.env("COLORTERM", "truecolor");
            Ok(command)
        }
        AgentLaunch::WindowsBatch(batch_path) => {
            let batch_name = validate_windows_batch_filename(batch_path)?;
            let Some(batch_dir) = batch_path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            else {
                crate::log_verbose(
                    "[project_agent_pty::build_agent_command] branch=batch_dir_missing",
                );
                return Err("batch_dir_missing");
            };
            let batch_dir_lossy = batch_dir.as_os_str().to_string_lossy();
            if batch_dir_lossy.contains(';') || batch_dir_lossy.contains('"') {
                crate::log_verbose(
                    "[project_agent_pty::build_agent_command] branch=batch_dir_unsafe_for_path",
                );
                return Err("batch_dir_unsafe_for_path");
            }
            let entries = std::fs::read_dir(checkout_path).map_err(|_| {
                crate::log_verbose(
                    "[project_agent_pty::build_agent_command] branch=checkout_unreadable",
                );
                "checkout_unreadable"
            })?;
            let batch_name_lower = batch_name.to_ascii_lowercase();
            let batch_dot_prefix = format!("{batch_name_lower}.");
            for entry in entries {
                let entry = entry.map_err(|_| {
                    crate::log_verbose(
                        "[project_agent_pty::build_agent_command] branch=checkout_unreadable",
                    );
                    "checkout_unreadable"
                })?;
                let entry_name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                if entry_name == batch_name_lower || entry_name.starts_with(&batch_dot_prefix) {
                    crate::log_verbose(
                        "[project_agent_pty::build_agent_command] branch=batch_shadowed_by_checkout",
                    );
                    return Err("batch_shadowed_by_checkout");
                }
            }
            for argument in argv {
                if !is_safe_windows_batch_arg(argument) {
                    crate::log_verbose(
                        "[project_agent_pty::build_agent_command] branch=batch_argv_unsafe",
                    );
                    return Err("batch_argv_unsafe");
                }
            }
            let cmd_exe = resolve_windows_cmd_exe(system_root);
            let mut command = CommandBuilder::new(cmd_exe);
            let mut new_path = OsString::from(batch_dir.as_os_str());
            if let Some(existing) = command
                .get_env("PATH")
                .filter(|value| !value.is_empty())
                .or_else(|| base_path.filter(|value| !value.is_empty()))
            {
                new_path.push(";");
                new_path.push(existing);
            }
            command.arg("/d");
            command.arg("/s");
            command.arg("/c");
            command.arg(&batch_name);
            for argument in argv {
                command.arg(argument);
            }
            command.cwd(checkout_path);
            command.env("PATH", new_path);
            command.env("TERM", "xterm-256color");
            command.env("COLORTERM", "truecolor");
            crate::log_verbose("[project_agent_pty::build_agent_command] branch=windows_batch");
            Ok(command)
        }
    }
}

fn validate_windows_batch_filename(batch_path: &Path) -> Result<String, &'static str> {
    let Some(stem) = batch_path.file_stem().and_then(OsStr::to_str) else {
        crate::log_verbose("[project_agent_pty::build_agent_command] branch=batch_name_invalid");
        return Err("batch_name_invalid");
    };
    let Some(extension) = batch_path.extension().and_then(OsStr::to_str) else {
        crate::log_verbose("[project_agent_pty::build_agent_command] branch=batch_name_invalid");
        return Err("batch_name_invalid");
    };
    if stem.is_empty()
        || !stem
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        crate::log_verbose("[project_agent_pty::build_agent_command] branch=batch_name_invalid");
        return Err("batch_name_invalid");
    }
    let extension_lower = extension.to_ascii_lowercase();
    if !matches!(extension_lower.as_str(), "cmd" | "bat") {
        crate::log_verbose("[project_agent_pty::build_agent_command] branch=batch_name_invalid");
        return Err("batch_name_invalid");
    }
    Ok(format!("{stem}.{extension_lower}"))
}

fn is_safe_windows_batch_arg(arg: &str) -> bool {
    !arg.is_empty()
        && arg.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'.' | b'_' | b'=' | b':' | b'/' | b'+' | b'-')
        })
}

fn resolve_windows_cmd_exe(system_root: Option<&OsStr>) -> String {
    let root = system_root
        .and_then(OsStr::to_str)
        .filter(|value| is_windows_drive_absolute(value))
        .map(|value| value.trim_end_matches(['\\', '/']))
        .unwrap_or(r"C:\Windows");
    format!(r"{root}\System32\cmd.exe")
}

fn is_windows_drive_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
        && !path.contains(['"', ';', '\0'])
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

        let expected = dunce::canonicalize(&claude_path)
            .ok()
            .map(AgentLaunch::Direct);
        assert_eq!(
            find_agent_launch(
                CodingApp::Claude,
                Some(temp.path().as_os_str()),
                ExecutableRules::Unix
            ),
            expected
        );
        #[cfg(unix)]
        assert_eq!(
            find_agent_executable(CodingApp::Claude, Some(temp.path().as_os_str())),
            expected
        );
        assert_eq!(
            find_agent_launch(
                CodingApp::Codex,
                Some(temp.path().as_os_str()),
                ExecutableRules::Unix
            ),
            None
        );
        assert_eq!(find_agent_executable(CodingApp::Muse, None), None);
    }

    #[test]
    fn project_agent_pty_windows_rules_ignore_extensionless_and_find_cmd_shuttle() {
        let temp = tempfile::tempdir().unwrap();
        let extensionless = temp.path().join("opencode");
        std::fs::write(&extensionless, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&extensionless, std::fs::Permissions::from_mode(0o700))
                .unwrap();
        }

        assert_eq!(
            find_agent_launch(
                CodingApp::OpenCode,
                Some(temp.path().as_os_str()),
                ExecutableRules::Windows
            ),
            None
        );

        let cmd_shuttle = temp.path().join("opencode.cmd");
        std::fs::write(&cmd_shuttle, "@echo off\r\n").unwrap();

        assert_eq!(
            find_agent_launch(
                CodingApp::OpenCode,
                Some(temp.path().as_os_str()),
                ExecutableRules::Windows
            ),
            dunce::canonicalize(&cmd_shuttle)
                .ok()
                .map(AgentLaunch::WindowsBatch)
        );
    }

    #[test]
    fn project_agent_pty_windows_rules_respect_extension_and_directory_precedence() {
        let temp = tempfile::tempdir().unwrap();
        let same_dir = temp.path().join("same");
        let front_dir = temp.path().join("front");
        let back_dir = temp.path().join("back");
        let bat_dir = temp.path().join("bat");
        std::fs::create_dir_all(&same_dir).unwrap();
        std::fs::create_dir_all(&front_dir).unwrap();
        std::fs::create_dir_all(&back_dir).unwrap();
        std::fs::create_dir_all(&bat_dir).unwrap();

        let same_exe = same_dir.join("codex.exe");
        let same_cmd = same_dir.join("codex.cmd");
        std::fs::write(&same_exe, "exe").unwrap();
        std::fs::write(&same_cmd, "cmd").unwrap();
        assert_eq!(
            find_agent_launch(
                CodingApp::Codex,
                Some(same_dir.as_os_str()),
                ExecutableRules::Windows
            ),
            dunce::canonicalize(&same_exe).ok().map(AgentLaunch::Direct)
        );

        let front_cmd = front_dir.join("codex.cmd");
        let back_exe = back_dir.join("codex.exe");
        std::fs::write(&front_cmd, "cmd").unwrap();
        std::fs::write(&back_exe, "exe").unwrap();
        let joined = std::env::join_paths([&front_dir, &back_dir]).unwrap();
        assert_eq!(
            find_agent_launch(
                CodingApp::Codex,
                Some(joined.as_os_str()),
                ExecutableRules::Windows
            ),
            dunce::canonicalize(&front_cmd)
                .ok()
                .map(AgentLaunch::WindowsBatch)
        );

        let muse_bat = bat_dir.join("muse.bat");
        std::fs::write(&muse_bat, "@echo off\r\n").unwrap();
        assert_eq!(
            find_agent_launch(
                CodingApp::Muse,
                Some(bat_dir.as_os_str()),
                ExecutableRules::Windows
            ),
            dunce::canonicalize(&muse_bat)
                .ok()
                .map(AgentLaunch::WindowsBatch)
        );
    }

    #[test]
    fn project_agent_pty_windows_batch_command_puts_directory_in_path_not_argv() {
        let temp = tempfile::tempdir().unwrap();
        let batch_dir = temp.path().join("Program Files & (x86) %PATH% ^!");
        let checkout = temp.path().join("checkout");
        std::fs::create_dir_all(&batch_dir).unwrap();
        std::fs::create_dir_all(&checkout).unwrap();
        let batch_path = batch_dir.join("opencode.CMD");
        std::fs::write(&batch_path, "@echo off\r\n").unwrap();

        let existing_path = r"C:\Windows\System32;C:\Tools";
        let command = build_agent_command(
            &AgentLaunch::WindowsBatch(batch_path),
            &[],
            &checkout,
            Some(OsStr::new(existing_path)),
            Some(OsStr::new(r"C:\Win")),
        )
        .expect("build Windows batch command");

        let expected_argv = vec![
            OsString::from(r"C:\Win\System32\cmd.exe"),
            OsString::from("/d"),
            OsString::from("/s"),
            OsString::from("/c"),
            OsString::from("opencode.cmd"),
        ];
        assert_eq!(command.get_argv(), &expected_argv);
        let batch_dir_str = batch_dir.to_string_lossy();
        for arg in command.get_argv() {
            let text = arg.to_string_lossy();
            assert!(!text.contains(batch_dir_str.as_ref()));
            assert!(!text.contains("Program Files"));
        }

        let expected_path_prefix = format!("{};", batch_dir.display());
        let actual_path = command
            .get_env("PATH")
            .expect("PATH set on command")
            .to_string_lossy()
            .into_owned();
        let path_remainder = actual_path
            .strip_prefix(&expected_path_prefix)
            .unwrap_or_else(|| panic!("unexpected PATH prefix: {actual_path}"));
        assert!(
            !path_remainder.is_empty(),
            "unexpected empty PATH remainder: {actual_path}"
        );
        assert_eq!(command.get_cwd(), Some(&OsString::from(&checkout)));
    }

    #[test]
    fn project_agent_pty_command_builder_validates_batch_hazards_and_system_root_fallbacks() {
        let temp = tempfile::tempdir().unwrap();
        let checkout = temp.path().join("checkout");
        std::fs::create_dir_all(&checkout).unwrap();
        let missing_checkout = temp.path().join("missing-checkout");

        let semicolon_dir = temp.path().join("bad;dir");
        std::fs::create_dir_all(&semicolon_dir).unwrap();
        let semicolon_batch = semicolon_dir.join("opencode.cmd");
        std::fs::write(&semicolon_batch, "@echo off\r\n").unwrap();
        assert_eq!(
            build_agent_command(
                &AgentLaunch::WindowsBatch(semicolon_batch),
                &[],
                &checkout,
                None,
                None,
            ),
            Err("batch_dir_unsafe_for_path")
        );

        let quote_batch = temp.path().join("bad\"dir").join("opencode.cmd");
        assert_eq!(
            build_agent_command(
                &AgentLaunch::WindowsBatch(quote_batch),
                &[],
                &missing_checkout,
                None,
                None,
            ),
            Err("batch_dir_unsafe_for_path")
        );

        let safe_dir = temp.path().join("safe-bin");
        std::fs::create_dir_all(&safe_dir).unwrap();
        let safe_batch = safe_dir.join("opencode.cmd");
        std::fs::write(&safe_batch, "@echo off\r\n").unwrap();

        assert_eq!(
            build_agent_command(
                &AgentLaunch::WindowsBatch(safe_batch.clone()),
                &[],
                &missing_checkout,
                None,
                None,
            ),
            Err("checkout_unreadable")
        );

        let shadowed = checkout.join("opencode.cmd");
        std::fs::write(&shadowed, "@echo off\r\n").unwrap();
        assert_eq!(
            build_agent_command(
                &AgentLaunch::WindowsBatch(safe_batch.clone()),
                &[],
                &checkout,
                None,
                None,
            ),
            Err("batch_shadowed_by_checkout")
        );
        std::fs::remove_file(&shadowed).unwrap();

        let shadowed_pathext = checkout.join("OPENCODE.CMD.exe");
        std::fs::write(&shadowed_pathext, "MZ").unwrap();
        assert_eq!(
            build_agent_command(
                &AgentLaunch::WindowsBatch(safe_batch.clone()),
                &[],
                &checkout,
                None,
                None,
            ),
            Err("batch_shadowed_by_checkout")
        );
        std::fs::remove_file(&shadowed_pathext).unwrap();

        let unrelated_cmdx = checkout.join("opencode.cmdx");
        let unrelated_md = checkout.join("opencode.md");
        std::fs::write(&unrelated_cmdx, "noop").unwrap();
        std::fs::write(&unrelated_md, "# doc").unwrap();
        assert!(build_agent_command(
            &AgentLaunch::WindowsBatch(safe_batch.clone()),
            &[],
            &checkout,
            None,
            None,
        )
        .is_ok());
        std::fs::remove_file(&unrelated_cmdx).unwrap();
        std::fs::remove_file(&unrelated_md).unwrap();

        for unsafe_arg in ["a&b", "x y", ""] {
            assert_eq!(
                build_agent_command(
                    &AgentLaunch::WindowsBatch(safe_batch.clone()),
                    &[unsafe_arg],
                    &checkout,
                    None,
                    None,
                ),
                Err("batch_argv_unsafe")
            );
        }

        let direct_exe = safe_dir.join("opencode.exe");
        let direct_cmd = build_agent_command(
            &AgentLaunch::Direct(direct_exe.clone()),
            &["a&b", "x y"],
            &checkout,
            None,
            None,
        )
        .expect("direct command allows arbitrary static argv");
        assert_eq!(
            direct_cmd.get_argv(),
            &vec![
                OsString::from(&direct_exe),
                OsString::from("a&b"),
                OsString::from("x y"),
            ]
        );

        let none_root_cmd = build_agent_command(
            &AgentLaunch::WindowsBatch(safe_batch.clone()),
            &[],
            &checkout,
            None,
            None,
        )
        .expect("fallback when SystemRoot is None");
        assert_eq!(
            none_root_cmd.get_argv()[0],
            OsString::from(r"C:\Windows\System32\cmd.exe")
        );

        for relative_root in ["Windows", r"C:Windows", r".\Windows"] {
            let rel_cmd = build_agent_command(
                &AgentLaunch::WindowsBatch(safe_batch.clone()),
                &[],
                &checkout,
                None,
                Some(OsStr::new(relative_root)),
            )
            .expect("fallback when SystemRoot is relative");
            assert_eq!(
                rel_cmd.get_argv()[0],
                OsString::from(r"C:\Windows\System32\cmd.exe")
            );
        }
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
