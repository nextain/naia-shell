use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

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
    /// start_watch 이 백그라운드에서 watcher 구축 중이거나 완료됐는지(동기 가드 — 비동기 시작의 중복 spawn 방지).
    pub watch_started: bool,
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
            watch_started: false,
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

static WORKSPACE_ROOT_OVERRIDE: OnceLock<Mutex<String>> = OnceLock::new();

// Default workspace root when no override has been set by the UI/config.
// Portable: NAIA_WORKSPACE_ROOT env overrides; otherwise $HOME/dev (Unix) or
// %USERPROFILE%\dev (Windows). The user normally sets the real root via the
// `set_root` command, so this is only the first-run fallback.
fn default_workspace_root() -> String {
    if let Ok(v) = std::env::var("NAIA_WORKSPACE_ROOT") {
        if !v.is_empty() {
            return v;
        }
    }
    #[cfg(unix)]
    {
        match crate::data_home::unix_home() {
            h if !h.is_empty() => format!("{h}/dev"),
            _ => String::new(),
        }
    }
    #[cfg(windows)]
    {
        match crate::data_home::windows_home() {
            h if !h.is_empty() => format!("{h}\\dev"),
            _ => String::new(),
        }
    }
}

// --- Helpers -----------------------------------------------------------------

fn get_workspace_root() -> String {
    if let Some(m) = WORKSPACE_ROOT_OVERRIDE.get() {
        m.lock().unwrap().clone()
    } else {
        default_workspace_root()
    }
}

fn canonical_workspace_root() -> Result<PathBuf, String> {
    dunce::canonicalize(get_workspace_root())
        .map_err(|e| format!("Workspace root inaccessible: {e}"))
}

/// 사용자가 명시적으로 연 파일의 세션 한정 read/write 허용 목록 (#543).
/// 열림 = 동의. 정확한 canonical 파일 경로 1개 단위이며 디렉터리는 등록하지
/// 않고, 경계 밖 신규 파일 생성은 여전히 거부된다.
static OPEN_FILE_GRANTS: OnceLock<Mutex<std::collections::HashSet<PathBuf>>> = OnceLock::new();

fn open_file_grants() -> &'static Mutex<std::collections::HashSet<PathBuf>> {
    OPEN_FILE_GRANTS.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

fn is_open_file_granted(canonical: &Path) -> bool {
    open_file_grants()
        .lock()
        .map(|set| set.contains(canonical))
        .unwrap_or(false)
}

/// canonical 실파일만 등록하고 그 경로를 돌려준다.
pub fn grant_open_file(path: &str) -> Result<String, String> {
    let canonical =
        dunce::canonicalize(path).map_err(|e| format!("Path inaccessible: {e}"))?;
    if !canonical.is_file() {
        return Err("only files can be granted".into());
    }
    open_file_grants()
        .lock()
        .map_err(|_| "grant lock poisoned".to_string())?
        .insert(canonical.clone());
    Ok(canonical.to_string_lossy().into_owned())
}

/// 드래그앤드롭 등 프론트가 받은 OS 실경로를 CLI 와 같은 계약으로 등록한다.
#[tauri::command]
pub fn workspace_register_open_file(path: String) -> Result<String, String> {
    grant_open_file(&path)
}

fn validate_in_workspace(path: &str) -> Result<PathBuf, String> {
    let canonical = dunce::canonicalize(path).map_err(|e| format!("Path inaccessible: {e}"))?;
    // 명시적으로 연 파일은 워크스페이스 밖이어도 허용 (#543).
    if is_open_file_granted(&canonical) {
        return Ok(canonical);
    }
    let root = canonical_workspace_root()?;
    if !canonical.starts_with(&root) {
        return Err(format!("Access denied: path is outside workspace root"));
    }
    Ok(canonical)
}

fn validate_write_path(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    // 명시적으로 연 기존 파일은 경계 밖이어도 쓰기 허용 (#543). 신규 생성은 제외.
    if let Ok(canonical_file) = dunce::canonicalize(&p) {
        if is_open_file_granted(&canonical_file) {
            return Ok(canonical_file);
        }
    }
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
    crate::log_verbose("[workspace] start_watch enter");
    let root = canonical_workspace_root()?;
    // ⚠️ 비동기(루크 #1): 옛 구현은 collect_workspace_git_dirs(트리 walk) + 재귀 watch 등록(naia-adk 처럼
    // node_modules/.git 많은 큰 트리는 inotify 등록이 수백 ms~수십초)을 *invoke 안에서 동기로* 해 셸 기동을
    // 180s 까지 블록했다. → 무거운 작업을 백그라운드 스레드로 옮기고 invoke 는 즉시 리턴. watch 가 활성화될
    // 때까지 짧은 공백이 있으나 UI/대화는 막히지 않는다.
    // 동기 가드(락 짧게): 이미 watching 이거나 시작 중이면 noop — 비동기 시작이라 중복 호출의 double-spawn 차단.
    {
        let mut state = watcher_state.lock().unwrap();
        if state.watcher.is_some() || state.watch_started {
            crate::log_verbose("[workspace] start_watch already watching/in-progress — noop");
            return Ok(());
        }
        state.watch_started = true;
    }
    let ws: SharedWatcherState = watcher_state.inner().clone();
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let t0 = std::time::Instant::now();
        // 콜백이 쓰는 공유 맵(Arc clone) — 락 짧게 잡고 클론만.
        let (last_change_clone, recent_files_clone, branch_cache_clone) = {
            let state = ws.lock().unwrap();
            (
                state.last_change.clone(),
                state.recent_files.clone(),
                state.branch_cache.clone(),
            )
        };

        let watcher = RecommendedWatcher::new(
            move |result: notify::Result<Event>| {
                if let Ok(event) = result {
                    let is_content_change =
                        matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_));
                    if !is_content_change {
                        return;
                    }

                    for changed_path in &event.paths {
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
        );
        let mut w = match watcher {
            Ok(w) => w,
            Err(e) => {
                crate::log_verbose(&format!("[workspace] start_watch watcher 생성 실패: {e}"));
                ws.lock().unwrap().watch_started = false; // 실패 — 재시도 허용
                return;
            }
        };
        let dirs = collect_workspace_git_dirs(&root);
        crate::log_verbose(&format!(
            "[workspace] start_watch collected {} git dirs ms={}",
            dirs.len(),
            t0.elapsed().as_millis()
        ));
        for path in dirs {
            let _ = w.watch(&path, RecursiveMode::Recursive);
        }
        crate::log_verbose(&format!(
            "[workspace] start_watch watched ms={}",
            t0.elapsed().as_millis()
        ));
        // watcher 는 드롭되면 watch 가 중단되므로 state 에 보관(watch_started 는 true 유지).
        ws.lock().unwrap().watcher = Some(w);
    });
    Ok(())
}

#[tauri::command]
pub fn workspace_stop_watch(
    watcher_state: tauri::State<'_, SharedWatcherState>,
) -> Result<(), String> {
    let (last_change_arc, recent_files_arc, branch_cache_arc, origin_path_cache_arc) = {
        let mut state = watcher_state.lock().unwrap();
        state.watcher = None;
        state.watch_started = false; // 재시작(start_watch 재spawn) 허용
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
    // P1 진입·종료 로깅(debug=log_verbose) — 90초 등 타이밍 규명용(docs/logging.md).
    let t0 = std::time::Instant::now();
    crate::log_verbose(&format!("[workspace] set_root enter root={root}"));
    let p = PathBuf::from(&root);
    if !p.is_dir() {
        return Err(format!("Workspace root is not a directory: {root}"));
    }
    let canonical =
        dunce::canonicalize(&p).map_err(|e| format!("Workspace root inaccessible: {e}"))?;
    let canonical_str = canonical.to_string_lossy().to_string();
    let m = WORKSPACE_ROOT_OVERRIDE.get_or_init(|| Mutex::new(default_workspace_root()));
    *m.lock().unwrap() = canonical_str.clone();
    crate::log_verbose(&format!(
        "[workspace] set_root exit canonical={canonical_str} ms={}",
        t0.elapsed().as_millis()
    ));
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
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
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
    let body: serde_json::Value = response
        .into_json()
        .map_err(|e| format!("Parse error: {e}"))?;
    Ok(body)
}

#[tauri::command]
pub fn workspace_discover_adk_server() -> Option<String> {
    for port in [3141, 3142, 8080] {
        let url = format!("http://localhost:{}", port);
        let health = format!("{}/api/health", url);
        if ureq::get(&health)
            .timeout(std::time::Duration::from_secs(1))
            .call()
            .is_ok()
        {
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

    // D6: Gemini CLI / OpenCode removed from PTY agent detection.
    const AGENTS: &[&str] = &["claude", "codex", "grok"];

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
    if let Some(home) = crate::data_home::user_home_path() {
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
    let has_rules = path
        .join(".agents")
        .join("context")
        .join("agents-rules.json")
        .is_file();
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
    let json_str =
        serde_json::to_string(&yaml_value).map_err(|e| format!("JSON conversion: {e}"))?;
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
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
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

fn find_session_dir(file_path: &Path) -> Option<PathBuf> {
    let root = canonical_workspace_root().ok()?;
    let canonical_file = dunce::canonicalize(file_path).ok()?;
    let mut candidates = collect_workspace_git_dirs(&root);
    candidates.sort_by(|a, b| {
        b.components()
            .count()
            .cmp(&a.components().count())
            .then_with(|| b.as_os_str().len().cmp(&a.as_os_str().len()))
    });
    candidates
        .into_iter()
        .find(|candidate| canonical_file.starts_with(candidate))
}

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
    let canon_main = dunce::canonicalize(&main_path).ok()?;
    let canon_path = dunce::canonicalize(path).ok()?;
    if canon_main == canon_path {
        None
    } else {
        Some(canon_main.to_string_lossy().to_string())
    }
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
            let name = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            if name.starts_with('.') {
                continue;
            }
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
    std::fs::metadata(safe_path)
        .map(|m| m.len())
        .map_err(|e| e.to_string())
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

const RECURSIVE_IGNORE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    ".pnpm",
    ".turbo",
    "__pycache__",
    ".venv",
    "target",
    ".flatpak-builder",
    "flatpak-repo",
];

#[tauri::command]
pub fn workspace_list_files_recursive(parent: String) -> Result<Vec<String>, String> {
    let safe_path = validate_in_workspace(&parent)?;
    let mut results = Vec::new();
    let mut dirs_to_visit = vec![(safe_path, 0usize)];

    while let Some((dir, depth)) = dirs_to_visit.pop() {
        if depth > 15 {
            continue;
        }
        if results.len() >= 20000 {
            break;
        }
        if let Ok(read) = std::fs::read_dir(&dir) {
            for entry in read.flatten() {
                let p = entry.path();
                let name = p
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");
                if name.starts_with('.') {
                    continue;
                }
                if p.is_dir() {
                    if !RECURSIVE_IGNORE_DIRS.contains(&name) {
                        dirs_to_visit.push((p, depth + 1));
                    }
                } else if p.is_file() {
                    results.push(p.to_string_lossy().to_string());
                }
            }
        }
    }
    results.sort();
    Ok(results)
}

#[tauri::command]
pub fn fs_exists(path: String, cwd: Option<String>) -> bool {
    let target = if let Some(rel) = path.strip_prefix("~/") {
        crate::data_home::user_home_path().map(|h| h.join(rel))
    } else {
        let p = std::path::PathBuf::from(&path);
        if p.is_absolute() {
            Some(p)
        } else if let Some(cwd_str) = cwd {
            Some(std::path::PathBuf::from(cwd_str).join(p))
        } else {
            Some(p)
        }
    };
    target.map(|p| p.exists()).unwrap_or(false)
}

// Mirrors naia-agent src/main/domain/fs-sandbox.ts (main a1fb92d) DENY_* lists lines 29-97,
// isSensitivePath 154-165, isSettingsWriteFenced 139-151, and fs-tools.ts MAX_FILE/MAX_WRITE 44/46.
// Keep in sync.

pub const AGENT_DENY_SEGMENTS: &[&str] = &[
    ".keys",
    ".ssh",
    ".git",
    "data-private",
    "data-business",
    ".env",
    "secret",
    "secrets",
    ".gnupg",
    ".password-store",
];

pub const AGENT_DENY_FILENAMES: &[&str] = &[
    ".env",
    ".npmrc",
    ".netrc",
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "id_dsa",
    ".pgpass",
    "credentials",
    "authorized_keys",
    "known_hosts",
    "service-account.json",
    ".git-credentials",
    "gha-creds",
    "wif-config.json",
];

pub const AGENT_DENY_SUFFIXES: &[&str] = &[
    ".dpapi",
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".keystore",
    ".jks",
    ".age",
    ".gpg",
    ".asc",
];

pub const AGENT_DENY_FILENAME_PREFIXES: &[&str] = &[
    ".env.",
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "id_dsa",
];

pub const AGENT_DENY_SUBSTRINGS: &[&str] = &[
    "/naia-settings/memory",
    "/naia-settings/knowledge/",
    "/login data",
    "/cookies",
    "/.config/gcloud",
    "/.aws/",
    "/.docker/config",
    "/.kube/config",
    "/serviceaccount",
    "-key.json",
    "service-account",
];

pub const AGENT_OPEN_FILE_MAX_BYTES: u64 = 1024 * 1024;

fn agent_posix_lower(path: &Path) -> String {
    let lossy = path.to_string_lossy().replace('\\', "/");
    let mut collapsed = String::with_capacity(lossy.len());
    let mut prev_slash = false;
    for c in lossy.chars() {
        if c == '/' {
            if !prev_slash {
                collapsed.push(c);
                prev_slash = true;
            }
        } else {
            collapsed.push(c);
            prev_slash = false;
        }
    }
    let trimmed = collapsed.trim_end_matches('/');
    trimmed.to_lowercase()
}

pub fn is_agent_sensitive_path(path: &Path) -> bool {
    let lowered = agent_posix_lower(path);
    let segments: Vec<&str> = lowered.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return false;
    }
    for seg in &segments {
        if AGENT_DENY_SEGMENTS.contains(seg) {
            return true;
        }
    }
    if let Some(&filename) = segments.last() {
        if AGENT_DENY_FILENAMES.contains(&filename) {
            return true;
        }
        for suffix in AGENT_DENY_SUFFIXES {
            if filename.ends_with(suffix) {
                return true;
            }
        }
        for prefix in AGENT_DENY_FILENAME_PREFIXES {
            if filename.starts_with(prefix) {
                return true;
            }
        }
    }
    for substr in AGENT_DENY_SUBSTRINGS {
        if lowered.contains(substr) {
            return true;
        }
    }
    false
}

fn is_agent_settings_write_fenced(path: &Path, root: &Path) -> bool {
    let lowered_path = agent_posix_lower(path);
    let fence = format!("{}/naia-settings", agent_posix_lower(root));
    let fence_slash = format!("{fence}/");
    lowered_path == fence || lowered_path.starts_with(&fence_slash)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOpenFile {
    pub path: String,
    pub content: String,
    pub sha256: String,
    pub size: u64,
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let result = hasher.finalize();
    let mut s = String::with_capacity(64);
    for byte in result {
        use std::fmt::Write;
        let _ = write!(s, "{:02x}", byte);
    }
    s
}

fn agent_read_open_file_at(canonical: &Path) -> Result<AgentOpenFile, String> {
    if !canonical.is_file() {
        return Err("denied: not a file".to_string());
    }
    if is_agent_sensitive_path(canonical) {
        return Err("denied: path is sensitive (denylisted)".to_string());
    }
    let meta = std::fs::metadata(canonical).map_err(|e| e.to_string())?;
    if meta.len() > AGENT_OPEN_FILE_MAX_BYTES {
        return Err("denied: file too large (>1MB)".to_string());
    }
    let bytes = std::fs::read(canonical).map_err(|e| e.to_string())?;
    let content = String::from_utf8(bytes).map_err(|_| "denied: not a UTF-8 text file".to_string())?;
    let sha256 = sha256_hex(content.as_bytes());
    let size = content.len() as u64;
    Ok(AgentOpenFile {
        path: canonical.to_string_lossy().to_string(),
        content,
        sha256,
        size,
    })
}

fn agent_write_open_file_at(
    canonical: &Path,
    root: Option<&Path>,
    content: &str,
    expected_sha256: &str,
) -> Result<AgentOpenFile, String> {
    if !canonical.is_file() {
        return Err("denied: not a file".to_string());
    }
    if is_agent_sensitive_path(canonical) {
        return Err("denied: path is sensitive (denylisted)".to_string());
    }
    if let Some(r) = root {
        if is_agent_settings_write_fenced(canonical, r) {
            return Err("denied: naia-settings is shell-owned (write fenced)".to_string());
        }
    }
    if content.len() as u64 > AGENT_OPEN_FILE_MAX_BYTES {
        return Err("denied: content too large (>1MB)".to_string());
    }
    let current_bytes = std::fs::read(canonical).map_err(|e| e.to_string())?;
    if sha256_hex(&current_bytes) != expected_sha256.trim().to_lowercase() {
        return Err("stale: the file changed on disk after the preview".to_string());
    }
    std::fs::write(canonical, content).map_err(|e| e.to_string())?;
    let content_bytes = content.as_bytes();
    Ok(AgentOpenFile {
        path: canonical.to_string_lossy().to_string(),
        content: content.to_string(),
        sha256: sha256_hex(content_bytes),
        size: content_bytes.len() as u64,
    })
}

#[tauri::command]
pub fn workspace_agent_read_open_file(path: String) -> Result<AgentOpenFile, String> {
    let canonical = validate_in_workspace(&path)?;
    agent_read_open_file_at(&canonical)
}

#[tauri::command]
pub fn workspace_agent_write_open_file(
    path: String,
    content: String,
    expected_sha256: String,
) -> Result<AgentOpenFile, String> {
    let canonical = validate_in_workspace(&path)?; // existing files only — never creates
    let root = canonical_workspace_root().ok();
    agent_write_open_file_at(&canonical, root.as_deref(), &content, &expected_sha256)
}

#[cfg(test)]
mod open_grant_tests {
    use super::*;

    #[test]
    fn grant_allows_read_write_of_an_outside_file_only_after_registration() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("외부노트.md");
        std::fs::write(&file, "본문").unwrap();
        let path = file.to_string_lossy().to_string();

        assert!(validate_in_workspace(&path).is_err());
        assert!(validate_write_path(&path).is_err());

        grant_open_file(&path).unwrap();

        assert!(validate_in_workspace(&path).is_ok());
        assert!(validate_write_path(&path).is_ok());
    }

    #[test]
    fn grant_rejects_directories_and_never_covers_new_outside_files() {
        let dir = tempfile::tempdir().unwrap();
        assert!(grant_open_file(&dir.path().to_string_lossy()).is_err());

        let fresh = dir.path().join("아직없음.md");
        assert!(validate_write_path(&fresh.to_string_lossy()).is_err());
    }

    #[test]
    fn fs_exists_checks_relative_and_absolute_paths() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("test.txt");
        std::fs::write(&file, "hello").unwrap();

        // Absolute path exists
        assert!(fs_exists(file.to_string_lossy().to_string(), None));

        // Relative path with cwd exists
        assert!(fs_exists(
            "test.txt".to_string(),
            Some(dir.path().to_string_lossy().to_string())
        ));

        // Non-existent path returns false
        assert!(!fs_exists(
            "nonexistent.txt".to_string(),
            Some(dir.path().to_string_lossy().to_string())
        ));
        assert!(!fs_exists(
            dir.path().join("missing.txt").to_string_lossy().to_string(),
            None
        ));
    }
}

#[cfg(test)]
mod agent_open_file_tests {
    use super::*;

    #[test]
    fn sensitive_path_detection() {
        assert!(is_agent_sensitive_path(Path::new("D:/alpha-adk/data-private/persona.md")));
        assert!(is_agent_sensitive_path(Path::new("/home/u/.ssh/id_rsa")));
        assert!(is_agent_sensitive_path(Path::new("/w/.env.local")));
        assert!(is_agent_sensitive_path(Path::new("/w/naia-settings/.keys/x.dpapi")));
        assert!(is_agent_sensitive_path(Path::new("/w/naia-settings/memory/store.json")));
        assert!(is_agent_sensitive_path(Path::new("/w/certs/server.PEM")));

        assert!(!is_agent_sensitive_path(Path::new("/w/docs/readme.md")));
        assert!(!is_agent_sensitive_path(Path::new("/w/naia-settings/config.json")));
        assert!(!is_agent_sensitive_path(Path::new("/w/src/secretary.ts")));
    }

    #[test]
    fn settings_write_fenced_detection() {
        let root = Path::new("/workspace");
        assert!(is_agent_settings_write_fenced(
            Path::new("/workspace/naia-settings/config.json"),
            root
        ));
        assert!(!is_agent_settings_write_fenced(
            Path::new("/workspace/docs/a.md"),
            root
        ));
        assert!(!is_agent_settings_write_fenced(
            Path::new("/workspace/naia-settings-old/a.md"),
            root
        ));
    }

    #[test]
    fn agent_read_open_file_cases() {
        let dir = tempfile::tempdir().unwrap();
        let ok_file = dir.path().join("normal.txt");
        std::fs::write(&ok_file, "hello world").unwrap();

        let res = agent_read_open_file_at(&ok_file).expect("read ok");
        assert_eq!(res.content, "hello world");
        assert_eq!(res.sha256.len(), 64);
        assert_eq!(res.size, 11);

        // Large file (>1MB)
        let large_file = dir.path().join("large.bin");
        let big_data = vec![b'a'; (AGENT_OPEN_FILE_MAX_BYTES + 1) as usize];
        std::fs::write(&large_file, big_data).unwrap();
        let err = agent_read_open_file_at(&large_file).unwrap_err();
        assert!(err.contains("too large"));

        // Sensitive path inside tempdir (data-private)
        let private_dir = dir.path().join("data-private");
        std::fs::create_dir(&private_dir).unwrap();
        let priv_file = private_dir.join("secret.txt");
        std::fs::write(&priv_file, "secret").unwrap();
        let err = agent_read_open_file_at(&priv_file).unwrap_err();
        assert!(err.contains("sensitive"));

        // Non-UTF8 bytes
        let non_utf8_file = dir.path().join("invalid_utf8.bin");
        std::fs::write(&non_utf8_file, &[0xff, 0xfe, 0xfd]).unwrap();
        let err = agent_read_open_file_at(&non_utf8_file).unwrap_err();
        assert!(err.contains("not a UTF-8"));
    }

    #[test]
    fn agent_write_open_file_cases() {
        let dir = tempfile::tempdir().unwrap();
        let target_file = dir.path().join("doc.txt");
        std::fs::write(&target_file, "initial").unwrap();
        let initial_sha = sha256_hex(b"initial");

        // Success write
        let write_res = agent_write_open_file_at(
            &target_file,
            Some(dir.path()),
            "updated content",
            &initial_sha,
        ).expect("write ok");
        assert_eq!(write_res.content, "updated content");
        assert_eq!(write_res.sha256, sha256_hex(b"updated content"));
        assert_eq!(std::fs::read_to_string(&target_file).unwrap(), "updated content");

        // Stale sha
        let err = agent_write_open_file_at(
            &target_file,
            Some(dir.path()),
            "another update",
            "0000000000000000000000000000000000000000000000000000000000000000",
        ).unwrap_err();
        assert!(err.starts_with("stale:"));
        assert_eq!(std::fs::read_to_string(&target_file).unwrap(), "updated content");

        // Content over cap
        let curr_sha = sha256_hex(b"updated content");
        let big_content = "a".repeat((AGENT_OPEN_FILE_MAX_BYTES + 1) as usize);
        let err = agent_write_open_file_at(
            &target_file,
            Some(dir.path()),
            &big_content,
            &curr_sha,
        ).unwrap_err();
        assert!(err.contains("too large"));
        assert_eq!(std::fs::read_to_string(&target_file).unwrap(), "updated content");

        // Sensitive file unchanged
        let priv_dir = dir.path().join("data-private");
        std::fs::create_dir_all(&priv_dir).unwrap();
        let priv_file = priv_dir.join("secret.txt");
        std::fs::write(&priv_file, "original secret").unwrap();
        let err = agent_write_open_file_at(
            &priv_file,
            Some(dir.path()),
            "new secret",
            &sha256_hex(b"original secret"),
        ).unwrap_err();
        assert!(err.contains("sensitive"));
        assert_eq!(std::fs::read_to_string(&priv_file).unwrap(), "original secret");

        // Fenced naia-settings unchanged
        let settings_dir = dir.path().join("naia-settings");
        std::fs::create_dir_all(&settings_dir).unwrap();
        let settings_file = settings_dir.join("shell_owned.json");
        std::fs::write(&settings_file, "original settings").unwrap();
        let err = agent_write_open_file_at(
            &settings_file,
            Some(dir.path()),
            "new settings",
            &sha256_hex(b"original settings"),
        ).unwrap_err();
        assert!(err.contains("write fenced"));
        assert_eq!(std::fs::read_to_string(&settings_file).unwrap(), "original settings");
    }
}
