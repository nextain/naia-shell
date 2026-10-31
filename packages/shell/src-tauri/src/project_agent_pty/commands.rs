use portable_pty::{NativePtySystem, PtySize, PtySystem};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use crate::project_catalog_runtime::{resolve_project_checkout, ProjectCatalogAuthority};

use super::lifecycle::{authorized_project_session_path, stop_project_agent_handle};
use super::types::{
    build_agent_command, display_path, emit_or_buffer_project_agent_output, find_agent_executable,
    find_project_agent_handle, find_project_agent_handle_mut, project_agent_key,
    project_agent_session, project_checkout_reset_key, safe_app_id_for_log, CodingApp,
    ProjectAgentAvailability, ProjectAgentExitEvent, ProjectAgentHandle, ProjectAgentKey,
    ProjectAgentOutputEvent, ProjectAgentRegistry, ProjectAgentSession, ProjectAgentState,
    CODING_APPS, PROJECT_AGENT_SESSION_COUNTER,
};

const OPENCODE_NAIA_FALLBACK_MODEL: &str = "deepseek-v4-flash";
const OPENCODE_NAIA_KEY_ENV: &str = "NAIA_GATEWAY_KEY";
const OPENCODE_CONFIG_ENV: &str = "OPENCODE_CONFIG_CONTENT";

#[derive(Clone, Copy)]
struct OpenCodeNaiaModelLimit {
    id: &'static str,
    name: &'static str,
    context: u64,
    output: u64,
}

// The gateway catalog currently exposes capabilities and status, not token
// limits. DeepSeek publishes its limit; the other Naia aliases use conservative
// per-model defaults until the catalog gains authoritative limit fields.
const OPENCODE_NAIA_MODEL_LIMITS: &[OpenCodeNaiaModelLimit] = &[
    OpenCodeNaiaModelLimit {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        context: 1_048_576,
        output: 32_768,
    },
    OpenCodeNaiaModelLimit {
        id: "solar-pro4",
        name: "Solar Pro 4",
        context: 131_072,
        output: 8_192,
    },
    OpenCodeNaiaModelLimit {
        id: "solar-mini",
        name: "Solar Mini",
        context: 131_072,
        output: 8_192,
    },
    OpenCodeNaiaModelLimit {
        id: "gpt-5.6-luna",
        name: "Naia Luna",
        context: 131_072,
        output: 8_192,
    },
];

#[derive(Debug, Default, PartialEq, Eq)]
struct OpenCodeNaiaEnvironment {
    vars: Vec<(String, String)>,
    naia_login_required: bool,
    credential_fingerprint: Option<u64>,
}

fn credential_fingerprint(credential: Option<&str>) -> Option<u64> {
    credential
        .filter(|value| !value.trim().is_empty())
        .map(|value| {
            let mut hasher = DefaultHasher::new();
            value.hash(&mut hasher);
            hasher.finish()
        })
}

fn open_code_credential_changed(spawned: Option<u64>, current: Option<u64>) -> bool {
    spawned != current
}

fn opencode_naia_base_url(gateway_url: &str) -> Option<String> {
    let mut endpoint = crate::naia_balance_endpoint(gateway_url).ok()?;
    if !endpoint.username().is_empty() || endpoint.password().is_some() {
        return None;
    }
    endpoint.set_path("/v1");
    endpoint.set_query(None);
    endpoint.set_fragment(None);
    Some(endpoint.to_string().trim_end_matches('/').to_owned())
}

fn opencode_naia_selected_model(provider: &str, model: &str) -> &'static str {
    if matches!(provider, "nextain" | "naia")
        && OPENCODE_NAIA_MODEL_LIMITS
            .iter()
            .any(|candidate| candidate.id == model)
    {
        return OPENCODE_NAIA_MODEL_LIMITS
            .iter()
            .find(|candidate| candidate.id == model)
            .map(|candidate| candidate.id)
            .unwrap_or(OPENCODE_NAIA_FALLBACK_MODEL);
    }
    OPENCODE_NAIA_FALLBACK_MODEL
}

fn build_opencode_naia_environment(
    gateway_url: &str,
    model_provider: &str,
    model: &str,
    credential: Option<&str>,
) -> OpenCodeNaiaEnvironment {
    crate::log_verbose(&format!(
        "[project_agent_pty::build_opencode_naia_environment] enter credential_present={} gateway_supplied={}",
        credential.is_some_and(|value| !value.trim().is_empty()),
        !gateway_url.trim().is_empty()
    ));
    let Some(key) = credential.filter(|value| !value.trim().is_empty()) else {
        crate::log_verbose(
            "[project_agent_pty::build_opencode_naia_environment] branch=credential_missing",
        );
        return OpenCodeNaiaEnvironment {
            naia_login_required: true,
            ..OpenCodeNaiaEnvironment::default()
        };
    };
    let Some(base_url) = opencode_naia_base_url(gateway_url) else {
        crate::log_verbose(
            "[project_agent_pty::build_opencode_naia_environment] branch=gateway_rejected",
        );
        return OpenCodeNaiaEnvironment::default();
    };

    let selected_model = opencode_naia_selected_model(model_provider, model);
    let models = OPENCODE_NAIA_MODEL_LIMITS
        .iter()
        .map(|limit| {
            (
                limit.id.to_owned(),
                serde_json::json!({
                    "name": limit.name,
                    "limit": {
                        "context": limit.context,
                        "output": limit.output,
                    }
                }),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    let config = serde_json::json!({
        "$schema": "https://opencode.ai/config.json",
        "provider": {
            "naia": {
                "name": "Naia",
                "npm": "@ai-sdk/openai-compatible",
                "options": {
                    "baseURL": base_url,
                    "apiKey": "{env:NAIA_GATEWAY_KEY}",
                },
                "models": models,
            }
        },
        "model": format!("naia/{selected_model}"),
        "small_model": format!("naia/{OPENCODE_NAIA_FALLBACK_MODEL}"),
        "agent": {
            "build": { "model": format!("naia/{selected_model}") },
            "plan": { "model": format!("naia/{selected_model}") },
            "general": { "model": format!("naia/{selected_model}") },
            "explore": { "model": format!("naia/{selected_model}") },
        },
    });
    let config_content = match serde_json::to_string(&config) {
        Ok(value) => value,
        Err(_) => {
            crate::log_verbose(
                "[project_agent_pty::build_opencode_naia_environment] branch=config_serialization_failed",
            );
            return OpenCodeNaiaEnvironment::default();
        }
    };

    crate::log_verbose(
        "[project_agent_pty::build_opencode_naia_environment] branch=naia_environment_ready",
    );

    OpenCodeNaiaEnvironment {
        vars: vec![
            (OPENCODE_NAIA_KEY_ENV.to_owned(), key.to_owned()),
            (OPENCODE_CONFIG_ENV.to_owned(), config_content),
        ],
        naia_login_required: false,
        credential_fingerprint: credential_fingerprint(Some(key)),
    }
}

fn apply_project_agent_naia_environment(
    command: &mut portable_pty::CommandBuilder,
    coding_app: CodingApp,
    environment: &OpenCodeNaiaEnvironment,
) -> bool {
    crate::log_verbose(&format!(
        "[project_agent_pty::apply_project_agent_naia_environment] enter app_id={}",
        coding_app.spec().app_id
    ));
    command.env_remove(OPENCODE_NAIA_KEY_ENV);
    command.env_remove(OPENCODE_CONFIG_ENV);
    if coding_app != CodingApp::OpenCode {
        crate::log_verbose(
            "[project_agent_pty::apply_project_agent_naia_environment] branch=non_opencode_environment_removed",
        );
        return false;
    }
    for (name, value) in &environment.vars {
        command.env(name, value);
    }
    crate::log_verbose(&format!(
        "[project_agent_pty::apply_project_agent_naia_environment] branch=opencode_configured credential_present={} config_present={}",
        environment
            .vars
            .iter()
            .any(|(name, _)| name == OPENCODE_NAIA_KEY_ENV),
        environment
            .vars
            .iter()
            .any(|(name, _)| name == OPENCODE_CONFIG_ENV)
    ));
    environment.naia_login_required
}

#[derive(Debug)]
pub(crate) struct ResolvedProjectAgentStartTarget {
    coding_app: CodingApp,
    pub(crate) key: ProjectAgentKey,
    pub(crate) checkout_key: std::path::PathBuf,
    pub(crate) checkout_path: std::path::PathBuf,
}

pub(crate) fn resolve_project_agent_start_target(
    authority: &ProjectCatalogAuthority,
    adapter_root: &str,
    project_path: &str,
    app_id: &str,
) -> Result<ResolvedProjectAgentStartTarget, String> {
    let coding_app = CodingApp::parse(app_id).map_err(|error| {
        log::warn!("[project_agent_pty::project_agent_pty_start] branch=agent_invalid");
        error
    })?;
    let resolved = resolve_project_checkout(authority, adapter_root, project_path)?;
    let key = project_agent_key(&resolved.project_path, coding_app)?;
    let checkout_key = project_checkout_reset_key(&resolved.checkout_path)?;
    Ok(ResolvedProjectAgentStartTarget {
        coding_app,
        key,
        checkout_key,
        checkout_path: resolved.checkout_path,
    })
}

pub(crate) fn check_project_agent_start_in_state(
    state: &ProjectAgentState,
    key: &ProjectAgentKey,
    checkout_key: &std::path::Path,
) -> Result<Option<ProjectAgentSession>, String> {
    if state.resetting_checkouts.contains(checkout_key) {
        crate::log_verbose(&format!(
            "[project_agent_pty::project_agent_pty_start] branch=reject_class_reset_in_progress app_id={}",
            key.app.spec().app_id
        ));
        return Err("class_reset_in_progress".to_owned());
    }
    if let Some(handle) = state.sessions.get(key) {
        crate::log_verbose(&format!(
            "[project_agent_pty::project_agent_pty_start] branch=reuse_existing app_id={}",
            key.app.spec().app_id
        ));
        return Ok(Some(project_agent_session(key, handle)));
    }
    Ok(None)
}

pub(crate) fn prepare_project_agent_start(
    registry: &ProjectAgentRegistry,
    authority: &ProjectCatalogAuthority,
    adapter_root: &str,
    project_path: &str,
    app_id: &str,
) -> Result<ResolvedProjectAgentStartTarget, String> {
    let target = resolve_project_agent_start_target(authority, adapter_root, project_path, app_id)?;
    let state = match registry.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let _ = check_project_agent_start_in_state(&state, &target.key, &target.checkout_key)?;
    Ok(target)
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
    naia_gateway_url: Option<String>,
    naia_model_provider: Option<String>,
    naia_model: Option<String>,
) -> Result<ProjectAgentSession, String> {
    crate::log_verbose(&format!(
        "[project_agent_pty::project_agent_pty_start] enter app_id={} project_path_supplied=true",
        safe_app_id_for_log(&app_id)
    ));
    let target =
        prepare_project_agent_start(&registry, &authority, &adapter_root, &project_path, &app_id)?;
    let coding_app = target.coding_app;
    let key = target.key;
    let checkout_key = target.checkout_key;
    let path_value = std::env::var_os("PATH");
    let launch = find_agent_executable(coding_app, path_value.as_deref()).ok_or_else(|| {
        crate::log_verbose(&format!(
            "[project_agent_pty::project_agent_pty_start] branch=agent_not_available app_id={}",
            coding_app.spec().app_id
        ));
        "agent_unavailable".to_owned()
    })?;
    let checkout_path = target.checkout_path;
    let system_root = std::env::var_os("SystemRoot");
    let registry = Arc::clone(&registry);
    let session_app_id = coding_app.spec().app_id.to_owned();
    tokio::task::spawn_blocking(move || -> Result<ProjectAgentSession, String> {
        let opencode_naia = if coding_app == CodingApp::OpenCode {
            let credential = crate::read_secure_naia_credential(&app);
            build_opencode_naia_environment(
                naia_gateway_url.as_deref().unwrap_or_default(),
                naia_model_provider.as_deref().unwrap_or_default(),
                naia_model.as_deref().unwrap_or_default(),
                credential.as_deref(),
            )
        } else {
            OpenCodeNaiaEnvironment::default()
        };
        let current_credential_fingerprint = if coding_app == CodingApp::OpenCode {
            opencode_naia.credential_fingerprint
        } else {
            None
        };
        let mut command = build_agent_command(
            &launch,
            coding_app.spec().argv,
            &checkout_path,
            path_value.as_deref(),
            system_root.as_deref(),
        )
        .map_err(|reason| {
            crate::log_verbose(&format!(
                "[project_agent_pty::project_agent_pty_start] branch={reason} app_id={session_app_id}"
            ));
            "agent_unavailable".to_owned()
        })?;
        let naia_login_required = apply_project_agent_naia_environment(
            &mut command,
            coding_app,
            &opencode_naia,
        );

        let mut state = registry.lock().unwrap();
        if state.resetting_checkouts.contains(&checkout_key) {
            return Err("class_reset_in_progress".to_owned());
        }
        if let Some(handle) = state.sessions.get(&key) {
            let credential_changed = coding_app == CodingApp::OpenCode
                && open_code_credential_changed(
                    handle.credential_fingerprint,
                    current_credential_fingerprint,
                );
            if !credential_changed {
                crate::log_verbose(&format!(
                    "[project_agent_pty::project_agent_pty_start] branch=reuse_existing app_id={}",
                    session_app_id
                ));
                return Ok(project_agent_session(&key, handle));
            }
        }
        if state.sessions.contains_key(&key) {
            let mut previous = state
                .sessions
                .remove(&key)
                .expect("session presence was checked above");
            if stop_project_agent_handle(&mut previous).is_err() {
                state.sessions.insert(key.clone(), previous);
                crate::log_verbose(
                    "[project_agent_pty::project_agent_pty_start] branch=credential_change_stop_failed",
                );
                return Err("session_missing".to_owned());
            }
            crate::log_verbose(
                "[project_agent_pty::project_agent_pty_start] branch=credential_changed_respawn",
            );
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
            naia_login_required,
            credential_fingerprint: current_credential_fingerprint,
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
            naia_login_required,
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
    use std::collections::HashMap;
    use std::ffi::OsStr;
    use std::io;
    use std::path::PathBuf;

    fn assert_builtin_agent_models(config: &serde_json::Value, expected_model: &str) {
        let agents = config["agent"].as_object().expect("built-in agent config");
        assert_eq!(
            agents.len(),
            4,
            "only the four built-in agents are injected"
        );
        for name in ["build", "plan", "general", "explore"] {
            let agent = agents.get(name).expect("built-in agent");
            assert_eq!(agent["model"], expected_model, "agent {name}");
            assert_eq!(
                agent.as_object().map(serde_json::Map::len),
                Some(1),
                "only the model field is injected for agent {name}"
            );
        }
    }

    fn sanitize_test_command(command: &mut portable_pty::CommandBuilder) {
        command.env("PATH", "C:\\opencode-key-test-path");
        for name in ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"] {
            command.env_remove(name);
        }
    }

    #[test]
    fn opencode_naia_environment_uses_selected_model_and_key_reference() {
        const TEST_KEY: &str = "fake-key-for-opencode-tests";
        let environment = build_opencode_naia_environment(
            "https://api.nextain.io",
            "nextain",
            "gpt-5.6-luna",
            Some(TEST_KEY),
        );
        assert!(!environment.naia_login_required);
        let vars = environment.vars.iter().cloned().collect::<HashMap<_, _>>();
        assert_eq!(
            vars.get(OPENCODE_NAIA_KEY_ENV).map(String::as_str),
            Some(TEST_KEY)
        );
        let config = vars.get(OPENCODE_CONFIG_ENV).expect("OpenCode config JSON");
        let parsed: serde_json::Value = serde_json::from_str(config).unwrap();
        assert_eq!(parsed["model"], "naia/gpt-5.6-luna");
        assert_eq!(parsed["small_model"], "naia/deepseek-v4-flash");
        assert_builtin_agent_models(&parsed, "naia/gpt-5.6-luna");
        assert!(!config.contains(TEST_KEY));
        assert_eq!(
            parsed["provider"]["naia"]["npm"],
            "@ai-sdk/openai-compatible"
        );
        assert_eq!(
            parsed["provider"]["naia"]["options"]["baseURL"],
            "https://api.nextain.io/v1"
        );
        assert_eq!(
            parsed["provider"]["naia"]["options"]["apiKey"],
            "{env:NAIA_GATEWAY_KEY}"
        );
        assert_eq!(
            parsed["provider"]["naia"]["models"]["gpt-5.6-luna"]["limit"]["context"],
            131_072
        );
    }

    #[test]
    fn opencode_naia_environment_uses_fallback_for_local_provider() {
        const TEST_KEY: &str = "fake-local-provider-test-key";
        let environment = build_opencode_naia_environment(
            "https://api.nextain.io",
            "ollama",
            "llama3.2",
            Some(TEST_KEY),
        );
        let vars = environment.vars.iter().cloned().collect::<HashMap<_, _>>();
        let config: serde_json::Value =
            serde_json::from_str(vars.get(OPENCODE_CONFIG_ENV).unwrap()).unwrap();
        assert_eq!(config["model"], "naia/deepseek-v4-flash");
        assert_builtin_agent_models(&config, "naia/deepseek-v4-flash");
    }

    #[test]
    fn opencode_naia_environment_without_key_has_no_auth_environment_and_requires_login() {
        let environment = build_opencode_naia_environment(
            "https://api.nextain.io",
            "nextain",
            "gpt-5.6-luna",
            None,
        );
        assert!(environment.naia_login_required);
        assert!(environment.vars.is_empty());
        assert_eq!(environment.credential_fingerprint, None);
    }

    #[test]
    fn opencode_naia_environment_rejects_untrusted_gateway_without_auth_environment() {
        const TEST_KEY: &str = "fake-untrusted-gateway-test-key";
        let environment = build_opencode_naia_environment(
            "https://gateway.example.test",
            "nextain",
            "gpt-5.6-luna",
            Some(TEST_KEY),
        );
        assert!(!environment.naia_login_required);
        assert!(environment.vars.is_empty());
        assert_eq!(environment.credential_fingerprint, None);
    }

    #[test]
    fn opencode_config_json_never_contains_the_credential_value() {
        const TEST_KEY: &str = "fake-json-exclusion-test-key";
        let environment = build_opencode_naia_environment(
            "https://api.nextain.io",
            "nextain",
            "gpt-5.6-luna",
            Some(TEST_KEY),
        );
        let config = environment
            .vars
            .iter()
            .find(|(name, _)| name == OPENCODE_CONFIG_ENV)
            .map(|(_, value)| value)
            .expect("OpenCode config JSON");
        assert!(!config.contains(TEST_KEY));
        assert!(config.contains("{env:NAIA_GATEWAY_KEY}"));
    }

    #[test]
    fn opencode_environment_reaches_direct_and_windows_batch_commands_without_argv_json() {
        use super::super::types::{build_agent_command, AgentLaunch};

        const TEST_KEY: &str = "fake-command-env-test-key";
        let temp = tempfile::tempdir().unwrap();
        let checkout = temp.path().join("checkout");
        let bin = temp.path().join("bin");
        std::fs::create_dir_all(&checkout).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        let batch_path = bin.join("opencode.cmd");
        std::fs::write(&batch_path, "@echo off\r\n").unwrap();
        let launches = [
            AgentLaunch::Direct(PathBuf::from("opencode.exe")),
            AgentLaunch::WindowsBatch(batch_path),
        ];
        let environment = build_opencode_naia_environment(
            "https://api.nextain.io",
            "nextain",
            "gpt-5.6-luna",
            Some(TEST_KEY),
        );
        let no_key_environment = build_opencode_naia_environment(
            "https://api.nextain.io",
            "nextain",
            "gpt-5.6-luna",
            None,
        );

        for launch in &launches {
            let mut command = build_agent_command(
                launch,
                &[],
                &checkout,
                Some(OsStr::new("C:\\test-bin")),
                Some(OsStr::new("C:\\Win")),
            )
            .expect("build isolated test command");
            sanitize_test_command(&mut command);
            command.env(OPENCODE_NAIA_KEY_ENV, "parent-test-key");
            command.env(OPENCODE_CONFIG_ENV, "parent-test-config");
            assert!(!apply_project_agent_naia_environment(
                &mut command,
                CodingApp::OpenCode,
                &environment,
            ));

            assert_eq!(
                command.get_env(OPENCODE_NAIA_KEY_ENV),
                Some(OsStr::new(TEST_KEY))
            );
            let config = command
                .get_env(OPENCODE_CONFIG_ENV)
                .expect("OpenCode config env");
            assert!(!config.to_string_lossy().contains(TEST_KEY));
            assert!(command
                .get_argv()
                .iter()
                .all(|argument| argument.as_os_str() != config));
            assert!(command
                .get_argv()
                .iter()
                .all(|argument| !argument.to_string_lossy().contains(TEST_KEY)));

            let mut no_key_command = build_agent_command(
                launch,
                &[],
                &checkout,
                Some(OsStr::new("C:\\test-bin")),
                Some(OsStr::new("C:\\Win")),
            )
            .expect("build no-key isolated test command");
            sanitize_test_command(&mut no_key_command);
            no_key_command.env(OPENCODE_NAIA_KEY_ENV, "parent-test-key");
            no_key_command.env(OPENCODE_CONFIG_ENV, "parent-test-config");
            assert!(apply_project_agent_naia_environment(
                &mut no_key_command,
                CodingApp::OpenCode,
                &no_key_environment,
            ));
            assert!(no_key_command.get_env(OPENCODE_NAIA_KEY_ENV).is_none());
            assert!(no_key_command.get_env(OPENCODE_CONFIG_ENV).is_none());
        }
    }

    #[test]
    fn open_code_credential_change_triggers_respawn_decision() {
        let first = credential_fingerprint(Some("fake-key-first"));
        let second = credential_fingerprint(Some("fake-key-second"));
        assert_ne!(first, second);
        assert!(open_code_credential_changed(None, first));
        assert!(open_code_credential_changed(first, None));
        assert!(open_code_credential_changed(first, second));
        assert!(!open_code_credential_changed(first, first));
        assert!(!open_code_credential_changed(None, None));
    }

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
        use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
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

    #[cfg(windows)]
    #[test]
    fn project_agent_conpty_spawns_windows_batch_shuttle_from_special_char_dir() {
        use crate::project_agent_pty::types::AgentLaunch;
        use portable_pty::{NativePtySystem, PtySize, PtySystem};
        use std::io::Read;
        use std::sync::mpsc;
        use std::time::Duration;

        let temp = tempfile::tempdir().unwrap();
        let batch_dir = temp.path().join("Program Files & (x86) %PATH% ^!");
        let checkout_dir = temp.path().join("checkout");
        std::fs::create_dir_all(&batch_dir).unwrap();
        std::fs::create_dir_all(&checkout_dir).unwrap();
        let batch_path = batch_dir.join("naia-test.cmd");
        std::fs::write(&batch_path, "@echo off\r\necho naia-batch-ok %*\r\n").unwrap();

        let canonical_batch = dunce::canonicalize(&batch_path).unwrap();
        let canonical_checkout = dunce::canonicalize(&checkout_dir).unwrap();
        let command = build_agent_command(
            &AgentLaunch::WindowsBatch(canonical_batch),
            &["arg-one"],
            &canonical_checkout,
            std::env::var_os("PATH").as_deref(),
            std::env::var_os("SystemRoot").as_deref(),
        )
        .expect("build Windows batch command");

        let pair = NativePtySystem::default()
            .openpty(PtySize {
                rows: 25,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open Windows ConPTY");
        let mut child = pair
            .slave
            .spawn_command(command)
            .expect("spawn cmd.exe batch shuttle");
        let mut reader = pair.master.try_clone_reader().expect("clone ConPTY reader");
        let writer = std::sync::Arc::new(std::sync::Mutex::new(
            pair.master.take_writer().expect("take ConPTY writer"),
        ));
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
        let (output_tx, output_rx) = mpsc::sync_channel(1);
        let reply_writer = std::sync::Arc::clone(&writer);
        let reader_seen = std::sync::Arc::clone(&seen);
        std::thread::spawn(move || {
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
                        if output.contains("naia-batch-ok arg-one") {
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

        let output = output_rx.recv_timeout(Duration::from_secs(20));
        let _ = child.kill();
        let _ = child.wait();
        let output = output.unwrap_or_else(|_| {
            let bytes = seen.lock().unwrap().clone();
            panic!(
                "receive ConPTY batch output within 20 seconds; partial output: {:?}",
                String::from_utf8_lossy(&bytes)
            )
        });
        assert!(
            output.contains("naia-batch-ok arg-one"),
            "batch shuttle did not produce expected output through ConPTY: {output:?}"
        );
    }
}
