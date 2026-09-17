use std::path::PathBuf;
use tauri::AppHandle;

use super::api::{herdr_api_output, herdr_protocol_supported, unsupported_herdr_protocol};
use super::config::write_embedded_herdr_config;

/// Resolve a terminal-reported path against its pane CWD, then enforce the
/// active workspace root after canonicalization. This keeps home expansion,
/// symlink handling, and containment checks out of the WebView.
#[tauri::command]
pub async fn workspace_resolve_file_location(
    app: AppHandle,
    path: String,
    expected_workspace_id: String,
    expected_pane_id: Option<String>,
) -> Result<String, String> {
    let config_path = write_embedded_herdr_config(&app)?;
    tokio::task::spawn_blocking(move || {
        let raw = herdr_api_output(&config_path, &["api", "snapshot"])?;
        let envelope: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| format!("Invalid Herdr snapshot: {e}"))?;
        let snapshot = envelope
            .pointer("/result/snapshot")
            .ok_or_else(|| "Herdr snapshot payload missing".to_string())?;
        let protocol = snapshot
            .get("protocol")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| "Herdr snapshot protocol missing".to_string())?;
        if !herdr_protocol_supported(protocol) {
            return Err(unsupported_herdr_protocol(protocol));
        }
        let (workspace_id, pane_id, cwd, root) = focused_location_context(snapshot)?;
        ensure_expected_focus(
            workspace_id,
            pane_id,
            &expected_workspace_id,
            expected_pane_id.as_deref(),
        )?;
        resolve_file_location(&path, cwd, root)
    })
    .await
    .map_err(|e| format!("Herdr file resolution task failed: {e}"))?
}

fn ensure_expected_focus(
    workspace_id: &str,
    pane_id: Option<&str>,
    expected_workspace_id: &str,
    expected_pane_id: Option<&str>,
) -> Result<(), String> {
    if workspace_id != expected_workspace_id || pane_id != expected_pane_id {
        return Err("Herdr focus changed while resolving file location".to_string());
    }
    Ok(())
}

fn focused_location_context(
    snapshot: &serde_json::Value,
) -> Result<(&str, Option<&str>, &str, &str), String> {
    let focused_workspace_id = snapshot
        .get("focused_workspace_id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Herdr focused workspace missing".to_string())?;
    let workspace = snapshot
        .get("workspaces")
        .and_then(serde_json::Value::as_array)
        .and_then(|items| {
            items.iter().find(|item| {
                item.get("workspace_id").and_then(serde_json::Value::as_str)
                    == Some(focused_workspace_id)
            })
        })
        .ok_or_else(|| "Herdr focused workspace not found".to_string())?;
    let focused_pane_id = snapshot
        .get("focused_pane_id")
        .and_then(serde_json::Value::as_str);
    let agent = snapshot
        .get("agents")
        .and_then(serde_json::Value::as_array)
        .and_then(|items| {
            items.iter().find(|item| {
                item.get("pane_id").and_then(serde_json::Value::as_str) == focused_pane_id
            })
        });
    let root = workspace
        .pointer("/worktree/checkout_path")
        .and_then(serde_json::Value::as_str)
        .or_else(|| agent.and_then(|item| item.get("cwd")?.as_str()))
        .ok_or_else(|| "Herdr active workspace root missing".to_string())?;
    let cwd = agent
        .and_then(|item| {
            item.get("foreground_cwd")
                .and_then(serde_json::Value::as_str)
        })
        .or_else(|| agent.and_then(|item| item.get("cwd").and_then(serde_json::Value::as_str)))
        .unwrap_or(root);
    Ok((focused_workspace_id, focused_pane_id, cwd, root))
}

fn resolve_file_location(path: &str, cwd: &str, root: &str) -> Result<String, String> {
    let candidate = if let Some(relative) = path.strip_prefix("~/") {
        crate::data_home::user_home_path()
            .ok_or_else(|| "Home directory unavailable".to_string())?
            .join(relative)
    } else {
        let path = PathBuf::from(path);
        if path.is_absolute() {
            path
        } else {
            PathBuf::from(cwd).join(path)
        }
    };
    let canonical =
        dunce::canonicalize(&candidate).map_err(|e| format!("Path inaccessible: {e}"))?;
    let canonical_root =
        dunce::canonicalize(root).map_err(|e| format!("Workspace root inaccessible: {e}"))?;
    if !canonical_root.is_dir() {
        return Err("Workspace root is not a directory".to_string());
    }
    if !canonical.starts_with(&canonical_root) {
        return Err("Access denied: path is outside workspace root".to_string());
    }
    if !canonical.is_file() {
        return Err("Path is not a file".to_string());
    }
    Ok(canonical.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::{ensure_expected_focus, focused_location_context, resolve_file_location};

    #[test]
    fn rejects_file_resolution_after_workspace_or_pane_focus_changes() {
        assert!(ensure_expected_focus("w2", Some("w2:p2"), "w2", Some("w2:p2")).is_ok());
        assert!(ensure_expected_focus("w3", Some("w3:p1"), "w2", Some("w2:p2")).is_err());
        assert!(ensure_expected_focus("w2", Some("w2:p3"), "w2", Some("w2:p2")).is_err());
        assert!(ensure_expected_focus("w2", None, "w2", Some("w2:p2")).is_err());
    }

    #[test]
    fn selects_the_focused_pane_foreground_cwd_and_its_workspace_root() {
        let snapshot = serde_json::json!({
            "focused_workspace_id": "w2",
            "focused_pane_id": "w2:p2",
            "workspaces": [
                { "workspace_id": "w1", "worktree": { "checkout_path": "/work/alpha" } },
                { "workspace_id": "w2", "worktree": { "checkout_path": "/work/beta" } }
            ],
            "agents": [
                { "pane_id": "w2:p1", "cwd": "/work/beta/other" },
                { "pane_id": "w2:p2", "cwd": "/work/beta", "foreground_cwd": "/work/beta/packages/shell" }
            ]
        });

        assert_eq!(
            focused_location_context(&snapshot).unwrap(),
            (
                "w2",
                Some("w2:p2"),
                "/work/beta/packages/shell",
                "/work/beta"
            )
        );
    }

    #[test]
    fn resolves_relative_paths_and_rejects_escape_from_explicit_root() {
        let base =
            std::env::temp_dir().join(format!("naia-workspace-location-{}", std::process::id()));
        let root = base.join("root");
        let cwd = root.join("src");
        let outside = base.join("outside.txt");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::write(cwd.join("main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(&outside, "outside\n").unwrap();

        let resolved =
            resolve_file_location("main.rs", &cwd.to_string_lossy(), &root.to_string_lossy())
                .unwrap();
        assert_eq!(resolved, cwd.join("main.rs").to_string_lossy());
        assert!(resolve_file_location(
            &outside.to_string_lossy(),
            &cwd.to_string_lossy(),
            &root.to_string_lossy(),
        )
        .unwrap_err()
        .contains("outside workspace root"));
        assert!(resolve_file_location(
            "missing.rs",
            &cwd.to_string_lossy(),
            &root.to_string_lossy(),
        )
        .unwrap_err()
        .contains("Path inaccessible"));
        assert!(
            resolve_file_location(".", &cwd.to_string_lossy(), &root.to_string_lossy())
                .unwrap_err()
                .contains("not a file")
        );

        std::fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let base = std::env::temp_dir().join(format!(
            "naia-workspace-symlink-location-{}",
            std::process::id()
        ));
        let root = base.join("root");
        let outside = base.join("outside.txt");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&outside, "outside\n").unwrap();
        symlink(&outside, root.join("escape.txt")).unwrap();

        assert!(resolve_file_location(
            "escape.txt",
            &root.to_string_lossy(),
            &root.to_string_lossy(),
        )
        .unwrap_err()
        .contains("outside workspace root"));

        std::fs::remove_dir_all(base).unwrap();
    }
}
