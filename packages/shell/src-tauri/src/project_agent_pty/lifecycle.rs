use std::path::PathBuf;
use std::thread;
use std::time::Duration;

use crate::project_catalog_runtime::{read_project_runtime_config, ProjectCatalogAuthority};

use super::types::{ProjectAgentHandle, ProjectAgentRegistry};

const PROCESS_GROUP_GRACE: Duration = Duration::from_millis(150);

pub(super) fn authorized_project_session_path(
    authority: &ProjectCatalogAuthority,
    adapter_root: &str,
    project_path: &str,
) -> Result<PathBuf, String> {
    crate::log_verbose(
		"[project_agent_pty::authorized_project_session_path] enter adapter_root_supplied=true project_path_supplied=true",
	);
    match read_project_runtime_config(authority, adapter_root, project_path) {
        Ok(config) => {
            crate::log_verbose(
                "[project_agent_pty::authorized_project_session_path] branch=project_authorized",
            );
            Ok(config.project_path)
        }
        Err(error) => {
            crate::log_verbose(
				"[project_agent_pty::authorized_project_session_path] branch=project_authority_rejected",
			);
            Err(error)
        }
    }
}

fn request_soft_termination(handle: &mut ProjectAgentHandle) -> Result<(), String> {
    crate::log_verbose(
        "[project_agent_pty::request_soft_termination] enter process_group_signal=true",
    );
    #[cfg(unix)]
    {
        let group_signal = signal_project_agent_group(handle.pid, libc::SIGHUP);
        let child_signal = handle.killer.kill();
        if group_signal.is_ok() || child_signal.is_ok() {
            crate::log_verbose(
                "[project_agent_pty::request_soft_termination] branch=hangup_requested",
            );
            return Ok(());
        }
        if group_signal
            .as_ref()
            .is_err_and(|error| error.raw_os_error() == Some(libc::ESRCH))
            || child_signal
                .as_ref()
                .is_err_and(|error| error.raw_os_error() == Some(libc::ESRCH))
        {
            crate::log_verbose(
                "[project_agent_pty::request_soft_termination] branch=process_already_exited",
            );
            return Ok(());
        }
        crate::log_verbose("[project_agent_pty::request_soft_termination] branch=hangup_failed");
        Err("session_missing".to_owned())
    }
    #[cfg(windows)]
    {
        handle.killer.kill().map_err(|_| {
            crate::log_verbose(
                "[project_agent_pty::request_soft_termination] branch=process_stop_failed",
            );
            "session_missing".to_owned()
        })
    }
}

#[cfg(unix)]
fn signal_project_agent_group(pid: u32, signal: libc::c_int) -> std::io::Result<()> {
    crate::log_verbose(
        "[project_agent_pty::signal_project_agent_group] enter process_group_signal=true",
    );
    let process_group = i32::try_from(pid).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid process group")
    })?;
    let result = unsafe { libc::kill(-process_group, signal) };
    if result == 0 {
        crate::log_verbose("[project_agent_pty::signal_project_agent_group] branch=signal_sent");
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(unix)]
fn request_force_termination(handle: &mut ProjectAgentHandle) -> Result<(), String> {
    crate::log_verbose(
        "[project_agent_pty::request_force_termination] enter process_group_signal=true",
    );
    let group_signal = signal_project_agent_group(handle.pid, libc::SIGKILL);
    let child_signal = i32::try_from(handle.pid)
        .map(|pid| unsafe { libc::kill(pid, libc::SIGKILL) })
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid process id"))
        .and_then(|result| {
            if result == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    if group_signal.is_ok() || child_signal.is_ok() {
        crate::log_verbose("[project_agent_pty::request_force_termination] branch=kill_sent");
        return Ok(());
    }
    if group_signal
        .as_ref()
        .is_err_and(|error| error.raw_os_error() == Some(libc::ESRCH))
        || child_signal
            .as_ref()
            .is_err_and(|error| error.raw_os_error() == Some(libc::ESRCH))
    {
        crate::log_verbose(
            "[project_agent_pty::request_force_termination] branch=process_already_exited",
        );
        return Ok(());
    }
    crate::log_verbose("[project_agent_pty::request_force_termination] branch=kill_failed");
    Err("session_missing".to_owned())
}

#[cfg(windows)]
fn request_force_termination(_handle: &mut ProjectAgentHandle) -> Result<(), String> {
    crate::log_verbose(
        "[project_agent_pty::request_force_termination] branch=child_process_terminated",
    );
    Ok(())
}

pub(super) fn stop_project_agent_handle(handle: &mut ProjectAgentHandle) -> Result<(), String> {
    crate::log_verbose(
        "[project_agent_pty::stop_project_agent_handle] enter termination_requested=true",
    );
    if handle.termination_requested {
        crate::log_verbose(
            "[project_agent_pty::stop_project_agent_handle] branch=termination_already_requested",
        );
        return Ok(());
    }
    handle.termination_requested = true;
    if let Err(error) = request_soft_termination(handle) {
        handle.termination_requested = false;
        return Err(error);
    }
    #[cfg(unix)]
    thread::sleep(PROCESS_GROUP_GRACE);
    match request_force_termination(handle) {
        Ok(()) => Ok(()),
        Err(error) => {
            handle.termination_requested = false;
            Err(error)
        }
    }
}

pub(crate) fn shutdown_project_agent_sessions(registry: &ProjectAgentRegistry) {
    crate::log_verbose("[project_agent_pty::shutdown_project_agent_sessions] enter");
    let mut sessions = {
        let mut state = registry.lock().unwrap();
        state.sessions.drain().collect::<Vec<_>>()
    };
    if sessions.is_empty() {
        crate::log_verbose(
            "[project_agent_pty::shutdown_project_agent_sessions] branch=no_sessions",
        );
        return;
    }
    crate::log_verbose(&format!(
        "[project_agent_pty::shutdown_project_agent_sessions] branch=stopping_sessions count={}",
        sessions.len()
    ));
    for (_, handle) in &mut sessions {
        handle.termination_requested = true;
        if request_soft_termination(handle).is_err() {
            crate::log_verbose(
                "[project_agent_pty::shutdown_project_agent_sessions] branch=soft_stop_failed",
            );
        }
    }
    #[cfg(unix)]
    thread::sleep(PROCESS_GROUP_GRACE);
    for (_, handle) in &mut sessions {
        if request_force_termination(handle).is_err() {
            crate::log_verbose(
                "[project_agent_pty::shutdown_project_agent_sessions] branch=force_stop_failed",
            );
        }
    }
    drop(sessions);
    crate::log_verbose(
        "[project_agent_pty::shutdown_project_agent_sessions] branch=sessions_stopped",
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
    use std::collections::HashMap;
    use std::fs;
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Instant;

    use crate::project_agent_pty::types::{CodingApp, ProjectAgentKey, ProjectAgentState};

    fn catalog_fixture() -> (tempfile::TempDir, ProjectCatalogAuthority, PathBuf, PathBuf) {
        crate::log_verbose("[project_agent_pty::lifecycle::tests::catalog_fixture] enter");
        let temp = tempfile::tempdir().unwrap();
        // Windows CI temp dirs can be 8.3 short names (for example a RUNNER~1
        // user directory). The catalog accepts only canonical paths, so
        // fixtures start from the canonical temp root.
        let root = dunce::canonicalize(temp.path()).expect("canonical temporary root");
        let adapter = root.join("projects").join("adapter");
        let project = adapter.join("projects").join("sample");
        fs::create_dir_all(&project).unwrap();
        fs::write(
            project.join("project.yaml"),
            "version: 1\nproject:\n  id: sample\n  repository: owner/sample\n",
        )
        .unwrap();
        let authority = ProjectCatalogAuthority::default();
        authority.replace_projects([(project.clone(), adapter.clone())]);
        (temp, authority, adapter, project)
    }

    #[test]
    fn project_agent_session_path_requires_the_current_catalog_authority() {
        let (_temp, authority, adapter, project) = catalog_fixture();
        let authorized = authorized_project_session_path(
            &authority,
            &adapter.to_string_lossy(),
            &project.to_string_lossy(),
        )
        .unwrap();
        assert_eq!(authorized, project);

        let unlisted_project = adapter.join("projects/unlisted");
        fs::create_dir_all(&unlisted_project).unwrap();
        fs::write(
            unlisted_project.join("project.yaml"),
            "version: 1\nproject:\n  id: unlisted\n  repository: owner/unlisted\n",
        )
        .unwrap();
        assert_eq!(
            authorized_project_session_path(
                &authority,
                &adapter.to_string_lossy(),
                &unlisted_project.to_string_lossy(),
            ),
            Err("project_unverified".to_owned())
        );
    }

    #[cfg(unix)]
    struct RunningProcessFixture {
        _temp: tempfile::TempDir,
        registry: ProjectAgentRegistry,
        key: ProjectAgentKey,
        exit_rx: mpsc::Receiver<bool>,
        process_group: u32,
        grandchild_pid: u32,
    }

    #[cfg(unix)]
    fn running_process_fixture() -> RunningProcessFixture {
        crate::log_verbose("[project_agent_pty::lifecycle::tests::running_process_fixture] enter");
        let temp = tempfile::tempdir().unwrap();
        let pid_file = temp.path().join("child.pid");
        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.arg("-c");
        command.arg(
            "trap '' HUP; (trap '' HUP; exec sleep 60) & echo $! > \"$NAIA_TEST_PID_FILE\"; wait",
        );
        command.env("NAIA_TEST_PID_FILE", &pid_file);
        let child = pair.slave.spawn_command(command).unwrap();
        let process_group = child.process_id().unwrap();
        let killer = child.clone_killer();
        let master = pair.master;
        let writer = master.take_writer().unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let grandchild_pid = loop {
            if let Ok(value) = fs::read_to_string(&pid_file) {
                if let Ok(pid) = value.trim().parse() {
                    break pid;
                }
            }
            assert!(
                Instant::now() < deadline,
                "test process child did not start"
            );
            thread::sleep(Duration::from_millis(10));
        };
        let (exit_tx, exit_rx) = mpsc::channel();
        thread::spawn(move || {
            let mut child = child;
            let exited = child.wait().is_ok();
            let _ = exit_tx.send(exited);
        });
        let project_path = temp.path().canonicalize().unwrap();
        let key = ProjectAgentKey {
            project_path,
            app: CodingApp::Claude,
        };
        let registry = Arc::new(Mutex::new(ProjectAgentState {
            sessions: HashMap::new(),
        }));
        registry.lock().unwrap().sessions.insert(
            key.clone(),
            ProjectAgentHandle {
                pty_id: "test-project-pty".to_owned(),
                pid: process_group,
                master,
                writer,
                killer,
                termination_requested: false,
                output_attached: false,
                output_backlog: String::new(),
            },
        );
        RunningProcessFixture {
            _temp: temp,
            registry,
            key,
            exit_rx,
            process_group,
            grandchild_pid,
        }
    }

    #[cfg(unix)]
    fn assert_process_gone(pid: u32, process_group: bool) {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let target = i32::try_from(pid).unwrap();
            let target = if process_group { -target } else { target };
            let result = unsafe { libc::kill(target, 0) };
            if result != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "owned child process remained alive"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[cfg(unix)]
    #[test]
    fn explicit_stop_kills_the_project_process_group_and_reaps_the_child() {
        let fixture = running_process_fixture();
        {
            let mut registry = fixture.registry.lock().unwrap();
            let handle = registry.sessions.get_mut(&fixture.key).unwrap();
            stop_project_agent_handle(handle).unwrap();
        }
        assert!(fixture
            .exit_rx
            .recv_timeout(Duration::from_secs(3))
            .unwrap());
        assert_process_gone(fixture.process_group, true);
        assert_process_gone(fixture.grandchild_pid, false);
    }

    #[cfg(unix)]
    #[test]
    fn application_shutdown_terminates_every_registered_project_process() {
        let fixture = running_process_fixture();
        shutdown_project_agent_sessions(&fixture.registry);
        assert!(fixture
            .exit_rx
            .recv_timeout(Duration::from_secs(3))
            .unwrap());
        assert_process_gone(fixture.process_group, true);
        assert_process_gone(fixture.grandchild_pid, false);
        assert!(fixture.registry.lock().unwrap().sessions.is_empty());
    }
}
