//! 배포 경로 판정 (#727).
//!
//! Steam 은 앱 안에서 외부 결제 페이지로 보내는 것을 허용하지 않으므로, Steam 판
//! 셸은 크레딧 충전 버튼과 naia.land 결제 링크를 숨겨야 한다. Steam 데포는 NSIS
//! 설치본과 같은 실행 파일이라, 두 가지 신호로 구분한다.
//!
//! 1. 표시 파일: `prepare-steam-depot.mjs` 가 설치 폴더 최상위(실행 파일 옆)에
//!    [`MARKER_FILE`] 을 쓴다. 내용은 [`MARKER_CONTENT`]. 데포 해시 목록에 포함된다.
//! 2. 보조: Steam 이 실행할 때 넣는 환경 변수 `SteamAppId` 가 [`STEAM_APP_ID`] 와 같다.
//!
//! 판정 논리는 파일·환경 입력을 받는 순수 함수로 두어 단독으로 시험한다.

use std::path::Path;

pub const MARKER_FILE: &str = "naia-distribution.txt";
pub const MARKER_CONTENT: &str = "steam";
pub const STEAM_APP_ID: &str = "5354630";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Standard,
    Steam,
    Unknown,
}

impl Channel {
    pub fn as_str(self) -> &'static str {
        match self {
            Channel::Standard => "standard",
            Channel::Steam => "steam",
            Channel::Unknown => "unknown",
        }
    }
}

/// `install_dir` 아래 표시 파일이 있거나 `steam_app_id_env` 가 Steam App ID 면 Steam 판.
pub fn detect_channel(install_dir: Option<&Path>, steam_app_id_env: Option<&str>) -> Channel {
    if steam_app_id_env.map(str::trim) == Some(STEAM_APP_ID) {
        return Channel::Steam;
    }

    let dir = match install_dir {
        Some(d) => d,
        None => return Channel::Unknown,
    };

    match std::fs::metadata(dir) {
        Ok(meta) if meta.is_dir() => {}
        _ => return Channel::Unknown,
    }

    let marker = dir.join(MARKER_FILE);
    match std::fs::symlink_metadata(&marker) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Channel::Standard,
        Ok(_) => match std::fs::read_to_string(&marker) {
            Ok(text) => {
                if text.trim().eq_ignore_ascii_case(MARKER_CONTENT) {
                    Channel::Steam
                } else {
                    Channel::Unknown
                }
            }
            Err(_) => Channel::Unknown,
        },
        Err(_) => Channel::Unknown,
    }
}

pub fn detect_current_channel() -> Channel {
    let install_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    let env = std::env::var("SteamAppId").ok();
    detect_channel(install_dir.as_deref(), env.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "naia-distribution-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn marker_file_present_is_steam() {
        let dir = temp_dir("present");
        std::fs::write(dir.join(MARKER_FILE), "steam\n").unwrap();
        assert_eq!(detect_channel(Some(&dir), None), Channel::Steam);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn marker_file_absent_in_valid_dir_is_standard() {
        let dir = temp_dir("absent");
        assert_eq!(detect_channel(Some(&dir), None), Channel::Standard);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn marker_with_other_content_is_unknown() {
        let dir = temp_dir("other");
        std::fs::write(dir.join(MARKER_FILE), "nsis").unwrap();
        assert_eq!(detect_channel(Some(&dir), None), Channel::Unknown);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn marker_read_error_is_unknown() {
        let dir = temp_dir("read_err");
        std::fs::create_dir_all(dir.join(MARKER_FILE)).unwrap(); // directory causes read_to_string error
        assert_eq!(detect_channel(Some(&dir), None), Channel::Unknown);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn none_install_dir_is_unknown() {
        assert_eq!(detect_channel(None, None), Channel::Unknown);
    }

    #[test]
    fn nonexistent_install_dir_is_unknown() {
        let dir = temp_dir("nonexistent");
        let non_dir = dir.join("not_created");
        assert_eq!(detect_channel(Some(&non_dir), None), Channel::Unknown);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn steam_app_id_env_is_fallback() {
        let dir = temp_dir("env");
        assert_eq!(detect_channel(Some(&dir), Some("5354630")), Channel::Steam);
        assert_eq!(detect_channel(Some(&dir), Some(" 5354630 ")), Channel::Steam);
        assert_eq!(detect_channel(None, Some("5354630")), Channel::Steam);
        assert_eq!(detect_channel(Some(&dir), Some("480")), Channel::Standard);
        assert_eq!(detect_channel(Some(&dir), Some("")), Channel::Standard);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn broken_symlink_marker_is_unknown() {
        let dir = temp_dir("broken_symlink");
        let non_target = dir.join("nonexistent_target_file");
        let marker = dir.join(MARKER_FILE);
        std::os::unix::fs::symlink(&non_target, &marker).unwrap();
        assert_eq!(detect_channel(Some(&dir), None), Channel::Unknown);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn native_ipc_channel_strings_match_each_case() {
        let dir = temp_dir("ipc_cases");

        // Case 1: 표지 steam -> "steam"
        let steam_dir = dir.join("steam");
        std::fs::create_dir_all(&steam_dir).unwrap();
        std::fs::write(steam_dir.join(MARKER_FILE), "steam").unwrap();
        assert_eq!(detect_channel(Some(&steam_dir), None).as_str(), "steam");

        // Case 2: 정상 부재 -> "standard"
        let standard_dir = dir.join("standard");
        std::fs::create_dir_all(&standard_dir).unwrap();
        assert_eq!(detect_channel(Some(&standard_dir), None).as_str(), "standard");

        // Case 3: 손상 링크 (unix) -> "unknown"
        #[cfg(unix)]
        {
            let broken_dir = dir.join("broken");
            std::fs::create_dir_all(&broken_dir).unwrap();
            let non_target = broken_dir.join("missing_target");
            std::os::unix::fs::symlink(&non_target, broken_dir.join(MARKER_FILE)).unwrap();
            assert_eq!(detect_channel(Some(&broken_dir), None).as_str(), "unknown");
        }

        // Case 4: 읽기 오류 (디렉터리 표지) -> "unknown"
        let err_dir = dir.join("read_err");
        std::fs::create_dir_all(err_dir.join(MARKER_FILE)).unwrap();
        assert_eq!(detect_channel(Some(&err_dir), None).as_str(), "unknown");

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
