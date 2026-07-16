import { expect, test } from "@playwright/test";
import { TAURI_BASE_MOCK_FALLBACK } from "./helpers/tauri-base-mock";

/**
 * UC-CONFIG-SOT 부팅 e2e — 파일(naia-settings/config.json)이 SoT, localStorage 는 캐시.
 *
 * 배경(2026-07-16 시연장 실측): 지식 세션이 파일 persona 를 21,187자로 갱신했는데
 * 부팅/저장 경로가 스테일 localStorage persona(5,953자)를 파일에 되써 지식이 반복 유실됐다.
 * 이 스펙은 실 UI 부팅으로 세 계약을 고정한다:
 *   1. FR-CONFIG-SOT.1 — 부팅 하이드레이션: 파일 persona 가 스테일 캐시를 덮는다.
 *   2. FR-CONFIG-SOT.2 — 부팅 후 어떤 write_naia_config 도 스테일 persona 를 싣지 않는다.
 *   3. FR-CONFIG-SOT.2(경쟁) — 파일 읽기가 늦어도(300ms) 첫 되쓰기는 하이드레이션 후 값이다.
 *
 * Prerequisites: Vite dev server at localhost:1420 (playwright webServer 가 자동 기동).
 */

const STALE_PERSONA = "알파-스테일-페르소나";
const FILE_PERSONA = "나이아-정본-페르소나-21k";

/** Tauri IPC mock: read_naia_config → 파일 persona, write_naia_config → 캡처. */
function buildMockScript(opts: { readDelayMs?: number } = {}) {
	const delay = opts.readDelayMs ?? 0;
	return `
(function() {
	window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};

	window.__TAURI_INTERNALS__.metadata = {
		currentWindow: { label: "main" },
		currentWebview: { windowLabel: "main", label: "main" },
	};

	var callbacks = new Map();
	var nextCbId = 1;
	window.__TAURI_INTERNALS__.transformCallback = function(fn, once) {
		var id = nextCbId++;
		callbacks.set(id, function(data) { if (once) callbacks.delete(id); return fn && fn(data); });
		return id;
	};
	window.__TAURI_INTERNALS__.unregisterCallback = function(id) { callbacks.delete(id); };
	window.__TAURI_INTERNALS__.convertFileSrc = function(p, protocol) {
		return (protocol || "asset") + "://localhost/" + encodeURIComponent(p);
	};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};

	window.__SOT_E2E__ = { writes: [], reads: 0 };

	var FILE_CONFIG = JSON.stringify({
		persona: ${JSON.stringify(FILE_PERSONA)},
		agentName: "나이아",
		provider: "ollama",
		model: "test-model",
		onboardingComplete: true,
	});

	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		if (cmd === "plugin:event|listen") return args.handler;
		if (cmd === "plugin:event|emit" || cmd === "plugin:event|unlisten") return null;

		if (cmd === "read_naia_config") {
			window.__SOT_E2E__.reads++;
			${delay > 0 ? `await new Promise(function(r){ setTimeout(r, ${delay}); });` : ""}
			return FILE_CONFIG;
		}
		if (cmd === "read_naia_ui_config") return null;
		if (cmd === "write_naia_config") {
			try { window.__SOT_E2E__.writes.push(JSON.parse(args.json)); } catch (e) {}
			return;
		}
		if (cmd === "write_naia_ui_config" || cmd === "write_slots_manifest") return;
		if (cmd === "send_to_agent_command") return;
		return undefined;
	};
})();
`;
}

/** 스테일 캐시 seed — 실측 사고와 동형(파일보다 오래된 persona 가 캐시에 잔존). */
const SEED_STALE_CACHE = `
localStorage.setItem("naia-adk-path", "/tmp/mock-naia-adk-workspace");
localStorage.setItem("naia-config", JSON.stringify({
	persona: ${JSON.stringify(STALE_PERSONA)},
	agentName: "알파",
	provider: "ollama",
	model: "test-model",
	onboardingComplete: true,
}));
`;

async function bootApp(
	page: import("@playwright/test").Page,
	mockScript: string,
) {
	await page.addInitScript(mockScript);
	await page.addInitScript(TAURI_BASE_MOCK_FALLBACK);
	await page.addInitScript(SEED_STALE_CACHE);
	await page.goto("/");
	await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 15_000 });
}

test("FR-CONFIG-SOT.1 — 부팅 하이드레이션: 파일 persona 가 스테일 캐시를 덮는다", async ({
	page,
}) => {
	await bootApp(page, buildMockScript());
	// 하이드레이션은 비동기 — persona 가 파일 값으로 바뀔 때까지 폴링.
	await expect
		.poll(
			async () =>
				await page.evaluate(() => {
					const raw = localStorage.getItem("naia-config");
					return raw ? JSON.parse(raw).persona : null;
				}),
			{ timeout: 10_000 },
		)
		.toBe(FILE_PERSONA);
});

test("FR-CONFIG-SOT.2 — 부팅 후 어떤 write 도 스테일 persona 를 파일에 싣지 않는다", async ({
	page,
}) => {
	await bootApp(page, buildMockScript());
	// 부트-싱크 debounce(800ms) + 여유를 지나 모든 부팅 write 가 완료되게 한다.
	await page.waitForTimeout(2_500);
	const writes = await page.evaluate(
		() =>
			(
				window as unknown as {
					__SOT_E2E__: { writes: Array<{ persona?: string }> };
				}
			).__SOT_E2E__.writes,
	);
	for (const w of writes) {
		expect(w.persona, "스테일 캐시가 파일을 덮으면 안 된다(클로버)").not.toBe(
			STALE_PERSONA,
		);
	}
});

test("FR-CONFIG-SOT.2(경쟁) — 파일 읽기가 늦어도 첫 되쓰기는 하이드레이션 이후 값", async ({
	page,
}) => {
	// read_naia_config 300ms 지연 = 실측 사고의 경쟁 재현(되쓰기 debounce 800ms 와 겨룸).
	await bootApp(page, buildMockScript({ readDelayMs: 300 }));
	await page.waitForTimeout(2_500);
	const st = await page.evaluate(
		() =>
			(
				window as unknown as {
					__SOT_E2E__: {
						writes: Array<{ persona?: string }>;
						reads: number;
					};
				}
			).__SOT_E2E__,
	);
	expect(st.reads, "부팅이 파일을 읽어야 한다").toBeGreaterThan(0);
	for (const w of st.writes) {
		expect(w.persona).not.toBe(STALE_PERSONA);
	}
});
