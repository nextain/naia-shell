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
    #[allow(dead_code)]
    pub(crate) coding_app: Option<String>,
    pub(crate) docs_dirs: Vec<String>,
    pub(crate) class: Option<ProjectClassConfig>,
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedProjectCheckout {
    pub(crate) project_path: PathBuf,
    pub(crate) checkout_path: PathBuf,
    pub(crate) checkout_relative_path: String,
}

mod checkout;
pub(crate) mod class_reset;
mod config;
pub(crate) mod docs;
mod url_validation;
mod yaml_helpers;

pub(crate) use checkout::{resolve_checkout_from_parts, resolve_project_checkout};
#[cfg(test)]
pub(crate) use class_reset::{reset_class_project, ProjectClassBackupManifest};
pub(crate) use config::read_project_runtime_config;
#[cfg(test)]
pub(crate) use docs::{
    list_project_docs, list_project_docs_with_caps, read_project_doc,
    MAX_PROJECT_DOC_VISITED_ENTRIES,
};
pub(crate) use url_validation::validate_project_url;
#[cfg(test)]
pub(crate) use yaml_helpers::{validate_docs_dir_in_checkout, validate_docs_dir_relative_path};
pub(crate) use yaml_helpers::{parse_project_catalog_fields, ProjectClassConfig};

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
        // Windows CI temp dirs can be 8.3 short names (for example a RUNNER~1
        // user directory). The catalog accepts only canonical paths, so
        // fixtures start from the canonical temp root.
        let root = dunce::canonicalize(temp.path()).expect("canonical temporary root");
        let adapter = root.join("projects").join("adapter");
        let project = adapter.join("projects").join("sample");
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

    #[test]
    fn runtime_config_prefers_docs_and_tasks_url_aliases() {
        let (_temp, authority, adapter, project) = project_fixture("owner/Hello-World");
        fs::write(
            project.join("project.yaml"),
            "version: 1\nproject:\n  id: sample\n  repository: owner/Hello-World\n  dashboard_url: https://legacy.example.test/dashboard\n  docs_url: https://docs.example.test/winner\n  issues_url: https://legacy.example.test/issues\n  tasks_url: https://tasks.example.test/winner\n",
        )
        .unwrap();

        let config = read_project_runtime_config(
            &authority,
            &adapter.to_string_lossy(),
            &project.to_string_lossy(),
        )
        .unwrap();
        assert_eq!(
            config.dashboard_url.as_deref(),
            Some("https://docs.example.test/winner")
        );
        assert_eq!(
            config.issues_url.as_deref(),
            Some("https://tasks.example.test/winner")
        );
    }

    #[test]
    fn validates_docs_dirs_and_rejects_abs_parent_backslash_empty_symlink_and_outside() {
        let (_temp, _authority, adapter, _project) = project_fixture("owner/Hello-World");
        let checkout = adapter.join("checkouts").join("Hello-World");
        fs::create_dir_all(checkout.join("domain/sub")).unwrap();
        let checkout = dunce::canonicalize(&checkout).unwrap();

        for invalid in [
            "",
            "   ",
            "/etc",
            "../outside",
            "domain/../../outside",
            "domain\\sub",
            ".hidden",
            "domain/.hidden",
            "C:foo",
        ] {
            assert!(
                validate_docs_dir_relative_path(invalid).is_err(),
                "expected {invalid:?} to be rejected"
            );
            assert!(
                validate_docs_dir_in_checkout(&checkout, invalid).is_err(),
                "expected {invalid:?} to be rejected in checkout"
            );
        }

        let (norm, existing) = validate_docs_dir_in_checkout(&checkout, "domain/sub").unwrap();
        assert_eq!(norm, "domain/sub");
        assert!(existing.is_some());

        let (norm_missing, missing_path) =
            validate_docs_dir_in_checkout(&checkout, "missing-dir").unwrap();
        assert_eq!(norm_missing, "missing-dir");
        assert!(missing_path.is_none());

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let outside = tempfile::tempdir().unwrap();
            fs::create_dir_all(outside.path().join("escaped")).unwrap();
            symlink(
                outside.path().join("escaped"),
                checkout.join("linked-outside"),
            )
            .unwrap();
            assert_eq!(
                validate_docs_dir_in_checkout(&checkout, "linked-outside").unwrap_err(),
                "docs_dir_symlink"
            );
            assert_eq!(
                validate_docs_dir_in_checkout(&checkout, "linked-outside/nested").unwrap_err(),
                "docs_dir_symlink"
            );
        }
    }

    #[test]
    fn docs_list_and_read_enforce_confinement_hidden_skip_depth_and_size_caps() {
        let (_temp, authority, adapter, project) = project_fixture("owner/Hello-World");
        let checkout = adapter.join("checkouts").join("Hello-World");
        fs::create_dir_all(checkout.join("domain/nested")).unwrap();
        fs::create_dir_all(checkout.join("자료")).unwrap();
        fs::create_dir_all(checkout.join("unconfigured")).unwrap();
        fs::create_dir_all(checkout.join("domain/.hidden_dir")).unwrap();

        fs::write(checkout.join("domain/guide.md"), "# Guide\nHello world").unwrap();
        fs::write(checkout.join("domain/nested/UPPER.MD"), "# Upper").unwrap();
        fs::write(checkout.join("domain/notes.txt"), "not markdown").unwrap();
        fs::write(checkout.join("domain/.secret.md"), "hidden file").unwrap();
        fs::write(checkout.join("domain/.hidden_dir/inside.md"), "hidden dir").unwrap();
        fs::write(checkout.join("자료/intro.md"), "# 수업 소개").unwrap();
        fs::write(checkout.join("unconfigured/outside.md"), "# Unconfigured").unwrap();

        // Depth 8 file (allowed) vs Depth 9 file (beyond depth 8 cap)
        let depth8_dir = checkout.join("domain/d1/d2/d3/d4/d5/d6/d7");
        let depth9_dir = depth8_dir.join("d8");
        fs::create_dir_all(&depth9_dir).unwrap();
        fs::write(depth8_dir.join("ok-depth8.md"), "depth 8").unwrap();
        fs::write(depth9_dir.join("too-deep.md"), "depth 9").unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let outside = tempfile::tempdir().unwrap();
            fs::write(outside.path().join("leak.md"), "secret").unwrap();
            symlink(
                outside.path().join("leak.md"),
                checkout.join("domain/symlink.md"),
            )
            .unwrap();
        }

        fs::write(
            project.join("project.yaml"),
            "version: 1\nproject:\n  id: sample\n  repository: owner/Hello-World\n  docs_dirs:\n    - domain\n    - 자료\n    - student-notes\n",
        )
        .unwrap();

        let adapter_str = adapter.to_string_lossy().into_owned();
        let project_str = project.to_string_lossy().into_owned();

        let listed = list_project_docs(&authority, &adapter_str, &project_str).unwrap();
        let paths = listed
            .iter()
            .map(|entry| (entry.dir.as_str(), entry.relative_path.as_str()))
            .collect::<Vec<_>>();
        assert!(paths.contains(&("domain", "domain/guide.md")));
        assert!(paths.contains(&("domain", "domain/nested/UPPER.MD")));
        assert!(paths.contains(&("domain", "domain/d1/d2/d3/d4/d5/d6/d7/ok-depth8.md")));
        assert!(paths.contains(&("자료", "자료/intro.md")));
        assert!(!paths.iter().any(|(_, rel)| rel.contains(".secret")
            || rel.contains(".hidden")
            || rel.contains("notes.txt")
            || rel.contains("too-deep.md")
            || rel.contains("symlink.md")
            || rel.contains("outside.md")));

        let content =
            read_project_doc(&authority, &adapter_str, &project_str, "domain/guide.md").unwrap();
        assert_eq!(content, "# Guide\nHello world");

        for rejected in [
            "../project.yaml",
            "domain/../unconfigured/outside.md",
            "unconfigured/outside.md",
            "domain/.secret.md",
            "domain/notes.txt",
            "/etc/passwd",
        ] {
            assert!(
                read_project_doc(&authority, &adapter_str, &project_str, rejected).is_err(),
                "expected read_project_doc to reject {rejected:?}"
            );
        }

        #[cfg(unix)]
        assert_eq!(
            read_project_doc(&authority, &adapter_str, &project_str, "domain/symlink.md")
                .unwrap_err(),
            "doc_symlink_rejected"
        );

        let oversized_path = checkout.join("domain/oversized.md");
        fs::write(&oversized_path, vec![b'a'; 1024 * 1024 + 1]).unwrap();
        assert_eq!(
            read_project_doc(&authority, &adapter_str, &project_str, "domain/oversized.md")
                .unwrap_err(),
            "doc_too_large"
        );
    }

    #[test]
    fn docs_list_caps_entries_at_two_thousand_and_visited_entries_at_twenty_thousand() {
        assert_eq!(MAX_PROJECT_DOC_VISITED_ENTRIES, 20_000);
        let (_temp, authority, adapter, project) = project_fixture("owner/Hello-World");
        let checkout = adapter.join("checkouts").join("Hello-World");
        let bulk_dir = checkout.join("domain");
        fs::create_dir_all(&bulk_dir).unwrap();
        for index in 0..2005 {
            fs::write(bulk_dir.join(format!("doc-{index:04}.md")), "# Doc").unwrap();
        }
        fs::write(
            project.join("project.yaml"),
            "version: 1\nproject:\n  id: sample\n  repository: owner/Hello-World\n  docs_dirs:\n    - domain\n",
        )
        .unwrap();

        let listed = list_project_docs(
            &authority,
            &adapter.to_string_lossy(),
            &project.to_string_lossy(),
        )
        .unwrap();
        assert_eq!(listed.len(), 2000);

        let visited_capped = list_project_docs_with_caps(
            &authority,
            &adapter.to_string_lossy(),
            &project.to_string_lossy(),
            2000,
            25,
        )
        .unwrap();
        assert_eq!(visited_capped.len(), 25);
    }

    fn run_test_git(dir: &std::path::Path, args: &[&str]) -> String {
        let mut cmd = std::process::Command::new("git");
        cmd.current_dir(dir).args(args);
        for key in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_OBJECT_DIRECTORY",
            "GIT_COMMON_DIR",
        ] {
            cmd.env_remove(key);
        }
        if let Some(parent) = dir.parent() {
            cmd.env("GIT_CEILING_DIRECTORIES", parent);
        }
        let out = cmd.output().expect("git command in test");
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    }

    #[test]
    fn class_reset_happy_path_backs_up_student_work_and_restores_baseline_preserving_ignored() {
        let (_temp, authority, adapter, project) = project_fixture("owner/practice-repo");
        let checkout = adapter.join("checkouts").join("practice-repo");
        fs::create_dir_all(checkout.join("domain")).unwrap();
        fs::write(checkout.join(".gitignore"), "ignored.log\n").unwrap();
        fs::write(checkout.join("domain/lesson.md"), "baseline lesson\n").unwrap();
        fs::write(checkout.join("domain/to-delete.md"), "will be deleted\n").unwrap();

        run_test_git(&checkout, &["init"]);
        run_test_git(&checkout, &["add", "."]);
        run_test_git(
            &checkout,
            &[
                "-c",
                "user.name=test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-m",
                "baseline",
            ],
        );
        let baseline_sha = run_test_git(&checkout, &["rev-parse", "HEAD"]);

        fs::write(
            project.join("project.yaml"),
            format!(
                "version: 1\nproject:\n  id: sample\n  repository: owner/practice-repo\n  class:\n    baseline_ref: {baseline_sha}\n"
            ),
        )
        .unwrap();

        // Student modifications: modify tracked, delete one, add untracked, add ignored
        fs::write(checkout.join("domain/lesson.md"), "student modified\n").unwrap();
        fs::remove_file(checkout.join("domain/to-delete.md")).unwrap();
        fs::write(checkout.join("domain/student-notes.md"), "new untracked\n").unwrap();
        fs::write(checkout.join("ignored.log"), "keep me\n").unwrap();

        let registry = crate::project_agent_pty::new_project_agent_registry();
        let adapter_str = adapter.to_string_lossy().into_owned();
        let project_str = project.to_string_lossy().into_owned();

        let result = reset_class_project(
            &authority,
            &registry,
            &adapter_str,
            &project_str,
            Some("20261025-120000"),
        )
        .unwrap();

        assert_eq!(
            result.backup_relative_path,
            "class-backups/practice-repo-20261025-120000"
        );
        assert_eq!(result.backed_up_files, 2);
        assert_eq!(result.deleted_files, 1);

        let backup_dir = adapter.join(&result.backup_relative_path);
        assert_eq!(
            fs::read_to_string(backup_dir.join("files/domain/lesson.md")).unwrap(),
            "student modified\n"
        );
        assert_eq!(
            fs::read_to_string(backup_dir.join("files/domain/student-notes.md")).unwrap(),
            "new untracked\n"
        );
        let manifest: ProjectClassBackupManifest =
            serde_json::from_str(&fs::read_to_string(backup_dir.join("manifest.json")).unwrap())
                .unwrap();
        assert_eq!(manifest.baseline_ref, baseline_sha);
        assert_eq!(manifest.previous_head, baseline_sha);
        assert_eq!(
            manifest.files,
            vec![
                "domain/lesson.md".to_owned(),
                "domain/student-notes.md".to_owned()
            ]
        );
        assert_eq!(manifest.deleted, vec!["domain/to-delete.md".to_owned()]);

        // Checkout restored to baseline, untracked removed, ignored kept
        assert_eq!(
            fs::read_to_string(checkout.join("domain/lesson.md")).unwrap(),
            "baseline lesson\n"
        );
        assert_eq!(
            fs::read_to_string(checkout.join("domain/to-delete.md")).unwrap(),
            "will be deleted\n"
        );
        assert!(!checkout.join("domain/student-notes.md").exists());
        assert_eq!(
            fs::read_to_string(checkout.join("ignored.log")).unwrap(),
            "keep me\n"
        );

        // Second reset with the same timestamp fails with backup_exists without touching checkout
        fs::write(checkout.join("domain/lesson.md"), "second edit\n").unwrap();
        let err = reset_class_project(
            &authority,
            &registry,
            &adapter_str,
            &project_str,
            Some("20261025-120000"),
        )
        .unwrap_err();
        assert_eq!(err, "backup_exists");
        assert_eq!(
            fs::read_to_string(checkout.join("domain/lesson.md")).unwrap(),
            "second edit\n"
        );
    }

    #[test]
    fn class_reset_refuses_checkout_without_own_git_inside_outer_git_repo_and_checks_errors() {
        let (_temp, authority, adapter, project) = project_fixture("owner/practice-repo");
        let root = adapter.parent().unwrap().parent().unwrap();

        // Initialize an outer git repo at the temp root
        fs::write(root.join("outer.txt"), "outer untouched\n").unwrap();
        run_test_git(root, &["init"]);
        run_test_git(root, &["add", "outer.txt"]);
        run_test_git(
            root,
            &[
                "-c",
                "user.name=test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-m",
                "outer commit",
            ],
        );
        let outer_sha = run_test_git(root, &["rev-parse", "HEAD"]);
        fs::write(root.join("outer.txt"), "outer dirty\n").unwrap();

        // Checkout inside adapter has NO .git of its own
        let checkout = adapter.join("checkouts").join("practice-repo");
        fs::create_dir_all(&checkout).unwrap();
        fs::write(checkout.join("work.txt"), "student work\n").unwrap();

        let registry = crate::project_agent_pty::new_project_agent_registry();
        let adapter_str = adapter.to_string_lossy().into_owned();
        let project_str = project.to_string_lossy().into_owned();

        // 1. Non-class project (no class.baseline_ref)
        let non_class_err =
            reset_class_project(&authority, &registry, &adapter_str, &project_str, None)
                .unwrap_err();
        assert_eq!(non_class_err, "not_class_project");

        // 2. Class project with invalid baseline_ref format -> not_class_project
        fs::write(
            project.join("project.yaml"),
            "version: 1\nproject:\n  id: sample\n  repository: owner/practice-repo\n  class:\n    baseline_ref: 'not-hex!'\n",
        )
        .unwrap();
        assert_eq!(
            reset_class_project(&authority, &registry, &adapter_str, &project_str, None)
                .unwrap_err(),
            "not_class_project"
        );

        // 3. Valid baseline_ref, but checkout lacks its own .git -> not_git_repo (outer unchanged)
        fs::write(
            project.join("project.yaml"),
            format!(
                "version: 1\nproject:\n  id: sample\n  repository: owner/practice-repo\n  class:\n    baseline_ref: {outer_sha}\n"
            ),
        )
        .unwrap();
        assert_eq!(
            reset_class_project(&authority, &registry, &adapter_str, &project_str, None)
                .unwrap_err(),
            "not_git_repo"
        );
        assert_eq!(
            fs::read_to_string(root.join("outer.txt")).unwrap(),
            "outer dirty\n"
        );
        assert_eq!(
            fs::read_to_string(checkout.join("work.txt")).unwrap(),
            "student work\n"
        );

        // 4. Initialize checkout's own .git, test missing baseline commit -> baseline_missing
        run_test_git(&checkout, &["init"]);
        run_test_git(&checkout, &["add", "work.txt"]);
        run_test_git(
            &checkout,
            &[
                "-c",
                "user.name=test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-m",
                "init checkout",
            ],
        );
        fs::write(
            project.join("project.yaml"),
            "version: 1\nproject:\n  id: sample\n  repository: owner/practice-repo\n  class:\n    baseline_ref: deadbeefdeadbeef\n",
        )
        .unwrap();
        assert_eq!(
            reset_class_project(&authority, &registry, &adapter_str, &project_str, None)
                .unwrap_err(),
            "baseline_missing"
        );

        // 5. Register active agent session via production spawn key derivation -> agent_running
        crate::project_agent_pty::register_test_session_via_spawn_key_derivation(
            &registry,
            &authority,
            &adapter_str,
            &project_str,
            "opencode",
        )
        .unwrap();
        {
            let state = registry.lock().unwrap();
            let (live, terminating) = crate::project_agent_pty::session_activity_for_project(
                state
                    .sessions
                    .iter()
                    .map(|(key, handle)| (key, handle.termination_requested)),
                &project,
            );
            assert!(live);
            assert!(!terminating);
        }
        assert_eq!(
            reset_class_project(&authority, &registry, &adapter_str, &project_str, None)
                .unwrap_err(),
            "agent_running"
        );
    }

    #[test]
    fn class_reset_preserves_student_root_manifest_json_alongside_generated_manifest() {
        let (_temp, authority, adapter, project) = project_fixture("owner/practice-repo");
        let checkout = adapter.join("checkouts").join("practice-repo");
        fs::create_dir_all(&checkout).unwrap();
        fs::write(checkout.join("README.md"), "# Practice\n").unwrap();

        run_test_git(&checkout, &["init"]);
        run_test_git(&checkout, &["add", "."]);
        run_test_git(
            &checkout,
            &[
                "-c",
                "user.name=test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-m",
                "baseline",
            ],
        );
        let baseline_sha = run_test_git(&checkout, &["rev-parse", "HEAD"]);

        fs::write(
            project.join("project.yaml"),
            format!(
                "version: 1\nproject:\n  id: sample\n  repository: owner/practice-repo\n  class:\n    baseline_ref: {baseline_sha}\n"
            ),
        )
        .unwrap();

        let student_manifest_body = "{\"student\":\"custom-manifest-data\"}\n";
        fs::write(checkout.join("manifest.json"), student_manifest_body).unwrap();

        let registry = crate::project_agent_pty::new_project_agent_registry();
        let result = reset_class_project(
            &authority,
            &registry,
            &adapter.to_string_lossy(),
            &project.to_string_lossy(),
            Some("20261025-130000"),
        )
        .unwrap();

        assert_eq!(result.backed_up_files, 1);
        let backup_dir = adapter.join(&result.backup_relative_path);
        assert_eq!(
            fs::read_to_string(backup_dir.join("files/manifest.json")).unwrap(),
            student_manifest_body
        );
        let generated_manifest: ProjectClassBackupManifest =
            serde_json::from_str(&fs::read_to_string(backup_dir.join("manifest.json")).unwrap())
                .unwrap();
        assert_eq!(generated_manifest.files, vec!["manifest.json".to_owned()]);
        assert!(!checkout.join("manifest.json").exists());
    }

    #[test]
    fn class_reset_refuses_linked_worktree_at_checkout_and_leaves_main_repo_unchanged() {
        let (_temp, authority, adapter, project) = project_fixture("owner/practice-repo");
        let root = adapter.parent().unwrap().parent().unwrap();
        let main_repo = root.join("main-repo");
        fs::create_dir_all(&main_repo).unwrap();
        fs::write(main_repo.join("main.txt"), "main baseline\n").unwrap();

        run_test_git(&main_repo, &["init"]);
        run_test_git(&main_repo, &["add", "main.txt"]);
        run_test_git(
            &main_repo,
            &[
                "-c",
                "user.name=test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-m",
                "main init",
            ],
        );
        let baseline_sha = run_test_git(&main_repo, &["rev-parse", "HEAD"]);

        let checkout = adapter.join("checkouts").join("practice-repo");
        fs::create_dir_all(checkout.parent().unwrap()).unwrap();
        run_test_git(
            &main_repo,
            &[
                "worktree",
                "add",
                "-b",
                "linked-worktree-branch",
                &checkout.to_string_lossy(),
            ],
        );
        assert!(checkout.join(".git").is_file());

        // Dirty both main repo and linked worktree
        fs::write(main_repo.join("main.txt"), "main modified\n").unwrap();
        fs::write(checkout.join("student.txt"), "worktree student file\n").unwrap();

        fs::write(
            project.join("project.yaml"),
            format!(
                "version: 1\nproject:\n  id: sample\n  repository: owner/practice-repo\n  class:\n    baseline_ref: {baseline_sha}\n"
            ),
        )
        .unwrap();

        let registry = crate::project_agent_pty::new_project_agent_registry();
        let err = reset_class_project(
            &authority,
            &registry,
            &adapter.to_string_lossy(),
            &project.to_string_lossy(),
            Some("20261025-140000"),
        )
        .unwrap_err();
        assert_eq!(err, "not_git_repo");
        assert_eq!(
            fs::read_to_string(main_repo.join("main.txt")).unwrap(),
            "main modified\n"
        );
        assert_eq!(
            fs::read_to_string(checkout.join("student.txt")).unwrap(),
            "worktree student file\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn class_reset_backs_up_and_cleans_untracked_files_with_special_and_unicode_names() {
        let (_temp, authority, adapter, project) = project_fixture("owner/practice-repo");
        let checkout = adapter.join("checkouts").join("practice-repo");
        fs::create_dir_all(&checkout).unwrap();
        fs::write(checkout.join("README.md"), "# Baseline\n").unwrap();

        run_test_git(&checkout, &["init"]);
        run_test_git(&checkout, &["add", "."]);
        run_test_git(
            &checkout,
            &[
                "-c",
                "user.name=test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-m",
                "baseline",
            ],
        );
        let baseline_sha = run_test_git(&checkout, &["rev-parse", "HEAD"]);

        fs::write(
            project.join("project.yaml"),
            format!(
                "version: 1\nproject:\n  id: sample\n  repository: owner/practice-repo\n  class:\n    baseline_ref: {baseline_sha}\n"
            ),
        )
        .unwrap();

        fs::create_dir_all(checkout.join("자료")).unwrap();
        let special_files = [
            ("note\nline2.txt", "newline content"),
            ("section:01.txt", "colon content"),
            ("slash\\name.txt", "backslash content"),
            ("자료/한글 연습.md", "korean content"),
            ("student notes.txt", "space content"),
        ];
        let mut created_special_files = Vec::new();
        for (rel, body) in special_files {
            match fs::write(checkout.join(rel), body) {
                Ok(()) => created_special_files.push((rel, body)),
                // NTFS-backed FUSE mounts reject names that Linux filesystems accept.
                Err(error) if error.kind() == std::io::ErrorKind::InvalidInput => {}
                Err(error) => panic!("could not create test file {rel:?}: {error}"),
            }
        }
        assert!(!created_special_files.is_empty());

        let registry = crate::project_agent_pty::new_project_agent_registry();
        let result = reset_class_project(
            &authority,
            &registry,
            &adapter.to_string_lossy(),
            &project.to_string_lossy(),
            Some("20261025-150000"),
        )
        .unwrap();

        assert_eq!(result.backed_up_files, created_special_files.len());
        let files_dir = adapter.join(&result.backup_relative_path).join("files");
        for (rel, body) in created_special_files {
            assert_eq!(
                fs::read_to_string(files_dir.join(rel)).unwrap(),
                body,
                "expected {rel:?} to be backed up under files/"
            );
            assert!(
                !checkout.join(rel).exists(),
                "expected {rel:?} to be removed from checkout by reset"
            );
        }
    }

    #[test]
    fn class_reset_blocks_agent_start_across_coding_apps_while_in_progress_and_releases_on_finish_or_failure() {
        let (_temp, authority, adapter, project) = project_fixture("owner/practice-repo");
        let checkout = adapter.join("checkouts").join("practice-repo");
        fs::create_dir_all(&checkout).unwrap();
        fs::write(checkout.join("README.md"), "# Baseline\n").unwrap();

        let adapter_str = adapter.to_string_lossy().to_string();
        let project_str = project.to_string_lossy().to_string();
        let registry = crate::project_agent_pty::new_project_agent_registry();

        // 1. Before reset, start-path judgment allows starting for this checkout.
        let resolved =
            resolve_project_checkout(&authority, &adapter_str, &project_str).unwrap();
        assert!(crate::project_agent_pty::commands::prepare_project_agent_start(
            &registry,
            &authority,
            &adapter_str,
            &project_str,
            "opencode",
        )
        .is_ok());

        // 2. While reset guard is registered for the checkout, start-path judgment rejects
        //    both the configured app (opencode) and a different coding app (claude).
        {
            let _guard = crate::project_agent_pty::acquire_project_class_reset_guard(
                &registry,
                &resolved.project_path,
                &resolved.checkout_path,
            )
            .unwrap();
            assert_eq!(
                crate::project_agent_pty::commands::prepare_project_agent_start(
                    &registry,
                    &authority,
                    &adapter_str,
                    &project_str,
                    "opencode",
                )
                .unwrap_err(),
                "class_reset_in_progress"
            );
            assert_eq!(
                crate::project_agent_pty::commands::prepare_project_agent_start(
                    &registry,
                    &authority,
                    &adapter_str,
                    &project_str,
                    "claude",
                )
                .unwrap_err(),
                "class_reset_in_progress"
            );
            assert_eq!(
                reset_class_project(&authority, &registry, &adapter_str, &project_str, None)
                    .unwrap_err(),
                "not_class_project"
            );
        }
        assert!(registry.lock().unwrap().resetting_checkouts.is_empty());

        // 3. Failure path in reset_class_project (not_git_repo) releases the reset key via Drop.
        fs::write(
            project.join("project.yaml"),
            "version: 1\nproject:\n  id: sample\n  repository: owner/practice-repo\n  class:\n    baseline_ref: deadbeefdeadbeef\n",
        )
        .unwrap();
        assert_eq!(
            reset_class_project(&authority, &registry, &adapter_str, &project_str, None)
                .unwrap_err(),
            "not_git_repo"
        );
        assert!(registry.lock().unwrap().resetting_checkouts.is_empty());
        assert!(crate::project_agent_pty::commands::prepare_project_agent_start(
            &registry,
            &authority,
            &adapter_str,
            &project_str,
            "opencode",
        )
        .is_ok());

        // 4. Panic while holding the guard also releases the reset key via Drop.
        let panic_registry = std::sync::Arc::clone(&registry);
        let panic_project_path = resolved.project_path.clone();
        let panic_checkout_path = resolved.checkout_path.clone();
        let unwind = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _guard = crate::project_agent_pty::acquire_project_class_reset_guard(
                &panic_registry,
                &panic_project_path,
                &panic_checkout_path,
            )
            .unwrap();
            panic!("simulated panic during reset");
        }));
        assert!(unwind.is_err());
        assert!(registry.lock().unwrap().resetting_checkouts.is_empty());

        // 5. Success path in reset_class_project also releases the reset key so start is allowed afterward.
        run_test_git(&checkout, &["init"]);
        run_test_git(&checkout, &["add", "."]);
        run_test_git(
            &checkout,
            &[
                "-c",
                "user.name=test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-m",
                "baseline",
            ],
        );
        let baseline_sha = run_test_git(&checkout, &["rev-parse", "HEAD"]);
        fs::write(
            project.join("project.yaml"),
            format!(
                "version: 1\nproject:\n  id: sample\n  repository: owner/practice-repo\n  class:\n    baseline_ref: {baseline_sha}\n"
            ),
        )
        .unwrap();
        reset_class_project(
            &authority,
            &registry,
            &adapter_str,
            &project_str,
            Some("20261025-160000"),
        )
        .unwrap();
        assert!(registry.lock().unwrap().resetting_checkouts.is_empty());
        assert!(crate::project_agent_pty::commands::prepare_project_agent_start(
            &registry,
            &authority,
            &adapter_str,
            &project_str,
            "claude",
        )
        .is_ok());
    }
}
