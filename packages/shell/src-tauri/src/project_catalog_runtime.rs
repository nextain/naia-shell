use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

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

mod checkout;
mod config;
mod url_validation;
mod yaml_helpers;

pub(crate) use checkout::resolve_project_checkout;
pub(crate) use config::read_project_runtime_config;
pub(crate) use url_validation::validate_project_url;
pub(crate) use yaml_helpers::project_catalog_fields;

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

    #[cfg(windows)]
    #[test]
    fn project_agent_pty_catalog_accepts_verbatim_paths_as_the_same_authorized_paths() {
        let (_temp, authority, adapter, project) = project_fixture("owner/Hello-World");
        let expected = read_project_runtime_config(
            &authority,
            &adapter.to_string_lossy(),
            &project.to_string_lossy(),
        )
        .unwrap();
        let verbatim_adapter = format!(r"\\?\{}", dunce::canonicalize(&adapter).unwrap().display());
        let verbatim_project = format!(r"\\?\{}", dunce::canonicalize(&project).unwrap().display());

        let actual =
            read_project_runtime_config(&authority, &verbatim_adapter, &verbatim_project).unwrap();

        assert_eq!(actual.adapter_root, expected.adapter_root);
        assert_eq!(actual.project_path, expected.project_path);
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
