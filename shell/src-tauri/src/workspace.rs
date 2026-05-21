use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

// --- Types -------------------------------------------------------------------

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
    pub status: String,              // "active" | "idle" | "stopped" | "error"
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

// --- Watcher State -----------------------------------------------------------

pub struct WatcherState {
    pub watcher: Option<RecommendedWatcher>,
    /// Maps directory path -> last change timestamp (seconds since epoch)
    pub last_change: Arc<Mutex<HashMap<String, u64>>>,
    /// Maps directory path -> most recently changed file (relative path)
    pub recent_files: Arc<Mutex<HashMap<String, String>>>,
    /// Maps directory path -> current git branch.
    pub branch_cache: Arc<Mutex<HashMap<String, Option<String>>>>,
    /// Maps directory path -> main worktree path (Some) or None (is the main worktree itself).
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

// --- Shared watcher handle managed by AppState -------------------------------
pub type SharedWatcherState = Arc<Mutex<WatcherState>>;

pub fn new_shared_watcher() -> SharedWatcherState {
    Arc::new(Mutex::new(WatcherState::new()))
}

// --- Constants ---------------------------------------------------------------

#[cfg(unix)]
const WORKSPACE_ROOT: &str = "/var/home/luke/dev";
#[cfg(windows)]
const WORKSPACE_ROOT: &str = "";

static WORKSPACE_ROOT_OVERRIDE: OnceLock<Mutex<String>> = OnceLock::new();

// --- Helpers -----------------------------------------------------------------

fn get_workspace_root() -> String {
    if let Some(m) = WORKSPACE_ROOT_OVERRIDE.get() {
        m.lock().unwrap().clone()
    } else {
        WORKSPACE_ROOT.to_string()
    }
}

fn canonical_workspace_root() -> Result<PathBuf, String> {
    dunce::canonicalize(get_workspace_root())
        .map_err(|e| format!("Workspace root inaccessible: {e}"))
}

fn validate_in_workspace(path: &str) -> Result<PathBuf, String> {
    let canonical = dunce::canonicalize(path).map_err(|e| format!("Path inaccessible: {e}"))?;
    let root = canonical_workspace_root()?;
    if !canonical.starts_with(&root) {
        return Err(format!("Access denied: path is outside workspace root"));
    }
    Ok(canonical)
}

fn validate_write_path(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let mut check: &std::path::Path = p.as_path();
    loop {
        if check.exists() {
            break;
        }
        check = check
            .parent()
            .ok_or_else(|| "Invalid path: no valid ancestor found".to_string())?;
    }
    let canonical_ancestor = dunce::canonicalize(&check).map_err(|e| format!("Path error: {e}"))?;
    let root = canonical_workspace_root()?;
    if !canonical_ancestor.starts_with(&root) {
        return Err(format!("Access denied: path is outside workspace root"));
    }
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

fn push_git_dir(
    candidates: &mut Vec<PathBuf>,
    seen: &mut std::collections::HashSet<PathBuf>,
    path: PathBuf,
) {
    if !path.is_dir() || !is_git_repo(&path) {
        return;
    }
    let canonical = dunce::canonicalize(&path).unwrap_or(path);
    if seen.insert(canonical.clone()) {
        candidates.push(canonical);
    }
}

pub fn collect_workspace_git_dirs(root: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let mut seen = std::collections::HashSet::new();

    push_git_dir(&mut candidates, &mut seen, root.to_path_buf());

    let read = match std::fs::read_dir(root) {
        Ok(read) => read,
        Err(_) => return candidates,
    };
    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let dir_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if dir_name.starts_with('.') {
            continue;
        }
        push_git_dir(&mut candidates, &mut seen, path.clone());

        // Also look into 'projects/' folder if it exists
        if dir_name == "projects" {
            if let Ok(projects) = std::fs::read_dir(&path) {
                for project in projects.flatten() {
                    push_git_dir(&mut candidates, &mut seen, project.path());
                }
            }
        }
    }

    candidates
}

fn git_cmd(path: &Path, args: &[&str]) -> std::process::Command {
    let mut cmd = std::process::Command::new("git");
    cmd.current_dir(path).args(args);
    crate::platform::hide_console(&mut cmd);
    cmd
}

fn get_branch(path: &Path) -> Option<String> {
    let output = git_cmd(path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let b = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if b == "HEAD" {
        // detached HEAD, get hash
        let output = git_cmd(path, &["rev-parse", "--short", "HEAD"])
            .output()
            .ok()?;
        if output.status.success() {
            let hash = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Some(format!("(HEAD {})", hash));
        }
    }
    Some(b)
}

fn read_progress(path: &Path) -> (Option<ProgressInfo>, bool) {
    let progress_dir = path.join(".agents").join("progress");
    if !progress_dir.is_dir() {
        return (None, false);
    }
    let mut latest_file = None;
    let mut latest_time = 0;
    let mut has_blockers = false;

    if let Ok(entries) = std::fs::read_dir(progress_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().map_or(false, |ext| ext == "json") {
                if let Ok(meta) = p.metadata() {
                    if let Ok(time) = meta.modified() {
                        let secs = time
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs();
                        if secs > latest_time {
                            latest_time = secs;
                            latest_file = Some(p.clone());
                        }
                    }
                }
                // check blockers in all json files
                if !has_blockers {
                    if let Ok(content) = std::fs::read_to_string(&p) {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                            if let Some(blockers) = v.get("blockers").and_then(|b| b.as_array()) {
                                if !blockers.is_empty() {
                                    has_blockers = true;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let info = latest_file.and_then(|p| {
        let content = std::fs::read_to_string(p).ok()?;
        serde_json::from_str::<ProgressInfo>(&content).ok()
    });

    (info, has_blockers)
}

fn classify_dir_heuristic(path: &Path) -> &'static str {
    if path.join("AGENTS.md").exists() || path.join("CLAUDE.md").exists() {
        "project"
    } else if path.join(".git").exists() {
        "project"
    } else if path.join("package.json").exists() || path.join("Cargo.toml").exists() {
        "project"
    } else {
        "other"
    }
}

fn collect_workspace_dirs(root: &Path) -> Vec<PathBuf> {
    let mut result = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            result.push(entry.path());
        }
    }
    result
}

// --- Commands ----------------------------------------------------------------

#[tauri::command]
pub fn workspace_get_sessions(
    watcher_state: tauri::State<'_, SharedWatcherState>,
) -> Result<Vec<SessionInfo>, String> {
    let root = canonical_workspace_root()?;
    let mut sessions = Vec::new();

    let candidates = collect_workspace_git_dirs(&root);
    let (last_change_map, recent_files_map, branch_cache_map, origin_path_cache_map) = {
        let state = watcher_state.lock().unwrap();
        (
            state.last_change.clone(),
            state.recent_files.clone(),
            state.branch_cache.clone(),
            state.origin_path_cache.clone(),
        )
    };
    let lc = last_change_map.lock().unwrap();
    let rf = recent_files_map.lock().unwrap();
    let mut bc = branch_cache_map.lock().unwrap();
    let mut opc = origin_path_cache_map.lock().unwrap();

    let now = now_secs();

    for path in candidates {
        let dir_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let path_str = dunce::canonicalize(&path)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| path.to_string_lossy().to_string());

        let last_change = lc.get(&path_str).copied();
        let recent_file = rf.get(&path_str).cloned();
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

        let status = match (has_blockers, last_change) {
            (true, _) => "error",
            (_, Some(t)) if now.saturating_sub(t) < 30 => "active",
            (_, Some(t)) if now.saturating_sub(t) < 1800 => "idle",
            _ => "stopped",
        };

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

#[tauri::command]
pub fn workspace_get_progress(path: String) -> Option<ProgressInfo> {
    let safe = validate_in_workspace(&path).ok()?;
    read_progress(&safe).0
}

#[tauri::command]
pub fn workspace_start_watch(
    app: AppHandle,
    watcher_state: tauri::State<'_, SharedWatcherState>,
) -> Result<(), String> {
    let root = canonical_workspace_root()?;
    let mut state = watcher_state.lock().unwrap();

    if state.watcher.is_some() {
        return Ok(());
    }

    let last_change_clone = state.last_change.clone();
    let recent_files_clone = state.recent_files.clone();
    let branch_cache_clone = state.branch_cache.clone();
    let app_clone = app.clone();

    let watcher = RecommendedWatcher::new(
        move |result: notify::Result<Event>| {
            if let Ok(event) = result {
                let is_content_change = matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_));
                if !is_content_change {
                    return;
                }

                for changed_path in &event.paths {
                    let name = changed_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if name.starts_with('.') || name.ends_with(".lock") {
                        continue;
                    }
                    if !changed_path.is_file() {
                        continue;
                    }

                    if let Some(session_dir) = find_session_dir(changed_path) {
                        let session_str = session_dir.to_string_lossy().to_string();
                        let now = now_secs();
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
                        {
                            let new_branch = get_branch(&session_dir);
                            let mut bc = branch_cache_clone.lock().unwrap();
                            if new_branch.is_some() {
                                bc.insert(session_str.clone(), new_branch);
                            } else {
                                bc.remove(&session_str);
                            }
                        }

                        let _ = app_clone.emit(
                            "workspace:file-changed",
                            serde_json::json!({
                                "session": session_str,
                                "file": rel,
                                "timestamp": now,
                            }),
                        );
                    }
                }
            }
        },
        Config::default(),
    )
    .map_err(|e| e.to_string())?;

    let mut w = watcher;
    for path in collect_workspace_git_dirs(&root) {
        let _ = w.watch(&path, RecursiveMode::Recursive);
    }

    state.watcher = Some(w);
    Ok(())
}

#[tauri::command]
pub fn workspace_stop_watch(
    watcher_state: tauri::State<'_, SharedWatcherState>,
) -> Result<(), String> {
    let (last_change_arc, recent_files_arc, branch_cache_arc, origin_path_cache_arc) = {
        let mut state = watcher_state.lock().unwrap();
        state.watcher = None;
        (
            state.last_change.clone(),
            state.recent_files.clone(),
            state.branch_cache.clone(),
            state.origin_path_cache.clone(),
        )
    };
    last_change_arc.lock().unwrap().clear();
    recent_files_arc.lock().unwrap().clear();
    branch_cache_arc.lock().unwrap().clear();
    origin_path_cache_arc.lock().unwrap().clear();
    Ok(())
}

#[tauri::command]
pub fn workspace_set_root(root: String) -> Result<String, String> {
    let p = PathBuf::from(&root);
    if !p.is_dir() {
        return Err(format!("Workspace root is not a directory: {root}"));
    }
    let canonical = dunce::canonicalize(&p).map_err(|e| format!("Workspace root inaccessible: {e}"))?;
    let canonical_str = canonical.to_string_lossy().to_string();
    let m = WORKSPACE_ROOT_OVERRIDE.get_or_init(|| Mutex::new(WORKSPACE_ROOT.to_string()));
    *m.lock().unwrap() = canonical_str.clone();
    Ok(canonical_str)
}

#[tauri::command]
pub fn workspace_classify_dirs() -> Result<Vec<ClassifiedDir>, String> {
    let root = canonical_workspace_root()?;
    let mut result = Vec::new();
    let worktree_paths = get_all_worktree_paths(&root);

    let mut raw = collect_workspace_dirs(&root);
    raw.sort_by_key(|p| p.to_string_lossy().to_string());

    for path in raw {
        if !path.is_dir() {
            continue;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        if name.starts_with('.') {
            continue;
        }
        let path_str = dunce::canonicalize(&path)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| path.to_string_lossy().to_string());

        let is_worktree_listed = worktree_paths.contains(&path_str);
        let category = if is_worktree_listed && path.join(".git").is_file() {
            "worktree"
        } else {
            classify_dir_heuristic(path.as_path())
        };

        result.push(ClassifiedDir {
            name,
            path: path_str,
            category: category.to_string(),
        });
    }

    Ok(result)
}

#[tauri::command]
pub fn workspace_detect_adk_root() -> Result<String, String> {
    let candidates = collect_search_candidates();
    for dir in candidates {
        if is_naia_adk_root(&dir) {
            let canonical = dunce::canonicalize(&dir).ok();
            if let Some(c) = canonical {
                return Ok(c.to_string_lossy().to_string());
            }
        }
    }
    Err("No naia-adk workspace detected".to_string())
}

#[tauri::command]
pub fn workspace_check_adk_server(url: Option<String>) -> Result<serde_json::Value, String> {
    let server_url = url.unwrap_or_else(|| "http://localhost:3141".to_string());
    let health_url = format!("{}/api/health", server_url);
    let response = ureq::get(&health_url)
        .timeout(std::time::Duration::from_secs(3))
        .call()
        .map_err(|e| format!("Server not reachable: {e}"))?;
    let body: serde_json::Value = response.into_json().map_err(|e| format!("Parse error: {e}"))?;
    Ok(body)
}

#[tauri::command]
pub fn workspace_discover_adk_server() -> Option<String> {
    for port in [3141, 3142, 8080] {
        let url = format!("http://localhost:{}", port);
        let health = format!("{}/api/health", url);
        if ureq::get(&health).timeout(std::time::Duration::from_secs(1)).call().is_ok() {
            return Some(url);
        }
    }
    None
}

/// For each PTY PID, inspect its child process tree and return the agent name if found.
/// Returns Record<pid, agentName> — missing entry means no agent detected.
#[tauri::command]
pub fn workspace_get_pty_agents(pids: Vec<u32>) -> std::collections::HashMap<u32, String> {
    use sysinfo::{ProcessesToUpdate, System};

    const AGENTS: &[&str] = &["claude", "opencode", "codex", "gemini"];

    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, false);

    let mut result = std::collections::HashMap::new();

    for pid in pids {
        let target = sysinfo::Pid::from(pid as usize);
        'proc: for (proc_pid, process) in sys.processes() {
            if *proc_pid == target {
                continue;
            }
            // Walk parent chain (max depth 6) to see if this process descends from our PTY
            let mut cur = process.parent();
            for _ in 0..6 {
                match cur {
                    Some(p) if p == target => {
                        // Descendant found — check if its name matches an agent
                        let name = process.name().to_string_lossy().to_lowercase();
                        for &agent in AGENTS {
                            if name.contains(agent) {
                                result.insert(pid, agent.to_string());
                                break 'proc;
                            }
                        }
                        break;
                    }
                    Some(p) => {
                        cur = sys.process(p).and_then(|pr| pr.parent());
                    }
                    None => break,
                }
            }
        }
    }

    result
}

fn collect_search_candidates() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        for ancestor in cwd.ancestors() {
            dirs.push(ancestor.join("projects").join("naia-adk"));
            dirs.push(ancestor.join("naia-adk"));
            dirs.push(ancestor.to_path_buf());
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            for ancestor in exe_dir.ancestors() {
                dirs.push(ancestor.join("projects").join("naia-adk"));
                dirs.push(ancestor.join("naia-adk"));
                dirs.push(ancestor.to_path_buf());
            }
        }
    }
    if let Some(home) = dirs::home_dir() {
        let dev = home.join("dev");
        if dev.is_dir() {
            dirs.push(dev);
        }
        dirs.push(home);
    }
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
    let has_entry_point = path.join("AGENTS.md").is_file() || path.join("CLAUDE.md").is_file();
    let has_rules = path.join(".agents").join("context").join("agents-rules.json").is_file();
    if !(has_entry_point && has_rules) {
        return false;
    }
    // AGENTS.md + agents-rules.json alone is NOT enough — every Naia project
    // (naia-os, alpha-adk root, etc.) uses the same context-as-code layout.
    // The actual naia-adk repo is identified by its package.json `name`.
    // Without this check, `workspace_detect_adk_root` would happily return
    // the cwd's nearest AGENTS.md-bearing ancestor as "the ADK" — e.g. the
    // naia-os shell directory the user is dev-running from.
    let pkg_path = path.join("package.json");
    let Ok(pkg_str) = std::fs::read_to_string(&pkg_path) else {
        return false;
    };
    let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&pkg_str) else {
        return false;
    };
    pkg.get("name").and_then(|n| n.as_str()) == Some("naia-adk")
}

#[tauri::command]
pub fn workspace_load_project_index() -> Result<serde_json::Value, String> {
    let root = canonical_workspace_root()?;
    let index_path = root.join(".agents").join("context").join("project-index.yaml");
    if !index_path.is_file() {
        return Err("project-index.yaml not found".to_string());
    }
    let content = std::fs::read_to_string(&index_path).map_err(|e| e.to_string())?;
    let yaml_value: serde_yaml::Value = serde_yaml::from_str(&content).map_err(|e| format!("YAML parse error: {e}"))?;
    let json_str = serde_json::to_string(&yaml_value).map_err(|e| format!("JSON conversion: {e}"))?;
    serde_json::from_str(&json_str).map_err(|e| format!("JSON parse: {e}"))
}

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
    let Ok(entries) = std::fs::read_dir(dir) else { return; };
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
        description: frontmatter.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        trigger: frontmatter.get("trigger").and_then(|v| v.as_str()).map(|s| s.to_string()),
        management: frontmatter.get("management").and_then(|v| v.as_str()).map(|s| s.to_string()),
        has_frontmatter,
    })
}

fn parse_frontmatter(content: &str) -> (serde_yaml::Value, bool) {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") { return (serde_yaml::Value::Null, false); }
    let rest = &trimmed[3..];
    let Some(end) = rest.find("\n---") else { return (serde_yaml::Value::Null, false); };
    let yaml_str = &rest[..end];
    match serde_yaml::from_str(yaml_str) {
        Ok(v) => (v, true),
        Err(_) => (serde_yaml::Value::Null, false),
    }
}

fn find_session_dir(file_path: &Path) -> Option<PathBuf> {
    let root = canonical_workspace_root().ok()?;
    let canonical_file = dunce::canonicalize(file_path).ok()?;
    let mut candidates = collect_workspace_git_dirs(&root);
    candidates.sort_by(|a, b| {
        b.components().count().cmp(&a.components().count())
            .then_with(|| b.as_os_str().len().cmp(&a.as_os_str().len()))
    });
    candidates.into_iter().find(|candidate| canonical_file.starts_with(candidate))
}

fn get_main_worktree(path: &Path) -> Option<String> {
    let output = git_cmd(path, &["worktree", "list", "--porcelain"]).output().ok()?;
    if !output.status.success() { return None; }
    let text = String::from_utf8_lossy(&output.stdout);
    let main_path = text.lines().find_map(|l| l.strip_prefix("worktree ")).map(str::to_string)?;
    let canon_main = dunce::canonicalize(&main_path).ok()?;
    let canon_path = dunce::canonicalize(path).ok()?;
    if canon_main == canon_path { None } else { Some(canon_main.to_string_lossy().to_string()) }
}

fn get_all_worktree_paths(root: &Path) -> Vec<String> {
    let mut paths = Vec::new();
    for p in collect_workspace_git_dirs(root) {
        if let Ok(output) = git_cmd(&p, &["worktree", "list", "--porcelain"]).output() {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                for line in text.lines() {
                    if let Some(wt_path) = line.strip_prefix("worktree ") {
                        let canonical = dunce::canonicalize(wt_path)
                            .map(|p| p.to_string_lossy().to_string())
                            .unwrap_or_else(|_| wt_path.to_string());
                        paths.push(canonical);
                    }
                }
            }
        }
    }
    paths.sort();
    paths.dedup();
    paths
}

// RESTORED MISSING COMMANDS

#[tauri::command]
pub fn workspace_list_dirs(parent: String) -> Result<Vec<DirEntry>, String> {
    let safe_path = validate_in_workspace(&parent)?;
    let mut entries = Vec::new();
    if let Ok(read) = std::fs::read_dir(safe_path) {
        for entry in read.flatten() {
            let p = entry.path();
            let is_dir = p.is_dir();
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            if name.starts_with('.') { continue; }
            entries.push(DirEntry {
                name,
                path: p.to_string_lossy().to_string(),
                is_dir,
                children: None,
            });
        }
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(entries)
}

#[tauri::command]
pub fn workspace_read_file(path: String) -> Result<String, String> {
    let safe_path = validate_in_workspace(&path)?;
    std::fs::read_to_string(safe_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspace_read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    let safe_path = validate_in_workspace(&path)?;
    std::fs::read(safe_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspace_file_size(path: String) -> Result<u64, String> {
    let safe_path = validate_in_workspace(&path)?;
    std::fs::metadata(safe_path).map(|m| m.len()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspace_write_file(path: String, content: String) -> Result<(), String> {
    let safe_path = validate_write_path(&path)?;
    std::fs::write(safe_path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspace_get_git_info(path: String) -> Result<GitInfo, String> {
    let safe_path = validate_in_workspace(&path)?;
    Ok(GitInfo {
        branch: get_branch(&safe_path),
    })
}

#[tauri::command]
pub fn workspace_get_pty_agents(pids: Vec<u32>) -> Result<HashMap<u32, String>, String> {
    if pids.is_empty() {
        return Ok(HashMap::new());
    }

    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::All,
        true,
        sysinfo::ProcessRefreshKind::nothing()
            .with_cmd(sysinfo::UpdateKind::Always)
            .with_exe(sysinfo::UpdateKind::OnlyIfNotSet)
            .without_tasks(),
    );

    let mut children_by_parent: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut agent_by_pid: HashMap<u32, String> = HashMap::new();

    for (pid, process) in system.processes() {
        let pid_u32 = pid.as_u32();
        if let Some(parent) = process.parent() {
            children_by_parent
                .entry(parent.as_u32())
                .or_default()
                .push(pid_u32);
        }
        if let Some(agent) = detect_agent_process(process) {
            agent_by_pid.insert(pid_u32, agent.to_string());
        }
    }

    for children in children_by_parent.values_mut() {
        children.sort_unstable();
    }

    let mut result = HashMap::new();
    for pid in pids {
        if let Some(agent) = find_agent_descendant(pid, &children_by_parent, &agent_by_pid) {
            result.insert(pid, agent);
        }
    }
    Ok(result)
}

fn find_agent_descendant(
    root_pid: u32,
    children_by_parent: &HashMap<u32, Vec<u32>>,
    agent_by_pid: &HashMap<u32, String>,
) -> Option<String> {
    if let Some(agent) = agent_by_pid.get(&root_pid) {
        return Some(agent.clone());
    }

    let mut seen = HashSet::new();
    let mut stack = children_by_parent
        .get(&root_pid)
        .cloned()
        .unwrap_or_default();
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        if let Some(agent) = agent_by_pid.get(&pid) {
            return Some(agent.clone());
        }
        if let Some(children) = children_by_parent.get(&pid) {
            stack.extend(children.iter().copied());
        }
    }
    None
}

fn detect_agent_process(process: &sysinfo::Process) -> Option<&'static str> {
    let mut haystack = process.name().to_string_lossy().to_ascii_lowercase();
    if let Some(exe) = process.exe() {
        haystack.push(' ');
        haystack.push_str(&exe.to_string_lossy().to_ascii_lowercase());
    }
    for arg in process.cmd() {
        haystack.push(' ');
        haystack.push_str(&arg.to_string_lossy().to_ascii_lowercase());
    }

    for agent in ["claude", "opencode", "codex", "gemini"] {
        if haystack.contains(agent) {
            return Some(agent);
        }
    }
    None
}
