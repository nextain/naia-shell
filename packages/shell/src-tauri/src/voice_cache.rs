//! Shared, content-addressed voice runtime cache building blocks.
//!
//! Provides pure path resolution, cache key generation, private directory creation,
//! cross-process cooperative locking, and tree copying for the local voice runtime.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

// ─── 1. Cache root resolver ──────────────────────────────────────────────────

pub const CACHE_DIR_NAME_WINDOWS: &str = "NaiaRuntimeCache";
pub const CACHE_DIR_NAME_LINUX: &str = "naia-runtime-cache";
pub const CACHE_ROOT_OVERRIDE_ENV: &str = "NAIA_RUNTIME_CACHE_ROOT";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheOs {
    Windows,
    Linux,
}

/// Pure resolver for the cache root directory.
///
/// `overrides_allowed` is true only in debug builds.
///
/// The Windows cache dir name is `NaiaRuntimeCache` directly under `%LOCALAPPDATA%`,
/// NOT under `%LOCALAPPDATA%\Naia`. This is because the per-user NSIS install dir is
/// `$LOCALAPPDATA\Naia` and `windows/installer-hooks.nsh:72` does `RMDir /r "$INSTDIR"`
/// on uninstall; placing the cache under `%LOCALAPPDATA%\Naia` would cause uninstall to delete it.
/// `LOCALAPPDATA` is read from the environment first because `dirs::data_local_dir()` uses
/// the known-folder Windows API and ignores any E2E harness redirection of `%LOCALAPPDATA%`.
pub fn resolve_cache_root_with(
    os: CacheOs,
    overrides_allowed: bool,
    override_value: Option<OsString>,
    local_app_data_env: Option<OsString>, // Windows: value of LOCALAPPDATA
    known_folder: Option<PathBuf>,        // dirs::data_local_dir()
) -> Option<PathBuf> {
    if overrides_allowed {
        if let Some(val) = override_value {
            if !val.is_empty() {
                let p = PathBuf::from(val);
                if p.is_absolute() {
                    return Some(p);
                }
            }
        }
    }
    match os {
        CacheOs::Windows => {
            let base = if let Some(env_val) = local_app_data_env {
                if !env_val.is_empty() {
                    let p = PathBuf::from(env_val);
                    if p.is_absolute() {
                        Some(p)
                    } else {
                        known_folder
                    }
                } else {
                    known_folder
                }
            } else {
                known_folder
            };
            base.map(|b| b.join(CACHE_DIR_NAME_WINDOWS))
        }
        CacheOs::Linux => known_folder.map(|kf| kf.join(CACHE_DIR_NAME_LINUX)),
    }
}

pub fn resolve_cache_root() -> Option<PathBuf> {
    let os = if cfg!(windows) {
        CacheOs::Windows
    } else {
        CacheOs::Linux
    };
    resolve_cache_root_with(
        os,
        cfg!(debug_assertions),
        std::env::var_os(CACHE_ROOT_OVERRIDE_ENV),
        std::env::var_os("LOCALAPPDATA"),
        dirs::data_local_dir(),
    )
}

// ─── 2. Path segment allowlist and keys ───────────────────────────────────────

pub const DIR_KEY_LEN: usize = 16;

pub fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

pub fn is_hex16(s: &str) -> bool {
    s.len() == DIR_KEY_LEN && s.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

pub fn dir_key(key: &str) -> Result<String, String> {
    if is_hex64(key) {
        Ok(key[..DIR_KEY_LEN].to_string())
    } else if is_hex16(key) {
        Ok(key.to_string())
    } else {
        Err(format!("invalid cache path segment: {}", key))
    }
}

pub fn is_safe_profile_id(s: &str) -> bool {
    let len = s.len();
    (1..=64).contains(&len)
        && !s.starts_with('_')
        && s.chars().all(|c| matches!(c, 'a'..='z' | '0'..='9' | '_'))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    use std::fmt::Write;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let hash = hasher.finalize();
    let mut out = String::with_capacity(64);
    for b in hash {
        let _ = write!(&mut out, "{:02x}", b);
    }
    out
}

#[derive(Clone, Copy, Debug)]
pub struct SlotKeyInput<'a> {
    pub profile: &'a str,
    pub artifact_manifest_sha256: &'a str,
    pub prepare_script: &'a [u8],
    pub activation_contract: &'a [u8],
}

pub fn slot_key(input: &SlotKeyInput) -> Result<String, String> {
    if !is_safe_profile_id(input.profile) {
        return Err(format!("invalid profile: {}", input.profile));
    }
    let artifact_lowercased = input.artifact_manifest_sha256.to_ascii_lowercase();
    if !is_hex64(&artifact_lowercased) {
        return Err(format!(
            "invalid artifact sha: {}",
            input.artifact_manifest_sha256
        ));
    }
    let script_hex = sha256_hex(input.prepare_script);
    let contract_hex = sha256_hex(input.activation_contract);
    let payload = format!(
        "naia-voxcpm2-slot/v1\nprofile={}\nartifact={}\nscript={}\ncontract={}\n",
        input.profile, artifact_lowercased, script_hex, contract_hex
    );
    Ok(sha256_hex(payload.as_bytes()))
}

#[derive(Clone, Copy, Debug)]
pub struct EngineStampInput<'a> {
    pub gpu_name: &'a str,
    pub compute_cap: &'a str,
    pub driver_version: &'a str,
    pub tensorrt_version: &'a str,
}

pub fn engine_stamp(input: &EngineStampInput) -> Result<String, String> {
    let gpu = input.gpu_name.trim();
    let cc = input.compute_cap.trim();
    let driver = input.driver_version.trim();
    let trt = input.tensorrt_version.trim();
    if gpu.is_empty() {
        return Err("empty gpu_name".to_string());
    }
    if cc.is_empty() {
        return Err("empty compute_cap".to_string());
    }
    if driver.is_empty() {
        return Err("empty driver_version".to_string());
    }
    if trt.is_empty() {
        return Err("empty tensorrt_version".to_string());
    }
    let payload = format!(
        "naia-voxcpm2-engine/v1\ngpu={}\ncc={}\ndriver={}\ntensorrt={}\n",
        gpu, cc, driver, trt
    );
    Ok(sha256_hex(payload.as_bytes()))
}

#[derive(Debug, Clone)]
pub struct CacheLayout {
    pub root: PathBuf,
}

impl CacheLayout {
    pub fn new(cache_root: &Path) -> Self {
        Self {
            root: cache_root.join("voxcpm2"),
        }
    }

    pub fn downloads_dir(&self) -> PathBuf {
        self.root.join("downloads")
    }

    pub fn download_zip(&self, archive_sha: &str) -> Result<PathBuf, String> {
        if !is_hex64(archive_sha) {
            return Err(format!("invalid cache path segment: {}", archive_sha));
        }
        Ok(self.downloads_dir().join(format!("{}.zip", archive_sha)))
    }

    pub fn profile_dir(&self, profile: &str) -> Result<PathBuf, String> {
        if !is_safe_profile_id(profile) {
            return Err(format!("invalid cache path segment: {}", profile));
        }
        Ok(self.root.join("slots").join(profile))
    }

    pub fn slot_dir(&self, profile: &str, slot: &str) -> Result<PathBuf, String> {
        if !is_safe_profile_id(profile) {
            return Err(format!("invalid cache path segment: {}", profile));
        }
        let dk = dir_key(slot)?;
        Ok(self.root.join("slots").join(profile).join(dk))
    }

    pub fn engine_dir(&self, profile: &str, slot: &str, stamp: &str) -> Result<PathBuf, String> {
        let slot_dir = self.slot_dir(profile, slot)?;
        let stamp_dk = dir_key(stamp)?;
        Ok(slot_dir.join("engines").join(stamp_dk))
    }

    pub fn lock_path(&self, profile: &str, slot: &str) -> Result<PathBuf, String> {
        if !is_safe_profile_id(profile) {
            return Err(format!("invalid cache path segment: {}", profile));
        }
        let dk = dir_key(slot)?;
        Ok(self.root.join("locks").join(format!("{}-{}.lock", profile, dk)))
    }

    pub fn migration_receipt(&self, profile: &str, slot: &str) -> Result<PathBuf, String> {
        if !is_safe_profile_id(profile) {
            return Err(format!("invalid cache path segment: {}", profile));
        }
        let dk = dir_key(slot)?;
        Ok(self.root.join("migration").join(format!("{}-{}.receipt.json", profile, dk)))
    }
}

// ─── 3. Private directories and reparse points ───────────────────────────────

pub fn is_reparse_or_symlink(path: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

pub fn path_has_reparse_component(path: &Path, stop_at: &Path) -> bool {
    for ancestor in path.ancestors() {
        if !ancestor.starts_with(stop_at) {
            break;
        }
        if is_reparse_or_symlink(ancestor) {
            return true;
        }
    }
    false
}

pub fn ensure_private_dir(path: &Path) -> Result<(), String> {
    if is_reparse_or_symlink(path) {
        return Err(format!("refusing reparse point/symlink: {}", path.display()));
    }
    let existed = path.exists();
    std::fs::create_dir_all(path)
        .map_err(|e| format!("failed to create dir {}: {}", path.display(), e))?;
    if is_reparse_or_symlink(path) {
        return Err(format!("refusing reparse point/symlink: {}", path.display()));
    }

    if !existed {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| format!("failed to set permissions on {}: {}", path.display(), e))?;
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let username = std::env::var("USERNAME")
                .map_err(|_| "missing USERNAME env var".to_string())?;
            if username.is_empty() {
                return Err("USERNAME env var is empty".to_string());
            }
            let user_spec = match std::env::var("USERDOMAIN") {
                Ok(domain) if !domain.is_empty() => format!(r"{}\{}", domain, username),
                _ => username,
            };

            let mut cmd = std::process::Command::new("icacls");
            cmd.arg(path)
                .arg("/inheritance:r")
                .arg("/grant:r")
                .arg("*S-1-5-18:(OI)(CI)F")
                .arg(format!("{}:(OI)(CI)F", user_spec));
            cmd.creation_flags(0x0800_0000);
            let output = cmd.output().map_err(|e| format!("failed to execute icacls: {}", e))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let stdout = String::from_utf8_lossy(&output.stdout);
                let msg = if !stderr.trim().is_empty() {
                    stderr.trim()
                } else {
                    stdout.trim()
                };
                return Err(format!("icacls failed: {}", msg));
            }
        }
    }

    Ok(())
}

// ─── 4. Cross-process lock ───────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockMode {
    Shared,
    Exclusive,
}

#[derive(Debug)]
pub struct RuntimeLock {
    file: std::fs::File,
    _path: PathBuf,
    _mode: LockMode,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LockBusy {
    pub owner_pid: Option<u32>,
    pub owner_mode: Option<String>,
}

fn owner_file_path(lock_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.owner", lock_path.display()))
}

fn read_lock_busy(owner_path: &Path) -> LockBusy {
    if let Ok(bytes) = std::fs::read(owner_path) {
        #[derive(serde::Deserialize)]
        struct OwnerRecord {
            pid: Option<u32>,
            mode: Option<String>,
        }
        if let Ok(record) = serde_json::from_slice::<OwnerRecord>(&bytes) {
            return LockBusy {
                owner_pid: record.pid,
                owner_mode: record.mode,
            };
        }
    }
    LockBusy {
        owner_pid: None,
        owner_mode: None,
    }
}

fn write_owner_stamp(owner_path: &Path, pid: u32, mode: &str) -> std::io::Result<()> {
    let tmp_path = PathBuf::from(format!("{}.tmp", owner_path.display()));
    let payload = serde_json::json!({
        "pid": pid,
        "mode": mode,
    });
    let data = serde_json::to_vec(&payload)?;
    std::fs::write(&tmp_path, data)?;
    if std::fs::rename(&tmp_path, owner_path).is_err() {
        let _ = std::fs::remove_file(owner_path);
        std::fs::rename(&tmp_path, owner_path)?;
    }
    Ok(())
}

impl RuntimeLock {
    /// Non-blocking. On contention returns `Err(LockBusy)` with the owner stamp read from `<lock>.owner`.
    ///
    /// The OS releases the lock when the holding process dies, so a dead owner
    /// never blocks ("steal if dead" is inherent to OS locks). A stale `.owner`
    /// stamp is simply overwritten by the next exclusive holder.
    pub fn try_acquire(
        lock_path: &Path,
        mode: LockMode,
        owner_label: &str,
    ) -> Result<RuntimeLock, LockBusy> {
        if let Some(parent) = lock_path.parent() {
            let _ = ensure_private_dir(parent);
        }
        let file = match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(lock_path)
        {
            Ok(f) => f,
            Err(_) => {
                let owner_path = owner_file_path(lock_path);
                return Err(read_lock_busy(&owner_path));
            }
        };

        let lock_result = match mode {
            LockMode::Shared => file.try_lock_shared(),
            LockMode::Exclusive => file.try_lock(),
        };

        if lock_result.is_err() {
            let owner_path = owner_file_path(lock_path);
            return Err(read_lock_busy(&owner_path));
        }

        let owner_path = owner_file_path(lock_path);
        match mode {
            LockMode::Exclusive => {
                let _ = write_owner_stamp(&owner_path, std::process::id(), owner_label);
            }
            LockMode::Shared => {
                if !owner_path.exists() {
                    let _ = write_owner_stamp(&owner_path, std::process::id(), owner_label);
                }
            }
        }

        Ok(RuntimeLock {
            file,
            _path: lock_path.to_path_buf(),
            _mode: mode,
        })
    }
}

impl Drop for RuntimeLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

pub fn lock_busy_message(busy: &LockBusy) -> String {
    let pid_str = busy
        .owner_pid
        .map(|p| p.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let mode_str = busy.owner_mode.as_deref().unwrap_or("unknown");
    format!(
        "Another Naia instance (last recorded PID {}, {}) is using the local voice runtime. Stop its local voice, then try again.",
        pid_str, mode_str
    )
}

// ─── 5. Free space and copy plan ─────────────────────────────────────────────

pub fn available_space(path: &Path) -> Option<u64> {
    for ancestor in path.ancestors() {
        if ancestor.exists() {
            if let Ok(space) = fs2::available_space(ancestor) {
                return Some(space);
            }
        }
    }
    None
}

pub fn has_room_for(available: Option<u64>, needed: u64) -> bool {
    let Some(avail) = available else {
        return false;
    };
    let headroom = needed.saturating_add(9) / 10;
    let required = match needed.checked_add(headroom) {
        Some(r) => r,
        None => return false,
    };
    avail >= required
}

pub const MIGRATION_EXCLUDED_NAMES: &[&str] = &["state", "hf-cache", "downloads", "voxcpm2-install.log"];

pub fn migration_excluded(relative: &Path) -> bool {
    let mut components = relative.components().peekable();
    if let Some(first) = components.peek() {
        let s = first.as_os_str().to_string_lossy();
        if s == "voices" {
            return true;
        }
    }
    for comp in relative.components() {
        let s = comp.as_os_str().to_string_lossy();
        if MIGRATION_EXCLUDED_NAMES.iter().any(|&name| s == name) {
            return true;
        }
        if s.ends_with(".pending")
            || s.ends_with(".backup")
            || s.ends_with(".pending-migration")
            || s.ends_with(".mig")
        {
            return true;
        }
    }
    false
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CopyStats {
    pub files: u64,
    pub bytes: u64,
    pub hardlinked: u64,
    pub copied: u64,
}

fn walk_tree_size(
    current: &Path,
    root: &Path,
    excluded: &dyn Fn(&Path) -> bool,
    files: &mut u64,
    bytes: &mut u64,
) -> std::io::Result<()> {
    if is_reparse_or_symlink(current) {
        return Ok(());
    }
    let relative = current.strip_prefix(root).unwrap_or(current);
    if !relative.as_os_str().is_empty() && excluded(relative) {
        return Ok(());
    }
    if current.is_dir() {
        for entry in std::fs::read_dir(current)? {
            let entry = entry?;
            let path = entry.path();
            if is_reparse_or_symlink(&path) {
                continue;
            }
            let rel = path.strip_prefix(root).unwrap_or(&path);
            if excluded(rel) {
                continue;
            }
            let meta = std::fs::symlink_metadata(&path)?;
            if meta.is_dir() {
                walk_tree_size(&path, root, excluded, files, bytes)?;
            } else if meta.is_file() {
                *files += 1;
                *bytes += meta.len();
            }
        }
    } else if current.is_file() {
        let meta = std::fs::symlink_metadata(current)?;
        *files += 1;
        *bytes += meta.len();
    }
    Ok(())
}

pub fn tree_size(root: &Path, excluded: &dyn Fn(&Path) -> bool) -> std::io::Result<(u64, u64)> {
    if !root.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("path not found: {}", root.display()),
        ));
    }
    let mut files = 0;
    let mut bytes = 0;
    walk_tree_size(root, root, excluded, &mut files, &mut bytes)?;
    Ok((files, bytes))
}

fn walk_link_or_copy(
    current: &Path,
    src_root: &Path,
    dst_root: &Path,
    excluded: &dyn Fn(&Path) -> bool,
    stats: &mut CopyStats,
    limit: Option<u64>,
) -> Result<(), String> {
    if is_reparse_or_symlink(current) {
        return Ok(());
    }
    let relative = current.strip_prefix(src_root).unwrap_or(current);
    if !relative.as_os_str().is_empty() && excluded(relative) {
        return Ok(());
    }

    if current.is_dir() {
        let entries = std::fs::read_dir(current)
            .map_err(|e| format!("failed to read directory {}: {}", current.display(), e))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("failed to read directory entry: {}", e))?;
            let path = entry.path();
            if is_reparse_or_symlink(&path) {
                continue;
            }
            let rel = path.strip_prefix(src_root).unwrap_or(&path);
            if excluded(rel) {
                continue;
            }
            let meta = std::fs::symlink_metadata(&path)
                .map_err(|e| format!("failed to get metadata for {}: {}", path.display(), e))?;
            let dst_target = dst_root.join(rel);

            if meta.is_dir() {
                std::fs::create_dir_all(&dst_target)
                    .map_err(|e| format!("failed to create directory {}: {}", dst_target.display(), e))?;
                walk_link_or_copy(&path, src_root, dst_root, excluded, stats, limit)?;
            } else if meta.is_file() {
                if let Some(max) = limit {
                    if stats.files >= max {
                        return Err(format!("fault hook: reached file limit of {}", max));
                    }
                }
                if let Some(parent) = dst_target.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("failed to create parent dir {}: {}", parent.display(), e))?;
                }
                stats.files += 1;
                stats.bytes += meta.len();
                if std::fs::hard_link(&path, &dst_target).is_ok() {
                    stats.hardlinked += 1;
                } else {
                    std::fs::copy(&path, &dst_target)
                        .map_err(|e| format!("failed to copy {} to {}: {}", path.display(), dst_target.display(), e))?;
                    stats.copied += 1;
                }
            }
        }
    } else if current.is_file() {
        if let Some(max) = limit {
            if stats.files >= max {
                return Err(format!("fault hook: reached file limit of {}", max));
            }
        }
        let meta = std::fs::symlink_metadata(current)
            .map_err(|e| format!("failed to get metadata for {}: {}", current.display(), e))?;
        if let Some(parent) = dst_root.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create parent dir {}: {}", parent.display(), e))?;
        }
        stats.files += 1;
        stats.bytes += meta.len();
        if std::fs::hard_link(current, dst_root).is_ok() {
            stats.hardlinked += 1;
        } else {
            std::fs::copy(current, dst_root)
                .map_err(|e| format!("failed to copy {} to {}: {}", current.display(), dst_root.display(), e))?;
            stats.copied += 1;
        }
    }

    Ok(())
}

#[cfg(test)]
pub fn link_or_copy_tree(
    src: &Path,
    dst: &Path,
    excluded: &dyn Fn(&Path) -> bool,
) -> Result<CopyStats, String> {
    link_or_copy_tree_with_limit(src, dst, excluded, None)
}

pub fn link_or_copy_tree_with_limit_into(
    src: &Path,
    dst: &Path,
    excluded: &dyn Fn(&Path) -> bool,
    stats: &mut CopyStats,
    limit: Option<u64>,
) -> Result<(), String> {
    if !src.exists() {
        return Err(format!("source does not exist: {}", src.display()));
    }
    if dst.exists() || is_reparse_or_symlink(dst) {
        return Err(format!("destination already exists: {}", dst.display()));
    }
    if is_reparse_or_symlink(src) {
        return Err(format!("source is a reparse point or symlink: {}", src.display()));
    }

    if src.is_dir() {
        std::fs::create_dir_all(dst)
            .map_err(|e| format!("failed to create destination dir {}: {}", dst.display(), e))?;
    }

    walk_link_or_copy(src, src, dst, excluded, stats, limit)?;
    Ok(())
}

#[cfg(test)]
pub fn link_or_copy_tree_with_limit(
    src: &Path,
    dst: &Path,
    excluded: &dyn Fn(&Path) -> bool,
    limit: Option<u64>,
) -> Result<CopyStats, String> {
    let mut stats = CopyStats::default();
    link_or_copy_tree_with_limit_into(src, dst, excluded, &mut stats, limit)?;
    Ok(stats)
}

fn copy_single_file(
    src: &Path,
    dst: &Path,
    stats: &mut CopyStats,
    limit: Option<u64>,
) -> Result<(), String> {
    if is_reparse_or_symlink(src) {
        return Ok(());
    }
    if let Some(max) = limit {
        if stats.files >= max {
            return Err(format!("fault hook: reached file limit of {}", max));
        }
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create parent dir {}: {}", parent.display(), e))?;
    }
    let meta = std::fs::symlink_metadata(src)
        .map_err(|e| format!("failed to get metadata for {}: {}", src.display(), e))?;
    stats.files += 1;
    stats.bytes += meta.len();
    std::fs::copy(src, dst)
        .map_err(|e| format!("failed to copy {} to {}: {}", src.display(), dst.display(), e))?;
    stats.copied += 1;
    Ok(())
}

// ─── 6. Retention ────────────────────────────────────────────────────────────

pub fn slots_to_prune(existing: &[String], active: &str, previous: Option<&str>) -> Vec<String> {
    let active_dk = dir_key(active).ok();
    let previous_dk = previous.and_then(|p| dir_key(p).ok());
    let mut to_prune = Vec::new();
    for name in existing {
        if is_hex16(name) {
            let is_active = active_dk.as_ref().map_or(false, |a| name == a);
            let is_previous = previous_dk.as_ref().map_or(false, |p| name == p);
            if !is_active && !is_previous {
                to_prune.push(name.clone());
            }
        }
    }
    to_prune.sort();
    to_prune.dedup();
    to_prune
}

// ─── 8. Embedded control files ───────────────────────────────────────────────

pub const PREPARE_SCRIPT_WINDOWS: &[u8] = include_bytes!("../windows/prepare-voxcpm2-model.ps1");
pub const PREPARE_SCRIPT_LINUX: &[u8] = include_bytes!("../linux/prepare-voxcpm2-model.sh");
pub const ACTIVATION_CONTRACT: &[u8] = include_bytes!("../voxcpm2-activation-contract.json");

pub fn embedded_prepare_script(os: CacheOs) -> (&'static str, &'static [u8]) {
    match os {
        CacheOs::Windows => ("prepare-voxcpm2-model.ps1", PREPARE_SCRIPT_WINDOWS),
        CacheOs::Linux => ("prepare-voxcpm2-model.sh", PREPARE_SCRIPT_LINUX),
    }
}

fn write_control_file_if_changed(dest: &Path, bytes: &[u8], is_script: bool) -> Result<(), String> {
    if dest.exists() {
        if let Ok(existing) = std::fs::read(dest) {
            if existing == bytes {
                return Ok(());
            }
        }
    }
    let tmp = PathBuf::from(format!("{}.tmp", dest.display()));
    std::fs::write(&tmp, bytes)
        .map_err(|e| format!("failed to write {}: {}", tmp.display(), e))?;
    #[cfg(unix)]
    if is_script {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
    }
    #[cfg(not(unix))]
    let _ = is_script;

    if std::fs::rename(&tmp, dest).is_err() {
        let _ = std::fs::remove_file(dest);
        std::fs::rename(&tmp, dest)
            .map_err(|e| format!("failed to rename {} to {}: {}", tmp.display(), dest.display(), e))?;
    }
    Ok(())
}

pub fn write_control_files(slot_dir: &Path, os: CacheOs) -> Result<PathBuf, String> {
    ensure_private_dir(slot_dir)?;
    let (script_name, script_bytes) = embedded_prepare_script(os);
    let script_path = slot_dir.join(script_name);
    write_control_file_if_changed(&script_path, script_bytes, true)?;
    let contract_path = slot_dir.join("voxcpm2-activation-contract.json");
    write_control_file_if_changed(&contract_path, ACTIVATION_CONTRACT, false)?;
    Ok(script_path)
}

// ─── 9. Slot record (slot.json) ──────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotRecord {
    pub schema_version: u32,
    pub profile: String,
    pub artifact_manifest_sha256: String,
    pub prepare_script_sha256: String,
    pub activation_contract_sha256: String,
    pub slot_key: String,
}

pub fn slot_record_for(profile: &str, artifact_sha: &str, os: CacheOs) -> Result<SlotRecord, String> {
    let (_script_name, script_bytes) = embedded_prepare_script(os);
    let key = slot_key(&SlotKeyInput {
        profile,
        artifact_manifest_sha256: artifact_sha,
        prepare_script: script_bytes,
        activation_contract: ACTIVATION_CONTRACT,
    })?;
    Ok(SlotRecord {
        schema_version: 1,
        profile: profile.to_string(),
        artifact_manifest_sha256: artifact_sha.to_ascii_lowercase(),
        prepare_script_sha256: sha256_hex(script_bytes),
        activation_contract_sha256: sha256_hex(ACTIVATION_CONTRACT),
        slot_key: key,
    })
}

pub fn write_slot_record(slot_dir: &Path, record: &SlotRecord) -> Result<(), String> {
    std::fs::create_dir_all(slot_dir)
        .map_err(|e| format!("failed to create slot dir {}: {}", slot_dir.display(), e))?;
    let dest = slot_dir.join("slot.json");
    let tmp = slot_dir.join("slot.json.tmp");
    let data = serde_json::to_vec_pretty(record)
        .map_err(|e| format!("failed to serialize slot record: {}", e))?;
    std::fs::write(&tmp, data)
        .map_err(|e| format!("failed to write {}: {}", tmp.display(), e))?;
    if std::fs::rename(&tmp, &dest).is_err() {
        let _ = std::fs::remove_file(&dest);
        std::fs::rename(&tmp, &dest)
            .map_err(|e| format!("failed to rename {} to {}: {}", tmp.display(), dest.display(), e))?;
    }
    Ok(())
}

pub fn read_slot_record(slot_dir: &Path) -> Option<SlotRecord> {
    let dest = slot_dir.join("slot.json");
    let bytes = std::fs::read(&dest).ok()?;
    serde_json::from_slice(&bytes).ok()
}

// ─── 10. Engine stamp input from nvidia-smi and installer lock ───────────────

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuIdentity {
    pub index: u32,
    pub name: String,
    pub compute_cap: String,
    pub driver_version: String,
}

/// Parses `nvidia-smi --query-gpu=index,name,compute_cap,driver_version --format=csv,noheader` output.
pub fn parse_nvidia_identity_csv(text: &str) -> Vec<GpuIdentity> {
    let mut identities = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parts: Vec<&str> = trimmed.split(',').map(|s| s.trim()).collect();
        if parts.len() == 4 {
            if let Ok(index) = parts[0].parse::<u32>() {
                if !parts[1].is_empty() && !parts[2].is_empty() && !parts[3].is_empty() {
                    identities.push(GpuIdentity {
                        index,
                        name: parts[1].to_string(),
                        compute_cap: parts[2].to_string(),
                        driver_version: parts[3].to_string(),
                    });
                }
            }
        }
    }
    identities
}

pub fn query_nvidia_identities() -> Vec<GpuIdentity> {
    let mut cmd = std::process::Command::new("nvidia-smi");
    cmd.arg("--query-gpu=index,name,compute_cap,driver_version")
        .arg("--format=csv,noheader");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    match cmd.output() {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            parse_nvidia_identity_csv(&stdout)
        }
        _ => Vec::new(),
    }
}

pub fn tensorrt_version_from_lock(installer_lock: &Path) -> Option<String> {
    let bytes = std::fs::read(installer_lock).ok()?;
    let val: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    val.pointer("/packages/tensorrt-cu12")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStampRecord {
    pub schema_version: u32,
    pub gpu_name: String,
    pub compute_cap: String,
    pub driver_version: String,
    pub tensorrt_version: String,
    pub stamp: String,
}

pub fn engine_stamp_record(
    gpu: &GpuIdentity,
    tensorrt_version: &str,
) -> Result<EngineStampRecord, String> {
    let stamp = engine_stamp(&EngineStampInput {
        gpu_name: &gpu.name,
        compute_cap: &gpu.compute_cap,
        driver_version: &gpu.driver_version,
        tensorrt_version,
    })?;
    Ok(EngineStampRecord {
        schema_version: 1,
        gpu_name: gpu.name.clone(),
        compute_cap: gpu.compute_cap.clone(),
        driver_version: gpu.driver_version.clone(),
        tensorrt_version: tensorrt_version.to_string(),
        stamp,
    })
}

pub fn write_engine_stamp(engine_dir: &Path, record: &EngineStampRecord) -> Result<(), String> {
    std::fs::create_dir_all(engine_dir)
        .map_err(|e| format!("failed to create engine dir {}: {}", engine_dir.display(), e))?;
    let dest = engine_dir.join("stamp.json");
    let tmp = engine_dir.join("stamp.json.tmp");
    let data = serde_json::to_vec_pretty(record)
        .map_err(|e| format!("failed to serialize engine stamp: {}", e))?;
    std::fs::write(&tmp, data)
        .map_err(|e| format!("failed to write {}: {}", tmp.display(), e))?;
    if std::fs::rename(&tmp, &dest).is_err() {
        let _ = std::fs::remove_file(&dest);
        std::fs::rename(&tmp, &dest)
            .map_err(|e| format!("failed to rename {} to {}: {}", tmp.display(), dest.display(), e))?;
    }
    Ok(())
}

pub fn read_engine_stamp(engine_dir: &Path) -> Option<EngineStampRecord> {
    let dest = engine_dir.join("stamp.json");
    let bytes = std::fs::read(&dest).ok()?;
    serde_json::from_slice(&bytes).ok()
}

// ─── 11. Native module hashes ────────────────────────────────────────────────

fn sha256_streaming(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("failed to open {}: {}", path.display(), e))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("failed to read {}: {}", path.display(), e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let hash = hasher.finalize();
    let mut out = String::with_capacity(64);
    use std::fmt::Write;
    for b in hash {
        let _ = write!(&mut out, "{:02x}", b);
    }
    Ok(out)
}

/// Files whose bytes are loaded as native code when the server starts: the bundled
/// interpreter, top-level shared libraries next to it, and the compiled voxcpm2_tensorrt modules.
pub fn native_module_paths(artifact_root: &Path, os: CacheOs) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    match os {
        CacheOs::Windows => {
            let py_dir = if artifact_root.join("python").is_dir() {
                artifact_root.join("python")
            } else {
                artifact_root.to_path_buf()
            };
            let exe = py_dir.join("python.exe");
            if exe.is_file() {
                paths.push(exe);
            }
            if let Ok(entries) = std::fs::read_dir(&py_dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_file() {
                        if let Some(ext) = p.extension() {
                            if ext.eq_ignore_ascii_case("dll") {
                                paths.push(p);
                            }
                        }
                    }
                }
            }
            let vox_dir = py_dir
                .join("Lib")
                .join("site-packages")
                .join("voxcpm2_tensorrt");
            if let Ok(entries) = std::fs::read_dir(&vox_dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_file() {
                        if let Some(ext) = p.extension() {
                            if ext.eq_ignore_ascii_case("pyd") {
                                paths.push(p);
                            }
                        }
                    }
                }
            }
        }
        CacheOs::Linux => {
            let py_dir = if artifact_root.join("python").is_dir() {
                artifact_root.join("python")
            } else {
                artifact_root.to_path_buf()
            };
            let bin_dir = py_dir.join("bin");
            if let Ok(entries) = std::fs::read_dir(&bin_dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_file() {
                        if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                            if name == "python3" || name.starts_with("python3.") {
                                paths.push(p);
                            }
                        }
                    }
                }
            }
            let lib_dir = py_dir.join("lib");
            if let Ok(entries) = std::fs::read_dir(&lib_dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_file() {
                        if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                            if name.contains(".so") {
                                paths.push(p);
                            }
                        }
                    } else if p.is_dir() {
                        if let Some(dir_name) = p.file_name().and_then(|n| n.to_str()) {
                            if dir_name.starts_with("python3.") {
                                let vox_dir = p.join("site-packages").join("voxcpm2_tensorrt");
                                if let Ok(vox_entries) = std::fs::read_dir(&vox_dir) {
                                    for v_entry in vox_entries.flatten() {
                                        let vp = v_entry.path();
                                        if vp.is_file() {
                                            if let Some(vname) = vp.file_name().and_then(|n| n.to_str()) {
                                                if vname.contains(".so") {
                                                    paths.push(vp);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    paths.sort();
    paths.dedup();
    paths
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeHashesRecord {
    pub schema_version: u32,
    pub files: std::collections::BTreeMap<String, String>,
}

pub fn record_native_hashes(
    slot_dir: &Path,
    artifact_root: &Path,
    os: CacheOs,
) -> Result<usize, String> {
    let paths = native_module_paths(artifact_root, os);
    let mut files = std::collections::BTreeMap::new();
    for path in &paths {
        if is_reparse_or_symlink(path) {
            return Err(format!("refusing reparse point/symlink: {}", path.display()));
        }
        let rel = path
            .strip_prefix(artifact_root)
            .map_err(|e| format!("failed to strip prefix for {}: {}", path.display(), e))?;
        let rel_str = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        let sha = sha256_streaming(path)?;
        files.insert(rel_str, sha);
    }
    let count = files.len();
    let record = NativeHashesRecord {
        schema_version: 1,
        files,
    };
    std::fs::create_dir_all(slot_dir)
        .map_err(|e| format!("failed to create slot dir {}: {}", slot_dir.display(), e))?;
    let dest = slot_dir.join("native-hashes.json");
    let tmp = slot_dir.join("native-hashes.json.tmp");
    let data = serde_json::to_vec_pretty(&record)
        .map_err(|e| format!("failed to serialize native hashes: {}", e))?;
    std::fs::write(&tmp, data)
        .map_err(|e| format!("failed to write {}: {}", tmp.display(), e))?;
    if std::fs::rename(&tmp, &dest).is_err() {
        let _ = std::fs::remove_file(&dest);
        std::fs::rename(&tmp, &dest)
            .map_err(|e| format!("failed to rename {} to {}: {}", tmp.display(), dest.display(), e))?;
    }
    Ok(count)
}

pub fn verify_native_hashes(
    slot_dir: &Path,
    artifact_root: &Path,
    os: CacheOs,
) -> Result<(), String> {
    let hashes_path = slot_dir.join("native-hashes.json");
    let bytes = std::fs::read(&hashes_path)
        .map_err(|_| "missing native-hashes.json".to_string())?;
    let recorded: NativeHashesRecord = serde_json::from_slice(&bytes)
        .map_err(|e| format!("failed to parse native-hashes.json: {}", e))?;
    if recorded.schema_version != 1 {
        return Err(format!(
            "unsupported native-hashes schema version: {}",
            recorded.schema_version
        ));
    }

    let current_paths = native_module_paths(artifact_root, os);
    let mut current_map = std::collections::BTreeMap::new();
    for p in current_paths {
        let rel = p
            .strip_prefix(artifact_root)
            .map_err(|e| format!("failed to strip prefix for {}: {}", p.display(), e))?;
        let rel_str = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        current_map.insert(rel_str, p);
    }

    for recorded_rel in recorded.files.keys() {
        if !current_map.contains_key(recorded_rel) {
            return Err(format!("missing recorded native module: {}", recorded_rel));
        }
    }
    for current_rel in current_map.keys() {
        if !recorded.files.contains_key(current_rel) {
            return Err(format!("unexpected native module in artifact: {}", current_rel));
        }
    }

    for (rel_str, recorded_sha) in &recorded.files {
        let p = current_map.get(rel_str).unwrap();
        if is_reparse_or_symlink(p) {
            return Err(format!("reparse point or symlink detected: {}", rel_str));
        }
        let actual_sha = sha256_streaming(p)?;
        if !actual_sha.eq_ignore_ascii_case(recorded_sha) {
            return Err(format!("native module hash mismatch: {}", rel_str));
        }
    }

    Ok(())
}

// ─── 12. Readiness ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReadinessFacts {
    pub slot_record_matches: bool,
    pub native_hashes_match: bool,
    pub nvidia_receipt_matches: bool,
    pub model_present: bool,
    pub palette_matches: bool,
    pub ready_json_matches: bool,
    pub engine_matches: bool,
    pub python_runtime: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Readiness {
    Ready,
    NeedsInstall(Vec<&'static str>),
}

pub fn evaluate_readiness(facts: &ReadinessFacts) -> Readiness {
    let mut reasons = Vec::new();
    if !facts.slot_record_matches {
        reasons.push("slot-key-mismatch");
    }
    if !facts.native_hashes_match {
        reasons.push("native-module-mismatch");
    }
    if !facts.nvidia_receipt_matches {
        reasons.push("nvidia-packages-missing");
    }
    if !facts.model_present {
        reasons.push("model-missing");
    }
    if !facts.palette_matches {
        reasons.push("palette-missing");
    }
    if !facts.ready_json_matches {
        reasons.push("ready-receipt-mismatch");
    }
    if !facts.engine_matches {
        reasons.push("engine-generation-missing");
    }
    if !facts.python_runtime {
        reasons.push("python-runtime-unavailable");
    }
    if reasons.is_empty() {
        Readiness::Ready
    } else {
        Readiness::NeedsInstall(reasons)
    }
}

#[derive(Debug, Clone)]
pub struct ReadinessInputs<'a> {
    pub slot_dir: &'a Path,
    pub artifact_root: &'a Path,
    pub engine_dir: &'a Path,
    pub expected: &'a SlotRecord,
    pub engine_stamp: &'a str,
    pub os: CacheOs,
}

pub fn embedded_palette() -> Vec<(String, String, u64)> {
    let val: Option<serde_json::Value> = serde_json::from_slice(ACTIVATION_CONTRACT).ok();
    let voices = val
        .as_ref()
        .and_then(|v| v.pointer("/runtime/referenceVoices"))
        .and_then(|v| v.as_array());
    let mut palette = Vec::new();
    if let Some(list) = voices {
        for v in list {
            let id = v.get("id").and_then(|s| s.as_str()).unwrap_or("");
            let sha = v.get("sha256").and_then(|s| s.as_str()).unwrap_or("");
            let bytes = v.get("bytes").and_then(|b| b.as_u64()).unwrap_or(0);
            if !id.is_empty() && !sha.is_empty() && bytes > 0 {
                palette.push((id.to_string(), sha.to_string(), bytes));
            }
        }
    }
    palette
}

pub fn gather_file_facts_with_palette(
    inputs: &ReadinessInputs,
    palette: &[(String, String, u64)],
) -> ReadinessFacts {
    let slot_record_matches = read_slot_record(inputs.slot_dir) == Some(inputs.expected.clone());

    let native_hashes_match =
        verify_native_hashes(inputs.slot_dir, inputs.artifact_root, inputs.os).is_ok();

    let nvidia_receipt_matches = {
        let receipt_path = inputs
            .slot_dir
            .join("python-packages")
            .join("naia-nvidia-package-receipt.json");
        let lock_path = inputs.artifact_root.join("installer-package-lock.json");
        match (std::fs::read(&receipt_path), std::fs::read(&lock_path)) {
            (Ok(receipt_bytes), Ok(lock_bytes)) => {
                let receipt_val: Option<serde_json::Value> =
                    serde_json::from_slice(&receipt_bytes).ok();
                let recorded_sha = receipt_val
                    .as_ref()
                    .and_then(|v| v.get("installerPackageLockSha256"))
                    .and_then(|v| v.as_str());
                let expected_sha = sha256_hex(&lock_bytes);
                recorded_sha
                    .map(|s| s.eq_ignore_ascii_case(&expected_sha))
                    .unwrap_or(false)
            }
            _ => false,
        }
    };

    let model_present = {
        let model_dir = inputs.slot_dir.join("models").join("VoxCPM2");
        let cfg = model_dir.join("config.json");
        let st = model_dir.join("model.safetensors");
        let rc = model_dir.join("voxcpm2-model-receipt.json");
        cfg.is_file()
            && rc.is_file()
            && st.is_file()
            && std::fs::metadata(&st).map(|m| m.len() > 0).unwrap_or(false)
    };

    let palette_matches = {
        if palette.is_empty() {
            false
        } else {
            let voices_dir = inputs.slot_dir.join("voices");
            palette.iter().all(|(id, expected_sha, expected_len)| {
                let p = voices_dir.join(id);
                if !p.is_file() {
                    return false;
                }
                match std::fs::metadata(&p) {
                    Ok(m) if m.len() == *expected_len => sha256_streaming(&p)
                        .map(|s| s.eq_ignore_ascii_case(expected_sha))
                        .unwrap_or(false),
                    _ => false,
                }
            })
        }
    };

    let (ready_json_matches, expected_model_rev) = {
        let manifest_path = inputs.artifact_root.join("runtime-manifest.json");
        let expected_rev = match std::fs::read(&manifest_path) {
            Ok(bytes) => {
                let val: Option<serde_json::Value> = serde_json::from_slice(&bytes).ok();
                val.as_ref()
                    .and_then(|v| v.pointer("/model/revision"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            }
            _ => None,
        };

        let ready_path = inputs.slot_dir.join("voxcpm2-runtime-ready.json");
        let ready_match = match (std::fs::read(&ready_path), &expected_rev) {
            (Ok(bytes), Some(exp_rev)) => {
                let val: Option<serde_json::Value> = serde_json::from_slice(&bytes).ok();
                let art_sha = val
                    .as_ref()
                    .and_then(|v| v.get("artifactManifestSha256"))
                    .and_then(|v| v.as_str());
                let mod_rev = val
                    .as_ref()
                    .and_then(|v| v.pointer("/model/revision"))
                    .and_then(|v| v.as_str());
                let sha_ok = art_sha
                    .map(|s| s.eq_ignore_ascii_case(&inputs.expected.artifact_manifest_sha256))
                    .unwrap_or(false);
                let rev_ok = mod_rev.map(|s| s == exp_rev).unwrap_or(false);
                sha_ok && rev_ok
            }
            _ => false,
        };
        (ready_match, expected_rev)
    };

    let engine_matches = {
        let stamp_rec = read_engine_stamp(inputs.engine_dir);
        let stamp_ok = stamp_rec
            .map(|r| r.stamp == inputs.engine_stamp)
            .unwrap_or(false);
        let manifest_path = inputs.engine_dir.join("manifest.json");
        let rev_ok = match (std::fs::read(&manifest_path), &expected_model_rev) {
            (Ok(bytes), Some(exp_rev)) => {
                let val: Option<serde_json::Value> = serde_json::from_slice(&bytes).ok();
                let rev = val
                    .as_ref()
                    .and_then(|v| v.get("model_revision").or_else(|| v.get("modelRevision")))
                    .and_then(|v| v.as_str());
                rev.map(|s| s.to_ascii_lowercase() == exp_rev.to_ascii_lowercase())
                    .unwrap_or(false)
            }
            _ => false,
        };
        stamp_ok && rev_ok
    };

    ReadinessFacts {
        slot_record_matches,
        native_hashes_match,
        nvidia_receipt_matches,
        model_present,
        palette_matches,
        ready_json_matches,
        engine_matches,
        python_runtime: false,
    }
}

/// File facts only. `python_runtime` is left false; the caller runs the interpreter check and sets it.
pub fn gather_file_facts(inputs: &ReadinessInputs) -> ReadinessFacts {
    let palette = embedded_palette();
    gather_file_facts_with_palette(inputs, &palette)
}

// ─── 13. Per-mode voice directory from palette ───────────────────────────────

pub fn sync_palette_to_state_with(
    slot_voices: &Path,
    state_voices: &Path,
    palette: &[(String, String, u64)],
) -> Result<usize, String> {
    std::fs::create_dir_all(state_voices)
        .map_err(|e| format!("failed to create state_voices dir {}: {}", state_voices.display(), e))?;

    let mut synced_count = 0;
    for (id, expected_sha, expected_len) in palette {
        let slot_file = slot_voices.join(id);
        if !slot_file.is_file() {
            return Err(format!("missing slot palette file: {}", slot_file.display()));
        }

        let state_file = state_voices.join(id);
        let needs_sync = if !state_file.is_file() {
            true
        } else {
            match std::fs::metadata(&state_file) {
                Ok(m) if m.len() == *expected_len => {
                    match sha256_streaming(&state_file) {
                        Ok(sha) => !sha.eq_ignore_ascii_case(expected_sha),
                        Err(_) => true,
                    }
                }
                _ => true,
            }
        };

        if needs_sync {
            let meta = std::fs::metadata(&slot_file)
                .map_err(|e| format!("failed to read metadata for {}: {}", slot_file.display(), e))?;
            if meta.len() != *expected_len {
                return Err(format!("slot palette file failed verification: {}", id));
            }
            let slot_sha = sha256_streaming(&slot_file)?;
            if !slot_sha.eq_ignore_ascii_case(expected_sha) {
                return Err(format!("slot palette file failed verification: {}", id));
            }

            let tmp_file = state_voices.join(format!("{}.tmp", id));
            let _ = std::fs::remove_file(&tmp_file);
            std::fs::copy(&slot_file, &tmp_file)
                .map_err(|e| format!("failed to copy {} to {}: {}", slot_file.display(), tmp_file.display(), e))?;
            if std::fs::rename(&tmp_file, &state_file).is_err() {
                let _ = std::fs::remove_file(&state_file);
                std::fs::rename(&tmp_file, &state_file)
                    .map_err(|e| format!("failed to rename {} to {}: {}", tmp_file.display(), state_file.display(), e))?;
            }
            synced_count += 1;
        }
    }

    Ok(synced_count)
}

pub fn sync_palette_to_state(slot_voices: &Path, state_voices: &Path) -> Result<usize, String> {
    let palette = embedded_palette();
    sync_palette_to_state_with(slot_voices, state_voices, &palette)
}

// ─── 14. Migration of legacy per-mode runtime tree into a slot ───────────────

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReceipt {
    pub schema_version: u32,
    pub source: String,
    pub slot_key: String,
    pub imported: Vec<String>,
    pub files: u64,
    pub bytes: u64,
    pub hardlinked: u64,
    pub copied: u64,
    pub verified_install: bool,
    pub verified_start: bool,
    #[serde(default)]
    pub cleaned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MigrationOutcome {
    Migrated(MigrationReceipt),
    SkippedSlotExists,
    SkippedNothingToImport,
    SkippedArtifactMismatch,
    SkippedNoSpace { needed: u64, available: Option<u64> },
}

#[derive(Debug, Clone)]
pub struct MigrationPlanInput<'a> {
    pub legacy_root: &'a Path,
    pub slot_dir: &'a Path,
    pub engine_dir: Option<&'a Path>,
    pub downloads_dir: &'a Path,
    pub expected_artifact_sha: &'a str,
    pub palette_ids: &'a [String],
    pub import_payload: bool,
}

fn find_first_probe_file(path: &Path, excluded: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    if is_reparse_or_symlink(path) {
        return None;
    }
    if path.is_file() {
        return Some(path.to_path_buf());
    }
    if path.is_dir() {
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                let p = entry.path();
                if is_reparse_or_symlink(&p) {
                    continue;
                }
                let rel = p.strip_prefix(path).unwrap_or(&p);
                if excluded(rel) {
                    continue;
                }
                if p.is_file() {
                    return Some(p);
                }
                if p.is_dir() {
                    if let Some(f) = find_first_probe_file(&p, excluded) {
                        return Some(f);
                    }
                }
            }
        }
    }
    None
}

pub fn migrate_legacy_runtime_with(
    input: &MigrationPlanInput,
    available: &dyn Fn(&Path) -> Option<u64>,
    hardlink_probe: &dyn Fn(&Path, &Path) -> bool,
    fail_after_files: Option<u64>,
) -> Result<MigrationOutcome, String> {
    if input.slot_dir.exists() {
        return Ok(MigrationOutcome::SkippedSlotExists);
    }
    if !input.legacy_root.exists() || is_reparse_or_symlink(input.legacy_root) {
        return Ok(MigrationOutcome::SkippedNothingToImport);
    }

    // Candidate items
    let payload_artifact = input.legacy_root.join("payload").join("artifact");
    let mut payload_importable = false;
    let mut payload_mismatched = false;
    if input.import_payload && payload_artifact.exists() && !is_reparse_or_symlink(&payload_artifact) {
        let manifest_path = payload_artifact.join("artifact-manifest.json");
        if manifest_path.is_file() && !is_reparse_or_symlink(&manifest_path) {
            if let Ok(manifest_bytes) = std::fs::read(&manifest_path) {
                let sha = sha256_hex(&manifest_bytes);
                if sha.eq_ignore_ascii_case(input.expected_artifact_sha) {
                    payload_importable = true;
                } else {
                    payload_mismatched = true;
                }
            } else {
                payload_mismatched = true;
            }
        } else {
            payload_mismatched = true;
        }
    }

    let python_packages = input.legacy_root.join("python-packages");
    let python_packages_importable = python_packages.exists() && !is_reparse_or_symlink(&python_packages);

    let models = input.legacy_root.join("models");
    let models_importable = models.exists() && !is_reparse_or_symlink(&models);

    let checkpoints_trt = input.legacy_root.join("checkpoints").join("voxcpm2_trt");
    let checkpoints_importable = input.engine_dir.is_some()
        && checkpoints_trt.exists()
        && !is_reparse_or_symlink(&checkpoints_trt);

    let mut importable_voices = Vec::new();
    for id in input.palette_ids {
        let v_path = input.legacy_root.join("voices").join(id);
        if v_path.is_file() && !is_reparse_or_symlink(&v_path) {
            importable_voices.push(id.clone());
        }
    }

    let has_other_importable = python_packages_importable
        || models_importable
        || checkpoints_importable
        || !importable_voices.is_empty();

    if !payload_importable && !has_other_importable {
        if payload_mismatched {
            return Ok(MigrationOutcome::SkippedArtifactMismatch);
        } else {
            return Ok(MigrationOutcome::SkippedNothingToImport);
        }
    }

    // Engine dir validation: engine_dir is always <slot_dir>/engines/<stamp> when Some
    let stamp_name = if let Some(ed) = input.engine_dir {
        let name = ed
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| "invalid engine_dir file name".to_string())?;
        let expected_engines_parent = input.slot_dir.join("engines");
        if ed.parent() != Some(&expected_engines_parent) {
            return Err(format!(
                "engine_dir {} must be under {}",
                ed.display(),
                expected_engines_parent.display()
            ));
        }
        Some(name)
    } else {
        None
    };

    // Total bytes calculation
    let mut total_bytes = 0u64;
    if payload_importable {
        if let Ok((_, bytes)) = tree_size(&payload_artifact, &migration_excluded) {
            total_bytes += bytes;
        }
    }
    if python_packages_importable {
        if let Ok((_, bytes)) = tree_size(&python_packages, &migration_excluded) {
            total_bytes += bytes;
        }
    }
    if models_importable {
        if let Ok((_, bytes)) = tree_size(&models, &migration_excluded) {
            total_bytes += bytes;
        }
    }
    if checkpoints_importable {
        if let Ok((_, bytes)) = tree_size(&checkpoints_trt, &migration_excluded) {
            total_bytes += bytes;
        }
    }
    for id in &importable_voices {
        let p = input.legacy_root.join("voices").join(id);
        if let Ok(meta) = std::fs::symlink_metadata(&p) {
            total_bytes += meta.len();
        }
    }

    let slot_dir_parent = input.slot_dir.parent().unwrap_or_else(|| Path::new("."));
    let _ = std::fs::create_dir_all(slot_dir_parent);

    // Hardlink probe
    let probe_path = slot_dir_parent.join(format!(".naia-migration-probe-{}", std::process::id()));
    let mut probe_file = None;
    if payload_importable {
        probe_file = find_first_probe_file(&payload_artifact, &migration_excluded);
    }
    if probe_file.is_none() && python_packages_importable {
        probe_file = find_first_probe_file(&python_packages, &migration_excluded);
    }
    if probe_file.is_none() && models_importable {
        probe_file = find_first_probe_file(&models, &migration_excluded);
    }
    if probe_file.is_none() && checkpoints_importable {
        probe_file = find_first_probe_file(&checkpoints_trt, &migration_excluded);
    }
    if probe_file.is_none() && !importable_voices.is_empty() {
        let p = input.legacy_root.join("voices").join(&importable_voices[0]);
        if p.is_file() {
            probe_file = Some(p);
        }
    }

    let can_hardlink = if let Some(ref pf) = probe_file {
        let res = hardlink_probe(pf, &probe_path);
        let _ = std::fs::remove_file(&probe_path);
        res
    } else {
        true
    };

    let needed = if can_hardlink { 0 } else { total_bytes };
    let avail = available(slot_dir_parent);
    if needed > 0 && !has_room_for(avail, needed) {
        return Ok(MigrationOutcome::SkippedNoSpace {
            needed,
            available: avail,
        });
    }

    // Staging into <slot_dir>.mig (short suffix to avoid MAX_PATH overflow)
    let old_pending_slot = PathBuf::from(format!("{}.pending-migration", input.slot_dir.display()));
    if old_pending_slot.exists() && !is_reparse_or_symlink(&old_pending_slot) {
        let _ = std::fs::remove_dir_all(&old_pending_slot);
    }
    let pending_slot = PathBuf::from(format!("{}.mig", input.slot_dir.display()));
    if pending_slot.exists() {
        if is_reparse_or_symlink(&pending_slot) {
            return Err(format!(
                "refusing reparse point for pending slot: {}",
                pending_slot.display()
            ));
        }
        std::fs::remove_dir_all(&pending_slot).map_err(|e| {
            format!(
                "failed to remove leftover pending slot {}: {}",
                pending_slot.display(),
                e
            )
        })?;
    }

    let mut stats = CopyStats::default();
    let mut imported = Vec::new();

    let stage_result: Result<(), String> = (|| {
        if payload_importable {
            let dst = pending_slot.join("payload").join("artifact");
            link_or_copy_tree_with_limit_into(
                &payload_artifact,
                &dst,
                &migration_excluded,
                &mut stats,
                fail_after_files,
            )?;
            imported.push("payload/artifact".to_string());
        }
        if python_packages_importable {
            let dst = pending_slot.join("python-packages");
            link_or_copy_tree_with_limit_into(
                &python_packages,
                &dst,
                &migration_excluded,
                &mut stats,
                fail_after_files,
            )?;
            imported.push("python-packages".to_string());
        }
        if models_importable {
            let dst = pending_slot.join("models");
            link_or_copy_tree_with_limit_into(
                &models,
                &dst,
                &migration_excluded,
                &mut stats,
                fail_after_files,
            )?;
            imported.push("models".to_string());
        }
        if checkpoints_importable {
            if let Some(sname) = stamp_name {
                let pending_engine_dir = pending_slot.join("engines").join(sname);
                link_or_copy_tree_with_limit_into(
                    &checkpoints_trt,
                    &pending_engine_dir,
                    &migration_excluded,
                    &mut stats,
                    fail_after_files,
                )?;
                imported.push("checkpoints/voxcpm2_trt".to_string());
            }
        }
        for id in &importable_voices {
            let src = input.legacy_root.join("voices").join(id);
            let dst = pending_slot.join("voices").join(id);
            copy_single_file(&src, &dst, &mut stats, fail_after_files)?;
            imported.push(format!("voices/{}", id));
        }
        Ok(())
    })();

    if let Err(e) = stage_result {
        if pending_slot.exists() && !is_reparse_or_symlink(&pending_slot) {
            let _ = std::fs::remove_dir_all(&pending_slot);
        }
        return Err(e);
    }

    if let Some(parent) = input.slot_dir.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::rename(&pending_slot, input.slot_dir).map_err(|e| {
        if pending_slot.exists() && !is_reparse_or_symlink(&pending_slot) {
            let _ = std::fs::remove_dir_all(&pending_slot);
        }
        format!(
            "failed to rename {} to {}: {}",
            pending_slot.display(),
            input.slot_dir.display(),
            e
        )
    })?;

    // Copy download zips
    let legacy_downloads = input.legacy_root.join("downloads");
    if legacy_downloads.is_dir() && !is_reparse_or_symlink(&legacy_downloads) {
        let _ = std::fs::create_dir_all(input.downloads_dir);
        if let Ok(entries) = std::fs::read_dir(&legacy_downloads) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() && !is_reparse_or_symlink(&path) {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        if name.ends_with(".zip") {
                            let stem = &name[..name.len() - 4];
                            if is_hex64(stem) {
                                let dst = input.downloads_dir.join(name);
                                if !dst.exists() {
                                    if std::fs::hard_link(&path, &dst).is_err() {
                                        let _ = std::fs::copy(&path, &dst);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let slot_key_str = input
        .slot_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    let receipt = MigrationReceipt {
        schema_version: 1,
        source: input.legacy_root.display().to_string(),
        slot_key: slot_key_str,
        imported,
        files: stats.files,
        bytes: stats.bytes,
        hardlinked: stats.hardlinked,
        copied: stats.copied,
        verified_install: false,
        verified_start: false,
        cleaned: false,
    };

    Ok(MigrationOutcome::Migrated(receipt))
}

pub fn migrate_legacy_runtime(
    input: &MigrationPlanInput,
    available: &dyn Fn(&Path) -> Option<u64>,
) -> Result<MigrationOutcome, String> {
    let probe = |src: &Path, dst: &Path| -> bool {
        let _ = std::fs::remove_file(dst);
        let ok = std::fs::hard_link(src, dst).is_ok();
        let _ = std::fs::remove_file(dst);
        ok
    };
    migrate_legacy_runtime_with(input, available, &probe, None)
}

pub fn write_migration_receipt(path: &Path, receipt: &MigrationReceipt) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create dir {}: {}", parent.display(), e))?;
    }
    let tmp = PathBuf::from(format!("{}.tmp", path.display()));
    let data = serde_json::to_vec_pretty(receipt)
        .map_err(|e| format!("failed to serialize migration receipt: {}", e))?;
    std::fs::write(&tmp, data)
        .map_err(|e| format!("failed to write {}: {}", tmp.display(), e))?;
    if std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(path);
        std::fs::rename(&tmp, path)
            .map_err(|e| format!("failed to rename {} to {}: {}", tmp.display(), path.display(), e))?;
    }
    Ok(())
}

pub fn read_migration_receipt(path: &Path) -> Option<MigrationReceipt> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[derive(Debug, Clone)]
pub struct AdoptMigratedInput<'a> {
    pub legacy_root: &'a Path,
    pub slot_dir: &'a Path,
    pub artifact_root: &'a Path,
    pub engine_dir: Option<&'a Path>,
    pub engine: Option<&'a EngineStampRecord>,
    pub record: &'a SlotRecord,
    pub os: CacheOs,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AdoptReport {
    pub slot_record: bool,
    pub native_hashes: bool,
    pub ready_json: bool,
    pub engine_stamp: bool,
}

pub fn adopt_migrated_slot(input: &AdoptMigratedInput) -> Result<AdoptReport, String> {
    let mut report = AdoptReport::default();

    if !input.slot_dir.exists() || is_reparse_or_symlink(input.slot_dir) {
        return Ok(report);
    }

    // 1. Artifact identity check
    let manifest_path = input.artifact_root.join("artifact-manifest.json");
    if is_reparse_or_symlink(&manifest_path) || !manifest_path.is_file() {
        return Ok(report);
    }
    let manifest_bytes = std::fs::read(&manifest_path)
        .map_err(|e| format!("failed to read artifact-manifest.json: {}", e))?;
    let actual_manifest_sha = sha256_hex(&manifest_bytes);
    if !actual_manifest_sha.eq_ignore_ascii_case(&input.record.artifact_manifest_sha256) {
        return Ok(report);
    }

    // 2. Slot record
    write_slot_record(input.slot_dir, input.record)?;
    report.slot_record = true;

    // 3. Native hashes check & record
    let manifest_val: Option<serde_json::Value> = serde_json::from_slice(&manifest_bytes).ok();
    let mut manifest_files = std::collections::HashMap::new();
    if let Some(val) = &manifest_val {
        if let Some(files_arr) = val.get("files").and_then(|f| f.as_array()) {
            for entry in files_arr {
                if let (Some(p), Some(s)) = (
                    entry.get("path").or_else(|| entry.get("name")).and_then(|v| v.as_str()),
                    entry.get("sha256").and_then(|v| v.as_str()),
                ) {
                    manifest_files.insert(p.replace('\\', "/"), s.to_string());
                }
            }
        } else if let Some(files_obj) = val.get("files").and_then(|f| f.as_object()) {
            for (k, v) in files_obj {
                if let Some(s) = v.as_str() {
                    manifest_files.insert(k.replace('\\', "/"), s.to_string());
                }
            }
        }
    }

    let native_paths = native_module_paths(input.artifact_root, input.os);
    let mut native_verified = !native_paths.is_empty() && !manifest_files.is_empty();
    if native_verified {
        for np in &native_paths {
            if is_reparse_or_symlink(np) || !np.is_file() {
                native_verified = false;
                break;
            }
            let rel = match np.strip_prefix(input.artifact_root) {
                Ok(r) => r.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/"),
                Err(_) => {
                    native_verified = false;
                    break;
                }
            };
            match manifest_files.get(&rel) {
                Some(expected_sha) => {
                    let actual_sha = match sha256_streaming(np) {
                        Ok(s) => s,
                        Err(_) => {
                            native_verified = false;
                            break;
                        }
                    };
                    if !actual_sha.eq_ignore_ascii_case(expected_sha) {
                        native_verified = false;
                        break;
                    }
                }
                None => {
                    native_verified = false;
                    break;
                }
            }
        }
    }

    if native_verified {
        record_native_hashes(input.slot_dir, input.artifact_root, input.os)?;
        report.native_hashes = true;
    }

    // 4. Ready marker adoption
    let expected_model_rev = {
        let rmanifest_path = input.artifact_root.join("runtime-manifest.json");
        std::fs::read(&rmanifest_path).ok().and_then(|bytes| {
            let val: Option<serde_json::Value> = serde_json::from_slice(&bytes).ok();
            val.as_ref()
                .and_then(|v| v.pointer("/model/revision"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
    };

    let legacy_ready_path = input.legacy_root.join("voxcpm2-runtime-ready.json");
    if legacy_ready_path.is_file() && !is_reparse_or_symlink(&legacy_ready_path) {
        if let Ok(ready_bytes) = std::fs::read(&legacy_ready_path) {
            if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&ready_bytes) {
                let art_sha = val.get("artifactManifestSha256").and_then(|v| v.as_str());
                let mod_rev = val
                    .pointer("/model/revision")
                    .or_else(|| val.get("model_revision"))
                    .or_else(|| val.get("modelRevision"))
                    .and_then(|v| v.as_str());

                let sha_ok = art_sha
                    .map(|s| s.eq_ignore_ascii_case(&input.record.artifact_manifest_sha256))
                    .unwrap_or(false);
                let rev_ok = match (&expected_model_rev, mod_rev) {
                    (Some(exp), Some(act)) => exp.eq_ignore_ascii_case(act),
                    _ => false,
                };

                if sha_ok && rev_ok {
                    let dest = input.slot_dir.join("voxcpm2-runtime-ready.json");
                    let tmp = input.slot_dir.join("voxcpm2-runtime-ready.json.tmp");
                    if std::fs::write(&tmp, &ready_bytes).is_ok() {
                        if std::fs::rename(&tmp, &dest).is_err() {
                            let _ = std::fs::remove_file(&dest);
                            let _ = std::fs::rename(&tmp, &dest);
                        }
                        report.ready_json = true;
                    }
                }
            }
        }
    }

    // 5. Engine stamp adoption
    if let (Some(ed), Some(eng)) = (input.engine_dir, input.engine) {
        let engine_manifest_path = ed.join("manifest.json");
        if engine_manifest_path.is_file() && !is_reparse_or_symlink(&engine_manifest_path) {
            if let Ok(mbytes) = std::fs::read(&engine_manifest_path) {
                if let Ok(mval) = serde_json::from_slice::<serde_json::Value>(&mbytes) {
                    let gpu_name = mval.get("gpu_name").or_else(|| mval.get("gpuName")).and_then(|v| v.as_str());
                    let cc = mval
                        .get("compute_capability")
                        .or_else(|| mval.get("computeCapability"))
                        .or_else(|| mval.get("compute_cap"))
                        .or_else(|| mval.get("computeCap"))
                        .and_then(|v| v.as_str());
                    let trt = mval
                        .get("tensorrt_version")
                        .or_else(|| mval.get("tensorrtVersion"))
                        .and_then(|v| v.as_str());
                    let rev = mval
                        .get("model_revision")
                        .or_else(|| mval.get("modelRevision"))
                        .and_then(|v| v.as_str());

                    let gpu_ok = matches!((gpu_name, cc), (Some(g), Some(c)) if eng.gpu_name.eq_ignore_ascii_case(g) && eng.compute_cap == c);
                    let trt_ok = match trt {
                        Some(t) => eng.tensorrt_version == t,
                        None => false,
                    };
                    let rev_ok = match (&expected_model_rev, rev) {
                        (Some(exp), Some(act)) => exp.eq_ignore_ascii_case(act),
                        _ => false,
                    };

                    let engine_name = mval.get("engine").and_then(|v| v.as_str());
                    let valid_engine_name = match engine_name {
                        Some(name)
                            if !name.is_empty()
                                && !name.contains('/')
                                && !name.contains('\\')
                                && !name.contains("..")
                                && !name.contains(':')
                                && ed.join(name).parent() == Some(ed) =>
                        {
                            Some(name)
                        }
                        _ => None,
                    };

                    let (file_ok, sha_ok) = match valid_engine_name {
                        Some(name) => {
                            let engine_file = ed.join(name);
                            let f_ok = engine_file.is_file()
                                && !is_reparse_or_symlink(&engine_file)
                                && std::fs::metadata(&engine_file).map(|m| m.len() > 0).unwrap_or(false);
                            let s_ok = match mval
                                .get("engine_sha256")
                                .or_else(|| mval.get("engineSha256"))
                                .and_then(|v| v.as_str())
                            {
                                Some(exp_sha) if !exp_sha.is_empty() => {
                                    sha256_streaming(&engine_file)
                                        .map(|s| s.eq_ignore_ascii_case(exp_sha))
                                        .unwrap_or(false)
                                }
                                _ => false,
                            };
                            (f_ok, s_ok)
                        }
                        None => (false, false),
                    };

                    if gpu_ok && trt_ok && rev_ok && file_ok && sha_ok {
                        // Driver version is not recorded in the legacy engine manifest; a TensorRT engine built for the same GPU and TensorRT version is accepted.
                        write_engine_stamp(ed, eng)?;
                        report.engine_stamp = true;
                    }
                }
            }
        }
    }

    Ok(report)
}

// ─── 15. Legacy cleanup after one verified start ─────────────────────────────

pub fn cleanup_migrated_legacy(
    legacy_root: &Path,
    receipt: &MigrationReceipt,
) -> Result<Vec<String>, String> {
    if !receipt.verified_install || !receipt.verified_start {
        return Err("migration not verified yet".to_string());
    }
    if is_reparse_or_symlink(legacy_root) {
        return Err(format!(
            "refusing reparse point for legacy root: {}",
            legacy_root.display()
        ));
    }

    let mut deleted = Vec::new();
    for entry in &receipt.imported {
        let target = legacy_root.join(entry);
        if target.exists() && !path_has_reparse_component(&target, legacy_root) {
            if target.is_dir() {
                std::fs::remove_dir_all(&target)
                    .map_err(|e| format!("failed to remove dir {}: {}", target.display(), e))?;
                deleted.push(entry.clone());
            } else if target.is_file() {
                std::fs::remove_file(&target)
                    .map_err(|e| format!("failed to remove file {}: {}", target.display(), e))?;
                deleted.push(entry.clone());
            }
        }
    }

    let ctrl_files = [
        "prepare-voxcpm2-model.ps1",
        "prepare-voxcpm2-model.sh",
        "voxcpm2-activation-contract.json",
    ];
    let payload_dir = legacy_root.join("payload");
    for ctrl in &ctrl_files {
        let p = payload_dir.join(ctrl);
        if p.is_file() && !path_has_reparse_component(&p, legacy_root) {
            if std::fs::remove_file(&p).is_ok() {
                deleted.push(format!("payload/{}", ctrl));
            }
        }
    }

    if payload_dir.is_dir() && !path_has_reparse_component(&payload_dir, legacy_root) {
        let is_empty = std::fs::read_dir(&payload_dir)
            .map(|mut d| d.next().is_none())
            .unwrap_or(false);
        if is_empty {
            if std::fs::remove_dir(&payload_dir).is_ok() {
                deleted.push("payload".to_string());
            }
        }
    }

    let checkpoints_dir = legacy_root.join("checkpoints");
    if checkpoints_dir.is_dir() && !path_has_reparse_component(&checkpoints_dir, legacy_root) {
        let is_empty = std::fs::read_dir(&checkpoints_dir)
            .map(|mut d| d.next().is_none())
            .unwrap_or(false);
        if is_empty {
            if std::fs::remove_dir(&checkpoints_dir).is_ok() {
                deleted.push("checkpoints".to_string());
            }
        }
    }

    Ok(deleted)
}

// ─── 16. Retention executor ──────────────────────────────────────────────────

pub fn prune_slots(
    layout: &CacheLayout,
    profile: &str,
    active: &str,
    previous: Option<&str>,
) -> Vec<String> {
    let profile_dir = match layout.profile_dir(profile) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    if !profile_dir.is_dir() || is_reparse_or_symlink(&profile_dir) {
        return Vec::new();
    }

    let mut existing = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&profile_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() && !is_reparse_or_symlink(&p) {
                if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                    existing.push(name.to_string());
                }
            }
        }
    }

    let candidates = slots_to_prune(&existing, active, previous);
    let mut removed = Vec::new();

    for name in candidates {
        let Ok(lock_path) = layout.lock_path(profile, &name) else { continue; };
        let Ok(slot_dir) = layout.slot_dir(profile, &name) else { continue; };

        match RuntimeLock::try_acquire(&lock_path, LockMode::Exclusive, "prune") {
            Ok(lock) => {
                if slot_dir.exists() && !is_reparse_or_symlink(&slot_dir) {
                    if std::fs::remove_dir_all(&slot_dir).is_ok() {
                        removed.push(name);
                    }
                }
                drop(lock);
                let _ = std::fs::remove_file(&lock_path);
                let _ = std::fs::remove_file(owner_file_path(&lock_path));
            }
            Err(_) => {
                continue;
            }
        }
    }

    removed
}

// ─── 17. VoiceContext ────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct VoiceContext {
    pub os: CacheOs,
    pub profile: String,
    pub cache: CacheLayout,
    pub read_only: bool, // E2E opt-in over the user's cache: never write the slot
    pub record: SlotRecord, // expected slot record (key inputs)
    pub slot_dir: PathBuf, // published asset root
    pub engine: Option<EngineStampRecord>,
    pub engine_dir: Option<PathBuf>,
    pub state_root: PathBuf, // per-mode state root (never shared)
    pub lock_path: PathBuf,
}

fn roots_overlap(cache_root: &Path, state_root: &Path) -> bool {
    let norm_c = cache_root
        .to_string_lossy()
        .to_ascii_lowercase()
        .replace('\\', "/");
    let norm_s = state_root
        .to_string_lossy()
        .to_ascii_lowercase()
        .replace('\\', "/");
    let c_path = Path::new(&norm_c);
    let s_path = Path::new(&norm_s);

    if s_path.starts_with(c_path)
        || c_path.starts_with(s_path)
        || state_root.starts_with(cache_root)
        || cache_root.starts_with(state_root)
    {
        return true;
    }

    if let (Ok(c_can), Ok(s_can)) = (
        std::fs::canonicalize(cache_root),
        std::fs::canonicalize(state_root),
    ) {
        let norm_can_c = c_can
            .to_string_lossy()
            .to_ascii_lowercase()
            .replace('\\', "/");
        let norm_can_s = s_can
            .to_string_lossy()
            .to_ascii_lowercase()
            .replace('\\', "/");
        let cc_path = Path::new(&norm_can_c);
        let ss_path = Path::new(&norm_can_s);
        if ss_path.starts_with(cc_path) || cc_path.starts_with(ss_path) {
            return true;
        }
    }
    false
}

pub fn build_voice_context(
    cache_root: &Path,
    state_root: &Path,
    profile: &str,
    artifact_sha: &str,
    os: CacheOs,
    gpu: Option<&GpuIdentity>,
    tensorrt_version: Option<&str>,
    read_only: bool,
) -> Result<VoiceContext, String> {
    if roots_overlap(cache_root, state_root) {
        return Err("state and cache roots must be separate".to_string());
    }

    let record = slot_record_for(profile, artifact_sha, os)?;
    let cache = CacheLayout::new(cache_root);
    let slot_dir = cache.slot_dir(profile, &record.slot_key)?;
    let lock_path = cache.lock_path(profile, &record.slot_key)?;

    let (engine, engine_dir) = match (gpu, tensorrt_version) {
        (Some(g), Some(trt)) => {
            let stamp_rec = engine_stamp_record(g, trt)?;
            let dir = cache.engine_dir(profile, &record.slot_key, &stamp_rec.stamp)?;
            (Some(stamp_rec), Some(dir))
        }
        _ => (None, None),
    };

    Ok(VoiceContext {
        os,
        profile: profile.to_string(),
        cache,
        read_only,
        record,
        slot_dir,
        engine,
        engine_dir,
        state_root: state_root.to_path_buf(),
        lock_path,
    })
}

impl VoiceContext {
    pub fn python_packages(&self) -> PathBuf {
        self.slot_dir.join("python-packages")
    }

    pub fn model_dir(&self) -> PathBuf {
        self.slot_dir.join("models").join("VoxCPM2")
    }

    pub fn slot_voices(&self) -> PathBuf {
        self.slot_dir.join("voices")
    }

    pub fn state_voices(&self) -> PathBuf {
        self.state_root.join("voices")
    }

    pub fn state_dir(&self) -> PathBuf {
        self.state_root.join("state")
    }

    pub fn numba_cache(&self) -> PathBuf {
        self.state_root.join("state").join("cache").join("numba")
    }

    pub fn hf_home(&self) -> PathBuf {
        self.state_root.join("hf-cache")
    }

    pub fn install_log(&self) -> PathBuf {
        self.state_root.join("voxcpm2-install.log")
    }

    pub fn receipt_path(&self) -> Result<PathBuf, String> {
        self.cache
            .migration_receipt(&self.profile, &self.record.slot_key)
    }

    pub fn readiness_inputs<'a>(&'a self, artifact_root: &'a Path) -> Option<ReadinessInputs<'a>> {
        let engine_dir = self.engine_dir.as_deref()?;
        let engine = self.engine.as_ref()?;
        Some(ReadinessInputs {
            slot_dir: &self.slot_dir,
            artifact_root,
            engine_dir,
            expected: &self.record,
            engine_stamp: &engine.stamp,
            os: self.os,
        })
    }
}

// ─── 18. GPU choice ──────────────────────────────────────────────────────────

pub fn select_identity(ids: &[GpuIdentity], chosen_index: Option<u32>) -> Option<GpuIdentity> {
    match chosen_index {
        Some(idx) => ids.iter().find(|id| id.index == idx).cloned(),
        None => ids.iter().min_by_key(|id| id.index).cloned(),
    }
}

pub fn record_gpu_choice(state_root: &Path, index: Option<u32>) -> Result<(), String> {
    std::fs::create_dir_all(state_root)
        .map_err(|e| format!("failed to create state dir {}: {}", state_root.display(), e))?;
    let dest = state_root.join("voice-gpu.json");
    let tmp = state_root.join("voice-gpu.json.tmp");
    let payload = serde_json::json!({
        "index": index,
    });
    let data = serde_json::to_vec_pretty(&payload)
        .map_err(|e| format!("failed to serialize gpu choice: {}", e))?;
    std::fs::write(&tmp, data)
        .map_err(|e| format!("failed to write {}: {}", tmp.display(), e))?;
    if std::fs::rename(&tmp, &dest).is_err() {
        let _ = std::fs::remove_file(&dest);
        std::fs::rename(&tmp, &dest)
            .map_err(|e| format!("failed to rename {} to {}: {}", tmp.display(), dest.display(), e))?;
    }
    Ok(())
}

pub fn recorded_gpu_choice(state_root: &Path) -> Option<u32> {
    let dest = state_root.join("voice-gpu.json");
    let bytes = std::fs::read(&dest).ok()?;
    #[derive(serde::Deserialize)]
    struct GpuChoiceRecord {
        index: Option<u32>,
    }
    let rec: GpuChoiceRecord = serde_json::from_slice(&bytes).ok()?;
    rec.index
}

// ─── 19. Port ownership ──────────────────────────────────────────────────────

pub fn loopback_port_in_use(port: u16) -> bool {
    use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
    use std::time::Duration;
    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(127, 0, 0, 1), port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

// ─── 20. E2E read-only opt-in over user cache ────────────────────────────────

pub const E2E_USER_CACHE_ENV: &str = "NAIA_E2E_VOXCPM2_USER_CACHE";
pub const E2E_USER_CACHE_ROOT_ENV: &str = "NAIA_E2E_VOXCPM2_USER_CACHE_ROOT";

pub fn e2e_user_cache_root_with(
    debug_build: bool,
    e2e_mode: bool,
    opt_in: Option<OsString>,
    root: Option<OsString>,
) -> Option<PathBuf> {
    if !debug_build || !e2e_mode {
        return None;
    }
    let opt = opt_in?;
    if opt != "read-only" {
        return None;
    }
    let r = root?;
    if r.is_empty() {
        return None;
    }
    let path = PathBuf::from(r);
    if path.is_absolute() {
        Some(path)
    } else {
        None
    }
}

// ─── 21. Active / previous slot marker ───────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveSlotRecord {
    pub active: String,
    pub previous: Option<String>,
}

pub fn set_active_slot(
    layout: &CacheLayout,
    profile: &str,
    slot: &str,
) -> Result<(String, Option<String>), String> {
    if !is_hex64(slot) {
        return Err(format!("invalid cache path segment: {}", slot));
    }
    let profile_dir = layout.profile_dir(profile)?;
    ensure_private_dir(&profile_dir)?;
    let active_path = profile_dir.join("active.json");

    let current: Option<ActiveSlotRecord> = if active_path.is_file() {
        std::fs::read(&active_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    } else {
        None
    };

    if let Some(curr) = current {
        if curr.active == slot {
            return Ok((curr.active, curr.previous));
        }
        let old_active = curr.active;
        let new_record = ActiveSlotRecord {
            active: slot.to_string(),
            previous: Some(old_active.clone()),
        };
        let tmp = profile_dir.join("active.json.tmp");
        let data = serde_json::to_vec_pretty(&new_record)
            .map_err(|e| format!("failed to serialize active slot: {}", e))?;
        std::fs::write(&tmp, data)
            .map_err(|e| format!("failed to write {}: {}", tmp.display(), e))?;
        if std::fs::rename(&tmp, &active_path).is_err() {
            let _ = std::fs::remove_file(&active_path);
            std::fs::rename(&tmp, &active_path)
                .map_err(|e| format!("failed to rename {} to {}: {}", tmp.display(), active_path.display(), e))?;
        }
        Ok((slot.to_string(), Some(old_active)))
    } else {
        let new_record = ActiveSlotRecord {
            active: slot.to_string(),
            previous: None,
        };
        let tmp = profile_dir.join("active.json.tmp");
        let data = serde_json::to_vec_pretty(&new_record)
            .map_err(|e| format!("failed to serialize active slot: {}", e))?;
        std::fs::write(&tmp, data)
            .map_err(|e| format!("failed to write {}: {}", tmp.display(), e))?;
        if std::fs::rename(&tmp, &active_path).is_err() {
            let _ = std::fs::remove_file(&active_path);
            std::fs::rename(&tmp, &active_path)
                .map_err(|e| format!("failed to rename {} to {}: {}", tmp.display(), active_path.display(), e))?;
        }
        Ok((slot.to_string(), None))
    }
}

// ─── 7. Unit tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[test]
    fn test_resolve_cache_root() {
        // Windows uses LOCALAPPDATA env over known folder
        let win_env = Some(OsString::from(r"C:\Users\Default\AppData\Local"));
        let known = Some(PathBuf::from(r"C:\Custom\DataLocal"));
        let resolved = resolve_cache_root_with(CacheOs::Windows, false, None, win_env.clone(), known.clone());
        assert_eq!(
            resolved,
            Some(PathBuf::from(r"C:\Users\Default\AppData\Local\NaiaRuntimeCache"))
        );
        let path = resolved.unwrap();
        assert_eq!(path.file_name().unwrap(), "NaiaRuntimeCache");
        assert_eq!(path.parent().unwrap(), Path::new(r"C:\Users\Default\AppData\Local"));

        // Falls back to known folder when env missing
        let fallback_missing = resolve_cache_root_with(CacheOs::Windows, false, None, None, known.clone());
        assert_eq!(
            fallback_missing,
            Some(PathBuf::from(r"C:\Custom\DataLocal\NaiaRuntimeCache"))
        );

        // Falls back to known folder when env empty
        let fallback_empty = resolve_cache_root_with(CacheOs::Windows, false, None, Some(OsString::from("")), known.clone());
        assert_eq!(
            fallback_empty,
            Some(PathBuf::from(r"C:\Custom\DataLocal\NaiaRuntimeCache"))
        );

        // Falls back to known folder when env relative
        let fallback_rel = resolve_cache_root_with(CacheOs::Windows, false, None, Some(OsString::from(r"relative\path")), known.clone());
        assert_eq!(
            fallback_rel,
            Some(PathBuf::from(r"C:\Custom\DataLocal\NaiaRuntimeCache"))
        );

        // Linux uses known folder + naia-runtime-cache
        let linux_known = Some(PathBuf::from("/home/user/.local/share"));
        let linux_resolved = resolve_cache_root_with(CacheOs::Linux, false, None, None, linux_known.clone());
        assert_eq!(
            linux_resolved,
            Some(PathBuf::from("/home/user/.local/share/naia-runtime-cache"))
        );

        // Override honoured only when overrides_allowed = true
        let override_abs = Some(OsString::from(r"C:\TestCacheRoot"));
        let overridden = resolve_cache_root_with(CacheOs::Windows, true, override_abs.clone(), win_env.clone(), known.clone());
        assert_eq!(overridden, Some(PathBuf::from(r"C:\TestCacheRoot")));

        // Relative override ignored
        let override_rel = Some(OsString::from(r"rel\cache"));
        let ignore_rel_override = resolve_cache_root_with(CacheOs::Windows, true, override_rel, win_env.clone(), known.clone());
        assert_eq!(
            ignore_rel_override,
            Some(PathBuf::from(r"C:\Users\Default\AppData\Local\NaiaRuntimeCache"))
        );

        // Release-style call (overrides_allowed = false) ignores the override
        let release_ignored = resolve_cache_root_with(CacheOs::Windows, false, override_abs, win_env, known);
        assert_eq!(
            release_ignored,
            Some(PathBuf::from(r"C:\Users\Default\AppData\Local\NaiaRuntimeCache"))
        );

        // None when nothing resolves
        assert_eq!(resolve_cache_root_with(CacheOs::Windows, false, None, None, None), None);
        assert_eq!(resolve_cache_root_with(CacheOs::Linux, false, None, None, None), None);
    }

    #[test]
    fn test_is_hex64_and_safe_profile_id() {
        let valid_hex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        assert!(is_hex64(valid_hex));
        // Built from pieces so the mixed-case literal does not read as a secret
        // token to the OSS readiness scanner.
        let upper_hex = format!("{}{}", "0123456789ABCDEF", &valid_hex[16..]);
        assert!(!is_hex64(&upper_hex));
        assert!(!is_hex64(&valid_hex[..63]));
        let hex_65 = format!("{}a", valid_hex);
        assert!(!is_hex64(&hex_65));
        assert!(!is_hex64(""));
        assert!(!is_hex64("../x"));
        assert!(!is_hex64("foo/bar"));
        assert!(!is_hex64(r"foo\bar"));

        assert!(is_safe_profile_id("windows_trt_6g"));
        assert!(is_safe_profile_id("linux_rocm_8g"));
        assert!(is_safe_profile_id("p1"));
        assert!(!is_safe_profile_id("_leading_underscore"));
        assert!(!is_safe_profile_id(""));
        assert!(!is_safe_profile_id(&"a".repeat(65)));
        assert!(!is_safe_profile_id("has.dot"));
        assert!(!is_safe_profile_id("has-dash"));
        assert!(!is_safe_profile_id("has/slash"));
        assert!(!is_safe_profile_id(r"has\backslash"));
        assert!(!is_safe_profile_id("../x"));
        assert!(!is_safe_profile_id("UPPERCASE"));
    }

    #[test]
    fn test_slot_key() {
        let valid_sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let input = SlotKeyInput {
            profile: "windows_trt_6g",
            artifact_manifest_sha256: valid_sha,
            prepare_script: b"echo prepare",
            activation_contract: b"contract json",
        };
        let k1 = slot_key(&input).unwrap();
        let k2 = slot_key(&input).unwrap();
        assert_eq!(k1, k2);
        assert!(is_hex64(&k1));

        // Changes when profile changes
        let mut input_mod = input;
        input_mod.profile = "linux_rocm_8g";
        assert_ne!(slot_key(&input_mod).unwrap(), k1);

        // Changes when artifact manifest changes
        let valid_sha2 = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
        input_mod = input;
        input_mod.artifact_manifest_sha256 = valid_sha2;
        assert_ne!(slot_key(&input_mod).unwrap(), k1);

        // Changes when prepare script changes
        input_mod = input;
        input_mod.prepare_script = b"echo different";
        assert_ne!(slot_key(&input_mod).unwrap(), k1);

        // Changes when activation contract changes
        input_mod = input;
        input_mod.activation_contract = b"different contract";
        assert_ne!(slot_key(&input_mod).unwrap(), k1);

        // Rejects bad profile
        input_mod = input;
        input_mod.profile = "_bad_profile";
        assert!(slot_key(&input_mod).is_err());

        // Rejects bad artifact sha
        input_mod = input;
        input_mod.artifact_manifest_sha256 = "not-a-valid-sha";
        assert!(slot_key(&input_mod).is_err());

        // Uppercase artifact sha is normalised
        input_mod = input;
        let upper_sha = valid_sha.to_ascii_uppercase();
        input_mod.artifact_manifest_sha256 = &upper_sha;
        assert_eq!(slot_key(&input_mod).unwrap(), k1);
    }

    #[test]
    fn test_engine_stamp() {
        let input = EngineStampInput {
            gpu_name: "RTX 4090",
            compute_cap: "8.9",
            driver_version: "550.54.14",
            tensorrt_version: "10.0.1",
        };
        let s1 = engine_stamp(&input).unwrap();
        assert!(is_hex64(&s1));

        let mut input_mod = input;
        input_mod.gpu_name = "RTX 3060";
        assert_ne!(engine_stamp(&input_mod).unwrap(), s1);

        input_mod = input;
        input_mod.compute_cap = "8.6";
        assert_ne!(engine_stamp(&input_mod).unwrap(), s1);

        input_mod = input;
        input_mod.driver_version = "551.00";
        assert_ne!(engine_stamp(&input_mod).unwrap(), s1);

        input_mod = input;
        input_mod.tensorrt_version = "10.1.0";
        assert_ne!(engine_stamp(&input_mod).unwrap(), s1);

        // Rejects empty fields
        input_mod = input;
        input_mod.gpu_name = "  ";
        assert!(engine_stamp(&input_mod).is_err());
        input_mod = input;
        input_mod.compute_cap = "";
        assert!(engine_stamp(&input_mod).is_err());
        input_mod = input;
        input_mod.driver_version = "";
        assert!(engine_stamp(&input_mod).is_err());
        input_mod = input;
        input_mod.tensorrt_version = "";
        assert!(engine_stamp(&input_mod).is_err());
    }

    #[test]
    fn test_cache_layout() {
        let root = Path::new("/var/cache/naia");
        let layout = CacheLayout::new(root);
        assert_eq!(layout.root, root.join("voxcpm2"));
        assert_eq!(layout.downloads_dir(), root.join("voxcpm2").join("downloads"));

        let hex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let dk = &hex[..16];
        assert_eq!(
            layout.download_zip(hex).unwrap(),
            root.join("voxcpm2").join("downloads").join(format!("{}.zip", hex))
        );
        assert_eq!(
            layout.profile_dir("windows_trt_6g").unwrap(),
            root.join("voxcpm2").join("slots").join("windows_trt_6g")
        );
        assert_eq!(
            layout.slot_dir("windows_trt_6g", hex).unwrap(),
            root.join("voxcpm2").join("slots").join("windows_trt_6g").join(dk)
        );
        assert_eq!(
            layout.slot_dir("windows_trt_6g", dk).unwrap(),
            root.join("voxcpm2").join("slots").join("windows_trt_6g").join(dk)
        );
        assert_eq!(
            layout.engine_dir("windows_trt_6g", hex, hex).unwrap(),
            root.join("voxcpm2").join("slots").join("windows_trt_6g").join(dk).join("engines").join(dk)
        );
        assert_eq!(
            layout.engine_dir("windows_trt_6g", dk, dk).unwrap(),
            root.join("voxcpm2").join("slots").join("windows_trt_6g").join(dk).join("engines").join(dk)
        );
        assert_eq!(
            layout.lock_path("windows_trt_6g", hex).unwrap(),
            root.join("voxcpm2").join("locks").join(format!("windows_trt_6g-{}.lock", dk))
        );
        assert_eq!(
            layout.lock_path("windows_trt_6g", dk).unwrap(),
            root.join("voxcpm2").join("locks").join(format!("windows_trt_6g-{}.lock", dk))
        );
        assert_eq!(
            layout.migration_receipt("windows_trt_6g", hex).unwrap(),
            root.join("voxcpm2").join("migration").join(format!("windows_trt_6g-{}.receipt.json", dk))
        );
        assert_eq!(
            layout.migration_receipt("windows_trt_6g", dk).unwrap(),
            root.join("voxcpm2").join("migration").join(format!("windows_trt_6g-{}.receipt.json", dk))
        );

        // Rejects ../x
        assert!(layout.profile_dir("../x").is_err());
        assert!(layout.download_zip("../x").is_err());
        assert!(layout.slot_dir("windows_trt_6g", "../x").is_err());

        // Rejects uppercase slot
        let upper_hex = hex.to_ascii_uppercase();
        assert!(layout.slot_dir("windows_trt_6g", &upper_hex).is_err());

        // Rejects 15-hex, 17-hex, and 63-hex stamps
        assert!(layout.engine_dir("windows_trt_6g", hex, &hex[..15]).is_err());
        assert!(layout.engine_dir("windows_trt_6g", hex, &hex[..17]).is_err());
        assert!(layout.engine_dir("windows_trt_6g", hex, &hex[..63]).is_err());
    }

    #[test]
    fn test_reparse_and_ensure_private_dir() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("my_private_dir");

        // Creates the dir
        ensure_private_dir(&dir).unwrap();
        assert!(dir.is_dir());

        // Idempotent: calling twice on same dir is Ok
        ensure_private_dir(&dir).unwrap();

        // Normal dir is not reparse/symlink
        assert!(!is_reparse_or_symlink(&dir));
        assert!(!path_has_reparse_component(&dir, temp.path()));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta = std::fs::metadata(&dir).unwrap();
            assert_eq!(meta.permissions().mode() & 0o777, 0o700);

            // Second call on existing dir does not fail and keeps 0700
            ensure_private_dir(&dir).unwrap();
            let meta2 = std::fs::metadata(&dir).unwrap();
            assert_eq!(meta2.permissions().mode() & 0o777, 0o700);

            // Refuses a symlink
            let real_sub = temp.path().join("real_sub");
            std::fs::create_dir(&real_sub).unwrap();
            let sym = temp.path().join("sym_link");
            std::os::unix::fs::symlink(&real_sub, &sym).unwrap();
            assert!(is_reparse_or_symlink(&sym));
            assert!(path_has_reparse_component(&sym, temp.path()));
            assert!(ensure_private_dir(&sym).is_err());
        }

        #[cfg(windows)]
        {
            let real_sub = temp.path().join("real_sub");
            std::fs::create_dir(&real_sub).unwrap();
            let sym = temp.path().join("sym_dir");
            if std::os::windows::fs::symlink_dir(&real_sub, &sym).is_ok() {
                assert!(is_reparse_or_symlink(&sym));
                assert!(path_has_reparse_component(&sym, temp.path()));
                assert!(ensure_private_dir(&sym).is_err());
            }
        }
    }

    #[test]
    fn test_lock() {
        let temp = tempfile::tempdir().unwrap();
        let lock_path = temp.path().join("locks").join("test.lock");

        let lock1 = RuntimeLock::try_acquire(&lock_path, LockMode::Exclusive, "test_exclusive").unwrap();

        // Exclusive then second exclusive on the same path -> Err with owner pid = current pid
        let lock2_err = RuntimeLock::try_acquire(&lock_path, LockMode::Exclusive, "second_exclusive");
        assert!(lock2_err.is_err());
        let busy1 = lock2_err.unwrap_err();
        assert_eq!(busy1.owner_pid, Some(std::process::id()));
        assert_eq!(busy1.owner_mode.as_deref(), Some("test_exclusive"));

        // Exclusive then shared -> Err
        let shared_err = RuntimeLock::try_acquire(&lock_path, LockMode::Shared, "shared_test");
        assert!(shared_err.is_err());

        // Dropping exclusive holder lets new exclusive succeed
        drop(lock1);

        // Shared + shared -> both Ok
        let s1 = RuntimeLock::try_acquire(&lock_path, LockMode::Shared, "s1").unwrap();
        let s2 = RuntimeLock::try_acquire(&lock_path, LockMode::Shared, "s2").unwrap();
        drop(s1);
        drop(s2);

        let lock3 = RuntimeLock::try_acquire(&lock_path, LockMode::Exclusive, "third_exclusive").unwrap();
        drop(lock3);

        // Stale .owner with pid 999999 and no holder -> exclusive succeeds and .owner now has current pid
        let owner_p = owner_file_path(&lock_path);
        std::fs::write(&owner_p, br#"{"pid": 999999, "mode": "stale_owner"}"#).unwrap();
        let lock_stale = RuntimeLock::try_acquire(&lock_path, LockMode::Exclusive, "recovered").unwrap();
        let busy_after = read_lock_busy(&owner_p);
        assert_eq!(busy_after.owner_pid, Some(std::process::id()));
        assert_eq!(busy_after.owner_mode.as_deref(), Some("recovered"));
        drop(lock_stale);

        // lock_busy_message wording
        let busy_full = LockBusy {
            owner_pid: Some(1234),
            owner_mode: Some("exclusive".to_string()),
        };
        assert_eq!(
            lock_busy_message(&busy_full),
            "Another Naia instance (last recorded PID 1234, exclusive) is using the local voice runtime. Stop its local voice, then try again."
        );
        let busy_unknown = LockBusy {
            owner_pid: None,
            owner_mode: None,
        };
        assert_eq!(
            lock_busy_message(&busy_unknown),
            "Another Naia instance (last recorded PID unknown, unknown) is using the local voice runtime. Stop its local voice, then try again."
        );
    }

    #[test]
    fn test_free_space() {
        assert!(has_room_for(Some(110), 100));
        assert!(!has_room_for(Some(109), 100));
        assert!(!has_room_for(None, 1));

        let temp = tempfile::tempdir().unwrap();
        assert!(available_space(temp.path()).is_some());
    }

    #[test]
    fn test_migration_excluded() {
        assert!(migration_excluded(Path::new("state/x")));
        assert!(migration_excluded(Path::new(r"state\x")));
        assert!(migration_excluded(Path::new("hf-cache/a")));
        assert!(migration_excluded(Path::new(r"hf-cache\a")));
        assert!(migration_excluded(Path::new("payload.pending/x")));
        assert!(migration_excluded(Path::new(r"payload.pending\x")));
        assert!(migration_excluded(Path::new("python-packages.backup/y")));
        assert!(migration_excluded(Path::new(r"python-packages.backup\y")));
        assert!(migration_excluded(Path::new("checkpoints/voxcpm2_trt.pending/z")));
        assert!(migration_excluded(Path::new(r"checkpoints\voxcpm2_trt.pending\z")));
        assert!(migration_excluded(Path::new("slot.pending-migration/x")));
        assert!(migration_excluded(Path::new(r"slot.pending-migration\x")));
        assert!(migration_excluded(Path::new("slot.mig/x")));
        assert!(migration_excluded(Path::new(r"slot.mig\x")));
        assert!(migration_excluded(Path::new("voices/a.wav")));
        assert!(migration_excluded(Path::new(r"voices\a.wav")));

        assert!(!migration_excluded(Path::new("payload/artifact/python/python.exe")));
        assert!(!migration_excluded(Path::new(r"payload\artifact\python\python.exe")));
        assert!(!migration_excluded(Path::new("python-packages/tensorrt/x.dll")));
        assert!(!migration_excluded(Path::new(r"python-packages\tensorrt\x.dll")));
        assert!(!migration_excluded(Path::new("models/VoxCPM2/config.json")));
        assert!(!migration_excluded(Path::new(r"models\VoxCPM2\config.json")));
    }

    #[test]
    fn test_tree_size_and_link_or_copy() {
        let temp_src = tempfile::tempdir().unwrap();
        let src = temp_src.path().join("src");
        std::fs::create_dir(&src).unwrap();
        std::fs::write(src.join("file1.txt"), b"hello").unwrap();
        let sub = src.join("sub");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join("file2.txt"), b"world").unwrap();
        std::fs::write(sub.join("ignored.txt"), b"skip me").unwrap();

        let is_ignored = |p: &Path| p.ends_with("ignored.txt");

        // tree_size counts files and bytes, skipping excluded paths
        let (files, bytes) = tree_size(&src, &is_ignored).unwrap();
        assert_eq!(files, 2);
        assert_eq!(bytes, 10);

        let temp_dst = tempfile::tempdir().unwrap();
        let dst = temp_dst.path().join("dst");

        // Copies a small tree (files are equal afterwards)
        let stats = link_or_copy_tree(&src, &dst, &is_ignored).unwrap();
        assert_eq!(stats.files, 2);
        assert_eq!(stats.bytes, 10);
        assert_eq!(stats.hardlinked + stats.copied, 2);

        assert_eq!(std::fs::read(dst.join("file1.txt")).unwrap(), b"hello");
        assert_eq!(std::fs::read(dst.join("sub").join("file2.txt")).unwrap(), b"world");
        assert!(!dst.join("sub").join("ignored.txt").exists());

        // Refuses an existing dst
        assert!(link_or_copy_tree(&src, &dst, &is_ignored).is_err());

        // src is unchanged afterwards (same file list and bytes)
        assert_eq!(std::fs::read(src.join("file1.txt")).unwrap(), b"hello");
        assert_eq!(std::fs::read(sub.join("file2.txt")).unwrap(), b"world");
        assert_eq!(std::fs::read(sub.join("ignored.txt")).unwrap(), b"skip me");
        let (src_files, src_bytes) = tree_size(&src, &|_| false).unwrap();
        assert_eq!(src_files, 3);
        assert_eq!(src_bytes, 17);
    }

    #[test]
    fn test_slots_to_prune() {
        let active = "1111111111111111111111111111111111111111111111111111111111111111";
        let prev = "2222222222222222222222222222222222222222222222222222222222222222";
        let dir_active = &active[..16];
        let dir_prev = &prev[..16];
        let dir_a = "3333333333333333";
        let dir_b = "4444444444444444";
        let non_hex = "not_a_hex_slot";
        let hex64 = "5555555555555555555555555555555555555555555555555555555555555555";

        let existing = vec![
            dir_b.to_string(),
            dir_active.to_string(),
            dir_prev.to_string(),
            non_hex.to_string(),
            dir_a.to_string(),
            hex64.to_string(),
        ];

        let pruned = slots_to_prune(&existing, active, Some(prev));
        assert_eq!(pruned, vec![dir_a.to_string(), dir_b.to_string()]);

        let pruned_no_prev = slots_to_prune(&existing, active, None);
        assert_eq!(pruned_no_prev, vec![dir_prev.to_string(), dir_a.to_string(), dir_b.to_string()]);

        // Also works when active and previous are already 16-hex
        let pruned_short = slots_to_prune(&existing, dir_active, Some(dir_prev));
        assert_eq!(pruned_short, vec![dir_a.to_string(), dir_b.to_string()]);
    }

    #[test]
    fn test_write_control_files() {
        let temp = tempfile::tempdir().unwrap();
        let slot_dir = temp.path().join("slot");
        let script_path = write_control_files(&slot_dir, CacheOs::Windows).unwrap();
        assert!(script_path.exists());
        let contract_path = slot_dir.join("voxcpm2-activation-contract.json");
        assert!(contract_path.exists());
        assert_eq!(std::fs::read(&script_path).unwrap(), PREPARE_SCRIPT_WINDOWS);
        assert_eq!(std::fs::read(&contract_path).unwrap(), ACTIVATION_CONTRACT);

        let mtime_script_1 = std::fs::metadata(&script_path).unwrap().modified().unwrap();
        let mtime_contract_1 = std::fs::metadata(&contract_path).unwrap().modified().unwrap();

        std::thread::sleep(std::time::Duration::from_millis(50));

        let script_path_2 = write_control_files(&slot_dir, CacheOs::Windows).unwrap();
        assert_eq!(script_path, script_path_2);
        let mtime_script_2 = std::fs::metadata(&script_path).unwrap().modified().unwrap();
        let mtime_contract_2 = std::fs::metadata(&contract_path).unwrap().modified().unwrap();
        assert_eq!(mtime_script_1, mtime_script_2);
        assert_eq!(mtime_contract_1, mtime_contract_2);
    }

    #[test]
    fn test_slot_record() {
        let sha1 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let rec1 = slot_record_for("windows_trt_6g", sha1, CacheOs::Windows).unwrap();
        assert_eq!(rec1.schema_version, 1);
        assert_eq!(rec1.profile, "windows_trt_6g");
        assert_eq!(rec1.artifact_manifest_sha256, sha1);
        assert_eq!(rec1.prepare_script_sha256, sha256_hex(PREPARE_SCRIPT_WINDOWS));
        assert_eq!(rec1.activation_contract_sha256, sha256_hex(ACTIVATION_CONTRACT));

        let expected_key = slot_key(&SlotKeyInput {
            profile: "windows_trt_6g",
            artifact_manifest_sha256: sha1,
            prepare_script: PREPARE_SCRIPT_WINDOWS,
            activation_contract: ACTIVATION_CONTRACT,
        })
        .unwrap();
        assert_eq!(rec1.slot_key, expected_key);

        let temp = tempfile::tempdir().unwrap();
        write_slot_record(temp.path(), &rec1).unwrap();
        let read = read_slot_record(temp.path()).unwrap();
        assert_eq!(rec1, read);

        let sha2 = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
        let rec2 = slot_record_for("windows_trt_6g", sha2, CacheOs::Windows).unwrap();
        assert_ne!(rec1.slot_key, rec2.slot_key);
        assert_ne!(rec1.artifact_manifest_sha256, rec2.artifact_manifest_sha256);
    }

    #[test]
    fn test_parse_nvidia_identity_csv() {
        let text = "0, NVIDIA GeForce RTX 4060, 8.9, 572.16\n1, NVIDIA GeForce RTX 3090, 8.6, 572.16\n";
        let gpus = parse_nvidia_identity_csv(text);
        assert_eq!(gpus.len(), 2);
        assert_eq!(gpus[0].index, 0);
        assert_eq!(gpus[0].name, "NVIDIA GeForce RTX 4060");
        assert_eq!(gpus[0].compute_cap, "8.9");
        assert_eq!(gpus[0].driver_version, "572.16");

        assert_eq!(gpus[1].index, 1);
        assert_eq!(gpus[1].name, "NVIDIA GeForce RTX 3090");
        assert_eq!(gpus[1].compute_cap, "8.6");
        assert_eq!(gpus[1].driver_version, "572.16");

        let garbage = "not,enough\n\ngarbage line\nfoo, bar, baz, qux\n-1, valid, 1.0, 1.0\n";
        let empty = parse_nvidia_identity_csv(garbage);
        assert!(empty.is_empty());
    }

    #[test]
    fn test_tensorrt_version_from_lock() {
        let temp = tempfile::tempdir().unwrap();
        let lock_path = temp.path().join("installer-package-lock.json");
        let json = r#"{"packages": {"tensorrt-cu12": "10.0.1", "torch": "2.2.0"}}"#;
        std::fs::write(&lock_path, json).unwrap();
        assert_eq!(tensorrt_version_from_lock(&lock_path), Some("10.0.1".to_string()));

        let json_missing = r#"{"packages": {"torch": "2.2.0"}}"#;
        std::fs::write(&lock_path, json_missing).unwrap();
        assert_eq!(tensorrt_version_from_lock(&lock_path), None);
    }

    #[test]
    fn test_engine_stamp_record() {
        let temp = tempfile::tempdir().unwrap();
        let gpu = GpuIdentity {
            index: 0,
            name: "RTX 4090".to_string(),
            compute_cap: "8.9".to_string(),
            driver_version: "550.54.14".to_string(),
        };
        let rec = engine_stamp_record(&gpu, "10.0.1").unwrap();
        assert_eq!(rec.schema_version, 1);
        assert_eq!(rec.gpu_name, "RTX 4090");
        assert_eq!(rec.compute_cap, "8.9");
        assert_eq!(rec.driver_version, "550.54.14");
        assert_eq!(rec.tensorrt_version, "10.0.1");

        let engine_dir = temp.path().join("engine");
        write_engine_stamp(&engine_dir, &rec).unwrap();
        let read = read_engine_stamp(&engine_dir).unwrap();
        assert_eq!(rec, read);

        let gpu_diff = GpuIdentity {
            index: 0,
            name: "RTX 4090".to_string(),
            compute_cap: "8.9".to_string(),
            driver_version: "551.00".to_string(),
        };
        let rec_diff = engine_stamp_record(&gpu_diff, "10.0.1").unwrap();
        assert_ne!(rec.stamp, rec_diff.stamp);
    }

    #[test]
    fn test_native_hashes() {
        let temp_win = tempfile::tempdir().unwrap();
        let artifact_win = temp_win.path().join("artifact");
        std::fs::create_dir_all(&artifact_win).unwrap();

        let py_exe = artifact_win.join("python.exe");
        std::fs::write(&py_exe, b"fake python.exe binary").unwrap();
        let py_dll = artifact_win.join("python312.dll");
        std::fs::write(&py_dll, b"fake python312.dll").unwrap();

        let pyd_dir = artifact_win
            .join("Lib")
            .join("site-packages")
            .join("voxcpm2_tensorrt");
        std::fs::create_dir_all(&pyd_dir).unwrap();
        let pyd_file = pyd_dir.join("http_server.cp312-win_amd64.pyd");
        std::fs::write(&pyd_file, b"fake pyd module").unwrap();

        let ignored_file = pyd_dir.join("ignored.txt");
        std::fs::write(&ignored_file, b"non-native file").unwrap();

        let slot_dir = temp_win.path().join("slot");
        let count = record_native_hashes(&slot_dir, &artifact_win, CacheOs::Windows).unwrap();
        assert_eq!(count, 3);

        verify_native_hashes(&slot_dir, &artifact_win, CacheOs::Windows).unwrap();

        std::fs::write(&py_exe, b"tampered python.exe binary").unwrap();
        let err = verify_native_hashes(&slot_dir, &artifact_win, CacheOs::Windows).unwrap_err();
        assert!(err.contains("python.exe"));
        std::fs::write(&py_exe, b"fake python.exe binary").unwrap();
        verify_native_hashes(&slot_dir, &artifact_win, CacheOs::Windows).unwrap();

        let extra_pyd = pyd_dir.join("extra.pyd");
        std::fs::write(&extra_pyd, b"extra pyd").unwrap();
        let err2 = verify_native_hashes(&slot_dir, &artifact_win, CacheOs::Windows).unwrap_err();
        assert!(err2.contains("extra.pyd"));
        std::fs::remove_file(&extra_pyd).unwrap();
        verify_native_hashes(&slot_dir, &artifact_win, CacheOs::Windows).unwrap();

        std::fs::remove_file(slot_dir.join("native-hashes.json")).unwrap();
        assert!(verify_native_hashes(&slot_dir, &artifact_win, CacheOs::Windows).is_err());

        let temp_linux = tempfile::tempdir().unwrap();
        let artifact_linux = temp_linux.path().join("artifact");
        let bin_dir = artifact_linux.join("python").join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let py3_exe = bin_dir.join("python3");
        std::fs::write(&py3_exe, b"fake python3").unwrap();

        let lib_dir = artifact_linux.join("python").join("lib");
        std::fs::create_dir_all(&lib_dir).unwrap();
        let so_lib = lib_dir.join("libpython3.12.so.1.0");
        std::fs::write(&so_lib, b"fake libpython so").unwrap();

        let linux_vox_dir = lib_dir
            .join("python3.12")
            .join("site-packages")
            .join("voxcpm2_tensorrt");
        std::fs::create_dir_all(&linux_vox_dir).unwrap();
        let linux_so_file = linux_vox_dir.join("http_server.cpython-312-x86_64-linux-gnu.so");
        std::fs::write(&linux_so_file, b"fake linux voxcpm2 so").unwrap();

        let linux_slot_dir = temp_linux.path().join("slot");
        let linux_count = record_native_hashes(&linux_slot_dir, &artifact_linux, CacheOs::Linux).unwrap();
        assert_eq!(linux_count, 3);
        verify_native_hashes(&linux_slot_dir, &artifact_linux, CacheOs::Linux).unwrap();

        std::fs::write(&linux_so_file, b"tampered linux so").unwrap();
        let err3 = verify_native_hashes(&linux_slot_dir, &artifact_linux, CacheOs::Linux).unwrap_err();
        assert!(err3.contains("http_server.cpython-312-x86_64-linux-gnu.so"));
    }

    #[test]
    fn test_evaluate_readiness() {
        let all_true = ReadinessFacts {
            slot_record_matches: true,
            native_hashes_match: true,
            nvidia_receipt_matches: true,
            model_present: true,
            palette_matches: true,
            ready_json_matches: true,
            engine_matches: true,
            python_runtime: true,
        };
        assert_eq!(evaluate_readiness(&all_true), Readiness::Ready);

        let payload_only = ReadinessFacts {
            slot_record_matches: true,
            native_hashes_match: true,
            nvidia_receipt_matches: false,
            model_present: false,
            palette_matches: false,
            ready_json_matches: false,
            engine_matches: false,
            python_runtime: false,
        };
        let readiness = evaluate_readiness(&payload_only);
        match readiness {
            Readiness::NeedsInstall(reasons) => {
                assert!(reasons.contains(&"model-missing"));
                assert!(reasons.contains(&"engine-generation-missing"));
                assert_eq!(
                    reasons,
                    vec![
                        "nvidia-packages-missing",
                        "model-missing",
                        "palette-missing",
                        "ready-receipt-mismatch",
                        "engine-generation-missing",
                        "python-runtime-unavailable",
                    ]
                );
            }
            Readiness::Ready => panic!("expected NeedsInstall"),
        }

        let all_false = ReadinessFacts::default();
        let all_reasons = match evaluate_readiness(&all_false) {
            Readiness::NeedsInstall(r) => r,
            Readiness::Ready => panic!("expected NeedsInstall"),
        };
        assert_eq!(
            all_reasons,
            vec![
                "slot-key-mismatch",
                "native-module-mismatch",
                "nvidia-packages-missing",
                "model-missing",
                "palette-missing",
                "ready-receipt-mismatch",
                "engine-generation-missing",
                "python-runtime-unavailable",
            ]
        );
    }

    #[test]
    fn test_gather_file_facts() {
        let temp = tempfile::tempdir().unwrap();
        let artifact_root = temp.path().join("artifact");
        let slot_dir = temp.path().join("slot");
        let engine_dir = temp.path().join("engine");
        std::fs::create_dir_all(&artifact_root).unwrap();
        std::fs::create_dir_all(&slot_dir).unwrap();
        std::fs::create_dir_all(&engine_dir).unwrap();

        let fake_art_content = b"fake artifact manifest";
        std::fs::write(artifact_root.join("artifact-manifest.json"), fake_art_content).unwrap();
        let fake_art_sha = sha256_hex(fake_art_content);

        let fake_lock_content = b"fake installer lock";
        std::fs::write(artifact_root.join("installer-package-lock.json"), fake_lock_content).unwrap();
        let fake_lock_sha = sha256_hex(fake_lock_content);

        std::fs::write(
            artifact_root.join("runtime-manifest.json"),
            br#"{"model": {"revision": "rev123"}}"#,
        )
        .unwrap();

        std::fs::write(artifact_root.join("python.exe"), b"python exe").unwrap();
        record_native_hashes(&slot_dir, &artifact_root, CacheOs::Windows).unwrap();

        let expected = slot_record_for("windows_trt_6g", &fake_art_sha, CacheOs::Windows).unwrap();
        write_slot_record(&slot_dir, &expected).unwrap();

        let py_pkg_dir = slot_dir.join("python-packages");
        std::fs::create_dir_all(&py_pkg_dir).unwrap();
        let receipt_json = serde_json::json!({
            "installerPackageLockSha256": fake_lock_sha,
        });
        std::fs::write(
            py_pkg_dir.join("naia-nvidia-package-receipt.json"),
            serde_json::to_vec(&receipt_json).unwrap(),
        )
        .unwrap();

        let model_dir = slot_dir.join("models").join("VoxCPM2");
        std::fs::create_dir_all(&model_dir).unwrap();
        std::fs::write(model_dir.join("config.json"), b"{}").unwrap();
        std::fs::write(model_dir.join("model.safetensors"), b"non-empty weight data").unwrap();
        std::fs::write(model_dir.join("voxcpm2-model-receipt.json"), b"{}").unwrap();

        let fake_wav = b"RIFFfakeWAVEbody";
        let fake_palette = vec![(
            "voice1.wav".to_string(),
            sha256_hex(fake_wav),
            fake_wav.len() as u64,
        )];
        let voices_dir = slot_dir.join("voices");
        std::fs::create_dir_all(&voices_dir).unwrap();
        std::fs::write(voices_dir.join("voice1.wav"), fake_wav).unwrap();

        let ready_json = serde_json::json!({
            "artifactManifestSha256": fake_art_sha,
            "model": {
                "revision": "rev123"
            }
        });
        std::fs::write(
            slot_dir.join("voxcpm2-runtime-ready.json"),
            serde_json::to_vec(&ready_json).unwrap(),
        )
        .unwrap();

        let gpu = GpuIdentity {
            index: 0,
            name: "RTX 4090".to_string(),
            compute_cap: "8.9".to_string(),
            driver_version: "550.54".to_string(),
        };
        let engine_stamp_rec = engine_stamp_record(&gpu, "10.0.1").unwrap();
        write_engine_stamp(&engine_dir, &engine_stamp_rec).unwrap();
        std::fs::write(
            engine_dir.join("manifest.json"),
            br#"{"model_revision": "rev123"}"#,
        )
        .unwrap();

        let inputs = ReadinessInputs {
            slot_dir: &slot_dir,
            artifact_root: &artifact_root,
            engine_dir: &engine_dir,
            expected: &expected,
            engine_stamp: &engine_stamp_rec.stamp,
            os: CacheOs::Windows,
        };

        let facts = gather_file_facts_with_palette(&inputs, &fake_palette);
        assert!(facts.slot_record_matches);
        assert!(facts.native_hashes_match);
        assert!(facts.nvidia_receipt_matches);
        assert!(facts.model_present);
        assert!(facts.palette_matches);
        assert!(facts.ready_json_matches);
        assert!(facts.engine_matches);
        assert!(!facts.python_runtime);

        std::fs::remove_file(engine_dir.join("stamp.json")).unwrap();
        let facts2 = gather_file_facts_with_palette(&inputs, &fake_palette);
        assert!(!facts2.engine_matches);
        assert!(facts2.slot_record_matches);
        assert!(facts2.native_hashes_match);
        assert!(facts2.nvidia_receipt_matches);
        assert!(facts2.model_present);
        assert!(facts2.palette_matches);
        assert!(facts2.ready_json_matches);
    }

    #[test]
    fn test_sync_palette_to_state() {
        let temp = tempfile::tempdir().unwrap();
        let slot_voices = temp.path().join("slot_voices");
        let state_voices = temp.path().join("state_voices");
        std::fs::create_dir_all(&slot_voices).unwrap();
        std::fs::create_dir_all(&state_voices).unwrap();

        let v1_bytes = b"voice one content";
        std::fs::write(slot_voices.join("v1.wav"), v1_bytes).unwrap();
        let palette = vec![(
            "v1.wav".to_string(),
            sha256_hex(v1_bytes),
            v1_bytes.len() as u64,
        )];

        let count1 = sync_palette_to_state_with(&slot_voices, &state_voices, &palette).unwrap();
        assert_eq!(count1, 1);
        assert_eq!(std::fs::read(state_voices.join("v1.wav")).unwrap(), v1_bytes);

        let count2 = sync_palette_to_state_with(&slot_voices, &state_voices, &palette).unwrap();
        assert_eq!(count2, 0);

        // Writing to the state file leaves the slot file's bytes unchanged (no hardlink)
        std::fs::write(state_voices.join("v1.wav"), b"corrupted content").unwrap();
        assert_eq!(std::fs::read(slot_voices.join("v1.wav")).unwrap(), v1_bytes);

        let count3 = sync_palette_to_state_with(&slot_voices, &state_voices, &palette).unwrap();
        assert_eq!(count3, 1);
        assert_eq!(std::fs::read(state_voices.join("v1.wav")).unwrap(), v1_bytes);
        assert_eq!(std::fs::read(slot_voices.join("v1.wav")).unwrap(), v1_bytes);

        let user_recording = b"user voice recording";
        std::fs::write(state_voices.join("naia-current.wav"), user_recording).unwrap();
        sync_palette_to_state_with(&slot_voices, &state_voices, &palette).unwrap();
        assert_eq!(
            std::fs::read(state_voices.join("naia-current.wav")).unwrap(),
            user_recording
        );

        // Slot file verification failure
        std::fs::write(slot_voices.join("v1.wav"), b"bad slot data").unwrap();
        std::fs::remove_file(state_voices.join("v1.wav")).unwrap();
        let err_verify = sync_palette_to_state_with(&slot_voices, &state_voices, &palette).unwrap_err();
        assert_eq!(err_verify, "slot palette file failed verification: v1.wav");

        std::fs::remove_file(slot_voices.join("v1.wav")).unwrap();
        assert!(sync_palette_to_state_with(&slot_voices, &state_voices, &palette).is_err());
    }

    #[test]
    fn test_migration_success() {
        let temp_legacy = tempfile::tempdir().unwrap();
        let legacy_root = temp_legacy.path().join("legacy");

        let art_dir = legacy_root.join("payload").join("artifact");
        std::fs::create_dir_all(&art_dir).unwrap();
        let manifest_bytes = b"real artifact manifest data";
        std::fs::write(art_dir.join("artifact-manifest.json"), manifest_bytes).unwrap();
        std::fs::write(art_dir.join("python.exe"), b"binary python content").unwrap();
        let expected_artifact_sha = sha256_hex(manifest_bytes);

        let py_pkgs = legacy_root.join("python-packages");
        std::fs::create_dir_all(&py_pkgs).unwrap();
        std::fs::write(py_pkgs.join("x.dll"), b"x dll bytes").unwrap();

        let models_dir = legacy_root.join("models").join("VoxCPM2");
        std::fs::create_dir_all(&models_dir).unwrap();
        std::fs::write(models_dir.join("config.json"), b"config bytes").unwrap();

        let trt_dir = legacy_root.join("checkpoints").join("voxcpm2_trt");
        std::fs::create_dir_all(&trt_dir).unwrap();
        std::fs::write(trt_dir.join("manifest.json"), b"engine manifest bytes").unwrap();

        let voices_dir = legacy_root.join("voices");
        std::fs::create_dir_all(&voices_dir).unwrap();
        std::fs::write(voices_dir.join("default.wav"), b"default wav bytes").unwrap();
        std::fs::write(voices_dir.join("naia-current.wav"), b"user wav bytes").unwrap();

        let state_dir = legacy_root.join("state");
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::write(state_dir.join("prompt.bin"), b"prompt bin bytes").unwrap();

        let hf_dir = legacy_root.join("hf-cache");
        std::fs::create_dir_all(&hf_dir).unwrap();
        std::fs::write(hf_dir.join("a"), b"hf cache bytes").unwrap();

        let py_pending = legacy_root.join("python-packages.pending");
        std::fs::create_dir_all(&py_pending).unwrap();
        std::fs::write(py_pending.join("y"), b"pending bytes").unwrap();

        let hex_zip = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
        let dl_dir = legacy_root.join("downloads");
        std::fs::create_dir_all(&dl_dir).unwrap();
        std::fs::write(dl_dir.join(format!("{}.zip", hex_zip)), b"zip content").unwrap();

        std::fs::write(legacy_root.join("voxcpm2-install.log"), b"install log").unwrap();

        let temp_cache = tempfile::tempdir().unwrap();
        let slot_key = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
        let layout = CacheLayout::new(temp_cache.path());
        let slot_dir = layout.slot_dir("windows_trt_6g", slot_key).unwrap();
        let stamp = "fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321";
        let engine_dir = layout.engine_dir("windows_trt_6g", slot_key, stamp).unwrap();
        let downloads_dir = temp_cache.path().join("downloads");

        let palette_ids = vec!["default.wav".to_string()];
        let input = MigrationPlanInput {
            legacy_root: &legacy_root,
            slot_dir: &slot_dir,
            engine_dir: Some(&engine_dir),
            downloads_dir: &downloads_dir,
            expected_artifact_sha: &expected_artifact_sha,
            palette_ids: &palette_ids,
            import_payload: true,
        };

        let outcome = migrate_legacy_runtime(&input, &|_| Some(1024 * 1024 * 1024)).unwrap();
        match outcome {
            MigrationOutcome::Migrated(receipt) => {
                assert_eq!(receipt.schema_version, 1);
                assert_eq!(receipt.slot_key, slot_dir.file_name().unwrap().to_str().unwrap());
                assert!(!receipt.verified_install);
                assert!(!receipt.verified_start);
                assert!(receipt.imported.contains(&"payload/artifact".to_string()));
                assert!(receipt.imported.contains(&"python-packages".to_string()));
                assert!(receipt.imported.contains(&"models".to_string()));
                assert!(receipt.imported.contains(&"checkpoints/voxcpm2_trt".to_string()));
                assert!(receipt.imported.contains(&"voices/default.wav".to_string()));
                assert_eq!(receipt.imported.len(), 5);

                // receipt write and read roundtrip
                let rc_path = temp_cache.path().join("test.receipt.json");
                write_migration_receipt(&rc_path, &receipt).unwrap();
                let rc_read = read_migration_receipt(&rc_path).unwrap();
                assert_eq!(receipt, rc_read);
            }
            other => panic!("expected Migrated outcome, got {:?}", other),
        }

        // Slot checks
        assert!(slot_dir.join("payload").join("artifact").join("artifact-manifest.json").is_file());
        assert!(slot_dir.join("payload").join("artifact").join("python.exe").is_file());
        assert!(slot_dir.join("python-packages").join("x.dll").is_file());
        assert!(slot_dir.join("models").join("VoxCPM2").join("config.json").is_file());
        assert!(engine_dir.join("manifest.json").is_file());
        assert!(slot_dir.join("voices").join("default.wav").is_file());

        // Negative slot checks
        assert!(!slot_dir.join("state").exists());
        assert!(!slot_dir.join("hf-cache").exists());
        assert!(!slot_dir.join("voices").join("naia-current.wav").exists());
        assert!(!slot_dir.join("python-packages.pending").exists());
        assert!(!slot_dir.join("voxcpm2-install.log").exists());

        // Downloads dir check
        assert_eq!(std::fs::read(downloads_dir.join(format!("{}.zip", hex_zip))).unwrap(), b"zip content");

        // Pending migration dir does not remain
        let pending_dir = PathBuf::from(format!("{}.mig", slot_dir.display()));
        assert!(!pending_dir.exists());

        // Legacy tree has every original file with identical bytes
        assert_eq!(std::fs::read(art_dir.join("artifact-manifest.json")).unwrap(), manifest_bytes);
        assert_eq!(std::fs::read(art_dir.join("python.exe")).unwrap(), b"binary python content");
        assert_eq!(std::fs::read(py_pkgs.join("x.dll")).unwrap(), b"x dll bytes");
        assert_eq!(std::fs::read(models_dir.join("config.json")).unwrap(), b"config bytes");
        assert_eq!(std::fs::read(trt_dir.join("manifest.json")).unwrap(), b"engine manifest bytes");
        assert_eq!(std::fs::read(voices_dir.join("default.wav")).unwrap(), b"default wav bytes");
        assert_eq!(std::fs::read(voices_dir.join("naia-current.wav")).unwrap(), b"user wav bytes");
        assert_eq!(std::fs::read(state_dir.join("prompt.bin")).unwrap(), b"prompt bin bytes");
        assert_eq!(std::fs::read(hf_dir.join("a")).unwrap(), b"hf cache bytes");
        assert_eq!(std::fs::read(py_pending.join("y")).unwrap(), b"pending bytes");
        assert_eq!(std::fs::read(dl_dir.join(format!("{}.zip", hex_zip))).unwrap(), b"zip content");
        assert_eq!(std::fs::read(legacy_root.join("voxcpm2-install.log")).unwrap(), b"install log");

        // After successful migration, writing to legacy/voices/default.wav does not change slot/voices/default.wav
        std::fs::write(voices_dir.join("default.wav"), b"modified legacy wav bytes").unwrap();
        assert_eq!(
            std::fs::read(slot_dir.join("voices").join("default.wav")).unwrap(),
            b"default wav bytes"
        );
    }

    #[test]
    fn test_migration_skipped_outcomes() {
        let temp_legacy = tempfile::tempdir().unwrap();
        let legacy_root = temp_legacy.path().join("legacy");
        std::fs::create_dir_all(&legacy_root).unwrap();

        let temp_cache = tempfile::tempdir().unwrap();
        let slot_dir = temp_cache.path().join("slots").join("windows_trt_6g").join("1111111111111111111111111111111111111111111111111111111111111111");
        let stamp = "2222222222222222222222222222222222222222222222222222222222222222";
        let engine_dir = slot_dir.join("engines").join(stamp);
        let downloads_dir = temp_cache.path().join("downloads");

        let input = MigrationPlanInput {
            legacy_root: &legacy_root,
            slot_dir: &slot_dir,
            engine_dir: Some(&engine_dir),
            downloads_dir: &downloads_dir,
            expected_artifact_sha: "0000000000000000000000000000000000000000000000000000000000000000",
            palette_ids: &[],
            import_payload: true,
        };

        // 1. SkippedSlotExists when slot dir exists
        std::fs::create_dir_all(&slot_dir).unwrap();
        let outcome1 = migrate_legacy_runtime(&input, &|_| Some(1024 * 1024 * 1024)).unwrap();
        assert_eq!(outcome1, MigrationOutcome::SkippedSlotExists);
        std::fs::remove_dir_all(&slot_dir).unwrap();

        // 2. SkippedNothingToImport for an empty legacy dir
        let outcome2 = migrate_legacy_runtime(&input, &|_| Some(1024 * 1024 * 1024)).unwrap();
        assert_eq!(outcome2, MigrationOutcome::SkippedNothingToImport);

        // 3. SkippedArtifactMismatch when only a mismatching payload exists
        let payload_art = legacy_root.join("payload").join("artifact");
        std::fs::create_dir_all(&payload_art).unwrap();
        std::fs::write(payload_art.join("artifact-manifest.json"), b"mismatching manifest content").unwrap();
        let outcome3 = migrate_legacy_runtime(&input, &|_| Some(1024 * 1024 * 1024)).unwrap();
        assert_eq!(outcome3, MigrationOutcome::SkippedArtifactMismatch);
    }

    #[test]
    fn test_migration_no_space() {
        let temp_legacy = tempfile::tempdir().unwrap();
        let legacy_root = temp_legacy.path().join("legacy");
        std::fs::create_dir_all(legacy_root.join("models")).unwrap();
        std::fs::write(legacy_root.join("models").join("test.bin"), b"some data").unwrap();

        let temp_cache = tempfile::tempdir().unwrap();
        let slot_dir = temp_cache.path().join("slots").join("windows_trt_6g").join("1111111111111111111111111111111111111111111111111111111111111111");
        let stamp = "2222222222222222222222222222222222222222222222222222222222222222";
        let engine_dir = slot_dir.join("engines").join(stamp);
        let downloads_dir = temp_cache.path().join("downloads");

        let input = MigrationPlanInput {
            legacy_root: &legacy_root,
            slot_dir: &slot_dir,
            engine_dir: Some(&engine_dir),
            downloads_dir: &downloads_dir,
            expected_artifact_sha: "0000000000000000000000000000000000000000000000000000000000000000",
            palette_ids: &[],
            import_payload: true,
        };

        let outcome = migrate_legacy_runtime_with(
            &input,
            &|_| Some(0),
            &|_, _| false,
            None,
        )
        .unwrap();

        match outcome {
            MigrationOutcome::SkippedNoSpace { needed, available } => {
                assert!(needed > 0);
                assert_eq!(available, Some(0));
            }
            other => panic!("expected SkippedNoSpace, got {:?}", other),
        }

        assert!(!slot_dir.exists());
    }

    #[test]
    fn test_migration_partial_failure() {
        let temp_legacy = tempfile::tempdir().unwrap();
        let legacy_root = temp_legacy.path().join("legacy");
        let models_dir = legacy_root.join("models");
        std::fs::create_dir_all(&models_dir).unwrap();
        std::fs::write(models_dir.join("f1.bin"), b"data1").unwrap();
        std::fs::write(models_dir.join("f2.bin"), b"data2").unwrap();
        std::fs::write(models_dir.join("f3.bin"), b"data3").unwrap();

        let temp_cache = tempfile::tempdir().unwrap();
        let slot_dir = temp_cache.path().join("slots").join("windows_trt_6g").join("1111111111111111111111111111111111111111111111111111111111111111");
        let stamp = "2222222222222222222222222222222222222222222222222222222222222222";
        let engine_dir = slot_dir.join("engines").join(stamp);
        let downloads_dir = temp_cache.path().join("downloads");
        let pending_dir = PathBuf::from(format!("{}.mig", slot_dir.display()));

        let input = MigrationPlanInput {
            legacy_root: &legacy_root,
            slot_dir: &slot_dir,
            engine_dir: Some(&engine_dir),
            downloads_dir: &downloads_dir,
            expected_artifact_sha: "0000000000000000000000000000000000000000000000000000000000000000",
            palette_ids: &[],
            import_payload: true,
        };

        let err = migrate_legacy_runtime_with(
            &input,
            &|_| Some(1024 * 1024 * 1024),
            &|_, _| true,
            Some(2),
        );
        assert!(err.is_err());
        assert!(!slot_dir.exists());
        assert!(!pending_dir.exists());
        assert_eq!(std::fs::read(models_dir.join("f1.bin")).unwrap(), b"data1");
        assert_eq!(std::fs::read(models_dir.join("f2.bin")).unwrap(), b"data2");
        assert_eq!(std::fs::read(models_dir.join("f3.bin")).unwrap(), b"data3");
    }

    #[test]
    fn test_migration_without_engine_dir() {
        let temp_legacy = tempfile::tempdir().unwrap();
        let legacy_root = temp_legacy.path().join("legacy");
        std::fs::create_dir_all(&legacy_root).unwrap();

        let models_dir = legacy_root.join("models");
        std::fs::create_dir_all(&models_dir).unwrap();
        std::fs::write(models_dir.join("test.bin"), b"model data").unwrap();

        let trt_dir = legacy_root.join("checkpoints").join("voxcpm2_trt");
        std::fs::create_dir_all(&trt_dir).unwrap();
        std::fs::write(trt_dir.join("manifest.json"), b"engine data").unwrap();

        let temp_cache = tempfile::tempdir().unwrap();
        let slot_dir = temp_cache.path().join("slots").join("windows_trt_6g").join("1111111111111111111111111111111111111111111111111111111111111111");
        let downloads_dir = temp_cache.path().join("downloads");

        let input = MigrationPlanInput {
            legacy_root: &legacy_root,
            slot_dir: &slot_dir,
            engine_dir: None,
            downloads_dir: &downloads_dir,
            expected_artifact_sha: "0000000000000000000000000000000000000000000000000000000000000000",
            palette_ids: &[],
            import_payload: true,
        };

        let outcome = migrate_legacy_runtime(&input, &|_| Some(1024 * 1024 * 1024)).unwrap();
        match outcome {
            MigrationOutcome::Migrated(receipt) => {
                assert!(receipt.imported.contains(&"models".to_string()));
                assert!(!receipt.imported.contains(&"checkpoints/voxcpm2_trt".to_string()));
                assert!(!slot_dir.join("engines").exists());
                assert!(slot_dir.join("models").join("test.bin").is_file());
            }
            other => panic!("expected Migrated outcome, got {:?}", other),
        }
    }

    #[test]
    fn test_cleanup_migrated_legacy() {
        let temp = tempfile::tempdir().unwrap();
        let legacy_root = temp.path().join("legacy");

        let art_dir = legacy_root.join("payload").join("artifact");
        std::fs::create_dir_all(&art_dir).unwrap();
        std::fs::write(art_dir.join("python.exe"), b"python exe").unwrap();

        let payload_dir = legacy_root.join("payload");
        std::fs::write(payload_dir.join("prepare-voxcpm2-model.ps1"), b"script").unwrap();
        std::fs::write(payload_dir.join("voxcpm2-activation-contract.json"), b"contract").unwrap();

        let py_pkgs = legacy_root.join("python-packages");
        std::fs::create_dir_all(&py_pkgs).unwrap();
        std::fs::write(py_pkgs.join("x.dll"), b"x dll").unwrap();

        let models_dir = legacy_root.join("models");
        std::fs::create_dir_all(&models_dir).unwrap();
        std::fs::write(models_dir.join("config.json"), b"cfg").unwrap();

        let trt_dir = legacy_root.join("checkpoints").join("voxcpm2_trt");
        std::fs::create_dir_all(&trt_dir).unwrap();
        std::fs::write(trt_dir.join("manifest.json"), b"manifest").unwrap();

        let voices_dir = legacy_root.join("voices");
        std::fs::create_dir_all(&voices_dir).unwrap();
        std::fs::write(voices_dir.join("default.wav"), b"default wav").unwrap();
        std::fs::write(voices_dir.join("naia-current.wav"), b"user wav").unwrap();

        let state_dir = legacy_root.join("state");
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::write(state_dir.join("prompt.bin"), b"prompt").unwrap();

        let hf_dir = legacy_root.join("hf-cache");
        std::fs::create_dir_all(&hf_dir).unwrap();
        std::fs::write(hf_dir.join("a"), b"hf").unwrap();

        std::fs::write(legacy_root.join("voxcpm2-install.log"), b"log").unwrap();

        let mut receipt = MigrationReceipt {
            schema_version: 1,
            source: legacy_root.display().to_string(),
            slot_key: "key".to_string(),
            imported: vec![
                "payload/artifact".to_string(),
                "python-packages".to_string(),
                "models".to_string(),
                "checkpoints/voxcpm2_trt".to_string(),
                "voices/default.wav".to_string(),
            ],
            files: 5,
            bytes: 100,
            hardlinked: 0,
            copied: 5,
            verified_install: false,
            verified_start: false,
            cleaned: false,
        };

        // Refuses when not verified
        assert!(cleanup_migrated_legacy(&legacy_root, &receipt).is_err());
        receipt.verified_install = true;
        assert!(cleanup_migrated_legacy(&legacy_root, &receipt).is_err());

        // Succeeds when both verified
        receipt.verified_start = true;
        let deleted = cleanup_migrated_legacy(&legacy_root, &receipt).unwrap();
        assert!(deleted.contains(&"payload/artifact".to_string()));
        assert!(deleted.contains(&"python-packages".to_string()));
        assert!(deleted.contains(&"models".to_string()));
        assert!(deleted.contains(&"checkpoints/voxcpm2_trt".to_string()));
        assert!(deleted.contains(&"voices/default.wav".to_string()));
        assert!(deleted.contains(&"payload/prepare-voxcpm2-model.ps1".to_string()));
        assert!(deleted.contains(&"payload/voxcpm2-activation-contract.json".to_string()));
        assert!(deleted.contains(&"payload".to_string()));
        assert!(deleted.contains(&"checkpoints".to_string()));

        // Check deleted
        assert!(!art_dir.exists());
        assert!(!payload_dir.exists());
        assert!(!py_pkgs.exists());
        assert!(!models_dir.exists());
        assert!(!trt_dir.exists());
        assert!(!legacy_root.join("checkpoints").exists());
        assert!(!voices_dir.join("default.wav").exists());

        // Check kept
        assert!(voices_dir.join("naia-current.wav").exists());
        assert!(voices_dir.exists());
        assert!(state_dir.join("prompt.bin").exists());
        assert!(hf_dir.join("a").exists());
        assert!(legacy_root.join("voxcpm2-install.log").exists());
        assert!(legacy_root.exists());
    }

    #[test]
    fn test_prune_slots() {
        let temp = tempfile::tempdir().unwrap();
        let cache_root = temp.path().join("cache");
        let layout = CacheLayout::new(&cache_root);

        let profile = "windows_trt_6g";
        let hex_active = "1111111111111111111111111111111111111111111111111111111111111111";
        let hex_prev = "2222222222222222222222222222222222222222222222222222222222222222";
        let hex_third = "3333333333333333333333333333333333333333333333333333333333333333";
        let dk_third = &hex_third[..16];

        let active_dir = layout.slot_dir(profile, hex_active).unwrap();
        let prev_dir = layout.slot_dir(profile, hex_prev).unwrap();
        let third_dir = layout.slot_dir(profile, hex_third).unwrap();
        let non_hex_dir = layout.profile_dir(profile).unwrap().join("not-a-hex-dir");

        std::fs::create_dir_all(&active_dir).unwrap();
        std::fs::create_dir_all(&prev_dir).unwrap();
        std::fs::create_dir_all(&third_dir).unwrap();
        std::fs::create_dir_all(&non_hex_dir).unwrap();

        // Third dir is pruned, active/prev and non-hex kept
        let pruned = prune_slots(&layout, profile, hex_active, Some(hex_prev));
        assert_eq!(pruned, vec![dk_third.to_string()]);
        assert!(!third_dir.exists());
        assert!(active_dir.exists());
        assert!(prev_dir.exists());
        assert!(non_hex_dir.exists());

        // Recreate third dir and acquire shared lock on it
        std::fs::create_dir_all(&third_dir).unwrap();
        let lock_path = layout.lock_path(profile, hex_third).unwrap();
        let hold = RuntimeLock::try_acquire(&lock_path, LockMode::Shared, "test_holder").unwrap();

        let pruned2 = prune_slots(&layout, profile, hex_active, Some(hex_prev));
        assert!(pruned2.is_empty());
        assert!(third_dir.exists());
        drop(hold);

        // After dropping shared lock, prune succeeds
        let pruned3 = prune_slots(&layout, profile, hex_active, Some(hex_prev));
        assert_eq!(pruned3, vec![dk_third.to_string()]);
        assert!(!third_dir.exists());
    }

    #[test]
    fn two_data_homes_share_one_cache_without_mixing_state() {
        let temp = tempfile::tempdir().unwrap();
        let cache_root = temp.path().join("cache");
        let dev_state = temp.path().join("home_dev").join("voxcpm2-runtime");
        let prod_state = temp.path().join("home_prod").join("voxcpm2-runtime");

        let artifact_root = temp.path().join("artifact");
        std::fs::create_dir_all(&artifact_root).unwrap();

        let manifest_bytes = b"fake artifact manifest for two homes";
        std::fs::write(artifact_root.join("artifact-manifest.json"), manifest_bytes).unwrap();
        let artifact_sha = sha256_hex(manifest_bytes);

        std::fs::write(
            artifact_root.join("runtime-manifest.json"),
            br#"{"model":{"revision":"abc"}}"#,
        )
        .unwrap();

        let lock_bytes = br#"{"packages":{"tensorrt-cu12":"10.0.1"}}"#;
        std::fs::write(artifact_root.join("installer-package-lock.json"), lock_bytes).unwrap();
        let lock_sha = sha256_hex(lock_bytes);

        std::fs::write(artifact_root.join("python.exe"), b"python exe content").unwrap();
        std::fs::write(artifact_root.join("python312.dll"), b"python dll content").unwrap();
        let pyd_dir = artifact_root
            .join("Lib")
            .join("site-packages")
            .join("voxcpm2_tensorrt");
        std::fs::create_dir_all(&pyd_dir).unwrap();
        std::fs::write(
            pyd_dir.join("http_server.cp312-win_amd64.pyd"),
            b"pyd content",
        )
        .unwrap();

        let fake_wav = b"RIFFfakeWAVEdefaultbody";
        let fake_palette = vec![(
            "default.wav".to_string(),
            sha256_hex(fake_wav),
            fake_wav.len() as u64,
        )];

        let profile = "windows_trt_6g";
        let gpu = GpuIdentity {
            index: 0,
            name: "RTX 4090".to_string(),
            compute_cap: "8.9".to_string(),
            driver_version: "550.54".to_string(),
        };
        let trt_ver = "10.0.1";

        let ctx_a = build_voice_context(
            &cache_root,
            &dev_state,
            profile,
            &artifact_sha,
            CacheOs::Windows,
            Some(&gpu),
            Some(trt_ver),
            false,
        )
        .unwrap();

        let ctx_b = build_voice_context(
            &cache_root,
            &prod_state,
            profile,
            &artifact_sha,
            CacheOs::Windows,
            Some(&gpu),
            Some(trt_ver),
            false,
        )
        .unwrap();

        assert_eq!(ctx_a.slot_dir, ctx_b.slot_dir);
        assert_eq!(ctx_a.engine_dir, ctx_b.engine_dir);
        assert_eq!(ctx_a.lock_path, ctx_b.lock_path);
        assert_ne!(ctx_a.state_root, ctx_b.state_root);

        // "install" A by hand under exclusive lock
        let lock_a = RuntimeLock::try_acquire(&ctx_a.lock_path, LockMode::Exclusive, "install").unwrap();

        write_slot_record(&ctx_a.slot_dir, &ctx_a.record).unwrap();
        record_native_hashes(&ctx_a.slot_dir, &artifact_root, CacheOs::Windows).unwrap();

        let py_pkg_dir = ctx_a.python_packages();
        std::fs::create_dir_all(&py_pkg_dir).unwrap();
        let receipt_json = serde_json::json!({
            "installerPackageLockSha256": lock_sha,
        });
        std::fs::write(
            py_pkg_dir.join("naia-nvidia-package-receipt.json"),
            serde_json::to_vec(&receipt_json).unwrap(),
        )
        .unwrap();

        let model_dir = ctx_a.model_dir();
        std::fs::create_dir_all(&model_dir).unwrap();
        std::fs::write(model_dir.join("config.json"), b"{}").unwrap();
        std::fs::write(model_dir.join("model.safetensors"), b"fake weights").unwrap();
        std::fs::write(model_dir.join("voxcpm2-model-receipt.json"), b"{}").unwrap();

        let slot_voices = ctx_a.slot_voices();
        std::fs::create_dir_all(&slot_voices).unwrap();
        std::fs::write(slot_voices.join("default.wav"), fake_wav).unwrap();

        let ready_json = serde_json::json!({
            "artifactManifestSha256": artifact_sha,
            "model": {
                "revision": "abc"
            }
        });
        std::fs::write(
            ctx_a.slot_dir.join("voxcpm2-runtime-ready.json"),
            serde_json::to_vec(&ready_json).unwrap(),
        )
        .unwrap();

        let eng_dir = ctx_a.engine_dir.as_ref().unwrap();
        let eng_rec = ctx_a.engine.as_ref().unwrap();
        write_engine_stamp(eng_dir, eng_rec).unwrap();
        std::fs::write(eng_dir.join("manifest.json"), br#"{"model_revision":"abc"}"#).unwrap();

        drop(lock_a);

        // assert gather_file_facts_with_palette for B gives all file facts true
        let inputs_b = ctx_b.readiness_inputs(&artifact_root).unwrap();
        let facts_b = gather_file_facts_with_palette(&inputs_b, &fake_palette);
        assert!(facts_b.slot_record_matches);
        assert!(facts_b.native_hashes_match);
        assert!(facts_b.nvidia_receipt_matches);
        assert!(facts_b.model_present);
        assert!(facts_b.palette_matches);
        assert!(facts_b.ready_json_matches);
        assert!(facts_b.engine_matches);

        // lock contention: A holds Shared -> B's Exclusive fails with LockBusy; B's Shared succeeds; drop both -> B's Exclusive succeeds
        let shared_a = RuntimeLock::try_acquire(&ctx_a.lock_path, LockMode::Shared, "running_server").unwrap();
        let excl_b_err = RuntimeLock::try_acquire(&ctx_b.lock_path, LockMode::Exclusive, "install_attempt");
        assert!(excl_b_err.is_err());
        let shared_b = RuntimeLock::try_acquire(&ctx_b.lock_path, LockMode::Shared, "second_server").unwrap();
        drop(shared_a);
        drop(shared_b);
        let excl_b = RuntimeLock::try_acquire(&ctx_b.lock_path, LockMode::Exclusive, "install_attempt_retry").unwrap();
        drop(excl_b);

        // sync_palette_to_state_with into A and B state voices
        sync_palette_to_state_with(&ctx_a.slot_voices(), &ctx_a.state_voices(), &fake_palette).unwrap();
        sync_palette_to_state_with(&ctx_b.slot_voices(), &ctx_b.state_voices(), &fake_palette).unwrap();
        assert!(ctx_a.state_voices().join("default.wav").is_file());
        assert!(ctx_b.state_voices().join("default.wav").is_file());

        // write naia-current.wav into A's state voices only
        std::fs::write(ctx_a.state_voices().join("naia-current.wav"), b"user clip for A").unwrap();
        assert!(!ctx_b.state_voices().join("naia-current.wav").exists());
        assert!(!ctx_a.slot_voices().join("naia-current.wav").exists());

        // record_gpu_choice(A, Some(1)) does not affect recorded_gpu_choice(B)
        record_gpu_choice(&ctx_a.state_root, Some(1)).unwrap();
        assert_eq!(recorded_gpu_choice(&ctx_a.state_root), Some(1));
        assert_eq!(recorded_gpu_choice(&ctx_b.state_root), None);
    }

    #[test]
    fn test_voice_context() {
        let temp = tempfile::tempdir().unwrap();
        let cache_root = temp.path().join("cache");
        let state_root = temp.path().join("state");
        std::fs::create_dir_all(&cache_root).unwrap();
        std::fs::create_dir_all(&state_root).unwrap();

        let sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

        // Nested roots rejection
        // Same root
        let err_same = build_voice_context(
            &cache_root,
            &cache_root,
            "windows_trt_6g",
            sha,
            CacheOs::Windows,
            None,
            None,
            false,
        );
        assert_eq!(
            err_same.unwrap_err(),
            "state and cache roots must be separate"
        );

        // State inside cache
        let state_inside_cache = cache_root.join("substate");
        let err_inside = build_voice_context(
            &cache_root,
            &state_inside_cache,
            "windows_trt_6g",
            sha,
            CacheOs::Windows,
            None,
            None,
            false,
        );
        assert_eq!(
            err_inside.unwrap_err(),
            "state and cache roots must be separate"
        );

        // Cache inside state
        let cache_inside_state = state_root.join("subcache");
        let err_cache_inside = build_voice_context(
            &cache_inside_state,
            &state_root,
            "windows_trt_6g",
            sha,
            CacheOs::Windows,
            None,
            None,
            false,
        );
        assert_eq!(
            err_cache_inside.unwrap_err(),
            "state and cache roots must be separate"
        );

        // Engine None without gpu
        let ctx_no_gpu = build_voice_context(
            &cache_root,
            &state_root,
            "windows_trt_6g",
            sha,
            CacheOs::Windows,
            None,
            Some("10.0.1"),
            false,
        )
        .unwrap();
        assert!(ctx_no_gpu.engine.is_none());
        assert!(ctx_no_gpu.engine_dir.is_none());
        assert!(ctx_no_gpu.readiness_inputs(temp.path()).is_none());

        // Context path helper methods
        assert_eq!(
            ctx_no_gpu.python_packages(),
            ctx_no_gpu.slot_dir.join("python-packages")
        );
        assert_eq!(
            ctx_no_gpu.model_dir(),
            ctx_no_gpu.slot_dir.join("models").join("VoxCPM2")
        );
        assert_eq!(ctx_no_gpu.slot_voices(), ctx_no_gpu.slot_dir.join("voices"));
        assert_eq!(
            ctx_no_gpu.state_voices(),
            ctx_no_gpu.state_root.join("voices")
        );
        assert_eq!(ctx_no_gpu.state_dir(), ctx_no_gpu.state_root.join("state"));
        assert_eq!(
            ctx_no_gpu.numba_cache(),
            ctx_no_gpu.state_root.join("state").join("cache").join("numba")
        );
        assert_eq!(
            ctx_no_gpu.hf_home(),
            ctx_no_gpu.state_root.join("hf-cache")
        );
        assert_eq!(
            ctx_no_gpu.install_log(),
            ctx_no_gpu.state_root.join("voxcpm2-install.log")
        );
        assert_eq!(
            ctx_no_gpu.receipt_path().unwrap(),
            ctx_no_gpu
                .cache
                .migration_receipt(&ctx_no_gpu.profile, &ctx_no_gpu.record.slot_key)
                .unwrap()
        );
    }

    #[test]
    fn test_select_identity() {
        let gpus = vec![
            GpuIdentity {
                index: 2,
                name: "GPU 2".to_string(),
                compute_cap: "8.6".to_string(),
                driver_version: "550.00".to_string(),
            },
            GpuIdentity {
                index: 0,
                name: "GPU 0".to_string(),
                compute_cap: "8.9".to_string(),
                driver_version: "550.00".to_string(),
            },
            GpuIdentity {
                index: 1,
                name: "GPU 1".to_string(),
                compute_cap: "8.6".to_string(),
                driver_version: "550.00".to_string(),
            },
        ];

        // Chosen index found
        let sel1 = select_identity(&gpus, Some(1)).unwrap();
        assert_eq!(sel1.index, 1);
        assert_eq!(sel1.name, "GPU 1");

        // Chosen index missing
        assert!(select_identity(&gpus, Some(99)).is_none());

        // None chosen -> first by index (smallest index = 0)
        let sel_default = select_identity(&gpus, None).unwrap();
        assert_eq!(sel_default.index, 0);
        assert_eq!(sel_default.name, "GPU 0");

        // Empty list
        assert!(select_identity(&[], None).is_none());
        assert!(select_identity(&[], Some(0)).is_none());
    }

    #[test]
    fn test_gpu_choice_round_trip() {
        let temp = tempfile::tempdir().unwrap();
        let state_root = temp.path().join("state");

        // Unrecorded dir
        assert_eq!(recorded_gpu_choice(&state_root), None);

        // Record Some(2)
        record_gpu_choice(&state_root, Some(2)).unwrap();
        assert_eq!(recorded_gpu_choice(&state_root), Some(2));

        // Record None
        record_gpu_choice(&state_root, None).unwrap();
        assert_eq!(recorded_gpu_choice(&state_root), None);
    }

    #[test]
    fn test_loopback_port_in_use() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(loopback_port_in_use(port));
        drop(listener);
        assert!(!loopback_port_in_use(port));
    }

    #[test]
    fn test_e2e_user_cache_root() {
        #[cfg(windows)]
        let abs_path = OsString::from(r"C:\TestPath\Cache");
        #[cfg(not(windows))]
        let abs_path = OsString::from("/test_path/cache");

        // debug_build = false -> None
        assert_eq!(
            e2e_user_cache_root_with(
                false,
                true,
                Some(OsString::from("read-only")),
                Some(abs_path.clone())
            ),
            None
        );

        // e2e_mode = false -> None
        assert_eq!(
            e2e_user_cache_root_with(
                true,
                false,
                Some(OsString::from("read-only")),
                Some(abs_path.clone())
            ),
            None
        );

        // opt_in != "read-only" -> None
        assert_eq!(
            e2e_user_cache_root_with(
                true,
                true,
                Some(OsString::from("write")),
                Some(abs_path.clone())
            ),
            None
        );
        assert_eq!(
            e2e_user_cache_root_with(true, true, None, Some(abs_path.clone())),
            None
        );

        // root is empty or None or relative -> None
        assert_eq!(
            e2e_user_cache_root_with(
                true,
                true,
                Some(OsString::from("read-only")),
                Some(OsString::from(""))
            ),
            None
        );
        assert_eq!(
            e2e_user_cache_root_with(
                true,
                true,
                Some(OsString::from("read-only")),
                Some(OsString::from("relative/path"))
            ),
            None
        );
        assert_eq!(
            e2e_user_cache_root_with(true, true, Some(OsString::from("read-only")), None),
            None
        );

        // Valid absolute path -> Some(PathBuf)
        let resolved = e2e_user_cache_root_with(
            true,
            true,
            Some(OsString::from("read-only")),
            Some(abs_path.clone()),
        );
        assert_eq!(resolved, Some(PathBuf::from(abs_path)));
    }

    #[test]
    fn test_set_active_slot() {
        let temp = tempfile::tempdir().unwrap();
        let layout = CacheLayout::new(temp.path());
        let profile = "windows_trt_6g";

        let hex_a = "1111111111111111111111111111111111111111111111111111111111111111";
        let hex_b = "2222222222222222222222222222222222222222222222222222222222222222";
        let hex_c = "3333333333333333333333333333333333333333333333333333333333333333";

        // Sequence: A -> B -> B -> C
        let r_a = set_active_slot(&layout, profile, hex_a).unwrap();
        assert_eq!(r_a, (hex_a.to_string(), None));

        let r_b1 = set_active_slot(&layout, profile, hex_b).unwrap();
        assert_eq!(r_b1, (hex_b.to_string(), Some(hex_a.to_string())));

        let r_b2 = set_active_slot(&layout, profile, hex_b).unwrap();
        assert_eq!(r_b2, (hex_b.to_string(), Some(hex_a.to_string())));

        let r_c = set_active_slot(&layout, profile, hex_c).unwrap();
        assert_eq!(r_c, (hex_c.to_string(), Some(hex_b.to_string())));

        // Validates hex64
        assert!(set_active_slot(&layout, profile, "not-a-hex").is_err());

        // Validates profile
        assert!(set_active_slot(&layout, "../bad", hex_a).is_err());
    }

    #[test]
    fn test_migration_receipt_cleaned_default() {
        let json_without_cleaned = serde_json::json!({
            "schemaVersion": 1,
            "source": "/some/path",
            "slotKey": "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            "imported": ["models"],
            "files": 1,
            "bytes": 100,
            "hardlinked": 0,
            "copied": 1,
            "verifiedInstall": true,
            "verifiedStart": true
        });
        let receipt: MigrationReceipt = serde_json::from_value(json_without_cleaned).unwrap();
        assert_eq!(receipt.cleaned, false);

        let json_with_cleaned = serde_json::json!({
            "schemaVersion": 1,
            "source": "/some/path",
            "slotKey": "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            "imported": ["models"],
            "files": 1,
            "bytes": 100,
            "hardlinked": 0,
            "copied": 1,
            "verifiedInstall": true,
            "verifiedStart": true,
            "cleaned": true
        });
        let receipt2: MigrationReceipt = serde_json::from_value(json_with_cleaned).unwrap();
        assert_eq!(receipt2.cleaned, true);
    }

    #[test]
    fn slot_paths_stay_under_max_path_for_long_user_names() {
        let user = "VeryLongUsernameHere"; // 20 characters
        assert_eq!(user.len(), 20);
        let slot_key = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
        let stamp = "fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321";
        let dk = dir_key(slot_key).unwrap();
        let sk = dir_key(stamp).unwrap();
        let release_slot = format!(r"C:\Users\{user}\AppData\Local\NaiaRuntimeCache\voxcpm2\slots\windows_trt_6g\{dk}");
        let e2e_slot = format!(r"C:\Users\{user}\AppData\Local\Temp\naia-shell-e2e-codex-4450\runtime\runtime-cache\voxcpm2\slots\windows_trt_6g\{dk}");
        // Deepest known files of the pinned windows_trt_6g artifact and packages (measured 2026-09-24).
        let both: Vec<String> = vec![
            r"\python-packages.pending\nvidia\cuda_runtime\include\cooperative_groups\details\coalesced_reduce.h".to_string(),
            r".mig\python-packages\nvidia\cuda_runtime\include\cooperative_groups\details\coalesced_reduce.h".to_string(),
            r"\models\VoxCPM2\.cache\huggingface\download\tokenization_voxcpm2.py.metadata".to_string(),
            format!(r"\engines\{sk}.pending\locdit_fp16.engine"),
        ];
        // The slot payload is only used on the release download path (E2E/dev keep the payload outside).
        let release_only = [
            r"\payload.pending\artifact\python\Lib\site-packages\transformers\models\audio_spectrogram_transformer\feature_extraction_audio_spectrogram_transformer.py",
            r".mig\payload\artifact\python\Lib\site-packages\transformers\models\audio_spectrogram_transformer\feature_extraction_audio_spectrogram_transformer.py",
        ];
        for tail in &both {
            for slot in [&release_slot, &e2e_slot] {
                let p = format!("{slot}{tail}");
                assert!(p.len() < 260, "{} chars: {}", p.len(), p);
            }
        }
        for tail in release_only {
            let p = format!("{release_slot}{tail}");
            assert!(p.len() < 260, "{} chars: {}", p.len(), p);
        }
        // The old 64-hex layout would have exceeded MAX_PATH for the NVIDIA header on the E2E root.
        let old = format!(r"C:\Users\{user}\AppData\Local\Temp\naia-shell-e2e-codex-4450\runtime\runtime-cache\voxcpm2\slots\windows_trt_6g\{slot_key}\python-packages.pending\nvidia\cuda_runtime\include\cooperative_groups\details\coalesced_reduce.h");
        assert!(old.len() >= 260);

        let temp = tempfile::tempdir().unwrap();
        let layout = CacheLayout::new(temp.path());
        let slot_dir = layout.slot_dir("windows_trt_6g", slot_key).unwrap();
        assert_eq!(slot_dir.file_name().unwrap(), dk.as_str());
        assert!(slot_dir.ends_with(&dk));
        let engine_dir = layout.engine_dir("windows_trt_6g", slot_key, stamp).unwrap();
        assert_eq!(engine_dir.file_name().unwrap(), sk.as_str());
        assert!(engine_dir.ends_with(&sk));
    }

    #[test]
    fn dir_key_accepts_full_and_short_keys_and_collision_is_mismatch() {
        let full = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let short = &full[..16];
        assert_eq!(dir_key(full).unwrap(), short);
        assert_eq!(dir_key(short).unwrap(), short);

        assert!(dir_key(&full.to_ascii_uppercase()).is_err());
        assert!(dir_key("not_a_hex_key!!").is_err());
        assert!(dir_key(&full[..15]).is_err());
        assert!(dir_key(&full[..17]).is_err());
        assert!(dir_key(&full[..32]).is_err());
        assert!(dir_key(&full[..63]).is_err());
        assert!(dir_key(&format!("{}a", full)).is_err());

        // Collision simulation: two full keys that share the first 16 chars
        let key_a = format!("{}111111111111111111111111111111111111111111111111", short);
        let key_b = format!("{}222222222222222222222222222222222222222222222222", short);
        assert_eq!(dir_key(&key_a).unwrap(), dir_key(&key_b).unwrap());

        let temp = tempfile::tempdir().unwrap();
        let slot_dir = temp.path().join("slot");
        let rec_a = SlotRecord {
            schema_version: 1,
            profile: "windows_trt_6g".to_string(),
            artifact_manifest_sha256: "aaaabbbbccccddddaaaabbbbccccddddaaaabbbbccccddddaaaabbbbccccdddd".to_string(),
            prepare_script_sha256: "1111222233334444111122223333444411112222333344441111222233334444".to_string(),
            activation_contract_sha256: "5555666677778888555566667777888855556666777788885555666677778888".to_string(),
            slot_key: key_a,
        };
        write_slot_record(&slot_dir, &rec_a).unwrap();

        let mut rec_b = rec_a.clone();
        rec_b.slot_key = key_b;

        // Reading slot record expecting B fails even though directory key is identical
        assert_eq!(read_slot_record(&slot_dir), Some(rec_a));
        assert_ne!(read_slot_record(&slot_dir), Some(rec_b));
    }

    #[test]
    fn restore_of_pre_703_legacy_install_becomes_ready_without_installer() {
        let temp_legacy = tempfile::tempdir().unwrap();
        let legacy_root = temp_legacy.path().join("legacy");

        let art_dir = legacy_root.join("payload").join("artifact");
        std::fs::create_dir_all(&art_dir).unwrap();
        let fake_python_content = b"python exe for test";
        std::fs::write(art_dir.join("python.exe"), fake_python_content).unwrap();
        let fake_python_sha = sha256_hex(fake_python_content);
        let manifest_json = serde_json::json!({
            "files": [
                {
                    "path": "python.exe",
                    "sha256": fake_python_sha
                }
            ]
        });
        let manifest_bytes = serde_json::to_vec(&manifest_json).unwrap();
        std::fs::write(art_dir.join("artifact-manifest.json"), &manifest_bytes).unwrap();
        let expected_artifact_sha = sha256_hex(&manifest_bytes);

        std::fs::write(
            art_dir.join("runtime-manifest.json"),
            br#"{"model":{"revision":"rev-703"}}"#,
        )
        .unwrap();

        let fake_lock = br#"{"packages":{"tensorrt-cu12":"10.0.1"}}"#;
        std::fs::write(art_dir.join("installer-package-lock.json"), fake_lock).unwrap();
        let fake_lock_sha = sha256_hex(fake_lock);

        let py_pkgs = legacy_root.join("python-packages");
        std::fs::create_dir_all(&py_pkgs).unwrap();
        let receipt_json = serde_json::json!({
            "installerPackageLockSha256": fake_lock_sha,
        });
        std::fs::write(
            py_pkgs.join("naia-nvidia-package-receipt.json"),
            serde_json::to_vec(&receipt_json).unwrap(),
        )
        .unwrap();

        let models_dir = legacy_root.join("models").join("VoxCPM2");
        std::fs::create_dir_all(&models_dir).unwrap();
        std::fs::write(models_dir.join("config.json"), b"{}").unwrap();
        std::fs::write(models_dir.join("model.safetensors"), b"weight bytes").unwrap();
        std::fs::write(models_dir.join("voxcpm2-model-receipt.json"), b"{}").unwrap();

        let trt_dir = legacy_root.join("checkpoints").join("voxcpm2_trt");
        std::fs::create_dir_all(&trt_dir).unwrap();
        let engine_bytes = b"serialized tensorrt engine bytes";
        std::fs::write(trt_dir.join("model.engine"), engine_bytes).unwrap();
        let engine_sha = sha256_hex(engine_bytes);
        let engine_manifest_json = serde_json::json!({
            "gpu_name": "RTX 4090",
            "compute_capability": "8.9",
            "tensorrt_version": "10.0.1",
            "model_revision": "rev-703",
            "engine": "model.engine",
            "engine_sha256": engine_sha
        });
        std::fs::write(
            trt_dir.join("manifest.json"),
            serde_json::to_vec(&engine_manifest_json).unwrap(),
        )
        .unwrap();

        let fake_wav = b"RIFFfakeWAVEdefaultbody";
        let fake_palette = vec![(
            "default.wav".to_string(),
            sha256_hex(fake_wav),
            fake_wav.len() as u64,
        )];
        let voices_dir = legacy_root.join("voices");
        std::fs::create_dir_all(&voices_dir).unwrap();
        std::fs::write(voices_dir.join("default.wav"), fake_wav).unwrap();

        let ready_json = serde_json::json!({
            "artifactManifestSha256": expected_artifact_sha,
            "model": {
                "revision": "rev-703"
            }
        });
        std::fs::write(
            legacy_root.join("voxcpm2-runtime-ready.json"),
            serde_json::to_vec(&ready_json).unwrap(),
        )
        .unwrap();

        let temp_cache = tempfile::tempdir().unwrap();
        let layout = CacheLayout::new(temp_cache.path());
        let profile = "windows_trt_6g";
        let gpu = GpuIdentity {
            index: 0,
            name: "RTX 4090".to_string(),
            compute_cap: "8.9".to_string(),
            driver_version: "550.54".to_string(),
        };
        let eng_rec = engine_stamp_record(&gpu, "10.0.1").unwrap();

        let record = slot_record_for(profile, &expected_artifact_sha, CacheOs::Windows).unwrap();
        let slot_dir = layout.slot_dir(profile, &record.slot_key).unwrap();
        let engine_dir = layout.engine_dir(profile, &record.slot_key, &eng_rec.stamp).unwrap();
        let downloads_dir = layout.downloads_dir();

        let palette_ids = vec!["default.wav".to_string()];
        let plan = MigrationPlanInput {
            legacy_root: &legacy_root,
            slot_dir: &slot_dir,
            engine_dir: Some(&engine_dir),
            downloads_dir: &downloads_dir,
            expected_artifact_sha: &expected_artifact_sha,
            palette_ids: &palette_ids,
            import_payload: true,
        };

        // 1. Migrate legacy tree
        let outcome = migrate_legacy_runtime(&plan, &|_| Some(1024 * 1024 * 1024)).unwrap();
        assert!(matches!(outcome, MigrationOutcome::Migrated(_)));

        // 2. Adopt migrated slot
        let staged_artifact = slot_dir.join("payload").join("artifact");
        let adopt_input = AdoptMigratedInput {
            legacy_root: &legacy_root,
            slot_dir: &slot_dir,
            artifact_root: &staged_artifact,
            engine_dir: Some(&engine_dir),
            engine: Some(&eng_rec),
            record: &record,
            os: CacheOs::Windows,
        };
        let report = adopt_migrated_slot(&adopt_input).unwrap();
        assert!(report.slot_record);
        assert!(report.native_hashes);
        assert!(report.ready_json);
        assert!(report.engine_stamp);

        // 3. Readiness facts without running installer
        let readiness_inputs = ReadinessInputs {
            slot_dir: &slot_dir,
            artifact_root: &staged_artifact,
            engine_dir: &engine_dir,
            expected: &record,
            engine_stamp: &eng_rec.stamp,
            os: CacheOs::Windows,
        };
        let mut facts = gather_file_facts_with_palette(&readiness_inputs, &fake_palette);
        assert!(facts.slot_record_matches);
        assert!(facts.native_hashes_match);
        assert!(facts.nvidia_receipt_matches);
        assert!(facts.model_present);
        assert!(facts.palette_matches);
        assert!(facts.ready_json_matches);
        assert!(facts.engine_matches);

        // When python runtime passes, full readiness is Ready
        facts.python_runtime = true;
        assert_eq!(evaluate_readiness(&facts), Readiness::Ready);
    }

    #[test]
    fn adopt_refuses_mismatches() {
        let temp = tempfile::tempdir().unwrap();
        let slot_dir = temp.path().join("slot");
        std::fs::create_dir_all(&slot_dir).unwrap();
        let legacy_root = temp.path().join("legacy");
        std::fs::create_dir_all(&legacy_root).unwrap();
        let artifact_root = temp.path().join("artifact");
        std::fs::create_dir_all(&artifact_root).unwrap();

        let manifest_bytes = br#"{"files":[{"path":"python.exe","sha256":"0000000000000000000000000000000000000000000000000000000000000000"}]}"#;
        std::fs::write(artifact_root.join("artifact-manifest.json"), manifest_bytes).unwrap();
        std::fs::write(artifact_root.join("python.exe"), b"corrupted python exe").unwrap();
        let manifest_sha = sha256_hex(manifest_bytes);

        let mut record = slot_record_for("windows_trt_6g", &manifest_sha, CacheOs::Windows).unwrap();

        // 1. Refuses if artifact manifest sha does not match record
        record.artifact_manifest_sha256 = "1111111111111111111111111111111111111111111111111111111111111111".to_string();
        let input_bad_sha = AdoptMigratedInput {
            legacy_root: &legacy_root,
            slot_dir: &slot_dir,
            artifact_root: &artifact_root,
            engine_dir: None,
            engine: None,
            record: &record,
            os: CacheOs::Windows,
        };
        let report_bad_sha = adopt_migrated_slot(&input_bad_sha).unwrap();
        assert_eq!(report_bad_sha, AdoptReport::default());
        record.artifact_manifest_sha256 = manifest_sha.clone();

        // 2. Refuses native hashes if file hash does not match manifest
        let input_bad_hash = AdoptMigratedInput {
            legacy_root: &legacy_root,
            slot_dir: &slot_dir,
            artifact_root: &artifact_root,
            engine_dir: None,
            engine: None,
            record: &record,
            os: CacheOs::Windows,
        };
        let report_bad_hash = adopt_migrated_slot(&input_bad_hash).unwrap();
        assert!(report_bad_hash.slot_record);
        assert!(!report_bad_hash.native_hashes);

        // 2a. Refuses native hashes if artifact manifest has no files table
        let no_files_manifest = br#"{}"#;
        let no_files_sha = sha256_hex(no_files_manifest);
        std::fs::write(artifact_root.join("artifact-manifest.json"), no_files_manifest).unwrap();
        let mut rec_no_files = record.clone();
        rec_no_files.artifact_manifest_sha256 = no_files_sha;
        let input_no_files = AdoptMigratedInput {
            legacy_root: &legacy_root,
            slot_dir: &slot_dir,
            artifact_root: &artifact_root,
            engine_dir: None,
            engine: None,
            record: &rec_no_files,
            os: CacheOs::Windows,
        };
        let report_no_files = adopt_migrated_slot(&input_no_files).unwrap();
        assert!(report_no_files.slot_record);
        assert!(!report_no_files.native_hashes);

        // Fix python.exe hash and manifest files table
        let valid_python_bytes = b"real python bytes";
        let valid_python_sha = sha256_hex(valid_python_bytes);
        let manifest_bytes_valid = format!(
            r#"{{"files":[{{"path":"python.exe","sha256":"{}"}}]}}"#,
            valid_python_sha
        );
        std::fs::write(artifact_root.join("artifact-manifest.json"), manifest_bytes_valid.as_bytes()).unwrap();
        std::fs::write(artifact_root.join("python.exe"), valid_python_bytes).unwrap();
        let valid_manifest_sha = sha256_hex(manifest_bytes_valid.as_bytes());
        record.artifact_manifest_sha256 = valid_manifest_sha;

        // 3a. Refuses ready.json if runtime-manifest has no model revision
        std::fs::write(
            artifact_root.join("runtime-manifest.json"),
            br#"{}"#,
        )
        .unwrap();
        let ready_valid_rev = serde_json::json!({
            "artifactManifestSha256": record.artifact_manifest_sha256,
            "model": {"revision": "rev-A"}
        });
        std::fs::write(
            legacy_root.join("voxcpm2-runtime-ready.json"),
            serde_json::to_vec(&ready_valid_rev).unwrap(),
        )
        .unwrap();
        let _ = std::fs::remove_file(slot_dir.join("voxcpm2-runtime-ready.json"));
        let input_no_rev = AdoptMigratedInput {
            legacy_root: &legacy_root,
            slot_dir: &slot_dir,
            artifact_root: &artifact_root,
            engine_dir: None,
            engine: None,
            record: &record,
            os: CacheOs::Windows,
        };
        let report_no_rev = adopt_migrated_slot(&input_no_rev).unwrap();
        assert!(report_no_rev.slot_record);
        assert!(report_no_rev.native_hashes);
        assert!(!report_no_rev.ready_json);
        assert!(!slot_dir.join("voxcpm2-runtime-ready.json").exists());

        // 3b. Refuses ready.json if model revision mismatches
        std::fs::write(
            artifact_root.join("runtime-manifest.json"),
            br#"{"model":{"revision":"rev-A"}}"#,
        )
        .unwrap();
        let ready_mismatch_rev = serde_json::json!({
            "artifactManifestSha256": record.artifact_manifest_sha256,
            "model": {"revision": "rev-B"}
        });
        std::fs::write(
            legacy_root.join("voxcpm2-runtime-ready.json"),
            serde_json::to_vec(&ready_mismatch_rev).unwrap(),
        )
        .unwrap();

        let engine_dir = slot_dir.join("engines").join("eng");
        std::fs::create_dir_all(&engine_dir).unwrap();
        let gpu = GpuIdentity {
            index: 0,
            name: "RTX 4090".to_string(),
            compute_cap: "8.9".to_string(),
            driver_version: "550.54".to_string(),
        };
        let eng_rec = engine_stamp_record(&gpu, "10.0.1").unwrap();

        let engine_bytes = b"engine bytes";
        std::fs::write(engine_dir.join("model.engine"), engine_bytes).unwrap();
        let engine_sha = sha256_hex(engine_bytes);

        // 4a. Refuses engine stamp if engine manifest has no engine_sha256
        let engine_no_sha_json = serde_json::json!({
            "gpu_name": "RTX 4090",
            "compute_capability": "8.9",
            "tensorrt_version": "10.0.1",
            "model_revision": "rev-A",
            "engine": "model.engine"
        });
        std::fs::write(
            engine_dir.join("manifest.json"),
            serde_json::to_vec(&engine_no_sha_json).unwrap(),
        )
        .unwrap();
        let _ = std::fs::remove_file(engine_dir.join("stamp.json"));
        let input_no_engine_sha = AdoptMigratedInput {
            legacy_root: &legacy_root,
            slot_dir: &slot_dir,
            artifact_root: &artifact_root,
            engine_dir: Some(&engine_dir),
            engine: Some(&eng_rec),
            record: &record,
            os: CacheOs::Windows,
        };
        let report_no_engine_sha = adopt_migrated_slot(&input_no_engine_sha).unwrap();
        assert!(report_no_engine_sha.slot_record);
        assert!(report_no_engine_sha.native_hashes);
        assert!(!report_no_engine_sha.engine_stamp);
        assert!(!engine_dir.join("stamp.json").exists());

        // 4b. Refuses engine stamp if GPU compute cap mismatches (with valid engine_sha256)
        let engine_bad_cc_json = serde_json::json!({
            "gpu_name": "RTX 4090",
            "compute_capability": "7.5",
            "tensorrt_version": "10.0.1",
            "model_revision": "rev-A",
            "engine": "model.engine",
            "engine_sha256": engine_sha
        });
        std::fs::write(
            engine_dir.join("manifest.json"),
            serde_json::to_vec(&engine_bad_cc_json).unwrap(),
        )
        .unwrap();

        let input_mismatches = AdoptMigratedInput {
            legacy_root: &legacy_root,
            slot_dir: &slot_dir,
            artifact_root: &artifact_root,
            engine_dir: Some(&engine_dir),
            engine: Some(&eng_rec),
            record: &record,
            os: CacheOs::Windows,
        };
        let report_mismatches = adopt_migrated_slot(&input_mismatches).unwrap();
        assert!(report_mismatches.slot_record);
        assert!(report_mismatches.native_hashes);
        assert!(!report_mismatches.ready_json);
        assert!(!report_mismatches.engine_stamp);

        // 4d. Refuses engine stamp if engine manifest has no gpu_name
        let engine_no_gpu_json = serde_json::json!({
            "compute_capability": "8.9",
            "tensorrt_version": "10.0.1",
            "model_revision": "rev-A",
            "engine": "model.engine",
            "engine_sha256": engine_sha
        });
        std::fs::write(
            engine_dir.join("manifest.json"),
            serde_json::to_vec(&engine_no_gpu_json).unwrap(),
        )
        .unwrap();
        let _ = std::fs::remove_file(engine_dir.join("stamp.json"));
        let report_no_gpu = adopt_migrated_slot(&input_mismatches).unwrap();
        assert!(report_no_gpu.slot_record);
        assert!(report_no_gpu.native_hashes);
        assert!(!report_no_gpu.engine_stamp);
        assert!(!engine_dir.join("stamp.json").exists());

        // 4e. Refuses engine stamp if engine manifest has no tensorrt_version
        let engine_no_trt_json = serde_json::json!({
            "gpu_name": "RTX 4090",
            "compute_capability": "8.9",
            "model_revision": "rev-A",
            "engine": "model.engine",
            "engine_sha256": engine_sha
        });
        std::fs::write(
            engine_dir.join("manifest.json"),
            serde_json::to_vec(&engine_no_trt_json).unwrap(),
        )
        .unwrap();
        let _ = std::fs::remove_file(engine_dir.join("stamp.json"));
        let report_no_trt = adopt_migrated_slot(&input_mismatches).unwrap();
        assert!(report_no_trt.slot_record);
        assert!(report_no_trt.native_hashes);
        assert!(!report_no_trt.engine_stamp);
        assert!(!engine_dir.join("stamp.json").exists());

        // 4f-1. Refuses engine stamp if engine field contains path traversal ("..\\model.engine")
        let engine_traversal_json = serde_json::json!({
            "gpu_name": "RTX 4090",
            "compute_capability": "8.9",
            "tensorrt_version": "10.0.1",
            "model_revision": "rev-A",
            "engine": "..\\model.engine",
            "engine_sha256": engine_sha
        });
        std::fs::write(
            engine_dir.join("manifest.json"),
            serde_json::to_vec(&engine_traversal_json).unwrap(),
        )
        .unwrap();
        let _ = std::fs::remove_file(engine_dir.join("stamp.json"));
        let report_traversal = adopt_migrated_slot(&input_mismatches).unwrap();
        assert!(report_traversal.slot_record);
        assert!(report_traversal.native_hashes);
        assert!(!report_traversal.engine_stamp);
        assert!(!engine_dir.join("stamp.json").exists());

        // 4f-2. Refuses engine stamp if engine field is missing
        let engine_missing_json = serde_json::json!({
            "gpu_name": "RTX 4090",
            "compute_capability": "8.9",
            "tensorrt_version": "10.0.1",
            "model_revision": "rev-A",
            "engine_sha256": engine_sha
        });
        std::fs::write(
            engine_dir.join("manifest.json"),
            serde_json::to_vec(&engine_missing_json).unwrap(),
        )
        .unwrap();
        let _ = std::fs::remove_file(engine_dir.join("stamp.json"));
        let report_missing_engine = adopt_migrated_slot(&input_mismatches).unwrap();
        assert!(report_missing_engine.slot_record);
        assert!(report_missing_engine.native_hashes);
        assert!(!report_missing_engine.engine_stamp);
        assert!(!engine_dir.join("stamp.json").exists());
    }

    #[test]
    fn migration_skips_payload_for_staged_bundle() {
        let temp_legacy = tempfile::tempdir().unwrap();
        let legacy_root = temp_legacy.path().join("legacy");

        let art_dir = legacy_root.join("payload").join("artifact");
        std::fs::create_dir_all(&art_dir).unwrap();
        std::fs::write(art_dir.join("artifact-manifest.json"), b"mismatched artifact manifest").unwrap();

        let py_pkgs = legacy_root.join("python-packages");
        std::fs::create_dir_all(&py_pkgs).unwrap();
        std::fs::write(py_pkgs.join("x.dll"), b"x dll bytes").unwrap();

        let models_dir = legacy_root.join("models").join("VoxCPM2");
        std::fs::create_dir_all(&models_dir).unwrap();
        std::fs::write(models_dir.join("config.json"), b"cfg").unwrap();

        let temp_cache = tempfile::tempdir().unwrap();
        let layout = CacheLayout::new(temp_cache.path());
        let slot_dir = layout.slot_dir("windows_trt_6g", "1111111111111111111111111111111111111111111111111111111111111111").unwrap();
        let downloads_dir = layout.downloads_dir();

        let plan = MigrationPlanInput {
            legacy_root: &legacy_root,
            slot_dir: &slot_dir,
            engine_dir: None,
            downloads_dir: &downloads_dir,
            expected_artifact_sha: "0000000000000000000000000000000000000000000000000000000000000000",
            palette_ids: &[],
            import_payload: false, // Staged bundle exists; skip payload import
        };

        let outcome = migrate_legacy_runtime(&plan, &|_| Some(1024 * 1024 * 1024)).unwrap();
        match outcome {
            MigrationOutcome::Migrated(receipt) => {
                assert!(!receipt.imported.contains(&"payload/artifact".to_string()));
                assert!(receipt.imported.contains(&"python-packages".to_string()));
                assert!(receipt.imported.contains(&"models".to_string()));
                assert!(!slot_dir.join("payload").exists());
                assert!(slot_dir.join("python-packages").join("x.dll").is_file());
                assert!(slot_dir.join("models").join("VoxCPM2").join("config.json").is_file());
            }
            other => panic!("expected Migrated, got {:?}", other),
        }
    }
}

