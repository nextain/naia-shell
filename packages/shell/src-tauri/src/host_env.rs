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

fn trim_trailing_slashes(mut appdir: &[u8]) -> &[u8] {
    while let [rest @ .., b'/'] = appdir {
        appdir = rest;
    }
    appdir
}

fn is_under(entry: &[u8], appdir: &[u8]) -> bool {
    entry == appdir
        || entry
            .strip_prefix(appdir)
            .is_some_and(|rest| rest.first() == Some(&b'/'))
}

/// 바이트 단위 정리. 리눅스 경로·환경값은 UTF-8 이 아닐 수 있으므로 문자열로 바꾸지 않는다.
fn strip_appdir_bytes(value: &[u8], appdir: &[u8]) -> Option<Option<Vec<u8>>> {
    let appdir = trim_trailing_slashes(appdir);
    // `APPDIR=/` 는 AppImage 가 만들지 않는 값이다. 그대로 따르면 `/usr/lib` 같은 시스템
    // 항목까지 모두 빠져 시스템 프로그램이 더 크게 깨지므로, 정리하지 않고 그대로 둔다.
    if appdir.is_empty() || !value.windows(appdir.len()).any(|w| w == appdir) {
        return None;
    }
    let kept: Vec<&[u8]> = value
        .split(|byte| *byte == b':')
        .filter(|entry| !is_under(entry, appdir))
        .collect();
    let rebuilt = kept.join(&b':');
    if rebuilt == value {
        return None;
    }
    Some(if kept.iter().all(|entry| entry.is_empty()) {
        None
    } else {
        Some(rebuilt)
    })
}

/// `OsStr` 판. `:`(ASCII) 경계에서만 자르고 잇기 때문에 인코딩된 바이트가 그대로 유효하다.
fn strip_appdir_os(value: &OsStr, appdir: &OsStr) -> Option<Option<OsString>> {
    strip_appdir_bytes(value.as_encoded_bytes(), appdir.as_encoded_bytes()).map(|stripped| {
        // SAFETY: 입력 OsStr 의 바이트를 ASCII `:` 경계에서만 나누고 이었다.
        stripped.map(|bytes| unsafe { OsString::from_encoded_bytes_unchecked(bytes) })
    })
}

/// `appdir` 아래를 가리키는 `:` 구분 항목을 뺀 값. 바뀐 것이 없으면 `None`,
/// 전부 빠져 비면 `Some(None)`, 일부만 남으면 `Some(Some(남은 값))`.
pub(crate) fn strip_appdir_entries(value: &str, appdir: &str) -> Option<Option<String>> {
    strip_appdir_bytes(value.as_bytes(), appdir.as_bytes())
        .map(|stripped| stripped.map(|bytes| String::from_utf8_lossy(&bytes).into_owned()))
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
        .map(|(_, value)| value.as_os_str())
        .filter(|value| !value.is_empty())
    else {
        return Vec::new();
    };
    vars.iter()
        .filter(|(name, _)| name != OsStr::new("APPDIR"))
        .filter_map(|(name, value)| {
            strip_appdir_os(value, appdir).map(|stripped| (name.clone(), stripped))
        })
        .collect()
}

/// 이 프로세스의 환경에서 AppImage 주입분을 뺀 `(이름, 값)` 목록(현재 값 조회용).
pub(crate) fn host_env_var(name: &str) -> String {
    let raw = std::env::var(name).unwrap_or_default();
    strip_path_list(&raw, std::env::var("APPDIR").ok().as_deref())
}

/// 경로 목록 값에서 APPDIR 아래 항목을 뺀 값(순수). APPDIR 이 없거나 해당 항목이 없으면 그대로.
pub(crate) fn strip_path_list(raw: &str, appdir: Option<&str>) -> String {
    match appdir {
        Some(appdir) => match strip_appdir_entries(raw, appdir) {
            Some(Some(value)) => value,
            Some(None) => String::new(),
            None => raw.to_string(),
        },
        None => raw.to_string(),
    }
}

/// 환경 목록을 주입받는 순수 판: 목록 기준으로 정리한 변경을 Command 에 적용한다.
pub(crate) fn apply_host_tool_env(
    command: &mut Command,
    vars: impl IntoIterator<Item = (OsString, OsString)>,
) -> &mut Command {
    for (name, value) in host_tool_env_changes(vars) {
        match value {
            Some(value) => command.env(name, value),
            None => command.env_remove(name),
        };
    }
    command
}

/// 시스템 프로그램용 Command 에 AppImage 주입 환경을 되돌린다. AppImage 밖에서는 아무 일도 안 한다.
pub(crate) fn sanitize_for_host_tool(command: &mut Command) -> &mut Command {
    apply_host_tool_env(command, std::env::vars_os())
}

/// 음성 런타임 python(슬롯 안, APPDIR 밖)을 띄우는 공용 Command. 호출부는 이 뒤에 자기 env 를 얹는다.
pub(crate) fn voice_python_command(python: impl AsRef<OsStr>) -> Command {
    voice_python_command_with(python, std::env::vars_os())
}

pub(crate) fn voice_python_command_with(
    python: impl AsRef<OsStr>,
    vars: impl IntoIterator<Item = (OsString, OsString)>,
) -> Command {
    host_command_with(python, vars)
}

/// 시스템 프로그램을 띄우는 Command(주입 환경 되돌림 포함).
pub(crate) fn host_command(program: impl AsRef<OsStr>) -> Command {
    host_command_with(program, std::env::vars_os())
}

/// `host_command` 의 환경 목록 주입판(정리 판정에만 쓰고, 자식은 실제 환경을 상속한다).
pub(crate) fn host_command_with(
    program: impl AsRef<OsStr>,
    vars: impl IntoIterator<Item = (OsString, OsString)>,
) -> Command {
    let mut command = Command::new(program);
    apply_host_tool_env(&mut command, vars);
    command
}

/// 프로그램이 번들(`APPDIR` 아래)에 있으면 true. 이름만 있는 프로그램(PATH 탐색)은 시스템 것으로 본다.
pub(crate) fn program_is_bundled(program: &OsStr, appdir: Option<&OsStr>) -> bool {
    let Some(appdir) = appdir
        .map(|value| trim_trailing_slashes(value.as_encoded_bytes()))
        .filter(|value| !value.is_empty())
    else {
        return false;
    };
    is_under(program.as_encoded_bytes(), appdir)
}

/// 실행 시점에 경로가 정해지는 프로그램용 Command. 번들 안 프로그램(node, 에이전트 등)은
/// 상속 환경을 그대로 두고, 그 밖의 것(시스템 설치본, PATH 로 찾은 이름)은 주입 환경을 되돌린다.
pub(crate) fn command_for(program: impl AsRef<OsStr>) -> Command {
    let appdir = std::env::var_os("APPDIR");
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
        assert!(program_is_bundled(bundled, Some(OsStr::new("/app"))));
        assert!(!program_is_bundled(OsStr::new("/usr/bin/node"), Some(OsStr::new("/app"))));
        assert!(!program_is_bundled(OsStr::new("node"), Some(OsStr::new("/app"))));
        assert!(!program_is_bundled(OsStr::new("/app2/node"), Some(OsStr::new("/app"))));
        assert!(!program_is_bundled(bundled, None));
    }

    #[test]
    fn appdir_가_루트면_시스템_항목을_지우지_않는다() {
        assert_eq!(strip_appdir_entries("/usr/lib:/usr/lib64", "/"), None);
        assert_eq!(strip_appdir_entries("/usr/bin", "///"), None);
    }

    #[cfg(unix)]
    #[test]
    fn utf8_가_아닌_appdir_와_값도_정리한다() {
        use std::os::unix::ffi::OsStrExt;
        let appdir = OsStr::from_bytes(b"/tmp/.mount_\xff\xfeNaia");
        let value = OsStr::from_bytes(b"/tmp/.mount_\xff\xfeNaia/usr/lib/:/usr/lib64");
        let changes = host_tool_env_changes(vec![
            (OsString::from("APPDIR"), appdir.to_os_string()),
            (OsString::from("LD_LIBRARY_PATH"), value.to_os_string()),
        ]);
        assert_eq!(
            changes,
            vec![(OsString::from("LD_LIBRARY_PATH"), Some(OsString::from("/usr/lib64")))]
        );
        let bundled = OsStr::from_bytes(b"/tmp/.mount_\xff\xfeNaia/usr/bin/node");
        assert!(program_is_bundled(bundled, Some(appdir)));
    }

    #[test]
    fn 주입_환경_판이_python_변수를_되돌리고_나머지는_상속에_맡긴다() {
        let mut command = Command::new("true");
        apply_host_tool_env(
            &mut command,
            os(&[
                ("APPDIR", "/tmp/.mount_Naia"),
                ("PYTHONHOME", "/tmp/.mount_Naia/usr/"),
                ("PYTHONPATH", "/tmp/.mount_Naia/usr/share/pyshared/"),
                ("LD_LIBRARY_PATH", "/tmp/.mount_Naia/usr/lib/:/usr/lib64"),
                ("CUDA_VISIBLE_DEVICES", "1"),
                ("NAIA_TOKEN", "secret"),
            ]),
        );
        command.env("PYTHONPATH", "/slot/payload");
        let envs: std::collections::HashMap<_, _> = command.get_envs().collect();
        assert_eq!(envs.get(OsStr::new("PYTHONHOME")), Some(&None));
        // 정리 뒤 호출부가 얹은 값이 이긴다.
        assert_eq!(envs.get(OsStr::new("PYTHONPATH")), Some(&Some(OsStr::new("/slot/payload"))));
        assert_eq!(
            envs.get(OsStr::new("LD_LIBRARY_PATH")),
            Some(&Some(OsStr::new("/usr/lib64")))
        );
        // APPDIR 밖 값은 건드리지 않는다(목록에 없음 = 상속 유지).
        assert!(!envs.contains_key(OsStr::new("CUDA_VISIBLE_DEVICES")));
        assert!(!envs.contains_key(OsStr::new("NAIA_TOKEN")));
    }

    #[cfg(unix)]
    #[test]
    fn 음성_python_Command_를_실제로_실행해_상속과_정리를_확인한다() {
        let mut command = voice_python_command_with(
            "/usr/bin/env",
            os(&[
                ("APPDIR", "/tmp/fake-appdir"),
                ("PYTHONHOME", "/tmp/fake-appdir/usr/"),
                ("LD_LIBRARY_PATH", "/tmp/fake-appdir/usr/lib:/usr/lib"),
                ("PYTHONPATH", "/tmp/fake-appdir/x"),
            ]),
        );
        command.env("PYTHONPATH", "/slot/pp");
        let output = command.output().expect("env 실행");
        let text = String::from_utf8_lossy(&output.stdout);
        let var = |name: &str| {
            text.lines()
                .find_map(|line| line.strip_prefix(&format!("{name}=")))
                .map(str::to_string)
        };
        assert_eq!(var("PYTHONHOME"), None);
        assert_eq!(var("LD_LIBRARY_PATH").as_deref(), Some("/usr/lib"));
        assert_eq!(var("PYTHONPATH").as_deref(), Some("/slot/pp"));
        // 부모 프로세스의 환경은 그대로 상속된다(env_clear 같은 상속 상실 회귀를 잡는다).
        assert_eq!(var("PATH"), std::env::var("PATH").ok());
    }

    #[test]
    fn 경로_목록_원본에서_appdir_항목을_뺀다() {
        assert_eq!(
            strip_path_list("/tmp/.mount_Naia/usr/lib/:/usr/lib64", Some("/tmp/.mount_Naia")),
            "/usr/lib64"
        );
        assert_eq!(strip_path_list("/tmp/.mount_Naia/usr/lib", Some("/tmp/.mount_Naia")), "");
        assert_eq!(strip_path_list("/usr/lib64", None), "/usr/lib64");
    }
}
