use tauri::AppHandle;

use super::config::{herdr_command, set_herdr_theme, validate_herdr, write_embedded_herdr_config};

/// Snapshot protocol range this shell accepts from PATH or bundled Herdr.
///
/// Canonical pin: this module. Frontend `src/apps/workspace/herdr.ts` keeps the
/// same range. Bundled/dev `herdr 0.8.0–0.8.2` speak 19; PATH `herdr 0.9.1`
/// speaks 22. The shell does not vendor a second protocol number against PATH
/// (#645).
pub(super) const HERDR_PROTOCOL_MIN: u64 = 19;
pub(super) const HERDR_PROTOCOL_MAX: u64 = 22;
pub(super) const HERDR_SUPPORTED_VERSIONS: &str = "0.8.0–0.9.1";

pub(super) fn herdr_protocol_supported(protocol: u64) -> bool {
    (HERDR_PROTOCOL_MIN..=HERDR_PROTOCOL_MAX).contains(&protocol)
}

pub(super) fn unsupported_herdr_protocol(protocol: u64) -> String {
    format!(
        "Unsupported Herdr protocol {protocol}; expected {HERDR_PROTOCOL_MIN}..={HERDR_PROTOCOL_MAX} (herdr {HERDR_SUPPORTED_VERSIONS})"
    )
}

// Herdr currently transports prompts as process arguments. Stay below the
// Windows CreateProcess command-line ceiling after executable/flag overhead.
const HERDR_PROMPT_MAX_BYTES: usize = 12 * 1024;
const HERDR_ID_PART_MAX_BYTES: usize = 64;
const HERDR_LABEL_MAX_BYTES: usize = 256;
// 터미널 입력 경로(#502 FR-ENV-DISPATCH.3/.5). 사용자의 터미널에 직접 타이핑하는 것과 같으므로
// 구조화 경로보다 좁게 잡는다.
const HERDR_KEYS_MAX: usize = 8;
const HERDR_KEY_MAX_BYTES: usize = 32;

pub(super) fn herdr_api_output(
    config_path: &std::path::Path,
    args: &[&str],
) -> Result<String, String> {
    let output = herdr_command()
        .env("HERDR_CONFIG_PATH", config_path)
        .args(args)
        .output()
        .map_err(|e| format!("Herdr API unavailable: {e}"))?;
    if !output.status.success() {
        let reason = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if reason.is_empty() {
            "Herdr API command failed".to_string()
        } else {
            reason
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
pub async fn herdr_snapshot(app: AppHandle) -> Result<serde_json::Value, String> {
    let config_path = write_embedded_herdr_config(&app)?;
    tokio::task::spawn_blocking(move || {
        validate_herdr()?;
        let raw = herdr_api_output(&config_path, &["api", "snapshot"])?;
        let envelope: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| format!("Invalid Herdr snapshot: {e}"))?;
        let snapshot = envelope
            .pointer("/result/snapshot")
            .cloned()
            .ok_or_else(|| "Herdr snapshot payload missing".to_string())?;
        let protocol = snapshot
            .get("protocol")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| "Herdr snapshot protocol missing".to_string())?;
        if !herdr_protocol_supported(protocol) {
            return Err(unsupported_herdr_protocol(protocol));
        }
        Ok(snapshot)
    })
    .await
    .map_err(|e| format!("Herdr snapshot task failed: {e}"))?
}

#[tauri::command]
pub async fn herdr_set_theme(app: AppHandle, dark: bool) -> Result<(), String> {
    tokio::task::spawn_blocking(move || set_herdr_theme(&app, dark))
        .await
        .map_err(|e| format!("Herdr theme task failed: {e}"))?
}

fn valid_herdr_id(value: &str, prefix: char) -> bool {
    let mut parts = value.split(':');
    matches!(parts.next(), Some(workspace) if valid_herdr_id_part(workspace, 'w'))
        && matches!(parts.next(), Some(target) if valid_herdr_id_part(target, prefix))
        && parts.next().is_none()
}

fn valid_herdr_id_part(value: &str, prefix: char) -> bool {
    value.strip_prefix(prefix).is_some_and(|tail| {
        !tail.is_empty()
            && tail.len() <= HERDR_ID_PART_MAX_BYTES
            && tail.chars().all(|c| c.is_ascii_alphanumeric())
    })
}

fn normalized_label(label: Option<String>) -> Result<Option<String>, String> {
    let label = label.filter(|value| !value.trim().is_empty());
    if label
        .as_ref()
        .is_some_and(|value| value.len() > HERDR_LABEL_MAX_BYTES)
    {
        return Err(format!(
            "Herdr workspace label exceeds {HERDR_LABEL_MAX_BYTES} byte limit"
        ));
    }
    Ok(label)
}

#[tauri::command]
pub async fn herdr_focus_workspace(app: AppHandle, workspace_id: String) -> Result<(), String> {
    if !valid_herdr_id_part(&workspace_id, 'w') {
        return Err("Invalid Herdr workspace id".to_string());
    }
    let config_path = write_embedded_herdr_config(&app)?;
    tokio::task::spawn_blocking(move || {
        herdr_api_output(&config_path, &["workspace", "focus", &workspace_id]).map(|_| ())
    })
    .await
    .map_err(|e| format!("Herdr workspace focus task failed: {e}"))?
}

#[tauri::command]
pub async fn herdr_focus_agent(app: AppHandle, pane_id: String) -> Result<(), String> {
    if !valid_herdr_id(&pane_id, 'p') {
        return Err("Invalid Herdr pane id".to_string());
    }
    let config_path = write_embedded_herdr_config(&app)?;
    tokio::task::spawn_blocking(move || {
        herdr_api_output(&config_path, &["agent", "focus", &pane_id]).map(|_| ())
    })
    .await
    .map_err(|e| format!("Herdr agent focus task failed: {e}"))?
}

#[tauri::command]
pub async fn herdr_create_workspace(
    app: AppHandle,
    cwd: String,
    label: Option<String>,
) -> Result<(), String> {
    let cwd =
        dunce::canonicalize(&cwd).map_err(|e| format!("Invalid Herdr workspace directory: {e}"))?;
    if !cwd.is_dir() {
        return Err("Herdr workspace directory is not a directory".to_string());
    }
    let cwd = cwd.to_string_lossy().to_string();
    let label = normalized_label(label)?;
    let config_path = write_embedded_herdr_config(&app)?;
    tokio::task::spawn_blocking(move || {
        validate_herdr()?;
        let mut args = vec!["workspace", "create", "--cwd", cwd.as_str(), "--focus"];
        if let Some(label) = label.as_deref() {
            args.extend(["--label", label]);
        }
        herdr_api_output(&config_path, &args).map(|_| ())
    })
    .await
    .map_err(|e| format!("Herdr workspace create task failed: {e}"))?
}

#[tauri::command]
pub async fn herdr_prompt_agent(
    app: AppHandle,
    pane_id: String,
    text: String,
) -> Result<(), String> {
    if !valid_herdr_id(&pane_id, 'p') {
        return Err("Invalid Herdr pane id".to_string());
    }
    if text.trim().is_empty() {
        return Err("Herdr prompt text is required".to_string());
    }
    if text.len() > HERDR_PROMPT_MAX_BYTES {
        return Err(format!(
            "Herdr prompt exceeds {HERDR_PROMPT_MAX_BYTES} byte limit"
        ));
    }
    let config_path = write_embedded_herdr_config(&app)?;
    tokio::task::spawn_blocking(move || {
        validate_herdr()?;
        herdr_api_output(&config_path, &["agent", "prompt", &pane_id, &text]).map(|_| ())
    })
    .await
    .map_err(|e| format!("Herdr agent prompt task failed: {e}"))?
}

/// 터미널에 넣을 본문 검증 (#502 FR-ENV-DISPATCH.5). 빈 값 금지, 길이 상한.
fn validated_terminal_body(value: &str, what: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("Herdr {what} is required"));
    }
    if value.len() > HERDR_PROMPT_MAX_BYTES {
        return Err(format!(
            "Herdr {what} exceeds {HERDR_PROMPT_MAX_BYTES} byte limit"
        ));
    }
    Ok(())
}

/// 키 이름 검증 (#502 FR-ENV-DISPATCH.4/.5).
/// Herdr 는 키를 개별 인자로 받으므로 셸 주입은 없지만, `-` 로 시작하는 값은 플래그로 해석될 수 있다.
fn validated_keys(keys: &[String]) -> Result<(), String> {
    if keys.is_empty() {
        return Err("Herdr keys are required".to_string());
    }
    if keys.len() > HERDR_KEYS_MAX {
        return Err(format!("Herdr keys exceed {HERDR_KEYS_MAX} entries"));
    }
    for key in keys {
        if key.is_empty() || key.len() > HERDR_KEY_MAX_BYTES {
            return Err(format!("Invalid Herdr key length: {key}"));
        }
        if key.starts_with('-') {
            return Err("Herdr key must not start with '-'".to_string());
        }
        if !key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '+' | ':'))
        {
            return Err(format!("Invalid Herdr key: {key}"));
        }
    }
    Ok(())
}

/// #502 FR-ENV-DISPATCH.3 — 일반 터미널에서 명령을 실행한다.
/// `pane run` 은 텍스트와 Enter 를 함께 보낸다. 사용자가 직접 타이핑한 것과 동등한 권한이며,
/// 능력 게이팅은 core 의 의도 계층이 수행한다(FR-ENV-DISPATCH.7).
#[tauri::command]
pub async fn herdr_run_pane(
    app: AppHandle,
    pane_id: String,
    command: String,
) -> Result<(), String> {
    if !valid_herdr_id(&pane_id, 'p') {
        return Err("Invalid Herdr pane id".to_string());
    }
    validated_terminal_body(&command, "command")?;
    let config_path = write_embedded_herdr_config(&app)?;
    tokio::task::spawn_blocking(move || {
        validate_herdr()?;
        herdr_api_output(&config_path, &["pane", "run", &pane_id, &command]).map(|_| ())
    })
    .await
    .map_err(|e| format!("Herdr pane run task failed: {e}"))?
}

/// #502 FR-ENV-DISPATCH.3 — 진행 중인 것을 중단한다(키 입력).
#[tauri::command]
pub async fn herdr_send_keys(
    app: AppHandle,
    pane_id: String,
    keys: Vec<String>,
) -> Result<(), String> {
    if !valid_herdr_id(&pane_id, 'p') {
        return Err("Invalid Herdr pane id".to_string());
    }
    validated_keys(&keys)?;
    let config_path = write_embedded_herdr_config(&app)?;
    tokio::task::spawn_blocking(move || {
        validate_herdr()?;
        let mut args: Vec<&str> = vec!["pane", "send-keys", &pane_id];
        for key in &keys {
            args.push(key);
        }
        herdr_api_output(&config_path, &args).map(|_| ())
    })
    .await
    .map_err(|e| format!("Herdr pane send-keys task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::{
        normalized_label, valid_herdr_id, validated_keys, validated_terminal_body, HERDR_KEYS_MAX,
        HERDR_KEY_MAX_BYTES, HERDR_PROMPT_MAX_BYTES,
    };

    #[test]
    fn validates_public_ids() {
        assert!(valid_herdr_id("w9:pB", 'p'));
        assert!(!valid_herdr_id("w:pB", 'p'));
        assert!(!valid_herdr_id("w9:p", 'p'));
        assert!(!valid_herdr_id("w9:pB;rm", 'p'));
        assert!(!valid_herdr_id(&format!("w9:p{}", "a".repeat(65)), 'p'));
    }

    #[test]
    fn normalizes_and_limits_workspace_labels() {
        assert_eq!(normalized_label(None).unwrap(), None);
        assert_eq!(normalized_label(Some("   ".to_string())).unwrap(), None);
        assert_eq!(
            normalized_label(Some("project alpha".to_string())).unwrap(),
            Some("project alpha".to_string())
        );
        assert!(normalized_label(Some("a".repeat(257))).is_err());
    }

    #[test]
    fn rejects_empty_and_oversized_terminal_bodies() {
        assert!(validated_terminal_body("pnpm test", "command").is_ok());
        assert!(validated_terminal_body("   ", "command").is_err());
        assert!(validated_terminal_body("", "command").is_err());
        assert!(
            validated_terminal_body(&"a".repeat(HERDR_PROMPT_MAX_BYTES + 1), "command").is_err()
        );
    }

    #[test]
    fn validates_keys_against_flag_injection_and_limits() {
        assert!(validated_keys(&["C-c".to_string()]).is_ok());
        assert!(validated_keys(&["esc".to_string(), "Enter".to_string()]).is_ok());
        assert!(validated_keys(&[]).is_err());
        assert!(validated_keys(&["--help".to_string()]).is_err());
        assert!(validated_keys(&["".to_string()]).is_err());
        assert!(validated_keys(&["a b".to_string()]).is_err());
        assert!(validated_keys(&["k;rm".to_string()]).is_err());
        assert!(validated_keys(&["a".repeat(HERDR_KEY_MAX_BYTES + 1)]).is_err());
        let too_many: Vec<String> = (0..HERDR_KEYS_MAX + 1).map(|_| "esc".to_string()).collect();
        assert!(validated_keys(&too_many).is_err());
    }

    #[test]
    fn accepts_herdr_protocol_range_19_through_22() {
        assert!(herdr_protocol_supported(19));
        assert!(herdr_protocol_supported(22));
        assert!(!herdr_protocol_supported(18));
        assert!(!herdr_protocol_supported(23));
        let err = unsupported_herdr_protocol(22);
        assert!(err.contains("22"));
        assert!(err.contains("19..=22"));
        assert!(err.contains(HERDR_SUPPORTED_VERSIONS));
    }
}
