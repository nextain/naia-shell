//! Local device pairing owned by the Shell, not the removed gateway.
//!
//! Pairing records live at `{adkPath}/device-pairings.json`. Tokens and pair
//! codes are stored as SHA-256 hex; plaintext is returned once and never written.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const STORE_VERSION: u32 = 1;
const PAIR_TTL_SECS: u64 = 600;
const STORE_FILE: &str = "device-pairings.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NodeRecord {
    pub node_id: String,
    pub display_name: String,
    pub platform: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_hash: Option<String>,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairRequestRecord {
    pub request_id: String,
    pub node_id: String,
    pub display_name: String,
    pub platform: String,
    pub code_hash: String,
    pub status: PairStatus,
    pub created_at: u64,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PairStatus {
    Pending,
    Verified,
    Approved,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingStore {
    pub version: u32,
    pub nodes: Vec<NodeRecord>,
    pub requests: Vec<PairRequestRecord>,
}

impl Default for PairingStore {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            nodes: Vec::new(),
            requests: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NodePublic {
    pub node_id: String,
    pub display_name: String,
    pub platform: String,
    pub created_at: u64,
    pub last_seen: Option<u64>,
    pub has_token: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairRequestPublic {
    pub request_id: String,
    pub node_id: String,
    pub display_name: String,
    pub platform: String,
    pub status: PairStatus,
    pub created_at: u64,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairRequestCreated {
    pub request: PairRequestPublic,
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedNode {
    pub node: NodePublic,
    pub token: String,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn sha256_hex(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| format!("rng_failed:{e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

pub fn store_path_for_adk(adk_path: &str) -> PathBuf {
    Path::new(adk_path).join(STORE_FILE)
}

fn load_store(path: &Path) -> Result<PairingStore, String> {
    if !path.exists() {
        return Ok(PairingStore::default());
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("store_read_failed:{e}"))?;
    if raw.trim().is_empty() {
        return Ok(PairingStore::default());
    }
    serde_json::from_str(&raw).map_err(|e| format!("store_parse_failed:{e}"))
}

fn save_store(path: &Path, store: &PairingStore) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("store_dir_failed:{e}"))?;
    }
    let encoded =
        serde_json::to_string_pretty(store).map_err(|e| format!("store_encode_failed:{e}"))?;
    fs::write(path, encoded).map_err(|e| format!("store_write_failed:{e}"))
}

fn node_public(node: &NodeRecord) -> NodePublic {
    NodePublic {
        node_id: node.node_id.clone(),
        display_name: node.display_name.clone(),
        platform: node.platform.clone(),
        created_at: node.created_at,
        last_seen: node.last_seen,
        has_token: node.token_hash.is_some(),
    }
}

fn request_public(request: &PairRequestRecord) -> PairRequestPublic {
    PairRequestPublic {
        request_id: request.request_id.clone(),
        node_id: request.node_id.clone(),
        display_name: request.display_name.clone(),
        platform: request.platform.clone(),
        status: request.status.clone(),
        created_at: request.created_at,
        expires_at: request.expires_at,
    }
}

pub fn list_nodes(path: &Path) -> Result<Vec<NodePublic>, String> {
    let store = load_store(path)?;
    Ok(store.nodes.iter().map(node_public).collect())
}

pub fn list_requests(path: &Path) -> Result<Vec<PairRequestPublic>, String> {
    let now = now_secs();
    let store = load_store(path)?;
    Ok(store
        .requests
        .iter()
        .filter(|request| request.expires_at >= now || request.status != PairStatus::Pending)
        .map(request_public)
        .collect())
}

pub fn describe_node(path: &Path, node_id: &str) -> Result<NodePublic, String> {
    let store = load_store(path)?;
    store
        .nodes
        .iter()
        .find(|node| node.node_id == node_id)
        .map(node_public)
        .ok_or_else(|| "node_not_found".to_string())
}

pub fn rename_node(path: &Path, node_id: &str, display_name: &str) -> Result<NodePublic, String> {
    let name = display_name.trim();
    if name.is_empty() {
        return Err("display_name_required".to_string());
    }
    let mut store = load_store(path)?;
    let node = store
        .nodes
        .iter_mut()
        .find(|node| node.node_id == node_id)
        .ok_or_else(|| "node_not_found".to_string())?;
    node.display_name = name.to_string();
    let public = node_public(node);
    save_store(path, &store)?;
    Ok(public)
}

pub fn rotate_token(path: &Path, node_id: &str) -> Result<String, String> {
    let token = random_hex(32)?;
    let mut store = load_store(path)?;
    let node = store
        .nodes
        .iter_mut()
        .find(|node| node.node_id == node_id)
        .ok_or_else(|| "node_not_found".to_string())?;
    node.token_hash = Some(sha256_hex(&token));
    save_store(path, &store)?;
    Ok(token)
}

pub fn revoke_token(path: &Path, node_id: &str) -> Result<NodePublic, String> {
    let mut store = load_store(path)?;
    let node = store
        .nodes
        .iter_mut()
        .find(|node| node.node_id == node_id)
        .ok_or_else(|| "node_not_found".to_string())?;
    node.token_hash = None;
    let public = node_public(node);
    save_store(path, &store)?;
    Ok(public)
}

pub fn authenticate(path: &Path, node_id: &str, token: &str) -> Result<bool, String> {
    let store = load_store(path)?;
    let Some(node) = store.nodes.iter().find(|node| node.node_id == node_id) else {
        return Ok(false);
    };
    let Some(hash) = node.token_hash.as_ref() else {
        return Ok(false);
    };
    Ok(hash == &sha256_hex(token))
}

pub fn pair_request(
    path: &Path,
    display_name: &str,
    platform: &str,
) -> Result<PairRequestCreated, String> {
    let name = display_name.trim();
    if name.is_empty() {
        return Err("display_name_required".to_string());
    }
    let platform = if platform.trim().is_empty() {
        "unknown"
    } else {
        platform.trim()
    };
    let now = now_secs();
    let code = random_hex(3)?;
    let request = PairRequestRecord {
        request_id: random_hex(16)?,
        node_id: random_hex(16)?,
        display_name: name.to_string(),
        platform: platform.to_string(),
        code_hash: sha256_hex(&code),
        status: PairStatus::Pending,
        created_at: now,
        expires_at: now.saturating_add(PAIR_TTL_SECS),
    };
    let created = PairRequestCreated {
        request: request_public(&request),
        code,
    };
    let mut store = load_store(path)?;
    store.requests.push(request);
    save_store(path, &store)?;
    Ok(created)
}

pub fn pair_verify(path: &Path, request_id: &str, code: &str) -> Result<PairRequestPublic, String> {
    let now = now_secs();
    let mut store = load_store(path)?;
    let request = store
        .requests
        .iter_mut()
        .find(|request| request.request_id == request_id)
        .ok_or_else(|| "request_not_found".to_string())?;
    if request.expires_at < now {
        return Err("request_expired".to_string());
    }
    if request.status != PairStatus::Pending {
        return Err("request_not_pending".to_string());
    }
    if request.code_hash != sha256_hex(code.trim()) {
        return Err("code_mismatch".to_string());
    }
    request.status = PairStatus::Verified;
    let public = request_public(request);
    save_store(path, &store)?;
    Ok(public)
}

pub fn pair_approve(path: &Path, request_id: &str) -> Result<ApprovedNode, String> {
    let now = now_secs();
    let mut store = load_store(path)?;
    let request = store
        .requests
        .iter_mut()
        .find(|request| request.request_id == request_id)
        .ok_or_else(|| "request_not_found".to_string())?;
    if request.expires_at < now {
        return Err("request_expired".to_string());
    }
    if request.status != PairStatus::Verified {
        return Err("request_not_verified".to_string());
    }
    request.status = PairStatus::Approved;
    let token = random_hex(32)?;
    let node = NodeRecord {
        node_id: request.node_id.clone(),
        display_name: request.display_name.clone(),
        platform: request.platform.clone(),
        token_hash: Some(sha256_hex(&token)),
        created_at: now,
        last_seen: Some(now),
    };
    let public = node_public(&node);
    store.nodes.push(node);
    save_store(path, &store)?;
    Ok(ApprovedNode {
        node: public,
        token,
    })
}

pub fn pair_reject(path: &Path, request_id: &str) -> Result<PairRequestPublic, String> {
    let mut store = load_store(path)?;
    let request = store
        .requests
        .iter_mut()
        .find(|request| request.request_id == request_id)
        .ok_or_else(|| "request_not_found".to_string())?;
    if request.status == PairStatus::Approved {
        return Err("request_already_approved".to_string());
    }
    request.status = PairStatus::Rejected;
    let public = request_public(request);
    save_store(path, &store)?;
    Ok(public)
}

fn command_store_path() -> Result<PathBuf, String> {
    Ok(store_path_for_adk(&crate::current_adk_path()?))
}

#[tauri::command]
pub fn device_list() -> Result<Vec<NodePublic>, String> {
    list_nodes(&command_store_path()?)
}

#[tauri::command]
pub fn device_list_requests() -> Result<Vec<PairRequestPublic>, String> {
    list_requests(&command_store_path()?)
}

#[tauri::command]
pub fn device_describe(node_id: String) -> Result<NodePublic, String> {
    describe_node(&command_store_path()?, &node_id)
}

#[tauri::command]
pub fn device_rename(node_id: String, display_name: String) -> Result<NodePublic, String> {
    rename_node(&command_store_path()?, &node_id, &display_name)
}

#[tauri::command]
pub fn device_token_rotate(node_id: String) -> Result<String, String> {
    rotate_token(&command_store_path()?, &node_id)
}

#[tauri::command]
pub fn device_token_revoke(node_id: String) -> Result<NodePublic, String> {
    revoke_token(&command_store_path()?, &node_id)
}

#[tauri::command]
pub fn device_authenticate(node_id: String, token: String) -> Result<bool, String> {
    authenticate(&command_store_path()?, &node_id, &token)
}

#[tauri::command]
pub fn device_pair_request(
    display_name: String,
    platform: String,
) -> Result<PairRequestCreated, String> {
    pair_request(&command_store_path()?, &display_name, &platform)
}

#[tauri::command]
pub fn device_pair_verify(request_id: String, code: String) -> Result<PairRequestPublic, String> {
    pair_verify(&command_store_path()?, &request_id, &code)
}

#[tauri::command]
pub fn device_pair_approve(request_id: String) -> Result<ApprovedNode, String> {
    pair_approve(&command_store_path()?, &request_id)
}

#[tauri::command]
pub fn device_pair_reject(request_id: String) -> Result<PairRequestPublic, String> {
    pair_reject(&command_store_path()?, &request_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn store() -> (tempfile::TempDir, PathBuf) {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join(STORE_FILE);
        (dir, path)
    }

    #[test]
    fn rotated_token_invalidates_the_previous_token() {
        let (_dir, path) = store();
        let created = pair_request(&path, "kitchen", "windows").unwrap();
        pair_verify(&path, &created.request.request_id, &created.code).unwrap();
        let approved = pair_approve(&path, &created.request.request_id).unwrap();
        let old = approved.token.clone();
        assert!(authenticate(&path, &approved.node.node_id, &old).unwrap());

        let rotated = rotate_token(&path, &approved.node.node_id).unwrap();
        assert_ne!(rotated, old);
        assert!(!authenticate(&path, &approved.node.node_id, &old).unwrap());
        assert!(authenticate(&path, &approved.node.node_id, &rotated).unwrap());
    }

    #[test]
    fn revoke_stops_the_current_token() {
        let (_dir, path) = store();
        let created = pair_request(&path, "desk", "linux").unwrap();
        pair_verify(&path, &created.request.request_id, &created.code).unwrap();
        let approved = pair_approve(&path, &created.request.request_id).unwrap();
        revoke_token(&path, &approved.node.node_id).unwrap();
        assert!(!authenticate(&path, &approved.node.node_id, &approved.token).unwrap());
        let listed = list_nodes(&path).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].has_token);
    }

    #[test]
    fn rename_and_describe_change_the_visible_name() {
        let (_dir, path) = store();
        let created = pair_request(&path, "old-name", "windows").unwrap();
        pair_verify(&path, &created.request.request_id, &created.code).unwrap();
        let approved = pair_approve(&path, &created.request.request_id).unwrap();
        rename_node(&path, &approved.node.node_id, "e2e-node").unwrap();
        let described = describe_node(&path, &approved.node.node_id).unwrap();
        assert_eq!(described.display_name, "e2e-node");
    }

    #[test]
    fn pair_verify_rejects_the_wrong_code_and_approve_requires_verify() {
        let (_dir, path) = store();
        let created = pair_request(&path, "phone", "android").unwrap();
        let err = pair_verify(&path, &created.request.request_id, "ffffff").unwrap_err();
        assert_eq!(err, "code_mismatch");
        let err = pair_approve(&path, &created.request.request_id).unwrap_err();
        assert_eq!(err, "request_not_verified");
        pair_verify(&path, &created.request.request_id, &created.code).unwrap();
        pair_approve(&path, &created.request.request_id).unwrap();
        assert_eq!(list_nodes(&path).unwrap().len(), 1);
    }

    #[test]
    fn store_never_writes_plaintext_secrets() {
        let (_dir, path) = store();
        let created = pair_request(&path, "lab", "linux").unwrap();
        pair_verify(&path, &created.request.request_id, &created.code).unwrap();
        let approved = pair_approve(&path, &created.request.request_id).unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        assert!(!raw.contains(&created.code));
        assert!(!raw.contains(&approved.token));
        assert!(raw.contains("tokenHash"));
        assert!(raw.contains("codeHash"));
    }
}
