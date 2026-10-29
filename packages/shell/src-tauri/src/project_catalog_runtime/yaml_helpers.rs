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
    yaml_source: &str,
) -> ParsedProjectCatalogFields {
    crate::log_verbose("[project_catalog_runtime::parse_project_catalog_fields] enter");
    let repository = mapping_raw_string(mapping, "repository");
    let dashboard_url = resolve_docs_url_field(mapping);
    let issues_url = resolve_tasks_url_field(mapping);
    let coding_app = parse_coding_app(mapping);
    let docs_dirs = parse_docs_dirs(mapping, checkout_path);
    let class = parse_class_config(mapping, yaml_source);
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

pub(crate) fn parse_class_config(
    mapping: &Mapping,
    yaml_source: &str,
) -> Option<ProjectClassConfig> {
    let class_mapping = mapping
        .get(YamlValue::String("class".to_owned()))?
        .as_mapping()?;
    let baseline_value = class_mapping.get(YamlValue::String("baseline_ref".to_owned()))?;
    let raw_scalar = class_baseline_ref_scalar(yaml_source)?;
    let baseline_ref = match baseline_value {
        YamlValue::String(value) => value.to_owned(),
        YamlValue::Number(number) if number.is_i64() || number.is_u64() => {
            if !is_decimal_integer_scalar(raw_scalar) || number.to_string() != raw_scalar {
                return None;
            }
            raw_scalar.to_owned()
        }
        _ => return None,
    };
    let baseline_ref = baseline_ref.trim();
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

fn class_baseline_ref_scalar(yaml_source: &str) -> Option<&str> {
    let mut class_indent = None;
    let mut class_count = 0;
    let mut baseline_ref = None;
    for line in yaml_source.lines() {
        let indentation = line.len() - line.trim_start().len();
        let content = line.trim();
        if content
            .strip_prefix("class:")
            .is_some_and(is_empty_yaml_value)
        {
            class_count += 1;
            if class_count > 1 {
                return None;
            }
            class_indent = Some(indentation);
            continue;
        }
        let Some(parent_indent) = class_indent else {
            continue;
        };
        if !content.is_empty() && !content.starts_with('#') && indentation <= parent_indent {
            class_indent = None;
            continue;
        }
        if indentation > parent_indent {
            if let Some(value) = content.strip_prefix("baseline_ref:") {
                if baseline_ref.is_some() {
                    return None;
                }
                baseline_ref = Some(value.trim().split('#').next()?.trim());
            }
        }
    }
    if class_count == 1 {
        baseline_ref
    } else {
        None
    }
}

fn is_empty_yaml_value(rest: &str) -> bool {
    let rest = rest.trim();
    rest.is_empty() || rest.starts_with('#')
}

fn is_decimal_integer_scalar(raw_scalar: &str) -> bool {
    (7..=40).contains(&raw_scalar.len()) && raw_scalar.bytes().all(|byte| byte.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::parse_class_config;
    use serde_yaml::{Mapping, Value as YamlValue};

    fn project_mapping(yaml: &str) -> Mapping {
        serde_yaml::from_str(yaml).expect("valid fixture YAML")
    }

    #[test]
    fn parses_unquoted_numeric_baseline_ref_as_a_string() {
        let yaml = "class:\n  baseline_ref: 1234567\n";
        let mapping = project_mapping(yaml);
        assert_eq!(
            parse_class_config(&mapping, yaml).map(|config| config.baseline_ref),
            Some("1234567".to_owned())
        );
    }

    #[test]
    fn retains_quoted_baseline_ref() {
        let yaml = "class:\n  baseline_ref: \"abcdef0\"\n";
        let mapping = project_mapping(yaml);
        assert_eq!(
            parse_class_config(&mapping, yaml).map(|config| config.baseline_ref),
            Some("abcdef0".to_owned())
        );
    }

    #[test]
    fn rejects_non_canonical_numeric_baseline_refs() {
        for scalar in [
            "+1234567",
            "01234567",
            "1_234_567",
            "0XABCDEF0",
            "0O12345670",
            "0B101010101010101010101010",
            "0xabcdef0",
            "1e6",
            "1.5",
        ] {
            let yaml = format!("class:\n  baseline_ref: {scalar}\n");
            let mapping = project_mapping(&yaml);
            assert!(parse_class_config(&mapping, &yaml).is_none(), "{scalar}");
        }
    }

    #[test]
    fn accepts_decimal_integer_baseline_ref() {
        let yaml = "class:\n  baseline_ref: 1234567\n";
        let mapping = project_mapping(yaml);
        assert_eq!(
            parse_class_config(&mapping, yaml).map(|config| config.baseline_ref),
            Some("1234567".to_owned())
        );
    }

    #[test]
    fn rejects_ambiguous_and_duplicate_yaml_baseline_ref_forms() {
        for yaml in [
            "class: {baseline_ref: 1234567}\n",
            "class: # inline class comment\n  baseline_ref: 1234567\n",
            "class:\n  baseline_ref : 1234567\n",
            "class:\n  baseline_ref: 1234567\n  baseline_ref: 7654321\n",
            "class:\n  baseline_ref: 1234567\nclass:\n  baseline_ref: 7654321\n",
        ] {
            if let Ok(mapping) = serde_yaml::from_str::<Mapping>(yaml) {
                assert!(parse_class_config(&mapping, yaml).is_none(), "{yaml}");
            }
        }
    }

    #[test]
    fn numeric_mapping_access_uses_yaml_value_keys() {
        let yaml = "class:\n  baseline_ref: 0XABCDEF0\n";
        let mapping = project_mapping(yaml);
        let class = mapping
            .get(&YamlValue::String("class".to_owned()))
            .and_then(YamlValue::as_mapping)
            .expect("class mapping");
        let value = class.get(&YamlValue::String("baseline_ref".to_owned()));
        assert!(value.is_some(), "serde_yaml should parse the scalar");
        assert!(parse_class_config(&mapping, yaml).is_none());
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
