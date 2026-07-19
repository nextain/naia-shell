fn main() {
    tauri_build::build();

    // ── os↔agent gRPC 클라이언트 코드젠 (정본 transport=gRPC) ──────────────────────
    // naia_agent.proto SoT = sibling repo naia-agent. protoc = vendored(시스템 설치 불요).
    // os = client only(build_server=false). 생성 코드는 OUT_DIR → agent_grpc 모듈이 include_proto!.
    use std::{env, path::PathBuf};
    println!("cargo:rerun-if-env-changed=NAIA_AGENT_PROTO_DIR");
    let proto_dir = env::var("NAIA_AGENT_PROTO_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("../../../../naia-agent/src/main/adapters/grpc"));
    let proto = proto_dir.join("naia_agent.proto");
    if !proto.is_file() {
        panic!(
            "naia_agent.proto 없음: {} (NAIA_AGENT_PROTO_DIR로 paired agent worktree를 지정하세요)",
            proto.display()
        );
    }
    use sha2::{Digest, Sha256};
    let proto_bytes = std::fs::read(&proto).expect("naia_agent.proto hash 입력 읽기 실패");
    let proto_sha256 = format!("{:x}", Sha256::digest(&proto_bytes));
    let agent_commit = std::process::Command::new("git")
        .args(["-C", proto_dir.to_str().expect("proto 경로 UTF-8"), "rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "uncommitted-worktree".to_string());
    let head_proto = std::process::Command::new("git")
        .args([
            "-C", proto_dir.to_str().expect("proto 경로 UTF-8"), "show",
            "HEAD:src/main/adapters/grpc/naia_agent.proto",
        ])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| output.stdout);
    let proto_dirty = head_proto.as_deref() != Some(proto_bytes.as_slice());
    println!("cargo:warning=NAIA_AGENT_PAIRED_COMMIT={agent_commit}");
    println!("cargo:warning=NAIA_AGENT_PROTO_SHA256={proto_sha256}");
    println!("cargo:warning=NAIA_AGENT_PAIRED_DIRTY={proto_dirty}");
    std::env::set_var(
        "PROTOC",
        protoc_bin_vendored::protoc_bin_path().expect("vendored protoc 경로"),
    );
    tonic_build::configure()
        .build_server(false)
        .compile_protos(&[proto.as_path()], &[proto_dir.as_path()])
        .expect("naia_agent.proto gRPC client 코드젠 실패");
    println!("cargo:rerun-if-changed={}", proto.display());

    // Set rpath so the binary finds libvosk.so next to itself
    #[cfg(target_os = "linux")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN:$ORIGIN/../lib/Naia");
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path");
}
