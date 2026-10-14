use serde_yaml::{Mapping, Value as YamlValue};

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
