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
const AGENT_PAIRING = readText("packages/shell/scripts/agent-pairing.mjs");
const BUILD_E2E_TAURI = readText("packages/shell/scripts/build-e2e-tauri.mjs");
const CODEX_E2E_ENVIRONMENT = readText("packages/shell/e2e-tauri/codex-e2e-environment.ts");
const PAIRING = JSON.parse(readText("packages/shell/agent-pairing.json")) as {
	agentCommit: string;
	protoSha256: string;
};

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
			`REQUIRED_AGENT_COMMIT: &str = "${PAIRING.agentCommit}"`,
		);
		expect(BUILD_RS).toContain(
			`REQUIRED_PROTO_SHA256: &str =\n        "${PAIRING.protoSha256}"`,
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
	// #539 로 짝 체크아웃 **선택**이 agent-pairing.mjs 한 곳으로 모였다. 그전에는
	// 런처(tauri-with-mode)와 설치 스테이징(stage-runtime)이 각자 후보를 열거해
	// 서로 다른 워크트리를 고를 수 있었고, 그러면 빌드가 박아 둔 짝과 실행이 넘기는
	// 짝이 어긋난다. 계약 자체는 그대로다 — "정확히 하나의 짝 agent/proto 체크아웃을
	// 고르고 검증한다". 그 계약이 성립하는 자리만 옮겼으므로 단정도 그 자리를 본다.
	it("selects and validates one exact paired agent/proto checkout", () => {
		// ① 후보 열거는 공유 해석기만 갖는다. 두 진입점이 자기 사본을 다시 만들면
		//    둘이 갈라질 수 있으므로 사본이 없다는 것까지 못 박는다.
		for (const source of [TAURI_WITH_MODE, STAGE_RUNTIME]) {
			expect(source).toContain('from "./agent-pairing.mjs"');
			expect(source).toContain("resolvePairedAgent({");
			expect(source).not.toContain("AGENT_WORKTREE_ROOTS");
			expect(source).not.toContain("function agentCandidates");
			expect(source).not.toContain("function firstPairedAgentCheckout");
			expect(source).not.toContain("function isPairedAgentCheckout");
			expect(source).not.toContain("merge-base");
			expect(source).not.toContain("--is-ancestor");
		}

		// ② 해석기가 후보를 모은다. 옛 하드코딩 자리(.agents/work/naia-agent-issue-388-proto)
		//    대신 워크트리 모음 디렉터리와 주 저장소에 **등록된** 워크트리 목록을 본다.
		expect(AGENT_PAIRING).toContain("export function resolvePairedAgent");
		expect(AGENT_PAIRING).toContain("sourceEnv.NAIA_E2E_AGENT_ROOT");
		expect(AGENT_PAIRING).toContain("sourceEnv.NAIA_AGENT_WORKTREES_DIR");
		expect(AGENT_PAIRING).toContain('"naia-agent-worktrees"');
		expect(AGENT_PAIRING).toContain("readdirSync(root, { withFileTypes: true })");
		expect(AGENT_PAIRING).toContain('["worktree", "list", "--porcelain"]');
		expect(AGENT_PAIRING).toContain("parseGitWorktreePaths(");
		// 임시 디렉터리의 사본은 후보에서 뺀다. 이것이 회귀 전체의 전제를 조용히
		// 바꿨던 자리라 빠져도 통과하면 안 된다.
		expect(AGENT_PAIRING).toContain("TEMPORARY_PATH.test(path)");

		// ③ 후보가 여럿이어도 **하나만** 고르고, 부르는 쪽이 달라도 같은 하나를
		//    고른다: 중복 제거 + 경로 정렬 후 첫 합격자에서 return.
		expect(AGENT_PAIRING).toContain("[...new Set(candidates)].sort()");
		expect(AGENT_PAIRING).toContain("return { pairedAgent, agentScript, agentProtoDir };");

		// ④ 고른 것을 실제로 검증한다 — 핀 커밋 · 깨끗함 · proto 해시 · 정해진 경로.
		expect(AGENT_PAIRING).toContain('"scripts/builds/agent-stdio-entry.mjs"');
		expect(AGENT_PAIRING).toContain('"src/main/adapters/grpc"');
		expect(AGENT_PAIRING).toContain('"naia_agent.proto"');
		expect(AGENT_PAIRING).toContain('["rev-parse", "HEAD"]');
		expect(AGENT_PAIRING).toContain("!==\n\t\t\tREQUIRED_AGENT_COMMIT");
		expect(AGENT_PAIRING).toContain('["status", "--porcelain"]');
		expect(AGENT_PAIRING).toContain("if (dirty) continue;");
		expect(AGENT_PAIRING).toContain("hashProto(proto) !== REQUIRED_PROTO_SHA256");

		// ⑤ 하나도 합격하지 않으면 조용히 넘어가지 않고 실패한다.
		expect(AGENT_PAIRING).toContain("No clean paired naia-agent checkout");

		// ⑥ 런처: 명시 env 가 있으면 해석기로 내려가기 **전에** 그 쌍을 직접 검증하고,
		//    없으면 해석 결과를 env 에 심는다. 그리고 그 짝 소스를 빌드한다.
		expect(TAURI_WITH_MODE).toContain('from "./package-manager.mjs"');
		expect(TAURI_WITH_MODE).toContain(
			'runProjectPnpm(["run", "build"], pairedAgent, env)',
		);
		expect(TAURI_WITH_MODE).not.toContain(
			'spawnSync("pnpm", ["run", "build"]',
		);
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
		expect(applyBody).toContain(
			"NAIA_AGENT_SCRIPT and NAIA_AGENT_PROTO_DIR must be provided together",
		);
		// 두 호출이 모두 있어야 순서를 따질 수 있다. indexOf 만 비교하면 호출이
		// 통째로 사라진 경우 -1 이 앞선 것으로 읽혀 조용히 통과한다.
		expect(applyBody).toContain("validateAgentEnvPair(explicitScript, explicitProtoDir)");
		expect(applyBody.indexOf("validateAgentEnvPair(explicitScript, explicitProtoDir)")).toBeLessThan(
			applyBody.indexOf("resolvePairedAgent({"),
		);
		expect(applyBody).toContain("targetEnv.NAIA_AGENT_SCRIPT = agentScript");
		expect(applyBody).toContain("targetEnv.NAIA_AGENT_PROTO_DIR = agentProtoDir");
		expect(TAURI_WITH_MODE).not.toContain("firstAgentWith");
		expect(TAURI_WITH_MODE).not.toContain(
			'env.NAIA_AGENT_PROTO_DIR = env.NAIA_AGENT_PROTO_DIR ?? resolve(AGENT, "src/main/adapters/grpc")',
		);
	});

	it("applies the same paired agent/proto env before direct Tauri bundle builds", () => {
		expect(STAGE_RUNTIME).toContain('from "./agent-pairing.mjs"');
		expect(STAGE_RUNTIME).toContain("applyPairedAgentEnv(process.env)");
		expect(STAGE_RUNTIME).toContain(
			"const pairedAgentRoot = applyPairedAgentEnv(process.env)",
		);

		// 런처와 같은 해석기를 같은 방식으로 부른다 — 스테이징이 후보를 따로
		// 추리거나 검증을 건너뛰면 두 쪽이 다른 체크아웃을 고르게 된다.
		const applyBody = STAGE_RUNTIME.slice(
			STAGE_RUNTIME.indexOf("function applyPairedAgentEnv"),
			STAGE_RUNTIME.indexOf("/* ───────────────────────── 순수 함수"),
		);
		expect(applyBody).toContain("resolvePairedAgent({");
		expect(applyBody).toContain(
			"NAIA_AGENT_SCRIPT and NAIA_AGENT_PROTO_DIR must be provided together",
		);
		expect(applyBody).toContain("validateAgentEnvPair(explicitScript, explicitProtoDir)");
		expect(applyBody.indexOf("validateAgentEnvPair(explicitScript, explicitProtoDir)")).toBeLessThan(
			applyBody.indexOf("resolvePairedAgent({"),
		);
		expect(applyBody).toContain("env.NAIA_AGENT_SCRIPT = agentScript");
		expect(applyBody).toContain("env.NAIA_AGENT_PROTO_DIR = agentProtoDir");

		// 명시 env 로 들어온 쌍도 런처와 같은 항목을 검사한다.
		expect(STAGE_RUNTIME).toContain("validateAgentEnvPair");
		expect(STAGE_RUNTIME).toContain("NAIA_AGENT_SCRIPT and NAIA_AGENT_PROTO_DIR must come from the same checkout");
		expect(STAGE_RUNTIME).toContain("isCleanProto");
		expect(STAGE_RUNTIME).toContain("isCleanAgentEntrypoint");
		expect(STAGE_RUNTIME).toContain("isCleanCheckout");
		expect(STAGE_RUNTIME).toContain("sha256File");
		expect(STAGE_RUNTIME).toContain("NAIA_AGENT_SCRIPT must be scripts/builds/agent-stdio-entry.mjs");

		// 해석 결과가 실제로 스테이징 대상이 된다.
		expect(STAGE_RUNTIME).toContain("sibling: pairedAgentRoot");

		// 그리고 그 적용은 런타임 준비·에이전트 스테이징·번들 빌드 **앞**에 온다.
		// 비교 대상이 실제로 존재하는지 먼저 못 박는다(없으면 -1 로 통과해 버린다).
		for (const anchor of [
			"await prepareRuntime(matrix, platform, arch)",
			'script: "scripts/stage-agent.mjs"',
			"pnpm exec tauri build --verbose --config",
		]) {
			expect(STAGE_RUNTIME).toContain(anchor);
		}
		expect(STAGE_RUNTIME.indexOf("const pairedAgentRoot = applyPairedAgentEnv(process.env)")).toBeLessThan(
			STAGE_RUNTIME.indexOf("await prepareRuntime(matrix, platform, arch)"),
		);
		expect(STAGE_RUNTIME.indexOf("const pairedAgentRoot = applyPairedAgentEnv(process.env)")).toBeLessThan(
			STAGE_RUNTIME.indexOf('script: "scripts/stage-agent.mjs"'),
		);
		expect(STAGE_RUNTIME.indexOf("const pairedAgentRoot = applyPairedAgentEnv(process.env)")).toBeLessThan(
			STAGE_RUNTIME.indexOf("pnpm exec tauri build --verbose --config"),
		);
	});

	it("requires stage-agent to stage the same validated paired checkout", () => {
		expect(STAGE_AGENT).toContain('from "./agent-pairing.mjs"');
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

	it("uses the same pairing manifest for isolated native E2E", () => {
		expect(BUILD_E2E_TAURI).toContain('from "./agent-pairing.mjs"');
		expect(CODEX_E2E_ENVIRONMENT).toContain('"agent-pairing.json"');
		expect(CODEX_E2E_ENVIRONMENT).not.toMatch(
			/REQUIRED_AGENT_COMMIT\s*=\s*"[0-9a-f]{40}"/,
		);
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
