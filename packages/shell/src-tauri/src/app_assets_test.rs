use super::*;

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "naia-assets-test-{}-{unique}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::create_dir(path.join("assets")).unwrap();
        fs::write(path.join("assets/index.js"), "// fixture module").unwrap();
        fs::write(path.join("assets/style.css"), "/* fixture */").unwrap();
        Self(path)
    }
    fn html(&self, html: &str) {
        fs::write(self.0.join("index.html"), html).unwrap();
    }
    fn read(&self) -> String {
        fs::read_to_string(self.0.join("index.html")).unwrap()
    }
    fn rewrite(&self) {
        rewrite_installed_app_asset_urls(&self.0).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn component_encoding_still_matches_javascript() {
    assert_eq!(encode_uri_component("C:\\x\\y.js"), "C%3A%5Cx%5Cy.js");
    assert_eq!(encode_uri_component("a/b"), "a%2Fb");
    assert_eq!(encode_uri_component("a-b_c.d~e"), "a-b_c.d~e");
}

#[test]
fn previously_installed_urls_are_repaired_and_original_is_preserved() {
    let f = Fixture::new();
    let old = format!(
        "<script src=\"http://asset.localhost/{}\"></script>",
        encode_uri_component(&f.0.join("assets/index.js").to_string_lossy())
    );
    f.html(&old);
    f.rewrite();
    let current = f.read();
    assert_ne!(current, old);
    assert!(current.contains(&asset_localhost_url(
        &f.0.join("assets/index.js").to_string_lossy()
    )));
    assert_eq!(fs::read_to_string(f.0.join(BACKUP_NAME)).unwrap(), old);
    let modified = fs::metadata(f.0.join("index.html"))
        .unwrap()
        .modified()
        .unwrap();
    f.rewrite();
    assert_eq!(f.read(), current);
    assert_eq!(
        fs::metadata(f.0.join("index.html"))
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
    assert_eq!(fs::read_to_string(f.0.join(BACKUP_NAME)).unwrap(), old);
}

#[test]
fn both_platform_asset_origins_are_migrated() {
    let f = Fixture::new();
    for prefix in ["http://asset.localhost/", "asset://localhost/"] {
        let legacy = format!(
            "{prefix}{}",
            encode_uri_component(&f.0.join("assets/index.js").to_string_lossy())
        );
        assert_eq!(
            rewrite_asset_value(&legacy, &f.0),
            asset_localhost_url(&f.0.join("assets/index.js").to_string_lossy())
        );
    }
}

#[test]
fn local_script_stylesheet_and_single_quotes_are_rewritten() {
    let f = Fixture::new();
    f.html("<script src=\"./assets/index.js\"></script><link href='assets/style.css'><img src=\"assets/missing.png\">");
    f.rewrite();
    let out = f.read();
    assert!(out.contains(&asset_localhost_url(
        &f.0.join("assets/index.js").to_string_lossy()
    )));
    assert!(out.contains(&asset_localhost_url(
        &f.0.join("assets/style.css").to_string_lossy()
    )));
    assert!(out.contains("src=\"assets/missing.png\""));
}

#[test]
fn remote_anchors_data_missing_and_malformed_urls_stay_unchanged() {
    let f = Fixture::new();
    for value in [
        "",
        "#top",
        "//cdn.example/x.js",
        "https://cdn.example/x.js",
        "data:text/plain,test",
        "blob:example",
        "mailto:example",
        "assets/missing.js",
        "assets/%FF.js",
        "assets/%G0.js",
        "assets/%",
        "http://asset.localhost.evil/x.js",
        "http://asset.localhost/assets/index.js",
    ] {
        assert_eq!(rewrite_asset_value(value, &f.0), value);
    }
}

#[test]
fn real_files_outside_package_are_not_rewritten() {
    let f = Fixture::new();
    fs::create_dir(f.0.join("other-app")).unwrap();
    let app = f.0.join("other-app");
    let absolute = format!(
        "http://asset.localhost/{}",
        encode_uri_component(&f.0.join("assets/index.js").to_string_lossy())
    );
    for value in [
        "../assets/index.js",
        "%2E%2E/assets/index.js",
        absolute.as_str(),
    ] {
        assert_eq!(rewrite_asset_value(value, &app), value);
    }
}

#[test]
fn encoded_names_and_url_suffixes_round_trip_once() {
    let f = Fixture::new();
    let file = "한글 +#%.js";
    fs::write(f.0.join("assets").join(file), "// names").unwrap();
    let value = format!("assets/{}?v=1#module", encode_uri_component(file));
    let expected = format!(
        "{}?v=1#module",
        asset_localhost_url(&f.0.join("assets").join(file).to_string_lossy())
    );
    assert_eq!(rewrite_asset_value(&value, &f.0), expected);
    assert_eq!(rewrite_asset_value(&expected, &f.0), expected);
}

#[test]
fn no_html_is_a_noop() {
    let f = Fixture::new();
    f.rewrite();
    assert!(!f.0.join("index.html").exists());
    assert!(!f.0.join(BACKUP_NAME).exists());
}

#[test]
fn unchanged_html_does_not_create_backup() {
    let f = Fixture::new();
    let html = "<a href=\"https://example.com\">unchanged</a>";
    f.html(html);
    f.rewrite();
    assert_eq!(f.read(), html);
    assert!(!f.0.join(BACKUP_NAME).exists());
}

#[test]
fn backup_failure_does_not_change_original() {
    let f = Fixture::new();
    let html = "<script src=\"assets/index.js\"></script>";
    f.html(html);
    fs::create_dir(f.0.join(BACKUP_NAME)).unwrap();
    assert!(rewrite_installed_app_asset_urls(&f.0).is_err());
    assert_eq!(f.read(), html);
}

#[test]
fn malformed_html_is_not_truncated() {
    let f = Fixture::new();
    let html = "<!doctype html><script src=\"assets/index.js";
    f.html(html);
    f.rewrite();
    assert_eq!(f.read(), html);
}

#[cfg(unix)]
#[test]
fn symlink_escape_and_index_are_not_rewritten() {
    let f = Fixture::new();
    let app = f.0.join("nested");
    fs::create_dir(&app).unwrap();
    std::os::unix::fs::symlink(f.0.join("assets"), app.join("linked")).unwrap();
    assert_eq!(
        rewrite_asset_value("linked/index.js", &app),
        "linked/index.js"
    );
    f.html("original");
    std::os::unix::fs::symlink(f.0.join("index.html"), app.join("index.html")).unwrap();
    assert!(rewrite_installed_app_asset_urls(&app).is_err());
    assert_eq!(f.read(), "original");
}

#[test]
fn asset_url_keeps_directory_segments_for_relative_worker() {
    let input = if cfg!(windows) {
        "C:\\Users\\User Name\\.naia\\apps\\land.naia.slides\\assets\\index.js"
    } else {
        "/home/User Name/.naia/apps/land.naia.slides/assets/index.js"
    };
    let url = asset_localhost_url(input);
    assert!(url.ends_with("/assets/index.js"), "{url}");
    assert!(url.contains("User%20Name"), "{url}");
    let worker = format!(
        "{}pdf.worker.min-qwK7q_zL.mjs",
        &url[..url.rfind('/').unwrap() + 1]
    );
    assert!(
        worker.ends_with("/assets/pdf.worker.min-qwK7q_zL.mjs"),
        "{worker}"
    );
}
