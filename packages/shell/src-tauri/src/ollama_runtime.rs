//! User-scoped Ollama installation, discovery, and owned server lifecycle.
//!
//! The supervisor only executes a validated managed CLI on loopback. It never
//! signals an external Ollama process. Local Ollama use is admitted through the
//! shared accelerator reservation manager.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex, MutexGuard,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use zip::ZipArchive;

#[cfg(test)]
use std::sync::atomic::{AtomicBool, AtomicUsize};

use crate::accelerator::{
    AcceleratorApi, AcceleratorDevice, AcceleratorInventory, DetectionStatus, DeviceIdKind,
    HardwareVendor, InformationSource, NvidiaMetadata, ProviderScopedDeviceId,
};
use crate::vram_reservation::{
    LocalModelKind, LocalModelRequest, ReservationLease, ReservationManager,
};

type InventoryLoader = Arc<dyn Fn() -> AcceleratorInventory + Send + Sync>;

const OLLAMA_WORKLOAD_ID: &str = "ollama-local-llm";

const RELEASE_VERSION: &str = "0.40.3";
const RELEASE_BASE: &str = "https://github.com/ollama/ollama/releases/download";
const INTEGRITY_KIND: &str = "official_sha256_manifest";
const MANIFEST_FILE: &str = "naia-shell-ollama.json";
const STATE_EVENT: &str = "ollama_runtime_state_changed";
const PROGRESS_EVENT: &str = "ollama_runtime_install_progress";
const MODEL_PULL_STATE_EVENT: &str = "ollama_model_pull_state_changed";
const MODEL_PULL_PROGRESS_EVENT: &str = "ollama_model_pull_progress";
const DEFAULT_HOST_URL: &str = "http://localhost:11434";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const READINESS_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(250);
const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(5);
const FORCE_STOP_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_ARCHIVE_ENTRIES: usize = 100_000;
const MAX_EXTRACTED_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MODEL_PULL_CANCEL_TIMEOUT: Duration = Duration::from_secs(30);
const MODEL_PULL_MAX_LINE_BYTES: usize = 1024 * 1024;
const DECIMAL_GB_BYTES: u64 = 1_000_000_000;
const QWEN_DISK_SPACE_MULTIPLIER: u64 = 2;

static OPERATION_COUNTER: AtomicU64 = AtomicU64::new(1);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
#[cfg(windows)]
const CREATE_SUSPENDED: u32 = 0x0000_0004;
#[cfg(windows)]
const OLLAMA_WINDOWS_PROCESS_FLAGS: u32 =
    CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED;

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
    AcceleratorInventoryUnavailable,
    DeviceNotFound,
    DeviceSelectionRequired,
    DeviceMappingUnverified,
    ReservationDenied,
    ReservationLeaseLost,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ServerState {
    NotInstalled,
    CheckingHost,
    ExternalUnavailable,
    Installing,
    InstalledStopped,
    Reserving,
    Starting,
    ReadyManaged,
    ReadyExternalLocal,
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
    Starting,
    Running,
    Denied,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReservationSnapshot {
    kind: Option<String>,
    status: ReservationStatus,
    bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
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

impl ReservationSnapshot {
    fn starting() -> Self {
        Self {
            kind: Some("local_llm".to_string()),
            status: ReservationStatus::Starting,
            bytes: None,
            reason_code: None,
        }
    }

    fn denied(reason_code: &str) -> Self {
        Self {
            kind: Some("local_llm".to_string()),
            status: ReservationStatus::Denied,
            bytes: None,
            reason_code: Some(reason_code.to_string()),
        }
    }

    fn from_lease(lease: &ReservationLease) -> Option<Self> {
        lease.snapshot().map(|reservation| Self {
            kind: Some("local_llm".to_string()),
            status: match reservation.status {
                crate::vram_reservation::ReservationStatus::Starting => ReservationStatus::Starting,
                crate::vram_reservation::ReservationStatus::Running => ReservationStatus::Running,
            },
            bytes: reservation.reservation_bytes,
            reason_code: None,
        })
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
    #[serde(skip_serializing_if = "Option::is_none")]
    reason_code: Option<String>,
}

impl RuntimeError {
    fn new(code: RuntimeErrorCode, stage: &str, retryable: bool) -> Self {
        Self {
            code,
            stage: stage.to_string(),
            retryable,
            operation_id: None,
            reason_code: None,
        }
    }

    fn for_operation(mut self, operation_id: &str) -> Self {
        self.operation_id = Some(operation_id.to_string());
        self
    }

    fn with_reason_code(mut self, reason_code: &str) -> Self {
        self.reason_code = Some(reason_code.to_string());
        self
    }
}

#[derive(Serialize)]
#[serde(untagged)]
pub(crate) enum StopCommandError {
    Runtime(RuntimeError),
    ModelPull(ModelPullError),
}

impl From<RuntimeError> for StopCommandError {
    fn from(error: RuntimeError) -> Self {
        Self::Runtime(error)
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct QwenModelCandidate {
    id: &'static str,
    display_name: &'static str,
    tag: &'static str,
    published_size: &'static str,
    published_size_bytes: Option<u64>,
    minimum_free_bytes: Option<u64>,
    quantization: &'static str,
    source_url: String,
    license: &'static str,
    license_url: String,
    published_context_tokens: u64,
    parameter_size: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QwenModelPolicy {
    candidates: Vec<QwenModelCandidate>,
    default_model_tag: Option<String>,
    context_default_tokens: Option<u64>,
    pull_start_policy: Option<String>,
    model_store_override: Option<String>,
    automatic_selection_policy: Option<String>,
    disk_space_multiplier: Option<u64>,
    model_store_available_bytes: Option<u64>,
    show_license: Option<bool>,
    measured_peak_vram_bytes: Option<u64>,
    selection_headroom_bytes: Option<u64>,
    #[cfg(test)]
    #[serde(skip)]
    available_bytes_override: Option<u64>,
}

fn qwen_model_policy() -> QwenModelPolicy {
    qwen_model_policy_with_store(None)
}

fn app_managed_model_store_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|app_data| app_data.join("ollama").join("models"))
}

fn qwen_model_policy_for_app(app: &AppHandle) -> QwenModelPolicy {
    let mut policy = qwen_model_policy_with_store(app_managed_model_store_path(app));
    policy.model_store_available_bytes = policy
        .model_store_override
        .as_deref()
        .and_then(|path| model_store_available_bytes(Path::new(path)).ok());
    policy
}

fn qwen_model_policy_with_store(model_store: Option<PathBuf>) -> QwenModelPolicy {
    let model_page = |tag: &'static str| format!("https://ollama.com/{tag}");
    let candidates = [
        (
            "0.8B",
            "huihui_ai/qwen3.5-abliterated:0.8B",
            "1.0 GB",
            "Q8_0",
            "0.8B",
        ),
        (
            "2B",
            "huihui_ai/qwen3.5-abliterated:2B",
            "1.9 GB",
            "Q4_K_M",
            "2B",
        ),
        (
            "4B",
            "huihui_ai/qwen3.5-abliterated:4B",
            "3.3 GB",
            "Q4_K_M",
            "4B",
        ),
        (
            "9b",
            "huihui_ai/qwen3.5-abliterated:9b",
            "6.6 GB",
            "Q4_K_M",
            "9B",
        ),
    ]
    .into_iter()
    .map(
        |(size, tag, published_size, quantization, parameter_size)| {
            let published_size_bytes = decimal_gb_bytes(published_size);
            QwenModelCandidate {
                id: match size {
                    "0.8B" => "qwen35-abliterated-08b",
                    "2B" => "qwen35-abliterated-2b",
                    "4B" => "qwen35-abliterated-4b",
                    _ => "qwen35-abliterated-9b",
                },
                display_name: match size {
                    "0.8B" => "Qwen 3.5 Abliterated 0.8B",
                    "2B" => "Qwen 3.5 Abliterated 2B",
                    "4B" => "Qwen 3.5 Abliterated 4B",
                    _ => "Qwen 3.5 Abliterated 9B",
                },
                tag,
                published_size,
                published_size_bytes,
                minimum_free_bytes: published_size_bytes
                    .and_then(|bytes| bytes.checked_mul(QWEN_DISK_SPACE_MULTIPLIER)),
                quantization,
                source_url: model_page(tag),
                license: "Apache License 2.0",
                license_url: "https://www.apache.org/licenses/LICENSE-2.0".to_string(),
                published_context_tokens: 256 * 1024,
                parameter_size,
            }
        },
    )
    .collect();
    QwenModelPolicy {
        candidates,
        default_model_tag: Some("huihui_ai/qwen3.5-abliterated:4B".to_string()),
        context_default_tokens: Some(8192),
        pull_start_policy: Some("user_confirmed_exact_tag".to_string()),
        model_store_override: model_store.map(|path| path.to_string_lossy().into_owned()),
        automatic_selection_policy: Some("manual_only_until_measured".to_string()),
        disk_space_multiplier: Some(QWEN_DISK_SPACE_MULTIPLIER),
        model_store_available_bytes: None,
        show_license: Some(true),
        measured_peak_vram_bytes: None,
        selection_headroom_bytes: None,
        #[cfg(test)]
        available_bytes_override: None,
    }
}

fn decimal_gb_bytes(size_label: &str) -> Option<u64> {
    let amount = size_label.strip_suffix(" GB")?.trim();
    let mut parts = amount.split('.');
    let whole = parts.next()?.parse::<u64>().ok()?;
    let fractional = parts.next().unwrap_or("");
    if parts.next().is_some()
        || fractional.len() > 9
        || !fractional.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let scale = 10_u64.checked_pow(fractional.len() as u32)?;
    let fraction = if fractional.is_empty() {
        0
    } else {
        fractional
            .parse::<u64>()
            .ok()?
            .checked_mul(DECIMAL_GB_BYTES / scale)?
    };
    whole.checked_mul(DECIMAL_GB_BYTES)?.checked_add(fraction)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ModelPullErrorCode {
    ModelTagUnknown,
    ModelConfirmationRequired,
    ManagedServerRequired,
    PullAlreadyActive,
    ModelStoreUnresolved,
    DiskSpaceLow,
    DiskMarginUnset,
    PullHttpFailed,
    PullStreamMalformed,
    ModelTagAbsent,
    ModelDigestMismatch,
    ModelDetailsMismatch,
    PullCancelTimeout,
    PullOperationUnknown,
    AcceleratorMappingUnverified,
    ModelPullActive,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelPullError {
    code: ModelPullErrorCode,
    stage: String,
    retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    required_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    available_bytes: Option<u64>,
}

impl ModelPullError {
    fn new(code: ModelPullErrorCode, stage: &str, retryable: bool) -> Self {
        Self {
            code,
            stage: stage.to_string(),
            retryable,
            operation_id: None,
            required_bytes: None,
            available_bytes: None,
        }
    }

    fn for_operation(mut self, operation_id: &str) -> Self {
        self.operation_id = Some(operation_id.to_string());
        self
    }

    fn with_disk_space(mut self, required_bytes: u64, available_bytes: u64) -> Self {
        self.required_bytes = Some(required_bytes);
        self.available_bytes = Some(available_bytes);
        self
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ModelPullState {
    Absent,
    Preflight,
    Pulling,
    Paused,
    Failed,
    Verifying,
    Ready,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelPullSnapshot {
    operation_id: Option<String>,
    tag: String,
    state: ModelPullState,
    stage: String,
    digest: Option<String>,
    error: Option<ModelPullError>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelPullProgress {
    operation_id: String,
    tag: String,
    phase: String,
    digest: Option<String>,
    completed: Option<u64>,
    total: Option<u64>,
    layer_percent: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelPullStartResponse {
    operation_id: String,
    snapshot: ModelPullSnapshot,
}

struct ActiveModelPull {
    operation_id: String,
    tag: String,
    cancel: Option<tokio::sync::oneshot::Sender<()>>,
    completion: Arc<(Mutex<bool>, Condvar)>,
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
    unreaped_processes: Vec<ManagedProcess>,
    external_reservation: Option<ExternalReservation>,
    external_reservation_pending: Option<(u64, String)>,
    external_reservation_generation: u64,
    next_process_generation: u64,
    model_pull_snapshots: BTreeMap<String, ModelPullSnapshot>,
    active_model_pull: Option<ActiveModelPull>,
    shutdown_requested: bool,
}

impl Default for ManagerState {
    fn default() -> Self {
        Self {
            snapshot: RuntimeSnapshot::default(),
            operation: None,
            active_versions: BTreeSet::new(),
            process: None,
            unreaped_processes: Vec::new(),
            external_reservation: None,
            external_reservation_pending: None,
            external_reservation_generation: 0,
            next_process_generation: 1,
            model_pull_snapshots: BTreeMap::new(),
            active_model_pull: None,
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

    #[cfg(all(test, windows))]
    fn child_pid_for_test(&self) -> Option<u32> {
        None
    }
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
    #[cfg(all(test, windows))]
    fn child_pid_for_test(&self) -> Option<u32> {
        Some(self.child.id())
    }

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
    reservation: Option<ReservationLease>,
}

struct ExternalReservation {
    host: String,
    lease: ReservationLease,
}

/// Tauri-managed state shared by the status, install, and remove commands.
#[derive(Clone)]
pub(crate) struct RuntimeManager {
    inner: Arc<Mutex<ManagerState>>,
    downloader: Arc<dyn ArtifactDownloader>,
    process_runner: Arc<dyn RuntimeProcessRunner>,
    reservation_manager: ReservationManager,
    inventory_loader: InventoryLoader,
    settings: RuntimeSettings,
    locations: Option<(PathBuf, PathBuf)>,
    release_pin: Option<ReleasePin>,
}

impl Default for RuntimeManager {
    fn default() -> Self {
        let inventory_loader: InventoryLoader = if cfg!(debug_assertions)
            && std::env::var_os("NAIA_SHELL_E2E_FAKE_ACCELERATOR").is_some()
        {
            Arc::new(e2e_fake_accelerator_inventory)
        } else {
            Arc::new(crate::accelerator::list_accelerators)
        };
        Self {
            inner: Arc::new(Mutex::new(ManagerState::default())),
            downloader: Arc::new(HttpDownloader),
            process_runner: Arc::new(SystemProcessRunner),
            reservation_manager: crate::vram_reservation::process_manager_clone(),
            inventory_loader,
            settings: RuntimeSettings::default(),
            locations: None,
            release_pin: None,
        }
    }
}

fn e2e_fake_accelerator_inventory() -> AcceleratorInventory {
    AcceleratorInventory {
        status: DetectionStatus::Detected,
        devices: vec![AcceleratorDevice {
            accelerator: AcceleratorApi::Vulkan,
            vendor: HardwareVendor::Nvidia,
            name: Some("Fixture accelerator".to_string()),
            provider_id: ProviderScopedDeviceId {
                provider: AcceleratorApi::Vulkan,
                kind: DeviceIdKind::VulkanUuid,
                value: "vulkan:uuid:00112233445566778899aabbccddeeff".to_string(),
            },
            total_vram_bytes: Some(16 * 1024 * 1024 * 1024),
            available_vram_bytes: Some(15 * 1024 * 1024 * 1024),
            info_source: InformationSource::Vulkan,
            total_vram_source: Some(InformationSource::Vulkan),
            available_vram_source: Some(InformationSource::NvidiaSmi),
            nvidia: Some(NvidiaMetadata {
                compatibility_index: Some(0),
                name: Some("Fixture accelerator".to_string()),
                compute_capability: None,
                driver_version: None,
            }),
            nvidia_info_source: Some(InformationSource::NvidiaSmi),
        }],
        error_code: None,
    }
}

fn select_ollama_device(
    inventory: &AcceleratorInventory,
    requested_device_id: Option<&str>,
) -> Result<(String, String), RuntimeError> {
    if inventory.status != DetectionStatus::Detected {
        let (code, reason) = if inventory.status == DetectionStatus::NoDevices {
            (RuntimeErrorCode::DeviceNotFound, "device_not_found")
        } else {
            (
                RuntimeErrorCode::AcceleratorInventoryUnavailable,
                "inventory_unavailable",
            )
        };
        return Err(RuntimeError::new(code, "reservation", true).with_reason_code(reason));
    }
    if inventory.devices.is_empty() {
        return Err(
            RuntimeError::new(RuntimeErrorCode::DeviceNotFound, "reservation", false)
                .with_reason_code("device_not_found"),
        );
    }
    let device = if let Some(requested_device_id) = requested_device_id {
        let mut matches = inventory
            .devices
            .iter()
            .filter(|device| device.provider_id.value == requested_device_id);
        let Some(device) = matches.next() else {
            return Err(
                RuntimeError::new(RuntimeErrorCode::DeviceNotFound, "reservation", false)
                    .with_reason_code("device_not_found"),
            );
        };
        if matches.next().is_some() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::DeviceMappingUnverified,
                "mapping",
                false,
            )
            .with_reason_code("device_mapping_unverified"));
        }
        device
    } else {
        if inventory.devices.len() != 1 {
            return Err(RuntimeError::new(
                RuntimeErrorCode::DeviceSelectionRequired,
                "reservation",
                false,
            )
            .with_reason_code("device_selection_required"));
        }
        &inventory.devices[0]
    };

    if device.vendor != HardwareVendor::Nvidia {
        return Err(
            RuntimeError::new(RuntimeErrorCode::DeviceMappingUnverified, "mapping", false)
                .with_reason_code("device_mapping_unverified"),
        );
    }
    let selector = device
        .nvidia
        .as_ref()
        .and_then(|metadata| metadata.compatibility_index)
        .filter(|index| {
            inventory
                .devices
                .iter()
                .filter(|candidate| {
                    candidate
                        .nvidia
                        .as_ref()
                        .and_then(|metadata| metadata.compatibility_index)
                        == Some(*index)
                })
                .count()
                == 1
        })
        .map(|index| index.to_string())
        .or_else(|| {
            let uuid = device.provider_id.value.strip_prefix("vulkan:uuid:")?;
            if uuid.len() == 32 && uuid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                let selector = format!("GPU-{uuid}");
                let collisions = inventory
                    .devices
                    .iter()
                    .filter(|candidate| {
                        candidate
                            .provider_id
                            .value
                            .strip_prefix("vulkan:uuid:")
                            .is_some_and(|candidate_uuid| {
                                format!("GPU-{candidate_uuid}") == selector
                            })
                    })
                    .count();
                (collisions == 1).then_some(selector)
            } else {
                None
            }
        });
    let Some(selector) = selector else {
        return Err(
            RuntimeError::new(RuntimeErrorCode::DeviceMappingUnverified, "mapping", false)
                .with_reason_code("device_mapping_unverified"),
        );
    };
    Ok((device.provider_id.value.clone(), selector))
}

fn reservation_error(reason_code: &str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::ReservationDenied, "reservation", true)
        .with_reason_code(reason_code)
}

impl RuntimeManager {
    fn lock(&self) -> MutexGuard<'_, ManagerState> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn begin(&self, id: &str, kind: OperationKind) -> Result<(), RuntimeError> {
        let mut state = self.lock();
        if state.shutdown_requested
            || state.operation.is_some()
            || state.active_model_pull.is_some()
        {
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
            OperationKind::Start => {
                state.snapshot.server_state = ServerState::CheckingHost;
                state.snapshot.reservation = ReservationSnapshot::default();
            }
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
                        | ServerState::ReadyExternalLocal
                        | ServerState::Reserving
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
                        | ServerState::ReadyExternalLocal
                        | ServerState::Reserving
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

    fn set_reservation_snapshot(&self, reservation: ReservationSnapshot) {
        self.lock().snapshot.reservation = reservation;
    }

    fn try_reserve_local(
        &self,
        requested_device_id: Option<&str>,
    ) -> Result<(ReservationLease, String, String), RuntimeError> {
        let inventory = (self.inventory_loader)();
        let (device_id, selector) = select_ollama_device(&inventory, requested_device_id)?;
        let request = LocalModelRequest {
            device_id: device_id.clone(),
            kind: LocalModelKind::LocalLlm,
            workload_id: OLLAMA_WORKLOAD_ID.to_string(),
            reservation_bytes: None,
        };
        let lease = self
            .reservation_manager
            .try_reserve_with_inventory(request, &inventory)
            .map_err(|denial| reservation_error(denial.reason.code()))?;
        Ok((lease, device_id, selector))
    }

    fn is_shutting_down(&self) -> bool {
        self.lock().shutdown_requested
    }

    #[cfg(test)]
    fn mark_active_for_test(&self, version: &str) {
        self.lock().active_versions.insert(version.to_string());
    }
}

enum ExternalAdmission {
    Reserved(ReservationSnapshot),
    InProgress,
    Denied(RuntimeError),
}

fn reserve_external_local(
    manager: &RuntimeManager,
    host: &str,
    requested_device_id: Option<&str>,
) -> ExternalAdmission {
    let (generation, old_reservation) = {
        let mut state = manager.lock();
        if state.shutdown_requested {
            return ExternalAdmission::Denied(RuntimeError::new(
                RuntimeErrorCode::RuntimeBusy,
                "reservation",
                true,
            ));
        }
        if let Some(existing) = state.external_reservation.as_ref() {
            if existing.host == host {
                return match ReservationSnapshot::from_lease(&existing.lease) {
                    Some(snapshot) => ExternalAdmission::Reserved(snapshot),
                    None => ExternalAdmission::Denied(
                        RuntimeError::new(
                            RuntimeErrorCode::ReservationLeaseLost,
                            "reservation",
                            true,
                        )
                        .with_reason_code("reservation_lease_lost"),
                    ),
                };
            }
        }
        if state.external_reservation_pending.is_some() {
            return ExternalAdmission::InProgress;
        }
        let old_reservation = state.external_reservation.take();
        state.external_reservation_generation =
            state.external_reservation_generation.wrapping_add(1).max(1);
        let generation = state.external_reservation_generation;
        state.external_reservation_pending = Some((generation, host.to_string()));
        (generation, old_reservation)
    };
    drop(old_reservation);

    let (lease, _device_id, _selector) = match manager.try_reserve_local(requested_device_id) {
        Ok(value) => value,
        Err(error) => {
            let mut state = manager.lock();
            if state
                .external_reservation_pending
                .as_ref()
                .is_some_and(|(current, _)| *current == generation)
            {
                state.external_reservation_pending = None;
            }
            return ExternalAdmission::Denied(error);
        }
    };
    if !lease.mark_running() {
        let mut state = manager.lock();
        if state
            .external_reservation_pending
            .as_ref()
            .is_some_and(|(current, _)| *current == generation)
        {
            state.external_reservation_pending = None;
        }
        drop(state);
        drop(lease);
        return ExternalAdmission::Denied(
            RuntimeError::new(RuntimeErrorCode::ReservationLeaseLost, "reservation", true)
                .with_reason_code("reservation_lease_lost"),
        );
    }
    let Some(reservation) = ReservationSnapshot::from_lease(&lease) else {
        let mut state = manager.lock();
        if state
            .external_reservation_pending
            .as_ref()
            .is_some_and(|(current, _)| *current == generation)
        {
            state.external_reservation_pending = None;
        }
        drop(state);
        drop(lease);
        return ExternalAdmission::Denied(
            RuntimeError::new(RuntimeErrorCode::ReservationLeaseLost, "reservation", true)
                .with_reason_code("reservation_lease_lost"),
        );
    };
    let mut lease_to_drop = Some(lease);
    let committed = {
        let mut state = manager.lock();
        if state
            .external_reservation_pending
            .as_ref()
            .is_some_and(|(current, current_host)| *current == generation && current_host == host)
            && !state.shutdown_requested
        {
            state.external_reservation_pending = None;
            state.external_reservation = Some(ExternalReservation {
                host: host.to_string(),
                lease: lease_to_drop.take().expect("new external lease is present"),
            });
            true
        } else {
            false
        }
    };
    drop(lease_to_drop);
    if committed {
        ExternalAdmission::Reserved(reservation)
    } else {
        ExternalAdmission::Denied(RuntimeError::new(
            RuntimeErrorCode::RuntimeBusy,
            "reservation",
            true,
        ))
    }
}

fn release_external_reservation_for_host(manager: &RuntimeManager, host: &str) {
    let external_reservation = {
        let mut state = manager.lock();
        if state
            .external_reservation
            .as_ref()
            .is_some_and(|reservation| reservation.host == host)
        {
            state.external_reservation.take()
        } else {
            None
        }
    };
    drop(external_reservation);
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
            // Keep the process group available for CTRL_BREAK without creating a console window.
            command.creation_flags(OLLAMA_WINDOWS_PROCESS_FLAGS);
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

#[cfg(all(windows, test))]
fn with_attached_child_console<T>(
    child_pid: u32,
    action: impl FnOnce() -> io::Result<T>,
) -> io::Result<T> {
    use windows_sys::Win32::System::Console::{AttachConsole, FreeConsole, GetConsoleProcessList};

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
    if unsafe { AttachConsole(child_pid) } == 0 {
        let error = io::Error::last_os_error();
        if let Some(pid) = previous_console_process {
            unsafe { AttachConsole(pid) };
        }
        return Err(error);
    }

    let result = action();
    unsafe { FreeConsole() };
    if let Some(pid) = previous_console_process {
        if unsafe { AttachConsole(pid) } == 0 && result.is_ok() {
            return Err(io::Error::last_os_error());
        }
    }
    result
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

fn model_pull_error(
    code: ModelPullErrorCode,
    stage: &str,
    retryable: bool,
    operation_id: Option<&str>,
) -> ModelPullError {
    let error = ModelPullError::new(code, stage, retryable);
    operation_id.map_or(error.clone(), |id| error.for_operation(id))
}

fn model_candidate<'a>(policy: &'a QwenModelPolicy, tag: &str) -> Option<&'a QwenModelCandidate> {
    policy
        .candidates
        .iter()
        .find(|candidate| candidate.tag == tag)
}

fn model_pull_client(timeout: Duration) -> Result<reqwest::Client, ModelPullError> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(timeout)
        .build()
        .map_err(|_| ModelPullError::new(ModelPullErrorCode::PullHttpFailed, "connect", true))
}

fn model_api_url(base: &str, path: &str) -> Result<url::Url, ModelPullError> {
    let base = url::Url::parse(base).map_err(|_| {
        ModelPullError::new(ModelPullErrorCode::ManagedServerRequired, "owner", false)
    })?;
    if base.scheme() != "http"
        || !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return Err(ModelPullError::new(
            ModelPullErrorCode::ManagedServerRequired,
            "owner",
            false,
        ));
    }
    base.join(path)
        .map_err(|_| ModelPullError::new(ModelPullErrorCode::ManagedServerRequired, "owner", false))
}

fn managed_pull_base(manager: &RuntimeManager) -> Result<String, ModelPullError> {
    let mut state = manager.lock();
    if state.shutdown_requested {
        return Err(ModelPullError::new(
            ModelPullErrorCode::ManagedServerRequired,
            "owner",
            false,
        ));
    }
    if state.active_model_pull.is_some() {
        return Err(ModelPullError::new(
            ModelPullErrorCode::PullAlreadyActive,
            "preflight",
            true,
        ));
    }
    if state.operation.is_some() {
        return Err(ModelPullError::new(
            ModelPullErrorCode::PullAlreadyActive,
            "preflight",
            true,
        ));
    }
    if state.snapshot.server_state != ServerState::ReadyManaged
        || state.snapshot.ownership != RuntimeOwnership::ManagedChild
    {
        return Err(ModelPullError::new(
            ModelPullErrorCode::ManagedServerRequired,
            "owner",
            false,
        ));
    }
    let Some(process) = state.process.as_mut() else {
        return Err(ModelPullError::new(
            ModelPullErrorCode::ManagedServerRequired,
            "owner",
            false,
        ));
    };
    if process.child.has_exited().unwrap_or(true) {
        return Err(ModelPullError::new(
            ModelPullErrorCode::ManagedServerRequired,
            "owner",
            true,
        ));
    }
    let reservation_is_running = process
        .reservation
        .as_ref()
        .and_then(ReservationSnapshot::from_lease)
        .is_some_and(|reservation| reservation.status == ReservationStatus::Running);
    if !reservation_is_running || state.snapshot.reservation.status != ReservationStatus::Running {
        return Err(ModelPullError::new(
            ModelPullErrorCode::AcceleratorMappingUnverified,
            "owner",
            false,
        ));
    }
    let base = manager.settings.managed_base_url.clone();
    let parsed = url::Url::parse(&base).map_err(|_| {
        ModelPullError::new(ModelPullErrorCode::ManagedServerRequired, "owner", false)
    })?;
    let allowed = if cfg!(test) {
        is_loopback_endpoint(&parsed)
    } else {
        base == DEFAULT_HOST_URL && is_loopback_endpoint(&parsed)
    };
    if !allowed {
        return Err(ModelPullError::new(
            ModelPullErrorCode::ManagedServerRequired,
            "owner",
            false,
        ));
    }
    Ok(base)
}

#[derive(Debug)]
struct ModelStoreCheck {
    probe_directory: PathBuf,
    available_bytes: u64,
}

fn model_store_probe_directory(configured: &Path) -> Result<PathBuf, ModelPullError> {
    if !configured.is_absolute() {
        return Err(ModelPullError::new(
            ModelPullErrorCode::ModelStoreUnresolved,
            "preflight",
            false,
        ));
    }
    let mut ancestor = configured;
    let existing = loop {
        match fs::metadata(ancestor) {
            Ok(metadata) if metadata.is_dir() => break ancestor.to_path_buf(),
            Ok(_) => {
                return Err(ModelPullError::new(
                    ModelPullErrorCode::ModelStoreUnresolved,
                    "preflight",
                    false,
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                ancestor = ancestor.parent().ok_or_else(|| {
                    ModelPullError::new(
                        ModelPullErrorCode::ModelStoreUnresolved,
                        "preflight",
                        false,
                    )
                })?;
            }
            Err(_) => {
                return Err(ModelPullError::new(
                    ModelPullErrorCode::ModelStoreUnresolved,
                    "preflight",
                    false,
                ));
            }
        }
    };
    Ok(existing)
}

fn model_store_available_bytes(configured: &Path) -> Result<u64, ModelPullError> {
    let existing = model_store_probe_directory(configured)?;
    fs2::available_space(&existing).map_err(|_| {
        ModelPullError::new(ModelPullErrorCode::ModelStoreUnresolved, "preflight", false)
    })
}

fn check_model_store(policy: &QwenModelPolicy) -> Result<ModelStoreCheck, ModelPullError> {
    let configured = policy
        .model_store_override
        .as_deref()
        .map(Path::new)
        .ok_or_else(|| {
            ModelPullError::new(ModelPullErrorCode::ModelStoreUnresolved, "preflight", false)
        })?;
    if !configured.is_absolute() || fs::create_dir_all(configured).is_err() {
        return Err(ModelPullError::new(
            ModelPullErrorCode::ModelStoreUnresolved,
            "preflight",
            false,
        ));
    }
    let existing = model_store_probe_directory(configured)?;
    let probe = tempfile::Builder::new()
        .prefix("naia-ollama-write-check-")
        .tempfile_in(&existing)
        .map_err(|_| {
            ModelPullError::new(ModelPullErrorCode::ModelStoreUnresolved, "preflight", false)
        })?;
    probe.close().map_err(|_| {
        ModelPullError::new(ModelPullErrorCode::ModelStoreUnresolved, "preflight", false)
    })?;
    #[cfg(test)]
    let available_bytes = match policy.available_bytes_override {
        Some(available_bytes) => available_bytes,
        None => fs2::available_space(&existing).map_err(|_| {
            ModelPullError::new(ModelPullErrorCode::ModelStoreUnresolved, "preflight", false)
        })?,
    };
    #[cfg(not(test))]
    let available_bytes = fs2::available_space(&existing).map_err(|_| {
        ModelPullError::new(ModelPullErrorCode::ModelStoreUnresolved, "preflight", false)
    })?;
    Ok(ModelStoreCheck {
        probe_directory: existing,
        available_bytes,
    })
}

fn installed_model_digest(models: &Value, tag: &str) -> Option<String> {
    models
        .get("models")?
        .as_array()?
        .iter()
        .find(|model| {
            model.get("name").and_then(Value::as_str) == Some(tag)
                || model.get("model").and_then(Value::as_str) == Some(tag)
        })?
        .get("digest")
        .and_then(Value::as_str)
        .filter(|digest| !digest.trim().is_empty())
        .map(str::to_string)
}

fn model_tag_present(models: &Value, tag: &str) -> bool {
    models
        .get("models")
        .and_then(Value::as_array)
        .is_some_and(|models| {
            models.iter().any(|model| {
                model.get("name").and_then(Value::as_str) == Some(tag)
                    || model.get("model").and_then(Value::as_str) == Some(tag)
            })
        })
}

fn fetch_tags_sync(
    client: &reqwest::blocking::Client,
    base: &str,
    tag: &str,
    operation_id: Option<&str>,
) -> Result<Option<String>, ModelPullError> {
    let url = model_api_url(base, "/api/tags").map_err(|error| match operation_id {
        Some(operation_id) => error.for_operation(operation_id),
        None => error,
    })?;
    let response = client
        .get(url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|_| {
            model_pull_error(
                ModelPullErrorCode::PullHttpFailed,
                "tags",
                true,
                operation_id,
            )
        })?;
    let value: Value = response.json().map_err(|_| {
        model_pull_error(
            ModelPullErrorCode::PullStreamMalformed,
            "tags",
            true,
            operation_id,
        )
    })?;
    let digest = installed_model_digest(&value, tag);
    if model_tag_present(&value, tag) && digest.is_none() {
        return Err(model_pull_error(
            ModelPullErrorCode::ModelDigestMismatch,
            "tags",
            false,
            operation_id,
        ));
    }
    Ok(digest)
}

fn verify_show_details(
    show: &Value,
    candidate: &QwenModelCandidate,
) -> Result<(), ModelPullErrorCode> {
    let details = show
        .get("details")
        .ok_or(ModelPullErrorCode::ModelDetailsMismatch)?;
    let quantization = details
        .get("quantization_level")
        .and_then(Value::as_str)
        .ok_or(ModelPullErrorCode::ModelDetailsMismatch)?;
    let parameters = details
        .get("parameter_size")
        .and_then(Value::as_str)
        .ok_or(ModelPullErrorCode::ModelDetailsMismatch)?;
    let model_info = show
        .get("model_info")
        .and_then(Value::as_object)
        .ok_or(ModelPullErrorCode::ModelDetailsMismatch)?;
    let context = model_info
        .iter()
        .find(|(key, _)| key.ends_with(".context_length"))
        .and_then(|(_, value)| value.as_u64())
        .ok_or(ModelPullErrorCode::ModelDetailsMismatch)?;
    let is_qwen = model_info
        .keys()
        .any(|key| key.to_ascii_lowercase().contains("qwen"))
        || details
            .get("family")
            .and_then(Value::as_str)
            .is_some_and(|family| family.to_ascii_lowercase().contains("qwen"));
    if quantization != candidate.quantization
        || !parameters
            .to_ascii_lowercase()
            .starts_with(&candidate.parameter_size.to_ascii_lowercase())
        || context != candidate.published_context_tokens
        || !is_qwen
    {
        return Err(ModelPullErrorCode::ModelDetailsMismatch);
    }
    Ok(())
}

fn verify_model_sync(
    client: &reqwest::blocking::Client,
    base: &str,
    candidate: &QwenModelCandidate,
    operation_id: &str,
) -> Result<String, ModelPullError> {
    let digest =
        fetch_tags_sync(client, base, candidate.tag, Some(operation_id))?.ok_or_else(|| {
            model_pull_error(
                ModelPullErrorCode::ModelTagAbsent,
                "verify_tags",
                true,
                Some(operation_id),
            )
        })?;
    let show_url = model_api_url(base, "/api/show").map_err(|_| {
        model_pull_error(
            ModelPullErrorCode::PullHttpFailed,
            "verify_show",
            true,
            Some(operation_id),
        )
    })?;
    let show: Value = client
        .post(show_url)
        .json(&serde_json::json!({ "name": candidate.tag }))
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .and_then(reqwest::blocking::Response::json)
        .map_err(|_| {
            model_pull_error(
                ModelPullErrorCode::PullHttpFailed,
                "verify_show",
                true,
                Some(operation_id),
            )
        })?;
    verify_show_details(&show, candidate)
        .map_err(|code| model_pull_error(code, "verify_show", false, Some(operation_id)))?;
    let confirmed_digest = fetch_tags_sync(client, base, candidate.tag, Some(operation_id))?
        .ok_or_else(|| {
            model_pull_error(
                ModelPullErrorCode::ModelTagAbsent,
                "verify_tags_again",
                true,
                Some(operation_id),
            )
        })?;
    if digest != confirmed_digest {
        return Err(model_pull_error(
            ModelPullErrorCode::ModelDigestMismatch,
            "verify_tags_again",
            true,
            Some(operation_id),
        ));
    }
    Ok(digest)
}

fn emit_model_pull_snapshot(app: Option<&AppHandle>, snapshot: &ModelPullSnapshot) {
    if let Some(app) = app {
        let _ = app.emit(MODEL_PULL_STATE_EVENT, snapshot);
    }
}

fn update_model_pull_snapshot(
    manager: &RuntimeManager,
    app: Option<&AppHandle>,
    operation_id: &str,
    state_value: ModelPullState,
    stage: &str,
    digest: Option<String>,
    error: Option<ModelPullError>,
    terminal: bool,
) -> Option<ModelPullSnapshot> {
    let snapshot = {
        let mut state = manager.lock();
        let active_tag = state
            .active_model_pull
            .as_ref()
            .filter(|active| active.operation_id == operation_id)
            .map(|active| active.tag.clone());
        let tag = active_tag.or_else(|| {
            state
                .model_pull_snapshots
                .iter()
                .find_map(|(tag, snapshot)| {
                    (snapshot.operation_id.as_deref() == Some(operation_id)).then(|| tag.clone())
                })
        })?;
        let previous = state.model_pull_snapshots.get(&tag)?;
        if previous.operation_id.as_deref() != Some(operation_id) {
            return None;
        }
        let snapshot = ModelPullSnapshot {
            operation_id: Some(operation_id.to_string()),
            tag: tag.clone(),
            state: state_value,
            stage: stage.to_string(),
            digest,
            error,
        };
        state.model_pull_snapshots.insert(tag, snapshot.clone());
        if terminal {
            state.active_model_pull = None;
        }
        snapshot
    };
    emit_model_pull_snapshot(app, &snapshot);
    Some(snapshot)
}

fn finish_model_pull(
    manager: &RuntimeManager,
    app: Option<&AppHandle>,
    operation_id: &str,
    state_value: ModelPullState,
    stage: &str,
    digest: Option<String>,
    error: Option<ModelPullError>,
    completion: &Arc<(Mutex<bool>, Condvar)>,
) {
    update_model_pull_snapshot(
        manager,
        app,
        operation_id,
        state_value,
        stage,
        digest,
        error,
        true,
    );
    let (done, changed) = &**completion;
    *done.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
    changed.notify_all();
}

fn wait_for_model_pull(completion: &Arc<(Mutex<bool>, Condvar)>, timeout: Duration) -> bool {
    let (done, changed) = &**completion;
    let guard = done.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (guard, _) = changed
        .wait_timeout_while(guard, timeout, |finished| !*finished)
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard
}

fn emit_model_pull_progress(app: Option<&AppHandle>, progress: &ModelPullProgress) {
    if let Some(app) = app {
        let _ = app.emit(MODEL_PULL_PROGRESS_EVENT, progress);
    }
}

fn parse_pull_line(
    line: &[u8],
) -> Result<Option<(String, Option<String>, Option<u64>, Option<u64>)>, ModelPullErrorCode> {
    if line.iter().all(u8::is_ascii_whitespace) {
        return Ok(None);
    }
    let value: Value =
        serde_json::from_slice(line).map_err(|_| ModelPullErrorCode::PullStreamMalformed)?;
    if value.get("error").and_then(Value::as_str).is_some() {
        return Err(ModelPullErrorCode::PullHttpFailed);
    }
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("pulling")
        .to_string();
    let digest = value
        .get("digest")
        .and_then(Value::as_str)
        .map(str::to_string);
    let completed = value.get("completed").and_then(Value::as_u64);
    let total = value.get("total").and_then(Value::as_u64);
    Ok(Some((status, digest, completed, total)))
}

fn append_pull_chunk(
    buffer: &mut Vec<u8>,
    chunk: &[u8],
) -> Result<Vec<Option<(String, Option<String>, Option<u64>, Option<u64>)>>, ModelPullErrorCode> {
    buffer.extend_from_slice(chunk);
    let mut lines = Vec::new();
    while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
        if newline > MODEL_PULL_MAX_LINE_BYTES {
            return Err(ModelPullErrorCode::PullStreamMalformed);
        }
        let line = buffer.drain(..=newline).collect::<Vec<_>>();
        lines.push(parse_pull_line(&line[..line.len().saturating_sub(1)])?);
    }
    if buffer.len() > MODEL_PULL_MAX_LINE_BYTES {
        return Err(ModelPullErrorCode::PullStreamMalformed);
    }
    Ok(lines)
}

fn finish_pull_buffer(
    buffer: &mut Vec<u8>,
) -> Result<Option<(String, Option<String>, Option<u64>, Option<u64>)>, ModelPullErrorCode> {
    if buffer.is_empty() {
        return Ok(None);
    }
    parse_pull_line(&std::mem::take(buffer))
}

fn model_pull_progress_due(
    last_event: &mut tokio::time::Instant,
    now: tokio::time::Instant,
    completed_bytes: Option<u64>,
) -> bool {
    if completed_bytes.is_none() || now.duration_since(*last_event) >= Duration::from_millis(250) {
        *last_event = now;
        true
    } else {
        false
    }
}

async fn stream_model_pull(
    client: reqwest::Client,
    base: String,
    operation_id: String,
    tag: String,
    app: Option<AppHandle>,
    mut cancel: tokio::sync::oneshot::Receiver<()>,
) -> Result<bool, ModelPullError> {
    let url = model_api_url(&base, "/api/pull").map_err(|_| {
        model_pull_error(
            ModelPullErrorCode::ManagedServerRequired,
            "pull",
            false,
            Some(&operation_id),
        )
    })?;
    let request = client
        .post(url)
        .json(&serde_json::json!({ "name": tag, "stream": true }));
    let response = tokio::select! {
        result = request.send() => result.map_err(|_| model_pull_error(ModelPullErrorCode::PullHttpFailed, "pull", true, Some(&operation_id)))?,
        _ = &mut cancel => return Ok(false),
    };
    if !response.status().is_success() {
        return Err(model_pull_error(
            ModelPullErrorCode::PullHttpFailed,
            "pull",
            true,
            Some(&operation_id),
        ));
    }
    let mut stream = response.bytes_stream();
    let mut buffer = Vec::new();
    let mut saw_success = false;
    let mut last_progress_event = tokio::time::Instant::now() - Duration::from_secs(1);
    loop {
        let chunk = tokio::select! {
            result = futures_util::StreamExt::next(&mut stream) => result,
            _ = &mut cancel => return Ok(false),
        };
        let Some(chunk) = chunk else { break };
        let chunk = match chunk {
            Ok(chunk) => chunk,
            // A severed HTTP stream is resumable. Explicit HTTP or JSON errors remain failures.
            Err(_) => return Ok(false),
        };
        let lines = append_pull_chunk(&mut buffer, &chunk)
            .map_err(|code| model_pull_error(code, "pull", true, Some(&operation_id)))?;
        for parsed in lines {
            if let Some((phase, digest, completed, total)) = parsed {
                saw_success |= phase == "success";
                let layer_percent = match (completed, total) {
                    (Some(completed), Some(total)) if total > 0 => {
                        Some((completed as f64 * 100.0 / total as f64).min(100.0))
                    }
                    _ => None,
                };
                let progress = ModelPullProgress {
                    operation_id: operation_id.clone(),
                    tag: tag.clone(),
                    phase,
                    digest,
                    completed,
                    total,
                    layer_percent,
                };
                let now = tokio::time::Instant::now();
                if model_pull_progress_due(&mut last_progress_event, now, completed) {
                    emit_model_pull_progress(app.as_ref(), &progress);
                }
            }
        }
    }
    if let Some((phase, digest, completed, total)) = finish_pull_buffer(&mut buffer)
        .map_err(|code| model_pull_error(code, "pull", true, Some(&operation_id)))?
    {
        saw_success |= phase == "success";
        let layer_percent = match (completed, total) {
            (Some(completed), Some(total)) if total > 0 => {
                Some((completed as f64 * 100.0 / total as f64).min(100.0))
            }
            _ => None,
        };
        let progress = ModelPullProgress {
            operation_id: operation_id.clone(),
            tag: tag.clone(),
            phase,
            digest,
            completed,
            total,
            layer_percent,
        };
        emit_model_pull_progress(app.as_ref(), &progress);
    }
    Ok(saw_success)
}

async fn verify_model_async(
    client: &reqwest::Client,
    base: &str,
    candidate: &QwenModelCandidate,
    operation_id: &str,
) -> Result<String, ModelPullError> {
    let tags_url = model_api_url(base, "/api/tags").map_err(|_| {
        model_pull_error(
            ModelPullErrorCode::ManagedServerRequired,
            "verify_tags",
            false,
            Some(operation_id),
        )
    })?;
    let response = client
        .get(tags_url)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|_| {
            model_pull_error(
                ModelPullErrorCode::PullHttpFailed,
                "verify_tags",
                true,
                Some(operation_id),
            )
        })?;
    let tags: Value = response.json().await.map_err(|_| {
        model_pull_error(
            ModelPullErrorCode::PullStreamMalformed,
            "verify_tags",
            true,
            Some(operation_id),
        )
    })?;
    let digest = installed_model_digest(&tags, candidate.tag).ok_or_else(|| {
        let code = if model_tag_present(&tags, candidate.tag) {
            ModelPullErrorCode::ModelDigestMismatch
        } else {
            ModelPullErrorCode::ModelTagAbsent
        };
        model_pull_error(code, "verify_tags", true, Some(operation_id))
    })?;
    let show_url = model_api_url(base, "/api/show").map_err(|_| {
        model_pull_error(
            ModelPullErrorCode::ManagedServerRequired,
            "verify_show",
            false,
            Some(operation_id),
        )
    })?;
    let show: Value = client
        .post(show_url)
        .json(&serde_json::json!({ "name": candidate.tag }))
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|_| {
            model_pull_error(
                ModelPullErrorCode::PullHttpFailed,
                "verify_show",
                true,
                Some(operation_id),
            )
        })?
        .json()
        .await
        .map_err(|_| {
            model_pull_error(
                ModelPullErrorCode::PullStreamMalformed,
                "verify_show",
                true,
                Some(operation_id),
            )
        })?;
    verify_show_details(&show, candidate)
        .map_err(|code| model_pull_error(code, "verify_show", false, Some(operation_id)))?;
    let response = client
        .get(model_api_url(base, "/api/tags").map_err(|_| {
            model_pull_error(
                ModelPullErrorCode::ManagedServerRequired,
                "verify_tags_again",
                false,
                Some(operation_id),
            )
        })?)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|_| {
            model_pull_error(
                ModelPullErrorCode::PullHttpFailed,
                "verify_tags_again",
                true,
                Some(operation_id),
            )
        })?;
    let tags: Value = response.json().await.map_err(|_| {
        model_pull_error(
            ModelPullErrorCode::PullStreamMalformed,
            "verify_tags_again",
            true,
            Some(operation_id),
        )
    })?;
    let confirmed_digest = installed_model_digest(&tags, candidate.tag).ok_or_else(|| {
        let code = if model_tag_present(&tags, candidate.tag) {
            ModelPullErrorCode::ModelDigestMismatch
        } else {
            ModelPullErrorCode::ModelTagAbsent
        };
        model_pull_error(code, "verify_tags_again", true, Some(operation_id))
    })?;
    if digest != confirmed_digest {
        return Err(model_pull_error(
            ModelPullErrorCode::ModelDigestMismatch,
            "verify_tags_again",
            true,
            Some(operation_id),
        ));
    }
    Ok(digest)
}

fn record_model_pull_failure(
    manager: &RuntimeManager,
    app: Option<&AppHandle>,
    tag: &str,
    operation_id: &str,
    error: ModelPullError,
) -> ModelPullSnapshot {
    let snapshot = ModelPullSnapshot {
        operation_id: Some(operation_id.to_string()),
        tag: tag.to_string(),
        state: ModelPullState::Failed,
        stage: error.stage.clone(),
        digest: None,
        error: Some(error),
    };
    manager
        .lock()
        .model_pull_snapshots
        .insert(tag.to_string(), snapshot.clone());
    emit_model_pull_snapshot(app, &snapshot);
    snapshot
}

fn managed_owner_for_cancel(manager: &RuntimeManager) -> Result<(), ModelPullError> {
    let mut state = manager.lock();
    if state.snapshot.server_state != ServerState::ReadyManaged
        || state.snapshot.ownership != RuntimeOwnership::ManagedChild
    {
        return Err(ModelPullError::new(
            ModelPullErrorCode::ManagedServerRequired,
            "owner",
            false,
        ));
    }
    let Some(process) = state.process.as_mut() else {
        return Err(ModelPullError::new(
            ModelPullErrorCode::ManagedServerRequired,
            "owner",
            false,
        ));
    };
    if process.child.has_exited().unwrap_or(true) {
        return Err(ModelPullError::new(
            ModelPullErrorCode::ManagedServerRequired,
            "owner",
            true,
        ));
    }
    let base = url::Url::parse(&manager.settings.managed_base_url).map_err(|_| {
        ModelPullError::new(ModelPullErrorCode::ManagedServerRequired, "owner", false)
    })?;
    if !(cfg!(test) && is_loopback_endpoint(&base)
        || manager.settings.managed_base_url == DEFAULT_HOST_URL && is_loopback_endpoint(&base))
    {
        return Err(ModelPullError::new(
            ModelPullErrorCode::ManagedServerRequired,
            "owner",
            false,
        ));
    }
    Ok(())
}

fn start_model_pull_with_policy(
    manager: &RuntimeManager,
    app: Option<AppHandle>,
    tag: &str,
    confirmed_tag: &str,
    policy: QwenModelPolicy,
) -> Result<ModelPullStartResponse, ModelPullError> {
    let Some(candidate) = model_candidate(&policy, tag).cloned() else {
        return Err(ModelPullError::new(
            ModelPullErrorCode::ModelTagUnknown,
            "preflight",
            false,
        ));
    };
    if policy.pull_start_policy.as_deref() != Some("user_confirmed_exact_tag")
        || confirmed_tag != tag
    {
        return Err(ModelPullError::new(
            ModelPullErrorCode::ModelConfirmationRequired,
            "preflight",
            false,
        ));
    }
    let base = managed_pull_base(manager)?;
    let operation_id = next_operation_id();
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(manager.settings.request_timeout)
        .timeout(manager.settings.request_timeout)
        .build()
        .map_err(|_| {
            model_pull_error(
                ModelPullErrorCode::PullHttpFailed,
                "preflight",
                true,
                Some(&operation_id),
            )
        })?;
    let already_installed = match fetch_tags_sync(&client, &base, tag, Some(&operation_id)) {
        Ok(digest) => digest.is_some(),
        Err(error) => {
            record_model_pull_failure(manager, app.as_ref(), tag, &operation_id, error.clone());
            return Err(error);
        }
    };
    let mut pull_budget: Option<(PathBuf, u64)> = None;
    if !already_installed {
        let store = check_model_store(&policy).map_err(|error| {
            record_model_pull_failure(manager, app.as_ref(), tag, &operation_id, error.clone());
            error.for_operation(&operation_id)
        })?;
        let multiplier = policy.disk_space_multiplier.ok_or_else(|| {
            let error = model_pull_error(
                ModelPullErrorCode::DiskMarginUnset,
                "preflight",
                false,
                Some(&operation_id),
            );
            record_model_pull_failure(manager, app.as_ref(), tag, &operation_id, error.clone());
            error
        })?;
        let size_bytes = candidate.published_size_bytes.ok_or_else(|| {
            let error = model_pull_error(
                ModelPullErrorCode::DiskSpaceLow,
                "preflight",
                false,
                Some(&operation_id),
            );
            record_model_pull_failure(manager, app.as_ref(), tag, &operation_id, error.clone());
            error
        })?;
        let required = size_bytes.checked_mul(multiplier).ok_or_else(|| {
            let error = model_pull_error(
                ModelPullErrorCode::DiskSpaceLow,
                "preflight",
                false,
                Some(&operation_id),
            );
            record_model_pull_failure(manager, app.as_ref(), tag, &operation_id, error.clone());
            error
        })?;
        if store.available_bytes < required {
            let error = model_pull_error(
                ModelPullErrorCode::DiskSpaceLow,
                "preflight",
                true,
                Some(&operation_id),
            )
            .with_disk_space(required, store.available_bytes);
            record_model_pull_failure(manager, app.as_ref(), tag, &operation_id, error.clone());
            return Err(error);
        }
        // Recheck against the same filesystem immediately before reserving the operation.
        #[cfg(test)]
        let latest_free = match policy.available_bytes_override {
            Some(available_bytes) => available_bytes,
            None => fs2::available_space(&store.probe_directory).map_err(|_| {
                let error = model_pull_error(
                    ModelPullErrorCode::ModelStoreUnresolved,
                    "preflight",
                    false,
                    Some(&operation_id),
                );
                record_model_pull_failure(manager, app.as_ref(), tag, &operation_id, error.clone());
                error
            })?,
        };
        #[cfg(not(test))]
        let latest_free = fs2::available_space(&store.probe_directory).map_err(|_| {
            let error = model_pull_error(
                ModelPullErrorCode::ModelStoreUnresolved,
                "preflight",
                false,
                Some(&operation_id),
            );
            record_model_pull_failure(manager, app.as_ref(), tag, &operation_id, error.clone());
            error
        })?;
        if latest_free < required {
            let error = model_pull_error(
                ModelPullErrorCode::DiskSpaceLow,
                "preflight",
                true,
                Some(&operation_id),
            )
            .with_disk_space(required, latest_free);
            record_model_pull_failure(manager, app.as_ref(), tag, &operation_id, error.clone());
            return Err(error);
        }
        pull_budget = Some((store.probe_directory.clone(), required));
    }

    let initial_snapshot = ModelPullSnapshot {
        operation_id: Some(operation_id.clone()),
        tag: tag.to_string(),
        state: ModelPullState::Preflight,
        stage: "preflight".to_string(),
        digest: None,
        error: None,
    };
    let (cancel_sender, cancel_receiver) = tokio::sync::oneshot::channel();
    let completion = Arc::new((Mutex::new(false), Condvar::new()));
    {
        let mut state = manager.lock();
        if state.shutdown_requested
            || state.operation.is_some()
            || state.active_model_pull.is_some()
        {
            return Err(model_pull_error(
                ModelPullErrorCode::PullAlreadyActive,
                "preflight",
                true,
                Some(&operation_id),
            ));
        }
        if state.snapshot.server_state != ServerState::ReadyManaged
            || state.snapshot.ownership != RuntimeOwnership::ManagedChild
            || state.process.is_none()
        {
            return Err(model_pull_error(
                ModelPullErrorCode::ManagedServerRequired,
                "owner",
                false,
                Some(&operation_id),
            ));
        }
        state
            .model_pull_snapshots
            .insert(tag.to_string(), initial_snapshot.clone());
        state.active_model_pull = Some(ActiveModelPull {
            operation_id: operation_id.clone(),
            tag: tag.to_string(),
            cancel: Some(cancel_sender),
            completion: completion.clone(),
        });
    }
    emit_model_pull_snapshot(app.as_ref(), &initial_snapshot);

    let manager_worker = manager.clone();
    let app_worker = app.clone();
    let operation_id_worker = operation_id.clone();
    let tag_worker = tag.to_string();
    let candidate_worker = candidate.clone();
    let base_worker = base.clone();
    let completion_worker = completion.clone();
    let pull_budget_worker = pull_budget.clone();
    let worker = thread::Builder::new()
        .name("ollama-model-pull".to_string())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();
            let outcome = match runtime {
                Ok(runtime) => runtime.block_on(async {
                    let client = match model_pull_client(manager_worker.settings.request_timeout) {
                        Ok(client) => client,
                        Err(error) => return Err(error),
                    };
                    if !already_installed {
                        if let Some((directory, required_bytes)) = pull_budget_worker {
                            let available_bytes =
                                fs2::available_space(&directory).map_err(|_| {
                                    model_pull_error(
                                        ModelPullErrorCode::ModelStoreUnresolved,
                                        "preflight",
                                        false,
                                        Some(&operation_id_worker),
                                    )
                                })?;
                            if available_bytes < required_bytes {
                                return Err(model_pull_error(
                                    ModelPullErrorCode::DiskSpaceLow,
                                    "preflight",
                                    true,
                                    Some(&operation_id_worker),
                                )
                                .with_disk_space(required_bytes, available_bytes));
                            }
                        }
                        let _ = update_model_pull_snapshot(
                            &manager_worker,
                            app_worker.as_ref(),
                            &operation_id_worker,
                            ModelPullState::Pulling,
                            "pull",
                            None,
                            None,
                            false,
                        );
                        match stream_model_pull(
                            client.clone(),
                            base_worker.clone(),
                            operation_id_worker.clone(),
                            tag_worker.clone(),
                            app_worker.clone(),
                            cancel_receiver,
                        )
                        .await
                        {
                            Ok(false) => return Ok(None),
                            Ok(true) => {}
                            Err(error) => return Err(error),
                        }
                    }
                    let _ = update_model_pull_snapshot(
                        &manager_worker,
                        app_worker.as_ref(),
                        &operation_id_worker,
                        ModelPullState::Verifying,
                        "verify_tags",
                        None,
                        None,
                        false,
                    );
                    verify_model_async(
                        &client,
                        &base_worker,
                        &candidate_worker,
                        &operation_id_worker,
                    )
                    .await
                    .map(Some)
                }),
                Err(_) => Err(model_pull_error(
                    ModelPullErrorCode::PullHttpFailed,
                    "pull",
                    true,
                    Some(&operation_id_worker),
                )),
            };
            match outcome {
                Ok(None) => finish_model_pull(
                    &manager_worker,
                    app_worker.as_ref(),
                    &operation_id_worker,
                    ModelPullState::Paused,
                    "paused",
                    None,
                    None,
                    &completion_worker,
                ),
                Ok(Some(digest)) => finish_model_pull(
                    &manager_worker,
                    app_worker.as_ref(),
                    &operation_id_worker,
                    ModelPullState::Ready,
                    "ready",
                    Some(digest),
                    None,
                    &completion_worker,
                ),
                Err(error) => {
                    let stage = error.stage.clone();
                    finish_model_pull(
                        &manager_worker,
                        app_worker.as_ref(),
                        &operation_id_worker,
                        ModelPullState::Failed,
                        &stage,
                        None,
                        Some(error.for_operation(&operation_id_worker)),
                        &completion_worker,
                    )
                }
            }
        });
    if worker.is_err() {
        let error = model_pull_error(
            ModelPullErrorCode::PullHttpFailed,
            "pull",
            true,
            Some(&operation_id),
        );
        finish_model_pull(
            manager,
            app.as_ref(),
            &operation_id,
            ModelPullState::Failed,
            "pull",
            None,
            Some(error.clone()),
            &completion,
        );
        return Err(error);
    }
    Ok(ModelPullStartResponse {
        operation_id,
        snapshot: initial_snapshot,
    })
}

fn dispatch_model_pull_start(
    manager: &RuntimeManager,
    app: Option<AppHandle>,
    tag: &str,
    confirmed_tag: &str,
) -> Result<ModelPullStartResponse, ModelPullError> {
    let policy = app
        .as_ref()
        .map(qwen_model_policy_for_app)
        .unwrap_or_else(qwen_model_policy);
    start_model_pull_with_policy(manager, app, tag, confirmed_tag, policy)
}

fn dispatch_model_pull_retry(
    manager: &RuntimeManager,
    app: Option<AppHandle>,
    tag: &str,
) -> Result<ModelPullStartResponse, ModelPullError> {
    let policy = app
        .as_ref()
        .map(qwen_model_policy_for_app)
        .unwrap_or_else(qwen_model_policy);
    dispatch_model_pull_retry_with_policy(manager, app, tag, policy)
}

fn dispatch_model_pull_retry_with_policy(
    manager: &RuntimeManager,
    app: Option<AppHandle>,
    tag: &str,
    policy: QwenModelPolicy,
) -> Result<ModelPullStartResponse, ModelPullError> {
    let retryable = manager
        .lock()
        .model_pull_snapshots
        .get(tag)
        .is_some_and(|snapshot| match snapshot.state {
            ModelPullState::Paused => true,
            ModelPullState::Failed => snapshot.error.as_ref().is_some_and(|error| error.retryable),
            _ => false,
        });
    if !retryable {
        return Err(ModelPullError::new(
            ModelPullErrorCode::PullOperationUnknown,
            "retry",
            false,
        ));
    }
    start_model_pull_with_policy(manager, app, tag, tag, policy)
}

fn dispatch_model_pull_cancel(
    manager: &RuntimeManager,
    operation_id: &str,
) -> Result<ModelPullSnapshot, ModelPullError> {
    managed_owner_for_cancel(manager)?;
    let (tag, completion, cancel) = {
        let mut state = manager.lock();
        let Some(active) = state
            .active_model_pull
            .as_mut()
            .filter(|active| active.operation_id == operation_id)
        else {
            if let Some(snapshot) = state
                .model_pull_snapshots
                .values()
                .find(|snapshot| snapshot.operation_id.as_deref() == Some(operation_id))
                .filter(|snapshot| {
                    matches!(
                        snapshot.state,
                        ModelPullState::Paused | ModelPullState::Ready
                    )
                })
            {
                return Ok(snapshot.clone());
            }
            return Err(model_pull_error(
                ModelPullErrorCode::PullOperationUnknown,
                "cancel",
                false,
                Some(operation_id),
            ));
        };
        (
            active.tag.clone(),
            active.completion.clone(),
            active.cancel.take(),
        )
    };
    if let Some(cancel) = cancel {
        let _ = cancel.send(());
    }
    if !wait_for_model_pull(&completion, MODEL_PULL_CANCEL_TIMEOUT) {
        return Err(model_pull_error(
            ModelPullErrorCode::PullCancelTimeout,
            "cancel",
            true,
            Some(operation_id),
        ));
    }
    manager
        .lock()
        .model_pull_snapshots
        .get(&tag)
        .cloned()
        .ok_or_else(|| {
            model_pull_error(
                ModelPullErrorCode::PullOperationUnknown,
                "cancel",
                false,
                Some(operation_id),
            )
        })
}

fn dispatch_model_pull_status(
    manager: &RuntimeManager,
    app: Option<&AppHandle>,
    tag: &str,
) -> Result<ModelPullSnapshot, ModelPullError> {
    let policy = qwen_model_policy();
    let Some(candidate) = model_candidate(&policy, tag) else {
        return Err(ModelPullError::new(
            ModelPullErrorCode::ModelTagUnknown,
            "status",
            false,
        ));
    };
    let current = manager
        .lock()
        .model_pull_snapshots
        .get(tag)
        .cloned()
        .unwrap_or_else(|| ModelPullSnapshot {
            operation_id: None,
            tag: tag.to_string(),
            state: ModelPullState::Absent,
            stage: "absent".to_string(),
            digest: None,
            error: None,
        });
    if current.state != ModelPullState::Ready || manager.lock().active_model_pull.is_some() {
        return Ok(current);
    }
    let base = managed_pull_base(manager)?;
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(manager.settings.request_timeout)
        .timeout(manager.settings.request_timeout)
        .build()
        .map_err(|_| ModelPullError::new(ModelPullErrorCode::PullHttpFailed, "status", true))?;
    let operation_id = current.operation_id.as_deref().ok_or_else(|| {
        ModelPullError::new(ModelPullErrorCode::PullOperationUnknown, "status", false)
    })?;
    let result = verify_model_sync(&client, &base, candidate, operation_id);
    let snapshot = match result {
        Ok(digest) => ModelPullSnapshot {
            digest: Some(digest),
            ..current
        },
        Err(error) => ModelPullSnapshot {
            state: if error.code == ModelPullErrorCode::ModelTagAbsent {
                ModelPullState::Absent
            } else {
                ModelPullState::Failed
            },
            stage: error.stage.clone(),
            digest: None,
            error: Some(error),
            ..current
        },
    };
    manager
        .lock()
        .model_pull_snapshots
        .insert(tag.to_string(), snapshot.clone());
    emit_model_pull_snapshot(app, &snapshot);
    Ok(snapshot)
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

fn mark_managed_reservation_running(manager: &RuntimeManager, generation: u64) -> bool {
    let mut state = manager.lock();
    let Some(process) = state
        .process
        .as_mut()
        .filter(|process| process.generation == generation)
    else {
        return false;
    };
    let Some(lease) = process.reservation.as_ref() else {
        return false;
    };
    let running = match lease.snapshot() {
        Some(snapshot)
            if snapshot.status == crate::vram_reservation::ReservationStatus::Running =>
        {
            true
        }
        Some(_) => lease.mark_running(),
        None => false,
    };
    if running {
        state.snapshot.reservation = ReservationSnapshot::from_lease(lease)
            .unwrap_or_else(|| ReservationSnapshot::denied("reservation_lease_lost"));
    }
    running
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
    manager.set_reservation_snapshot(ReservationSnapshot::default());
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
            state.snapshot.reservation = if error.code == RuntimeErrorCode::ReservationLeaseLost {
                ReservationSnapshot::denied("reservation_lease_lost")
            } else {
                ReservationSnapshot::default()
            };
            (error, RuntimeOwnership::None)
        } else {
            let version = process_ref.version.clone();
            let mut state = manager.lock();
            state.active_versions.insert(version);
            state.snapshot.reservation = process_ref
                .reservation
                .as_ref()
                .and_then(ReservationSnapshot::from_lease)
                .unwrap_or_else(|| ReservationSnapshot::denied("reservation_lease_lost"));
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
    device_id: Option<String>,
    operation_id: String,
) {
    log_ollama_debug(
        "start.worker_enter",
        Some(&operation_id),
        &format!("host_scope={:?}", endpoint.scope),
    );
    let model_store = app.as_ref().and_then(app_managed_model_store_path);
    if app.is_some() && model_store.is_none() {
        finish_start_error(
            &manager,
            app.as_ref(),
            &operation_id,
            RuntimeError::new(RuntimeErrorCode::SpawnFailed, "model_store", false),
        );
        return;
    }
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
                        if !mark_managed_reservation_running(&manager, generation) {
                            finish_start_with_process_error(
                                &manager,
                                app.as_ref(),
                                &operation_id,
                                generation,
                                RuntimeError::new(
                                    RuntimeErrorCode::ReservationLeaseLost,
                                    "reservation",
                                    true,
                                )
                                .with_reason_code("reservation_lease_lost"),
                            );
                            return;
                        }
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
            update_operation_snapshot(
                &manager,
                &operation_id,
                &versions,
                installed_version.as_deref(),
                ServerState::Reserving,
                RuntimeOwnership::ExternalLocal,
                Some(model_count),
                "reserving",
            );
            emit_manager_snapshot(app.as_ref(), &manager);
            match reserve_external_local(&manager, endpoint.url.as_str(), device_id.as_deref()) {
                ExternalAdmission::Reserved(reservation) => {
                    manager.set_reservation_snapshot(reservation);
                    manager.finish_server_operation(
                        &operation_id,
                        versions,
                        installed_version,
                        ServerState::ReadyExternalLocal,
                        RuntimeOwnership::ExternalLocal,
                        Some(model_count),
                        None,
                    );
                }
                ExternalAdmission::InProgress => {
                    manager.set_reservation_snapshot(ReservationSnapshot::starting());
                    manager.finish_server_operation(
                        &operation_id,
                        versions,
                        installed_version,
                        ServerState::Reserving,
                        RuntimeOwnership::ExternalLocal,
                        Some(model_count),
                        None,
                    );
                }
                ExternalAdmission::Denied(error) => {
                    let reason_code = error.reason_code.as_deref().unwrap_or("reservation_denied");
                    manager.set_reservation_snapshot(ReservationSnapshot::denied(reason_code));
                    manager.finish_server_operation(
                        &operation_id,
                        versions,
                        installed_version,
                        ServerState::ConnectedUnreserved,
                        RuntimeOwnership::ExternalLocal,
                        Some(model_count),
                        Some(error),
                    );
                }
            }
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

    if endpoint.scope == EndpointScope::ManagedDefault {
        release_external_reservation_for_host(&manager, endpoint.url.as_str());
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
        ServerState::Reserving,
        RuntimeOwnership::None,
        None,
        "reserving",
    );
    emit_manager_snapshot(app.as_ref(), &manager);
    let (lease, _selected_device_id, device_selector) =
        match manager.try_reserve_local(device_id.as_deref()) {
            Ok(reservation) => reservation,
            Err(error) => {
                let reason_code = error.reason_code.as_deref().unwrap_or("reservation_denied");
                manager.set_reservation_snapshot(ReservationSnapshot::denied(reason_code));
                manager.finish_server_operation(
                    &operation_id,
                    versions,
                    Some(version),
                    ServerState::Failed,
                    RuntimeOwnership::None,
                    None,
                    Some(error),
                );
                emit_manager_snapshot(app.as_ref(), &manager);
                return;
            }
        };
    let mut pending_reservation = Some(lease);
    manager.set_reservation_snapshot(
        ReservationSnapshot::from_lease(
            pending_reservation
                .as_ref()
                .expect("reserved lease is present before spawn"),
        )
        .unwrap_or_else(|| ReservationSnapshot::denied("reservation_lease_lost")),
    );
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
    let mut environment = BTreeMap::from([
        (
            std::ffi::OsString::from("OLLAMA_HOST"),
            std::ffi::OsString::from(managed_host),
        ),
        (
            std::ffi::OsString::from("CUDA_VISIBLE_DEVICES"),
            std::ffi::OsString::from(device_selector),
        ),
    ]);
    if let Some(model_store) = model_store {
        environment.insert(
            std::ffi::OsString::from("OLLAMA_MODELS"),
            model_store.into_os_string(),
        );
    }
    let spec = ProcessSpec {
        executable,
        arguments: vec!["serve".to_string()],
        environment,
        inherit_environment: true,
    };
    let child = match manager.process_runner.spawn(&spec) {
        Ok(child) => child,
        Err(error) => {
            drop(pending_reservation.take());
            manager.set_reservation_snapshot(ReservationSnapshot::default());
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
        if state.shutdown_requested
            || !operation_is_current
            || state.process.is_some()
            || !state.unreaped_processes.is_empty()
        {
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
                reservation: pending_reservation.take(),
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
                version: version.clone(),
                generation: 0,
                reservation: pending_reservation.take(),
            };
            if stop_managed_process(&mut pending, &manager.settings) {
                drop(pending);
                manager.set_reservation_snapshot(ReservationSnapshot::default());
                finish_start_error(
                    &manager,
                    app.as_ref(),
                    &operation_id,
                    RuntimeError::new(RuntimeErrorCode::RuntimeBusy, "register", true),
                );
            } else {
                let mut state = manager.lock();
                state.active_versions.insert(version);
                state.snapshot.server_state = ServerState::Failed;
                state.snapshot.ownership = RuntimeOwnership::ManagedChild;
                state.snapshot.reservation = pending
                    .reservation
                    .as_ref()
                    .and_then(ReservationSnapshot::from_lease)
                    .unwrap_or_else(|| ReservationSnapshot::denied("reservation_lease_lost"));
                state.snapshot.error = Some(RuntimeError::new(
                    RuntimeErrorCode::StopFailed,
                    "register",
                    true,
                ));
                state.snapshot.phase = None;
                state.snapshot.operation_id = Some(operation_id.clone());
                state.operation = None;
                state.unreaped_processes.push(pending);
                drop(state);
                emit_manager_snapshot(app.as_ref(), &manager);
            }
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
                if !mark_managed_reservation_running(&manager, generation) {
                    finish_start_with_process_error(
                        &manager,
                        app.as_ref(),
                        &operation_id,
                        generation,
                        RuntimeError::new(
                            RuntimeErrorCode::ReservationLeaseLost,
                            "reservation",
                            true,
                        )
                        .with_reason_code("reservation_lease_lost"),
                    );
                    return;
                }
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
                state.snapshot.reservation = ReservationSnapshot::default();
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
                state.snapshot.reservation = process
                    .reservation
                    .as_ref()
                    .and_then(ReservationSnapshot::from_lease)
                    .unwrap_or_else(|| ReservationSnapshot::denied("reservation_lease_lost"));
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
                device_id,
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
    log_ollama_debug("stop.enter", None, "managed_or_external_lease_check=true");
    {
        let state = manager.lock();
        if state.operation.is_some() || state.active_model_pull.is_some() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::RuntimeBusy,
                "dispatch",
                true,
            ));
        }
        if state.process.is_none()
            && state.unreaped_processes.is_empty()
            && state.external_reservation.is_none()
            && state.external_reservation_pending.is_none()
        {
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
        "operation_guard=held",
    );
    emit_manager_snapshot(app.as_ref(), manager);
    let manager_worker = manager.clone();
    let operation_id_worker = operation_id.clone();
    let spawn = thread::Builder::new()
        .name("ollama-runtime-stop".to_string())
        .spawn(move || {
            let (mut processes, external_reservation, external_was_connected) = {
                let mut state = manager_worker.lock();
                let external_was_connected = state.external_reservation.is_some()
                    || state.external_reservation_pending.is_some();
                state.external_reservation_generation =
                    state.external_reservation_generation.wrapping_add(1).max(1);
                state.external_reservation_pending = None;
                let mut processes = std::mem::take(&mut state.unreaped_processes);
                if let Some(process) = state.process.take() {
                    processes.push(process);
                }
                (
                    processes,
                    state.external_reservation.take(),
                    external_was_connected,
                )
            };
            drop(external_reservation);
            let mut unreaped = Vec::new();
            let mut stopped_versions = Vec::new();
            for mut process in processes.drain(..) {
                let version = process.version.clone();
                if stop_managed_process(&mut process, &manager_worker.settings) {
                    log_ollama_debug(
                        "stop.process_tree_reaped",
                        Some(&operation_id_worker),
                        &format!("version={version}"),
                    );
                    stopped_versions.push(version);
                    drop(process);
                } else {
                    log_ollama_debug(
                        "stop.process_tree_unconfirmed",
                        Some(&operation_id_worker),
                        &format!("version={version} error=stop_failed"),
                    );
                    unreaped.push(process);
                }
            }
            let snapshot = manager_worker.snapshot();
            if unreaped.is_empty() {
                {
                    let mut state = manager_worker.lock();
                    for version in stopped_versions {
                        state.active_versions.remove(&version);
                    }
                    state.snapshot.reservation = ReservationSnapshot::default();
                }
                let (server_state, ownership, model_count) = if external_was_connected {
                    (
                        ServerState::ConnectedUnreserved,
                        RuntimeOwnership::ExternalLocal,
                        snapshot.model_count,
                    )
                } else {
                    (ServerState::Stopped, RuntimeOwnership::None, None)
                };
                manager_worker.finish_server_operation(
                    &operation_id_worker,
                    snapshot.installed_versions,
                    snapshot.installed_version,
                    server_state,
                    ownership,
                    model_count,
                    None,
                );
            } else {
                let mut state = manager_worker.lock();
                for process in &unreaped {
                    state.active_versions.insert(process.version.clone());
                }
                state.snapshot.server_state = ServerState::Failed;
                state.snapshot.ownership = RuntimeOwnership::ManagedChild;
                state.snapshot.reservation = unreaped
                    .first()
                    .and_then(|process| process.reservation.as_ref())
                    .and_then(ReservationSnapshot::from_lease)
                    .unwrap_or_else(|| ReservationSnapshot::denied("reservation_lease_lost"));
                state.unreaped_processes = unreaped;
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
    device_id: Option<&str>,
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
        match process_state.as_ref() {
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
            Some((_, version, Ok(false))) => Some(version.clone()),
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
        ProbeResult::Ready { model_count } => match endpoint.scope {
            EndpointScope::ManagedDefault if managed_version.is_some() => {
                let process_reservation = {
                    let state = manager.lock();
                    state.process.as_ref().and_then(|process| {
                        (Some(process.generation)
                            == process_state.as_ref().map(|current| current.0))
                        .then(|| {
                            process
                                .reservation
                                .as_ref()
                                .and_then(ReservationSnapshot::from_lease)
                        })
                        .flatten()
                    })
                };
                match process_reservation {
                    Some(reservation) if reservation.status == ReservationStatus::Running => {
                        snapshot.server_state = ServerState::ReadyManaged;
                        snapshot.ownership = RuntimeOwnership::ManagedChild;
                        snapshot.reservation = reservation;
                        snapshot.model_count = Some(model_count);
                    }
                    _ => {
                        snapshot.server_state = ServerState::Failed;
                        snapshot.ownership = RuntimeOwnership::ManagedChild;
                        snapshot.reservation =
                            ReservationSnapshot::denied("reservation_lease_lost");
                        snapshot.error = Some(
                            RuntimeError::new(
                                RuntimeErrorCode::ReservationLeaseLost,
                                "reservation",
                                true,
                            )
                            .with_reason_code("reservation_lease_lost"),
                        );
                    }
                }
            }
            EndpointScope::ManagedDefault | EndpointScope::Loopback => {
                snapshot.model_count = Some(model_count);
                snapshot.ownership = RuntimeOwnership::ExternalLocal;
                match reserve_external_local(manager, endpoint.url.as_str(), device_id) {
                    ExternalAdmission::Reserved(reservation) => {
                        snapshot.server_state = ServerState::ReadyExternalLocal;
                        snapshot.reservation = reservation;
                    }
                    ExternalAdmission::InProgress => {
                        snapshot.server_state = ServerState::Reserving;
                        snapshot.reservation = ReservationSnapshot::starting();
                    }
                    ExternalAdmission::Denied(error) => {
                        let reason_code =
                            error.reason_code.as_deref().unwrap_or("reservation_denied");
                        snapshot.server_state = ServerState::ConnectedUnreserved;
                        snapshot.reservation = ReservationSnapshot::denied(reason_code);
                        snapshot.error = Some(error);
                    }
                }
            }
            EndpointScope::Remote => {
                snapshot.server_state = ServerState::ReadyRemote;
                snapshot.ownership = RuntimeOwnership::Remote;
                snapshot.model_count = Some(model_count);
            }
        },
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
    let pull_completion = {
        let mut state = manager.lock();
        state.shutdown_requested = true;
        state.active_model_pull.as_mut().map(|active| {
            if let Some(cancel) = active.cancel.take() {
                let _ = cancel.send(());
            }
            active.completion.clone()
        })
    };
    if let Some(completion) = pull_completion {
        if !wait_for_model_pull(&completion, MODEL_PULL_CANCEL_TIMEOUT) {
            log_ollama_debug(
                "shutdown.pull_cancel_unconfirmed",
                None,
                "managed_child_and_reservation_retained=true",
            );
            return;
        }
    }
    let (mut processes, external_reservation) = {
        let mut state = manager.lock();
        state.shutdown_requested = true;
        state.operation = None;
        state.snapshot.phase = None;
        state.external_reservation_generation =
            state.external_reservation_generation.wrapping_add(1).max(1);
        state.external_reservation_pending = None;
        let mut processes = std::mem::take(&mut state.unreaped_processes);
        if let Some(process) = state.process.take() {
            processes.push(process);
        }
        let external_reservation = state.external_reservation.take();
        if !processes.is_empty() {
            state.snapshot.server_state = ServerState::Stopping;
            state.snapshot.ownership = RuntimeOwnership::ManagedChild;
        }
        (processes, external_reservation)
    };
    let had_external_reservation = external_reservation.is_some();
    drop(external_reservation);
    let mut unreaped = Vec::new();
    let mut stopped_versions = Vec::new();
    for mut process in processes.drain(..) {
        let version = process.version.clone();
        if stop_managed_process(&mut process, &manager.settings) {
            log_ollama_debug(
                "shutdown.process_tree_reaped",
                None,
                "ownership=managed_child",
            );
            stopped_versions.push(version);
            drop(process);
        } else {
            log_ollama_debug(
                "shutdown.process_tree_unconfirmed",
                None,
                "error=stop_failed",
            );
            unreaped.push(process);
        }
    }
    let mut state = manager.lock();
    for version in stopped_versions {
        state.active_versions.remove(&version);
    }
    if unreaped.is_empty() {
        if had_external_reservation {
            state.snapshot.server_state = ServerState::ConnectedUnreserved;
            state.snapshot.ownership = RuntimeOwnership::ExternalLocal;
            state.snapshot.error = None;
        } else if state.snapshot.ownership == RuntimeOwnership::ManagedChild
            || state.snapshot.server_state == ServerState::Stopping
        {
            state.snapshot.state = install_state_from_versions(&state.snapshot.installed_versions);
            state.snapshot.server_state = ServerState::Stopped;
            state.snapshot.ownership = RuntimeOwnership::None;
            state.snapshot.model_count = None;
            state.snapshot.error = None;
        }
        state.snapshot.reservation = ReservationSnapshot::default();
    } else {
        for process in &unreaped {
            state.active_versions.insert(process.version.clone());
        }
        state.snapshot.server_state = ServerState::Failed;
        state.snapshot.ownership = RuntimeOwnership::ManagedChild;
        state.snapshot.reservation = unreaped
            .first()
            .and_then(|process| process.reservation.as_ref())
            .and_then(ReservationSnapshot::from_lease)
            .unwrap_or_else(|| ReservationSnapshot::denied("reservation_lease_lost"));
        state.snapshot.error = Some(RuntimeError::new(
            RuntimeErrorCode::StopFailed,
            "shutdown",
            true,
        ));
        state.unreaped_processes = unreaped;
    }
}

#[tauri::command]
pub(crate) fn ollama_runtime_status(
    host: Option<String>,
    device_id: Option<String>,
    app: AppHandle,
    manager: State<'_, RuntimeManager>,
) -> Result<RuntimeSnapshot, RuntimeError> {
    log::debug!("OllamaRuntime::status host_value_redacted=true");
    let snapshot = status_snapshot(&manager, host.as_deref(), device_id.as_deref())?;
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
) -> Result<String, StopCommandError> {
    if let Some(active) = manager.lock().active_model_pull.as_ref() {
        return Err(StopCommandError::ModelPull(
            ModelPullError::new(ModelPullErrorCode::ModelPullActive, "stop", true)
                .for_operation(&active.operation_id),
        ));
    }
    dispatch_stop(&manager, Some(app)).map_err(|error| {
        if error.code == RuntimeErrorCode::RuntimeBusy {
            if let Some(active) = manager.lock().active_model_pull.as_ref() {
                return StopCommandError::ModelPull(
                    ModelPullError::new(ModelPullErrorCode::ModelPullActive, "stop", true)
                        .for_operation(&active.operation_id),
                );
            }
        }
        StopCommandError::Runtime(error)
    })
}

#[tauri::command]
pub(crate) fn ollama_model_catalog_list(app: AppHandle) -> QwenModelPolicy {
    qwen_model_policy_for_app(&app)
}

#[tauri::command]
pub(crate) fn ollama_model_pull_status(
    tag: String,
    app: AppHandle,
    manager: State<'_, RuntimeManager>,
) -> Result<ModelPullSnapshot, ModelPullError> {
    dispatch_model_pull_status(&manager, Some(&app), &tag)
}

#[tauri::command]
pub(crate) fn ollama_model_pull_start(
    tag: String,
    confirmed_tag: String,
    app: AppHandle,
    manager: State<'_, RuntimeManager>,
) -> Result<ModelPullStartResponse, ModelPullError> {
    dispatch_model_pull_start(&manager, Some(app), &tag, &confirmed_tag)
}

#[tauri::command]
pub(crate) fn ollama_model_pull_cancel(
    operation_id: String,
    manager: State<'_, RuntimeManager>,
) -> Result<ModelPullSnapshot, ModelPullError> {
    dispatch_model_pull_cancel(&manager, &operation_id)
}

#[tauri::command]
pub(crate) fn ollama_model_pull_retry(
    tag: String,
    app: AppHandle,
    manager: State<'_, RuntimeManager>,
) -> Result<ModelPullStartResponse, ModelPullError> {
    dispatch_model_pull_retry(&manager, Some(app), &tag)
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

    #[cfg(windows)]
    static WINDOWS_CONSOLE_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[cfg(windows)]
    #[test]
    fn ollama_no_window_child_supports_ctrl_break_shutdown() {
        use windows_sys::Win32::System::Console::GetConsoleWindow;

        let _guard = WINDOWS_CONSOLE_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        let spec = ProcessSpec {
            executable: PathBuf::from("powershell.exe"),
            arguments: vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-NonInteractive".to_string(),
                "-Command".to_string(),
                "Start-Sleep -Seconds 60".to_string(),
            ],
            environment: BTreeMap::new(),
            inherit_environment: true,
        };
        let mut child = SystemProcessRunner
            .spawn(&spec)
            .expect("spawn suspended no-window PowerShell child");
        let child_pid = child.child_pid_for_test().expect("managed child PID");
        thread::sleep(Duration::from_millis(500));

        let still_running_before_shutdown = child.has_exited().map(|exited| !exited);
        let parent_had_console = !unsafe { GetConsoleWindow() }.is_null();
        let windowless =
            with_attached_child_console(child_pid, || Ok(unsafe { GetConsoleWindow() }.is_null()));
        let parent_console_restored_after_inspection =
            !unsafe { GetConsoleWindow() }.is_null() == parent_had_console;
        let ctrl_break = child.request_graceful_shutdown();
        let parent_console_restored_after_shutdown =
            !unsafe { GetConsoleWindow() }.is_null() == parent_had_console;
        let deadline = Instant::now() + GRACEFUL_STOP_TIMEOUT;
        let mut exited = false;
        if ctrl_break.is_ok() {
            while Instant::now() < deadline {
                match child.has_exited() {
                    Ok(true) => {
                        exited = true;
                        break;
                    }
                    Ok(false) => thread::sleep(Duration::from_millis(25)),
                    Err(_) => break,
                }
            }
        }
        if !exited {
            let _ = child.force_kill_tree();
        }

        assert!(
            matches!(still_running_before_shutdown, Ok(true)),
            "the PowerShell child exited before the shutdown signal: {still_running_before_shutdown:?}"
        );
        assert!(
            matches!(windowless, Ok(true)),
            "expected no console window after attaching, got {windowless:?}"
        );
        assert!(
            parent_console_restored_after_inspection && parent_console_restored_after_shutdown,
            "attaching to or signaling the child changed the test process console state"
        );
        assert!(
            ctrl_break.is_ok(),
            "existing CTRL_BREAK shutdown path failed: {ctrl_break:?}"
        );
        assert!(
            exited,
            "the child did not exit within {GRACEFUL_STOP_TIMEOUT:?} after CTRL_BREAK"
        );
    }

    #[cfg(target_os = "linux")]
    static REAL_PROCESS_GROUP_TEST_LOCK: Mutex<()> = Mutex::new(());

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
        model_pull: Option<Arc<ModelPullApiFixture>>,
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
                model_pull: None,
            }
        }

        fn with_model_pull(mut self, fixture: Arc<ModelPullApiFixture>) -> Self {
            self.model_pull = Some(fixture);
            self
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
        listening: Arc<AtomicBool>,
        #[cfg(target_os = "linux")]
        listen_fd: std::os::fd::RawFd,
        fixture: Arc<Mutex<ApiFixture>>,
        worker: Option<thread::JoinHandle<()>>,
    }

    impl TestApiServer {
        fn bind(address: impl std::net::ToSocketAddrs, fixture: ApiFixture) -> io::Result<Self> {
            let listener = std::net::TcpListener::bind(address)?;
            listener.set_nonblocking(true)?;
            Self::from_listener(listener, true, fixture)
        }

        #[cfg(target_os = "linux")]
        fn reserve_unlistened(
            address: std::net::SocketAddrV4,
            fixture: ApiFixture,
        ) -> io::Result<Self> {
            use std::os::fd::FromRawFd;

            let fd = unsafe {
                libc::socket(
                    libc::AF_INET,
                    libc::SOCK_STREAM | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
                    0,
                )
            };
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            let socket = unsafe { std::net::TcpListener::from_raw_fd(fd) };
            let address = libc::sockaddr_in {
                sin_family: libc::AF_INET as libc::sa_family_t,
                sin_port: address.port().to_be(),
                sin_addr: libc::in_addr {
                    s_addr: u32::from_ne_bytes(address.ip().octets()),
                },
                sin_zero: [0; 8],
            };
            let bound = unsafe {
                libc::bind(
                    fd,
                    (&address as *const libc::sockaddr_in).cast(),
                    std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t,
                )
            };
            if bound < 0 {
                return Err(io::Error::last_os_error());
            }
            Self::from_listener(socket, false, fixture)
        }

        fn from_listener(
            listener: std::net::TcpListener,
            is_listening: bool,
            fixture: ApiFixture,
        ) -> io::Result<Self> {
            listener.set_nonblocking(true)?;
            let address = listener.local_addr()?;
            #[cfg(target_os = "linux")]
            let listen_fd = {
                use std::os::fd::AsRawFd;
                listener.as_raw_fd()
            };
            let stopped = Arc::new(AtomicBool::new(false));
            let worker_stopped = stopped.clone();
            let listening = Arc::new(AtomicBool::new(is_listening));
            let worker_listening = listening.clone();
            let fixture = Arc::new(Mutex::new(fixture));
            let worker_fixture = fixture.clone();
            let worker = thread::spawn(move || {
                while !worker_stopped.load(Ordering::Acquire) {
                    if !worker_listening.load(Ordering::Acquire) {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            let fixture = worker_fixture.lock().unwrap().clone();
                            if let Some(model_pull) = fixture.model_pull {
                                serve_model_pull_fixture(stream, model_pull);
                            } else {
                                serve_fixture_request(&mut stream, &fixture);
                            }
                        }
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
                listening,
                #[cfg(target_os = "linux")]
                listen_fd,
                fixture,
                worker: Some(worker),
            })
        }

        fn base_url(&self) -> String {
            format!("http://{}", self.address)
        }

        fn stop(&self) {
            self.stopped.store(true, Ordering::Release);
        }

        fn set_fixture(&self, fixture: ApiFixture) {
            *self.fixture.lock().unwrap() = fixture;
        }

        #[cfg(target_os = "linux")]
        fn listen(&self) {
            if self.listening.load(Ordering::Acquire) {
                return;
            }
            let result = unsafe { libc::listen(self.listen_fd, 128) };
            assert_eq!(result, 0, "failed to activate the reserved test API socket");
            self.listening.store(true, Ordering::Release);
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
    fn shell_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }

    #[cfg(target_os = "linux")]
    fn write_fake_executable_install(
        root: &Path,
        pin: ReleasePin,
        pid_file: &Path,
        reaped_file: &Path,
    ) {
        use std::os::unix::fs::PermissionsExt;

        let script = format!(
            "#!/bin/sh\nset -eu\npid_file={}\nreaped_file={}\ndescendant=\ntrap 'if [ -n \"$descendant\" ]; then wait \"$descendant\" 2>/dev/null || :; fi; printf \"descendant reaped\" > \"$reaped_file\"; exit 0' TERM\n/bin/sleep 60 &\ndescendant=$!\nprintf '%s' \"$descendant\" > \"$pid_file\"\nwait \"$descendant\"\n",
            shell_quote(&pid_file.to_string_lossy()),
            shell_quote(&reaped_file.to_string_lossy()),
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
        fixture_pid_file: &Path,
    ) -> RuntimeManager {
        RuntimeManager {
            inner: Arc::new(Mutex::new(ManagerState::default())),
            downloader: Arc::new(FixtureDownloader::succeeding(Vec::new())),
            process_runner: Arc::new(FixtureStartBarrierRunner {
                pid_file: fixture_pid_file.to_path_buf(),
            }),
            reservation_manager: ReservationManager::default(),
            inventory_loader: Arc::new(e2e_fake_accelerator_inventory),
            settings: RuntimeSettings {
                managed_base_url: format!("http://127.0.0.1:{port}"),
                request_timeout: Duration::from_millis(30),
                readiness_timeout: Duration::from_secs(10),
                poll_interval: Duration::from_millis(5),
                graceful_stop_timeout: Duration::from_secs(5),
                force_stop_timeout: Duration::from_secs(2),
            },
            locations: Some((anchor.path().to_path_buf(), root.to_path_buf())),
            release_pin: Some(pin),
        }
    }

    #[cfg(target_os = "linux")]
    struct FixtureStartBarrierRunner {
        pid_file: PathBuf,
    }

    #[cfg(target_os = "linux")]
    impl RuntimeProcessRunner for FixtureStartBarrierRunner {
        fn spawn(&self, spec: &ProcessSpec) -> io::Result<Box<dyn ManagedChild>> {
            let mut child = SystemProcessRunner.spawn(spec)?;
            let deadline = Instant::now() + Duration::from_secs(10);
            while !self.pid_file.exists() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(5));
            }
            if !self.pid_file.exists() {
                let _ = stop_managed_child(child.as_mut(), &RuntimeSettings::default());
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "fake managed child did not complete its startup handshake",
                ));
            }
            Ok(child)
        }
    }

    #[cfg(target_os = "linux")]
    fn wait_for_fixture_reap_marker(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !path.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(path.exists(), "fake executable did not reap its descendant");
    }

    #[cfg(target_os = "linux")]
    fn wait_for_fixture_pid_file(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !path.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(
            path.exists(),
            "fake executable did not spawn its descendant"
        );
    }

    #[cfg(target_os = "linux")]
    fn process_group_test_api() -> TestApiServer {
        // Keep the ephemeral port bound but not listening until the fake child
        // starts. This preserves the real launch probe's connection-refused
        // result while preventing parallel tests from claiming the port.
        TestApiServer::reserve_unlistened(
            std::net::SocketAddrV4::new(std::net::Ipv4Addr::LOCALHOST, 0),
            ApiFixture::ready(0),
        )
        .unwrap()
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
        fail_spawn: AtomicBool,
        invalidate_reservation_on_spawn: AtomicBool,
        reservation_manager_on_spawn: Mutex<Option<ReservationManager>>,
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
                fail_spawn: AtomicBool::new(false),
                invalidate_reservation_on_spawn: AtomicBool::new(false),
                reservation_manager_on_spawn: Mutex::new(None),
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
            if self.state.fail_spawn.load(Ordering::Acquire) {
                return Err(io::Error::other("injected spawn failure"));
            }
            if let Some(manager) = self.state.shutdown_manager_on_spawn.lock().unwrap().take() {
                manager.shutdown();
            }
            if self
                .state
                .invalidate_reservation_on_spawn
                .load(Ordering::Acquire)
            {
                if let Some(manager) = self
                    .state
                    .reservation_manager_on_spawn
                    .lock()
                    .unwrap()
                    .take()
                {
                    manager.release_workload_for_test(
                        "vulkan:uuid:00112233445566778899aabbccddeeff",
                        LocalModelKind::LocalLlm,
                        OLLAMA_WORKLOAD_ID,
                    );
                }
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
        test_manager_with_inventory(
            anchor,
            root,
            port,
            runner,
            pin,
            downloader,
            installed,
            e2e_fake_accelerator_inventory(),
        )
    }

    fn test_manager_with_inventory(
        anchor: &tempfile::TempDir,
        root: &Path,
        port: u16,
        runner: &Arc<FakeRunner>,
        pin: ReleasePin,
        downloader: Arc<dyn ArtifactDownloader>,
        installed: bool,
        inventory: AcceleratorInventory,
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
            reservation_manager: ReservationManager::default(),
            inventory_loader: Arc::new(move || inventory.clone()),
            settings: test_settings(port),
            locations: Some((anchor.path().to_path_buf(), root.to_path_buf())),
            release_pin: Some(pin),
        }
    }

    fn local_llm_device_id() -> &'static str {
        "vulkan:uuid:00112233445566778899aabbccddeeff"
    }

    fn inventory_with_total_vram(total_vram_bytes: Option<u64>) -> AcceleratorInventory {
        let mut inventory = e2e_fake_accelerator_inventory();
        inventory.devices[0].total_vram_bytes = total_vram_bytes;
        inventory.devices[0].available_vram_bytes = Some(7 * 1024 * 1024 * 1024);
        inventory
    }

    fn reserve_test_voice(
        manager: &RuntimeManager,
        inventory: &AcceleratorInventory,
    ) -> ReservationLease {
        manager
            .reservation_manager
            .try_reserve_with_inventory(
                LocalModelRequest {
                    device_id: local_llm_device_id().to_string(),
                    kind: LocalModelKind::Voice,
                    workload_id: "voice-fixture".to_string(),
                    reservation_bytes: Some(256 * 1024 * 1024),
                },
                inventory,
            )
            .expect("fake Voice lease is admitted")
    }

    #[test]
    fn repeated_workload_id_cannot_create_a_second_local_lease() {
        let inventory = e2e_fake_accelerator_inventory();
        let manager = ReservationManager::default();
        let request = LocalModelRequest {
            device_id: local_llm_device_id().to_string(),
            kind: LocalModelKind::LocalLlm,
            workload_id: OLLAMA_WORKLOAD_ID.to_string(),
            reservation_bytes: None,
        };
        let lease = manager
            .try_reserve_with_inventory(request.clone(), &inventory)
            .unwrap();
        let duplicate = manager
            .try_reserve_with_inventory(request, &inventory)
            .unwrap_err();
        assert_eq!(duplicate.reason.code(), "workload_already_reserved");
        assert_eq!(
            manager.reservations_for_device(local_llm_device_id()).len(),
            1
        );
        drop(lease);
        assert!(manager
            .reservations_for_device(local_llm_device_id())
            .is_empty());
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
        wait_for_snapshot(manager, Duration::from_secs(10), |snapshot| {
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

        let operation = dispatch_start(&manager, None, None, None).unwrap();
        let snapshot = wait_for_operation(&manager, &operation);
        assert_eq!(snapshot.server_state, ServerState::ReadyManaged);
        assert_eq!(snapshot.ownership, RuntimeOwnership::ManagedChild);
        assert_eq!(snapshot.model_count, Some(2));
        assert_eq!(snapshot.state, RuntimeState::InstalledStopped);
        assert_eq!(snapshot.reservation.kind.as_deref(), Some("local_llm"));
        assert_eq!(snapshot.reservation.status, ReservationStatus::Running);
        assert_eq!(snapshot.reservation.bytes, None);
        let spec = runner.state.captured_spec.lock().unwrap().clone().unwrap();
        assert_eq!(
            spec.executable,
            root.join(pin.version).join(pin.executable_relative_path)
        );
        assert_eq!(spec.arguments, vec!["serve"]);
        assert!(spec.inherit_environment);
        assert_eq!(
            spec.environment
                .get(&std::ffi::OsString::from("CUDA_VISIBLE_DEVICES"))
                .unwrap(),
            &std::ffi::OsString::from("0")
        );
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
    fn voice_lease_conflicts_block_local_llm_without_spawning_and_keep_voice_lease() {
        let gib = 1024_u64 * 1024 * 1024;
        for (total_vram_bytes, reason_code) in [
            (Some(8 * gib), "same_device_conflict"),
            (Some(16 * gib), "policy_undecided"),
            (None, "policy_undecided"),
        ] {
            let inventory = inventory_with_total_vram(total_vram_bytes);
            let runner = FakeRunner::new(Some(ApiFixture::ready(0)));
            let anchor = tempfile::tempdir().unwrap();
            let root = make_test_root(&anchor);
            let pin = *release_pin("linux", "x86_64").unwrap();
            let address = std::net::TcpListener::bind("127.0.0.1:0")
                .unwrap()
                .local_addr()
                .unwrap();
            let manager = test_manager_with_inventory(
                &anchor,
                &root,
                address.port(),
                &runner,
                pin,
                Arc::new(FixtureDownloader::succeeding(Vec::new())),
                true,
                inventory.clone(),
            );
            let voice_lease = reserve_test_voice(&manager, &inventory);
            let operation = dispatch_start(&manager, None, None, None).unwrap();
            let snapshot = wait_for_operation(&manager, &operation);
            assert_eq!(snapshot.server_state, ServerState::Failed);
            assert_eq!(
                snapshot.error.as_ref().unwrap().code,
                RuntimeErrorCode::ReservationDenied
            );
            assert_eq!(
                snapshot.error.as_ref().unwrap().reason_code.as_deref(),
                Some(reason_code)
            );
            assert_eq!(snapshot.reservation.status, ReservationStatus::Denied);
            assert_eq!(
                snapshot.reservation.reason_code.as_deref(),
                Some(reason_code)
            );
            assert_eq!(snapshot.reservation.bytes, None);
            assert_eq!(runner.state.spawned.load(Ordering::Relaxed), 0);
            assert_eq!(
                manager
                    .reservation_manager
                    .reservations_for_device(local_llm_device_id())
                    .len(),
                1
            );
            drop(voice_lease);
        }
    }

    #[test]
    fn inventory_selection_and_mapping_fail_closed_without_starting_a_child() {
        let base = e2e_fake_accelerator_inventory();
        let mut multiple = base.clone();
        let mut second = multiple.devices[0].clone();
        second.provider_id.value = "vulkan:uuid:ffeeddccbbaa99887766554433221100".to_string();
        second.nvidia.as_mut().unwrap().compatibility_index = Some(1);
        multiple.devices.push(second);

        let mut unmapped = base.clone();
        unmapped.devices[0].vendor = HardwareVendor::Amd;
        unmapped.devices[0].nvidia = None;

        let mut unavailable = base.clone();
        unavailable.status = DetectionStatus::Unavailable;
        unavailable.devices.clear();
        let mut no_devices = base.clone();
        no_devices.status = DetectionStatus::NoDevices;
        no_devices.devices.clear();

        for (inventory, expected_code, expected_reason, requested_device_id) in [
            (
                multiple,
                RuntimeErrorCode::DeviceSelectionRequired,
                "device_selection_required",
                None,
            ),
            (
                unmapped,
                RuntimeErrorCode::DeviceMappingUnverified,
                "device_mapping_unverified",
                None,
            ),
            (
                unavailable,
                RuntimeErrorCode::AcceleratorInventoryUnavailable,
                "inventory_unavailable",
                None,
            ),
            (
                no_devices,
                RuntimeErrorCode::DeviceNotFound,
                "device_not_found",
                None,
            ),
            (
                base,
                RuntimeErrorCode::DeviceNotFound,
                "device_not_found",
                Some("vulkan:uuid:ffffffffffffffffffffffffffffffff"),
            ),
        ] {
            let runner = FakeRunner::new(Some(ApiFixture::ready(0)));
            let anchor = tempfile::tempdir().unwrap();
            let root = make_test_root(&anchor);
            let pin = *release_pin("linux", "x86_64").unwrap();
            let address = std::net::TcpListener::bind("127.0.0.1:0")
                .unwrap()
                .local_addr()
                .unwrap();
            let manager = test_manager_with_inventory(
                &anchor,
                &root,
                address.port(),
                &runner,
                pin,
                Arc::new(FixtureDownloader::succeeding(Vec::new())),
                true,
                inventory,
            );
            let operation = dispatch_start(
                &manager,
                None,
                None,
                requested_device_id.map(str::to_string),
            )
            .unwrap();
            let snapshot = wait_for_operation(&manager, &operation);
            assert_eq!(snapshot.error.as_ref().unwrap().code, expected_code);
            assert_eq!(
                snapshot.error.as_ref().unwrap().reason_code.as_deref(),
                Some(expected_reason)
            );
            assert_eq!(
                snapshot.reservation.reason_code.as_deref(),
                Some(expected_reason)
            );
            assert_eq!(runner.state.spawned.load(Ordering::Relaxed), 0);
        }
    }

    #[test]
    fn spawn_failure_returns_the_starting_lease() {
        let runner = FakeRunner::new(Some(ApiFixture::ready(0)));
        runner.state.fail_spawn.store(true, Ordering::Release);
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
        let operation = dispatch_start(&manager, None, None, None).unwrap();
        let snapshot = wait_for_operation(&manager, &operation);
        assert_eq!(snapshot.error.unwrap().code, RuntimeErrorCode::SpawnFailed);
        assert_eq!(runner.state.spawned.load(Ordering::Relaxed), 1);
        assert!(manager
            .reservation_manager
            .reservations_for_device(local_llm_device_id())
            .is_empty());
    }

    #[test]
    fn lost_mark_running_reaps_child_before_returning_lease() {
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
        *runner.state.reservation_manager_on_spawn.lock().unwrap() =
            Some(manager.reservation_manager.clone());
        runner
            .state
            .invalidate_reservation_on_spawn
            .store(true, Ordering::Release);

        let operation = dispatch_start(&manager, None, None, None).unwrap();
        let snapshot = wait_for_operation(&manager, &operation);

        assert_eq!(
            snapshot.error.as_ref().unwrap().code,
            RuntimeErrorCode::ReservationLeaseLost
        );
        assert_eq!(
            snapshot.error.as_ref().unwrap().reason_code.as_deref(),
            Some("reservation_lease_lost")
        );
        assert_eq!(
            snapshot.reservation.reason_code.as_deref(),
            Some("reservation_lease_lost")
        );
        assert!(manager.lock().process.is_none());
        assert!(manager
            .reservation_manager
            .reservations_for_device(local_llm_device_id())
            .is_empty());
        assert_eq!(runner.state.graceful_calls.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn rejected_spawn_keeps_unreaped_child_and_lease_for_shutdown_retry() {
        let runner = FakeRunner::new(Some(ApiFixture::ready(0)));
        runner.state.graceful_exits.store(false, Ordering::Release);
        runner.state.force_reaps.store(false, Ordering::Release);
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
        *runner.state.shutdown_manager_on_spawn.lock().unwrap() = Some(manager.clone());

        let _operation = dispatch_start(&manager, None, None, None).unwrap();
        let failed = wait_for_snapshot(&manager, Duration::from_secs(2), |snapshot| {
            snapshot
                .error
                .as_ref()
                .is_some_and(|error| error.code == RuntimeErrorCode::StopFailed)
        });

        assert_eq!(failed.server_state, ServerState::Failed);
        assert_eq!(manager.lock().unreaped_processes.len(), 1);
        assert_eq!(
            manager
                .reservation_manager
                .reservations_for_device(local_llm_device_id())
                .len(),
            1
        );
        runner.state.force_reaps.store(true, Ordering::Release);
        manager.shutdown();
        assert!(manager.lock().unreaped_processes.is_empty());
        assert!(manager
            .reservation_manager
            .reservations_for_device(local_llm_device_id())
            .is_empty());
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
        assert_eq!(started.server_state, ServerState::ReadyExternalLocal);
        assert_eq!(started.ownership, RuntimeOwnership::ExternalLocal);
        assert_eq!(started.reservation.status, ReservationStatus::Running);
        assert_eq!(started.reservation.bytes, None);
        assert_eq!(
            manager
                .reservation_manager
                .reservations_for_device(local_llm_device_id())
                .len(),
            1
        );
        assert_eq!(runner.state.spawned.load(Ordering::Relaxed), 0);
        let custom = external.base_url();
        assert_eq!(
            dispatch_start(&manager, None, Some(custom.clone()), None)
                .unwrap_err()
                .code,
            RuntimeErrorCode::ManagedEndpointUnsupported
        );
        let status = status_snapshot(&manager, Some(&custom), None).unwrap();
        assert_eq!(status.server_state, ServerState::ReadyExternalLocal);
        assert_eq!(status.ownership, RuntimeOwnership::ExternalLocal);
        assert_eq!(
            manager
                .reservation_manager
                .reservations_for_device(local_llm_device_id())
                .len(),
            1
        );
        let unused = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let unavailable = format!("http://{}", unused.local_addr().unwrap());
        drop(unused);
        assert_eq!(
            status_snapshot(&manager, Some(&unavailable), None)
                .unwrap()
                .server_state,
            ServerState::ExternalUnavailable
        );
        let active_again = status_snapshot(&manager, Some(&custom), None).unwrap();
        assert_eq!(active_again.server_state, ServerState::ReadyExternalLocal);
        assert_eq!(active_again.model_count, Some(1));
        let stop = dispatch_stop(&manager, None).unwrap();
        let stopped = wait_for_operation(&manager, &stop);
        assert_eq!(stopped.server_state, ServerState::ConnectedUnreserved);
        assert_eq!(stopped.ownership, RuntimeOwnership::ExternalLocal);
        assert_eq!(stopped.model_count, Some(1));
        assert_eq!(stopped.reservation.status, ReservationStatus::NotRequested);
        assert!(manager
            .reservation_manager
            .reservations_for_device(local_llm_device_id())
            .is_empty());
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
    fn application_shutdown_releases_external_lease_without_signaling_server() {
        let external = TestApiServer::bind("127.0.0.1:0", ApiFixture::ready(1)).unwrap();
        let runner = FakeRunner::new(Some(ApiFixture::ready(0)));
        let anchor = tempfile::tempdir().unwrap();
        let root = make_test_root(&anchor);
        let pin = *release_pin("linux", "x86_64").unwrap();
        let manager = test_manager(
            &anchor,
            &root,
            external.address.port(),
            &runner,
            pin,
            Arc::new(FixtureDownloader::succeeding(Vec::new())),
            true,
        );
        assert_eq!(
            status_snapshot(&manager, None, None).unwrap().server_state,
            ServerState::ReadyExternalLocal
        );
        assert_eq!(
            manager
                .reservation_manager
                .reservations_for_device(local_llm_device_id())
                .len(),
            1
        );

        manager.shutdown();

        assert!(manager
            .reservation_manager
            .reservations_for_device(local_llm_device_id())
            .is_empty());
        assert_eq!(
            probe_ollama(
                &url::Url::parse(&external.base_url()).unwrap(),
                Duration::from_millis(80)
            ),
            ProbeResult::Ready { model_count: 1 }
        );
        assert_eq!(runner.state.spawned.load(Ordering::Relaxed), 0);
        assert_eq!(runner.state.graceful_calls.load(Ordering::Relaxed), 0);
        assert_eq!(runner.state.force_calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn external_loopback_conflict_keeps_models_visible_and_chat_unreserved() {
        let external = TestApiServer::bind("127.0.0.1:0", ApiFixture::ready(2)).unwrap();
        let runner = FakeRunner::new(Some(ApiFixture::ready(0)));
        let anchor = tempfile::tempdir().unwrap();
        let root = make_test_root(&anchor);
        let pin = *release_pin("linux", "x86_64").unwrap();
        let mut inventory = inventory_with_total_vram(Some(8 * 1024 * 1024 * 1024));
        inventory.devices[0].available_vram_bytes = Some(7 * 1024 * 1024 * 1024);
        let manager = test_manager_with_inventory(
            &anchor,
            &root,
            external.address.port(),
            &runner,
            pin,
            Arc::new(FixtureDownloader::succeeding(Vec::new())),
            true,
            inventory.clone(),
        );
        let voice_lease = reserve_test_voice(&manager, &inventory);

        let first = status_snapshot(&manager, None, None).unwrap();
        let repeated = status_snapshot(&manager, None, None).unwrap();

        for snapshot in [&first, &repeated] {
            assert_eq!(snapshot.server_state, ServerState::ConnectedUnreserved);
            assert_eq!(snapshot.ownership, RuntimeOwnership::ExternalLocal);
            assert_eq!(snapshot.model_count, Some(2));
            assert_eq!(snapshot.reservation.status, ReservationStatus::Denied);
            assert_eq!(
                snapshot.reservation.reason_code.as_deref(),
                Some("same_device_conflict")
            );
        }
        assert_eq!(
            manager
                .reservation_manager
                .reservations_for_device(local_llm_device_id())
                .len(),
            1
        );
        assert_eq!(runner.state.spawned.load(Ordering::Relaxed), 0);
        assert_eq!(
            probe_ollama(
                &url::Url::parse(&external.base_url()).unwrap(),
                Duration::from_millis(80)
            ),
            ProbeResult::Ready { model_count: 2 }
        );
        assert_eq!(runner.state.graceful_calls.load(Ordering::Relaxed), 0);
        assert_eq!(runner.state.force_calls.load(Ordering::Relaxed), 0);
        drop(voice_lease);
    }

    #[test]
    fn simultaneous_external_status_requests_share_one_session_lease() {
        let external = TestApiServer::bind("127.0.0.1:0", ApiFixture::ready(1)).unwrap();
        let runner = FakeRunner::new(Some(ApiFixture::ready(0)));
        let anchor = tempfile::tempdir().unwrap();
        let root = make_test_root(&anchor);
        let pin = *release_pin("linux", "x86_64").unwrap();
        let manager = test_manager(
            &anchor,
            &root,
            external.address.port(),
            &runner,
            pin,
            Arc::new(FixtureDownloader::succeeding(Vec::new())),
            true,
        );
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let workers = (0..2)
            .map(|_| {
                let manager = manager.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    status_snapshot(&manager, None, None).unwrap()
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let snapshots = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();

        assert!(snapshots.iter().all(|snapshot| matches!(
            snapshot.server_state,
            ServerState::ReadyExternalLocal | ServerState::Reserving
        )));
        assert_eq!(
            status_snapshot(&manager, None, None).unwrap().server_state,
            ServerState::ReadyExternalLocal
        );
        assert_eq!(
            manager
                .reservation_manager
                .reservations_for_device(local_llm_device_id())
                .len(),
            1
        );
        assert_eq!(runner.state.spawned.load(Ordering::Relaxed), 0);
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
        let api = process_group_test_api();
        let port = api.address.port();
        let pid_file = anchor.path().join("fake-child.pid");
        let reaped_file = anchor.path().join("fake-child-reaped");
        write_fake_executable_install(&root, pin, &pid_file, &reaped_file);
        let mut manager = real_process_manager(&anchor, &root, port, pin, &pid_file);
        manager.settings.readiness_timeout = Duration::from_secs(5);

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
        let api = process_group_test_api();
        let port = api.address.port();
        let pid_file = anchor.path().join("fake-child.pid");
        let reaped_file = anchor.path().join("fake-child-reaped");
        write_fake_executable_install(&root, pin, &pid_file, &reaped_file);
        let manager = real_process_manager(&anchor, &root, port, pin, &pid_file);

        let start = dispatch_start(&manager, None, None, None).unwrap();
        wait_for_fixture_pid_file(&pid_file);
        api.set_fixture(ApiFixture::ready(0));
        api.listen();
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
    fn managed_child_fake_ollama_pulls_exact_qwen_tag_and_releases_reservation() {
        let _guard = REAL_PROCESS_GROUP_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        let anchor = tempfile::tempdir().unwrap();
        let root = make_test_root(&anchor);
        let pin = *release_pin("linux", "x86_64").unwrap();
        let tag = "huihui_ai/qwen3.5-abliterated:0.8B";
        let model_api = Arc::new(ModelPullApiFixture::new(
            tag, None, false, false, false, false,
        ));
        let api = TestApiServer::reserve_unlistened(
            std::net::SocketAddrV4::new(std::net::Ipv4Addr::LOCALHOST, 0),
            ApiFixture::ready(0).with_model_pull(model_api.clone()),
        )
        .unwrap();
        let port = api.address.port();
        let pid_file = anchor.path().join("fake-child.pid");
        let reaped_file = anchor.path().join("fake-child-reaped");
        write_fake_executable_install(&root, pin, &pid_file, &reaped_file);
        let manager = real_process_manager(&anchor, &root, port, pin, &pid_file);

        let start = dispatch_start(&manager, None, None, None).unwrap();
        wait_for_fixture_pid_file(&pid_file);
        api.listen();
        let started = wait_for_operation(&manager, &start);
        assert_eq!(started.server_state, ServerState::ReadyManaged);
        assert_eq!(started.ownership, RuntimeOwnership::ManagedChild);
        assert_eq!(started.reservation.status, ReservationStatus::Running);
        let startup_requests = model_api.request_paths.lock().unwrap().clone();
        assert_eq!(startup_requests, vec!["GET /api/tags"]);
        model_api.request_paths.lock().unwrap().clear();

        let model_store = tempfile::tempdir().unwrap();
        let pull = start_model_pull_with_policy(
            &manager,
            None,
            tag,
            tag,
            test_model_pull_policy(model_store.path()),
        )
        .unwrap();
        assert_eq!(pull.snapshot.state, ModelPullState::Preflight);
        let pulled = wait_for_model_pull_result(&manager, tag);
        assert_eq!(pulled.state, ModelPullState::Ready);
        assert_eq!(
            pulled.operation_id.as_deref(),
            Some(pull.operation_id.as_str())
        );
        assert_eq!(pulled.digest.as_deref(), Some("sha256:fixture"));
        assert!(pulled.error.is_none());
        assert_eq!(model_api.pull_requests.load(Ordering::Acquire), 1);
        assert_eq!(model_api.show_requests.load(Ordering::Acquire), 1);
        assert_eq!(
            model_api.pull_request_bodies.lock().unwrap().as_slice(),
            &[serde_json::json!({ "name": tag, "stream": true })]
        );
        assert_eq!(
            model_api.request_paths.lock().unwrap().as_slice(),
            [
                "GET /api/tags",
                "POST /api/pull",
                "GET /api/tags",
                "POST /api/show",
                "GET /api/tags",
            ]
        );

        let stop = dispatch_stop(&manager, None).unwrap();
        assert_eq!(
            wait_for_operation(&manager, &stop).server_state,
            ServerState::Stopped
        );
        wait_for_fixture_reap_marker(&reaped_file);
        assert!(manager.lock().process.is_none());
        assert!(manager
            .reservation_manager
            .reservations_for_device(local_llm_device_id())
            .is_empty());
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
            status_snapshot(&manager, None, None).unwrap().server_state,
            ServerState::ReadyManaged
        );
        let second = dispatch_start(&manager, None, None, None).unwrap();
        assert_eq!(
            wait_for_operation(&manager, &second).server_state,
            ServerState::ReadyManaged
        );
        assert_eq!(runner.state.spawned.load(Ordering::Relaxed), 1);
        runner.state.stop_listener();
        let unavailable = status_snapshot(&manager, None, None).unwrap();
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
        let state = manager.lock();
        assert!(state.process.is_none());
        assert_eq!(state.unreaped_processes.len(), 1);
        assert_eq!(
            state.snapshot.reservation.status,
            ReservationStatus::Running
        );
        assert_eq!(
            manager
                .reservation_manager
                .reservations_for_device(local_llm_device_id())
                .len(),
            1
        );
        drop(state);
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

    struct ModelPullApiFixture {
        tag: String,
        digest: Option<String>,
        hold_pull_open: bool,
        change_digest_on_recheck: bool,
        fail_first_pull: bool,
        disconnect_pull_early: bool,
        pull_requests: AtomicUsize,
        tags_requests: AtomicUsize,
        show_requests: AtomicUsize,
        pull_request_bodies: Mutex<Vec<Value>>,
        request_paths: Mutex<Vec<String>>,
        model_available: AtomicBool,
        client_closed_pull: AtomicBool,
        stopped: AtomicBool,
    }

    impl ModelPullApiFixture {
        fn new(
            tag: &str,
            digest: Option<&str>,
            hold_pull_open: bool,
            change_digest_on_recheck: bool,
            fail_first_pull: bool,
            disconnect_pull_early: bool,
        ) -> Self {
            Self {
                tag: tag.to_string(),
                digest: digest.map(str::to_string),
                hold_pull_open,
                change_digest_on_recheck,
                fail_first_pull,
                disconnect_pull_early,
                pull_requests: AtomicUsize::new(0),
                tags_requests: AtomicUsize::new(0),
                show_requests: AtomicUsize::new(0),
                pull_request_bodies: Mutex::new(Vec::new()),
                request_paths: Mutex::new(Vec::new()),
                model_available: AtomicBool::new(digest.is_some()),
                client_closed_pull: AtomicBool::new(false),
                stopped: AtomicBool::new(false),
            }
        }
    }

    struct ModelPullApiServer {
        address: std::net::SocketAddr,
        fixture: Arc<ModelPullApiFixture>,
        worker: Option<thread::JoinHandle<()>>,
    }

    impl ModelPullApiServer {
        fn bind(
            tag: &str,
            digest: Option<&str>,
            hold_pull_open: bool,
            change_digest_on_recheck: bool,
            fail_first_pull: bool,
            disconnect_pull_early: bool,
        ) -> io::Result<Self> {
            let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
            listener.set_nonblocking(true)?;
            let address = listener.local_addr()?;
            let fixture = Arc::new(ModelPullApiFixture::new(
                tag,
                digest,
                hold_pull_open,
                change_digest_on_recheck,
                fail_first_pull,
                disconnect_pull_early,
            ));
            let worker_fixture = fixture.clone();
            let worker = thread::spawn(move || {
                while !worker_fixture.stopped.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((stream, _)) => serve_model_pull_fixture(stream, worker_fixture.clone()),
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(2));
                        }
                        Err(_) => break,
                    }
                }
            });
            Ok(Self {
                address,
                fixture,
                worker: Some(worker),
            })
        }

        fn base_url(&self) -> String {
            format!("http://{}", self.address)
        }
    }

    impl Drop for ModelPullApiServer {
        fn drop(&mut self) {
            self.fixture.stopped.store(true, Ordering::Release);
            // Release a nonblocking accept loop even on platforms where the next poll is delayed.
            let _ = std::net::TcpStream::connect(self.address);
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }

    fn write_fixture_response(stream: &mut std::net::TcpStream, body: &[u8]) -> io::Result<()> {
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )?;
        stream.write_all(body)?;
        stream.flush()
    }

    fn serve_model_pull_fixture(
        mut stream: std::net::TcpStream,
        fixture: Arc<ModelPullApiFixture>,
    ) {
        let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
        let mut request = Vec::new();
        let mut chunk = [0_u8; 2048];
        let request_deadline = Instant::now() + Duration::from_secs(2);
        let header_end = loop {
            if let Some(position) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                break position + 4;
            }
            if request.len() >= 32 * 1024 || Instant::now() >= request_deadline {
                return;
            }
            match stream.read(&mut chunk) {
                Ok(0) => return,
                Ok(read) => request.extend_from_slice(&chunk[..read]),
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock
                            | io::ErrorKind::TimedOut
                            | io::ErrorKind::Interrupted
                    ) => {}
                Err(_) => return,
            }
        };
        let header = String::from_utf8_lossy(&request[..header_end - 4]).into_owned();
        let content_length = header
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find_map(|(name, value)| {
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or_default();
        while request.len() < header_end.saturating_add(content_length)
            && request.len() < 32 * 1024
            && Instant::now() < request_deadline
        {
            match stream.read(&mut chunk) {
                Ok(0) => return,
                Ok(read) => request.extend_from_slice(&chunk[..read]),
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock
                            | io::ErrorKind::TimedOut
                            | io::ErrorKind::Interrupted
                    ) => {}
                Err(_) => return,
            }
        }
        if request.len() < header_end.saturating_add(content_length) {
            return;
        }
        let request_body = &request[header_end..header_end + content_length];
        let request_line = header.lines().next().unwrap_or_default().to_string();
        let mut request_parts = request_line.split_whitespace();
        let method = request_parts.next().unwrap_or_default();
        let path = request_parts.next().unwrap_or_default();
        fixture
            .request_paths
            .lock()
            .unwrap()
            .push(format!("{method} {path}"));
        match path {
            "/api/version" => {
                let _ = write_fixture_response(&mut stream, br#"{"version":"fixture"}"#);
            }
            "/api/tags" => {
                let request_index = fixture.tags_requests.fetch_add(1, Ordering::AcqRel);
                let digest = match fixture.digest.as_deref() {
                    Some(digest) => Some(digest),
                    None if fixture.model_available.load(Ordering::Acquire) => {
                        Some("sha256:fixture")
                    }
                    None => None,
                };
                let digest = match digest {
                    Some(_) if fixture.change_digest_on_recheck && request_index >= 2 => {
                        Some("sha256:changed")
                    }
                    other => other,
                };
                let body = match digest {
                    Some(digest) => format!(
                        "{{\"models\":[{{\"name\":\"{}\",\"model\":\"{}\",\"digest\":\"{}\"}}]}}",
                        fixture.tag, fixture.tag, digest
                    ),
                    None => "{\"models\":[]}".to_string(),
                };
                let _ = write_fixture_response(&mut stream, body.as_bytes());
            }
            "/api/show" => {
                fixture.show_requests.fetch_add(1, Ordering::AcqRel);
                let body = br#"{"details":{"family":"qwen3","parameter_size":"0.8B","quantization_level":"Q8_0"},"model_info":{"qwen3.context_length":262144}}"#;
                let _ = write_fixture_response(&mut stream, body);
            }
            "/api/pull" => {
                let pull_number = fixture.pull_requests.fetch_add(1, Ordering::AcqRel) + 1;
                let body = serde_json::from_slice(request_body).unwrap_or(Value::Null);
                fixture.pull_request_bodies.lock().unwrap().push(body);
                if fixture.fail_first_pull && pull_number == 1 {
                    let _ = stream.write_all(
                        b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                    return;
                }
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                );
                let first =
                    br#"{"status":"downloading","digest":"sha256:layer","completed":1,"total":2}"#;
                let _ = write!(stream, "{:X}\r\n", first.len());
                let _ = stream.write_all(first);
                let _ = stream.write_all(b"\r\n");
                let _ = stream.flush();
                if fixture.disconnect_pull_early {
                    return;
                }
                if fixture.hold_pull_open {
                    loop {
                        match stream.read(&mut chunk) {
                            Ok(0) => {
                                fixture.client_closed_pull.store(true, Ordering::Release);
                                break;
                            }
                            Ok(_) => {}
                            Err(error)
                                if matches!(
                                    error.kind(),
                                    io::ErrorKind::WouldBlock
                                        | io::ErrorKind::TimedOut
                                        | io::ErrorKind::Interrupted
                                ) => {}
                            Err(_) => {
                                fixture.client_closed_pull.store(true, Ordering::Release);
                                break;
                            }
                        }
                        if fixture.stopped.load(Ordering::Acquire) {
                            break;
                        }
                    }
                } else {
                    let second = b"\n{\"status\":\"success\"}";
                    let _ = write!(stream, "{:X}\r\n", second.len());
                    let _ = stream.write_all(second);
                    let _ = stream.write_all(b"\r\n0\r\n\r\n");
                    let _ = stream.flush();
                    fixture.model_available.store(true, Ordering::Release);
                }
            }
            _ => {
                let _ = stream.write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
            }
        }
    }

    fn model_pull_test_manager(base_url: &str) -> (RuntimeManager, Arc<FakeProcessState>) {
        let mut manager = RuntimeManager::default();
        manager.reservation_manager = ReservationManager::default();
        manager.settings.managed_base_url = base_url.to_string();
        let inventory = e2e_fake_accelerator_inventory();
        let device_id = inventory.devices[0].provider_id.value.clone();
        let lease = manager
            .reservation_manager
            .try_reserve_with_inventory(
                LocalModelRequest {
                    device_id,
                    kind: LocalModelKind::LocalLlm,
                    workload_id: next_operation_id(),
                    reservation_bytes: None,
                },
                &inventory,
            )
            .expect("synthetic accelerator fixture reservation");
        assert!(lease.mark_running());
        let reservation = ReservationSnapshot::from_lease(&lease).expect("running lease snapshot");
        let fake_process = Arc::new(FakeProcessState::new());
        {
            let mut state = manager.lock();
            state.snapshot.state = RuntimeState::InstalledStopped;
            state.snapshot.server_state = ServerState::ReadyManaged;
            state.snapshot.ownership = RuntimeOwnership::ManagedChild;
            state.snapshot.installed_version = Some(RELEASE_VERSION.to_string());
            state.snapshot.installed_versions = vec![RELEASE_VERSION.to_string()];
            state.snapshot.reservation = reservation;
            state.snapshot.model_count = Some(0);
            state.process = Some(ManagedProcess {
                child: Box::new(FakeChild {
                    state: fake_process.clone(),
                }),
                version: RELEASE_VERSION.to_string(),
                generation: 1,
                reservation: Some(lease),
            });
        }
        (manager, fake_process)
    }

    fn test_model_pull_policy(directory: &Path) -> QwenModelPolicy {
        let mut policy = qwen_model_policy();
        policy.disk_space_multiplier = Some(2);
        policy.model_store_override = Some(directory.to_string_lossy().into_owned());
        policy.available_bytes_override = Some(u64::MAX);
        for candidate in &mut policy.candidates {
            candidate.published_size_bytes = Some(1);
            candidate.minimum_free_bytes = Some(2);
        }
        policy
    }

    fn undecided_qwen_model_policy() -> QwenModelPolicy {
        let mut policy = qwen_model_policy();
        policy.default_model_tag = None;
        policy.context_default_tokens = None;
        policy.pull_start_policy = None;
        policy.model_store_override = None;
        policy.automatic_selection_policy = None;
        policy.disk_space_multiplier = None;
        policy.model_store_available_bytes = None;
        policy.show_license = None;
        for candidate in &mut policy.candidates {
            candidate.published_size_bytes = None;
            candidate.minimum_free_bytes = None;
        }
        policy
    }

    fn wait_for_model_pull_result(manager: &RuntimeManager, tag: &str) -> ModelPullSnapshot {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(snapshot) = manager.lock().model_pull_snapshots.get(tag).cloned() {
                if matches!(
                    snapshot.state,
                    ModelPullState::Paused | ModelPullState::Failed | ModelPullState::Ready
                ) {
                    return snapshot;
                }
            }
            assert!(
                Instant::now() < deadline,
                "model pull worker did not finish"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn qwen_model_policy_exposes_fixed_catalog_and_undecided_slots_as_null() {
        let policy = undecided_qwen_model_policy();
        assert_eq!(
            policy
                .candidates
                .iter()
                .map(|candidate| candidate.tag)
                .collect::<Vec<_>>(),
            vec![
                "huihui_ai/qwen3.5-abliterated:0.8B",
                "huihui_ai/qwen3.5-abliterated:2B",
                "huihui_ai/qwen3.5-abliterated:4B",
                "huihui_ai/qwen3.5-abliterated:9b",
            ]
        );
        assert!(policy.candidates.iter().all(|candidate| {
            candidate.published_context_tokens == 256 * 1024
                && candidate.published_size_bytes.is_none()
                && candidate.minimum_free_bytes.is_none()
                && candidate.source_url.starts_with("https://ollama.com/")
                && candidate.license == "Apache License 2.0"
        }));
        assert!(policy.default_model_tag.is_none());
        assert!(policy.context_default_tokens.is_none());
        assert!(policy.pull_start_policy.is_none());
        assert!(policy.model_store_override.is_none());
        assert!(policy.automatic_selection_policy.is_none());
        assert!(policy.disk_space_multiplier.is_none());
        assert!(policy.show_license.is_none());
        assert!(policy.measured_peak_vram_bytes.is_none());
        assert!(policy.selection_headroom_bytes.is_none());
    }

    #[test]
    fn qwen_model_policy_contains_coordinator_decisions() {
        let store = PathBuf::from("/app-data/ollama/models");
        let policy = qwen_model_policy_with_store(Some(store.clone()));
        assert_eq!(
            policy.default_model_tag.as_deref(),
            Some("huihui_ai/qwen3.5-abliterated:4B")
        );
        assert_eq!(policy.context_default_tokens, Some(8192));
        assert_eq!(
            policy.pull_start_policy.as_deref(),
            Some("user_confirmed_exact_tag")
        );
        assert_eq!(
            policy.model_store_override.as_deref(),
            Some(store.to_string_lossy().as_ref())
        );
        assert_eq!(
            policy.automatic_selection_policy.as_deref(),
            Some("manual_only_until_measured")
        );
        assert_eq!(policy.disk_space_multiplier, Some(2));
        assert_eq!(policy.show_license, Some(true));
        assert!(policy.measured_peak_vram_bytes.is_none());
        assert!(policy.selection_headroom_bytes.is_none());
        let four_b = model_candidate(&policy, "huihui_ai/qwen3.5-abliterated:4B").unwrap();
        assert_eq!(four_b.quantization, "Q4_K_M");
        assert_eq!(four_b.published_size_bytes, Some(3_300_000_000));
        assert_eq!(four_b.minimum_free_bytes, Some(6_600_000_000));
        let nine_b = model_candidate(&policy, "huihui_ai/qwen3.5-abliterated:9b").unwrap();
        assert_eq!(nine_b.minimum_free_bytes, Some(13_200_000_000));
    }

    #[test]
    fn decimal_gb_labels_are_exact_and_reject_invalid_or_overflowing_values() {
        assert_eq!(decimal_gb_bytes("1.9 GB"), Some(1_900_000_000));
        assert_eq!(decimal_gb_bytes("3.3 GB"), Some(3_300_000_000));
        assert_eq!(decimal_gb_bytes("0.8 GB"), Some(800_000_000));
        assert_eq!(decimal_gb_bytes("1.25 GB"), Some(1_250_000_000));
        assert_eq!(decimal_gb_bytes("bad GB"), None);
        assert_eq!(decimal_gb_bytes("18446744073.709551616 GB"), None);
    }

    #[test]
    fn model_store_preflight_creates_and_checks_only_the_configured_path() {
        let root = tempfile::tempdir().unwrap();
        let configured = root.path().join("ollama").join("models");
        let policy = qwen_model_policy_with_store(Some(configured.clone()));
        let check = check_model_store(&policy).unwrap();
        assert_eq!(check.probe_directory, configured);
        assert!(check.probe_directory.is_dir());

        let without_configured_path = qwen_model_policy();
        assert_eq!(
            check_model_store(&without_configured_path)
                .unwrap_err()
                .code,
            ModelPullErrorCode::ModelStoreUnresolved
        );
    }

    #[test]
    fn pull_requires_a_known_exact_tag_and_matching_confirmation() {
        let tag = "huihui_ai/qwen3.5-abliterated:0.8B";
        let policy = qwen_model_policy();
        assert_eq!(
            model_candidate(&policy, "huihui_ai/qwen3.5-abliterated:latest"),
            None
        );
        let (manager, _) = model_pull_test_manager("http://127.0.0.1:1");
        let confirmation = start_model_pull_with_policy(
            &manager,
            None,
            tag,
            "huihui_ai/qwen3.5-abliterated:0.8b",
            policy,
        )
        .unwrap_err();
        assert_eq!(
            confirmation.code,
            ModelPullErrorCode::ModelConfirmationRequired
        );
        assert_eq!(confirmation.stage, "preflight");
    }

    #[test]
    fn pull_stream_parser_accepts_split_coalesced_optional_and_final_lines() {
        let mut buffer = Vec::new();
        assert!(append_pull_chunk(
            &mut buffer,
            br#"{"status":"downloading","digest":"sha256:layer","completed":1"#
        )
        .unwrap()
        .is_empty());
        let parsed =
            append_pull_chunk(&mut buffer, b",\"total\":2}\n{\"status\":\"success\"}").unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].as_ref().unwrap().0, "downloading");
        assert_eq!(parsed[0].as_ref().unwrap().2, Some(1));
        assert_eq!(parsed[0].as_ref().unwrap().3, Some(2));
        let final_line = finish_pull_buffer(&mut buffer).unwrap().unwrap();
        assert_eq!(final_line.0, "success");
        assert_eq!(final_line.1, None);
        assert_eq!(final_line.2, None);
        assert_eq!(final_line.3, None);
        assert_eq!(
            parse_pull_line(br#"{"status":"verifying"}"#)
                .unwrap()
                .unwrap()
                .2,
            None
        );
        assert_eq!(
            parse_pull_line(b"{not-json}").unwrap_err(),
            ModelPullErrorCode::PullStreamMalformed
        );
        assert_eq!(
            parse_pull_line(br#"{"error":"fixture failure"}"#).unwrap_err(),
            ModelPullErrorCode::PullHttpFailed
        );
        assert_eq!(
            append_pull_chunk(&mut Vec::new(), &vec![b'x'; MODEL_PULL_MAX_LINE_BYTES + 1])
                .unwrap_err(),
            ModelPullErrorCode::PullStreamMalformed
        );
    }

    #[test]
    fn pull_progress_throttles_bytes_but_never_delays_phase_events() {
        let start = tokio::time::Instant::now();
        let mut last_event = start - Duration::from_secs(1);
        assert!(model_pull_progress_due(&mut last_event, start, Some(1)));
        assert!(!model_pull_progress_due(
            &mut last_event,
            start + Duration::from_millis(100),
            Some(2)
        ));
        assert!(model_pull_progress_due(
            &mut last_event,
            start + Duration::from_millis(250),
            Some(3)
        ));
        assert!(model_pull_progress_due(
            &mut last_event,
            start + Duration::from_millis(251),
            None
        ));
    }

    #[test]
    fn fake_ollama_pull_stream_verifies_exact_tag_details_and_stable_digest() {
        let tag = "huihui_ai/qwen3.5-abliterated:0.8B";
        let server = ModelPullApiServer::bind(tag, None, false, false, false, false).unwrap();
        let (manager, _) = model_pull_test_manager(&server.base_url());
        let directory = tempfile::tempdir().unwrap();
        let response = start_model_pull_with_policy(
            &manager,
            None,
            tag,
            tag,
            test_model_pull_policy(directory.path()),
        )
        .unwrap();
        assert_eq!(response.snapshot.state, ModelPullState::Preflight);
        let snapshot = wait_for_model_pull_result(&manager, tag);
        assert_eq!(snapshot.state, ModelPullState::Ready);
        assert_eq!(snapshot.digest.as_deref(), Some("sha256:fixture"));
        assert!(snapshot.error.is_none());
        assert_eq!(server.fixture.pull_requests.load(Ordering::Acquire), 1);
        assert_eq!(server.fixture.tags_requests.load(Ordering::Acquire), 3);
        let status = dispatch_model_pull_status(&manager, None, tag).unwrap();
        assert_eq!(status.state, ModelPullState::Ready);
        assert_eq!(status.digest.as_deref(), Some("sha256:fixture"));
        assert_eq!(server.fixture.tags_requests.load(Ordering::Acquire), 5);
    }

    #[test]
    fn exact_installed_tag_is_verified_without_another_pull_even_when_margin_is_unset() {
        let tag = "huihui_ai/qwen3.5-abliterated:0.8B";
        let server =
            ModelPullApiServer::bind(tag, Some("sha256:fixture"), false, false, false, false)
                .unwrap();
        let (manager, _) = model_pull_test_manager(&server.base_url());
        let mut policy = qwen_model_policy();
        policy.model_store_override = None;
        let response = start_model_pull_with_policy(&manager, None, tag, tag, policy).unwrap();
        let snapshot = wait_for_model_pull_result(&manager, tag);
        assert_eq!(snapshot.state, ModelPullState::Ready);
        assert_eq!(snapshot.digest.as_deref(), Some("sha256:fixture"));
        assert_eq!(response.operation_id, snapshot.operation_id.unwrap());
        assert_eq!(server.fixture.pull_requests.load(Ordering::Acquire), 0);
        assert_eq!(server.fixture.tags_requests.load(Ordering::Acquire), 3);
    }

    #[test]
    fn unset_disk_margin_blocks_new_pull_before_post_request() {
        let tag = "huihui_ai/qwen3.5-abliterated:0.8B";
        let server = ModelPullApiServer::bind(tag, None, false, false, false, false).unwrap();
        let (manager, _) = model_pull_test_manager(&server.base_url());
        let directory = tempfile::tempdir().unwrap();
        let mut policy = test_model_pull_policy(directory.path());
        policy.disk_space_multiplier = None;
        let error = start_model_pull_with_policy(&manager, None, tag, tag, policy).unwrap_err();
        assert_eq!(error.code, ModelPullErrorCode::DiskMarginUnset);
        assert!(error.operation_id.is_some());
        assert_eq!(server.fixture.pull_requests.load(Ordering::Acquire), 0);
    }

    #[test]
    fn unknown_published_size_blocks_new_pull_before_post_request() {
        let tag = "huihui_ai/qwen3.5-abliterated:0.8B";
        let server = ModelPullApiServer::bind(tag, None, false, false, false, false).unwrap();
        let (manager, _) = model_pull_test_manager(&server.base_url());
        let directory = tempfile::tempdir().unwrap();
        let mut policy = test_model_pull_policy(directory.path());
        policy.candidates[0].published_size_bytes = None;
        policy.candidates[0].minimum_free_bytes = None;
        let error = start_model_pull_with_policy(&manager, None, tag, tag, policy).unwrap_err();
        assert_eq!(error.code, ModelPullErrorCode::DiskSpaceLow);
        assert_eq!(server.fixture.pull_requests.load(Ordering::Acquire), 0);
    }

    #[test]
    fn cancel_waits_for_fake_http_request_close_before_reporting_paused() {
        let tag = "huihui_ai/qwen3.5-abliterated:0.8B";
        let server = ModelPullApiServer::bind(tag, None, true, false, false, false).unwrap();
        let (manager, _) = model_pull_test_manager(&server.base_url());
        let directory = tempfile::tempdir().unwrap();
        let preserved_fragment = directory.path().join("preserved-model-fragment");
        fs::write(&preserved_fragment, b"partial Ollama data").unwrap();
        let response = start_model_pull_with_policy(
            &manager,
            None,
            tag,
            tag,
            test_model_pull_policy(directory.path()),
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while server.fixture.pull_requests.load(Ordering::Acquire) == 0 {
            assert!(
                Instant::now() < deadline,
                "fake server did not receive pull request"
            );
            thread::sleep(Duration::from_millis(5));
        }
        let concurrent = start_model_pull_with_policy(
            &manager,
            None,
            tag,
            tag,
            test_model_pull_policy(directory.path()),
        )
        .unwrap_err();
        assert_eq!(concurrent.code, ModelPullErrorCode::PullAlreadyActive);
        assert_eq!(server.fixture.pull_requests.load(Ordering::Acquire), 1);
        let stop_error = dispatch_stop(&manager, None).unwrap_err();
        assert_eq!(stop_error.code, RuntimeErrorCode::RuntimeBusy);
        let snapshot = dispatch_model_pull_cancel(&manager, &response.operation_id).unwrap();
        assert_eq!(snapshot.state, ModelPullState::Paused);
        assert!(server.fixture.client_closed_pull.load(Ordering::Acquire));
        assert_eq!(
            fs::read(preserved_fragment).unwrap(),
            b"partial Ollama data"
        );
    }

    #[test]
    fn changed_digest_after_show_never_reaches_ready_and_does_not_delete_model_data() {
        let tag = "huihui_ai/qwen3.5-abliterated:0.8B";
        let server = ModelPullApiServer::bind(tag, None, false, true, false, false).unwrap();
        let (manager, _) = model_pull_test_manager(&server.base_url());
        let directory = tempfile::tempdir().unwrap();
        let response = start_model_pull_with_policy(
            &manager,
            None,
            tag,
            tag,
            test_model_pull_policy(directory.path()),
        )
        .unwrap();
        let snapshot = wait_for_model_pull_result(&manager, tag);
        assert_eq!(snapshot.state, ModelPullState::Failed);
        assert_eq!(
            snapshot.error.unwrap().code,
            ModelPullErrorCode::ModelDigestMismatch
        );
        assert_eq!(
            snapshot.operation_id.as_deref(),
            Some(response.operation_id.as_str())
        );
        assert_eq!(server.fixture.pull_requests.load(Ordering::Acquire), 1);
    }

    #[test]
    fn external_ollama_is_rejected_before_any_pull_http_request() {
        let tag = "huihui_ai/qwen3.5-abliterated:0.8B";
        let server = ModelPullApiServer::bind(tag, None, false, false, false, false).unwrap();
        let (manager, _) = model_pull_test_manager(&server.base_url());
        {
            let mut state = manager.lock();
            state.snapshot.server_state = ServerState::ReadyExternalLocal;
            state.snapshot.ownership = RuntimeOwnership::ExternalLocal;
            state.process = None;
        }
        let directory = tempfile::tempdir().unwrap();
        let error = start_model_pull_with_policy(
            &manager,
            None,
            tag,
            tag,
            test_model_pull_policy(directory.path()),
        )
        .unwrap_err();
        assert_eq!(error.code, ModelPullErrorCode::ManagedServerRequired);
        assert_eq!(server.fixture.pull_requests.load(Ordering::Acquire), 0);
        assert_eq!(server.fixture.tags_requests.load(Ordering::Acquire), 0);
    }

    #[test]
    fn retry_uses_same_exact_tag_with_a_new_operation_id_and_resumes_pull() {
        let tag = "huihui_ai/qwen3.5-abliterated:0.8B";
        let server = ModelPullApiServer::bind(tag, None, false, false, true, false).unwrap();
        let (manager, _) = model_pull_test_manager(&server.base_url());
        let directory = tempfile::tempdir().unwrap();
        let policy = test_model_pull_policy(directory.path());
        let first = start_model_pull_with_policy(&manager, None, tag, tag, policy.clone()).unwrap();
        let failed = wait_for_model_pull_result(&manager, tag);
        assert_eq!(failed.state, ModelPullState::Failed);
        assert_eq!(
            failed.error.unwrap().code,
            ModelPullErrorCode::PullHttpFailed
        );
        let retry = dispatch_model_pull_retry_with_policy(&manager, None, tag, policy).unwrap();
        assert_ne!(first.operation_id, retry.operation_id);
        assert_eq!(retry.snapshot.tag, tag);
        let ready = wait_for_model_pull_result(&manager, tag);
        assert_eq!(ready.state, ModelPullState::Ready);
        assert_eq!(
            ready.operation_id.as_deref(),
            Some(retry.operation_id.as_str())
        );
        assert_eq!(server.fixture.pull_requests.load(Ordering::Acquire), 2);
        assert_eq!(ready.digest.as_deref(), Some("sha256:fixture"));
    }

    #[test]
    fn remote_stream_disconnect_becomes_paused_and_keeps_partial_content() {
        let tag = "huihui_ai/qwen3.5-abliterated:0.8B";
        let server = ModelPullApiServer::bind(tag, None, false, false, false, true).unwrap();
        let (manager, _) = model_pull_test_manager(&server.base_url());
        let directory = tempfile::tempdir().unwrap();
        let response = start_model_pull_with_policy(
            &manager,
            None,
            tag,
            tag,
            test_model_pull_policy(directory.path()),
        )
        .unwrap();
        let snapshot = wait_for_model_pull_result(&manager, tag);
        assert_eq!(snapshot.state, ModelPullState::Paused);
        assert_eq!(
            snapshot.operation_id.as_deref(),
            Some(response.operation_id.as_str())
        );
        assert!(snapshot.error.is_none());
        assert_eq!(server.fixture.pull_requests.load(Ordering::Acquire), 1);
    }

    #[test]
    fn insufficient_space_and_unresolved_store_are_denied_without_exposing_paths() {
        let tag = "huihui_ai/qwen3.5-abliterated:0.8B";
        let server = ModelPullApiServer::bind(tag, None, false, false, false, false).unwrap();
        let (manager, _) = model_pull_test_manager(&server.base_url());
        let directory = tempfile::tempdir().unwrap();
        let mut policy = test_model_pull_policy(directory.path());
        policy.available_bytes_override = Some(0);
        policy.candidates[0].published_size_bytes =
            Some(fs2::available_space(directory.path()).unwrap() + 1024);
        policy.candidates[0].minimum_free_bytes = policy.candidates[0]
            .published_size_bytes
            .and_then(|bytes| bytes.checked_mul(2));
        let required_bytes = policy.candidates[0].minimum_free_bytes.unwrap();
        let error = start_model_pull_with_policy(&manager, None, tag, tag, policy).unwrap_err();
        assert_eq!(error.code, ModelPullErrorCode::DiskSpaceLow);
        assert_eq!(error.required_bytes, Some(required_bytes));
        assert_eq!(error.available_bytes, Some(0));
        assert!(!serde_json::to_string(&error)
            .unwrap()
            .contains(&directory.path().to_string_lossy().to_string()));
        let mut unresolved = qwen_model_policy();
        unresolved.model_store_override = Some("relative/models".to_string());
        let error = check_model_store(&unresolved).err().unwrap();
        assert_eq!(error.code, ModelPullErrorCode::ModelStoreUnresolved);
        assert_eq!(server.fixture.pull_requests.load(Ordering::Acquire), 0);
    }

    #[test]
    fn disk_space_below_two_times_size_is_blocked_and_exact_threshold_is_allowed() {
        let tag = "huihui_ai/qwen3.5-abliterated:0.8B";
        let server = ModelPullApiServer::bind(tag, None, false, false, false, false).unwrap();
        let (manager, _) = model_pull_test_manager(&server.base_url());
        let directory = tempfile::tempdir().unwrap();

        let mut too_little = test_model_pull_policy(directory.path());
        too_little.available_bytes_override = Some(1);
        let error = start_model_pull_with_policy(&manager, None, tag, tag, too_little).unwrap_err();
        assert_eq!(error.code, ModelPullErrorCode::DiskSpaceLow);
        assert_eq!(error.required_bytes, Some(2));
        assert_eq!(error.available_bytes, Some(1));
        assert_eq!(server.fixture.pull_requests.load(Ordering::Acquire), 0);

        let mut exact_threshold = test_model_pull_policy(directory.path());
        exact_threshold.available_bytes_override = Some(2);
        let response =
            start_model_pull_with_policy(&manager, None, tag, tag, exact_threshold).unwrap();
        let snapshot = wait_for_model_pull_result(&manager, tag);
        assert_eq!(snapshot.state, ModelPullState::Ready);
        assert_eq!(response.snapshot.state, ModelPullState::Preflight);
        assert_eq!(server.fixture.pull_requests.load(Ordering::Acquire), 1);
    }

    #[test]
    fn shutdown_cancels_pull_and_waits_for_connection_close_before_reaping_child() {
        let tag = "huihui_ai/qwen3.5-abliterated:0.8B";
        let server = ModelPullApiServer::bind(tag, None, true, false, false, false).unwrap();
        let (manager, child) = model_pull_test_manager(&server.base_url());
        let directory = tempfile::tempdir().unwrap();
        let response = start_model_pull_with_policy(
            &manager,
            None,
            tag,
            tag,
            test_model_pull_policy(directory.path()),
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while server.fixture.pull_requests.load(Ordering::Acquire) == 0 {
            assert!(
                Instant::now() < deadline,
                "fake server did not receive pull request"
            );
            thread::sleep(Duration::from_millis(5));
        }
        shutdown_manager(&manager);
        let snapshot = manager
            .lock()
            .model_pull_snapshots
            .get(tag)
            .cloned()
            .unwrap();
        assert_eq!(
            snapshot.operation_id.as_deref(),
            Some(response.operation_id.as_str())
        );
        assert_eq!(snapshot.state, ModelPullState::Paused);
        assert!(server.fixture.client_closed_pull.load(Ordering::Acquire));
        assert!(child.graceful_calls.load(Ordering::Acquire) > 0);
        assert!(manager.lock().process.is_none());
        assert!(manager.lock().active_model_pull.is_none());
    }
}
