//! Local device/node pairing store. Replaces the deleted gateway `skill_device`
//! path (#570): Settings and Tauri commands own list/describe/rename/rotate/
//! revoke/pair, and the store keeps only token hashes.

use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

static REGISTRY_LOCK: Mutex<()> = Mutex::new(());

const REGISTRY_VERSION: u32 = 1;
const MAX_ID_CHARS: usize = 128;
const TOKEN_PREFIX: &str = "ndt_";
const TOKEN_BYTES: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registry {
    version: u32,
    nodes: Vec<Node>,
    pair_requests: Vec<PairRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Node {
    node_id: String,
    display_name: String,
    platform: String,
    token_hash: Option<String>,
    created_at: u64,
    updated_at: u64,
    revoked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest {
    request_id: String,
    node_id: String,
    display_name: String,
    platform: String,
    code_hash: String,
    status: String,
    created_at: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex_encode(&Sha256::digest(bytes))
}

fn random_bytes(n: usize) -> Result<Vec<u8>, String> {
    let mut buf = vec![0u8; n];
    getrandom::fill(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

fn new_id(prefix: &str) -> Result<String, String> {
    Ok(format!("{prefix}{}", hex_encode(&random_bytes(8)?)))
}

fn new_token() -> Result<String, String> {
    Ok(format!(
        "{TOKEN_PREFIX}{}",
        hex_encode(&random_bytes(TOKEN_BYTES)?)
    ))
}

fn new_pair_code() -> Result<String, String> {
    let bytes = random_bytes(4)?;
    let n = u32::from_le_bytes(bytes.as_slice().try_into().unwrap_or([0; 4])) % 1_000_000;
    Ok(format!("{n:06}"))
}

fn safe_id(raw: &str, label: &str) -> Result<String, String> {
    let s: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(MAX_ID_CHARS)
        .collect();
    if s.is_empty() {
        return Err(format!("invalid {label}"));
    }
    Ok(s)
}

fn require_adk_path(adk_path: &str) -> Result<PathBuf, String> {
    let trimmed = adk_path.trim();
    if trimmed.is_empty() {
        return Err("adk path is required".into());
    }
    if trimmed.contains("..") {
        return Err("adk path rejected".into());
    }
    Ok(PathBuf::from(trimmed))
}

fn registry_path(adk: &Path) -> PathBuf {
    adk.join("naia-settings").join("devices").join("registry.json")
}

fn empty_registry() -> Registry {
    Registry {
        version: REGISTRY_VERSION,
        nodes: Vec::new(),
        pair_requests: Vec::new(),
    }
}

fn read_registry(path: &Path) -> Result<Registry, String> {
    if !path.is_file() {
        return Ok(empty_registry());
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(empty_registry());
    }
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn write_registry(path: &Path, registry: &Registry) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(registry).map_err(|e| e.to_string())?;
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

fn with_registry<T>(
    adk_path: &str,
    mutate: impl FnOnce(&mut Registry) -> Result<T, String>,
) -> Result<T, String> {
    let _guard = REGISTRY_LOCK
        .lock()
        .map_err(|_| "device registry lock poisoned".to_string())?;
    let adk = require_adk_path(adk_path)?;
    let path = registry_path(&adk);
    let mut registry = read_registry(&path)?;
    let result = mutate(&mut registry)?;
    write_registry(&path, &registry)?;
    Ok(result)
}

fn node_view(node: &Node) -> serde_json::Value {
    json!({
        "nodeId": node.node_id,
        "displayName": node.display_name,
        "platform": node.platform,
        "createdAt": node.created_at,
        "updatedAt": node.updated_at,
        "revoked": node.revoked,
        "hasToken": node.token_hash.is_some(),
    })
}

fn request_view(req: &PairRequest) -> serde_json::Value {
    json!({
        "requestId": req.request_id,
        "nodeId": req.node_id,
        "displayName": req.display_name,
        "platform": req.platform,
        "status": req.status,
        "createdAt": req.created_at,
    })
}

#[tauri::command]
pub fn device_node_list(adk_path: String) -> Result<serde_json::Value, String> {
    with_registry(&adk_path, |registry| {
        Ok(json!({
            "nodes": registry.nodes.iter().map(node_view).collect::<Vec<_>>(),
        }))
    })
}

#[tauri::command]
pub fn device_node_describe(adk_path: String, node_id: String) -> Result<serde_json::Value, String> {
    let node_id = safe_id(&node_id, "node id")?;
    with_registry(&adk_path, |registry| {
        let node = registry
            .nodes
            .iter()
            .find(|n| n.node_id == node_id)
            .ok_or_else(|| "node not found".to_string())?;
        Ok(node_view(node))
    })
}

#[tauri::command]
pub fn device_node_rename(
    adk_path: String,
    node_id: String,
    display_name: String,
) -> Result<serde_json::Value, String> {
    let node_id = safe_id(&node_id, "node id")?;
    let display_name = display_name.trim();
    if display_name.is_empty() || display_name.chars().count() > 80 {
        return Err("invalid display name".into());
    }
    let display_name = display_name.to_string();
    with_registry(&adk_path, |registry| {
        let node = registry
            .nodes
            .iter_mut()
            .find(|n| n.node_id == node_id)
            .ok_or_else(|| "node not found".to_string())?;
        node.display_name = display_name.clone();
        node.updated_at = now_ms();
        Ok(node_view(node))
    })
}

#[tauri::command]
pub fn device_token_rotate(adk_path: String, node_id: String) -> Result<serde_json::Value, String> {
    let node_id = safe_id(&node_id, "node id")?;
    let token = new_token()?;
    let hash = sha256_hex(token.as_bytes());
    with_registry(&adk_path, |registry| {
        let node = registry
            .nodes
            .iter_mut()
            .find(|n| n.node_id == node_id)
            .ok_or_else(|| "node not found".to_string())?;
        if node.revoked {
            return Err("node is revoked".into());
        }
        node.token_hash = Some(hash.clone());
        node.updated_at = now_ms();
        Ok(json!({
            "node": node_view(node),
            "token": token,
        }))
    })
}

#[tauri::command]
pub fn device_token_revoke(adk_path: String, node_id: String) -> Result<serde_json::Value, String> {
    let node_id = safe_id(&node_id, "node id")?;
    with_registry(&adk_path, |registry| {
        let node = registry
            .nodes
            .iter_mut()
            .find(|n| n.node_id == node_id)
            .ok_or_else(|| "node not found".to_string())?;
        node.revoked = true;
        node.token_hash = None;
        node.updated_at = now_ms();
        Ok(json!({ "ok": true, "node": node_view(node) }))
    })
}

#[tauri::command]
pub fn device_token_verify(
    adk_path: String,
    node_id: String,
    token: String,
) -> Result<serde_json::Value, String> {
    let node_id = safe_id(&node_id, "node id")?;
    let hash = sha256_hex(token.as_bytes());
    with_registry(&adk_path, |registry| {
        let node = registry.nodes.iter().find(|n| n.node_id == node_id);
        let valid = match node {
            Some(n) if !n.revoked => n.token_hash.as_deref() == Some(hash.as_str()),
            _ => false,
        };
        Ok(json!({ "valid": valid }))
    })
}

#[tauri::command]
pub fn device_pair_list(adk_path: String) -> Result<serde_json::Value, String> {
    with_registry(&adk_path, |registry| {
        Ok(json!({
            "requests": registry.pair_requests.iter().map(request_view).collect::<Vec<_>>(),
        }))
    })
}

#[tauri::command]
pub fn device_pair_request(
    adk_path: String,
    node_id: Option<String>,
    display_name: Option<String>,
    platform: Option<String>,
) -> Result<serde_json::Value, String> {
    let node_id = match node_id {
        Some(id) if !id.trim().is_empty() => safe_id(&id, "node id")?,
        _ => new_id("node-")?,
    };
    let display_name = display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&node_id)
        .chars()
        .take(80)
        .collect::<String>();
    let platform = platform
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("linux")
        .chars()
        .take(32)
        .collect::<String>();
    let request_id = new_id("req-")?;
    let code = new_pair_code()?;
    let code_hash = sha256_hex(code.as_bytes());
    let created_at = now_ms();
    with_registry(&adk_path, |registry| {
        if registry.nodes.iter().any(|n| n.node_id == node_id && !n.revoked) {
            return Err("node already paired".into());
        }
        registry.pair_requests.push(PairRequest {
            request_id: request_id.clone(),
            node_id: node_id.clone(),
            display_name: display_name.clone(),
            platform: platform.clone(),
            code_hash: code_hash.clone(),
            status: "pending".into(),
            created_at,
        });
        Ok(json!({
            "requestId": request_id,
            "nodeId": node_id,
            "displayName": display_name,
            "platform": platform,
            "status": "pending",
            "code": code,
        }))
    })
}

#[tauri::command]
pub fn device_pair_verify(
    adk_path: String,
    request_id: String,
    code: String,
) -> Result<serde_json::Value, String> {
    let request_id = safe_id(&request_id, "request id")?;
    let code_hash = sha256_hex(code.trim().as_bytes());
    with_registry(&adk_path, |registry| {
        let req = registry
            .pair_requests
            .iter_mut()
            .find(|r| r.request_id == request_id)
            .ok_or_else(|| "pair request not found".to_string())?;
        if req.status != "pending" {
            return Err("pair request is not pending".into());
        }
        if req.code_hash != code_hash {
            return Err("pair code mismatch".into());
        }
        req.status = "verified".into();
        Ok(request_view(req))
    })
}

#[tauri::command]
pub fn device_pair_approve(
    adk_path: String,
    request_id: String,
) -> Result<serde_json::Value, String> {
    let request_id = safe_id(&request_id, "request id")?;
    let token = new_token()?;
    let token_hash = sha256_hex(token.as_bytes());
    let now = now_ms();
    with_registry(&adk_path, |registry| {
        let req = registry
            .pair_requests
            .iter_mut()
            .find(|r| r.request_id == request_id)
            .ok_or_else(|| "pair request not found".to_string())?;
        if req.status != "verified" {
            return Err("pair request is not verified".into());
        }
        let node_id = req.node_id.clone();
        let display_name = req.display_name.clone();
        let platform = req.platform.clone();
        req.status = "approved".into();
        if let Some(existing) = registry.nodes.iter_mut().find(|n| n.node_id == node_id) {
            existing.display_name = display_name.clone();
            existing.platform = platform.clone();
            existing.token_hash = Some(token_hash.clone());
            existing.revoked = false;
            existing.updated_at = now;
        } else {
            registry.nodes.push(Node {
                node_id: node_id.clone(),
                display_name: display_name.clone(),
                platform: platform.clone(),
                token_hash: Some(token_hash.clone()),
                created_at: now,
                updated_at: now,
                revoked: false,
            });
        }
        let node = registry
            .nodes
            .iter()
            .find(|n| n.node_id == node_id)
            .expect("approved node");
        Ok(json!({
            "node": node_view(node),
            "token": token,
        }))
    })
}

#[tauri::command]
pub fn device_pair_reject(
    adk_path: String,
    request_id: String,
) -> Result<serde_json::Value, String> {
    let request_id = safe_id(&request_id, "request id")?;
    with_registry(&adk_path, |registry| {
        let req = registry
            .pair_requests
            .iter_mut()
            .find(|r| r.request_id == request_id)
            .ok_or_else(|| "pair request not found".to_string())?;
        if req.status == "approved" {
            return Err("approved request cannot be rejected".into());
        }
        req.status = "rejected".into();
        Ok(request_view(req))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    fn temp_adk() -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "naia-device-reg-{}-{}-{}",
            std::process::id(),
            n,
            now_ms()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("naia-settings")).unwrap();
        dir
    }

    fn pair_through(adk: &str, name: &str) -> (String, String, String) {
        let req = device_pair_request(
            adk.to_string(),
            None,
            Some(name.into()),
            Some("linux".into()),
        )
        .unwrap();
        let request_id = req["requestId"].as_str().unwrap().to_string();
        let node_id = req["nodeId"].as_str().unwrap().to_string();
        let code = req["code"].as_str().unwrap().to_string();
        device_pair_verify(adk.to_string(), request_id.clone(), code).unwrap();
        let approved = device_pair_approve(adk.to_string(), request_id).unwrap();
        let token = approved["token"].as_str().unwrap().to_string();
        (node_id, token, name.to_string())
    }

    #[test]
    fn pair_verify_approve_then_describe() {
        let adk = temp_adk();
        let adk_s = adk.to_str().unwrap();
        let (node_id, token, _) = pair_through(adk_s, "desk-a");
        let listed = device_node_list(adk_s.into()).unwrap();
        assert_eq!(listed["nodes"][0]["displayName"], "desk-a");
        let described = device_node_describe(adk_s.into(), node_id.clone()).unwrap();
        assert_eq!(described["nodeId"], node_id);
        assert_eq!(described["hasToken"], true);
        let check = device_token_verify(adk_s.into(), node_id, token).unwrap();
        assert_eq!(check["valid"], true);
    }

    #[test]
    fn rotate_invalidates_previous_token() {
        let adk = temp_adk();
        let adk_s = adk.to_str().unwrap();
        let (node_id, old_token, _) = pair_through(adk_s, "desk-b");
        let rotated = device_token_rotate(adk_s.into(), node_id.clone()).unwrap();
        let new_token = rotated["token"].as_str().unwrap().to_string();
        assert_ne!(old_token, new_token);
        assert_eq!(
            device_token_verify(adk_s.into(), node_id.clone(), old_token).unwrap()["valid"],
            false
        );
        assert_eq!(
            device_token_verify(adk_s.into(), node_id, new_token).unwrap()["valid"],
            true
        );
    }

    #[test]
    fn revoke_rejects_previous_token() {
        let adk = temp_adk();
        let adk_s = adk.to_str().unwrap();
        let (node_id, token, _) = pair_through(adk_s, "desk-c");
        device_token_revoke(adk_s.into(), node_id.clone()).unwrap();
        assert_eq!(
            device_token_verify(adk_s.into(), node_id.clone(), token).unwrap()["valid"],
            false
        );
        assert!(device_token_rotate(adk_s.into(), node_id).is_err());
    }

    #[test]
    fn rename_changes_display_name() {
        let adk = temp_adk();
        let adk_s = adk.to_str().unwrap();
        let (node_id, _, _) = pair_through(adk_s, "old-name");
        let renamed = device_node_rename(adk_s.into(), node_id, "e2e-node".into()).unwrap();
        assert_eq!(renamed["displayName"], "e2e-node");
    }

    #[test]
    fn wrong_code_does_not_verify() {
        let adk = temp_adk();
        let adk_s = adk.to_str().unwrap();
        let req = device_pair_request(adk_s.into(), None, Some("x".into()), None).unwrap();
        let request_id = req["requestId"].as_str().unwrap().to_string();
        assert!(device_pair_verify(adk_s.into(), request_id.clone(), "000000".into()).is_err());
        assert!(device_pair_approve(adk_s.into(), request_id).is_err());
    }

    #[test]
    fn reject_leaves_no_node() {
        let adk = temp_adk();
        let adk_s = adk.to_str().unwrap();
        let req = device_pair_request(adk_s.into(), None, Some("nope".into()), None).unwrap();
        let request_id = req["requestId"].as_str().unwrap().to_string();
        device_pair_reject(adk_s.into(), request_id).unwrap();
        let listed = device_node_list(adk_s.into()).unwrap();
        assert_eq!(listed["nodes"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn traversal_ids_are_rejected() {
        let adk = temp_adk();
        let adk_s = adk.to_str().unwrap();
        assert!(device_node_describe(adk_s.into(), "../etc/passwd".into()).is_err());
        assert!(device_node_list("../outside".into()).is_err());
        assert!(device_node_list("".into()).is_err());
    }

    #[test]
    fn registry_file_does_not_store_plaintext_token() {
        let adk = temp_adk();
        let adk_s = adk.to_str().unwrap();
        let (_, token, _) = pair_through(adk_s, "secret-node");
        let raw = fs::read_to_string(registry_path(&adk)).unwrap();
        assert!(!raw.contains(&token));
        assert!(!raw.contains("ndt_"));
    }
}
