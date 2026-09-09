//! User-mediated PDF selection with one exact, read-only Markdown companion.
use crate::slides_import::{self, CancellationToken};
use base64::Engine;
use serde::Serialize;
use serde_json::json;
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};
use tauri::Emitter;
use tauri_plugin_dialog::DialogExt;

const MAX_PDF_BYTES: u64 = 128 * 1024 * 1024;
const MAX_SCRIPT_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SlidesPdfSelection {
    pdf_name: String,
    pdf_base64: String,
    script_name: Option<String>,
    script_text: Option<String>,
    script_read_failed: bool,
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|_| "slides_file_read_failed")?;
    let metadata = file.metadata().map_err(|_| "slides_file_read_failed")?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err("slides_file_too_large_or_not_regular".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "slides_file_read_failed")?;
    if bytes.len() as u64 > limit {
        return Err("slides_file_too_large_or_not_regular".into());
    }
    Ok(bytes)
}

fn read_script(selected_pdf: &Path) -> Result<Option<(String, String)>, String> {
    let sibling = selected_pdf.with_extension("md");
    match fs::symlink_metadata(&sibling) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("slides_script_read_failed".into()),
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
            return Err("slides_script_not_regular".into());
        }
        Ok(_) => {}
    }
    let parent = selected_pdf
        .parent()
        .ok_or("slides_invalid_path")?
        .canonicalize()
        .map_err(|_| "slides_invalid_path")?;
    let canonical = sibling
        .canonicalize()
        .map_err(|_| "slides_script_read_failed")?;
    if canonical.parent() != Some(parent.as_path()) {
        return Err("slides_script_outside_directory".into());
    }
    let bytes = read_bounded(&canonical, MAX_SCRIPT_BYTES)?;
    let text = String::from_utf8(bytes).map_err(|_| "slides_script_not_utf8")?;
    Ok(Some((
        sibling
            .file_name()
            .ok_or("slides_invalid_path")?
            .to_string_lossy()
            .into_owned(),
        text.trim_start_matches('\u{feff}').to_string(),
    )))
}

fn read_selected_pdf(selected: &Path) -> Result<SlidesPdfSelection, String> {
    if !selected
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
    {
        return Err("slides_not_pdf".into());
    }
    let canonical = selected
        .canonicalize()
        .map_err(|_| "slides_file_read_failed")?;
    let pdf = read_bounded(&canonical, MAX_PDF_BYTES)?;
    let mut selection = SlidesPdfSelection {
        pdf_name: selected
            .file_name()
            .ok_or("slides_invalid_path")?
            .to_string_lossy()
            .into_owned(),
        pdf_base64: base64::engine::general_purpose::STANDARD.encode(pdf),
        script_name: None,
        script_text: None,
        script_read_failed: false,
    };
    match read_script(selected) {
        Ok(Some((name, text))) => {
            selection.script_name = Some(name);
            selection.script_text = Some(text);
        }
        Ok(None) => {}
        Err(_) => selection.script_read_failed = true,
    }
    log::debug!(
        "[SlidesFiles] selected PDF; companion={}, companion_failed={}",
        selection.script_name.is_some(),
        selection.script_read_failed
    );
    Ok(selection)
}

fn read_selected_document(
    selected: &Path,
    cache_root: Option<&Path>,
    cancellation: &CancellationToken,
    progress: &mut dyn FnMut(&'static str),
) -> Result<SlidesPdfSelection, String> {
    let extension = selected
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if extension.eq_ignore_ascii_case("pdf") {
        if cancellation.is_cancelled() {
            return Err("slides_import_cancelled".into());
        }
        progress("reading");
        let selection = read_selected_pdf(selected)?;
        progress("complete");
        return Ok(selection);
    }
    if !extension.eq_ignore_ascii_case("pptx") {
        return Err("slides_unsupported_file_type".into());
    }

    let canonical = selected
        .canonicalize()
        .map_err(|_| "slides_file_read_failed".to_string())?;
    let cache_root = cache_root.ok_or("slides_conversion_failed")?;
    let imported = slides_import::import_pptx(&canonical, cache_root, cancellation, progress)?;
    if cancellation.is_cancelled() {
        return Err("slides_import_cancelled".into());
    }
    assemble_pptx_selection(selected, imported.pdf, &imported.notes)
}

fn assemble_pptx_selection(
    selected: &Path,
    pdf: Vec<u8>,
    notes: &slides_import::PptxNotes,
) -> Result<SlidesPdfSelection, String> {
    let pdf_name = selected
        .file_name()
        .ok_or("slides_invalid_path")?
        .to_string_lossy()
        .into_owned();
    let mut selection = SlidesPdfSelection {
        // The UI deliberately keeps the source name so the user can identify
        // the deck even though the viewer receives converted PDF bytes.
        pdf_name,
        pdf_base64: base64::engine::general_purpose::STANDARD.encode(pdf),
        script_name: None,
        script_text: None,
        script_read_failed: false,
    };
    match read_script(selected) {
        Ok(Some((name, text))) => {
            selection.script_name = Some(name);
            selection.script_text = Some(text);
        }
        Ok(None) => {
            if let Some(text) = notes.script_markdown() {
                selection.script_name = Some(
                    selected
                        .with_extension("md")
                        .file_name()
                        .ok_or("slides_invalid_path")?
                        .to_string_lossy()
                        .into_owned(),
                );
                selection.script_text = Some(text);
            }
        }
        Err(_) => selection.script_read_failed = true,
    }
    Ok(selection)
}

fn slides_import_cache_root() -> Result<PathBuf, String> {
    let root = crate::data_home::child(crate::data_home::DataHomeChild::Apps)
        .join("slides")
        .join("pptx-import");
    fs::create_dir_all(&root).map_err(|_| "slides_conversion_failed".to_string())?;
    Ok(root)
}

type ImportJobKey = (String, String);

fn import_jobs() -> &'static Mutex<HashMap<ImportJobKey, Arc<CancellationToken>>> {
    static JOBS: OnceLock<Mutex<HashMap<ImportJobKey, Arc<CancellationToken>>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn valid_request_id(request_id: &str) -> bool {
    !request_id.is_empty()
        && request_id.len() <= 160
        && request_id.chars().all(|value| {
            value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | '.' | ':' | '/')
        })
}

fn register_import_job(
    webview_label: &str,
    request_id: &str,
) -> Result<Arc<CancellationToken>, String> {
    let mut jobs = import_jobs()
        .lock()
        .map_err(|_| "slides_import_state_unavailable".to_string())?;
    let key = (webview_label.to_string(), request_id.to_string());
    // A native file dialog is process-global. Keep one picker per webview and
    // bound the total number of active requests so distinct request IDs cannot
    // create an unbounded queue of blocking picker threads.
    if jobs.keys().any(|(label, _)| label == webview_label) || jobs.len() >= 4 {
        return Err("slides_import_busy".into());
    }
    let token = Arc::new(CancellationToken::default());
    jobs.insert(key, token.clone());
    Ok(token)
}

fn unregister_import_job(webview_label: &str, request_id: &str) {
    if let Ok(mut jobs) = import_jobs().lock() {
        jobs.remove(&(webview_label.to_string(), request_id.to_string()));
    }
}

fn emit_import_progress(
    app: &tauri::AppHandle,
    webview_label: &str,
    request_id: &str,
    phase: &'static str,
) {
    let _ = app.emit_to(
        webview_label,
        "naia-slides:import-progress",
        json!({"requestId": request_id, "phase": phase}),
    );
}

struct ImportJobGuard {
    webview_label: String,
    request_id: String,
}

impl Drop for ImportJobGuard {
    fn drop(&mut self) {
        unregister_import_job(&self.webview_label, &self.request_id);
    }
}

/// Pick a PDF or PPTX using the native picker.  A PPTX is converted only
/// after the user selects it; the source path is never supplied by the
/// caller.  `request_id` is scoped to the invoking webview and is used only
/// for progress/cancellation correlation.
#[tauri::command]
pub(crate) async fn slides_open_document(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    request_id: String,
) -> Result<Option<SlidesPdfSelection>, String> {
    if !valid_request_id(&request_id) {
        return Err("slides_invalid_request_id".into());
    }
    let webview_label = webview.label().to_string();
    let cancellation = register_import_job(&webview_label, &request_id)?;
    let _job_guard = ImportJobGuard {
        webview_label: webview_label.clone(),
        request_id: request_id.clone(),
    };
    let app_for_worker = app.clone();
    let label_for_worker = webview_label.clone();
    let request_for_worker = request_id.clone();
    let cancellation_for_worker = cancellation.clone();
    let result = tokio::task::spawn_blocking(move || {
        // Keep the registry entry alive until the blocking worker itself
        // exits. Dropping the Tauri future must not detach an uncancellable
        // conversion from its request binding.
        let _job_guard = _job_guard;
        let mut progress = |phase: &'static str| {
            emit_import_progress(
                &app_for_worker,
                &label_for_worker,
                &request_for_worker,
                phase,
            );
        };
        progress("picking");
        let selected = app_for_worker
            .dialog()
            .file()
            .add_filter("PDF or PowerPoint", &["pdf", "pptx"])
            .blocking_pick_file();
        let path = match selected {
            None => {
                if cancellation_for_worker.is_cancelled() {
                    return Err("slides_import_cancelled".into());
                }
                return Ok(None);
            }
            Some(tauri_plugin_dialog::FilePath::Path(path)) => path,
            Some(_) => return Err("slides_unsupported_file_location".into()),
        };
        if cancellation_for_worker.is_cancelled() {
            return Err("slides_import_cancelled".into());
        }
        let cache_root = path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("pptx"))
            .then(slides_import_cache_root)
            .transpose()?;
        read_selected_document(
            &path,
            cache_root.as_deref(),
            &cancellation_for_worker,
            &mut progress,
        )
        .map(Some)
    })
    .await
    .map_err(|_| "slides_picker_failed".to_string())?;
    result
}

/// Cancel only a conversion started by the same Tauri webview and request ID.
/// A caller cannot cancel another webview's job by guessing its request ID.
#[tauri::command]
pub(crate) fn slides_cancel_open(
    webview: tauri::Webview,
    request_id: String,
) -> Result<(), String> {
    if !valid_request_id(&request_id) {
        return Err("slides_invalid_request_id".into());
    }
    let key = (webview.label().to_string(), request_id);
    let token = import_jobs()
        .lock()
        .map_err(|_| "slides_import_state_unavailable".to_string())?
        .get(&key)
        .cloned()
        .ok_or("slides_import_not_found")?;
    token.cancel();
    Ok(())
}

/// No caller-supplied path: access begins with the native user file picker.
/// No workspace grant, directory scope, write access, or persistence is added.
#[tauri::command]
pub(crate) async fn slides_open_pdf(
    app: tauri::AppHandle,
) -> Result<Option<SlidesPdfSelection>, String> {
    tokio::task::spawn_blocking(move || {
        log::debug!("[SlidesFiles] opening PDF picker");
        let selected = app
            .dialog()
            .file()
            .add_filter("PDF", &["pdf"])
            .blocking_pick_file();
        match selected {
            None => Ok(None),
            Some(tauri_plugin_dialog::FilePath::Path(path)) => read_selected_pdf(&path).map(Some),
            Some(_) => Err("slides_unsupported_file_location".into()),
        }
    })
    .await
    .map_err(|_| "slides_picker_failed".to_string())?
}

#[cfg(test)]
#[path = "slides_files_test.rs"]
mod tests;
