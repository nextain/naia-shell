//! 데이터 홈(`~/.naia`) 아래 자리를 만드는 **유일한 자리**.
//!
//! ## 목표 (2026-09-05, 루크 지시)
//!
//! `~/.naia` 에는 `adk-path` **하나만** 둔다. 그것은 어느 ADK 를 볼지 알려 주는
//! 부트스트랩 포인터라 ADK 밖에 있어야 한다. 로그·임차·PID·설치된 앱과 스킬·
//! 음성 런타임을 포함한 나머지 실행 부산물은 `adk-path` 가 가리키는 ADK 아래로
//! 가야 하고, 그 위치는 `adk-path` 에서 파생돼야 한다. 코드가 홈을 직접 짚으면
//! ADK 를 옮겼을 때 데이터가 따라가지 못한다.
//!
//! 아래 [`DataHomeChild`] 의 열넷 중 `AdkPath` 를 뺀 열셋은 **아직 홈에 있고,
//! 이관 대기 상태다.** 이 모듈은 이관을 대신하지 않는다. 이관하는 동안에도 새
//! 자리가 생기지 않게 입구를 하나로 모을 뿐이다(추적:
//! nextain/naia-agent#127, `docs/storage-locations.md`).
//!
//! ## 이 모듈이 입구인 이유
//!
//! 데이터 홈 아래 경로는 두 가지 방법으로만 만들 수 있다 — 데이터 홈을 돌려주는
//! 함수를 부르거나, 사용자 홈에 `.naia` 를 이어 붙이거나. 둘 다 이 파일 안에만
//! 둔다. 그래서 `scripts/check-data-home-boundary.mjs` 는 "새 자리 이름을 정규식이
//! 알아보는가" 를 묻지 않고 "이 파일 밖에서 홈을 짚었는가" 를 묻는다. 자리를
//! 하나 늘리려면 [`DataHomeChild`] 에 변형을 더해야 하고, 그러면 이름표가 늘어나
//! 검사기의 목록·문서와 어긋나 붉어진다.
//!
//! ## 이 모듈이 보증하지 않는 것
//!
//! 보증 범위는 "`~/.naia` **바로 아래** 새 자리가 이름표 없이 생기지 않는다" 뿐이다.
//! 이미 알려진 자리 **안쪽**(예 `logs/` 밑의 파일 이름, `apps/<앱 id>/…`)은 그 자리를
//! 가진 모듈의 책임이고, 이 검사는 거기까지 보지 않는다. 그렇게 끊어 두지 않으면
//! 경계가 저장소 전체로 번져 무한히 단단해지기만 한다.
//!
//! 문자열을 한 글자씩 조립해 `.naia` 를 만드는 코드(`format!(".{}", "naia")` 같은
//! 것)도 잡지 못한다. 그것은 우회가 아니라 위조라서, 검사기가 아니라 리뷰가 볼
//! 몫이다.
//!
//! 이 모듈이 돌려준 경로를 위로 거슬러(`parent`·`pop`) 형제 자리를 만드는 것도
//! 검사기 밖이다. 데이터 홈 **디렉터리 자체**를 돌려주는 함수는 모듈 밖에
//! 없으므로(비공개) 그러려면 눈에 띄는 경로 산술을 적어야 한다 — 실수로는
//! 나오지 않고 리뷰에서 보인다.

use std::path::{Path, PathBuf};

/// 데이터 홈 디렉터리의 이름. 사용자 홈 아래 이 이름으로 붙는다.
///
/// **비공개다.** 이 이름이 밖으로 나가면 홈 조회 하나만 더하면 이름표 없이
/// `~/.naia/<아무거나>` 를 조립할 수 있다. 실제로 11회차 리뷰가 그렇게 뚫었다 —
/// `user_home_path()?.join(DATA_HOME_DIR_NAME).join("ghost-cache")` 는 금지
/// 문자열도 금지 식별자도 쓰지 않는다. 이제 그 조립은 컴파일되지 않고,
/// `check-data-home-boundary.mjs` 의 공개 API 허용 목록이 다시 열리는 것도 막는다.
const DATA_HOME_DIR_NAME: &str = ".naia";

/// 홈을 못 찾는 윈도우 딥링크 경로의 마지막 수단. 앱이 뜨기 전에 쓰이는 자리라
/// 사용자 홈 없이도 어딘가에 써야 한다.
#[allow(dead_code)]
const WINDOWS_PUBLIC_FALLBACK: &str = r"C:\Users\Public\.naia";

/// 데이터 홈 **바로 아래**에 오늘 만들어지는 자리 열넷.
///
/// 변형 하나가 자리 하나다. 이름표는 [`DataHomeChild::name`] 한 곳에만 적고,
/// 검사기와 `docs/storage-locations.md` 의 표가 그 이름표와 정확히 같아야 한다.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DataHomeChild {
    /// 어느 ADK 를 볼지 가리키는 부트스트랩 포인터. **여기 남는 유일한 것.**
    AdkPath,
    /// 셸 로그.
    Logs,
    /// 실행 중 PID 파일.
    Run,
    /// 설치된 스킬.
    Skills,
    /// 로컬 음성 런타임(실측 17GB).
    Voxcpm2Runtime,
    /// 설치된 앱.
    Apps,
    /// #472 이전의 앱 자리(패널).
    Panels,
    /// 에이전트 자식 임차 파일.
    AgentChildLease,
    /// 위 임차의 잠금 파일.
    AgentChildLeaseLock,
    /// 내장 브라우저 프로필. 사용자의 로그인 상태가 들어 있다.
    ChromeProfile,
    /// 로그인 전용 브라우저 프로필.
    LoginProfile,
    /// macOS·윈도우 딥링크 대기 파일.
    DeepLinkPending,
    /// macOS 개발 인스턴스의 딥링크 헬퍼.
    DevDeepLink,
    /// 게이트웨이 기본 설정이 적어 두는 에이전트 워크스페이스. 경로가 아니라
    /// `~` 를 품은 **문자열**로 설정에 실려 나가 다른 프로세스가 푼다 — 그래서
    /// `NAIA_HOME` 도 타지 않는다. 옛 200자 창 검사가 못 보던 자리다.
    Workspace,
}

/// 검사기와 테스트가 세는 전체 목록. 변형을 더하면 여기도 더해야 한다.
pub const ALL_CHILDREN: [DataHomeChild; 14] = [
    DataHomeChild::AdkPath,
    DataHomeChild::Logs,
    DataHomeChild::Run,
    DataHomeChild::Skills,
    DataHomeChild::Voxcpm2Runtime,
    DataHomeChild::Apps,
    DataHomeChild::Panels,
    DataHomeChild::AgentChildLease,
    DataHomeChild::AgentChildLeaseLock,
    DataHomeChild::ChromeProfile,
    DataHomeChild::LoginProfile,
    DataHomeChild::DeepLinkPending,
    DataHomeChild::DevDeepLink,
    DataHomeChild::Workspace,
];

impl DataHomeChild {
    /// 자리 이름. 이 대응표가 검사기·문서와 맞춰지는 단일 출처다.
    pub const fn name(self) -> &'static str {
        match self {
            DataHomeChild::AdkPath => "adk-path",
            DataHomeChild::Logs => "logs",
            DataHomeChild::Run => "run",
            DataHomeChild::Skills => "skills",
            DataHomeChild::Voxcpm2Runtime => "voxcpm2-runtime",
            DataHomeChild::Apps => "apps",
            DataHomeChild::Panels => "panels",
            DataHomeChild::AgentChildLease => "agent-child-lease.json",
            DataHomeChild::AgentChildLeaseLock => "agent-child-lease.lock",
            DataHomeChild::ChromeProfile => "chrome-profile",
            DataHomeChild::LoginProfile => "login-profile",
            DataHomeChild::DeepLinkPending => "deep-link-pending.txt",
            DataHomeChild::DevDeepLink => "dev-deeplink",
            DataHomeChild::Workspace => "workspace",
        }
    }
}

// --- 사용자 홈 -----------------------------------------------------------
//
// 홈을 읽는 방법도 이 파일에만 둔다. 밖에서 홈을 다시 구하면 `.naia` 를 이어
// 붙이는 새 자리가 검사기 눈 밖에서 생길 수 있다. 뜻이 다른 넷을 그대로 옮겨
// 두어 동작이 한 글자도 바뀌지 않게 한다.
//
// 아래 넷은 **데이터 홈이 아닌** 자리를 짚으려고 공개돼 있다 — `~/dev`,
// `~/.agent-browser`, `~/.cache/huggingface`, `~/Library/LaunchAgents`, 그리고
// 경로 가드가 쓰는 홈 자체다. 데이터 홈은 이것들로 만들 수 없다: `.naia` 라는
// 이름이 이 파일 밖에 없고(위 상수는 비공개), 문자열로 적으면
// `check-data-home-boundary.mjs` 가 경로 마디로 잡는다. 데이터 홈 아래를
// 짚어야 하면 아래 이름표 API 를 쓴다.

/// 크로스 플랫폼 홈: `HOME`(유닉스) 또는 `USERPROFILE`(윈도우).
pub fn user_home() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default()
}

/// `dirs` 가 판단하는 홈. `user_home` 과 결과가 다를 수 있어 따로 둔다.
pub fn user_home_path() -> Option<PathBuf> {
    dirs::home_dir()
}

/// 유닉스 전용 홈(`HOME` 만). 윈도우로 흘러가지 않는 자리에서 쓴다.
#[allow(dead_code)]
pub fn unix_home() -> String {
    std::env::var("HOME").unwrap_or_default()
}

/// 윈도우 전용 홈(`USERPROFILE` 만).
#[allow(dead_code)]
pub fn windows_home() -> String {
    std::env::var("USERPROFILE").unwrap_or_default()
}

// --- 데이터 홈 -----------------------------------------------------------

/// FR-SHELL-ISO (#425): the Naia data home. A non-empty `NAIA_HOME` overrides
/// `<home>/.naia` so the isolated dev instance (Naia Dev, launched by
/// tauri-with-mode with NAIA_HOME=~/.naia-dev) keeps its adk-path cache,
/// lease files, logs, PID files, and skills apart from the production
/// install's data. Native E2E isolation (e2e_runtime_dir) stays senior.
fn naia_data_home_from(home: PathBuf) -> PathBuf {
    naia_data_home_with(home, std::env::var("NAIA_HOME").ok().as_deref())
}

/// Pure resolution half of [`naia_data_home_from`] — injectable for tests
/// without process-global env mutation.
fn naia_data_home_with(home: PathBuf, override_home: Option<&str>) -> PathBuf {
    match override_home {
        Some(v) if !v.trim().is_empty() => PathBuf::from(v),
        _ => home.join(DATA_HOME_DIR_NAME),
    }
}

/// 주어진 홈 기준 데이터 홈. `NAIA_HOME` 을 존중한다.
///
/// 밖으로 내지 않는다 — 데이터 홈 **디렉터리 자체**를 손에 쥐면 이름표 없이
/// 그 아래에 무엇이든 만들 수 있다. 밖에서는 자리 하나를 지목하는
/// [`child`]·[`child_of`] 만 쓴다.
fn root_of(home: &Path) -> PathBuf {
    naia_data_home_from(home.to_path_buf())
}

/// 주어진 홈 기준 자리. `NAIA_HOME` 을 존중한다.
pub fn child_of(home: &Path, child: DataHomeChild) -> PathBuf {
    root_of(home).join(child.name())
}

/// 환경에서 읽은 홈 기준 자리. `NAIA_HOME` 을 존중한다.
pub fn child(child: DataHomeChild) -> PathBuf {
    child_of(Path::new(&user_home()), child)
}

/// `dirs` 가 판단하는 홈 기준 자리. `NAIA_HOME` 을 존중한다.
///
/// 밖에서 `user_home_path()` 를 부른 뒤 [`child_of`] 를 이어 붙이던 자리를
/// 대신한다. 그렇게 두면 호출부가 홈 디렉터리를 손에 쥐게 되고, 그 손에서
/// 이름표 없는 자리가 나온다.
pub fn child_from_dirs_home(child: DataHomeChild) -> Option<PathBuf> {
    user_home_path().map(|home| child_of(&home, child))
}

/// 데이터 홈 아래 자리의 내용을 읽는다. 없거나 못 읽으면 `None`.
///
/// `adk-path` 부트스트랩 포인터를 읽는 자리가 여럿이다. 그 자리들이 저마다
/// 홈을 구해 경로를 조립하면 깔때기가 다섯 조각으로 갈라진다 — 읽는 일까지
/// 이름표로 받는다.
pub fn read_child_from_dirs_home(child: DataHomeChild) -> Option<String> {
    std::fs::read_to_string(child_from_dirs_home(child)?).ok()
}

// --- 옛 자리 (NAIA_HOME 을 거치지 않는다) -------------------------------
//
// 아래 둘은 `<home>/.naia` 를 직접 짚는다. `NAIA_HOME` 을 무시하므로 격리된
// 개발 인스턴스가 운영 데이터를 건드릴 수 있다 — 이관할 때 함께 풀 것이고,
// 그때까지 동작을 바꾸지 않으려고 그대로 옮겨 둔다.

/// `NAIA_HOME` 을 무시하고 `<home>/.naia` 를 짚는다. 위와 같은 이유로 밖으로
/// 내지 않는다.
fn direct_root_of(home: &Path) -> PathBuf {
    home.join(DATA_HOME_DIR_NAME)
}

/// `NAIA_HOME` 을 무시하고 `<home>/.naia/<자리>` 를 짚는다.
pub fn direct_child_of(home: &Path, child: DataHomeChild) -> PathBuf {
    direct_root_of(home).join(child.name())
}

/// 환경에서 읽은 홈 기준 옛 자리.
#[allow(dead_code)]
pub fn direct_child(child: DataHomeChild) -> PathBuf {
    direct_child_of(Path::new(&user_home()), child)
}

/// `~/.naia/<자리>` 꼴의 tilde 문자열. 경로가 아니라 문자열로 설정 파일에
/// 실려 나가는 자리에만 쓴다.
pub fn tilde_child(child: DataHomeChild) -> String {
    format!("~/{}/{}", DATA_HOME_DIR_NAME, child.name())
}

/// macOS 딥링크 헬퍼(AppleScript)가 쓰는 **홈 기준 상대 경로** 두 조각:
/// 데이터 홈 자체와 그 아래 대기 파일.
///
/// 그 스크립트는 앱 밖에서 돌며 홈을 스스로 구한다. 그래서 경로를 통째로
/// 넘길 수 없고 상대 경로가 필요하다. 데이터 홈 이름을 밖으로 내주는 대신,
/// 이 한 자리에만 쓰이는 조각을 여기서 조립해 준다 — 게이트의 허용 목록이
/// 이 항목을 `platform/macos.rs` 로 묶어 둔다.
pub fn deep_link_helper_script_paths() -> (String, String) {
    (
        DATA_HOME_DIR_NAME.to_string(),
        format!(
            "{}/{}",
            DATA_HOME_DIR_NAME,
            DataHomeChild::DeepLinkPending.name()
        ),
    )
}

/// 윈도우 딥링크 대기 파일. 앱이 뜨기 전(`main.rs`)에도 쓰이므로 홈을 못 찾으면
/// 공용 자리로 떨어진다 — 그 예외까지 이 모듈이 갖는다.
#[allow(dead_code)]
pub fn windows_deep_link_pending() -> PathBuf {
    match user_home_path() {
        Some(home) => direct_child_of(&home, DataHomeChild::DeepLinkPending),
        None => PathBuf::from(WINDOWS_PUBLIC_FALLBACK).join(DataHomeChild::DeepLinkPending.name()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 리팩터링 전후로 경로가 한 글자도 바뀌지 않았음을 고정한다. 이 열넷이
    /// 옮기기 전의 문자열 그대로다.
    #[test]
    fn child_paths_are_frozen() {
        let home = PathBuf::from("/fake-home");
        let expected = [
            (DataHomeChild::AdkPath, "/fake-home/.naia/adk-path"),
            (DataHomeChild::Logs, "/fake-home/.naia/logs"),
            (DataHomeChild::Run, "/fake-home/.naia/run"),
            (DataHomeChild::Skills, "/fake-home/.naia/skills"),
            (
                DataHomeChild::Voxcpm2Runtime,
                "/fake-home/.naia/voxcpm2-runtime",
            ),
            (DataHomeChild::Apps, "/fake-home/.naia/apps"),
            (DataHomeChild::Panels, "/fake-home/.naia/panels"),
            (
                DataHomeChild::AgentChildLease,
                "/fake-home/.naia/agent-child-lease.json",
            ),
            (
                DataHomeChild::AgentChildLeaseLock,
                "/fake-home/.naia/agent-child-lease.lock",
            ),
            (
                DataHomeChild::ChromeProfile,
                "/fake-home/.naia/chrome-profile",
            ),
            (
                DataHomeChild::LoginProfile,
                "/fake-home/.naia/login-profile",
            ),
            (
                DataHomeChild::DeepLinkPending,
                "/fake-home/.naia/deep-link-pending.txt",
            ),
            (DataHomeChild::DevDeepLink, "/fake-home/.naia/dev-deeplink"),
            (DataHomeChild::Workspace, "/fake-home/.naia/workspace"),
        ];
        assert_eq!(expected.len(), ALL_CHILDREN.len());
        for (child, path) in expected {
            assert_eq!(
                direct_child_of(&home, child)
                    .to_string_lossy()
                    .replace('\\', "/"),
                path,
                "{:?} 의 경로가 바뀌었다",
                child
            );
        }
    }

    /// 이름표가 하나라도 바뀌면 검사기·문서와 어긋난다. 그 어긋남을 여기서 먼저
    /// 잡는다.
    #[test]
    fn child_names_are_the_fourteen() {
        let names: Vec<&str> = ALL_CHILDREN.iter().map(|c| c.name()).collect();
        assert_eq!(
            names,
            vec![
                "adk-path",
                "logs",
                "run",
                "skills",
                "voxcpm2-runtime",
                "apps",
                "panels",
                "agent-child-lease.json",
                "agent-child-lease.lock",
                "chrome-profile",
                "login-profile",
                "deep-link-pending.txt",
                "dev-deeplink",
                "workspace",
            ]
        );
    }

    /// 홈을 스스로 구하는 AppleScript 로 나가는 두 조각도 같은 이름표에서
    /// 나온다. 이 함수가 데이터 홈 이름이 밖으로 나가는 **유일한** 통로라
    /// 모양을 여기서 고정한다.
    #[test]
    fn deep_link_script_paths_are_home_relative() {
        let (dir, pending) = deep_link_helper_script_paths();
        assert_eq!(dir, ".naia");
        assert_eq!(pending, ".naia/deep-link-pending.txt");
        // 스크립트가 붙이는 `homePath` 는 `/` 로 끝난다 — 두 조각 다 홈 기준
        // 상대 경로여야 하고, 앞에 구분자가 붙으면 절대 경로가 된다.
        assert!(!dir.starts_with('/'));
        assert!(!pending.starts_with('/'));
        assert!(pending.starts_with(&dir));
    }

    /// 설정에 실려 나가는 tilde 문자열도 같은 이름표에서 나온다.
    #[test]
    fn tilde_child_uses_the_same_label() {
        assert_eq!(tilde_child(DataHomeChild::Workspace), "~/.naia/workspace");
    }

    /// `NAIA_HOME` 을 존중하는 쪽과 무시하는 쪽이 실제로 다르게 갈린다.
    #[test]
    fn override_applies_only_to_the_respecting_half() {
        let home = PathBuf::from("C:/naia-test-home");
        assert_eq!(
            naia_data_home_with(home.clone(), Some("C:/naia-test-home/.naia-dev")),
            PathBuf::from("C:/naia-test-home/.naia-dev")
        );
        assert_eq!(
            naia_data_home_with(home.clone(), Some("   ")),
            PathBuf::from("C:/naia-test-home/.naia")
        );
        assert_eq!(
            naia_data_home_with(home.clone(), None),
            PathBuf::from("C:/naia-test-home/.naia")
        );
        assert_eq!(
            direct_child_of(&home, DataHomeChild::Logs),
            PathBuf::from("C:/naia-test-home/.naia/logs")
        );
    }
    #[test]
    fn r12_two_homes_do_not_fall_back_to_user_pointer() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("user");
        let isolated = root.path().join("isolated");
        std::fs::create_dir_all(home.join(".naia")).unwrap();
        std::fs::create_dir_all(&isolated).unwrap();
        let user_pointer = home.join(".naia/adk-path");
        std::fs::write(&user_pointer, "private-adk-A").unwrap();
        let target = naia_data_home_with(home.clone(), isolated.to_str()).join("adk-path");
        assert!(!target.exists());
        std::fs::write(&target, "test-adk-B").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "test-adk-B");
        assert_eq!(std::fs::read_to_string(user_pointer).unwrap(), "private-adk-A");
    }

    #[test]
    fn r12_native_pointer_uses_only_selected_home() {
        // Separate processes exercise dirs + NAIA_HOME without racing other
        // tests through process-global environment mutation.
        if let Ok(case) = std::env::var("R12_POINTER_CASE") {
            let expected = std::env::var("R12_EXPECTED_ADK").unwrap();
            match case.as_str() {
                "selected" => assert_eq!(crate::read_naia_path_cache().unwrap(), Some(expected)),
                "empty" => assert_eq!(crate::read_naia_path_cache().unwrap(), None),
                "unreadable" => assert!(crate::read_naia_path_cache().is_err()),
                _ => panic!("unknown case"),
            }
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("user");
        let isolated = root.path().join("isolated");
        std::fs::create_dir_all(direct_child_of(&home, DataHomeChild::AdkPath).parent().unwrap()).unwrap();
        std::fs::create_dir_all(&isolated).unwrap();
        let private_pointer = direct_child_of(&home, DataHomeChild::AdkPath);
        std::fs::write(&private_pointer, "private-adk-A").unwrap();
        let pointer = isolated.join("adk-path");
        for case in ["empty", "selected", "unreadable"] {
            if case == "selected" { std::fs::write(&pointer, "test-adk-B\n").unwrap(); }
            if case == "unreadable" {
                std::fs::remove_file(&pointer).unwrap();
                std::fs::create_dir(&pointer).unwrap();
            }
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "data_home::tests::r12_native_pointer_uses_only_selected_home", "--nocapture"])
                .env("HOME", &home).env("USERPROFILE", &home)
                .env("NAIA_HOME", &isolated).env_remove("NAIA_E2E")
                .env("R12_POINTER_CASE", case).env("R12_EXPECTED_ADK", "test-adk-B")
                .output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stdout));
            assert_eq!(std::fs::read_to_string(&private_pointer).unwrap(), "private-adk-A");
        }
    }


}
