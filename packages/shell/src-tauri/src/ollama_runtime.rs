//! User-scoped Ollama CLI installation and discovery.
//!
//! This stage deliberately does not execute the Ollama binary, contact an
//! Ollama API, inspect a GPU, or alter an external Ollama installation.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};
use zip::ZipArchive;

const RELEASE_VERSION: &str = "0.40.3";
const RELEASE_BASE: &str = "https://github.com/ollama/ollama/releases/download";
const INTEGRITY_KIND: &str = "official_sha256_manifest";
const MANIFEST_FILE: &str = "naia-shell-ollama.json";
const STATE_EVENT: &str = "ollama_runtime_state_changed";
const PROGRESS_EVENT: &str = "ollama_runtime_install_progress";
const MAX_ARCHIVE_ENTRIES: usize = 100_000;
const MAX_EXTRACTED_BYTES: u64 = 8 * 1024 * 1024 * 1024;

static OPERATION_COUNTER: AtomicU64 = AtomicU64::new(1);

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
    PermissionDenied,
    NotManaged,
    ConfirmationRequired,
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
    state: RuntimeState,
    installed_version: Option<String>,
    installed_versions: Vec<String>,
    operation_id: Option<String>,
    phase: Option<String>,
    error: Option<RuntimeError>,
}

impl Default for RuntimeSnapshot {
    fn default() -> Self {
        Self {
            state: RuntimeState::NotInstalled,
            installed_version: None,
            installed_versions: Vec::new(),
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
    Remove,
}

#[derive(Clone, Debug)]
struct ActiveOperation {
    id: String,
}

#[derive(Default)]
struct ManagerState {
    snapshot: RuntimeSnapshot,
    operation: Option<ActiveOperation>,
    active_versions: BTreeSet<String>,
}

/// Tauri-managed state shared by the status, install, and remove commands.
#[derive(Clone, Default)]
pub(crate) struct RuntimeManager {
    inner: Arc<Mutex<ManagerState>>,
}

impl RuntimeManager {
    fn lock(&self) -> MutexGuard<'_, ManagerState> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn begin(&self, id: &str, kind: OperationKind) -> Result<(), RuntimeError> {
        let mut state = self.lock();
        if state.operation.is_some() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::RuntimeBusy,
                "dispatch",
                true,
            ));
        }
        state.operation = Some(ActiveOperation { id: id.to_string() });
        state.snapshot.operation_id = Some(id.to_string());
        state.snapshot.phase = Some(match kind {
            OperationKind::Install => "download".to_string(),
            OperationKind::Remove => "remove".to_string(),
        });
        state.snapshot.error = None;
        if kind == OperationKind::Install {
            state.snapshot.state = RuntimeState::Installing;
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
        if !state.operation.as_ref().is_some_and(|op| op.id == id) {
            return;
        }
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
    }

    fn finish_failure(&self, id: &str, error: RuntimeError) {
        let mut state = self.lock();
        if !state.operation.as_ref().is_some_and(|op| op.id == id) {
            return;
        }
        state.operation = None;
        state.snapshot.state = RuntimeState::Failed;
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

    #[cfg(test)]
    fn mark_active_for_test(&self, version: &str) {
        self.lock().active_versions.insert(version.to_string());
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
    D: ArtifactDownloader,
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
        installed_version,
        installed_versions: versions,
        operation_id: None,
        phase: None,
        error,
    }
}

#[tauri::command]
pub(crate) fn ollama_runtime_status(
    host: Option<String>,
    app: AppHandle,
    manager: State<'_, RuntimeManager>,
) -> Result<RuntimeSnapshot, RuntimeError> {
    let _host_was_supplied = host.is_some();
    log::debug!("OllamaRuntime::status host_value_redacted=true");
    if let Some(snapshot) = manager.operation_snapshot() {
        return Ok(snapshot);
    }
    let pin = match current_release_pin() {
        Ok(pin) => pin,
        Err(error) => {
            let snapshot = RuntimeSnapshot {
                state: RuntimeState::Failed,
                error: Some(error.clone()),
                ..RuntimeSnapshot::default()
            };
            manager.lock().snapshot = snapshot.clone();
            emit_snapshot(&app, &snapshot);
            return Ok(snapshot);
        }
    };
    let (anchor, root) = runtime_locations()?;
    let operation_id = next_operation_id();
    let (versions, invalid) =
        inspect_installations(&anchor, &root, pin.os, pin.arch, &operation_id)?;
    let error = invalid.then(|| RuntimeError::new(RuntimeErrorCode::NotManaged, "discover", false));
    let snapshot = snapshot_from_installations(versions, error);
    manager.lock().snapshot = snapshot.clone();
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
    log::debug!(
        "OllamaRuntime::start host_scope={} device_id_present={}",
        if is_default_managed_host(host.as_deref()) {
            "default_loopback"
        } else {
            "custom"
        },
        device_id.is_some()
    );
    if !is_default_managed_host(host.as_deref()) {
        return Err(RuntimeError::new(
            RuntimeErrorCode::NotManaged,
            "endpoint",
            false,
        ));
    }
    let pin = current_release_pin()?;
    let (anchor, root) = runtime_locations()?;
    let operation_id = next_operation_id();
    manager.begin(&operation_id, OperationKind::Install)?;
    emit_snapshot(&app, &manager.lock().snapshot.clone());

    let app_worker = app.clone();
    let manager_worker = (*manager).clone();
    let worker_id = operation_id.clone();
    let spawn = std::thread::Builder::new()
        .name("ollama-install-worker".to_string())
        .spawn(move || {
            let result = install_release(
                &anchor,
                &root,
                pin,
                &HttpDownloader,
                &worker_id,
                |phase, received, total| {
                    manager_worker.set_phase(&worker_id, phase);
                    emit_progress(&app_worker, &worker_id, phase, received, total);
                },
            );
            match result {
                Ok(installed) => {
                    let (versions, error) =
                        inspect_installations(&anchor, &root, pin.os, pin.arch, &worker_id)
                            .map(|(versions, invalid)| {
                                let error = invalid.then(|| {
                                    RuntimeError::new(
                                        RuntimeErrorCode::NotManaged,
                                        "discover",
                                        false,
                                    )
                                });
                                (versions, error)
                            })
                            .unwrap_or_else(|error| (Vec::new(), Some(error)));
                    if let Some(error) = error {
                        manager_worker.finish_failure(&worker_id, error);
                    } else {
                        manager_worker.finish_success(
                            &worker_id,
                            versions,
                            Some(installed.version),
                        );
                    }
                }
                Err(error) => manager_worker.finish_failure(&worker_id, error),
            }
            emit_snapshot(&app_worker, &manager_worker.lock().snapshot.clone());
        });
    if spawn.is_err() {
        let error = RuntimeError::new(RuntimeErrorCode::DownloadFailed, "dispatch", true)
            .for_operation(&operation_id);
        manager.finish_failure(&operation_id, error.clone());
        emit_snapshot(&app, &manager.lock().snapshot.clone());
        return Err(error);
    }
    Ok(operation_id)
}

#[tauri::command]
pub(crate) fn ollama_runtime_remove(
    version: String,
    confirm: bool,
    app: AppHandle,
    manager: State<'_, RuntimeManager>,
) -> Result<String, RuntimeError> {
    validate_remove_request(&version, confirm)?;
    let pin = current_release_pin()?;
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
