fn main() {
    tauri_build::build();

    // ── os↔agent gRPC 클라이언트 코드젠 (정본 transport=gRPC) ──────────────────────
    // naia_agent.proto SoT = sibling repo naia-agent. protoc = vendored(시스템 설치 불요).
    // os = client only(build_server=false). 생성 코드는 OUT_DIR → agent_grpc 모듈이 include_proto!.
    let proto_dir = "../../../../naia-agent/src/main/adapters/grpc";
    let proto = format!("{proto_dir}/naia_agent.proto");
    if std::path::Path::new(&proto).exists() {
        std::env::set_var(
            "PROTOC",
            protoc_bin_vendored::protoc_bin_path().expect("vendored protoc 경로"),
        );
        tonic_build::configure()
            .build_server(false)
            .compile_protos(&[proto.as_str()], &[proto_dir])
            .expect("naia_agent.proto gRPC client 코드젠 실패");
        println!("cargo:rerun-if-changed={proto}");
    } else {
        println!("cargo:warning=naia_agent.proto 없음({proto}) — gRPC codegen 스킵");
    }

    // Set rpath so the binary finds libvosk.so next to itself
    #[cfg(target_os = "linux")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN:$ORIGIN/../lib/Naia");
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path");
}
