use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

/// Minimum PATH/bundled herdr. Protocol 19..=22 covers 0.8.0–0.9.1 (#645).
const HERDR_MIN_VERSION: (u32, u32, u32) = (0, 8, 0);
static HERDR_CONFIG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static HERDR_CONFIG_PATH: OnceLock<std::path::PathBuf> = OnceLock::new();
static HERDR_BIN: OnceLock<std::ffi::OsString> = OnceLock::new();

/// Resolve the Herdr executable once at startup: the version bundled next to the
/// app (`resource_dir/herdr/herdr.exe` — staged by stage-herdr.mjs) is preferred
/// so a packaged install needs no separately-installed Herdr; otherwise fall
/// back to `herdr` on PATH (dev, where resources are not staged). Call once from
/// the Tauri setup hook.
pub fn init_herdr_bin(app: &AppHandle) {
    let resolved = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| {
            dir.join("herdr")
                .join(if cfg!(windows) { "herdr.exe" } else { "herdr" })
        })
        .filter(|path| path.is_file())
        .map(std::ffi::OsString::from)
        .unwrap_or_else(|| std::ffi::OsString::from("herdr"));
    let _ = HERDR_BIN.set(resolved);
}

/// The resolved Herdr executable (bundled resource or PATH fallback). Safe before
/// `init_herdr_bin` (returns the PATH name).
pub(super) fn herdr_bin() -> std::ffi::OsString {
    HERDR_BIN
        .get()
        .cloned()
        .unwrap_or_else(|| std::ffi::OsString::from("herdr"))
}

/// e2e 하네스가 붙을 herdr 세션 이름. 제품 실행에서는 `None`.
///
/// 워크스페이스 탭이 사람의 herdr 세션을 그대로 보여 주는 것은 **설계**다. 그런데
/// 그 설계가 하네스에도 그대로 적용되면, e2e 가 워크스페이스를 열 때마다 사람이
/// 지금 쓰고 있는 세션에 클라이언트가 하나 더 붙어 그 세션을 앱 터미널 크기로
/// 리사이즈한다(실측: `~/.config/herdr/herdr-server.log` 의 `client resize …
/// cols=80 rows=24`). 사람이 보던 화면이 시험 때문에 움직인다.
///
/// herdr 은 이름 있는 세션마다 디렉터리와 소켓을 따로 둔다
/// (`herdr session list` 의 `directory`·`socket` 열). 그래서 하네스일 때만
/// `--session <이름>` 을 얹어 빈 세션에 붙는다. 제품 경로는 한 글자도 바뀌지 않는다.
pub(super) fn herdr_session_name() -> Option<String> {
    crate::e2e_runtime_dir().map(|runtime| session_name_for_runtime(&runtime))
}

/// 일반어로 끝나는 마디. 이것만 보면 실행이 서로 같은 이름을 갖는다.
const GENERIC_RUNTIME_SEGMENTS: [&str; 7] = ["runtime", "run", "tmp", "temp", "e2e", "data", "."];

/// 실행 자리 경로에서 세션 이름을 만든다. 실행마다 달라야 두 실행이 서로의 세션에
/// 붙지 않는다.
///
/// 마지막 마디만 보면 안 된다 — 전용 환경의 실행 자리는
/// `<tmp>/naia-shell-e2e-codex-<포트>/runtime` 처럼 일반어로 끝나서, codex 실행이
/// 전부 `naia-e2e-runtime` 한 이름을 나눠 갖고 그 세션이 사람 홈에 남았다
/// (2026-09-06 실측). 그래서 경로에서 `naia-shell-e2e-…` 마디를 **찾아** 그 뒤를 쓰고,
/// 그런 마디가 없으면 일반어가 아닌 마지막 마디로 내려간다.
///
/// 규칙은 `e2e-tauri/herdr-session.mjs` 와 **같아야 한다** — 여기가 세션을 만들고
/// 거기가 내린다. 계약이 같은 예제들로 둘을 묶는다.
fn session_name_for_runtime(runtime: &std::path::Path) -> String {
    let segments: Vec<&str> = runtime
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .filter(|segment| !segment.is_empty() && *segment != "/" && *segment != "\\")
        .collect();
    let mut raw = "";
    for segment in segments.iter().rev() {
        if let Some(rest) = segment.strip_prefix("naia-shell-e2e-") {
            raw = rest;
            break;
        }
    }
    if raw.is_empty() {
        for segment in segments.iter().rev() {
            if GENERIC_RUNTIME_SEGMENTS
                .iter()
                .any(|generic| segment.eq_ignore_ascii_case(generic))
            {
                continue;
            }
            raw = segment.strip_prefix("naia-shell-e2e-").unwrap_or(segment);
            break;
        }
    }
    let tag: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let tag = tag.trim_matches('-');
    if tag.is_empty() {
        "naia-e2e".to_string()
    } else {
        format!("naia-e2e-{tag}")
    }
}

/// `herdr` 를 부르는 모든 자리는 이 함수를 지난다 — 하네스 세션이 한 자리에서
/// 얹힌다. `--session` 은 하위 명령보다 **앞**에 와야 하는 전역 옵션이라 여기서
/// 먼저 넣는다.
pub(super) fn herdr_command() -> std::process::Command {
    let mut command = std::process::Command::new(herdr_bin());
    if let Some(session) = herdr_session_name() {
        command.arg("--session").arg(session);
    }
    crate::platform::hide_console(&mut command);
    command
}

fn parse_herdr_version(raw: &str) -> Option<(u32, u32, u32)> {
    let version = raw.split_whitespace().find(|part| {
        part.chars().next().is_some_and(|c| c.is_ascii_digit()) && part.contains('.')
    })?;
    let mut parts = version.split('.');
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.split('-').next()?.parse().ok()?,
    ))
}

/// Set `key = value` inside the given TOML `section` header (e.g. `[ui]`),
/// replacing an existing (possibly commented-out) key or appending a new one,
/// and creating the section if it is absent. Preserves all other content.
fn replace_or_insert_setting(config: &mut String, section: &str, key: &str, value: &str) {
    let lines: Vec<&str> = config.lines().collect();
    let mut in_section = false;
    let mut section_found = false;
    let mut replaced = false;
    let mut output = Vec::with_capacity(lines.len() + 4);

    for line in lines {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if in_section && !replaced {
                output.push(format!("{key} = {value}"));
                replaced = true;
            }
            in_section = trimmed == section;
            section_found |= in_section;
        }
        if in_section {
            let uncommented = trimmed.strip_prefix('#').unwrap_or(trimmed).trim();
            if uncommented
                .split_once('=')
                .is_some_and(|(candidate, _)| candidate.trim() == key)
            {
                if !replaced {
                    output.push(format!("{key} = {value}"));
                    replaced = true;
                }
                continue;
            }
        }
        output.push(line.to_string());
    }
    if !section_found {
        output.push(String::new());
        output.push(section.to_string());
    }
    if !replaced {
        output.push(format!("{key} = {value}"));
    }
    *config = output.join("\n") + "\n";
}

pub(super) fn write_embedded_herdr_config(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    if let Some(path) = HERDR_CONFIG_PATH.get() {
        return Ok(path.clone());
    }
    let _config_guard = HERDR_CONFIG_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Herdr config lock poisoned".to_string())?;
    if let Some(path) = HERDR_CONFIG_PATH.get() {
        return Ok(path.clone());
    }
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("herdr app config directory unavailable: {e}"))?
        .join("herdr-embedded");
    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("herdr embedded config directory failed: {e}"))?;

    let global_path = dirs::config_dir().map(|path| path.join("herdr").join("config.toml"));
    let mut config = global_path
        .as_ref()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .unwrap_or_else(|| "[ui]\n".to_string());
    replace_or_insert_setting(&mut config, "[ui]", "sidebar_start_collapsed", "true");
    replace_or_insert_setting(&mut config, "[ui]", "sidebar_collapsed_mode", "\"hidden\"");
    // Allow the embedded client to run even when the desktop app was itself
    // launched from inside a herdr pane (the dev terminal inherits HERDR_ENV /
    // HERDR_PANE_ID). Without this herdr refuses with "nested herdr is disabled"
    // and the PTY exits immediately ("Herdr가 종료되었습니다"). In a packaged
    // launch there is no parent herdr, so this is a harmless no-op there.
    replace_or_insert_setting(&mut config, "[experimental]", "allow_nested", "true");
    // Default to the shell's dark theme; herdr_set_theme() rewrites this to
    // follow the app's light/dark selection at runtime.
    apply_herdr_theme(&mut config, true);

    let path = config_dir.join("config.toml");
    let temporary = config_dir.join("config.toml.tmp");
    std::fs::write(&temporary, config.as_bytes())
        .map_err(|e| format!("herdr embedded config write failed: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("herdr embedded config permissions failed: {e}"))?;
    }
    #[cfg(windows)]
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("herdr embedded config replace preparation failed: {e}"))?;
    }
    std::fs::rename(&temporary, &path)
        .map_err(|e| format!("herdr embedded config replace failed: {e}"))?;
    let _ = HERDR_CONFIG_PATH.set(path.clone());
    Ok(path)
}

/// Set the embedded Herdr theme to match the shell's light/dark selection, kept
/// to Herdr's documented-safe custom tokens (name, app_bg, accent). Dark =
/// the shell midnight palette; light = a readable light base (catppuccin-latte)
/// with the shell espresso palette — the light variant is deliberately a
/// well-formed readable theme, not a washed-out default.
fn apply_herdr_theme(config: &mut String, dark: bool) {
    let (name, app_bg, accent) = if dark {
        ("\"one-dark\"", "\"#202124\"", "\"#8ab4f8\"")
    } else {
        ("\"catppuccin-latte\"", "\"#f8fafc\"", "\"#2563eb\"")
    };
    replace_or_insert_setting(config, "[theme]", "name", name);
    replace_or_insert_setting(config, "[theme.custom]", "app_bg", app_bg);
    replace_or_insert_setting(config, "[theme.custom]", "accent", accent);
}

/// Rewrite the embedded config's theme to the shell's light/dark selection and
/// hot-reload the running Herdr server so the embedded terminal follows the app.
pub(super) fn set_herdr_theme(app: &AppHandle, dark: bool) -> Result<(), String> {
    let path = write_embedded_herdr_config(app)?;
    let _guard = HERDR_CONFIG_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Herdr config lock poisoned".to_string())?;
    let mut config =
        std::fs::read_to_string(&path).map_err(|e| format!("herdr config read failed: {e}"))?;
    apply_herdr_theme(&mut config, dark);
    let temporary = path.with_extension("toml.tmp");
    std::fs::write(&temporary, config.as_bytes())
        .map_err(|e| format!("herdr theme write failed: {e}"))?;
    #[cfg(windows)]
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("herdr theme replace preparation failed: {e}"))?;
    }
    std::fs::rename(&temporary, &path).map_err(|e| format!("herdr theme replace failed: {e}"))?;
    // Hot-reload the running server (no-op error if none is running yet).
    let _ = herdr_command().args(["server", "reload-config"]).output();
    Ok(())
}

pub(super) fn validate_herdr() -> Result<String, String> {
    let output = herdr_command()
        .arg("--version")
        .output()
        .map_err(|e| format!("Herdr is not installed or not on PATH: {e}"))?;
    if !output.status.success() {
        return Err("Herdr version check failed".to_string());
    }
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let version =
        parse_herdr_version(&raw).ok_or_else(|| format!("Unrecognized Herdr version: {raw}"))?;
    if version < HERDR_MIN_VERSION {
        return Err(format!("Herdr 0.8.0 or newer is required; found {raw}"));
    }
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn harness_session_name_is_per_run_and_never_the_default_session() {
        // 사람의 세션은 `default` 다. 하네스가 그 이름을 만들어 내면 안 된다.
        let name = session_name_for_runtime(std::path::Path::new("/tmp/naia-shell-e2e-4448"));
        assert_eq!(name, "naia-e2e-4448");
        assert_ne!(name, "default");

        // 실행마다 자리 이름이 다르므로 세션도 다르다.
        assert_ne!(
            session_name_for_runtime(std::path::Path::new("/tmp/naia-shell-e2e-4448")),
            session_name_for_runtime(std::path::Path::new("/tmp/naia-shell-e2e-4449")),
        );

        // 전용 환경은 일반어로 끝난다 — 마지막 마디만 보면 codex 실행이 모두 같은
        // 이름을 갖고 그 세션이 사람 홈에 남는다(2026-09-06 실측).
        assert_eq!(
            session_name_for_runtime(std::path::Path::new(
                "/tmp/naia-shell-e2e-codex-4455/runtime"
            )),
            "naia-e2e-codex-4455"
        );
        assert_ne!(
            session_name_for_runtime(std::path::Path::new(
                "/tmp/naia-shell-e2e-codex-4455/runtime"
            )),
            session_name_for_runtime(std::path::Path::new(
                "/tmp/naia-shell-e2e-codex-4456/runtime"
            )),
        );
        assert_ne!(
            session_name_for_runtime(std::path::Path::new("/tmp/naia-shell-e2e-4448/runtime")),
            "naia-e2e-runtime"
        );

        // 이름에 쓸 수 없는 글자는 지운다. 빈 이름이 되면 고정 이름으로 떨어진다.
        assert_eq!(
            session_name_for_runtime(std::path::Path::new("/tmp/run dir.1")),
            "naia-e2e-run-dir-1"
        );
        assert_eq!(
            session_name_for_runtime(std::path::Path::new("/tmp/---")),
            "naia-e2e"
        );
    }

    #[test]
    fn embedded_config_preserves_other_settings_and_replaces_sidebar_values() {
        let mut config = "theme = \"naia\"\n[ui]\nsidebar_start_collapsed = false\n# sidebar_collapsed_mode = \"compact\"\nmobile_breakpoint = 90\n[keys]\nquit = \"q\"\n".to_string();
        replace_or_insert_setting(&mut config, "[ui]", "sidebar_start_collapsed", "true");
        replace_or_insert_setting(&mut config, "[ui]", "sidebar_collapsed_mode", "\"hidden\"");
        replace_or_insert_setting(&mut config, "[experimental]", "allow_nested", "true");
        assert!(config.contains("theme = \"naia\""));
        assert!(config.contains("sidebar_start_collapsed = true"));
        assert!(config.contains("sidebar_collapsed_mode = \"hidden\""));
        assert!(config.contains("mobile_breakpoint = 90"));
        assert!(config.contains("[keys]"));
        assert!(config.contains("[experimental]"));
        assert!(config.contains("allow_nested = true"));
        assert_eq!(config.matches("sidebar_start_collapsed").count(), 1);
    }

    #[test]
    fn parses_supported_version_shapes() {
        assert_eq!(parse_herdr_version("herdr 0.8.0"), Some((0, 8, 0)));
        assert_eq!(parse_herdr_version("herdr 1.2.3-preview"), Some((1, 2, 3)));
    }
}
