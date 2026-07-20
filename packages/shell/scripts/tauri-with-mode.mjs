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
import { existsSync, readFileSync, statSync } from "node:fs";
import { platform } from "node:os";
import { dirname, resolve } from "node:path";

const mode = process.argv[2] === "prod" ? "prod" : "dev";

const HERE = import.meta.dirname; // packages/shell/scripts
const SHELL = resolve(HERE, ".."); // packages/shell
const OS_ROOT = resolve(SHELL, "..", ".."); // new-naia-os
const REQUIRED_AGENT_COMMIT = "de844dfe0392d3174c12fcce5969e638ce997290";
const REQUIRED_PROTO_SHA256 = "49f4f5c1a983b1c563dd8a723fddc89134db2aba005b22b85e31161bc63c9f92";
const AGENT_CANDIDATES = [
	resolve(OS_ROOT, "..", "naia-agent"),
	resolve(OS_ROOT, "..", "..", "naia-agent"),
	resolve(OS_ROOT, "..", "..", "..", ".agents", "work", "naia-agent-issue-388-proto"),
	resolve(OS_ROOT, "..", "..", ".agents", "work", "naia-agent-issue-388-proto"),
];

function gitOutput(dir, args) {
	const r = spawnSync(
		"git",
		["-C", dir, ...args],
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
	return gitOutput(dir, ["status", "--porcelain"]) === "";
}

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isPairedAgentCheckout(dir) {
	return (
		existsSync(resolve(dir, "scripts/builds/agent-stdio-entry.mjs")) &&
		existsSync(resolve(dir, "src/main/adapters/grpc/naia_agent.proto")) &&
		hasRequiredAgentCommit(dir) &&
		isCleanProto(dir) &&
		isCleanAgentEntrypoint(dir) &&
		isCleanCheckout(dir) &&
		sha256File(resolve(dir, "src/main/adapters/grpc/naia_agent.proto")) === REQUIRED_PROTO_SHA256
	);
}

function firstPairedAgentCheckout() {
	for (const dir of AGENT_CANDIDATES) {
		if (isPairedAgentCheckout(dir)) return dir;
	}
	return null;
}

const PAIRED_AGENT = firstPairedAgentCheckout();
if (!PAIRED_AGENT) {
	throw new Error(
		`No paired naia-agent checkout contains ${REQUIRED_AGENT_COMMIT} with both agent-stdio-entry.mjs and naia_agent.proto`,
	);
}
const WINDOWS_MANAGER = resolve(OS_ROOT, "..", "naia-omni-windows-manager");

const env = { ...process.env };

// ── 새 코어 + 분리 에이전트 (new-naia-os 불변) ──
env.VITE_NAIA_NEW_CORE = env.VITE_NAIA_NEW_CORE ?? "1";
env.NAIA_AGENT_STANDALONE = env.NAIA_AGENT_STANDALONE ?? "1";
env.NAIA_AGENT_SCRIPT =
	env.NAIA_AGENT_SCRIPT ?? resolve(PAIRED_AGENT, "scripts/builds/agent-stdio-entry.mjs");
env.NAIA_AGENT_PROTO_DIR =
	env.NAIA_AGENT_PROTO_DIR ?? resolve(PAIRED_AGENT, "src/main/adapters/grpc");

function gitDirForPath(path) {
	let dir = resolve(path);
	if (existsSync(dir) && statSync(dir).isFile()) dir = dirname(dir);
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

// ── 로컬 cascade loader (dev): 소스 sibling repo(loader/ 포함 dir) 를 가리킨다.
// 패키지 빌드는 stage-cascade-loader.mjs 가 src-tauri/cascade-loader 로 동봉(resource_dir 해석).
env.NAIA_CASCADE_LOADER_DIR = env.NAIA_CASCADE_LOADER_DIR ?? WINDOWS_MANAGER;
// Linux GTK 백엔드: 옛 naia-os 는 x11 무조건 강제(WebKitGTK XReparentWindow embedding).
// 그러나 XWayland 없는 순수 Wayland 세션(KDE Plasma 등, DISPLAY 비어있음)에선 x11 백엔드가
// 붙을 X 가 없어 GTK init 패닉(2026-06-13 실측: 루크 KDE Wayland tauri:dev 기동 불가).
// → X 가 실제로 있을 때만 x11, 아니면 wayland. 호출자 명시값(GDK_BACKEND)은 보존.
if (platform() === "linux") {
	const hasX = !!(env.DISPLAY && env.DISPLAY.trim());
	env.GDK_BACKEND = env.GDK_BACKEND ?? (hasX ? "x11" : "wayland");
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
		env[k] = v;
		n++;
	}
	process.stdout.write(`[tauri-with-mode] ${mode.toUpperCase()} — .env.${mode} 에서 ${n}개 주입\n`);
} else {
	process.stdout.write(`[tauri-with-mode] ${mode.toUpperCase()} — .env.${mode} 없음; config 기본값 사용\n`);
}

validateAgentEnvPair(env.NAIA_AGENT_SCRIPT, env.NAIA_AGENT_PROTO_DIR);
process.stdout.write(`[tauri-with-mode] new core=${env.VITE_NAIA_NEW_CORE}, agent=${env.NAIA_AGENT_SCRIPT}, proto=${env.NAIA_AGENT_PROTO_DIR}\n`);

const r = spawnSync("pnpm", ["run", "tauri", "dev"], { env, stdio: "inherit", shell: true });
process.exit(r.status ?? 1);
