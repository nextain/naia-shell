// Shared ffmpeg sidecar constants and binary validation used by both `build.rs`
// (via top-level `include!("src/ffmpeg_sidecar.rs");`) and the application crate
// (`pub(crate) mod ffmpeg_sidecar;` in `lib.rs`, imported by `broadcast.rs`).
// Keep this file self-contained (fully-qualified `std::` paths only) so it
// compiles cleanly in both contexts.
// Canonical source of truth: `packages/shell/src-tauri/platform-matrix.json`
// (`os.win32.ffmpeg`), enforced by `packages/shell/scripts/__tests__/platform-matrix.test.ts`.

#[allow(dead_code)]
pub const FFMPEG_DEV_PLACEHOLDER_PREFIX: &[u8] = b"#!naia-ffmpeg-dev-placeholder";
#[allow(dead_code)]
pub const MIN_WINDOWS_FFMPEG_BYTES: u64 = 1_000_000;
#[allow(dead_code)]
pub const FFMPEG_SIDECAR_SOURCE_ENV: &str = "NAIA_FFMPEG_SIDECAR_SOURCE";
#[allow(dead_code)]
pub const FFMPEG_REQUIRE_REAL_ENV: &str = "NAIA_REQUIRE_REAL_FFMPEG";
#[allow(dead_code)]
pub const WINDOWS_FFMPEG_FALLBACK_CANDIDATES: &[&str] = &[
    r"C:\ProgramData\chocolatey\bin\ffmpeg.exe",
    r"C:\ffmpeg\bin\ffmpeg.exe",
];

/// Single source of truth for validating an `ffmpeg` sidecar or runtime executable
/// across `build.rs` and `broadcast.rs`.
/// - Checks that `path` exists and is a regular file.
/// - Rejects empty files and `#!naia-ffmpeg-dev-placeholder` stubs.
/// - When `require_windows_pe` is true, on Windows targets, or for `.exe` files:
///   requires a valid PE `MZ` header (`0x4D 0x5A`) and at least `MIN_WINDOWS_FFMPEG_BYTES`
///   (1,000,000 bytes), preventing Windows from showing the 16-bit application modal
///   dialog (`os error 216`).
#[allow(dead_code)]
pub fn validate_ffmpeg_sidecar_file(
    path: &std::path::Path,
    require_windows_pe: bool,
) -> Result<u64, String> {
    let meta = std::fs::metadata(path).map_err(|_| {
        format!(
            "ffmpeg 실행 파일을 찾을 수 없습니다: {}",
            path.display()
        )
    })?;
    if !meta.is_file() {
        return Err(format!(
            "ffmpeg 실행 파일을 찾을 수 없습니다: {}",
            path.display()
        ));
    }
    let mut header = [0u8; 64];
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("ffmpeg 실행 파일을 열 수 없습니다 ({}): {e}", path.display()))?;
    let n = std::io::Read::read(&mut file, &mut header)
        .map_err(|e| format!("ffmpeg 실행 파일을 읽을 수 없습니다 ({}): {e}", path.display()))?;
    if n == 0 || header[..n].starts_with(FFMPEG_DEV_PLACEHOLDER_PREFIX) {
        return Err(format!(
            "ffmpeg 실행 파일이 개발용 자리표시 파일(#!naia-ffmpeg-dev-placeholder)이거나 비어 있어 실행할 수 없습니다: {}",
            path.display()
        ));
    }
    let is_exe_ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("exe"))
        .unwrap_or(false);
    let must_be_pe = require_windows_pe || cfg!(target_os = "windows") || is_exe_ext;
    if must_be_pe {
        if n < 2 || header[0] != b'M' || header[1] != b'Z' {
            return Err(format!(
                "Windows ffmpeg 실행 파일의 PE(MZ) 헤더가 올바르지 않아 실행을 차단했습니다 (os error 216 방지): {}",
                path.display()
            ));
        }
        if meta.len() < MIN_WINDOWS_FFMPEG_BYTES {
            return Err(format!(
                "Windows ffmpeg 실행 파일 크기가 최소 기준({} bytes < {MIN_WINDOWS_FFMPEG_BYTES})에 미달합니다: {}",
                meta.len(),
                path.display()
            ));
        }
    }
    Ok(meta.len())
}
