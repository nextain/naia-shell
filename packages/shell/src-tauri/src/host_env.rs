//! 시스템 프로그램(curl·git·bash·python 등)을 띄울 때 AppImage 가 주입한 환경을 되돌린다.
//!
//! AppImage(AppRun, linuxdeploy 훅)는 번들 폴더(`$APPDIR`)를 가리키는 값을
//! `LD_LIBRARY_PATH`·`PATH`·`XDG_DATA_DIRS`·`GST_*`·`GIO_*`·`GTK_*`·`PYTHON*` 등에 넣고
//! 자식 프로세스에 그대로 물려준다. 번들 `libssl.so.3` 이 시스템 `libcurl` 보다 앞서
//! 잡히면 새 OpenSSL 을 기대하는 시스템 `curl`/`git-remote-https` 가
//! "version `OPENSSL_3.2.0' not found" 로 죽는다(#729 Steam 빌드).
//!
//! 이름 목록 대신 값을 본다: `APPDIR` 아래를 가리키는 항목은 모든 변수에서 뺀다.
//! 번들 안 프로그램(node, 에이전트, WebKit 도우미)에는 쓰지 말 것 — 그쪽은 번들 경로가 필요하다.

use std::ffi::{OsStr, OsString};
use std::process::Command;

fn is_under(entry: &str, appdir: &str) -> bool {
    entry == appdir
        || entry
            .strip_prefix(appdir)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// `appdir` 아래를 가리키는 `:` 구분 항목을 뺀 값. 바뀐 것이 없으면 `None`,
/// 전부 빠져 비면 `Some(None)`, 일부만 남으면 `Some(Some(남은 값))`.
pub(crate) fn strip_appdir_entries(value: &str, appdir: &str) -> Option<Option<String>> {
    let appdir = appdir.trim_end_matches('/');
    if appdir.is_empty() || !value.contains(appdir) {
        return None;
    }
    let kept: Vec<&str> = value
        .split(':')
        .filter(|entry| !is_under(entry, appdir))
        .collect();
    let rebuilt = kept.join(":");
    if rebuilt == value {
        return None;
    }
    Some(if kept.iter().all(|entry| entry.is_empty()) {
        None
    } else {
        Some(rebuilt)
    })
}

/// 자식에게 줄 환경 변경 목록: `(이름, Some(새 값))` 은 덮어쓰기, `(이름, None)` 은 제거.
pub(crate) fn host_tool_env_changes<I>(vars: I) -> Vec<(OsString, Option<OsString>)>
where
    I: IntoIterator<Item = (OsString, OsString)>,
{
    let vars: Vec<(OsString, OsString)> = vars.into_iter().collect();
    let Some(appdir) = vars
        .iter()
        .find(|(name, _)| name == OsStr::new("APPDIR"))
        .and_then(|(_, value)| value.to_str())
        .filter(|value| !value.is_empty())
    else {
        return Vec::new();
    };
    vars.iter()
        .filter(|(name, _)| name != OsStr::new("APPDIR"))
        .filter_map(|(name, value)| {
            let text = value.to_str()?;
            strip_appdir_entries(text, appdir)
                .map(|stripped| (name.clone(), stripped.map(OsString::from)))
        })
        .collect()
}

/// 이 프로세스의 환경에서 AppImage 주입분을 뺀 `(이름, 값)` 목록(현재 값 조회용).
pub(crate) fn host_env_var(name: &str) -> String {
    let raw = std::env::var(name).unwrap_or_default();
    match std::env::var("APPDIR") {
        Ok(appdir) => match strip_appdir_entries(&raw, &appdir) {
            Some(Some(value)) => value,
            Some(None) => String::new(),
            None => raw,
        },
        Err(_) => raw,
    }
}

/// 시스템 프로그램용 Command 에 AppImage 주입 환경을 되돌린다. AppImage 밖에서는 아무 일도 안 한다.
pub(crate) fn sanitize_for_host_tool(command: &mut Command) -> &mut Command {
    for (name, value) in host_tool_env_changes(std::env::vars_os()) {
        match value {
            Some(value) => command.env(name, value),
            None => command.env_remove(name),
        };
    }
    command
}

/// 시스템 프로그램을 띄우는 Command(주입 환경 되돌림 포함).
pub(crate) fn host_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    sanitize_for_host_tool(&mut command);
    command
}

/// 프로그램이 번들(`APPDIR` 아래)에 있으면 true. 이름만 있는 프로그램(PATH 탐색)은 시스템 것으로 본다.
pub(crate) fn program_is_bundled(program: &OsStr, appdir: Option<&str>) -> bool {
    let Some(appdir) = appdir.map(|value| value.trim_end_matches('/')).filter(|v| !v.is_empty())
    else {
        return false;
    };
    program.to_str().is_some_and(|text| is_under(text, appdir))
}

/// 실행 시점에 경로가 정해지는 프로그램용 Command. 번들 안 프로그램(node, 에이전트 등)은
/// 상속 환경을 그대로 두고, 그 밖의 것(시스템 설치본, PATH 로 찾은 이름)은 주입 환경을 되돌린다.
pub(crate) fn command_for(program: impl AsRef<OsStr>) -> Command {
    let appdir = std::env::var("APPDIR").ok();
    if program_is_bundled(program.as_ref(), appdir.as_deref()) {
        Command::new(program)
    } else {
        host_command(program)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(k, v)| (OsString::from(k), OsString::from(v)))
            .collect()
    }

    #[test]
    fn 번들_항목만_빼고_원래_값은_남긴다() {
        let value = "/app/usr/lib/:/app/usr/lib64/:/opt/vendor/lib:/usr/lib";
        assert_eq!(
            strip_appdir_entries(value, "/app"),
            Some(Some("/opt/vendor/lib:/usr/lib".to_string()))
        );
    }

    #[test]
    fn 이름이_비슷한_다른_폴더는_건드리지_않는다() {
        assert_eq!(strip_appdir_entries("/app2/lib:/usr/lib", "/app"), None);
    }

    #[test]
    fn 전부_번들이면_변수를_없앤다() {
        assert_eq!(strip_appdir_entries("/app/usr/lib/gstreamer-1.0", "/app"), Some(None));
        assert_eq!(strip_appdir_entries("/app//usr/lib/gtk-3.0", "/app"), Some(None));
    }

    #[test]
    fn appdir_가_없으면_아무것도_바꾸지_않는다() {
        let env = os(&[("LD_LIBRARY_PATH", "/app/usr/lib")]);
        assert!(host_tool_env_changes(env).is_empty());
    }

    #[test]
    fn 이름_목록_없이_값으로_모든_변수를_고친다() {
        let env = os(&[
            ("APPDIR", "/app"),
            ("LD_LIBRARY_PATH", "/app/usr/lib/:/app/lib/:/usr/lib64"),
            ("GST_PLUGIN_SCANNER_1_0", "/app/usr/lib/gstreamer1.0/gst-plugin-scanner"),
            ("GIO_EXTRA_MODULES", "/app/usr/lib/x86_64-linux-gnu/gio/modules"),
            ("XDG_DATA_DIRS", "/app/usr/share:/usr/share:"),
            ("HOME", "/home/u"),
        ]);
        let changes = host_tool_env_changes(env);
        let get = |name: &str| {
            changes
                .iter()
                .find(|(n, _)| n == OsStr::new(name))
                .map(|(_, v)| v.clone())
        };
        assert_eq!(get("LD_LIBRARY_PATH"), Some(Some(OsString::from("/usr/lib64"))));
        assert_eq!(get("GST_PLUGIN_SCANNER_1_0"), Some(None));
        assert_eq!(get("GIO_EXTRA_MODULES"), Some(None));
        assert_eq!(get("XDG_DATA_DIRS"), Some(Some(OsString::from("/usr/share:"))));
        assert_eq!(get("HOME"), None);
        assert_eq!(get("APPDIR"), None);
    }

    #[test]
    fn command_에_덮어쓰기와_제거가_들어간다() {
        // 환경을 직접 건드리지 않고 변경 목록을 Command 에 적용하는 경로만 확인한다.
        let mut command = Command::new("true");
        for (name, value) in host_tool_env_changes(os(&[
            ("APPDIR", "/app"),
            ("LD_LIBRARY_PATH", "/app/usr/lib"),
            ("PATH", "/app/usr/bin/:/usr/bin"),
        ])) {
            match value {
                Some(value) => command.env(name, value),
                None => command.env_remove(name),
            };
        }
        let envs: Vec<_> = command.get_envs().collect();
        assert!(envs.contains(&(OsStr::new("LD_LIBRARY_PATH"), None)));
        assert!(envs.contains(&(OsStr::new("PATH"), Some(OsStr::new("/usr/bin")))));
    }

    #[test]
    fn 번들_안_프로그램만_번들로_본다() {
        let bundled = OsStr::new("/app/usr/lib/Naia/node");
        assert!(program_is_bundled(bundled, Some("/app")));
        assert!(!program_is_bundled(OsStr::new("/usr/bin/node"), Some("/app")));
        assert!(!program_is_bundled(OsStr::new("node"), Some("/app")));
        assert!(!program_is_bundled(OsStr::new("/app2/node"), Some("/app")));
        assert!(!program_is_bundled(bundled, None));
    }
}
