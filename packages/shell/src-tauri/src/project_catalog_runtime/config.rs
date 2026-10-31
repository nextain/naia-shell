use serde_yaml::{Mapping, Value as YamlValue};
use std::fs;
use std::io::Read;
use std::path::Path;

use super::yaml_helpers::{
    mapping_raw_string, parse_class_config, parse_coding_app, parse_docs_dirs,
    resolve_docs_url_field, resolve_tasks_url_field,
};
use super::{ProjectCatalogAuthority, ProjectRuntimeConfig};

const MAX_PROJECT_CONFIG_BYTES: usize = 64 * 1024;

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
    // `canonicalize` returns Win32 paths without the `\\?\` verbatim prefix.
    // Strip only that representational prefix before the existing canonical
    // identity and catalog-authority checks.
    let adapter_input = dunce::simplified(Path::new(adapter_root)).to_path_buf();
    let project_input = dunce::simplified(Path::new(project_path)).to_path_buf();
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
    let (yaml, yaml_source) = read_project_yaml(&project_file)?;
    let project_mapping = yaml
        .as_mapping()
        .and_then(|mapping| mapping.get(&YamlValue::String("project".to_owned())))
        .and_then(YamlValue::as_mapping)
        .ok_or_else(|| "project_unverified".to_owned())?;
    let _project_id =
        runtime_string(project_mapping, "id").ok_or_else(|| "project_unverified".to_owned())?;
    let repository = mapping_raw_string(project_mapping, "repository");
    let dashboard_url = resolve_docs_url_field(project_mapping);
    let issues_url = resolve_tasks_url_field(project_mapping);
    let coding_app = parse_coding_app(project_mapping);
    let docs_dirs = parse_docs_dirs(project_mapping, None);
    let class = parse_class_config(project_mapping, &yaml_source);

    crate::log_verbose(
        "[project_catalog_runtime::read_project_runtime_config] branch=project_verified",
    );
    Ok(ProjectRuntimeConfig {
        adapter_root: canonical_adapter,
        project_path: canonical_project,
        repository,
        dashboard_url,
        issues_url,
        coding_app,
        docs_dirs,
        class,
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

fn read_project_yaml(path: &Path) -> Result<(YamlValue, String), String> {
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
    let yaml = serde_yaml::from_str(&text).map_err(|_| {
        crate::log_verbose("[project_catalog_runtime::read_project_yaml] branch=invalid_yaml");
        "project_unverified".to_owned()
    })?;
    Ok((yaml, text))
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
