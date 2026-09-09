//! Bounded, local PPTX import primitives.
//!
//! This module deliberately has no Tauri dependency.  The command layer in
//! `slides_files.rs` supplies the cache directory, cancellation token, and
//! progress callback.  Keeping the importer independent makes the archive
//! parser and converter contract testable without starting a native window.

use quick_xml::{events::Event, Reader};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering as AtomicOrdering},
    Mutex, MutexGuard, OnceLock, TryLockError,
};
use std::time::{Duration, SystemTime};
use zip::ZipArchive;

#[path = "slides_import_parser.rs"]
mod slides_import_parser;
#[path = "slides_import_process.rs"]
mod slides_import_process;
#[path = "slides_import_runtime.rs"]
mod slides_import_runtime;

pub(crate) use slides_import_parser::parse_pptx_notes;
use slides_import_parser::{looks_like_zip, read_bounded, wait_for_conversion_guard};
use slides_import_runtime::{
    cache_key, cleanup_cache, convert_with_libreoffice, find_converter, validate_converted_pdf,
    write_cache_atomically,
};
#[cfg(test)]
use slides_import_runtime::{file_uri, Converter};
#[cfg(test)]
use slides_import_process::{kill_child, spawn_owned_child};

pub(crate) const MAX_PPTX_BYTES: u64 = 256 * 1024 * 1024;
pub(crate) const MAX_PDF_BYTES: u64 = 128 * 1024 * 1024;
const MAX_ZIP_ENTRIES: usize = 4096;
const MAX_ZIP_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
const MAX_XML_BYTES: u64 = 16 * 1024 * 1024;
const MAX_NOTES_BYTES: usize = 4 * 1024 * 1024;
const MAX_SLIDES: usize = 4096;
const MAX_CACHE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_CACHE_ENTRIES: usize = 64;
const CACHE_MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const CONVERSION_TIMEOUT: Duration = Duration::from_secs(120);
const CONVERTER_OPTIONS_VERSION: &str =
    "libreoffice-impress-pdf-v1-hidden-slides-lossless-no-notes";

/// A cancellation token owned by one command invocation.
///
/// It is intentionally independent of a Tauri `Webview`; the command layer
/// binds this token to `(webview label, request id)` before exposing it to the
/// importer.  A token only cancels work spawned by that command.
#[derive(Debug, Default)]
pub(crate) struct CancellationToken {
    cancelled: AtomicBool,
}

impl CancellationToken {
    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, AtomicOrdering::Release);
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(AtomicOrdering::Acquire)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PptxNotes {
    pub(crate) slide_count: usize,
    /// One entry per physical slide. `None` means the slide has no notes.
    pub(crate) notes: Vec<Option<String>>,
}

impl PptxNotes {
    pub(crate) fn script_markdown(&self) -> Option<String> {
        if !self.notes.iter().any(Option::is_some) {
            return None;
        }
        let mut output = String::new();
        for (index, note) in self.notes.iter().enumerate() {
            // The heading is intentionally present for every physical page,
            // including hidden and blank-note pages.  The shell parser uses
            // the numeric heading to retain the PDF page mapping.
            output.push_str(&format!("## {:02}.\n", index + 1));
            if let Some(note) = note {
                output.push_str(note);
                output.push('\n');
            }
        }
        Some(output)
    }
}

#[derive(Debug)]
pub(crate) struct ImportedPptx {
    pub(crate) pdf: Vec<u8>,
    pub(crate) notes: PptxNotes,
    pub(crate) cache_hit: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImportFailure {
    InvalidPptx,
    ConverterUnavailable,
    ConversionFailed,
    ConversionTimeout,
    Cancelled,
}

impl ImportFailure {
    fn code(self) -> &'static str {
        match self {
            Self::InvalidPptx => "slides_invalid_pptx",
            Self::ConverterUnavailable => "slides_converter_unavailable",
            Self::ConversionFailed => "slides_conversion_failed",
            Self::ConversionTimeout => "slides_conversion_timeout",
            Self::Cancelled => "slides_import_cancelled",
        }
    }
}

type ImportResult<T> = Result<T, String>;

/// Import a PPTX from a path selected by the native picker.
///
/// `cache_root` must be an application-owned directory.  This function only
/// creates and removes files below that directory.  `progress` receives
/// stable phase names (`validating`, `parsing`, `converting`, `caching`,
/// `complete`).
pub(crate) fn import_pptx<F>(
    source: &Path,
    cache_root: &Path,
    cancellation: &CancellationToken,
    mut progress: F,
) -> ImportResult<ImportedPptx>
where
    F: FnMut(&'static str),
{
    if cancellation.is_cancelled() {
        return Err(ImportFailure::Cancelled.code().into());
    }
    progress("validating");
    let source_bytes = read_bounded(source, MAX_PPTX_BYTES)
        .map_err(|_| ImportFailure::InvalidPptx.code().to_string())?;
    if !looks_like_zip(&source_bytes) {
        return Err(ImportFailure::InvalidPptx.code().into());
    }

    progress("parsing");
    let notes = parse_pptx_notes(&source_bytes)?;
    if cancellation.is_cancelled() {
        return Err(ImportFailure::Cancelled.code().into());
    }

    // Normalize the caller-provided cache root before constructing profile,
    // job, and cache paths. The production path is absolute already, but the
    // standalone importer contract also accepts a relative test/root path.
    fs::create_dir_all(cache_root)
        .map_err(|_| ImportFailure::ConversionFailed.code().to_string())?;
    let cache_root = cache_root
        .canonicalize()
        .map_err(|_| ImportFailure::ConversionFailed.code().to_string())?;

    // Serializing cache cleanup and conversion prevents one active job from
    // pruning another job's cache entry. Each job still receives its own
    // LibreOffice profile/temp directory. Polling the lock keeps cancellation
    // responsive while another conversion is running.
    let _conversion_guard = wait_for_conversion_guard(cancellation)?;
    let converter = find_converter(cancellation)?;
    let cache_key = cache_key(source, &source_bytes, &converter);
    let cache_path = cache_root.join(format!("{cache_key}.pdf"));
    cleanup_cache(&cache_root, Some(&cache_path));

    if cache_path.is_file() {
        if let Ok(pdf) = read_bounded(&cache_path, MAX_PDF_BYTES) {
            if validate_converted_pdf(&pdf) {
                if cancellation.is_cancelled() {
                    return Err(ImportFailure::Cancelled.code().into());
                }
                progress("complete");
                return Ok(ImportedPptx {
                    pdf,
                    notes,
                    cache_hit: true,
                });
            }
        }
        // This path is generated by this module and is safe to remove.  A
        // corrupt cache entry must never make a valid source permanently fail.
        let _ = fs::remove_file(&cache_path);
    }

    progress("converting");
    let pdf = convert_with_libreoffice(&source_bytes, &converter, &cache_root, cancellation)?;
    if cancellation.is_cancelled() {
        return Err(ImportFailure::Cancelled.code().into());
    }
    if !validate_converted_pdf(&pdf) {
        return Err(ImportFailure::ConversionFailed.code().into());
    }

    progress("caching");
    write_cache_atomically(&cache_path, &pdf)
        .map_err(|_| ImportFailure::ConversionFailed.code().to_string())?;
    if cancellation.is_cancelled() {
        return Err(ImportFailure::Cancelled.code().into());
    }
    cleanup_cache(&cache_root, Some(&cache_path));
    progress("complete");
    Ok(ImportedPptx {
        pdf,
        notes,
        cache_hit: false,
    })
}

/// Parse the bounded PPTX package and return one note slot per physical slide.
///
/// This parser reads only presentation relationships, slide relationships, and
/// notes XML.  It does not extract arbitrary package entries and rejects path
/// traversal, external relationships, oversized entries, and malformed/missing
/// presentation relationships.
#[cfg(test)]
#[path = "slides_import_test.rs"]
mod tests;
