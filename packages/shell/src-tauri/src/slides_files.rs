//! User-mediated PDF selection with one exact, read-only Markdown companion.
use crate::slides_import::{self, CancellationToken};
use base64::Engine;
use serde::Serialize;
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};
use tauri::Emitter;
use tauri_plugin_dialog::DialogExt;

const MAX_PDF_BYTES: u64 = 128 * 1024 * 1024;
const MAX_SCRIPT_BYTES: u64 = 1024 * 1024;
const MAX_VIDEO_BYTES: u64 = 300 * 1024 * 1024;
const MAX_TOTAL_VIDEO_BYTES: u64 = 600 * 1024 * 1024;
const MAX_VIDEO_FILES: usize = 20;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SlidesVideoAsset {
    name: String,
    mime_type: &'static str,
    base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SlidesPdfSelection {
    pdf_name: String,
    pdf_base64: String,
    script_name: Option<String>,
    script_text: Option<String>,
    script_read_failed: bool,
    videos: Vec<SlidesVideoAsset>,
    video_read_failures: Vec<String>,
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

fn valid_slide_video_name(name: &str) -> bool {
    if name.is_empty()
        || name.chars().count() > 180
        || name.starts_with('.')
        || name.contains("..")
        || name.trim() != name
        || name.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '/' | '\\' | ':' | '*' | '?' | '<' | '>' | '|' | '"'
                )
        })
    {
        return false;
    }
    Path::new(name).components().count() == 1
        && Path::new(name).file_name().and_then(|value| value.to_str()) == Some(name)
        && Path::new(name)
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                extension.eq_ignore_ascii_case("mp4")
                    || extension.eq_ignore_ascii_case("webm")
                    || extension.eq_ignore_ascii_case("m4v")
            })
}

fn video_names_from_script(script: &str) -> (Vec<String>, Vec<String>) {
    let mut names = Vec::new();
    let mut failures = Vec::new();
    let mut seen = HashSet::new();
    for line in script.lines() {
        let Some(heading) = line.strip_prefix("## ") else {
            continue;
        };
        let Some((position, rest)) = heading.split_once(". ") else {
            continue;
        };
        let Some((page, order)) = position.split_once('-') else {
            continue;
        };
        let valid_position = page.parse::<u32>().is_ok_and(|value| value > 0)
            && order.parse::<u32>().is_ok_and(|value| value > 0);
        let rest = rest.trim_start();
        let Some(tag_end) = rest.find(']') else {
            continue;
        };
        let Some(tag) = rest.strip_prefix('[') else {
            continue;
        };
        let tag = &tag[..tag_end.saturating_sub(1)];
        if !(tag.eq_ignore_ascii_case("video") || tag == "영상") {
            continue;
        }
        let name = rest[tag_end + 1..].trim();
        let label = if name.is_empty() {
            "(파일 이름 없음)".to_string()
        } else {
            name.to_string()
        };
        if !valid_position || !valid_slide_video_name(name) {
            if !failures.contains(&label) {
                failures.push(label);
            }
            continue;
        }
        if seen.insert(name.to_string()) {
            names.push(name.to_string());
        }
    }
    (names, failures)
}

fn read_slide_videos(
    selected_document: &Path,
    script: &str,
) -> (Vec<SlidesVideoAsset>, Vec<String>) {
    let (names, mut failures) = video_names_from_script(script);
    if names.is_empty() {
        return (Vec::new(), failures);
    }
    let Some(parent) = selected_document
        .parent()
        .and_then(|path| path.canonicalize().ok())
    else {
        failures.extend(names);
        return (Vec::new(), failures);
    };
    let mut videos = Vec::new();
    let mut total_bytes = 0_u64;
    for (index, name) in names.into_iter().enumerate() {
        if index >= MAX_VIDEO_FILES {
            failures.push(name);
            continue;
        }
        let candidate = parent.join(&name);
        let metadata = match fs::symlink_metadata(&candidate) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => metadata,
            _ => {
                failures.push(name);
                continue;
            }
        };
        if metadata.len() > MAX_VIDEO_BYTES
            || total_bytes.saturating_add(metadata.len()) > MAX_TOTAL_VIDEO_BYTES
        {
            failures.push(name);
            continue;
        }
        let canonical = match candidate.canonicalize() {
            Ok(path) if path.parent() == Some(parent.as_path()) => path,
            _ => {
                failures.push(name);
                continue;
            }
        };
        let bytes = match read_bounded(&canonical, MAX_VIDEO_BYTES) {
            Ok(bytes) => bytes,
            Err(_) => {
                failures.push(name);
                continue;
            }
        };
        total_bytes = total_bytes.saturating_add(bytes.len() as u64);
        let mime_type = match Path::new(&name)
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "webm" => "video/webm",
            _ => "video/mp4",
        };
        videos.push(SlidesVideoAsset {
            name,
            mime_type,
            base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        });
    }
    for name in &failures {
        log::warn!("[SlidesFiles] demo video unavailable or rejected: {}", name);
    }
    (videos, failures)
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
        videos: Vec::new(),
        video_read_failures: Vec::new(),
    };
    match read_script(selected) {
        Ok(Some((name, text))) => {
            selection.script_name = Some(name);
            selection.script_text = Some(text);
        }
        Ok(None) => {}
        Err(_) => selection.script_read_failed = true,
    }
    if let Some(script) = selection.script_text.as_deref() {
        (selection.videos, selection.video_read_failures) = read_slide_videos(selected, script);
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
        videos: Vec::new(),
        video_read_failures: Vec::new(),
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
    if let Some(script) = selection.script_text.as_deref() {
        (selection.videos, selection.video_read_failures) = read_slide_videos(selected, script);
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
