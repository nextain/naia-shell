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
}

async function gotoModelSettings(page: Page, opts: SetupOpts = {}): Promise<void> {
	await page.addInitScript(buildMock(opts.vramGb ?? null));
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_ADK_PATH });
	await page.addInitScript(
		(configJson: string) => localStorage.setItem("naia-config", configJson),
		JSON.stringify({
			provider: "nextain",
			model: opts.model ?? "gemini-3.5-flash",
			naiaKey: API_KEY,
			enableTools: false,
			ttsEnabled: true,
			ttsProvider: "nextain",
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
	// model-select lives in the "AI 모델" (AI Model) sub-tab, not "모델" (Models).
	await page.getByRole("button", { name: /^(AI 모델|AI Model)$/ }).click();
	await expect(page.locator("#model-select")).toBeVisible({ timeout: 10_000 });
}

test.describe("Capability-driven settings (#365)", () => {
	test("text model → voice section shown; omni model → hidden", async ({
		page,
	}) => {
		await gotoModelSettings(page, { model: "gemini-3.5-flash" });

		// gemini-3.5-flash = ["llm"] → needs external STT/TTS → voice section shown.
		await expect(page.locator("#tts-toggle")).toBeVisible({ timeout: 5_000 });

		// Switch to an omni model (built-in voice I/O) → voice section hides.
		await page.locator("#model-select").selectOption("gemini-2.5-flash-live");
		await expect(page.locator("#tts-toggle")).toBeHidden({ timeout: 5_000 });

		// Back to a text model → shown again (driven purely by capabilities).
		await page.locator("#model-select").selectOption("gemini-3.5-flash");
		await expect(page.locator("#tts-toggle")).toBeVisible({ timeout: 5_000 });
	});

	test("gateway /v1/models capability overrides static (gateway = SoT)", async ({
		page,
	}) => {
		// Statically gemini-3.5-flash is ["llm"] (voice section shown). The gateway
		// declares it omni → the UI must follow and hide the voice section.
		await gotoModelSettings(page, {
			model: "gemini-3.5-flash",
			catalog: [{ model_key: "gemini-3.5-flash", capabilities: ["llm", "omni"] }],
		});

		await expect(page.locator("#tts-toggle")).toBeHidden({ timeout: 6_000 });
	});
});

test.describe("VRAM tier local profile (#2)", () => {
	test("detected VRAM surfaces the local GPU tier selector", async ({
		page,
	}) => {
		await gotoModelSettings(page, { vramGb: 24, model: "gemini-3.5-flash" });

		const tierSelect = page.locator("#local-gpu-tier");
		await expect(tierSelect).toBeVisible({ timeout: 5_000 });
		// The "auto" option reflects the detected capacity.
		await expect(tierSelect.locator('option[value="auto"]')).toContainText(
			"24",
			{ timeout: 5_000 },
		);
		// off + auto + 3 tiers (6/12/24G).
		await expect(tierSelect.locator("option")).toHaveCount(5);
	});

	test("no GPU detected → manual-selection hint, default off", async ({
		page,
	}) => {
		await gotoModelSettings(page, { vramGb: null, model: "gemini-3.5-flash" });

		const tierSelect = page.locator("#local-gpu-tier");
		await expect(tierSelect).toBeVisible({ timeout: 5_000 });
		await expect(tierSelect.locator('option[value="auto"]')).toContainText(
			/미감지|수동/,
			{ timeout: 5_000 },
		);
		// Default = off (no behaviour change).
		await expect(tierSelect).toHaveValue("off");
	});
});
