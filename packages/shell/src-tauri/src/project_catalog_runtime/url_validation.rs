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
    // WHATWG 파서는 특수 스킴의 빈 권한부를 고쳐 읽는다("http:///host" → "http://host/",
    // "http:host" → "http://host/"). 원문이 이미 `스킴://권한부` 꼴인지 먼저 본다.
    let has_authority = raw
        .split_once("://")
        .is_some_and(|(_, rest)| !rest.is_empty() && !rest.starts_with('/'));
    if !has_authority {
        crate::log_verbose(
            "[project_catalog_runtime::validate_project_url] branch=reject_missing_authority",
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
