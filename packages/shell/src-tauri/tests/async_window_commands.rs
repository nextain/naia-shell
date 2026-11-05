//! Source-level guard for Windows WebView2 deadlocks. Run with `rustc --test`.
use std::fs;
use std::path::Path;

fn synchronous_window_commands(source: &str) -> Vec<String> {
    let mut found = Vec::new();
    for section in source.split("#[tauri::command]").skip(1) {
        let Some(fn_pos) = section.find("fn ") else { continue };
        let prefix = &section[..fn_pos];
        if prefix.split_whitespace().last() == Some("async") { continue; }
        let after = &section[fn_pos + 3..];
        let name = after.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).next().unwrap_or("");
        // Rustfmt places the closing brace of a module-level function in column 0.
        let Some(end) = after.find("\n}") else { continue };
        let body = &after[..end];
        if ["WebviewWindowBuilder::", "WindowBuilder::", "WebviewBuilder::", ".add_child(", ".blocking_"].iter().any(|needle| body.contains(needle)) {
            found.push(name.to_string());
        }
    }
    found
}

#[test]
fn commands_creating_windows_are_async() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut violations = Vec::new();
    let mut directories = vec![root];
    while let Some(directory) = directories.pop() {
        for entry in fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                directories.push(path);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                let source = fs::read_to_string(&path).unwrap();
                for name in synchronous_window_commands(&source) {
                    violations.push(format!("{}: {name}", path.display()));
                }
            }
        }
    }
    assert!(synchronous_window_commands(include_str!("../src/app.rs")).is_empty());
    assert!(violations.is_empty(), "synchronous window commands: {violations:?}");
    assert_eq!(synchronous_window_commands("#[tauri::command]\npub fn bad() {\n WebviewWindowBuilder::new();\n}"), ["bad"]);
    assert!(synchronous_window_commands("#[tauri::command]\npub async fn good() {\n WebviewWindowBuilder::new();\n}").is_empty());
}
