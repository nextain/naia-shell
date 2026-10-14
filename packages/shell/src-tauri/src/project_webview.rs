use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::project_catalog_runtime::{
    read_project_runtime_config, validate_project_url, ProjectCatalogAuthority,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProjectWebViewKind {
    Dashboard,
    Issues,
}

impl ProjectWebViewKind {
    fn parse(raw: &str) -> Result<Self, String> {
        crate::log_verbose(&format!(
            "[project_webview::ProjectWebViewKind::parse] enter view={}",
            match raw {
                "dashboard" => "dashboard",
                "issues" => "issues",
                _ => "<invalid>",
            }
        ));
        match raw {
            "dashboard" => Ok(Self::Dashboard),
            "issues" => Ok(Self::Issues),
            _ => {
                crate::log_verbose(
                    "[project_webview::ProjectWebViewKind::parse] branch=reject_unknown_view",
                );
                Err("project_url_invalid".to_owned())
            }
        }
    }

    fn as_key(self) -> &'static str {
        crate::log_verbose("[project_webview::ProjectWebViewKind::as_key] enter");
        match self {
            Self::Dashboard => "dashboard",
            Self::Issues => "issues",
        }
    }

    fn title(self) -> &'static str {
        crate::log_verbose("[project_webview::ProjectWebViewKind::title] enter");
        match self {
            Self::Dashboard => "Project Dashboard",
            Self::Issues => "Project Issues",
        }
    }
}

fn project_webview_identity(
    adapter_root: &str,
    project_path: &str,
    kind: ProjectWebViewKind,
) -> ([u8; 32], String) {
    crate::log_verbose(&format!(
        "[project_webview::project_webview_identity] enter view={}",
        kind.as_key()
    ));
    let mut hasher = Sha256::new();
    hasher.update(b"naia-shell-project-webview-v1\0");
    hasher.update(adapter_root.as_bytes());
    hasher.update([0]);
    hasher.update(project_path.as_bytes());
    hasher.update([0]);
    hasher.update(kind.as_key().as_bytes());
    let digest: [u8; 32] = hasher.finalize().into();
    let label_suffix = digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    (
        digest,
        format!("project-view-{label_suffix}-{}", kind.as_key()),
    )
}

fn project_navigation_allowed(url: &url::Url) -> bool {
    crate::log_verbose(&format!(
        "[project_webview::project_navigation_allowed] enter scheme={}",
        url.scheme()
    ));
    let allowed = matches!(url.scheme(), "http" | "https")
        && url.host().is_some()
        && url.username().is_empty()
        && url.password().is_none();
    crate::log_verbose(&format!(
        "[project_webview::project_navigation_allowed] branch=validated allowed={allowed} scheme={}",
        url.scheme()
    ));
    allowed
}

/// Open a dedicated, per-project dashboard or internal-issues window.
/// The URL is reread from the catalog-authorized project.yaml on every call.
#[tauri::command]
pub async fn project_webview_open(
    app: AppHandle,
    authority: tauri::State<'_, ProjectCatalogAuthority>,
    adapter_root: String,
    project_path: String,
    view: String,
) -> Result<bool, String> {
    let kind = ProjectWebViewKind::parse(&view)?;
    crate::log_verbose(&format!(
        "[project_webview::project_webview_open] enter view={} adapter_root_supplied=true project_path_supplied=true",
        kind.as_key()
    ));
    let config = read_project_runtime_config(&authority, &adapter_root, &project_path)?;
    let raw_url = match kind {
        ProjectWebViewKind::Dashboard => config.dashboard_url.as_deref(),
        ProjectWebViewKind::Issues => config.issues_url.as_deref(),
    }
    .filter(|value| !value.is_empty())
    .ok_or_else(|| {
        crate::log_verbose(&format!(
            "[project_webview::project_webview_open] branch=project_url_missing view={}",
            kind.as_key()
        ));
        "project_url_missing".to_owned()
    })?;
    let url = validate_project_url(raw_url).map_err(|_| {
        crate::log_verbose(&format!(
            "[project_webview::project_webview_open] branch=project_url_invalid view={} url_length={}",
            kind.as_key(),
            raw_url.len()
        ));
        "project_url_invalid".to_owned()
    })?;

    if crate::debug_e2e_enabled() {
        crate::log_verbose(&format!(
            "[project_webview::project_webview_open] branch=e2e_webview_skipped view={}",
            kind.as_key()
        ));
        return Ok(false);
    }

    let (digest, label) = project_webview_identity(
        &config.adapter_root.to_string_lossy(),
        &config.project_path.to_string_lossy(),
        kind,
    );
    if let Some(existing) = app.get_webview_window(&label) {
        existing
            .navigate(url.clone())
            .map_err(|_| "webview_unavailable".to_owned())?;
        existing
            .set_focus()
            .map_err(|_| "webview_unavailable".to_owned())?;
        crate::log_verbose(&format!(
            "[project_webview::project_webview_open] branch=focused_existing view={}",
            kind.as_key()
        ));
        return Ok(true);
    }

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "webview_unavailable".to_owned())?;
    let profile_dir = app_data.join("project-webviews").join(
        digest[..16]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
    );
    std::fs::create_dir_all(&profile_dir).map_err(|_| "webview_unavailable".to_owned())?;
    #[cfg(target_os = "macos")]
    let store_id: [u8; 16] = digest[..16].try_into().expect("fixed 16-byte hash prefix");
    let navigation = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::External(url.clone()),
    )
    .title(kind.title())
    .inner_size(1100.0, 760.0)
    .resizable(true)
    .on_navigation(move |next| {
        let allowed = project_navigation_allowed(next);
        crate::log_verbose(&format!(
            "[project_webview::project_webview_open::on_navigation] branch=checked view={} allowed={} scheme={}",
            kind.as_key(),
            allowed,
            next.scheme()
        ));
        allowed
    });
    #[cfg(target_os = "macos")]
    let navigation = navigation.data_store_identifier(store_id);
    #[cfg(not(target_os = "macos"))]
    let navigation = navigation.data_directory(PathBuf::from(profile_dir));
    navigation.build().map_err(|_| {
        crate::log_verbose(&format!(
            "[project_webview::project_webview_open] branch=window_build_failed view={}",
            kind.as_key()
        ));
        "webview_unavailable".to_owned()
    })?;
    crate::log_verbose(&format!(
        "[project_webview::project_webview_open] branch=window_created view={}",
        kind.as_key()
    ));
    Ok(true)
}

#[cfg(test)]
mod project_webview_tests {
    use super::*;

    #[test]
    fn project_webview_identity_isolated_by_project_and_view() {
        let (first, first_label) = project_webview_identity(
            "/workspace/adapter",
            "/workspace/adapter/projects/one",
            ProjectWebViewKind::Dashboard,
        );
        let (second, second_label) = project_webview_identity(
            "/workspace/adapter",
            "/workspace/adapter/projects/two",
            ProjectWebViewKind::Dashboard,
        );
        let (third, third_label) = project_webview_identity(
            "/workspace/adapter",
            "/workspace/adapter/projects/one",
            ProjectWebViewKind::Issues,
        );

        assert_ne!(first, second);
        assert_ne!(first, third);
        assert_ne!(first_label, second_label);
        assert_ne!(first_label, third_label);
        assert!(!first_label.contains("workspace"));
    }

    #[test]
    fn project_webview_navigation_allows_only_http_or_https_without_credentials() {
        for raw in ["http://localhost:3000/", "https://example.test/issues"] {
            assert!(project_navigation_allowed(&url::Url::parse(raw).unwrap()));
        }
        for raw in [
            "file:///tmp/page",
            "javascript:alert(1)",
            "https://user:secret@example.test/",
        ] {
            assert!(!project_navigation_allowed(&url::Url::parse(raw).unwrap()));
        }
    }

    #[test]
    fn project_webview_kind_accepts_only_dashboard_and_issues() {
        assert_eq!(
            ProjectWebViewKind::parse("dashboard").unwrap(),
            ProjectWebViewKind::Dashboard
        );
        assert_eq!(
            ProjectWebViewKind::parse("issues").unwrap(),
            ProjectWebViewKind::Issues
        );
        assert_eq!(
            ProjectWebViewKind::parse("browser"),
            Err("project_url_invalid".to_owned())
        );
    }
}
