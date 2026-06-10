// Always use windows subsystem — even in debug builds, to prevent a console
// window flash when the OS launches a second instance for deep link handling.
#![windows_subsystem = "windows"]

fn main() {
    // Windows: If launched with a naia:// deep link URL as argument (e.g. by a
    // browser protocol handler), write the URL to a pending file and exit
    // immediately.  The already-running primary instance watches this file and
    // processes the deep link.  This bypasses the single-instance Named Mutex
    // IPC which fails when the second instance is launched from a Chromium
    // sandboxed context.
    #[cfg(target_os = "windows")]
    {
        let args: Vec<String> = std::env::args().collect();
        if let Some(url) = args.iter().find(|a| a.starts_with("naia://")) {
            let naia_dir = dirs::home_dir()
                .map(|h| h.join(".naia"))
                .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Users\Public\.naia"));
            let _ = std::fs::create_dir_all(&naia_dir);
            let pending = naia_dir.join("deep-link-pending.txt");
            let _ = std::fs::write(&pending, url);
            // Exit — primary instance will pick it up
            return;
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
            // Only set if XWayland is available (check DISPLAY env).
            // Wayland-only environments keep native Wayland (browser embedding won't work).
            if std::env::var("GDK_BACKEND").is_err() && std::env::var("DISPLAY").is_ok() {
                std::env::set_var("GDK_BACKEND", "x11");
            }
        }
    }

    naia_shell_lib::run()
}
