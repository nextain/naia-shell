use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tokio::sync::oneshot;

// ─── Backup IPC Relay ─────────────────────────────────────────────────────────

type BackupSender = oneshot::Sender<Result<serde_json::Value, String>>;
static PENDING_OPS: std::sync::OnceLock<Mutex<HashMap<String, BackupSender>>> =
    std::sync::OnceLock::new();

fn pending_ops() -> &'static Mutex<HashMap<String, BackupSender>> {
    PENDING_OPS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Lock the pending ops map, recovering from a poisoned mutex (mirroring lib.rs `lock_or_recover`).
fn lock_pending() -> std::sync::MutexGuard<'static, HashMap<String, BackupSender>> {
    match pending_ops().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Register a pending one-shot channel for a memory backup IPC request.
pub fn register_pending(request_id: String, tx: BackupSender) {
    lock_pending().insert(request_id, tx);
}

/// Remove a pending one-shot channel (e.g. on timeout cleanup).
pub fn unregister_pending(request_id: &str) {
    lock_pending().remove(request_id);
}

/// Called from the agent stdout reader when a backup result message arrives.
/// Returns `true` if the message was consumed (should NOT be forwarded as `agent_response`).
pub fn dispatch_backup_response(parsed: &serde_json::Value) -> bool {
    let type_str = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if !matches!(type_str, "memory_export_result" | "memory_import_result") {
        return false;
    }
    let request_id = match parsed.get("requestId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return false,
    };
    let sender = lock_pending().remove(&request_id);
    if let Some(tx) = sender {
        let result = match parsed.get("error").and_then(|v| v.as_str()) {
            Some(err) => Err(err.to_string()),
            None => Ok(parsed.clone()),
        };
        let _ = tx.send(result);
        true
    } else {
        // Sender already dropped (likely timed out) — late-arriving response silently discarded
        crate::log_verbose(&format!(
            "[Naia] late backup response for requestId={} (timed out or duplicate) — discarded",
            request_id
        ));
        false
    }
}

/// Agent's semantic Fact — matches agent/src/memory/types.ts Fact interface
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentFact {
    pub id: String,
    pub content: String,
    #[serde(default)]
    pub entities: Vec<String>,
    #[serde(default)]
    pub topics: Vec<String>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub importance: f64,
    #[serde(default)]
    pub recall_count: i64,
    #[serde(default)]
    pub last_accessed: i64,
    #[serde(default)]
    pub strength: f64,
    #[serde(default)]
    pub source_episodes: Vec<String>,
}

/// On-disk JSON schema (matches LocalAdapter's MemoryStore)
#[derive(Debug, Deserialize)]
struct MemoryStore {
    #[serde(default)]
    facts: Vec<AgentFact>,
}

/// Get the Agent memory JSON file path (~/.naia/memory/alpha-memory.json)
fn agent_memory_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".naia")
        .join("memory")
        .join("alpha-memory.json")
}

/// Read all facts from Agent's memory JSON file.
/// Returns empty vec if file doesn't exist or is invalid.
pub fn get_all_agent_facts() -> Vec<AgentFact> {
    let path = agent_memory_path();
    match std::fs::read_to_string(&path) {
        Ok(content) => match serde_json::from_str::<MemoryStore>(&content) {
            Ok(store) => store.facts,
            Err(_) => Vec::new(),
        },
        Err(_) => Vec::new(),
    }
}

/// Delete a fact from Agent's memory JSON file by ID.
/// Returns true if the fact was found and deleted.
///
/// RACE NOTE: Agent (Node.js) also writes this file during consolidation (30-min cycle)
/// and recall (recallCount updates). Both sides use atomic write (tmp+rename).
/// No cross-process file lock exists — a lost update is theoretically possible if
/// Agent writes during the read-modify-write window here. In practice this is rare
/// because user-initiated deletes are infrequent and consolidation runs every 30 min.
/// Future: route deletes through Agent IPC to eliminate this race entirely.
pub fn delete_agent_fact(fact_id: &str) -> Result<bool, String> {
    let path = agent_memory_path();
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read memory file: {}", e))?;

    let mut raw: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse memory JSON: {}", e))?;

    let facts = raw
        .get_mut("facts")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| "No facts array in memory file".to_string())?;

    let original_len = facts.len();
    facts.retain(|f| f.get("id").and_then(|v| v.as_str()) != Some(fact_id));
    let deleted = facts.len() < original_len;

    if deleted {
        // Atomic write: write to tmp, then rename
        let tmp_path = path.with_extension("json.tmp");
        let serialized = serde_json::to_string_pretty(&raw)
            .map_err(|e| format!("Failed to serialize: {}", e))?;
        std::fs::write(&tmp_path, &serialized)
            .map_err(|e| format!("Failed to write tmp file: {}", e))?;
        std::fs::rename(&tmp_path, &path)
            .map_err(|e| format!("Failed to rename tmp file: {}", e))?;
    }

    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    // ─── IPC Relay tests ────────────────────────────────────────────────────

    #[test]
    fn register_and_dispatch_success_response() {
        let request_id = "test-req-001".to_string();
        let (tx, mut rx) = oneshot::channel();
        register_pending(request_id.clone(), tx);

        let msg = serde_json::json!({
            "type": "memory_export_result",
            "requestId": request_id,
            "data": [1, 2, 3, 4]
        });
        let consumed = dispatch_backup_response(&msg);
        assert!(consumed, "dispatch should return true for memory_export_result");

        let result = rx.try_recv().expect("sender should have fired");
        let val = result.expect("should be Ok, not Err");
        assert_eq!(val["type"], "memory_export_result");
        assert_eq!(val["data"], serde_json::json!([1, 2, 3, 4]));
    }

    #[test]
    fn register_and_dispatch_error_response() {
        let request_id = "test-req-002".to_string();
        let (tx, mut rx) = oneshot::channel();
        register_pending(request_id.clone(), tx);

        let msg = serde_json::json!({
            "type": "memory_import_result",
            "requestId": request_id,
            "error": "Decryption failed"
        });
        let consumed = dispatch_backup_response(&msg);
        assert!(consumed);

        let result = rx.try_recv().expect("sender should have fired");
        let err = result.expect_err("should be Err, not Ok");
        assert_eq!(err, "Decryption failed");
    }

    #[test]
    fn dispatch_returns_false_for_unrelated_message_type() {
        let msg = serde_json::json!({
            "type": "agent_response",
            "content": "hello"
        });
        let consumed = dispatch_backup_response(&msg);
        assert!(!consumed, "should not consume agent_response messages");
    }

    #[test]
    fn dispatch_returns_false_when_no_pending_sender() {
        // Dispatch a backup message that was never registered (simulates late arrival)
        let msg = serde_json::json!({
            "type": "memory_export_result",
            "requestId": "nonexistent-id-xyz",
            "data": []
        });
        let consumed = dispatch_backup_response(&msg);
        // No sender registered: should return false (late/stale response)
        assert!(!consumed);
    }

    #[test]
    fn unregister_pending_removes_sender() {
        let request_id = "test-req-003".to_string();
        let (tx, _rx) = oneshot::channel::<Result<serde_json::Value, String>>();
        register_pending(request_id.clone(), tx);
        unregister_pending(&request_id);

        // After unregister, dispatching should return false (no sender)
        let msg = serde_json::json!({
            "type": "memory_export_result",
            "requestId": request_id,
            "data": []
        });
        let consumed = dispatch_backup_response(&msg);
        assert!(!consumed, "sender was removed, should not be consumed");
    }

    #[test]
    fn dispatch_returns_false_for_backup_type_without_request_id() {
        // Malformed: correct type but no requestId field
        let msg = serde_json::json!({
            "type": "memory_export_result",
            "data": [1, 2, 3]
        });
        let consumed = dispatch_backup_response(&msg);
        assert!(!consumed, "missing requestId should return false without panic");
    }

    // ─── MemoryStore deserialization tests ─────────────────────────────────

    #[test]
    fn parse_agent_memory_json() {
        let content = r#"{
            "version": 1,
            "facts": [
                {
                    "id": "f1",
                    "content": "User prefers TypeScript",
                    "entities": ["TypeScript"],
                    "topics": ["preference"],
                    "createdAt": 1000,
                    "updatedAt": 1000,
                    "importance": 0.8,
                    "recallCount": 2,
                    "lastAccessed": 2000,
                    "strength": 0.7,
                    "sourceEpisodes": ["ep1"]
                }
            ],
            "episodes": [],
            "skills": [],
            "reflections": [],
            "associations": {}
        }"#;
        let store: MemoryStore = serde_json::from_str(content).unwrap();
        assert_eq!(store.facts.len(), 1);
        assert_eq!(store.facts[0].id, "f1");
        assert_eq!(store.facts[0].content, "User prefers TypeScript");
        assert_eq!(store.facts[0].entities, vec!["TypeScript"]);
        assert_eq!(store.facts[0].importance, 0.8);
    }

    #[test]
    fn empty_file_returns_empty_facts() {
        let content = r#"{"version": 1, "episodes": [], "skills": [], "reflections": [], "associations": {}}"#;
        let store: MemoryStore = serde_json::from_str(content).unwrap();
        assert!(store.facts.is_empty());
    }
}
