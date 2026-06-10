use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

const MAX_PAYLOAD_BYTES: usize = 4096;

pub type AuditDb = Arc<Mutex<Connection>>;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AuditEvent {
    pub id: i64,
    pub timestamp: String,
    pub request_id: String,
    pub event_type: String,
    pub tool_name: Option<String>,
    pub tool_call_id: Option<String>,
    pub tier: Option<i32>,
    pub success: Option<bool>,
    pub payload: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct AuditFilter {
    pub request_id: Option<String>,
    pub event_type: Option<String>,
    pub tool_name: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[derive(Debug, Serialize, Clone)]
pub struct AuditStats {
    pub total_events: u64,
    pub by_event_type: Vec<(String, u64)>,
    pub by_tool_name: Vec<(String, u64)>,
    pub total_cost: f64,
}

const DEFAULT_LIMIT: u32 = 100;
const MAX_LIMIT: u32 = 1000;

pub fn init_db(path: &std::path::Path) -> Result<AuditDb, String> {
    let conn = Connection::open(path).map_err(|e| format!("Failed to open audit DB: {}", e))?;

    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| format!("Failed to set WAL mode: {}", e))?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS audit_events (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
            request_id   TEXT NOT NULL,
            event_type   TEXT NOT NULL,
            tool_name    TEXT,
            tool_call_id TEXT,
            tier         INTEGER,
            success      INTEGER,
            payload      TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_audit_request_id ON audit_events(request_id);
        CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_events(event_type);
        CREATE INDEX IF NOT EXISTS idx_audit_tool_name ON audit_events(tool_name);",
    )
    .map_err(|e| format!("Failed to create audit table: {}", e))?;

    Ok(Arc::new(Mutex::new(conn)))
}

pub fn insert_event(
    db: &AuditDb,
    request_id: &str,
    event_type: &str,
    tool_name: Option<&str>,
    tool_call_id: Option<&str>,
    tier: Option<i32>,
    success: Option<bool>,
    payload: Option<&str>,
) -> Result<(), String> {
    let conn = db.lock().map_err(|e| format!("Lock error: {}", e))?;
    conn.execute(
        "INSERT INTO audit_events (request_id, event_type, tool_name, tool_call_id, tier, success, payload)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            request_id,
            event_type,
            tool_name,
            tool_call_id,
            tier,
            success.map(|b| b as i32),
            payload,
        ],
    )
    .map_err(|e| format!("Insert error: {}", e))?;
    Ok(())
}

pub fn maybe_log_event(db: &AuditDb, chunk: &serde_json::Value) {
    let event_type = match chunk.get("type").and_then(|v| v.as_str()) {
        Some(t) => t,
        None => return,
    };

    match event_type {
        "tool_use" | "tool_result" | "approval_request" | "usage" | "error" => {}
        _ => return,
    }

    let request_id = chunk
        .get("requestId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let tool_name = chunk.get("toolName").and_then(|v| v.as_str());
    let tool_call_id = chunk.get("toolCallId").and_then(|v| v.as_str());
    let tier = chunk.get("tier").and_then(|v| v.as_i64()).map(|v| v as i32);
    let success = chunk.get("success").and_then(|v| v.as_bool());
    let payload = build_payload(event_type, chunk);

    if let Err(e) = insert_event(
        db,
        request_id,
        event_type,
        tool_name,
        tool_call_id,
        tier,
        success,
        payload.as_deref(),
    ) {
        eprintln!("[Naia] Audit log error: {}", e);
    }
}

pub fn query_events(db: &AuditDb, filter: &AuditFilter) -> Result<Vec<AuditEvent>, String> {
    let conn = db.lock().map_err(|e| format!("Lock error: {}", e))?;

    let mut sql = String::from(
        "SELECT id, timestamp, request_id, event_type, tool_name, tool_call_id, tier, success, payload
         FROM audit_events WHERE 1=1",
    );
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(ref rid) = filter.request_id {
        params.push(Box::new(rid.clone()));
        sql.push_str(&format!(" AND request_id = ?{}", params.len()));
    }
    if let Some(ref et) = filter.event_type {
        params.push(Box::new(et.clone()));
        sql.push_str(&format!(" AND event_type = ?{}", params.len()));
    }
    if let Some(ref tn) = filter.tool_name {
        params.push(Box::new(tn.clone()));
        sql.push_str(&format!(" AND tool_name = ?{}", params.len()));
    }
    if let Some(ref from) = filter.from {
        params.push(Box::new(from.clone()));
        sql.push_str(&format!(" AND timestamp >= ?{}", params.len()));
    }
    if let Some(ref to) = filter.to {
        params.push(Box::new(to.clone()));
        sql.push_str(&format!(" AND timestamp <= ?{}", params.len()));
    }

    sql.push_str(" ORDER BY id DESC");

    let limit = filter.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
    let offset = filter.offset.unwrap_or(0);
    sql.push_str(&format!(" LIMIT {} OFFSET {}", limit, offset));

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Query prepare error: {}", e))?;

    let rows = stmt
        .query_map(param_refs.as_slice(), |row| {
            let success_int: Option<i32> = row.get(7)?;
            Ok(AuditEvent {
                id: row.get(0)?,
                timestamp: row.get(1)?,
                request_id: row.get(2)?,
                event_type: row.get(3)?,
                tool_name: row.get(4)?,
                tool_call_id: row.get(5)?,
                tier: row.get(6)?,
                success: success_int.map(|v| v != 0),
                payload: row.get(8)?,
            })
        })
        .map_err(|e| format!("Query error: {}", e))?;

    let mut events = Vec::new();
    for row in rows {
        events.push(row.map_err(|e| format!("Row error: {}", e))?);
    }
    Ok(events)
}

pub fn query_stats(db: &AuditDb) -> Result<AuditStats, String> {
    let conn = db.lock().map_err(|e| format!("Lock error: {}", e))?;

    let total_events: u64 = conn
        .query_row("SELECT COUNT(*) FROM audit_events", [], |row| row.get(0))
        .map_err(|e| format!("Stats error: {}", e))?;

    let mut by_event_type = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT event_type, COUNT(*) FROM audit_events GROUP BY event_type")
            .map_err(|e| format!("Stats error: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
            })
            .map_err(|e| format!("Stats error: {}", e))?;
        for row in rows {
            by_event_type.push(row.map_err(|e| format!("Row error: {}", e))?);
        }
    }

    let mut by_tool_name = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT tool_name, COUNT(*) FROM audit_events WHERE tool_name IS NOT NULL GROUP BY tool_name",
            )
            .map_err(|e| format!("Stats error: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
            })
            .map_err(|e| format!("Stats error: {}", e))?;
        for row in rows {
            by_tool_name.push(row.map_err(|e| format!("Row error: {}", e))?);
        }
    }

    // Sum cost from usage event payloads
    let total_cost: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(json_extract(payload, '$.cost')), 0.0) FROM audit_events WHERE event_type = 'usage' AND payload IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("Stats error: {}", e))?;

    Ok(AuditStats {
        total_events,
        by_event_type,
        by_tool_name,
        total_cost,
    })
}

fn truncate_payload(payload: &str) -> String {
    if payload.len() <= MAX_PAYLOAD_BYTES {
        payload.to_string()
    } else {
        // Find the last valid UTF-8 char boundary at or before MAX_PAYLOAD_BYTES
        let mut end = MAX_PAYLOAD_BYTES;
        while end > 0 && !payload.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}...[truncated]", &payload[..end])
    }
}

fn build_payload(event_type: &str, chunk: &serde_json::Value) -> Option<String> {
    let payload = match event_type {
        "tool_use" => {
            let args = chunk
                .get("args")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            serde_json::json!({ "args": args })
        }
        "tool_result" => {
            let output = chunk.get("output").and_then(|v| v.as_str()).unwrap_or("");
            let output = truncate_payload(output);
            let error = chunk
                .get("error")
                .and_then(|v| v.as_str())
                .map(String::from);
            let mut obj = serde_json::json!({ "output": output });
            if let Some(err) = error {
                obj["error"] = serde_json::Value::String(err);
            }
            obj
        }
        "approval_request" => {
            let args = chunk
                .get("args")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let desc = chunk
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            serde_json::json!({ "args": args, "description": desc })
        }
        "usage" => {
            let input_tokens = chunk
                .get("inputTokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let output_tokens = chunk
                .get("outputTokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let cost = chunk.get("cost").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let model = chunk.get("model").and_then(|v| v.as_str()).unwrap_or("");
            serde_json::json!({
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "cost": cost,
                "model": model
            })
        }
        "error" => {
            let message = chunk.get("message").and_then(|v| v.as_str()).unwrap_or("");
            serde_json::json!({ "message": message })
        }
        _ => return None,
    };

    Some(payload.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn test_db() -> (AuditDb, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test_audit.db");
        let db = init_db(&db_path).unwrap();
        (db, dir)
    }

    // --- init_db ---

    #[test]
    fn init_db_creates_table() {
        let (db, _dir) = test_db();
        let conn = db.lock().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='audit_events'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn init_db_enables_wal_mode() {
        let (db, _dir) = test_db();
        let conn = db.lock().unwrap();
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
    }

    // --- insert_event + query ---

    #[test]
    fn insert_and_query_tool_use_event() {
        let (db, _dir) = test_db();
        insert_event(
            &db,
            "req-1",
            "tool_use",
            Some("read_file"),
            Some("call-1"),
            Some(0),
            None,
            Some(r#"{"args":{"path":"/tmp"}}"#),
        )
        .unwrap();

        let events = query_events(&db, &AuditFilter::default()).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "tool_use");
        assert_eq!(events[0].tool_name.as_deref(), Some("read_file"));
        assert_eq!(events[0].tool_call_id.as_deref(), Some("call-1"));
        assert_eq!(events[0].tier, Some(0));
        assert!(events[0].success.is_none());
    }

    #[test]
    fn insert_and_query_tool_result_event() {
        let (db, _dir) = test_db();
        insert_event(
            &db,
            "req-1",
            "tool_result",
            Some("read_file"),
            Some("call-1"),
            None,
            Some(true),
            Some(r#"{"output":"file contents"}"#),
        )
        .unwrap();

        let events = query_events(&db, &AuditFilter::default()).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "tool_result");
        assert_eq!(events[0].success, Some(true));
    }

    #[test]
    fn insert_and_query_usage_event() {
        let (db, _dir) = test_db();
        insert_event(
            &db,
            "req-1",
            "usage",
            None,
            None,
            None,
            None,
            Some(r#"{"inputTokens":100,"outputTokens":50,"cost":0.001,"model":"gemini"}"#),
        )
        .unwrap();

        let events = query_events(&db, &AuditFilter::default()).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "usage");
        assert!(events[0].payload.as_ref().unwrap().contains("0.001"));
    }

    #[test]
    fn insert_and_query_error_event() {
        let (db, _dir) = test_db();
        insert_event(
            &db,
            "req-1",
            "error",
            None,
            None,
            None,
            None,
            Some(r#"{"message":"something failed"}"#),
        )
        .unwrap();

        let events = query_events(&db, &AuditFilter::default()).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "error");
    }

    // --- Filtering ---

    #[test]
    fn filter_by_request_id() {
        let (db, _dir) = test_db();
        insert_event(&db, "req-1", "tool_use", Some("a"), None, None, None, None).unwrap();
        insert_event(&db, "req-2", "tool_use", Some("b"), None, None, None, None).unwrap();

        let filter = AuditFilter {
            request_id: Some("req-1".into()),
            ..Default::default()
        };
        let events = query_events(&db, &filter).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].request_id, "req-1");
    }

    #[test]
    fn filter_by_event_type() {
        let (db, _dir) = test_db();
        insert_event(&db, "req-1", "tool_use", Some("a"), None, None, None, None).unwrap();
        insert_event(&db, "req-1", "usage", None, None, None, None, None).unwrap();

        let filter = AuditFilter {
            event_type: Some("usage".into()),
            ..Default::default()
        };
        let events = query_events(&db, &filter).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "usage");
    }

    #[test]
    fn filter_by_tool_name() {
        let (db, _dir) = test_db();
        insert_event(
            &db,
            "req-1",
            "tool_use",
            Some("read_file"),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        insert_event(
            &db,
            "req-1",
            "tool_use",
            Some("write_file"),
            None,
            None,
            None,
            None,
        )
        .unwrap();

        let filter = AuditFilter {
            tool_name: Some("write_file".into()),
            ..Default::default()
        };
        let events = query_events(&db, &filter).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].tool_name.as_deref(), Some("write_file"));
    }

    #[test]
    fn filter_by_time_range() {
        let (db, _dir) = test_db();
        // Insert events - timestamps are auto-generated
        insert_event(&db, "req-1", "tool_use", Some("a"), None, None, None, None).unwrap();

        // Use a wide time range that includes everything
        let filter = AuditFilter {
            from: Some("2020-01-01T00:00:00".into()),
            to: Some("2099-12-31T23:59:59".into()),
            ..Default::default()
        };
        let events = query_events(&db, &filter).unwrap();
        assert_eq!(events.len(), 1);

        // Use a time range in the past that excludes everything
        let filter_past = AuditFilter {
            from: Some("2020-01-01T00:00:00".into()),
            to: Some("2020-01-02T00:00:00".into()),
            ..Default::default()
        };
        let events = query_events(&db, &filter_past).unwrap();
        assert_eq!(events.len(), 0);
    }

    #[test]
    fn filter_with_limit_and_offset() {
        let (db, _dir) = test_db();
        for i in 0..10 {
            insert_event(
                &db,
                &format!("req-{}", i),
                "tool_use",
                Some("t"),
                None,
                None,
                None,
                None,
            )
            .unwrap();
        }

        let filter = AuditFilter {
            limit: Some(3),
            offset: Some(2),
            ..Default::default()
        };
        let events = query_events(&db, &filter).unwrap();
        assert_eq!(events.len(), 3);
    }

    #[test]
    fn query_default_limit_100() {
        let (db, _dir) = test_db();
        for i in 0..150 {
            insert_event(
                &db,
                &format!("req-{}", i),
                "tool_use",
                Some("t"),
                None,
                None,
                None,
                None,
            )
            .unwrap();
        }

        let events = query_events(&db, &AuditFilter::default()).unwrap();
        assert_eq!(events.len(), 100);
    }

    #[test]
    fn query_max_limit_1000() {
        let (db, _dir) = test_db();
        // Even if user requests 5000, cap at 1000
        let filter = AuditFilter {
            limit: Some(5000),
            ..Default::default()
        };
        // With no data, result is 0, but the internal limit should be capped.
        // We test the cap by inserting 1010 rows and requesting 5000.
        for i in 0..1010 {
            insert_event(
                &db,
                &format!("req-{}", i),
                "tool_use",
                Some("t"),
                None,
                None,
                None,
                None,
            )
            .unwrap();
        }
        let events = query_events(&db, &filter).unwrap();
        assert_eq!(events.len(), 1000);
    }

    // --- Stats ---

    #[test]
    fn query_stats_aggregates_correctly() {
        let (db, _dir) = test_db();
        insert_event(
            &db,
            "req-1",
            "tool_use",
            Some("read_file"),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        insert_event(
            &db,
            "req-1",
            "tool_result",
            Some("read_file"),
            None,
            None,
            Some(true),
            None,
        )
        .unwrap();
        insert_event(
            &db,
            "req-1",
            "usage",
            None,
            None,
            None,
            None,
            Some(r#"{"inputTokens":100,"outputTokens":50,"cost":0.005,"model":"gemini"}"#),
        )
        .unwrap();
        insert_event(
            &db,
            "req-2",
            "usage",
            None,
            None,
            None,
            None,
            Some(r#"{"inputTokens":200,"outputTokens":100,"cost":0.010,"model":"gemini"}"#),
        )
        .unwrap();
        insert_event(
            &db,
            "req-2",
            "error",
            None,
            None,
            None,
            None,
            Some(r#"{"message":"err"}"#),
        )
        .unwrap();

        let stats = query_stats(&db).unwrap();
        assert_eq!(stats.total_events, 5);

        // by_event_type should have tool_use(1), tool_result(1), usage(2), error(1)
        let usage_count = stats
            .by_event_type
            .iter()
            .find(|(t, _)| t == "usage")
            .map(|(_, c)| *c)
            .unwrap_or(0);
        assert_eq!(usage_count, 2);

        // by_tool_name should have read_file(2)
        let rf_count = stats
            .by_tool_name
            .iter()
            .find(|(t, _)| t == "read_file")
            .map(|(_, c)| *c)
            .unwrap_or(0);
        assert_eq!(rf_count, 2);

        // total_cost = 0.005 + 0.010
        assert!((stats.total_cost - 0.015).abs() < 0.0001);
    }

    // --- maybe_log_event ---

    #[test]
    fn maybe_log_event_handles_tool_use() {
        let (db, _dir) = test_db();
        let chunk: serde_json::Value = serde_json::from_str(
            r#"{"type":"tool_use","requestId":"req-1","toolName":"read_file","toolCallId":"call-1","tier":0,"args":{"path":"/tmp"}}"#,
        )
        .unwrap();
        maybe_log_event(&db, &chunk);

        let events = query_events(&db, &AuditFilter::default()).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "tool_use");
        assert_eq!(events[0].tool_name.as_deref(), Some("read_file"));
    }

    #[test]
    fn maybe_log_event_handles_tool_result() {
        let (db, _dir) = test_db();
        let chunk: serde_json::Value = serde_json::from_str(
            r#"{"type":"tool_result","requestId":"req-1","toolName":"read_file","toolCallId":"call-1","success":true,"output":"data"}"#,
        )
        .unwrap();
        maybe_log_event(&db, &chunk);

        let events = query_events(&db, &AuditFilter::default()).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "tool_result");
        assert_eq!(events[0].success, Some(true));
    }

    #[test]
    fn maybe_log_event_handles_approval_request() {
        let (db, _dir) = test_db();
        let chunk: serde_json::Value = serde_json::from_str(
            r#"{"type":"approval_request","requestId":"req-1","toolName":"execute_command","toolCallId":"call-2","tier":2,"args":{"command":"rm -rf /"},"description":"dangerous"}"#,
        )
        .unwrap();
        maybe_log_event(&db, &chunk);

        let events = query_events(&db, &AuditFilter::default()).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "approval_request");
        assert_eq!(events[0].tier, Some(2));
    }

    #[test]
    fn maybe_log_event_handles_usage() {
        let (db, _dir) = test_db();
        let chunk: serde_json::Value = serde_json::from_str(
            r#"{"type":"usage","requestId":"req-1","inputTokens":100,"outputTokens":50,"cost":0.001,"model":"gemini"}"#,
        )
        .unwrap();
        maybe_log_event(&db, &chunk);

        let events = query_events(&db, &AuditFilter::default()).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "usage");
    }

    #[test]
    fn maybe_log_event_handles_error() {
        let (db, _dir) = test_db();
        let chunk: serde_json::Value = serde_json::from_str(
            r#"{"type":"error","requestId":"req-1","message":"something broke"}"#,
        )
        .unwrap();
        maybe_log_event(&db, &chunk);

        let events = query_events(&db, &AuditFilter::default()).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "error");
    }

    #[test]
    fn maybe_log_event_ignores_text() {
        let (db, _dir) = test_db();
        let chunk: serde_json::Value =
            serde_json::from_str(r#"{"type":"text","requestId":"req-1","text":"hello"}"#).unwrap();
        maybe_log_event(&db, &chunk);

        let events = query_events(&db, &AuditFilter::default()).unwrap();
        assert_eq!(events.len(), 0);
    }

    #[test]
    fn maybe_log_event_ignores_audio_and_finish() {
        let (db, _dir) = test_db();
        let audio: serde_json::Value =
            serde_json::from_str(r#"{"type":"audio","requestId":"req-1"}"#).unwrap();
        let finish: serde_json::Value =
            serde_json::from_str(r#"{"type":"finish","requestId":"req-1"}"#).unwrap();
        maybe_log_event(&db, &audio);
        maybe_log_event(&db, &finish);

        let events = query_events(&db, &AuditFilter::default()).unwrap();
        assert_eq!(events.len(), 0);
    }

    #[test]
    fn large_output_truncated_in_payload() {
        let (db, _dir) = test_db();
        let big_output = "x".repeat(8000);
        let chunk_json = format!(
            r#"{{"type":"tool_result","requestId":"req-1","toolName":"read_file","toolCallId":"call-1","success":true,"output":"{}"}}"#,
            big_output
        );
        let chunk: serde_json::Value = serde_json::from_str(&chunk_json).unwrap();
        maybe_log_event(&db, &chunk);

        let events = query_events(&db, &AuditFilter::default()).unwrap();
        assert_eq!(events.len(), 1);
        let payload = events[0].payload.as_ref().unwrap();
        assert!(payload.len() <= MAX_PAYLOAD_BYTES + 100); // some JSON overhead
    }

    #[test]
    fn large_output_with_multibyte_chars_truncated_safely() {
        let (db, _dir) = test_db();
        // Korean chars are 3 bytes each in UTF-8
        let big_output = "가".repeat(3000); // 9000 bytes
        let chunk_json = format!(
            r#"{{"type":"tool_result","requestId":"req-1","toolName":"read_file","toolCallId":"call-1","success":true,"output":"{}"}}"#,
            big_output
        );
        let chunk: serde_json::Value = serde_json::from_str(&chunk_json).unwrap();
        maybe_log_event(&db, &chunk);

        let events = query_events(&db, &AuditFilter::default()).unwrap();
        assert_eq!(events.len(), 1);
        let payload = events[0].payload.as_ref().unwrap();
        // Payload should be valid UTF-8 and not panic
        assert!(payload.len() <= MAX_PAYLOAD_BYTES + 100);
    }

    #[test]
    fn empty_db_returns_empty_results() {
        let (db, _dir) = test_db();
        let events = query_events(&db, &AuditFilter::default()).unwrap();
        assert_eq!(events.len(), 0);

        let stats = query_stats(&db).unwrap();
        assert_eq!(stats.total_events, 0);
        assert_eq!(stats.total_cost, 0.0);
    }
}
