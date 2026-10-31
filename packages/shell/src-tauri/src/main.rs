// Always use windows subsystem — even in debug builds, to prevent a console
// window flash when the OS launches a second instance for deep link handling.
#![cfg_attr(
    all(target_os = "windows", not(feature = "webdriver-e2e")),
    windows_subsystem = "windows"
)]

/// Returns true when the primary instance already holds the single-instance
/// mutex (`tauri-plugin-single-instance` creates `<identifier>-sim`). Access
/// denied also means the mutex exists, so only "not found" counts as no
/// running instance.
#[cfg(target_os = "windows")]
fn primary_instance_running() -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_FILE_NOT_FOUND};
    use windows_sys::Win32::System::Threading::OpenMutexW;
    // SYNCHRONIZE access right (winnt.h); defined in a windows-sys feature we
    // do not otherwise need.
    const SYNCHRONIZE: u32 = 0x0010_0000;
    let name: Vec<u16> = naia_shell_lib::SINGLE_INSTANCE_MUTEX_NAME
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: `name` is a NUL-terminated UTF-16 buffer that outlives the call;
    // the returned handle is closed before leaving this function.
    let handle = unsafe { OpenMutexW(SYNCHRONIZE, 0, name.as_ptr()) };
    if !handle.is_null() {
        unsafe { CloseHandle(handle) };
        return true;
    }
    let last_error = unsafe { GetLastError() };
    last_error != ERROR_FILE_NOT_FOUND
}

fn main() {
    // Windows: If launched with a naia:// deep link URL as argument (e.g. by a
    // browser protocol handler) while the shell is already running, write the
    // URL to a pending file and exit immediately.  The already-running primary
    // instance watches this file and processes the deep link.  This bypasses
    // the single-instance Named Mutex IPC which fails when the second instance
    // is launched from a Chromium sandboxed context.
    //
    // When no primary instance is running, keep starting up: this process
    // becomes the shell, and the deep-link plugin hands the startup URL to
    // `process_deep_link_url` through `get_current()`.
    #[cfg(target_os = "windows")]
    {
        let args: Vec<String> = std::env::args().collect();
        if let Some(url) = args.iter().find(|a| a.starts_with("naia://")) {
            if primary_instance_running() {
                let pending = naia_shell_lib::data_home::windows_deep_link_pending();
                if let Some(naia_dir) = pending.parent() {
                    let _ = std::fs::create_dir_all(naia_dir);
                }
                let _ = std::fs::write(&pending, url);
                // Exit — primary instance will pick it up
                return;
            }
        }
    }

    // Work around WebKit EGL initialization failure on some GPU/driver combos
    // (e.g. Intel Kaby Lake + XWayland via AppImage GTK hook).
    // This must be set before any GTK/WebKit code runs.
    #[cfg(target_os = "linux")]
    {
        // SAFETY: Called before any threads are spawned (single-threaded main).
        unsafe {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            // Force X11 backend for Chrome embedding (X11 reparenting).
            // Force it whenever XWayland is available: inherited Wayland makes
            // child WebViews ignore their bounds and appear below the main window.
            // Wayland-only environments keep native Wayland (browser embedding won't work).
            if std::env::var("DISPLAY").is_ok() {
                std::env::set_var("GDK_BACKEND", "x11");
            }
        }
    }

    naia_shell_lib::run()
}
