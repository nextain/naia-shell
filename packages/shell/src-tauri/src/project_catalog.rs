use serde::Serialize;
use serde_yaml::Value as YamlValue;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_PROJECT_ENTRIES: usize = 200;
const MAX_CONFIG_FILE_BYTES: usize = 64 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCatalog {
    projects: Vec<CatalogProject>,
    truncation: CatalogTruncation,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogTruncation {
    max_entries: usize,
    scanned_entries: usize,
    more_entries_available: bool,
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
    directory_name: String,
    project_id: String,
    name: String,
    repository: Option<String>,
    issue_tracker: Option<String>,
    config_errors: Vec<ConfigIssue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigIssue {
    file: String,
    reason: &'static str,
}

#[tauri::command]
pub fn projects_scan_checkout(checkout_path: String) -> Result<ProjectCatalog, String> {
    let selected_root = dunce::canonicalize(PathBuf::from(checkout_path))
        .map_err(|_| "The selected checkout could not be opened.".to_owned())?;
    if !selected_root.is_dir() {
        return Err("The selected checkout could not be opened.".to_owned());
    }

    let projects_dir = selected_root.join("projects");
    let canonical_projects_dir = dunce::canonicalize(&projects_dir).map_err(|_| {
        "The selected directory does not contain a readable projects folder.".to_owned()
    })?;
    if canonical_projects_dir.parent() != Some(selected_root.as_path()) {
        return Err("The projects folder is outside the selected checkout.".to_owned());
    }

    let mut directory_entries = fs::read_dir(&canonical_projects_dir)
        .map_err(|_| "The selected projects folder could not be read.".to_owned())?
        .into_iter();
    let mut directories = Vec::with_capacity(MAX_PROJECT_ENTRIES);
    let mut scanned_entries = 0;
    while scanned_entries < MAX_PROJECT_ENTRIES {
        let Some(entry) = directory_entries.next() else {
            break;
        };
        directories.push(entry.map_err(|_| "A project entry could not be read.".to_owned())?);
        scanned_entries += 1;
    }
    let more_entries_available = if scanned_entries == MAX_PROJECT_ENTRIES {
        match directory_entries.next() {
            Some(Ok(_)) => true,
            Some(Err(_)) => return Err("A project entry could not be read.".to_owned()),
            None => false,
        }
    } else {
        false
    };
    directories.sort_by_key(|entry| entry.file_name());

    let mut projects = Vec::new();
    let mut oversized_files = Vec::new();
    for entry in directories {
        let directory_name = entry.file_name().to_string_lossy().into_owned();
        if matches!(directory_name.as_str(), "_template" | "_template-local") {
            continue;
        }

        let file_type = entry
            .file_type()
            .map_err(|_| "A project entry could not be inspected.".to_owned())?;
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }

        let project_dir = dunce::canonicalize(entry.path())
            .map_err(|_| "A project directory could not be opened.".to_owned())?;
        if project_dir.parent() != Some(canonical_projects_dir.as_path())
            || !project_dir.starts_with(&selected_root)
        {
            continue;
        }
        projects.push(read_project(
            &selected_root,
            &directory_name,
            &project_dir,
            &mut oversized_files,
        ));
    }

    Ok(ProjectCatalog {
        projects,
        truncation: CatalogTruncation {
            max_entries: MAX_PROJECT_ENTRIES,
            scanned_entries,
            more_entries_available,
            max_config_file_bytes: MAX_CONFIG_FILE_BYTES,
            oversized_files,
        },
    })
}

fn read_project(
    root: &Path,
    directory_name: &str,
    project_dir: &Path,
    oversized_files: &mut Vec<OversizedConfigFile>,
) -> CatalogProject {
    let project_file = format!("projects/{directory_name}/project.yaml");
    let yaml = match read_yaml(root, &project_dir.join("project.yaml")) {
        Ok(value) => value,
        Err(ConfigFileReadError::Issue(reason)) => {
            return unavailable_project(directory_name, project_file, reason);
        }
        Err(ConfigFileReadError::Oversized { observed_bytes }) => {
            oversized_files.push(OversizedConfigFile {
                file: project_file,
                observed_bytes,
            });
            return incomplete_project(directory_name);
        }
    };
    let Some(mapping) = yaml.as_mapping() else {
        return unavailable_project(directory_name, project_file, "invalid_yaml");
    };

    let Some(project_mapping) = mapping
        .get(&YamlValue::String("project".to_owned()))
        .and_then(YamlValue::as_mapping)
    else {
        return unavailable_project(directory_name, project_file, "missing_project_id");
    };
    let Some(project_id) = value_string(project_mapping, &["id"]) else {
        return unavailable_project(directory_name, project_file, "missing_project_id");
    };

    CatalogProject {
        directory_name: directory_name.to_owned(),
        project_id: project_id.clone(),
        name: value_string(project_mapping, &["name", "display_name", "title"])
            .unwrap_or(project_id),
        repository: value_string(project_mapping, &["repository"]),
        issue_tracker: value_string(project_mapping, &["issue_tracker"]),
        config_errors: Vec::new(),
    }
}

fn incomplete_project(directory_name: &str) -> CatalogProject {
    CatalogProject {
        directory_name: directory_name.to_owned(),
        project_id: directory_name.to_owned(),
        name: directory_name.to_owned(),
        repository: None,
        issue_tracker: None,
        config_errors: Vec::new(),
    }
}

fn unavailable_project(directory_name: &str, file: String, reason: &'static str) -> CatalogProject {
    CatalogProject {
        directory_name: directory_name.to_owned(),
        project_id: directory_name.to_owned(),
        name: directory_name.to_owned(),
        repository: None,
        issue_tracker: None,
        config_errors: vec![ConfigIssue { file, reason }],
    }
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

enum ConfigFileReadError {
    Issue(&'static str),
    Oversized { observed_bytes: usize },
}

fn read_yaml(root: &Path, path: &Path) -> Result<YamlValue, ConfigFileReadError> {
    let text = read_confined(root, path)?;
    serde_yaml::from_str(&text).map_err(|_| ConfigFileReadError::Issue("invalid_yaml"))
}

fn read_confined(root: &Path, path: &Path) -> Result<String, ConfigFileReadError> {
    let canonical = dunce::canonicalize(path).map_err(|error| {
        ConfigFileReadError::Issue(if error.kind() == std::io::ErrorKind::NotFound {
            "missing"
        } else {
            "unreadable"
        })
    })?;
    if !canonical.starts_with(root) {
        return Err(ConfigFileReadError::Issue("unsafe_path"));
    }
    if !canonical.is_file() {
        return Err(ConfigFileReadError::Issue("unreadable"));
    }
    let file = fs::File::open(canonical).map_err(|_| ConfigFileReadError::Issue("unreadable"))?;
    let mut bytes = Vec::with_capacity(MAX_CONFIG_FILE_BYTES + 1);
    file.take((MAX_CONFIG_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| ConfigFileReadError::Issue("unreadable"))?;
    if bytes.len() > MAX_CONFIG_FILE_BYTES {
        return Err(ConfigFileReadError::Oversized {
            observed_bytes: bytes.len(),
        });
    }
    String::from_utf8(bytes).map_err(|_| ConfigFileReadError::Issue("unreadable"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn checkout() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().expect("temporary checkout");
        let root = temp.path().to_path_buf();
        fs::create_dir_all(root.join("projects")).unwrap();
        (temp, root)
    }

    fn write(root: &Path, relative: &str, content: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn nested_project_yaml(id: &str) -> String {
        format!(
            "version: 1\nproject:\n  id: {id}\n  repository: example-org/{id}\n  issue_tracker: github\n  default_branch: main\n  integration_branch: develop\nroles: {{}}\ndiscord: {{}}\ncommands: {{}}\n"
        )
    }

    #[test]
    fn lists_projects_and_excludes_both_templates() {
        let (_temp, root) = checkout();
        for name in ["_template", "_template-local", "example-project"] {
            write(
                &root,
                &format!("projects/{name}/project.yaml"),
                &nested_project_yaml(name),
            );
        }

        let catalog = projects_scan_checkout(root.to_string_lossy().into_owned()).unwrap();
        assert_eq!(catalog.projects.len(), 1);
        let project = &catalog.projects[0];
        assert_eq!(project.project_id, "example-project");
        assert_eq!(project.name, "example-project");
        assert_eq!(
            project.repository.as_deref(),
            Some("example-org/example-project")
        );
        assert_eq!(project.issue_tracker.as_deref(), Some("github"));
        assert!(project.config_errors.is_empty());
    }

    #[test]
    fn empty_projects_directory_returns_an_empty_catalog() {
        let (_temp, root) = checkout();
        let catalog = projects_scan_checkout(root.to_string_lossy().into_owned()).unwrap();
        assert!(catalog.projects.is_empty());
    }

    #[test]
    fn reports_missing_and_malformed_project_configuration() {
        let (_temp, root) = checkout();
        fs::create_dir_all(root.join("projects/missing")).unwrap();
        write(
            &root,
            "projects/malformed/project.yaml",
            "id: [unterminated\n",
        );
        write(
            &root,
            "projects/missing-id/project.yaml",
            "version: 1\nroles: {}\n",
        );
        write(
            &root,
            "projects/top-level-id/project.yaml",
            "version: 1\nid: top-level-id\n",
        );

        let catalog = projects_scan_checkout(root.to_string_lossy().into_owned()).unwrap();
        let by_name = catalog
            .projects
            .iter()
            .map(|project| (project.directory_name.as_str(), project))
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(by_name["missing"].config_errors[0].reason, "missing");
        assert_eq!(by_name["malformed"].config_errors[0].reason, "invalid_yaml");
        assert_eq!(
            by_name["missing-id"].config_errors[0].reason,
            "missing_project_id"
        );
        assert_eq!(
            by_name["top-level-id"].config_errors[0].reason,
            "missing_project_id"
        );
    }

    #[test]
    fn stops_after_the_project_entry_limit_and_reports_more_entries() {
        let (_temp, root) = checkout();
        for index in 0..=MAX_PROJECT_ENTRIES {
            let name = format!("project-{index:03}");
            write(
                &root,
                &format!("projects/{name}/project.yaml"),
                &format!("version: 1\nproject:\n  id: {name}\n"),
            );
        }

        let catalog = projects_scan_checkout(root.to_string_lossy().into_owned()).unwrap();
        assert_eq!(catalog.projects.len(), MAX_PROJECT_ENTRIES);
        assert_eq!(catalog.truncation.max_entries, MAX_PROJECT_ENTRIES);
        assert_eq!(catalog.truncation.scanned_entries, MAX_PROJECT_ENTRIES);
        assert!(catalog.truncation.more_entries_available);
        assert!(catalog.truncation.oversized_files.is_empty());
    }

    #[test]
    fn reports_an_oversized_project_file_as_catalog_truncation_not_a_config_error() {
        let (_temp, root) = checkout();
        let file = format!(
            "version: 1\nproject:\n  id: large\n{}",
            " ".repeat(MAX_CONFIG_FILE_BYTES + 1)
        );
        write(&root, "projects/large/project.yaml", &file);

        let catalog = projects_scan_checkout(root.to_string_lossy().into_owned()).unwrap();
        let project = &catalog.projects[0];
        assert_eq!(project.directory_name, "large");
        assert!(project.config_errors.is_empty());
        assert_eq!(
            catalog.truncation.max_config_file_bytes,
            MAX_CONFIG_FILE_BYTES
        );
        assert_eq!(catalog.truncation.oversized_files.len(), 1);
        assert_eq!(
            catalog.truncation.oversized_files[0].file,
            "projects/large/project.yaml"
        );
        assert_eq!(
            catalog.truncation.oversized_files[0].observed_bytes,
            MAX_CONFIG_FILE_BYTES + 1
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_configuration_symlinks_that_escape_the_checkout() {
        use std::os::unix::fs::symlink;

        let (_temp, root) = checkout();
        let outside = tempfile::tempdir().unwrap();
        fs::write(
            outside.path().join("project.yaml"),
            "version: 1\nproject:\n  id: outside\n",
        )
        .unwrap();
        fs::create_dir_all(root.join("projects/linked")).unwrap();
        symlink(
            outside.path().join("project.yaml"),
            root.join("projects/linked/project.yaml"),
        )
        .unwrap();

        let catalog = projects_scan_checkout(root.to_string_lossy().into_owned()).unwrap();
        assert_eq!(catalog.projects[0].config_errors[0].reason, "unsafe_path");
    }
}
