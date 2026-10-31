use std::fs;
use std::path::Path;

use super::config::read_project_runtime_config;
use super::{ProjectCatalogAuthority, ResolvedProjectCheckout};

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
    resolve_checkout_from_parts(
        &config.adapter_root,
        &config.project_path,
        config.repository.as_deref(),
    )
}

pub(crate) fn resolve_checkout_from_parts(
    adapter_root: &Path,
    project_path: &Path,
    repository: Option<&str>,
) -> Result<ResolvedProjectCheckout, String> {
    let repository = repository.ok_or_else(|| "repository_invalid".to_owned())?;
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
    let checkouts_root = adapter_root.join("checkouts");
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
    if canonical_checkouts.parent() != Some(adapter_root) {
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
        project_path: project_path.to_path_buf(),
        checkout_path,
        checkout_relative_path,
    })
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
