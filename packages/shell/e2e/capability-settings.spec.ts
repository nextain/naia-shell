import { type Page, expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

/**
 * Capability-driven settings E2E (#365) + VRAM tier (#2) — headless UI.
 *
 * Verifies the settings UI wiring that unit tests can't:
 *  - P3: the voice (STT/TTS) section show/hide is driven by the selected
 *    model's capabilities (deriveSettingsSlots), and the gateway /v1/models
 *    catalog overrides those capabilities (gateway = SoT).
 *  - P4: GPU VRAM detection surfaces a local GPU profile tier selector.
 *
 * Tauri Rust IPC is mocked; `detect_gpu_vram` and the gateway fetches
 * (/v1/pricing, /v1/models) are stubbed per test.
 */

const API_KEY = "e2e-mock-key";

/** Minimal Tauri IPC mock with a configurable detect_gpu_vram result. */
function buildMock(vramGb: number | null): string {
	return `
(function() {
	window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
	window.__TAURI_INTERNALS__.metadata = { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } };
	var callbacks = new Map(); var nextCbId = 1;
	window.__TAURI_INTERNALS__.transformCallback = function(fn, once) { var id = nextCbId++; callbacks.set(id, function(d){ if(once) callbacks.delete(id); return fn && fn(d); }); return id; };
	window.__TAURI_INTERNALS__.unregisterCallback = function(id){ callbacks.delete(id); };
	window.__TAURI_INTERNALS__.runCallback = function(id, d){ var cb = callbacks.get(id); if (cb) cb(d); };
	window.__TAURI_INTERNALS__.callbacks = callbacks;
	var eventListeners = new Map();
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};
	window.__TAURI_INTERNALS__.convertFileSrc = function(p, proto){ return (proto||"asset") + "://localhost/" + encodeURIComponent(p); };
	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		if (cmd === "plugin:event|listen") { if(!eventListeners.has(args.event)) eventListeners.set(args.event, []); eventListeners.get(args.event).push(args.handler); return args.handler; }
		if (cmd === "plugin:event|emit" || cmd === "plugin:event|unlisten") return null;
		if (cmd === "detect_gpu_vram") return ${vramGb === null ? "null" : vramGb};
		return undefined; // TAURI_BASE_MOCK_FALLBACK handles the rest
	};
})();
`;
}

interface SetupOpts {
	vramGb?: number | null;
	model?: string;
	/** Gateway /v1/models override entries (capability SoT). */
	catalog?: Array<{ model_key: string; capabilities: string[] }>;
	pricing?: Array<{
		model_key: string;
		input_price_per_million: number;
		output_price_per_million: number;
		cached_price_per_million: number | null;
		cache_write_price_per_million?: number | null;
	}> /** FR-3: when false, seed a logged-out (no naiaKey / BYO) config. */;
	loggedIn?: boolean;
	/** Override ttsEnabled (FR-6 lip-sync note). Defaults to true. */
	ttsEnabled?: boolean;
	config?: Record<string, unknown>;
}

async function gotoModelSettings(
	page: Page,
	opts: SetupOpts = {},
): Promise<void> {
	const loggedIn = opts.loggedIn !== false;
	await page.addInitScript(buildMock(opts.vramGb ?? null));
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_ADK_PATH });
	await page.addInitScript(
		(configJson: string) => localStorage.setItem("naia-config", configJson),
		JSON.stringify({
			provider: loggedIn ? "nextain" : "gemini",
			model: opts.model ?? "deepseek-v4-flash",
			...(loggedIn ? { naiaKey: API_KEY } : {}),
			enableTools: false,
			ttsEnabled: opts.ttsEnabled ?? true,
			ttsProvider: loggedIn ? "nextain" : "edge",
			locale: "ko",
			onboardingComplete: true,
			...(opts.config ?? {}),
		}),
	);

	// Pricing fetch → empty (independent of capability catalog); models → catalog.
	await page.route("**/v1/pricing", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(opts.pricing ?? []),
		}),
	);
	await page.route("**/v1/models", (route) =>
		route.fulfill({
			status: opts.catalog ? 200 : 503,
			contentType: "application/json",
			body: JSON.stringify(opts.catalog ?? []),
		}),
	);

	await page.goto("/");
	await expect(page.locator(".chat-app")).toBeVisible({ timeout: 10_000 });
	await page.getByRole("button", { name: /^(설정|Settings)$/ }).click();
	await page.locator('[data-settings-tab="brain"]').click();
	if (loggedIn) {
		await expect(
			page.locator("select#model-select, [data-testid='model-single']").first(),
		).toBeVisible({ timeout: 10_000 });
	}
}

test.describe("Capability-driven settings (#365)", () => {
	test("Naia model names include pricing and pricing states its token basis", async ({
		page,
	}) => {
		await gotoModelSettings(page, {
			model: "solar-mini",
			pricing: [
				{
					model_key: "upstage:solar-mini",
					input_price_per_million: 0.165,
					output_price_per_million: 0.165,
					cached_price_per_million: null,
				},
			],
		});

		const modelSelect = page.locator("#model-select");
		const sortSelect = page.locator('[data-testid="model-sort-mode"]');
		await expect(sortSelect).toHaveValue("price");
		await expect(sortSelect.locator('option[value="default"]')).toHaveCount(0);
		await expect(
			page.locator('[data-testid="model-price-sort-basis"]'),
		).toContainText(/3\s*:\s*.*1/);
		await expect(modelSelect.locator('option[value="solar-mini"]')).toHaveText(
			/Solar Mini \((?:Pricing:|Price per 1M tokens: Input) \$0\.165 \/ (?:Output )?\$0\.165\)/,
		);
		await expect(modelSelect.locator("option")).toHaveCount(4);
		await expect(
			modelSelect.locator('option[value="deepseek-v4-flash"]'),
		).toHaveCount(1);
		await expect(
			modelSelect.locator('option[value="solar-pro4"]'),
		).toHaveCount(1);
		await expect(
			modelSelect.locator('option[value="gpt-5.6-luna"]'),
		).toHaveCount(1);
		await expect(
			modelSelect.locator('option[value="claude-opus-5"]'),
		).toHaveCount(0);
		await expect(
			modelSelect.locator('option[value="naia-0.9-omni-24g"]'),
		).toHaveCount(0);
		await expect(
			modelSelect.locator('option[value="grok-4.3"]'),
		).toHaveCount(0);
		await expect(
			modelSelect.locator('option[value="gpt-5.6-sol"]'),
		).toHaveCount(0);
		const priceOrder = await modelSelect
			.locator("option")
			.evaluateAll((options) =>
				options.map((option) => (option as HTMLOptionElement).value),
			);
		expect(priceOrder[0]).toBe("solar-mini");
		await expect(modelSelect).toHaveValue("solar-mini");
		await sortSelect.selectOption("performance");
		await expect(modelSelect.locator("option").first()).toHaveAttribute(
			"value",
			"deepseek-v4-flash",
		);
		const performanceOrder = await modelSelect
			.locator("option")
			.evaluateAll((options) =>
				options.map((option) => (option as HTMLOptionElement).value),
			);
		expect(performanceOrder).not.toEqual(priceOrder);
		await expect(modelSelect).toHaveValue("solar-mini");
		await expect(modelSelect.locator('option[value="naia-local"]')).toHaveCount(
			0,
		);
		await expect(
			page.locator(".settings-hint").filter({ hasText: "100만 토큰당 가격" }),
		).toContainText("입력 $0.165 · 출력 $0.165");

		const proactiveButton = page.locator("button[data-proactive-state]");
		await expect(proactiveButton).toHaveAttribute(
			"data-proactive-state",
			"blocked",
		);
		await expect(proactiveButton).toHaveAttribute("aria-label", /능동 발화/);
	});
	test("STT section always available; omni model shows an 'optional' hint", async ({
		page,
	}) => {
		// 이 스펙에서 가장 무거운 케이스(탭 6전환 + 모델 3재선택). 적대리뷰 실측: 격리에서도
		// ~50-70s(부하 무관 본질적 느림) — SettingsTab(5000+줄)의 렌더 thrash(탭 클릭당 재렌더
		// 수초, 렌더 본문 loadConfig() 등)로 60s 기본 한도 초과. test.slow()(=180s)로 안정화.
		// ⚠️ 근본원인은 성능(별도 트래킹 대상) — 이 완충은 실행시간 문제이지 correctness 아님
		//    (caps 유도는 순수 함수 deriveSettingsSlots, race 없음 — 적대리뷰 확인됨).
		test.slow();
		// 사용자 결정 2026-07-02: omni 내장 모델이어도 외부/로컬 STT를 옵션으로 열어둔다
		// (로컬 Whisper 등이 무료 STT 대비 정확도·프라이버시 이점). capability는 이제
		// STT를 '숨김'이 아니라 omni일 때 '선택' 안내로만 반영.
		await gotoModelSettings(page, { model: "deepseek-v4-flash" });

		// text model → STT section shown, no "optional" hint (external STT needed).
		await page.locator('[data-settings-tab="voice"]').click();
		await expect(page.locator("#tts-toggle")).toBeVisible({ timeout: 5_000 });
		await expect(
			page.locator('[data-testid="stt-provider-section"]'),
		).toBeVisible({ timeout: 5_000 });
		await expect(
			page.locator('[data-testid="stt-omni-optional-hint"]'),
		).toHaveCount(0);
		// text model needs external STT → status ladder ("STT setup required") shows.
		await expect(
			page.locator('[data-testid="voice-status-summary"]'),
		).toBeVisible();
	});

	test("gateway /v1/models capability overrides static (gateway = SoT)", async ({
		page,
	}) => {
		// Statically deepseek-v4-flash is ["llm"] (no hint). The gateway declares it
		// omni → the UI must follow: STT stays available but shows the 'optional' hint.
		await gotoModelSettings(page, {
			model: "deepseek-v4-flash",
			catalog: [
				{ model_key: "deepseek-v4-flash", capabilities: ["llm", "omni"] },
				{ model_key: "solar-pro4", capabilities: ["llm"] },
				{ model_key: "solar-mini", capabilities: ["llm"] },
				{ model_key: "gpt-5.6-luna", capabilities: ["llm"] },
			],
		});

		await page.locator('[data-settings-tab="voice"]').click();
		await expect(
			page.locator('[data-testid="stt-provider-section"]'),
		).toBeVisible({ timeout: 5_000 });
		await expect(
			page.locator('[data-testid="stt-omni-optional-hint"]'),
		).toBeVisible();
	});
});

test.describe("Retired local GPU profile surface", () => {
	test("GPU detection does not expose the retired profile selector", async ({
		page,
	}) => {
		await gotoModelSettings(page, { vramGb: 24, model: "deepseek-v4-flash" });
		await page.locator('[data-settings-tab="profile"]').click();

		await expect(page.locator("#local-gpu-tier")).toHaveCount(0);
		await expect(
			page.locator('[data-testid="engine-capability-summary"]'),
		).toBeVisible();
	});
});

test.describe("Pre-baked NVA settings", () => {
	test("video avatar is enabled without login or GPU", async ({ page }) => {
		await gotoModelSettings(page, {
			vramGb: null,
			model: "deepseek-v4-flash",
			loggedIn: false,
		});
		await page.locator('[data-settings-tab="avatar"]').click();
		const option = page.locator('option[value="naia-video-avatar"]');
		await expect(option).toBeEnabled();
		await page.locator("#avatar-provider").selectOption("naia-video-avatar");
		await expect(page.locator("#avatar-provider")).toHaveValue(
			"naia-video-avatar",
		);
		await expect(
			page.locator('[data-testid="avatar-cascade-required"]'),
		).toHaveCount(0);
		await expect(page.locator("#cascade-runtime-url")).toHaveCount(0);
	});

	test("legacy remote Ditto host is removed from persisted settings", async ({
		page,
	}) => {
		await gotoModelSettings(page, {
			vramGb: null,
			model: "deepseek-v4-flash",
			loggedIn: false,
			config: {
				avatarProvider: "naia-video-avatar",
				nvaModel: "legacy.nva",
				cascadeRuntimeUrl: "http://stale.example:8910",
			},
		});
		await page.locator('[data-settings-tab="avatar"]').click();
		await expect(page.locator("#avatar-provider")).toHaveValue(
			"naia-video-avatar",
		);
		await expect(page.locator("#cascade-runtime-url")).toHaveCount(0);
		const config = await page.evaluate(() =>
			JSON.parse(localStorage.getItem("naia-config") || "{}"),
		);
		expect(config.cascadeRuntimeUrl).toBeUndefined();
	});
});
