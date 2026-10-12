use serde::Serialize;
use serde_yaml::Value as YamlValue;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCatalog {
    projects: Vec<CatalogProject>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogProject {
    directory_name: String,
    project_id: String,
    name: String,
    repository: Option<String>,
    issue_tracker: Option<String>,
    profile: Option<String>,
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

    let mut directories = fs::read_dir(&canonical_projects_dir)
        .map_err(|_| "The selected projects folder could not be read.".to_owned())?
        .map(|entry| entry.map_err(|_| "A project entry could not be read.".to_owned()))
        .collect::<Result<Vec<_>, _>>()?;
    directories.sort_by_key(|entry| entry.file_name());

    let mut projects = Vec::new();
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
        projects.push(read_project(&selected_root, &directory_name, &project_dir));
    }

    Ok(ProjectCatalog { projects })
}

fn read_project(root: &Path, directory_name: &str, project_dir: &Path) -> CatalogProject {
    let project_file = format!("projects/{directory_name}/project.yaml");
    let yaml = match read_yaml(root, &project_dir.join("project.yaml")) {
        Ok(value) => value,
        Err(reason) => {
            return unavailable_project(directory_name, project_file, reason);
        }
    };
    let Some(mapping) = yaml.as_mapping() else {
        return unavailable_project(directory_name, project_file, "invalid_yaml");
    };

    let Some(project_id) = value_string(mapping, &["id", "project_id", "projectId"]) else {
        return unavailable_project(directory_name, project_file, "missing_project_id");
    };
    let Some(profile) = value_string(mapping, &["profile"]) else {
        return unavailable_project(directory_name, project_file, "missing_profile");
    };

    let mut config_errors = Vec::new();
    if profile == "local" {
        for (relative, parser) in [
            ("profiles/local/profile.yaml", ConfigParser::Yaml),
            ("profiles/local/workspace/repos.json", ConfigParser::Json),
        ] {
            let path = root.join(relative);
            let result = match parser {
                ConfigParser::Yaml => read_yaml(root, &path).map(|_| ()),
                ConfigParser::Json => read_json(root, &path).map(|_| ()),
            };
            if let Err(reason) = result {
                config_errors.push(ConfigIssue {
                    file: relative.to_owned(),
                    reason,
                });
            }
        }
    }

    CatalogProject {
        directory_name: directory_name.to_owned(),
        project_id: project_id.clone(),
        name: value_string(mapping, &["name", "title"]).unwrap_or(project_id),
        repository: value_string(mapping, &["repository", "repo"]),
        issue_tracker: value_string(mapping, &["issue_tracker", "issueTracker"]),
        profile: Some(profile),
        config_errors,
    }
}

#[derive(Clone, Copy)]
enum ConfigParser {
    Yaml,
    Json,
}

fn unavailable_project(directory_name: &str, file: String, reason: &'static str) -> CatalogProject {
    CatalogProject {
        directory_name: directory_name.to_owned(),
        project_id: directory_name.to_owned(),
        name: directory_name.to_owned(),
        repository: None,
        issue_tracker: None,
        profile: None,
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

fn read_yaml(root: &Path, path: &Path) -> Result<YamlValue, &'static str> {
    let text = read_confined(root, path)?;
    serde_yaml::from_str(&text).map_err(|_| "invalid_yaml")
}

fn read_json(root: &Path, path: &Path) -> Result<serde_json::Value, &'static str> {
    let text = read_confined(root, path)?;
    serde_json::from_str(&text).map_err(|_| "invalid_json")
}

fn read_confined(root: &Path, path: &Path) -> Result<String, &'static str> {
    let canonical = dunce::canonicalize(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "missing"
        } else {
            "unreadable"
        }
    })?;
    if !canonical.starts_with(root) {
        return Err("unsafe_path");
    }
    if !canonical.is_file() {
        return Err("unreadable");
    }
    fs::read_to_string(canonical).map_err(|_| "unreadable")
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

    #[test]
    fn lists_projects_and_excludes_both_templates() {
        let (_temp, root) = checkout();
        for name in ["_template", "_template-local", "alpha"] {
            write(
                &root,
                &format!("projects/{name}/project.yaml"),
                &format!(
                    "id: {name}\nname: {name} title\nprofile: server\nrepository: nextain/{name}\n"
                ),
            );
        }

        let catalog = projects_scan_checkout(root.to_string_lossy().into_owned()).unwrap();
        assert_eq!(catalog.projects.len(), 1);
        let project = &catalog.projects[0];
        assert_eq!(project.project_id, "alpha");
        assert_eq!(project.name, "alpha title");
        assert_eq!(project.repository.as_deref(), Some("nextain/alpha"));
        assert_eq!(project.profile.as_deref(), Some("server"));
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
            "projects/no-profile/project.yaml",
            "id: no-profile\n",
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
            by_name["no-profile"].config_errors[0].reason,
            "missing_profile"
        );
    }

    #[test]
    fn validates_both_local_profile_files() {
        let (_temp, root) = checkout();
        write(
            &root,
            "projects/local/project.yaml",
            "id: local\nprofile: local\n",
        );
        write(&root, "profiles/local/profile.yaml", "mode: local\n");
        write(&root, "profiles/local/workspace/repos.json", "{bad json");

        let catalog = projects_scan_checkout(root.to_string_lossy().into_owned()).unwrap();
        let project = &catalog.projects[0];
        assert_eq!(project.config_errors.len(), 1);
        assert_eq!(
            project.config_errors[0].file,
            "profiles/local/workspace/repos.json"
        );
        assert_eq!(project.config_errors[0].reason, "invalid_json");
    }

    #[test]
    fn reports_missing_and_malformed_local_profile_files() {
        let (_temp, root) = checkout();
        write(
            &root,
            "projects/local/project.yaml",
            "id: local\nprofile: local\n",
        );

        let missing = projects_scan_checkout(root.to_string_lossy().into_owned()).unwrap();
        let missing_project = &missing.projects[0];
        assert_eq!(missing_project.config_errors.len(), 2);
        assert!(missing_project.config_errors.iter().any(|issue| {
            issue.file == "profiles/local/profile.yaml" && issue.reason == "missing"
        }));
        assert!(missing_project.config_errors.iter().any(|issue| {
            issue.file == "profiles/local/workspace/repos.json" && issue.reason == "missing"
        }));

        write(
            &root,
            "profiles/local/profile.yaml",
            "mode: [unterminated\n",
        );
        write(&root, "profiles/local/workspace/repos.json", "[]");
        let malformed = projects_scan_checkout(root.to_string_lossy().into_owned()).unwrap();
        assert_eq!(malformed.projects[0].config_errors.len(), 1);
        assert_eq!(
            malformed.projects[0].config_errors[0].file,
            "profiles/local/profile.yaml"
        );
        assert_eq!(
            malformed.projects[0].config_errors[0].reason,
            "invalid_yaml"
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
            "id: outside\nprofile: server\n",
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
