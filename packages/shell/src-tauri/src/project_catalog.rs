use serde::Serialize;
use serde_yaml::Value as YamlValue;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_SCAN_ENTRIES: usize = 200;
const MAX_DISPLAY_ROWS: usize = 200;
const MAX_CONFIG_FILE_BYTES: usize = 64 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCatalog {
    projects: Vec<CatalogProject>,
    catalog_errors: Vec<CatalogIssue>,
    truncation: CatalogTruncation,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogTruncation {
    max_entries: usize,
    scanned_entries: usize,
    more_entries_available: bool,
    max_rows: usize,
    shown_rows: usize,
    more_rows_available: bool,
    max_config_file_bytes: usize,
    oversized_files: Vec<OversizedConfigFile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OversizedConfigFile {
    file: String,
    observed_bytes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogProject {
    project_id: String,
    name: String,
    repository: Option<String>,
    issue_tracker: Option<String>,
    project_path: String,
    source_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogIssue {
    path: String,
    reason: &'static str,
}

#[derive(Default)]
struct ScanState {
    scanned_entries: usize,
    shown_rows: usize,
    more_entries_available: bool,
    more_rows_available: bool,
}

#[tauri::command]
pub fn projects_scan_adk(adk_path: String) -> Result<ProjectCatalog, String> {
    let adk_root = dunce::canonicalize(PathBuf::from(adk_path))
        .map_err(|_| "The configured naia-adk folder could not be opened.".to_owned())?;
    if !adk_root.is_dir() {
        return Err("The configured naia-adk folder could not be opened.".to_owned());
    }

    let projects_root = adk_root.join("projects");
    let projects_metadata = fs::symlink_metadata(&projects_root).map_err(|_| {
        "The configured naia-adk folder does not contain a readable projects folder.".to_owned()
    })?;
    if projects_metadata.file_type().is_symlink() || !projects_metadata.is_dir() {
        return Err("The configured naia-adk projects folder is not a safe directory.".to_owned());
    }
    let canonical_projects_root = dunce::canonicalize(&projects_root)
        .map_err(|_| "The configured naia-adk projects folder could not be opened.".to_owned())?;
    if canonical_projects_root.parent() != Some(adk_root.as_path()) {
        return Err("The configured naia-adk projects folder is outside its root.".to_owned());
    }

    let workspace_adk_paths = read_workspace_adk_paths(&adk_root)?;

    let mut state = ScanState::default();
    let mut projects = Vec::new();
    let mut catalog_errors = Vec::new();
    let mut oversized_files = Vec::new();
    let top_level = read_directory_entries(
        &canonical_projects_root,
        &adk_root,
        &mut state,
        &mut catalog_errors,
    )
    .map_err(|_| "The configured naia-adk projects folder could not be read.".to_owned())?;

    let mut candidates = Vec::new();
    for entry in top_level {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('_') {
            continue;
        }
        let first_level = vec![name.clone()];
        let has_second_level = workspace_adk_paths
            .iter()
            .any(|path| path.len() == 2 && path[0] == name);
        if !workspace_adk_paths.contains(&first_level) && !has_second_level {
            continue;
        }
        if let Some(candidate) = checked_directory(
            &entry,
            &canonical_projects_root,
            &adk_root,
            &mut state,
            &mut catalog_errors,
        ) {
            if workspace_adk_paths.contains(&first_level) {
                candidates.push(candidate.clone());
            }
            if !has_second_level {
                continue;
            }
            for child in read_nested_directory_entries(
                &candidate,
                &adk_root,
                &mut state,
                &mut catalog_errors,
            ) {
                let child_name = child.file_name().to_string_lossy().into_owned();
                if child_name.starts_with('_')
                    || !workspace_adk_paths.contains(&vec![name.clone(), child_name])
                {
                    continue;
                }
                if let Some(nested) = checked_directory(
                    &child,
                    &candidate,
                    &adk_root,
                    &mut state,
                    &mut catalog_errors,
                ) {
                    candidates.push(nested);
                }
            }
        }
    }
    candidates.sort_by_key(|path| (!candidate_has_projects(path), path.clone()));
    candidates.dedup();

    for candidate in candidates {
        if state.scanned_entries >= MAX_SCAN_ENTRIES {
            state.more_entries_available = true;
            break;
        }
        scan_candidate(
            &candidate,
            &adk_root,
            &mut state,
            &mut projects,
            &mut catalog_errors,
            &mut oversized_files,
        );
    }

    projects.sort_by(|left, right| {
        left.project_id
            .cmp(&right.project_id)
            .then_with(|| left.source_path.cmp(&right.source_path))
    });
    catalog_errors.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| left.reason.cmp(right.reason))
    });

    Ok(ProjectCatalog {
        projects,
        catalog_errors,
        truncation: CatalogTruncation {
            max_entries: MAX_SCAN_ENTRIES,
            scanned_entries: state.scanned_entries,
            more_entries_available: state.more_entries_available,
            max_rows: MAX_DISPLAY_ROWS,
            shown_rows: state.shown_rows,
            more_rows_available: state.more_rows_available,
            max_config_file_bytes: MAX_CONFIG_FILE_BYTES,
            oversized_files,
        },
    })
}

fn candidate_has_projects(candidate: &Path) -> bool {
    fs::symlink_metadata(candidate.join("projects"))
        .map(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        .unwrap_or(false)
}

fn read_workspace_adk_paths(root: &Path) -> Result<Vec<Vec<String>>, String> {
    let agents = root.join(".agents");
    let agents_metadata = fs::symlink_metadata(&agents)
        .map_err(|_| "The configured naia-adk project index could not be opened.".to_owned())?;
    if agents_metadata.file_type().is_symlink() || !agents_metadata.is_dir() {
        return Err("The configured naia-adk project index is not a safe directory.".to_owned());
    }
    let canonical_agents = dunce::canonicalize(&agents)
        .map_err(|_| "The configured naia-adk project index could not be opened.".to_owned())?;
    if canonical_agents.parent() != Some(root) {
        return Err("The configured naia-adk project index is outside its root.".to_owned());
    }

    let context = agents.join("context");
    let context_metadata = fs::symlink_metadata(&context)
        .map_err(|_| "The configured naia-adk project index could not be opened.".to_owned())?;
    if context_metadata.file_type().is_symlink() || !context_metadata.is_dir() {
        return Err("The configured naia-adk project index is not a safe directory.".to_owned());
    }
    let canonical_context = dunce::canonicalize(&context)
        .map_err(|_| "The configured naia-adk project index could not be opened.".to_owned())?;
    if canonical_context.parent() != Some(&canonical_agents) {
        return Err("The configured naia-adk project index is outside its root.".to_owned());
    }

    let index_file = canonical_context.join("project-index.yaml");
    let yaml_text = read_confined(root, &canonical_context, &index_file)
        .map_err(|_| "The configured naia-adk project index could not be read.".to_owned())?;
    let yaml: YamlValue = serde_yaml::from_str(&yaml_text)
        .map_err(|_| "The configured naia-adk project index is invalid.".to_owned())?;
    let submodules = yaml
        .as_mapping()
        .and_then(|mapping| mapping.get(&YamlValue::String("submodules".to_owned())))
        .and_then(YamlValue::as_mapping)
        .ok_or_else(|| "The configured naia-adk project index has no submodules.".to_owned())?;

    let mut paths = Vec::new();
    for record in submodules.values().filter_map(YamlValue::as_mapping) {
        if value_string(record, &["type"]).as_deref() != Some("workspace_adk") {
            continue;
        }
        let Some(path) =
            value_string(record, &["path"]).and_then(|path| workspace_adk_path_components(&path))
        else {
            continue;
        };
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    paths.sort();
    Ok(paths)
}

fn workspace_adk_path_components(path: &str) -> Option<Vec<String>> {
    let relative = path.strip_prefix("./").unwrap_or(path);
    if relative.contains('\\') || relative.starts_with('/') {
        return None;
    }
    let components = relative.split('/').collect::<Vec<_>>();
    if !(components.len() == 2 || components.len() == 3)
        || components[0] != "projects"
        || components
            .iter()
            .any(|part| part.is_empty() || *part == "." || *part == ".." || part.starts_with('_'))
    {
        return None;
    }
    Some(
        components[1..]
            .iter()
            .map(|part| (*part).to_owned())
            .collect(),
    )
}

fn read_directory_entries(
    directory: &Path,
    root: &Path,
    state: &mut ScanState,
    errors: &mut Vec<CatalogIssue>,
) -> Result<Vec<fs::DirEntry>, ()> {
    let relative = relative_path(root, directory);
    let entries = fs::read_dir(directory).map_err(|_| ())?;
    let mut collected = Vec::new();
    for result in entries {
        if state.scanned_entries >= MAX_SCAN_ENTRIES {
            state.more_entries_available = true;
            break;
        }
        state.scanned_entries += 1;
        match result {
            Ok(entry) => collected.push(entry),
            Err(_) => push_issue(state, errors, relative.clone(), "entry_unreadable"),
        }
    }
    collected.sort_by_key(|entry| entry.file_name());
    Ok(collected)
}

fn read_nested_directory_entries(
    directory: &Path,
    root: &Path,
    state: &mut ScanState,
    errors: &mut Vec<CatalogIssue>,
) -> Vec<fs::DirEntry> {
    match read_directory_entries(directory, root, state, errors) {
        Ok(entries) => entries,
        Err(()) => {
            push_issue(
                state,
                errors,
                relative_path(root, directory),
                "directory_unreadable",
            );
            Vec::new()
        }
    }
}

fn checked_directory(
    entry: &fs::DirEntry,
    expected_parent: &Path,
    root: &Path,
    state: &mut ScanState,
    errors: &mut Vec<CatalogIssue>,
) -> Option<PathBuf> {
    let path = entry.path();
    let relative = relative_path(root, &path);
    let file_type = match entry.file_type() {
        Ok(file_type) => file_type,
        Err(_) => {
            push_issue(state, errors, relative, "entry_unreadable");
            return None;
        }
    };
    if file_type.is_symlink() {
        push_issue(state, errors, relative, "unsafe_path");
        return None;
    }
    if !file_type.is_dir() {
        return None;
    }
    let canonical = match dunce::canonicalize(path) {
        Ok(canonical) => canonical,
        Err(_) => {
            push_issue(state, errors, relative, "directory_unreadable");
            return None;
        }
    };
    if canonical.parent() != Some(expected_parent) || !canonical.starts_with(root) {
        push_issue(state, errors, relative, "unsafe_path");
        return None;
    }
    Some(canonical)
}

fn scan_candidate(
    candidate: &Path,
    root: &Path,
    state: &mut ScanState,
    projects: &mut Vec<CatalogProject>,
    errors: &mut Vec<CatalogIssue>,
    oversized_files: &mut Vec<OversizedConfigFile>,
) {
    let candidate_projects = candidate.join("projects");
    let relative = relative_path(root, &candidate_projects);
    let metadata = match fs::symlink_metadata(&candidate_projects) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(_) => {
            push_issue(state, errors, relative, "directory_unreadable");
            return;
        }
    };
    if metadata.file_type().is_symlink() {
        push_issue(state, errors, relative, "unsafe_path");
        return;
    }
    if !metadata.is_dir() {
        return;
    }
    let canonical_projects = match dunce::canonicalize(&candidate_projects) {
        Ok(path) => path,
        Err(_) => {
            push_issue(state, errors, relative, "directory_unreadable");
            return;
        }
    };
    if canonical_projects.parent() != Some(candidate) || !canonical_projects.starts_with(root) {
        push_issue(state, errors, relative, "unsafe_path");
        return;
    }

    for entry in read_nested_directory_entries(&canonical_projects, root, state, errors) {
        let directory_name = entry.file_name().to_string_lossy().into_owned();
        if directory_name.starts_with('_') {
            continue;
        }
        let Some(project_dir) = checked_directory(&entry, &canonical_projects, root, state, errors)
        else {
            continue;
        };
        let project_file = project_dir.join("project.yaml");
        let project_relative = relative_path(root, &project_file);
        match read_project(root, &project_dir, &project_file) {
            Ok(project) => push_project(state, projects, project),
            Err(ProjectReadError::Issue(reason)) => {
                push_issue(state, errors, project_relative, reason);
            }
            Err(ProjectReadError::Oversized { observed_bytes }) => {
                oversized_files.push(OversizedConfigFile {
                    file: project_relative.clone(),
                    observed_bytes,
                });
                push_issue(state, errors, project_relative, "file_too_large");
            }
        }
    }
}

fn read_project(
    root: &Path,
    project_dir: &Path,
    project_file: &Path,
) -> Result<CatalogProject, ProjectReadError> {
    let yaml = read_yaml(root, project_dir, project_file)?;
    let Some(mapping) = yaml.as_mapping() else {
        return Err(ProjectReadError::Issue("invalid_yaml"));
    };
    let Some(project_mapping) = mapping
        .get(&YamlValue::String("project".to_owned()))
        .and_then(YamlValue::as_mapping)
    else {
        return Err(ProjectReadError::Issue("missing_project_id"));
    };
    let Some(project_id) = value_string(project_mapping, &["id"]) else {
        return Err(ProjectReadError::Issue("missing_project_id"));
    };

    let canonical_project = dunce::canonicalize(project_dir)
        .map_err(|_| ProjectReadError::Issue("directory_unreadable"))?;
    if !canonical_project.starts_with(root) {
        return Err(ProjectReadError::Issue("unsafe_path"));
    }
    Ok(CatalogProject {
        project_id: project_id.clone(),
        name: value_string(project_mapping, &["name", "display_name", "title"])
            .unwrap_or(project_id),
        repository: value_string(project_mapping, &["repository"]),
        issue_tracker: value_string(project_mapping, &["issue_tracker"]),
        project_path: path_string(&canonical_project),
        source_path: relative_path(root, &canonical_project),
    })
}

fn push_project(
    state: &mut ScanState,
    projects: &mut Vec<CatalogProject>,
    project: CatalogProject,
) {
    if state.shown_rows >= MAX_DISPLAY_ROWS {
        state.more_rows_available = true;
        return;
    }
    projects.push(project);
    state.shown_rows += 1;
}

fn push_issue(
    state: &mut ScanState,
    errors: &mut Vec<CatalogIssue>,
    path: String,
    reason: &'static str,
) {
    if state.shown_rows >= MAX_DISPLAY_ROWS {
        state.more_rows_available = true;
        return;
    }
    errors.push(CatalogIssue { path, reason });
    state.shown_rows += 1;
}

fn value_string(mapping: &serde_yaml::Mapping, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        mapping
            .get(&YamlValue::String((*key).to_owned()))
            .and_then(YamlValue::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    })
}

enum ProjectReadError {
    Issue(&'static str),
    Oversized { observed_bytes: usize },
}

fn read_yaml(root: &Path, project_dir: &Path, path: &Path) -> Result<YamlValue, ProjectReadError> {
    let text = read_confined(root, project_dir, path)?;
    serde_yaml::from_str(&text).map_err(|_| ProjectReadError::Issue("invalid_yaml"))
}

fn read_confined(root: &Path, project_dir: &Path, path: &Path) -> Result<String, ProjectReadError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        ProjectReadError::Issue(if error.kind() == std::io::ErrorKind::NotFound {
            "missing"
        } else {
            "file_unreadable"
        })
    })?;
    if metadata.file_type().is_symlink() {
        return Err(ProjectReadError::Issue("unsafe_path"));
    }
    if !metadata.is_file() {
        return Err(ProjectReadError::Issue("file_unreadable"));
    }
    let canonical =
        dunce::canonicalize(path).map_err(|_| ProjectReadError::Issue("file_unreadable"))?;
    if canonical.parent() != Some(project_dir) || !canonical.starts_with(root) {
        return Err(ProjectReadError::Issue("unsafe_path"));
    }
    let observed_bytes = fs::metadata(&canonical)
        .map_err(|_| ProjectReadError::Issue("file_unreadable"))?
        .len() as usize;
    if observed_bytes > MAX_CONFIG_FILE_BYTES {
        return Err(ProjectReadError::Oversized { observed_bytes });
    }
    let file = fs::File::open(canonical).map_err(|_| ProjectReadError::Issue("file_unreadable"))?;
    let mut bytes = Vec::with_capacity(observed_bytes.min(MAX_CONFIG_FILE_BYTES));
    file.take((MAX_CONFIG_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| ProjectReadError::Issue("file_unreadable"))?;
    if bytes.len() > MAX_CONFIG_FILE_BYTES {
        return Err(ProjectReadError::Oversized {
            observed_bytes: bytes.len(),
        });
    }
    String::from_utf8(bytes).map_err(|_| ProjectReadError::Issue("file_unreadable"))
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn adk() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().expect("temporary naia-adk");
        let root = temp.path().to_path_buf();
        fs::create_dir_all(root.join("projects")).unwrap();
        write(
            &root,
            ".agents/context/project-index.yaml",
            "version: '2.0'\nsubmodules:\n  naia-pj-adk:\n    path: ./projects/naia-pj-adk\n    type: workspace_adk\n",
        );
        (temp, root)
    }

    fn write(root: &Path, relative: &str, content: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn project_yaml(id: &str) -> String {
        format!(
            "version: 1\nproject:\n  id: {id}\n  name: Example {id}\n  repository: octocat/Hello-World\n  issue_tracker: github\nroles: {{}}\ndiscord: {{}}\ncommands: {{}}\n"
        )
    }

    fn scan(root: &Path) -> ProjectCatalog {
        projects_scan_adk(root.to_string_lossy().into_owned()).unwrap()
    }

    #[test]
    fn discovers_first_and_second_level_candidate_roots_and_skips_deeper_roots() {
        let (_temp, root) = adk();
        write(
            &root,
            ".agents/context/project-index.yaml",
            "version: '2.0'\nsubmodules:\n  naia-pj-adk:\n    path: ./projects/naia-pj-adk\n    type: workspace_adk\n  grouped-adk:\n    path: ./projects/group/naia-pj-adk\n    type: workspace_adk\n",
        );
        write(
            &root,
            "projects/naia-pj-adk/projects/aipol/project.yaml",
            &project_yaml("aipol"),
        );
        write(
            &root,
            "projects/group/naia-pj-adk/projects/blackjack/project.yaml",
            &project_yaml("blackjack"),
        );
        write(
            &root,
            "projects/group/naia-pj-adk/deeper/naia-pj-adk/projects/ignored/project.yaml",
            &project_yaml("ignored"),
        );
        write(
            &root,
            "projects/naia-pj-adk/projects/_template/project.yaml",
            &project_yaml("template"),
        );

        let catalog = scan(&root);
        assert_eq!(
            catalog
                .projects
                .iter()
                .map(|project| project.project_id.as_str())
                .collect::<Vec<_>>(),
            ["aipol", "blackjack"]
        );
        assert!(catalog.projects.iter().all(|project| project
            .project_path
            .ends_with(project.source_path.trim_start_matches("projects/"))));
    }

    #[test]
    fn scans_only_roots_registered_as_workspace_adks() {
        let (_temp, root) = adk();
        write(
            &root,
            ".agents/context/project-index.yaml",
            "version: '2.0'\nsubmodules:\n  registered-workspace:\n    path: ./projects/registered-workspace\n    type: workspace_adk\n  app-repository:\n    path: ./projects/app-repository\n    type: project\n  development-hub:\n    path: ./projects/development-hub\n    type: project\n",
        );
        write(
            &root,
            "projects/registered-workspace/projects/eligible-project/project.yaml",
            &project_yaml("eligible-project"),
        );
        write(
            &root,
            "projects/app-repository/projects/example-project/project.yaml",
            &project_yaml("example-project"),
        );
        write(
            &root,
            "projects/development-hub/projects/hub-project/project.yaml",
            &project_yaml("hub-project"),
        );

        let catalog = scan(&root);
        assert_eq!(catalog.projects.len(), 1);
        assert_eq!(catalog.projects[0].project_id, "eligible-project");
        assert_eq!(
            catalog.projects[0].source_path,
            "projects/registered-workspace/projects/eligible-project"
        );
    }

    #[test]
    fn ignores_workspace_paths_outside_allowed_project_depth_or_under_templates() {
        let (_temp, root) = adk();
        write(
            &root,
            ".agents/context/project-index.yaml",
            "version: '2.0'\nsubmodules:\n  template:\n    path: ./projects/_template\n    type: workspace_adk\n  too-deep:\n    path: ./projects/group/too/deep\n    type: workspace_adk\n  outside:\n    path: ../outside\n    type: workspace_adk\n",
        );
        write(
            &root,
            "projects/_template/projects/template-project/project.yaml",
            &project_yaml("template-project"),
        );
        write(
            &root,
            "projects/group/too/deep/projects/deep-project/project.yaml",
            &project_yaml("deep-project"),
        );

        let catalog = scan(&root);
        assert!(catalog.projects.is_empty());
    }

    #[test]
    fn lists_only_projects_with_nested_id_and_reports_relative_metadata_errors() {
        let (_temp, root) = adk();
        write(
            &root,
            "projects/naia-pj-adk/projects/valid/project.yaml",
            &project_yaml("valid"),
        );
        write(
            &root,
            "projects/naia-pj-adk/projects/malformed/project.yaml",
            "id: [unterminated\n",
        );
        write(
            &root,
            "projects/naia-pj-adk/projects/missing-id/project.yaml",
            "version: 1\nproject:\n  repository: octocat/Hello-World\n",
        );
        fs::create_dir_all(root.join("projects/naia-pj-adk/projects/missing-file")).unwrap();

        let catalog = scan(&root);
        assert_eq!(catalog.projects.len(), 1);
        assert_eq!(catalog.projects[0].project_id, "valid");
        assert_eq!(
            catalog.projects[0].source_path,
            "projects/naia-pj-adk/projects/valid"
        );
        assert!(catalog.catalog_errors.iter().any(|error| {
            error.path == "projects/naia-pj-adk/projects/malformed/project.yaml"
                && error.reason == "invalid_yaml"
        }));
        assert!(catalog.catalog_errors.iter().any(|error| {
            error.path == "projects/naia-pj-adk/projects/missing-id/project.yaml"
                && error.reason == "missing_project_id"
        }));
        assert!(catalog.catalog_errors.iter().any(|error| {
            error.path == "projects/naia-pj-adk/projects/missing-file/project.yaml"
                && error.reason == "missing"
        }));
    }

    #[test]
    fn ignores_non_candidate_roots_without_projects_directories() {
        let (_temp, root) = adk();
        fs::create_dir_all(root.join("projects/not-a-harness/docs")).unwrap();
        let catalog = scan(&root);
        assert!(catalog.projects.is_empty());
        assert!(catalog.catalog_errors.is_empty());
    }

    #[test]
    fn limits_total_scanned_entries_and_reports_remaining_entries() {
        let (_temp, root) = adk();
        for index in 0..=MAX_SCAN_ENTRIES {
            let id = format!("project-{index:03}");
            write(
                &root,
                &format!("projects/naia-pj-adk/projects/{id}/project.yaml"),
                &project_yaml(&id),
            );
        }
        let catalog = scan(&root);
        assert_eq!(catalog.truncation.scanned_entries, MAX_SCAN_ENTRIES);
        assert!(catalog.truncation.more_entries_available);
        assert_eq!(catalog.projects.len(), MAX_SCAN_ENTRIES - 1);
        assert!(catalog.projects.len() < MAX_DISPLAY_ROWS);
    }

    #[test]
    fn reports_oversized_metadata_and_caps_display_rows() {
        let (_temp, root) = adk();
        let oversized = format!(
            "version: 1\nproject:\n  id: large\n{}",
            " ".repeat(MAX_CONFIG_FILE_BYTES + 1)
        );
        write(
            &root,
            "projects/naia-pj-adk/projects/large/project.yaml",
            &oversized,
        );
        let catalog = scan(&root);
        assert_eq!(
            catalog.truncation.max_config_file_bytes,
            MAX_CONFIG_FILE_BYTES
        );
        assert_eq!(catalog.truncation.oversized_files.len(), 1);
        assert_eq!(
            catalog.truncation.oversized_files[0].observed_bytes,
            oversized.len()
        );
        assert!(catalog.catalog_errors.iter().any(|error| {
            error.path == "projects/naia-pj-adk/projects/large/project.yaml"
                && error.reason == "file_too_large"
        }));
        assert_eq!(
            catalog.truncation.shown_rows,
            catalog.projects.len() + catalog.catalog_errors.len()
        );
        assert!(catalog.truncation.shown_rows <= MAX_DISPLAY_ROWS);
    }

    #[test]
    fn caps_project_and_error_rows_together() {
        let mut state = ScanState::default();
        let mut projects = Vec::new();
        let mut errors = Vec::new();
        for index in 0..MAX_DISPLAY_ROWS {
            push_project(
                &mut state,
                &mut projects,
                CatalogProject {
                    project_id: format!("project-{index}"),
                    name: format!("project-{index}"),
                    repository: None,
                    issue_tracker: None,
                    project_path: format!("/adk/projects/{index}"),
                    source_path: format!("projects/{index}"),
                },
            );
        }
        push_issue(
            &mut state,
            &mut errors,
            "projects/overflow".to_owned(),
            "entry_unreadable",
        );

        assert_eq!(state.shown_rows, MAX_DISPLAY_ROWS);
        assert_eq!(projects.len() + errors.len(), MAX_DISPLAY_ROWS);
        assert!(state.more_rows_available);
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlink_candidates_or_project_metadata() {
        use std::os::unix::fs::symlink;

        let (_temp, root) = adk();
        write(
            &root,
            ".agents/context/project-index.yaml",
            "version: '2.0'\nsubmodules:\n  naia-pj-adk:\n    path: ./projects/naia-pj-adk\n    type: workspace_adk\n  linked-candidate:\n    path: ./projects/linked-candidate\n    type: workspace_adk\n",
        );
        let outside = tempfile::tempdir().unwrap();
        write(
            outside.path(),
            "projects/escape/project.yaml",
            &project_yaml("escape"),
        );
        symlink(
            outside.path().join("projects"),
            root.join("projects/linked-candidate"),
        )
        .unwrap();
        fs::create_dir_all(root.join("projects/naia-pj-adk/projects/linked-project")).unwrap();
        symlink(
            outside.path().join("projects/escape/project.yaml"),
            root.join("projects/naia-pj-adk/projects/linked-project/project.yaml"),
        )
        .unwrap();

        let catalog = scan(&root);
        assert!(catalog.projects.is_empty());
        assert!(catalog.catalog_errors.iter().any(|error| {
            error.path == "projects/linked-candidate" && error.reason == "unsafe_path"
        }));
        assert!(catalog.catalog_errors.iter().any(|error| {
            error.path == "projects/naia-pj-adk/projects/linked-project/project.yaml"
                && error.reason == "unsafe_path"
        }));
    }

    #[test]
    fn rejects_an_adk_path_without_a_projects_directory() {
        let temp = tempfile::tempdir().unwrap();
        let error = projects_scan_adk(temp.path().to_string_lossy().into_owned()).unwrap_err();
        assert!(error.contains("projects folder"));
    }

    #[test]
    fn top_level_projects_directory_open_failure_is_fatal() {
        let (_temp, root) = adk();
        let mut state = ScanState::default();
        let mut errors = Vec::new();
        let unreadable = root.join("projects-missing");

        assert!(read_directory_entries(&unreadable, &root, &mut state, &mut errors).is_err());
        assert!(errors.is_empty());
    }
}
