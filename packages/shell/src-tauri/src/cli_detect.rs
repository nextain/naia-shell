//! Descriptor-driven CLI install/readiness detection (#605 / epic #589 L6).
//!
//! Reads L0b-style JSON descriptors under `cli-descriptors/`. Classification
//! uses spawn errors, exit codes, timeouts, JSON fields, and auth-file
//! presence — never English prose matching for install state.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

const DESCRIPTOR_SOURCES: &[(&str, &str)] = &[
    ("claude", include_str!("../cli-descriptors/claude.json")),
    ("codex", include_str!("../cli-descriptors/codex.json")),
    ("grok", include_str!("../cli-descriptors/grok.json")),
    ("agy", include_str!("../cli-descriptors/agy.json")),
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliDescriptor {
    id: String,
    display_name: String,
    executables: HashMap<String, Vec<String>>,
    version: CheckSpec,
    readiness: ReadinessSpec,
    login: LoginSpec,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckSpec {
    args: Vec<String>,
    timeout_ms: u64,
    #[serde(default)]
    parse: Option<ParseSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParseSpec {
    kind: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadinessSpec {
    args: Vec<String>,
    timeout_ms: u64,
    classify: Vec<ClassifyRule>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginSpec {
    args: Vec<String>,
    #[serde(default)]
    open_in_terminal: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct ClassifyRule {
    when: ClassifyWhen,
    status: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ClassifyWhen {
    #[serde(default)]
    spawn_error: Option<String>,
    #[serde(default)]
    timed_out: Option<bool>,
    #[serde(default)]
    exit_code: Option<i32>,
    #[serde(default)]
    exit_code_non_zero: Option<bool>,
    #[serde(default)]
    json_bool_path: Option<String>,
    #[serde(default)]
    equals: Option<bool>,
    #[serde(default)]
    auth_file_non_empty: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliDetectionResult {
    pub id: String,
    pub display_name: String,
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// ready | not-installed | login-required | waiting-input | error
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliDetectionSnapshot {
    pub refreshed_at: String,
    pub results: Vec<CliDetectionResult>,
}

#[derive(Debug)]
struct CommandOutcome {
    spawn_error: Option<&'static str>,
    timed_out: bool,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
}

const MAX_CAPTURED_OUTPUT: usize = 64 * 1024;

fn current_os_key() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn load_descriptors() -> Result<Vec<CliDescriptor>, String> {
    DESCRIPTOR_SOURCES
        .iter()
        .map(|(id, raw)| {
            serde_json::from_str::<CliDescriptor>(raw)
                .map_err(|e| format!("cli descriptor {id}: {e}"))
        })
        .collect()
}

fn path_entries() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for entry in std::env::split_paths(&path) {
            if !entry.as_os_str().is_empty() {
                out.push(entry);
            }
        }
    }
    out
}

fn is_executable_candidate(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Resolve the first existing executable among OS-specific candidates on PATH.
pub fn resolve_executable(candidates: &[String]) -> Option<PathBuf> {
    for name in candidates {
        let as_path = PathBuf::from(name);
        if as_path.is_absolute() && is_executable_candidate(&as_path) {
            return Some(as_path);
        }
        for dir in path_entries() {
            let candidate = dir.join(name);
            if is_executable_candidate(&candidate) {
                return Some(candidate);
            }
            #[cfg(windows)]
            {
                // PATHEXT-style fallback when the descriptor omitted an extension.
                for ext in ["EXE", "CMD", "BAT", "COM"] {
                    let with_ext = dir.join(format!("{name}.{ext}"));
                    if is_executable_candidate(&with_ext) {
                        return Some(with_ext);
                    }
                    let lower = dir.join(format!("{name}.{}", ext.to_ascii_lowercase()));
                    if is_executable_candidate(&lower) {
                        return Some(lower);
                    }
                }
            }
        }
    }
    None
}

fn expand_home(raw: &str) -> PathBuf {
    if let Some(rest) = raw.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    if raw == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    }
    PathBuf::from(raw)
}

fn auth_file_non_empty(path_spec: &str) -> bool {
    let path = expand_home(path_spec);
    let Ok(bytes) = std::fs::read(&path) else {
        return false;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        // Non-JSON but non-empty file still counts as credentials present.
        return !bytes.is_empty();
    };
    match value {
        serde_json::Value::Object(map) => !map.is_empty(),
        serde_json::Value::Array(arr) => !arr.is_empty(),
        serde_json::Value::Bool(b) => b,
        serde_json::Value::String(s) => !s.is_empty(),
        serde_json::Value::Number(_) => true,
        serde_json::Value::Null => false,
    }
}

fn json_bool_at(stdout: &str, stderr: &str, path: &str) -> Option<bool> {
    for text in [stdout, stderr] {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if let Some(v) = value.pointer(&format!("/{}", path.replace('.', "/"))) {
                if let Some(b) = v.as_bool() {
                    return Some(b);
                }
            }
            // Top-level key fallback (common for claude auth status).
            if let Some(b) = value.get(path).and_then(|v| v.as_bool()) {
                return Some(b);
            }
        }
    }
    None
}

fn read_capped_output(mut reader: impl Read) -> String {
    let mut captured = Vec::new();
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                let remaining = MAX_CAPTURED_OUTPUT.saturating_sub(captured.len());
                if remaining > 0 {
                    captured.extend_from_slice(&buffer[..read.min(remaining)]);
                }
            }
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&captured).into_owned()
}

fn spawn_output_reader(reader: impl Read + Send + 'static) -> Receiver<String> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = sender.send(read_capped_output(reader));
    });
    receiver
}

fn collect_output(stdout: Receiver<String>, stderr: Receiver<String>) -> (String, String) {
    // A child that leaves a descendant holding an inherited pipe must not make
    // readiness detection wait forever after the direct child has exited.
    let drain_timeout = Duration::from_millis(100);
    let stdout = stdout.recv_timeout(drain_timeout).unwrap_or_default();
    let stderr = stderr.recv_timeout(drain_timeout).unwrap_or_default();
    (stdout, stderr)
}

fn run_command_with_timeout(program: &Path, args: &[String], timeout: Duration) -> CommandOutcome {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::platform::hide_console(&mut command);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return CommandOutcome {
                spawn_error: Some("notFound"),
                timed_out: false,
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
            };
        }
        Err(_) => {
            return CommandOutcome {
                spawn_error: Some("error"),
                timed_out: false,
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
            };
        }
    };

    let stdout = child
        .stdout
        .take()
        .map(spawn_output_reader)
        .expect("CLI readiness stdout must be piped");
    let stderr = child
        .stderr
        .take()
        .map(spawn_output_reader)
        .expect("CLI readiness stderr must be piped");
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let (stdout, stderr) = collect_output(stdout, stderr);
                return CommandOutcome {
                    spawn_error: None,
                    timed_out: false,
                    exit_code: status.code(),
                    stdout,
                    stderr,
                };
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    let (stdout, stderr) = collect_output(stdout, stderr);
                    return CommandOutcome {
                        spawn_error: None,
                        timed_out: true,
                        exit_code: None,
                        stdout,
                        stderr,
                    };
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let (stdout, stderr) = collect_output(stdout, stderr);
                return CommandOutcome {
                    spawn_error: Some("error"),
                    timed_out: false,
                    exit_code: None,
                    stdout,
                    stderr,
                };
            }
        }
    }
}

/// Pure classifier used by unit tests and runtime detection.
fn classify_outcome(rules: &[ClassifyRule], outcome: &CommandOutcome) -> &'static str {
    for rule in rules {
        let when = &rule.when;
        if let Some(spawn) = when.spawn_error.as_deref() {
            if outcome.spawn_error != Some(spawn) {
                continue;
            }
        }
        if let Some(true) = when.timed_out {
            if !outcome.timed_out {
                continue;
            }
        } else if when.timed_out == Some(false) && outcome.timed_out {
            continue;
        }
        if let Some(code) = when.exit_code {
            if outcome.exit_code != Some(code) {
                continue;
            }
        }
        if let Some(true) = when.exit_code_non_zero {
            match outcome.exit_code {
                Some(c) if c != 0 => {}
                _ => continue,
            }
        }
        if let Some(path) = when.json_bool_path.as_deref() {
            let expected = when.equals.unwrap_or(true);
            match json_bool_at(&outcome.stdout, &outcome.stderr, path) {
                Some(actual) if actual == expected => {}
                _ => continue,
            }
        }
        if let Some(auth_path) = when.auth_file_non_empty.as_deref() {
            if !auth_file_non_empty(auth_path) {
                continue;
            }
        }
        return match rule.status.as_str() {
            "ready" => "ready",
            "not-installed" => "not-installed",
            "login-required" => "login-required",
            "waiting-input" => "waiting-input",
            _ => "error",
        };
    }
    "error"
}

fn parse_version(outcome: &CommandOutcome, parse: &Option<ParseSpec>) -> Option<String> {
    if outcome.spawn_error.is_some() || outcome.timed_out {
        return None;
    }
    let kind = parse
        .as_ref()
        .map(|p| p.kind.as_str())
        .unwrap_or("stdoutFirstLine");
    if kind == "stdoutFirstLine" {
        let line = outcome
            .stdout
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .or_else(|| {
                outcome
                    .stderr
                    .lines()
                    .map(str::trim)
                    .find(|l| !l.is_empty())
            })?;
        return Some(line.to_string());
    }
    None
}

fn detect_one(desc: &CliDescriptor) -> CliDetectionResult {
    let os = current_os_key();
    let candidates = desc
        .executables
        .get(os)
        .cloned()
        .unwrap_or_else(|| desc.executables.values().flatten().cloned().collect());

    let Some(program) = resolve_executable(&candidates) else {
        return CliDetectionResult {
            id: desc.id.clone(),
            display_name: desc.display_name.clone(),
            installed: false,
            path: None,
            version: None,
            status: "not-installed".into(),
        };
    };

    let version_outcome = run_command_with_timeout(
        &program,
        &desc.version.args,
        Duration::from_millis(desc.version.timeout_ms.max(500)),
    );
    let version = parse_version(&version_outcome, &desc.version.parse);

    let readiness = run_command_with_timeout(
        &program,
        &desc.readiness.args,
        Duration::from_millis(desc.readiness.timeout_ms.max(500)),
    );
    // If the binary vanished between resolve and run.
    let status = if readiness.spawn_error == Some("notFound") {
        "not-installed"
    } else {
        classify_outcome(&desc.readiness.classify, &readiness)
    };

    CliDetectionResult {
        id: desc.id.clone(),
        display_name: desc.display_name.clone(),
        installed: status != "not-installed",
        path: Some(program.to_string_lossy().into_owned()),
        version,
        status: status.to_string(),
    }
}

pub fn detect_all() -> Result<CliDetectionSnapshot, String> {
    let descriptors = load_descriptors()?;
    let results = descriptors.iter().map(detect_one).collect::<Vec<_>>();
    Ok(CliDetectionSnapshot {
        refreshed_at: chrono_like_now(),
        results,
    })
}

pub fn detect_by_id(id: &str) -> Result<CliDetectionResult, String> {
    let descriptors = load_descriptors()?;
    let desc = descriptors
        .into_iter()
        .find(|d| d.id == id)
        .ok_or_else(|| format!("unknown cli id: {id}"))?;
    Ok(detect_one(&desc))
}

fn chrono_like_now() -> String {
    // Avoid pulling chrono; RFC3339-ish UTC from system time is enough for config.
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

fn spawn_login_in_terminal(program: &Path, args: &[String]) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        let candidates = [
            "x-terminal-emulator",
            "gnome-terminal",
            "kgx",
            "konsole",
            "kitty",
            "alacritty",
            "foot",
        ]
        .into_iter()
        .map(String::from)
        .collect::<Vec<_>>();
        let terminal = resolve_executable(&candidates).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "no supported terminal emulator found",
            )
        })?;
        let name = terminal
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_owned();
        let mut command = Command::new(terminal);
        match name.as_str() {
            "gnome-terminal" | "kgx" => {
                command.arg("--").arg(program).args(args);
            }
            "konsole" | "x-terminal-emulator" | "alacritty" => {
                command.arg("-e").arg(program).args(args);
            }
            _ => {
                command.arg(program).args(args);
            }
        }
        return command.spawn().map(|_| ());
    }

    #[cfg(target_os = "macos")]
    {
        fn escape_applescript(value: &str) -> String {
            value.replace('\\', "\\\\").replace('"', "\\\"")
        }

        let mut command_line = vec![program.to_string_lossy().into_owned()];
        command_line.extend(args.iter().cloned());
        let script = format!(
            "tell application \"Terminal\" to do script \"{}\"",
            escape_applescript(&command_line.join(" "))
        );
        return Command::new("osascript")
            .args(["-e", script.as_str()])
            .spawn()
            .map(|_| ());
    }

    #[cfg(windows)]
    {
        let terminal_candidates = ["wt.exe", "wt"]
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>();
        if let Some(terminal) = resolve_executable(&terminal_candidates) {
            return Command::new(terminal)
                .args(["-w", "new", "--"])
                .arg(program)
                .args(args)
                .spawn()
                .map(|_| ());
        }

        let comspec = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
        return Command::new(comspec)
            .args(["/c", "start", ""])
            .arg(program)
            .args(args)
            .spawn()
            .map(|_| ());
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = (program, args);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "interactive CLI login is unsupported on this platform",
        ))
    }
}

pub fn open_login(id: &str) -> Result<(), String> {
    let descriptors = load_descriptors()?;
    let desc = descriptors
        .into_iter()
        .find(|d| d.id == id)
        .ok_or_else(|| format!("unknown cli id: {id}"))?;
    let os = current_os_key();
    let candidates = desc
        .executables
        .get(os)
        .cloned()
        .unwrap_or_else(|| desc.executables.values().flatten().cloned().collect());
    let program =
        resolve_executable(&candidates).ok_or_else(|| format!("{id} is not installed"))?;

    if desc.login.open_in_terminal {
        return spawn_login_in_terminal(&program, &desc.login.args)
            .map_err(|e| format!("failed to open {id} login: {e}"));
    }

    let mut command = Command::new(&program);
    command.args(&desc.login.args).stdin(Stdio::null());
    crate::platform::hide_console(&mut command);
    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to open {id} login: {e}"))
}

#[tauri::command]
pub async fn cli_detect_refresh() -> Result<CliDetectionSnapshot, String> {
    tokio::task::spawn_blocking(detect_all)
        .await
        .map_err(|e| format!("cli_detect_refresh join: {e}"))?
}

#[tauri::command]
pub async fn cli_detect_one(id: String) -> Result<CliDetectionResult, String> {
    tokio::task::spawn_blocking(move || detect_by_id(&id))
        .await
        .map_err(|e| format!("cli_detect_one join: {e}"))?
}

#[tauri::command]
pub async fn cli_open_login(id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || open_login(&id))
        .await
        .map_err(|e| format!("cli_open_login join: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules_from(desc_json: &str) -> Vec<ClassifyRule> {
        let desc: CliDescriptor = serde_json::from_str(desc_json).expect("descriptor");
        desc.readiness.classify
    }

    #[test]
    fn descriptors_parse() {
        let descriptors = load_descriptors().expect("load");
        assert_eq!(descriptors.len(), 4);
        assert!(descriptors.iter().any(|descriptor| descriptor.id == "agy"));
    }

    #[test]
    fn classify_agy_models_readiness_without_output_matching() {
        let rules = rules_from(include_str!("../cli-descriptors/agy.json"));
        assert_eq!(
            classify_outcome(
                &rules,
                &CommandOutcome {
                    spawn_error: None,
                    timed_out: false,
                    exit_code: Some(0),
                    stdout: "some available models".into(),
                    stderr: String::new(),
                },
            ),
            "ready"
        );
        assert_eq!(
            classify_outcome(
                &rules,
                &CommandOutcome {
                    spawn_error: None,
                    timed_out: false,
                    exit_code: Some(1),
                    stdout: String::new(),
                    stderr: "authentication required".into(),
                },
            ),
            "login-required"
        );
    }

    #[test]
    fn agy_uses_interactive_login_fallback() {
        let descriptor: CliDescriptor =
            serde_json::from_str(include_str!("../cli-descriptors/agy.json")).unwrap();
        assert_eq!(descriptor.readiness.args, vec![String::from("models")]);
        assert!(descriptor.login.args.is_empty());
        assert!(descriptor.login.open_in_terminal);
    }

    #[test]
    fn classify_not_found_without_english() {
        let rules = rules_from(include_str!("../cli-descriptors/codex.json"));
        let status = classify_outcome(
            &rules,
            &CommandOutcome {
                spawn_error: Some("notFound"),
                timed_out: false,
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
            },
        );
        assert_eq!(status, "not-installed");
    }

    #[test]
    fn classify_codex_exit_codes() {
        let rules = rules_from(include_str!("../cli-descriptors/codex.json"));
        assert_eq!(
            classify_outcome(
                &rules,
                &CommandOutcome {
                    spawn_error: None,
                    timed_out: false,
                    exit_code: Some(0),
                    stdout: String::new(),
                    stderr: String::new(),
                },
            ),
            "ready"
        );
        assert_eq!(
            classify_outcome(
                &rules,
                &CommandOutcome {
                    spawn_error: None,
                    timed_out: false,
                    exit_code: Some(1),
                    stdout: String::new(),
                    stderr: String::new(),
                },
            ),
            "login-required"
        );
    }

    #[test]
    fn classify_timeout_as_waiting_input() {
        let rules = rules_from(include_str!("../cli-descriptors/claude.json"));
        assert_eq!(
            classify_outcome(
                &rules,
                &CommandOutcome {
                    spawn_error: None,
                    timed_out: true,
                    exit_code: None,
                    stdout: String::new(),
                    stderr: String::new(),
                },
            ),
            "waiting-input"
        );
    }

    #[test]
    fn classify_claude_json_logged_in() {
        let rules = rules_from(include_str!("../cli-descriptors/claude.json"));
        assert_eq!(
            classify_outcome(
                &rules,
                &CommandOutcome {
                    spawn_error: None,
                    timed_out: false,
                    exit_code: Some(0),
                    stdout: r#"{"loggedIn":true,"authMethod":"claude.ai"}"#.into(),
                    stderr: String::new(),
                },
            ),
            "ready"
        );
        assert_eq!(
            classify_outcome(
                &rules,
                &CommandOutcome {
                    spawn_error: None,
                    timed_out: false,
                    exit_code: Some(0),
                    stdout: r#"{"loggedIn":false}"#.into(),
                    stderr: String::new(),
                },
            ),
            "login-required"
        );
    }

    #[test]
    fn classify_claude_without_structured_json_as_error() {
        let rules = rules_from(include_str!("../cli-descriptors/claude.json"));
        assert_eq!(
            classify_outcome(
                &rules,
                &CommandOutcome {
                    spawn_error: None,
                    timed_out: false,
                    exit_code: Some(0),
                    stdout: "logged in".into(),
                    stderr: String::new(),
                },
            ),
            "error"
        );
    }

    #[test]
    fn classify_grok_nonzero_exit_does_not_use_auth_file_rule() {
        let rules = rules_from(include_str!("../cli-descriptors/grok.json"));
        assert_eq!(
            classify_outcome(
                &rules,
                &CommandOutcome {
                    spawn_error: None,
                    timed_out: false,
                    exit_code: Some(1),
                    stdout: String::new(),
                    stderr: String::new(),
                },
            ),
            "login-required"
        );
    }

    #[test]
    fn windows_candidates_include_more_than_cmd() {
        let desc: CliDescriptor =
            serde_json::from_str(include_str!("../cli-descriptors/codex.json")).unwrap();
        let win = desc.executables.get("windows").unwrap();
        assert!(win.iter().any(|c| c == "codex.exe"));
        assert!(win.iter().any(|c| c == "codex.cmd"));
        assert!(win.iter().any(|c| c == "codex"));
        assert!(!win.iter().all(|c| c.ends_with(".cmd")));
    }
}
