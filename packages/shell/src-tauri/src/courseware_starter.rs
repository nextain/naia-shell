use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const ALLOWED_COURSEWARE_APP_IDS: &[&str] = &[
    "land.naia.blackjack",
    "land.naia.nts-edu-helper",
];
const MAX_STARTER_FILES: usize = 32;
const MAX_STARTER_FILE_BYTES: usize = 512 * 1024;
const MAX_RELATIVE_PATH_CHARS: usize = 240;
const MAX_RELATIVE_DEPTH: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StarterFileEntry {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CoursewareProjectInfo {
    pub project_dir: String,
    pub project_slug: String,
    pub written_files: Vec<String>,
    pub skipped_files: Vec<String>,
}

fn validate_app_id(app_id: &str) -> Result<(), String> {
    let trimmed = app_id.trim();
    if ALLOWED_COURSEWARE_APP_IDS.contains(&trimmed) {
        Ok(())
    } else {
        Err("Unsupported courseware app identifier.".to_owned())
    }
}

fn validate_project_slug(slug: &str) -> Result<(), String> {
    let bytes = slug.as_bytes();
    if bytes.len() < 2 || bytes.len() > 63 {
        return Err("Project slug must be 2..63 lowercase alphanumeric, hyphen, or underscore characters.".to_owned());
    }
    let first = bytes[0];
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return Err("Project slug must start with a lowercase ASCII letter or digit.".to_owned());
    }
    if !bytes[1..]
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-' || *b == b'_')
    {
        return Err("Project slug contains invalid characters.".to_owned());
    }
    Ok(())
}

fn validate_relative_path(raw: &str) -> Result<(String, Vec<String>), String> {
    if raw.is_empty() || raw.len() > MAX_RELATIVE_PATH_CHARS {
        return Err("Starter file path must be between 1 and 240 characters.".to_owned());
    }
    if raw.contains('\0')
        || raw.starts_with('/')
        || raw.ends_with('/')
        || raw.contains('\\')
        || raw.contains(':')
    {
        return Err(format!("Unsafe starter file path rejected: {raw}"));
    }
    let mut segments = Vec::new();
    for part in raw.split('/') {
        if part.is_empty() || part == "." || part == ".." || part == ".git" {
            return Err(format!("Unsafe starter file path segment rejected: {raw}"));
        }
        if part.chars().any(char::is_control) {
            return Err(format!("Control characters are not allowed in file path: {raw}"));
        }
        segments.push(part.to_owned());
    }
    if segments.is_empty() || segments.len() > MAX_RELATIVE_DEPTH {
        return Err(format!("Starter file path exceeds depth limit: {raw}"));
    }
    let normalized = segments.join("/");
    Ok((normalized, segments))
}

fn canonical_adk_root(adk_path: &str) -> Result<PathBuf, String> {
    let trimmed = adk_path.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err("A valid ADK workspace directory is required.".to_owned());
    }
    let raw_path = PathBuf::from(trimmed);
    let meta = fs::symlink_metadata(&raw_path)
        .map_err(|_| "The configured ADK directory could not be opened.".to_owned())?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err("The configured ADK path must be a real directory.".to_owned());
    }
    let canonical = dunce::canonicalize(&raw_path)
        .map_err(|_| "The configured ADK directory could not be canonicalized.".to_owned())?;
    if !canonical.is_dir() {
        return Err("The configured ADK directory could not be opened.".to_owned());
    }
    Ok(canonical)
}

fn ensure_projects_parent(canonical_adk: &Path, create_if_missing: bool) -> Result<PathBuf, String> {
    let projects_dir = canonical_adk.join("projects");
    match fs::symlink_metadata(&projects_dir) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return Err("The ADK projects path is not a real directory.".to_owned());
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            if !create_if_missing {
                return Err("The courseware project directory does not exist yet.".to_owned());
            }
            fs::create_dir_all(&projects_dir)
                .map_err(|e| format!("Failed to create ADK projects directory: {e}"))?;
        }
        Err(err) => {
            return Err(format!("Failed to inspect ADK projects directory: {err}"));
        }
    }
    let canonical_projects = dunce::canonicalize(&projects_dir)
        .map_err(|_| "Failed to canonicalize ADK projects directory.".to_owned())?;
    if canonical_projects.parent() != Some(canonical_adk) {
        return Err("The ADK projects directory escaped its workspace root.".to_owned());
    }
    Ok(canonical_projects)
}

fn ensure_project_dir(
    canonical_projects: &Path,
    project_slug: &str,
    create_if_missing: bool,
) -> Result<PathBuf, String> {
    let project_dir = canonical_projects.join(project_slug);
    match fs::symlink_metadata(&project_dir) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return Err("Target courseware project path is not a safe directory.".to_owned());
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            if !create_if_missing {
                return Err("Target courseware project has not been provisioned yet.".to_owned());
            }
            fs::create_dir(&project_dir)
                .map_err(|e| format!("Failed to create courseware project directory: {e}"))?;
        }
        Err(err) => {
            return Err(format!("Failed to inspect courseware project directory: {err}"));
        }
    }
    let canonical_project = dunce::canonicalize(&project_dir)
        .map_err(|_| "Failed to canonicalize courseware project directory.".to_owned())?;
    if canonical_project.parent() != Some(canonical_projects) {
        return Err("Target courseware project directory escaped the ADK projects root.".to_owned());
    }
    Ok(canonical_project)
}

fn write_project_files_inner(
    adk_path: &str,
    project_slug: &str,
    files: &[StarterFileEntry],
    overwrite: bool,
    init_git_repo: bool,
) -> Result<CoursewareProjectInfo, String> {
    validate_project_slug(project_slug)?;
    if files.is_empty() || files.len() > MAX_STARTER_FILES {
        return Err(format!(
            "Starter file batch must contain between 1 and {MAX_STARTER_FILES} files."
        ));
    }

    let mut seen = HashSet::with_capacity(files.len());
    let mut validated = Vec::with_capacity(files.len());
    for entry in files {
        if entry.content.len() > MAX_STARTER_FILE_BYTES {
            return Err(format!(
                "Starter file '{}' exceeds the 512 KiB size limit.",
                entry.path
            ));
        }
        let (normalized, segments) = validate_relative_path(&entry.path)?;
        if !seen.insert(normalized.clone()) {
            return Err(format!("Duplicate starter file path: {normalized}"));
        }
        validated.push((normalized, segments, entry.content.as_bytes()));
    }

    let canonical_adk = canonical_adk_root(adk_path)?;
    let canonical_projects = ensure_projects_parent(&canonical_adk, true)?;
    let canonical_project = ensure_project_dir(&canonical_projects, project_slug, true)?;

    let mut written_files = Vec::new();
    let mut skipped_files = Vec::new();

    for (normalized, segments, bytes) in validated {
        let mut cursor = canonical_project.clone();
        for dir_segment in &segments[..segments.len() - 1] {
            cursor = cursor.join(dir_segment);
            match fs::symlink_metadata(&cursor) {
                Ok(meta) => {
                    if meta.file_type().is_symlink() || !meta.is_dir() {
                        return Err(format!(
                            "Unsafe intermediate path in courseware project: {normalized}"
                        ));
                    }
                }
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                    fs::create_dir(&cursor)
                        .map_err(|e| format!("Failed to create subdirectory for {normalized}: {e}"))?;
                }
                Err(err) => {
                    return Err(format!("Failed to inspect subdirectory for {normalized}: {err}"));
                }
            }
            let canonical_cursor = dunce::canonicalize(&cursor)
                .map_err(|_| format!("Failed to verify subdirectory for {normalized}"))?;
            if !canonical_cursor.starts_with(&canonical_project) {
                return Err(format!(
                    "Subdirectory escaped courseware project root: {normalized}"
                ));
            }
        }

        let file_name = &segments[segments.len() - 1];
        let target = cursor.join(file_name);
        match fs::symlink_metadata(&target) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(format!("Symlink target is not allowed: {normalized}"));
                }
                if meta.file_type().is_dir() {
                    return Err(format!("Cannot write file over directory: {normalized}"));
                }
                if !overwrite {
                    skipped_files.push(normalized);
                    continue;
                }
                let canonical_target = dunce::canonicalize(&target)
                    .map_err(|_| format!("Failed to verify target file: {normalized}"))?;
                if !canonical_target.starts_with(&canonical_project) {
                    return Err(format!(
                        "Target file escaped courseware project root: {normalized}"
                    ));
                }
                fs::write(&canonical_target, bytes)
                    .map_err(|e| format!("Failed to update starter file {normalized}: {e}"))?;
                written_files.push(normalized);
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                fs::write(&target, bytes)
                    .map_err(|e| format!("Failed to write starter file {normalized}: {e}"))?;
                written_files.push(normalized);
            }
            Err(err) => {
                return Err(format!("Failed to inspect target file {normalized}: {err}"));
            }
        }
    }

    if init_git_repo {
        let git_dir = canonical_project.join(".git");
        if fs::symlink_metadata(&git_dir).is_err() {
            let _ = Command::new("git")
                .args(["init", "-q"])
                .current_dir(&canonical_project)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }

    Ok(CoursewareProjectInfo {
        project_dir: canonical_project.to_string_lossy().into_owned(),
        project_slug: project_slug.to_owned(),
        written_files,
        skipped_files,
    })
}

fn read_project_files_inner(
    adk_path: &str,
    project_slug: &str,
    paths: &[String],
) -> Result<Vec<StarterFileEntry>, String> {
    validate_project_slug(project_slug)?;
    if paths.is_empty() || paths.len() > MAX_STARTER_FILES {
        return Err(format!(
            "Read request must specify between 1 and {MAX_STARTER_FILES} relative paths."
        ));
    }

    let mut seen = HashSet::with_capacity(paths.len());
    let mut validated = Vec::with_capacity(paths.len());
    for raw_path in paths {
        let (normalized, segments) = validate_relative_path(raw_path)?;
        if !seen.insert(normalized.clone()) {
            return Err(format!("Duplicate file path in read request: {normalized}"));
        }
        validated.push((normalized, segments));
    }

    let canonical_adk = canonical_adk_root(adk_path)?;
    let canonical_projects = ensure_projects_parent(&canonical_adk, false)?;
    let canonical_project = ensure_project_dir(&canonical_projects, project_slug, false)?;

    let mut out = Vec::with_capacity(validated.len());
    for (normalized, segments) in validated {
        let mut cursor = canonical_project.clone();
        for dir_segment in &segments[..segments.len() - 1] {
            cursor = cursor.join(dir_segment);
            let meta = fs::symlink_metadata(&cursor)
                .map_err(|_| format!("File not found in courseware project: {normalized}"))?;
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return Err(format!("Unsafe directory in courseware project: {normalized}"));
            }
        }
        let target = cursor.join(&segments[segments.len() - 1]);
        let meta = fs::symlink_metadata(&target)
            .map_err(|_| format!("File not found in courseware project: {normalized}"))?;
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err(format!("Target path is not a regular file: {normalized}"));
        }
        if meta.len() > MAX_STARTER_FILE_BYTES as u64 {
            return Err(format!(
                "Project file '{normalized}' exceeds the 512 KiB read limit."
            ));
        }
        let canonical_target = dunce::canonicalize(&target)
            .map_err(|_| format!("Failed to canonicalize project file: {normalized}"))?;
        if !canonical_target.starts_with(&canonical_project) {
            return Err(format!(
                "Project file escaped courseware project root: {normalized}"
            ));
        }
        let content = fs::read_to_string(&canonical_target)
            .map_err(|e| format!("Failed to read UTF-8 text from {normalized}: {e}"))?;
        out.push(StarterFileEntry {
            path: normalized,
            content,
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn courseware_provision_starter(
    adk_path: String,
    app_id: String,
    project_slug: String,
    files: Vec<StarterFileEntry>,
    overwrite: bool,
) -> Result<CoursewareProjectInfo, String> {
    crate::log_verbose(&format!(
        "[courseware_starter::courseware_provision_starter] enter app_id={app_id} slug={project_slug} file_count={} overwrite={overwrite}",
        files.len()
    ));
    validate_app_id(&app_id)?;
    let result = tokio::task::spawn_blocking(move || {
        write_project_files_inner(&adk_path, &project_slug, &files, overwrite, true)
    })
    .await
    .map_err(|e| format!("Courseware provision worker failed: {e}"))??;
    crate::log_verbose(&format!(
        "[courseware_starter::courseware_provision_starter] branch=ok written={} skipped={}",
        result.written_files.len(),
        result.skipped_files.len()
    ));
    Ok(result)
}

#[tauri::command]
pub async fn courseware_sync_files(
    adk_path: String,
    project_slug: String,
    files: Vec<StarterFileEntry>,
) -> Result<CoursewareProjectInfo, String> {
    crate::log_verbose(&format!(
        "[courseware_starter::courseware_sync_files] enter slug={project_slug} file_count={}",
        files.len()
    ));
    let result = tokio::task::spawn_blocking(move || {
        write_project_files_inner(&adk_path, &project_slug, &files, true, false)
    })
    .await
    .map_err(|e| format!("Courseware sync worker failed: {e}"))??;
    crate::log_verbose(&format!(
        "[courseware_starter::courseware_sync_files] branch=ok written={}",
        result.written_files.len()
    ));
    Ok(result)
}

#[tauri::command]
pub async fn courseware_read_files(
    adk_path: String,
    project_slug: String,
    paths: Vec<String>,
) -> Result<Vec<StarterFileEntry>, String> {
    crate::log_verbose(&format!(
        "[courseware_starter::courseware_read_files] enter slug={project_slug} path_count={}",
        paths.len()
    ));
    let entries = tokio::task::spawn_blocking(move || {
        read_project_files_inner(&adk_path, &project_slug, &paths)
    })
    .await
    .map_err(|e| format!("Courseware read worker failed: {e}"))??;
    crate::log_verbose(&format!(
        "[courseware_starter::courseware_read_files] branch=ok read={}",
        entries.len()
    ));
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, content: &str) -> StarterFileEntry {
        StarterFileEntry {
            path: path.to_owned(),
            content: content.to_owned(),
        }
    }

    #[tokio::test]
    async fn rejects_disallowed_app_id_and_invalid_project_slugs() {
        let temp = tempfile::tempdir().expect("temp adk");
        let adk = temp.path().to_string_lossy().into_owned();
        let files = vec![entry("README.md", "# Test\n")];

        let bad_app = courseware_provision_starter(
            adk.clone(),
            "land.naia.unknown".to_owned(),
            "blackjack-lab".to_owned(),
            files.clone(),
            false,
        )
        .await;
        assert!(bad_app.is_err());

        for bad_slug in [
            "a",
            "_hidden",
            "-dash",
            "UpperCase",
            "../escape",
            "nested/slug",
            &"a".repeat(64),
        ] {
            let res = courseware_provision_starter(
                adk.clone(),
                "land.naia.blackjack".to_owned(),
                bad_slug.to_owned(),
                files.clone(),
                false,
            )
            .await;
            assert!(res.is_err(), "expected invalid slug '{bad_slug}' to fail");
        }
    }

    #[tokio::test]
    async fn rejects_path_traversal_absolute_backslash_and_git_paths() {
        let temp = tempfile::tempdir().expect("temp adk");
        let adk = temp.path().to_string_lossy().into_owned();

        for unsafe_path in [
            "../outside.js",
            "sub/../../outside.js",
            "/etc/passwd",
            "sub\\win.js",
            "C:drive.js",
            ".git/config",
            "sub/.git/hooks/pre-commit",
            "./current.js",
        ] {
            let res = courseware_provision_starter(
                adk.clone(),
                "land.naia.blackjack".to_owned(),
                "blackjack-studio".to_owned(),
                vec![entry(unsafe_path, "bad")],
                true,
            )
            .await;
            assert!(res.is_err(), "expected unsafe path '{unsafe_path}' to fail");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_symlink_targets_on_write_and_read() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("temp adk");
        let adk_root = dunce::canonicalize(temp.path()).expect("canonical adk");
        let outside = tempfile::tempdir().expect("outside dir");
        let secret_file = outside.path().join("secret.txt");
        fs::write(&secret_file, "do-not-touch").expect("write outside");

        let info = courseware_provision_starter(
            adk_root.to_string_lossy().into_owned(),
            "land.naia.blackjack".to_owned(),
            "blackjack-studio".to_owned(),
            vec![entry("README.md", "# Starter\n")],
            false,
        )
        .await
        .expect("initial provision");

        let link_path = PathBuf::from(&info.project_dir).join("blackjack-rules.js");
        symlink(&secret_file, &link_path).expect("create file symlink");

        let write_attempt = courseware_sync_files(
            adk_root.to_string_lossy().into_owned(),
            "blackjack-studio".to_owned(),
            vec![entry("blackjack-rules.js", "overwritten")],
        )
        .await;
        assert!(write_attempt.is_err());
        assert_eq!(
            fs::read_to_string(&secret_file).expect("secret intact"),
            "do-not-touch"
        );

        let read_attempt = courseware_read_files(
            adk_root.to_string_lossy().into_owned(),
            "blackjack-studio".to_owned(),
            vec!["blackjack-rules.js".to_owned()],
        )
        .await;
        assert!(read_attempt.is_err());
    }

    #[tokio::test]
    async fn non_overwrite_preserves_learner_edits_and_overwrite_updates_them() {
        let temp = tempfile::tempdir().expect("temp adk");
        let adk = temp.path().to_string_lossy().into_owned();

        let first = courseware_provision_starter(
            adk.clone(),
            "land.naia.blackjack".to_owned(),
            "naia-blackjack-lab".to_owned(),
            vec![
                entry("blackjack-rules.js", "// starter v1\n"),
                entry("docs/mission.md", "Step 1\n"),
            ],
            false,
        )
        .await
        .expect("first provision");

        assert_eq!(
            first.written_files,
            vec!["blackjack-rules.js".to_owned(), "docs/mission.md".to_owned()]
        );
        assert!(first.skipped_files.is_empty());

        // Simulate learner editing blackjack-rules.js with OpenCode in terminal
        let rules_on_disk = PathBuf::from(&first.project_dir).join("blackjack-rules.js");
        fs::write(&rules_on_disk, "// edited by learner in OpenCode\n").expect("learner edit");

        // Re-provisioning with overwrite=false preserves existing files and writes new ones
        let second = courseware_provision_starter(
            adk.clone(),
            "land.naia.blackjack".to_owned(),
            "naia-blackjack-lab".to_owned(),
            vec![
                entry("blackjack-rules.js", "// starter v2\n"),
                entry("AGENTS.md", "# Socratic Tutor\n"),
            ],
            false,
        )
        .await
        .expect("second non-overwrite provision");

        assert_eq!(second.written_files, vec!["AGENTS.md".to_owned()]);
        assert_eq!(second.skipped_files, vec!["blackjack-rules.js".to_owned()]);

        let read_back = courseware_read_files(
            adk.clone(),
            "naia-blackjack-lab".to_owned(),
            vec!["blackjack-rules.js".to_owned(), "AGENTS.md".to_owned()],
        )
        .await
        .expect("read back");
        assert_eq!(read_back[0].content, "// edited by learner in OpenCode\n");
        assert_eq!(read_back[1].content, "# Socratic Tutor\n");

        // Provisioning with overwrite=true updates existing files
        let third = courseware_provision_starter(
            adk.clone(),
            "land.naia.nts-edu-helper".to_owned(),
            "naia-blackjack-lab".to_owned(),
            vec![entry("blackjack-rules.js", "// reset starter v3\n")],
            true,
        )
        .await
        .expect("third overwrite provision");
        assert_eq!(third.written_files, vec!["blackjack-rules.js".to_owned()]);
        assert!(third.skipped_files.is_empty());

        let after_overwrite = courseware_read_files(
            adk,
            "naia-blackjack-lab".to_owned(),
            vec!["blackjack-rules.js".to_owned()],
        )
        .await
        .expect("read after overwrite");
        assert_eq!(after_overwrite[0].content, "// reset starter v3\n");
    }

    #[tokio::test]
    async fn sync_files_and_limits_enforce_size_and_file_count() {
        let temp = tempfile::tempdir().expect("temp adk");
        let adk = temp.path().to_string_lossy().into_owned();

        let synced = courseware_sync_files(
            adk.clone(),
            "nts-ax-workbook".to_owned(),
            vec![entry("04-wireframe.html", "<!doctype html><title>AX</title>")],
        )
        .await
        .expect("sync files");
        assert_eq!(synced.project_slug, "nts-ax-workbook");
        assert_eq!(synced.written_files, vec!["04-wireframe.html".to_owned()]);

        let oversized = "x".repeat(MAX_STARTER_FILE_BYTES + 1);
        let too_big = courseware_sync_files(
            adk.clone(),
            "nts-ax-workbook".to_owned(),
            vec![entry("huge.txt", &oversized)],
        )
        .await;
        assert!(too_big.is_err());

        let too_many: Vec<StarterFileEntry> = (0..33)
            .map(|i| entry(&format!("f{i}.md"), "ok"))
            .collect();
        let batch_err =
            courseware_sync_files(adk, "nts-ax-workbook".to_owned(), too_many).await;
        assert!(batch_err.is_err());
    }
}
