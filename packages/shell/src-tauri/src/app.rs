use base64::Engine as _;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use tauri::Manager;

use crate::data_home::{self, DataHomeChild};

#[path = "app_assets.rs"]
mod app_assets;

#[derive(Debug, Deserialize)]
struct StoreArtifact {
    sha256: String,
    signature: String,
    size: u64,
    manifest: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct StoreEntitlement {
    app_id: String,
    status: String,
    download_path: String,
    artifact: StoreArtifact,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoreSignatureReceipt {
    app_id: String,
    sha256: String,
    signature: String,
}

const STORE_SIGNATURE_RECEIPT: &str = ".naia-store-signature.json";
const STORE_SIGNATURE_ARTIFACT: &str = ".naia-store-artifact.zip";
const STORE_ENTITLEMENT_GRANTS_DIR: &str = "store-entitlement-grants";

fn is_false(value: &bool) -> bool {
    !value
}

fn decode_sha256_hex(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 {
        return None;
    }
    let bytes = value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            std::str::from_utf8(pair)
                .ok()
                .and_then(|digits| u8::from_str_radix(digits, 16).ok())
        })
        .collect::<Option<Vec<_>>>()?;
    bytes.try_into().ok()
}

fn has_verified_store_signature_with_key(
    app_dir: &std::path::Path,
    app_id: &str,
    public_key: &str,
) -> bool {
    let Some(receipt_path) = safe_app_file(app_dir, STORE_SIGNATURE_RECEIPT) else {
        return false;
    };
    let Ok(receipt) = std::fs::read(receipt_path).and_then(|bytes| {
        serde_json::from_slice::<StoreSignatureReceipt>(&bytes)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
    }) else {
        return false;
    };
    let Some(digest) = decode_sha256_hex(&receipt.sha256) else {
        return false;
    };
    let Some(manifest_path) = safe_app_file(app_dir, "app.json") else {
        return false;
    };
    let Ok(manifest_bytes) = std::fs::read(manifest_path) else {
        return false;
    };
    let Some(artifact_path) = safe_app_file(app_dir, STORE_SIGNATURE_ARTIFACT) else {
        return false;
    };
    let Ok(artifact_bytes) = std::fs::read(artifact_path) else {
        return false;
    };
    if receipt.app_id != app_id || Sha256::digest(&artifact_bytes).as_slice() != digest.as_slice() {
        return false;
    }
    if verify_artifact_signature_with_key(public_key, &digest, &receipt.signature).is_err() {
        return false;
    }
    let Ok(mut archive) = zip::ZipArchive::new(std::io::Cursor::new(artifact_bytes)) else {
        return false;
    };
    let Ok(mut signed_manifest) = archive.by_name("app.json") else {
        return false;
    };
    let mut signed_manifest_bytes = Vec::new();
    std::io::Read::read_to_end(&mut signed_manifest, &mut signed_manifest_bytes).is_ok()
        && signed_manifest_bytes == manifest_bytes
}

fn safe_app_file(app_dir: &std::path::Path, name: &str) -> Option<std::path::PathBuf> {
    let path = app_dir.join(name);
    let metadata = std::fs::symlink_metadata(&path).ok()?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return None;
    }
    let root = dunce::canonicalize(app_dir).ok()?;
    let canonical = dunce::canonicalize(path).ok()?;
    if canonical.parent() != Some(root.as_path()) {
        return None;
    }
    Some(canonical)
}

fn set_store_signature_status(
    manifest: &mut AppManifest,
    app_dir: &std::path::Path,
    public_key: &str,
) {
    manifest.store_signature_verified =
        has_verified_store_signature_with_key(app_dir, &manifest.id, public_key);
}

trait StoreFetcher {
    fn fetch_entitlement(&mut self, app_id: &str) -> Result<StoreEntitlement, String>;
    fn download_artifact(&mut self, path: &str, expected_size: u64) -> Result<Vec<u8>, String>;
}

struct HttpStoreFetcher {
    client: reqwest::blocking::Client,
    base: url::Url,
    credential: String,
}

impl StoreFetcher for HttpStoreFetcher {
    fn fetch_entitlement(&mut self, app_id: &str) -> Result<StoreEntitlement, String> {
        let endpoint = self
            .base
            .join(&format!("v1/apps/entitlements/{app_id}"))
            .map_err(|_| "Invalid entitlement endpoint".to_string())?;
        self.client
            .get(endpoint)
            .bearer_auth(&self.credential)
            .send()
            .map_err(|e| format!("Entitlement check failed: {e}"))?
            .error_for_status()
            .map_err(|e| format!("No install entitlement: {e}"))?
            .json()
            .map_err(|e| format!("Invalid entitlement: {e}"))
    }
    fn download_artifact(&mut self, path: &str, expected_size: u64) -> Result<Vec<u8>, String> {
        const MAX_ARTIFACT_BYTES: u64 = 50 * 1024 * 1024;
        if expected_size == 0 || expected_size > MAX_ARTIFACT_BYTES {
            return Err("Artifact size is outside policy limits".into());
        }
        let endpoint = self
            .base
            .join(path.trim_start_matches('/'))
            .map_err(|_| "Invalid artifact download path".to_string())?;
        let mut response = self
            .client
            .get(endpoint)
            .bearer_auth(&self.credential)
            .send()
            .map_err(|e| format!("Artifact download failed: {e}"))?
            .error_for_status()
            .map_err(|e| format!("Artifact download failed: {e}"))?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_ARTIFACT_BYTES || length != expected_size)
        {
            return Err("Artifact size verification failed".to_string());
        }
        let mut bytes = Vec::with_capacity(expected_size as usize);
        response
            .by_ref()
            .take(MAX_ARTIFACT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 != expected_size {
            return Err("Artifact size verification failed".into());
        }
        Ok(bytes)
    }
}

// Ed25519 verification key paired with the private key the gateway uses to sign
// published app artifacts. It is safe to embed in every build; rotate it by
// setting compile-time NAIA_APP_SIGNING_PUBLIC_KEY in the build environment.
const PUBLISHED_APP_SIGNING_PUBLIC_KEY: &str = "GCqIQ1dXU07erJixc6UjAaDMgnSfh+GB3ZSRxb+VH2g=";

fn resolve_signing_public_key(override_key: Option<&str>) -> &str {
    override_key
        .filter(|key| !key.trim().is_empty())
        .unwrap_or(PUBLISHED_APP_SIGNING_PUBLIC_KEY)
}

fn verify_artifact_signature(digest: &[u8], value: &str) -> Result<(), String> {
    let encoded_key = resolve_signing_public_key(option_env!("NAIA_APP_SIGNING_PUBLIC_KEY"));
    verify_artifact_signature_with_key(encoded_key, digest, value)
}

/// 어느 키로 검증할지를 밖에서 준다. 기본 키 해석과 검증 자체를 나눠 두면,
/// 검증 규칙을 배포 키에 묶인 벡터 없이 확인할 수 있다.
fn verify_artifact_signature_with_key(
    encoded_key: &str,
    digest: &[u8],
    value: &str,
) -> Result<(), String> {
    let key_bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded_key)
        .map_err(|_| "Invalid app signing public key".to_string())?;
    let key_array: [u8; 32] = key_bytes
        .try_into()
        .map_err(|_| "Invalid app signing public key".to_string())?;
    let signature_bytes = value
        .strip_prefix("ed25519:")
        .ok_or_else(|| "Artifact signature must use Ed25519".to_string())
        .and_then(|encoded| {
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| "Invalid artifact signature".to_string())
        })?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| "Invalid artifact signature".to_string())?;
    VerifyingKey::from_bytes(&key_array)
        .map_err(|_| "Invalid app signing public key".to_string())?
        .verify(digest, &signature)
        .map_err(|_| "Artifact signature verification failed".to_string())
}

fn install_store_artifact(
    apps_root: &std::path::Path,
    app_id: &str,
    artifact: &StoreArtifact,
    bytes: &[u8],
    signing_key: &str,
    allow_permission_expansion: bool,
) -> Result<(String, std::path::PathBuf), String> {
    const MAX_ARTIFACT_BYTES: u64 = 50 * 1024 * 1024;
    const MAX_EXTRACTED_BYTES: u64 = 200 * 1024 * 1024;
    const MAX_ARCHIVE_ENTRIES: usize = 4096;
    if artifact.size == 0
        || artifact.size > MAX_ARTIFACT_BYTES
        || bytes.len() as u64 != artifact.size
    {
        return Err("Artifact size verification failed".to_string());
    }
    let digest_bytes = Sha256::digest(bytes);
    let digest = format!("{:x}", digest_bytes);
    if !digest.eq_ignore_ascii_case(&artifact.sha256) {
        return Err("Artifact SHA-256 verification failed".to_string());
    }
    verify_artifact_signature_with_key(signing_key, digest_bytes.as_slice(), &artifact.signature)?;

    let temp = tempfile::Builder::new()
        .prefix(".store-install-")
        .tempdir_in(apps_root)
        .map_err(|e| e.to_string())?;
    std::fs::write(temp.path().join(STORE_SIGNATURE_ARTIFACT), bytes)
        .map_err(|e| format!("Failed to preserve verified Store artifact: {e}"))?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("Invalid app ZIP: {e}"))?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("App ZIP contains too many entries".to_string());
    }
    let mut extracted_bytes = 0_u64;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|e| e.to_string())?;
        if file
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("Symlinks are not allowed in app ZIPs".to_string());
        }
        extracted_bytes = extracted_bytes
            .checked_add(file.size())
            .ok_or_else(|| "App ZIP size overflow".to_string())?;
        if extracted_bytes > MAX_EXTRACTED_BYTES {
            return Err("Expanded app exceeds policy limits".to_string());
        }
        let relative = file
            .enclosed_name()
            .ok_or_else(|| "Unsafe path in app ZIP".to_string())?;
        let output = temp.path().join(relative);
        if file.is_dir() {
            std::fs::create_dir_all(&output).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut target = std::fs::File::create(&output).map_err(|e| e.to_string())?;
        std::io::copy(&mut file, &mut target).map_err(|e| e.to_string())?;
    }
    let manifest: AppManifest = serde_json::from_reader(
        std::fs::File::open(temp.path().join("app.json"))
            .map_err(|_| "app.json missing".to_string())?,
    )
    .map_err(|e| format!("Invalid app.json: {e}"))?;
    let issues = validate_manifest(&manifest);
    let errors: Vec<_> = issues
        .iter()
        .filter(|issue| issue.level == IssueLevel::Error)
        .collect();
    if !errors.is_empty() {
        return Err(format!(
            "App manifest validation failed: {}",
            errors
                .iter()
                .map(|issue| issue.message.as_str())
                .collect::<Vec<_>>()
                .join("; ")
        ));
    }
    for warning in issues
        .iter()
        .filter(|issue| issue.level == IssueLevel::Warning)
    {
        log::warn!("App {} manifest warning: {}", manifest.id, warning.message);
    }
    if manifest.id != app_id || artifact.manifest.get("id").and_then(|v| v.as_str()) != Some(app_id)
    {
        return Err("Installed manifest id mismatch".to_string());
    }
    if !temp.path().join("index.html").is_file() {
        return Err("index.html missing".to_string());
    }
    let receipt = StoreSignatureReceipt {
        app_id: manifest.id.clone(),
        sha256: digest,
        signature: artifact.signature.clone(),
    };
    std::fs::write(
        temp.path().join(STORE_SIGNATURE_RECEIPT),
        serde_json::to_vec(&receipt).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to record verified Store install: {e}"))?;
    let destination = apps_root.join(app_id);
    let installed_manifest = if destination.is_dir() {
        std::fs::File::open(destination.join("app.json"))
            .ok()
            .and_then(|file| serde_json::from_reader::<_, AppManifest>(file).ok())
    } else {
        None
    };
    let installed_version = installed_manifest
        .as_ref()
        .and_then(|installed| installed.version.as_deref());
    compare_store_versions(installed_version, manifest.version.as_deref())?;
    if let Some(installed) = &installed_manifest {
        let expanded = permission_expansions(installed, &manifest);
        if !expanded.is_empty() && !allow_permission_expansion {
            return Err(format!(
                "PERMISSION_EXPANSION:{}",
                serde_json::to_string(&expanded).unwrap_or_else(|_| "[]".into())
            ));
        }
    }
    let staged = temp.keep();
    match replace_store_install(
        apps_root,
        &staged,
        app_id,
        installed_version,
        manifest.version.as_deref(),
    ) {
        Ok(path) => Ok((manifest.name, path)),
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staged);
            Err(error)
        }
    }
}

fn install_store_from_fetcher(
    fetcher: &mut impl StoreFetcher,
    apps_root: &std::path::Path,
    app_id: &str,
    signing_key: &str,
    allow_permission_expansion: bool,
) -> Result<(String, std::path::PathBuf), String> {
    let entitlement = fetcher.fetch_entitlement(app_id)?;
    if entitlement.app_id != app_id || entitlement.status != "GRANTED" {
        return Err("App entitlement was not granted".into());
    }
    let expected_path = format!("/v1/apps/entitlements/{app_id}/artifact");
    if entitlement.download_path != expected_path {
        return Err("Invalid artifact download path".into());
    }
    if entitlement
        .artifact
        .manifest
        .get("id")
        .and_then(|value| value.as_str())
        != Some(app_id)
    {
        return Err("Artifact manifest mismatch".into());
    }
    let bytes = fetcher.download_artifact(&entitlement.download_path, entitlement.artifact.size)?;
    // Serialize cleanup/recovery with the staging swap, then serialize this app's
    // version check and replacement with a stable per-app advisory lock.
    let _global_lock = lock_store_global(apps_root)?;
    let _app_lock = lock_store_app(apps_root, app_id)?;
    install_store_artifact(
        apps_root,
        app_id,
        &entitlement.artifact,
        &bytes,
        signing_key,
        allow_permission_expansion,
    )
}

#[cfg(test)]
mod store_signature_tests {
    use super::*;

    #[test]
    fn uses_published_key_without_override() {
        assert_eq!(
            resolve_signing_public_key(None),
            PUBLISHED_APP_SIGNING_PUBLIC_KEY
        );
    }

    #[test]
    fn empty_or_whitespace_override_uses_published_key() {
        for override_key in ["", " \t\n"] {
            assert_eq!(
                resolve_signing_public_key(Some(override_key)),
                PUBLISHED_APP_SIGNING_PUBLIC_KEY
            );
        }
    }

    #[test]
    fn uses_a_valid_override() {
        use ed25519_dalek::SigningKey;

        let signing_key = SigningKey::from_bytes(&[9u8; 32]);
        let override_key = base64::engine::general_purpose::STANDARD
            .encode(signing_key.verifying_key().to_bytes());

        assert_eq!(
            resolve_signing_public_key(Some(&override_key)),
            override_key
        );
    }

    #[test]
    fn published_key_is_a_32_byte_ed25519_verifying_key() {
        let key_bytes = base64::engine::general_purpose::STANDARD
            .decode(PUBLISHED_APP_SIGNING_PUBLIC_KEY)
            .expect("published key must be valid base64");
        let key_array: [u8; 32] = key_bytes
            .try_into()
            .expect("published Ed25519 key must be 32 bytes");

        VerifyingKey::from_bytes(&key_array).expect("published key must parse as Ed25519");
    }

    /// 검증 경로가 옳은 서명을 받고 건드려진 것을 거절하는가.
    ///
    /// 예전에는 실제 배포 산출물의 서명을 그대로 박아 두었다. 그런데
    /// 2026-08-31 에 기본 공개키를 게이트웨이의 실제 키로 바꾸면서(96394eee)
    /// 옛 키로 서명된 그 벡터를 그대로 두어, 그때부터 이 테스트가 계속
    /// 실패했다. 벡터와 키가 따로 움직이면 언제든 다시 어긋난다.
    ///
    /// 그래서 여기서는 키와 서명을 이 테스트 안에서 함께 만든다. 씨앗이
    /// 고정이라 결과도 고정이고, 키를 바꿔도 벡터를 다시 만들 일이 없다.
    /// 기본 공개키가 실제 배포 산출물과 맞는지는 여기서 잴 수 없다 — 그것은
    /// 게이트웨이가 배포 시점에 확인한다.
    #[test]
    fn verifies_reviewed_artifact_and_rejects_tampering() {
        use ed25519_dalek::{Signer as _, SigningKey};

        let signing_key = SigningKey::from_bytes(&[7u8; 32]);
        let public_key = base64::engine::general_purpose::STANDARD
            .encode(signing_key.verifying_key().to_bytes());
        let digest = hex_digest("c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c");
        let signature = format!(
            "ed25519:{}",
            base64::engine::general_purpose::STANDARD.encode(signing_key.sign(&digest).to_bytes())
        );

        assert!(verify_artifact_signature_with_key(&public_key, &digest, &signature).is_ok());
        let mut tampered = digest;
        tampered[0] ^= 1;
        assert!(verify_artifact_signature_with_key(&public_key, &tampered, &signature).is_err());
        // 서명이 Ed25519 임을 밝히지 않으면 받지 않는다.
        assert!(verify_artifact_signature_with_key(&public_key, &digest, "MAfl").is_err());
    }

    fn hex_digest(value: &str) -> [u8; 32] {
        let decoded = (0..value.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&value[index..index + 2], 16).unwrap())
            .collect::<Vec<_>>();
        decoded.try_into().unwrap()
    }
}

fn apps_root(home: &std::path::Path) -> std::path::PathBuf {
    data_home::direct_child_of(home, DataHomeChild::Apps)
}

fn legacy_apps_root(home: &std::path::Path) -> std::path::PathBuf {
    data_home::direct_child_of(home, DataHomeChild::Panels)
}

fn is_safe_app_id(id: &str) -> bool {
    !id.is_empty()
        && id != "."
        && id != ".."
        && !id.starts_with('.')
        && ![".~install-", ".store-install-", ".store-backup-"]
            .iter()
            .any(|prefix| id.starts_with(prefix))
        && !id.contains("..")
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

#[derive(Deserialize)]
struct ManifestIdentity {
    id: String,
}

#[derive(Debug)]
enum LegacyMigrationError {
    Rejected(String),
    Io(String),
}

impl std::fmt::Display for LegacyMigrationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rejected(message) | Self::Io(message) => formatter.write_str(message),
        }
    }
}

fn migration_manifest_id(dir: &std::path::Path) -> Result<String, LegacyMigrationError> {
    let path = dir.join("app.json");
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(LegacyMigrationError::Rejected(format!(
                "Legacy app manifest is missing: {}",
                path.display()
            )))
        }
        Err(error) => {
            return Err(LegacyMigrationError::Io(format!(
                "Failed to inspect {}: {}",
                path.display(),
                error
            )))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(LegacyMigrationError::Rejected(format!(
            "Legacy app manifest is not a regular file: {}",
            path.display()
        )));
    }
    let data = match std::fs::read_to_string(&path) {
        Ok(data) => data,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::InvalidData
            ) =>
        {
                return Err(LegacyMigrationError::Rejected(format!(
                    "Invalid legacy app manifest {}: {}",
                    path.display(),
                    error
                )))
            }
        Err(error) => {
            return Err(LegacyMigrationError::Io(format!(
                "Failed to read {}: {}",
                path.display(),
                error
            )))
        }
    };
    let manifest: ManifestIdentity = serde_json::from_str(&data).map_err(|error| {
        LegacyMigrationError::Rejected(format!("Invalid {}: {}", path.display(), error))
    })?;
    if !is_safe_app_id(&manifest.id) {
        return Err(LegacyMigrationError::Rejected(format!(
            "Invalid app id in {}: {:?}",
            path.display(),
            manifest.id
        )));
    }
    Ok(manifest.id)
}

fn manifest_id(dir: &std::path::Path) -> Result<String, String> {
    migration_manifest_id(dir).map_err(|error| error.to_string())
}

fn ensure_directory(path: &std::path::Path, label: &str) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => Err(format!(
            "{} must be a real directory: {}",
            label,
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(path).map_err(|e| format!("Failed to create {}: {}", label, e))
        }
        Err(error) => Err(format!("Failed to inspect {}: {}", label, error)),
    }
}

/// Resolve the ADK selected by the running shell. Installed apps live below
/// this path so changing workspaces changes the app source of truth too.
fn selected_adk_path() -> Result<std::path::PathBuf, String> {
    let raw = crate::current_adk_path()?;
    let path = std::path::PathBuf::from(raw.trim());
    if path.as_os_str().is_empty() {
        return Err("Selected ADK path is empty".to_string());
    }
    ensure_directory(&path, "selected ADK directory")?;
    Ok(path)
}

/// Copy a legacy app without following symlinks.
///
/// A copy is used instead of the old rename migration so the source remains a
/// recoverable fallback if validation or a later ADK switch fails. App ZIPs
/// already reject symlinks; applying the same rule here keeps a legacy app
/// from widening the selected ADK's file boundary during migration.
fn copy_tree_without_symlinks(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), LegacyMigrationError> {
    let source_type = std::fs::symlink_metadata(source)
        .map_err(|error| {
            LegacyMigrationError::Io(format!("Failed to inspect legacy app: {}", error))
        })?
        .file_type();
    if !source_type.is_dir() || source_type.is_symlink() {
        return Err(LegacyMigrationError::Rejected(
            "Legacy app must be a real directory".to_string(),
        ));
    }
    std::fs::create_dir_all(destination).map_err(|error| {
        LegacyMigrationError::Io(format!("Failed to create migration directory: {}", error))
        })?;
    for entry in std::fs::read_dir(source).map_err(|error| {
            LegacyMigrationError::Io(format!("Failed to read legacy app: {}", error))
    })? {
        let entry = entry.map_err(|error| {
            LegacyMigrationError::Io(format!("Failed to read legacy app entry: {}", error))
        })?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry.file_type().map_err(|error| {
            LegacyMigrationError::Io(format!("Failed to inspect legacy app entry: {}", error))
            })?;
        if file_type.is_symlink() {
            return Err(LegacyMigrationError::Rejected(format!(
                "Legacy app contains a symlink: {}",
                source_path.display()
            )));
        }
        if file_type.is_dir() {
            copy_tree_without_symlinks(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            std::fs::copy(&source_path, &destination_path).map_err(|error| {
                LegacyMigrationError::Io(format!("Failed to copy legacy app file: {}", error))
                })?;
        } else {
            return Err(LegacyMigrationError::Rejected(format!(
                "Legacy app contains an unsupported entry: {}",
                source_path.display()
            )));
        }
    }
    Ok(())
}

/// Preserve the pre-#472 `panels` root while making safe, verified copies into
/// the canonical root. Invalid or ambiguous entries stay in place and are
/// reported diagnostically; they never block unrelated canonical apps.
fn copy_legacy_apps(root: &std::path::Path, legacy: &std::path::Path) -> Result<(), String> {
    // The canonical app directory can also be the device HOME's app root
    // (especially in tests and single-ADK installs). It is not a legacy
    // source, and scanning it through the migration path would hide malformed
    // canonical manifests as preservable legacy entries.
    if let (Ok(canonical_root), Ok(canonical_legacy)) =
        (dunce::canonicalize(root), dunce::canonicalize(legacy))
    {
        if canonical_root == canonical_legacy {
            return Ok(());
        }
    }
    let metadata = match std::fs::symlink_metadata(legacy) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Failed to inspect legacy apps directory: {}",
                error
            ))
        }
        Ok(metadata) => metadata,
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        crate::log_verbose(&format!(
            "[app storage] preserving invalid legacy panels path: {}",
            legacy.display()
        ));
        return Ok(());
    }

    for entry in std::fs::read_dir(legacy)
        .map_err(|e| format!("Failed to read legacy apps directory: {}", e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read legacy app entry: {}", e))?;
        let source = entry.path();
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(".~install-")
        {
            crate::log_verbose(&format!(
                "[app storage] preserving incomplete legacy install: {}",
                source.display()
            ));
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to inspect legacy app entry: {}", e))?;
        if file_type.is_symlink() || !file_type.is_dir() {
            crate::log_verbose(&format!(
                "[app storage] preserving unsupported legacy app entry: {}",
                source.display()
            ));
            continue;
        }
        let id = match migration_manifest_id(&source) {
            Ok(id) => id,
            Err(LegacyMigrationError::Rejected(error)) => {
                crate::log_verbose(&format!(
                    "[app storage] preserving legacy app with invalid manifest: {} ({})",
                    source.display(),
                    error
                ));
                continue;
            }
            Err(LegacyMigrationError::Io(error)) => {
                return Err(format!(
                    "Failed to inspect legacy app manifest {}: {}",
                    source.display(),
                    error
                ));
            }
        };
        let destination = root.join(&id);
        if destination.exists() {
            crate::log_verbose(&format!(
                "[app storage] preserving ambiguous legacy app; canonical copy exists: {}",
                source.display()
            ));
            continue;
        }

        let temporary = tempfile::Builder::new()
            .prefix(".~migrate-")
            .tempdir_in(root)
            .map_err(|e| format!("Failed to create legacy migration directory: {}", e))?;
        let temporary_app = temporary.path().join(&id);
        match copy_tree_without_symlinks(&source, &temporary_app) {
            Ok(()) => {}
            Err(LegacyMigrationError::Rejected(error)) => {
                crate::log_verbose(&format!(
                    "[app storage] preserving legacy app after rejected copy: {} ({})",
                    source.display(),
                    error
                ));
                continue;
            }
            Err(LegacyMigrationError::Io(error)) => {
                return Err(format!(
                    "Failed to copy legacy app {}: {}",
                    source.display(),
                    error
                ));
            }
        }
        match migration_manifest_id(&temporary_app) {
            Ok(copied_id) if copied_id == id => {}
            Ok(_) | Err(LegacyMigrationError::Rejected(_)) => {
                crate::log_verbose(&format!(
                    "[app storage] preserving legacy app after copy verification failure: {}",
                    source.display()
                ));
                continue;
            }
            Err(LegacyMigrationError::Io(error)) => {
                return Err(format!(
                    "Failed to verify migrated legacy app {}: {}",
                    source.display(),
                    error
                ));
            }
        }
        if let Err(error) = std::fs::rename(&temporary_app, &destination) {
            return Err(format!(
                "Failed to finalize migrated legacy app {}: {}",
                source.display(),
                error
            ));
        }
        rewrite_installed_app_asset_urls(&destination);
    }
    Ok(())
}

const LEGACY_MIGRATION_RECEIPT: &str = "naia-apps-legacy-panels-v1\n";
const DEVICE_LEGACY_MIGRATION_RECEIPT: &str = "naia-apps-adk-bound-v1\n";

fn legacy_migration_receipt(root: &std::path::Path) -> Result<std::path::PathBuf, String> {
    root.parent()
        .map(|parent| parent.join(".apps-legacy-migrated-v1"))
        .ok_or_else(|| "Apps directory has no ADK metadata parent".to_string())
}

fn legacy_migration_completed(root: &std::path::Path) -> Result<bool, String> {
    let receipt = legacy_migration_receipt(root)?;
    let metadata = match std::fs::symlink_metadata(&receipt) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Failed to inspect app migration receipt: {}",
                error
            ))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(format!(
            "App migration receipt must be a regular file: {}",
            receipt.display()
        ));
    }
    let contents = std::fs::read_to_string(&receipt)
        .map_err(|e| format!("Failed to read app migration receipt: {}", e))?;
    if contents != LEGACY_MIGRATION_RECEIPT {
        return Err(format!(
            "Invalid app migration receipt: {}",
            receipt.display()
        ));
    }
    Ok(true)
}

fn write_legacy_migration_receipt(root: &std::path::Path) -> Result<(), String> {
    let receipt = legacy_migration_receipt(root)?;
    let parent = receipt
        .parent()
        .ok_or_else(|| "App migration receipt has no parent".to_string())?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".apps-legacy-migrated-")
        .tempfile_in(parent)
        .map_err(|e| format!("Failed to create app migration receipt: {}", e))?;
    temporary
        .write_all(LEGACY_MIGRATION_RECEIPT.as_bytes())
        .map_err(|e| format!("Failed to write app migration receipt: {}", e))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|e| format!("Failed to flush app migration receipt: {}", e))?;
    temporary
        .persist(&receipt)
        .map_err(|e| format!("Failed to finalize app migration receipt: {}", e.error))?;
    Ok(())
}

fn device_legacy_migration_receipt(
    legacy_home: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    apps_root(legacy_home)
        .parent()
        .map(|parent| parent.join(".apps-adk-bound-v1"))
        .ok_or_else(|| "Legacy apps directory has no metadata parent".to_string())
}

fn device_legacy_migration_completed(legacy_home: &std::path::Path) -> Result<bool, String> {
    let receipt = device_legacy_migration_receipt(legacy_home)?;
    let metadata = match std::fs::symlink_metadata(&receipt) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Failed to inspect device app migration receipt: {}",
                error
            ))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(format!(
            "Device app migration receipt must be a regular file: {}",
            receipt.display()
        ));
    }
    let contents = std::fs::read_to_string(&receipt)
        .map_err(|e| format!("Failed to read device app migration receipt: {}", e))?;
    if contents != DEVICE_LEGACY_MIGRATION_RECEIPT {
        return Err(format!(
            "Invalid device app migration receipt: {}",
            receipt.display()
        ));
    }
    Ok(true)
}

fn write_device_legacy_migration_receipt(legacy_home: &std::path::Path) -> Result<(), String> {
    let receipt = device_legacy_migration_receipt(legacy_home)?;
    let parent = receipt
        .parent()
        .ok_or_else(|| "Device app migration receipt has no parent".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create device app migration receipt: {}", e))?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".apps-adk-bound-")
        .tempfile_in(parent)
        .map_err(|e| format!("Failed to create device app migration receipt: {}", e))?;
    temporary
        .write_all(DEVICE_LEGACY_MIGRATION_RECEIPT.as_bytes())
        .map_err(|e| format!("Failed to write device app migration receipt: {}", e))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|e| format!("Failed to flush device app migration receipt: {}", e))?;
    temporary.persist(&receipt).map_err(|e| {
        format!(
            "Failed to finalize device app migration receipt: {}",
            e.error
        )
    })?;
    Ok(())
}

fn legacy_user_home() -> Result<std::path::PathBuf, String> {
    let raw = data_home::user_home();
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("User home is empty; cannot migrate installed apps".to_string());
    }
    Ok(std::path::PathBuf::from(trimmed))
}

/// Establish the canonical app root below the selected ADK.
///
/// The pre-#472 `panels` directory is never removed. Safe entries are copied
/// only after verification, while invalid or ambiguous entries remain as a
/// read-only fallback with a diagnostic.
fn prepare_apps_root(home: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let legacy_home = legacy_user_home()?;
    prepare_apps_root_with_legacy_home(home, &legacy_home)
}

fn prepare_apps_root_with_legacy_home(
    home: &std::path::Path,
    legacy_home: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let root = apps_root(home);
    // 앱 자리의 부모가 곧 데이터 홈이다. 데이터 홈 경로를 따로 받아 오지
    // 않는다 — 그 디렉터리를 손에 쥐면 이름표 없는 자리를 만들 수 있다.
    if let Some(naia_root) = root.parent() {
        ensure_directory(naia_root, "Naia data directory")?;
    }
    ensure_directory(&root, "apps directory")?;
    let canonical_home = dunce::canonicalize(home).map_err(|e| format!("Invalid home: {}", e))?;
    let canonical_root =
        dunce::canonicalize(&root).map_err(|e| format!("Invalid apps directory: {}", e))?;
    if !canonical_root.starts_with(&canonical_home) {
        return Err("Apps directory escapes the user home".to_string());
    }

    if !device_legacy_migration_completed(legacy_home)? {
        // The old HOME roots are the only device-wide migration sources. A
        // device receipt prevents those sources from being replayed into a
        // later ADK, while each ADK's own panels root is migrated separately
        // under that ADK's receipt below.
        copy_legacy_apps(&root, &apps_root(legacy_home))?;
        copy_legacy_apps(&root, &legacy_apps_root(legacy_home))?;
        write_device_legacy_migration_receipt(legacy_home)?;
    }
    if !legacy_migration_completed(&root)? {
        // Keep a per-ADK receipt for the selected ADK's own legacy panels.
        // This lets a later ADK migrate its own panels once without replaying
        // the device-wide HOME sources or resurrecting removed apps.
        copy_legacy_apps(&root, &legacy_apps_root(home))?;
        write_legacy_migration_receipt(&root)?;
    }
    Ok(root)
}

/// Known app permissions aligned with PC 4.2 draft and TS app-permissions.ts.
pub const KNOWN_PERMISSIONS: &[&str] = &[
    "fullscreen",
    "downloads",
    "modals",
    "speech",
    "model.ask",
    "locale",
    "environment",
    "files.pick",
    "media.record",
    "character.read",
    "character.write",
    "browser",
    "browser.upload",
    "login-handoff",
    "shell.command",
];

/// Maximum allowed length (in unicode characters) for the context field.
/// PR-1 은 `context` 필드 문자열만 제한한다. `context.md` 파일 길이 측정은 경로 가두기(절대 경로·`..`·심볼릭 링크 거부)와 함께 PR-6 에서
pub const MAX_CONTEXT_LENGTH: usize = 800;

/// A skill procedure specification declared in app.json.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, Default)]
pub struct AppSkillSpec {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// Data use and privacy disclosure declared in app.json.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, Default)]
pub struct AppDataUseSpec {
    #[serde(
        default,
        rename = "leaves_device",
        alias = "leavesDevice",
        skip_serializing_if = "Option::is_none"
    )]
    pub leaves_device: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Panel manifest stored in ~/.naia/apps/{id}/app.json
fn deserialize_https_thumbnail<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where D: serde::Deserializer<'de> {
    let value = Option::<String>::deserialize(deserializer)?;
    Ok(value.filter(|raw| url::Url::parse(raw).is_ok_and(|url| url.scheme() == "https" && url.host_str().is_some())))
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppManifest {
    pub id: String,
    pub name: String,
    #[serde(
        default,
        rename = "manifest_version",
        alias = "manifestVersion",
        skip_serializing_if = "Option::is_none"
    )]
    pub manifest_version: Option<u32>,
    pub description: Option<String>,
    #[serde(default, rename = "descriptionKo", alias = "description_ko", skip_serializing_if = "Option::is_none")]
    pub description_ko: Option<String>,
    #[serde(default, rename = "descriptionEn", alias = "description_en", skip_serializing_if = "Option::is_none")]
    pub description_en: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub descriptions: Option<std::collections::HashMap<String, String>>,
    pub icon: Option<String>,
    /// Path to SVG icon file, relative to app directory (e.g. "icon.svg")
    #[serde(rename = "iconUrl", skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    #[serde(default, rename = "thumbnailUrl", alias = "thumbnail_url", deserialize_with = "deserialize_https_thumbnail", skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,
    /// Inline SVG content — populated at load time from iconUrl, not stored in app.json
    #[serde(
        rename = "iconSvg",
        skip_deserializing,
        skip_serializing_if = "Option::is_none"
    )]
    pub icon_svg: Option<String>,
    pub names: Option<std::collections::HashMap<String, String>>,
    #[serde(default, rename = "nameKo", alias = "name_ko", skip_serializing_if = "Option::is_none")]
    pub name_ko: Option<String>,
    #[serde(default, rename = "nameEn", alias = "name_en", skip_serializing_if = "Option::is_none")]
    pub name_en: Option<String>,
    pub version: Option<String>,
    #[serde(
        default,
        rename = "keepAlive",
        alias = "keep_alive",
        skip_serializing_if = "Option::is_none"
    )]
    pub keep_alive: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<AppSkillSpec>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<Vec<String>>,
    #[serde(
        default,
        rename = "host_permissions",
        alias = "hostPermissions",
        skip_serializing_if = "Option::is_none"
    )]
    pub host_permissions: Option<Vec<String>>,
    #[serde(
        default,
        rename = "optional_permissions",
        alias = "optionalPermissions",
        skip_serializing_if = "Option::is_none"
    )]
    pub optional_permissions: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub help: Option<std::collections::HashMap<String, String>>,
    #[serde(
        default,
        rename = "data_use",
        alias = "dataUse",
        skip_serializing_if = "Option::is_none"
    )]
    pub data_use: Option<AppDataUseSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    /// Tools the app exposes to Naia. Declared statically in app.json so the
    /// Shell can register proxy stubs with the Agent; actual execution is routed
    /// to the app iframe via postMessage (GenericInstalledApp).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<AppToolSpec>>,
    /// Set only by Rust after verifying a persisted store artifact receipt.
    /// A value in app.json is ignored.
    #[serde(default, skip_deserializing, skip_serializing_if = "is_false")]
    pub store_signature_verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store_signature_issued_at_ms: Option<u64>,
    /// Absolute path to index.html if present — used for iframe rendering
    #[serde(
        rename = "htmlEntry",
        skip_deserializing,
        skip_serializing_if = "Option::is_none"
    )]
    pub html_entry: Option<String>,
    /// Unrecognized top-level manifest keys collected for warning issues
    #[serde(flatten, skip_serializing)]
    pub extra: std::collections::BTreeMap<String, serde_json::Value>,
}

/// A tool an installed app exposes to Naia.
/// Mirrors the shell `NaiaTool` shape — forwarded verbatim to the Agent.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppToolSpec {
    /// Unique skill name with `skill_` prefix, e.g. "skill_memo_read".
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// JSON Schema for parameters (arbitrary JSON object).
    #[serde(default)]
    pub parameters: serde_json::Value,
    /// Permission tier (0=auto, 1=notify, 2=confirm). Defaults to 1.
    #[serde(default = "default_tool_tier")]
    pub tier: u8,
    /// Whether this tool is exported for cross-app invocation (default false).
    #[serde(default)]
    pub exported: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueLevel {
    Error,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestIssue {
    pub level: IssueLevel,
    pub field: String,
    pub message: String,
}

fn is_shell_reserved_key(key: &str) -> bool {
    matches!(key, "htmlEntry" | "iconSvg" | "html_entry" | "icon_svg")
}

/// Validate manifest according to v2 specification and legacy profile compatibility rules.
///
/// If `manifest_version >= 2`, rule violations are reported as `IssueLevel::Error` (installation rejected).
/// If `manifest_version` is missing or < 2 (legacy), violations are reported as `IssueLevel::Warning`
/// allowing the app to install/load with warning logs as before.
pub fn validate_manifest(manifest: &AppManifest) -> Vec<ManifestIssue> {
    let mut issues = Vec::new();
    let is_v2 = manifest.manifest_version.unwrap_or(1) >= 2;
    let make_level = |is_err: bool| -> IssueLevel {
        if is_err && is_v2 {
            IssueLevel::Error
        } else {
            IssueLevel::Warning
        }
    };

    // 1. 알 수 없는 최상위 매니페스트 필드 및 셸 예약 필드 (v2·legacy 모두 Warning, 설치는 그대로 통과)
    for key in manifest.extra.keys() {
        let message = if is_shell_reserved_key(key) {
            format!("'{}' 필드는 셸이 채우는 값이라 무시됨", key)
        } else {
            format!("알 수 없는 매니페스트 필드입니다: {}", key)
        };
        issues.push(ManifestIssue {
            level: IssueLevel::Warning,
            field: key.clone(),
            message,
        });
    }

    // 2. 알 수 없는 권한 (permissions, optional_permissions)
    let check_perms =
        |perms: &Option<Vec<String>>, field_name: &str, issues: &mut Vec<ManifestIssue>| {
        if let Some(ref list) = perms {
            for perm in list {
                if !KNOWN_PERMISSIONS.contains(&perm.as_str()) {
                    issues.push(ManifestIssue {
                        level: make_level(true),
                        field: field_name.to_string(),
                        message: format!("알 수 없는 권한입니다: {}", perm),
                    });
                }
            }
        }
    };
    check_perms(&manifest.permissions, "permissions", &mut issues);
    check_perms(
        &manifest.optional_permissions,
        "optional_permissions",
        &mut issues,
    );

    // 3. context 길이 상한 초과 (PR-1 은 `context` 필드 문자열만 제한한다. `context.md` 파일 길이 측정은 경로 가두기(절대 경로·`..`·심볼릭 링크 거부)와 함께 PR-6 에서)
    if let Some(ref ctx) = manifest.context {
        if ctx.chars().count() > MAX_CONTEXT_LENGTH {
            issues.push(ManifestIssue {
                level: make_level(true),
                field: "context".to_string(),
                message: format!(
                    "context 길이가 상한({}자)을 초과했습니다: {}자",
                    MAX_CONTEXT_LENGTH,
                    ctx.chars().count()
                ),
            });
        }
    }

    // 4. 도구 이름 규칙 (skill_ 접두사, 중복)
    if let Some(ref tools) = manifest.tools {
        let mut seen_names = std::collections::HashSet::new();
        for tool in tools {
            if !tool.name.starts_with("skill_") {
                issues.push(ManifestIssue {
                    level: make_level(true),
                    field: "tools".to_string(),
                    message: format!("도구 이름은 'skill_'로 시작해야 합니다: {}", tool.name),
                });
            }
            if !seen_names.insert(&tool.name) {
                issues.push(ManifestIssue {
                    level: make_level(true),
                    field: "tools".to_string(),
                    message: format!("중복된 도구 이름이 있습니다: {}", tool.name),
                });
            }
        }
    }

    // 5. browser / login-handoff 권한 선언에 host_permissions 없음
    let declared_perms: Vec<&str> = manifest
        .permissions
        .as_deref()
        .into_iter()
        .flatten()
        .chain(
            manifest
                .optional_permissions
                .as_deref()
                .into_iter()
                .flatten(),
        )
        .map(|s| s.as_str())
        .collect();

    let has_browser_or_login = declared_perms
        .iter()
        .any(|&p| p == "browser" || p == "login-handoff");
    if has_browser_or_login {
        let has_host_perms = manifest
            .host_permissions
            .as_ref()
            .map(|list| !list.is_empty())
            .unwrap_or(false);
        if !has_host_perms {
            issues.push(ManifestIssue {
                level: make_level(true),
                field: "host_permissions".to_string(),
                message: "'browser' 또는 'login-handoff' 권한 선언 시 'host_permissions'가 반드시 지정되어야 합니다"
                    .to_string(),
            });
        }
    }

    issues
}

fn default_tool_tier() -> u8 {
    1
}

/// List installed apps by scanning the selected ADK's `.naia/apps/`.
fn list_installed_from(home: &std::path::Path) -> Result<Vec<AppManifest>, String> {
    // Test and in-process lifecycle callers use their temporary home as the
    // migration source. The Tauri command below opts into the device HOME
    // source explicitly so tests never touch the user's receipt.
    list_installed_from_with_legacy_home(home, home)
}

fn list_installed_from_selected(home: &std::path::Path) -> Result<Vec<AppManifest>, String> {
    let legacy_home = legacy_user_home()?;
    list_installed_from_with_legacy_home(home, &legacy_home)
}

fn list_installed_from_with_legacy_home(
    home: &std::path::Path,
    legacy_home: &std::path::Path,
) -> Result<Vec<AppManifest>, String> {
    let apps_dir = prepare_apps_root_with_legacy_home(home, legacy_home)?;
    list_installed_from_root(home, apps_dir)
}

fn list_installed_from_root(
    home: &std::path::Path,
    apps_dir: std::path::PathBuf,
) -> Result<Vec<AppManifest>, String> {
    list_installed_from_root_with_signing_key(
        home,
        apps_dir,
        resolve_signing_public_key(option_env!("NAIA_APP_SIGNING_PUBLIC_KEY")),
    )
}

fn list_installed_from_root_with_signing_key(
    _home: &std::path::Path,
    apps_dir: std::path::PathBuf,
    public_key: &str,
) -> Result<Vec<AppManifest>, String> {
    let mut apps: Vec<AppManifest> = Vec::new();

    let entries = match std::fs::read_dir(&apps_dir) {
        Ok(e) => e,
        Err(e) => return Err(format!("Failed to read apps directory: {}", e)),
    };

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                log::warn!("Skipping unreadable installed-app entry: {error}");
                continue;
            }
        };
        let directory_id = entry.file_name().to_string_lossy().into_owned();
        if directory_id.starts_with('.') {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(e) => {
                log::warn!("Skipping app entry {}: {e}", entry.path().display());
            continue;
        }
        };
        if !file_type.is_dir() || file_type.is_symlink() {
            log::warn!("Skipping invalid app entry: {}", entry.path().display());
            continue;
        }
        let manifest_path = entry.path().join("app.json");
        let Some(manifest_path) = safe_app_file(&entry.path(), "app.json") else {
            return Err(format!(
                "Invalid app manifest path: {}",
                manifest_path.display()
            ));
        };
        let data = std::fs::read_to_string(&manifest_path)
            .map_err(|e| format!("Failed to read {}: {}", manifest_path.display(), e))?;
        let mut manifest: AppManifest = serde_json::from_str(&data)
            .map_err(|e| format!("Invalid {}: {e}", manifest_path.display()))?;
        if !is_safe_app_id(&manifest.id) || manifest.id != directory_id {
            log::warn!(
                "Skipping app with manifest id mismatch: {}",
                entry.path().display()
            );
            continue;
        }

        set_store_signature_status(&mut manifest, &entry.path(), public_key);
        manifest.store_signature_issued_at_ms =
            safe_app_file(&entry.path(), STORE_SIGNATURE_RECEIPT)
            .and_then(|path| std::fs::metadata(path).ok())
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64);

        // Load inline SVG if iconUrl is specified
        if let Some(ref icon_url) = manifest.icon_url.clone() {
            if let Some(svg_path) = safe_app_file(&entry.path(), icon_url) {
                if let Ok(svg) = std::fs::read_to_string(svg_path) {
                    manifest.icon_svg = Some(svg);
                }
            }
        }

        // Detect index.html for iframe rendering
        let html_path = entry.path().join("index.html");
        if std::fs::symlink_metadata(&html_path)
            .map(|metadata| metadata.file_type().is_file())
            .unwrap_or(false)
        {
            // An app may have been copied to a different ADK after install.
            // Rebase any old asset-protocol URLs before exposing htmlEntry.
            rewrite_installed_app_asset_urls(&entry.path());
            manifest.html_entry = html_path.to_string_lossy().into_owned().into();
        }

        // Strip shell-reserved keys from extra so they cannot linger even in in-memory structures
        manifest.extra.remove("htmlEntry");
        manifest.extra.remove("iconSvg");
        manifest.extra.remove("html_entry");
        manifest.extra.remove("icon_svg");

        apps.push(manifest);
    }

    Ok(apps)
}

#[tauri::command]
pub fn app_list_installed(app_handle: tauri::AppHandle) -> Result<Vec<AppManifest>, String> {
    let adk = selected_adk_path()?;
    let apps_root = prepare_apps_root(&adk)?;
    let _lock = lock_store_global(&apps_root)?;
    recover_store_artifacts(&apps_root)?;
    crate::allow_installed_app_asset_scope(&app_handle, &apps_root);
    list_installed_from_selected(&adk)
}

/// Recheck a single installed app's signature receipt immediately before a
/// model-facing Store tool is dispatched. The frontend throttles this to once
/// per app per 60 seconds; the command always reads the current files.
#[tauri::command]
pub fn app_verify_installed_store_app(app_id: String) -> Result<bool, String> {
    validate_store_app_id(&app_id)?;
    let adk = selected_adk_path()?;
    let apps_root = prepare_apps_root(&adk)?;
    let app_dir = apps_root.join(&app_id);
    let metadata = std::fs::symlink_metadata(&app_dir)
        .map_err(|_| "Installed app not found".to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Installed app not found".to_string());
    }
    let manifest_path = safe_app_file(&app_dir, "app.json")
        .ok_or_else(|| "Installed app manifest unavailable".to_string())?;
    let manifest_bytes = std::fs::read(manifest_path)
        .map_err(|_| "Installed app manifest unavailable".to_string())?;
    let manifest: AppManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| "Installed app manifest invalid".to_string())?;
    if manifest.id != app_id {
        return Ok(false);
    }
    Ok(has_verified_store_signature_with_key(
        &app_dir,
        &app_id,
        resolve_signing_public_key(option_env!("NAIA_APP_SIGNING_PUBLIC_KEY")),
    ))
}

/// Read a file on behalf of an iframe panel.
/// Restricted to files inside the selected ADK's installed-app root (max 1 MB).
/// Called from iframe-bridge.ts → Tauri invoke("app_read_file").
#[tauri::command]
pub fn app_read_file(path: String) -> Result<String, String> {
    let adk = selected_adk_path()?;
    let apps_root = prepare_apps_root(&adk)?;
    read_installed_app_file(&apps_root, &path)
}

fn read_installed_app_file(apps_root: &std::path::Path, path: &str) -> Result<String, String> {
    let root = dunce::canonicalize(apps_root).map_err(|_| "Access denied".to_string())?;

    // Resolve to canonical path to defeat symlink / path-traversal attacks.
    // Returns a generic "Access denied" to avoid leaking path existence.
    let canonical = dunce::canonicalize(path).map_err(|_| "Access denied".to_string())?;

    if !canonical.starts_with(&root) {
        return Err("Access denied".to_string());
    }

    // Enforce 1 MB read limit to prevent OOM from large/virtual files
    const MAX_BYTES: u64 = 1024 * 1024;
    let metadata = std::fs::metadata(&canonical).map_err(|_| "Access denied".to_string())?;
    if metadata.len() > MAX_BYTES {
        return Err(format!("File too large (max {} bytes)", MAX_BYTES));
    }

    std::fs::read_to_string(&canonical).map_err(|e| format!("Failed to read file: {}", e))
}

/// Shell result returned to the iframe app.
#[derive(Debug, Serialize)]
pub struct AppShellResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

/// Allowed commands mapped to absolute paths to prevent PATH hijacking.
/// Note: path-containing arguments are blocked by the '/' restriction below.
/// File access should use app_read_file rather than shell commands.
#[cfg(unix)]
const SHELL_CMD_MAP: &[(&str, &str)] = &[
    ("ls", "/usr/bin/ls"),
    ("echo", "/usr/bin/echo"),
    ("pwd", "/usr/bin/pwd"),
    ("date", "/usr/bin/date"),
    ("uname", "/usr/bin/uname"),
    ("whoami", "/usr/bin/whoami"),
];

#[cfg(windows)]
const SHELL_CMD_MAP: &[(&str, &str)] = &[
    ("ls", r"C:\Windows\System32\cmd.exe"),    // /C dir
    ("echo", r"C:\Windows\System32\cmd.exe"),  // /C echo
    ("pwd", r"C:\Windows\System32\cmd.exe"),   // /C cd
    ("date", r"C:\Windows\System32\cmd.exe"),  // /C date /t
    ("uname", r"C:\Windows\System32\cmd.exe"), // /C ver
    ("whoami", r"C:\Windows\System32\whoami.exe"),
];

/// Map shell command name to Windows cmd.exe arguments
#[cfg(windows)]
fn windows_cmd_args(cmd: &str, args: &[String]) -> Vec<String> {
    match cmd {
        "ls" => {
            let mut v = vec!["/C".to_string(), "dir".to_string()];
            v.extend(args.iter().cloned());
            v
        }
        "echo" => {
            let mut v = vec!["/C".to_string(), "echo".to_string()];
            v.extend(args.iter().cloned());
            v
        }
        "pwd" => vec!["/C".to_string(), "cd".to_string()],
        "date" => vec!["/C".to_string(), "date".to_string(), "/t".to_string()],
        "uname" => vec!["/C".to_string(), "ver".to_string()],
        _ => args.to_vec(),
    }
}

/// Run an allowlisted shell command on behalf of an iframe app.
/// Uses absolute command paths (no PATH lookup). cwd is always HOME.
/// Called from iframe-bridge.ts → Tauri invoke("app_run_shell").
#[tauri::command]
pub fn app_run_shell(cmd: String, args: Vec<String>) -> Result<AppShellResult, String> {
    // Resolve command to absolute path — rejects anything not on the allowlist
    let program = SHELL_CMD_MAP
        .iter()
        .find(|(name, _)| *name == cmd.as_str())
        .map(|(_, path)| *path)
        .ok_or_else(|| format!("Command not allowed: {}", cmd))?;

    // Validate args: no shell metacharacters, null bytes, path separators, or traversal
    for arg in &args {
        if arg.contains('\0') {
            return Err("Argument contains null byte".to_string());
        }
        if arg.contains(['|', '&', ';', '$', '`', '\n', '\r']) {
            return Err(format!("Argument contains disallowed characters: {}", arg));
        }
        // Block path separators (both / and \ on all platforms)
        if arg.contains('/') || arg.contains('\\') {
            return Err(format!("Path separator not allowed in argument: {}", arg));
        }
        if arg.contains("..") {
            return Err(format!("Path traversal not allowed in argument: {}", arg));
        }
    }

    let home = data_home::user_home();
    // Canonicalize HOME consistently with app_read_file; fall back to raw path if unavailable
    let home_path = dunce::canonicalize(&home).unwrap_or_else(|_| std::path::PathBuf::from(&home));

    #[cfg(unix)]
    let final_args = args.clone();
    #[cfg(windows)]
    let final_args = windows_cmd_args(&cmd, &args);

    let mut cmd = std::process::Command::new(program);
    cmd.args(&final_args).current_dir(&home_path); // Always run from HOME, never inheriting Tauri's cwd
    crate::platform::hide_console(&mut cmd);
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run command: {}", e))?;

    Ok(AppShellResult {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        code: output.status.code().unwrap_or(-1),
    })
}

/// Remove an installed app by its app id.
///
/// Removes exactly `<selected-adk>/.naia/apps/{id}` after validating that its manifest id
/// matches its canonical directory name.
#[tauri::command]
pub fn app_remove_installed(app: tauri::AppHandle, app_id: String) -> Result<(), String> {
    // The frontend invokes this with { appId } (removeInstalledApp). Tauri binds
    // by exact camelCase name, so the old `panel_id` (→ panelId) never received
    // the value and every removal failed ("제거하지 못했습니다", 2026-08-31).
    let adk = selected_adk_path()?;
    let root = prepare_apps_root(&adk)?;
    let _global_lock = lock_store_global(&root)?;
    let _lock = lock_store_app(&root, &app_id)?;
    remove_installed_from_selected(&adk, &app_id)?;
    use tauri::Emitter;
    let _ = app.emit("installed-apps-changed", ());
    Ok(())
}

fn remove_installed_from(home: &std::path::Path, panel_id: &str) -> Result<(), String> {
    remove_installed_from_with_legacy_home(home, panel_id, home)
}

fn remove_installed_from_selected(home: &std::path::Path, panel_id: &str) -> Result<(), String> {
    let legacy_home = legacy_user_home()?;
    remove_installed_from_with_legacy_home(home, panel_id, &legacy_home)
}

fn remove_installed_from_with_legacy_home(
    home: &std::path::Path,
    panel_id: &str,
    legacy_home: &std::path::Path,
) -> Result<(), String> {
    if !is_safe_app_id(panel_id) {
        return Err(format!("Invalid app id: {}", panel_id));
    }

    let root = prepare_apps_root_with_legacy_home(home, legacy_home)?;
    let dir = root.join(&panel_id);
    if !dir.exists() {
        return Ok(());
    }
    let file_type = std::fs::symlink_metadata(&dir)
        .map_err(|e| format!("Failed to inspect app {}: {}", panel_id, e))?
        .file_type();
    if !file_type.is_dir() || file_type.is_symlink() {
        return Err("Access denied".to_string());
    }
    if manifest_id(&dir)? != panel_id {
        return Err(format!(
            "App manifest id does not match directory: {}",
            panel_id
        ));
    }
    let canonical_root = dunce::canonicalize(&root).map_err(|_| "Access denied".to_string())?;
    let canonical = dunce::canonicalize(&dir).map_err(|_| "Access denied".to_string())?;
    if canonical.parent() != Some(canonical_root.as_path()) {
        return Err("Access denied".to_string());
    }
    std::fs::remove_dir_all(&canonical)
        .map_err(|e| format!("Failed to remove app {}: {}", panel_id, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_verifier_resolves_the_production_published_key() {
        let selected = resolve_signing_public_key(option_env!("NAIA_APP_SIGNING_PUBLIC_KEY"));
        assert_eq!(selected, PUBLISHED_APP_SIGNING_PUBLIC_KEY);
        let key_bytes = base64::engine::general_purpose::STANDARD
            .decode(selected)
            .expect("production key must decode");
        assert_eq!(key_bytes.len(), 32);
        VerifyingKey::from_bytes(key_bytes.as_slice().try_into().unwrap())
            .expect("production key must be a valid Ed25519 key");
    }

    struct MockStoreGateway {
        entitlement: Option<StoreEntitlement>,
        bytes: Vec<u8>,
        calls: Vec<&'static str>,
    }
    impl StoreFetcher for MockStoreGateway {
        fn fetch_entitlement(&mut self, _app_id: &str) -> Result<StoreEntitlement, String> {
            self.calls.push("entitlement");
            self.entitlement
                .take()
                .ok_or_else(|| "missing entitlement fixture".into())
        }
        fn download_artifact(&mut self, _path: &str, _size: u64) -> Result<Vec<u8>, String> {
            self.calls.push("download");
            Ok(self.bytes.clone())
        }
    }

    fn signed_gateway_fixture(version: &str) -> (MockStoreGateway, String) {
        signed_gateway_fixture_with_permission(version, false)
    }

    fn signed_gateway_fixture_with_permission(
        version: &str,
        add_permission: bool,
    ) -> (MockStoreGateway, String) {
        use ed25519_dalek::Signer;
        let mut manifest =
            serde_json::json!({"id":"land.naia.demo","name":"Store app","version":version});
        if add_permission {
            manifest["permissions"] = serde_json::json!(["browser"]);
        }
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        writer
            .start_file("app.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(manifest.to_string().as_bytes()).unwrap();
        writer
            .start_file("index.html", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"new package").unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        let digest = Sha256::digest(&bytes);
        let key = ed25519_dalek::SigningKey::from_bytes(&[23u8; 32]);
        let signature = key.sign(digest.as_slice());
        let encoded_key =
            base64::engine::general_purpose::STANDARD.encode(key.verifying_key().to_bytes());
        let artifact = StoreArtifact {
            sha256: format!("{digest:x}"),
            signature: format!(
                "ed25519:{}",
                base64::engine::general_purpose::STANDARD.encode(signature.to_bytes())
            ),
            size: bytes.len() as u64,
            manifest: manifest.clone(),
        };
        (
            MockStoreGateway {
                entitlement: Some(StoreEntitlement {
                    app_id: "land.naia.demo".into(),
                    status: "GRANTED".into(),
                    download_path: "/v1/apps/entitlements/land.naia.demo/artifact".into(),
                    artifact,
                }),
                bytes,
                calls: Vec::new(),
            },
            encoded_key,
        )
    }

    fn make_store_app(
        root: &std::path::Path,
        id: &str,
        version: &str,
        payload: &str,
    ) -> std::path::PathBuf {
        let app = root.join(id);
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(
            app.join("app.json"),
            serde_json::json!({"id": id, "name": "Store app", "version": version}).to_string(),
        )
        .unwrap();
        std::fs::write(app.join("index.html"), payload).unwrap();
        app
    }

    #[test]
    fn store_update_keeps_bundle_files_and_preserves_unbundled_old_files() {
        let root = tempfile::tempdir().unwrap();
        let old = make_store_app(root.path(), "land.naia.demo", "1.0.0", "old");
        std::fs::create_dir_all(old.join("data")).unwrap();
        std::fs::write(old.join("data/preferences.json"), "user settings").unwrap();
        std::fs::write(old.join("data/legacy.json"), "legacy user data").unwrap();
        let staged = make_store_app(root.path(), ".stage", "1.1.0", "new");
        std::fs::create_dir_all(staged.join("data")).unwrap();
        std::fs::write(staged.join("data/preferences.json"), "new defaults").unwrap();

        let destination = replace_store_install(
            root.path(),
            &staged,
            "land.naia.demo",
            Some("1.0.0"),
            Some("1.1.0"),
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(destination.join("index.html")).unwrap(),
            "new"
        );
        assert_eq!(
            std::fs::read_to_string(destination.join("data/preferences.json")).unwrap(),
            "new defaults"
        );
        assert_eq!(
            std::fs::read_to_string(destination.join("data/legacy.json")).unwrap(),
            "legacy user data"
        );
        assert!(!staged.exists());
    }

    #[test]
    fn same_store_version_can_repair_install_but_downgrade_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let old = make_store_app(root.path(), "land.naia.demo", "1.2.0", "corrupt");
        let staged = make_store_app(root.path(), ".stage", "1.2.0", "repaired");
        let destination = replace_store_install(
            root.path(),
            &staged,
            "land.naia.demo",
            Some("1.2.0"),
            Some("1.2.0"),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(destination.join("index.html")).unwrap(),
            "repaired"
        );
        assert_eq!(old, destination);
        assert!(compare_store_versions(Some("1.2.0"), Some("1.1.9")).is_err());
    }

    #[test]
    fn store_update_failure_restores_previous_install() {
        let root = tempfile::tempdir().unwrap();
        let old = make_store_app(root.path(), "land.naia.demo", "1.0.0", "old");
        let staged = make_store_app(root.path(), ".stage", "1.1.0", "new");

        let error = replace_store_install_with(
            root.path(),
            &staged,
            "land.naia.demo",
            Some("1.0.0"),
            Some("1.1.0"),
            |_, _| Err(std::io::Error::other("injected commit failure")),
        )
        .unwrap_err();

        assert!(error.contains("previous version restored"));
        assert_eq!(
            std::fs::read_to_string(old.join("index.html")).unwrap(),
            "old"
        );
        assert!(!std::fs::read_dir(root.path()).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".store-backup-")));
    }

    #[test]
    fn store_signature_mismatch_keeps_previous_install() {
        let root = tempfile::tempdir().unwrap();
        let old = make_store_app(root.path(), "land.naia.demo", "1.0.0", "old");
        let digest = Sha256::digest(b"tampered artifact");
        use ed25519_dalek::Signer;
        let other_key = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let other_signature = other_key.sign(digest.as_slice());
        let encoded = base64::engine::general_purpose::STANDARD.encode(other_signature.to_bytes());

        assert!(
            verify_artifact_signature(digest.as_slice(), &format!("ed25519:{encoded}")).is_err()
        );
        assert_eq!(
            std::fs::read_to_string(old.join("index.html")).unwrap(),
            "old"
        );
    }

    #[test]
    fn lower_store_version_keeps_previous_install() {
        let root = tempfile::tempdir().unwrap();
        let old = make_store_app(root.path(), "land.naia.demo", "2.0.0", "old");
        let staged = make_store_app(root.path(), ".stage", "1.9.0", "downgrade");

        assert!(replace_store_install(
            root.path(),
            &staged,
            "land.naia.demo",
            Some("2.0.0"),
            Some("1.9.0")
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(old.join("index.html")).unwrap(),
            "old"
        );
        assert_eq!(
            std::fs::read_to_string(staged.join("index.html")).unwrap(),
            "downgrade"
        );
    }

    #[test]
    fn malformed_versions_warn_and_allow_repair_but_semver_downgrade_fails() {
        assert!(compare_store_versions(Some("2026.10"), Some("2026.9")).is_ok());
        assert!(compare_store_versions(Some("broken"), Some("1.0.0")).is_ok());
        assert!(compare_store_versions(Some("2.0.0"), Some("1.9.9")).is_err());
    }

    #[test]
    fn store_ids_reject_hidden_and_reserved_paths() {
        for id in [
            ".",
            "..",
            ".hidden",
            ".store-install-app",
            ".store-backup-app",
            ".~install-app",
        ] {
            assert!(validate_store_app_id(id).is_err(), "accepted {id}");
        }
        assert!(validate_store_app_id("land.naia.demo").is_ok());
    }

    #[test]
    fn store_recovery_restores_or_removes_backups_and_cleans_install_temps() {
        let root = tempfile::tempdir().unwrap();
        let app_id = "land.naia.recover";
        let backup_name = format!(".store-backup-{}-crash", encode_hex(app_id.as_bytes()));
        let backup = root.path().join(&backup_name);
        make_store_app(root.path(), &backup_name, app_id, "recover me");
        let stale = root.path().join(".store-install-stale");
        std::fs::create_dir(&stale).unwrap();
        recover_store_artifacts(root.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.path().join(app_id).join("index.html")).unwrap(),
            "recover me"
        );
        assert!(!stale.exists());
        make_store_app(root.path(), app_id, app_id, "destination is fine");
        let redundant = root.path().join(format!(
            ".store-backup-{}-old",
            encode_hex(app_id.as_bytes())
        ));
        std::fs::create_dir(&redundant).unwrap();
        recover_store_artifacts(root.path()).unwrap();
        assert!(!redundant.exists());
        let legacy_id = "land.naia.legacy";
        make_store_app(
            root.path(),
            ".store-backup-land.naia.legacy-random",
            legacy_id,
            "legacy crash backup",
        );
        recover_store_artifacts(root.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.path().join(legacy_id).join("index.html")).unwrap(),
            "legacy crash backup"
        );
    }

    #[test]
    fn installed_app_listing_rejects_bad_manifests_and_skips_hidden_artifacts() {
        let root = tempfile::tempdir().unwrap();
        write_app(root.path(), "good", "good");
        for hidden in [
            ".~install-old",
            ".store-install-old",
            ".store-backup-old",
            ".store-lock-global",
        ] {
            std::fs::create_dir_all(root.path().join(hidden)).unwrap();
        }
        let bad = root.path().join("bad");
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(bad.join("app.json"), "not json").unwrap();
        let error = list_installed_from_root(root.path(), root.path().to_path_buf()).unwrap_err();
        assert!(error.contains("Invalid"));
        std::fs::remove_dir_all(bad).unwrap();

        let result = list_installed_from_root(root.path(), root.path().to_path_buf()).unwrap();
        assert_eq!(
            result.iter().map(|app| app.id.as_str()).collect::<Vec<_>>(),
            ["good"]
        );
    }

    #[test]
    fn permission_expansion_reports_permissions_hosts_and_tool_relaxation() {
        let old: AppManifest = serde_json::from_value(serde_json::json!({"id":"x","name":"x","permissions":["fullscreen"],"host_permissions":["https://old.example/*"],"tools":[{"name":"skill_read","tier":2,"exported":false}]})).unwrap();
        let new: AppManifest = serde_json::from_value(serde_json::json!({"id":"x","name":"x","permissions":["fullscreen","browser"],"host_permissions":["https://old.example/*","https://new.example/*"],"tools":[{"name":"skill_read","tier":0,"exported":true},{"name":"skill_write","tier":1}]})).unwrap();
        let expanded = permission_expansions(&old, &new);
        assert!(expanded
            .iter()
            .any(|item| item.contains("permissions: browser")));
        assert!(expanded
            .iter()
            .any(|item| item.contains("host_permissions: https://new.example")));
        assert!(expanded.iter().any(|item| item.contains("skill_read tier")));
        assert!(expanded
            .iter()
            .any(|item| item.contains("skill_read exported")));
        assert!(expanded.iter().any(|item| item.contains("skill_write")));
    }

    #[test]
    fn store_app_lock_serializes_same_app_but_not_other_apps() {
        use std::sync::mpsc;
        let root = tempfile::tempdir().unwrap();
        let first = lock_store_app(root.path(), "land.naia.demo").unwrap();
        let _other = lock_store_app(root.path(), "land.naia.other").unwrap();
        let (tx, rx) = mpsc::channel();
        let path = root.path().to_path_buf();
        let join = std::thread::spawn(move || {
            let _same = lock_store_app(&path, "land.naia.demo").unwrap();
            tx.send(()).unwrap();
        });
        assert!(rx
            .recv_timeout(std::time::Duration::from_millis(50))
            .is_err());
        drop(first);
        rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        join.join().unwrap();
    }

    #[test]
    fn mock_gateway_install_exercises_entitlement_download_hash_signature_manifest_and_replace() {
        let root = tempfile::tempdir().unwrap();
        make_store_app(root.path(), "land.naia.demo", "1.0.0", "old");
        let (mut gateway, key) = signed_gateway_fixture("1.1.0");
        let (name, destination) =
            install_store_from_fetcher(&mut gateway, root.path(), "land.naia.demo", &key, false)
                .unwrap();
        assert_eq!(gateway.calls, ["entitlement", "download"]);
        assert_eq!(name, "Store app");
        assert_eq!(
            std::fs::read_to_string(destination.join("index.html")).unwrap(),
            "new package"
        );
        let installed = list_installed_from_root_with_signing_key(
            root.path(),
            root.path().to_path_buf(),
            &key,
        )
        .unwrap();
        assert_eq!(installed.len(), 1);
        assert!(installed[0].store_signature_verified);
    }

    #[test]
    fn mock_gateway_rejects_signature_hash_downgrade_and_permission_expansion_without_touching_old_app(
    ) {
        for failure in ["signature", "hash", "lower", "permission"] {
            let root = tempfile::tempdir().unwrap();
            let old = make_store_app(
                root.path(),
                "land.naia.demo",
                if failure == "lower" { "2.0.0" } else { "1.0.0" },
                "old",
            );
            if failure == "permission" {
                let manifest = serde_json::json!({"id":"land.naia.demo","name":"Store app","version":"1.0.0","permissions":["fullscreen"]});
                std::fs::write(old.join("app.json"), manifest.to_string()).unwrap();
            }
            let (mut gateway, key) = signed_gateway_fixture_with_permission(
                if failure == "lower" { "1.5.0" } else { "1.1.0" },
                failure == "permission",
            );
            if failure == "signature" {
                gateway.entitlement.as_mut().unwrap().artifact.signature = "ed25519:MAfl".into();
            } else if failure == "hash" {
                gateway.entitlement.as_mut().unwrap().artifact.sha256 = "00".into();
            }
            let result = install_store_from_fetcher(
                &mut gateway,
                root.path(),
                "land.naia.demo",
                &key,
                false,
            );
            if failure == "permission" {
                assert!(result.unwrap_err().starts_with("PERMISSION_EXPANSION:"));
            } else {
                assert!(result.is_err(), "{failure} unexpectedly succeeded");
            }
            assert_eq!(
                std::fs::read_to_string(old.join("index.html")).unwrap(),
                "old",
                "{failure}"
            );
        }
    }

    fn write_app(root: &std::path::Path, dir: &str, id: &str) -> std::path::PathBuf {
        let app_dir = root.join(dir);
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::write(
            app_dir.join("app.json"),
            format!(r#"{{"id":"{}","name":"Test App"}}"#, id),
        )
        .unwrap();
        std::fs::write(app_dir.join("index.html"), "<!doctype html>").unwrap();
        app_dir
    }

    #[test]
    fn canonical_lifecycle_lists_after_restart_and_removes() {
        let home = tempfile::tempdir().unwrap();
        write_app(&apps_root(home.path()), "slides", "slides");

        let first = list_installed_from(home.path()).unwrap();
        let restarted = list_installed_from(home.path()).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(restarted[0].id, "slides");
        let expected_entry = apps_root(home.path()).join("slides/index.html");
        assert_eq!(
            std::path::Path::new(restarted[0].html_entry.as_deref().unwrap()),
            expected_entry
        );

        remove_installed_from(home.path(), "slides").unwrap();
        assert!(list_installed_from(home.path()).unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn list_and_signature_verification_reject_symlinked_app_manifest() {
        use std::os::unix::fs::symlink;

        let home = tempfile::tempdir().unwrap();
        let apps = apps_root(home.path());
        std::fs::create_dir_all(&apps).unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(
            outside.path().join("app.json"),
            r#"{"id":"linked","name":"Outside"}"#,
        )
        .unwrap();
        std::fs::create_dir_all(apps.join("linked")).unwrap();
        symlink(outside.path().join("app.json"), apps.join("linked").join("app.json")).unwrap();

        let public_key = PUBLISHED_APP_SIGNING_PUBLIC_KEY;
        assert!(list_installed_from_root_with_signing_key(home.path(), apps, public_key).is_err());
        assert!(safe_app_file(&apps_root(home.path()).join("linked"), "app.json").is_none());

        let app_dir = apps_root(home.path()).join("linked");
        for name in [STORE_SIGNATURE_RECEIPT, STORE_SIGNATURE_ARTIFACT] {
            let link = app_dir.join(name);
            symlink(outside.path().join("app.json"), &link).unwrap();
            assert!(
                safe_app_file(&app_dir, name).is_none(),
                "{name} symlink must be rejected"
            );
            std::fs::remove_file(link).unwrap();
        }
    }

    #[test]
    fn entitlement_grant_timestamp_is_persisted_and_future_values_are_rejected() {
        let app_data = tempfile::tempdir().unwrap();
        persist_store_entitlement_grant(app_data.path(), "signed-game", 1_000).unwrap();
        assert_eq!(load_store_entitlement_grant(app_data.path(), "signed-game", 1_000), Some(1_000));
        assert_eq!(load_store_entitlement_grant(app_data.path(), "signed-game", 999), None);
        assert_eq!(load_store_entitlement_grant(app_data.path(), "never-approved", 1_000), None);
    }

    #[test]
    fn entitlement_grant_filename_cannot_escape_app_data() {
        let app_data = tempfile::tempdir().unwrap();
        assert!(persist_store_entitlement_grant(app_data.path(), "../outside", 1_000).is_err());
        assert!(!app_data.path().parent().unwrap().join("outside.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn installed_icon_loading_rejects_parent_and_symlink_paths() {
        use std::os::unix::fs::symlink;

        let home = tempfile::tempdir().unwrap();
        let apps = apps_root(home.path());
        let app_dir = write_app(&apps, "icon-check", "icon-check");
        let outside = home.path().join("outside.svg");
        std::fs::write(&outside, "<svg>outside</svg>").unwrap();
        std::fs::write(
            app_dir.join("app.json"),
            r#"{"id":"icon-check","name":"Icon check","iconUrl":"../../../outside.svg"}"#,
        )
        .unwrap();
        let manifest = list_installed_from_root_with_signing_key(
            home.path(),
            apps.clone(),
            PUBLISHED_APP_SIGNING_PUBLIC_KEY,
        )
        .unwrap()
        .remove(0);
        assert!(manifest.icon_svg.is_none());

        std::fs::write(
            app_dir.join("app.json"),
            r#"{"id":"icon-check","name":"Icon check","iconUrl":"icon.svg"}"#,
        )
        .unwrap();
        symlink(&outside, app_dir.join("icon.svg")).unwrap();
        let manifest = list_installed_from_root_with_signing_key(
            home.path(),
            apps,
            PUBLISHED_APP_SIGNING_PUBLIC_KEY,
        )
        .unwrap()
        .remove(0);
        assert!(manifest.icon_svg.is_none());
    }

    #[test]
    fn only_a_valid_store_signature_receipt_marks_an_app_as_store_installed() {
        use ed25519_dalek::{Signer as _, SigningKey};

        assert_eq!(decode_sha256_hex(&"💥".repeat(16)), None);
        let home = tempfile::tempdir().unwrap();
        let app_dir = write_app(&apps_root(home.path()), "signed-game", "signed-game");
        std::fs::write(
            app_dir.join("app.json"),
            r#"{"id":"signed-game","name":"Test App","store_signature_verified":true}"#,
        )
        .unwrap();
        let signing_key = SigningKey::from_bytes(&[41_u8; 32]);
        let public_key = base64::engine::general_purpose::STANDARD
            .encode(signing_key.verifying_key().to_bytes());
        assert!(
            !list_installed_from_root_with_signing_key(
                home.path(),
                apps_root(home.path()),
                &public_key
            )
            .unwrap()[0]
                .store_signature_verified
        );
        let signed_manifest =
            br#"{"id":"signed-game","name":"Test App","store_signature_verified":true}"#;
        let mut artifact_bytes = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut artifact_bytes));
            writer
                .start_file("app.json", zip::write::SimpleFileOptions::default())
                .unwrap();
            std::io::Write::write_all(&mut writer, signed_manifest).unwrap();
            writer.finish().unwrap();
        }
        let digest = Sha256::digest(&artifact_bytes);
        let signature = format!(
            "ed25519:{}",
            base64::engine::general_purpose::STANDARD.encode(signing_key.sign(&digest).to_bytes())
        );
        let receipt = StoreSignatureReceipt {
            app_id: "signed-game".to_string(),
            sha256: format!("{:x}", digest),
            signature: signature.clone(),
        };
        let receipt_path = app_dir.join(STORE_SIGNATURE_RECEIPT);
        std::fs::write(app_dir.join(STORE_SIGNATURE_ARTIFACT), &artifact_bytes).unwrap();
        std::fs::write(&receipt_path, serde_json::to_vec(&receipt).unwrap()).unwrap();

        let listed = list_installed_from_root_with_signing_key(
            home.path(),
            apps_root(home.path()),
            &public_key,
        )
        .unwrap();
        assert!(listed[0].store_signature_verified);
        let serialized = serde_json::to_value(&listed[0]).unwrap();
        assert_eq!(serialized["store_signature_verified"], true);

        let mut invalid_signature = StoreSignatureReceipt {
            app_id: "signed-game".to_string(),
            sha256: format!("{:x}", digest),
            signature: "ed25519:AA==".to_string(),
        };
        std::fs::write(
            &receipt_path,
            serde_json::to_vec(&invalid_signature).unwrap(),
        )
        .unwrap();
        assert!(
            !list_installed_from_root_with_signing_key(
                home.path(),
                apps_root(home.path()),
                &public_key
            )
            .unwrap()[0]
                .store_signature_verified
        );
        invalid_signature.signature = signature;
        std::fs::write(
            &receipt_path,
            serde_json::to_vec(&invalid_signature).unwrap(),
        )
        .unwrap();

        std::fs::write(
            app_dir.join("app.json"),
            r#"{"id":"signed-game","name":"Replaced manifest"}"#,
        )
        .unwrap();
        assert!(
            !list_installed_from_root_with_signing_key(
                home.path(),
                apps_root(home.path()),
                &public_key
            )
            .unwrap()[0]
                .store_signature_verified
        );
        let mut tampered = receipt;
        tampered.sha256 = format!("{:x}", Sha256::digest(b"tampered artifact"));
        std::fs::write(&receipt_path, serde_json::to_vec(&tampered).unwrap()).unwrap();
        assert!(
            !list_installed_from_root_with_signing_key(
                home.path(),
                apps_root(home.path()),
                &public_key
            )
            .unwrap()[0]
                .store_signature_verified
        );
        std::fs::remove_file(&receipt_path).unwrap();
        assert!(!has_verified_store_signature_with_key(
            &app_dir,
            "signed-game",
            &public_key
        ));
    }

    #[test]
    fn migrates_legacy_panels_once() {
        let home = tempfile::tempdir().unwrap();
        let legacy = write_app(&legacy_apps_root(home.path()), "old-repo-name", "slides");

        let installed = list_installed_from(home.path()).unwrap();
        assert_eq!(installed[0].id, "slides");
        assert!(apps_root(home.path()).join("slides/app.json").is_file());
        assert!(legacy.is_dir());
        assert!(legacy_migration_receipt(&apps_root(home.path()))
            .unwrap()
            .is_file());

        remove_installed_from(home.path(), "slides").unwrap();
        assert!(list_installed_from(home.path()).unwrap().is_empty());
        assert!(legacy.is_dir());
    }

    #[test]
    fn migrates_home_apps_and_first_adk_panels_once_per_device() {
        let legacy_home = tempfile::tempdir().unwrap();
        let adk_a = tempfile::tempdir().unwrap();
        let adk_b = tempfile::tempdir().unwrap();
        let home_app = write_app(&apps_root(legacy_home.path()), "home-name", "home-app");
        let home_panel = write_app(
            &legacy_apps_root(legacy_home.path()),
            "home-panel-name",
            "home-panel",
        );
        let first_adk_panel = write_app(&legacy_apps_root(adk_a.path()), "panel-name", "panel-app");

        let listed_a =
            list_installed_from_with_legacy_home(adk_a.path(), legacy_home.path()).unwrap();
        let mut ids = listed_a.into_iter().map(|app| app.id).collect::<Vec<_>>();
        ids.sort();
        assert_eq!(ids, vec!["home-app", "home-panel", "panel-app"]);
        assert!(device_legacy_migration_receipt(legacy_home.path())
            .unwrap()
            .is_file());

        remove_installed_from_with_legacy_home(adk_a.path(), "home-app", legacy_home.path())
            .unwrap();
        remove_installed_from_with_legacy_home(adk_a.path(), "home-panel", legacy_home.path())
            .unwrap();
        remove_installed_from_with_legacy_home(adk_a.path(), "panel-app", legacy_home.path())
            .unwrap();
        assert!(
            list_installed_from_with_legacy_home(adk_a.path(), legacy_home.path())
            .unwrap()
                .is_empty()
        );

        // A later ADK cannot replay the old HOME sources, but its own legacy
        // panels are migrated once under that ADK's local receipt.
        write_app(&legacy_apps_root(adk_b.path()), "b-panel-name", "b-panel");
        let listed_b =
            list_installed_from_with_legacy_home(adk_b.path(), legacy_home.path()).unwrap();
        assert_eq!(
            listed_b
                .iter()
                .map(|app| app.id.as_str())
                .collect::<Vec<_>>(),
            ["b-panel"]
        );
        remove_installed_from_with_legacy_home(adk_b.path(), "b-panel", legacy_home.path())
            .unwrap();
        assert!(
            list_installed_from_with_legacy_home(adk_b.path(), legacy_home.path())
            .unwrap()
                .is_empty()
        );
        assert!(home_app.is_dir());
        assert!(home_panel.is_dir());
        assert!(first_adk_panel.is_dir());
    }

    #[test]
    fn rejects_missing_or_non_regular_legacy_manifests_without_failing_listing() {
        let legacy_home = tempfile::tempdir().unwrap();
        let adk = tempfile::tempdir().unwrap();
        let missing = legacy_apps_root(legacy_home.path()).join("incomplete");
        std::fs::create_dir_all(&missing).unwrap();
        let non_regular = legacy_apps_root(legacy_home.path()).join("directory-manifest");
        std::fs::create_dir_all(non_regular.join("app.json")).unwrap();

        assert!(
            list_installed_from_with_legacy_home(adk.path(), legacy_home.path())
            .unwrap()
                .is_empty()
        );
        assert!(device_legacy_migration_receipt(legacy_home.path())
            .unwrap()
            .is_file());
        assert!(missing.is_dir());
        assert!(non_regular.join("app.json").is_dir());
    }

    #[test]
    fn migration_keeps_duplicate_legacy_app_without_resurrecting_it() {
        let home = tempfile::tempdir().unwrap();
        let legacy = write_app(&legacy_apps_root(home.path()), "legacy", "slides");
        write_app(&apps_root(home.path()), "slides", "slides");

        let installed = list_installed_from(home.path()).unwrap();
        assert_eq!(installed.len(), 1);
        remove_installed_from(home.path(), "slides").unwrap();
        assert!(list_installed_from(home.path()).unwrap().is_empty());
        assert!(legacy.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn migration_refuses_symlink_without_touching_target() {
        use std::os::unix::fs::symlink;

        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        write_app(outside.path(), "target", "slides");
        let legacy = legacy_apps_root(home.path());
        std::fs::create_dir_all(&legacy).unwrap();
        symlink(outside.path().join("target"), legacy.join("slides")).unwrap();

        assert!(list_installed_from(home.path()).unwrap().is_empty());
        assert!(outside.path().join("target/app.json").is_file());
    }

    #[test]
    fn selected_app_read_stays_inside_canonical_apps_root() {
        let home = tempfile::tempdir().unwrap();
        let app = write_app(&apps_root(home.path()), "slides", "slides");
        std::fs::write(app.join("assets.txt"), "inside").unwrap();
        let outside = home.path().join("outside.txt");
        std::fs::write(&outside, "outside").unwrap();

        assert_eq!(
            read_installed_app_file(
                &apps_root(home.path()),
                &app.join("assets.txt").to_string_lossy()
            )
                .unwrap(),
            "inside"
        );
        assert_eq!(
            read_installed_app_file(&apps_root(home.path()), &outside.to_string_lossy())
                .unwrap_err(),
            "Access denied"
        );
    }

    #[test]
    fn switching_adk_roots_uses_only_the_current_apps_directory() {
        let adk_a = tempfile::tempdir().unwrap();
        let adk_b = tempfile::tempdir().unwrap();
        let app_a = write_app(&apps_root(adk_a.path()), "slides", "slides");
        std::fs::write(app_a.join("assets.txt"), "A").unwrap();
        let app_b = apps_root(adk_b.path()).join("slides");
        copy_tree_without_symlinks(&app_a, &app_b).unwrap();
        std::fs::write(app_b.join("assets.txt"), "B").unwrap();

        let listed_a = list_installed_from(adk_a.path()).unwrap();
        let listed_b = list_installed_from(adk_b.path()).unwrap();
        assert_eq!(
            listed_a[0].html_entry.as_deref(),
            Some(app_a.join("index.html").to_string_lossy().as_ref())
        );
        assert_eq!(
            listed_b[0].html_entry.as_deref(),
            Some(app_b.join("index.html").to_string_lossy().as_ref())
        );
        assert_eq!(
            read_installed_app_file(
                &apps_root(adk_b.path()),
                &app_b.join("assets.txt").to_string_lossy()
            )
                .unwrap(),
            "B"
        );
    }

    #[test]
    fn removal_refuses_manifest_id_mismatch_and_traversal() {
        let home = tempfile::tempdir().unwrap();
        let app = write_app(&apps_root(home.path()), "slides", "different-id");

        assert!(remove_installed_from(home.path(), "../slides").is_err());
        assert!(remove_installed_from(home.path(), "slides").is_err());
        assert!(app.is_dir());
    }

    #[test]
    fn listing_rejects_invalid_canonical_manifest() {
        let home = tempfile::tempdir().unwrap();
        let app = apps_root(home.path()).join("slides");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("app.json"), r#"{"name":"Missing id"}"#).unwrap();

        let error = list_installed_from(home.path()).unwrap_err();
        assert!(error.contains("Invalid"));
    }

    #[cfg(unix)]
    #[test]
    fn listing_rejects_symlinked_naia_data_root() {
        use std::os::unix::fs::symlink;

        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(
            outside.path(),
            data_home::direct_child_of(home.path(), DataHomeChild::Apps)
                .parent()
                .unwrap(),
        )
        .unwrap();

        assert!(list_installed_from(home.path()).is_err());
        assert!(!outside.path().join("apps").exists());
    }

    #[test]
    fn slides_package_public_app_json_reads_as_legacy_profile() {
        let slides_json = include_str!("../../src/apps/slides/package-public/app.json");
        let manifest: AppManifest =
            serde_json::from_str(slides_json).expect("slides app.json must deserialize");
        assert_eq!(manifest.id, "land.naia.slides");
        assert!(manifest.manifest_version.is_none());
        assert!(manifest.descriptions.is_some());
        let descriptions = manifest.descriptions.as_ref().unwrap();
        assert!(descriptions.contains_key("ko"));
        assert!(descriptions.contains_key("en"));

        // All keys declared in slides app.json must be recognized (no unknown keys in extra)
        assert!(
            manifest.extra.is_empty(),
            "slides app.json must not have unknown keys, got: {:?}",
            manifest.extra
        );

        let issues = validate_manifest(&manifest);
        // Legacy profile must not produce any Error-level issues or unknown field warnings
        assert!(!issues.iter().any(|i| i.level == IssueLevel::Error));
        assert!(!issues.iter().any(|i| manifest.extra.contains_key(&i.field)));
        assert!(
            issues.is_empty(),
            "expected no issues for slides app.json, got: {:?}",
            issues
        );
    }

    #[test]
    fn localized_store_metadata_survives_roundtrip() {
        let input = r#"{"id":"example.app","name":"Example","names":{"ko":"이름"},"descriptions":{"en":"Description"},"nameKo":"이름","descriptionEn":"Description","thumbnailUrl":"https://example.com/preview.png"}"#;
        let manifest: AppManifest = serde_json::from_str(input).unwrap();
        assert!(manifest.extra.is_empty());
        let json = serde_json::to_value(manifest).unwrap();
        assert_eq!(json["names"]["ko"], "이름");
        assert_eq!(json["descriptions"]["en"], "Description");
        assert_eq!(json["nameKo"], "이름");
        assert_eq!(json["descriptionEn"], "Description");
        assert_eq!(json["thumbnailUrl"], "https://example.com/preview.png");
    }

    #[test]
    fn thumbnail_url_drops_non_https_values() {
        for raw in ["javascript:alert(1)", "data:image/png;base64,AAAA", "file:///tmp/image.png", "http://example.com/x", "/preview.png"] {
            let input = serde_json::json!({"id": "example.app", "name": "Example", "thumbnailUrl": raw});
            let manifest: AppManifest = serde_json::from_value(input).unwrap();
            assert_eq!(manifest.thumbnail_url, None, "{raw}");
            assert!(serde_json::to_value(manifest).unwrap().get("thumbnailUrl").is_none());
        }
    }

    #[test]
    fn manifest_v2_full_fields_roundtrip() {
        let original_json = r#"{
            "manifest_version": 2,
            "id": "land.naia.v2test",
            "name": "Naia V2 Test",
            "description": "Test app description",
            "descriptions": {
                "ko": "테스트 설명",
                "en": "Test description"
            },
            "icon": "🚀",
            "iconUrl": "icon.svg",
            "names": {
                "ko": "테스트",
                "en": "Test"
            },
            "version": "1.2.3",
            "keepAlive": false,
            "context": "context.md",
            "skills": [
                {
                    "id": "test-skill",
                    "version": "1.0.0",
                    "path": "skills/test/SKILL.md"
                }
            ],
            "permissions": ["fullscreen", "downloads", "speech", "browser"],
            "host_permissions": ["https://example.com/*"],
            "optional_permissions": ["modals"],
            "requires": ["land.naia.slides@>=0.2"],
            "help": {
                "ko": "help/ko.md",
                "en": "help/en.md"
            },
            "data_use": {
                "leaves_device": ["https://example.com/api"],
                "note": "Telemetry only"
            },
            "publisher": "nextain",
            "tools": [
                {
                    "name": "skill_v2_action",
                    "description": "Do action",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query": { "type": "string" }
                        }
                    },
                    "tier": 2,
                    "exported": true
                }
            ]
        }"#;

        let manifest: AppManifest = serde_json::from_str(original_json).unwrap();
        assert_eq!(manifest.manifest_version, Some(2));
        assert_eq!(manifest.id, "land.naia.v2test");
        assert_eq!(manifest.keep_alive, Some(false));
        assert_eq!(manifest.context.as_deref(), Some("context.md"));
        assert_eq!(manifest.publisher.as_deref(), Some("nextain"));

        let skills = manifest.skills.as_ref().unwrap();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, "test-skill");
        assert_eq!(skills[0].version.as_deref(), Some("1.0.0"));

        let tools = manifest.tools.as_ref().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "skill_v2_action");
        assert_eq!(tools[0].tier, 2);
        assert!(tools[0].exported);

        let data_use = manifest.data_use.as_ref().unwrap();
        assert_eq!(
            data_use.leaves_device.as_deref(),
            Some(&vec!["https://example.com/api".to_string()][..])
        );

        let issues = validate_manifest(&manifest);
        assert!(
            issues.is_empty(),
            "valid v2 manifest should have no issues: {:?}",
            issues
        );

        // Serialization round-trip
        assert!(manifest.extra.is_empty());
        let serialized = serde_json::to_string(&manifest).unwrap();
        let remanifest: AppManifest = serde_json::from_str(&serialized).unwrap();
        assert_eq!(remanifest.manifest_version, Some(2));
        assert_eq!(remanifest.id, "land.naia.v2test");
        assert_eq!(remanifest.keep_alive, Some(false));
        assert_eq!(remanifest.tools.unwrap()[0].exported, true);
        assert!(remanifest.extra.is_empty());

        // Extra fields collected into manifest.extra during deserialization, but omitted from serialization (IPC)
        let extra_json = r#"{"id":"test","name":"Test","custom_key":"custom_val"}"#;
        let manifest_extra: AppManifest = serde_json::from_str(extra_json).unwrap();
        assert_eq!(
            manifest_extra.extra.get("custom_key"),
            Some(&serde_json::Value::String("custom_val".to_string()))
        );
        let serialized_extra = serde_json::to_string(&manifest_extra).unwrap();
        assert!(
            !serialized_extra.contains("custom_key"),
            "unknown extra keys must not be serialized"
        );
        let remanifest_extra: AppManifest = serde_json::from_str(&serialized_extra).unwrap();
        assert!(
            remanifest_extra.extra.is_empty(),
            "deserialized result from serialized JSON must have empty extra"
        );
    }

    #[test]
    fn keep_alive_false_preserved_in_manifest() {
        let json_false = r#"{"id":"test","name":"Test","keepAlive":false}"#;
        let manifest_false: AppManifest = serde_json::from_str(json_false).unwrap();
        assert_eq!(manifest_false.keep_alive, Some(false));

        let json_true = r#"{"id":"test","name":"Test","keepAlive":true}"#;
        let manifest_true: AppManifest = serde_json::from_str(json_true).unwrap();
        assert_eq!(manifest_true.keep_alive, Some(true));

        let json_none = r#"{"id":"test","name":"Test"}"#;
        let manifest_none: AppManifest = serde_json::from_str(json_none).unwrap();
        assert_eq!(manifest_none.keep_alive, None);
    }

    #[test]
    fn validate_manifest_unknown_permissions_rule() {
        let v2_json = r#"{
            "manifest_version": 2,
            "id": "test",
            "name": "Test",
            "permissions": ["fullscreen", "completely_unknown_perm"]
        }"#;
        let v2_manifest: AppManifest = serde_json::from_str(v2_json).unwrap();
        let v2_issues = validate_manifest(&v2_manifest);
        assert!(v2_issues
            .iter()
            .any(|i| i.level == IssueLevel::Error && i.field == "permissions"));

        let legacy_json = r#"{
            "id": "test",
            "name": "Test",
            "permissions": ["completely_unknown_perm"]
        }"#;
        let legacy_manifest: AppManifest = serde_json::from_str(legacy_json).unwrap();
        let legacy_issues = validate_manifest(&legacy_manifest);
        assert!(legacy_issues
            .iter()
            .any(|i| i.level == IssueLevel::Warning && i.field == "permissions"));
        assert!(!legacy_issues.iter().any(|i| i.level == IssueLevel::Error));
    }

    #[test]
    fn validate_manifest_context_length_limit_rule() {
        let long_context = "a".repeat(801);
        let v2_json = format!(
            r#"{{"manifest_version": 2, "id": "test", "name": "Test", "context": "{}"}}"#,
            long_context
        );
        let v2_manifest: AppManifest = serde_json::from_str(&v2_json).unwrap();
        let v2_issues = validate_manifest(&v2_manifest);
        assert!(v2_issues
            .iter()
            .any(|i| i.level == IssueLevel::Error && i.field == "context"));

        let legacy_json = format!(
            r#"{{"id": "test", "name": "Test", "context": "{}"}}"#,
            long_context
        );
        let legacy_manifest: AppManifest = serde_json::from_str(&legacy_json).unwrap();
        let legacy_issues = validate_manifest(&legacy_manifest);
        assert!(legacy_issues
            .iter()
            .any(|i| i.level == IssueLevel::Warning && i.field == "context"));
        assert!(!legacy_issues.iter().any(|i| i.level == IssueLevel::Error));
    }

    #[test]
    fn validate_manifest_tool_naming_and_duplicates_rule() {
        // Bad prefix in v2 -> Error
        let bad_prefix_json = r#"{
            "manifest_version": 2,
            "id": "test",
            "name": "Test",
            "tools": [{"name": "bad_tool_name"}]
        }"#;
        let bad_prefix_manifest: AppManifest = serde_json::from_str(bad_prefix_json).unwrap();
        let bad_prefix_issues = validate_manifest(&bad_prefix_manifest);
        assert!(bad_prefix_issues
            .iter()
            .any(|i| i.level == IssueLevel::Error && i.message.contains("skill_")));

        // Duplicate tool in v2 -> Error
        let dup_json = r#"{
            "manifest_version": 2,
            "id": "test",
            "name": "Test",
            "tools": [
                {"name": "skill_do_something"},
                {"name": "skill_do_something"}
            ]
        }"#;
        let dup_manifest: AppManifest = serde_json::from_str(dup_json).unwrap();
        let dup_issues = validate_manifest(&dup_manifest);
        assert!(dup_issues
            .iter()
            .any(|i| i.level == IssueLevel::Error && i.message.contains("중복")));

        // Legacy -> Warnings, not Errors
        let legacy_bad_tool_json = r#"{
            "id": "test",
            "name": "Test",
            "tools": [{"name": "not_prefixed"}]
        }"#;
        let legacy_bad_manifest: AppManifest = serde_json::from_str(legacy_bad_tool_json).unwrap();
        let legacy_issues = validate_manifest(&legacy_bad_manifest);
        assert!(legacy_issues.iter().any(|i| i.level == IssueLevel::Warning));
        assert!(!legacy_issues.iter().any(|i| i.level == IssueLevel::Error));
    }

    #[test]
    fn validate_manifest_browser_requires_host_permissions_rule() {
        // v2 with browser but empty host_permissions -> Error
        let v2_no_host_json = r#"{
            "manifest_version": 2,
            "id": "test",
            "name": "Test",
            "permissions": ["browser"],
            "host_permissions": []
        }"#;
        let v2_no_host_manifest: AppManifest = serde_json::from_str(v2_no_host_json).unwrap();
        let v2_issues = validate_manifest(&v2_no_host_manifest);
        assert!(v2_issues
            .iter()
            .any(|i| i.level == IssueLevel::Error && i.field == "host_permissions"));

        // v2 with login-handoff but no host_permissions -> Error
        let v2_login_json = r#"{
            "manifest_version": 2,
            "id": "test",
            "name": "Test",
            "permissions": ["login-handoff"]
        }"#;
        let v2_login_manifest: AppManifest = serde_json::from_str(v2_login_json).unwrap();
        let v2_login_issues = validate_manifest(&v2_login_manifest);
        assert!(v2_login_issues
            .iter()
            .any(|i| i.level == IssueLevel::Error && i.field == "host_permissions"));

        // Legacy with browser but no host_permissions -> Warning, not Error
        let legacy_browser_json = r#"{
            "id": "test",
            "name": "Test",
            "permissions": ["browser"]
        }"#;
        let legacy_browser_manifest: AppManifest =
            serde_json::from_str(legacy_browser_json).unwrap();
        let legacy_issues = validate_manifest(&legacy_browser_manifest);
        assert!(legacy_issues
            .iter()
            .any(|i| i.level == IssueLevel::Warning && i.field == "host_permissions"));
        assert!(!legacy_issues.iter().any(|i| i.level == IssueLevel::Error));

        // v2 with browser and valid host_permissions -> OK
        let v2_valid_json = r#"{
            "manifest_version": 2,
            "id": "test",
            "name": "Test",
            "permissions": ["browser"],
            "host_permissions": ["https://example.com/*"]
        }"#;
        let v2_valid_manifest: AppManifest = serde_json::from_str(v2_valid_json).unwrap();
        let v2_valid_issues = validate_manifest(&v2_valid_manifest);
        assert!(
            v2_valid_issues.is_empty(),
            "expected no issues, got {:?}",
            v2_valid_issues
        );
    }

    #[test]
    fn validate_manifest_unknown_keys_warns() {
        // v2 with typo key "permission" -> Warning 1건, Error 0건, 설치 거부 없음
        let v2_typo_json = r#"{
            "manifest_version": 2,
            "id": "test",
            "name": "Test",
            "permission": ["fullscreen"]
        }"#;
        let v2_typo_manifest: AppManifest = serde_json::from_str(v2_typo_json).unwrap();
        assert!(v2_typo_manifest.extra.contains_key("permission"));
        let v2_issues = validate_manifest(&v2_typo_manifest);
        let warnings: Vec<_> = v2_issues
            .iter()
            .filter(|i| i.level == IssueLevel::Warning)
            .collect();
        let errors: Vec<_> = v2_issues
            .iter()
            .filter(|i| i.level == IssueLevel::Error)
            .collect();
        assert_eq!(warnings.len(), 1);
        assert_eq!(
            errors.len(),
            0,
            "typo key must produce 0 errors so install is not rejected"
        );
        assert_eq!(warnings[0].field, "permission");
        assert!(warnings[0].message.contains("permission"));

        // Legacy with unknown key -> Warning 1건, Error 0건
        let legacy_typo_json = r#"{
            "id": "test",
            "name": "Test",
            "unknown_extra_field": "some_value"
        }"#;
        let legacy_typo_manifest: AppManifest = serde_json::from_str(legacy_typo_json).unwrap();
        assert!(legacy_typo_manifest
            .extra
            .contains_key("unknown_extra_field"));
        let legacy_issues = validate_manifest(&legacy_typo_manifest);
        let legacy_warnings: Vec<_> = legacy_issues
            .iter()
            .filter(|i| i.level == IssueLevel::Warning)
            .collect();
        let legacy_errors: Vec<_> = legacy_issues
            .iter()
            .filter(|i| i.level == IssueLevel::Error)
            .collect();
        assert_eq!(legacy_warnings.len(), 1);
        assert_eq!(legacy_errors.len(), 0);
        assert_eq!(legacy_warnings[0].field, "unknown_extra_field");
        assert!(legacy_warnings[0].message.contains("unknown_extra_field"));
    }

    #[test]
    fn shell_filled_fields_cannot_be_overridden_by_app_json() {
        let evil_json = r#"{
            "manifest_version": 2,
            "id": "land.naia.evil",
            "name": "Evil App",
            "htmlEntry": "C:/evil/index.html",
            "iconSvg": "<svg onload=alert(1)>"
        }"#;

        // Deserializing app.json: htmlEntry and iconSvg are skip_deserializing, so placed into extra
        let mut manifest: AppManifest =
            serde_json::from_str(evil_json).expect("must deserialize evil manifest");
        assert_eq!(
            manifest.extra.get("htmlEntry"),
            Some(&serde_json::Value::String("C:/evil/index.html".to_string()))
        );
        assert_eq!(
            manifest.extra.get("iconSvg"),
            Some(&serde_json::Value::String(
                "<svg onload=alert(1)>".to_string()
            ))
        );

        // validate_manifest reports warnings for shell-reserved keys but does not reject install (0 errors)
        let issues = validate_manifest(&manifest);
        let warnings: Vec<_> = issues
            .iter()
            .filter(|i| i.level == IssueLevel::Warning)
            .collect();
        let errors: Vec<_> = issues
            .iter()
            .filter(|i| i.level == IssueLevel::Error)
            .collect();
        assert_eq!(
            errors.len(),
            0,
            "shell-reserved keys must not reject install"
        );
        assert_eq!(warnings.len(), 2);
        assert!(warnings
            .iter()
            .any(|w| w.field == "htmlEntry" && w.message.contains("셸이 채우는 값이라 무시됨")));
        assert!(warnings
            .iter()
            .any(|w| w.field == "iconSvg" && w.message.contains("셸이 채우는 값이라 무시됨")));

        // Shell populates trusted values
        manifest.html_entry = Some("C:/apps/a/index.html".to_string());
        manifest.icon_svg = Some("<svg/>".to_string());

        let serialized = serde_json::to_string(&manifest).expect("must serialize");

        // Raw JSON string must contain each key exactly ONCE (no duplication from extra)
        assert_eq!(
            serialized.matches("\"htmlEntry\"").count(),
            1,
            "htmlEntry must appear exactly once in serialized json, got: {}",
            serialized
        );
        assert_eq!(
            serialized.matches("\"iconSvg\"").count(),
            1,
            "iconSvg must appear exactly once in serialized json, got: {}",
            serialized
        );

        // Reparsing JSON confirms shell values are preserved, evil values are absent
        let parsed: serde_json::Value = serde_json::from_str(&serialized).expect("must parse json");
        assert_eq!(parsed["htmlEntry"], "C:/apps/a/index.html");
        assert_eq!(parsed["iconSvg"], "<svg/>");

        // When shell values are None, extra keys must NOT resurrect into empty slots
        manifest.html_entry = None;
        manifest.icon_svg = None;
        let serialized_none = serde_json::to_string(&manifest).expect("must serialize none");
        assert!(
            !serialized_none.contains("\"htmlEntry\""),
            "empty htmlEntry must not be filled by extra"
        );
        assert!(
            !serialized_none.contains("\"iconSvg\""),
            "empty iconSvg must not be filled by extra"
        );
    }

    #[test]
    fn list_installed_from_root_shell_filled_fields_cannot_be_overridden_by_app_json() {
        let home = tempfile::tempdir().unwrap();
        let apps_dir = apps_root(home.path());
        let app_dir = apps_dir.join("land.naia.evil");
        std::fs::create_dir_all(&app_dir).unwrap();

        let evil_json = r#"{
            "manifest_version": 2,
            "id": "land.naia.evil",
            "name": "Evil App",
            "iconUrl": "icon.svg",
            "htmlEntry": "C:/evil/index.html",
            "iconSvg": "<svg onload=alert(1)>"
        }"#;
        std::fs::write(app_dir.join("app.json"), evil_json).unwrap();
        std::fs::write(
            app_dir.join("index.html"),
            "<!doctype html><html><body>trusted</body></html>",
        )
        .unwrap();
        std::fs::write(app_dir.join("icon.svg"), "<svg><path d=\"trusted\"/></svg>").unwrap();

        let installed =
            list_installed_from_root(home.path(), apps_dir).expect("must list installed");
        assert_eq!(installed.len(), 1);
        let manifest = &installed[0];
        assert_eq!(manifest.id, "land.naia.evil");

        // In-memory manifest has trusted shell-populated paths/contents
        assert!(manifest
            .html_entry
            .as_ref()
            .unwrap()
            .ends_with("index.html"));
        assert_ne!(manifest.html_entry.as_deref(), Some("C:/evil/index.html"));
        assert_eq!(
            manifest.icon_svg.as_deref(),
            Some("<svg><path d=\"trusted\"/></svg>")
        );

        // IPC serialization roundtrip: keys appear once, trusted values win, evil values absent
        let serialized = serde_json::to_string(manifest).expect("must serialize");
        assert_eq!(
            serialized.matches("\"htmlEntry\"").count(),
            1,
            "htmlEntry must appear exactly once in serialized json"
        );
        assert_eq!(
            serialized.matches("\"iconSvg\"").count(),
            1,
            "iconSvg must appear exactly once in serialized json"
        );
        assert!(!serialized.contains("C:/evil/index.html"));
        assert!(!serialized.contains("onload=alert"));

        let parsed: serde_json::Value = serde_json::from_str(&serialized).expect("must parse json");
        assert_eq!(
            parsed["htmlEntry"],
            manifest.html_entry.as_ref().unwrap().as_str()
        );
        assert_eq!(parsed["iconSvg"], "<svg><path d=\"trusted\"/></svg>");
    }

    #[test]
    fn validate_manifest_warns_on_shell_reserved_keys() {
        // v2 with shell-reserved keys -> Warning only, 0 errors
        let v2_json = r#"{
            "manifest_version": 2,
            "id": "test",
            "name": "Test",
            "htmlEntry": "evil.html",
            "iconSvg": "<svg/>",
            "html_entry": "evil2.html",
            "icon_svg": "<svg2/>"
        }"#;
        let v2_manifest: AppManifest = serde_json::from_str(v2_json).unwrap();
        let v2_issues = validate_manifest(&v2_manifest);
        let v2_warnings: Vec<_> = v2_issues
            .iter()
            .filter(|i| i.level == IssueLevel::Warning)
            .collect();
        let v2_errors: Vec<_> = v2_issues
            .iter()
            .filter(|i| i.level == IssueLevel::Error)
            .collect();
        assert_eq!(
            v2_errors.len(),
            0,
            "shell reserved keys must produce 0 errors"
        );
        assert_eq!(v2_warnings.len(), 4);
        for field in &["htmlEntry", "iconSvg", "html_entry", "icon_svg"] {
            assert!(
                v2_warnings
                    .iter()
                    .any(|w| w.field == *field && w.message.contains("셸이 채우는 값이라 무시됨")),
                "expected warning mentioning '셸이 채우는 값이라 무시됨' for field {}",
                field
            );
        }

        // Legacy with shell-reserved keys -> Warning only, 0 errors
        let legacy_json = r#"{
            "id": "test",
            "name": "Test",
            "htmlEntry": "evil.html"
        }"#;
        let legacy_manifest: AppManifest = serde_json::from_str(legacy_json).unwrap();
        let legacy_issues = validate_manifest(&legacy_manifest);
        let legacy_warnings: Vec<_> = legacy_issues
            .iter()
            .filter(|i| i.level == IssueLevel::Warning)
            .collect();
        let legacy_errors: Vec<_> = legacy_issues
            .iter()
            .filter(|i| i.level == IssueLevel::Error)
            .collect();
        assert_eq!(legacy_errors.len(), 0);
        assert_eq!(legacy_warnings.len(), 1);
        assert_eq!(legacy_warnings[0].field, "htmlEntry");
        assert!(legacy_warnings[0]
            .message
            .contains("셸이 채우는 값이라 무시됨"));
    }
}

/// Result of a successful app install.
#[derive(Debug, Serialize)]
pub struct AppInstallResult {
    pub id: String,
    pub name: String,
    pub path: String,
}

/// Log a recoverable package error without hiding other installed apps.
fn rewrite_installed_app_asset_urls(app_dir: &std::path::Path) {
    if let Err(error) = app_assets::rewrite_installed_app_asset_urls(app_dir) {
        log::warn!("Failed to prepare installed app assets: {error}");
    }
}

/// Derive a app directory name from a Git URL.
/// Strips query/hash, trailing slash and ".git", then takes the last path segment.
fn derive_app_name(source: &str) -> String {
    let s = source.trim();
    // strip query/hash
    let s = s.split(['?', '#']).next().unwrap_or(s);
    // strip trailing slash(es)
    let s = s.trim_end_matches('/');
    // strip .git suffix
    let s = s.trim_end_matches(".git");
    // take last path segment (after last '/' or ':')
    let seg = s.rsplit(['/', ':']).next().unwrap_or(s);
    seg.to_string()
}

/// Install an app from a Git URL into `<selected-adk>/.naia/apps/{app-id}/`.
///
/// Ported from the legacy agent skill `agent/src/skills/built-in/app.ts`
/// (#89, with #257 HTTPS-only hardening) into a shell-side Tauri command —
/// app install is a filesystem operation, not an AI task, so it belongs in
/// the shell rather than being routed through the agent.
///
/// The directory name is the app **id** (read from the cloned `app.json`),
/// NOT the repo name. This keeps `app_remove_installed` (which matches by id)
/// consistent: dir name == id == canonical identifier.
///
/// Security:
/// - HTTPS-only (#257): rejects `http://`, `git@`, `file://`, `data:`, bare paths.
/// - The app id (untrusted, from app.json) is sanitized before becoming a
///   path segment, so the destination cannot escape `~/.naia/apps/`.
/// - `git` is invoked with an arg vector (no shell).
/// - On any failure the temp clone is removed.
#[tauri::command]
pub fn app_install(
    app_handle: tauri::AppHandle,
    source: String,
) -> Result<AppInstallResult, String> {
    let source = source.trim();

    // #257: HTTPS-only.
    if !source.starts_with("https://") {
        return Err(format!(
            "지원하지 않는 소스입니다. HTTPS Git URL만 설치할 수 있습니다\n(예: https://github.com/org/app.git).\n받은 소스: {}",
            source
        ));
    }

    let derived = derive_app_name(source);
    // The derived name is only used for the temp dir; still sanity-check it.
    let derived_ok = !derived.is_empty()
        && derived
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_');
    if !derived_ok {
        return Err(format!(
            "유효하지 않은 저장소 이름이 도출되었습니다: {:?}",
            derived
        ));
    }

    let adk = selected_adk_path()?;
    let apps_root = prepare_apps_root(&adk)?;
    crate::allow_installed_app_asset_scope(&app_handle, &apps_root);
    let canonical_apps_root =
        dunce::canonicalize(&apps_root).map_err(|_| "Access denied".to_string())?;

    // Temp clone target *inside* apps_root (same volume → rename is atomic).
    // Leading-dot prefix keeps it out of the installed-app list while cloning.
    let tmp = apps_root.join(format!(".~install-{}", derived));
    if tmp.exists() {
        let _ = std::fs::remove_dir_all(&tmp); // clear stale partial clone
    }

    // Clone via arg vector — no shell, no shell injection. --depth 1 for speed.
    let mut command = std::process::Command::new("git");
    command.args(["clone", "--depth", "1", source, &tmp.to_string_lossy()]);
    crate::platform::hide_console(&mut command);
    let output = command
        .output()
        .map_err(|e| format!("git 실행 실패 (git이 설치되어 있는지 확인): {}", e))?;

    if !output.status.success() {
        let _ = std::fs::remove_dir_all(&tmp);
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "git clone 실패: {}",
            if stderr.is_empty() {
                "알 수 없는 오류".to_string()
            } else {
                stderr
            }
        ));
    }

    // Verify app.json manifest exists.
    let manifest_path = tmp.join("app.json");
    if !manifest_path.exists() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(
            "설치된 앱에 app.json 매니페스트가 없습니다 — 임시 디렉토리를 제거했습니다."
                .to_string(),
        );
    }

    // Read AppManifest and validate according to v2 / legacy profile rules.
    let manifest_data = std::fs::read_to_string(&manifest_path).map_err(|error| {
        let _ = std::fs::remove_dir_all(&tmp);
        format!("app.json을 읽을 수 없습니다: {}", error)
    })?;
    let manifest: AppManifest = serde_json::from_str(&manifest_data).map_err(|error| {
        let _ = std::fs::remove_dir_all(&tmp);
        format!("app.json 형식이 유효하지 않습니다: {}", error)
    })?;

    let issues = validate_manifest(&manifest);
    let errors: Vec<_> = issues
        .iter()
        .filter(|i| i.level == IssueLevel::Error)
        .collect();
    if !errors.is_empty() {
        let _ = std::fs::remove_dir_all(&tmp);
        let msg = errors
            .iter()
            .map(|e| e.message.as_str())
            .collect::<Vec<_>>()
            .join("; ");
        return Err(format!("앱 매니페스트 유효성 검사 실패: {}", msg));
    }
    for warning in issues.iter().filter(|i| i.level == IssueLevel::Warning) {
        log::warn!("App {} manifest warning: {}", manifest.id, warning.message);
    }

    let id = manifest.id;
    let display_name = if manifest.name.is_empty() {
        derived.clone()
    } else {
        manifest.name
    };

    // The id becomes a path segment — sanitize strictly.
    let id_safe = is_safe_app_id(&id);
    if !id_safe {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!(
            "app.json의 id가 유효하지 않아 설치할 수 없습니다 (영문/숫자/-/_ 만 허용): {:?}",
            id
        ));
    }

    // Final destination keyed by id.
    let dest = apps_root.join(&id);
    if dest.exists() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!(
            "앱 \"{}\" 이(가) 이미 설치되어 있습니다: {}\n먼저 제거한 뒤 다시 설치하세요.",
            id,
            dest.display()
        ));
    }

    // Move temp → final (same volume, so rename is O(1) and atomic).
    std::fs::rename(&tmp, &dest).map_err(|e| {
        let _ = std::fs::remove_dir_all(&tmp);
        format!("설치 마무리 실패 (rename): {}", e)
    })?;

    // Selected ADK boundary sanity check (defense in depth).
    if let Ok(canonical_dest) = dunce::canonicalize(&dest) {
        if canonical_dest.parent() != Some(canonical_apps_root.as_path()) {
            let _ = std::fs::remove_dir_all(&canonical_dest);
            return Err("Access denied".to_string());
        }
    }

    // Absolutize relative asset URLs so the iframe renders (see fn docs).
    rewrite_installed_app_asset_urls(&dest);

    Ok(AppInstallResult {
        id,
        name: display_name,
        path: dest.to_string_lossy().into_owned(),
    })
}

fn validated_store_gateway(raw: &str) -> Result<url::Url, String> {
    let normalized = raw
        .trim()
        .replace("ws://", "http://")
        .replace("wss://", "https://");
    let mut url =
        url::Url::parse(&normalized).map_err(|_| "Invalid App Store Gateway URL".to_string())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Invalid App Store Gateway URL".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Invalid App Store Gateway URL".to_string())?;
    let production = url.scheme() == "https"
        && crate::is_trusted_naia_https_host(url.scheme(), host)
        && url.port_or_known_default() == Some(443);
    let loopback = cfg!(debug_assertions)
        && url.scheme() == "http"
        && matches!(host, "localhost" | "127.0.0.1" | "::1");
    if !production && !loopback {
        return Err("Untrusted App Store Gateway origin".to_string());
    }
    url.set_path("/");
    Ok(url)
}

fn store_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

fn store_entitlement_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(1))
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())
}

fn store_key(app: &tauri::AppHandle) -> Result<String, String> {
    crate::read_secure_naia_credential(app).ok_or_else(|| "Naia login required".to_string())
}

#[tauri::command]
pub fn app_store_has_entitlement(
    app: tauri::AppHandle,
    app_id: String,
    gateway_url: String,
) -> Result<bool, String> {
    validate_store_app_id(&app_id)?;
    let endpoint = validated_store_gateway(&gateway_url)?
        .join(&format!("v1/apps/entitlements/{app_id}"))
        .map_err(|_| "Invalid entitlement endpoint".to_string())?;
    let response = store_entitlement_client()?
        .get(endpoint)
        .bearer_auth(store_key(&app)?)
        .send()
        .map_err(|e| format!("Entitlement check failed: {e}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(false);
    }
    if !response.status().is_success() {
        return Err(format!("Entitlement check failed ({})", response.status()));
    }
    let entitlement: StoreEntitlement = response
        .json()
        .map_err(|e| format!("Invalid entitlement: {e}"))?;
    let granted = entitlement.app_id == app_id && entitlement.status == "GRANTED";
    if granted {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "System clock is before Unix epoch".to_string())?
            .as_millis()
            .min(u64::MAX as u128) as u64;
        let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
        persist_store_entitlement_grant(&app_data, &app_id, now_ms)?;
    }
    Ok(granted)
}

#[tauri::command]
pub fn app_store_last_entitlement_grant(
    app: tauri::AppHandle,
    app_id: String,
) -> Result<Option<u64>, String> {
    validate_store_app_id(&app_id)?;
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "System clock is before Unix epoch".to_string())?
        .as_millis()
        .min(u64::MAX as u128) as u64;
    Ok(load_store_entitlement_grant(&app_data, &app_id, now_ms))
}

fn store_entitlement_grant_path(app_data: &std::path::Path, app_id: &str) -> std::path::PathBuf {
    app_data
        .join(STORE_ENTITLEMENT_GRANTS_DIR)
        .join(format!("{app_id}.json"))
}

fn persist_store_entitlement_grant(
    app_data: &std::path::Path,
    app_id: &str,
    timestamp_ms: u64,
) -> Result<(), String> {
    validate_store_app_id(app_id)?;
    let dir = app_data.join(STORE_ENTITLEMENT_GRANTS_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not save entitlement grant: {e}"))?;
    let path = store_entitlement_grant_path(app_data, app_id);
    let bytes = serde_json::to_vec(&timestamp_ms).map_err(|e| e.to_string())?;
    std::fs::write(path, bytes).map_err(|e| format!("Could not save entitlement grant: {e}"))
}

fn load_store_entitlement_grant(
    app_data: &std::path::Path,
    app_id: &str,
    now_ms: u64,
) -> Option<u64> {
    let timestamp = serde_json::from_slice::<u64>(
        &std::fs::read(store_entitlement_grant_path(app_data, app_id)).ok()?,
    )
    .ok()?;
    (timestamp <= now_ms).then_some(timestamp)
}

#[tauri::command]
pub fn focus_or_create_app_store_window(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    let parsed = url::Url::parse(&url).map_err(|_| "Invalid App Store URL".to_string())?;
    let segments = parsed
        .path()
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if parsed.scheme() != "https"
        || !matches!(
            parsed.host_str(),
            Some("naia.land" | "www.naia.land" | "dev.naia.land" | "naia.nextain.io")
        )
        || segments.len() != 2
        || segments[1] != "apps"
    {
        return Err("Untrusted App Store URL".to_string());
    }
    if let Some(window) = app.get_webview_window("app-store") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let external = WebviewUrl::External(parsed);
    WebviewWindowBuilder::new(&app, "app-store", external)
        .title("Naia App Store")
        .inner_size(1180.0, 820.0)
        .min_inner_size(760.0, 600.0)
        .center()
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn validate_store_app_id(app_id: &str) -> Result<(), String> {
    let id_ok = !app_id.is_empty()
        && app_id != "."
        && app_id != ".."
        && !app_id.starts_with('.')
        && ![".~install-", ".store-install-", ".store-backup-"]
            .iter()
            .any(|prefix| app_id.starts_with(prefix))
        && app_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !app_id.contains("..");
    if id_ok {
        Ok(())
    } else {
        Err("Invalid app id".to_string())
    }
}

fn compare_store_versions(installed: Option<&str>, incoming: Option<&str>) -> Result<(), String> {
    let (Some(installed), Some(incoming)) = (installed, incoming) else {
        if installed.is_some() || incoming.is_some() {
            log::warn!("Missing app version; allowing update for compatibility or repair");
        }
        return Ok(());
    };
    let (Ok(installed), Ok(incoming)) = (
        semver::Version::parse(installed.trim_start_matches('v')),
        semver::Version::parse(incoming.trim_start_matches('v')),
    ) else {
        log::warn!("Store version is not semver; allowing update comparison fallback");
        return Ok(());
    };
    // Same-version reinstall repairs a damaged install; only a downgrade risks silently replacing newer app state.
    if incoming < installed {
        return Err("A lower app version cannot replace the installed version".to_string());
    }
    Ok(())
}

fn preserve_unbundled_app_files(
    old: &std::path::Path,
    staged: &std::path::Path,
) -> Result<(), String> {
    fn copy_tree(old: &std::path::Path, staged: &std::path::Path) -> Result<(), String> {
        std::fs::create_dir_all(staged).map_err(|e| e.to_string())?;
        for entry in std::fs::read_dir(old).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let source = entry.path();
            let target = staged.join(entry.file_name());
            let file_type = entry.file_type().map_err(|e| e.to_string())?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                copy_tree(&source, &target)?;
            } else if file_type.is_file() {
                std::fs::copy(&source, &target).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    fn copy_missing(old: &std::path::Path, staged: &std::path::Path) -> Result<(), String> {
        for entry in std::fs::read_dir(old).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let source = entry.path();
            let target = staged.join(entry.file_name());
            let file_type = entry.file_type().map_err(|e| e.to_string())?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                if target.exists() {
                    if target.is_dir() {
                        copy_missing(&source, &target)?;
                    }
                } else {
                    copy_tree(&source, &target)?;
                }
            } else if file_type.is_file() && !target.exists() {
                if target.is_dir() {
                    std::fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
                } else if target.exists() {
                    std::fs::remove_file(&target).map_err(|e| e.to_string())?;
                }
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::copy(&source, &target).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
    copy_missing(old, staged)
}

fn lock_store_app(apps_root: &std::path::Path, app_id: &str) -> Result<std::fs::File, String> {
    let path = apps_root.join(format!(".store-lock-{}", encode_hex(app_id.as_bytes())));
    lock_store_path(&path)
}

fn lock_store_global(apps_root: &std::path::Path) -> Result<std::fs::File, String> {
    lock_store_path(&apps_root.join(".store-lock-global"))
}

fn lock_store_path(path: &std::path::Path) -> Result<std::fs::File, String> {
    use fs2::FileExt;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.lock_exclusive().map_err(|e| e.to_string())?;
    Ok(file)
}

fn recover_store_artifacts(apps_root: &std::path::Path) -> Result<(), String> {
    let entries = std::fs::read_dir(apps_root).map_err(|e| e.to_string())?;
    for item in entries {
        let item = match item {
            Ok(item) => item,
            Err(e) => {
                log::warn!("Skipping unreadable store artifact: {e}");
                continue;
            }
        };
        let name = item.file_name().to_string_lossy().into_owned();
        let path = item.path();
        let kind = match item.file_type() {
            Ok(kind) => kind,
            Err(e) => {
                log::warn!("Skipping store artifact {}: {e}", path.display());
                continue;
            }
        };
        if name.starts_with(".store-install-") {
            if kind.is_dir() && !kind.is_symlink() {
                if let Err(e) = std::fs::remove_dir_all(&path) {
                    log::warn!("Could not remove stale install {}: {e}", path.display());
                }
            }
        } else if let Some(rest) = name.strip_prefix(".store-backup-") {
            if !kind.is_dir() || kind.is_symlink() {
                log::warn!("Skipping unsafe backup {}", path.display());
                continue;
            }
            let encoded = rest
                .split_once('-')
                .and_then(|(encoded_id, _)| decode_hex(encoded_id))
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .filter(|candidate| is_safe_app_id(candidate));
            // Accept the pre-fix `.store-backup-{app-id}-{temp-suffix}` form too.
            let app_id = encoded.or_else(|| {
                rest.rsplit_once('-')
                    .map(|(legacy_id, _)| legacy_id.to_string())
            });
            let Some(app_id) = app_id.filter(|candidate| is_safe_app_id(candidate)) else {
                log::warn!("Skipping malformed backup {}", path.display());
                continue;
            };
            let destination = apps_root.join(&app_id);
            let destination_is_fine = std::fs::symlink_metadata(&destination)
                .ok()
                .filter(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
                .and_then(|_| manifest_id(&destination).ok())
                .is_some_and(|id| id == app_id && destination.join("index.html").is_file());
            if !destination_is_fine {
                if destination.exists() {
                    let _ = std::fs::remove_dir_all(&destination);
                }
                if let Err(e) = std::fs::rename(&path, &destination) {
                    log::warn!("Could not restore backup {}: {e}", path.display());
                }
            } else if let Err(e) = std::fs::remove_dir_all(&path) {
                log::warn!("Could not remove obsolete backup {}: {e}", path.display());
            }
        }
    }
    Ok(())
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn decode_hex(value: &str) -> Option<Vec<u8>> {
    if value.len() % 2 != 0 {
        return None;
    }
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).ok())
        .collect()
}

fn permission_expansions(old: &AppManifest, new: &AppManifest) -> Vec<String> {
    let mut expanded = Vec::new();
    let mut compare = |label: &str, old: &[String], new: &[String]| {
        for item in new {
            if !old.contains(item) {
                expanded.push(format!("{label}: {item}"));
            }
        }
    };
    compare(
        "permissions",
        old.permissions.as_deref().unwrap_or_default(),
        new.permissions.as_deref().unwrap_or_default(),
    );
    compare(
        "host_permissions",
        old.host_permissions.as_deref().unwrap_or_default(),
        new.host_permissions.as_deref().unwrap_or_default(),
    );
    compare(
        "optional_permissions",
        old.optional_permissions.as_deref().unwrap_or_default(),
        new.optional_permissions.as_deref().unwrap_or_default(),
    );
    let old_tools = old.tools.as_deref().unwrap_or_default();
    for tool in new.tools.as_deref().unwrap_or_default() {
        match old_tools
            .iter()
            .find(|candidate| candidate.name == tool.name)
        {
            None => expanded.push(format!(
                "tools: {} (tier {}, exported {})",
                tool.name, tool.tier, tool.exported
            )),
            Some(previous) => {
                if tool.tier < previous.tier {
                    expanded.push(format!(
                        "tools: {} tier {} → {}",
                        tool.name, previous.tier, tool.tier
                    ));
                }
                if tool.exported && !previous.exported {
                    expanded.push(format!("tools: {} exported", tool.name));
                }
            }
        }
    }
    expanded
}

fn replace_store_install(
    apps_root: &std::path::Path,
    staged: &std::path::Path,
    app_id: &str,
    installed_version: Option<&str>,
    incoming_version: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    replace_store_install_with(
        apps_root,
        staged,
        app_id,
        installed_version,
        incoming_version,
        |from, to| std::fs::rename(from, to),
    )
}

fn replace_store_install_with(
    apps_root: &std::path::Path,
    staged: &std::path::Path,
    app_id: &str,
    installed_version: Option<&str>,
    incoming_version: Option<&str>,
    commit_staged: impl FnOnce(&std::path::Path, &std::path::Path) -> std::io::Result<()>,
) -> Result<std::path::PathBuf, String> {
    compare_store_versions(installed_version, incoming_version)?;
    if !staged.is_dir() {
        return Err("Staged app directory is missing".to_string());
    }
    let destination = apps_root.join(app_id);
    if !destination.exists() {
        commit_staged(staged, &destination).map_err(|e| format!("Install finalize failed: {e}"))?;
        return Ok(destination);
    }
    let metadata = std::fs::symlink_metadata(&destination).map_err(|e| e.to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Installed app path is not a safe directory".to_string());
    }

    preserve_unbundled_app_files(&destination, staged)?;
    let backup_dir = tempfile::Builder::new()
        .prefix(&format!(".store-backup-{}-", encode_hex(app_id.as_bytes())))
        .tempdir_in(apps_root)
        .map_err(|e| e.to_string())?;
    let backup = backup_dir.keep();
    std::fs::remove_dir(&backup).map_err(|e| e.to_string())?;
    std::fs::rename(&destination, &backup).map_err(|e| e.to_string())?;
    if let Err(install_error) = commit_staged(staged, &destination) {
        return match std::fs::rename(&backup, &destination) {
            Ok(()) => Err(format!(
                "Install finalize failed; previous version restored: {install_error}"
            )),
            Err(restore_error) => Err(format!(
                "Install finalize failed ({install_error}); previous version restore failed ({restore_error})"
            )),
        };
    }
    if let Err(error) = std::fs::remove_dir_all(&backup) {
        log::warn!(
            "Updated app {} but could not remove backup {}: {}",
            app_id,
            backup.display(),
            error
        );
    }
    Ok(destination)
}

/// Install a reviewed Store ZIP only after the Gateway confirms ownership.
#[tauri::command]
pub fn app_install_store(
    app: tauri::AppHandle,
    app_id: String,
    gateway_url: String,
    allow_permission_expansion: Option<bool>,
) -> Result<AppInstallResult, String> {
    validate_store_app_id(&app_id)?;
    let adk = selected_adk_path()?;
    let apps_root = prepare_apps_root(&adk)?;
    let base = validated_store_gateway(&gateway_url)?;
    let credential = store_key(&app)?;
    let mut fetcher = HttpStoreFetcher {
        client: store_client()?,
        base,
        credential,
    };
    crate::allow_installed_app_asset_scope(&app, &apps_root);
    let (name, destination) = install_store_from_fetcher(
        &mut fetcher,
        &apps_root,
        &app_id,
        resolve_signing_public_key(option_env!("NAIA_APP_SIGNING_PUBLIC_KEY")),
        allow_permission_expansion.unwrap_or(false),
    )?;
    // Absolutize relative asset URLs so the iframe renders (see fn docs).
    rewrite_installed_app_asset_urls(&destination);
    use tauri::Emitter;
    let _ = app.emit("installed-apps-changed", ());
    Ok(AppInstallResult {
        id: app_id,
        name,
        path: destination.to_string_lossy().into_owned(),
    })
}
