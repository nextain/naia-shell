//! Chrome subprocess embedding (legacy) + standalone login Chrome.
//!
//! The embedded browser panel was replaced by Tauri 2 multi-webview
//! (see browser_webview.rs). This file is kept for:
//!   - browser_open_login / browser_chrome_testing_ready (auth flow)
//!   - browser_embed_kill (kills login Chrome on app exit)
//!
//! The old embed commands (browser_embed_*) are no longer registered in
//! invoke_handler and will be removed in a future cleanup pass.
#![allow(dead_code)]
//! Chrome subprocess embedding for the Naia browser panel.
//!
//! Architecture:
//!   Chrome (--remote-debugging-port=<port>)
//!     ├── Native window embedded/overlaid into Tauri via platform abstraction
//!     │     Linux:   XReparentWindow (x11rb) — supports_native_embed: true
//!     │     Windows: SetParent (WS_CHILD reparenting) — supports_native_embed: true
//!     │     Other:   overlay via SetWindowPos — supports_native_embed: false
//!     └── CDP endpoint → agent-browser connect <port> (AI interface)
//!
//! Platform support:
//!   Linux (X11 / XWayland): full embedding via x11rb
//!   Windows:                overlay mode — Chrome positioned as top-level window with SWP_NOACTIVATE
//!   macOS:                  NOT YET SUPPORTED (add PlatformWindowManager impl)

use crate::platform::{self, PlatformHandle, WindowRect};
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

// ─── Global state ─────────────────────────────────────────────────────────────

struct ChromeState {
	process: Option<Child>,
	port: u16,
	chrome_handle: PlatformHandle,
	tauri_handle: PlatformHandle, // cached so browser_shell_focus / overlay resize don't re-search
	tmpdir: String,
	pid: u32,
	overlay_mode: bool,    // true on platforms where supports_native_embed() == false
	last_client_rect: WindowRect, // panel rect in Tauri client coords — for overlay watchdog
	chrome_visible: bool,  // false while browser_embed_hide is active — watchdog skips repositioning
}

impl ChromeState {
	const fn new() -> Self {
		Self {
			process: None,
			port: 0,
			chrome_handle: PlatformHandle::None,
			tauri_handle: PlatformHandle::None,
			tmpdir: String::new(),
			pid: 0,
			overlay_mode: false,
			last_client_rect: WindowRect { x: 0, y: 0, width: 0, height: 0 },
			chrome_visible: false,
		}
	}
}

/// Spawn a background thread that:
/// 1. Watches Chrome's PID → emits `browser_closed` if it exits unexpectedly.
/// 2. Guards tabs via CDP REST → opens a new tab if all tabs are closed
///    (works together with `--keep-alive-for-test` which prevents Chrome from
///    exiting when the last tab is closed).
/// 3. Detects desktop auth-complete URL → emits `naia_auth_complete` with key/user_id (exactly once).
fn spawn_chrome_monitor(app: AppHandle, pid: u32, port: u16) {
	std::thread::spawn(move || {
		let version_url = format!("http://127.0.0.1:{port}/json/version");
		let list_url = format!("http://127.0.0.1:{port}/json/list");
		let new_tab_url = format!("http://127.0.0.1:{port}/json/new");
		let mut auth_emitted = false;
		let mut cdp_fail_streak = 0u32;
		const CDP_FAIL_LIMIT: u32 = 6; // 3 s of consecutive failures
		loop {
			std::thread::sleep(std::time::Duration::from_millis(500));

			// Position watchdog: re-enforce Chrome's position/style every 500 ms.
			// Chrome periodically restores its own WINDOWPLACEMENT from the profile
			// (on WM_ACTIVATE, tab drag, min/max button clicks) which undoes our
			// embed/overlay positioning. try_lock avoids blocking CDP checks.
			if let Ok(state) = CHROME.try_lock() {
				if state.pid == pid && state.chrome_handle.is_valid() && state.last_client_rect.width > 0 {
					if state.overlay_mode && state.chrome_visible && state.tauri_handle.is_valid() {
						let (th, ch, rect) =
							(state.tauri_handle, state.chrome_handle, state.last_client_rect);
						drop(state);
						let _ = platform::window_manager().overlay_enforce_pos(th, ch, rect);
					} else if !state.overlay_mode {
						let (ch, rect, visible) =
							(state.chrome_handle, state.last_client_rect, state.chrome_visible);
						drop(state);
						let _ = platform::window_manager().embed_enforce_pos(ch, rect, visible);
					}
				}
			}

			// CDP health is the primary liveness signal.
			// PID check is secondary: a zombie Chrome keeps its PID but loses CDP.
			// Flatpak launcher PIDs die immediately after forking Chrome, so
			// do NOT treat PID death as Chrome death when CDP is still alive.
			let cdp_alive = ureq::get(&version_url)
				.call()
				.map(|r| r.status() == 200)
				.unwrap_or(false);

			if cdp_alive {
				cdp_fail_streak = 0;
			} else {
				// PID also gone — Chrome is truly dead
				let pid_exists = crate::platform::is_pid_alive(pid);
				if !pid_exists {
					cdp_fail_streak = CDP_FAIL_LIMIT;
				} else {
					cdp_fail_streak += 1;
				}
			}

			if cdp_fail_streak >= CDP_FAIL_LIMIT {
				// Clear state
				if let Ok(mut state) = CHROME.lock() {
					if state.pid == pid {
						state.process = None;
						state.chrome_handle = PlatformHandle::None;
						state.port = 0;
						state.pid = 0;
					}
				}
				let _ = app.emit("browser_closed", ());
				break;
			}

			// Skip tab guard + auth detection when CDP is not responding
			if !cdp_alive { continue; }

			// Tab guard + auth-complete detection
			if let Ok(resp) = ureq::get(&list_url).call() {
				if let Ok(body) = resp.into_string() {
					if !body.contains("\"page\"") {
						let _ = ureq::get(&new_tab_url).call();
					}
					// Emit naia_auth_complete when Chrome lands on /desktop/auth-complete.
					// auth_emitted guards against firing every 500 ms while Chrome stays there.
					// Reset when Chrome navigates away so re-login works correctly.
					if body.contains("/desktop/auth-complete") {
						if !auth_emitted {
							if let Some(auth) = parse_auth_complete_from_tab_list(&body) {
								let _ = app.emit("naia_auth_complete", auth);
								auth_emitted = true;
							}
						}
					} else {
						// Reset so re-login in the same Chrome session works
						auth_emitted = false;
					}
				}
			}
		}
	});
}

/// Parse `key` and `user_id` from the CDP /json/list response body.
/// Returns `None` if the auth-complete URL is not found or has no key.
/// Allowed hosts for auth-complete tab detection.
/// Only tabs served by the Naia web app may trigger token extraction.
const AUTH_COMPLETE_HOSTS: &[&str] = &["naia.nextain.io", "localhost", "127.0.0.1"];

fn parse_auth_complete_from_tab_list(body: &str) -> Option<serde_json::Value> {
	use serde_json::Value;
	let tabs: Vec<Value> = serde_json::from_str(body).ok()?;
	for tab in &tabs {
		// Use unwrap_or so tabs without a "url" field are skipped, not early-exit the function.
		let url = tab.get("url").and_then(|v| v.as_str()).unwrap_or("");
		if !url.contains("/desktop/auth-complete") {
			continue;
		}
		let parsed = match url::Url::parse(url) {
			Ok(u) => u,
			Err(_) => continue,
		};
		// Guard: only accept auth-complete from trusted Naia hosts.
		// Prevents a rogue tab (e.g. attacker redirect) from injecting a token.
		let host = parsed.host_str().unwrap_or("");
		if !AUTH_COMPLETE_HOSTS.iter().any(|&h| host == h) {
			continue;
		}
		let key = parsed
			.query_pairs()
			.find(|(k, _)| k == "key")
			.map(|(_, v)| v.into_owned())?;
		if key.is_empty() {
			continue;
		}
		let user_id = parsed
			.query_pairs()
			.find(|(k, _)| k == "user_id")
			.map(|(_, v)| v.into_owned())
			.unwrap_or_default();
		return Some(serde_json::json!({
			"naiaKey": key,
			"naiaUserId": user_id,
		}));
	}
	None
}

static CHROME: Mutex<ChromeState> = Mutex::new(ChromeState::new());

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Find a free TCP port by binding to port 0.
fn find_free_port() -> u16 {
	use std::net::TcpListener;
	TcpListener::bind("127.0.0.1:0")
		.ok()
		.and_then(|l| l.local_addr().ok())
		.map(|a| a.port())
		.unwrap_or(19222)
}

/// Detect platform-specific native agent-browser binary name.
fn agent_browser_native_name() -> &'static str {
	if cfg!(target_os = "windows") {
		"agent-browser-win32-x64.exe"
	} else if cfg!(target_os = "macos") {
		if cfg!(target_arch = "aarch64") { "agent-browser-darwin-arm64" }
		else { "agent-browser-darwin-x64" }
	} else if cfg!(target_arch = "aarch64") {
		"agent-browser-linux-arm64"
	} else {
		"agent-browser-linux-x64"
	}
}

/// Ensure the native binary is executable (no-op on Windows; sets +x on Unix).
#[allow(unused_variables)]
fn ensure_executable(path: &std::path::Path) {
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		if let Ok(meta) = std::fs::metadata(path) {
			let mut perms = meta.permissions();
			let mode = perms.mode();
			if mode & 0o111 == 0 {
				perms.set_mode(mode | 0o755);
				let _ = std::fs::set_permissions(path, perms);
			}
		}
	}
}

/// Resolve `agent-browser` native binary.
///
/// Search order:
///   1. Bundled: `<exe_dir>/agent/node_modules/agent-browser/bin/<native>`
///      (production Tauri bundle — node_modules is a Tauri resource)
///   2. Dev: workspace-relative path from CWD
///      (pnpm run tauri:dev from shell/)
///   3. PATH / nvm fallback (existing installs)
fn agent_browser_bin() -> Option<String> {
	let native = agent_browser_native_name();

	// 1. Bundled binary (production app)
	if let Ok(exe) = std::env::current_exe() {
		if let Some(dir) = exe.parent() {
			let bundled = dir.join("agent/node_modules/agent-browser/bin").join(native);
			if bundled.exists() {
				ensure_executable(&bundled);
				return Some(bundled.to_string_lossy().to_string());
			}
		}
	}

	// 2. Dev mode: CWD is typically shell/ when running `pnpm run tauri:dev`
	for rel in &[
		"../../agent/node_modules/agent-browser/bin",
		"../agent/node_modules/agent-browser/bin",
		"agent/node_modules/agent-browser/bin",
	] {
		let p = std::path::Path::new(rel).join(native);
		if p.exists() {
			ensure_executable(&p);
			if let Ok(abs) = p.canonicalize() {
				return Some(abs.to_string_lossy().to_string());
			}
		}
	}

	// 3. PATH lookup
	let mut lookup = Command::new(if cfg!(windows) { "where.exe" } else { "which" });
	lookup.arg("agent-browser");
	platform::hide_console(&mut lookup);
	if let Ok(out) = lookup.output() {
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

	// 4. nvm fallback
	let home = std::env::var("HOME")
		.or_else(|_| std::env::var("USERPROFILE"))
		.unwrap_or_default();
	if home.is_empty() {
		return None;
	}
	#[cfg(unix)]
	{
		for suffix in &[".config/nvm/versions/node", ".nvm/versions/node"] {
			let base = format!("{home}/{suffix}");
			if let Ok(mut dirs) = std::fs::read_dir(&base) {
				if let Some(Ok(entry)) = dirs.next() {
					let bin = entry.path().join("bin/agent-browser");
					if bin.exists() {
						return Some(bin.to_string_lossy().to_string());
					}
				}
			}
		}
	}
	#[cfg(windows)]
	{
		let nvm_home = std::env::var("NVM_HOME")
			.unwrap_or_else(|_| format!("{home}\\AppData\\Roaming\\nvm"));
		if let Ok(dirs) = std::fs::read_dir(&nvm_home) {
			for entry in dirs.flatten() {
				let bin = entry.path().join("agent-browser.cmd");
				if bin.exists() {
					return Some(bin.to_string_lossy().to_string());
				}
			}
		}
	}
	None
}

/// Find Chrome for Testing installed by `agent-browser install`.
///
/// Default location: `~/.agent-browser/browsers/chrome-{version}/`
/// Returns the Chrome executable path if found.
fn chrome_for_testing_bin() -> Option<String> {
	let home = std::env::var("HOME")
		.or_else(|_| std::env::var("USERPROFILE"))
		.unwrap_or_default();
	if home.is_empty() {
		return None;
	}
	let base = std::path::PathBuf::from(&home)
		.join(".agent-browser")
		.join("browsers");
	let mut chrome_dirs: Vec<_> = std::fs::read_dir(&base)
		.ok()?
		.flatten()
		.filter(|e| e.file_name().to_string_lossy().starts_with("chrome-"))
		.collect();
	// Latest version first (lexicographic desc works for semver)
	chrome_dirs.sort_by(|a, b| b.file_name().cmp(&a.file_name()));

	for entry in chrome_dirs {
		#[cfg(target_os = "windows")]
		let bin = entry.path().join("chrome.exe");
		#[cfg(target_os = "macos")]
		let bin = entry.path().join(
			"Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
		);
		#[cfg(target_os = "linux")]
		let bin = entry.path().join("chrome");

		if bin.exists() {
			return Some(bin.to_string_lossy().to_string());
		}
	}
	None
}

/// Spawn Chrome as a subprocess with CDP enabled.
///
/// Uses platform::window_manager() for Chrome binary discovery and
/// platform-specific launch arguments (e.g., --ozone-platform=x11 on Linux).
/// Remove Chrome session/tab files from the Default profile so Chrome does not
/// show the "Restore pages?" dialog on the next launch.  The files are only
/// written by a clean Chrome shutdown; since we always kill Chrome with
/// TerminateProcess / SIGKILL, they are always stale.
fn clear_chrome_crash_state(tmpdir: &str) {
	let default_dir = std::path::Path::new(tmpdir).join("Default");
	if !default_dir.exists() {
		return; // Profile not created yet — nothing to clear
	}
	for name in &["Last Session", "Last Tabs", "Current Session", "Current Tabs"] {
		let _ = std::fs::remove_file(default_dir.join(name));
	}
	crate::log_verbose("[browser] Chrome crash state cleared");
}

fn spawn_chrome(port: u16, tmpdir: &str) -> Result<Child, String> {
	let wm = platform::window_manager();
	let bin = wm.chrome_bin().ok_or("Chrome not found (searched PATH and well-known locations)")?;
	let (extra_args, extra_env) = wm.chrome_spawn_args();

	// Flatpak handling (Linux-only: detected by FLATPAK_APP_PREFIX in bin path)
	#[cfg(target_os = "linux")]
	let is_flatpak_chrome = bin.starts_with("flatpak::");
	#[cfg(not(target_os = "linux"))]
	let is_flatpak_chrome = false;

	let mut chrome_flags: Vec<String> = extra_args;
	chrome_flags.extend([
		"--keep-alive-for-test".into(),
		"--no-first-run".into(),
		"--no-default-browser-check".into(),
		"--disable-sync".into(),
		"--disable-extensions".into(),
		"--disable-infobars".into(),
		"--disable-session-crashed-bubble".into(),
		"--disable-dev-shm-usage".into(),
		format!("--remote-debugging-port={port}"),
		format!("--user-data-dir={tmpdir}"),
	]);

	// Execution matrix (Naia mode × Chrome install):
	//   Naia native  + Chrome native  → direct exec
	//   Naia native  + Chrome Flatpak → flatpak run --command=<bin> <app_id>
	//   Naia Flatpak + Chrome native  → flatpak-spawn --host <bin>
	//   Naia Flatpak + Chrome Flatpak → flatpak-spawn --host flatpak run
	let mut cmd = if is_flatpak_chrome {
		#[cfg(target_os = "linux")]
		{
			let app_id = &bin["flatpak::".len()..];
			let bin_name = if app_id.contains("chromium") || app_id.contains("Chromium") {
				"chromium"
			} else {
				"google-chrome"
			};
			let command_flag = format!("--command={bin_name}");
			let is_flatpak = std::env::var("FLATPAK").is_ok();
			if is_flatpak {
				let mut c = Command::new("flatpak-spawn");
				c.args([
					"--host",
					"flatpak",
					"run",
					"--filesystem=home",
					"--env=DISPLAY=:0",
					"--env=GDK_BACKEND=x11",
					&command_flag,
					app_id,
				]);
				c
			} else {
				let mut c = Command::new("flatpak");
				c.args([
					"run",
					"--filesystem=home",
					"--env=DISPLAY=:0",
					"--env=GDK_BACKEND=x11",
					&command_flag,
					app_id,
				]);
				c
			}
		}
		#[cfg(not(target_os = "linux"))]
		{
			return Err("Flatpak Chrome is only supported on Linux".into());
		}
	} else {
		#[cfg(target_os = "linux")]
		{
			let is_flatpak = std::env::var("FLATPAK").is_ok();
			if is_flatpak {
				let mut c = Command::new("flatpak-spawn");
				c.arg("--host").arg(&bin);
				c
			} else {
				Command::new(&bin)
			}
		}
		#[cfg(not(target_os = "linux"))]
		{
			Command::new(&bin)
		}
	};

	cmd.args(&chrome_flags);
	for (key, val) in &extra_env {
		cmd.env(key, val);
	}
	cmd.stdout(std::process::Stdio::null())
		.stderr(std::process::Stdio::null());
	#[cfg(windows)]
	platform::hide_console(&mut cmd);
	cmd.spawn()
		.map_err(|e| format!("Failed to spawn Chrome: {e}"))
}

/// Wait for Chrome to expose its CDP endpoint (up to 8 s).
fn wait_for_cdp(port: u16) -> Result<(), String> {
	let url = format!("http://127.0.0.1:{port}/json/version");
	for _ in 0..16 {
		if let Ok(resp) = ureq::get(&url).call() {
			if resp.status() == 200 {
				return Ok(());
			}
		}
		std::thread::sleep(std::time::Duration::from_millis(500));
	}
	Err(format!("Chrome CDP not ready on port {port} after 8 s"))
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

/// Returns true if a supported Chrome binary is available.
#[tauri::command]
pub fn browser_check() -> bool {
	platform::window_manager().chrome_bin().is_some()
}

/// Returns true if agent-browser is installed.
#[tauri::command]
pub fn browser_agent_check() -> bool {
	agent_browser_bin().is_some()
}

/// Spawn Chrome, wait for CDP, embed window into Tauri via platform abstraction.
///
/// `x`, `y` — browser panel origin relative to Tauri window (from React getBoundingClientRect)
/// `width`, `height` — panel content area dimensions
///
/// NOTE: This is a synchronous (blocking) Tauri command intentionally.
/// It runs on Tauri's blocking thread pool (not the async executor) so it can
/// sleep while waiting for Chrome to start without blocking other async commands.
#[tauri::command]
pub fn browser_embed_init(
	app: AppHandle,
	x: f64,
	y: f64,
	width: f64,
	height: f64,
) -> Result<u16, String> {
	// Diagnostic escape hatch: when NAIA_DISABLE_BROWSER_EMBED is set we
	// short-circuit before any Chrome spawn / SetParent / focus handling.
	// Use this to confirm whether the browser embed is the cause of an
	// observed input/focus regression — if input still misbehaves with
	// the embed disabled, the regression is somewhere else entirely.
	if std::env::var("NAIA_DISABLE_BROWSER_EMBED").is_ok() {
		crate::log_both(
			"[browser] init skipped — NAIA_DISABLE_BROWSER_EMBED is set",
		);
		return Err("browser embed disabled by NAIA_DISABLE_BROWSER_EMBED".into());
	}

	let wm = platform::window_manager();
	let rect = WindowRect::from_f64(x, y, width, height);
	let state = CHROME.lock().unwrap();

	// If Chrome process already exists, re-embed (don't spawn again).
	// This handles two cases:
	//   a) chrome_handle is valid — fully embedded/overlaid, just reposition
	//   b) chrome_handle is None — React StrictMode detached; re-attach
	if state.process.is_some() {
		let port = state.port;
		let pid = state.pid;
		let existing_handle = state.chrome_handle;
		let cached_tauri = state.tauri_handle;
		let is_overlay = state.overlay_mode;
		drop(state);

		crate::log_verbose(&format!(
			"[browser] re-embed: pid={pid} existing_handle={existing_handle:?}"
		));
		let chrome_handle = if existing_handle.is_valid() {
			existing_handle
		} else {
			wm.find_window_by_pid(pid, 6000)?
		};
		crate::log_verbose(&format!("[browser] re-embed: chrome_handle={chrome_handle:?}"));
		if is_overlay {
			// In overlay mode we need the Tauri handle for ClientToScreen conversion.
			let tauri_h = if cached_tauri.is_valid() {
				cached_tauri
			} else {
				wm.find_window_by_name("Naia", 10000)?
			};
			wm.overlay_show(tauri_h, chrome_handle, rect)?;
			let mut s = CHROME.lock().unwrap();
			s.chrome_handle = chrome_handle;
			s.tauri_handle = tauri_h;
		} else {
			wm.remap(chrome_handle, rect)?;
			CHROME.lock().unwrap().chrome_handle = chrome_handle;
		}
		crate::log_verbose("[browser] re-embed OK");
		return Ok(port);
	}

	crate::log_verbose("[browser] init: spawning Chrome");
	// Kill lingering Chrome processes from previous sessions
	wm.kill_lingering_chrome();
	std::thread::sleep(std::time::Duration::from_millis(300));

	// Snapshot Chrome HWNDs *before* spawning our own instance.
	// Used after spawn to pick the newly-created window via diff — avoids
	// grabbing the user's pre-existing normal Chrome window on Windows
	// (find_window_by_pid's class-name fallback is unreliable when multiple
	// Chrome instances coexist).
	let chrome_baseline = platform::snapshot_chrome_hwnds();
	crate::log_verbose(&format!(
		"[browser] chrome_baseline: {} existing windows",
		chrome_baseline.len()
	));

	let port = find_free_port();
	// Use a persistent profile directory so Chrome login sessions survive app restarts.
	let home = std::env::var("HOME")
		.or_else(|_| std::env::var("USERPROFILE"))
		.unwrap_or_default();

	// Determine if Chrome is installed as a Flatpak (bin starts with "flatpak::")
	let chrome_bin = platform::window_manager().chrome_bin().unwrap_or_default();
	let is_flatpak_chrome = chrome_bin.starts_with("flatpak::");

	let tmpdir = if !home.is_empty() {
		if is_flatpak_chrome {
			// Flatpak Chrome can't access ~/.naia/ directly — use a path under
			// the Flatpak app's XDG data dir which is always accessible inside the sandbox.
			let app_id = &chrome_bin["flatpak::".len()..];
			let p = std::path::PathBuf::from(&home)
				.join(".var").join("app").join(app_id).join("data").join("naia-profile");
			p.to_string_lossy().to_string()
		} else {
			let p = std::path::PathBuf::from(&home).join(".naia").join("chrome-profile");
			p.to_string_lossy().to_string()
		}
	} else {
		std::env::temp_dir()
			.join("naia-chrome-profile")
			.to_string_lossy()
			.to_string()
	};
	crate::log_verbose(&format!("[browser] Chrome profile dir: {tmpdir}"));
	std::fs::create_dir_all(&tmpdir)
		.map_err(|e| format!("Failed to create Chrome profile dir: {e}"))?;

	// Clear Chrome's crash state before spawning so the "Restore pages?" dialog
	// doesn't appear. The profile is persistent (login sessions survive restarts)
	// but we always kill Chrome with SIGKILL/TerminateProcess, so Chrome always
	// thinks it crashed. Clearing the session files tells Chrome to start fresh.
	clear_chrome_crash_state(&tmpdir);

	let child = spawn_chrome(port, &tmpdir)?;
	let pid = child.id();
	crate::log_verbose(&format!("[browser] Chrome spawned: pid={pid} port={port}"));

	// Store process immediately so it's tracked even if later steps fail.
	{
		let mut s = state; // re-use the held lock
		s.process = Some(child);
		s.port = port;
		s.tmpdir = tmpdir.clone();
		s.pid = pid;
	}

	// Wait for CDP (blocking wait)
	crate::log_verbose(&format!("[browser] waiting for CDP on port {port}..."));
	if let Err(e) = wait_for_cdp(port) {
		crate::log_both(&format!("[browser] CDP wait failed: {e}"));
		let mut s = CHROME.lock().unwrap();
		if let Some(mut child) = s.process.take() {
			let _ = child.kill();
		}
		s.port = 0;
		s.pid = 0;
		return Err(e);
	}
	crate::log_verbose("[browser] CDP ready");

	// Find the Chrome window we just spawned via the pre/post diff.
	// This is strictly more reliable than PID-based lookup — Chrome's launcher
	// PID dies immediately and the actual browser process is a child we don't
	// own, so we identify "our" window by "wasn't there before, is there now".
	let chrome_handle = match platform::find_new_chrome_window(&chrome_baseline, 6000) {
		Ok(h) => h,
		Err(e) => {
			crate::log_both(&format!("[browser] diff lookup failed: {e} — fallback to PID lookup"));
			wm.find_window_by_pid(pid, 6000)?
		}
	};
	crate::log_verbose(&format!("[browser] chrome_handle={chrome_handle:?}"));

	// Find Tauri's native window
	crate::log_verbose("[browser] searching for Tauri window by name 'Naia'...");
	let tauri_handle = wm.find_window_by_name("Naia", 10000)?;
	crate::log_verbose(&format!("[browser] tauri_handle={tauri_handle:?}"));

	// Embed or overlay Chrome into Tauri
	let overlay_mode = !wm.supports_native_embed();
	if overlay_mode {
		wm.overlay_position(tauri_handle, chrome_handle, rect)?;
		crate::log_verbose(&format!(
			"[browser] overlay OK: chrome={chrome_handle:?} over tauri={tauri_handle:?}"
		));
	} else {
		wm.embed(tauri_handle, chrome_handle, rect)?;
		crate::log_verbose(&format!(
			"[browser] embed OK: chrome={chrome_handle:?} → tauri={tauri_handle:?}"
		));
	}

	// Record handles now that embedding/overlay succeeded
	let mut state = CHROME.lock().unwrap();
	state.chrome_handle = chrome_handle;
	state.tauri_handle = tauri_handle;
	state.overlay_mode = overlay_mode;
	state.last_client_rect = rect;  // used by both overlay watchdog and embed watchdog
	state.chrome_visible = true;
	drop(state);

	// Monitor Chrome process + tab guard
	spawn_chrome_monitor(app, pid, port);

	Ok(port)
}

/// Update Chrome window position/size when the panel resizes.
#[tauri::command]
pub fn browser_embed_resize(x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
	let rect = WindowRect::from_f64(x, y, width, height);
	let mut state = CHROME.lock().unwrap();
	if state.chrome_handle.is_none() {
		return Ok(());
	}
	let handle = state.chrome_handle;
	let tauri_handle = state.tauri_handle;
	let overlay_mode = state.overlay_mode;
	state.last_client_rect = rect;  // always track for watchdog
	drop(state);
	let wm = platform::window_manager();
	if overlay_mode && tauri_handle.is_valid() {
		wm.overlay_position(tauri_handle, handle, rect)
	} else {
		wm.resize(handle, rect)
	}
}

/// Give keyboard focus to Chrome's native window.
///
/// Called from the viewport onClick and a 1500 ms timer in BrowserCenterPanel.
/// On Windows (embed/SetParent mode), Win32 routes click→focus automatically
/// and the 1500ms timer must NOT call SetFocus — doing so every 1.5s causes
/// continuous WM_KILLFOCUS/WM_SETFOCUS on WebView2, producing visible flicker.
/// Only active in overlay mode (Linux X11) where explicit SetFocus is needed.
#[tauri::command]
pub fn browser_embed_focus() -> Result<(), String> {
	let state = CHROME.lock().unwrap();
	if !state.overlay_mode {
		return Ok(()); // embed mode: Win32 click routing handles focus natively
	}
	let handle = state.chrome_handle;
	drop(state);
	if handle.is_none() {
		return Ok(());
	}
	platform::window_manager().focus(handle)
}

/// Run an agent-browser command against the active Chrome CDP session.
fn run_agent_cmd(port: u16, args: &[&str]) -> Result<String, String> {
	let bin = agent_browser_bin().ok_or("agent-browser not found")?;
	let mut cmd = Command::new(&bin);
	cmd.arg("--cdp").arg(port.to_string()).args(args);
	platform::hide_console(&mut cmd);
	let out = cmd
		.output()
		.map_err(|e| format!("agent-browser: {e}"))?;
	if !out.status.success() {
		let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
		return Err(if stderr.is_empty() {
			format!("agent-browser exited with status {}", out.status)
		} else {
			stderr
		});
	}
	Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Navigate Chrome to a URL via CDP.
/// Tries agent-browser first; falls back to direct CDP WebSocket if not available.
#[tauri::command]
pub async fn browser_embed_navigate(url: String) -> Result<(), String> {
	let port = CHROME.lock().unwrap().port;
	if port == 0 {
		return Err("Browser not initialized".to_string());
	}
	// Primary: agent-browser CLI (AI-integrated control)
	if let Some(bin) = agent_browser_bin() {
		let url2 = url.clone();
		let out = tokio::task::spawn_blocking(move || {
			let mut cmd = std::process::Command::new(&bin);
			cmd.arg("--cdp").arg(port.to_string())
				.arg("open").arg(&url2);
			platform::hide_console(&mut cmd);
			cmd.output()
		})
		.await
		.map_err(|e| format!("spawn_blocking: {e}"))?;
		match out {
			Ok(o) if o.status.success() => return Ok(()),
			Ok(o) => {
				let stderr = String::from_utf8_lossy(&o.stderr);
				crate::log_verbose(&format!("[browser] agent-browser failed ({}) — fallback to CDP: {stderr}", o.status));
			}
			Err(e) => crate::log_verbose(&format!("[browser] agent-browser io error: {e}")),
		}
	}
	// Fallback: direct CDP WebSocket Page.navigate
	navigate_cdp_direct(port, &url).await
}

async fn navigate_cdp_direct(port: u16, url: &str) -> Result<(), String> {
	use futures_util::SinkExt;
	// Get list of open tabs to find a page tab's WebSocket URL
	let tabs_body = reqwest::Client::new()
		.get(format!("http://127.0.0.1:{port}/json/list"))
		.timeout(std::time::Duration::from_secs(3))
		.send().await
		.map_err(|e| format!("CDP /json/list: {e}"))?
		.text().await
		.map_err(|e| format!("CDP body: {e}"))?;
	let tabs: serde_json::Value =
		serde_json::from_str(&tabs_body).map_err(|e| format!("CDP parse: {e}"))?;
	let ws_url = tabs
		.as_array()
		.and_then(|arr| {
			arr.iter().find(|t| {
				t.get("type").and_then(|v| v.as_str()) == Some("page")
			})
		})
		.and_then(|t| t.get("webSocketDebuggerUrl"))
		.and_then(|v| v.as_str())
		.ok_or("CDP: no page tab found")?
		.to_string();
	let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url)
		.await
		.map_err(|e| format!("CDP WS: {e}"))?;
	let msg = serde_json::json!({
		"id": 1,
		"method": "Page.navigate",
		"params": { "url": url }
	});
	ws.send(tokio_tungstenite::tungstenite::Message::Text(
		msg.to_string().into(),
	))
	.await
	.map_err(|e| format!("CDP send: {e}"))?;
	crate::log_verbose(&format!("[browser] CDP direct navigate: {url}"));
	Ok(())
}

/// Get current page URL and title via CDP.
#[tauri::command]
pub fn browser_embed_page_info() -> Result<(String, String), String> {
	let port = CHROME.lock().unwrap().port;
	if port == 0 {
		return Ok((String::new(), String::new()));
	}
	let url_api = format!("http://127.0.0.1:{port}/json/list");
	let resp = ureq::get(&url_api)
		.call()
		.map_err(|e| format!("CDP /json/list: {e}"))?;
	let tabs: Vec<serde_json::Value> = resp
		.into_json()
		.map_err(|e| format!("JSON parse: {e}"))?;
	let tab = tabs
		.iter()
		.find(|t| t["type"] == "page")
		.unwrap_or(&serde_json::Value::Null);
	let page_url = tab["url"].as_str().unwrap_or("").to_string();
	let page_title = tab["title"].as_str().unwrap_or("").to_string();
	Ok((page_url, page_title))
}

/// Navigate back via CDP.
#[tauri::command]
pub fn browser_embed_back() -> Result<(), String> {
	run_cdp_nav_cmd("browser_back")
}

/// Navigate forward via CDP.
#[tauri::command]
pub fn browser_embed_forward() -> Result<(), String> {
	run_cdp_nav_cmd("browser_forward")
}

/// Reload current page via CDP.
#[tauri::command]
pub fn browser_embed_reload() -> Result<(), String> {
	run_cdp_nav_cmd("browser_reload")
}

fn run_cdp_nav_cmd(cmd: &str) -> Result<(), String> {
	let port = CHROME.lock().unwrap().port;
	if port == 0 {
		return Err("Browser not initialized".to_string());
	}
	let agent_cmd = match cmd {
		"browser_back" => "back",
		"browser_forward" => "forward",
		"browser_reload" => "reload",
		_ => return Err(format!("Unknown nav cmd: {cmd}")),
	};
	run_agent_cmd(port, &[agent_cmd])?;
	Ok(())
}

/// Detach the browser panel (called on React component unmount / panel switch).
///
/// Hides Chrome so it is visually hidden while another panel is active.
/// Does NOT reset chrome_handle — browser_embed_init re-shows using the cached handle.
/// Does NOT kill Chrome — Chrome is a long-lived process managed by the
/// monitor thread. Chrome is killed by `browser_embed_kill` on actual app exit.
#[tauri::command]
pub fn browser_embed_close() -> Result<(), String> {
	let mut state = CHROME.lock().unwrap();
	let handle = state.chrome_handle;
	state.chrome_visible = false;
	drop(state);
	if handle.is_none() {
		return Ok(());
	}
	platform::window_manager().hide(handle)
}

/// Hide Chrome window when switching away from the browser panel.
#[tauri::command]
pub fn browser_embed_hide() -> Result<(), String> {
	let mut state = CHROME.lock().unwrap();
	let handle = state.chrome_handle;
	state.chrome_visible = false;
	drop(state);
	if handle.is_none() {
		return Ok(());
	}
	platform::window_manager().hide(handle)
}

/// Show Chrome window after it was hidden.
#[tauri::command]
pub fn browser_embed_show() -> Result<(), String> {
	let mut state = CHROME.lock().unwrap();
	let handle = state.chrome_handle;
	let overlay_mode = state.overlay_mode;
	state.chrome_visible = true;
	drop(state);
	if handle.is_none() {
		return Ok(());
	}
	let wm = platform::window_manager();
	if overlay_mode {
		wm.show_no_activate(handle)
	} else {
		wm.show(handle)
	}
}

/// Grant or reset a Chrome browser-level permission via CDP WebSocket.
/// permission: "mic" | "camera" | "notifications"
/// granted: true = grant for all origins, false = reset to default (ask)
#[tauri::command]
pub async fn browser_set_permission(permission: String, granted: bool) -> Result<(), String> {
	use futures_util::{SinkExt, StreamExt};
	use tokio_tungstenite::connect_async;
	use tokio_tungstenite::tungstenite::Message;

	let port = { CHROME.lock().unwrap().port };
	if port == 0 {
		return Err("Browser not initialized".to_string());
	}

	let version_url = format!("http://127.0.0.1:{port}/json/version");
	let json: serde_json::Value = ureq::get(&version_url)
		.call()
		.map_err(|e| format!("CDP version: {e}"))?
		.into_json()
		.map_err(|e| format!("CDP JSON: {e}"))?;
	let ws_url = json["webSocketDebuggerUrl"]
		.as_str()
		.ok_or("No webSocketDebuggerUrl in CDP response")?
		.to_string();

	let (mut ws, _) = connect_async(ws_url.as_str())
		.await
		.map_err(|e| format!("WS connect: {e}"))?;

	let cdp_perm = match permission.as_str() {
		"mic" | "microphone" | "audioCapture" => "audioCapture",
		"camera" | "videoCapture" => "videoCapture",
		"notifications" => "notifications",
		_ => return Err(format!("Unknown permission: {permission}")),
	};

	let msg = if granted {
		serde_json::json!({
			"id": 1,
			"method": "Browser.grantPermissions",
			"params": { "permissions": [cdp_perm] }
		})
	} else {
		serde_json::json!({
			"id": 1,
			"method": "Browser.resetPermissions",
			"params": {}
		})
	};

	ws.send(Message::text(msg.to_string()))
		.await
		.map_err(|e| format!("WS send: {e}"))?;
	let _ = ws.next().await;
	Ok(())
}

/// Return keyboard focus to the Tauri WebView2 child window.
///
/// Call this when an HTML input element receives DOM focus so that keyboard
/// events are routed to the WebView (not Chrome). Focusing the top-level
/// Tauri HWND is insufficient — the actual key handler lives in the WebView2
/// child HWND (Chrome_WidgetWin_1 that spans the full content area).
#[tauri::command]
pub fn browser_shell_focus() -> Result<(), String> {
	let handle = CHROME.lock().unwrap().tauri_handle;
	if handle.is_none() {
		return Ok(());
	}
	// On Windows: redirect focus to the WebView2 child (largest Chrome_WidgetWin
	// under Tauri's HWND). On other platforms, fall back to top-level focus.
	#[cfg(target_os = "windows")]
	{
		let PlatformHandle::Win32(tauri_isize) = handle else {
			return platform::window_manager().focus(handle);
		};
		if let Some(webview2) = platform::find_webview2_child(tauri_isize) {
			return platform::window_manager().focus(PlatformHandle::Win32(webview2));
		}
	}
	platform::window_manager().focus(handle)
}

// ─── Login Chrome (headed, not embedded) ─────────────────────────────────────

struct LoginChromeState {
	process: Option<Child>,
	pid: u32,
	port: u16,
}

impl LoginChromeState {
	const fn new() -> Self {
		Self { process: None, pid: 0, port: 0 }
	}
}

static LOGIN_CHROME: Mutex<LoginChromeState> = Mutex::new(LoginChromeState::new());

/// Monitor login Chrome for auth-complete; auto-close Chrome once token arrives.
fn spawn_login_chrome_monitor(app: AppHandle, pid: u32, port: u16) {
	std::thread::spawn(move || {
		let version_url = format!("http://127.0.0.1:{port}/json/version");
		let list_url = format!("http://127.0.0.1:{port}/json/list");
		let mut auth_emitted = false;
		let mut cdp_fail_streak = 0u32;
		const CDP_FAIL_LIMIT: u32 = 6;
		loop {
			std::thread::sleep(std::time::Duration::from_millis(500));

			let cdp_alive = ureq::get(&version_url)
				.call()
				.map(|r| r.status() == 200)
				.unwrap_or(false);

			if cdp_alive {
				cdp_fail_streak = 0;
			} else {
				let pid_alive = crate::platform::is_pid_alive(pid);
				cdp_fail_streak = if !pid_alive { CDP_FAIL_LIMIT } else { cdp_fail_streak + 1 };
			}

			if cdp_fail_streak >= CDP_FAIL_LIMIT {
				let mut s = LOGIN_CHROME.lock().unwrap();
				if s.pid == pid {
					s.process = None;
					s.port = 0;
					s.pid = 0;
				}
				break;
			}

			if !cdp_alive {
				continue;
			}

			if let Ok(resp) = ureq::get(&list_url).call() {
				if let Ok(body) = resp.into_string() {
					if body.contains("/desktop/auth-complete") && !auth_emitted {
						if let Some(auth) = parse_auth_complete_from_tab_list(&body) {
							let _ = app.emit("naia_auth_complete", auth);
							auth_emitted = true;
							// Give the page a moment to render before closing
							std::thread::sleep(std::time::Duration::from_millis(800));
							let mut s = LOGIN_CHROME.lock().unwrap();
							if s.pid == pid {
								if let Some(mut child) = s.process.take() {
									let _ = child.kill();
								}
								s.port = 0;
								s.pid = 0;
							}
							break;
						}
					} else if !body.contains("/desktop/auth-complete") {
						auth_emitted = false;
					}
				}
			}
		}
	});
}

/// Navigate to login URL — inside the embedded browser panel if it is running,
/// otherwise launch a standalone Chrome for Testing window.
///
/// When the embedded Chrome handles login, `spawn_chrome_monitor` already
/// watches for `/desktop/auth-complete` and emits `naia_auth_complete` — no
/// separate monitor is needed.
///
/// Fallback (no embedded Chrome): opens a headed Chrome for Testing window,
/// monitors via `spawn_login_chrome_monitor`, auto-closes on auth-complete.
#[tauri::command]
pub async fn browser_open_login(app: AppHandle, url: String) -> Result<(), String> {
	// Fast path 1: multi-webview panel (new default).
	if let Some(wv) = app.get_webview(crate::browser_webview::BROWSER_LABEL) {
		crate::log_verbose("[browser_login] multi-webview active — navigating in-panel");
		tauri::Webview::eval(&wv, &format!("window.location.href = {:?};", url))
			.map_err(|e| format!("navigate: {e}"))?;
		// Tell frontend to switch to the browser panel so user can see the login page.
		let _ = app.emit("browser_panel_activate", ());
		// Watch CURRENT_URL for /desktop/auth-complete and emit naia_auth_complete.
		let app2 = app.clone();
		std::thread::spawn(move || {
			let mut auth_emitted = false;
			// Timeout after 10 min.
			let deadline = std::time::Instant::now() + std::time::Duration::from_secs(600);
			loop {
				if std::time::Instant::now() > deadline { break; }
				std::thread::sleep(std::time::Duration::from_millis(500));
				let current = crate::browser_webview::get_current_url();
				if current.contains("/desktop/auth-complete") {
					if !auth_emitted {
						if let Ok(parsed) = current.parse::<url::Url>() {
							let key: String = parsed.query_pairs()
								.find(|(k, _)| k == "key")
								.map(|(_, v)| v.to_string())
								.unwrap_or_default();
							let user_id: String = parsed.query_pairs()
								.find(|(k, _)| k == "user_id")
								.map(|(_, v)| v.to_string())
								.unwrap_or_default();
							if !key.is_empty() {
								let auth = serde_json::json!({ "naiaKey": key, "naiaUserId": user_id });
								let _ = app2.emit("naia_auth_complete", auth);
								auth_emitted = true;
							}
						}
					}
				} else {
					auth_emitted = false;
				}
				if auth_emitted { break; }
			}
		});
		return Ok(());
	}

	// Fast path 2: embedded Chrome already running → navigate in-panel.
	let port = CHROME.lock().unwrap().port;
	if port != 0 {
		crate::log_verbose(&format!("[browser_login] embedded Chrome active (port={port}) — navigating in-panel"));
		return navigate_cdp_direct(port, &url).await;
	}

	// Slow path: no embedded Chrome yet → standalone login window.
	// Kill any lingering login Chrome from a previous attempt
	{
		let mut s = LOGIN_CHROME.lock().unwrap();
		if let Some(mut child) = s.process.take() {
			let _ = child.kill();
		}
		s.port = 0;
		s.pid = 0;
	}

	// Find (or install) Chrome for Testing
	let chrome_path = if let Some(p) = chrome_for_testing_bin() {
		p
	} else {
		let bin = agent_browser_bin()
			.ok_or("agent-browser not found — reinstall Naia")?;
		crate::log_both("[browser_login] Chrome for Testing not found — running agent-browser install");
		let mut cmd = Command::new(&bin);
		cmd.arg("install");
		platform::hide_console(&mut cmd);
		let out = cmd
			.output()
			.map_err(|e| format!("agent-browser install: {e}"))?;
		if !out.status.success() {
			let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
			return Err(format!(
				"Chrome for Testing install failed: {}",
				if stderr.is_empty() { format!("exit {}", out.status) } else { stderr }
			));
		}
		chrome_for_testing_bin().ok_or("Chrome for Testing not found after install")?
	};

	let port = find_free_port();
	let home = std::env::var("HOME")
		.or_else(|_| std::env::var("USERPROFILE"))
		.unwrap_or_default();
	let profile_dir = if home.is_empty() {
		std::env::temp_dir().join("naia-login-profile")
	} else {
		std::path::PathBuf::from(&home).join(".naia").join("login-profile")
	};
	std::fs::create_dir_all(&profile_dir)
		.map_err(|e| format!("Profile dir: {e}"))?;

	let profile_str = profile_dir.to_string_lossy().to_string();

	// Center the login window over the Naia window when possible.
	let _ = &app; // AppHandle not needed here — use platform abstraction for window rect
	let cached_tauri = CHROME.lock().unwrap().tauri_handle;
	let tauri_h = if cached_tauri.is_valid() {
		Some(cached_tauri)
	} else {
		platform::window_manager().find_window_by_name("Naia", 1000).ok()
	};
	let window_pos_arg = tauri_h
		.and_then(|h| platform::window_manager().get_window_screen_rect(h))
		.map(|(x, y, w, h)| {
			let cx = x + (w as i32 - 900) / 2;
			let cy = y + (h as i32 - 700) / 2;
			format!("--window-position={cx},{cy}")
		})
		.unwrap_or_else(|| "--window-position=100,100".into());

	let mut cmd = Command::new(&chrome_path);
	cmd.args([
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-sync",
		"--disable-extensions",
		"--disable-infobars",
		"--disable-session-crashed-bubble",
		"--disable-dev-shm-usage",
		"--window-size=900,700",
		&window_pos_arg,
		&format!("--remote-debugging-port={port}"),
		&format!("--user-data-dir={profile_str}"),
		&url,
	]);
	cmd.stdout(std::process::Stdio::null())
		.stderr(std::process::Stdio::null());

	let child = cmd.spawn().map_err(|e| format!("Spawn Chrome: {e}"))?;
	let pid = child.id();
	crate::log_both(&format!(
		"[browser_login] Chrome for Testing spawned: pid={pid} port={port}"
	));

	{
		let mut s = LOGIN_CHROME.lock().unwrap();
		s.process = Some(child);
		s.port = port;
		s.pid = pid;
	}

	wait_for_cdp(port)?;
	spawn_login_chrome_monitor(app, pid, port);
	Ok(())
}

/// Returns true if Chrome for Testing is already installed (no download needed).
#[tauri::command]
pub fn browser_chrome_testing_ready() -> bool {
	chrome_for_testing_bin().is_some()
}

/// Hard-kill all Chrome instances (embedded + login) on app exit.
/// Profile directories are preserved so login sessions survive restarts.
pub fn browser_embed_kill() {
	{
		let mut state = CHROME.lock().unwrap();
		if let Some(mut child) = state.process.take() {
			let _ = child.kill();
		}
		state.tmpdir = String::new();
		state.port = 0;
		state.chrome_handle = PlatformHandle::None;
		state.pid = 0;
		state.chrome_visible = false;
		state.last_client_rect = WindowRect { x: 0, y: 0, width: 0, height: 0 };
	}
	{
		let mut s = LOGIN_CHROME.lock().unwrap();
		if let Some(mut child) = s.process.take() {
			let _ = child.kill();
		}
		s.port = 0;
		s.pid = 0;
	}
}

/// Return the active Chrome CDP port (0 if not running).
#[tauri::command]
pub fn browser_embed_port() -> u16 {
	CHROME.lock().unwrap().port
}

/// Return accessibility tree snapshot of the current page (for Naia AI).
#[tauri::command]
pub fn browser_snapshot() -> Result<String, String> {
	let port = CHROME.lock().unwrap().port;
	if port == 0 {
		return Err("Browser not initialized".to_string());
	}
	run_agent_cmd(port, &["snapshot"])
}

/// Click an element identified by an @ref from snapshot output (for Naia AI).
#[tauri::command]
pub fn browser_click(selector: String) -> Result<(), String> {
	let port = CHROME.lock().unwrap().port;
	if port == 0 {
		return Err("Browser not initialized".to_string());
	}
	run_agent_cmd(port, &["click", &selector])?;
	Ok(())
}

/// Fill (clear + type) an input element identified by @ref (for Naia AI).
#[tauri::command]
pub fn browser_fill(selector: String, text: String) -> Result<(), String> {
	let port = CHROME.lock().unwrap().port;
	if port == 0 {
		return Err("Browser not initialized".to_string());
	}
	run_agent_cmd(port, &["fill", &selector, &text])?;
	Ok(())
}

/// Get inner text of an element (or full page body if selector empty) (for Naia AI).
#[tauri::command]
pub fn browser_get_text(selector: String) -> Result<String, String> {
	let port = CHROME.lock().unwrap().port;
	if port == 0 {
		return Err("Browser not initialized".to_string());
	}
	if selector.is_empty() {
		run_agent_cmd(port, &["get", "text", "body"])
	} else {
		run_agent_cmd(port, &["get", "text", &selector])
	}
}

/// Scroll the page (for Naia AI).
#[tauri::command]
pub fn browser_scroll(direction: String, pixels: i32) -> Result<(), String> {
	let port = CHROME.lock().unwrap().port;
	if port == 0 {
		return Err("Browser not initialized".to_string());
	}
	let px = pixels.to_string();
	run_agent_cmd(port, &["scroll", &direction, &px])?;
	Ok(())
}

/// Press a keyboard key (for Naia AI).
#[tauri::command]
pub fn browser_press(key: String) -> Result<(), String> {
	let port = CHROME.lock().unwrap().port;
	if port == 0 {
		return Err("Browser not initialized".to_string());
	}
	run_agent_cmd(port, &["press", &key])?;
	Ok(())
}

/// Take a screenshot and return the file path (for Naia AI).
#[tauri::command]
pub fn browser_screenshot_path() -> Result<String, String> {
	let port = CHROME.lock().unwrap().port;
	if port == 0 {
		return Err("Browser not initialized".to_string());
	}
	let path = std::env::temp_dir()
		.join("naia-browser-screenshot.png")
		.to_string_lossy()
		.to_string();
	run_agent_cmd(port, &["screenshot", &path])?;
	Ok(path)
}

/// Evaluate JavaScript in the current page (for Naia AI).
#[tauri::command]
pub fn browser_eval(js: String) -> Result<String, String> {
	let port = CHROME.lock().unwrap().port;
	if port == 0 {
		return Err("Browser not initialized".to_string());
	}
	run_agent_cmd(port, &["eval", &js])
}

#[cfg(test)]
mod tests {
	use super::parse_auth_complete_from_tab_list;

	fn make_tab_list(url: &str) -> String {
		format!(
			r#"[{{"id":"1","title":"Login Successful","type":"page","url":"{url}","webSocketDebuggerUrl":"ws://127.0.0.1:19222/devtools/page/1"}}]"#,
			url = url
		)
	}

	#[test]
	fn parses_key_and_user_id() {
		let body = make_tab_list(
			"https://naia.nextain.io/desktop/auth-complete?key=gw-abc123&user_id=user-42",
		);
		let result = parse_auth_complete_from_tab_list(&body).unwrap();
		assert_eq!(result["naiaKey"], "gw-abc123");
		assert_eq!(result["naiaUserId"], "user-42");
	}

	#[test]
	fn parses_key_without_user_id() {
		let body = make_tab_list(
			"https://naia.nextain.io/desktop/auth-complete?key=gw-xyz",
		);
		let result = parse_auth_complete_from_tab_list(&body).unwrap();
		assert_eq!(result["naiaKey"], "gw-xyz");
		assert_eq!(result["naiaUserId"], "");
	}

	#[test]
	fn returns_none_when_no_auth_complete_url() {
		let body = make_tab_list("https://naia.nextain.io/ko/dashboard");
		assert!(parse_auth_complete_from_tab_list(&body).is_none());
	}

	#[test]
	fn returns_none_when_key_missing() {
		let body = make_tab_list(
			"https://naia.nextain.io/desktop/auth-complete?user_id=user-42",
		);
		assert!(parse_auth_complete_from_tab_list(&body).is_none());
	}

	#[test]
	fn returns_none_on_empty_body() {
		assert!(parse_auth_complete_from_tab_list("").is_none());
		assert!(parse_auth_complete_from_tab_list("[]").is_none());
	}

	#[test]
	fn returns_none_when_key_is_empty_string() {
		let body = make_tab_list(
			"https://naia.nextain.io/desktop/auth-complete?key=&user_id=user-42",
		);
		assert!(parse_auth_complete_from_tab_list(&body).is_none());
	}

	#[test]
	fn multi_tab_finds_auth_complete_tab() {
		let body = format!(
			r#"[
				{{"id":"1","title":"Dashboard","type":"page","url":"https://naia.nextain.io/ko/dashboard"}},
				{{"id":"2","title":"Login Successful","type":"page","url":"https://naia.nextain.io/desktop/auth-complete?key=gw-multi&user_id=u-99"}}
			]"#
		);
		let result = parse_auth_complete_from_tab_list(&body).unwrap();
		assert_eq!(result["naiaKey"], "gw-multi");
		assert_eq!(result["naiaUserId"], "u-99");
	}

	#[test]
	fn tab_without_url_field_does_not_abort_search() {
		let body = r#"[
			{"id":"1","title":"Service Worker","type":"service_worker"},
			{"id":"2","title":"Login Successful","type":"page","url":"https://naia.nextain.io/desktop/auth-complete?key=gw-sw&user_id=u-sw"}
		]"#;
		let result = parse_auth_complete_from_tab_list(body).unwrap();
		assert_eq!(result["naiaKey"], "gw-sw");
	}
}
