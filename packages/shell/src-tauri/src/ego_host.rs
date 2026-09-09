//! #582 S6b — 에이전트 브라우저 호스트를 셸의 소유 런타임 정리에 편입한다.
//!
//! 계약: `docs/progress/issue-582-ego-browser-host.md` 4.8·4.9, 9절 S6b.
//!
//! 감독자는 `<ADK>/ego-host/lease.json` 에 자기 소유를 남긴다. 형식은 감독자 쪽
//! `packages/ego-host/src/supervisor/lease.mjs` 의 `createLease` 가 쓰는 필드 그대로다.
//! 이 모듈이 하는 일은 둘뿐이다.
//!
//!   `reap_ego_host`     시작 조정 — 크래시가 남긴 것을 회수한다.
//!   `cleanup_ego_host`  Reset·재시작·정상 종료 — 우리가 띄운 것을 내린다.
//!
//! **PID 만으로는 아무것도 죽이지 않는다.** PID 는 재사용된다. 그래서 감독자가 Chromium
//! 명령줄에 심어 둔 `--naia-ego-marker=<nonce>` 가 그 PID 의 명령줄에 실제로 있는지 먼저 본다.
//! 없으면 남의 프로세스이므로 손대지 않고 기록만 남긴다(`foreign`).
//!
//! 경계가 둘인 이유(계약 4.9): 보통 `/proc/<pid>/cmdline` 은 인자를 `\0` 로 나누지만
//! **Chromium 은 시작하며 argv 를 통째로 다시 써서 공백으로 이어 붙는다**(S2b 실측).
//! `\0` 만 경계로 보면 우리 브라우저가 전부 "남의 것"으로 판정돼 회수가 죽는다.
//!
//! Windows 는 marker 확인 수단이 아직 확정되지 않았다(windows4060 게이트). 확인하지 못한
//! 프로세스는 **회수하지 않는다** — 추측으로 죽이면 그 추측이 사람의 프로세스를 죽인다.

use std::path::{Path, PathBuf};

/// Chromium 명령줄에 심는 표식의 접두사. 감독자 쪽 `chrome-launcher.mjs` 의 `MARKER_FLAG` 와 같다.
pub(crate) const MARKER_FLAG: &str = "--naia-ego-marker";

/// 회수 전에 SIGTERM 이 듣기를 기다리는 시간. 감독자 쪽 `reconcile.mjs` 의 `TERM_GRACE_MS` 와 같다.
const TERM_GRACE_MS: u64 = 2_000;
const POLL_STEP_MS: u64 = 50;

/// lease 한 장. 필드 이름은 `lease.mjs` 의 `createLease` 가 쓰는 것 그대로다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EgoHostLease {
    pub nonce: String,
    pub marker: String,
    /// Chromium 의 PID. 이것이 회수 대상이다.
    pub pid: u32,
    /// 감독자 프로세스의 PID. 셸 안에서 도는 경우 marker 가 없어 `foreign` 으로 판정된다.
    pub supervisor_pid: Option<u32>,
    pub started_at: Option<String>,
    pub executable: Option<String>,
    pub profile_dir: Option<String>,
    pub socket_path: Option<String>,
}

/// 조정 결과. 문자열 값은 감독자 쪽 `RECONCILE_STATUS` 와 같은 뜻이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EgoHostStatus {
    NoLease,
    Unreadable,
    Stale,
    Foreign,
    Unverified,
    Reclaimed,
}

impl EgoHostStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            EgoHostStatus::NoLease => "no-lease",
            EgoHostStatus::Unreadable => "unreadable",
            EgoHostStatus::Stale => "stale",
            EgoHostStatus::Foreign => "foreign",
            EgoHostStatus::Unverified => "unverified",
            EgoHostStatus::Reclaimed => "reclaimed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EgoHostReport {
    pub status: EgoHostStatus,
    pub browser_pid: Option<u32>,
    pub supervisor_pid: Option<u32>,
    /// 살아남은 것으로 확인된 우리 프로세스 수. 0 이 목표다.
    pub orphans: u32,
    pub lease_removed: bool,
    pub note: String,
}

impl EgoHostReport {
    fn empty(status: EgoHostStatus, note: impl Into<String>) -> Self {
        EgoHostReport {
            status,
            browser_pid: None,
            supervisor_pid: None,
            orphans: 0,
            lease_removed: false,
            note: note.into(),
        }
    }
}

/// 한 PID 의 신원 판정.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MarkerProbe {
    /// 살아 있고 명령줄에 우리 marker 가 있다.
    Match,
    /// 살아 있으나 우리 marker 가 없다 — 남의 프로세스다.
    Mismatch,
    /// 그 PID 가 없다.
    Gone,
    /// 살아 있으나 이 플랫폼에서는 명령줄을 확인할 수 없다.
    Unverified,
}

pub(crate) fn ego_host_dir(adk_dir: &Path) -> PathBuf {
    adk_dir.join("ego-host")
}

pub(crate) fn lease_path(adk_dir: &Path) -> PathBuf {
    ego_host_dir(adk_dir).join("lease.json")
}

/// 명령줄 덩어리에 그 토큰이 **온전한 인자로** 들어 있는가.
///
/// 구분자는 `\0` 과 공백류 둘 다다. `lease.mjs` 의 `cmdlineHasToken` 과 같은 규칙이며,
/// 두 구현이 갈라지면 셸과 감독자가 같은 프로세스를 다르게 판정한다.
pub(crate) fn marker_matches(cmdline: &[u8], marker: &str) -> bool {
    if marker.is_empty() {
        return false;
    }
    cmdline
        .split(|byte| *byte == 0 || byte.is_ascii_whitespace())
        .any(|token| token == marker.as_bytes())
}

/// lease 를 읽는다. `pid` 와 `nonce` 가 없으면 형식 오류다 — 조용한 `None` 과 구별해야 한다.
pub(crate) fn parse_lease(text: &str) -> Result<EgoHostLease, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|error| format!("ego_host_lease_not_json: {error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "ego_host_lease_not_object".to_string())?;
    let pid = object
        .get("pid")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "ego_host_lease_missing_pid".to_string())?;
    if pid == 0 || pid > u64::from(u32::MAX) {
        return Err("ego_host_lease_invalid_pid".to_string());
    }
    let nonce = object
        .get("nonce")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "ego_host_lease_missing_nonce".to_string())?
        .to_string();
    let marker = object
        .get("marker")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        // 감독자가 marker 를 안 적었으면 nonce 에서 되만든다. 두 곳이 같은 규칙을 쓴다.
        .unwrap_or_else(|| format!("{MARKER_FLAG}={nonce}"));
    let text_field = |key: &str| {
        object
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::to_string)
    };
    let supervisor_pid = object
        .get("supervisorPid")
        .and_then(|v| v.as_u64())
        .filter(|pid| *pid > 0 && *pid <= u64::from(u32::MAX))
        .map(|pid| pid as u32);
    Ok(EgoHostLease {
        nonce,
        marker,
        pid: pid as u32,
        supervisor_pid,
        started_at: text_field("startedAt"),
        executable: text_field("executable"),
        profile_dir: text_field("profileDir"),
        socket_path: text_field("socketPath"),
    })
}

/// 조정 한 번. 프로세스 조회·종료·파일 삭제를 전부 주입받아 테스트가 실제 기계를 건드리지 않는다.
pub(crate) fn reconcile_with<R, P, K, D, S>(
    read_lease: R,
    probe: P,
    mut terminate: K,
    remove_lease: D,
    mut sleep: S,
    label: &str,
) -> EgoHostReport
where
    R: FnOnce() -> Option<Result<String, String>>,
    P: Fn(u32, &str) -> MarkerProbe,
    // `hard` 가 참이면 즉시 종료(SIGKILL 상당)다.
    K: FnMut(u32, bool),
    D: FnOnce(),
    S: FnMut(u64),
{
    let Some(read) = read_lease() else {
        return EgoHostReport::empty(
            EgoHostStatus::NoLease,
            format!("{label}: lease 없음 — 이전 감독자의 흔적이 없다"),
        );
    };
    let lease = match read.and_then(|text| parse_lease(&text)) {
        Ok(lease) => lease,
        Err(error) => {
            // 형식이 깨진 lease 는 소유를 증명하지 못한다. 아무 PID 도 건드리지 않고 파일만 치운다.
            remove_lease();
            let mut report = EgoHostReport::empty(
                EgoHostStatus::Unreadable,
                format!("{label}: {error} — 아무 프로세스도 건드리지 않았다"),
            );
            report.lease_removed = true;
            return report;
        }
    };

    let mut report = EgoHostReport::empty(EgoHostStatus::NoLease, String::new());
    report.browser_pid = Some(lease.pid);
    report.supervisor_pid = lease.supervisor_pid;

    match probe(lease.pid, &lease.marker) {
        MarkerProbe::Gone => {
            remove_lease();
            report.status = EgoHostStatus::Stale;
            report.lease_removed = true;
            report.note = format!("{label}: PID {} 는 없다 — 고아 0, lease 만 지웠다", lease.pid);
            return report;
        }
        MarkerProbe::Unverified => {
            report.status = EgoHostStatus::Unverified;
            report.orphans = 1;
            report.note = format!(
                "{label}: PID {} 는 살아 있으나 이 플랫폼({})에서는 marker 를 확인할 수 없다. 회수하지 않는다(windows4060 게이트).",
                lease.pid,
                std::env::consts::OS
            );
            return report;
        }
        MarkerProbe::Mismatch => {
            report.status = EgoHostStatus::Foreign;
            report.note = format!(
                "{label}: PID {} 는 살아 있지만 명령줄에 우리 marker 가 없다 — PID 재사용이다. 종료도 lease 삭제도 하지 않는다.",
                lease.pid
            );
            return report;
        }
        MarkerProbe::Match => {}
    }

    // 여기부터가 "우리 것"이다. 감독자를 먼저 내린다 — 파이프 EOF 로 Chromium 이 스스로 닫히는
    // 경로가 가장 깨끗하다(계약 4.8, 실측 약 200ms). marker 를 확인할 수 없는 감독자는 건드리지 않는다.
    if let Some(supervisor) = lease.supervisor_pid {
        if matches!(probe(supervisor, &lease.marker), MarkerProbe::Match) {
            terminate(supervisor, false);
        }
    }

    terminate(lease.pid, false);
    let mut alive = wait_gone(&probe, lease.pid, &lease.marker, &mut sleep);
    if alive {
        terminate(lease.pid, true);
        alive = wait_gone(&probe, lease.pid, &lease.marker, &mut sleep);
    }
    remove_lease();
    report.status = EgoHostStatus::Reclaimed;
    report.lease_removed = true;
    report.orphans = u32::from(alive);
    report.note = if alive {
        format!("{label}: PID {} 가 강제 종료 뒤에도 남았다 — 회수 실패를 기록한다", lease.pid)
    } else {
        format!("{label}: PID {} 를 회수했다 — 고아 0", lease.pid)
    };
    report
}

/// 아직 살아 있는가. `Match` 만 살아 있는 것으로 본다 — 그 PID 가 남의 것이 됐으면 우리 일은 끝났다.
fn wait_gone<P, S>(probe: &P, pid: u32, marker: &str, sleep: &mut S) -> bool
where
    P: Fn(u32, &str) -> MarkerProbe,
    S: FnMut(u64),
{
    let mut waited = 0;
    loop {
        if !matches!(probe(pid, marker), MarkerProbe::Match) {
            return false;
        }
        if waited >= TERM_GRACE_MS {
            return true;
        }
        sleep(POLL_STEP_MS);
        waited += POLL_STEP_MS;
    }
}

// ── 실제 기계 ────────────────────────────────────────────────────────────────

/// 이 플랫폼에서 명령줄로 신원을 확인할 수 있는가 (계약 4.9).
fn marker_verifiable() -> bool {
    std::env::consts::OS != "windows"
}

fn probe_real(pid: u32, marker: &str) -> MarkerProbe {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let target = sysinfo::Pid::from(pid as usize);
    let mut system = System::new();
    // 명령줄을 **명시적으로** 요청한다. `refresh_processes` 의 기본 묶음에는 `cmd` 가 없어서
    // `process.cmd()` 가 늘 비고, 그러면 우리 브라우저가 전부 `mismatch` 로 판정돼 회수가 죽는다.
    // 2026-09-10 e2e-tauri 실기에서 실제로 그렇게 실패했다 — 아래 실프로세스 테스트가 그 자리다.
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[target]),
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );
    let Some(process) = system.process(target) else {
        return MarkerProbe::Gone;
    };
    if !marker_verifiable() {
        return MarkerProbe::Unverified;
    }
    // 인자를 `\0` 로 이어 붙여 한 덩어리로 만든 뒤 `\0`·공백 둘 다를 경계로 본다.
    // Chromium 이 argv 를 공백으로 재작성해도 같은 판정이 나오는 자리다.
    let mut cmdline: Vec<u8> = Vec::new();
    for arg in process.cmd() {
        if !cmdline.is_empty() {
            cmdline.push(0);
        }
        cmdline.extend_from_slice(arg.as_encoded_bytes());
    }
    if marker_matches(&cmdline, marker) {
        MarkerProbe::Match
    } else {
        MarkerProbe::Mismatch
    }
}

fn terminate_real(pid: u32, hard: bool) {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
    let target = sysinfo::Pid::from(pid as usize);
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[target]),
        true,
        ProcessRefreshKind::nothing(),
    );
    let Some(process) = system.process(target) else {
        return;
    };
    if hard {
        process.kill();
    } else if process.kill_with(sysinfo::Signal::Term).is_none() {
        // 이 플랫폼에 SIGTERM 이 없다. 부드러운 길이 없으면 기다릴 것도 없다.
        process.kill();
    }
}

fn run_reconcile(adk_dir: &Path, label: &str) -> EgoHostReport {
    let path = lease_path(adk_dir);
    reconcile_with(
        || match std::fs::read_to_string(&path) {
            Ok(text) => Some(Ok(text)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => Some(Err(format!("ego_host_lease_unreadable: {error}"))),
        },
        probe_real,
        terminate_real,
        || {
            let _ = std::fs::remove_file(&path);
        },
        |ms| std::thread::sleep(std::time::Duration::from_millis(ms)),
        label,
    )
}

/// 시작 조정. 크래시가 남긴 감독자·Chromium 을 marker 가 맞을 때만 회수한다.
pub(crate) fn reap_ego_host(adk_dir: &Path) -> EgoHostReport {
    run_reconcile(adk_dir, "reap")
}

/// Reset·재시작·정상 종료 경로의 정리. 조정과 같은 규칙으로 우리 것만 내린다.
pub(crate) fn cleanup_ego_host(adk_dir: &Path) -> EgoHostReport {
    let report = run_reconcile(adk_dir, "cleanup(reset)");
    log_report(&report);
    report
}

/// 현재 ADK 에 대해 조정한다. ADK 를 모르면 아무것도 하지 않는다 — 모르는 자리를 뒤지지 않는다.
pub(crate) fn reap_current_adk() {
    if let Ok(adk) = crate::current_adk_path() {
        let report = reap_ego_host(std::path::Path::new(&adk));
        log_report(&report);
    }
}

/// 현재 ADK 의 브라우저 호스트를 내린다. `label` 은 어느 경로가 불렀는지를 기록에 남긴다 —
/// 재시작과 정상 종료가 같은 글자로 찍히면 실기 로그에서 둘을 구별할 수 없다.
pub(crate) fn cleanup_current_adk(label: &str) {
    if let Ok(adk) = crate::current_adk_path() {
        let report = run_reconcile(std::path::Path::new(&adk), label);
        log_report(&report);
    }
}

fn log_report(report: &EgoHostReport) {
    if matches!(report.status, EgoHostStatus::NoLease) {
        return;
    }
    crate::log_both(&format!(
        "[Naia] ego-host {} orphans={} {}",
        report.status.as_str(),
        report.orphans,
        report.note
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const NONCE: &str = "8a1f-2b";

    fn marker() -> String {
        format!("{MARKER_FLAG}={NONCE}")
    }

    fn lease_json() -> String {
        format!(
            r#"{{"nonce":"{NONCE}","marker":"{}","startedAt":"2026-09-10T00:00:00.000Z","pid":4242,
                "executable":"/usr/bin/chromium","profileDir":"/adk/ego-host/profile",
                "socketPath":"/run/user/1000/naia-ego-host-abc.sock","supervisorPid":4200}}"#,
            marker()
        )
    }

    #[test]
    fn parses_the_supervisor_lease_format() {
        let lease = parse_lease(&lease_json()).expect("lease 를 읽어야 한다");
        assert_eq!(lease.nonce, NONCE);
        assert_eq!(lease.marker, marker());
        assert_eq!(lease.pid, 4242);
        assert_eq!(lease.supervisor_pid, Some(4200));
        assert_eq!(lease.executable.as_deref(), Some("/usr/bin/chromium"));
        assert_eq!(lease.profile_dir.as_deref(), Some("/adk/ego-host/profile"));
        assert_eq!(
            lease.socket_path.as_deref(),
            Some("/run/user/1000/naia-ego-host-abc.sock")
        );
    }

    #[test]
    fn a_lease_without_pid_or_nonce_is_a_format_error() {
        assert!(parse_lease("not json").is_err());
        assert!(parse_lease("[]").is_err());
        assert!(parse_lease(r#"{"nonce":"x"}"#).is_err());
        assert!(parse_lease(r#"{"pid":1}"#).is_err());
        assert!(parse_lease(r#"{"pid":0,"nonce":"x"}"#).is_err());
    }

    #[test]
    fn marker_needs_a_whole_argument_boundary() {
        let m = marker();
        // NUL 로 나뉜 보통의 cmdline.
        assert!(marker_matches(
            b"/usr/bin/chromium\0--headless=new\0--naia-ego-marker=8a1f-2b\0--user-data-dir=/x",
            &m
        ));
        // Chromium 이 argv 를 공백으로 다시 쓴 cmdline (S2b 실측).
        assert!(marker_matches(
            b"/usr/bin/chromium --headless=new --naia-ego-marker=8a1f-2b --type=zygote",
            &m
        ));
        // 마지막 인자여도 잡는다.
        assert!(marker_matches(b"/usr/bin/chromium --naia-ego-marker=8a1f-2b", &m));
    }

    #[test]
    fn a_longer_token_is_not_our_marker() {
        let m = marker();
        // 접두사만 같은 다른 nonce.
        assert!(!marker_matches(b"/usr/bin/chromium --naia-ego-marker=8a1f-2bXX", &m));
        // 다른 인자 안에 부분 문자열로 들어 있는 경우.
        assert!(!marker_matches(b"/usr/bin/chromium --log=--naia-ego-marker=8a1f-2b", &m));
        // 다른 ADK 의 감독자.
        assert!(!marker_matches(b"/usr/bin/chromium --naia-ego-marker=other", &m));
        assert!(!marker_matches(b"/usr/bin/chromium --headless=new", &m));
        assert!(!marker_matches(b"", &m));
    }

    struct Recorder {
        terminated: RefCell<Vec<(u32, bool)>>,
        removed: RefCell<bool>,
    }

    impl Recorder {
        fn new() -> Self {
            Recorder {
                terminated: RefCell::new(Vec::new()),
                removed: RefCell::new(false),
            }
        }
    }

    fn run(
        lease: Option<Result<String, String>>,
        probe: impl Fn(u32, &str) -> MarkerProbe,
        recorder: &Recorder,
    ) -> EgoHostReport {
        reconcile_with(
            || lease,
            probe,
            |pid, hard| recorder.terminated.borrow_mut().push((pid, hard)),
            || *recorder.removed.borrow_mut() = true,
            |_| {},
            "test",
        )
    }

    #[test]
    fn no_lease_touches_nothing() {
        let recorder = Recorder::new();
        let report = run(None, |_, _| MarkerProbe::Match, &recorder);
        assert_eq!(report.status, EgoHostStatus::NoLease);
        assert!(recorder.terminated.borrow().is_empty());
        assert!(!*recorder.removed.borrow());
    }

    #[test]
    fn a_broken_lease_removes_the_file_and_no_process() {
        let recorder = Recorder::new();
        let report = run(Some(Ok("{".to_string())), |_, _| MarkerProbe::Match, &recorder);
        assert_eq!(report.status, EgoHostStatus::Unreadable);
        assert!(report.lease_removed);
        assert!(recorder.terminated.borrow().is_empty(), "깨진 lease 로 프로세스를 죽였다");
    }

    #[test]
    fn a_dead_pid_only_clears_the_lease() {
        let recorder = Recorder::new();
        let report = run(Some(Ok(lease_json())), |_, _| MarkerProbe::Gone, &recorder);
        assert_eq!(report.status, EgoHostStatus::Stale);
        assert_eq!(report.orphans, 0);
        assert!(report.lease_removed);
        assert!(recorder.terminated.borrow().is_empty());
    }

    #[test]
    fn a_marker_mismatch_is_left_alone() {
        let recorder = Recorder::new();
        let report = run(Some(Ok(lease_json())), |_, _| MarkerProbe::Mismatch, &recorder);
        assert_eq!(report.status, EgoHostStatus::Foreign);
        assert!(
            recorder.terminated.borrow().is_empty(),
            "marker 가 다른데 종료를 시도했다 — PID 재사용이면 남의 프로세스다"
        );
        assert!(!*recorder.removed.borrow(), "남의 프로세스인데 lease 를 지웠다");
    }

    #[test]
    fn an_unverified_platform_records_an_orphan_and_reclaims_nothing() {
        let recorder = Recorder::new();
        let report = run(Some(Ok(lease_json())), |_, _| MarkerProbe::Unverified, &recorder);
        assert_eq!(report.status, EgoHostStatus::Unverified);
        assert_eq!(report.orphans, 1);
        assert!(!report.lease_removed);
        assert!(recorder.terminated.borrow().is_empty());
    }

    #[test]
    fn a_matching_lease_reclaims_supervisor_then_browser() {
        let recorder = Recorder::new();
        let calls = RefCell::new(0_u32);
        let report = run(
            Some(Ok(lease_json())),
            |_pid, _marker| {
                let mut count = calls.borrow_mut();
                *count += 1;
                // 첫 두 번(브라우저 판정·감독자 판정)은 살아 있고, 그 뒤에는 사라진다.
                if *count <= 3 {
                    MarkerProbe::Match
                } else {
                    MarkerProbe::Gone
                }
            },
            &recorder,
        );
        assert_eq!(report.status, EgoHostStatus::Reclaimed);
        assert_eq!(report.orphans, 0);
        assert!(report.lease_removed);
        let terminated = recorder.terminated.borrow();
        assert_eq!(
            terminated.as_slice(),
            &[(4200, false), (4242, false)],
            "감독자를 먼저 내리고 그다음 브라우저여야 한다"
        );
    }

    #[test]
    fn a_supervisor_without_our_marker_is_never_terminated() {
        let recorder = Recorder::new();
        let report = run(
            Some(Ok(lease_json())),
            |pid, _marker| {
                if pid == 4200 {
                    // 감독자가 셸 프로세스 안에서 돌면 명령줄에 marker 가 없다.
                    MarkerProbe::Mismatch
                } else {
                    MarkerProbe::Gone
                }
            },
            &recorder,
        );
        // 브라우저 PID 가 이미 없으므로 stale 로 끝나고 감독자는 손대지 않는다.
        assert_eq!(report.status, EgoHostStatus::Stale);
        assert!(recorder.terminated.borrow().is_empty());
    }

    #[test]
    fn a_process_that_survives_sigkill_is_recorded_as_an_orphan() {
        let recorder = Recorder::new();
        let report = run(Some(Ok(lease_json())), |_, _| MarkerProbe::Match, &recorder);
        assert_eq!(report.status, EgoHostStatus::Reclaimed);
        assert_eq!(report.orphans, 1, "죽지 않은 프로세스를 고아로 세지 않았다");
        let terminated = recorder.terminated.borrow();
        assert!(terminated.contains(&(4242, false)), "SIGTERM 을 먼저 보내야 한다");
        assert!(terminated.contains(&(4242, true)), "안 죽으면 강제 종료해야 한다");
    }

    /// **실제 프로세스**로 `probe_real` 을 잰다.
    ///
    /// 주입 테스트는 판정 규칙만 본다. 명령줄을 어디서 어떻게 읽는지는 못 본다 — 그리고 실패는
    /// 바로 거기서 났다(sysinfo 의 기본 갱신 묶음에 `cmd` 가 없어 명령줄이 늘 비었다).
    /// 그래서 표식을 단 진짜 프로세스를 띄워 세 판정을 전부 밟는다.
    #[test]
    fn probe_real_reads_the_command_line_of_a_live_process() {
        if std::env::consts::OS == "windows" {
            // 이 플랫폼은 marker 를 확인하지 않는 것이 계약이다(4.9 windows4060 게이트).
            return;
        }
        let nonce = format!("probe-{}", std::process::id());
        let marker = format!("{MARKER_FLAG}={nonce}");
        let spawn = |arg: &str| {
            std::process::Command::new("sh")
                .args(["-c", "sleep 30; :", "naia-ego-probe", arg])
                .spawn()
                .expect("표식 프로세스를 띄우지 못했다")
        };
        let mut ours = spawn(&marker);
        let mut theirs = spawn(&format!("{MARKER_FLAG}=someone-else"));

        // spawn 직후에는 아직 exec 전일 수 있다. 명령줄이 자리잡을 때까지 짧게 기다린다.
        let mut verdict = MarkerProbe::Gone;
        for _ in 0..50 {
            verdict = probe_real(ours.id(), &marker);
            if verdict == MarkerProbe::Match {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(verdict, MarkerProbe::Match, "우리 표식을 단 프로세스를 못 알아봤다");
        assert_eq!(
            probe_real(theirs.id(), &marker),
            MarkerProbe::Mismatch,
            "남의 표식을 우리 것으로 읽었다"
        );

        let gone = ours.id();
        let _ = ours.kill();
        let _ = ours.wait();
        let _ = theirs.kill();
        let _ = theirs.wait();
        // 죽은 뒤에는 `Gone` 이어야 한다. 좀비를 살아 있다고 읽으면 회수가 영영 끝나지 않는다.
        let mut after = MarkerProbe::Match;
        for _ in 0..50 {
            after = probe_real(gone, &marker);
            if after == MarkerProbe::Gone {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(after, MarkerProbe::Gone, "종료된 PID 를 살아 있다고 읽었다");
    }

    #[test]
    fn lease_paths_sit_under_the_adk() {
        let adk = Path::new("/adk");
        assert_eq!(ego_host_dir(adk), Path::new("/adk/ego-host"));
        assert_eq!(lease_path(adk), Path::new("/adk/ego-host/lease.json"));
    }
}
