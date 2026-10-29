use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

use crate::project_agent_pty::{acquire_project_class_reset_guard, ProjectAgentRegistry};

use super::checkout::resolve_project_checkout;
use super::config::read_project_runtime_config;
use super::yaml_helpers::is_valid_baseline_ref;
use super::ProjectCatalogAuthority;

const SANITIZED_GIT_ENV_VARS: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_COMMON_DIR",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectClassResetResult {
    pub backup_relative_path: String,
    pub backed_up_files: usize,
    pub deleted_files: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectClassBackupManifest {
    pub baseline_ref: String,
    pub previous_head: String,
    pub created_at: String,
    pub files: Vec<String>,
    pub deleted: Vec<String>,
}

#[tauri::command]
pub fn project_class_reset(
    registry: State<'_, ProjectAgentRegistry>,
    authority: State<'_, ProjectCatalogAuthority>,
    adapter_root: String,
    project_path: String,
) -> Result<ProjectClassResetResult, String> {
    crate::log_verbose("[project_catalog_runtime::project_class_reset] enter");
    reset_class_project(&authority, &registry, &adapter_root, &project_path, None)
}

pub(crate) fn reset_class_project(
    authority: &ProjectCatalogAuthority,
    registry: &ProjectAgentRegistry,
    adapter_root: &str,
    project_path: &str,
    timestamp_override: Option<&str>,
) -> Result<ProjectClassResetResult, String> {
    crate::log_verbose("[project_catalog_runtime::reset_class_project] enter");
    let config = read_project_runtime_config(authority, adapter_root, project_path)?;
    let Some(class_config) = config.class else {
        crate::log_verbose(
            "[project_catalog_runtime::reset_class_project] branch=reject_not_class_project",
        );
        return Err("not_class_project".to_owned());
    };
    let baseline_ref = class_config.baseline_ref.trim().to_owned();
    if !is_valid_baseline_ref(&baseline_ref) {
        crate::log_verbose(
            "[project_catalog_runtime::reset_class_project] branch=reject_invalid_baseline_ref",
        );
        return Err("not_class_project".to_owned());
    }

    let checkout = resolve_project_checkout(authority, adapter_root, project_path)?;

    let _reset_guard = acquire_project_class_reset_guard(
        registry,
        &checkout.project_path,
        &checkout.checkout_path,
    )?;

    verify_checkout_is_own_git_repo(&checkout.checkout_path)?;
    verify_baseline_commit_exists(&checkout.checkout_path, &baseline_ref)?;
    let previous_head = read_current_head(&checkout.checkout_path)?;

    let candidate_paths = collect_changed_and_untracked_paths(&checkout.checkout_path, &baseline_ref)?;
    let checkout_name = checkout
        .checkout_path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "backup_failed".to_owned())?;

    let (compact_ts, iso_created_at) = match timestamp_override {
        Some(custom) => (custom.to_owned(), format!("{custom}Z")),
        None => current_utc_timestamps(),
    };
    let backup_folder_name = format!("{checkout_name}-{compact_ts}");
    let backup_relative_path = format!("class-backups/{backup_folder_name}");

    let backups_parent = ensure_class_backups_root(&config.adapter_root)?;
    let backup_root_input = backups_parent.join(&backup_folder_name);
    match fs::create_dir(&backup_root_input) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            crate::log_verbose(
                "[project_catalog_runtime::reset_class_project] branch=reject_backup_exists",
            );
            return Err("backup_exists".to_owned());
        }
        Err(_) => {
            crate::log_verbose(
                "[project_catalog_runtime::reset_class_project] branch=reject_backup_create_failed",
            );
            return Err("backup_failed".to_owned());
        }
    }

    let backup_meta =
        fs::symlink_metadata(&backup_root_input).map_err(|_| "backup_failed".to_owned())?;
    if backup_meta.file_type().is_symlink() || !backup_meta.is_dir() {
        return Err("backup_failed".to_owned());
    }
    let canonical_backup_root =
        dunce::canonicalize(&backup_root_input).map_err(|_| "backup_failed".to_owned())?;
    if !canonical_backup_root.starts_with(&backups_parent)
        || canonical_backup_root.parent() != Some(backups_parent.as_path())
    {
        return Err("backup_failed".to_owned());
    }

    let files_root_input = canonical_backup_root.join("files");
    fs::create_dir(&files_root_input).map_err(|_| "backup_failed".to_owned())?;
    let files_meta =
        fs::symlink_metadata(&files_root_input).map_err(|_| "backup_failed".to_owned())?;
    if files_meta.file_type().is_symlink() || !files_meta.is_dir() {
        return Err("backup_failed".to_owned());
    }
    let canonical_files_root =
        dunce::canonicalize(&files_root_input).map_err(|_| "backup_failed".to_owned())?;
    if !canonical_files_root.starts_with(&canonical_backup_root)
        || canonical_files_root.parent() != Some(canonical_backup_root.as_path())
    {
        return Err("backup_failed".to_owned());
    }

    let (backed_up_files, deleted_files) = backup_working_tree_files(
        &checkout.checkout_path,
        &canonical_files_root,
        &candidate_paths,
    )?;

    let manifest = ProjectClassBackupManifest {
        baseline_ref: baseline_ref.clone(),
        previous_head,
        created_at: iso_created_at,
        files: backed_up_files.clone(),
        deleted: deleted_files.clone(),
    };
    let manifest_json =
        serde_json::to_vec_pretty(&manifest).map_err(|_| "backup_failed".to_owned())?;
    let manifest_path = canonical_backup_root.join("manifest.json");
    let mut manifest_file = open_new_backup_dest_file(&manifest_path)?;
    manifest_file
        .write_all(&manifest_json)
        .map_err(|_| "backup_failed".to_owned())?;
    manifest_file
        .flush()
        .map_err(|_| "backup_failed".to_owned())?;

    let reset_output = run_git_command(
        &checkout.checkout_path,
        &["reset", "--hard", &baseline_ref],
        "reset_failed",
    )?;
    if !reset_output.status.success() {
        crate::log_verbose(
            "[project_catalog_runtime::reset_class_project] branch=git_reset_failed",
        );
        return Err("reset_failed".to_owned());
    }

    let clean_output =
        run_git_command(&checkout.checkout_path, &["clean", "-fd"], "reset_failed")?;
    if !clean_output.status.success() {
        crate::log_verbose(
            "[project_catalog_runtime::reset_class_project] branch=git_clean_failed",
        );
        return Err("reset_failed".to_owned());
    }

    crate::log_verbose(&format!(
        "[project_catalog_runtime::reset_class_project] branch=success backed_up={} deleted={}",
        backed_up_files.len(),
        deleted_files.len()
    ));
    Ok(ProjectClassResetResult {
        backup_relative_path,
        backed_up_files: backed_up_files.len(),
        deleted_files: deleted_files.len(),
    })
}

fn verify_checkout_is_own_git_repo(checkout_path: &Path) -> Result<(), String> {
    let dot_git = checkout_path.join(".git");
    let metadata = fs::symlink_metadata(&dot_git).map_err(|_| {
        crate::log_verbose(
            "[project_catalog_runtime::verify_checkout_is_own_git_repo] branch=missing_dot_git",
        );
        "not_git_repo".to_owned()
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        crate::log_verbose(
            "[project_catalog_runtime::verify_checkout_is_own_git_repo] branch=reject_non_directory_dot_git",
        );
        return Err("not_git_repo".to_owned());
    }
    let canonical_dot_git =
        dunce::canonicalize(&dot_git).map_err(|_| "not_git_repo".to_owned())?;
    if canonical_dot_git != dot_git {
        crate::log_verbose(
            "[project_catalog_runtime::verify_checkout_is_own_git_repo] branch=dot_git_noncanonical",
        );
        return Err("not_git_repo".to_owned());
    }

    let output = run_git_command(
        checkout_path,
        &["rev-parse", "--show-toplevel"],
        "not_git_repo",
    )?;
    if !output.status.success() {
        crate::log_verbose(
            "[project_catalog_runtime::verify_checkout_is_own_git_repo] branch=rev_parse_failed",
        );
        return Err("not_git_repo".to_owned());
    }
    let toplevel_raw = std::str::from_utf8(&output.stdout)
        .map_err(|_| "not_git_repo".to_owned())?
        .trim();
    if toplevel_raw.is_empty() {
        return Err("not_git_repo".to_owned());
    }
    let canonical_toplevel =
        dunce::canonicalize(Path::new(toplevel_raw)).map_err(|_| "not_git_repo".to_owned())?;
    if canonical_toplevel != checkout_path {
        crate::log_verbose(
            "[project_catalog_runtime::verify_checkout_is_own_git_repo] branch=toplevel_mismatch",
        );
        return Err("not_git_repo".to_owned());
    }

    let git_dirs_output = run_git_command(
        checkout_path,
        &["rev-parse", "--absolute-git-dir", "--git-common-dir"],
        "not_git_repo",
    )?;
    if !git_dirs_output.status.success() {
        crate::log_verbose(
            "[project_catalog_runtime::verify_checkout_is_own_git_repo] branch=git_dirs_rev_parse_failed",
        );
        return Err("not_git_repo".to_owned());
    }
    let git_dirs_text =
        std::str::from_utf8(&git_dirs_output.stdout).map_err(|_| "not_git_repo".to_owned())?;
    let mut git_dir_lines = git_dirs_text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    let Some(abs_git_dir_raw) = git_dir_lines.next() else {
        return Err("not_git_repo".to_owned());
    };
    let Some(common_git_dir_raw) = git_dir_lines.next() else {
        return Err("not_git_repo".to_owned());
    };
    if git_dir_lines.next().is_some() {
        return Err("not_git_repo".to_owned());
    }
    let abs_git_dir_path = if Path::new(abs_git_dir_raw).is_absolute() {
        Path::new(abs_git_dir_raw).to_path_buf()
    } else {
        checkout_path.join(abs_git_dir_raw)
    };
    let common_git_dir_path = if Path::new(common_git_dir_raw).is_absolute() {
        Path::new(common_git_dir_raw).to_path_buf()
    } else {
        checkout_path.join(common_git_dir_raw)
    };
    let canonical_abs_git_dir =
        dunce::canonicalize(&abs_git_dir_path).map_err(|_| "not_git_repo".to_owned())?;
    let canonical_common_git_dir =
        dunce::canonicalize(&common_git_dir_path).map_err(|_| "not_git_repo".to_owned())?;
    if canonical_abs_git_dir != canonical_dot_git || canonical_common_git_dir != canonical_dot_git {
        crate::log_verbose(
            "[project_catalog_runtime::verify_checkout_is_own_git_repo] branch=external_or_linked_git_dir",
        );
        return Err("not_git_repo".to_owned());
    }
    Ok(())
}

fn verify_baseline_commit_exists(checkout_path: &Path, baseline_ref: &str) -> Result<(), String> {
    if !is_valid_baseline_ref(baseline_ref) {
        return Err("not_class_project".to_owned());
    }
    let commit_spec = format!("{baseline_ref}^{{commit}}");
    let output = run_git_command(
        checkout_path,
        &["cat-file", "-e", &commit_spec],
        "baseline_missing",
    )?;
    if !output.status.success() {
        crate::log_verbose(
            "[project_catalog_runtime::verify_baseline_commit_exists] branch=baseline_missing",
        );
        return Err("baseline_missing".to_owned());
    }
    Ok(())
}

fn read_current_head(checkout_path: &Path) -> Result<String, String> {
    let output = run_git_command(checkout_path, &["rev-parse", "HEAD"], "backup_failed")?;
    if !output.status.success() {
        return Err("backup_failed".to_owned());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn collect_changed_and_untracked_paths(
    checkout_path: &Path,
    baseline_ref: &str,
) -> Result<BTreeSet<Vec<u8>>, String> {
    if !is_valid_baseline_ref(baseline_ref) {
        return Err("not_class_project".to_owned());
    }
    let diff_output = run_git_command(
        checkout_path,
        &["diff", "--name-only", "-z", baseline_ref, "--"],
        "backup_failed",
    )?;
    if !diff_output.status.success() {
        return Err("backup_failed".to_owned());
    }

    let untracked_output = run_git_command(
        checkout_path,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        "backup_failed",
    )?;
    if !untracked_output.status.success() {
        return Err("backup_failed".to_owned());
    }

    let mut paths = BTreeSet::new();
    for raw in diff_output
        .stdout
        .split(|byte| *byte == 0)
        .chain(untracked_output.stdout.split(|byte| *byte == 0))
    {
        if raw.is_empty() {
            continue;
        }
        paths.insert(raw.to_vec());
    }
    Ok(paths)
}

fn ensure_class_backups_root(adapter_root: &Path) -> Result<std::path::PathBuf, String> {
    let backups_dir = adapter_root.join("class-backups");
    match fs::symlink_metadata(&backups_dir) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("backup_failed".to_owned());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&backups_dir).map_err(|_| "backup_failed".to_owned())?;
        }
        Err(_) => return Err("backup_failed".to_owned()),
    }
    let canonical = dunce::canonicalize(&backups_dir).map_err(|_| "backup_failed".to_owned())?;
    if !canonical.starts_with(adapter_root) || canonical.parent() != Some(adapter_root) {
        return Err("backup_failed".to_owned());
    }
    Ok(canonical)
}

fn backup_working_tree_files(
    checkout_path: &Path,
    files_root: &Path,
    candidate_paths: &BTreeSet<Vec<u8>>,
) -> Result<(Vec<String>, Vec<String>), String> {
    let mut backed_up = Vec::new();
    let mut deleted = Vec::new();

    for raw_rel in candidate_paths {
        let (segments, normalized_rel) = validate_relative_backup_segments(raw_rel)?;

        let mut current_source = checkout_path.to_path_buf();
        let mut missing = false;
        let mut symlink_encountered = false;

        for segment in &segments[..segments.len() - 1] {
            current_source.push(segment);
            match fs::symlink_metadata(&current_source) {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink() {
                        symlink_encountered = true;
                        break;
                    }
                    if !metadata.is_dir() {
                        return Err("backup_failed".to_owned());
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    missing = true;
                    break;
                }
                Err(_) => return Err("backup_failed".to_owned()),
            }
        }

        if symlink_encountered {
            continue;
        }
        if missing {
            deleted.push(normalized_rel);
            continue;
        }

        current_source.push(&segments[segments.len() - 1]);
        match fs::symlink_metadata(&current_source) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    continue;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                deleted.push(normalized_rel);
                continue;
            }
            Err(_) => return Err("backup_failed".to_owned()),
        }

        let canonical_source =
            dunce::canonicalize(&current_source).map_err(|_| "backup_failed".to_owned())?;
        if !canonical_source.starts_with(checkout_path) || canonical_source == checkout_path {
            return Err("backup_failed".to_owned());
        }

        let Some(mut source_file) = open_backup_source_file(&current_source)? else {
            continue;
        };
        let opened_meta = source_file
            .metadata()
            .map_err(|_| "backup_failed".to_owned())?;
        if !opened_meta.is_file() {
            continue;
        }

        let mut current_dest = files_root.to_path_buf();
        for segment in &segments[..segments.len() - 1] {
            current_dest.push(segment);
            match fs::symlink_metadata(&current_dest) {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink() || !metadata.is_dir() {
                        return Err("backup_failed".to_owned());
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    fs::create_dir(&current_dest).map_err(|_| "backup_failed".to_owned())?;
                }
                Err(_) => return Err("backup_failed".to_owned()),
            }
            let canonical_dest_dir =
                dunce::canonicalize(&current_dest).map_err(|_| "backup_failed".to_owned())?;
            if !canonical_dest_dir.starts_with(files_root) {
                return Err("backup_failed".to_owned());
            }
        }

        let dest_path = current_dest.join(&segments[segments.len() - 1]);
        let mut dest_file = open_new_backup_dest_file(&dest_path)?;
        std::io::copy(&mut source_file, &mut dest_file).map_err(|_| "backup_failed".to_owned())?;
        dest_file.flush().map_err(|_| "backup_failed".to_owned())?;
        backed_up.push(normalized_rel);
    }

    Ok((backed_up, deleted))
}

#[cfg(unix)]
fn open_backup_source_file(path: &Path) -> Result<Option<fs::File>, String> {
    use std::os::unix::fs::OpenOptionsExt;
    match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
    {
        Ok(file) => Ok(Some(file)),
        Err(error) if error.raw_os_error() == Some(libc::ELOOP) => Ok(None),
        Err(_) => Err("backup_failed".to_owned()),
    }
}

#[cfg(not(unix))]
fn open_backup_source_file(path: &Path) -> Result<Option<fs::File>, String> {
    // Windows std::fs::OpenOptions does not provide a portable O_NOFOLLOW flag;
    // parent-segment symlink_metadata + canonicalize checks above mitigate symlink
    // traversal, with residual TOCTOU risk between the check and open on Windows.
    fs::OpenOptions::new()
        .read(true)
        .open(path)
        .map(Some)
        .map_err(|_| "backup_failed".to_owned())
}

#[cfg(unix)]
fn open_new_backup_dest_file(path: &Path) -> Result<fs::File, String> {
    use std::os::unix::fs::OpenOptionsExt;
    if fs::symlink_metadata(path).is_ok() {
        return Err("backup_failed".to_owned());
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| "backup_failed".to_owned())
}

#[cfg(not(unix))]
fn open_new_backup_dest_file(path: &Path) -> Result<fs::File, String> {
    // create_new(true) refuses any existing file or symlink at the destination path.
    if fs::symlink_metadata(path).is_ok() {
        return Err("backup_failed".to_owned());
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "backup_failed".to_owned())
}

#[cfg(unix)]
fn validate_relative_backup_segments(raw_path: &[u8]) -> Result<(Vec<OsString>, String), String> {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    if raw_path.is_empty() || raw_path.starts_with(b"/") || raw_path.contains(&0) {
        return Err("backup_failed".to_owned());
    }
    let mut segments = Vec::new();
    let mut display_segments = Vec::new();
    for part in raw_path.split(|byte| *byte == b'/') {
        if part.is_empty() || part == b"." || part == b".." {
            return Err("backup_failed".to_owned());
        }
        segments.push(OsStr::from_bytes(part).to_os_string());
        display_segments.push(String::from_utf8_lossy(part).into_owned());
    }
    if segments.is_empty() {
        return Err("backup_failed".to_owned());
    }
    Ok((segments, display_segments.join("/")))
}

#[cfg(not(unix))]
fn validate_relative_backup_segments(raw_path: &[u8]) -> Result<(Vec<OsString>, String), String> {
    use std::path::Component;

    if raw_path.is_empty() || raw_path.contains(&0) {
        return Err("backup_failed".to_owned());
    }
    let text = std::str::from_utf8(raw_path).map_err(|_| "backup_failed".to_owned())?;
    if text.is_empty()
        || text.contains(':')
        || text.starts_with('/')
        || text.starts_with('\\')
    {
        return Err("backup_failed".to_owned());
    }
    let mut segments = Vec::new();
    let mut display_segments = Vec::new();
    for raw_part in text.split(['/', '\\']) {
        if raw_part.is_empty() || matches!(raw_part, "." | "..") {
            return Err("backup_failed".to_owned());
        }
        let component_path = Path::new(raw_part);
        if component_path.is_absolute()
            || !matches!(
                component_path.components().next(),
                Some(Component::Normal(_))
            )
        {
            return Err("backup_failed".to_owned());
        }
        segments.push(OsString::from(raw_part));
        display_segments.push(raw_part.to_owned());
    }
    if segments.is_empty() {
        return Err("backup_failed".to_owned());
    }
    Ok((segments, display_segments.join("/")))
}

fn run_git_command(
    checkout_path: &Path,
    args: &[&str],
    spawn_failure_code: &str,
) -> Result<Output, String> {
    let mut command = Command::new("git");
    command.current_dir(checkout_path);
    command.args(args);
    for env_key in SANITIZED_GIT_ENV_VARS {
        command.env_remove(env_key);
    }
    if let Some(parent) = checkout_path.parent() {
        command.env("GIT_CEILING_DIRECTORIES", parent);
    }
    crate::platform::hide_console(&mut command);
    command.output().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            crate::log_verbose("[project_catalog_runtime::run_git_command] branch=git_unavailable");
            "git_unavailable".to_owned()
        } else {
            crate::log_verbose(
                "[project_catalog_runtime::run_git_command] branch=git_spawn_failed",
            );
            spawn_failure_code.to_owned()
        }
    })
}

fn current_utc_timestamps() -> (String, String) {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let hour = rem / 3600;
    let minute = (rem % 3600) / 60;
    let second = rem % 60;

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };

    let compact = format!("{year:04}{month:02}{day:02}-{hour:02}{minute:02}{second:02}");
    let iso = format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z");
    (compact, iso)
}
