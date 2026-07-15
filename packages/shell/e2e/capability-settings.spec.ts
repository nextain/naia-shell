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
	/** FR-3: when false, seed a logged-out (no naiaKey / BYO) config. */
	loggedIn?: boolean;
	/** Override ttsEnabled (FR-6 lip-sync note). Defaults to true. */
	ttsEnabled?: boolean;
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
			model: opts.model ?? "gemini-3.5-flash",
			...(loggedIn ? { naiaKey: API_KEY } : {}),
			enableTools: false,
			ttsEnabled: opts.ttsEnabled ?? true,
			ttsProvider: loggedIn ? "nextain" : "edge",
			locale: "ko",
			onboardingComplete: true,
		}),
	);

	// Pricing fetch → empty (independent of capability catalog); models → catalog.
	await page.route("**/v1/pricing", (route) =>
		route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
	);
	await page.route("**/v1/models", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(opts.catalog ?? []),
		}),
	);

	await page.goto("/");
	await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });
	await page.getByRole("button", { name: /^(설정|Settings)$/ }).click();
	// model-select lives in the brain tab; use stable tab ids instead of copy.
	await page.locator('[data-settings-tab="brain"]').click();
	await expect(page.locator("#model-select")).toBeVisible({ timeout: 10_000 });
}

test.describe("Capability-driven settings (#365)", () => {
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
		await gotoModelSettings(page, { model: "gemini-3.5-flash" });

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

		// omni model → STT section STILL shown (option) + "optional" hint appears.
		await page.locator('[data-settings-tab="brain"]').click();
		await page.locator("#model-select").selectOption("gemini-2.5-flash-live");
		await page.locator('[data-settings-tab="voice"]').click();
		await expect(
			page.locator('[data-testid="stt-provider-section"]'),
		).toBeVisible({ timeout: 5_000 });
		await expect(
			page.locator('[data-testid="stt-omni-optional-hint"]'),
		).toBeVisible();
		// H1 regression guard: omni + no STT picked → the "STT setup required" status
		// ladder must NOT show (it would contradict the "optional" hint above).
		await expect(
			page.locator('[data-testid="voice-status-summary"]'),
		).toHaveCount(0);

		// Back to a text model → hint disappears again (driven by capabilities).
		await page.locator('[data-settings-tab="brain"]').click();
		await page.locator("#model-select").selectOption("gemini-3.5-flash");
		await page.locator('[data-settings-tab="voice"]').click();
		await expect(
			page.locator('[data-testid="stt-omni-optional-hint"]'),
		).toHaveCount(0);
	});

	test("gateway /v1/models capability overrides static (gateway = SoT)", async ({
		page,
	}) => {
		// Statically gemini-3.5-flash is ["llm"] (no hint). The gateway declares it
		// omni → the UI must follow: STT stays available but shows the 'optional' hint.
		await gotoModelSettings(page, {
			model: "gemini-3.5-flash",
			catalog: [
				{ model_key: "gemini-3.5-flash", capabilities: ["llm", "omni"] },
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

test.describe("VRAM tier local profile (#2, FR-1/FR-3)", () => {
	test("detected VRAM surfaces the local GPU tier selector on the Profile tab", async ({
		page,
	}) => {
		await gotoModelSettings(page, { vramGb: 24, model: "gemini-3.5-flash" });

		// FR-1: the local GPU profile editor lives on the Profile tab, not Brain.
		await page.locator('[data-settings-tab="profile"]').click();
		const tierSelect = page.locator("#local-gpu-tier");
		await expect(tierSelect).toBeVisible({ timeout: 5_000 });
		// The "auto" option reflects the detected capacity.
		await expect(tierSelect.locator('option[value="auto"]')).toContainText(
			"24",
			{ timeout: 5_000 },
		);
		// off + auto + 4 tiers (6/8/12/24G).
		await expect(tierSelect.locator("option")).toHaveCount(6);
	});

	test("no GPU detected → manual-selection hint, default off", async ({
		page,
	}) => {
		await gotoModelSettings(page, { vramGb: null, model: "gemini-3.5-flash" });

		await page.locator('[data-settings-tab="profile"]').click();
		const tierSelect = page.locator("#local-gpu-tier");
		await expect(tierSelect).toBeVisible({ timeout: 5_000 });
		await expect(tierSelect.locator('option[value="auto"]')).toContainText(
			/VRAM not detected|manual|미감지|수동/,
			{ timeout: 5_000 },
		);
		// Default = off (no behaviour change).
		await expect(tierSelect).toHaveValue("off");
	});

	test("FR-1: Profile tab hosts the local GPU profile; canonical model controls stay on Brain", async ({
		page,
	}) => {
		await gotoModelSettings(page, { vramGb: 6, model: "gemini-3.5-flash" });

		await page.locator('[data-settings-tab="profile"]').click();
		// engine-core-summary 제거(2026-06-30, slot-groups 중복) + engine-gpu-summary
		// 제거(a8fe9517, 8G 재티어링: GPU 정보를 tier 셀렉터+local-profile-hint 로 통합) → 부재 확인.
		await expect(
			page.locator('[data-testid="engine-core-summary"]'),
		).toHaveCount(0);
		await expect(
			page.locator('[data-testid="engine-gpu-summary"]'),
		).toHaveCount(0);
		await expect(
			page.locator('[data-testid="engine-capability-summary"]'),
		).toBeVisible();
		// FR-1: local GPU tier editor is on the Profile tab.
		await expect(page.locator("#local-gpu-tier")).toBeVisible();
		// Canonical model pickers stay on the Brain tab.
		await expect(page.locator("#provider-select")).toHaveCount(0);
		await expect(page.locator("#model-select")).toHaveCount(0);

		await page.locator('[data-settings-tab="brain"]').click();
		await expect(page.locator("#provider-select")).toBeVisible({
			timeout: 5_000,
		});
		await expect(page.locator("#model-select")).toBeVisible();
		// FR-1: the GPU tier editor moved away from Brain.
		await expect(page.locator("#local-gpu-tier")).toHaveCount(0);
	});

	test("FR-3: local GPU profile is gated behind Naia login", async ({
		page,
	}) => {
		// Logged out → the tier selector is disabled and a login hint shows.
		await gotoModelSettings(page, {
			vramGb: 24,
			model: "gemini-3.5-flash",
			loggedIn: false,
		});
		await page.locator('[data-settings-tab="profile"]').click();
		const tierSelect = page.locator("#local-gpu-tier");
		await expect(tierSelect).toBeVisible({ timeout: 5_000 });
		await expect(tierSelect).toBeDisabled();
		await expect(
			page.locator('[data-testid="local-profile-hint"]'),
		).toContainText(/Naia/i);
	});

	test("FR-3: logged in → local GPU profile is enabled", async ({ page }) => {
		await gotoModelSettings(page, { vramGb: 24, model: "gemini-3.5-flash" });
		await page.locator('[data-settings-tab="profile"]').click();
		const tierSelect = page.locator("#local-gpu-tier");
		await expect(tierSelect).toBeVisible({ timeout: 5_000 });
		await expect(tierSelect).toBeEnabled();
	});

	test("FR-5: 8G exclusive tier exposes the llm/avatar/both focus selector", async ({
		page,
	}) => {
		// 8G 배타 티어(2026-07-08 3모드) → focus 셀렉터 노출, 옵션 = llm | avatar | both.
		await gotoModelSettings(page, { vramGb: 8, model: "gemini-3.5-flash" });
		await page.locator('[data-settings-tab="profile"]').click();
		await page.locator("#local-gpu-tier").selectOption("local-llm-avatar-8g");
		await expect(
			page.locator('[data-testid="local-focus-select"]'),
		).toBeVisible({ timeout: 5_000 });
		const focus = page.locator("#local-av-focus");
		await expect(focus.locator("option")).toHaveCount(3);
	});
});

test.describe("FR-6: NVA lip-sync note (avatar tab)", () => {
	test("TTS off → warning note referencing TTS", async ({ page }) => {
		await gotoModelSettings(page, {
			vramGb: 24,
			model: "gemini-3.5-flash",
			ttsEnabled: false,
		});
		// 비디오 아바타(cascade)는 로컬 프로파일이 avatar 를 제공할 때만 선택 가능 →
		// 먼저 프로파일 탭에서 티어를 고른다(24G auto = avatar+voice 동시 가능).
		await page.locator('[data-settings-tab="profile"]').click();
		await page.locator("#local-gpu-tier").selectOption("auto");
		await page.locator('[data-settings-tab="avatar"]').click();
		// Select the video avatar so the .nva picker (and note) renders.
		await page
			.locator('select:has(option[value="naia-video-avatar"])')
			.selectOption("naia-video-avatar");
		const note = page.locator('[data-testid="nva-lipsync-note"]');
		await expect(note).toBeVisible({ timeout: 5_000 });
		await expect(note).toContainText(/TTS/);
	});
});

test.describe("FR-7: video avatar gated by cascade capability", () => {
	test("logged-in shell can stage video avatar without an avatar local profile", async ({
		page,
	}) => {
		// 2026-07-08 단조 티어에선 6G+ 모두 avatar 를 로컬 제공. avatar 미제공 케이스는
		// 최저 티어(6G) 미만 = 로컬 프로파일 null 뿐 → vramGb=4 로 cascade 불가를 만든다.
		await gotoModelSettings(page, { vramGb: 4, model: "gemini-3.5-flash" });
		await page.locator('[data-settings-tab="profile"]').click();
		await page.locator("#local-gpu-tier").selectOption("auto"); // 4G → null(로컬 off)
		await page.locator('[data-settings-tab="avatar"]').click();
		await expect(
			page.locator('option[value="naia-video-avatar"]'),
		).toBeEnabled();
	});

	test("logged out → video-avatar option disabled (FR-3 cross-check)", async ({
		page,
	}) => {
		// 로그아웃이면 로컬 프로파일 자체가 비활성(activeLocalTier=null) → 아바타 불가.
		await gotoModelSettings(page, {
			vramGb: 24,
			model: "gemini-3.5-flash",
			loggedIn: false,
		});
		await page.locator('[data-settings-tab="avatar"]').click();
		await expect(
			page.locator('option[value="naia-video-avatar"]'),
		).toBeDisabled();
	});
});

test.describe("FR-8: NVA Host URL", () => {
	test("NVA 선택 후 유효 Host URL 입력 → 저장(정규화)", async ({ page }) => {
		await gotoModelSettings(page, { vramGb: 8, model: "gemini-3.5-flash" });
		await page.locator('[data-settings-tab="avatar"]').click();
		await page.locator("#avatar-provider").selectOption("naia-video-avatar");
		const input = page.locator("#cascade-runtime-url");
		await input.fill("http://100.1.2.3:8910/");
		await input.blur();
		const config = await page.evaluate(() =>
			JSON.parse(localStorage.getItem("naia-config") || "{}"),
		);
		expect(config.cascadeRuntimeUrl).toBe("http://100.1.2.3:8910"); // trailing slash 정규화
	});

	test("잘못된 URL → 에러 표시 + 저장 안 됨", async ({ page }) => {
		await gotoModelSettings(page, { vramGb: 8, model: "gemini-3.5-flash" });
		await page.locator('[data-settings-tab="avatar"]').click();
		await page.locator("#avatar-provider").selectOption("naia-video-avatar");
		const input = page.locator("#cascade-runtime-url");
		await input.fill("ws://bad:8910");
		await input.blur();
		await expect(
			page.locator('[data-testid="cascade-url-error"]'),
		).toBeVisible({ timeout: 5_000 });
		const config = await page.evaluate(() =>
			JSON.parse(localStorage.getItem("naia-config") || "{}"),
		);
		expect(config.cascadeRuntimeUrl).toBeUndefined();
	});

	test("logged out → NVA Host 미노출 (naiaKey 게이트)", async ({
		page,
	}) => {
		await gotoModelSettings(page, {
			vramGb: 8,
			model: "gemini-3.5-flash",
			loggedIn: false,
		});
		await page.locator('[data-settings-tab="avatar"]').click();
		await expect(page.locator("#cascade-runtime-url")).toHaveCount(0);
	});
});
