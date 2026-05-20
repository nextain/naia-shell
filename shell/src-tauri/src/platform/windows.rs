//! Windows platform implementations.

use super::{PlatformHandle, PlatformWindowManager, WindowRect};
use std::path::PathBuf;
use std::process::Command;

/// Check if a process with the given PID is still running (Windows: OpenProcess + GetExitCodeProcess).
pub(crate) fn is_pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess};
    let handle = unsafe { OpenProcess(0x0400, 0, pid) }; // PROCESS_QUERY_INFORMATION
    if handle.is_null() {
        return false; // OpenProcess returns NULL HANDLE on failure
    }
    let mut exit_code: u32 = 0;
    let alive = unsafe {
        GetExitCodeProcess(handle, &mut exit_code) != 0 && exit_code == 259 // STILL_ACTIVE
    };
    unsafe { CloseHandle(handle) };
    alive
}

/// Suppress the visible console window that GUI-spawned processes would otherwise show.
pub(crate) fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

/// Clean up orphan processes from a previous session (Windows: TerminateProcess).
pub(crate) fn cleanup_orphan_processes() {
    for component in &["gateway", "node-host"] {
        if let Some(pid) = crate::read_pid_file(component) {
            if is_pid_alive(pid) {
                crate::log_verbose(&format!(
                    "[Naia] Orphan {} found (PID {}) — terminating",
                    component, pid
                ));
                let handle = unsafe {
                    windows_sys::Win32::System::Threading::OpenProcess(0x0001, 0, pid)
                    // PROCESS_TERMINATE
                };
                if !handle.is_null() {
                    unsafe {
                        windows_sys::Win32::System::Threading::TerminateProcess(handle, 1);
                        windows_sys::Win32::Foundation::CloseHandle(handle);
                    }
                }
            }
            crate::remove_pid_file(component);
        }
    }
}

/// Associate the default IME context with a window and all its children.
///
/// Tauri frameless windows (`decorations: false`) can break Korean/CJK IME
/// because the custom WndProc doesn't always forward `WM_IME_SETCONTEXT`
/// properly to the WebView2 child windows.  Calling this after the window is
/// shown (and again on each `WindowEvent::Focused`) forces Windows to
/// re-establish the IME association so the 한/영 toggle and IME composition
/// both work in the WebView2 textarea.
pub(crate) fn enable_ime_for_window(hwnd_isize: isize) {
    use windows_sys::Win32::UI::Input::Ime::{ImmAssociateContextEx, IACE_CHILDREN, IACE_DEFAULT};
    let hwnd = isize_to_hwnd(hwnd_isize);
    unsafe {
        // Apply to the Tauri top-level HWND + all Win32 children
        ImmAssociateContextEx(hwnd, std::ptr::null_mut(), IACE_DEFAULT | IACE_CHILDREN);
    }
    // Also apply directly to the WebView2 host HWND (Chrome_WidgetWin_1).
    // ImmAssociateContextEx on the parent alone doesn't reliably reach the
    // WebView2 renderer — calling it on the actual WebView2 child HWND is
    // required for the 한/영 toggle to work inside the WebView2 textarea.
    if let Some(wv2_isize) = find_webview2_child(hwnd_isize) {
        let wv2_hwnd = isize_to_hwnd(wv2_isize);
        unsafe {
            ImmAssociateContextEx(wv2_hwnd, std::ptr::null_mut(), IACE_DEFAULT | IACE_CHILDREN);
        }
        crate::log_verbose(&format!(
            "[Naia] IME enabled for WebView2 child Win32({wv2_isize})"
        ));
    }
}

/// Resolve `npx` to `npx.cmd` on Windows (Rust's Command doesn't search .cmd extensions).
pub(crate) fn resolve_npx() -> String {
    "npx.cmd".to_string()
}

/// Resolve tsx as a direct node invocation from agent's node_modules.
/// Returns (node_exe, tsx_cli_mjs_path) if found, None otherwise.
/// .cmd batch files fail under CREATE_NO_WINDOW, so we invoke node directly.
pub(crate) fn resolve_tsx_from_agent(agent_dir: &std::path::Path) -> Option<(String, String)> {
    // Find tsx cli.mjs inside pnpm store (version-agnostic glob)
    let pnpm_dir = agent_dir.join("node_modules").join(".pnpm");
    if pnpm_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&pnpm_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("tsx@") {
                    let cli_mjs = entry
                        .path()
                        .join("node_modules")
                        .join("tsx")
                        .join("dist")
                        .join("cli.mjs");
                    if cli_mjs.exists() {
                        return Some(("node".to_string(), cli_mjs.to_string_lossy().to_string()));
                    }
                }
            }
        }
    }
    None
}

/// Start a background thread that watches for deep link URLs written to a
/// pending file by a second instance (see main.rs).  This is needed because
/// Chromium browsers launch the protocol handler in a sandboxed context where
/// the single-instance Named Mutex IPC fails silently.
pub(crate) fn start_deep_link_file_watcher(app_handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        let pending_path = dirs::home_dir()
            .map(|h| h.join(".naia").join("deep-link-pending.txt"))
            .unwrap_or_else(|| PathBuf::from(r"C:\Users\Public\.naia\deep-link-pending.txt"));
        loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if pending_path.exists() {
                if let Ok(raw) = std::fs::read_to_string(&pending_path) {
                    let _ = std::fs::remove_file(&pending_path);
                    let url_str = raw.trim();
                    if !url_str.is_empty() {
                        crate::process_deep_link_url(url_str, &app_handle, None, "file");
                    }
                }
            }
        }
    });
    crate::log_both("[Naia] Deep link file watcher started");
}


// ─── Browser window embedding (Win32) ────────────────────────────────────────

use windows_sys::Win32::Foundation::{BOOL, FALSE, HWND, LPARAM, POINT, RECT, TRUE};
use windows_sys::Win32::Graphics::Gdi::{ClientToScreen, ScreenToClient};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows_sys::Win32::UI::WindowsAndMessaging::*;

pub struct Win32WindowManager;

fn hwnd_to_isize(h: HWND) -> isize {
    h as isize
}
fn isize_to_hwnd(i: isize) -> HWND {
    i as HWND
}

struct FindByPidCtx {
    target_pid: u32,
    found_hwnd: HWND,
}

unsafe extern "system" fn enum_by_pid_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &mut *(lparam as *mut FindByPidCtx);
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if pid == ctx.target_pid && IsWindowVisible(hwnd) != 0 {
        let mut rect = std::mem::zeroed::<RECT>();
        if GetWindowRect(hwnd, &mut rect) != 0 {
            let w = rect.right - rect.left;
            let h = rect.bottom - rect.top;
            if w > 100 && h > 100 {
                ctx.found_hwnd = hwnd;
                return FALSE;
            }
        }
    }
    TRUE
}

struct FindChromeCtx {
    found_hwnd: HWND,
}

unsafe extern "system" fn enum_chrome_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &mut *(lparam as *mut FindChromeCtx);
    if IsWindowVisible(hwnd) != 0 {
        let mut class_buf = [0u16; 256];
        let len = GetClassNameW(hwnd, class_buf.as_mut_ptr(), 256);
        if len > 0 {
            let class_name = String::from_utf16_lossy(&class_buf[..len as usize]);
            if class_name.starts_with("Chrome_WidgetWin") {
                let mut rect = std::mem::zeroed::<RECT>();
                if GetWindowRect(hwnd, &mut rect) != 0 {
                    let w = rect.right - rect.left;
                    let h = rect.bottom - rect.top;
                    if w > 200 && h > 200 {
                        ctx.found_hwnd = hwnd;
                        return FALSE;
                    }
                }
            }
        }
    }
    TRUE
}

struct EnumChildrenCtx {
    children: Vec<(HWND, String, i32, i32)>,
}

unsafe extern "system" fn enum_children_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &mut *(lparam as *mut EnumChildrenCtx);
    let mut class_buf = [0u16; 256];
    let len = GetClassNameW(hwnd, class_buf.as_mut_ptr(), 256);
    let class_name = if len > 0 {
        String::from_utf16_lossy(&class_buf[..len as usize])
    } else {
        String::new()
    };
    let mut rect = std::mem::zeroed::<RECT>();
    let (w, h) = if GetWindowRect(hwnd, &mut rect) != 0 {
        (rect.right - rect.left, rect.bottom - rect.top)
    } else {
        (0, 0)
    };
    ctx.children.push((hwnd, class_name, w, h));
    TRUE
}

/// Find the WebView2 child window inside the Tauri main HWND.
///
/// Tauri/wry hosts the Edge WebView2 control as a direct child of the main
/// window with class `Chrome_WidgetWin_1` (Microsoft reuses the upstream
/// Chromium class name). We enumerate children and pick the LARGEST visible
/// Chrome_WidgetWin candidate — the WebView2 host spans the entire content
/// area while our embedded Chrome panel only covers a portion of it.
pub(crate) fn find_webview2_child(parent_hwnd: isize) -> Option<isize> {
    let parent = isize_to_hwnd(parent_hwnd);
    let mut ctx = EnumChildrenCtx {
        children: Vec::new(),
    };
    unsafe {
        EnumChildWindows(parent, Some(enum_children_cb), &mut ctx as *mut _ as LPARAM);
    }
    let mut webview2_candidates: Vec<(HWND, i32, i32)> = ctx
        .children
        .into_iter()
        .filter_map(|(h, class, w, ht)| {
            if class.starts_with("Chrome_WidgetWin") && w > 100 && ht > 100 {
                Some((h, w, ht))
            } else {
                None
            }
        })
        .collect();
    if webview2_candidates.is_empty() {
        return None;
    }
    // Largest area = WebView2 (full content area > embedded Chrome panel area).
    webview2_candidates.sort_by_key(|(_, w, h)| -(*w as i64 * *h as i64));
    Some(hwnd_to_isize(webview2_candidates[0].0))
}

struct CollectChromeCtx {
    hwnds: Vec<(HWND, i32, i32)>,
} // (hwnd, width, height)

unsafe extern "system" fn collect_chrome_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &mut *(lparam as *mut CollectChromeCtx);
    if IsWindowVisible(hwnd) == 0 {
        return TRUE;
    }
    let mut class_buf = [0u16; 256];
    let len = GetClassNameW(hwnd, class_buf.as_mut_ptr(), 256);
    if len > 0 {
        let class_name = String::from_utf16_lossy(&class_buf[..len as usize]);
        if class_name.starts_with("Chrome_WidgetWin") {
            let mut rect = std::mem::zeroed::<RECT>();
            if GetWindowRect(hwnd, &mut rect) != 0 {
                ctx.hwnds
                    .push((hwnd, rect.right - rect.left, rect.bottom - rect.top));
            }
        }
    }
    TRUE
}

/// Capture every currently-visible `Chrome_WidgetWin_*` HWND.
/// Call this *before* spawning our own Chrome so we can diff the set afterwards.
pub(crate) fn snapshot_chrome_hwnds() -> Vec<isize> {
    let mut ctx = CollectChromeCtx { hwnds: Vec::new() };
    unsafe {
        EnumWindows(Some(collect_chrome_cb), &mut ctx as *mut _ as LPARAM);
    }
    ctx.hwnds
        .into_iter()
        .map(|(h, _, _)| hwnd_to_isize(h))
        .collect()
}

/// Find the newly-spawned Chrome window by diffing against a pre-spawn baseline.
///
/// Why this exists:
///   `find_window_by_pid` can't reliably identify a freshly-launched Chrome —
///   the launcher PID dies immediately, the browser PID is a child we don't
///   track, and the class-name fallback happily returns any user-owned Chrome
///   that was already running. Embedding that window reparents the user's
///   normal browser into our shell and leaves our own Chrome floating.
///
/// Strategy: snapshot HWNDs pre-spawn → snapshot again → any Chrome_WidgetWin
/// class HWND that appeared is ours. If more than one appeared, prefer the
/// largest (content area), which matches the actual browser UI rather than
/// transient startup/splash windows.
pub(crate) fn find_new_chrome_window(
    baseline: &[isize],
    timeout_ms: u64,
) -> Result<super::PlatformHandle, String> {
    let baseline: std::collections::HashSet<isize> = baseline.iter().copied().collect();
    let attempts = (timeout_ms / 500).max(1);
    for _ in 0..attempts {
        let mut ctx = CollectChromeCtx { hwnds: Vec::new() };
        unsafe {
            EnumWindows(Some(collect_chrome_cb), &mut ctx as *mut _ as LPARAM);
        }
        // Keep only windows that did not exist before spawn and that look
        // like a real browser frame (> 200x200 — same threshold used elsewhere).
        let mut candidates: Vec<(HWND, i32, i32)> = ctx
            .hwnds
            .into_iter()
            .filter(|(h, w, ht)| !baseline.contains(&hwnd_to_isize(*h)) && *w > 200 && *ht > 200)
            .collect();
        if !candidates.is_empty() {
            // Largest area wins — real browser UI > any transient popups.
            candidates.sort_by_key(|(_, w, h)| -(*w as i64 * *h as i64));
            let (hwnd, _, _) = candidates[0];
            return Ok(super::PlatformHandle::Win32(hwnd_to_isize(hwnd)));
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    Err(format!(
        "No new Chrome window appeared within {timeout_ms} ms (baseline had {} windows)",
        baseline.len()
    ))
}

impl PlatformWindowManager for Win32WindowManager {
    fn find_window_by_pid(&self, pid: u32, timeout_ms: u64) -> Result<PlatformHandle, String> {
        let attempts = (timeout_ms / 500).max(1);
        for _ in 0..attempts {
            let mut ctx = FindByPidCtx {
                target_pid: pid,
                found_hwnd: std::ptr::null_mut(),
            };
            unsafe {
                EnumWindows(Some(enum_by_pid_cb), &mut ctx as *mut _ as LPARAM);
            }
            if !ctx.found_hwnd.is_null() {
                return Ok(PlatformHandle::Win32(hwnd_to_isize(ctx.found_hwnd)));
            }
            let mut chrome_ctx = FindChromeCtx {
                found_hwnd: std::ptr::null_mut(),
            };
            unsafe {
                EnumWindows(Some(enum_chrome_cb), &mut chrome_ctx as *mut _ as LPARAM);
            }
            if !chrome_ctx.found_hwnd.is_null() {
                return Ok(PlatformHandle::Win32(hwnd_to_isize(chrome_ctx.found_hwnd)));
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        Err(format!(
            "Chrome window not found for PID {pid} within {timeout_ms} ms"
        ))
    }

    fn find_window_by_name(&self, name: &str, timeout_ms: u64) -> Result<PlatformHandle, String> {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let attempts = (timeout_ms / 500).max(1);
        for attempt in 0..attempts {
            let hwnd = unsafe { FindWindowW(std::ptr::null(), wide.as_ptr()) };
            if !hwnd.is_null() {
                return Ok(PlatformHandle::Win32(hwnd_to_isize(hwnd)));
            }
            std::thread::sleep(std::time::Duration::from_millis(if attempt == 0 {
                1000
            } else {
                500
            }));
        }
        Err(format!("Window '{name}' not found within {timeout_ms} ms"))
    }

    fn embed(
        &self,
        parent: PlatformHandle,
        child: PlatformHandle,
        rect: WindowRect,
    ) -> Result<(), String> {
        let PlatformHandle::Win32(pv) = parent else {
            return Err("not Win32".into());
        };
        let PlatformHandle::Win32(cv) = child else {
            return Err("not Win32".into());
        };
        let (ph, ch) = (isize_to_hwnd(pv), isize_to_hwnd(cv));
        unsafe {
            // Convert Chrome's top-level window into a child window (style
            // transition WS_POPUP/WS_CAPTION/WS_THICKFRAME → WS_CHILD) before
            // reparenting. SetParent on a window that still carries WS_POPUP
            // is undefined behaviour.
            let style = GetWindowLongW(ch, GWL_STYLE) as u32;
            SetWindowLongW(
                ch,
                GWL_STYLE,
                ((style & !(WS_POPUP | WS_CAPTION | WS_THICKFRAME)) | WS_CHILD) as i32,
            );

            // WS_EX_NOACTIVATE intentionally NOT set here.
            // Allowing Chrome to receive Win32 keyboard focus on click is
            // required so the user can type in Chrome's URL bar, input fields,
            // etc. Focus restoration to Tauri's WebView2 is handled by
            // browser_shell_focus() — called from the frontend whenever a
            // Tauri HTML input receives DOM focus.

            // SetParent returns the previous parent (or NULL for top-level
            // windows, regardless of success). Use GetLastError to distinguish.
            let prev = SetParent(ch, ph);
            if prev.is_null() {
                let err = windows_sys::Win32::Foundation::GetLastError();
                if err != 0 {
                    return Err(format!("SetParent failed: Win32 error {err}"));
                }
            }

            // SWP_NOACTIVATE on the positioning call keeps Tauri's current
            // activation state intact — MoveWindow alone can trigger an
            // implicit activation transfer to the newly-reparented child.
            SetWindowPos(
                ch,
                std::ptr::null_mut(),
                rect.x,
                rect.y,
                rect.width as i32,
                rect.height as i32,
                SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );

            // Restore keyboard focus to Tauri's WebView2 child after SetParent.
            // Top-level Tauri HWND doesn't process keys itself — the actual
            // input handler lives in the WebView2 child (Chrome_WidgetWin_1
            // covering the full content area). We pick the LARGEST such child
            // — WebView2 spans the whole window; our embedded Chrome only
            // covers the panel rect, so it's always smaller.
            if let Some(webview2_isize) = find_webview2_child(pv) {
                let webview2 = isize_to_hwnd(webview2_isize);
                SetFocus(webview2);
                crate::log_verbose(&format!(
                    "[browser] focus restored to webview2 child Win32({webview2_isize})"
                ));
            } else {
                crate::log_verbose("[browser] could not locate webview2 child to refocus");
                SetFocus(ph);
            }
        }
        Ok(())
    }

    fn remap(&self, handle: PlatformHandle, rect: WindowRect) -> Result<(), String> {
        let PlatformHandle::Win32(v) = handle else {
            return Err("not Win32".into());
        };
        let h = isize_to_hwnd(v);
        unsafe {
            MoveWindow(
                h,
                rect.x,
                rect.y,
                rect.width as i32,
                rect.height as i32,
                TRUE,
            );
            ShowWindow(h, SW_SHOW);
            SetFocus(h);
        }
        Ok(())
    }

    fn resize(&self, handle: PlatformHandle, rect: WindowRect) -> Result<(), String> {
        let PlatformHandle::Win32(v) = handle else {
            return Err("not Win32".into());
        };
        unsafe {
            MoveWindow(
                isize_to_hwnd(v),
                rect.x,
                rect.y,
                rect.width as i32,
                rect.height as i32,
                TRUE,
            );
        }
        Ok(())
    }

    fn focus(&self, handle: PlatformHandle) -> Result<(), String> {
        let PlatformHandle::Win32(v) = handle else {
            return Ok(());
        };
        unsafe {
            SetFocus(isize_to_hwnd(v));
        }
        Ok(())
    }

    fn show(&self, handle: PlatformHandle) -> Result<(), String> {
        let PlatformHandle::Win32(v) = handle else {
            return Ok(());
        };
        let h = isize_to_hwnd(v);
        unsafe {
            ShowWindow(h, SW_SHOW);
            SetFocus(h);
        }
        Ok(())
    }

    fn hide(&self, handle: PlatformHandle) -> Result<(), String> {
        let PlatformHandle::Win32(v) = handle else {
            return Ok(());
        };
        unsafe {
            ShowWindow(isize_to_hwnd(v), SW_HIDE);
        }
        Ok(())
    }

    fn chrome_bin(&self) -> Option<String> {
        // 1. Chrome for Testing (installed by agent-browser install) — preferred
        //    because it's version-stable and always available when bundled.
        let home = std::env::var("USERPROFILE").unwrap_or_default();
        if !home.is_empty() {
            let base = std::path::PathBuf::from(&home)
                .join(".agent-browser")
                .join("browsers");
            if let Ok(entries) = std::fs::read_dir(&base) {
                let mut dirs: Vec<_> = entries
                    .flatten()
                    .filter(|e| e.file_name().to_string_lossy().starts_with("chrome-"))
                    .collect();
                dirs.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
                for entry in dirs {
                    let bin = entry.path().join("chrome.exe");
                    if bin.exists() {
                        return Some(bin.to_string_lossy().to_string());
                    }
                }
            }
        }

        // 2. System Chrome (well-known install paths)
        let pf = std::env::var("ProgramFiles").unwrap_or_default();
        let pf86 = std::env::var("ProgramFiles(x86)").unwrap_or_default();
        let la = std::env::var("LOCALAPPDATA").unwrap_or_default();
        for path in &[
            format!("{pf}\\Google\\Chrome\\Application\\chrome.exe"),
            format!("{pf86}\\Google\\Chrome\\Application\\chrome.exe"),
            format!("{la}\\Google\\Chrome\\Application\\chrome.exe"),
        ] {
            if std::path::Path::new(path).exists() {
                return Some(path.clone());
            }
        }
        for name in &["chrome", "google-chrome", "chromium"] {
            let mut cmd = Command::new("where.exe");
            cmd.arg(name);
            hide_console(&mut cmd);
            if let Ok(out) = cmd.output() {
                if out.status.success() {
                    let p = String::from_utf8_lossy(&out.stdout)
                        .lines()
                        .next()
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if !p.is_empty() {
                        return Some(p);
                    }
                }
            }
        }
        None
    }

    fn chrome_spawn_args(&self) -> (Vec<String>, Vec<(String, String)>) {
        (vec![], vec![])
    }

    fn kill_lingering_chrome(&self) {
        // wmic is a GUI-hosted tool invocation — suppress its console window.
        let mut cmd = Command::new("wmic");
        cmd.args([
            "process",
            "where",
            "commandline like '%naia%chrome-profile%'",
            "call",
            "terminate",
        ]);
        hide_console(&mut cmd);
        let _ = cmd.output();
    }

    fn supports_native_embed(&self) -> bool {
        true
    }

    fn overlay_position(
        &self,
        tauri: super::PlatformHandle,
        chrome: super::PlatformHandle,
        rect: super::WindowRect,
    ) -> Result<(), String> {
        let super::PlatformHandle::Win32(tv) = tauri else {
            return Err("tauri not Win32".into());
        };
        let super::PlatformHandle::Win32(cv) = chrome else {
            return Err("chrome not Win32".into());
        };
        let (th, ch) = (isize_to_hwnd(tv), isize_to_hwnd(cv));
        let mut pt = POINT {
            x: rect.x,
            y: rect.y,
        };
        unsafe {
            ClientToScreen(th, &mut pt);
            let screen_rect = RECT {
                left: pt.x,
                top: pt.y,
                right: pt.x + rect.width as i32,
                bottom: pt.y + rect.height as i32,
            };

            // Remove OS window decorations (title bar, resize border, system menu).
            // Chrome's internal browser UI (address bar, tabs) is part of its own rendering
            // and is unaffected. Without WS_CAPTION, title-bar dragging cannot move the
            // overlay out of position. Apply once — style bits persist across calls.
            let style = GetWindowLongW(ch, GWL_STYLE) as u32;
            if style & (WS_CAPTION | WS_THICKFRAME) != 0 {
                SetWindowLongW(
                    ch,
                    GWL_STYLE,
                    (style
                        & !(WS_CAPTION
                            | WS_THICKFRAME
                            | WS_SYSMENU
                            | WS_MINIMIZEBOX
                            | WS_MAXIMIZEBOX)) as i32,
                );
                // WS_EX_TOOLWINDOW: hide from taskbar and Alt+Tab.
                let exstyle = GetWindowLongW(ch, GWL_EXSTYLE) as u32;
                SetWindowLongW(ch, GWL_EXSTYLE, (exstyle | WS_EX_TOOLWINDOW) as i32);
            }

            // Overwrite Chrome's saved WINDOWPLACEMENT (rcNormalPosition).
            // Without this, Chrome restores its previous standalone-window position
            // (stored in the profile from a prior session) when it receives WM_ACTIVATE.
            // By making rcNormalPosition == our overlay rect, restore is a no-op.
            let mut placement: WINDOWPLACEMENT = std::mem::zeroed();
            placement.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
            if GetWindowPlacement(ch, &mut placement) != 0 {
                placement.flags = 0;
                placement.showCmd = SW_SHOWNORMAL as u32;
                placement.rcNormalPosition = screen_rect;
                SetWindowPlacement(ch, &placement);
            }

            // HWND_TOPMOST: Chrome floats above Tauri (non-topmost) at all times.
            // SWP_NOACTIVATE: Win32 focus stays with Tauri's WebView2 thread.
            // SWP_FRAMECHANGED: forces non-client area redraw after style change.
            SetWindowPos(
                ch,
                HWND_TOPMOST,
                pt.x,
                pt.y,
                rect.width as i32,
                rect.height as i32,
                SWP_SHOWWINDOW | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
        }
        Ok(())
    }

    fn overlay_enforce_pos(
        &self,
        tauri: super::PlatformHandle,
        chrome: super::PlatformHandle,
        rect: super::WindowRect,
    ) -> Result<(), String> {
        let super::PlatformHandle::Win32(tv) = tauri else {
            return Ok(());
        };
        let super::PlatformHandle::Win32(cv) = chrome else {
            return Ok(());
        };
        let (th, ch) = (isize_to_hwnd(tv), isize_to_hwnd(cv));
        let mut pt = POINT {
            x: rect.x,
            y: rect.y,
        };
        unsafe {
            ClientToScreen(th, &mut pt);
            let (tx, ty, tw, th_) = (pt.x, pt.y, rect.width as i32, rect.height as i32);

            // Skip SetWindowPos when Chrome is already in place.
            // Unconditional SetWindowPos triggers Chrome's WM_WINDOWPOSCHANGED
            // handler which causes focus contention and flickering while the user
            // types in the message input. Only reposition on actual drift.
            let mut cur: RECT = std::mem::zeroed();
            let drifted = if GetWindowRect(ch, &mut cur) != 0 {
                let cw = cur.right - cur.left;
                let cur_h = cur.bottom - cur.top;
                (cur.left - tx).abs() > 2
                    || (cur.top - ty).abs() > 2
                    || (cw - tw).abs() > 2
                    || (cur_h - th_).abs() > 2
            } else {
                true
            };

            if drifted {
                // No SWP_FRAMECHANGED — style already set by overlay_position at init.
                SetWindowPos(ch, HWND_TOPMOST, tx, ty, tw, th_, SWP_NOACTIVATE);
            }
        }
        Ok(())
    }

    fn show_no_activate(&self, handle: super::PlatformHandle) -> Result<(), String> {
        let super::PlatformHandle::Win32(v) = handle else {
            return Ok(());
        };
        unsafe {
            SetWindowPos(
                isize_to_hwnd(v),
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW | SWP_NOACTIVATE,
            );
        }
        Ok(())
    }

    fn get_window_screen_rect(
        &self,
        handle: super::PlatformHandle,
    ) -> Option<(i32, i32, u32, u32)> {
        let super::PlatformHandle::Win32(v) = handle else {
            return None;
        };
        unsafe {
            let mut r: RECT = std::mem::zeroed();
            if GetWindowRect(isize_to_hwnd(v), &mut r) != 0 {
                Some((
                    r.left,
                    r.top,
                    (r.right - r.left) as u32,
                    (r.bottom - r.top) as u32,
                ))
            } else {
                None
            }
        }
    }

    fn embed_enforce_pos(
        &self,
        child: super::PlatformHandle,
        rect: super::WindowRect,
        visible: bool,
    ) -> Result<(), String> {
        let super::PlatformHandle::Win32(cv) = child else {
            return Ok(());
        };
        let ch = isize_to_hwnd(cv);
        unsafe {
            // ── Style check ───────────────────────────────────────────────────
            let style = GetWindowLongW(ch, GWL_STYLE) as u32;
            let style_bad = style & WS_CHILD == 0 || style & (WS_CAPTION | WS_THICKFRAME) != 0;
            if style_bad {
                SetWindowLongW(
                    ch,
                    GWL_STYLE,
                    ((style
                        & !(WS_POPUP
                            | WS_CAPTION
                            | WS_THICKFRAME
                            | WS_SYSMENU
                            | WS_MINIMIZEBOX
                            | WS_MAXIMIZEBOX))
                        | WS_CHILD) as i32,
                );
            }

            // ── Position check (skip MoveWindow when already in place) ────────
            // Unconditional MoveWindow triggers Chrome's WM_WINDOWPOSCHANGED
            // handler which re-claims keyboard focus on every 500 ms tick.
            // Only move when Chrome has actually drifted from the expected rect.
            let parent = GetParent(ch);
            let pos_bad = if !parent.is_null() {
                let mut screen: RECT = std::mem::zeroed();
                if GetWindowRect(ch, &mut screen) != 0 {
                    let mut pt = POINT {
                        x: screen.left,
                        y: screen.top,
                    };
                    ScreenToClient(parent, &mut pt);
                    let w = screen.right - screen.left;
                    let h = screen.bottom - screen.top;
                    (pt.x - rect.x).abs() > 2
                        || (pt.y - rect.y).abs() > 2
                        || (w - rect.width as i32).abs() > 2
                        || (h - rect.height as i32).abs() > 2
                } else {
                    style_bad
                }
            } else {
                style_bad
            };

            if !style_bad && !pos_bad {
                return Ok(());
            }

            // ── Restore if Chrome min/maximized (only when supposed to be visible) ──
            if visible {
                let mut placement: WINDOWPLACEMENT = std::mem::zeroed();
                placement.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
                if GetWindowPlacement(ch, &mut placement) != 0
                    && placement.showCmd != SW_SHOWNORMAL as u32
                    && placement.showCmd != SW_SHOW as u32
                {
                    ShowWindow(ch, SW_RESTORE);
                }
            }
            if pos_bad {
                MoveWindow(
                    ch,
                    rect.x,
                    rect.y,
                    rect.width as i32,
                    rect.height as i32,
                    FALSE,
                );
            }
        }
        Ok(())
    }
}
