//! Cross-platform screen region capture.
//!
//! Used by `skill_tab_screenshot` to capture a panel's native viewport area
//! from the OS screen buffer — no WebView2 / WebKitGTK API required.
//!
//! Platform implementations:
//!   Windows  — GDI BitBlt (no extra dependencies)
//!   macOS    — `screencapture -R` CLI (bundled with macOS)
//!   Linux    — `scrot -a` (first choice) → `import -crop` (ImageMagick fallback)
//!
//! Coordinate convention:
//!   The caller passes CSS logical pixels from `getBoundingClientRect()` in the
//!   main shell WebView. This module converts them to physical screen pixels
//!   by querying the main window's outer position and DPI scale factor.

use base64::Engine as _;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

// ─── Tauri Command ────────────────────────────────────────────────────────────

/// Capture a screen region and return it as a base64 PNG data URI.
///
/// `x`, `y`, `width`, `height` — CSS logical pixels from the shell WebView's
/// `getBoundingClientRect()` call on the panel viewport element.
///
/// Returns `data:image/png;base64,<base64>` — suitable for LLM vision input.
#[tauri::command]
pub async fn capture_screen_region(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<String, String> {
    let window = app.get_window("main").ok_or("main window not found")?;

    let scale = window
        .scale_factor()
        .map_err(|e| format!("scale_factor: {e}"))?;

    // inner_position = top-left of the client area (excludes title bar + borders).
    // outer_position would include the OS window frame, causing y to be off by
    // ~32px on a default Windows decorated window.
    let win_pos = window
        .inner_position()
        .map_err(|e| format!("inner_position: {e}"))?;

    // CSS logical px → physical screen px
    let sx = (win_pos.x as f64 + x * scale).round() as i32;
    let sy = (win_pos.y as f64 + y * scale).round() as i32;
    let sw = (width * scale).round() as i32;
    let sh = (height * scale).round() as i32;

    if sw <= 0 || sh <= 0 {
        return Err(format!("Invalid region: {sw}×{sh}"));
    }

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let path = std::env::temp_dir().join(format!("naia-screenshot-{ts:x}.png"));

    // Blocking GDI / CLI capture — offload from tokio worker thread
    let path2 = path.clone();
    tokio::task::spawn_blocking(move || platform_capture(sx, sy, sw, sh, &path2))
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))??;

    // Read saved PNG and encode to base64 data URI for LLM vision
    let bytes = std::fs::read(&path).map_err(|e| format!("read png: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    // Clean up temp file
    let _ = std::fs::remove_file(&path);
    Ok(format!("data:image/png;base64,{b64}"))
}

// ─── Platform dispatch ────────────────────────────────────────────────────────

#[allow(unused_variables)]
fn platform_capture(x: i32, y: i32, w: i32, h: i32, path: &PathBuf) -> Result<(), String> {
    #[cfg(windows)]
    return capture_windows(x, y, w, h, path);

    #[cfg(target_os = "macos")]
    return capture_macos(x, y, w, h, path);

    #[cfg(target_os = "linux")]
    return capture_linux(x, y, w, h, path);

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    Err("Screenshot not supported on this platform".to_string())
}

// ─── Windows — GDI BitBlt ─────────────────────────────────────────────────────

#[cfg(windows)]
fn capture_windows(x: i32, y: i32, w: i32, h: i32, path: &PathBuf) -> Result<(), String> {
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        RGBQUAD, SRCCOPY,
    };

    let pixels: Vec<u8> = unsafe {
        let hdc_screen = GetDC(std::ptr::null_mut()); // null = desktop
        if hdc_screen.is_null() {
            return Err("GetDC(desktop) failed".to_string());
        }

        let hdc_mem = CreateCompatibleDC(hdc_screen);
        let hbmp = CreateCompatibleBitmap(hdc_screen, w, h);
        let old = SelectObject(hdc_mem, hbmp);

        // Capture screen region into memory DC
        BitBlt(hdc_mem, 0, 0, w, h, hdc_screen, x, y, SRCCOPY);

        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // negative = top-down scanlines
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [RGBQUAD {
                rgbBlue: 0,
                rgbGreen: 0,
                rgbRed: 0,
                rgbReserved: 0,
            }],
        };

        let mut buf = vec![0u8; (w * h * 4) as usize];
        GetDIBits(
            hdc_screen,
            hbmp,
            0,
            h as u32,
            buf.as_mut_ptr() as *mut _,
            &mut bmi,
            DIB_RGB_COLORS,
        );

        SelectObject(hdc_mem, old);
        DeleteObject(hbmp);
        DeleteDC(hdc_mem);
        ReleaseDC(std::ptr::null_mut(), hdc_screen);

        // GDI returns BGRA — swap B↔R to get RGBA for PNG encoder
        for chunk in buf.chunks_exact_mut(4) {
            chunk.swap(0, 2);
        }
        buf
    };

    encode_png(&pixels, w as u32, h as u32, path)
}

// ─── macOS — screencapture CLI ────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn capture_macos(x: i32, y: i32, w: i32, h: i32, path: &PathBuf) -> Result<(), String> {
    let path_str = path.to_str().ok_or("invalid temp path")?;
    let region = format!("{x},{y},{w},{h}");

    let out = std::process::Command::new("screencapture")
        .args(["-R", &region, "-x", path_str]) // -x = no shutter sound
        .output()
        .map_err(|e| format!("screencapture: {e}"))?;

    if !out.status.success() {
        return Err(format!(
            "screencapture failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

// ─── Linux — scrot → ImageMagick import ──────────────────────────────────────

#[cfg(target_os = "linux")]
fn capture_linux(x: i32, y: i32, w: i32, h: i32, path: &PathBuf) -> Result<(), String> {
    let path_str = path.to_str().ok_or("invalid temp path")?;

    // Try scrot (lightweight, common on X11)
    let scrot = std::process::Command::new("scrot")
        .args(["-a", &format!("{x},{y},{w},{h}"), path_str])
        .status();
    if let Ok(s) = scrot {
        if s.success() {
            return Ok(());
        }
    }

    // Fallback: ImageMagick import (also works on Wayland via XWayland)
    let import = std::process::Command::new("import")
        .args([
            "-window",
            "root",
            "-crop",
            &format!("{w}x{h}+{x}+{y}"),
            path_str,
        ])
        .status()
        .map_err(|e| format!("import (ImageMagick): {e}"))?;

    if !import.success() {
        return Err("Screenshot failed: install 'scrot' or 'imagemagick' (import)".to_string());
    }
    Ok(())
}

// ─── PNG encoder (Windows only — other platforms produce PNG natively) ────────

#[cfg(windows)]
fn encode_png(pixels: &[u8], width: u32, height: u32, path: &PathBuf) -> Result<(), String> {
    use std::io::BufWriter;
    let file = std::fs::File::create(path).map_err(|e| format!("file create: {e}"))?;
    let mut buf = BufWriter::new(file);
    let mut enc = png::Encoder::new(&mut buf, width, height);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    let mut writer = enc.write_header().map_err(|e| format!("png header: {e}"))?;
    writer
        .write_image_data(pixels)
        .map_err(|e| format!("png write: {e}"))
}
