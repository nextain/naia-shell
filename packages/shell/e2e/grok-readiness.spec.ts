import { expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

/**
 * UC-GROK-SUBSCRIPTION — 실 셸 UI 통합.
 * 설정 두뇌에서 Grok 구독 CLI를 고르고, API 키 없이 준비 상태를 확인하며,
 * 채팅 wire가 xAI API-key 경로로 새지 않는지 검증한다.
 */
const GROK_TAURI_MOCK = `
(function() {
	window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
	window.__TAURI_INTERNALS__.metadata = {
		currentWindow: { label: "main" },
		currentWebview: { windowLabel: "main", label: "main" },
	};
	window.__GROK_INVOKES__ = [];
	window.__E2E_OUTBOUND__ = [];
	window.__NAIA_NEW_CORE__ = true;
	var callbacks = new Map();
	var nextCallbackId = 1;
	var eventListeners = new Map();
	window.__TAURI_INTERNALS__.transformCallback = function(fn, once) {
		var id = nextCallbackId++;
		callbacks.set(id, function(data) {
			if (once) callbacks.delete(id);
			return fn && fn(data);
		});
		return id;
	};
	window.__TAURI_INTERNALS__.unregisterCallback = function(id) {
		callbacks.delete(id);
	};
	window.__TAURI_INTERNALS__.runCallback = function(id, data) {
		var cb = callbacks.get(id);
		if (cb) cb(data);
	};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};
	function emitEvent(event, payload) {
		var hs = eventListeners.get(event) || [];
		for (var i = 0; i < hs.length; i++) window.__TAURI_INTERNALS__.runCallback(hs[i], { event: event, payload: payload });
	}
	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		window.__GROK_INVOKES__.push({ cmd: cmd, args: args || null });
		if (cmd === "plugin:event|listen") {
			if (!eventListeners.has(args.event)) eventListeners.set(args.event, []);
			eventListeners.get(args.event).push(args.handler);
			return args.handler;
		}
		if (cmd === "plugin:event|unlisten") return null;
		if (cmd === "read_naia_config") {
			return window.__E2E_CONFIG__ ? JSON.stringify(window.__E2E_CONFIG__) : "";
		}
		// Rust device_pairing.rs device_list/device_list_requests always resolve
		// to arrays. With tools enabled (the default) Settings mounts
		// DevicePairingSection, which crashes the Settings app on undefined.
		if (cmd === "device_list" || cmd === "device_list_requests") return [];
		if (cmd === "cli_detect_one") {
			return window.__GROK_PREFLIGHT__ || {
				status: "ready",
				output: "You are logged in as private@example.com",
			};
		}
		if (cmd === "send_to_agent_command") {
			var payload = JSON.parse(args.message);
			window.__E2E_OUTBOUND__.push(payload);
			if (payload && payload.type === "chat_request") {
				var rid = payload.requestId;
				setTimeout(function () {
					emitEvent("agent_response", JSON.stringify({ type: "text", requestId: rid, text: "pong" }));
				}, 80);
				setTimeout(function () {
					emitEvent("agent_response", JSON.stringify({ type: "finish", requestId: rid }));
				}, 160);
			}
			return null;
		}
		return undefined;
	};
})();
`;

function seedConfig(cfg: Record<string, unknown>, preflight?: { status: string; output?: string }): string {
	return `window.__E2E_CONFIG__ = ${JSON.stringify(cfg)};
		window.__GROK_PREFLIGHT__ = ${JSON.stringify(preflight ?? null)};
		localStorage.setItem("naia-chat-mode-v1", "app");
		localStorage.setItem("naia-config", ${JSON.stringify(JSON.stringify(cfg))});`;
}

async function boot(
	page: import("@playwright/test").Page,
	cfg: Record<string, unknown>,
	preflight?: { status: string; output?: string },
	catalog?: Array<Record<string, unknown>>,
) {
	const pricing = { requests: 0 };
	if (catalog) {
		await page.route("**/v1/pricing", (route) => {
			pricing.requests += 1;
			return route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(catalog),
			});
		});
	}
	await page.addInitScript({ content: GROK_TAURI_MOCK });
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_ADK_PATH });
	await page.addInitScript({ content: seedConfig(cfg, preflight) });
	await page.goto("/");
	await expect(page.locator(".chat-app")).toBeVisible({ timeout: 15_000 });
	return pricing;
}

async function openBrain(page: import("@playwright/test").Page) {
	await page.getByRole("button", { name: /^(Settings|설정)$/ }).click();
	await page.locator('[data-settings-tab="brain"]').click();
}

async function grokPreflightCount(page: import("@playwright/test").Page) {
	return page.evaluate(
		() =>
			(
				window as unknown as {
					__GROK_INVOKES__: Array<{ cmd: string; args?: unknown }>;
				}
			).__GROK_INVOKES__.filter(
				(call) =>
					call.cmd === "cli_detect_one" &&
					(call as { args?: { id?: string } | null }).args?.id === "grok",
			).length,
	);
}

// #602 (0221930f, 2026-09-16) removed the xAI API-key provider together with
// every other third-party cloud LLM API (third-party-providers-absent.test.ts).
// The only remaining provider with an API-key field is a remote Ollama
// (OpenAI-compatible key, adk-store.ts resolveAgentEnvKey), so it now stands in
// for "an API-key provider" next to the Grok subscription CLI.
const API_KEY_CFG = {
	onboardingComplete: true,
	provider: "ollama",
	model: "qwen3",
	apiKey: "remote-ollama-key",
	locale: "ko",
};

const GROK_CFG = {
	onboardingComplete: true,
	provider: "grok",
	model: "grok-4.6",
	apiKey: "",
	locale: "ko",
	enableTools: false,
};

test.describe("UC-GROK-SUBSCRIPTION", () => {
	test("설정에서 Grok를 고르면 API 키 없이 준비됨을 표시하고 계정/출력을 숨긴다", async ({ page }) => {
		await boot(page, GROK_CFG, {
			status: "ready",
			output: "You are logged in as private@example.com",
		});
		await openBrain(page);

		const provider = page.locator("#provider-select");
		await expect(provider).toHaveValue("grok");
		await expect(provider.locator('option[value="grok"]')).toHaveCount(1);
		// #602: the xAI API-key provider no longer exists next to Grok.
		await expect(provider.locator('option[value="xai"]')).toHaveCount(0);
		await expect(page.locator("#model-select")).toHaveValue("grok-4.6");
		await expect(page.locator("#apikey-input")).toHaveCount(0);

		const readiness = page.getByTestId("grok-readiness");
		await expect(readiness).toBeVisible();
		await expect(readiness).toContainText(/Not checked|확인 전/);
		await readiness.getByTestId("grok-readiness-check").click();
		await expect(readiness.getByTestId("grok-readiness-status")).toContainText(/Ready|준비됨/);

		await expect.poll(() => grokPreflightCount(page)).toBe(1);

		await expect(page.getByText("private@example.com")).toHaveCount(0);
		await expect(page.getByText("You are logged in as")).toHaveCount(0);
		const saved = await page.evaluate(() =>
			JSON.parse(localStorage.getItem("naia-config") || "{}"),
		);
		expect(saved).toMatchObject({
			provider: "grok",
			model: "grok-4.6",
			apiKey: "",
		});
		expect(JSON.stringify(saved)).not.toContain("private@example.com");
		expect(JSON.stringify(saved)).not.toContain("You are logged in as");
	});

	test("API 키 공급자에서 Grok로 바꾸면 API 키 칸이 사라지고 준비 확인이 나온다", async ({ page }) => {
		await boot(page, API_KEY_CFG);
		await openBrain(page);
		await expect(page.locator("#provider-select")).toHaveValue("ollama");
		await expect(page.locator("#apikey-input")).toHaveCount(1);
		await page.locator("#provider-select").selectOption("grok");
		await expect(page.locator("#provider-select")).toHaveValue("grok");
		await expect(page.locator("#model-select")).toHaveValue("grok-4.6");
		await expect(page.locator("#apikey-input")).toHaveCount(0);
		await expect(page.getByTestId("grok-readiness")).toBeVisible();
	});

	test("로그인 필요를 구분해 표시하고 계정과 설정을 바꾸지 않는다", async ({ page }) => {
		await boot(page, GROK_CFG, { status: "login-required", output: "Not logged in as leak@example.com" });
		await openBrain(page);
		await page.getByTestId("grok-readiness-check").click();
		await expect(page.getByTestId("grok-readiness-status")).toContainText(/Login required|로그인 필요/);
		await expect(page.getByText("leak@example.com")).toHaveCount(0);
		await expect(page.getByText("Not logged in as")).toHaveCount(0);
		expect(
			await page.evaluate(() => JSON.parse(localStorage.getItem("naia-config") || "{}").provider),
		).toBe("grok");
	});

	test("설치 필요와 확인 실패를 구분해 표시한다", async ({ page }) => {
		await boot(page, GROK_CFG, { status: "not-installed" });
		await openBrain(page);
		await page.getByTestId("grok-readiness-check").click();
		await expect(page.getByTestId("grok-readiness-status")).toContainText(/Installation required|설치 필요/);

		await page.evaluate(() => {
			(window as unknown as { __GROK_PREFLIGHT__: { status: string } }).__GROK_PREFLIGHT__ = {
				status: "error",
			};
		});
		await page.getByTestId("grok-readiness-check").click();
		await expect(page.getByTestId("grok-readiness-status")).toContainText(/Check failed|확인 실패/);
	});

	test("로그인 필요 다음에 다시 확인하면 준비됨으로 바뀐다", async ({ page }) => {
		await boot(page, GROK_CFG, { status: "login-required" });
		await openBrain(page);
		await page.getByTestId("grok-readiness-check").click();
		await expect(page.getByTestId("grok-readiness-status")).toContainText(/Login required|로그인 필요/);
		await page.evaluate(() => {
			(window as unknown as { __GROK_PREFLIGHT__: { status: string } }).__GROK_PREFLIGHT__ = {
				status: "ready",
			};
		});
		await page.getByTestId("grok-readiness-check").click();
		await expect(page.getByTestId("grok-readiness-status")).toContainText(/Ready|준비됨/);
	});

	test("API 키 공급자는 Grok 구독 화면과 섞이지 않는다", async ({ page }) => {
		await boot(page, API_KEY_CFG);
		await openBrain(page);
		await expect(page.locator("#provider-select")).toHaveValue("ollama");
		await expect(page.getByTestId("grok-readiness")).toHaveCount(0);
		await expect(page.locator("#apikey-input")).toHaveCount(1);
		expect(await grokPreflightCount(page)).toBe(0);
	});

	test("게이트웨이 grok: prefix는 Grok 구독 화면의 모델로 섞이지 않는다", async ({
		page,
	}) => {
		// #602 (0221930f) removed the xAI API path that used to own the gateway's
		// grok: prefix. The gateway catalog now maps only nextain routes and the
		// remaining CLI/local aliases (SettingsTab.tsx fetchModels providerAlias),
		// so a grok: entry must be dropped instead of reaching the Grok
		// subscription CLI's model list. A claude-code-cli: probe proves the
		// catalog itself was applied.
		const pricing = await boot(page, GROK_CFG, undefined, [
			{
				model_key: "grok:grok-4.3",
				input_price_per_million: 0.4,
				output_price_per_million: 1.2,
				cached_price_per_million: null,
			},
			{
				model_key: "claude-code-cli:claude-e2e-catalog-probe",
				input_price_per_million: 1,
				output_price_per_million: 2,
				cached_price_per_million: null,
			},
		]);
		await openBrain(page);
		await expect.poll(() => pricing.requests).toBeGreaterThan(0);

		const provider = page.locator("#provider-select");
		const model = page.locator("#model-select");
		await provider.selectOption("claude-code-cli");
		await expect(
			model.locator("option[value='claude-e2e-catalog-probe']"),
		).toHaveCount(1);

		await provider.selectOption("grok");
		await expect(provider).toHaveValue("grok");
		await expect(model).toHaveValue("grok-4.6");
		await expect(model.locator("option[value='grok-4.3']")).toHaveCount(0);
		await expect(provider.locator("option[value='grok']")).toHaveCount(1);
		await expect(provider.locator("option[value='xai']")).toHaveCount(0);
		await expect(page.locator("#apikey-input")).toHaveCount(0);
		await expect(page.getByTestId("grok-readiness")).toBeVisible();
		expect(await grokPreflightCount(page)).toBe(0);
	});

	test("Grok 채팅은 API 키 없이 chat_request를 보내고 응답을 렌더한다", async ({ page }) => {
		await boot(page, GROK_CFG);
		const input = page.locator(".chat-input");
		await expect(input).toBeEnabled({ timeout: 10_000 });
		await input.fill("ping");
		await input.press("Enter");

		const assistant = page.locator(".chat-message.assistant");
		await expect(assistant.last()).toContainText("pong", { timeout: 15_000 });

		const outbound = await page.evaluate(
			() =>
				(window as unknown as { __E2E_OUTBOUND__: Array<Record<string, unknown>> })
					.__E2E_OUTBOUND__,
		);
		const chatReqs = outbound.filter((o) => o.type === "chat_request");
		expect(chatReqs.length).toBeGreaterThan(0);
		const last = chatReqs[chatReqs.length - 1] as {
			provider?: { provider?: string; apiKey?: string };
		};
		expect(last.provider?.provider).toBe("grok");
		expect(last.provider?.apiKey ?? "").toBe("");
	});
});
