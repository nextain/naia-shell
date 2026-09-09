import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { execPath } from "node:process";
import { resolvePairedAgent } from "../scripts/agent-pairing.mjs";
import { reclaimLeakedAgentChild as reclaimAgentChild } from "./agent-child-lease.js";
import { reclaimSidecarForRuntimeDir } from "./bgm-sidecar-lease.mjs";
import {
	CREDENTIALED_KEY_ENV,
	CREDENTIALED_MAIN_MODEL,
	CREDENTIALED_MAIN_PROVIDER,
	credentialedSeedAvailable,
	credentialedSeedOptionsFromEnv,
	seedCredentialedAdk,
} from "./credentialed-adk-seed.js";
import { applyHarnessXdg } from "./e2e-xdg.mjs";
import { isCoverFailure, reportCover } from "./helpers/cover-probe.mjs";
import { stopHarnessHerdrSession } from "./herdr-session.mjs";
import { startNotifyWebhookStub } from "./notify-webhook-stub.mjs";

// Enable debug logging for Tauri app — Rust logs all agent events to stderr + naia.log
process.env.CAFE_DEBUG_E2E = "1";
process.env.NAIA_E2E_MODE = "1";
// E2E mock: bypass GitHub clone + agent-kill-before-delete so ADK setup
// scenarios run in milliseconds without network/process flakiness (#328).
process.env.NAIA_E2E_MOCK_CLONE = "1";
// Load shell/.env.e2e first (e2e-only knobs like VITE_NAIA_DEV_GATEWAY_URL),
// then shell/.env (shared defaults). first-match-wins per key so .env.e2e
// values take precedence. Keeping the dev-gateway URL out of .env is what
// prevents `pnpm run tauri:dev` from breaking a prod OAuth login (#333).
function loadEnvFile(filePath: string): void {
	try {
		const content = readFileSync(filePath, "utf-8");
		for (const line of content.split("\n")) {
			const match = line.match(/^([^#=]+)=(.*)$/);
			if (match) {
				const key = match[1].trim();
				const rawVal = match[2].trim();
				const val = rawVal.replace(/^['"]|['"]$/g, "");
				if (!process.env[key]) process.env[key] = val;
			}
		}
	} catch {
		/* file not found — keep going */
	}
}
loadEnvFile(resolve(import.meta.dirname, "../.env.e2e"));
loadEnvFile(resolve(import.meta.dirname, "../.env"));

// ── Platform constants ────────────────────────────────────────────────────────
// Linux uses WebKit2GTK + WebKitWebDriver; Windows uses WebView2 + msedgedriver.
// Keep Linux behavior identical to the original config and branch for win32.
const IS_WINDOWS = process.platform === "win32";
const EXE = IS_WINDOWS ? ".exe" : "";

// Every runner gets an identity before it creates any child process. The identity
// is inherited by Vite, the native app, and the agent so artifacts and cleanup can
// be attributed to one run without matching unrelated process names.
const E2E_RUN_ID = process.env.NAIA_E2E_RUN_ID?.trim() || randomUUID();
if (E2E_RUN_ID.length > 64 || !/^[A-Za-z0-9_-]+$/.test(E2E_RUN_ID)) {
	throw new Error(`Invalid NAIA_E2E_RUN_ID: ${E2E_RUN_ID}`);
}
process.env.NAIA_E2E_RUN_ID = E2E_RUN_ID;

function hashRunId(value: string): number {
	let hash = 2_166_136_261;
	for (const char of value) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

function parsePort(
	raw: string | undefined,
	fallback: number,
	name: string,
): number {
	if (!raw?.trim()) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1024 || value > 65_535) {
		throw new Error(`${name} must be a TCP port between 1024 and 65535`);
	}
	return value;
}

const RUN_HASH = hashRunId(E2E_RUN_ID);
// Keep the WebDriver and Vite ranges separate so a generated pair cannot collide.
const IN_APP_PORT = parsePort(
	process.env.NAIA_E2E_WEBDRIVER_PORT,
	45_000 + (RUN_HASH % 1_000),
	"NAIA_E2E_WEBDRIVER_PORT",
);
const NATIVE_DRIVER_PORT = parsePort(
	process.env.NAIA_E2E_NATIVE_DRIVER_PORT,
	47_000 + (RUN_HASH % 1_000),
	"NAIA_E2E_NATIVE_DRIVER_PORT",
);
const DEFAULT_VITE_PORT = 46_000 + ((RUN_HASH + 503) % 1_000);
// The native app and its sidecars otherwise fall back to the product ports
// (18791/18792). Derive one pair per runner and pass the same values to Rust,
// Vite, and any inherited worker. Explicit values remain available for a
// caller that has reserved ports before loading this config.
const E2E_BGM_PORT = parsePort(
	process.env.NAIA_BGM_PORT?.trim() || process.env.NAIA_E2E_BGM_PORT?.trim(),
	18_000 + (RUN_HASH % 1_000),
	"NAIA_BGM_PORT",
);
const E2E_OAUTH_CALLBACK_PORT = parsePort(
	process.env.NAIA_OAUTH_CALLBACK_PORT?.trim() ||
		process.env.NAIA_E2E_OAUTH_CALLBACK_PORT?.trim(),
	19_000 + (RUN_HASH % 1_000),
	"NAIA_OAUTH_CALLBACK_PORT",
);
process.env.NAIA_E2E_WEBDRIVER_PORT = String(IN_APP_PORT);
process.env.NAIA_E2E_NATIVE_DRIVER_PORT = String(NATIVE_DRIVER_PORT);
process.env.NAIA_BGM_PORT = String(E2E_BGM_PORT);
process.env.NAIA_E2E_BGM_PORT = String(E2E_BGM_PORT);
process.env.VITE_NAIA_BGM_BASE = `http://127.0.0.1:${E2E_BGM_PORT}`;
process.env.NAIA_OAUTH_CALLBACK_PORT = String(E2E_OAUTH_CALLBACK_PORT);
process.env.NAIA_E2E_OAUTH_CALLBACK_PORT = String(E2E_OAUTH_CALLBACK_PORT);
process.env.VITE_NAIA_OAUTH_CALLBACK_URL = `http://127.0.0.1:${E2E_OAUTH_CALLBACK_PORT}/auth/callback`;

// ── e2e 실행 자리 격리 ────────────────────────────────────────────────────────
// Rust 는 CAFE_DEBUG_E2E=1 일 때 로그(lib.rs log_dir)와 실행 중 리스·PID(lib.rs
// run_dir/agent_child_lease_path)를 `NAIA_E2E_RUNTIME_DIR` 아래에 둔다. 전용 설정
// 둘(codex-e2e-environment.ts, radio-queue-e2e-environment.ts)은 이미 그 변수를
// 잡는데 **이 기본 설정만 빠져 있었다**. 그래서 이 설정으로 도는 스펙 백여 개가
// 운영 앱과 같은 `~/.naia/run`·`~/.naia/logs` 를 썼다.
//
// 그 대가가 둘이었다. 하나, 앞 스펙의 에이전트 자식이 리스를 쥔 채 살아남으면
// 다음 스펙의 셸이 `agent-core not available: agent_lease_live_blocked` 로 뇌 없이
// 돌았다(이 기계에 그렇게 고아가 된 에이전트가 30개 쌓여 있었다). 둘, "`~/.naia`
// 에는 `adk-path` 하나만" 이라는 규칙을 회귀가 돌 때마다 다시 어겼다.
//
// 자리는 **OS 임시 디렉터리 아래**다. 저장소 안에 두면 `git add` 에 딸려 들어가고
// (실제로 그 사고가 있었다), 홈 아래에 두면 규칙 위반이 그대로다.
const E2E_RUNTIME_PARENT = resolve(tmpdir());
const E2E_RUNTIME_NAME = `naia-shell-e2e-${E2E_RUN_ID}`;
const E2E_RUNTIME_DIR = resolve(E2E_RUNTIME_PARENT, E2E_RUNTIME_NAME);
// 밖에서 이미 정해 넣었으면 그것이 정본이다 — 감싸는 러너가 자기 자리를 주는
// 경우를 덮어쓰면, 그 러너는 자기가 정리할 곳이 아닌 데를 보게 된다.
const OWNS_RUNTIME_DIR = !process.env.NAIA_E2E_RUNTIME_DIR?.trim();
if (OWNS_RUNTIME_DIR) process.env.NAIA_E2E_RUNTIME_DIR = E2E_RUNTIME_DIR;
const EFFECTIVE_RUNTIME_DIR = resolve(
	process.env.NAIA_E2E_RUNTIME_DIR?.trim() || E2E_RUNTIME_DIR,
);
// NAIA_HOME is part of the Rust data-home boundary, so inheriting a user's
// product home would still share config, leases, and logs between runners.
// An explicit E2E home is caller-owned; otherwise each generated run gets one.
const explicitE2eHome = process.env.NAIA_E2E_HOME?.trim();
const E2E_HOME = explicitE2eHome
	? resolve(explicitE2eHome)
	: resolve(EFFECTIVE_RUNTIME_DIR, "home");
process.env.NAIA_E2E_HOME = E2E_HOME;
process.env.NAIA_HOME = E2E_HOME;
// 자리는 여기서 만들지 않는다. import 만으로 디렉터리가 생기면 계약 테스트가
// 파일시스템을 더럽힌다. 실제로 만드는 것은 onPrepare 와 Rust 의 create_dir_all.

// 앱 프로필(WebKit 의 localStorage·IndexedDB, audit.db)도 그 자리 아래로 옮긴다.
// 안 옮기면 `~/.config/com.naia.shell.e2e/` 에 남아 스펙 사이·실행 사이에 상태가
// 살아남는다 — 자세한 이유는 `e2e-xdg.mjs` 머리말. 값은 여기서 세우고 자리는
// onPrepare 가 만든다.
const HARNESS_XDG = applyHarnessXdg();
const explicitProfileDir = process.env.NAIA_E2E_PROFILE_DIR?.trim();
const E2E_PROFILE_DIR = explicitProfileDir
	? resolve(explicitProfileDir)
	: resolve(EFFECTIVE_RUNTIME_DIR, "profile");
process.env.NAIA_E2E_PROFILE_DIR = E2E_PROFILE_DIR;
if (IS_WINDOWS) {
	const appDataRoot = process.env.NAIA_E2E_APPDATA?.trim()
		? resolve(process.env.NAIA_E2E_APPDATA.trim())
		: resolve(EFFECTIVE_RUNTIME_DIR, "appdata");
	// Windows always supplies APPDATA/LOCALAPPDATA globally. Assign the private
	// run paths explicitly; `??=` would silently keep the user's shared profile.
	process.env.APPDATA = resolve(appDataRoot, "roaming");
	process.env.LOCALAPPDATA = resolve(appDataRoot, "local");
	process.env.WEBVIEW2_USER_DATA_FOLDER = E2E_PROFILE_DIR;
}

// ── 자격증명 등급의 살아 있는 기본 공급자 (#547) ──────────────────────────────
// 에이전트는 셸이 실어 보내는 provider 를 gRPC 경계에서 버리고, 워크스페이스의
// `naia-settings/config.json` 으로 활성 공급자를 재구성한다. 그러니 e2e 가 자기
// 워크스페이스를 갖지 않으면 에이전트는 사람이 쓰던 실제 ADK 의 설정을 읽고,
// 갖더라도 아무것도 심지 않으면 죽은 값을 물고 `fetch failed` 로 끝난다.
//
// 게이트웨이 키가 환경에 있을 때에만(= 자격증명 등급일 때에만) 실행 자리 아래에
// 워크스페이스를 하나 만들고 거기에 살아 있는 공급자를 심는다. 키가 없으면 아무것도
// 하지 않는다 — 결정론 등급은 예전 그대로 돈다.
//
// 밖에서 이미 `NAIA_E2E_ADK_PATH` 를 준 경우(전용 설정, 감싸는 러너)에는 손대지
// 않는다. 그쪽이 자기 워크스페이스의 주인이다.
const EXPLICIT_ADK_PATH = process.env.NAIA_E2E_ADK_PATH?.trim();
const SEEDED_ADK_PATH = resolve(EFFECTIVE_RUNTIME_DIR, "adk");
const SEEDS_CREDENTIALED_ADK =
	!EXPLICIT_ADK_PATH && credentialedSeedAvailable();
if (EXPLICIT_ADK_PATH) {
	process.env.NAIA_E2E_ADK_PATH = EXPLICIT_ADK_PATH;
} else {
	// Even a credential-free smoke must get a private ADK path. Falling back to
	// ~/.naia here makes two workers overwrite each other's config and leases.
	process.env.NAIA_E2E_ADK_PATH = SEEDED_ADK_PATH;
	process.env.NAIA_E2E_ADK_FIXTURE = SEEDED_ADK_PATH;
}
if (SEEDS_CREDENTIALED_ADK) {
	// 이 설정은 워커에서도 다시 읽히는데, 그때는 위 경로가 이미 환경에 있어
	// `SEEDS_CREDENTIALED_ADK` 가 거짓이 된다. 그러면 스펙 앞에서 키를 실어 주는
	// 대목이 통째로 건너뛰어지고, 실패는 401 이라는 엉뚱한 모습으로만 보인다
	// (실측). 심었다는 사실 자체를 환경에 남겨 워커가 같은 판단을 하게 한다.
	process.env.NAIA_E2E_CREDENTIALED_SEED = "1";
	// 조건부로만 합성되는 도구의 전제를 세운다 (#567 재조준). 어댑터는 배선돼
	// 있는데 이 값이 없으면 그 도구가 목록에 오르지 않아, 모델이 "그런 도구가
	// 없다" 고 답한다 — 배선 부재와 구별되지 않는 모습이다. 목록의 정본은
	// `harness-provided-env.mjs` 이고 러너의 선별도 같은 곳을 본다.
	//
	// `shell_exec` 는 격리 실행 자리 아래(`allowRoots = adkPath`)로만 나간다.
	process.env.NAIA_SHELL_TOOL = "1";
	process.env.NAIA_E2E_NOTIFY_LOG = resolve(
		EFFECTIVE_RUNTIME_DIR,
		"notify-received.jsonl",
	);
}
/** 이 실행이 격리 ADK 에 살아 있는 공급자를 심었는가 — 런처와 워커가 같이 본다. */
const CREDENTIALED_SEED_ACTIVE = process.env.NAIA_E2E_CREDENTIALED_SEED === "1";

// 네이티브(Rust)는 e2e 에서 NAIA_E2E_ADK_PATH 를 워크스페이스 정본으로 삼는다
// (lib.rs current_adk_path/spawn_adk_path_snapshot). 그런데 화면(웹) 쪽은
// localStorage 의 `naia-adk-path` 를 쓰고, 그 값을 e2e 환경에 맞춰 다시 묶는 코드는
// App.tsx 에서 VITE_NAIA_E2E_MODE=1 일 때만 돈다. 그 두 변수를 여기서 같이 넘겨 주지
// 않으면, WebKit 프로필에 남아 있던 이전 실행(예: codex-live 격리 워크스페이스)의 경로가
// 그대로 살아남아 화면은 그 경로에 설정을 쓰고 에이전트는 다른 워크스페이스를 읽는다.
// 그러면 UI 에서 고른 provider 가 에이전트에 영영 닿지 않는다.
if (process.env.NAIA_E2E_ADK_PATH?.trim()) {
	process.env.VITE_NAIA_E2E_MODE = "1";
	process.env.VITE_NAIA_E2E_ADK_PATH = process.env.NAIA_E2E_ADK_PATH.trim();
	// App.tsx 는 온보딩 전이면 VITE_NAIA_E2E_PROVIDER/MODEL 로 화면 설정을 채우고,
	// 기본값이 `ollama/e2e` 다 — 이 기계에 없는 서버다. 심은 공급자와 같은 값을 준다.
	if (CREDENTIALED_SEED_ACTIVE) {
		process.env.VITE_NAIA_E2E_PROVIDER ??= CREDENTIALED_MAIN_PROVIDER;
		process.env.VITE_NAIA_E2E_MODEL ??= CREDENTIALED_MAIN_MODEL;
	}
}

/** 지울 수 있는 것은 이 설정이 이름까지 정한 자리뿐이다. */
function assertOwnedRuntimeDir(): string {
	const candidate = resolve(E2E_RUNTIME_DIR);
	if (
		!OWNS_RUNTIME_DIR ||
		dirname(candidate) !== E2E_RUNTIME_PARENT ||
		basename(candidate) !== E2E_RUNTIME_NAME
	) {
		throw new Error(`Refusing to clean a non-E2E path: ${candidate}`);
	}
	return candidate;
}

const SHELL_DIR = resolve(import.meta.dirname, "..");
// 짝 저장소를 찾는 규칙은 빌드와 하나여야 한다 (#539). 빌드가 어느 워크트리를
// 골라 바이너리에 박아 두면, 실행이 다른 것을 넘길 때 앱이 자기 짝이 아니라며
// 거절한다. 예전에는 두 규칙이 달라 그 어긋남이 실제로 났다.
const {
	pairedAgent: PAIRED_AGENT_DIR,
	agentScript: PAIRED_AGENT_SCRIPT,
	agentProtoDir: PAIRED_AGENT_PROTO_DIR,
} = resolvePairedAgent();
// The test launches the debug executable directly, bypassing tauri-with-mode.
// Inject the same verified pair used by `pnpm run tauri:dev`; without this the
// app opens but deliberately disables chat because no agent script is present.
process.env.NAIA_AGENT_SCRIPT = PAIRED_AGENT_SCRIPT;
process.env.NAIA_AGENT_PROTO_DIR = PAIRED_AGENT_PROTO_DIR;
// `build:e2e:tauri` 는 개발 타깃과 섞이지 않도록 target-e2e 에 짓는다 (#539).
// 여기서 개발 타깃을 띄우면 지금 고친 코드가 아니라 예전 빌드를 재게 된다 —
// 실제로 짝 저장소가 어긋난 것처럼 보이던 실패가 이것이었다.
const E2E_TARGET_DIR = resolve(
	process.env.NAIA_E2E_TARGET_DIR ?? resolve(SHELL_DIR, "src-tauri/target-e2e"),
);
const TAURI_BINARY = process.env.TAURI_BINARY
	? resolve(process.env.TAURI_BINARY)
	: resolve(E2E_TARGET_DIR, `debug/naia-shell${EXE}`);

// Vosk 의 공유 라이브러리는 빌드 산출물 안에 놓인다. 기본 타깃에서는 바이너리
// 옆으로 복사되지만 e2e 타깃에서는 그렇지 않아, 앱이 libvosk.so 를 못 찾고
// 세션 생성 단계에서 죽는다 (#539). 그 자리를 로더에게 알려 준다.
if (!IS_WINDOWS) {
	const buildDir = resolve(E2E_TARGET_DIR, "debug", "build");
	if (existsSync(buildDir)) {
		for (const entry of readdirSync(buildDir)) {
			const candidate = resolve(buildDir, entry, "out", "vosk-lib");
			if (!existsSync(resolve(candidate, "libvosk.so"))) continue;
			const existing = process.env.LD_LIBRARY_PATH ?? "";
			process.env.LD_LIBRARY_PATH = existing
				? `${candidate}:${existing}`
				: candidate;
			break;
		}
	}
}
const TAURI_DRIVER = resolve(homedir(), `.cargo/bin/tauri-driver${EXE}`);
const NATIVE_DRIVER = IS_WINDOWS
	? resolve(SHELL_DIR, "e2e-tauri/.drivers/msedgedriver.exe")
	: "/usr/bin/WebKitWebDriver";
// Run Vite via node directly — avoids `pnpm.cmd` (which Windows' CreateProcess
// refuses to spawn without a shell, producing `spawn EINVAL`) and also avoids
// the `shell:true + args[]` DEP0190 warning introduced in Node 22.
const VITE_ENTRY = resolve(SHELL_DIR, "node_modules/vite/bin/vite.js");
/**
 * dev 서버는 e2e 바이너리가 실제로 찾아가는 주소에 떠야 한다.
 * 그 주소의 정본은 `tauri.e2e.conf.json` 의 devUrl 이므로 거기서 읽는다 — 여기 상수로
 * 적어 두면 둘이 갈라진다(2026-08-26: conf 는 1420 에 띄우는데 바이너리는 1422 를 봤다).
 *
 * ⚠️ 호스트도 맞춰야 한다. Vite 는 기본으로 `[::1]`(IPv6) 에만 바인드하는데 devUrl 이
 *    `127.0.0.1`(IPv4) 이면 앱이 붙지 못하고 about:blank 에 머문다. 그러면 origin 이 null 이라
 *    Tauri IPC 가 모든 호출을 "Origin header is not a valid URL" 로 거절한다 —
 *    실패가 스펙이 아니라 하네스에서 나므로 원인을 찾기 어렵다.
 */
const configuredDevUrl = process.env.NAIA_E2E_DEV_URL?.trim();
const staticDevUrl =
	(
		JSON.parse(
			readFileSync(
				resolve(SHELL_DIR, "src-tauri", "tauri.e2e.conf.json"),
				"utf8",
			),
		) as { build?: { devUrl?: string } }
	).build?.devUrl ?? "http://127.0.0.1:1420";
const requestedDevUrl = new URL(configuredDevUrl || staticDevUrl);
const requestedHost = requestedDevUrl.hostname;
if (!["127.0.0.1", "localhost", "[::1]"].includes(requestedHost)) {
	throw new Error(`E2E devUrl must be loopback, got ${requestedDevUrl.href}`);
}
const explicitVitePort = process.env.NAIA_E2E_VITE_PORT?.trim();
const vitePort = parsePort(
	explicitVitePort,
	explicitVitePort
		? Number(explicitVitePort)
		: configuredDevUrl
			? Number(requestedDevUrl.port || "1420")
			: DEFAULT_VITE_PORT,
	"NAIA_E2E_VITE_PORT",
);
const E2E_DEV_URL = new URL(`http://${requestedHost}:${vitePort}`);
const VITE_PORT = vitePort;
// URL.hostname retains brackets for IPv6 literals, while Vite expects the
// unbracketed bind address. Keep the bracketed form only in the URL.
const VITE_HOST = requestedHost === "[::1]" ? "::1" : requestedHost;
process.env.NAIA_E2E_VITE_PORT = String(VITE_PORT);
process.env.NAIA_E2E_DEV_URL = E2E_DEV_URL.href;

let tauriDriver: ChildProcess | undefined;
let notifyStub: Awaited<ReturnType<typeof startNotifyWebhookStub>> | undefined;
let viteServer: ChildProcess | undefined;
let permissionPoller: { dispose: () => void } | undefined;

// ── Process cleanup helpers ───────────────────────────────────────────────────

/**
 * 앞선 실행이 흘린 agent 자식을 회수한다 (#541).
 *
 * 셸은 종료해도 자기가 띄운 agent 를 함께 데려가지 못할 때가 있다. 그 고아가
 * lease 를 쥔 채 남으면 다음 실행의 셸이 `agent_lease_live_blocked` 로 대화를
 * 아예 못 하고, 화면에는 스킬 등록 실패로만 보인다 — 원인과 증상이 멀다.
 *
 * lease 파일이 가리키는 것만 정리한다. 이름으로 훑어 죽이면 사람이 쓰고 있는
 * 앱의 agent 까지 잡는다.
 */
/** 실행 자리의 리스가 가리키는 agent 자식을 회수한다. 회수했으면 한 줄 남긴다. */
// 전용 설정(wdio.conf.chat.ts)이 이 이름을 import 하는데 export 가 아니어서 그쪽
// afterSession 이 매번 `is not a function` 으로 죽었다 — 처음 쓰일 때부터 그랬다.
// 계약(e2e-inherited-conf-contracts)이 이제 "가져가는 이름은 내보낸다" 를 잰다.
export function reclaimLeakedAgentChild(): boolean {
	// 격리한 실행 자리의 리스만 본다. 홈의 리스를 보면 사람이 지금 쓰고 있는
	// 앱의 에이전트를 잡는다 — 그 자리는 더 이상 e2e 의 것이 아니다.
	const outcome = reclaimAgentChild(
		process.env.NAIA_E2E_RUNTIME_DIR ?? E2E_RUNTIME_DIR,
	);
	if (outcome.reclaimed) {
		console.log(
			`[e2e] reclaimed leaked agent child (pid ${outcome.pid}, ${outcome.reason})`,
		);
	}
	return outcome.reclaimed;
}

/**
 * 이 실행 자리를 물고 있던 BGM 사이드카를 회수한다 (#577).
 *
 * 에이전트 자식과 같은 자리에서, 같은 순서로 돈다 — 자리를 지우기 **전에**.
 * 자리를 먼저 지우면 `bgm-server.pid` 가 함께 사라져 고아를 가리키던 단서가
 * 없어진다. 실측에서 그렇게 남은 사이드카가 여덟이었다.
 *
 * 자리와 표식과 환경이 모두 맞을 때에만 손댄다. 이름으로 훑지 않는다.
 */
function reclaimLeakedBgmSidecar(): boolean {
	const outcome = reclaimSidecarForRuntimeDir(
		process.env.NAIA_E2E_RUNTIME_DIR ?? E2E_RUNTIME_DIR,
	);
	if (outcome.reclaimed) {
		console.log(
			`[e2e] reclaimed leaked BGM sidecar (pid ${outcome.pid}, ${outcome.reason})`,
		);
	}
	return outcome.reclaimed;
}

/** Fail closed when a generated or explicitly requested run port is occupied. */
function requirePortFree(port: number, host = "127.0.0.1"): Promise<void> {
	return new Promise((resolvePort, rejectPort) => {
		const socket = connect({ host, port });
		const finish = (error?: Error) => {
			socket.destroy();
			if (error) rejectPort(error);
			else resolvePort();
		};
		socket.once("connect", () =>
			finish(new Error(`E2E port ${port} is already in use by another run`)),
		);
		socket.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ECONNREFUSED") finish();
			else finish(error);
		});
		socket.setTimeout(750, () =>
			finish(new Error(`Timed out checking E2E port ${port}`)),
		);
	});
}

function childIsRunning(
	child: ChildProcess | undefined,
): child is ChildProcess {
	// A failed spawn (for example ENOENT or a missing DLL on Windows) can return
	// a ChildProcess object before it emits `error`, but it never owns a PID. Do
	// not treat that object as a live process during cleanup.
	return Boolean(
		child &&
		child.pid &&
		child.exitCode === null &&
		child.signalCode === null,
	);
}

function signalOwnedProcess(child: ChildProcess, signal: NodeJS.Signals): void {
	if (!child.pid) return;
	if (IS_WINDOWS) {
		// `/PID` is the exact child we spawned; `/T` covers only its descendants.
		spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
			stdio: "ignore",
		});
		return;
	}
	try {
		// Vite and tauri-driver are spawned as detached process groups below.
		process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			/* The owned child exited between the status check and the signal. */
		}
	}
}

async function stopOwnedProcess(
	child: ChildProcess | undefined,
	label: string,
): Promise<void> {
	if (!childIsRunning(child)) return;
	signalOwnedProcess(child, "SIGTERM");
	try {
		await waitForChildExit(child, 5_000);
	} catch {
		if (childIsRunning(child)) signalOwnedProcess(child, "SIGKILL");
		try {
			await waitForChildExit(child, 5_000);
		} catch {
			throw new Error(`Owned ${label} process did not exit`);
		}
	}
}

function waitForChildExit(
	child: ChildProcess,
	timeoutMs: number,
): Promise<void> {
	if (!childIsRunning(child)) return Promise.resolve();
	return new Promise((resolveExit, rejectExit) => {
		const onExit = () => {
			clearTimeout(timer);
			resolveExit();
		};
		const timer = setTimeout(() => {
			child.removeListener("exit", onExit);
			rejectExit(new Error("child exit timeout"));
		}, timeoutMs);
		child.once("exit", onExit);
		if (!childIsRunning(child)) {
			clearTimeout(timer);
			resolveExit();
		}
	});
}

/** Wait until a port is accepting connections. */
export function waitForPort(
	port: number,
	timeoutMs = 30_000,
	ownedChild?: { child: ChildProcess; label: string },
	connectPort: typeof connect = connect,
): Promise<void> {
	return new Promise((ok, fail) => {
		const deadline = Date.now() + timeoutMs;
		const sockets = new Set<ReturnType<typeof connect>>();
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;

		const cleanup = () => {
			if (retryTimer !== undefined) clearTimeout(retryTimer);
			for (const socket of sockets) socket.destroy();
			sockets.clear();
			if (ownedChild) {
				ownedChild.child.removeListener("error", onChildError);
				ownedChild.child.removeListener("exit", onChildExit);
			}
		};
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) fail(error);
			else ok();
		};
		const failForChild = (reason: string) => {
			const label = ownedChild?.label ?? "owned process";
			finish(
				new Error(
					`Owned ${label} failed before port ${port} was ready: ${reason}`,
				),
			);
		};
		const onChildError = (error: Error) => {
			failForChild(`startup error: ${error.message}`);
		};
		const onChildExit = (code: number | null, signal: NodeJS.Signals | null) => {
			failForChild(
				`exited before readiness (code=${code ?? "null"}, signal=${signal ?? "none"})`,
			);
		};

		if (ownedChild) {
			ownedChild.child.once("error", onChildError);
			ownedChild.child.once("exit", onChildExit);
			if (
				ownedChild.child.exitCode !== null ||
				ownedChild.child.signalCode !== null
			) {
				failForChild(
					`already exited (code=${ownedChild.child.exitCode ?? "null"}, signal=${ownedChild.child.signalCode ?? "none"})`,
				);
				return;
			}
		}

		const tryConnect = () => {
			if (settled) return;
			retryTimer = undefined;
			const hosts = ["127.0.0.1", "::1", "localhost"] as const;
			let attempts = hosts.length;
			let connected = false;
			for (const host of hosts) {
				if (settled) return;
				const socket = connectPort(port, host);
				sockets.add(socket);
				socket.once("connect", () => {
					sockets.delete(socket);
					if (connected || settled) {
						socket.destroy();
						return;
					}
					connected = true;
					socket.destroy();
					finish();
				});
				socket.once("error", () => {
					sockets.delete(socket);
					socket.destroy();
					attempts -= 1;
					if (connected || settled || attempts > 0) return;
					if (Date.now() >= deadline) {
						finish(new Error(`Port ${port} not ready within ${timeoutMs}ms`));
					} else {
						retryTimer = setTimeout(tryConnect, 500);
					}
				});
			}
		};
		tryConnect();
	});
}

/** Wait until a previously-owned test port is actually released before reuse. */
function waitForPortClosed(port: number, timeoutMs = 10_000): Promise<void> {
	return new Promise((ok, fail) => {
		const deadline = Date.now() + timeoutMs;
		const tryConnect = () => {
			const sock = connect(port, "127.0.0.1");
			sock.once("connect", () => {
				sock.destroy();
				if (Date.now() > deadline) {
					fail(
						new Error(`Port ${port} was not released within ${timeoutMs}ms`),
					);
				} else {
					setTimeout(tryConnect, 150);
				}
			});
			sock.once("error", () => {
				sock.destroy();
				ok();
			});
		};
		tryConnect();
	});
}

/**
 * 심은 공급자에 쓸 게이트웨이 키를 에이전트에 실어 준다 (#547).
 *
 * 이것을 함수로 빼 둔 이유가 있다. 이 설정을 상속하면서 `before()` 만 갈아
 * 끼우는 설정이 있는데(wdio.conf.chat.ts), 그러면 키 전달이 통째로 빠진다.
 * 그 설정이 실제로 401 을 받았다 — 시딩은 상속되는데 키는 안 실린 것이다.
 * 상속하는 쪽이 자기 `before()` 에서 이 하나만 부르면 된다.
 */
export async function deliverCredentialedGatewayKey(): Promise<void> {
	// 심은 공급자에 쓸 게이트웨이 키를 에이전트에 실어 준다 (#547).
	//
	// config.json 의 `credentialRef` 만으로는 부족하다. 에이전트는 매 턴
	// `credentials.get(provider)` 를 설정 위에 덮어쓰는데, 리눅스에서 그것은 OS
	// 키체인(`secret-tool`)을 본다. 그 기계에 게이트웨이 키가 하나 남아 있으면
	// 그 값이 이겨서, 우리가 심은 키 대신 남의 키로 게이트웨이를 두드리다 401 을
	// 받는다(실측). 로그인 경로와 같은 wire(`creds_update`)로 보내면 그 덮어쓰기
	// 자체를 런타임 overlay 로 눌러, 어느 기계에서도 같은 키를 쓴다.
	//
	// 키는 이 프로세스의 환경에서 곧장 실려 파일에 남지 않는다. 스펙이 스스로
	// 다른 provider 로 갈아타면 그쪽 슬롯을 쓰므로 충돌하지 않는다.
	if (CREDENTIALED_SEED_ACTIVE) {
		// `browser.execute` 는 동기 실행이라 async 콜백의 promise 를 기다리지
		// 않는다. 결과를 창에 남기고 그것이 나타날 때까지 기다린다 — 안 그러면
		// 키가 닿았는지 모르는 채로 스펙이 시작하고, 실패는 401 이라는 엉뚱한
		// 모습으로 나타난다.
		await browser.execute(
			(message: string) => {
				const shell = window as unknown as {
					__TAURI_INTERNALS__?: {
						invoke: (command: string, value: unknown) => Promise<unknown>;
					};
					__naiaE2eCredsSeed?: string;
				};
				shell.__naiaE2eCredsSeed = "pending";
				const invoke = shell.__TAURI_INTERNALS__?.invoke;
				if (!invoke) {
					shell.__naiaE2eCredsSeed = "error: Tauri invoke unavailable";
					return;
				}
				invoke("send_to_agent_command", { message }).then(
					() => {
						shell.__naiaE2eCredsSeed = "ok";
					},
					(error: unknown) => {
						shell.__naiaE2eCredsSeed = `error: ${String(error)}`;
					},
				);
			},
			JSON.stringify({
				type: "creds_update",
				// 심을 때 고른 provider 와 같아야 한다. 환경으로 바꿔 끼웠는데
				// 키를 기본 provider 슬롯에 넣으면 그 키가 영영 안 쓰인다.
				provider:
					credentialedSeedOptionsFromEnv().provider ??
					CREDENTIALED_MAIN_PROVIDER,
				naiaKey: process.env[CREDENTIALED_KEY_ENV] ?? "",
			}),
		);
		let credsSeedState = "pending";
		await browser.waitUntil(
			async () => {
				credsSeedState = await browser.execute(
					() =>
						(window as unknown as { __naiaE2eCredsSeed?: string })
							.__naiaE2eCredsSeed ?? "pending",
				);
				return credsSeedState !== "pending";
			},
			{
				timeout: 15_000,
				timeoutMsg: "creds_update(게이트웨이 키) 가 에이전트에 닿지 않았다",
			},
		);
		if (credsSeedState !== "ok") {
			// 이 실패는 대개 키 문제가 아니라 **뇌가 없다** 는 뜻이다. 네이티브가 앞
			// 세션이 흘린 리스 때문에 agent 를 안 띄우면(`agent_lease_live_blocked`)
			// 이 wire 가 곧장 막히고 재시작마저 억제(cooldown)에 걸린다. 이름을 그대로
			// 두면 다음 사람이 자격증명을 뒤진다 — 실제로 그렇게 한 번 샜다.
			throw new Error(
				`creds_update failed: ${credsSeedState}${
					/restart debounced|not running|died/.test(credsSeedState)
						? " — 이 세션은 agent 없이 떴다. 앞 세션의 agent 자식이 리스를 쥐고" +
							" 있었을 가능성이 크다 (naia.log 의 agent_lease_live_blocked)."
						: ""
				}`,
			);
		}
		console.log("[e2e] gateway key delivered to agent (creds_update)");
		await browser.pause(500);
	}
}

export const config = {
	runner: "local" as const,

	specs: ["./specs/**/*.spec.ts"],
	maxInstances: 1,
	capabilities: [
		{
			maxInstances: 1,
			// ★ WebKitWebDriver(webkit2gtk 2.52.3)는 wdio 9 가 W3C 세션에 자동 활성하는 BiDi 프로토콜을
			//   제대로 지원 안 해, 응답이 깨진 JSON 으로 와 `Could not parse response body`(JSON.parse 실패)로
			//   모든 execute/세션이 깨진다 → classic WebDriver 만 쓰도록 강제(BiDi 비활성). e2e-tauri 핵심 fix.
			"wdio:enforceWebDriverClassic": true,
			// 헤드리스(cage/WebKitWebDriver)에서 browser.refresh()/url() 의 page-load 대기가
			// 완료 응답을 못 받아 "aborted due to timeout" 으로 세션이 끊기는 문제 → 'eager' 로
			// DOMContentLoaded 까지만 대기(전체 load 이벤트 대기 안 함). 준비 판정은 명시적 waitUntil 이 담당.
			pageLoadStrategy: "eager",
			// #539: Windows 는 인앱 WebDriver(tauri_plugin_wdio_webdriver)에 붙는다 —
			// msedgedriver 는 WebView2 의 DevToolsActivePort 를 찾지 못해 세션을 못 연다.
			// Linux 는 WebKitWebDriver 가 정상이라 tauri-driver 경유를 유지한다.
			...(IS_WINDOWS
				? { browserName: "tauri" }
				: { "tauri:options": { application: TAURI_BINARY } }),
		},
	],

	logLevel: "warn",
	bail: 0,
	waitforTimeout: 30_000,
	connectionRetryTimeout: 120_000,
	connectionRetryCount: 3,
	// Node 26 exposes its global fetch dispatcher through an undici compatibility
	// wrapper. webdriverio 9 precomputes Content-Length before that wrapper, which
	// rejects the otherwise valid session request as UND_ERR_INVALID_ARG. Let fetch
	// compute the byte length from the unchanged JSON body instead.
	transformRequest: (request) => {
		request.headers.delete("Content-Length");
		return request;
	},

	port: IN_APP_PORT,
	hostname: "127.0.0.1",

	framework: "mocha",
	mochaOpts: {
		ui: "bdd",
		timeout: 180_000,
	},

	reporters: ["spec"],

	async onPrepare() {
		// Never reclaim by image name or port: another worker may own either one.
		// A stale run is recoverable through its run-scoped lease; an unrelated
		// listener fails closed and leaves its owner untouched.
		// Reclaim this run's stale lease before checking its ports so a previous
		// interrupted invocation can release its own sidecar/agent safely.
		reclaimLeakedAgentChild();
		reclaimLeakedBgmSidecar();
		await requirePortFree(VITE_PORT, VITE_HOST);
		await requirePortFree(IN_APP_PORT);
		if (!IS_WINDOWS) await requirePortFree(NATIVE_DRIVER_PORT);
		await requirePortFree(E2E_BGM_PORT);
		await requirePortFree(E2E_OAUTH_CALLBACK_PORT);
		if (OWNS_RUNTIME_DIR) {
			const owned = assertOwnedRuntimeDir();
			rmSync(owned, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 200,
			});
			mkdirSync(owned, { recursive: true });
			console.log(`[e2e] isolated runtime dir: ${owned}`);
		}
		if (HARNESS_XDG) {
			// 실행 자리를 비운 **다음**에 만든다. 순서가 뒤집히면 방금 만든 자리를
			// 우리가 지운다. 앱이 기동하기 전에 있어야 WebKit 이 프로필을 거기 만든다.
			for (const dir of Object.values(HARNESS_XDG)) {
				mkdirSync(dir, { recursive: true });
			}
			console.log(`[e2e] isolated app profile: ${HARNESS_XDG.XDG_CONFIG_HOME}`);
		}
		mkdirSync(E2E_PROFILE_DIR, { recursive: true });
		mkdirSync(E2E_HOME, { recursive: true });
		if (!EXPLICIT_ADK_PATH) {
			mkdirSync(SEEDED_ADK_PATH, { recursive: true });
		}
		if (SEEDS_CREDENTIALED_ADK) {
			// 실행 자리를 비운 **다음**에 심는다. 순서가 뒤집히면 방금 심은 것을
			// 우리가 지운다.
			const seeded = seedCredentialedAdk(
				SEEDED_ADK_PATH,
				credentialedSeedOptionsFromEnv(),
			);
			console.log(
				`[e2e] credentialed live provider seeded: ${seeded.provider}/${seeded.model}` +
					` (key from $${seeded.credentialRefEnv}) → ${seeded.configPath}`,
			);
		}
		if (CREDENTIALED_SEED_ACTIVE) {
			// 받는 쪽이 있어야 `notify` 가 합성된다. 주소는 무작위 포트라 여기서
			// 정해 환경에 넣는다 — 워커와 앱은 이 환경을 물려받는다.
			notifyStub = await startNotifyWebhookStub(
				process.env.NAIA_E2E_NOTIFY_LOG as string,
			);
			process.env.NAIA_NOTIFY_SLACK_WEBHOOK = notifyStub.urlFor("slack");
			process.env.NAIA_NOTIFY_DISCORD_WEBHOOK = notifyStub.urlFor("discord");
			console.log(`[e2e] notify webhook stub on 127.0.0.1:${notifyStub.port}`);
		}
		// Start Vite at this run's loopback URL. The native binary receives the
		// same URL through its inherited NAIA_E2E_DEV_URL environment.
		viteServer = spawn(
			execPath,
			[VITE_ENTRY, "--host", VITE_HOST, "--port", String(VITE_PORT)],
			{
				cwd: SHELL_DIR,
				stdio: ["ignore", "pipe", "pipe"],
				detached: !IS_WINDOWS,
				env: {
					...process.env,
					NAIA_E2E_RUN_ID: E2E_RUN_ID,
					NAIA_E2E_VITE_PORT: String(VITE_PORT),
					BROWSER: "none",
					// The normal launch script defaults to new-core mode. Keep the direct
					// WebDriver runner on that same path so ChatArea does not take the
					// legacy API-key gate before the agent credential overlay arrives.
					VITE_NAIA_NEW_CORE: "1",
					PLAYWRIGHT_PORT: String(VITE_PORT),
				},
			},
		);
		viteServer.stdout?.on("data", (d: Buffer) => {
			const line = d.toString();
			if (line.includes("error") || line.includes("Error")) {
				process.stderr.write(`[vite] ${line}`);
			}
		});
		viteServer.stderr?.on("data", (d: Buffer) =>
			process.stderr.write(`[vite:err] ${d.toString()}`),
		);
		await waitForPort(VITE_PORT, 30_000);
		console.log(
			`[e2e] Vite dev server started on ${VITE_HOST}:${VITE_PORT} (devUrl=${E2E_DEV_URL.href})`,
		);
	},

	async beforeSession() {
		// The native drivers are an external boundary. Reclaim only this run's
		// lease, then fail closed if a different run owns either driver port.
		reclaimLeakedAgentChild();
		await requirePortFree(IN_APP_PORT);
		if (!IS_WINDOWS) await requirePortFree(NATIVE_DRIVER_PORT);

		if (IS_WINDOWS) {
			tauriDriver = spawn(TAURI_BINARY, [], {
				stdio: [null, process.stdout, process.stderr],
				detached: false,
				env: {
					...process.env,
					NAIA_E2E_RUN_ID: E2E_RUN_ID,
					NAIA_E2E_NATIVE_DRIVER_PORT: String(NATIVE_DRIVER_PORT),
					RUST_LOG: process.env.RUST_LOG ?? "tauri_plugin_wdio_webdriver=debug",
					TAURI_WEBDRIVER_PORT: String(IN_APP_PORT),
				},
			});
		} else {
			tauriDriver = spawn(
				TAURI_DRIVER,
				[
					"--port",
					String(IN_APP_PORT),
					"--native-port",
					String(NATIVE_DRIVER_PORT),
					"--native-driver",
					NATIVE_DRIVER,
				],
				{
					stdio: [null, process.stdout, process.stderr],
					detached: true,
					env: {
						...process.env,
						NAIA_E2E_RUN_ID: E2E_RUN_ID,
						NAIA_E2E_NATIVE_DRIVER_PORT: String(NATIVE_DRIVER_PORT),
						TAURI_WEBDRIVER_PORT: String(IN_APP_PORT),
						RUST_LOG: process.env.RUST_LOG ?? "tauri_driver=debug",
					},
				},
			);
		}
		try {
			await waitForPort(
				IN_APP_PORT,
				30_000,
				IS_WINDOWS
					? {
							child: tauriDriver as ChildProcess,
							label: `native WebDriver/app (${TAURI_BINARY})`,
						}
					: undefined,
			);
		} catch (error) {
			// Startup failures must clean only the child created by this hook. Keep
			// the original spawn/exit error visible instead of replacing it with a
			// cleanup timeout, and prevent onComplete from attempting a second kill.
			const failedChild = tauriDriver;
			tauriDriver = undefined;
			try {
				await stopOwnedProcess(failedChild, "native WebDriver/app");
			} catch (cleanupError) {
				process.stderr.write(
					`[e2e] native startup cleanup failed: ${String(cleanupError)}\n`,
				);
			}
			throw error;
		}
	},

	async before() {
		// Each spec runs in its own session (fresh app).
		// On Windows/WebView2 the session returns before the webview has
		// navigated from about:blank to devUrl — touching localStorage on an
		// opaque origin throws "Access is denied". Wait until the document is
		// on an http origin AND localStorage is actually writable before any
		// spec-level hook runs. Linux/WebKitGTK already blocks on navigation
		// so this wait is a no-op there.
		await browser.waitUntil(
			async () => {
				try {
					return await browser.execute(() => {
						if (!document.location.href.startsWith("http")) return false;
						try {
							const probe = "__naia_e2e_probe__";
							localStorage.setItem(probe, "1");
							localStorage.removeItem(probe);
							return true;
						} catch {
							return false;
						}
					});
				} catch {
					return false;
				}
			},
			{
				timeout: 30_000,
				timeoutMsg:
					"webview never reached an http origin with writable localStorage",
			},
		);

		// Ensure base config is set so the app bypasses onboarding.
		const { ensureAppReady } = await import("./helpers/settings.js");
		await ensureAppReady();

		await deliverCredentialedGatewayKey();

		// Auto-approve permission modals globally for all specs.
		// Prevents tool-call hangs when AI tries to use a tool not yet approved.
		const { autoApprovePermissions } = await import("./helpers/permissions.js");
		permissionPoller = autoApprovePermissions();
	},

	after() {
		permissionPoller?.dispose();
		permissionPoller = undefined;
	},

	async afterSession() {
		try {
			await stopOwnedProcess(tauriDriver, "native WebDriver/app");
		} finally {
			tauriDriver = undefined;
		}
		try {
			await waitForPortClosed(IN_APP_PORT);
		} catch (error) {
			process.stderr.write(
				`[e2e] owned driver port did not close: ${String(error)}\n`,
			);
		}
		reclaimLeakedAgentChild();
	},

	/**
	 * 클릭이 "가려짐" 으로 죽으면 무엇이 덮었는지 그 자리에서 남긴다 (#569).
	 *
	 * `element not interactable` · `element click intercepted` 는 요소가 없다는 뜻이
	 * 아니라 다른 것이 위에 있다는 뜻인데, 로그에는 그 "다른 것" 이 남지 않아 회차마다
	 * 화면을 다시 띄워 눈으로 확인해야 했다. 실패한 그 실행이 스스로 말하게 한다.
	 */
	async afterTest(
		_test: unknown,
		_context: unknown,
		result: { passed?: boolean; error?: { message?: string } },
	) {
		if (result?.passed) return;
		if (!isCoverFailure(result?.error?.message)) return;
		await reportCover(
			(script: unknown, ...args: unknown[]) =>
				(browser.execute as (s: unknown, ...a: unknown[]) => Promise<unknown>)(
					script,
					...args,
				),
			(line: string) => {
				process.stderr.write(`${line}\n`);
			},
		);
	},

	async onComplete() {
		try {
			await stopOwnedProcess(tauriDriver, "native WebDriver/app");
		} catch (error) {
			process.stderr.write(`[e2e] native cleanup failed: ${String(error)}\n`);
		}
		tauriDriver = undefined;
		try {
			await stopOwnedProcess(viteServer, "Vite");
		} catch (error) {
			process.stderr.write(`[e2e] Vite cleanup failed: ${String(error)}\n`);
		}
		viteServer = undefined;
		try {
			await notifyStub?.close();
		} finally {
			notifyStub = undefined;
		}
		if (OWNS_RUNTIME_DIR) {
			stopHarnessHerdrSession(process.env.NAIA_E2E_RUNTIME_DIR, spawnSync);
		}
		// 붉은 실행의 로그·리스를 볼 수 있어야 원인을 가린다. codex 전용 설정과
		// 같은 손잡이를 쓴다.
		if (!OWNS_RUNTIME_DIR) return;
		if (process.env.NAIA_E2E_KEEP_ARTIFACTS === "1") {
			process.stderr.write(
				`[e2e] preserving isolated runtime dir ${E2E_RUNTIME_DIR}\n`,
			);
			return;
		}
		try {
			rmSync(assertOwnedRuntimeDir(), {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 200,
			});
		} catch (error) {
			process.stderr.write(
				`[e2e] deferred cleanup for ${E2E_RUNTIME_DIR}: ${String(error)}\n`,
			);
		}
	},
};
