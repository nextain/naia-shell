const COMMANDS: &[&str] = &[
    "start_listening",
    "stop_listening",
    "is_available",
    "get_supported_languages",
    "check_permission",
    "request_permission",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();

    // Ensure libvosk is available for linking and bundled for runtime
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    setup_vosk();
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn setup_vosk() {
    use sha2::{Digest, Sha256};
    use std::path::PathBuf;

    let vosk_version = "0.3.45";
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let vosk_dir = out_dir.join("vosk-lib");

    // Platform-specific library name and download URL
    #[cfg(target_os = "linux")]
    let (archive_name, lib_name) = (
        format!("vosk-linux-x86_64-{vosk_version}.zip"),
        "libvosk.so",
    );
    #[cfg(target_os = "macos")]
    let (archive_name, lib_name) = (
        format!("vosk-osx-universal-{vosk_version}.zip"),
        "libvosk.dylib",
    );
    #[cfg(target_os = "windows")]
    let (archive_name, lib_name) = (format!("vosk-win64-{vosk_version}.zip"), "libvosk.dll");
    #[cfg(target_os = "linux")]
    let platform_key = "linux";
    #[cfg(target_os = "windows")]
    let platform_key = "win32";

    let matrix_path = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../../platform-matrix.json");
    println!("cargo:rerun-if-changed={}", matrix_path.display());
    let matrix: serde_json::Value = serde_json::from_slice(
        &std::fs::read(&matrix_path).expect("Failed to read platform-matrix.json"),
    )
    .expect("Failed to parse platform-matrix.json");
    let vosk_contract = &matrix["os"][platform_key]["vosk"]["archive"];
    let contracted_archive = vosk_contract["file"]
        .as_str()
        .expect("Missing Vosk archive file in platform matrix");
    let expected_sha256 = vosk_contract["sha256"]
        .as_str()
        .expect("Missing Vosk archive SHA256 in platform matrix");
    let runtime_files: Vec<&str> = matrix["os"][platform_key]["vosk"]["files"]
        .as_array()
        .expect("Missing Vosk runtime files in platform matrix")
        .iter()
        .map(|value| {
            value
                .as_str()
                .expect("Vosk runtime filename must be a string")
        })
        .collect();
    assert_eq!(
        contracted_archive, archive_name,
        "Vosk archive filename disagrees with platform matrix"
    );

    let lib_path = vosk_dir.join(lib_name);
    let archive_path = out_dir.join(&archive_name);
    let url = format!(
        "https://github.com/alphacep/vosk-api/releases/download/v{vosk_version}/{archive_name}"
    );

    let cached_archive_is_verified = std::fs::read(&archive_path)
        .map(|bytes| format!("{:x}", Sha256::digest(bytes)) == expected_sha256)
        .unwrap_or(false);
    if !cached_archive_is_verified {
        let _ = std::fs::remove_file(&archive_path);
        eprintln!("cargo:warning=Downloading verified libvosk archive from {url}");
        let status = std::process::Command::new("curl")
            .args(["-L", "-o"])
            .arg(&archive_path)
            .arg(&url)
            .status()
            .expect("Failed to run curl. Please install curl.");
        if !status.success() {
            panic!("Failed to download libvosk from {url}");
        }
    }

    let actual_sha256 = format!(
        "{:x}",
        Sha256::digest(
            std::fs::read(&archive_path).expect("Failed to read downloaded Vosk archive")
        )
    );
    if actual_sha256 != expected_sha256 {
        let _ = std::fs::remove_file(&archive_path);
        panic!("Vosk archive SHA256 mismatch: expected {expected_sha256}, got {actual_sha256}");
    }

    // Never trust extracted cache contents: rebuild them from the revalidated archive.
    if vosk_dir.exists() {
        std::fs::remove_dir_all(&vosk_dir).expect("Failed to clear extracted Vosk directory");
    }
    std::fs::create_dir_all(&vosk_dir).unwrap();
    let file = std::fs::File::open(&archive_path).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();

    #[cfg(target_os = "windows")]
    let extract_suffixes: &[&str] = &[".dll", ".lib"];
    #[cfg(not(target_os = "windows"))]
    let extract_suffixes: &[&str] = &[lib_name];

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).unwrap();
        let name = entry.name().to_string();
        let should_extract = if cfg!(target_os = "windows") {
            extract_suffixes.iter().any(|suffix| name.ends_with(suffix))
        } else {
            name.ends_with(lib_name)
        };
        if should_extract {
            let file_name = name.rsplit('/').next().unwrap_or(&name);
            let dest = vosk_dir.join(file_name);
            let mut out_file = std::fs::File::create(&dest).unwrap();
            std::io::copy(&mut entry, &mut out_file).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
    }

    if !lib_path.exists() {
        panic!("Failed to extract {lib_name} from archive");
    }
    for runtime_file in &runtime_files {
        assert!(
            vosk_dir.join(runtime_file).is_file(),
            "Vosk archive is missing contracted runtime file: {runtime_file}"
        );
    }
    eprintln!(
        "cargo:warning=Verified libvosk extracted to {}",
        lib_path.display()
    );

    // On Windows, generate .lib import library if only .dll was extracted (vosk zip has no .lib)
    #[cfg(target_os = "windows")]
    {
        let lib_file = vosk_dir.join("libvosk.lib");
        if !lib_file.exists() && vosk_dir.join("libvosk.dll").exists() {
            let def_path = vosk_dir.join("libvosk.def");
            std::fs::write(&def_path, "LIBRARY libvosk\nEXPORTS\n    vosk_model_new\n    vosk_model_free\n    vosk_model_find_word\n    vosk_recognizer_new\n    vosk_recognizer_free\n    vosk_recognizer_accept_waveform\n    vosk_recognizer_accept_waveform_s\n    vosk_recognizer_result\n    vosk_recognizer_final_result\n    vosk_recognizer_partial_result\n    vosk_recognizer_set_spk_model\n    vosk_set_log_level\n    vosk_gpu_init\n    vosk_gpu_thread_init\n    vosk_recognizer_set_max_alternatives\n    vosk_recognizer_set_words\n    vosk_recognizer_set_partial_words\n    vosk_recognizer_set_nlsml\n    vosk_recognizer_reset\n    vosk_recognizer_new_spk\n    vosk_recognizer_new_grm\n    vosk_spk_model_new\n    vosk_spk_model_free\n    vosk_batch_model_new\n    vosk_batch_model_free\n    vosk_batch_model_wait\n    vosk_batch_recognizer_new\n    vosk_batch_recognizer_free\n    vosk_batch_recognizer_accept_waveform\n    vosk_batch_recognizer_finish_stream\n    vosk_batch_recognizer_front_result\n    vosk_batch_recognizer_pop\n    vosk_batch_recognizer_get_pending_chunks\n    vosk_batch_recognizer_set_nlsml\n")
                .expect("Failed to write libvosk.def");
            let status = std::process::Command::new("lib.exe")
                .args([
                    &format!("/DEF:{}", def_path.display()),
                    &format!("/OUT:{}", lib_file.display()),
                    "/MACHINE:X64",
                ])
                .status();
            if !status.map(|s| s.success()).unwrap_or(false) {
                let _ = std::process::Command::new("dlltool")
                    .args([
                        "-d",
                        &def_path.display().to_string(),
                        "-l",
                        &lib_file.display().to_string(),
                    ])
                    .status();
            }
        }
    }

    // Tell the linker where to find libvosk
    println!("cargo:rustc-link-search=native={}", vosk_dir.display());

    // Set rpath so the binary can find libvosk at runtime
    #[cfg(target_os = "linux")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN:$ORIGIN/../lib/Naia");
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path");

    // Copy runtime libraries next to the binary AND to resources/ for installer bundling
    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let src_tauri_dir = PathBuf::from(&manifest_dir)
            .parent() // plugins
            .and_then(|p| p.parent()) // src-tauri
            .unwrap()
            .to_path_buf();
        let target_dir = src_tauri_dir.join("target");

        let profile = std::env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());
        let bin_dir = target_dir.join(&profile);
        // Create bin_dir if it doesn't exist yet (first build)
        let _ = std::fs::create_dir_all(&bin_dir);

        // Also copy to resources/ for NSIS/MSI installer bundling
        let resources_dir = src_tauri_dir.join("resources");
        let _ = std::fs::create_dir_all(&resources_dir);

        for name in &runtime_files {
            let source = vosk_dir.join(name);
            let bin_dest = bin_dir.join(name);
            std::fs::copy(&source, &bin_dest)
                .unwrap_or_else(|e| panic!("Failed to copy {name} to {}: {e}", bin_dest.display()));
            eprintln!("cargo:warning=Copied {} to {}", name, bin_dest.display());

            let res_dest = resources_dir.join(name);
            std::fs::copy(&source, &res_dest)
                .unwrap_or_else(|e| panic!("Failed to copy {name} to {}: {e}", res_dest.display()));
            eprintln!("cargo:warning=Copied {} to resources/", name);
        }
    }
}
