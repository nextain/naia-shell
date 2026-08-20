import { expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

const TAURI_MOCK = `
(function() {
	window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
	window.__TAURI_INTERNALS__.metadata = { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } };
	var callbacks = new Map(); var nextCbId = 1;
	window.__TAURI_INTERNALS__.transformCallback = function(fn, once) { var id = nextCbId++; callbacks.set(id, function(d){ if(once) callbacks.delete(id); return fn && fn(d); }); return id; };
	window.__TAURI_INTERNALS__.unregisterCallback = function(id){ callbacks.delete(id); };
	window.__TAURI_INTERNALS__.runCallback = function(id, d){ var cb = callbacks.get(id); if (cb) cb(d); };
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};
	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		if (cmd === "plugin:event|listen") return args.handler;
		if (cmd === "plugin:event|emit" || cmd === "plugin:event|unlisten") return null;
		if (cmd === "write_naia_config" || cmd === "detect_gpu_vram") return null;
		return undefined;
	};
})();
`;

test("remote Ollama exposes API key and preserves a custom model", async ({
	page,
}) => {
	await page.addInitScript(TAURI_MOCK);
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_ADK_PATH });
	await page.addInitScript(() => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "ollama",
				model: "qwen3.8",
				ollamaHost: "https://gpu.example.test/v1",
				locale: "ko",
				onboardingComplete: true,
			}),
		);
	});
	await page.route("**/api/tags", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ models: [{ name: "llama3.2:latest" }] }),
		}),
	);

	await page.goto("/");
	await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 15_000 });
	await page.getByRole("button", { name: /^(Settings|설정)$/ }).click();
	await page.locator('[data-settings-tab="brain"]').click();

	await expect(page.locator("#apikey-input")).toBeVisible();
	await expect(page.locator("#model-select")).toHaveAttribute("list");
	await expect(page.locator("#model-select")).toHaveValue("qwen3.8");

	await page.locator("#apikey-input").fill("e2e-remote-ollama-key");
	await page.locator("#model-select").fill("qwen3.8:14b");
	await page.locator(".settings-save-btn").first().click();

	const saved = await page.evaluate(() =>
		JSON.parse(localStorage.getItem("naia-config") ?? "{}"),
	);
	expect(saved.provider).toBe("ollama");
	expect(saved.model).toBe("qwen3.8:14b");
	expect(saved.apiKey).toBe("e2e-remote-ollama-key");
	expect(saved.ollamaHost).toBe("https://gpu.example.test/v1");
});
