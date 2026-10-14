use serde_yaml::{Mapping, Value as YamlValue};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_PROJECT_CONFIG_BYTES: usize = 64 * 1024;

/// The native catalog's canonical project-to-adapter mapping. Frontend-provided
/// paths are checked against this map before project-owned operations use them.
#[derive(Default)]
pub(crate) struct ProjectCatalogAuthority {
    projects: Mutex<HashMap<PathBuf, PathBuf>>,
}

#[derive(Debug, Clone)]
pub(crate) struct ProjectRuntimeConfig {
    pub(crate) adapter_root: PathBuf,
    pub(crate) project_path: PathBuf,
    repository: Option<String>,
    pub(crate) dashboard_url: Option<String>,
    pub(crate) issues_url: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedProjectCheckout {
    pub(crate) project_path: PathBuf,
    pub(crate) checkout_path: PathBuf,
    pub(crate) checkout_relative_path: String,
}

impl ProjectCatalogAuthority {
    pub(crate) fn clear(&self) {
        crate::log_verbose("[project_catalog_runtime::ProjectCatalogAuthority::clear] enter");
        self.projects.lock().unwrap().clear();
        crate::log_verbose(
            "[project_catalog_runtime::ProjectCatalogAuthority::clear] branch=cleared",
        );
    }

    pub(crate) fn replace_projects<I>(&self, projects: I)
    where
        I: IntoIterator<Item = (PathBuf, PathBuf)>,
    {
        crate::log_verbose(
            "[project_catalog_runtime::ProjectCatalogAuthority::replace_projects] enter",
        );
        let rows = projects.into_iter().collect::<HashMap<_, _>>();
        let count = rows.len();
        *self.projects.lock().unwrap() = rows;
        crate::log_verbose(&format!("[project_catalog_runtime::ProjectCatalogAuthority::replace_projects] branch=replaced project_count={count}"));
    }
}

pub(crate) fn project_catalog_fields(
    mapping: &Mapping,
) -> (Option<String>, Option<String>, Option<String>) {
    crate::log_verbose("[project_catalog_runtime::project_catalog_fields] enter");
    let repository = mapping_raw_string(mapping, "repository");
    let dashboard_url = mapping_url_value(mapping, "dashboard_url");
    let issues_url = mapping_url_value(mapping, "issues_url");
    crate::log_verbose(&format!(
        "[project_catalog_runtime::project_catalog_fields] branch=read urls_present={}",
        dashboard_url.is_some() as u8 + issues_url.is_some() as u8
    ));
    (repository, dashboard_url, issues_url)
}

/// Validate the catalog-provided adapter root and project directory, then read
/// the small project settings file without following symlinks.
pub(crate) fn read_project_runtime_config(
    authority: &ProjectCatalogAuthority,
    adapter_root: &str,
    project_path: &str,
) -> Result<ProjectRuntimeConfig, String> {
    crate::log_verbose(
        "[project_catalog_runtime::read_project_runtime_config] enter adapter_root_supplied=true project_path_supplied=true",
    );
    let adapter_input = PathBuf::from(adapter_root);
    let project_input = PathBuf::from(project_path);
    if !adapter_input.is_absolute() || !project_input.is_absolute() {
        crate::log_verbose(
            "[project_catalog_runtime::read_project_runtime_config] branch=reject_non_absolute_paths",
        );
        return Err("project_unverified".to_owned());
    }
    if has_symlink_or_wrong_type(&adapter_input, true)
        || has_symlink_or_wrong_type(&project_input, true)
    {
        crate::log_verbose(
            "[project_catalog_runtime::read_project_runtime_config] branch=reject_symlink_or_non_directory",
        );
        return Err("project_unverified".to_owned());
    }
    let canonical_adapter =
        dunce::canonicalize(&adapter_input).map_err(|_| "project_unverified".to_owned())?;
    let canonical_project =
        dunce::canonicalize(&project_input).map_err(|_| "project_unverified".to_owned())?;
    if canonical_adapter != adapter_input
        || canonical_project != project_input
        || !looks_like_catalog_candidate(&canonical_adapter)
    {
        crate::log_verbose(
            "[project_catalog_runtime::read_project_runtime_config] branch=reject_unverified_canonical_path",
        );
        return Err("project_unverified".to_owned());
    }

    let authorized = authority
        .projects
        .lock()
        .unwrap()
        .get(&canonical_project)
        .cloned();
    if authorized.as_deref() != Some(canonical_adapter.as_path()) {
        crate::log_verbose(
            "[project_catalog_runtime::read_project_runtime_config] branch=reject_catalog_authority_mismatch",
        );
        return Err("project_unverified".to_owned());
    }

    let projects_root = canonical_adapter.join("projects");
    if has_symlink_or_wrong_type(&projects_root, true) {
        crate::log_verbose(
            "[project_catalog_runtime::read_project_runtime_config] branch=reject_projects_root",
        );
        return Err("project_unverified".to_owned());
    }
    let canonical_projects =
        dunce::canonicalize(&projects_root).map_err(|_| "project_unverified".to_owned())?;
    if canonical_projects.parent() != Some(canonical_adapter.as_path())
        || canonical_project.parent() != Some(canonical_projects.as_path())
    {
        crate::log_verbose(
            "[project_catalog_runtime::read_project_runtime_config] branch=reject_project_outside_adapter",
        );
        return Err("project_unverified".to_owned());
    }

    let project_file = canonical_project.join("project.yaml");
    if has_symlink_or_wrong_type(&project_file, false) {
        crate::log_verbose(
            "[project_catalog_runtime::read_project_runtime_config] branch=reject_project_config_file",
        );
        return Err("project_unverified".to_owned());
    }
    let yaml = read_project_yaml(&project_file)?;
    let project_mapping = yaml
        .as_mapping()
        .and_then(|mapping| mapping.get(&YamlValue::String("project".to_owned())))
        .and_then(YamlValue::as_mapping)
        .ok_or_else(|| "project_unverified".to_owned())?;
    let _project_id =
        runtime_string(project_mapping, "id").ok_or_else(|| "project_unverified".to_owned())?;
    let repository = mapping_raw_string(project_mapping, "repository");
    let dashboard_url = mapping_url_value(project_mapping, "dashboard_url");
    let issues_url = mapping_url_value(project_mapping, "issues_url");

    crate::log_verbose(
        "[project_catalog_runtime::read_project_runtime_config] branch=project_verified",
    );
    Ok(ProjectRuntimeConfig {
        adapter_root: canonical_adapter,
        project_path: canonical_project,
        repository,
        dashboard_url,
        issues_url,
    })
}

/// Resolve only the expected checkout derived from the selected project's
/// repository field. The checkout remains a direct child of its adapter root.
pub(crate) fn resolve_project_checkout(
    authority: &ProjectCatalogAuthority,
    adapter_root: &str,
    project_path: &str,
) -> Result<ResolvedProjectCheckout, String> {
    crate::log_verbose(
        "[project_catalog_runtime::resolve_project_checkout] enter adapter_root_supplied=true project_path_supplied=true",
    );
    let config = read_project_runtime_config(authority, adapter_root, project_path)?;
    let repository = config
        .repository
        .ok_or_else(|| "repository_invalid".to_owned())?;
    let repository_parts = repository.split(['/', '\\']).collect::<Vec<_>>();
    if repository_parts.len() < 2
        || repository_parts.iter().any(|part| {
            part.is_empty()
                || matches!(*part, "." | "..")
                || part.contains(':')
                || part.chars().any(char::is_whitespace)
        })
    {
        crate::log_verbose(
            "[project_catalog_runtime::resolve_project_checkout] branch=reject_ambiguous_repository",
        );
        return Err("repository_invalid".to_owned());
    }
    let repository_name = repository
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| is_safe_repository_directory(name))
        .ok_or_else(|| "repository_invalid".to_owned())?;

    let checkout_relative_path = format!("checkouts/{repository_name}");
    let checkouts_root = config.adapter_root.join("checkouts");
    match fs::symlink_metadata(&checkouts_root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            crate::log_verbose(
                "[project_catalog_runtime::resolve_project_checkout] branch=checkout_missing_root",
            );
            return Err(format!("checkout_missing:{checkout_relative_path}"));
        }
        Err(_) => {
            crate::log_verbose(
                "[project_catalog_runtime::resolve_project_checkout] branch=checkout_root_unreadable",
            );
            return Err("checkout_unsafe".to_owned());
        }
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            crate::log_verbose(
                "[project_catalog_runtime::resolve_project_checkout] branch=checkout_root_unsafe",
            );
            return Err("checkout_unsafe".to_owned());
        }
        Ok(_) => {}
    }
    let canonical_checkouts =
        dunce::canonicalize(&checkouts_root).map_err(|_| "checkout_unsafe".to_owned())?;
    if canonical_checkouts.parent() != Some(config.adapter_root.as_path()) {
        crate::log_verbose(
            "[project_catalog_runtime::resolve_project_checkout] branch=checkout_root_outside_adapter",
        );
        return Err("checkout_unsafe".to_owned());
    }
    let checkout_input = canonical_checkouts.join(repository_name);
    match fs::symlink_metadata(&checkout_input) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            crate::log_verbose(
                "[project_catalog_runtime::resolve_project_checkout] branch=checkout_missing_project",
            );
            return Err(format!("checkout_missing:{checkout_relative_path}"));
        }
        Err(_) => {
            crate::log_verbose(
                "[project_catalog_runtime::resolve_project_checkout] branch=checkout_project_unreadable",
            );
            return Err("checkout_unsafe".to_owned());
        }
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            crate::log_verbose(
                "[project_catalog_runtime::resolve_project_checkout] branch=checkout_project_unsafe",
            );
            return Err("checkout_unsafe".to_owned());
        }
        Ok(_) => {}
    }
    let checkout_path =
        dunce::canonicalize(&checkout_input).map_err(|_| "checkout_unsafe".to_owned())?;
    if checkout_path.parent() != Some(canonical_checkouts.as_path()) {
        crate::log_verbose(
            "[project_catalog_runtime::resolve_project_checkout] branch=checkout_project_outside_root",
        );
        return Err("checkout_unsafe".to_owned());
    }
    crate::log_verbose(
        "[project_catalog_runtime::resolve_project_checkout] branch=checkout_verified relative_path=checkouts/<repository-name>",
    );
    Ok(ResolvedProjectCheckout {
        project_path: config.project_path,
        checkout_path,
        checkout_relative_path,
    })
}

fn has_symlink_or_wrong_type(path: &Path, directory: bool) -> bool {
    crate::log_verbose(&format!(
        "[project_catalog_runtime::has_symlink_or_wrong_type] enter expected_kind={}",
        if directory { "directory" } else { "file" }
    ));
    let invalid = match fs::symlink_metadata(path) {
        Ok(metadata) => {
            metadata.file_type().is_symlink()
                || if directory {
                    !metadata.is_dir()
                } else {
                    !metadata.is_file()
                }
        }
        Err(_) => false,
    };
    crate::log_verbose(&format!(
        "[project_catalog_runtime::has_symlink_or_wrong_type] branch=checked invalid={invalid}"
    ));
    invalid
}

fn looks_like_catalog_candidate(adapter_root: &Path) -> bool {
    crate::log_verbose(
        "[project_catalog_runtime::looks_like_catalog_candidate] enter adapter_root_supplied=true",
    );
    let Some(parent) = adapter_root.parent() else {
        crate::log_verbose(
            "[project_catalog_runtime::looks_like_catalog_candidate] branch=missing_parent",
        );
        return false;
    };
    let candidate = parent.file_name().is_some_and(|name| name == "projects")
        || parent
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name == "projects");
    crate::log_verbose(&format!(
        "[project_catalog_runtime::looks_like_catalog_candidate] branch=checked candidate={candidate}"
    ));
    candidate
}

fn is_safe_repository_directory(name: &str) -> bool {
    crate::log_verbose(&format!(
        "[project_catalog_runtime::is_safe_repository_directory] enter name_length={}",
        name.len()
    ));
    if name.is_empty()
        || matches!(name, "." | "..")
        || name.ends_with('.')
        || name.ends_with(' ')
        || name.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*'
                )
        })
    {
        crate::log_verbose(
            "[project_catalog_runtime::is_safe_repository_directory] branch=reject_unsafe_component",
        );
        return false;
    }
    let device_stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    let safe = !matches!(
        device_stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    );
    crate::log_verbose(&format!(
        "[project_catalog_runtime::is_safe_repository_directory] branch=checked safe={safe}"
    ));
    safe
}

pub(crate) fn validate_project_url(raw: &str) -> Result<url::Url, ()> {
    crate::log_verbose(&format!(
        "[project_catalog_runtime::validate_project_url] enter url_length={}",
        raw.len()
    ));
    if raw.trim() != raw
        || raw.is_empty()
        || raw.contains('\\')
        || raw.chars().any(char::is_control)
        || raw.chars().any(char::is_whitespace)
    {
        crate::log_verbose(
            "[project_catalog_runtime::validate_project_url] branch=reject_empty_whitespace_or_backslash",
        );
        return Err(());
    }
    let parsed = url::Url::parse(raw).map_err(|_| {
        crate::log_verbose("[project_catalog_runtime::validate_project_url] branch=parse_failed");
    })?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        crate::log_verbose(
            "[project_catalog_runtime::validate_project_url] branch=reject_scheme_host_or_credentials",
        );
        return Err(());
    }
    crate::log_verbose("[project_catalog_runtime::validate_project_url] branch=accepted_http_url");
    Ok(parsed)
}

fn read_project_yaml(path: &Path) -> Result<YamlValue, String> {
    crate::log_verbose(
        "[project_catalog_runtime::read_project_yaml] enter project_file_supplied=true",
    );
    let metadata = fs::symlink_metadata(path).map_err(|_| "project_unverified".to_owned())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() as usize > MAX_PROJECT_CONFIG_BYTES
    {
        crate::log_verbose(
            "[project_catalog_runtime::read_project_yaml] branch=reject_unsafe_or_oversized_file",
        );
        return Err("project_unverified".to_owned());
    }
    let canonical = dunce::canonicalize(path).map_err(|_| "project_unverified".to_owned())?;
    if canonical != path {
        crate::log_verbose(
            "[project_catalog_runtime::read_project_yaml] branch=reject_noncanonical_file",
        );
        return Err("project_unverified".to_owned());
    }
    let file = fs::File::open(&canonical).map_err(|_| "project_unverified".to_owned())?;
    let mut text = String::new();
    file.take((MAX_PROJECT_CONFIG_BYTES + 1) as u64)
        .read_to_string(&mut text)
        .map_err(|_| "project_unverified".to_owned())?;
    if text.len() > MAX_PROJECT_CONFIG_BYTES {
        crate::log_verbose(
            "[project_catalog_runtime::read_project_yaml] branch=file_grew_past_limit",
        );
        return Err("project_unverified".to_owned());
    }
    serde_yaml::from_str(&text).map_err(|_| {
        crate::log_verbose("[project_catalog_runtime::read_project_yaml] branch=invalid_yaml");
        "project_unverified".to_owned()
    })
}

fn runtime_string(mapping: &Mapping, key: &str) -> Option<String> {
    crate::log_verbose(&format!(
        "[project_catalog_runtime::runtime_string] enter key={key}"
    ));
    let value = mapping
        .get(YamlValue::String(key.to_owned()))?
        .as_str()?
        .trim();
    let result = (!value.is_empty()).then(|| value.to_owned());
    crate::log_verbose(&format!(
        "[project_catalog_runtime::runtime_string] branch=read key={key} value_present={}",
        result.is_some()
    ));
    result
}

fn mapping_raw_string(mapping: &Mapping, key: &str) -> Option<String> {
    crate::log_verbose(&format!(
        "[project_catalog_runtime::mapping_raw_string] enter key={key}"
    ));
    let result = mapping
        .get(YamlValue::String(key.to_owned()))?
        .as_str()
        .map(ToOwned::to_owned);
    crate::log_verbose(&format!(
        "[project_catalog_runtime::mapping_raw_string] branch=read key={key} value_present={}",
        result.is_some()
    ));
    result
}

fn mapping_url_value(mapping: &Mapping, key: &str) -> Option<String> {
    crate::log_verbose(&format!(
        "[project_catalog_runtime::mapping_url_value] enter key={key}"
    ));
    let value = mapping.get(YamlValue::String(key.to_owned()))?;
    let result = match value {
        YamlValue::Null => None,
        YamlValue::String(raw) if raw.trim().is_empty() => None,
        YamlValue::String(raw) => Some(raw.clone()),
        value => serde_yaml::to_string(value).ok(),
    };
    crate::log_verbose(&format!(
        "[project_catalog_runtime::mapping_url_value] branch=read key={key} value_present={}",
        result.is_some()
    ));
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn project_fixture(
        repository: &str,
    ) -> (tempfile::TempDir, ProjectCatalogAuthority, PathBuf, PathBuf) {
        crate::log_verbose("[project_catalog_runtime::tests::project_fixture] enter");
        let temp = tempfile::tempdir().expect("temporary catalog adapter");
        let adapter = temp.path().join("projects/adapter");
        let project = adapter.join("projects/sample");
        fs::create_dir_all(&project).unwrap();
        fs::write(
            project.join("project.yaml"),
            format!("version: 1\nproject:\n  id: sample\n  repository: '{repository}'\n"),
        )
        .unwrap();
        let authority = ProjectCatalogAuthority::default();
        authority.replace_projects([(project.clone(), adapter.clone())]);
        (temp, authority, adapter, project)
    }

    #[test]
    fn project_pty_resolves_only_the_repository_checkout_inside_the_catalog_adapter() {
        let (_temp, authority, adapter, project) = project_fixture("owner/Hello-World");
        let expected = adapter.join("checkouts/Hello-World");
        fs::create_dir_all(&expected).unwrap();
        let resolved = resolve_project_checkout(
            &authority,
            &adapter.to_string_lossy(),
            &project.to_string_lossy(),
        )
        .unwrap();
        assert_eq!(resolved.checkout_relative_path, "checkouts/Hello-World");
        assert_eq!(resolved.checkout_path, expected);
    }

    #[test]
    fn project_pty_reports_relative_expected_path_when_repository_checkout_is_missing() {
        let (_temp, authority, adapter, project) = project_fixture("owner/Hello-World");
        fs::create_dir_all(adapter.join("checkouts")).unwrap();
        let error = resolve_project_checkout(
            &authority,
            &adapter.to_string_lossy(),
            &project.to_string_lossy(),
        )
        .unwrap_err();
        assert_eq!(error, "checkout_missing:checkouts/Hello-World");
    }

    #[test]
    fn project_pty_rejects_invalid_repository_names_before_checkout_lookup() {
        for repository in [
            "",
            "single-name",
            "owner/",
            "owner/../escape",
            "owner/a:b",
            " owner/Hello-World",
            "owner/Hello-World ",
        ] {
            let (_temp, authority, adapter, project) = project_fixture(repository);
            let error = resolve_project_checkout(
                &authority,
                &adapter.to_string_lossy(),
                &project.to_string_lossy(),
            )
            .unwrap_err();
            assert_eq!(error, "repository_invalid", "repository={repository:?}");
        }
    }

    #[test]
    fn project_pty_rejects_unlisted_paths_even_when_the_config_looks_valid() {
        let (_temp, authority, adapter, project) = project_fixture("owner/Hello-World");
        let other = adapter.join("projects/other");
        fs::create_dir_all(&other).unwrap();
        fs::write(
            other.join("project.yaml"),
            "version: 1\nproject:\n  id: other\n  repository: owner/Hello-World\n",
        )
        .unwrap();
        let error = read_project_runtime_config(
            &authority,
            &adapter.to_string_lossy(),
            &other.to_string_lossy(),
        )
        .unwrap_err();
        assert_eq!(error, "project_unverified");
        assert!(project.exists());
    }

    #[cfg(unix)]
    #[test]
    fn project_pty_rejects_a_symlinked_checkout() {
        use std::os::unix::fs::symlink;
        let (_temp, authority, adapter, project) = project_fixture("owner/Hello-World");
        let outside = tempfile::tempdir().unwrap();
        let checkouts = adapter.join("checkouts");
        fs::create_dir_all(&checkouts).unwrap();
        symlink(outside.path(), checkouts.join("Hello-World")).unwrap();
        let error = resolve_project_checkout(
            &authority,
            &adapter.to_string_lossy(),
            &project.to_string_lossy(),
        )
        .unwrap_err();
        assert_eq!(error, "checkout_unsafe");
    }

    #[test]
    fn accepts_only_absolute_http_and_https_project_urls_without_credentials() {
        for valid in [
            "https://example.test/dashboard",
            "http://localhost:3000/issues",
        ] {
            assert!(validate_project_url(valid).is_ok(), "url={valid:?}");
        }
        for invalid in [
            "",
            " /relative",
            "/relative",
            "file:///tmp/dashboard",
            "javascript:alert(1)",
            "data:text/plain,issues",
            "http:///missing-host",
            "https://user:secret@example.test/",
            "https://example.test/a b",
            "https://example.test/a\\b",
        ] {
            assert!(validate_project_url(invalid).is_err(), "url={invalid:?}");
        }
    }
}
