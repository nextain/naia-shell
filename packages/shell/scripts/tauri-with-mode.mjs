#!/usr/bin/env node
/**
 * tauri-with-mode.mjs (new-naia) — `pnpm run tauri:dev | tauri:prod` 래퍼.
 *
 * 옛 old-naia-os/scripts/tauri-with-mode.mjs 의 새-구조 이식판.
 * 추가 책임(new-naia-os 는 항상 새 코어 + 분리 에이전트이므로):
 *   - VITE_NAIA_NEW_CORE=1        (셸 채팅을 이식 코어 경유)
 *   - NAIA_AGENT_STANDALONE=1     (Rust 가 임베디드 대신 외부 에이전트 스폰)
 *   - NAIA_AGENT_SCRIPT=../naia-agent/scripts/builds/agent-stdio-entry.mjs
 *   - GDK_BACKEND=x11 (Linux — WebKitGTK XReparentWindow embedding)
 * 그 위에 .env.{mode} 의 VITE_* 를 주입(URL 등은 .env 파일에만, 여기 하드코딩 없음).
 * 호출자(run-new-core-dev.sh 등)가 이미 설정한 값은 보존(?? 기본값).
 *
 * prod 모드는 dev-gateway 변수를 강제 제거 — stale 셸 env 가 prod 로그인 사용자를 dev 게이트웨이로
 * 라우팅(401)하지 못하게.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, resolve } from "node:path";
import {
	parseGitWorktreePaths,
	REQUIRED_AGENT_COMMIT,
	REQUIRED_PROTO_SHA256,
} from "./agent-pairing.mjs";
import { developmentInstanceEnv } from "./dev-instance.mjs";
import { voxCpm2Profile } from "./stage-voxcpm2-runtime.mjs";
import { interactiveLaunchEnv } from "./launch-env.mjs";
import { runProjectPnpm } from "./package-manager.mjs";

// `build` produces the release installer (`tauri build`, production config).
// It shares prod env resolution but does not launch a dev window.
const isBuild = process.argv[2] === "build";
const mode = process.argv[2] === "prod" || isBuild ? "prod" : "dev";

const HERE = import.meta.dirname; // packages/shell/scripts
const SHELL = resolve(HERE, ".."); // packages/shell
const OS_ROOT = resolve(SHELL, "..", ".."); // new-naia-os
const WORKSPACE_ROOT = resolve(OS_ROOT, "..", ".."); // alpha-adk
const STATIC_AGENT_CANDIDATES = [
	resolve(OS_ROOT, "..", "naia-agent"),
	resolve(OS_ROOT, "..", "..", "naia-agent"),
	resolve(OS_ROOT, "..", "..", "..", ".agents", "work", "naia-agent-issue-388-proto"),
	resolve(OS_ROOT, "..", "..", ".agents", "work", "naia-agent-issue-388-proto"),
];
const AGENT_WORKTREE_ROOTS = [
	resolve(OS_ROOT, "..", "naia-agent-worktrees"),
	resolve(OS_ROOT, "..", "..", "naia-agent-worktrees"),
];

function gitOutput(dir, args) {
	const safeDir = resolve(dir).replaceAll("\\", "/");
	const r = spawnSync(
		"git",
		["-c", `safe.directory=${safeDir}`, "-C", dir, ...args],
		{ encoding: "utf8", shell: false },
	);
	if (r.status !== 0) return null;
	return r.stdout.trim();
}

function hasRequiredAgentCommit(dir) {
	return gitOutput(dir, ["rev-parse", "HEAD"]) === REQUIRED_AGENT_COMMIT;
}

function isCleanProto(dir) {
	return gitOutput(dir, ["status", "--porcelain", "--", "src/main/adapters/grpc/naia_agent.proto"]) === "";
}

function isCleanAgentEntrypoint(dir) {
	return gitOutput(dir, ["status", "--porcelain", "--", "scripts/builds/agent-stdio-entry.mjs"]) === "";
}

function isCleanCheckout(dir) {
	// Twin of stage-runtime.mjs's isCleanPorcelainIgnoringRecovery — the dev
	// launch resolves the paired agent here, the bundle resolves it there. Both
	// must ignore request-contract crash-recovery leases under
	// .agents/session-contracts/.recovery/: a pure runtime artifact (never
	// source, cannot affect the built agent) that a concurrent tool call can
	// drop into the checkout. Without this, the correctly-paired main checkout
	// looks dirty and is skipped, so the dev build either selects a build-broken
	// sibling worktree or fails with "no paired checkout".
	const porcelain = gitOutput(dir, ["status", "--porcelain"]);
	if (porcelain == null) return false;
	return (
		porcelain
			.split("\n")
			.filter((line) => line.trim() !== "")
			.filter(
				(line) =>
					!/\.agents[\\/]session-contracts[\\/]\.recovery[\\/]/.test(line),
			).length === 0
	);
}

function sha256File(path) {
	return createHash("sha256")
		.update(readFileSync(path, "utf8").replace(/\r\n/g, "\n"))
		.digest("hex");
}

function isPairedAgentCheckout(dir) {
	return (
		existsSync(resolve(dir, "scripts/builds/agent-stdio-entry.mjs")) &&
		existsSync(resolve(dir, "src/main/adapters/grpc/naia_agent.proto")) &&
		hasRequiredAgentCommit(dir) &&
		isCleanProto(dir) &&
		isCleanAgentEntrypoint(dir) &&
		isCleanCheckout(dir) &&
		sha256File(resolve(dir, "src/main/adapters/grpc/naia_agent.proto")) ===
			REQUIRED_PROTO_SHA256
	);
}

function agentCandidates() {
	const candidates = [...STATIC_AGENT_CANDIDATES];
	for (const repository of STATIC_AGENT_CANDIDATES) {
		if (!existsSync(repository)) continue;
		candidates.push(
			...parseGitWorktreePaths(
				gitOutput(repository, ["worktree", "list", "--porcelain"]),
			),
		);
	}
	for (const root of AGENT_WORKTREE_ROOTS) {
		if (!existsSync(root)) continue;
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (entry.isDirectory()) candidates.push(resolve(root, entry.name));
		}
	}
	return [...new Set(candidates)];
}

function firstPairedAgentCheckout() {
	for (const dir of agentCandidates()) {
		if (isPairedAgentCheckout(dir)) return dir;
	}
	return null;
}

const WINDOWS_MANAGER = resolve(OS_ROOT, "..", "naia-omni-windows-manager");

const env = interactiveLaunchEnv(process.env);

// `tauri dev` does not stage bundle resources the way the release pipeline
// does. Point debug builds at the already verified local staging directory so
// the normal local-voice install flow can be exercised without pretending the
// development executable is an installed bundle. Rust ignores this override
// in release builds.
const devVoxCpm2Bundle = resolve(SHELL, "src-tauri", "voxcpm2-runtime");
const hostVoxCpm2Profile = voxCpm2Profile();
const devVoxCpm2DownloadManifest = resolve(
	SHELL,
	"scripts",
	"voxcpm2-download-manifest.json",
);
if (mode === "dev") {
	// Thin-runtime dev builds reuse the staged download manifest, but its ignored
	// control files can predate the checkout. Refresh the small trusted installer
	// assets before Tauri snapshots resources so RTX field debugging exercises
	// the same activation/default-voice contract as a release build.
	mkdirSync(devVoxCpm2Bundle, { recursive: true });
	// 설치 스크립트는 운영체제 사실이고, 그 사실은 VOXCPM2_PROFILES 한 곳에만 산다
	// (#537). 여기에 이름을 다시 적으면 두 번째 플랫폼이 조용히 어긋난다 — 실제로
	// 리눅스 dev 가 PowerShell 스크립트를 받아 설치가 승격 직전에 죽었다.
	copyFileSync(
		resolve(SHELL, hostVoxCpm2Profile.modelPrep),
		resolve(devVoxCpm2Bundle, hostVoxCpm2Profile.modelPrepName),
	);
	copyFileSync(
		resolve(SHELL, "src-tauri/voxcpm2-activation-contract.json"),
		resolve(devVoxCpm2Bundle, "voxcpm2-activation-contract.json"),
	);
	if (existsSync(devVoxCpm2DownloadManifest)) {
		env.NAIA_VOXCPM2_DOWNLOAD_MANIFEST =
			env.NAIA_VOXCPM2_DOWNLOAD_MANIFEST ?? devVoxCpm2DownloadManifest;
	}
	// #508: Rust resolves the installer resources from resource_dir, which for
	// a `tauri dev` debug binary is the cargo debug directory — NOT the
	// src-tauri/voxcpm2-runtime staging above. Without these three files the
	// installed payload fails its reuse check (voxcpm2_installed_payload_is_
	// reusable requires the resource-dir installer script), so
	// voxcpm2_installation_status reports can_start=false and the Shell
	// silently normalizes a completed install back to browser voice (#507
	// 실측). Stage them idempotently beside the debug executable.
	const devTargetDebugVoxCpm2Bundle = resolve(
		env.CARGO_TARGET_DIR ?? resolve(SHELL, "src-tauri", "target"),
		"debug",
		"voxcpm2-runtime",
	);
	mkdirSync(devTargetDebugVoxCpm2Bundle, { recursive: true });
	copyFileSync(
		resolve(SHELL, hostVoxCpm2Profile.modelPrep),
		resolve(devTargetDebugVoxCpm2Bundle, hostVoxCpm2Profile.modelPrepName),
	);
	copyFileSync(
		resolve(SHELL, "src-tauri/voxcpm2-activation-contract.json"),
		resolve(devTargetDebugVoxCpm2Bundle, "voxcpm2-activation-contract.json"),
	);
	if (existsSync(devVoxCpm2DownloadManifest)) {
		copyFileSync(
			devVoxCpm2DownloadManifest,
			resolve(devTargetDebugVoxCpm2Bundle, "download-manifest.json"),
		);
	}
}
if (
	mode === "dev" &&
	existsSync(resolve(devVoxCpm2Bundle, "artifact", "artifact-manifest.json"))
) {
	env.NAIA_VOXCPM2_DEV_BUNDLE_ROOT =
		env.NAIA_VOXCPM2_DEV_BUNDLE_ROOT ?? devVoxCpm2Bundle;
}

// `~/.naia/adk-path` is the user's settings/workspace root and may point to a
// lightweight checkout without sibling runtime repositories. Development
// launches still need the local naia-labs / naia-omni-cascade sources from the
// checkout that owns this Shell. Keep those two roots explicit instead of
// making the cascade loader infer source locations from user-data placement.
env.NAIA_REPOS_ADK = env.NAIA_REPOS_ADK ?? WORKSPACE_ROOT;

// FR-SHELL-ISO (#425): the dev instance is fully isolated from the installed
// production app — separate identifier/productName (tauri.conf.dev.json
// overlay, Naia Dev / com.naia.shell.dev → own WebView2 data + localStorage)
// and a separate data home (~/.naia-dev via NAIA_HOME) so concurrent dev and
// production runs can never clobber each other's config. The single-GPU
// cascade runtime stays SHARED by design (adopt-if-healthy in Rust).
env.NAIA_HOME = env.NAIA_HOME ?? resolve(homedir(), ".naia-dev");
// 8/6 dual-instance 설계 수확: BGM(:18891)/OAuth(:18892) dev 전용 포트 +
// Rust dev 게이트 플래그(NAIA_DEV_INSTANCE — debug 빌드에서만 인정).
Object.assign(env, developmentInstanceEnv(env));
const DEV_TAURI_CONFIG = resolve(SHELL, "src-tauri", "tauri.conf.dev.json");

// ── 새 코어 + 분리 에이전트 (new-naia-os 불변) ──
env.VITE_NAIA_NEW_CORE = env.VITE_NAIA_NEW_CORE ?? "1";
env.NAIA_AGENT_STANDALONE = env.NAIA_AGENT_STANDALONE ?? "1";

function gitDirForPath(path) {
	let dir = resolve(path);
	if (existsSync(dir) && statSync(dir).isFile()) dir = dirname(dir);
	while (!existsSync(resolve(dir, ".git"))) {
		const parent = dirname(dir);
		if (parent === dir) throw new Error(`Path is not inside a git checkout: ${path}`);
		dir = parent;
	}
	const root = gitOutput(dir, ["rev-parse", "--show-toplevel"]);
	if (!root) throw new Error(`Path is not inside a git checkout: ${path}`);
	return root.replaceAll("\\", "/");
}

function validateAgentEnvPair(agentScript, protoDir) {
	if (!existsSync(agentScript)) throw new Error(`NAIA_AGENT_SCRIPT not found: ${agentScript}`);
	if (!existsSync(resolve(protoDir, "naia_agent.proto"))) {
		throw new Error(`NAIA_AGENT_PROTO_DIR missing naia_agent.proto: ${protoDir}`);
	}
	const scriptRoot = gitDirForPath(agentScript);
	const protoRoot = gitDirForPath(protoDir);
	if (scriptRoot !== protoRoot) {
		throw new Error(`NAIA_AGENT_SCRIPT and NAIA_AGENT_PROTO_DIR must come from the same checkout: ${scriptRoot} !== ${protoRoot}`);
	}
	if (resolve(agentScript).replaceAll("\\", "/") !== resolve(scriptRoot, "scripts/builds/agent-stdio-entry.mjs").replaceAll("\\", "/")) {
		throw new Error(`NAIA_AGENT_SCRIPT must be scripts/builds/agent-stdio-entry.mjs from the paired checkout: ${agentScript}`);
	}
	if (resolve(protoDir).replaceAll("\\", "/") !== resolve(scriptRoot, "src/main/adapters/grpc").replaceAll("\\", "/")) {
		throw new Error(`NAIA_AGENT_PROTO_DIR must be src/main/adapters/grpc from the paired checkout: ${protoDir}`);
	}
	if (gitOutput(scriptRoot, ["rev-parse", "HEAD"]) !== REQUIRED_AGENT_COMMIT) {
		throw new Error(`Paired naia-agent checkout must be exactly ${REQUIRED_AGENT_COMMIT}: ${scriptRoot}`);
	}
	if (!isCleanProto(scriptRoot)) {
		throw new Error(`Paired naia-agent proto must be clean: ${scriptRoot}`);
	}
	if (!isCleanAgentEntrypoint(scriptRoot)) {
		throw new Error(`Paired naia-agent entrypoint must be clean: ${scriptRoot}`);
	}
	if (!isCleanCheckout(scriptRoot)) {
		throw new Error(`Paired naia-agent checkout must be clean: ${scriptRoot}`);
	}
	if (sha256File(resolve(protoDir, "naia_agent.proto")) !== REQUIRED_PROTO_SHA256) {
		throw new Error(`Paired naia-agent proto SHA256 must be ${REQUIRED_PROTO_SHA256}: ${protoDir}`);
	}
}

function applyPairedAgentEnv(targetEnv) {
	const explicitScript = targetEnv.NAIA_AGENT_SCRIPT;
	const explicitProtoDir = targetEnv.NAIA_AGENT_PROTO_DIR;
	if (explicitScript || explicitProtoDir) {
		if (!explicitScript || !explicitProtoDir) {
			throw new Error("NAIA_AGENT_SCRIPT and NAIA_AGENT_PROTO_DIR must be provided together");
		}
		validateAgentEnvPair(explicitScript, explicitProtoDir);
		return gitDirForPath(explicitScript);
	}

	const pairedAgent = firstPairedAgentCheckout();
	if (!pairedAgent) {
		throw new Error(
			`No paired naia-agent checkout contains ${REQUIRED_AGENT_COMMIT} with both agent-stdio-entry.mjs and naia_agent.proto`,
		);
	}
	targetEnv.NAIA_AGENT_SCRIPT = resolve(
		pairedAgent,
		"scripts/builds/agent-stdio-entry.mjs",
	);
	targetEnv.NAIA_AGENT_PROTO_DIR = resolve(
		pairedAgent,
		"src/main/adapters/grpc",
	);
	validateAgentEnvPair(
		targetEnv.NAIA_AGENT_SCRIPT,
		targetEnv.NAIA_AGENT_PROTO_DIR,
	);
	return pairedAgent;
}

// ── 로컬 cascade loader (dev): 소스 sibling repo(loader/ 포함 dir) 를 가리킨다.
// 패키지 빌드는 stage-cascade-loader.mjs 가 src-tauri/cascade-loader 로 동봉(resource_dir 해석).
env.NAIA_CASCADE_LOADER_DIR = env.NAIA_CASCADE_LOADER_DIR ?? WINDOWS_MANAGER;
// Linux GTK 백엔드: 옛 naia-os 는 x11 무조건 강제(WebKitGTK XReparentWindow embedding).
// 그러나 XWayland 없는 순수 Wayland 세션(KDE Plasma 등, DISPLAY 비어있음)에선 x11 백엔드가
// 붙을 X 가 없어 GTK init 패닉(2026-06-13 실측: 루크 KDE Wayland tauri:dev 기동 불가).
// → X 가 실제로 있을 때는 x11을 강제한다. Wayland에서 Tauri child WebView
//   좌표가 무시되어 메인 창 아래에 붙는 회귀가 있다.
if (platform() === "linux") {
	const hasX = !!env.DISPLAY?.trim();
	env.GDK_BACKEND = hasX ? "x11" : (env.GDK_BACKEND ?? "wayland");
	// Wayland 백엔드: WebKitGTK DMABUF 렌더 버그(빈 화면) 회피로 소프트웨어 렌더 강제.
	// (2026-06-13: 이걸 떼고 하드웨어 GL 로 시도했더니 루크 환경에서 *오히려 더 느렸음* → 기동 지연의 원인은
	// GL 모드가 아니었다. 따라서 DMABUF off 유지가 그나마 나음. 기동 ~90초 지연(webview JS 스레드 블록 — set_root/
	// start_watch invoke 응답 지연, Rust 핸들러는 ms=0)은 *별개 미해결 이슈*: 후보 = browser child webview 생성/
	// WebKit GStreamer 미디어 init(GstIntRange 경고)/세션 누적 stray 프로세스. docs/progress 참조.)
	env.WEBKIT_DISABLE_DMABUF_RENDERER = env.WEBKIT_DISABLE_DMABUF_RENDERER ?? "1";
}

// ── prod: dev-gateway 변수 강제 제거 ──
if (mode === "prod") {
	delete env.VITE_NAIA_USE_DEV_GATEWAY;
	delete env.VITE_NAIA_DEV_GATEWAY_URL;
}

// 웹 베이스 URL은 모드가 소유한다 (#523). `tauri:prod`도 vite dev 서버로 뜨므로
// config.ts 의 `import.meta.env.DEV` 폴백은 항상 dev.naia.land 를 고른다 —
// `.env.prod` 파일이 없는 머신에서 prod 실행의 앱스토어/로그인이 dev 로 새던
// 실측 결함(2026-08-31, 시연 리허설). 아래 기본값은 뒤에 로드되는 `.env.{mode}`
// 파일이 있으면 그 값으로 덮인다(명시 파일 > 모드 기본값).
env.VITE_NAIA_WEB_BASE_URL =
	env.VITE_NAIA_WEB_BASE_URL ??
	(mode === "prod" ? "https://www.naia.land" : "https://dev.naia.land");

/** 최소 KEY=VALUE env 파일 파서(주석·빈줄 skip, 따옴표 제거). */
function loadEnvFile(path) {
	const vars = {};
	for (const raw of readFileSync(path, "utf8").split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		let val = line.slice(eq + 1).trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		if (key) vars[key] = val;
	}
	return vars;
}

const envPath = resolve(SHELL, `.env.${mode}`);
if (existsSync(envPath)) {
	let n = 0;
	for (const [k, v] of Object.entries(loadEnvFile(envPath))) {
		if (
			(k === "NAIA_AGENT_SCRIPT" || k === "NAIA_AGENT_PROTO_DIR") &&
			env[k]
		) {
			continue;
		}
		env[k] = v;
		n++;
	}
	process.stdout.write(`[tauri-with-mode] ${mode.toUpperCase()} — .env.${mode} 에서 ${n}개 주입\n`);
} else {
	process.stdout.write(`[tauri-with-mode] ${mode.toUpperCase()} — .env.${mode} 없음; config 기본값 사용\n`);
}

// A developer .env file must not be able to re-introduce native E2E ownership
// after the inherited environment was scrubbed above.
const postFileEnv = interactiveLaunchEnv(env);
for (const key of Object.keys(env)) delete env[key];
Object.assign(env, postFileEnv);

const pairedAgent = applyPairedAgentEnv(env);
// The Tauri process runs the compiled agent entrypoint. Always build the exact
// paired source before development so a clean checkout cannot start with a
// missing or stale dist/ tree.
runProjectPnpm(["run", "build"], pairedAgent, env);
if (!existsSync(resolve(pairedAgent, "dist/main/composition/index.js"))) {
	throw new Error(`Paired naia-agent build failed or did not produce dist/main/composition/index.js: ${pairedAgent}`);
}
process.stdout.write(`[tauri-with-mode] new core=${env.VITE_NAIA_NEW_CORE}, agent=${env.NAIA_AGENT_SCRIPT}, proto=${env.NAIA_AGENT_PROTO_DIR}\n`);

if (isBuild) {
	// Release installer: production tauri.conf.json (real app identity), no dev
	// overlay and no dev window. beforeBuildCommand builds the frontend.
	// NSIS only — it is the primary distributed artifact (Naia-Shell-x86_64-
	// setup.exe) and avoids the WiX/MSI (light.exe) toolchain, which is a
	// separate packaging concern from the app build.
	const bundles = process.argv[3] ? [process.argv[3]] : ["nsis"];
	const rb = spawnSync(
		"pnpm",
		["run", "tauri", "build", "--bundles", ...bundles],
		{ env, stdio: "inherit", shell: true },
	);
	process.exit(rb.status ?? 1);
}

const r = spawnSync(
	"pnpm",
	["run", "tauri", "dev", "--config", DEV_TAURI_CONFIG],
	{ env, stdio: "inherit", shell: true },
);
process.exit(r.status ?? 1);
