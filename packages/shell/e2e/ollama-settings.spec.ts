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
	var eventListeners = new Map();
	window.__TAURI_INTERNALS__.transformCallback = function(fn, once) { var id = nextCbId++; callbacks.set(id, function(d){ if(once) callbacks.delete(id); return fn && fn(d); }); return id; };
	window.__TAURI_INTERNALS__.unregisterCallback = function(id){ callbacks.delete(id); };
	window.__TAURI_INTERNALS__.runCallback = function(id, d){ var cb = callbacks.get(id); if (cb) cb(d); };
	function emitEvent(event, payload) { var hs = eventListeners.get(event) || []; hs.forEach(function(id) { window.__TAURI_INTERNALS__.runCallback(id, { event: event, payload: payload }); }); }
	window.__OLLAMA_SETTINGS_E2E__.emitEvent = emitEvent;
	window.__OLLAMA_SETTINGS_E2E__.hasListener = function(event) { return (eventListeners.get(event) || []).length > 0; };
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};
	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		if (cmd === "plugin:event|listen") { if (!eventListeners.has(args.event)) eventListeners.set(args.event, []); eventListeners.get(args.event).push(args.handler); return args.handler; }
		if (cmd === "plugin:event|emit") { emitEvent(args.event, args.payload); return null; }
		if (cmd === "plugin:event|unlisten") { var hs = eventListeners.get(args.event) || []; eventListeners.set(args.event, hs.filter(function(id) { return id !== args.eventId; })); return null; }
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

async function installOllamaRuntimeMock(
	page: Page,
	initialSnapshot: unknown,
	modelPolicy?: unknown,
) {
	await page.addInitScript(
		({ snapshot, policy }) => {
			const globals = window as any;
			const fixture = globals.__OLLAMA_SETTINGS_E2E__;
			fixture.runtimeCalls = [];
			fixture.runtimeSnapshot = snapshot;
			fixture.pullCalls = [];
			fixture.modelPolicy = policy;
			fixture.pullSnapshots = {};
			fixture.retryCount = 0;
			const internals = globals.__TAURI_INTERNALS__;
			const originalInvoke = internals.invoke.bind(internals);
			internals.invoke = async (command: string, args: unknown) => {
				const payload = (args || {}) as Record<string, string>;
				if (command === "ollama_model_catalog_list") {
					fixture.pullCalls.push({ command, args });
					return fixture.modelPolicy;
				}
				if (command === "ollama_model_pull_status") {
					fixture.pullCalls.push({ command, args });
					return (
						fixture.pullSnapshots[payload.tag] || {
							operationId: null,
							tag: payload.tag,
							state: "absent",
							stage: "status",
							digest: null,
							error: null,
						}
					);
				}
				if (command === "ollama_model_pull_start") {
					fixture.pullCalls.push({ command, args });
					const operationId = "pull-1";
					const snapshot = {
						operationId,
						tag: payload.tag,
						state: "preflight",
						stage: "preflight",
						digest: null,
						error: null,
					};
					fixture.pullSnapshots[payload.tag] = snapshot;
					return { operationId, snapshot };
				}
				if (command === "ollama_model_pull_cancel") {
					fixture.pullCalls.push({ command, args });
					const current = Object.values(fixture.pullSnapshots).find(
						(value: any) => value.operationId === payload.operationId,
					) as any;
					return {
						...(current || {}),
						operationId: payload.operationId,
						state: "paused",
						stage: "cancelled",
					};
				}
				if (command === "ollama_model_pull_retry") {
					fixture.pullCalls.push({ command, args });
					fixture.retryCount += 1;
					const operationId = `pull-${fixture.retryCount + 1}`;
					const snapshot = {
						operationId,
						tag: payload.tag,
						state: "preflight",
						stage: "preflight",
						digest: null,
						error: null,
					};
					fixture.pullSnapshots[payload.tag] = snapshot;
					return { operationId, snapshot };
				}
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
		},
		{ snapshot: initialSnapshot, policy: modelPolicy },
	);
}

const QWEN_TAG = "huihui_ai/qwen3.5-abliterated:2B";

function qwenModelPolicy(decided = false) {
	return {
		candidates: [
			{
				id: "qwen35-abliterated-2b",
				displayName: "Qwen 3.5 Abliterated 2B",
				tag: QWEN_TAG,
				publishedSize: "1.9 GB",
				publishedSizeBytes: null,
				quantization: "Q4_K_M",
				sourceUrl: `https://ollama.com/${QWEN_TAG}`,
				license: "Apache License 2.0",
				licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
				publishedContextTokens: 262144,
				parameterSize: "2B",
			},
		],
		defaultModelTag: null,
		contextDefaultTokens: null,
		pullStartPolicy: decided ? "user_confirmed" : null,
		modelStoreOverride: null,
		lowVramFallbackTag: null,
		diskMarginBytes: decided ? 1 : null,
		showLicense: decided ? true : null,
		measuredPeakVramBytes: decided ? 4_000_000_000 : null,
		selectionHeadroomBytes: decided ? 500_000_000 : null,
	};
}

function managedRuntimeSnapshot() {
	return {
		state: "ready",
		serverState: "ready_managed",
		ownership: "managed_child",
		installedVersion: "0.40.3",
		installedVersions: ["0.40.3"],
		modelCount: 1,
		reservation: {
			kind: "local_llm",
			status: "running",
			bytes: null,
			reasonCode: null,
		},
		operationId: null,
		phase: null,
		error: null,
	};
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
	await installOllamaRuntimeMock(
		page,
		{
			state: "connected",
			serverState: "ready_remote",
			ownership: "remote",
			installedVersion: null,
			installedVersions: [],
			modelCount: null,
			reservation: { kind: null, status: "not_requested", bytes: null },
			operationId: null,
			phase: null,
			error: null,
		},
		qwenModelPolicy(true),
	);
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
	const pullCalls = await page.evaluate(
		() => (window as any).__OLLAMA_SETTINGS_E2E__.pullCalls,
	);
	expect(
		pullCalls.filter((call: { command: string }) =>
			call.command.startsWith("ollama_model_pull_"),
		),
	).toHaveLength(0);
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
	await installOllamaRuntimeMock(
		page,
		{
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
		},
		qwenModelPolicy(true),
	);
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
	const pullCalls = await page.evaluate(
		() => (window as any).__OLLAMA_SETTINGS_E2E__.pullCalls,
	);
	expect(
		pullCalls.filter((call: { command: string }) =>
			call.command.startsWith("ollama_model_pull_"),
		),
	).toHaveLength(0);
});

test("explicit Ollama thinking unsupported status preserves the saved level and stays accessible at 360px", async ({
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
				thinkingLevel: "high",
				enableThinking: true,
				locale: "en",
				onboardingComplete: true,
			}),
		);
	});
	await installOllamaRuntimeMock(page, {
		state: "ready_external_local",
		serverState: "ready_external_local",
		ownership: "external_local",
		installedVersion: null,
		installedVersions: [],
		modelCount: 1,
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
			body: JSON.stringify({ models: [{ name: "qwen3:8b" }] }),
		}),
	);

	await page.goto("/");
	await expect(page.locator(".chat-app")).toBeVisible({ timeout: 15_000 });
	await expect
		.poll(() =>
			page.evaluate(() =>
				(window as any).__OLLAMA_SETTINGS_E2E__.hasListener("agent_response"),
			),
		)
		.toBe(true);
	await page.evaluate(() => {
		(window as any).__OLLAMA_SETTINGS_E2E__.emitEvent(
			"agent_response",
			JSON.stringify({
				type: "log_entry",
				requestId: "fixture-request",
				level: "ollama_thinking_unsupported",
				message: JSON.stringify({
					host: "http://localhost:11434",
					model: "qwen3:8b",
				}),
			}),
		);
	});
	await page.getByRole("button", { name: /^(Settings|설정)$/ }).click();
	await page.locator('[data-settings-tab="brain"]').click();
	const status = page.getByTestId("ollama-runtime-status");
	await expect(status).toBeVisible();
	await expect(page.getByTestId("ollama-thinking-unsupported")).toHaveCount(1);
	const radioGroup = page.getByRole("radiogroup", { name: /thinking level/i });
	await expect(radioGroup).toBeVisible();
	const high = page.getByTestId("thinking-level-high");
	await expect(high).toHaveAttribute("aria-checked", "true");
	await high.focus();
	await page.keyboard.press("ArrowLeft");
	await expect(page.getByTestId("thinking-level-low")).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await page.keyboard.press("ArrowRight");
	await expect(high).toHaveAttribute("aria-checked", "true");
	const warning = page.getByTestId("ollama-thinking-unsupported");
	await expect(warning).toHaveAttribute("role", "status");
	await expect(warning).toBeVisible();
	await expect(warning).toContainText(
		"This model does not support thinking. Thinking is disabled for this request; your saved setting is unchanged.",
	);
	await expect(high).toHaveAttribute("aria-checked", "true");
	const saved = await page.evaluate(() =>
		JSON.parse(localStorage.getItem("naia-config") ?? "{}"),
	);
	expect(saved.thinkingLevel).toBe("high");
	expect(saved.enableThinking).toBe(true);

	await page.setViewportSize({ width: 360, height: 800 });
	const statusBox = await status.boundingBox();
	expect(statusBox).not.toBeNull();
	expect(statusBox!.x + statusBox!.width).toBeLessThanOrEqual(361);
	await expect(warning).toBeVisible();
});

test("undecided pull policy is visible and blocks automatic start and retry", async ({
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
				model: "llama3.2:8b",
				ollamaHost: "http://localhost:11434",
				locale: "en",
				onboardingComplete: true,
			}),
		);
	});
	await installOllamaRuntimeMock(
		page,
		managedRuntimeSnapshot(),
		qwenModelPolicy(),
	);
	await page.route("**/api/tags", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ models: [{ name: "llama3.2:8b" }] }),
		}),
	);

	await page.goto("/");
	await expect(page.locator(".chat-app")).toBeVisible({ timeout: 15_000 });
	await page.getByRole("button", { name: /^(Settings|설정)$/ }).click();
	await page.locator('[data-settings-tab="brain"]').click();

	const pullPanel = page.getByTestId("ollama-model-pull");
	await expect(pullPanel).toBeVisible();
	await expect(page.getByTestId("ollama-pull-vram-pending")).toBeVisible();
	await expect(page.getByTestId("ollama-pull-default-pending")).toBeVisible();
	await expect(page.getByTestId("ollama-pull-license-pending")).toBeVisible();
	await expect(page.getByTestId("ollama-pull-policy-pending")).toHaveAttribute(
		"role",
		"status",
	);
	await expect(pullPanel).toContainText(
		"The download start policy or required disk margin is unset.",
	);

	const candidateSelect = page.getByLabel("Model candidate");
	await candidateSelect.selectOption(QWEN_TAG);
	await expect(page.getByTestId("ollama-pull-exact-tag")).toHaveText(QWEN_TAG);
	await expect(
		page.getByTestId("ollama-pull-request-confirmation"),
	).toBeDisabled();
	await expect(page.locator("#model-select")).toHaveValue("llama3.2:8b");
	const pullCalls = await page.evaluate(
		() => (window as any).__OLLAMA_SETTINGS_E2E__.pullCalls,
	);
	expect(
		pullCalls.filter((call: { command: string }) =>
			["ollama_model_pull_start", "ollama_model_pull_retry"].includes(
				call.command,
			),
		),
	).toHaveLength(0);
});

test("managed model pull confirms an exact tag, recovers, filters stale events and connects ready model", async ({
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
				model: "llama3.2:8b",
				ollamaHost: "http://localhost:11434",
				thinkingLevel: "high",
				enableThinking: true,
				locale: "en",
				onboardingComplete: true,
			}),
		);
	});
	await installOllamaRuntimeMock(
		page,
		managedRuntimeSnapshot(),
		qwenModelPolicy(true),
	);
	let modelNames = ["llama3.2:8b"];
	await page.route("**/api/tags", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				models: modelNames.map((name) => ({ name })),
			}),
		}),
	);

	await page.goto("/");
	await expect(page.locator(".chat-app")).toBeVisible({ timeout: 15_000 });
	await page.getByRole("button", { name: /^(Settings|설정)$/ }).click();
	await page.locator('[data-settings-tab="brain"]').click();

	const candidateSelect = page.getByLabel("Model candidate");
	await expect(candidateSelect).toBeVisible();
	await candidateSelect.focus();
	await candidateSelect.selectOption(QWEN_TAG);
	await expect(page.getByTestId("ollama-pull-exact-tag")).toHaveText(QWEN_TAG);
	await expect(
		page.getByRole("link", { name: "Open model page" }),
	).toHaveAttribute("href", `https://ollama.com/${QWEN_TAG}`);
	await expect(
		page.getByRole("link", { name: "Apache License 2.0" }),
	).toHaveAttribute("href", "https://www.apache.org/licenses/LICENSE-2.0");
	await page.getByTitle("채팅 숨기기 (Ctrl+B)").click();
	await page.setViewportSize({ width: 360, height: 800 });
	const selectBox = await candidateSelect.boundingBox();
	expect(selectBox).not.toBeNull();
	expect(selectBox!.x + selectBox!.width).toBeLessThanOrEqual(361);
	await expect(page.getByTestId("thinking-level-section")).toBeVisible();

	const review = page.getByTestId("ollama-pull-request-confirmation");
	await expect(review).toBeEnabled();
	await review.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByText(`Download exactly ${QWEN_TAG}?`)).toBeVisible();
	const confirm = page.getByTestId("ollama-pull-confirm");
	await confirm.focus();
	await page.keyboard.press("Enter");
	await expect
		.poll(() =>
			page.evaluate(() => (window as any).__OLLAMA_SETTINGS_E2E__.pullCalls),
		)
		.toContainEqual({
			command: "ollama_model_pull_start",
			args: { tag: QWEN_TAG, confirmedTag: QWEN_TAG },
		});
	await expect
		.poll(() =>
			page.evaluate(() =>
				(window as any).__OLLAMA_SETTINGS_E2E__.hasListener(
					"ollama_model_pull_progress",
				),
			),
		)
		.toBe(true);

	await page.evaluate((tag) => {
		const emit = (window as any).__OLLAMA_SETTINGS_E2E__.emitEvent;
		emit("ollama_model_pull_progress", {
			operationId: "pull-1",
			tag,
			phase: "downloading",
			digest: null,
			completed: null,
			total: null,
			layerPercent: 34,
		});
		emit("ollama_model_pull_progress", {
			operationId: "stale-operation",
			tag,
			phase: "downloading",
			digest: null,
			completed: null,
			total: null,
			layerPercent: 99,
		});
	}, QWEN_TAG);
	await expect(page.getByTestId("ollama-pull-progress")).toContainText(
		"Current layer: 34%",
	);
	await expect(page.getByTestId("ollama-pull-progress")).not.toContainText(
		"99%",
	);
	const cancel = page.getByTestId("ollama-pull-cancel");
	await cancel.focus();
	await page.keyboard.press("Enter");
	await expect
		.poll(() =>
			page.evaluate(() => (window as any).__OLLAMA_SETTINGS_E2E__.pullCalls),
		)
		.toContainEqual({
			command: "ollama_model_pull_cancel",
			args: { operationId: "pull-1" },
		});
	const retry = page.getByTestId("ollama-pull-retry");
	await expect(retry).toBeVisible();
	await retry.click();
	await expect
		.poll(() =>
			page.evaluate(() => (window as any).__OLLAMA_SETTINGS_E2E__.pullCalls),
		)
		.toContainEqual({
			command: "ollama_model_pull_retry",
			args: { tag: QWEN_TAG },
		});

	await page.evaluate((tag) => {
		(window as any).__OLLAMA_SETTINGS_E2E__.emitEvent(
			"ollama_model_pull_state_changed",
			{
				operationId: "pull-2",
				tag,
				state: "failed",
				stage: "pull",
				digest: null,
				error: {
					code: "pull_http_failed",
					stage: "pull",
					retryable: true,
					operationId: "pull-2",
				},
			},
		);
	}, QWEN_TAG);
	await expect(page.getByTestId("ollama-pull-error")).toContainText(
		"The download request or stream failed.",
	);
	await page.getByTestId("ollama-pull-retry").click();
	await expect
		.poll(() =>
			page.evaluate(() => (window as any).__OLLAMA_SETTINGS_E2E__.pullCalls),
		)
		.toContainEqual({
			command: "ollama_model_pull_retry",
			args: { tag: QWEN_TAG },
		});

	modelNames = ["llama3.2:8b", QWEN_TAG];
	await page.evaluate((tag) => {
		(window as any).__OLLAMA_SETTINGS_E2E__.emitEvent(
			"ollama_model_pull_state_changed",
			{
				operationId: "pull-3",
				tag,
				state: "ready",
				stage: "ready",
				digest: "sha256:fixture",
				error: null,
			},
		);
	}, QWEN_TAG);
	await expect(page.locator("#model-select")).toHaveValue(QWEN_TAG);
	await expect
		.poll(() =>
			page.evaluate(
				() => JSON.parse(localStorage.getItem("naia-config") ?? "{}").model,
			),
		)
		.toBe(QWEN_TAG);
	const finalPullCalls = await page.evaluate(
		() => (window as any).__OLLAMA_SETTINGS_E2E__.pullCalls,
	);
	expect(
		finalPullCalls.filter(
			(call: { command: string }) => call.command === "ollama_model_pull_start",
		),
	).toHaveLength(1);
});
