use base64::Engine as _;
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashSet, VecDeque};
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const MAX_NVA_DOWNLOAD_BYTES: usize = 200 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES: usize = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_NVA_UNCOMPRESSED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_NVA_ENTRIES: usize = 4096;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum StudioNvaEnvironment {
    Production,
    Development,
}

impl StudioNvaEnvironment {
    fn gateway_base(self) -> &'static str {
        match self {
            Self::Production => "https://api.nextain.io",
            Self::Development => "https://api-dev.naia.land",
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StudioNvaApplyRequest {
    pub request_id: String,
    pub avatar_id: String,
    pub environment: StudioNvaEnvironment,
}

#[derive(Debug, Deserialize)]
struct StudioAvatarDetail {
    avatar: Option<StudioAvatarItem>,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StudioAvatarItem {
    name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StudioNvaAvatarPreview {
    pub name: String,
    pub thumbnail_data_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StudioNvaDownload {
    pub path: String,
    pub manifest_json: String,
    pub sha256: String,
}

fn is_valid_avatar_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'_' | b'-'))
        })
}

pub(crate) fn parse_deep_link(value: &str) -> Option<(String, StudioNvaEnvironment)> {
    let url = url::Url::parse(value).ok()?;
    if url.scheme() != "naia"
        || url.host_str() != Some("studio-nva-apply")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !url.path().is_empty()
        || url.fragment().is_some()
    {
        return None;
    }

    let mut avatar_id = None;
    let mut environment = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "avatar_id" if avatar_id.is_none() && is_valid_avatar_id(&value) => {
                avatar_id = Some(value.into_owned());
            }
            "env" if environment.is_none() => {
                environment = match value.as_ref() {
                    "production" => Some(StudioNvaEnvironment::Production),
                    "development" => Some(StudioNvaEnvironment::Development),
                    _ => return None,
                };
            }
            _ => return None,
        }
    }
    Some((avatar_id?, environment?))
}

static PENDING_REQUESTS: OnceLock<Mutex<VecDeque<StudioNvaApplyRequest>>> = OnceLock::new();
static REQUEST_SEQUENCE: OnceLock<Mutex<u64>> = OnceLock::new();

fn pending_requests() -> &'static Mutex<VecDeque<StudioNvaApplyRequest>> {
    PENDING_REQUESTS.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn next_request_id() -> String {
    let sequence = REQUEST_SEQUENCE.get_or_init(|| Mutex::new(0));
    let mut sequence = sequence
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *sequence = sequence.saturating_add(1);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("studio-{timestamp}-{}", *sequence)
}

const MAX_PENDING_REQUESTS: usize = 16;

/// Pushes a request unless the same avatar/environment pair is already waiting.
/// Returns the new request, or `None` when the link was a duplicate. The oldest
/// requests are dropped (and counted) when the queue is full.
fn push_pending_request(
    pending: &mut VecDeque<StudioNvaApplyRequest>,
    request_id: String,
    avatar_id: String,
    environment: StudioNvaEnvironment,
) -> (Option<StudioNvaApplyRequest>, usize) {
    if pending
        .iter()
        .any(|existing| existing.avatar_id == avatar_id && existing.environment == environment)
    {
        return (None, 0);
    }
    let mut dropped = 0;
    while pending.len() >= MAX_PENDING_REQUESTS {
        pending.pop_front();
        dropped += 1;
    }
    let request = StudioNvaApplyRequest {
        request_id,
        avatar_id,
        environment,
    };
    pending.push_back(request.clone());
    (Some(request), dropped)
}

pub(crate) fn enqueue_request(
    app: &AppHandle,
    avatar_id: String,
    environment: StudioNvaEnvironment,
) {
    let (request, dropped) = {
        let mut pending = pending_requests()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        push_pending_request(&mut pending, next_request_id(), avatar_id, environment)
    };
    if dropped > 0 {
        crate::log_both(&format!(
            "[Naia] Studio NVA apply queue full: dropped {dropped} oldest request(s)"
        ));
    }
    match request {
        Some(request) => {
            let _ = app.emit("studio_nva_apply_requested", request);
        }
        None => {
            crate::log_both(
                "[Naia] Studio NVA apply deep link ignored: same request already pending",
            );
        }
    }
}

#[tauri::command]
pub(crate) fn studio_nva_apply_pending() -> Vec<StudioNvaApplyRequest> {
    pending_requests()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .cloned()
        .collect()
}

#[tauri::command]
pub(crate) fn studio_nva_apply_ack(request_id: String) {
    let mut pending = pending_requests()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    pending.retain(|request| request.request_id != request_id);
}

fn validated_args(
    avatar_id: &str,
    environment: &str,
) -> Result<(String, StudioNvaEnvironment), String> {
    if !is_valid_avatar_id(avatar_id) {
        return Err("invalid_avatar_id".to_string());
    }
    let environment = match environment {
        "production" => StudioNvaEnvironment::Production,
        "development" => StudioNvaEnvironment::Development,
        _ => return Err("invalid_environment".to_string()),
    };
    Ok((avatar_id.to_string(), environment))
}

fn auth_key(app: &AppHandle) -> Result<zeroize::Zeroizing<String>, String> {
    crate::read_secure_naia_credential(app)
        .map(zeroize::Zeroizing::new)
        .ok_or_else(|| "naia_login_required".to_string())
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "gateway_client_unavailable".to_string())
}

async fn read_bounded_response(
    response: reqwest::Response,
    max_bytes: usize,
    too_large_error: &'static str,
    read_error: &'static str,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(too_large_error.to_string());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream
        .try_next()
        .await
        .map_err(|_| read_error.to_string())?
    {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(too_large_error.to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[tauri::command]
pub(crate) async fn studio_nva_apply_preview(
    app: AppHandle,
    avatar_id: String,
    environment: String,
) -> Result<StudioNvaAvatarPreview, String> {
    let (avatar_id, environment) = validated_args(&avatar_id, &environment)?;
    let key = auth_key(&app)?;
    let base = environment.gateway_base();
    let client = build_client()?;
    let detail_url = format!("{base}/v1/studio/avatars/{avatar_id}");
    let detail_response = client
        .get(detail_url)
        .bearer_auth(key.as_str())
        .send()
        .await
        .map_err(|_| "avatar_preview_unavailable".to_string())?;
    if !detail_response.status().is_success() {
        return Err(format!(
            "avatar_preview_http_{}",
            detail_response.status().as_u16()
        ));
    }
    let detail_bytes = read_bounded_response(
        detail_response,
        1024 * 1024,
        "avatar_preview_invalid",
        "avatar_preview_unavailable",
    )
    .await?;
    let detail: StudioAvatarDetail =
        serde_json::from_slice(&detail_bytes).map_err(|_| "avatar_preview_invalid".to_string())?;
    let avatar_name = detail
        .avatar
        .and_then(|avatar| avatar.name)
        .or(detail.name)
        .filter(|name| !name.trim().is_empty() && name.len() <= 256)
        .ok_or_else(|| "avatar_name_unavailable".to_string())?;

    let thumbnail_url = format!("{base}/v1/studio/avatars/{avatar_id}/thumbnail");
    let thumbnail_response = client
        .get(thumbnail_url)
        .bearer_auth(key.as_str())
        .send()
        .await
        .map_err(|_| "avatar_preview_unavailable".to_string())?;
    if !thumbnail_response.status().is_success() {
        return Err(format!(
            "avatar_preview_http_{}",
            thumbnail_response.status().as_u16()
        ));
    }
    let content_type = thumbnail_response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/png")
        .split(';')
        .next()
        .unwrap_or("")
        .to_string();
    if !matches!(
        content_type.as_str(),
        "image/png" | "image/jpeg" | "image/webp"
    ) {
        return Err("avatar_thumbnail_invalid".to_string());
    }
    let thumbnail = read_bounded_response(
        thumbnail_response,
        MAX_THUMBNAIL_BYTES,
        "avatar_thumbnail_too_large",
        "avatar_preview_unavailable",
    )
    .await?;
    if thumbnail.is_empty() {
        return Err("avatar_thumbnail_too_large".to_string());
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(thumbnail);
    Ok(StudioNvaAvatarPreview {
        name: avatar_name,
        thumbnail_data_url: format!("data:{content_type};base64,{encoded}"),
    })
}

#[derive(Clone, Copy, Debug)]
struct ArchiveLimits {
    max_entries: usize,
    max_uncompressed_bytes: u64,
    max_manifest_bytes: u64,
}

const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = ArchiveLimits {
    max_entries: MAX_NVA_ENTRIES,
    max_uncompressed_bytes: MAX_NVA_UNCOMPRESSED_BYTES,
    max_manifest_bytes: MAX_MANIFEST_BYTES,
};

fn is_unsafe_entry_name(normalized: &str) -> bool {
    let path_name = normalized.trim_end_matches('/');
    let components = path_name.split('/').collect::<Vec<_>>();
    let has_drive_prefix = components.first().is_some_and(|part| {
        let bytes = part.as_bytes();
        bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
    });
    normalized.starts_with('/')
        || std::path::Path::new(normalized).is_absolute()
        || has_drive_prefix
        || components.iter().any(|part| {
            part.is_empty() || *part == "." || *part == ".." || part.chars().any(char::is_control)
        })
}

fn inspect_nva_archive<R: Read + Seek>(reader: R, limits: ArchiveLimits) -> Result<String, String> {
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|_| "nva_archive_invalid".to_string())?;
    if archive.len() == 0 || archive.len() > limits.max_entries {
        return Err("nva_archive_invalid".to_string());
    }
    let mut expanded = 0_u64;
    let mut names = HashSet::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|_| "nva_archive_invalid".to_string())?;
        let normalized = entry.name().replace('\\', "/");
        let path_name = normalized.trim_end_matches('/');
        if is_unsafe_entry_name(&normalized) || !names.insert(path_name.to_ascii_lowercase()) {
            return Err("nva_archive_invalid".to_string());
        }
        expanded = expanded.saturating_add(entry.size());
        if expanded > limits.max_uncompressed_bytes {
            return Err("nva_archive_too_large".to_string());
        }
    }
    let manifest = archive
        .by_name("manifest.json")
        .map_err(|_| "nva_manifest_missing".to_string())?;
    if manifest.size() == 0 || manifest.size() > limits.max_manifest_bytes {
        return Err("nva_manifest_invalid".to_string());
    }
    let mut content = Vec::with_capacity(manifest.size() as usize);
    // Bound the actual read too: the declared size in the header is not trusted.
    manifest
        .take(limits.max_manifest_bytes + 1)
        .read_to_end(&mut content)
        .map_err(|_| "nva_manifest_invalid".to_string())?;
    if content.len() as u64 > limits.max_manifest_bytes {
        return Err("nva_manifest_invalid".to_string());
    }
    String::from_utf8(content).map_err(|_| "nva_manifest_invalid".to_string())
}

/// Reads the integrity headers. The SHA-256 header is mandatory; the size
/// header is optional but must parse when present.
fn parse_integrity_headers(
    sha_header: Option<&str>,
    size_header: Option<&str>,
) -> Result<(String, Option<u64>), String> {
    let expected_sha = sha_header
        .map(str::to_ascii_lowercase)
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| "nva_integrity_metadata_missing".to_string())?;
    let expected_size = match size_header {
        None => None,
        Some(value) => Some(
            value
                .trim()
                .parse::<u64>()
                .map_err(|_| "nva_integrity_metadata_missing".to_string())?,
        ),
    };
    Ok((expected_sha, expected_size))
}

fn verify_integrity(
    expected_sha: &str,
    expected_size: Option<u64>,
    actual_sha: &str,
    actual_size: u64,
) -> Result<(), String> {
    if expected_size.is_some_and(|size| size != actual_size) {
        return Err("nva_integrity_size_mismatch".to_string());
    }
    if actual_sha != expected_sha {
        return Err("nva_integrity_sha_mismatch".to_string());
    }
    Ok(())
}

/// Streams the body into `sink`, hashing as it goes, without holding the whole
/// archive in memory. Stops as soon as the running total passes `max_bytes`.
async fn stream_to_sink_hashed<S, B, E, W>(
    mut stream: S,
    sink: &mut W,
    max_bytes: u64,
) -> Result<(u64, String), String>
where
    S: futures_util::Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
    W: Write,
{
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    while let Some(chunk) = stream
        .try_next()
        .await
        .map_err(|_| "nva_download_unavailable".to_string())?
    {
        let chunk = chunk.as_ref();
        total = total.saturating_add(chunk.len() as u64);
        if total > max_bytes {
            return Err("nva_download_too_large".to_string());
        }
        hasher.update(chunk);
        sink.write_all(chunk)
            .map_err(|_| "nva_download_storage_unavailable".to_string())?;
    }
    sink.flush()
        .map_err(|_| "nva_download_storage_unavailable".to_string())?;
    Ok((total, format!("{:x}", hasher.finalize())))
}

#[tauri::command]
pub(crate) async fn studio_nva_apply_download(
    app: AppHandle,
    avatar_id: String,
    environment: String,
) -> Result<StudioNvaDownload, String> {
    let (avatar_id, environment) = validated_args(&avatar_id, &environment)?;
    let key = auth_key(&app)?;
    let client = build_client()?;
    let url = format!(
        "{}/v1/studio/avatars/{avatar_id}/download?inline=1",
        environment.gateway_base()
    );
    let response = client
        .get(url)
        .bearer_auth(key.as_str())
        .header(reqwest::header::ACCEPT, "application/zip")
        .send()
        .await
        .map_err(|_| "nva_download_unavailable".to_string())?;
    if !response.status().is_success() {
        return Err(format!("nva_download_http_{}", response.status().as_u16()));
    }
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
    };
    let (expected_sha, expected_size) = parse_integrity_headers(
        header("x-nva-sha256").as_deref(),
        header("x-nva-size").as_deref(),
    )?;
    let max_bytes = MAX_NVA_DOWNLOAD_BYTES as u64;
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes)
        || expected_size.is_some_and(|size| size > max_bytes)
    {
        return Err("nva_download_too_large".to_string());
    }

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|_| "nva_download_storage_unavailable".to_string())?;
    std::fs::create_dir_all(&cache_dir)
        .map_err(|_| "nva_download_storage_unavailable".to_string())?;
    // The temp file is removed automatically on every early return below; it is
    // kept only after size, hash and archive checks all pass.
    let mut staged = tempfile::Builder::new()
        .prefix("naia-studio-")
        .suffix(".nva")
        .tempfile_in(&cache_dir)
        .map_err(|_| "nva_download_storage_unavailable".to_string())?;
    let (actual_size, actual_sha) = {
        let mut writer = std::io::BufWriter::new(staged.as_file_mut());
        stream_to_sink_hashed(response.bytes_stream(), &mut writer, max_bytes).await?
    };
    verify_integrity(&expected_sha, expected_size, &actual_sha, actual_size)?;
    let file = staged.as_file_mut();
    file.seek(SeekFrom::Start(0))
        .map_err(|_| "nva_download_storage_unavailable".to_string())?;
    let manifest_json =
        inspect_nva_archive(std::io::BufReader::new(&*file), DEFAULT_ARCHIVE_LIMITS)?;
    let (_, path) = staged
        .keep()
        .map_err(|_| "nva_download_storage_unavailable".to_string())?;
    Ok(StudioNvaDownload {
        path: path.to_string_lossy().into_owned(),
        manifest_json,
        sha256: actual_sha,
    })
}

#[tauri::command]
pub(crate) fn studio_nva_apply_cleanup(app: AppHandle, path: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(path);
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|_| "nva_cleanup_failed".to_string())?;
    let canonical_cache =
        dunce::canonicalize(cache_dir).map_err(|_| "nva_cleanup_failed".to_string())?;
    let canonical_path =
        dunce::canonicalize(&path).map_err(|_| "nva_cleanup_failed".to_string())?;
    let filename = canonical_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if !canonical_path.starts_with(canonical_cache)
        || !filename.starts_with("naia-studio-")
        || !filename.ends_with(".nva")
    {
        return Err("nva_cleanup_path_rejected".to_string());
    }
    std::fs::remove_file(canonical_path).map_err(|_| "nva_cleanup_failed".to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        inspect_nva_archive, parse_deep_link, parse_integrity_headers, push_pending_request,
        stream_to_sink_hashed, verify_integrity, ArchiveLimits, StudioNvaEnvironment,
        DEFAULT_ARCHIVE_LIMITS, MAX_PENDING_REQUESTS,
    };
    use sha2::{Digest, Sha256};
    use std::collections::VecDeque;
    use std::io::{Cursor, Write};

    fn zip_with(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, body) in entries {
            writer.start_file(*name, options).expect("start entry");
            writer.write_all(body).expect("write entry");
        }
        writer.finish().expect("finish zip").into_inner()
    }

    const MANIFEST: &[u8] = br#"{"format":"nva"}"#;

    #[test]
    fn archive_with_manifest_passes_inspection() {
        let bytes = zip_with(&[("manifest.json", MANIFEST), ("frames/0001.png", b"png")]);
        assert_eq!(
            inspect_nva_archive(Cursor::new(bytes), DEFAULT_ARCHIVE_LIMITS).as_deref(),
            Ok(r#"{"format":"nva"}"#)
        );
    }

    #[test]
    fn archive_path_escape_is_rejected() {
        for bad in [
            "../evil.txt",
            "frames/../../evil.txt",
            "/etc/evil.txt",
            "C:/Windows/evil.txt",
            "..\\evil.txt",
            "frames//evil.txt",
            "./manifest2.json",
        ] {
            let bytes = zip_with(&[("manifest.json", MANIFEST), (bad, b"x")]);
            assert_eq!(
                inspect_nva_archive(Cursor::new(bytes), DEFAULT_ARCHIVE_LIMITS),
                Err("nva_archive_invalid".to_string()),
                "must reject {bad:?}"
            );
        }
    }

    #[test]
    fn archive_case_insensitive_duplicate_is_rejected() {
        let bytes = zip_with(&[
            ("manifest.json", MANIFEST),
            ("A.png", b"1"),
            ("a.png", b"2"),
        ]);
        assert_eq!(
            inspect_nva_archive(Cursor::new(bytes), DEFAULT_ARCHIVE_LIMITS),
            Err("nva_archive_invalid".to_string())
        );
    }

    #[test]
    fn archive_over_uncompressed_limit_is_rejected() {
        let limits = ArchiveLimits {
            max_uncompressed_bytes: 64,
            ..DEFAULT_ARCHIVE_LIMITS
        };
        let big = vec![b'x'; 65];
        let bytes = zip_with(&[("manifest.json", MANIFEST), ("frames/big.bin", &big)]);
        assert_eq!(
            inspect_nva_archive(Cursor::new(bytes), limits),
            Err("nva_archive_too_large".to_string())
        );
    }

    #[test]
    fn archive_with_too_many_entries_is_rejected() {
        let limits = ArchiveLimits {
            max_entries: 2,
            ..DEFAULT_ARCHIVE_LIMITS
        };
        let bytes = zip_with(&[("manifest.json", MANIFEST), ("a", b"1"), ("b", b"2")]);
        assert_eq!(
            inspect_nva_archive(Cursor::new(bytes), limits),
            Err("nva_archive_invalid".to_string())
        );
    }

    #[test]
    fn archive_manifest_missing_oversized_or_not_utf8_is_rejected() {
        let missing = zip_with(&[("frames/0001.png", b"png")]);
        assert_eq!(
            inspect_nva_archive(Cursor::new(missing), DEFAULT_ARCHIVE_LIMITS),
            Err("nva_manifest_missing".to_string())
        );
        let limits = ArchiveLimits {
            max_manifest_bytes: 4,
            ..DEFAULT_ARCHIVE_LIMITS
        };
        let oversized = zip_with(&[("manifest.json", MANIFEST)]);
        assert_eq!(
            inspect_nva_archive(Cursor::new(oversized), limits),
            Err("nva_manifest_invalid".to_string())
        );
        let not_utf8 = zip_with(&[("manifest.json", &[0xff, 0xfe, 0xfd])]);
        assert_eq!(
            inspect_nva_archive(Cursor::new(not_utf8), DEFAULT_ARCHIVE_LIMITS),
            Err("nva_manifest_invalid".to_string())
        );
        assert_eq!(
            inspect_nva_archive(Cursor::new(b"not a zip".to_vec()), DEFAULT_ARCHIVE_LIMITS),
            Err("nva_archive_invalid".to_string())
        );
    }

    fn chunks(
        parts: &[&'static [u8]],
    ) -> impl futures_util::Stream<Item = Result<&'static [u8], ()>> + Unpin {
        futures_util::stream::iter(parts.iter().map(|part| Ok(*part)).collect::<Vec<_>>())
    }

    #[tokio::test]
    async fn streamed_download_hashes_without_buffering() {
        let mut sink = Vec::new();
        let (size, sha) = stream_to_sink_hashed(chunks(&[b"hello ", b"world"]), &mut sink, 64)
            .await
            .expect("stream within limit");
        assert_eq!(size, 11);
        assert_eq!(sink, b"hello world");
        assert_eq!(sha, format!("{:x}", Sha256::digest(b"hello world")));
    }

    #[tokio::test]
    async fn streamed_download_over_size_limit_is_rejected() {
        let mut sink = Vec::new();
        let result =
            stream_to_sink_hashed(chunks(&[b"12345", b"67890", b"x"]), &mut sink, 10).await;
        assert_eq!(result, Err("nva_download_too_large".to_string()));
        assert!(
            sink.len() <= 10,
            "must stop writing before passing the limit"
        );
    }

    #[tokio::test]
    async fn streamed_download_read_error_is_reported() {
        let stream = futures_util::stream::iter(vec![Ok(&b"part"[..]), Err(())]);
        let mut sink = Vec::new();
        assert_eq!(
            stream_to_sink_hashed(stream, &mut sink, 64).await,
            Err("nva_download_unavailable".to_string())
        );
    }

    #[test]
    fn integrity_headers_are_required_and_validated() {
        let sha = "A".repeat(64);
        assert_eq!(
            parse_integrity_headers(Some(&sha), Some("42")),
            Ok(("a".repeat(64), Some(42)))
        );
        assert_eq!(
            parse_integrity_headers(Some(&sha), None),
            Ok(("a".repeat(64), None))
        );
        for bad in [None, Some(""), Some("abc"), Some(&*"g".repeat(64))] {
            assert_eq!(
                parse_integrity_headers(bad, None),
                Err("nva_integrity_metadata_missing".to_string()),
                "must reject sha header {bad:?}"
            );
        }
        assert_eq!(
            parse_integrity_headers(Some(&sha), Some("-1")),
            Err("nva_integrity_metadata_missing".to_string())
        );
    }

    #[test]
    fn integrity_hash_or_size_mismatch_is_rejected() {
        let actual = format!("{:x}", Sha256::digest(b"archive"));
        assert_eq!(verify_integrity(&actual, Some(7), &actual, 7), Ok(()));
        assert_eq!(verify_integrity(&actual, None, &actual, 7), Ok(()));
        assert_eq!(
            verify_integrity(&"0".repeat(64), None, &actual, 7),
            Err("nva_integrity_sha_mismatch".to_string())
        );
        assert_eq!(
            verify_integrity(&actual, Some(8), &actual, 7),
            Err("nva_integrity_size_mismatch".to_string())
        );
    }

    #[test]
    fn same_link_twice_is_queued_once() {
        let mut pending = VecDeque::new();
        let (first, _) = push_pending_request(
            &mut pending,
            "r1".into(),
            "av_1".into(),
            StudioNvaEnvironment::Production,
        );
        assert!(first.is_some());
        let (second, _) = push_pending_request(
            &mut pending,
            "r2".into(),
            "av_1".into(),
            StudioNvaEnvironment::Production,
        );
        assert!(second.is_none());
        let (other_env, _) = push_pending_request(
            &mut pending,
            "r3".into(),
            "av_1".into(),
            StudioNvaEnvironment::Development,
        );
        assert!(other_env.is_some());
        assert_eq!(pending.len(), 2);
    }

    #[test]
    fn full_queue_drops_oldest_and_reports_it() {
        let mut pending = VecDeque::new();
        for index in 0..MAX_PENDING_REQUESTS {
            push_pending_request(
                &mut pending,
                format!("r{index}"),
                format!("av{index}"),
                StudioNvaEnvironment::Production,
            );
        }
        let (request, dropped) = push_pending_request(
            &mut pending,
            "new".into(),
            "avnew".into(),
            StudioNvaEnvironment::Production,
        );
        assert!(request.is_some());
        assert_eq!(dropped, 1);
        assert_eq!(pending.len(), MAX_PENDING_REQUESTS);
        assert_eq!(pending.front().map(|r| r.request_id.as_str()), Some("r1"));
    }

    #[test]
    fn parses_valid_studio_nva_apply_link() {
        assert_eq!(
            parse_deep_link("naia://studio-nva-apply?avatar_id=av_123&env=development"),
            Some(("av_123".to_string(), StudioNvaEnvironment::Development))
        );
    }

    #[test]
    fn rejects_links_outside_the_registered_host() {
        assert_eq!(
            parse_deep_link("naia://evil/studio-nva-apply?avatar_id=av_123&env=production"),
            None
        );
    }

    #[test]
    fn rejects_secret_parameters_and_duplicates() {
        assert_eq!(
            parse_deep_link("naia://studio-nva-apply?avatar_id=av_123&env=production&token=secret"),
            None
        );
        assert_eq!(
            parse_deep_link(
                "naia://studio-nva-apply?avatar_id=av_123&avatar_id=av_456&env=production"
            ),
            None
        );
    }

    #[test]
    fn rejects_malformed_avatar_ids() {
        for id in ["", "../avatar", "av_123?token", "a".repeat(129).as_str()] {
            let link = format!("naia://studio-nva-apply?avatar_id={id}&env=production");
            assert_eq!(parse_deep_link(&link), None, "must reject {id:?}");
        }
    }
}
