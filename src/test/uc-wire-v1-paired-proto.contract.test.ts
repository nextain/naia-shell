import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function readText(path: string): string {
	return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

const BUILD_RS = readText("packages/shell/src-tauri/build.rs");
const TAURI_WITH_MODE = readText("packages/shell/scripts/tauri-with-mode.mjs");
const STAGE_RUNTIME = readText("packages/shell/scripts/stage-runtime.mjs");
const STAGE_AGENT = readText("packages/shell/scripts/stage-agent.mjs");

describe("UC-WIRE-V1 paired proto build", () => {
	it("requires an explicit NAIA_AGENT_PROTO_DIR", () => {
		expect(BUILD_RS).toContain('env::var("NAIA_AGENT_PROTO_DIR").expect');
		expect(BUILD_RS).toContain('env::var("NAIA_AGENT_SCRIPT").expect');
		expect(BUILD_RS).toContain("NAIA_AGENT_SCRIPT and NAIA_AGENT_PROTO_DIR must come from the same checkout");
		expect(BUILD_RS).not.toContain(
			"../../../../naia-agent/src/main/adapters/grpc",
		);
		expect(BUILD_RS).toContain("naia_agent.proto");
	});

	it("does not pass a missing proto as a warning", () => {
		expect(BUILD_RS).not.toContain("cargo:warning=naia_agent.proto");
		expect(BUILD_RS).toMatch(/panic!|expect\(/);
	});

	it("pins the paired agent ancestry and build evidence", () => {
		expect(BUILD_RS).toContain(
            'REQUIRED_AGENT_COMMIT: &str = "e44b0f575549d607f4207f433a0284cb15c44746"',
		);
		expect(BUILD_RS).toContain(
            'REQUIRED_PROTO_SHA256: &str =\n        "18000e2902410c5279f2d0d38a04c1ecb6c6f3d6566532c2d3b81ddecc9c8d3b"',
		);
		expect(BUILD_RS).not.toContain("merge-base");
		expect(BUILD_RS).toContain("NAIA_AGENT_REQUIRED_COMMIT");
		expect(BUILD_RS).toContain("NAIA_AGENT_PAIRED_COMMIT");
		expect(BUILD_RS).toContain("NAIA_AGENT_PROTO_SHA256");
		expect(BUILD_RS).toContain("NAIA_AGENT_PAIRED_DIRTY");
		expect(BUILD_RS).toContain("proto_sha256 != REQUIRED_PROTO_SHA256");
		expect(BUILD_RS).toContain("agent_commit != REQUIRED_AGENT_COMMIT");
		expect(BUILD_RS).toContain("if proto_dirty");
		expect(BUILD_RS).toContain("git_root_for_path(&proto_dir)");
		expect(BUILD_RS).toContain("git_root_for_path(&agent_script)");
		expect(BUILD_RS).toContain("scripts/builds/agent-stdio-entry.mjs");
		expect(BUILD_RS).toContain("agent_script_dirty");
		expect(BUILD_RS).toContain("NAIA_AGENT_SCRIPT_DIRTY");
		expect(BUILD_RS).toContain('git_output(&proto_root_path, &["status", "--porcelain"])');
		expect(BUILD_RS).toContain("NAIA_AGENT_CHECKOUT_DIRTY");
		expect(BUILD_RS).toContain("cargo:rustc-env=NAIA_AGENT_PAIRED_SCRIPT");
		expect(BUILD_RS).toContain("cargo:rustc-env=NAIA_AGENT_PAIRED_SCRIPT_SHA256");
		expect(BUILD_RS).toContain("cargo:rustc-env=NAIA_AGENT_PAIRED_PROTO_SHA256");
		expect(BUILD_RS).toContain("register_paired_checkout_rerun_inputs");
		expect(BUILD_RS).toContain('emit_rerun_if_changed(script)');
		expect(BUILD_RS).toContain('git_dir.join("index")');
		expect(BUILD_RS).toContain('git_dir.join("HEAD")');
		expect(BUILD_RS).toContain('common_git_dir.join("packed-refs")');
		expect(BUILD_RS).toContain('"symbolic-ref"');
		expect(BUILD_RS).toContain('"--git-dir"');
		expect(BUILD_RS).toContain('"--git-common-dir"');
		expect(BUILD_RS).toContain('"ls-files"');
		expect(BUILD_RS).toContain("watched_dirs");
		expect(BUILD_RS).toContain("watched_dirs.insert(root.to_path_buf())");
		expect(BUILD_RS).toContain("tracked.parent()");
		expect(BUILD_RS).toContain('"status"');
		expect(BUILD_RS).toContain('"--porcelain"');
		expect(BUILD_RS).toContain("Sha256");
	});

	it("checks UC-WIRE-V1 schema markers before codegen", () => {
		for (const marker of [
			"message AttachmentRef",
			"optional GroundingRequest grounding = 12;",
			"optional ProviderSessionRequest provider_session = 13;",
			"ProcessingDisclosureEvent processing_disclosure = 20;",
			"rpc Shutdown(ShutdownRequest) returns (Ack);",
			"message ShutdownRequest { string nonce = 1; }",
			"enum WireErrorCode",
			"ATTACHMENT_INVALID_REF",
		]) {
			expect(BUILD_RS).toContain(marker);
		}
	});
	it("selects and validates one exact paired agent/proto checkout", () => {
		expect(TAURI_WITH_MODE).toContain(
            'REQUIRED_AGENT_COMMIT = "e44b0f575549d607f4207f433a0284cb15c44746"',
		);
		expect(TAURI_WITH_MODE).toContain(
            'REQUIRED_PROTO_SHA256 = "18000e2902410c5279f2d0d38a04c1ecb6c6f3d6566532c2d3b81ddecc9c8d3b"',
		);
		expect(TAURI_WITH_MODE).toContain("naia-agent-issue-388-proto");
		expect(TAURI_WITH_MODE).not.toContain("merge-base");
		expect(TAURI_WITH_MODE).not.toContain("--is-ancestor");
		expect(TAURI_WITH_MODE).toContain("firstPairedAgentCheckout");
		expect(TAURI_WITH_MODE).toContain("AGENT_WORKTREE_ROOTS");
		expect(TAURI_WITH_MODE).toContain('"naia-agent-worktrees"');
		expect(TAURI_WITH_MODE).toContain("readdirSync(root, { withFileTypes: true })");
		expect(TAURI_WITH_MODE).toContain("agentCandidates()");
		expect(TAURI_WITH_MODE).toContain("validateAgentEnvPair");
		expect(TAURI_WITH_MODE).toContain("gitDirForPath");
		expect(TAURI_WITH_MODE).toContain("scriptRoot !== protoRoot");
		expect(TAURI_WITH_MODE).toContain("rev-parse");
		expect(TAURI_WITH_MODE).toContain("HEAD");
		expect(TAURI_WITH_MODE).toContain("isCleanProto");
		expect(TAURI_WITH_MODE).toContain("isCleanAgentEntrypoint");
		expect(TAURI_WITH_MODE).toContain("isCleanCheckout");
		expect(TAURI_WITH_MODE).toContain("sha256File");
		expect(TAURI_WITH_MODE).toContain("REQUIRED_PROTO_SHA256");
		expect(TAURI_WITH_MODE).toContain("NAIA_AGENT_SCRIPT must be scripts/builds/agent-stdio-entry.mjs");
		expect(TAURI_WITH_MODE).toContain("NAIA_AGENT_PROTO_DIR");
		expect(TAURI_WITH_MODE.lastIndexOf("applyPairedAgentEnv(env)")).toBeGreaterThan(
			TAURI_WITH_MODE.indexOf("if (existsSync(envPath))"),
		);
		expect(TAURI_WITH_MODE).toContain(
			'k === "NAIA_AGENT_SCRIPT" || k === "NAIA_AGENT_PROTO_DIR"',
		);
		const applyBody = TAURI_WITH_MODE.slice(
			TAURI_WITH_MODE.indexOf("function applyPairedAgentEnv"),
			TAURI_WITH_MODE.indexOf("// ── 로컬 cascade loader"),
		);
		expect(applyBody.indexOf("validateAgentEnvPair(explicitScript, explicitProtoDir)")).toBeLessThan(
			applyBody.indexOf("firstPairedAgentCheckout()"),
		);
		const candidateBody = TAURI_WITH_MODE.slice(
			TAURI_WITH_MODE.indexOf("function isPairedAgentCheckout"),
			TAURI_WITH_MODE.indexOf("function agentCandidates"),
		);
		expect(candidateBody).toContain("isCleanCheckout");
		expect(candidateBody).toContain("REQUIRED_PROTO_SHA256");
		expect(TAURI_WITH_MODE).not.toContain("firstAgentWith");
		expect(TAURI_WITH_MODE).not.toContain(
			'env.NAIA_AGENT_PROTO_DIR = env.NAIA_AGENT_PROTO_DIR ?? resolve(AGENT, "src/main/adapters/grpc")',
		);
	});

	it("applies the same paired agent/proto env before direct Tauri bundle builds", () => {
		expect(STAGE_RUNTIME).toContain(
            'REQUIRED_AGENT_COMMIT = "e44b0f575549d607f4207f433a0284cb15c44746"',
		);
		expect(STAGE_RUNTIME).toContain(
            'REQUIRED_PROTO_SHA256 = "18000e2902410c5279f2d0d38a04c1ecb6c6f3d6566532c2d3b81ddecc9c8d3b"',
		);
		expect(STAGE_RUNTIME).toContain("applyPairedAgentEnv(process.env)");
		expect(STAGE_RUNTIME).toContain("AGENT_WORKTREE_ROOTS");
		expect(STAGE_RUNTIME).toContain('"naia-agent-worktrees"');
		expect(STAGE_RUNTIME).toContain("readdirSync(root, { withFileTypes: true })");
		expect(STAGE_RUNTIME).toContain("agentCandidates()");
		expect(STAGE_RUNTIME).toContain("const pairedAgentRoot = applyPairedAgentEnv(process.env)");
		expect(STAGE_RUNTIME).toContain("sibling: pairedAgentRoot");
		expect(STAGE_RUNTIME).toContain("validateAgentEnvPair");
		expect(STAGE_RUNTIME).toContain("NAIA_AGENT_SCRIPT and NAIA_AGENT_PROTO_DIR must come from the same checkout");
		expect(STAGE_RUNTIME).toContain("isCleanAgentEntrypoint");
		expect(STAGE_RUNTIME).toContain("isCleanCheckout");
		expect(STAGE_RUNTIME).toContain("sha256File");
		expect(STAGE_RUNTIME).toContain("NAIA_AGENT_SCRIPT must be scripts/builds/agent-stdio-entry.mjs");
		expect(STAGE_RUNTIME.indexOf("const pairedAgentRoot = applyPairedAgentEnv(process.env)")).toBeLessThan(
			STAGE_RUNTIME.indexOf("await prepareRuntime(matrix, platform, arch)"),
		);
		expect(STAGE_RUNTIME.indexOf("const pairedAgentRoot = applyPairedAgentEnv(process.env)")).toBeLessThan(
			STAGE_RUNTIME.indexOf('script: "scripts/stage-agent.mjs"'),
		);
		expect(STAGE_RUNTIME.indexOf("const pairedAgentRoot = applyPairedAgentEnv(process.env)")).toBeLessThan(
			STAGE_RUNTIME.indexOf("pnpm exec tauri build --verbose --config"),
		);
		const applyBody = STAGE_RUNTIME.slice(
			STAGE_RUNTIME.indexOf("function applyPairedAgentEnv"),
			STAGE_RUNTIME.indexOf("/* ───────────────────────── 순수 함수"),
		);
		expect(applyBody.indexOf("validateAgentEnvPair(explicitScript, explicitProtoDir)")).toBeLessThan(
			applyBody.indexOf("firstPairedAgentCheckout()"),
		);
		const candidateBody = STAGE_RUNTIME.slice(
			STAGE_RUNTIME.indexOf("function isPairedAgentCheckout"),
			STAGE_RUNTIME.indexOf("function agentCandidates"),
		);
		expect(candidateBody).toContain("isCleanCheckout");
		expect(candidateBody).toContain("REQUIRED_PROTO_SHA256");
	});

	it("requires stage-agent to stage the same validated paired checkout", () => {
		expect(STAGE_AGENT).toContain(
            'REQUIRED_AGENT_COMMIT = "e44b0f575549d607f4207f433a0284cb15c44746"',
		);
		expect(STAGE_AGENT).toContain(
            'REQUIRED_PROTO_SHA256 = "18000e2902410c5279f2d0d38a04c1ecb6c6f3d6566532c2d3b81ddecc9c8d3b"',
		);
		expect(STAGE_AGENT).toContain("NAIA_AGENT_SCRIPT and NAIA_AGENT_PROTO_DIR are required");
		expect(STAGE_AGENT).toContain("const AGENT = gitRootForPath(AGENT_SCRIPT, true)");
		expect(STAGE_AGENT).toContain("NAIA_AGENT_SCRIPT and NAIA_AGENT_PROTO_DIR must come from the same checkout");
		expect(STAGE_AGENT).toContain("scripts/builds/agent-stdio-entry.mjs");
		expect(STAGE_AGENT).toContain("src/main/adapters/grpc");
		expect(STAGE_AGENT).toContain("REQUIRED_PROTO_SHA256");
		expect(STAGE_AGENT).toContain("paired naia-agent entrypoint must be clean");
		expect(STAGE_AGENT).toContain("paired naia-agent proto must be clean");
		expect(STAGE_AGENT).toContain("paired naia-agent checkout must be clean");
		expect(STAGE_AGENT).toContain("assertPairedCheckoutStillClean(\"agent install/build\")");
		expect(STAGE_AGENT).toContain("assertPairedCheckoutStillClean(\"agent deploy\")");
		expect(STAGE_AGENT).toContain("assertPairedCheckoutStillClean(\"dist/proto copy\")");
		expect(STAGE_AGENT).toContain("staged proto SHA256");
		expect(STAGE_AGENT).toContain("staged agent entrypoint hash does not match paired source");
		expect(STAGE_AGENT).not.toContain('const AGENT = resolve(SHELL, "../../../naia-agent")');
	});

	it("executes stage-agent fail-closed validation before staging side effects", () => {
		const runStageAgent = (env: Record<string, string>) =>
			spawnSync(process.execPath, ["scripts/stage-agent.mjs"], {
				cwd: "packages/shell",
				env: { ...process.env, ...env },
				encoding: "utf8",
			});

		const missingEnv = runStageAgent({
			NAIA_AGENT_SCRIPT: "",
			NAIA_AGENT_PROTO_DIR: "",
		});
		expect(missingEnv.status).not.toBe(0);
		expect(missingEnv.stdout + missingEnv.stderr).toContain(
			"NAIA_AGENT_SCRIPT and NAIA_AGENT_PROTO_DIR are required",
		);
		expect(missingEnv.stdout + missingEnv.stderr).not.toContain(
			"agent install + build",
		);

		const wrongEntrypoint = runStageAgent({
			NAIA_AGENT_SCRIPT: resolve("packages/shell/package.json"),
			NAIA_AGENT_PROTO_DIR: resolve("packages/shell/src"),
		});
		expect(wrongEntrypoint.status).not.toBe(0);
		expect(wrongEntrypoint.stdout + wrongEntrypoint.stderr).toContain(
			"NAIA_AGENT_SCRIPT must be scripts/builds/agent-stdio-entry.mjs",
		);
		expect(wrongEntrypoint.stdout + wrongEntrypoint.stderr).not.toContain(
			"agent install + build",
		);
	});

	it("validates runtime NAIA_AGENT_SCRIPT overrides against the build pair", () => {
		const LIB_RS = readText("packages/shell/src-tauri/src/lib.rs");
		expect(LIB_RS).toContain("validate_runtime_agent_script_override");
		expect(LIB_RS).toContain("runtime_git_output");
		expect(LIB_RS).toContain("sha256_file_hex");
		expect(LIB_RS).toContain('option_env!("NAIA_AGENT_PAIRED_SCRIPT")');
		expect(LIB_RS).toContain('option_env!("NAIA_AGENT_REQUIRED_COMMIT")');
		expect(LIB_RS).toContain('option_env!("NAIA_AGENT_PAIRED_SCRIPT_SHA256")');
		expect(LIB_RS).toContain('option_env!("NAIA_AGENT_PAIRED_PROTO_SHA256")');
		expect(LIB_RS).toContain('std::env::var("NAIA_AGENT_SCRIPT")');
		expect(LIB_RS).toContain("NAIA_AGENT_SCRIPT must match paired build script");
		expect(LIB_RS).toContain("checkout must remain clean at runtime");
		expect(LIB_RS).toContain("resolve_paired_bundled_agent_script");
		expect(LIB_RS).toContain("agent/scripts/builds/agent-stdio-entry.mjs");
		expect(LIB_RS).toContain("agent/dist/main/adapters/grpc/naia_agent.proto");
		expect(LIB_RS).toContain("bundled paired agent script hash must remain");
		expect(LIB_RS).toContain("bundled paired agent proto hash must remain");
		expect(LIB_RS).toContain("paired bundled agent proto is required");
		expect(LIB_RS).not.toContain("NAIA_AGENT_STANDALONE_PATH");
		expect(LIB_RS).not.toContain("agent-standalone");
		expect(LIB_RS).not.toContain("../agent/dist/index.js");
	});

	it("keeps authenticated shutdown independent from stalled ordinary RPCs", () => {
		const LIB_RS = readText("packages/shell/src-tauri/src/lib.rs");
		expect(LIB_RS).toContain(
			"tauri::async_runtime::spawn(agent_shutdown_dispatcher(addr.clone(), shutdown_rx))",
		);
		expect(LIB_RS).toContain("async fn agent_shutdown_dispatcher(");
		expect(LIB_RS).toContain(
			"const AGENT_SHUTDOWN_RPC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2)",
		);
		expect(LIB_RS).toContain(
			"agent_shutdown_dispatcher_with_timeout(addr, rx, AGENT_SHUTDOWN_RPC_TIMEOUT)",
		);
		expect(LIB_RS).toContain("AgentShutdownOutcome::Ambiguous");
		expect(LIB_RS).toContain(
			"async fn agent_dispatcher(\n    addr: String,\n    adk_path: String,\n    mut rx: tokio::sync::mpsc::UnboundedReceiver<String>",
		);
	});
});
