use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value as YamlValue};
use std::fs;
use std::path::{Component, Path, PathBuf};

pub(crate) const MAX_PROJECT_DOCS_DIRS: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectClassConfig {
    pub baseline_ref: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ParsedProjectCatalogFields {
    pub(crate) repository: Option<String>,
    pub(crate) dashboard_url: Option<String>,
    pub(crate) issues_url: Option<String>,
    pub(crate) coding_app: Option<String>,
    pub(crate) docs_dirs: Vec<String>,
    pub(crate) class: Option<ProjectClassConfig>,
}

pub(crate) fn parse_project_catalog_fields(
    mapping: &Mapping,
    checkout_path: Option<&Path>,
) -> ParsedProjectCatalogFields {
    crate::log_verbose("[project_catalog_runtime::parse_project_catalog_fields] enter");
    let repository = mapping_raw_string(mapping, "repository");
    let dashboard_url = resolve_docs_url_field(mapping);
    let issues_url = resolve_tasks_url_field(mapping);
    let coding_app = parse_coding_app(mapping);
    let docs_dirs = parse_docs_dirs(mapping, checkout_path);
    let class = parse_class_config(mapping);
    crate::log_verbose(&format!(
        "[project_catalog_runtime::parse_project_catalog_fields] branch=read urls_present={} coding_app_present={} docs_dirs_count={} class_present={}",
        dashboard_url.is_some() as u8 + issues_url.is_some() as u8,
        coding_app.is_some(),
        docs_dirs.len(),
        class.is_some()
    ));
    ParsedProjectCatalogFields {
        repository,
        dashboard_url,
        issues_url,
        coding_app,
        docs_dirs,
        class,
    }
}

pub(crate) fn resolve_docs_url_field(mapping: &Mapping) -> Option<String> {
    mapping_url_value(mapping, "docs_url").or_else(|| mapping_url_value(mapping, "dashboard_url"))
}

pub(crate) fn resolve_tasks_url_field(mapping: &Mapping) -> Option<String> {
    mapping_url_value(mapping, "tasks_url").or_else(|| mapping_url_value(mapping, "issues_url"))
}

pub(crate) fn parse_coding_app(mapping: &Mapping) -> Option<String> {
    let value = mapping.get(YamlValue::String("coding_app".to_owned()))?;
    match value {
        YamlValue::Null => None,
        YamlValue::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else if matches!(trimmed, "claude" | "codex" | "muse" | "opencode") {
                Some(trimmed.to_owned())
            } else {
                crate::log_verbose(&format!(
                    "[project_catalog_runtime::parse_coding_app] branch=ignore_invalid_coding_app value_len={}",
                    trimmed.len()
                ));
                None
            }
        }
        _ => {
            crate::log_verbose(
                "[project_catalog_runtime::parse_coding_app] branch=ignore_non_string_coding_app",
            );
            None
        }
    }
}

pub(crate) fn is_valid_baseline_ref(raw: &str) -> bool {
    let len = raw.len();
    (7..=40).contains(&len) && raw.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(crate) fn parse_class_config(mapping: &Mapping) -> Option<ProjectClassConfig> {
    let class_mapping = mapping
        .get(YamlValue::String("class".to_owned()))?
        .as_mapping()?;
    let baseline_ref = class_mapping
        .get(YamlValue::String("baseline_ref".to_owned()))?
        .as_str()?
        .trim();
    if is_valid_baseline_ref(baseline_ref) {
        Some(ProjectClassConfig {
            baseline_ref: baseline_ref.to_owned(),
        })
    } else {
        crate::log_verbose(
            "[project_catalog_runtime::parse_class_config] branch=ignore_invalid_baseline_ref",
        );
        None
    }
}

pub(crate) fn validate_docs_dir_relative_path(raw: &str) -> Result<String, &'static str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("docs_dir_empty");
    }
    if trimmed.contains('\\')
        || trimmed.contains(':')
        || trimmed.starts_with('/')
        || trimmed.chars().any(char::is_control)
    {
        return Err("docs_dir_invalid");
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err("docs_dir_absolute");
    }
    let mut segments = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                let Some(text) = part.to_str() else {
                    return Err("docs_dir_invalid");
                };
                if text.is_empty() || matches!(text, "." | "..") || text.starts_with('.') {
                    return Err("docs_dir_invalid");
                }
                segments.push(text);
            }
            _ => return Err("docs_dir_invalid"),
        }
    }
    if segments.is_empty() {
        return Err("docs_dir_empty");
    }
    Ok(segments.join("/"))
}

pub(crate) fn validate_docs_dir_in_checkout(
    checkout: &Path,
    raw_dir: &str,
) -> Result<(String, Option<PathBuf>), &'static str> {
    let normalized = validate_docs_dir_relative_path(raw_dir)?;
    let mut current = checkout.to_path_buf();
    let mut missing = false;
    for segment in normalized.split('/') {
        current.push(segment);
        if !missing {
            match fs::symlink_metadata(&current) {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink() {
                        return Err("docs_dir_symlink");
                    }
                    if !metadata.is_dir() {
                        return Err("docs_dir_not_directory");
                    }
                    let canonical =
                        dunce::canonicalize(&current).map_err(|_| "docs_dir_unreadable")?;
                    if !canonical.starts_with(checkout) || canonical == checkout {
                        return Err("docs_dir_outside_checkout");
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    missing = true;
                }
                Err(_) => return Err("docs_dir_unreadable"),
            }
        }
    }
    if missing {
        Ok((normalized, None))
    } else {
        let canonical = dunce::canonicalize(&current).map_err(|_| "docs_dir_unreadable")?;
        if !canonical.starts_with(checkout) || canonical == checkout {
            return Err("docs_dir_outside_checkout");
        }
        Ok((normalized, Some(canonical)))
    }
}

pub(crate) fn parse_docs_dirs(mapping: &Mapping, checkout_path: Option<&Path>) -> Vec<String> {
    let Some(sequence) = mapping
        .get(YamlValue::String("docs_dirs".to_owned()))
        .and_then(YamlValue::as_sequence)
    else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for item in sequence {
        if result.len() >= MAX_PROJECT_DOCS_DIRS {
            crate::log_verbose(
                "[project_catalog_runtime::parse_docs_dirs] branch=cap_docs_dirs_at_max",
            );
            break;
        }
        let Some(raw) = item.as_str() else {
            crate::log_verbose(
                "[project_catalog_runtime::parse_docs_dirs] branch=skip_non_string_entry",
            );
            continue;
        };
        let validated = match checkout_path {
            Some(checkout) => validate_docs_dir_in_checkout(checkout, raw).map(|(dir, _)| dir),
            None => validate_docs_dir_relative_path(raw),
        };
        match validated {
            Ok(dir) => {
                if !result.contains(&dir) {
                    result.push(dir);
                }
            }
            Err(reason) => {
                crate::log_verbose(&format!(
                    "[project_catalog_runtime::parse_docs_dirs] branch=reject_entry reason={reason}"
                ));
            }
        }
    }
    result
}

pub(super) fn mapping_raw_string(mapping: &Mapping, key: &str) -> Option<String> {
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

pub(super) fn mapping_url_value(mapping: &Mapping, key: &str) -> Option<String> {
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
