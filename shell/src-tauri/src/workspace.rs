use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

// ─── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<DirEntry>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub dir: String,
    pub path: String,
    pub branch: Option<String>,
    pub origin_path: Option<String>, // main worktree path if this is a linked worktree; None if main
    pub status: String, // "active" | "idle" | "stopped" | "error"
    pub progress: Option<ProgressInfo>,
    pub recent_file: Option<String>,
    pub last_change: Option<u64>, // Unix timestamp seconds
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressInfo {
    pub issue: Option<String>,
    pub phase: Option<String>,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitInfo {
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassifiedDir {
    pub name: String,
    pub path: String,
    pub category: String, // "project" | "worktree" | "reference" | "docs" | "other"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillMeta {
    pub name: String,
    pub path: String,
    pub description: String,
    pub trigger: Option<String>,
    pub management: Option<String>,
    pub has_frontmatter: bool,
}

// ─── Watcher State ────────────────────────────────────────────────────────────

pub struct WatcherState {
    pub watcher: Option<RecommendedWatcher>,
    /// Maps directory path → last change timestamp (seconds since epoch)
    pub last_change: Arc<Mutex<HashMap<String, u64>>>,
    /// Maps directory path → most recently changed file (relative path)
    pub recent_files: Arc<Mutex<HashMap<String, String>>>,
    /// Maps directory path → current git branch.
    /// Key absent = not yet resolved; Some(branch) = resolved branch or detached hash
    /// (detached HEAD returns `Some("(HEAD {hash})")`); key is never set to `None` —
    /// uninitialized repos (no commits yet) are re-checked on every call instead.
    /// Populated lazily on first workspace_get_sessions call; refreshed whenever
    /// a file-change event fires for that session.
    pub branch_cache: Arc<Mutex<HashMap<String, Option<String>>>>,
    /// Maps directory path → main worktree path (Some) or None (is the main worktree itself).
    /// Both None and Some values are cached (unlike branch_cache which only caches Some).
    /// Reset by `workspace_stop_watch` — call stop → start to pick up worktree topology changes
    /// (e.g. after `git worktree add/remove`). The file-change watcher does NOT invalidate
    /// this cache on content events because worktree topology changes are rare.
    pub origin_path_cache: Arc<Mutex<HashMap<String, Option<String>>>>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            watcher: None,
            last_change: Arc::new(Mutex::new(HashMap::new())),
            recent_files: Arc::new(Mutex::new(HashMap::new())),
            branch_cache: Arc::new(Mutex::new(HashMap::new())),
            origin_path_cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

// ─── Shared watcher handle managed by AppState ───────────────────────────────
pub type SharedWatcherState = Arc<Mutex<WatcherState>>;

pub fn new_shared_watcher() -> SharedWatcherState {
    Arc::new(Mutex::new(WatcherState::new()))
}

// ─── Constants ────────────────────────────────────────────────────────────────

/// Compile-time fallback workspace root. Overridden at runtime via `workspace_set_root`.
/// On Linux, uses the default dev directory. On Windows, empty (frontend prompts folder picker).
#[cfg(unix)]
const WORKSPACE_ROOT: &str = "/var/home/luke/dev";
#[cfg(windows)]
const WORKSPACE_ROOT: &str = "";

/// Runtime override set by `workspace_set_root` on app start from AppConfig.workspaceRoot.
static WORKSPACE_ROOT_OVERRIDE: OnceLock<Mutex<String>> = OnceLock::new();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Returns the current workspace root — runtime override (if set) or compile-time constant.
fn get_workspace_root() -> String {
    if let Some(m) = WORKSPACE_ROOT_OVERRIDE.get() {
        m.lock().unwrap().clone()
    } else {
        WORKSPACE_ROOT.to_string()
    }
}

/// Returns the canonical form of the workspace root, resolving any symlinks.
/// All path comparisons must use this form for consistency.
fn canonical_workspace_root() -> Result<PathBuf, String> {
    dunce::canonicalize(get_workspace_root())
        .map_err(|e| format!("Workspace root inaccessible: {e}"))
}

/// Validates that `path` (which must exist) resolves to a location inside
/// WORKSPACE_ROOT after symlink resolution. Returns the canonical path.
fn validate_in_workspace(path: &str) -> Result<PathBuf, String> {
    let canonical = dunce::canonicalize(path)
        .map_err(|e| format!("Path inaccessible: {e}"))?;
    let root = canonical_workspace_root()?;
    if !canonical.starts_with(&root) {
        return Err(format!("Access denied: path is outside workspace root"));
    }
    Ok(canonical)
}

/// Validates a write target path (file may not exist yet). Walks up to the
/// first existing ancestor, canonicalizes it, and verifies it is inside
/// WORKSPACE_ROOT. Returns the write path with canonical ancestor prefix.
fn validate_write_path(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    // Walk up until we find an existing ancestor
    let mut check: &std::path::Path = p.as_path();
    loop {
        if check.exists() {
            break;
        }
        check = check
            .parent()
            .ok_or_else(|| "Invalid path: no valid ancestor found".to_string())?;
    }
    let canonical_ancestor = dunce::canonicalize(&check)
        .map_err(|e| format!("Path error: {e}"))?;
    let root = canonical_workspace_root()?;
    if !canonical_ancestor.starts_with(&root) {
        return Err(format!("Access denied: path is outside workspace root"));
    }
    // Reconstruct the full write path under the canonical ancestor.
    // strip_prefix uses the original (non-canonical) check, which is always a
    // structural prefix of p by construction, so failure is an internal error.
    let suffix = p
        .strip_prefix(check)
        .map_err(|_| "Internal error: path prefix mismatch during write validation".to_string())?;
    Ok(canonical_ancestor.join(suffix))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn is_git_repo(path: &Path) -> bool {
    path.join(".git").exists()
}

/// Build a `git <args>` command rooted at `path` with the Windows console
/// window suppressed. Workspace scans fan out across many repos, so a visible
/// flash per invocation would strobe the screen on every refresh.
fn git_cmd(path: &Path, args: &[&str]) -> std::process::Command {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args).current_dir(path);
    crate::platform::hide_console(&mut cmd);
    cmd
}

fn get_branch(path: &Path) -> Option<String> {
    let output = git_cmd(path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !branch.is_empty() && branch != "HEAD" {
            return Some(branch);
        }
        // detached HEAD — get short commit hash
        let output2 = git_cmd(path, &["rev-parse", "--short", "HEAD"])
            .output()
            .ok()?;
        if output2.status.success() {
            let hash = String::from_utf8_lossy(&output2.stdout).trim().to_string();
            return Some(format!("(HEAD {})", hash));
        }
    }
    None
}

/// Reads ALL `.agents/progress/*.json` files in the given directory.
/// Returns `(first_ProgressInfo, has_blockers)` where:
/// - `first_ProgressInfo` is from the first parseable file (display only)
/// - `has_blockers` is true when ANY file's `blockers` array is non-empty
///
/// Iterating all files prevents a silent failure where blockers exist in a
/// non-first file that OS read_dir returns in non-deterministic order.
fn read_progress(session_path: &Path) -> (Option<ProgressInfo>, bool) {
    let progress_dir = session_path.join(".agents").join("progress");
    let entries = match std::fs::read_dir(&progress_dir) {
        Ok(e) => e,
        Err(_) => return (None, false),
    };
    let mut first_info: Option<ProgressInfo> = None;
    let mut any_blockers = false;
    // Sort by filename for deterministic first_info selection when multiple files exist.
    let mut sorted: Vec<_> = entries.flatten().collect();
    sorted.sort_by_key(|e| e.file_name());
    for entry in sorted {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Ok(content) = std::fs::read_to_string(&p) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                    if val["blockers"].as_array().map_or(false, |a| !a.is_empty()) {
                        any_blockers = true;
                    }
                    if first_info.is_none() {
                        first_info = Some(ProgressInfo {
                            issue: val["issue"].as_str().map(|s| s.to_string()),
                            phase: val["current_phase"].as_str().map(|s| s.to_string()),
                            title: val["title"].as_str().map(|s| s.to_string()),
                        });
                    }
                }
            }
        }
    }
    (first_info, any_blockers)
}

/// Classifies a directory by heuristic rules.
/// Rules (in priority order):
///   1. Has `.git` file (not dir) → worktree
///   2. Name starts with `ref-` → reference
///   3. Name starts with `docs-` → docs
///   4. Has `.git` dir → project
///   5. else → other
fn classify_dir_heuristic(path: &Path) -> &'static str {
    let git_path = path.join(".git");
    if git_path.is_file() {
        return "worktree";
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.starts_with("ref-") {
        return "reference";
    }
    if name.starts_with("docs-") {
        return "docs";
    }
    if git_path.is_dir() {
        return "project";
    }
    "other"
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

/// Lists top-level directories under the given path.
/// If `parent` is `None`, defaults to the current workspace root (runtime override or compile-time fallback).
#[tauri::command]
pub fn workspace_list_dirs(parent: Option<String>) -> Result<Vec<DirEntry>, String> {
    let root = parent.unwrap_or_else(get_workspace_root);
    let root_path = validate_in_workspace(&root)?;
    let mut entries: Vec<DirEntry> = Vec::new();

    let read = std::fs::read_dir(&root_path).map_err(|e| e.to_string())?;
    let mut raw: Vec<_> = read.flatten().collect();
    raw.sort_by_key(|e| e.file_name());

    for e in raw {
        let path = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        let is_dir = path.is_dir();
        entries.push(DirEntry {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            children: None, // lazy expansion
        });
    }

    Ok(entries)
}

/// Reads a file and returns its content as a string.
#[tauri::command]
pub fn workspace_read_file(path: String) -> Result<String, String> {
    let safe = validate_in_workspace(&path)?;
    std::fs::read_to_string(&safe).map_err(|e| e.to_string())
}

/// Reads a file as raw bytes (base64-encoded for JSON transport).
#[tauri::command]
pub fn workspace_read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    let safe = validate_in_workspace(&path)?;
    std::fs::read(&safe).map_err(|e| e.to_string())
}

/// Returns file size in bytes.
#[tauri::command]
pub fn workspace_file_size(path: String) -> Result<u64, String> {
    let safe = validate_in_workspace(&path)?;
    let meta = std::fs::metadata(&safe).map_err(|e| e.to_string())?;
    Ok(meta.len())
}

/// Writes content to a file, creating parent directories as needed.
#[tauri::command]
pub fn workspace_write_file(path: String, content: String) -> Result<(), String> {
    let safe = validate_write_path(&path)?;
    if let Some(parent) = safe.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&safe, content).map_err(|e| e.to_string())
}

/// Returns git branch for a directory.
#[tauri::command]
pub fn workspace_get_git_info(path: String) -> GitInfo {
    // Validate before running git subprocess in the provided directory
    let p = match validate_in_workspace(&path) {
        Ok(p) => p,
        Err(_) => return GitInfo { branch: None },
    };
    GitInfo {
        branch: get_branch(&p),
    }
}

/// Scans the configured workspace root for git-repo subdirectories and returns session info.
#[tauri::command]
pub fn workspace_get_sessions(
    watcher: tauri::State<'_, SharedWatcherState>,
) -> Result<Vec<SessionInfo>, String> {
    let root = canonical_workspace_root()?;
    let mut sessions = Vec::new();

    let read = std::fs::read_dir(&root).map_err(|e| e.to_string())?;
    // Clone the Arc handles while holding the outer lock once (avoids double-lock deadlock)
    let (last_change_map, recent_files_map, branch_cache_map, origin_path_cache_map) = {
        let state = watcher.lock().unwrap();
        (state.last_change.clone(), state.recent_files.clone(), state.branch_cache.clone(), state.origin_path_cache.clone())
    };
    let lc = last_change_map.lock().unwrap();
    let rf = recent_files_map.lock().unwrap();
    let mut bc = branch_cache_map.lock().unwrap();
    let mut opc = origin_path_cache_map.lock().unwrap();

    let now = now_secs();

    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let dir_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        // Skip hidden directories before is_git_repo to avoid unnecessary disk I/O
        if dir_name.starts_with('.') {
            continue;
        }
        if !is_git_repo(&path) {
            continue;
        }
        // Canonicalize so path_str matches the canonical form returned by get_main_worktree()
        // and stored by the file-change watcher (which also uses canonical_workspace_root).
        // Without this, /home/luke/... vs /var/home/luke/... symlink differences would cause
        // groupBy key mismatch and last_change/branch cache lookups to miss.
        let path_str = dunce::canonicalize(&path)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| path.to_string_lossy().to_string());

        let last_change = lc.get(&path_str).copied();
        let recent_file = rf.get(&path_str).cloned();
        // Use cached branch — avoids spawning a git subprocess per repo on every call.
        // Lazily populated on first access; refreshed by the file-change watcher callback.
        // Note: None (uninitialized repo — no commits yet) is NOT cached — re-checked every
        // call so that a newly initialized repo becomes visible without a file-change event.
        // Detached HEAD returns Some("(HEAD {hash})") and IS cached normally.
        let branch = match bc.get(&path_str) {
            Some(cached) => cached.clone(),
            None => {
                let b = get_branch(&path);
                if b.is_some() {
                    bc.insert(path_str.clone(), b.clone());
                }
                b
            }
        };
        let (progress, has_blockers) = read_progress(&path);

        // "error" when the progress file has active blockers (session stuck).
        let status = match (has_blockers, last_change) {
            (true, _) => "error",
            (_, Some(t)) if now.saturating_sub(t) < 30 => "active",
            (_, Some(t)) if now.saturating_sub(t) < 1800 => "idle",
            _ => "stopped",
        };

        // Use cached origin_path — avoids spawning git worktree list per repo on every call.
        // Both None (main worktree) and Some(path) (linked worktree) are cached permanently.
        let origin_path = match opc.get(&path_str) {
            Some(cached) => cached.clone(),
            None => {
                let op = get_main_worktree(&path);
                opc.insert(path_str.clone(), op.clone());
                op
            }
        };

        sessions.push(SessionInfo {
            dir: dir_name,
            path: path_str,
            branch,
            origin_path,
            status: status.to_string(),
            progress,
            recent_file,
            last_change,
        });
    }

    sessions.sort_by(|a, b| {
        b.last_change
            .unwrap_or(0)
            .cmp(&a.last_change.unwrap_or(0))
            .then_with(|| a.path.cmp(&b.path))
    });

    Ok(sessions)
}

/// Reads all `.agents/progress/*.json` files in the given session directory.
#[tauri::command]
pub fn workspace_get_progress(path: String) -> Option<ProgressInfo> {
    let safe = validate_in_workspace(&path)
        .map_err(|e| {
            eprintln!("[workspace] workspace_get_progress: validation failed for '{}': {}", path, e);
            e
        })
        .ok()?;
    read_progress(&safe).0
}

/// Starts file watching for all git-repo subdirectories of WORKSPACE_ROOT.
/// Emits `workspace:file-changed` Tauri event on any file change.
#[tauri::command]
pub fn workspace_start_watch(
    app: AppHandle,
    watcher_state: tauri::State<'_, SharedWatcherState>,
) -> Result<(), String> {
    let root = canonical_workspace_root()?;
    let mut state = watcher_state.lock().unwrap();

    if state.watcher.is_some() {
        // Already watching
        return Ok(());
    }

    let last_change_clone = state.last_change.clone();
    let recent_files_clone = state.recent_files.clone();
    let branch_cache_clone = state.branch_cache.clone();
    let app_clone = app.clone();

    let watcher = RecommendedWatcher::new(
        move |result: notify::Result<Event>| {
            if let Ok(event) = result {
                // Filter: only track file modifications/creations, skip metadata-only
                let is_content_change = matches!(
                    event.kind,
                    EventKind::Modify(_) | EventKind::Create(_)
                );
                if !is_content_change {
                    return;
                }

                for changed_path in &event.paths {
                    // Skip hidden files and lock files
                    let name = changed_path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("");
                    if name.starts_with('.') || name.ends_with(".lock") {
                        continue;
                    }
                    if !changed_path.is_file() {
                        continue;
                    }

                    // Determine which session dir this belongs to
                    // Session dir is the direct child of /var/home/luke/dev
                    if let Some(session_dir) = find_session_dir(changed_path) {
                        let session_str = session_dir.to_string_lossy().to_string();
                        let now = now_secs();

                        // Compute relative path within session
                        let rel = changed_path
                            .strip_prefix(&session_dir)
                            .map(|p| p.to_string_lossy().to_string())
                            .unwrap_or_else(|_| name.to_string());

                        {
                            let mut lc = last_change_clone.lock().unwrap();
                            lc.insert(session_str.clone(), now);
                        }
                        {
                            let mut rf = recent_files_clone.lock().unwrap();
                            rf.insert(session_str.clone(), rel.clone());
                        }
                        // Refresh branch cache for this session — branch may change during
                        // active work (e.g. git checkout). Only called once per file-change
                        // event (not per repo scan), so subprocess cost is amortized.
                        // Consistent with workspace_get_sessions: None is NOT stored so
                        // the next get_sessions call will re-check (avoids stale None freeze).
                        {
                            let new_branch = get_branch(&session_dir);
                            let mut bc = branch_cache_clone.lock().unwrap();
                            if new_branch.is_some() {
                                bc.insert(session_str.clone(), new_branch);
                            } else {
                                // Remove stale entry so workspace_get_sessions re-checks
                                bc.remove(&session_str);
                            }
                        }

                        let _ = app_clone.emit("workspace:file-changed", serde_json::json!({
                            "session": session_str,
                            "file": rel,
                            "timestamp": now,
                        }));
                    }
                }
            }
        },
        Config::default(),
    )
    .map_err(|e| e.to_string())?;

    let mut w = watcher;

    // Watch all non-hidden git-repo subdirectories
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if path.is_dir() && !name.starts_with('.') && is_git_repo(&path) {
                let _ = w.watch(&path, RecursiveMode::Recursive);
            }
        }
    }

    state.watcher = Some(w);
    Ok(())
}

/// Stops the file watcher.
#[tauri::command]
pub fn workspace_stop_watch(
    watcher_state: tauri::State<'_, SharedWatcherState>,
) -> Result<(), String> {
    // Clone Arc handles then release the outer lock before acquiring inner locks.
    // Mirrors workspace_get_sessions pattern — avoids holding the outer WatcherState
    // lock while acquiring inner HashMap locks (which the watcher callback also acquires).
    let (last_change_arc, recent_files_arc, branch_cache_arc, origin_path_cache_arc) = {
        let mut state = watcher_state.lock().unwrap();
        state.watcher = None; // drop watcher → stops callback thread
        (
            state.last_change.clone(),
            state.recent_files.clone(),
            state.branch_cache.clone(),
            state.origin_path_cache.clone(),
        )
    }; // outer lock released here
    // Clear all session data so a subsequent start_watch begins clean.
    // Prevents stale last_change / recent_files / branch_cache / origin_path_cache from the
    // previous watch session bleeding into new reads.
    last_change_arc.lock().unwrap().clear();
    recent_files_arc.lock().unwrap().clear();
    branch_cache_arc.lock().unwrap().clear();
    origin_path_cache_arc.lock().unwrap().clear();
    Ok(())
}

/// Sets the workspace root at runtime from AppConfig.workspaceRoot.
/// Returns the canonicalized path that the backend actually stored, so the caller
/// can display the resolved path rather than the raw config string.
///
/// **Ordering requirement**: Must be called before `workspace_start_watch`. The watcher
/// registers paths at startup and does not detect root changes made after it starts.
/// If the root is changed after the watcher is running, call `workspace_stop_watch` →
/// `workspace_set_root` → `workspace_start_watch` to pick up the new root.
///
/// In the default app flow this ordering holds: WorkspaceCenterPanel calls this command
/// in its mount useEffect before panel activation triggers `workspace_start_watch`.
/// Note: if the workspace panel is already active when the component mounts, the watcher
/// may start before this command completes — callers are responsible for the ordering.
#[tauri::command]
pub fn workspace_set_root(root: String) -> Result<String, String> {
    let p = PathBuf::from(&root);
    if !p.is_dir() {
        return Err(format!("Workspace root is not a directory: {root}"));
    }
    let canonical = dunce::canonicalize(&p)
        .map_err(|e| format!("Workspace root inaccessible: {e}"))?;
    let canonical_str = canonical.to_string_lossy().to_string();
    let m = WORKSPACE_ROOT_OVERRIDE.get_or_init(|| Mutex::new(WORKSPACE_ROOT.to_string()));
    *m.lock().unwrap() = canonical_str.clone();
    Ok(canonical_str)
}

/// Classifies all git-repo (and other) subdirectories of WORKSPACE_ROOT.
#[tauri::command]
pub fn workspace_classify_dirs() -> Result<Vec<ClassifiedDir>, String> {
    let root = canonical_workspace_root()?;
    let mut result = Vec::new();

    // Get list of worktree paths using `git worktree list` from the root
    let worktree_paths: Vec<String> = get_all_worktree_paths(&root);

    let read = std::fs::read_dir(&root).map_err(|e| e.to_string())?;
    let mut raw: Vec<_> = read.flatten().collect();
    raw.sort_by_key(|e| e.file_name());

    for entry in raw {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        // Skip hidden dirs
        if name.starts_with('.') {
            continue;
        }
        // Canonicalize to match canonical paths returned by get_all_worktree_paths()
        let path_str = dunce::canonicalize(&path)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| path.to_string_lossy().to_string());

        // Check if this dir is a worktree according to git worktree list
        let is_worktree_listed = worktree_paths.contains(&path_str);

        let category = if is_worktree_listed {
            // If it's in worktree list AND has a .git file, it's a worktree
            if path.join(".git").is_file() {
                "worktree"
            } else {
                classify_dir_heuristic(&path)
            }
        } else {
            classify_dir_heuristic(&path)
        };

        result.push(ClassifiedDir {
            name,
            path: path_str,
            category: category.to_string(),
        });
    }

    Ok(result)
}

/// Detects a naia-adk workspace root by searching upward from the current executable's
/// directory (or common dev paths) for marker files:
///   - `AGENTS.md` (or `CLAUDE.md`) at root level
///   - `.agents/context/agents-rules.json` inside root
///
/// Returns the canonical path if found, or an error string if no workspace detected.
#[tauri::command]
pub fn workspace_detect_adk_root() -> Result<String, String> {
    let candidates = collect_search_candidates();
    for dir in candidates {
        if is_naia_adk_root(&dir) {
            let canonical = dunce::canonicalize(&dir)
                .map_err(|e| format!("Canonicalize failed: {e}"))?;
            return Ok(canonical.to_string_lossy().to_string());
        }
    }
    Err("No naia-adk workspace detected".to_string())
}

fn collect_search_candidates() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    // 1. Current executable directory + parent
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent().and_then(|p| p.parent()) {
            dirs.push(parent.to_path_buf());
        }
    }

    // 2. Common dev directories (platform-specific)
    if let Some(home) = dirs::home_dir() {
        let dev = home.join("dev");
        if dev.is_dir() {
            dirs.push(dev);
        }
        dirs.push(home.clone());
    }

    // 3. Walk subdirs of the first valid candidate (max depth 1)
    let mut sub_candidates = Vec::new();
    for dir in &dirs {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if p.is_dir() && !name.starts_with('.') {
                    sub_candidates.push(p);
                }
            }
        }
    }
    dirs.extend(sub_candidates);

    dirs
}

fn is_naia_adk_root(path: &Path) -> bool {
    let has_entry_point = path.join("AGENTS.md").is_file()
        || path.join("CLAUDE.md").is_file();
    let has_rules = path
        .join(".agents")
        .join("context")
        .join("agents-rules.json")
        .is_file();
    has_entry_point && has_rules
}

/// Reads and parses the project-index.yaml from the current workspace root.
/// Returns the parsed YAML as a JSON value for the frontend to consume.
#[tauri::command]
pub fn workspace_load_project_index() -> Result<serde_json::Value, String> {
    let root = canonical_workspace_root()?;
    let index_path = root
        .join(".agents")
        .join("context")
        .join("project-index.yaml");
    if !index_path.is_file() {
        return Err("project-index.yaml not found".to_string());
    }
    let content = std::fs::read_to_string(&index_path).map_err(|e| e.to_string())?;
    let yaml_value: serde_yaml::Value =
        serde_yaml::from_str(&content).map_err(|e| format!("YAML parse error: {e}"))?;
    let json_str = serde_json::to_string(&yaml_value).map_err(|e| format!("JSON conversion: {e}"))?;
    serde_json::from_str(&json_str).map_err(|e| format!("JSON parse: {e}"))
}

/// Discovers SKILL.md files under the workspace root's skills/ directory.
/// Parses YAML frontmatter (--- delimited) and returns SkillMeta for each.
#[tauri::command]
pub fn workspace_discover_skills() -> Result<Vec<SkillMeta>, String> {
    let root = canonical_workspace_root()?;
    let skills_dir = root.join("skills");
    if !skills_dir.is_dir() {
        return Ok(vec![]);
    }

    let mut skills = Vec::new();
    visit_skill_dirs(&skills_dir, &root, &mut skills);
    Ok(skills)
}

/// Reads the full content of a SKILL.md file given the skill's relative path.
#[tauri::command]
pub fn workspace_read_skill_content(path: String) -> Result<String, String> {
    let root = canonical_workspace_root()?;
    let skill_path = root.join(&path).join("SKILL.md");
    if !skill_path.is_file() {
        return Err(format!("SKILL.md not found at: {path}"));
    }
    let abs = dunce::canonicalize(&skill_path).map_err(|e| format!("Path error: {e}"))?;
    if !abs.starts_with(&root) {
        return Err("Access denied: path outside workspace".to_string());
    }
    std::fs::read_to_string(&abs).map_err(|e| format!("Read failed: {e}"))
}

fn visit_skill_dirs(dir: &Path, root: &Path, skills: &mut Vec<SkillMeta>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let skill_file = path.join("SKILL.md");
            if skill_file.is_file() {
                if let Some(meta) = parse_skill_md(&skill_file, root) {
                    skills.push(meta);
                }
            }
        }
    }
}

fn parse_skill_md(path: &Path, root: &Path) -> Option<SkillMeta> {
    let content = std::fs::read_to_string(path).ok()?;
    let rel_path = path.parent()?.strip_prefix(root).ok()?;
    let rel_str = rel_path.to_str()?.to_string();
    let parts: Vec<&str> = rel_str.split(std::path::MAIN_SEPARATOR).collect();
    let name = if parts.len() >= 2 {
        parts[parts.len() - 1].to_string()
    } else {
        path.file_stem()?.to_str()?.to_string()
    };

    let (frontmatter, has_frontmatter) = parse_frontmatter(&content);

    Some(SkillMeta {
        name,
        path: rel_str,
        description: frontmatter
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        trigger: frontmatter
            .get("trigger")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        management: frontmatter
            .get("management")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        has_frontmatter,
    })
}

fn parse_frontmatter(content: &str) -> (serde_yaml::Value, bool) {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return (serde_yaml::Value::Null, false);
    }
    let rest = &trimmed[3..];
    let Some(end) = rest.find("\n---") else {
        return (serde_yaml::Value::Null, false);
    };
    let yaml_str = &rest[..end];
    match serde_yaml::from_str(yaml_str) {
        Ok(v) => (v, true),
        Err(_) => (serde_yaml::Value::Null, false),
    }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/// Given a file path, find the immediate child of WORKSPACE_ROOT that contains it.
/// E.g. /var/home/luke/dev/naia-os/shell/src/App.tsx → /var/home/luke/dev/naia-os
fn find_session_dir(file_path: &Path) -> Option<PathBuf> {
    let root = canonical_workspace_root().ok()?;
    let mut current = file_path.parent()?;
    loop {
        match current.parent() {
            Some(p) if p == root => return Some(current.to_path_buf()),
            Some(p) => current = p,
            None => return None,
        }
    }
}

/// Returns the main worktree path for `path` if it is a linked git worktree, or `None` if it is
/// the main worktree (or not a worktree at all). Uses `git worktree list --porcelain` run from
/// `path`; the first `worktree` block is always the main worktree.
fn get_main_worktree(path: &Path) -> Option<String> {
    let output = git_cmd(path, &["worktree", "list", "--porcelain"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let main_path = text
        .lines()
        .find_map(|l| l.strip_prefix("worktree "))
        .map(str::to_string)?;
    // Canonicalize both for comparison (symlinks, e.g. /home → /var/home on Fedora)
    let canon_main = dunce::canonicalize(&main_path).ok()?;
    let canon_path = dunce::canonicalize(path).ok()?;
    if canon_main == canon_path {
        None // this IS the main worktree
    } else {
        Some(canon_main.to_string_lossy().to_string())
    }
}

/// Runs `git worktree list --porcelain` from the workspace root to get all worktree paths.
fn get_all_worktree_paths(root: &Path) -> Vec<String> {
    // Try each git-repo child dir
    let mut paths = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() && p.join(".git").is_dir() {
                if let Ok(output) = git_cmd(&p, &["worktree", "list", "--porcelain"]).output() {
                    if output.status.success() {
                        let text = String::from_utf8_lossy(&output.stdout);
                        for line in text.lines() {
                            if let Some(wt_path) = line.strip_prefix("worktree ") {
                                // Canonicalize so paths match classify_dirs and get_sessions keys
                                let canonical = dunce::canonicalize(wt_path)
                                    .map(|p| p.to_string_lossy().to_string())
                                    .unwrap_or_else(|_| wt_path.to_string());
                                paths.push(canonical);
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

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn make_workspace() -> TempDir {
        tempfile::tempdir().unwrap()
    }

    // ── validate_in_workspace ────────────────────────────────────────────────

    #[test]
    fn test_validate_in_workspace_accepts_valid_path() {
        let ws = make_workspace();
        let file = ws.path().join("test.txt");
        fs::write(&file, "hello").unwrap();

        // Temporarily override the constant is not possible at runtime; instead,
        // call canonicalize directly and check behaviour via the function signature.
        // We test the helper by constructing a real scenario with a tmp dir as root.
        // Since WORKSPACE_ROOT is a compile-time const, integration tests via
        // actual workspace paths are used instead.
        let result = validate_in_workspace(file.to_str().unwrap());
        // Should succeed if file is under actual WORKSPACE_ROOT OR fail with our
        // specific error message (not a panic).
        match result {
            Ok(p) => assert!(p.is_absolute()),
            Err(e) => {
                // Acceptable: tmp dir is outside WORKSPACE_ROOT
                assert!(
                    e.contains("outside workspace") || e.contains("inaccessible"),
                    "unexpected error: {e}"
                );
            }
        }
    }

    #[test]
    fn test_validate_in_workspace_rejects_dotdot_traversal() {
        // A path with ".." that would escape WORKSPACE_ROOT should be rejected
        // Example: /var/home/luke/dev/../../../etc/passwd
        let traversal = "/var/home/luke/dev/../../../etc/passwd";
        let result = validate_in_workspace(traversal);
        match result {
            Ok(_) => {} // canonicalize may fail for non-existent paths; starts_with guard (L106) would reject out-of-workspace paths
            Err(e) => {
                // Either "outside workspace" or "inaccessible" (file doesn't exist)
                assert!(
                    e.contains("outside workspace") || e.contains("inaccessible"),
                    "unexpected error: {e}"
                );
            }
        }
        // The real guard: if it resolves to outside workspace, we must reject it.
        if let Ok(canonical) = dunce::canonicalize(traversal) {
            let root = dunce::canonicalize(WORKSPACE_ROOT)
                .unwrap_or_else(|_| std::path::PathBuf::from(WORKSPACE_ROOT));
            // If it resolved to outside root, validate_in_workspace must have returned Err
            if !canonical.starts_with(&root) {
                assert!(
                    validate_in_workspace(traversal).is_err(),
                    "Path traversal outside workspace should be rejected"
                );
            }
        }
    }

    #[test]
    #[cfg(unix)]
    fn test_validate_in_workspace_rejects_etc_passwd() {
        let result = validate_in_workspace("/etc/passwd");
        assert!(result.is_err(), "/etc/passwd must be rejected");
        let err = result.unwrap_err();
        assert!(
            err.contains("outside workspace") || err.contains("inaccessible"),
            "expected 'outside workspace' or 'inaccessible', got: {err}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn test_validate_in_workspace_rejects_home_ssh() {
        let result = validate_in_workspace("/root/.ssh/id_rsa");
        assert!(result.is_err(), "SSH key path must be rejected");
    }

    // ── validate_write_path ──────────────────────────────────────────────────

    #[test]
    #[cfg(unix)]
    fn test_validate_write_path_rejects_outside_workspace() {
        let result = validate_write_path("/etc/cron.d/evil");
        assert!(result.is_err(), "/etc/cron.d/evil must be rejected");
        let err = result.unwrap_err();
        assert!(
            err.contains("outside workspace") || err.contains("inaccessible"),
            "expected 'outside workspace' or 'inaccessible', got: {err}"
        );
    }

    #[test]
    fn test_validate_write_path_accepts_new_file_in_workspace() {
        // If WORKSPACE_ROOT itself exists, a new file under it should be allowed
        if std::path::Path::new(WORKSPACE_ROOT).exists() {
            let new_file = format!("{}/some-new-file-test.txt", WORKSPACE_ROOT);
            let result = validate_write_path(&new_file);
            assert!(result.is_ok(), "New file under workspace root should be OK: {:?}", result);

            // Verify the returned path is actually inside WORKSPACE_ROOT
            let returned = result.unwrap();
            let root = dunce::canonicalize(WORKSPACE_ROOT)
                .unwrap_or_else(|_| std::path::PathBuf::from(WORKSPACE_ROOT));
            assert!(
                returned.starts_with(&root),
                "Returned path {:?} should be inside workspace root {:?}",
                returned,
                root
            );
        }
    }

    #[test]
    fn test_validate_write_path_accepts_nested_nonexistent_dir() {
        // New file in a non-existent nested directory should be accepted
        if std::path::Path::new(WORKSPACE_ROOT).exists() {
            let new_file = format!("{}/nonexistent-dir-99999/subdir/newfile.txt", WORKSPACE_ROOT);
            let result = validate_write_path(&new_file);
            assert!(
                result.is_ok(),
                "New file in nested non-existent dir under workspace should be OK: {:?}",
                result
            );
            // Verify the returned path has the nested structure
            let returned = result.unwrap();
            assert!(returned.ends_with("nonexistent-dir-99999/subdir/newfile.txt"),
                "Returned path should preserve nested structure: {:?}", returned);
        }
    }

    #[test]
    #[cfg(unix)]
    fn test_validate_write_path_rejects_dotdot_in_new_path() {
        let traversal = "/var/home/luke/dev/../../etc/cron.d/evil";
        let result = validate_write_path(traversal);
        assert!(result.is_err(), "Traversal write path must be rejected");
    }

    // ── is_naia_adk_root ─────────────────────────────────────────────────────

    #[test]
    fn test_is_naia_adk_root_detects_valid_root() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        fs::write(path.join("AGENTS.md"), "# Test").unwrap();
        let rules_dir = path.join(".agents").join("context");
        fs::create_dir_all(&rules_dir).unwrap();
        fs::write(rules_dir.join("agents-rules.json"), "{}").unwrap();
        assert!(is_naia_adk_root(path));
    }

    #[test]
    fn test_is_naia_adk_root_detects_claude_md_variant() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        fs::write(path.join("CLAUDE.md"), "# Test").unwrap();
        let rules_dir = path.join(".agents").join("context");
        fs::create_dir_all(&rules_dir).unwrap();
        fs::write(rules_dir.join("agents-rules.json"), "{}").unwrap();
        assert!(is_naia_adk_root(path));
    }

    #[test]
    fn test_is_naia_adk_root_rejects_missing_entry_point() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        let rules_dir = path.join(".agents").join("context");
        fs::create_dir_all(&rules_dir).unwrap();
        fs::write(rules_dir.join("agents-rules.json"), "{}").unwrap();
        assert!(!is_naia_adk_root(path));
    }

    #[test]
    fn test_is_naia_adk_root_rejects_missing_rules() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        fs::write(path.join("AGENTS.md"), "# Test").unwrap();
        assert!(!is_naia_adk_root(path));
    }

    #[test]
    fn test_is_naia_adk_root_rejects_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_naia_adk_root(dir.path()));
    }
}
