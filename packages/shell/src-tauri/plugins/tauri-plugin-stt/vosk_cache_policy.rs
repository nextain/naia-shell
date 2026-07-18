use std::path::Path;

pub fn cache_is_verified(vosk_dir: &Path, runtime_files: &[&str], expected_sha256: &str) -> bool {
    runtime_files
        .iter()
        .all(|file| vosk_dir.join(file).is_file())
        && std::fs::read_to_string(vosk_dir.join(".archive.sha256"))
            .map(|value| value.trim() == expected_sha256)
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::cache_is_verified;
    use std::path::PathBuf;

    fn fixture() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "naia-vosk-cache-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn accepts_only_matching_marker_and_complete_runtime_set() {
        let dir = fixture();
        std::fs::write(dir.join("libvosk.dll"), b"dll").unwrap();
        std::fs::write(dir.join("runtime.dll"), b"runtime").unwrap();
        std::fs::write(dir.join(".archive.sha256"), "expected\n").unwrap();
        assert!(cache_is_verified(
            &dir,
            &["libvosk.dll", "runtime.dll"],
            "expected"
        ));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_missing_wrong_or_incomplete_cache() {
        let dir = fixture();
        std::fs::write(dir.join("libvosk.dll"), b"dll").unwrap();
        assert!(!cache_is_verified(&dir, &["libvosk.dll"], "expected"));
        std::fs::write(dir.join(".archive.sha256"), "wrong\n").unwrap();
        assert!(!cache_is_verified(&dir, &["libvosk.dll"], "expected"));
        std::fs::write(dir.join(".archive.sha256"), "expected\n").unwrap();
        assert!(!cache_is_verified(
            &dir,
            &["libvosk.dll", "runtime.dll"],
            "expected"
        ));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
