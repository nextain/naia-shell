import { expect, test, type Page } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

const TAURI_MOCK = `
(function() {
	window.__OLLAMA_SETTINGS_E2E__ = { agentKeys: {} };
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
		if (cmd === "read_naia_config") return localStorage.getItem("naia-config") || null;
		if (cmd === "read_naia_ui_config") return "{}";
		if (cmd === "device_list" || cmd === "device_list_requests") return [];
		if (cmd === "write_naia_config" || cmd === "detect_gpu_vram") return null;
		if (cmd === "write_agent_key") {
			window.__OLLAMA_SETTINGS_E2E__.agentKeys[args.envKey] = args.value;
			return null;
		}
		return undefined;
	};
})();
`;

async function installOllamaRuntimeMock(page: Page, initialSnapshot: unknown) {
	await page.addInitScript((snapshot) => {
		const globals = window as any;
		const fixture = globals.__OLLAMA_SETTINGS_E2E__;
		fixture.runtimeCalls = [];
		fixture.runtimeSnapshot = snapshot;
		const internals = globals.__TAURI_INTERNALS__;
		const originalInvoke = internals.invoke.bind(internals);
		internals.invoke = async (command: string, args: unknown) => {
			if (command === "ollama_runtime_status") {
				fixture.runtimeCalls.push({ command, args });
				return JSON.parse(JSON.stringify(fixture.runtimeSnapshot));
			}
			if (command === "ollama_runtime_start") {
				fixture.runtimeCalls.push({ command, args });
				fixture.runtimeSnapshot = {
					...fixture.runtimeSnapshot,
					serverState: "ready_managed",
					ownership: "managed_child",
					modelCount: 1,
					reservation: {
						kind: "local_llm",
						status: "running",
						bytes: null,
						reasonCode: null,
					},
					error: null,
				};
				return "op-ollama-start";
			}
			if (command === "ollama_runtime_stop") {
				fixture.runtimeCalls.push({ command, args });
				return "op-ollama-stop";
			}
			return originalInvoke(command, args);
		};
	}, initialSnapshot);
}

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
	await expect(page.locator(".chat-app")).toBeVisible({ timeout: 15_000 });
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
	expect(saved.apiKey).toBeUndefined();
	expect(saved.ollamaHost).toBe("https://gpu.example.test/v1");
	const agentKeys = await page.evaluate(
		() => (window as any).__OLLAMA_SETTINGS_E2E__.agentKeys,
	);
	expect(agentKeys.OPENAI_API_KEY).toBe("e2e-remote-ollama-key");
});

test("local Ollama shows reservation denial and recovers through the accessible start action", async ({
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
				model: "qwen3:8b",
				ollamaHost: "http://localhost:11434",
				locale: "en",
				onboardingComplete: true,
			}),
		);
	});
	await installOllamaRuntimeMock(page, {
		state: "installed_stopped",
		serverState: "connected_unreserved",
		ownership: "external_local",
		installedVersion: "0.40.3",
		installedVersions: ["0.40.3"],
		modelCount: 1,
		reservation: {
			kind: "local_llm",
			status: "denied",
			bytes: null,
			reasonCode: "same_device_conflict",
		},
		operationId: null,
		phase: null,
		error: {
			code: "reservation_denied",
			stage: "reservation",
			retryable: true,
			reasonCode: "same_device_conflict",
		},
	});
	await page.route("**/api/tags", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ models: [{ name: "fixture-model" }] }),
		}),
	);

	await page.goto("/");
	await expect(page.locator(".chat-app")).toBeVisible({ timeout: 15_000 });
	await page.getByRole("button", { name: /^(Settings|설정)$/ }).click();
	await page.locator('[data-settings-tab="brain"]').click();
	const status = page.getByTestId("ollama-runtime-status");
	await expect(status).toBeVisible();
	await expect(status).toHaveAttribute("role", "status");
	await expect(status).toHaveAttribute("aria-live", "polite");
	await expect(status).toContainText("Connected without a local reservation");
	await expect(status).toContainText(
		"Voice is using this accelerator; local Ollama cannot use it at the same time.",
	);
	await expect(status).toContainText("Connected — 1 models");
	await expect(status).not.toContainText("localhost");

	await page.setViewportSize({ width: 640, height: 900 });
	const statusBox = await status.boundingBox();
	expect(statusBox).not.toBeNull();
	expect(statusBox!.x + statusBox!.width).toBeLessThanOrEqual(641);

	const start = page.getByTestId("ollama-runtime-start");
	await start.focus();
	await expect(start).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(status).toContainText("Ready (managed)");
	await expect(page.getByTestId("ollama-runtime-stop")).toBeVisible();
	const runtimeCalls = await page.evaluate(
		() => (window as any).__OLLAMA_SETTINGS_E2E__.runtimeCalls,
	);
	expect(
		runtimeCalls.filter(
			(call: { command: string }) => call.command === "ollama_runtime_start",
		),
	).toHaveLength(1);
});

test("connected external loopback keeps its models visible without managed start or stop controls", async ({
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
				model: "qwen3:8b",
				ollamaHost: "http://127.0.0.1:11435",
				locale: "en",
				onboardingComplete: true,
			}),
		);
	});
	await installOllamaRuntimeMock(page, {
		state: "installed_stopped",
		serverState: "ready_external_local",
		ownership: "external_local",
		installedVersion: null,
		installedVersions: [],
		modelCount: 2,
		reservation: {
			kind: "local_llm",
			status: "running",
			bytes: null,
			reasonCode: null,
		},
		operationId: null,
		phase: null,
		error: null,
	});
	await page.route("**/api/tags", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				models: [{ name: "fixture-one" }, { name: "fixture-two" }],
			}),
		}),
	);

	await page.goto("/");
	await expect(page.locator(".chat-app")).toBeVisible({ timeout: 15_000 });
	await page.getByRole("button", { name: /^(Settings|설정)$/ }).click();
	await page.locator('[data-settings-tab="brain"]').click();

	const status = page.getByTestId("ollama-runtime-status");
	await expect(status).toContainText("Ready (connected local)");
	await expect(status).toContainText("Connected — 2 models");
	await expect(page.getByTestId("ollama-runtime-start")).toHaveCount(0);
	await expect(page.getByTestId("ollama-runtime-stop")).toHaveCount(0);
	const runtimeCalls = await page.evaluate(
		() => (window as any).__OLLAMA_SETTINGS_E2E__.runtimeCalls,
	);
	expect(
		runtimeCalls.some(
			(call: { command: string }) => call.command === "ollama_runtime_start",
		),
	).toBe(false);
	expect(
		runtimeCalls.some(
			(call: { command: string }) => call.command === "ollama_runtime_stop",
		),
	).toBe(false);
});
