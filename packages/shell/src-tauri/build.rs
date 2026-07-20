fn main() {
    tauri_build::build();

    // os <-> agent gRPC client codegen. The proto must come from the
    // explicitly paired naia-agent worktree; never fall back to a sibling repo.
    use std::{
        collections::BTreeSet,
        env,
        path::{Path, PathBuf},
    };
    const REQUIRED_AGENT_COMMIT: &str = "8b6b4e019e9a4d655fa0f8e9a75cc44b93ceecc5";
    const REQUIRED_PROTO_SHA256: &str =
        "02bf7557c9b31c0e749497fdef9ab8c87fd1181f5967c9b6ed7469798fd9f26a";
    const REQUIRED_PROTO_MARKERS: &[&str] = &[
        "repeated AttachmentRef attachments = 4;",
        "message AttachmentRef",
        "optional ChannelContext channel = 11;",
        "optional GroundingRequest grounding = 12;",
        "optional ProviderSessionRequest provider_session = 13;",
        "optional ProcessingRequest processing = 14;",
        "GroundingEvent grounding = 17;",
        "ArtifactEvent artifact = 18;",
        "ProviderSessionEvent provider_session = 19;",
        "ProcessingDisclosureEvent processing_disclosure = 20;",
        "rpc Shutdown(ShutdownRequest) returns (Ack);",
        "message ShutdownRequest { string nonce = 1; }",
        "enum WireErrorCode",
        "ATTACHMENT_INVALID_REF",
    ];
    fn git_output(dir: &Path, args: &[&str]) -> Option<String> {
        std::process::Command::new("git")
            .args(["-C", dir.to_str()?,])
            .args(args)
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .map(|value| value.trim().to_string())
    }

    fn git_root_for_path(path: &Path) -> String {
        let dir = if path.is_file() {
            path.parent().expect("file path must have a parent")
        } else {
            path
        };
        git_output(dir, &["rev-parse", "--show-toplevel"])
            .unwrap_or_else(|| panic!("path must be inside a git checkout: {}", path.display()))
            .replace('\\', "/")
    }

    fn canonical_string(path: &Path) -> String {
        std::fs::canonicalize(path)
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .replace('\\', "/")
    }

    fn git_path(root: &Path, args: &[&str]) -> Option<PathBuf> {
        let raw = git_output(root, args)?;
        let path = PathBuf::from(raw);
        Some(if path.is_absolute() {
            path
        } else {
            root.join(path)
        })
    }

    fn emit_rerun_if_changed(path: &Path) {
        println!("cargo:rerun-if-changed={}", path.display());
    }

    fn register_paired_checkout_rerun_inputs(root: &Path, proto: &Path, script: &Path) {
        let mut watched_dirs = BTreeSet::new();
        watched_dirs.insert(root.to_path_buf());
        emit_rerun_if_changed(proto);
        emit_rerun_if_changed(script);

        if let Some(git_dir) = git_path(root, &["rev-parse", "--git-dir"]) {
            emit_rerun_if_changed(&git_dir.join("HEAD"));
            emit_rerun_if_changed(&git_dir.join("index"));
        }
        if let Some(common_git_dir) = git_path(root, &["rev-parse", "--git-common-dir"]) {
            emit_rerun_if_changed(&common_git_dir.join("packed-refs"));
            if let Some(head_ref) = git_output(root, &["symbolic-ref", "--quiet", "HEAD"]) {
                emit_rerun_if_changed(&common_git_dir.join(head_ref));
            }
        }

        let tracked_files = git_output(root, &["ls-files"])
            .unwrap_or_else(|| panic!("paired naia-agent tracked file list unavailable"));
        for rel in tracked_files.lines().filter(|line| !line.trim().is_empty()) {
            let tracked = root.join(rel);
            emit_rerun_if_changed(&tracked);
            let mut parent = tracked.parent();
            while let Some(dir) = parent {
                if !dir.starts_with(root) {
                    break;
                }
                watched_dirs.insert(dir.to_path_buf());
                if dir == root {
                    break;
                }
                parent = dir.parent();
            }
        }
        for dir in watched_dirs {
            emit_rerun_if_changed(&dir);
        }
    }

    println!("cargo:rerun-if-env-changed=NAIA_AGENT_PROTO_DIR");
    println!("cargo:rerun-if-env-changed=NAIA_AGENT_SCRIPT");
    let agent_script = PathBuf::from(env::var("NAIA_AGENT_SCRIPT").expect(
        "NAIA_AGENT_SCRIPT must point to the paired naia-agent scripts/builds/agent-stdio-entry.mjs",
    ));
    if !agent_script.is_file() {
        panic!(
            "NAIA_AGENT_SCRIPT not found at {} (set it to the paired agent-stdio-entry.mjs)",
            agent_script.display()
        );
    }
    let proto_dir = PathBuf::from(env::var("NAIA_AGENT_PROTO_DIR").expect(
        "NAIA_AGENT_PROTO_DIR must point to the paired naia-agent/src/main/adapters/grpc directory",
    ));
    let proto = proto_dir.join("naia_agent.proto");
    if !proto.is_file() {
        panic!(
            "naia_agent.proto not found at {} (set NAIA_AGENT_PROTO_DIR to the paired agent worktree)",
            proto.display()
        );
    }
    use sha2::{Digest, Sha256};
    let proto_bytes = std::fs::read(&proto).expect("failed to read naia_agent.proto for hashing");
    let proto_text =
        String::from_utf8(proto_bytes.clone()).expect("naia_agent.proto must be UTF-8");
    for marker in REQUIRED_PROTO_MARKERS {
        if !proto_text.contains(marker) {
            panic!(
                "naia_agent.proto is missing UC-WIRE-V1 marker `{marker}`; use the exact paired naia-agent checkout {REQUIRED_AGENT_COMMIT}"
            );
        }
    }
    let proto_sha256 = format!("{:x}", Sha256::digest(&proto_bytes));
    if proto_sha256 != REQUIRED_PROTO_SHA256 {
        panic!(
            "NAIA_AGENT_PROTO_DIR must point to the paired naia_agent.proto SHA256 {REQUIRED_PROTO_SHA256}; got {proto_sha256}"
        );
    }
    let proto_root = git_root_for_path(&proto_dir);
    let script_root = git_root_for_path(&agent_script);
    if proto_root != script_root {
        panic!(
            "NAIA_AGENT_SCRIPT and NAIA_AGENT_PROTO_DIR must come from the same checkout: {script_root} != {proto_root}"
        );
    }
    let proto_root_path = PathBuf::from(&proto_root);
    let expected_agent_script = proto_root_path.join("scripts/builds/agent-stdio-entry.mjs");
    let paired_agent_script = canonical_string(&expected_agent_script);
    register_paired_checkout_rerun_inputs(&proto_root_path, &proto, &expected_agent_script);
    if canonical_string(&agent_script) != paired_agent_script {
        panic!(
            "NAIA_AGENT_SCRIPT must be scripts/builds/agent-stdio-entry.mjs from the paired checkout; got {}",
            agent_script.display()
        );
    }
    let paired_agent_script_sha256 = format!(
        "{:x}",
        Sha256::digest(
            std::fs::read(&expected_agent_script)
                .expect("failed to read paired agent entrypoint for hashing")
        )
    );
    let expected_proto_dir = proto_root_path.join("src/main/adapters/grpc");
    if canonical_string(&proto_dir) != canonical_string(&expected_proto_dir) {
        panic!(
            "NAIA_AGENT_PROTO_DIR must be src/main/adapters/grpc from the paired checkout; got {}",
            proto_dir.display()
        );
    }
    let agent_commit = git_output(&proto_root_path, &["rev-parse", "HEAD"])
        .unwrap_or_else(|| "uncommitted-worktree".to_string());
    if agent_commit != REQUIRED_AGENT_COMMIT {
        panic!(
            "NAIA_AGENT_PROTO_DIR must point to exact paired naia-agent commit {REQUIRED_AGENT_COMMIT}; got {agent_commit}"
        );
    }
    let proto_dirty = git_output(
        &proto_root_path,
        &[
            "status",
            "--porcelain",
            "--",
            "src/main/adapters/grpc/naia_agent.proto",
        ],
    )
    .map_or(true, |output| !output.is_empty());
    if proto_dirty {
        panic!("NAIA_AGENT_PROTO_DIR paired naia_agent.proto must be clean");
    }
    let agent_script_dirty = git_output(
        &proto_root_path,
        &[
            "status",
            "--porcelain",
            "--",
            "scripts/builds/agent-stdio-entry.mjs",
        ],
    )
    .map_or(true, |output| !output.is_empty());
    if agent_script_dirty {
        panic!("NAIA_AGENT_SCRIPT paired agent-stdio-entry.mjs must be clean");
    }
    let checkout_dirty = git_output(&proto_root_path, &["status", "--porcelain"])
        .map_or(true, |output| !output.is_empty());
    if checkout_dirty {
        panic!("paired naia-agent checkout must be clean");
    }
    println!("cargo:rustc-env=NAIA_AGENT_PAIRED_ROOT={proto_root}");
    println!("cargo:rustc-env=NAIA_AGENT_PAIRED_SCRIPT={paired_agent_script}");
    println!("cargo:rustc-env=NAIA_AGENT_REQUIRED_COMMIT={REQUIRED_AGENT_COMMIT}");
    println!("cargo:rustc-env=NAIA_AGENT_PAIRED_PROTO_SHA256={proto_sha256}");
    println!("cargo:rustc-env=NAIA_AGENT_PAIRED_SCRIPT_SHA256={paired_agent_script_sha256}");
    println!("cargo:warning=NAIA_AGENT_REQUIRED_COMMIT={REQUIRED_AGENT_COMMIT}");
    println!("cargo:warning=NAIA_AGENT_PAIRED_COMMIT={agent_commit}");
    println!("cargo:warning=NAIA_AGENT_PROTO_SHA256={proto_sha256}");
    println!("cargo:warning=NAIA_AGENT_PAIRED_DIRTY={proto_dirty}");
    println!("cargo:warning=NAIA_AGENT_SCRIPT_DIRTY={agent_script_dirty}");
    println!("cargo:warning=NAIA_AGENT_CHECKOUT_DIRTY={checkout_dirty}");
    std::env::set_var(
        "PROTOC",
        protoc_bin_vendored::protoc_bin_path().expect("vendored protoc path"),
    );
    tonic_build::configure()
        .build_server(false)
        .compile_protos(&[proto.as_path()], &[proto_dir.as_path()])
        .expect("naia_agent.proto gRPC client codegen failed");

    // Set rpath so the binary finds libvosk.so next to itself
    #[cfg(target_os = "linux")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN:$ORIGIN/../lib/Naia");
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path");
}
