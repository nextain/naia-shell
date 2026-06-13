#!/usr/bin/env node
/**
 * tauri-with-mode.mjs (new-naia) — `pnpm run tauri:dev | tauri:prod` 래퍼.
 *
 * 옛 old-naia-os/scripts/tauri-with-mode.mjs 의 새-구조 이식판.
 * 추가 책임(new-naia-os 는 항상 새 코어 + 분리 에이전트이므로):
 *   - VITE_NAIA_NEW_CORE=1        (셸 채팅을 이식 코어 경유)
 *   - NAIA_AGENT_STANDALONE=1     (Rust 가 임베디드 대신 외부 에이전트 스폰)
 *   - NAIA_AGENT_SCRIPT=../new-naia-agent/scripts/builds/agent-stdio-entry.mjs
 *   - GDK_BACKEND=x11 (Linux — WebKitGTK XReparentWindow embedding)
 * 그 위에 .env.{mode} 의 VITE_* 를 주입(URL 등은 .env 파일에만, 여기 하드코딩 없음).
 * 호출자(run-new-core-dev.sh 등)가 이미 설정한 값은 보존(?? 기본값).
 *
 * prod 모드는 dev-gateway 변수를 강제 제거 — stale 셸 env 가 prod 로그인 사용자를 dev 게이트웨이로
 * 라우팅(401)하지 못하게.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";

const mode = process.argv[2] === "prod" ? "prod" : "dev";

const HERE = import.meta.dirname; // packages/shell/scripts
const SHELL = resolve(HERE, ".."); // packages/shell
const OS_ROOT = resolve(SHELL, "..", ".."); // new-naia-os
const AGENT = resolve(OS_ROOT, "..", "new-naia-agent");

const env = { ...process.env };

// ── 새 코어 + 분리 에이전트 (new-naia-os 불변) ──
env.VITE_NAIA_NEW_CORE = env.VITE_NAIA_NEW_CORE ?? "1";
env.NAIA_AGENT_STANDALONE = env.NAIA_AGENT_STANDALONE ?? "1";
env.NAIA_AGENT_SCRIPT = env.NAIA_AGENT_SCRIPT ?? resolve(AGENT, "scripts/builds/agent-stdio-entry.mjs");
// Linux GTK 백엔드: 옛 naia-os 는 x11 무조건 강제(WebKitGTK XReparentWindow embedding).
// 그러나 XWayland 없는 순수 Wayland 세션(KDE Plasma 등, DISPLAY 비어있음)에선 x11 백엔드가
// 붙을 X 가 없어 GTK init 패닉(2026-06-13 실측: 루크 KDE Wayland tauri:dev 기동 불가).
// → X 가 실제로 있을 때만 x11, 아니면 wayland. 호출자 명시값(GDK_BACKEND)은 보존.
if (platform() === "linux") {
	const hasX = !!(env.DISPLAY && env.DISPLAY.trim());
	env.GDK_BACKEND = env.GDK_BACKEND ?? (hasX ? "x11" : "wayland");
	// Wayland 백엔드 = WebKitGTK DMABUF 렌더 버그(빈 화면) 회피.
	if (env.GDK_BACKEND === "wayland") {
		env.WEBKIT_DISABLE_DMABUF_RENDERER = env.WEBKIT_DISABLE_DMABUF_RENDERER ?? "1";
	}
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

process.stdout.write(`[tauri-with-mode] new core=${env.VITE_NAIA_NEW_CORE}, agent=${env.NAIA_AGENT_SCRIPT}\n`);

const r = spawnSync("pnpm", ["run", "tauri", "dev"], { env, stdio: "inherit", shell: true });
process.exit(r.status ?? 1);
