use base64::Engine as _;
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashSet, VecDeque};
use std::io::{Read, Write};
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

pub(crate) fn enqueue_request(
    app: &AppHandle,
    avatar_id: String,
    environment: StudioNvaEnvironment,
) {
    let request = StudioNvaApplyRequest {
        request_id: next_request_id(),
        avatar_id,
        environment,
    };
    {
        let mut pending = pending_requests()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while pending.len() >= 16 {
            pending.pop_front();
        }
        pending.push_back(request.clone());
    }
    let _ = app.emit("studio_nva_apply_requested", request);
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

fn inspect_nva_archive(bytes: &[u8]) -> Result<String, String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|_| "nva_archive_invalid".to_string())?;
    if archive.len() == 0 || archive.len() > MAX_NVA_ENTRIES {
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
        let components = path_name.split('/').collect::<Vec<_>>();
        let has_drive_prefix = components.first().is_some_and(|part| {
            let bytes = part.as_bytes();
            bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
        });
        if normalized.starts_with('/')
            || std::path::Path::new(&normalized).is_absolute()
            || has_drive_prefix
            || components.iter().any(|part| {
                part.is_empty()
                    || *part == "."
                    || *part == ".."
                    || part.chars().any(char::is_control)
            })
            || !names.insert(path_name.to_ascii_lowercase())
        {
            return Err("nva_archive_invalid".to_string());
        }
        expanded = expanded.saturating_add(entry.size());
        if expanded > MAX_NVA_UNCOMPRESSED_BYTES {
            return Err("nva_archive_too_large".to_string());
        }
    }
    let mut manifest = archive
        .by_name("manifest.json")
        .map_err(|_| "nva_manifest_missing".to_string())?;
    if manifest.size() == 0 || manifest.size() > MAX_MANIFEST_BYTES {
        return Err("nva_manifest_invalid".to_string());
    }
    let mut content = Vec::with_capacity(manifest.size() as usize);
    manifest
        .read_to_end(&mut content)
        .map_err(|_| "nva_manifest_invalid".to_string())?;
    String::from_utf8(content).map_err(|_| "nva_manifest_invalid".to_string())
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
    let expected_sha = response
        .headers()
        .get("x-nva-sha256")
        .and_then(|value| value.to_str().ok())
        .map(str::to_ascii_lowercase)
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| "nva_integrity_metadata_missing".to_string())?;
    let expected_size = response
        .headers()
        .get("x-nva-size")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());
    let bytes = read_bounded_response(
        response,
        MAX_NVA_DOWNLOAD_BYTES,
        "nva_download_too_large",
        "nva_download_unavailable",
    )
    .await?;
    if let Some(size) = expected_size {
        if size != bytes.len() {
            return Err("nva_integrity_size_mismatch".to_string());
        }
    }
    let actual_sha = format!("{:x}", Sha256::digest(&bytes));
    if actual_sha != expected_sha {
        return Err("nva_integrity_sha_mismatch".to_string());
    }
    let manifest_json = inspect_nva_archive(&bytes)?;

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|_| "nva_download_storage_unavailable".to_string())?;
    std::fs::create_dir_all(&cache_dir)
        .map_err(|_| "nva_download_storage_unavailable".to_string())?;
    let (mut file, path) = tempfile::Builder::new()
        .prefix("naia-studio-")
        .suffix(".nva")
        .tempfile_in(&cache_dir)
        .map_err(|_| "nva_download_storage_unavailable".to_string())?
        .keep()
        .map_err(|_| "nva_download_storage_unavailable".to_string())?;
    if file.write_all(&bytes).is_err() {
        let _ = std::fs::remove_file(&path);
        return Err("nva_download_storage_unavailable".to_string());
    }
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
    use super::{parse_deep_link, StudioNvaEnvironment};

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
