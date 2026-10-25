use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::path::{Component, Path};
use tauri::State;

use super::checkout::resolve_project_checkout;
use super::config::read_project_runtime_config;
use super::yaml_helpers::validate_docs_dir_in_checkout;
use super::ProjectCatalogAuthority;

pub(crate) const MAX_PROJECT_DOC_ENTRIES: usize = 2000;
pub(crate) const MAX_PROJECT_DOC_VISITED_ENTRIES: usize = 20_000;
pub(crate) const MAX_PROJECT_DOC_DEPTH: usize = 8;
pub(crate) const MAX_PROJECT_DOC_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDocEntry {
    pub dir: String,
    pub relative_path: String,
    pub size_bytes: u64,
}

#[tauri::command]
pub fn project_docs_list(
    authority: State<'_, ProjectCatalogAuthority>,
    adapter_root: String,
    project_path: String,
) -> Result<Vec<ProjectDocEntry>, String> {
    crate::log_verbose("[project_catalog_runtime::project_docs_list] enter");
    list_project_docs(&authority, &adapter_root, &project_path)
}

#[tauri::command]
pub fn project_docs_read(
    authority: State<'_, ProjectCatalogAuthority>,
    adapter_root: String,
    project_path: String,
    relative_path: String,
) -> Result<String, String> {
    crate::log_verbose("[project_catalog_runtime::project_docs_read] enter");
    read_project_doc(&authority, &adapter_root, &project_path, &relative_path)
}

pub(crate) fn list_project_docs(
    authority: &ProjectCatalogAuthority,
    adapter_root: &str,
    project_path: &str,
) -> Result<Vec<ProjectDocEntry>, String> {
    list_project_docs_with_caps(
        authority,
        adapter_root,
        project_path,
        MAX_PROJECT_DOC_ENTRIES,
        MAX_PROJECT_DOC_VISITED_ENTRIES,
    )
}

pub(crate) fn list_project_docs_with_caps(
    authority: &ProjectCatalogAuthority,
    adapter_root: &str,
    project_path: &str,
    max_entries: usize,
    max_visited_entries: usize,
) -> Result<Vec<ProjectDocEntry>, String> {
    crate::log_verbose("[project_catalog_runtime::list_project_docs] enter");
    let config = read_project_runtime_config(authority, adapter_root, project_path)?;
    let checkout = resolve_project_checkout(authority, adapter_root, project_path)?;
    if config.docs_dirs.is_empty() {
        crate::log_verbose("[project_catalog_runtime::list_project_docs] branch=empty_docs_dirs");
        return Ok(Vec::new());
    }

    let mut seen_paths = BTreeSet::new();
    let mut entries = Vec::new();
    let mut visited_entries = 0usize;
    for configured_dir in &config.docs_dirs {
        if entries.len() >= max_entries || visited_entries >= max_visited_entries {
            break;
        }
        match validate_docs_dir_in_checkout(&checkout.checkout_path, configured_dir) {
            Ok((normalized_dir, Some(canonical_dir))) => {
                walk_docs_directory(
                    &checkout.checkout_path,
                    &canonical_dir,
                    &canonical_dir,
                    &normalized_dir,
                    &normalized_dir,
                    1,
                    max_entries,
                    max_visited_entries,
                    &mut visited_entries,
                    &mut seen_paths,
                    &mut entries,
                );
            }
            Ok((_normalized_dir, None)) => {
                crate::log_verbose(
                    "[project_catalog_runtime::list_project_docs] branch=missing_dir_empty",
                );
            }
            Err(reason) => {
                crate::log_verbose(&format!(
                    "[project_catalog_runtime::list_project_docs] branch=skip_unsafe_dir reason={reason}"
                ));
            }
        }
    }
    crate::log_verbose(&format!(
        "[project_catalog_runtime::list_project_docs] branch=done count={} visited={visited_entries}",
        entries.len()
    ));
    Ok(entries)
}

#[allow(clippy::too_many_arguments)]
fn walk_docs_directory(
    checkout_root: &Path,
    dir_root: &Path,
    current_dir: &Path,
    configured_dir: &str,
    current_relative: &str,
    depth: usize,
    max_entries: usize,
    max_visited_entries: usize,
    visited_entries: &mut usize,
    seen_paths: &mut BTreeSet<String>,
    out: &mut Vec<ProjectDocEntry>,
) {
    if depth > MAX_PROJECT_DOC_DEPTH
        || out.len() >= max_entries
        || *visited_entries >= max_visited_entries
    {
        return;
    }
    let Ok(read_dir) = fs::read_dir(current_dir) else {
        return;
    };
    let mut children = Vec::new();
    for entry_result in read_dir {
        if *visited_entries >= max_visited_entries {
            crate::log_verbose(
                "[project_catalog_runtime::walk_docs_directory] branch=visited_entry_cap_reached",
            );
            break;
        }
        *visited_entries += 1;
        if let Ok(entry) = entry_result {
            children.push(entry);
        }
    }
    children.sort_by_key(|entry| entry.file_name());

    for entry in children {
        if out.len() >= max_entries {
            break;
        }
        let file_name_os = entry.file_name();
        let Some(file_name) = file_name_os.to_str() else {
            continue;
        };
        if file_name.is_empty() || file_name.starts_with('.') {
            continue;
        }
        let entry_path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&entry_path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        let child_relative = format!("{current_relative}/{file_name}");
        if metadata.file_type().is_dir() {
            if depth < MAX_PROJECT_DOC_DEPTH && *visited_entries < max_visited_entries {
                let Ok(canonical_child) = dunce::canonicalize(&entry_path) else {
                    continue;
                };
                if !canonical_child.starts_with(dir_root)
                    || !canonical_child.starts_with(checkout_root)
                {
                    continue;
                }
                walk_docs_directory(
                    checkout_root,
                    dir_root,
                    &canonical_child,
                    configured_dir,
                    &child_relative,
                    depth + 1,
                    max_entries,
                    max_visited_entries,
                    visited_entries,
                    seen_paths,
                    out,
                );
            }
        } else if metadata.file_type().is_file() && is_markdown_file_name(file_name) {
            let Ok(canonical_file) = dunce::canonicalize(&entry_path) else {
                continue;
            };
            if !canonical_file.starts_with(dir_root) || !canonical_file.starts_with(checkout_root) {
                continue;
            }
            if seen_paths.insert(child_relative.clone()) {
                out.push(ProjectDocEntry {
                    dir: configured_dir.to_owned(),
                    relative_path: child_relative,
                    size_bytes: metadata.len(),
                });
            }
        }
    }
}

pub(crate) fn read_project_doc(
    authority: &ProjectCatalogAuthority,
    adapter_root: &str,
    project_path: &str,
    relative_path: &str,
) -> Result<String, String> {
    crate::log_verbose("[project_catalog_runtime::read_project_doc] enter");
    let config = read_project_runtime_config(authority, adapter_root, project_path)?;
    let checkout = resolve_project_checkout(authority, adapter_root, project_path)?;
    let segments = validate_doc_relative_segments(relative_path)?;
    let normalized_rel = segments.join("/");

    let mut matched_dir_root = None;
    for configured_dir in &config.docs_dirs {
        let Ok((normalized_dir, Some(canonical_dir))) =
            validate_docs_dir_in_checkout(&checkout.checkout_path, configured_dir)
        else {
            continue;
        };
        let prefix = format!("{normalized_dir}/");
        if let Some(remainder) = normalized_rel.strip_prefix(&prefix) {
            let depth = remainder.split('/').count();
            if (1..=MAX_PROJECT_DOC_DEPTH).contains(&depth) {
                matched_dir_root = Some(canonical_dir);
                break;
            }
        }
    }
    let canonical_dir_root = matched_dir_root.ok_or_else(|| {
        crate::log_verbose(
            "[project_catalog_runtime::read_project_doc] branch=reject_outside_configured_dirs",
        );
        "doc_outside_configured_dirs".to_owned()
    })?;

    let mut current = checkout.checkout_path.clone();
    for segment in &segments[..segments.len() - 1] {
        current.push(segment);
        let metadata = fs::symlink_metadata(&current).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "doc_not_found".to_owned()
            } else {
                "doc_unreadable".to_owned()
            }
        })?;
        if metadata.file_type().is_symlink() {
            crate::log_verbose("[project_catalog_runtime::read_project_doc] branch=reject_symlink");
            return Err("doc_symlink_rejected".to_owned());
        }
        if !metadata.file_type().is_dir() {
            return Err("doc_not_found".to_owned());
        }
    }

    current.push(segments[segments.len() - 1]);
    let final_meta = fs::symlink_metadata(&current).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "doc_not_found".to_owned()
        } else {
            "doc_unreadable".to_owned()
        }
    })?;
    if final_meta.file_type().is_symlink() {
        crate::log_verbose("[project_catalog_runtime::read_project_doc] branch=reject_symlink");
        return Err("doc_symlink_rejected".to_owned());
    }

    let canonical_file = dunce::canonicalize(&current).map_err(|_| "doc_unreadable".to_owned())?;
    if !canonical_file.starts_with(&canonical_dir_root)
        || !canonical_file.starts_with(&checkout.checkout_path)
        || canonical_file == canonical_dir_root
    {
        crate::log_verbose(
            "[project_catalog_runtime::read_project_doc] branch=reject_canonical_escape",
        );
        return Err("doc_outside_configured_dirs".to_owned());
    }

    let file = open_doc_file_no_follow(&current)?;
    let opened_meta = file.metadata().map_err(|_| "doc_unreadable".to_owned())?;
    if !opened_meta.is_file() {
        return Err("doc_not_regular_file".to_owned());
    }
    if opened_meta.len() > MAX_PROJECT_DOC_BYTES as u64 {
        return Err("doc_too_large".to_owned());
    }

    let mut bytes = Vec::new();
    file.take((MAX_PROJECT_DOC_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "doc_unreadable".to_owned())?;
    if bytes.len() > MAX_PROJECT_DOC_BYTES {
        crate::log_verbose(
            "[project_catalog_runtime::read_project_doc] branch=reject_file_grew_past_limit",
        );
        return Err("doc_too_large".to_owned());
    }

    String::from_utf8(bytes).map_err(|_| "doc_invalid_utf8".to_owned())
}

#[cfg(unix)]
fn open_doc_file_no_follow(path: &Path) -> Result<fs::File, String> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| {
            if error.raw_os_error() == Some(libc::ELOOP) {
                crate::log_verbose(
                    "[project_catalog_runtime::open_doc_file_no_follow] branch=reject_eloop",
                );
                "doc_symlink_rejected".to_owned()
            } else if error.kind() == std::io::ErrorKind::NotFound {
                "doc_not_found".to_owned()
            } else {
                "doc_unreadable".to_owned()
            }
        })
}

#[cfg(not(unix))]
fn open_doc_file_no_follow(path: &Path) -> Result<fs::File, String> {
    // Windows std::fs::OpenOptions does not provide a portable O_NOFOLLOW flag;
    // parent-segment symlink_metadata + canonicalize checks above mitigate symlink
    // traversal, with residual TOCTOU risk between the check and open on Windows.
    fs::OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "doc_not_found".to_owned()
            } else {
                "doc_unreadable".to_owned()
            }
        })
}

fn validate_doc_relative_segments(relative_path: &str) -> Result<Vec<&str>, String> {
    let trimmed = relative_path.trim();
    if trimmed.is_empty()
        || trimmed.contains('\\')
        || trimmed.contains(':')
        || trimmed.starts_with('/')
        || trimmed.chars().any(char::is_control)
    {
        return Err("doc_path_invalid".to_owned());
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err("doc_path_invalid".to_owned());
    }
    let mut segments = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                let Some(text) = part.to_str() else {
                    return Err("doc_path_invalid".to_owned());
                };
                if text.is_empty() || matches!(text, "." | "..") || text.starts_with('.') {
                    return Err("doc_path_invalid".to_owned());
                }
                segments.push(text);
            }
            _ => return Err("doc_path_invalid".to_owned()),
        }
    }
    if segments.len() < 2 {
        return Err("doc_path_invalid".to_owned());
    }
    let Some(file_name) = segments.last() else {
        return Err("doc_path_invalid".to_owned());
    };
    if !is_markdown_file_name(file_name) {
        return Err("doc_path_invalid".to_owned());
    }
    Ok(segments)
}

fn is_markdown_file_name(file_name: &str) -> bool {
    file_name.len() > 3 && file_name.to_ascii_lowercase().ends_with(".md")
}
