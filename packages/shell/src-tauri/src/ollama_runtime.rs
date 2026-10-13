//! User-scoped Ollama installation, discovery, and owned server lifecycle.
//!
//! The supervisor only executes a validated managed CLI on loopback. It never
//! adopts or terminates an external Ollama process and does not inspect GPUs.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, MutexGuard,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};
use zip::ZipArchive;

#[cfg(test)]
use std::sync::atomic::{AtomicBool, AtomicUsize};

use crate::vram_reservation::ReservationLease;

const RELEASE_VERSION: &str = "0.40.3";
const RELEASE_BASE: &str = "https://github.com/ollama/ollama/releases/download";
const INTEGRITY_KIND: &str = "official_sha256_manifest";
const MANIFEST_FILE: &str = "naia-shell-ollama.json";
const STATE_EVENT: &str = "ollama_runtime_state_changed";
const PROGRESS_EVENT: &str = "ollama_runtime_install_progress";
const DEFAULT_HOST_URL: &str = "http://localhost:11434";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const READINESS_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(250);
const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(5);
const FORCE_STOP_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_ARCHIVE_ENTRIES: usize = 100_000;
const MAX_EXTRACTED_BYTES: u64 = 8 * 1024 * 1024 * 1024;

static OPERATION_COUNTER: AtomicU64 = AtomicU64::new(1);

#[cfg(all(test, unix))]
static PROCESS_GROUP_SIGTERM_ATTEMPTS: AtomicUsize = AtomicUsize::new(0);
#[cfg(all(test, unix))]
static PROCESS_GROUP_SIGKILL_ATTEMPTS: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TargetOs {
    Windows,
    Linux,
}

impl TargetOs {
    fn as_str(self) -> &'static str {
        match self {
            Self::Windows => "windows",
            Self::Linux => "linux",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TargetArch {
    X86_64,
    Aarch64,
}

impl TargetArch {
    fn as_str(self) -> &'static str {
        match self {
            Self::X86_64 => "x86_64",
            Self::Aarch64 => "aarch64",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ArchiveFormat {
    Zip,
    TarZst,
}

#[derive(Clone, Copy, Debug)]
struct ReleasePin {
    version: &'static str,
    os: TargetOs,
    arch: TargetArch,
    asset_name: &'static str,
    download_url: &'static str,
    sha256: Option<&'static str>,
    integrity_source: &'static str,
    asset_size: u64,
    format: ArchiveFormat,
    executable_relative_path: &'static str,
}

const RELEASE_PINS: &[ReleasePin] = &[
    ReleasePin {
        version: "0.40.3",
        os: TargetOs::Windows,
        arch: TargetArch::X86_64,
        asset_name: "ollama-windows-amd64.zip",
        download_url:
            "https://github.com/ollama/ollama/releases/download/v0.40.3/ollama-windows-amd64.zip",
        sha256: Some("e5ecff02dfc7cae8ddf6d6b7a7ac5f727ffeedf4491f44ae75ff5b0820dbbbd5"),
        integrity_source:
            "https://github.com/ollama/ollama/releases/download/v0.40.3/sha256sum.txt",
        asset_size: 1_468_053_171,
        format: ArchiveFormat::Zip,
        executable_relative_path: "ollama.exe",
    },
    ReleasePin {
        version: "0.40.3",
        os: TargetOs::Windows,
        arch: TargetArch::Aarch64,
        asset_name: "ollama-windows-arm64.zip",
        download_url:
            "https://github.com/ollama/ollama/releases/download/v0.40.3/ollama-windows-arm64.zip",
        sha256: Some("8af2eb5ff1b8e67fa3cba8adf52bcaeab41a650da318ec717182804d174ec05e"),
        integrity_source:
            "https://github.com/ollama/ollama/releases/download/v0.40.3/sha256sum.txt",
        asset_size: 209_943_812,
        format: ArchiveFormat::Zip,
        executable_relative_path: "ollama.exe",
    },
    ReleasePin {
        version: "0.40.3",
        os: TargetOs::Linux,
        arch: TargetArch::X86_64,
        asset_name: "ollama-linux-amd64.tar.zst",
        download_url:
            "https://github.com/ollama/ollama/releases/download/v0.40.3/ollama-linux-amd64.tar.zst",
        sha256: Some("ce6f8b671a699bf1ebafb28d60dbbabf4f37b30b499145fa308a8ba72de021d6"),
        integrity_source:
            "https://github.com/ollama/ollama/releases/download/v0.40.3/sha256sum.txt",
        asset_size: 1_437_349_190,
        format: ArchiveFormat::TarZst,
        executable_relative_path: "bin/ollama",
    },
    ReleasePin {
        version: "0.40.3",
        os: TargetOs::Linux,
        arch: TargetArch::Aarch64,
        asset_name: "ollama-linux-arm64.tar.zst",
        download_url:
            "https://github.com/ollama/ollama/releases/download/v0.40.3/ollama-linux-arm64.tar.zst",
        sha256: Some("5754700747a93ea14db88888f08072386d2da6fbf7dd75be19a684348b9f28b8"),
        integrity_source:
            "https://github.com/ollama/ollama/releases/download/v0.40.3/sha256sum.txt",
        asset_size: 1_558_419_074,
        format: ArchiveFormat::TarZst,
        executable_relative_path: "bin/ollama",
    },
];

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum RuntimeState {
    NotInstalled,
    Installing,
    InstalledStopped,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum RuntimeErrorCode {
    UnsupportedPlatform,
    RuntimeBusy,
    RuntimeInUse,
    VersionUnavailable,
    VersionNotInstalled,
    VersionMalformed,
    DownloadFailed,
    IntegrityMetadataMissing,
    IntegrityMismatch,
    ArchiveRejected,
    HostNotAllowed,
    ManagedEndpointUnsupported,
    SpawnFailed,
    ApiUnreachable,
    ReadinessTimeout,
    ProcessExited,
    StopFailed,
    PermissionDenied,
    NotManaged,
    ConfirmationRequired,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ServerState {
    NotInstalled,
    CheckingHost,
    ExternalUnavailable,
    Installing,
    InstalledStopped,
    Starting,
    ReadyManaged,
    ConnectedUnreserved,
    ReadyRemote,
    Stopping,
    Stopped,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum RuntimeOwnership {
    None,
    ManagedChild,
    ExternalLocal,
    Remote,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ReservationStatus {
    NotRequested,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReservationSnapshot {
    kind: Option<String>,
    status: ReservationStatus,
    bytes: Option<u64>,
    reason_code: Option<String>,
}

impl Default for ReservationSnapshot {
    fn default() -> Self {
        Self {
            kind: None,
            status: ReservationStatus::NotRequested,
            bytes: None,
            reason_code: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeError {
    code: RuntimeErrorCode,
    stage: String,
    retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation_id: Option<String>,
}

impl RuntimeError {
    fn new(code: RuntimeErrorCode, stage: &str, retryable: bool) -> Self {
        Self {
            code,
            stage: stage.to_string(),
            retryable,
            operation_id: None,
        }
    }

    fn for_operation(mut self, operation_id: &str) -> Self {
        self.operation_id = Some(operation_id.to_string());
        self
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeSnapshot {
    /// Installation state retained from stage 2 for IPC compatibility.
    state: RuntimeState,
    server_state: ServerState,
    ownership: RuntimeOwnership,
    installed_version: Option<String>,
    installed_versions: Vec<String>,
    model_count: Option<usize>,
    reservation: ReservationSnapshot,
    operation_id: Option<String>,
    phase: Option<String>,
    error: Option<RuntimeError>,
}

impl Default for RuntimeSnapshot {
    fn default() -> Self {
        Self {
            state: RuntimeState::NotInstalled,
            server_state: ServerState::NotInstalled,
            ownership: RuntimeOwnership::None,
            installed_version: None,
            installed_versions: Vec::new(),
            model_count: None,
            reservation: ReservationSnapshot::default(),
            operation_id: None,
            phase: None,
            error: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallProgress {
    operation_id: String,
    phase: String,
    received_bytes: u64,
    total_bytes: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallManifest {
    schema_version: u32,
    version: String,
    target_os: String,
    target_arch: String,
    asset_name: String,
    download_url: String,
    integrity_kind: String,
    integrity_source: String,
    archive_sha256: String,
    integrity_verified: bool,
    executable_relative_path: String,
    executable_sha256: String,
    installed_at_unix_seconds: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct InstalledRuntime {
    version: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OperationKind {
    Install,
    Start,
    Stop,
    Remove,
}

#[derive(Clone, Debug)]
struct ActiveOperation {
    id: String,
    kind: OperationKind,
}

struct ManagerState {
    snapshot: RuntimeSnapshot,
    operation: Option<ActiveOperation>,
    active_versions: BTreeSet<String>,
    process: Option<ManagedProcess>,
    next_process_generation: u64,
    shutdown_requested: bool,
}

impl Default for ManagerState {
    fn default() -> Self {
        Self {
            snapshot: RuntimeSnapshot::default(),
            operation: None,
            active_versions: BTreeSet::new(),
            process: None,
            next_process_generation: 1,
            shutdown_requested: false,
        }
    }
}

#[derive(Clone)]
struct RuntimeSettings {
    managed_base_url: String,
    request_timeout: Duration,
    readiness_timeout: Duration,
    poll_interval: Duration,
    graceful_stop_timeout: Duration,
    force_stop_timeout: Duration,
}

impl Default for RuntimeSettings {
    fn default() -> Self {
        Self {
            managed_base_url: DEFAULT_HOST_URL.to_string(),
            request_timeout: REQUEST_TIMEOUT,
            readiness_timeout: READINESS_TIMEOUT,
            poll_interval: POLL_INTERVAL,
            graceful_stop_timeout: GRACEFUL_STOP_TIMEOUT,
            force_stop_timeout: FORCE_STOP_TIMEOUT,
        }
    }
}

#[derive(Clone, Debug)]
struct ProcessSpec {
    executable: PathBuf,
    arguments: Vec<String>,
    environment: BTreeMap<std::ffi::OsString, std::ffi::OsString>,
    inherit_environment: bool,
}

trait ManagedChild: Send {
    fn has_exited(&mut self) -> io::Result<bool>;
    fn reap_exited_leader(&mut self) -> io::Result<()>;
    fn request_graceful_shutdown(&mut self) -> io::Result<()>;
    fn force_kill_tree(&mut self) -> io::Result<()>;
    fn process_tree_alive(&mut self) -> io::Result<bool>;
}

trait RuntimeProcessRunner: Send + Sync {
    fn spawn(&self, spec: &ProcessSpec) -> io::Result<Box<dyn ManagedChild>>;
}

struct SystemProcessRunner;

struct OwnedChild {
    child: Child,
    ownership: ChildOwnership,
    reaped: bool,
}

impl ManagedChild for OwnedChild {
    fn has_exited(&mut self) -> io::Result<bool> {
        self.observe_exit()
    }

    fn reap_exited_leader(&mut self) -> io::Result<()> {
        self.reap_leader()
    }

    fn request_graceful_shutdown(&mut self) -> io::Result<()> {
        if self.reaped {
            return Ok(());
        }
        self.ownership.request_graceful(self.child.id())
    }

    fn force_kill_tree(&mut self) -> io::Result<()> {
        #[cfg(unix)]
        if self.reaped {
            return Ok(());
        }
        self.ownership.force_kill(&mut self.child)
    }

    fn process_tree_alive(&mut self) -> io::Result<bool> {
        #[cfg(windows)]
        {
            // Job Object operations use this still-open, uniquely owned handle;
            // they do not resolve a possibly reused process id.
            self.ownership.is_alive()
        }
        #[cfg(unix)]
        {
            if self.reaped {
                return Ok(false);
            }
            let leader_exited = self.leader_has_exited()?;
            if !leader_exited {
                return Ok(true);
            }
            has_live_process_group_descendants(
                self.ownership.process_group,
                self.child.id() as libc::pid_t,
            )
        }
        #[cfg(all(not(windows), not(unix)))]
        {
            Ok(false)
        }
    }
}

impl OwnedChild {
    fn observe_exit(&mut self) -> io::Result<bool> {
        if self.reaped {
            return Ok(true);
        }
        #[cfg(unix)]
        {
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    self.child.id() as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if result == 0 {
                return Ok(unsafe { info.si_pid() } != 0);
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ECHILD) {
                // Another owner or SIGCHLD disposition already reaped it. Its
                // numeric process-group id can no longer be used safely.
                self.reaped = true;
                return Ok(true);
            }
            Err(error)
        }
        #[cfg(not(unix))]
        {
            let status = self.child.try_wait()?;
            if status.is_some() {
                self.reaped = true;
            }
            Ok(self.reaped)
        }
    }

    fn leader_has_exited(&mut self) -> io::Result<bool> {
        self.observe_exit()
    }

    fn reap_leader(&mut self) -> io::Result<()> {
        if self.reaped {
            return Ok(());
        }
        if !self.observe_exit()? {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "cannot reap a running managed child",
            ));
        }
        #[cfg(unix)]
        match self.child.wait() {
            Ok(_) => {
                self.reaped = true;
                Ok(())
            }
            Err(error) if error.raw_os_error() == Some(libc::ECHILD) => {
                self.reaped = true;
                Ok(())
            }
            Err(error) => Err(error),
        }
        #[cfg(not(unix))]
        {
            // observe_exit uses try_wait on these platforms, which also reaps.
            Ok(())
        }
    }
}

struct ManagedProcess {
    child: Box<dyn ManagedChild>,
    version: String,
    generation: u64,
    // Stage 4 fills this only after reservation-before-spawn is connected.
    reservation: Option<ReservationLease>,
}

/// Tauri-managed state shared by the status, install, and remove commands.
#[derive(Clone)]
pub(crate) struct RuntimeManager {
    inner: Arc<Mutex<ManagerState>>,
    downloader: Arc<dyn ArtifactDownloader>,
    process_runner: Arc<dyn RuntimeProcessRunner>,
    settings: RuntimeSettings,
    locations: Option<(PathBuf, PathBuf)>,
    release_pin: Option<ReleasePin>,
}

impl Default for RuntimeManager {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(ManagerState::default())),
            downloader: Arc::new(HttpDownloader),
            process_runner: Arc::new(SystemProcessRunner),
            settings: RuntimeSettings::default(),
            locations: None,
            release_pin: None,
        }
    }
}

impl RuntimeManager {
    fn lock(&self) -> MutexGuard<'_, ManagerState> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn begin(&self, id: &str, kind: OperationKind) -> Result<(), RuntimeError> {
        let mut state = self.lock();
        if state.shutdown_requested || state.operation.is_some() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::RuntimeBusy,
                "dispatch",
                true,
            ));
        }
        state.operation = Some(ActiveOperation {
            id: id.to_string(),
            kind,
        });
        state.snapshot.operation_id = Some(id.to_string());
        state.snapshot.phase = Some(match kind {
            OperationKind::Install => "download".to_string(),
            OperationKind::Start => "checking_host".to_string(),
            OperationKind::Stop => "stop".to_string(),
            OperationKind::Remove => "remove".to_string(),
        });
        state.snapshot.error = None;
        match kind {
            OperationKind::Install => {
                state.snapshot.state = RuntimeState::Installing;
                state.snapshot.server_state = ServerState::Installing;
            }
            OperationKind::Start => state.snapshot.server_state = ServerState::CheckingHost,
            OperationKind::Stop => state.snapshot.server_state = ServerState::Stopping,
            OperationKind::Remove => {}
        }
        Ok(())
    }

    fn set_phase(&self, id: &str, phase: &str) {
        let mut state = self.lock();
        if state.operation.as_ref().is_some_and(|op| op.id == id) {
            state.snapshot.phase = Some(phase.to_string());
        }
    }

    fn finish_success(&self, id: &str, versions: Vec<String>, installed: Option<String>) {
        let mut state = self.lock();
        let Some(operation) = state.operation.as_ref().filter(|op| op.id == id).cloned() else {
            return;
        };
        state.operation = None;
        state.snapshot.state = if installed.is_some() || !versions.is_empty() {
            RuntimeState::InstalledStopped
        } else {
            RuntimeState::NotInstalled
        };
        state.snapshot.installed_version = installed.or_else(|| versions.last().cloned());
        state.snapshot.installed_versions = versions;
        state.snapshot.operation_id = Some(id.to_string());
        state.snapshot.phase = None;
        state.snapshot.error = None;
        if matches!(
            operation.kind,
            OperationKind::Install | OperationKind::Remove
        ) {
            if state.process.is_some() {
                state.snapshot.server_state = ServerState::ReadyManaged;
                state.snapshot.ownership = RuntimeOwnership::ManagedChild;
            } else if operation.kind == OperationKind::Install
                || !matches!(
                    state.snapshot.server_state,
                    ServerState::ConnectedUnreserved
                        | ServerState::ReadyRemote
                        | ServerState::ExternalUnavailable
                )
            {
                state.snapshot.server_state = if state.snapshot.state == RuntimeState::NotInstalled
                {
                    ServerState::NotInstalled
                } else {
                    ServerState::InstalledStopped
                };
                state.snapshot.ownership = RuntimeOwnership::None;
                state.snapshot.model_count = None;
            }
        }
    }

    fn finish_failure(&self, id: &str, error: RuntimeError) {
        let mut state = self.lock();
        let Some(operation) = state.operation.as_ref().filter(|op| op.id == id).cloned() else {
            return;
        };
        state.operation = None;
        match operation.kind {
            OperationKind::Install => {
                state.snapshot.state = RuntimeState::Failed;
                state.snapshot.server_state = ServerState::Failed;
            }
            OperationKind::Remove => {
                state.snapshot.state =
                    install_state_from_versions(&state.snapshot.installed_versions);
                if state.process.is_some() {
                    state.snapshot.server_state = ServerState::ReadyManaged;
                    state.snapshot.ownership = RuntimeOwnership::ManagedChild;
                } else if !matches!(
                    state.snapshot.server_state,
                    ServerState::ConnectedUnreserved
                        | ServerState::ReadyRemote
                        | ServerState::ExternalUnavailable
                ) {
                    state.snapshot.server_state =
                        if state.snapshot.state == RuntimeState::NotInstalled {
                            ServerState::NotInstalled
                        } else {
                            ServerState::InstalledStopped
                        };
                    state.snapshot.ownership = RuntimeOwnership::None;
                    state.snapshot.model_count = None;
                }
            }
            OperationKind::Start => {
                state.snapshot.state = if state.snapshot.installed_versions.is_empty() {
                    RuntimeState::Failed
                } else {
                    RuntimeState::InstalledStopped
                };
                state.snapshot.server_state = ServerState::Failed;
            }
            OperationKind::Stop => {
                state.snapshot.state = if state.snapshot.installed_versions.is_empty() {
                    RuntimeState::NotInstalled
                } else {
                    RuntimeState::InstalledStopped
                };
                state.snapshot.server_state = ServerState::Failed;
            }
        }
        state.snapshot.operation_id = Some(id.to_string());
        state.snapshot.phase = None;
        state.snapshot.error = Some(error.for_operation(id));
    }

    fn in_use(&self, version: &str) -> bool {
        self.lock().active_versions.contains(version)
    }

    fn operation_snapshot(&self) -> Option<RuntimeSnapshot> {
        let state = self.lock();
        state.operation.as_ref().map(|_| state.snapshot.clone())
    }

    fn finish_server_operation(
        &self,
        id: &str,
        versions: Vec<String>,
        installed: Option<String>,
        server_state: ServerState,
        ownership: RuntimeOwnership,
        model_count: Option<usize>,
        error: Option<RuntimeError>,
    ) {
        let mut state = self.lock();
        if !state.operation.as_ref().is_some_and(|op| op.id == id) {
            return;
        }
        state.operation = None;
        state.snapshot.state = if error.is_some() && versions.is_empty() {
            RuntimeState::Failed
        } else if versions.is_empty() && installed.is_none() {
            RuntimeState::NotInstalled
        } else {
            RuntimeState::InstalledStopped
        };
        state.snapshot.installed_version = installed.or_else(|| versions.last().cloned());
        state.snapshot.installed_versions = versions;
        state.snapshot.server_state = server_state;
        state.snapshot.ownership = ownership;
        state.snapshot.model_count = model_count;
        state.snapshot.operation_id = Some(id.to_string());
        state.snapshot.phase = None;
        state.snapshot.error = error.map(|error| error.for_operation(id));
    }

    fn locations(&self) -> Result<(PathBuf, PathBuf), RuntimeError> {
        self.locations.clone().map_or_else(runtime_locations, Ok)
    }

    fn release_pin(&self) -> Result<ReleasePin, RuntimeError> {
        self.release_pin
            .map(Ok)
            .unwrap_or_else(|| current_release_pin().copied())
    }

    fn snapshot(&self) -> RuntimeSnapshot {
        self.lock().snapshot.clone()
    }

    fn is_shutting_down(&self) -> bool {
        self.lock().shutdown_requested
    }

    #[cfg(test)]
    fn mark_active_for_test(&self, version: &str) {
        self.lock().active_versions.insert(version.to_string());
    }
}

impl RuntimeProcessRunner for SystemProcessRunner {
    fn spawn(&self, spec: &ProcessSpec) -> io::Result<Box<dyn ManagedChild>> {
        let mut command = Command::new(&spec.executable);
        command
            .args(&spec.arguments)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if !spec.inherit_environment {
            command.env_clear();
        }
        for (key, value) in &spec.environment {
            command.env(key, value);
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            const CREATE_SUSPENDED: u32 = 0x0000_0004;
            command
                .creation_flags(CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED)
                .show_window(0);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::process::CommandExt;
            let parent_pid = unsafe { libc::getpid() };
            unsafe {
                command.pre_exec(move || {
                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM, 0, 0, 0) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    if libc::getppid() != parent_pid {
                        libc::raise(libc::SIGTERM);
                    }
                    Ok(())
                });
            }
        }

        let mut child = command.spawn()?;
        let ownership = match ChildOwnership::attach(&child) {
            Ok(ownership) => ownership,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        #[cfg(windows)]
        if let Err(error) = resume_suspended_child(&child) {
            let mut ownership = ownership;
            let _ = ownership.force_kill(&mut child);
            let _ = child.wait();
            return Err(error);
        }
        Ok(Box::new(OwnedChild {
            child,
            ownership,
            reaped: false,
        }))
    }
}

#[cfg(windows)]
fn resume_suspended_child(child: &Child) -> io::Result<()> {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let mut entry: THREADENTRY32 = unsafe { zeroed() };
    entry.dwSize = size_of::<THREADENTRY32>() as u32;
    let mut found = false;
    let mut has_entry = unsafe { Thread32First(snapshot, &mut entry) != 0 };
    while has_entry {
        if entry.th32OwnerProcessID == child.id() {
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if !thread.is_null() {
                let resumed = unsafe { ResumeThread(thread) };
                unsafe { CloseHandle(thread) };
                if resumed != u32::MAX {
                    found = true;
                    break;
                }
            }
        }
        has_entry = unsafe { Thread32Next(snapshot, &mut entry) != 0 };
    }
    unsafe { CloseHandle(snapshot) };
    if found {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
struct ChildOwnership {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

// The Job Object handle is uniquely owned and only accessed through the
// manager's mutex-protected child record, so moving that record between its
// worker and supervisor threads is safe.
#[cfg(windows)]
unsafe impl Send for ChildOwnership {}

#[cfg(unix)]
struct ChildOwnership {
    process_group: libc::pid_t,
}

#[cfg(all(not(windows), not(unix)))]
struct ChildOwnership;

impl ChildOwnership {
    fn attach(child: &Child) -> io::Result<Self> {
        #[cfg(windows)]
        {
            use std::mem::{size_of, zeroed};
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            };

            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const std::ffi::c_void,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) != 0
            };
            let assigned = configured
                && unsafe { AssignProcessToJobObject(handle, child.as_raw_handle() as _) != 0 };
            if !assigned {
                unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
                return Err(io::Error::last_os_error());
            }
            return Ok(Self { handle });
        }
        #[cfg(unix)]
        {
            let process_group = child.id() as libc::pid_t;
            validate_process_group(process_group)?;
            Ok(Self { process_group })
        }
        #[cfg(all(not(windows), not(unix)))]
        {
            let _ = child;
            Ok(Self)
        }
    }

    fn request_graceful(&self, _child_pid: u32) -> io::Result<()> {
        #[cfg(windows)]
        {
            send_windows_ctrl_break(_child_pid)
        }
        #[cfg(unix)]
        {
            validate_process_group(self.process_group)?;
            #[cfg(test)]
            PROCESS_GROUP_SIGTERM_ATTEMPTS.fetch_add(1, Ordering::Relaxed);
            let result = unsafe { libc::kill(-self.process_group, libc::SIGTERM) };
            if result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        }
        #[cfg(all(not(windows), not(unix)))]
        {
            let _ = _child_pid;
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "process tree termination is unsupported on this platform",
            ))
        }
    }

    fn force_kill(&self, child: &mut Child) -> io::Result<()> {
        #[cfg(windows)]
        {
            let terminated = unsafe {
                windows_sys::Win32::System::JobObjects::TerminateJobObject(self.handle, 1) != 0
            };
            if !terminated {
                let _ = child.kill();
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
        #[cfg(unix)]
        {
            validate_process_group(self.process_group)?;
            #[cfg(test)]
            PROCESS_GROUP_SIGKILL_ATTEMPTS.fetch_add(1, Ordering::Relaxed);
            let result = unsafe { libc::kill(-self.process_group, libc::SIGKILL) };
            if result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                Ok(())
            } else {
                let error = io::Error::last_os_error();
                let _ = child.kill();
                Err(error)
            }
        }
        #[cfg(all(not(windows), not(unix)))]
        {
            child.kill()
        }
    }

    #[cfg(windows)]
    fn is_alive(&self) -> io::Result<bool> {
        #[cfg(windows)]
        {
            use std::mem::{size_of, zeroed};
            use windows_sys::Win32::System::JobObjects::{
                JobObjectBasicAccountingInformation, QueryInformationJobObject,
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            };
            let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
            let queried = unsafe {
                QueryInformationJobObject(
                    self.handle,
                    JobObjectBasicAccountingInformation,
                    &mut accounting as *mut _ as *mut std::ffi::c_void,
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    std::ptr::null_mut(),
                ) != 0
            };
            if queried {
                Ok(accounting.ActiveProcesses != 0)
            } else {
                Err(io::Error::last_os_error())
            }
        }
    }
}

#[cfg(unix)]
fn validate_process_group(process_group: libc::pid_t) -> io::Result<()> {
    if process_group <= 0 || process_group == unsafe { libc::getpgrp() } {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "managed process group is not isolated",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn has_live_process_group_descendants(
    process_group: libc::pid_t,
    leader_pid: libc::pid_t,
) -> io::Result<bool> {
    validate_process_group(process_group)?;
    #[cfg(target_os = "linux")]
    {
        for entry in fs::read_dir("/proc")? {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<libc::pid_t>().ok())
            else {
                continue;
            };
            if pid == leader_pid {
                continue;
            }
            let stat = match fs::read_to_string(entry.path().join("stat")) {
                Ok(stat) => stat,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            if let Some((state, group)) = parse_process_stat(&stat) {
                if group == process_group && state != 'Z' && state != 'X' {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
    #[cfg(not(target_os = "linux"))]
    {
        // Keep the leader unreaped while ps enumerates its process group. This
        // avoids querying or signaling a numeric PGID after it can be reused.
        let output = Command::new("/bin/ps")
            .args(["-axo", "pid=,pgid=,stat="])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()?;
        if !output.status.success() {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                "could not inspect managed process group",
            ));
        }
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let mut columns = line.split_whitespace();
            let (Some(pid), Some(group), Some(state)) =
                (columns.next(), columns.next(), columns.next())
            else {
                continue;
            };
            let (Ok(pid), Ok(group)) = (pid.parse::<libc::pid_t>(), group.parse::<libc::pid_t>())
            else {
                continue;
            };
            if pid != leader_pid
                && group == process_group
                && !state.starts_with('Z')
                && !state.starts_with('X')
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

#[cfg(unix)]
fn parse_process_stat(stat: &str) -> Option<(char, libc::pid_t)> {
    let fields = stat.rsplit_once(')')?.1.split_whitespace();
    let mut fields = fields;
    let state = fields.next()?.chars().next()?;
    let _parent = fields.next()?;
    let process_group = fields.next()?.parse().ok()?;
    Some((state, process_group))
}

#[cfg(windows)]
fn send_windows_ctrl_break(child_pid: u32) -> io::Result<()> {
    use windows_sys::Win32::System::Console::{
        AttachConsole, FreeConsole, GenerateConsoleCtrlEvent, GetConsoleProcessList,
        CTRL_BREAK_EVENT,
    };

    let mut processes = [0u32; 64];
    let count = unsafe { GetConsoleProcessList(processes.as_mut_ptr(), processes.len() as u32) };
    let previous_console_process = if count == 0 {
        None
    } else {
        processes[..count.min(processes.len() as u32) as usize]
            .iter()
            .copied()
            .find(|pid| *pid != std::process::id())
    };
    if previous_console_process.is_some() {
        unsafe { FreeConsole() };
    }
    let attached = unsafe { AttachConsole(child_pid) != 0 };
    if !attached {
        let error = io::Error::last_os_error();
        if let Some(pid) = previous_console_process {
            unsafe { AttachConsole(pid) };
        }
        return Err(error);
    }
    let sent = unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, child_pid) != 0 };
    let send_error = (!sent).then(io::Error::last_os_error);
    unsafe { FreeConsole() };
    if let Some(pid) = previous_console_process {
        if unsafe { AttachConsole(pid) } == 0 && send_error.is_none() {
            return Err(io::Error::last_os_error());
        }
    }
    send_error.map_or(Ok(()), Err)
}

#[cfg(windows)]
impl Drop for ChildOwnership {
    fn drop(&mut self) {
        unsafe {
            let _ = windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = stop_managed_child(self, &RuntimeSettings::default());
    }
}

trait ArtifactDownloader: Send + Sync {
    fn download(
        &self,
        url: &str,
        destination: &Path,
        expected_size: Option<u64>,
        operation_id: &str,
        progress: &mut dyn FnMut(u64, Option<u64>),
    ) -> Result<String, RuntimeError>;
}

struct HttpDownloader;

impl ArtifactDownloader for HttpDownloader {
    fn download(
        &self,
        url: &str,
        destination: &Path,
        expected_size: Option<u64>,
        operation_id: &str,
        progress: &mut dyn FnMut(u64, Option<u64>),
    ) -> Result<String, RuntimeError> {
        let parsed = url::Url::parse(url).map_err(|_| {
            RuntimeError::new(RuntimeErrorCode::VersionUnavailable, "resolve", false)
                .for_operation(operation_id)
        })?;
        if parsed.scheme() != "https" || parsed.host_str() != Some("github.com") {
            return Err(
                RuntimeError::new(RuntimeErrorCode::VersionUnavailable, "resolve", false)
                    .for_operation(operation_id),
            );
        }

        let client = reqwest::blocking::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(20))
            .timeout(std::time::Duration::from_secs(30 * 60))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .map_err(|_| {
                RuntimeError::new(RuntimeErrorCode::DownloadFailed, "download", true)
                    .for_operation(operation_id)
            })?;
        let mut response = client.get(url).send().map_err(|_| {
            RuntimeError::new(RuntimeErrorCode::DownloadFailed, "download", true)
                .for_operation(operation_id)
        })?;
        if !response.status().is_success() || response.url().scheme() != "https" {
            return Err(
                RuntimeError::new(RuntimeErrorCode::DownloadFailed, "download", true)
                    .for_operation(operation_id),
            );
        }
        let total = response.content_length().or(expected_size);
        let expected = expected_size;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)
            .map_err(|error| install_io_error(error, "download", operation_id))?;
        let mut digest = Sha256::new();
        let mut received = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = response.read(&mut buffer).map_err(|_| {
                RuntimeError::new(RuntimeErrorCode::DownloadFailed, "download", true)
                    .for_operation(operation_id)
            })?;
            if read == 0 {
                break;
            }
            received = received.saturating_add(read as u64);
            if expected.is_some_and(|limit| received > limit) {
                return Err(
                    RuntimeError::new(RuntimeErrorCode::DownloadFailed, "download", false)
                        .for_operation(operation_id),
                );
            }
            file.write_all(&buffer[..read])
                .map_err(|error| install_io_error(error, "download", operation_id))?;
            digest.update(&buffer[..read]);
            progress(received, total);
        }
        file.sync_all()
            .map_err(|error| install_io_error(error, "download", operation_id))?;
        if expected.is_some_and(|size| size != received) {
            return Err(
                RuntimeError::new(RuntimeErrorCode::DownloadFailed, "download", true)
                    .for_operation(operation_id),
            );
        }
        Ok(hex_digest(digest.finalize().as_slice()))
    }
}

fn release_pin(os: &str, arch: &str) -> Result<&'static ReleasePin, RuntimeError> {
    let target_os = match os {
        "windows" => TargetOs::Windows,
        "linux" => TargetOs::Linux,
        _ => {
            return Err(RuntimeError::new(
                RuntimeErrorCode::UnsupportedPlatform,
                "resolve",
                false,
            ))
        }
    };
    let target_arch = match arch {
        "x86_64" => TargetArch::X86_64,
        "aarch64" => TargetArch::Aarch64,
        _ => {
            return Err(RuntimeError::new(
                RuntimeErrorCode::VersionUnavailable,
                "resolve",
                false,
            ))
        }
    };
    RELEASE_PINS
        .iter()
        .find(|pin| pin.os == target_os && pin.arch == target_arch)
        .ok_or_else(|| RuntimeError::new(RuntimeErrorCode::VersionUnavailable, "resolve", false))
}

fn current_release_pin() -> Result<&'static ReleasePin, RuntimeError> {
    #[cfg(target_os = "windows")]
    let os = "windows";
    #[cfg(target_os = "linux")]
    let os = "linux";
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    let os = "unsupported";

    let arch = std::env::consts::ARCH;
    release_pin(os, arch)
}

fn runtime_locations() -> Result<(PathBuf, PathBuf), RuntimeError> {
    let base = dirs::data_local_dir()
        .ok_or_else(|| RuntimeError::new(RuntimeErrorCode::PermissionDenied, "resolve", false))?;
    #[cfg(target_os = "windows")]
    let root = base
        .join("Nextain")
        .join("NaiaShell")
        .join("runtimes")
        .join("ollama");
    #[cfg(target_os = "linux")]
    let root = base.join("naia-shell").join("runtimes").join("ollama");
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    let root = base.join("naia-shell").join("runtimes").join("ollama");
    Ok((base, root))
}

fn is_default_managed_host(host: Option<&str>) -> bool {
    let Some(host) = host else {
        return true;
    };
    let Ok(parsed) = url::Url::parse(host) else {
        return false;
    };
    parsed.scheme() == "http"
        && parsed
            .host_str()
            .is_some_and(|name| name.eq_ignore_ascii_case("localhost"))
        && parsed.port_or_known_default() == Some(11434)
        && parsed.path() == "/"
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.query().is_none()
        && parsed.fragment().is_none()
}

fn next_operation_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let sequence = OPERATION_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("ollama-{millis}-{sequence}")
}

fn epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn log_ollama_debug(event: &str, operation_id: Option<&str>, details: &str) {
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    crate::log_verbose(&format!(
        "[{timestamp_ms}][OllamaRuntime] event={event} operation_id={} {details}",
        operation_id.unwrap_or("none")
    ));
}

fn install_io_error(error: io::Error, stage: &str, operation_id: &str) -> RuntimeError {
    let (code, retryable) = if error.kind() == io::ErrorKind::PermissionDenied {
        (RuntimeErrorCode::PermissionDenied, false)
    } else {
        (RuntimeErrorCode::DownloadFailed, true)
    };
    RuntimeError::new(code, stage, retryable).for_operation(operation_id)
}

fn archive_io_error(error: io::Error, operation_id: &str) -> RuntimeError {
    let code = if error.kind() == io::ErrorKind::PermissionDenied {
        RuntimeErrorCode::PermissionDenied
    } else {
        RuntimeErrorCode::ArchiveRejected
    };
    RuntimeError::new(code, "extract", false).for_operation(operation_id)
}

fn remove_io_error(error: io::Error, operation_id: &str) -> RuntimeError {
    let (code, retryable) = match error.kind() {
        io::ErrorKind::PermissionDenied => (RuntimeErrorCode::PermissionDenied, false),
        io::ErrorKind::NotFound => (RuntimeErrorCode::VersionNotInstalled, false),
        _ => (RuntimeErrorCode::NotManaged, true),
    };
    RuntimeError::new(code, "remove", retryable).for_operation(operation_id)
}

fn valid_version_id(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 64
        && version.as_bytes()[0].is_ascii_digit()
        && !version.contains("..")
        && version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-'))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut output, "{byte:02x}");
    }
    output
}

fn sha256_file(path: &Path, stage: &str, operation_id: &str) -> Result<String, RuntimeError> {
    let mut file =
        File::open(path).map_err(|error| install_io_error(error, stage, operation_id))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| install_io_error(error, stage, operation_id))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex_digest(digest.finalize().as_slice()))
}

fn ensure_managed_root(
    anchor: &Path,
    root: &Path,
    create: bool,
    operation_id: &str,
) -> Result<bool, RuntimeError> {
    let relative = root.strip_prefix(anchor).map_err(|_| {
        RuntimeError::new(RuntimeErrorCode::NotManaged, "discover", false)
            .for_operation(operation_id)
    })?;
    if create && !anchor.exists() {
        fs::create_dir_all(anchor)
            .map_err(|error| install_io_error(error, "place", operation_id))?;
    }
    if !anchor.exists() {
        return Ok(false);
    }
    let mut current = anchor.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(
                RuntimeError::new(RuntimeErrorCode::NotManaged, "discover", false)
                    .for_operation(operation_id),
            );
        };
        current.push(name);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(
                        RuntimeError::new(RuntimeErrorCode::NotManaged, "discover", false)
                            .for_operation(operation_id),
                    );
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound && create => {
                fs::create_dir(&current)
                    .map_err(|error| install_io_error(error, "place", operation_id))?;
                set_directory_mode(&current)
                    .map_err(|error| install_io_error(error, "place", operation_id))?;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(install_io_error(error, "discover", operation_id)),
        }
    }
    Ok(true)
}

#[cfg(unix)]
fn set_directory_mode(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn set_directory_mode(_path: &Path) -> io::Result<()> {
    Ok(())
}

fn safe_archive_path(raw: &str, operation_id: &str) -> Result<PathBuf, RuntimeError> {
    let rejected = || {
        RuntimeError::new(RuntimeErrorCode::ArchiveRejected, "extract", false)
            .for_operation(operation_id)
    };
    if raw.is_empty()
        || raw.starts_with('/')
        || raw.starts_with('\\')
        || raw.contains('\\')
        || raw.contains(':')
        || raw.contains('\0')
    {
        return Err(rejected());
    }
    let mut safe = PathBuf::new();
    for component in Path::new(raw).components() {
        match component {
            Component::Normal(value) => safe.push(value),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(rejected())
            }
        }
    }
    if safe.as_os_str().is_empty() {
        return Err(rejected());
    }
    Ok(safe)
}

fn output_path(root: &Path, relative: &Path, operation_id: &str) -> Result<PathBuf, RuntimeError> {
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(
            RuntimeError::new(RuntimeErrorCode::ArchiveRejected, "extract", false)
                .for_operation(operation_id),
        );
    }
    Ok(root.join(relative))
}

#[cfg(unix)]
fn set_extracted_mode(path: &Path, archive_mode: Option<u32>, directory: bool) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = if directory {
        0o755
    } else {
        (archive_mode.unwrap_or(0o644) & 0o755) | 0o600
    };
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_extracted_mode(
    _path: &Path,
    _archive_mode: Option<u32>,
    _directory: bool,
) -> io::Result<()> {
    Ok(())
}

fn extract_archive(
    archive_path: &Path,
    destination: &Path,
    pin: &ReleasePin,
    operation_id: &str,
) -> Result<(), RuntimeError> {
    match pin.format {
        ArchiveFormat::Zip => extract_zip(archive_path, destination, operation_id),
        ArchiveFormat::TarZst => extract_tar_zst(archive_path, destination, operation_id),
    }
}

fn extract_zip(
    archive_path: &Path,
    destination: &Path,
    operation_id: &str,
) -> Result<(), RuntimeError> {
    let file = File::open(archive_path).map_err(|error| archive_io_error(error, operation_id))?;
    let mut archive = ZipArchive::new(file).map_err(|_| {
        RuntimeError::new(RuntimeErrorCode::ArchiveRejected, "extract", false)
            .for_operation(operation_id)
    })?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(
            RuntimeError::new(RuntimeErrorCode::ArchiveRejected, "extract", false)
                .for_operation(operation_id),
        );
    }
    let mut extracted = 0_u64;
    let mut files = BTreeSet::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|_| {
            RuntimeError::new(RuntimeErrorCode::ArchiveRejected, "extract", false)
                .for_operation(operation_id)
        })?;
        if entry.is_symlink() {
            return Err(
                RuntimeError::new(RuntimeErrorCode::ArchiveRejected, "extract", false)
                    .for_operation(operation_id),
            );
        }
        let raw = std::str::from_utf8(entry.name_raw()).map_err(|_| {
            RuntimeError::new(RuntimeErrorCode::ArchiveRejected, "extract", false)
                .for_operation(operation_id)
        })?;
        let relative = safe_archive_path(raw, operation_id)?;
        let target = output_path(destination, &relative, operation_id)?;
        let mode = entry.unix_mode();
        if let Some(mode) = mode {
            let kind = mode & 0o170000;
            if kind != 0 && kind != 0o100000 && kind != 0o040000 {
                return Err(
                    RuntimeError::new(RuntimeErrorCode::ArchiveRejected, "extract", false)
                        .for_operation(operation_id),
                );
            }
        }
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|error| archive_io_error(error, operation_id))?;
            set_extracted_mode(&target, mode, true)
                .map_err(|error| archive_io_error(error, operation_id))?;
            continue;
        }
        extracted = extracted.saturating_add(entry.size());
        if extracted > MAX_EXTRACTED_BYTES || !files.insert(relative) {
            return Err(
                RuntimeError::new(RuntimeErrorCode::ArchiveRejected, "extract", false)
                    .for_operation(operation_id),
            );
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| archive_io_error(error, operation_id))?;
        }
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|error| archive_io_error(error, operation_id))?;
        io::copy(&mut entry, &mut output).map_err(|error| archive_io_error(error, operation_id))?;
        output
            .sync_all()
            .map_err(|error| archive_io_error(error, operation_id))?;
        set_extracted_mode(&target, mode, false)
            .map_err(|error| archive_io_error(error, operation_id))?;
    }
    Ok(())
}

fn extract_tar_zst(
    archive_path: &Path,
    destination: &Path,
    operation_id: &str,
) -> Result<(), RuntimeError> {
    let file = File::open(archive_path).map_err(|error| archive_io_error(error, operation_id))?;
    let decoder = zstd::stream::read::Decoder::new(file).map_err(|_| {
        RuntimeError::new(RuntimeErrorCode::ArchiveRejected, "extract", false)
            .for_operation(operation_id)
    })?;
    let mut archive = tar::Archive::new(decoder);
    let mut entries = archive.entries().map_err(|_| {
        RuntimeError::new(RuntimeErrorCode::ArchiveRejected, "extract", false)
            .for_operation(operation_id)
    })?;
    let mut extracted = 0_u64;
    let mut count = 0_usize;
    let mut files = BTreeSet::new();
    while let Some(entry_result) = entries.next() {
        count += 1;
        if count > MAX_ARCHIVE_ENTRIES {
            return Err(
                RuntimeError::new(RuntimeErrorCode::ArchiveRejected, "extract", false)
                    .for_operation(operation_id),
            );
        }
        let mut entry = entry_result.map_err(|_| {
            RuntimeError::new(RuntimeErrorCode::ArchiveRejected, "extract", false)
                .for_operation(operation_id)
        })?;
        let kind = entry.header().entry_type();
        if kind.is_symlink() || kind.is_hard_link() {
            return Err(
                RuntimeError::new(RuntimeErrorCode::ArchiveRejected, "extract", false)
                    .for_operation(operation_id),
            );
        }
        let path = entry.path().map_err(|_| {
            RuntimeError::new(RuntimeErrorCode::ArchiveRejected, "extract", false)
                .for_operation(operation_id)
        })?;
        let raw = path.to_str().ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::ArchiveRejected, "extract", false)
                .for_operation(operation_id)
        })?;
        let relative = safe_archive_path(raw, operation_id)?;
        let target = output_path(destination, &relative, operation_id)?;
        let mode = entry.header().mode().ok();
        if kind.is_dir() {
            fs::create_dir_all(&target).map_err(|error| archive_io_error(error, operation_id))?;
            set_extracted_mode(&target, mode, true)
                .map_err(|error| archive_io_error(error, operation_id))?;
            continue;
        }
        if !kind.is_file() {
            return Err(
                RuntimeError::new(RuntimeErrorCode::ArchiveRejected, "extract", false)
                    .for_operation(operation_id),
            );
        }
        let size = entry.size();
        extracted = extracted.saturating_add(size);
        if extracted > MAX_EXTRACTED_BYTES || !files.insert(relative) {
            return Err(
                RuntimeError::new(RuntimeErrorCode::ArchiveRejected, "extract", false)
                    .for_operation(operation_id),
            );
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| archive_io_error(error, operation_id))?;
        }
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|error| archive_io_error(error, operation_id))?;
        let copied = io::copy(&mut entry, &mut output)
            .map_err(|error| archive_io_error(error, operation_id))?;
        if copied != size {
            return Err(
                RuntimeError::new(RuntimeErrorCode::ArchiveRejected, "extract", false)
                    .for_operation(operation_id),
            );
        }
        output
            .sync_all()
            .map_err(|error| archive_io_error(error, operation_id))?;
        set_extracted_mode(&target, mode, false)
            .map_err(|error| archive_io_error(error, operation_id))?;
    }
    Ok(())
}

fn install_release<D, F>(
    anchor: &Path,
    root: &Path,
    pin: &ReleasePin,
    downloader: &D,
    operation_id: &str,
    mut progress: F,
) -> Result<InstalledRuntime, RuntimeError>
where
    D: ArtifactDownloader + ?Sized,
    F: FnMut(&str, u64, Option<u64>),
{
    let expected_sha256 = pin
        .sha256
        .filter(|value| valid_sha256(value))
        .ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::IntegrityMetadataMissing, "verify", false)
                .for_operation(operation_id)
        })?;
    if pin.version != RELEASE_VERSION
        || !pin
            .download_url
            .starts_with("https://github.com/ollama/ollama/releases/download/")
        || pin.integrity_source
            != format!(
                "{}/{}/sha256sum.txt",
                RELEASE_BASE,
                format!("v{}", pin.version)
            )
    {
        return Err(
            RuntimeError::new(RuntimeErrorCode::VersionUnavailable, "resolve", false)
                .for_operation(operation_id),
        );
    }
    if !ensure_managed_root(anchor, root, true, operation_id)? {
        return Err(
            RuntimeError::new(RuntimeErrorCode::PermissionDenied, "place", false)
                .for_operation(operation_id),
        );
    }
    let final_dir = root.join(pin.version);
    match fs::symlink_metadata(&final_dir) {
        Ok(_) => {
            return validate_installation(root, pin.version, pin.os, pin.arch, operation_id).map(
                |manifest| InstalledRuntime {
                    version: manifest.version,
                },
            );
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(install_io_error(error, "discover", operation_id)),
    }

    let temp = tempfile::Builder::new()
        .prefix(".ollama-install-")
        .tempdir_in(root)
        .map_err(|error| install_io_error(error, "place", operation_id))?;
    set_directory_mode(temp.path())
        .map_err(|error| install_io_error(error, "place", operation_id))?;
    let archive_path = temp.path().join("artifact");
    progress("download", 0, Some(pin.asset_size));
    let actual_sha256 = downloader.download(
        pin.download_url,
        &archive_path,
        Some(pin.asset_size),
        operation_id,
        &mut |received, total| progress("download", received, total),
    )?;
    progress("verify", pin.asset_size, Some(pin.asset_size));
    if !actual_sha256.eq_ignore_ascii_case(expected_sha256) {
        return Err(
            RuntimeError::new(RuntimeErrorCode::IntegrityMismatch, "verify", false)
                .for_operation(operation_id),
        );
    }

    let payload = temp.path().join("payload");
    fs::create_dir(&payload).map_err(|error| install_io_error(error, "extract", operation_id))?;
    set_directory_mode(&payload)
        .map_err(|error| install_io_error(error, "extract", operation_id))?;
    progress("extract", 0, None);
    extract_archive(&archive_path, &payload, pin, operation_id)?;

    let executable_relative = Path::new(pin.executable_relative_path);
    let executable = output_path(&payload, executable_relative, operation_id)?;
    let executable_metadata =
        fs::symlink_metadata(&executable).map_err(|error| archive_io_error(error, operation_id))?;
    if executable_metadata.file_type().is_symlink() || !executable_metadata.is_file() {
        return Err(
            RuntimeError::new(RuntimeErrorCode::ArchiveRejected, "extract", false)
                .for_operation(operation_id),
        );
    }
    if pin.os == TargetOs::Linux {
        set_extracted_mode(&executable, Some(0o755), false)
            .map_err(|error| archive_io_error(error, operation_id))?;
    }
    let executable_sha256 = sha256_file(&executable, "verify", operation_id)?;
    let manifest = InstallManifest {
        schema_version: 1,
        version: pin.version.to_string(),
        target_os: pin.os.as_str().to_string(),
        target_arch: pin.arch.as_str().to_string(),
        asset_name: pin.asset_name.to_string(),
        download_url: pin.download_url.to_string(),
        integrity_kind: INTEGRITY_KIND.to_string(),
        integrity_source: pin.integrity_source.to_string(),
        archive_sha256: actual_sha256,
        integrity_verified: true,
        executable_relative_path: pin.executable_relative_path.to_string(),
        executable_sha256,
        installed_at_unix_seconds: epoch_seconds(),
    };
    let manifest_path = payload.join(MANIFEST_FILE);
    let mut manifest_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&manifest_path)
        .map_err(|error| install_io_error(error, "place", operation_id))?;
    serde_json::to_writer(&mut manifest_file, &manifest).map_err(|_| {
        RuntimeError::new(RuntimeErrorCode::DownloadFailed, "place", true)
            .for_operation(operation_id)
    })?;
    manifest_file
        .write_all(b"\n")
        .and_then(|()| manifest_file.sync_all())
        .map_err(|error| install_io_error(error, "place", operation_id))?;
    progress("place", pin.asset_size, Some(pin.asset_size));
    match fs::symlink_metadata(&final_dir) {
        Ok(_) => {
            return Err(
                RuntimeError::new(RuntimeErrorCode::NotManaged, "place", false)
                    .for_operation(operation_id),
            )
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(install_io_error(error, "place", operation_id)),
    }
    fs::rename(&payload, &final_dir)
        .map_err(|error| install_io_error(error, "place", operation_id))?;
    Ok(InstalledRuntime {
        version: pin.version.to_string(),
    })
}

fn expected_asset(os: TargetOs, arch: TargetArch) -> (&'static str, &'static str) {
    match (os, arch) {
        (TargetOs::Windows, TargetArch::X86_64) => ("ollama-windows-amd64.zip", "ollama.exe"),
        (TargetOs::Windows, TargetArch::Aarch64) => ("ollama-windows-arm64.zip", "ollama.exe"),
        (TargetOs::Linux, TargetArch::X86_64) => ("ollama-linux-amd64.tar.zst", "bin/ollama"),
        (TargetOs::Linux, TargetArch::Aarch64) => ("ollama-linux-arm64.tar.zst", "bin/ollama"),
    }
}

fn validate_installation(
    root: &Path,
    version: &str,
    os: TargetOs,
    arch: TargetArch,
    operation_id: &str,
) -> Result<InstallManifest, RuntimeError> {
    if !valid_version_id(version) {
        return Err(
            RuntimeError::new(RuntimeErrorCode::VersionMalformed, "discover", false)
                .for_operation(operation_id),
        );
    }
    let version_dir = root.join(version);
    let dir_metadata = fs::symlink_metadata(&version_dir).map_err(|error| {
        let code = if error.kind() == io::ErrorKind::NotFound {
            RuntimeErrorCode::VersionNotInstalled
        } else if error.kind() == io::ErrorKind::PermissionDenied {
            RuntimeErrorCode::PermissionDenied
        } else {
            RuntimeErrorCode::NotManaged
        };
        RuntimeError::new(code, "discover", false).for_operation(operation_id)
    })?;
    if dir_metadata.file_type().is_symlink() || !dir_metadata.is_dir() {
        return Err(
            RuntimeError::new(RuntimeErrorCode::NotManaged, "discover", false)
                .for_operation(operation_id),
        );
    }
    let manifest_path = version_dir.join(MANIFEST_FILE);
    let metadata = fs::symlink_metadata(&manifest_path).map_err(|_| {
        RuntimeError::new(RuntimeErrorCode::NotManaged, "discover", false)
            .for_operation(operation_id)
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 64 * 1024 {
        return Err(
            RuntimeError::new(RuntimeErrorCode::NotManaged, "discover", false)
                .for_operation(operation_id),
        );
    }
    let manifest: InstallManifest =
        serde_json::from_reader(File::open(manifest_path).map_err(|_| {
            RuntimeError::new(RuntimeErrorCode::NotManaged, "discover", false)
                .for_operation(operation_id)
        })?)
        .map_err(|_| {
            RuntimeError::new(RuntimeErrorCode::NotManaged, "discover", false)
                .for_operation(operation_id)
        })?;
    let (asset_name, executable_relative_path) = expected_asset(os, arch);
    let expected_url = format!("{RELEASE_BASE}/v{}/{asset_name}", manifest.version);
    let expected_integrity_source = format!("{RELEASE_BASE}/v{}/sha256sum.txt", manifest.version);
    if manifest.schema_version != 1
        || manifest.version != version
        || !valid_version_id(&manifest.version)
        || manifest.target_os != os.as_str()
        || manifest.target_arch != arch.as_str()
        || manifest.asset_name != asset_name
        || manifest.download_url != expected_url
        || manifest.integrity_kind != INTEGRITY_KIND
        || manifest.integrity_source != expected_integrity_source
        || !valid_sha256(&manifest.archive_sha256)
        || !manifest.integrity_verified
        || manifest.executable_relative_path != executable_relative_path
        || !valid_sha256(&manifest.executable_sha256)
        || manifest.installed_at_unix_seconds == 0
    {
        return Err(
            RuntimeError::new(RuntimeErrorCode::NotManaged, "discover", false)
                .for_operation(operation_id),
        );
    }
    let executable = version_dir.join(executable_relative_path);
    let executable_metadata = fs::symlink_metadata(&executable).map_err(|_| {
        RuntimeError::new(RuntimeErrorCode::NotManaged, "discover", false)
            .for_operation(operation_id)
    })?;
    if executable_metadata.file_type().is_symlink() || !executable_metadata.is_file() {
        return Err(
            RuntimeError::new(RuntimeErrorCode::NotManaged, "discover", false)
                .for_operation(operation_id),
        );
    }
    let actual_executable_sha = sha256_file(&executable, "discover", operation_id)?;
    if !actual_executable_sha.eq_ignore_ascii_case(&manifest.executable_sha256) {
        return Err(
            RuntimeError::new(RuntimeErrorCode::NotManaged, "discover", false)
                .for_operation(operation_id),
        );
    }
    Ok(manifest)
}

fn inspect_installations(
    anchor: &Path,
    root: &Path,
    os: TargetOs,
    arch: TargetArch,
    operation_id: &str,
) -> Result<(Vec<String>, bool), RuntimeError> {
    if !ensure_managed_root(anchor, root, false, operation_id)? {
        return Ok((Vec::new(), false));
    }
    let entries =
        fs::read_dir(root).map_err(|error| install_io_error(error, "discover", operation_id))?;
    let mut versions = Vec::new();
    let mut invalid_manifest_found = false;
    for entry in entries {
        let entry = entry.map_err(|error| install_io_error(error, "discover", operation_id))?;
        let Some(version) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !valid_version_id(&version) {
            continue;
        }
        match validate_installation(root, &version, os, arch, operation_id) {
            Ok(_) => versions.push(version),
            Err(error) if error.code == RuntimeErrorCode::VersionNotInstalled => {}
            Err(error) if error.code == RuntimeErrorCode::PermissionDenied => return Err(error),
            Err(_) => invalid_manifest_found = true,
        }
    }
    versions.sort();
    Ok((versions, invalid_manifest_found))
}

fn remove_installation(
    anchor: &Path,
    root: &Path,
    version: &str,
    os: TargetOs,
    arch: TargetArch,
    active: bool,
    operation_id: &str,
) -> Result<Vec<String>, RuntimeError> {
    if !valid_version_id(version) {
        return Err(
            RuntimeError::new(RuntimeErrorCode::VersionMalformed, "remove", false)
                .for_operation(operation_id),
        );
    }
    if active {
        return Err(
            RuntimeError::new(RuntimeErrorCode::RuntimeInUse, "remove", true)
                .for_operation(operation_id),
        );
    }
    if !ensure_managed_root(anchor, root, false, operation_id)? {
        return Err(
            RuntimeError::new(RuntimeErrorCode::VersionNotInstalled, "remove", false)
                .for_operation(operation_id),
        );
    }
    validate_installation(root, version, os, arch, operation_id)?;
    fs::remove_dir_all(root.join(version)).map_err(|error| remove_io_error(error, operation_id))?;
    let (remaining, invalid) = inspect_installations(anchor, root, os, arch, operation_id)?;
    if invalid {
        return Err(
            RuntimeError::new(RuntimeErrorCode::NotManaged, "discover", false)
                .for_operation(operation_id),
        );
    }
    Ok(remaining)
}

fn validate_remove_request(version: &str, confirm: bool) -> Result<(), RuntimeError> {
    if !confirm {
        return Err(RuntimeError::new(
            RuntimeErrorCode::ConfirmationRequired,
            "remove",
            false,
        ));
    }
    if !valid_version_id(version) {
        return Err(RuntimeError::new(
            RuntimeErrorCode::VersionMalformed,
            "remove",
            false,
        ));
    }
    Ok(())
}

fn emit_snapshot(app: &AppHandle, snapshot: &RuntimeSnapshot) {
    let _ = app.emit(STATE_EVENT, snapshot);
}

fn emit_progress(
    app: &AppHandle,
    operation_id: &str,
    phase: &str,
    received_bytes: u64,
    total_bytes: Option<u64>,
) {
    let _ = app.emit(
        PROGRESS_EVENT,
        InstallProgress {
            operation_id: operation_id.to_string(),
            phase: phase.to_string(),
            received_bytes,
            total_bytes,
        },
    );
}

fn snapshot_from_installations(
    versions: Vec<String>,
    error: Option<RuntimeError>,
) -> RuntimeSnapshot {
    let installed_version = versions.last().cloned();
    RuntimeSnapshot {
        state: if error.is_some() {
            RuntimeState::Failed
        } else if versions.is_empty() {
            RuntimeState::NotInstalled
        } else {
            RuntimeState::InstalledStopped
        },
        server_state: if error.is_some() {
            ServerState::Failed
        } else if versions.is_empty() {
            ServerState::NotInstalled
        } else {
            ServerState::InstalledStopped
        },
        ownership: RuntimeOwnership::None,
        installed_version,
        installed_versions: versions,
        model_count: None,
        reservation: ReservationSnapshot::default(),
        operation_id: None,
        phase: None,
        error,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EndpointScope {
    ManagedDefault,
    Loopback,
    Remote,
}

#[derive(Clone, Debug)]
struct RuntimeEndpoint {
    url: url::Url,
    scope: EndpointScope,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProbeResult {
    Ready { model_count: usize },
    NotListening,
    ApiUnreachable,
}

fn parse_endpoint(
    host: Option<&str>,
    default_base_url: &str,
) -> Result<RuntimeEndpoint, RuntimeError> {
    let raw = host.unwrap_or(default_base_url);
    let url = url::Url::parse(raw)
        .map_err(|_| RuntimeError::new(RuntimeErrorCode::HostNotAllowed, "endpoint", false))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(RuntimeError::new(
            RuntimeErrorCode::HostNotAllowed,
            "endpoint",
            false,
        ));
    }
    let scope = if host.is_none() || is_default_managed_host(host) {
        EndpointScope::ManagedDefault
    } else if is_loopback_endpoint(&url) {
        EndpointScope::Loopback
    } else {
        EndpointScope::Remote
    };
    Ok(RuntimeEndpoint { url, scope })
}

fn is_loopback_endpoint(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        Some(url::Host::Domain(name)) => {
            name.eq_ignore_ascii_case("localhost")
                || name
                    .to_ascii_lowercase()
                    .strip_suffix(".localhost")
                    .is_some()
        }
        None => false,
    }
}

fn api_tags_url(base: &url::Url) -> Result<url::Url, RuntimeError> {
    let mut endpoint = base.clone();
    let base_path = endpoint.path().trim_end_matches('/');
    let path = if base_path.is_empty() {
        "/api/tags".to_string()
    } else {
        format!("{base_path}/api/tags")
    };
    endpoint.set_path(&path);
    Ok(endpoint)
}

fn probe_ollama(base: &url::Url, timeout: Duration) -> ProbeResult {
    let Ok(endpoint) = api_tags_url(base) else {
        return ProbeResult::ApiUnreachable;
    };
    let Ok(client) = reqwest::blocking::Client::builder()
        .connect_timeout(timeout)
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return ProbeResult::ApiUnreachable;
    };
    let response = match client.get(endpoint).send() {
        Ok(response) => response,
        Err(error) if is_connection_refused(&error) => return ProbeResult::NotListening,
        Err(_) => return ProbeResult::ApiUnreachable,
    };
    if response.status() != reqwest::StatusCode::OK {
        return ProbeResult::ApiUnreachable;
    }
    match response.json::<serde_json::Value>() {
        Ok(payload) => payload
            .as_object()
            .and_then(|object| object.get("models"))
            .and_then(serde_json::Value::as_array)
            .map(|models| ProbeResult::Ready {
                model_count: models.len(),
            })
            .unwrap_or(ProbeResult::ApiUnreachable),
        Err(_) => ProbeResult::ApiUnreachable,
    }
}

fn is_connection_refused(error: &reqwest::Error) -> bool {
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        if cause
            .downcast_ref::<io::Error>()
            .is_some_and(|io_error| io_error.kind() == io::ErrorKind::ConnectionRefused)
        {
            return true;
        }
        source = cause.source();
    }
    false
}

fn api_error(stage: &str, retryable: bool) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::ApiUnreachable, stage, retryable)
}

fn emit_optional_snapshot(app: Option<&AppHandle>, snapshot: &RuntimeSnapshot) {
    if let Some(app) = app {
        emit_snapshot(app, snapshot);
    }
}

fn emit_manager_snapshot(app: Option<&AppHandle>, manager: &RuntimeManager) {
    emit_optional_snapshot(app, &manager.snapshot());
}

fn install_state_from_versions(versions: &[String]) -> RuntimeState {
    if versions.is_empty() {
        RuntimeState::NotInstalled
    } else {
        RuntimeState::InstalledStopped
    }
}

fn update_operation_snapshot(
    manager: &RuntimeManager,
    operation_id: &str,
    versions: &[String],
    installed_version: Option<&str>,
    server_state: ServerState,
    ownership: RuntimeOwnership,
    model_count: Option<usize>,
    phase: &str,
) {
    let mut state = manager.lock();
    if !state
        .operation
        .as_ref()
        .is_some_and(|operation| operation.id == operation_id)
    {
        return;
    }
    state.snapshot.state = if server_state == ServerState::Installing {
        RuntimeState::Installing
    } else {
        install_state_from_versions(versions)
    };
    state.snapshot.server_state = server_state;
    state.snapshot.ownership = ownership;
    state.snapshot.installed_versions = versions.to_vec();
    state.snapshot.installed_version = installed_version
        .map(str::to_string)
        .or_else(|| versions.last().cloned());
    state.snapshot.model_count = model_count;
    state.snapshot.phase = Some(phase.to_string());
    state.snapshot.error = None;
}

fn child_is_stopped(child: &mut dyn ManagedChild) -> bool {
    if !matches!(child.has_exited(), Ok(true)) || !matches!(child.process_tree_alive(), Ok(false)) {
        return false;
    }
    child.reap_exited_leader().is_ok()
}

fn stop_managed_child(child: &mut dyn ManagedChild, settings: &RuntimeSettings) -> bool {
    if child_is_stopped(child) {
        return true;
    }
    let _ = child.request_graceful_shutdown();
    let graceful_deadline = Instant::now() + settings.graceful_stop_timeout;
    while Instant::now() < graceful_deadline {
        if child_is_stopped(child) {
            return true;
        }
        thread::sleep(settings.poll_interval.min(Duration::from_millis(50)));
    }

    let _ = child.force_kill_tree();
    let force_deadline = Instant::now() + settings.force_stop_timeout;
    while Instant::now() < force_deadline {
        if child_is_stopped(child) {
            return true;
        }
        thread::sleep(settings.poll_interval.min(Duration::from_millis(50)));
    }
    child_is_stopped(child)
}

fn stop_managed_process(process: &mut ManagedProcess, settings: &RuntimeSettings) -> bool {
    stop_managed_child(process.child.as_mut(), settings)
}

fn update_runtime_snapshot(manager: &RuntimeManager, snapshot: RuntimeSnapshot) -> RuntimeSnapshot {
    let mut state = manager.lock();
    if state.operation.is_some() {
        return state.snapshot.clone();
    }
    state.snapshot = snapshot;
    state.snapshot.clone()
}

fn current_installations(
    anchor: &Path,
    root: &Path,
    pin: &ReleasePin,
    operation_id: &str,
) -> Result<(Vec<String>, bool), RuntimeError> {
    inspect_installations(anchor, root, pin.os, pin.arch, operation_id)
}

fn finish_start_error(
    manager: &RuntimeManager,
    app: Option<&AppHandle>,
    operation_id: &str,
    error: RuntimeError,
) {
    manager.finish_failure(operation_id, error);
    emit_manager_snapshot(app, manager);
}

fn finish_start_with_process_error(
    manager: &RuntimeManager,
    app: Option<&AppHandle>,
    operation_id: &str,
    generation: u64,
    error: RuntimeError,
) {
    let mut process = {
        let mut state = manager.lock();
        if state
            .process
            .as_ref()
            .is_some_and(|process| process.generation == generation)
        {
            state.process.take()
        } else {
            None
        }
    };
    let snapshot = manager.snapshot();
    let versions = snapshot.installed_versions;
    let installed = snapshot.installed_version;
    let (final_error, ownership) = if let Some(process_ref) = process.as_mut() {
        if stop_managed_process(process_ref, &manager.settings) {
            let mut state = manager.lock();
            state.active_versions.remove(&process_ref.version);
            (error, RuntimeOwnership::None)
        } else {
            let version = process_ref.version.clone();
            let mut state = manager.lock();
            state.active_versions.insert(version);
            state.process = process.take();
            (
                RuntimeError::new(RuntimeErrorCode::StopFailed, "stop", true),
                RuntimeOwnership::ManagedChild,
            )
        }
    } else {
        (error, RuntimeOwnership::None)
    };
    manager.finish_server_operation(
        operation_id,
        versions,
        installed,
        ServerState::Failed,
        ownership,
        None,
        Some(final_error),
    );
    emit_manager_snapshot(app, manager);
}

fn perform_start_operation(
    manager: RuntimeManager,
    app: Option<AppHandle>,
    anchor: PathBuf,
    root: PathBuf,
    pin: ReleasePin,
    endpoint: RuntimeEndpoint,
    operation_id: String,
) {
    log_ollama_debug(
        "start.worker_enter",
        Some(&operation_id),
        &format!("host_scope={:?}", endpoint.scope),
    );
    let existing_managed = {
        let mut state = manager.lock();
        match state.process.as_mut() {
            Some(process) => Some((
                process.generation,
                process.version.clone(),
                process.child.has_exited(),
            )),
            None => None,
        }
    };
    let initial_probe = probe_ollama(&endpoint.url, manager.settings.request_timeout);
    let (mut versions, invalid_manifest) =
        match current_installations(&anchor, &root, &pin, &operation_id) {
            Ok(result) => result,
            Err(error) => {
                finish_start_error(&manager, app.as_ref(), &operation_id, error);
                return;
            }
        };
    if invalid_manifest {
        finish_start_error(
            &manager,
            app.as_ref(),
            &operation_id,
            RuntimeError::new(RuntimeErrorCode::NotManaged, "discover", false),
        );
        return;
    }
    let installed_version = versions.last().cloned();
    update_operation_snapshot(
        &manager,
        &operation_id,
        &versions,
        installed_version.as_deref(),
        ServerState::CheckingHost,
        if existing_managed.is_some() {
            RuntimeOwnership::ManagedChild
        } else {
            RuntimeOwnership::None
        },
        None,
        "checking_host",
    );
    emit_manager_snapshot(app.as_ref(), &manager);

    if let Some((generation, version, exited)) = existing_managed {
        match exited {
            Ok(false) => {
                log_ollama_debug(
                    "start.managed_child_found",
                    Some(&operation_id),
                    "child_spawned=false",
                );
                let deadline = Instant::now() + manager.settings.readiness_timeout;
                loop {
                    let alive = {
                        let mut state = manager.lock();
                        match state
                            .process
                            .as_mut()
                            .filter(|process| process.generation == generation)
                        {
                            Some(process) => process.child.has_exited().map(|exited| !exited),
                            None => Ok(false),
                        }
                    };
                    match alive {
                        Ok(false) => {
                            finish_start_with_process_error(
                                &manager,
                                app.as_ref(),
                                &operation_id,
                                generation,
                                RuntimeError::new(RuntimeErrorCode::ProcessExited, "ready", true),
                            );
                            return;
                        }
                        Err(_) => {
                            finish_start_with_process_error(
                                &manager,
                                app.as_ref(),
                                &operation_id,
                                generation,
                                RuntimeError::new(RuntimeErrorCode::StopFailed, "monitor", true),
                            );
                            return;
                        }
                        Ok(true) => {}
                    }
                    let now = Instant::now();
                    if now >= deadline {
                        finish_start_with_process_error(
                            &manager,
                            app.as_ref(),
                            &operation_id,
                            generation,
                            RuntimeError::new(RuntimeErrorCode::ReadinessTimeout, "ready", true),
                        );
                        return;
                    }
                    let timeout = manager
                        .settings
                        .request_timeout
                        .min(deadline.saturating_duration_since(now));
                    if let ProbeResult::Ready { model_count } = probe_ollama(&endpoint.url, timeout)
                    {
                        manager.finish_server_operation(
                            &operation_id,
                            versions,
                            Some(version),
                            ServerState::ReadyManaged,
                            RuntimeOwnership::ManagedChild,
                            Some(model_count),
                            None,
                        );
                        emit_manager_snapshot(app.as_ref(), &manager);
                        return;
                    }
                    thread::sleep(
                        manager
                            .settings
                            .poll_interval
                            .min(deadline.saturating_duration_since(Instant::now())),
                    );
                }
            }
            Ok(true) => {
                finish_start_with_process_error(
                    &manager,
                    app.as_ref(),
                    &operation_id,
                    generation,
                    RuntimeError::new(RuntimeErrorCode::ProcessExited, "monitor", true),
                );
                return;
            }
            Err(_) => {
                finish_start_error(
                    &manager,
                    app.as_ref(),
                    &operation_id,
                    RuntimeError::new(RuntimeErrorCode::StopFailed, "monitor", true),
                );
                return;
            }
        }
    }

    match initial_probe {
        ProbeResult::Ready { model_count } => {
            log_ollama_debug(
                "start.external_server_found",
                Some(&operation_id),
                &format!("model_count={model_count} child_spawned=false"),
            );
            manager.finish_server_operation(
                &operation_id,
                versions,
                installed_version,
                ServerState::ConnectedUnreserved,
                RuntimeOwnership::ExternalLocal,
                Some(model_count),
                None,
            );
            emit_manager_snapshot(app.as_ref(), &manager);
            return;
        }
        ProbeResult::ApiUnreachable => {
            log_ollama_debug(
                "start.probe_rejected",
                Some(&operation_id),
                "reason=api_unreachable child_spawned=false",
            );
            manager.finish_server_operation(
                &operation_id,
                versions,
                installed_version,
                ServerState::Failed,
                RuntimeOwnership::None,
                None,
                Some(api_error("probe", true)),
            );
            emit_manager_snapshot(app.as_ref(), &manager);
            return;
        }
        ProbeResult::NotListening => {
            log_ollama_debug(
                "start.endpoint_available_for_managed_launch",
                Some(&operation_id),
                "result=connection_refused",
            );
        }
    }

    if manager.is_shutting_down() {
        return;
    }
    if versions.is_empty() {
        log_ollama_debug("start.install_required", Some(&operation_id), "pin=0.40.3");
        update_operation_snapshot(
            &manager,
            &operation_id,
            &versions,
            None,
            ServerState::Installing,
            RuntimeOwnership::None,
            None,
            "download",
        );
        emit_manager_snapshot(app.as_ref(), &manager);
        let app_worker = app.clone();
        let manager_worker = manager.clone();
        let download = install_release(
            &anchor,
            &root,
            &pin,
            manager.downloader.as_ref(),
            &operation_id,
            |phase, received, total| {
                manager_worker.set_phase(&operation_id, phase);
                if let Some(app) = app_worker.as_ref() {
                    emit_progress(app, &operation_id, phase, received, total);
                }
            },
        );
        match download {
            Ok(_) => {
                if manager.is_shutting_down() {
                    return;
                }
                match current_installations(&anchor, &root, &pin, &operation_id) {
                    Ok((found, invalid)) if !invalid && !found.is_empty() => {
                        versions = found;
                        log_ollama_debug(
                            "start.install_ready",
                            Some(&operation_id),
                            "manifest_and_executable_verified=true",
                        );
                    }
                    Ok(_) => {
                        finish_start_error(
                            &manager,
                            app.as_ref(),
                            &operation_id,
                            RuntimeError::new(RuntimeErrorCode::NotManaged, "discover", false),
                        );
                        return;
                    }
                    Err(error) => {
                        finish_start_error(&manager, app.as_ref(), &operation_id, error);
                        return;
                    }
                }
            }
            Err(error) => {
                finish_start_error(&manager, app.as_ref(), &operation_id, error);
                return;
            }
        }
    }

    if manager.is_shutting_down() {
        return;
    }
    let Some(version) = versions.last().cloned() else {
        finish_start_error(
            &manager,
            app.as_ref(),
            &operation_id,
            RuntimeError::new(RuntimeErrorCode::VersionNotInstalled, "discover", false),
        );
        return;
    };
    log_ollama_debug(
        "start.installation_selected",
        Some(&operation_id),
        &format!("version={version}"),
    );
    let manifest = match validate_installation(&root, &version, pin.os, pin.arch, &operation_id) {
        Ok(manifest) => manifest,
        Err(error) => {
            finish_start_error(&manager, app.as_ref(), &operation_id, error);
            return;
        }
    };
    let executable = root.join(&version).join(&manifest.executable_relative_path);
    update_operation_snapshot(
        &manager,
        &operation_id,
        &versions,
        Some(&version),
        ServerState::Starting,
        RuntimeOwnership::None,
        None,
        "starting",
    );
    emit_manager_snapshot(app.as_ref(), &manager);
    let managed_url = match url::Url::parse(&manager.settings.managed_base_url) {
        Ok(url) => url,
        Err(_) => {
            finish_start_error(
                &manager,
                app.as_ref(),
                &operation_id,
                RuntimeError::new(
                    RuntimeErrorCode::ManagedEndpointUnsupported,
                    "endpoint",
                    false,
                ),
            );
            return;
        }
    };
    let managed_host = match managed_url.port_or_known_default() {
        Some(port) => format!("127.0.0.1:{port}"),
        None => {
            finish_start_error(
                &manager,
                app.as_ref(),
                &operation_id,
                RuntimeError::new(
                    RuntimeErrorCode::ManagedEndpointUnsupported,
                    "endpoint",
                    false,
                ),
            );
            return;
        }
    };
    let spec = ProcessSpec {
        executable,
        arguments: vec!["serve".to_string()],
        environment: BTreeMap::from([(
            std::ffi::OsString::from("OLLAMA_HOST"),
            std::ffi::OsString::from(managed_host),
        )]),
        inherit_environment: true,
    };
    let child = match manager.process_runner.spawn(&spec) {
        Ok(child) => child,
        Err(error) => {
            let code = if error.kind() == io::ErrorKind::PermissionDenied {
                RuntimeErrorCode::PermissionDenied
            } else {
                RuntimeErrorCode::SpawnFailed
            };
            finish_start_error(
                &manager,
                app.as_ref(),
                &operation_id,
                RuntimeError::new(code, "spawn", true),
            );
            return;
        }
    };
    let mut pending_child = Some(child);
    let generation = {
        let mut state = manager.lock();
        let operation_is_current = state
            .operation
            .as_ref()
            .is_some_and(|operation| operation.id == operation_id);
        if state.shutdown_requested || !operation_is_current || state.process.is_some() {
            None
        } else {
            let generation = state.next_process_generation;
            state.next_process_generation = state.next_process_generation.wrapping_add(1).max(1);
            state.active_versions.insert(version.clone());
            state.process = Some(ManagedProcess {
                child: pending_child
                    .take()
                    .expect("spawned Ollama child is present"),
                version: version.clone(),
                generation,
                reservation: None,
            });
            state.snapshot.state = RuntimeState::InstalledStopped;
            state.snapshot.server_state = ServerState::Starting;
            state.snapshot.ownership = RuntimeOwnership::ManagedChild;
            state.snapshot.installed_version = Some(version.clone());
            state.snapshot.installed_versions = versions.clone();
            state.snapshot.model_count = None;
            state.snapshot.phase = Some("ready".to_string());
            Some(generation)
        }
    };
    let Some(generation) = generation else {
        log_ollama_debug(
            "start.child_rejected_after_spawn",
            Some(&operation_id),
            "reason=shutdown_or_operation_changed",
        );
        if let Some(child) = pending_child {
            let mut pending = ManagedProcess {
                child,
                version,
                generation: 0,
                reservation: None,
            };
            let _ = stop_managed_process(&mut pending, &manager.settings);
        }
        return;
    };
    log_ollama_debug(
        "start.child_spawned",
        Some(&operation_id),
        &format!("version={version} arguments=serve host=loopback"),
    );
    emit_manager_snapshot(app.as_ref(), &manager);

    let readiness_deadline = Instant::now() + manager.settings.readiness_timeout;
    loop {
        if manager.is_shutting_down() {
            return;
        }
        let process_status = {
            let mut state = manager.lock();
            match state.process.as_mut() {
                Some(process) if process.generation == generation => {
                    match process.child.has_exited() {
                        Ok(true) => 1,
                        Ok(false) => 0,
                        Err(_) => 2,
                    }
                }
                _ => 3,
            }
        };
        match process_status {
            1 => {
                log_ollama_debug(
                    "start.child_exited_before_ready",
                    Some(&operation_id),
                    "stage=bind",
                );
                finish_start_with_process_error(
                    &manager,
                    app.as_ref(),
                    &operation_id,
                    generation,
                    RuntimeError::new(RuntimeErrorCode::ProcessExited, "bind", true),
                );
                return;
            }
            2 => {
                log_ollama_debug(
                    "start.child_monitor_uncertain",
                    Some(&operation_id),
                    "result=stop_failed",
                );
                finish_start_with_process_error(
                    &manager,
                    app.as_ref(),
                    &operation_id,
                    generation,
                    RuntimeError::new(RuntimeErrorCode::StopFailed, "monitor", true),
                );
                return;
            }
            3 => return,
            _ => {}
        }

        let now = Instant::now();
        if now >= readiness_deadline {
            log_ollama_debug(
                "start.readiness_timeout",
                Some(&operation_id),
                "elapsed_deadline_reached=true",
            );
            finish_start_with_process_error(
                &manager,
                app.as_ref(),
                &operation_id,
                generation,
                RuntimeError::new(RuntimeErrorCode::ReadinessTimeout, "ready", true),
            );
            return;
        }
        let timeout = manager
            .settings
            .request_timeout
            .min(readiness_deadline.saturating_duration_since(now));
        match probe_ollama(&endpoint.url, timeout) {
            ProbeResult::Ready { model_count } => {
                log_ollama_debug(
                    "start.ready_managed",
                    Some(&operation_id),
                    &format!("model_count={model_count}"),
                );
                let monitor = spawn_process_monitor(manager.clone(), app.clone(), generation);
                if monitor.is_err() {
                    finish_start_with_process_error(
                        &manager,
                        app.as_ref(),
                        &operation_id,
                        generation,
                        RuntimeError::new(RuntimeErrorCode::SpawnFailed, "monitor", true),
                    );
                    return;
                }
                manager.finish_server_operation(
                    &operation_id,
                    versions.clone(),
                    Some(version.clone()),
                    ServerState::ReadyManaged,
                    RuntimeOwnership::ManagedChild,
                    Some(model_count),
                    None,
                );
                emit_manager_snapshot(app.as_ref(), &manager);
                return;
            }
            ProbeResult::NotListening | ProbeResult::ApiUnreachable => {
                let remaining = readiness_deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    continue;
                }
                thread::sleep(manager.settings.poll_interval.min(remaining));
            }
        }
    }
}

fn spawn_process_monitor(
    manager: RuntimeManager,
    app: Option<AppHandle>,
    generation: u64,
) -> io::Result<thread::JoinHandle<()>> {
    thread::Builder::new()
        .name("ollama-runtime-monitor".to_string())
        .spawn(move || loop {
            thread::sleep(manager.settings.poll_interval);
            let observation = {
                let mut state = manager.lock();
                if state.shutdown_requested {
                    return;
                }
                if state.operation.is_some() {
                    continue;
                }
                let process_exited = match state
                    .process
                    .as_mut()
                    .filter(|process| process.generation == generation)
                {
                    Some(process) => match process.child.has_exited() {
                        Ok(true) => Some(true),
                        Ok(false) => None,
                        Err(_) => Some(false),
                    },
                    None => return,
                };
                let Some(child_exited) = process_exited else {
                    continue;
                };
                let operation_id = next_operation_id();
                state.operation = Some(ActiveOperation {
                    id: operation_id.clone(),
                    kind: OperationKind::Stop,
                });
                state.snapshot.operation_id = Some(operation_id.clone());
                state.snapshot.phase = Some("reap".to_string());
                state.snapshot.server_state = ServerState::Stopping;
                state.snapshot.ownership = RuntimeOwnership::ManagedChild;
                let Some(process) = state.process.take() else {
                    state.operation = None;
                    state.snapshot.phase = None;
                    return;
                };
                (operation_id, child_exited, process)
            };
            let (operation_id, child_exited, mut process) = observation;
            let cleaned = stop_managed_process(&mut process, &manager.settings);
            let version = process.version.clone();
            let mut state = manager.lock();
            if state
                .operation
                .as_ref()
                .is_some_and(|operation| operation.id == operation_id)
            {
                state.operation = None;
            }
            state.snapshot.phase = None;
            if cleaned {
                state.active_versions.remove(&version);
                state.snapshot.state =
                    install_state_from_versions(&state.snapshot.installed_versions);
                state.snapshot.server_state = ServerState::Failed;
                state.snapshot.ownership = RuntimeOwnership::None;
                state.snapshot.model_count = None;
                state.snapshot.error = Some(RuntimeError::new(
                    if child_exited {
                        RuntimeErrorCode::ProcessExited
                    } else {
                        RuntimeErrorCode::StopFailed
                    },
                    "monitor",
                    true,
                ));
            } else {
                state.active_versions.insert(version);
                state.process = Some(process);
                state.snapshot.server_state = ServerState::Failed;
                state.snapshot.ownership = RuntimeOwnership::ManagedChild;
                state.snapshot.model_count = None;
                state.snapshot.error = Some(RuntimeError::new(
                    RuntimeErrorCode::StopFailed,
                    "monitor",
                    true,
                ));
            }
            let snapshot = state.snapshot.clone();
            drop(state);
            emit_optional_snapshot(app.as_ref(), &snapshot);
            return;
        })
}

fn dispatch_start(
    manager: &RuntimeManager,
    app: Option<AppHandle>,
    host: Option<String>,
    device_id: Option<String>,
) -> Result<String, RuntimeError> {
    log_ollama_debug(
        "start.enter",
        None,
        &format!(
            "host_scope={} device_id_present={}",
            if host.as_deref().is_some_and(is_default_managed_host_value) || host.is_none() {
                "default_loopback"
            } else {
                "custom"
            },
            device_id.is_some()
        ),
    );
    let endpoint = parse_endpoint(host.as_deref(), &manager.settings.managed_base_url)?;
    log_ollama_debug(
        "start.endpoint_classified",
        None,
        &format!("host_scope={:?}", endpoint.scope),
    );
    match endpoint.scope {
        EndpointScope::ManagedDefault => {}
        EndpointScope::Loopback => {
            return Err(RuntimeError::new(
                RuntimeErrorCode::ManagedEndpointUnsupported,
                "endpoint",
                false,
            ));
        }
        EndpointScope::Remote => {
            return Err(RuntimeError::new(
                RuntimeErrorCode::HostNotAllowed,
                "endpoint",
                false,
            ));
        }
    }
    let pin = manager.release_pin()?;
    let (anchor, root) = manager.locations()?;
    let operation_id = next_operation_id();
    manager.begin(&operation_id, OperationKind::Start)?;
    log_ollama_debug(
        "start.operation_started",
        Some(&operation_id),
        "operation_guard=held",
    );
    emit_manager_snapshot(app.as_ref(), manager);
    let manager_worker = manager.clone();
    let operation_id_worker = operation_id.clone();
    let spawn = thread::Builder::new()
        .name("ollama-runtime-start".to_string())
        .spawn(move || {
            perform_start_operation(
                manager_worker,
                app,
                anchor,
                root,
                pin,
                endpoint,
                operation_id_worker,
            );
        });
    if spawn.is_err() {
        let error = RuntimeError::new(RuntimeErrorCode::SpawnFailed, "dispatch", true)
            .for_operation(&operation_id);
        manager.finish_failure(&operation_id, error.clone());
        log_ollama_debug(
            "start.dispatch_failed",
            Some(&operation_id),
            "error=spawn_failed",
        );
        emit_manager_snapshot(None, manager);
        return Err(error);
    }
    Ok(operation_id)
}

fn is_default_managed_host_value(host: &str) -> bool {
    is_default_managed_host(Some(host))
}

fn dispatch_stop(manager: &RuntimeManager, app: Option<AppHandle>) -> Result<String, RuntimeError> {
    log_ollama_debug("stop.enter", None, "managed_process_check=true");
    {
        let state = manager.lock();
        if state.operation.is_some() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::RuntimeBusy,
                "dispatch",
                true,
            ));
        }
        if state.process.is_none() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::NotManaged,
                "stop",
                false,
            ));
        }
    }
    let operation_id = next_operation_id();
    manager.begin(&operation_id, OperationKind::Stop)?;
    log_ollama_debug(
        "stop.operation_started",
        Some(&operation_id),
        "operation_guard=held ownership=managed_child",
    );
    emit_manager_snapshot(app.as_ref(), manager);
    let manager_worker = manager.clone();
    let operation_id_worker = operation_id.clone();
    let spawn = thread::Builder::new()
        .name("ollama-runtime-stop".to_string())
        .spawn(move || {
            let mut process = manager_worker.lock().process.take();
            let Some(mut process) = process.take() else {
                manager_worker.finish_failure(
                    &operation_id_worker,
                    RuntimeError::new(RuntimeErrorCode::NotManaged, "stop", false),
                );
                emit_manager_snapshot(app.as_ref(), &manager_worker);
                return;
            };
            let version = process.version.clone();
            if stop_managed_process(&mut process, &manager_worker.settings) {
                log_ollama_debug(
                    "stop.process_tree_reaped",
                    Some(&operation_id_worker),
                    &format!("version={version}"),
                );
                let snapshot = manager_worker.snapshot();
                manager_worker.lock().active_versions.remove(&version);
                manager_worker.finish_server_operation(
                    &operation_id_worker,
                    snapshot.installed_versions,
                    snapshot.installed_version,
                    ServerState::Stopped,
                    RuntimeOwnership::None,
                    None,
                    None,
                );
                drop(process);
            } else {
                log_ollama_debug(
                    "stop.process_tree_unconfirmed",
                    Some(&operation_id_worker),
                    &format!("version={version} error=stop_failed"),
                );
                let mut state = manager_worker.lock();
                state.process = Some(process);
                state.active_versions.insert(version);
                drop(state);
                manager_worker.finish_failure(
                    &operation_id_worker,
                    RuntimeError::new(RuntimeErrorCode::StopFailed, "stop", true),
                );
            }
            emit_manager_snapshot(app.as_ref(), &manager_worker);
        });
    if spawn.is_err() {
        let error = RuntimeError::new(RuntimeErrorCode::SpawnFailed, "dispatch", true)
            .for_operation(&operation_id);
        manager.finish_failure(&operation_id, error.clone());
        log_ollama_debug(
            "stop.dispatch_failed",
            Some(&operation_id),
            "error=spawn_failed",
        );
        emit_manager_snapshot(None, manager);
        return Err(error);
    }
    Ok(operation_id)
}

fn status_snapshot(
    manager: &RuntimeManager,
    host: Option<&str>,
) -> Result<RuntimeSnapshot, RuntimeError> {
    if let Some(snapshot) = manager.operation_snapshot() {
        return Ok(snapshot);
    }
    let endpoint = parse_endpoint(host, &manager.settings.managed_base_url)?;
    log_ollama_debug(
        "status.endpoint_classified",
        None,
        &format!("host_scope={:?}", endpoint.scope),
    );
    let process_state = if endpoint.scope == EndpointScope::ManagedDefault {
        let mut state = manager.lock();
        state.process.as_mut().map(|process| {
            (
                process.generation,
                process.version.clone(),
                process.child.has_exited(),
            )
        })
    } else {
        None
    };
    let probe_result = probe_ollama(&endpoint.url, manager.settings.request_timeout);
    let pin = manager.release_pin()?;
    let (anchor, root) = manager.locations()?;
    let operation_id = next_operation_id();
    let (versions, invalid) = current_installations(&anchor, &root, &pin, &operation_id)?;
    let mut snapshot = snapshot_from_installations(
        versions,
        invalid.then(|| RuntimeError::new(RuntimeErrorCode::NotManaged, "discover", false)),
    );

    let managed_version = if endpoint.scope == EndpointScope::ManagedDefault {
        match process_state {
            Some((_, _, Ok(true))) => {
                snapshot.server_state = ServerState::Failed;
                snapshot.ownership = RuntimeOwnership::ManagedChild;
                snapshot.error = Some(RuntimeError::new(
                    RuntimeErrorCode::ProcessExited,
                    "monitor",
                    true,
                ));
                return Ok(update_runtime_snapshot(manager, snapshot));
            }
            Some((_, version, Ok(false))) => Some(version),
            Some((_, _, Err(_))) => {
                snapshot.server_state = ServerState::Failed;
                snapshot.ownership = RuntimeOwnership::ManagedChild;
                snapshot.error = Some(RuntimeError::new(
                    RuntimeErrorCode::StopFailed,
                    "status",
                    true,
                ));
                return Ok(update_runtime_snapshot(manager, snapshot));
            }
            None => None,
        }
    } else {
        None
    };

    match probe_result {
        ProbeResult::Ready { model_count } => {
            snapshot.server_state = match endpoint.scope {
                EndpointScope::ManagedDefault if managed_version.is_some() => {
                    snapshot.ownership = RuntimeOwnership::ManagedChild;
                    ServerState::ReadyManaged
                }
                EndpointScope::ManagedDefault | EndpointScope::Loopback => {
                    snapshot.ownership = RuntimeOwnership::ExternalLocal;
                    ServerState::ConnectedUnreserved
                }
                EndpointScope::Remote => {
                    snapshot.ownership = RuntimeOwnership::Remote;
                    ServerState::ReadyRemote
                }
            };
            if managed_version.is_some() {
                snapshot.ownership = RuntimeOwnership::ManagedChild;
            }
            snapshot.model_count = Some(model_count);
        }
        ProbeResult::NotListening if endpoint.scope == EndpointScope::ManagedDefault => {
            if managed_version.is_some() {
                snapshot.server_state = ServerState::Failed;
                snapshot.ownership = RuntimeOwnership::ManagedChild;
                snapshot.error = Some(api_error("probe", true));
            } else {
                snapshot.server_state = if snapshot.state == RuntimeState::NotInstalled {
                    ServerState::NotInstalled
                } else {
                    ServerState::InstalledStopped
                };
            }
        }
        ProbeResult::NotListening | ProbeResult::ApiUnreachable => {
            snapshot.server_state = ServerState::ExternalUnavailable;
            snapshot.ownership = if managed_version.is_some() {
                RuntimeOwnership::ManagedChild
            } else {
                RuntimeOwnership::None
            };
            snapshot.error = Some(api_error("probe", true));
        }
    }
    if managed_version.is_some() && snapshot.server_state != ServerState::ReadyManaged {
        snapshot.server_state = ServerState::Failed;
        snapshot.ownership = RuntimeOwnership::ManagedChild;
    }
    Ok(update_runtime_snapshot(manager, snapshot))
}

fn shutdown_manager(manager: &RuntimeManager) {
    log_ollama_debug("shutdown.enter", None, "server_child_check=true");
    let mut process = {
        let mut state = manager.lock();
        state.shutdown_requested = true;
        state.operation = None;
        state.snapshot.phase = None;
        if state.process.is_some() {
            state.snapshot.server_state = ServerState::Stopping;
            state.snapshot.ownership = RuntimeOwnership::ManagedChild;
        }
        state.process.take()
    };
    let Some(mut process) = process.take() else {
        return;
    };
    let version = process.version.clone();
    if stop_managed_process(&mut process, &manager.settings) {
        log_ollama_debug(
            "shutdown.process_tree_reaped",
            None,
            "ownership=managed_child",
        );
        let mut state = manager.lock();
        state.active_versions.remove(&version);
        state.snapshot.state = install_state_from_versions(&state.snapshot.installed_versions);
        state.snapshot.server_state = ServerState::Stopped;
        state.snapshot.ownership = RuntimeOwnership::None;
        state.snapshot.model_count = None;
        state.snapshot.error = None;
    } else {
        log_ollama_debug(
            "shutdown.process_tree_unconfirmed",
            None,
            "error=stop_failed",
        );
        let mut state = manager.lock();
        state.active_versions.insert(version);
        state.process = Some(process);
        state.snapshot.server_state = ServerState::Failed;
        state.snapshot.ownership = RuntimeOwnership::ManagedChild;
        state.snapshot.error = Some(RuntimeError::new(
            RuntimeErrorCode::StopFailed,
            "shutdown",
            true,
        ));
    }
}

#[tauri::command]
pub(crate) fn ollama_runtime_status(
    host: Option<String>,
    app: AppHandle,
    manager: State<'_, RuntimeManager>,
) -> Result<RuntimeSnapshot, RuntimeError> {
    log::debug!("OllamaRuntime::status host_value_redacted=true");
    let snapshot = status_snapshot(&manager, host.as_deref())?;
    emit_snapshot(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub(crate) fn ollama_runtime_start(
    host: Option<String>,
    device_id: Option<String>,
    app: AppHandle,
    manager: State<'_, RuntimeManager>,
) -> Result<String, RuntimeError> {
    dispatch_start(&manager, Some(app), host, device_id)
}

#[tauri::command]
pub(crate) fn ollama_runtime_stop(
    app: AppHandle,
    manager: State<'_, RuntimeManager>,
) -> Result<String, RuntimeError> {
    dispatch_stop(&manager, Some(app))
}

impl RuntimeManager {
    pub(crate) fn shutdown(&self) {
        shutdown_manager(self);
    }
}

#[tauri::command]
pub(crate) fn ollama_runtime_remove(
    version: String,
    confirm: bool,
    app: AppHandle,
    manager: State<'_, RuntimeManager>,
) -> Result<String, RuntimeError> {
    validate_remove_request(&version, confirm)?;
    let pin = manager.release_pin()?;
    let (anchor, root) = runtime_locations()?;
    let operation_id = next_operation_id();
    manager.begin(&operation_id, OperationKind::Remove)?;
    let active = manager.in_use(&version);
    let app_worker = app.clone();
    let manager_worker = (*manager).clone();
    let worker_id = operation_id.clone();
    let spawn = std::thread::Builder::new()
        .name("ollama-remove-worker".to_string())
        .spawn(move || {
            let result = remove_installation(
                &anchor, &root, &version, pin.os, pin.arch, active, &worker_id,
            );
            match result {
                Ok(versions) => manager_worker.finish_success(&worker_id, versions, None),
                Err(error) => manager_worker.finish_failure(&worker_id, error),
            }
            emit_snapshot(&app_worker, &manager_worker.lock().snapshot.clone());
        });
    if spawn.is_err() {
        let error = RuntimeError::new(RuntimeErrorCode::NotManaged, "remove", true)
            .for_operation(&operation_id);
        manager.finish_failure(&operation_id, error.clone());
        emit_snapshot(&app, &manager.lock().snapshot.clone());
        return Err(error);
    }
    emit_snapshot(&app, &manager.lock().snapshot.clone());
    Ok(operation_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use zip::write::SimpleFileOptions;

    #[cfg(target_os = "linux")]
    static REAL_PROCESS_GROUP_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[cfg(target_os = "linux")]
    static FAKE_RUNTIME_CHILD_STOP_REQUESTED: AtomicBool = AtomicBool::new(false);

    struct FixtureDownloader {
        bytes: Vec<u8>,
        fail_after_partial_write: bool,
        calls: AtomicU64,
    }

    impl FixtureDownloader {
        fn succeeding(bytes: Vec<u8>) -> Self {
            Self {
                bytes,
                fail_after_partial_write: false,
                calls: AtomicU64::new(0),
            }
        }

        fn failing(bytes: Vec<u8>) -> Self {
            Self {
                bytes,
                fail_after_partial_write: true,
                calls: AtomicU64::new(0),
            }
        }
    }

    impl ArtifactDownloader for FixtureDownloader {
        fn download(
            &self,
            _url: &str,
            destination: &Path,
            expected_size: Option<u64>,
            operation_id: &str,
            progress: &mut dyn FnMut(u64, Option<u64>),
        ) -> Result<String, RuntimeError> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(destination)
                .map_err(|error| install_io_error(error, "download", operation_id))?;
            if self.fail_after_partial_write {
                let partial = self.bytes.len().min(8);
                file.write_all(&self.bytes[..partial])
                    .map_err(|error| install_io_error(error, "download", operation_id))?;
                progress(partial as u64, expected_size);
                return Err(
                    RuntimeError::new(RuntimeErrorCode::DownloadFailed, "download", true)
                        .for_operation(operation_id),
                );
            }
            if expected_size.is_some_and(|size| size != self.bytes.len() as u64) {
                return Err(
                    RuntimeError::new(RuntimeErrorCode::DownloadFailed, "download", true)
                        .for_operation(operation_id),
                );
            }
            file.write_all(&self.bytes)
                .map_err(|error| install_io_error(error, "download", operation_id))?;
            file.sync_all()
                .map_err(|error| install_io_error(error, "download", operation_id))?;
            progress(self.bytes.len() as u64, expected_size);
            Ok(hex_digest(Sha256::digest(&self.bytes).as_slice()))
        }
    }

    fn fixture_pin(format: ArchiveFormat, expected_sha256: &str, size: u64) -> ReleasePin {
        let mut pin = *RELEASE_PINS
            .iter()
            .find(|pin| {
                (format == ArchiveFormat::Zip && pin.os == TargetOs::Windows)
                    || (format == ArchiveFormat::TarZst && pin.os == TargetOs::Linux)
            })
            .unwrap();
        pin.sha256 = Some(Box::leak(expected_sha256.to_string().into_boxed_str()));
        pin.asset_size = size;
        pin
    }

    fn fixture_pin_for_bytes(format: ArchiveFormat, bytes: &[u8]) -> ReleasePin {
        let digest = hex_digest(Sha256::digest(bytes).as_slice());
        fixture_pin(format, &digest, bytes.len() as u64)
    }

    fn anchor_and_root() -> (tempfile::TempDir, PathBuf) {
        let anchor = tempfile::tempdir().unwrap();
        let root = anchor.path().join("naia-shell/runtimes/ollama");
        (anchor, root)
    }

    fn install_fixture(
        anchor: &Path,
        root: &Path,
        pin: &ReleasePin,
        bytes: Vec<u8>,
        operation_id: &str,
    ) -> Result<InstalledRuntime, RuntimeError> {
        let downloader = FixtureDownloader::succeeding(bytes);
        install_release(anchor, root, pin, &downloader, operation_id, |_, _, _| {})
    }

    fn zip_fixture(entries: &[(&str, &[u8], u32)]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes, mode) in entries {
            let options = SimpleFileOptions::default().unix_permissions(*mode);
            writer.start_file(name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn tar_zst_regular(path: &str, bytes: &[u8]) -> Vec<u8> {
        let encoder = zstd::stream::write::Encoder::new(Vec::new(), 1).unwrap();
        let mut builder = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        builder.append_data(&mut header, path, bytes).unwrap();
        builder.into_inner().unwrap().finish().unwrap()
    }

    fn tar_zst_link(path: &str, target: &str) -> Vec<u8> {
        let encoder = zstd::stream::write::Encoder::new(Vec::new(), 1).unwrap();
        let mut builder = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_mode(0o777);
        header.set_cksum();
        builder.append_link(&mut header, path, target).unwrap();
        builder.into_inner().unwrap().finish().unwrap()
    }

    fn tar_zst_with_unsafe_path(path: &str, bytes: &[u8]) -> Vec<u8> {
        assert!(path.len() < 100);
        let compressed = tar_zst_regular("safe", bytes);
        let mut archive = Vec::new();
        zstd::stream::read::Decoder::new(Cursor::new(compressed))
            .unwrap()
            .read_to_end(&mut archive)
            .unwrap();
        archive[..100].fill(0);
        archive[..path.len()].copy_from_slice(path.as_bytes());
        archive[148..156].fill(b' ');
        let checksum = archive[..512]
            .iter()
            .map(|byte| u64::from(*byte))
            .sum::<u64>();
        let encoded_checksum = format!("{checksum:06o}\0 ");
        assert_eq!(encoded_checksum.len(), 8);
        archive[148..156].copy_from_slice(encoded_checksum.as_bytes());
        zstd::stream::encode_all(Cursor::new(archive), 1).unwrap()
    }

    fn write_managed_fixture(
        root: &Path,
        version: &str,
        os: TargetOs,
        arch: TargetArch,
        executable_bytes: &[u8],
    ) {
        let (asset_name, executable_relative_path) = expected_asset(os, arch);
        let version_dir = root.join(version);
        let executable = version_dir.join(executable_relative_path);
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::write(&executable, executable_bytes).unwrap();
        let manifest = InstallManifest {
            schema_version: 1,
            version: version.to_string(),
            target_os: os.as_str().to_string(),
            target_arch: arch.as_str().to_string(),
            asset_name: asset_name.to_string(),
            download_url: format!("{RELEASE_BASE}/v{version}/{asset_name}"),
            integrity_kind: INTEGRITY_KIND.to_string(),
            integrity_source: format!("{RELEASE_BASE}/v{version}/sha256sum.txt"),
            archive_sha256: "a".repeat(64),
            integrity_verified: true,
            executable_relative_path: executable_relative_path.to_string(),
            executable_sha256: hex_digest(Sha256::digest(executable_bytes).as_slice()),
            installed_at_unix_seconds: 1,
        };
        fs::write(
            version_dir.join(MANIFEST_FILE),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
    }

    fn count_staging_dirs(root: &Path) -> usize {
        fs::read_dir(root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".ollama-install-")
            })
            .count()
    }

    #[derive(Clone)]
    struct ApiFixture {
        tags_status: u16,
        tags_body: Vec<u8>,
        version_status: u16,
        version_body: Vec<u8>,
        delay: Duration,
    }

    impl ApiFixture {
        fn ready(model_count: usize) -> Self {
            let models = std::iter::repeat("{}")
                .take(model_count)
                .collect::<Vec<_>>()
                .join(",");
            Self {
                tags_status: 200,
                tags_body: format!("{{\"models\":[{models}]}}").into_bytes(),
                version_status: 200,
                version_body: br#"{"version":"fixture"}"#.to_vec(),
                delay: Duration::ZERO,
            }
        }

        fn malformed() -> Self {
            Self {
                tags_body: b"{\"models\":".to_vec(),
                ..Self::ready(0)
            }
        }

        fn status(status: u16) -> Self {
            Self {
                tags_status: status,
                ..Self::ready(0)
            }
        }
    }

    struct TestApiServer {
        address: std::net::SocketAddr,
        stopped: Arc<AtomicBool>,
        worker: Option<thread::JoinHandle<()>>,
    }

    impl TestApiServer {
        fn bind(address: impl std::net::ToSocketAddrs, fixture: ApiFixture) -> io::Result<Self> {
            let listener = std::net::TcpListener::bind(address)?;
            listener.set_nonblocking(true)?;
            let address = listener.local_addr()?;
            let stopped = Arc::new(AtomicBool::new(false));
            let worker_stopped = stopped.clone();
            let worker = thread::spawn(move || {
                while !worker_stopped.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((mut stream, _)) => serve_fixture_request(&mut stream, &fixture),
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(2));
                        }
                        Err(_) => break,
                    }
                }
            });
            Ok(Self {
                address,
                stopped,
                worker: Some(worker),
            })
        }

        fn base_url(&self) -> String {
            format!("http://{}", self.address)
        }

        fn stop(&self) {
            self.stopped.store(true, Ordering::Release);
        }
    }

    impl Drop for TestApiServer {
        fn drop(&mut self) {
            self.stop();
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }

    fn serve_fixture_request(stream: &mut std::net::TcpStream, fixture: &ApiFixture) {
        let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
        let mut request = [0_u8; 2048];
        let Ok(read) = stream.read(&mut request) else {
            return;
        };
        let request = String::from_utf8_lossy(&request[..read]);
        let path = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or_default();
        let (status, body) = if path.ends_with("/api/tags") {
            (fixture.tags_status, fixture.tags_body.as_slice())
        } else if path.ends_with("/api/version") {
            (fixture.version_status, fixture.version_body.as_slice())
        } else {
            (404, b"{}".as_slice())
        };
        if !fixture.delay.is_zero() {
            thread::sleep(fixture.delay);
        }
        let reason = if status == 200 { "OK" } else { "Fixture" };
        let header = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(header.as_bytes());
        let _ = stream.write_all(body);
    }

    #[cfg(target_os = "linux")]
    extern "C" fn fake_runtime_child_term_handler(_: libc::c_int) {
        FAKE_RUNTIME_CHILD_STOP_REQUESTED.store(true, Ordering::Release);
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "spawned only as a fixture executable by process ownership tests"]
    fn fake_managed_ollama_process_entry() {
        let (Ok(port), Ok(mode), Ok(pid_file), Ok(reaped_file)) = (
            std::env::var("NAIA_SHELL_FAKE_OLLAMA_PORT"),
            std::env::var("NAIA_SHELL_FAKE_OLLAMA_MODE"),
            std::env::var("NAIA_SHELL_FAKE_OLLAMA_PID_FILE"),
            std::env::var("NAIA_SHELL_FAKE_OLLAMA_REAPED_FILE"),
        ) else {
            return;
        };
        FAKE_RUNTIME_CHILD_STOP_REQUESTED.store(false, Ordering::Release);
        let previous = unsafe {
            libc::signal(
                libc::SIGTERM,
                fake_runtime_child_term_handler as *const () as libc::sighandler_t,
            )
        };
        assert_ne!(previous, libc::SIG_ERR);

        let mut descendant = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        fs::write(pid_file, descendant.id().to_string()).unwrap();
        let fixture = if mode == "unready" {
            ApiFixture::status(503)
        } else {
            ApiFixture::ready(0)
        };
        let server =
            TestApiServer::bind(("127.0.0.1", port.parse::<u16>().unwrap()), fixture).unwrap();
        while !FAKE_RUNTIME_CHILD_STOP_REQUESTED.load(Ordering::Acquire) {
            thread::sleep(Duration::from_millis(2));
        }
        drop(server);
        let _ = descendant.wait().unwrap();
        fs::write(reaped_file, b"descendant reaped").unwrap();
    }

    #[cfg(target_os = "linux")]
    fn shell_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }

    #[cfg(target_os = "linux")]
    fn write_fake_executable_install(
        root: &Path,
        pin: ReleasePin,
        port: u16,
        mode: &str,
        pid_file: &Path,
        reaped_file: &Path,
    ) {
        use std::os::unix::fs::PermissionsExt;

        let current_exe = std::env::current_exe().unwrap();
        let script = format!(
            "#!/bin/sh\nexport NAIA_SHELL_FAKE_OLLAMA_PORT={}\nexport NAIA_SHELL_FAKE_OLLAMA_MODE={}\nexport NAIA_SHELL_FAKE_OLLAMA_PID_FILE={}\nexport NAIA_SHELL_FAKE_OLLAMA_REAPED_FILE={}\nexec {} --exact ollama_runtime::tests::fake_managed_ollama_process_entry --ignored --nocapture\n",
            shell_quote(&port.to_string()),
            shell_quote(mode),
            shell_quote(&pid_file.to_string_lossy()),
            shell_quote(&reaped_file.to_string_lossy()),
            shell_quote(&current_exe.to_string_lossy()),
        );
        write_managed_fixture(root, pin.version, pin.os, pin.arch, script.as_bytes());
        let (_, executable_relative_path) = expected_asset(pin.os, pin.arch);
        let executable = root.join(pin.version).join(executable_relative_path);
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(target_os = "linux")]
    fn real_process_manager(
        anchor: &tempfile::TempDir,
        root: &Path,
        port: u16,
        pin: ReleasePin,
    ) -> RuntimeManager {
        RuntimeManager {
            inner: Arc::new(Mutex::new(ManagerState::default())),
            downloader: Arc::new(FixtureDownloader::succeeding(Vec::new())),
            process_runner: Arc::new(SystemProcessRunner),
            settings: RuntimeSettings {
                managed_base_url: format!("http://127.0.0.1:{port}"),
                request_timeout: Duration::from_millis(30),
                readiness_timeout: Duration::from_secs(2),
                poll_interval: Duration::from_millis(5),
                graceful_stop_timeout: Duration::from_millis(500),
                force_stop_timeout: Duration::from_millis(500),
            },
            locations: Some((anchor.path().to_path_buf(), root.to_path_buf())),
            release_pin: Some(pin),
        }
    }

    #[cfg(target_os = "linux")]
    fn wait_for_fixture_reap_marker(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !path.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(path.exists(), "fake executable did not reap its descendant");
    }

    struct FakeProcessState {
        spawned: AtomicUsize,
        captured_spec: Mutex<Option<ProcessSpec>>,
        exited: AtomicBool,
        descendants_alive: AtomicBool,
        graceful_calls: AtomicUsize,
        force_calls: AtomicUsize,
        graceful_exits: AtomicBool,
        graceful_reaps_descendants: AtomicBool,
        force_reaps: AtomicBool,
        listener: Mutex<Option<TestApiServer>>,
        shutdown_manager_on_spawn: Mutex<Option<RuntimeManager>>,
    }

    impl FakeProcessState {
        fn new() -> Self {
            Self {
                spawned: AtomicUsize::new(0),
                captured_spec: Mutex::new(None),
                exited: AtomicBool::new(false),
                descendants_alive: AtomicBool::new(false),
                graceful_calls: AtomicUsize::new(0),
                force_calls: AtomicUsize::new(0),
                graceful_exits: AtomicBool::new(true),
                graceful_reaps_descendants: AtomicBool::new(true),
                force_reaps: AtomicBool::new(true),
                listener: Mutex::new(None),
                shutdown_manager_on_spawn: Mutex::new(None),
            }
        }

        fn stop_listener(&self) {
            if let Some(listener) = self.listener.lock().unwrap().as_ref() {
                listener.stop();
            }
        }

        fn simulate_exit(&self) {
            self.exited.store(true, Ordering::Release);
            self.descendants_alive.store(false, Ordering::Release);
            self.stop_listener();
        }
    }

    struct FakeRunner {
        state: Arc<FakeProcessState>,
        api: Option<ApiFixture>,
        exit_immediately: bool,
    }

    impl FakeRunner {
        fn new(api: Option<ApiFixture>) -> Arc<Self> {
            Arc::new(Self {
                state: Arc::new(FakeProcessState::new()),
                api,
                exit_immediately: false,
            })
        }

        fn exits_immediately() -> Arc<Self> {
            Arc::new(Self {
                state: Arc::new(FakeProcessState::new()),
                api: None,
                exit_immediately: true,
            })
        }

        fn loses_bind_race(api: ApiFixture) -> Arc<Self> {
            Arc::new(Self {
                state: Arc::new(FakeProcessState::new()),
                api: Some(api),
                exit_immediately: true,
            })
        }
    }

    impl RuntimeProcessRunner for FakeRunner {
        fn spawn(&self, spec: &ProcessSpec) -> io::Result<Box<dyn ManagedChild>> {
            self.state.spawned.fetch_add(1, Ordering::Relaxed);
            *self.state.captured_spec.lock().unwrap() = Some(spec.clone());
            if let Some(manager) = self.state.shutdown_manager_on_spawn.lock().unwrap().take() {
                manager.shutdown();
            }
            if let Some(api) = self.api.clone() {
                let host = spec
                    .environment
                    .get(&std::ffi::OsString::from("OLLAMA_HOST"))
                    .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing host"))?;
                let address = host
                    .to_string_lossy()
                    .parse::<std::net::SocketAddr>()
                    .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid host"))?;
                let server = TestApiServer::bind(address, api)?;
                *self.state.listener.lock().unwrap() = Some(server);
            }
            if self.exit_immediately {
                self.state.exited.store(true, Ordering::Release);
            }
            Ok(Box::new(FakeChild {
                state: self.state.clone(),
            }))
        }
    }

    struct FakeChild {
        state: Arc<FakeProcessState>,
    }

    impl ManagedChild for FakeChild {
        fn has_exited(&mut self) -> io::Result<bool> {
            Ok(self.state.exited.load(Ordering::Acquire))
        }

        fn reap_exited_leader(&mut self) -> io::Result<()> {
            if self.state.exited.load(Ordering::Acquire) {
                Ok(())
            } else {
                Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "cannot reap a running fake child",
                ))
            }
        }

        fn request_graceful_shutdown(&mut self) -> io::Result<()> {
            self.state.graceful_calls.fetch_add(1, Ordering::Relaxed);
            self.state.stop_listener();
            if self.state.graceful_exits.load(Ordering::Acquire) {
                self.state.exited.store(true, Ordering::Release);
                self.state.descendants_alive.store(
                    !self
                        .state
                        .graceful_reaps_descendants
                        .load(Ordering::Acquire),
                    Ordering::Release,
                );
            }
            Ok(())
        }

        fn force_kill_tree(&mut self) -> io::Result<()> {
            self.state.force_calls.fetch_add(1, Ordering::Relaxed);
            self.state.stop_listener();
            if self.state.force_reaps.load(Ordering::Acquire) {
                self.state.exited.store(true, Ordering::Release);
                self.state.descendants_alive.store(false, Ordering::Release);
            }
            Ok(())
        }

        fn process_tree_alive(&mut self) -> io::Result<bool> {
            Ok(!self.state.exited.load(Ordering::Acquire)
                || self.state.descendants_alive.load(Ordering::Acquire))
        }
    }

    fn test_settings(port: u16) -> RuntimeSettings {
        RuntimeSettings {
            managed_base_url: format!("http://127.0.0.1:{port}"),
            request_timeout: Duration::from_millis(30),
            readiness_timeout: Duration::from_millis(160),
            poll_interval: Duration::from_millis(3),
            graceful_stop_timeout: Duration::from_millis(12),
            force_stop_timeout: Duration::from_millis(12),
        }
    }

    fn test_manager(
        anchor: &tempfile::TempDir,
        root: &Path,
        port: u16,
        runner: &Arc<FakeRunner>,
        pin: ReleasePin,
        downloader: Arc<dyn ArtifactDownloader>,
        installed: bool,
    ) -> RuntimeManager {
        if installed {
            write_managed_fixture(
                root,
                pin.version,
                pin.os,
                pin.arch,
                b"fixture executable; injected runner never executes this file",
            );
        }
        RuntimeManager {
            inner: Arc::new(Mutex::new(ManagerState::default())),
            downloader,
            process_runner: runner.clone(),
            settings: test_settings(port),
            locations: Some((anchor.path().to_path_buf(), root.to_path_buf())),
            release_pin: Some(pin),
        }
    }

    fn wait_for_snapshot(
        manager: &RuntimeManager,
        timeout: Duration,
        predicate: impl Fn(&RuntimeSnapshot) -> bool,
    ) -> RuntimeSnapshot {
        let deadline = Instant::now() + timeout;
        loop {
            let snapshot = manager.snapshot();
            if predicate(&snapshot) {
                return snapshot;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for runtime snapshot"
            );
            thread::sleep(Duration::from_millis(3));
        }
    }

    fn wait_for_operation(manager: &RuntimeManager, operation_id: &str) -> RuntimeSnapshot {
        wait_for_snapshot(manager, Duration::from_secs(2), |snapshot| {
            snapshot.operation_id.as_deref() == Some(operation_id) && snapshot.phase.is_none()
        })
    }

    fn make_test_root(anchor: &tempfile::TempDir) -> PathBuf {
        anchor.path().join("runtime-root")
    }

    #[test]
    fn start_uses_verified_executable_serve_and_child_only_loopback_host() {
        let api = ApiFixture::ready(2);
        let runner = FakeRunner::new(Some(api.clone()));
        let anchor = tempfile::tempdir().unwrap();
        let root = make_test_root(&anchor);
        let pin = *release_pin("linux", "x86_64").unwrap();
        let address = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        let manager = test_manager(
            &anchor,
            &root,
            address.port(),
            &runner,
            pin,
            Arc::new(FixtureDownloader::succeeding(Vec::new())),
            true,
        );

        let operation =
            dispatch_start(&manager, None, None, Some("device-is-ignored".into())).unwrap();
        let snapshot = wait_for_operation(&manager, &operation);
        assert_eq!(snapshot.server_state, ServerState::ReadyManaged);
        assert_eq!(snapshot.ownership, RuntimeOwnership::ManagedChild);
        assert_eq!(snapshot.model_count, Some(2));
        assert_eq!(snapshot.state, RuntimeState::InstalledStopped);
        let spec = runner.state.captured_spec.lock().unwrap().clone().unwrap();
        assert_eq!(
            spec.executable,
            root.join(pin.version).join(pin.executable_relative_path)
        );
        assert_eq!(spec.arguments, vec!["serve"]);
        assert!(spec.inherit_environment);
        assert_eq!(
            spec.environment
                .get(&std::ffi::OsString::from("OLLAMA_HOST"))
                .unwrap(),
            &std::ffi::OsString::from(format!("127.0.0.1:{}", address.port()))
        );
        assert!(!spec
            .environment
            .contains_key(&std::ffi::OsString::from("OLLAMA_MODELS")));
        assert_eq!(runner.state.spawned.load(Ordering::Relaxed), 1);
        let serialized = serde_json::to_string(&snapshot).unwrap();
        assert!(!serialized.contains(&root.to_string_lossy().to_string()));
        assert!(!serialized.contains(&manager.settings.managed_base_url));
        assert!(!serialized.to_ascii_lowercase().contains("pid"));
        manager.shutdown();

        let version_server = TestApiServer::bind("127.0.0.1:0", api).unwrap();
        let client = reqwest::blocking::Client::new();
        let version: serde_json::Value = client
            .get(format!("{}/api/version", version_server.base_url()))
            .send()
            .unwrap()
            .json()
            .unwrap();
        assert_eq!(version["version"], "fixture");
        assert_eq!(
            RuntimeSettings::default().managed_base_url,
            "http://localhost:11434"
        );
    }

    #[test]
    fn missing_install_uses_fixture_archive_and_empty_models_are_ready() {
        let bytes = tar_zst_regular("bin/ollama", b"fixture executable; never launched directly");
        let pin = fixture_pin_for_bytes(ArchiveFormat::TarZst, &bytes);
        let runner = FakeRunner::new(Some(ApiFixture::ready(0)));
        let anchor = tempfile::tempdir().unwrap();
        let root = make_test_root(&anchor);
        let address = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        let manager = test_manager(
            &anchor,
            &root,
            address.port(),
            &runner,
            pin,
            Arc::new(FixtureDownloader::succeeding(bytes)),
            false,
        );
        let operation = dispatch_start(&manager, None, None, None).unwrap();
        let snapshot = wait_for_operation(&manager, &operation);
        assert_eq!(snapshot.server_state, ServerState::ReadyManaged);
        assert_eq!(snapshot.model_count, Some(0));
        assert!(root.join(pin.version).join(MANIFEST_FILE).is_file());
        let spec = runner.state.captured_spec.lock().unwrap().clone().unwrap();
        assert_eq!(spec.executable, root.join(pin.version).join("bin/ollama"));
        manager.shutdown();
    }

    #[test]
    fn api_probe_requires_200_and_an_object_with_a_models_array() {
        let wrong_shape = ApiFixture {
            tags_body: br#"{"models":{}}"#.to_vec(),
            ..ApiFixture::ready(0)
        };
        for fixture in [
            ApiFixture::malformed(),
            wrong_shape,
            ApiFixture::status(503),
        ] {
            let server = TestApiServer::bind("127.0.0.1:0", fixture).unwrap();
            let endpoint = url::Url::parse(&server.base_url()).unwrap();
            assert_eq!(
                probe_ollama(&endpoint, Duration::from_millis(80)),
                ProbeResult::ApiUnreachable
            );
        }
        let mut slow = ApiFixture::ready(0);
        slow.delay = Duration::from_millis(60);
        let server = TestApiServer::bind("127.0.0.1:0", slow).unwrap();
        assert_eq!(
            probe_ollama(
                &url::Url::parse(&server.base_url()).unwrap(),
                Duration::from_millis(5)
            ),
            ProbeResult::ApiUnreachable
        );
    }

    #[test]
    fn external_and_custom_loopback_servers_are_observed_but_never_owned() {
        let external = TestApiServer::bind("127.0.0.1:0", ApiFixture::ready(1)).unwrap();
        let port = external.address.port();
        let runner = FakeRunner::new(Some(ApiFixture::ready(0)));
        let anchor = tempfile::tempdir().unwrap();
        let root = make_test_root(&anchor);
        let pin = *release_pin("linux", "x86_64").unwrap();
        let manager = test_manager(
            &anchor,
            &root,
            port,
            &runner,
            pin,
            Arc::new(FixtureDownloader::succeeding(Vec::new())),
            true,
        );
        let operation = dispatch_start(&manager, None, None, None).unwrap();
        let started = wait_for_operation(&manager, &operation);
        assert_eq!(started.server_state, ServerState::ConnectedUnreserved);
        assert_eq!(started.ownership, RuntimeOwnership::ExternalLocal);
        assert_eq!(runner.state.spawned.load(Ordering::Relaxed), 0);
        let custom = external.base_url();
        assert_eq!(
            dispatch_start(&manager, None, Some(custom.clone()), None)
                .unwrap_err()
                .code,
            RuntimeErrorCode::ManagedEndpointUnsupported
        );
        let status = status_snapshot(&manager, Some(&custom)).unwrap();
        assert_eq!(status.server_state, ServerState::ConnectedUnreserved);
        assert_eq!(status.ownership, RuntimeOwnership::ExternalLocal);
        let unused = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let unavailable = format!("http://{}", unused.local_addr().unwrap());
        drop(unused);
        assert_eq!(
            status_snapshot(&manager, Some(&unavailable))
                .unwrap()
                .server_state,
            ServerState::ExternalUnavailable
        );
        assert_eq!(
            dispatch_stop(&manager, None).unwrap_err().code,
            RuntimeErrorCode::NotManaged
        );
        assert_eq!(
            probe_ollama(
                &url::Url::parse(&custom).unwrap(),
                Duration::from_millis(80)
            ),
            ProbeResult::Ready { model_count: 1 }
        );
        assert_eq!(runner.state.graceful_calls.load(Ordering::Relaxed), 0);
        assert_eq!(runner.state.force_calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn invalid_listener_and_remote_management_requests_do_not_spawn_or_signal() {
        let listener = TestApiServer::bind("127.0.0.1:0", ApiFixture::status(404)).unwrap();
        let runner = FakeRunner::new(Some(ApiFixture::ready(0)));
        let anchor = tempfile::tempdir().unwrap();
        let root = make_test_root(&anchor);
        let pin = *release_pin("linux", "x86_64").unwrap();
        let manager = test_manager(
            &anchor,
            &root,
            listener.address.port(),
            &runner,
            pin,
            Arc::new(FixtureDownloader::succeeding(Vec::new())),
            false,
        );
        let operation = dispatch_start(&manager, None, None, None).unwrap();
        let snapshot = wait_for_operation(&manager, &operation);
        assert_eq!(
            snapshot.error.unwrap().code,
            RuntimeErrorCode::ApiUnreachable
        );
        let snapshot_json = serde_json::to_string(&manager.snapshot()).unwrap();
        assert!(!snapshot_json.contains(&manager.settings.managed_base_url));
        assert!(!snapshot_json.contains(&root.to_string_lossy().to_string()));
        assert_eq!(runner.state.spawned.load(Ordering::Relaxed), 0);
        assert_eq!(
            dispatch_start(
                &manager,
                None,
                Some("https://example.com:11434".into()),
                None
            )
            .unwrap_err()
            .code,
            RuntimeErrorCode::HostNotAllowed
        );
        assert_eq!(runner.state.graceful_calls.load(Ordering::Relaxed), 0);
        assert_eq!(runner.state.force_calls.load(Ordering::Relaxed), 0);
        assert_eq!(
            probe_ollama(
                &url::Url::parse(&listener.base_url()).unwrap(),
                Duration::from_millis(80)
            ),
            ProbeResult::ApiUnreachable
        );
    }

    #[test]
    fn readiness_timeout_and_early_exit_reap_only_the_spawned_child() {
        let runner = FakeRunner::new(Some(ApiFixture::status(503)));
        let anchor = tempfile::tempdir().unwrap();
        let root = make_test_root(&anchor);
        let pin = *release_pin("linux", "x86_64").unwrap();
        let address = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        let mut manager = test_manager(
            &anchor,
            &root,
            address.port(),
            &runner,
            pin,
            Arc::new(FixtureDownloader::succeeding(Vec::new())),
            true,
        );
        manager.settings.readiness_timeout = Duration::from_millis(35);
        manager.settings.request_timeout = Duration::from_millis(8);
        let operation = dispatch_start(&manager, None, None, None).unwrap();
        let snapshot = wait_for_operation(&manager, &operation);
        assert_eq!(
            snapshot.error.unwrap().code,
            RuntimeErrorCode::ReadinessTimeout
        );
        assert_eq!(runner.state.graceful_calls.load(Ordering::Relaxed), 1);
        assert!(runner.state.exited.load(Ordering::Acquire));
        assert!(!runner.state.descendants_alive.load(Ordering::Acquire));
        assert!(manager.lock().process.is_none());

        let immediate = FakeRunner::exits_immediately();
        let anchor = tempfile::tempdir().unwrap();
        let root = make_test_root(&anchor);
        let pin = *release_pin("linux", "x86_64").unwrap();
        let address = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        let manager = test_manager(
            &anchor,
            &root,
            address.port(),
            &immediate,
            pin,
            Arc::new(FixtureDownloader::succeeding(Vec::new())),
            true,
        );
        let operation = dispatch_start(&manager, None, None, None).unwrap();
        let snapshot = wait_for_operation(&manager, &operation);
        let error = snapshot.error.unwrap();
        assert_eq!(error.code, RuntimeErrorCode::ProcessExited);
        assert_eq!(error.stage, "bind");
        assert!(manager.lock().process.is_none());

        let race = FakeRunner::loses_bind_race(ApiFixture::ready(0));
        let anchor = tempfile::tempdir().unwrap();
        let root = make_test_root(&anchor);
        let pin = *release_pin("linux", "x86_64").unwrap();
        let address = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        let manager = test_manager(
            &anchor,
            &root,
            address.port(),
            &race,
            pin,
            Arc::new(FixtureDownloader::succeeding(Vec::new())),
            true,
        );
        let operation = dispatch_start(&manager, None, None, None).unwrap();
        let snapshot = wait_for_operation(&manager, &operation);
        let error = snapshot.error.unwrap();
        assert_eq!(error.code, RuntimeErrorCode::ProcessExited);
        assert_eq!(error.stage, "bind");
        assert_eq!(race.state.graceful_calls.load(Ordering::Relaxed), 0);
        assert_eq!(race.state.force_calls.load(Ordering::Relaxed), 0);
        assert_eq!(
            probe_ollama(
                &url::Url::parse(&manager.settings.managed_base_url).unwrap(),
                Duration::from_millis(80)
            ),
            ProbeResult::Ready { model_count: 0 }
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn preparation_failure_cleans_fake_process_group_once_and_reaps_descendant() {
        let _guard = REAL_PROCESS_GROUP_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        PROCESS_GROUP_SIGTERM_ATTEMPTS.store(0, Ordering::Relaxed);
        PROCESS_GROUP_SIGKILL_ATTEMPTS.store(0, Ordering::Relaxed);

        let anchor = tempfile::tempdir().unwrap();
        let root = make_test_root(&anchor);
        let pin = *release_pin("linux", "x86_64").unwrap();
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let pid_file = anchor.path().join("fake-child.pid");
        let reaped_file = anchor.path().join("fake-child-reaped");
        write_fake_executable_install(&root, pin, port, "unready", &pid_file, &reaped_file);
        let mut manager = real_process_manager(&anchor, &root, port, pin);
        manager.settings.readiness_timeout = Duration::from_secs(1);

        let operation = dispatch_start(&manager, None, None, None).unwrap();
        let snapshot = wait_for_operation(&manager, &operation);
        assert_eq!(
            snapshot.error.unwrap().code,
            RuntimeErrorCode::ReadinessTimeout
        );
        wait_for_fixture_reap_marker(&reaped_file);
        assert!(pid_file.exists());
        assert!(manager.lock().process.is_none());
        assert_eq!(
            PROCESS_GROUP_SIGTERM_ATTEMPTS.load(Ordering::Relaxed),
            1,
            "preparation failure must request cleanup exactly once"
        );
        assert_eq!(
            PROCESS_GROUP_SIGKILL_ATTEMPTS.load(Ordering::Relaxed),
            0,
            "the fake server handles graceful shutdown and needs no forced signal"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn normal_stop_reaps_fake_descendant_and_drop_sends_no_second_signal() {
        let _guard = REAL_PROCESS_GROUP_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        PROCESS_GROUP_SIGTERM_ATTEMPTS.store(0, Ordering::Relaxed);
        PROCESS_GROUP_SIGKILL_ATTEMPTS.store(0, Ordering::Relaxed);

        let anchor = tempfile::tempdir().unwrap();
        let root = make_test_root(&anchor);
        let pin = *release_pin("linux", "x86_64").unwrap();
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let pid_file = anchor.path().join("fake-child.pid");
        let reaped_file = anchor.path().join("fake-child-reaped");
        write_fake_executable_install(&root, pin, port, "ready", &pid_file, &reaped_file);
        let manager = real_process_manager(&anchor, &root, port, pin);

        let start = dispatch_start(&manager, None, None, None).unwrap();
        assert_eq!(
            wait_for_operation(&manager, &start).server_state,
            ServerState::ReadyManaged
        );
        assert!(pid_file.exists());
        let stop = dispatch_stop(&manager, None).unwrap();
        assert_eq!(
            wait_for_operation(&manager, &stop).server_state,
            ServerState::Stopped
        );
        wait_for_fixture_reap_marker(&reaped_file);
        // Let the worker finish dropping its already-reaped OwnedChild.
        thread::sleep(Duration::from_millis(20));
        assert!(manager.lock().process.is_none());
        assert_eq!(
            PROCESS_GROUP_SIGTERM_ATTEMPTS.load(Ordering::Relaxed),
            1,
            "dropping a normally stopped child must not signal its old PGID"
        );
        assert_eq!(PROCESS_GROUP_SIGKILL_ATTEMPTS.load(Ordering::Relaxed), 0);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn dropping_reaped_child_does_not_signal_a_reused_process_group() {
        use std::os::unix::process::CommandExt;

        let _guard = REAL_PROCESS_GROUP_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        PROCESS_GROUP_SIGTERM_ATTEMPTS.store(0, Ordering::Relaxed);
        PROCESS_GROUP_SIGKILL_ATTEMPTS.store(0, Ordering::Relaxed);

        let mut unrelated = Command::new("/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        let mut child = Command::new("/bin/true").spawn().unwrap();
        child.wait().unwrap();
        let reused_group = unrelated.id() as libc::pid_t;
        drop(OwnedChild {
            child,
            ownership: ChildOwnership {
                process_group: reused_group,
            },
            reaped: true,
        });

        let survived = unrelated.try_wait().unwrap().is_none();
        if survived {
            unrelated.kill().unwrap();
            unrelated.wait().unwrap();
        }
        assert!(
            survived,
            "the unrelated process group received a stale signal"
        );
        assert_eq!(PROCESS_GROUP_SIGTERM_ATTEMPTS.load(Ordering::Relaxed), 0);
        assert_eq!(PROCESS_GROUP_SIGKILL_ATTEMPTS.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn repeated_start_and_unexpected_exit_preserve_single_child_ownership() {
        let runner = FakeRunner::new(Some(ApiFixture::ready(1)));
        let anchor = tempfile::tempdir().unwrap();
        let root = make_test_root(&anchor);
        let pin = *release_pin("linux", "x86_64").unwrap();
        let address = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        let manager = test_manager(
            &anchor,
            &root,
            address.port(),
            &runner,
            pin,
            Arc::new(FixtureDownloader::succeeding(Vec::new())),
            true,
        );
        let first = dispatch_start(&manager, None, None, None).unwrap();
        assert_eq!(
            wait_for_operation(&manager, &first).server_state,
            ServerState::ReadyManaged
        );
        assert_eq!(
            status_snapshot(&manager, None).unwrap().server_state,
            ServerState::ReadyManaged
        );
        let second = dispatch_start(&manager, None, None, None).unwrap();
        assert_eq!(
            wait_for_operation(&manager, &second).server_state,
            ServerState::ReadyManaged
        );
        assert_eq!(runner.state.spawned.load(Ordering::Relaxed), 1);
        runner.state.stop_listener();
        let unavailable = status_snapshot(&manager, None).unwrap();
        assert_eq!(unavailable.server_state, ServerState::Failed);
        assert_eq!(unavailable.ownership, RuntimeOwnership::ManagedChild);
        assert_eq!(
            unavailable.error.unwrap().code,
            RuntimeErrorCode::ApiUnreachable
        );
        runner.state.simulate_exit();
        let failed = wait_for_snapshot(&manager, Duration::from_secs(2), |snapshot| {
            snapshot.server_state == ServerState::Failed
                && snapshot
                    .error
                    .as_ref()
                    .is_some_and(|error| error.code == RuntimeErrorCode::ProcessExited)
        });
        assert_eq!(failed.ownership, RuntimeOwnership::None);
        assert_eq!(runner.state.spawned.load(Ordering::Relaxed), 1);
        assert!(manager.lock().process.is_none());
    }

    #[test]
    fn stop_reaps_gracefully_or_forces_descendants_and_failed_stop_can_retry() {
        let runner = FakeRunner::new(Some(ApiFixture::ready(0)));
        let anchor = tempfile::tempdir().unwrap();
        let root = make_test_root(&anchor);
        let pin = *release_pin("linux", "x86_64").unwrap();
        let address = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        let manager = test_manager(
            &anchor,
            &root,
            address.port(),
            &runner,
            pin,
            Arc::new(FixtureDownloader::succeeding(Vec::new())),
            true,
        );
        let start = dispatch_start(&manager, None, None, None).unwrap();
        wait_for_operation(&manager, &start);
        let stop = dispatch_stop(&manager, None).unwrap();
        assert_eq!(
            wait_for_operation(&manager, &stop).server_state,
            ServerState::Stopped
        );
        assert_eq!(runner.state.graceful_calls.load(Ordering::Relaxed), 1);
        assert_eq!(runner.state.force_calls.load(Ordering::Relaxed), 0);
        assert!(manager.lock().process.is_none());

        let runner = FakeRunner::new(Some(ApiFixture::ready(0)));
        runner
            .state
            .graceful_reaps_descendants
            .store(false, Ordering::Release);
        let anchor = tempfile::tempdir().unwrap();
        let root = make_test_root(&anchor);
        let address = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        let manager = test_manager(
            &anchor,
            &root,
            address.port(),
            &runner,
            pin,
            Arc::new(FixtureDownloader::succeeding(Vec::new())),
            true,
        );
        let start = dispatch_start(&manager, None, None, None).unwrap();
        wait_for_operation(&manager, &start);
        let stop = dispatch_stop(&manager, None).unwrap();
        assert_eq!(
            wait_for_operation(&manager, &stop).server_state,
            ServerState::Stopped
        );
        assert!(runner.state.force_calls.load(Ordering::Relaxed) > 0);
        assert!(manager.lock().active_versions.is_empty());

        let runner = FakeRunner::new(Some(ApiFixture::ready(0)));
        runner.state.graceful_exits.store(false, Ordering::Release);
        runner.state.force_reaps.store(false, Ordering::Release);
        let anchor = tempfile::tempdir().unwrap();
        let root = make_test_root(&anchor);
        let address = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        let manager = test_manager(
            &anchor,
            &root,
            address.port(),
            &runner,
            pin,
            Arc::new(FixtureDownloader::succeeding(Vec::new())),
            true,
        );
        let start = dispatch_start(&manager, None, None, None).unwrap();
        wait_for_operation(&manager, &start);
        let remove_error = remove_installation(
            &anchor.path().to_path_buf(),
            &root,
            pin.version,
            pin.os,
            pin.arch,
            manager.in_use(pin.version),
            "remove-active",
        )
        .unwrap_err();
        assert_eq!(remove_error.code, RuntimeErrorCode::RuntimeInUse);
        assert!(root.join(pin.version).is_dir());
        manager
            .begin("remove-active-operation", OperationKind::Remove)
            .unwrap();
        manager.finish_failure("remove-active-operation", remove_error);
        let still_running = manager.snapshot();
        assert_eq!(still_running.state, RuntimeState::InstalledStopped);
        assert_eq!(still_running.server_state, ServerState::ReadyManaged);
        assert_eq!(still_running.ownership, RuntimeOwnership::ManagedChild);

        let stop = dispatch_stop(&manager, None).unwrap();
        let failed = wait_for_operation(&manager, &stop);
        assert_eq!(failed.error.unwrap().code, RuntimeErrorCode::StopFailed);
        assert!(manager.in_use(pin.version));
        assert!(manager.lock().process.is_some());
        runner.state.force_reaps.store(true, Ordering::Release);
        let retry = dispatch_stop(&manager, None).unwrap();
        assert_eq!(
            wait_for_operation(&manager, &retry).server_state,
            ServerState::Stopped
        );
        assert!(!manager.in_use(pin.version));
    }

    #[test]
    fn operation_guard_blocks_overlapping_start_stop_and_remove() {
        let runner = FakeRunner::new(Some(ApiFixture::status(503)));
        let anchor = tempfile::tempdir().unwrap();
        let root = make_test_root(&anchor);
        let pin = *release_pin("linux", "x86_64").unwrap();
        let address = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        let mut manager = test_manager(
            &anchor,
            &root,
            address.port(),
            &runner,
            pin,
            Arc::new(FixtureDownloader::succeeding(Vec::new())),
            true,
        );
        manager.settings.readiness_timeout = Duration::from_millis(90);
        let first = dispatch_start(&manager, None, None, None).unwrap();
        assert_eq!(
            dispatch_start(&manager, None, None, None).unwrap_err().code,
            RuntimeErrorCode::RuntimeBusy
        );
        assert_eq!(
            dispatch_stop(&manager, None).unwrap_err().code,
            RuntimeErrorCode::RuntimeBusy
        );
        assert_eq!(
            manager
                .begin("remove-race", OperationKind::Remove)
                .unwrap_err()
                .code,
            RuntimeErrorCode::RuntimeBusy
        );
        assert_eq!(
            wait_for_operation(&manager, &first).error.unwrap().code,
            RuntimeErrorCode::ReadinessTimeout
        );
        assert!(manager.lock().process.is_none());
    }

    #[test]
    fn shell_shutdown_reaps_child_and_cleans_a_child_spawned_during_shutdown() {
        let runner = FakeRunner::new(Some(ApiFixture::ready(0)));
        let anchor = tempfile::tempdir().unwrap();
        let root = make_test_root(&anchor);
        let pin = *release_pin("linux", "x86_64").unwrap();
        let address = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        let manager = test_manager(
            &anchor,
            &root,
            address.port(),
            &runner,
            pin,
            Arc::new(FixtureDownloader::succeeding(Vec::new())),
            true,
        );
        let start = dispatch_start(&manager, None, None, None).unwrap();
        wait_for_operation(&manager, &start);
        manager.shutdown();
        assert!(manager.is_shutting_down());
        assert!(manager.lock().process.is_none());
        assert!(manager.lock().active_versions.is_empty());

        let runner = FakeRunner::new(Some(ApiFixture::ready(0)));
        let anchor = tempfile::tempdir().unwrap();
        let root = make_test_root(&anchor);
        let address = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        let manager = test_manager(
            &anchor,
            &root,
            address.port(),
            &runner,
            pin,
            Arc::new(FixtureDownloader::succeeding(Vec::new())),
            true,
        );
        *runner.state.shutdown_manager_on_spawn.lock().unwrap() = Some(manager.clone());
        let _operation = dispatch_start(&manager, None, None, None).unwrap();
        wait_for_snapshot(&manager, Duration::from_secs(1), |_| {
            runner.state.exited.load(Ordering::Acquire)
                && runner.state.spawned.load(Ordering::Relaxed) == 1
        });
        assert!(manager.lock().process.is_none());
        assert!(manager.is_shutting_down());
    }

    #[test]
    fn static_resolver_pins_supported_windows_and_linux_assets() {
        assert_eq!(RELEASE_PINS.len(), 4);
        for pin in RELEASE_PINS {
            assert_eq!(pin.version, "0.40.3");
            assert!(pin
                .download_url
                .starts_with("https://github.com/ollama/ollama/releases/"));
            assert_eq!(
                pin.integrity_source,
                "https://github.com/ollama/ollama/releases/download/v0.40.3/sha256sum.txt"
            );
            assert!(valid_sha256(pin.sha256.unwrap()));
        }
        assert_eq!(
            release_pin("windows", "x86_64").unwrap().asset_name,
            "ollama-windows-amd64.zip"
        );
        assert_eq!(
            release_pin("linux", "aarch64").unwrap().asset_name,
            "ollama-linux-arm64.tar.zst"
        );
        assert_eq!(
            release_pin("macos", "aarch64").unwrap_err().code,
            RuntimeErrorCode::UnsupportedPlatform
        );
        assert_eq!(
            release_pin("linux", "riscv64").unwrap_err().code,
            RuntimeErrorCode::VersionUnavailable
        );
    }

    #[test]
    fn install_verifies_fixture_bytes_and_discovers_manifest_with_executable() {
        let bytes = tar_zst_regular("bin/ollama", b"fixture cli; never execute");
        let pin = fixture_pin_for_bytes(ArchiveFormat::TarZst, &bytes);
        let (anchor, root) = anchor_and_root();
        let installed = install_fixture(anchor.path(), &root, &pin, bytes, "fixture-1").unwrap();
        assert_eq!(installed.version, "0.40.3");
        assert!(root.join("0.40.3/bin/ollama").is_file());
        assert!(root.join("0.40.3").join(MANIFEST_FILE).is_file());
        let (versions, invalid) = inspect_installations(
            anchor.path(),
            &root,
            TargetOs::Linux,
            TargetArch::X86_64,
            "fixture-status",
        )
        .unwrap();
        assert_eq!(versions, vec!["0.40.3"]);
        assert!(!invalid);
    }

    #[test]
    fn windows_zip_fixture_installs_without_running_the_cli() {
        let bytes = zip_fixture(&[("ollama.exe", b"fixture executable", 0o100755)]);
        let pin = fixture_pin_for_bytes(ArchiveFormat::Zip, &bytes);
        let (anchor, root) = anchor_and_root();
        install_fixture(anchor.path(), &root, &pin, bytes, "fixture-zip").unwrap();
        assert!(root.join("0.40.3/ollama.exe").is_file());
        let parsed: InstallManifest =
            serde_json::from_slice(&fs::read(root.join("0.40.3").join(MANIFEST_FILE)).unwrap())
                .unwrap();
        assert_eq!(parsed.integrity_kind, INTEGRITY_KIND);
        assert!(parsed.integrity_verified);
    }

    #[test]
    fn existing_install_is_not_redownloaded_and_corrupt_manifest_is_not_adopted() {
        let bytes = tar_zst_regular("bin/ollama", b"fixture cli");
        let pin = fixture_pin_for_bytes(ArchiveFormat::TarZst, &bytes);
        let (anchor, root) = anchor_and_root();
        install_fixture(anchor.path(), &root, &pin, bytes.clone(), "fixture-first").unwrap();
        let downloader = FixtureDownloader::succeeding(bytes);
        install_release(
            anchor.path(),
            &root,
            &pin,
            &downloader,
            "fixture-again",
            |_, _, _| {},
        )
        .unwrap();
        assert_eq!(downloader.calls.load(Ordering::Relaxed), 0);

        fs::write(root.join("0.40.3").join(MANIFEST_FILE), b"not json").unwrap();
        let (versions, invalid) = inspect_installations(
            anchor.path(),
            &root,
            TargetOs::Linux,
            TargetArch::X86_64,
            "fixture-corrupt",
        )
        .unwrap();
        assert!(versions.is_empty());
        assert!(invalid);
    }

    #[test]
    fn missing_integrity_metadata_fails_before_download_or_install() {
        let bytes = tar_zst_regular("bin/ollama", b"fixture cli");
        let mut pin = fixture_pin_for_bytes(ArchiveFormat::TarZst, &bytes);
        pin.sha256 = None;
        let (anchor, root) = anchor_and_root();
        let downloader = FixtureDownloader::succeeding(bytes);
        let error = install_release(
            anchor.path(),
            &root,
            &pin,
            &downloader,
            "fixture-missing",
            |_, _, _| {},
        )
        .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::IntegrityMetadataMissing);
        assert_eq!(downloader.calls.load(Ordering::Relaxed), 0);
        assert!(!root.exists());
    }

    #[test]
    fn download_failure_cleans_partial_temp_and_user_retry_uses_same_pin() {
        let bytes = tar_zst_regular("bin/ollama", b"fixture cli");
        let pin = fixture_pin_for_bytes(ArchiveFormat::TarZst, &bytes);
        let (anchor, root) = anchor_and_root();
        let failing = FixtureDownloader::failing(bytes.clone());
        let error = install_release(
            anchor.path(),
            &root,
            &pin,
            &failing,
            "fixture-fail",
            |_, _, _| {},
        )
        .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::DownloadFailed);
        assert!(!root.join("0.40.3").exists());
        assert_eq!(count_staging_dirs(&root), 0);

        let retry = FixtureDownloader::succeeding(bytes.clone());
        install_release(
            anchor.path(),
            &root,
            &pin,
            &retry,
            "fixture-retry",
            |_, _, _| {},
        )
        .unwrap();
        assert_eq!(retry.calls.load(Ordering::Relaxed), 1);
        assert!(root.join("0.40.3/bin/ollama").is_file());
    }

    #[test]
    fn digest_mismatch_never_extracts_or_places_an_executable() {
        let bytes = tar_zst_regular("bin/ollama", b"fixture cli");
        let pin = fixture_pin(ArchiveFormat::TarZst, &"0".repeat(64), bytes.len() as u64);
        let (anchor, root) = anchor_and_root();
        let downloader = FixtureDownloader::succeeding(bytes);
        let error = install_release(
            anchor.path(),
            &root,
            &pin,
            &downloader,
            "fixture-hash",
            |_, _, _| {},
        )
        .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::IntegrityMismatch);
        assert!(!root.join("0.40.3").exists());
        assert_eq!(count_staging_dirs(&root), 0);
    }

    #[test]
    fn zip_traversal_and_symlink_entries_are_rejected() {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .add_symlink("ollama.exe", "../outside", SimpleFileOptions::default())
            .unwrap();
        let symlink = writer.finish().unwrap().into_inner();
        for bytes in [zip_fixture(&[("../escape", b"bad", 0o100644)]), symlink] {
            let pin = fixture_pin_for_bytes(ArchiveFormat::Zip, &bytes);
            let (anchor, root) = anchor_and_root();
            let downloader = FixtureDownloader::succeeding(bytes);
            let error = install_release(
                anchor.path(),
                &root,
                &pin,
                &downloader,
                "fixture-zip-bad",
                |_, _, _| {},
            )
            .unwrap_err();
            assert_eq!(error.code, RuntimeErrorCode::ArchiveRejected);
            assert!(!root.join("0.40.3").exists());
            assert_eq!(count_staging_dirs(&root), 0);
        }
    }

    #[test]
    fn tar_traversal_and_external_link_entries_are_rejected() {
        let traversal = tar_zst_with_unsafe_path("../escape", b"bad");
        let external_link = tar_zst_link("bin/ollama", "../../outside");
        for bytes in [traversal, external_link] {
            let pin = fixture_pin_for_bytes(ArchiveFormat::TarZst, &bytes);
            let (anchor, root) = anchor_and_root();
            let downloader = FixtureDownloader::succeeding(bytes);
            let error = install_release(
                anchor.path(),
                &root,
                &pin,
                &downloader,
                "fixture-tar-bad",
                |_, _, _| {},
            )
            .unwrap_err();
            assert_eq!(error.code, RuntimeErrorCode::ArchiveRejected);
            assert!(!root.join("0.40.3").exists());
            assert_eq!(count_staging_dirs(&root), 0);
        }
    }

    #[test]
    fn absolute_unc_drive_and_parent_paths_are_rejected() {
        for value in [
            "/absolute",
            "C:/outside",
            "\\\\server\\share",
            "a/../b",
            "../x",
        ] {
            assert_eq!(
                safe_archive_path(value, "fixture-path").unwrap_err().code,
                RuntimeErrorCode::ArchiveRejected
            );
        }
    }

    #[test]
    fn failed_new_install_preserves_prior_managed_version() {
        let (anchor, root) = anchor_and_root();
        write_managed_fixture(
            &root,
            "0.40.2",
            TargetOs::Linux,
            TargetArch::X86_64,
            b"previous cli",
        );
        let bytes = tar_zst_regular("bin/ollama", b"new fixture cli");
        let pin = fixture_pin_for_bytes(ArchiveFormat::TarZst, &bytes);
        let downloader = FixtureDownloader::failing(bytes);
        assert!(install_release(
            anchor.path(),
            &root,
            &pin,
            &downloader,
            "fixture-new",
            |_, _, _| {}
        )
        .is_err());
        assert_eq!(
            fs::read(root.join("0.40.2/bin/ollama")).unwrap(),
            b"previous cli"
        );
        assert!(!root.join("0.40.3").exists());
    }

    #[test]
    fn manager_rejects_a_concurrent_install_or_remove_operation() {
        let manager = RuntimeManager::default();
        manager
            .begin("operation-1", OperationKind::Install)
            .unwrap();
        assert_eq!(
            manager
                .begin("operation-2", OperationKind::Remove)
                .unwrap_err()
                .code,
            RuntimeErrorCode::RuntimeBusy
        );
        assert_eq!(
            manager.operation_snapshot().unwrap().state,
            RuntimeState::Installing
        );
    }

    #[test]
    fn remove_requires_confirmation_and_rejects_path_like_version_ids() {
        assert_eq!(
            validate_remove_request("0.40.3", false).unwrap_err().code,
            RuntimeErrorCode::ConfirmationRequired
        );
        for version in ["../outside", "C:\\outside", "\\\\server\\share"] {
            assert_eq!(
                validate_remove_request(version, true).unwrap_err().code,
                RuntimeErrorCode::VersionMalformed
            );
        }
        assert!(validate_remove_request("0.40.3", true).is_ok());
    }

    #[test]
    fn running_managed_version_cannot_be_removed() {
        let (anchor, root) = anchor_and_root();
        write_managed_fixture(
            &root,
            "0.40.3",
            TargetOs::Linux,
            TargetArch::X86_64,
            b"fixture cli",
        );
        let manager = RuntimeManager::default();
        manager.mark_active_for_test("0.40.3");
        let error = remove_installation(
            anchor.path(),
            &root,
            "0.40.3",
            TargetOs::Linux,
            TargetArch::X86_64,
            manager.in_use("0.40.3"),
            "fixture-active",
        )
        .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::RuntimeInUse);
        assert!(root.join("0.40.3/bin/ollama").exists());
    }

    #[test]
    fn removal_only_deletes_selected_managed_version_and_keeps_models_and_external_cli() {
        let (anchor, root) = anchor_and_root();
        write_managed_fixture(
            &root,
            "0.40.2",
            TargetOs::Linux,
            TargetArch::X86_64,
            b"older managed cli",
        );
        write_managed_fixture(
            &root,
            "0.40.3",
            TargetOs::Linux,
            TargetArch::X86_64,
            b"current managed cli",
        );
        let models = anchor.path().join("models/blobs/model.gguf");
        let external_cli = anchor.path().join("external/ollama");
        fs::create_dir_all(models.parent().unwrap()).unwrap();
        fs::create_dir_all(external_cli.parent().unwrap()).unwrap();
        fs::write(&models, b"model data").unwrap();
        fs::write(&external_cli, b"external ollama").unwrap();

        let remaining = remove_installation(
            anchor.path(),
            &root,
            "0.40.2",
            TargetOs::Linux,
            TargetArch::X86_64,
            false,
            "fixture-remove",
        )
        .unwrap();
        assert_eq!(remaining, vec!["0.40.3"]);
        assert!(!root.join("0.40.2").exists());
        assert!(root.join("0.40.3/bin/ollama").exists());
        assert_eq!(fs::read(models).unwrap(), b"model data");
        assert_eq!(fs::read(external_cli).unwrap(), b"external ollama");
    }

    #[test]
    fn permission_denial_maps_to_stable_permission_code() {
        assert_eq!(
            install_io_error(
                io::Error::from(io::ErrorKind::PermissionDenied),
                "place",
                "fixture-permission",
            )
            .code,
            RuntimeErrorCode::PermissionDenied
        );
    }

    #[cfg(unix)]
    #[test]
    fn managed_runtime_root_symlink_is_not_followed_or_adopted() {
        use std::os::unix::fs::symlink;
        let (anchor, root) = anchor_and_root();
        let outside = anchor.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(root.parent().unwrap()).unwrap();
        symlink(&outside, &root).unwrap();
        let error =
            ensure_managed_root(anchor.path(), &root, false, "fixture-root-link").unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::NotManaged);
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
    }

    #[test]
    fn installer_start_accepts_only_the_default_managed_loopback_endpoint() {
        assert!(is_default_managed_host(None));
        assert!(is_default_managed_host(Some("http://localhost:11434")));
        assert!(is_default_managed_host(Some("http://LOCALHOST:11434/")));
        assert!(!is_default_managed_host(Some("http://localhost:11435")));
        assert!(!is_default_managed_host(Some("https://example.com:11434")));
    }
}
