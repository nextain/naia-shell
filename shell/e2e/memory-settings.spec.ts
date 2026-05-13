import { expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

/**
 * Naia Shell E2E — Memory settings UI verification.
 *
 * Tests that the memory settings section in SettingsTab correctly renders
 * adapter options, embedding provider options, backup UI, and persists config.
 *
 * Prerequisites:
 *   Vite dev server running at localhost:1420
 */

const API_KEY = "e2e-mock-key";

/** Base IPC mock, reused and extended per test. */
function buildMockScript(overrides = "") {
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
	window.__TAURI_INTERNALS__.runCallback = function(id, data) { var cb = callbacks.get(id); if (cb) cb(data); };
	window.__TAURI_INTERNALS__.callbacks = callbacks;

	var eventListeners = new Map();
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};

	window.__TAURI_INTERNALS__.convertFileSrc = function(filePath, protocol) {
		protocol = protocol || "asset";
		return protocol + "://localhost/" + encodeURIComponent(filePath);
	};

	window.__MEMORY_SETTINGS_E2E__ = {
		exportCalls: 0,
		importCalls: 0,
		factsRequested: 0,
		deletedFacts: 0,
		lastExportPassword: null,
		lastDeletedFactId: null,
		syncGatewayParams: null,
	};

	var MOCK_FACTS = [
		{
			id: "f1",
			content: "User prefers TypeScript",
			entities: ["TypeScript"],
			topics: ["preference"],
			createdAt: 1000,
			updatedAt: 1000,
			importance: 0.8,
			recallCount: 2,
			lastAccessed: 2000,
			strength: 0.7,
			sourceEpisodes: [],
		},
		{
			id: "f2",
			content: "User's name is Luke",
			entities: ["Luke"],
			topics: ["identity"],
			createdAt: 1000,
			updatedAt: 1000,
			importance: 0.9,
			recallCount: 5,
			lastAccessed: 3000,
			strength: 0.9,
			sourceEpisodes: [],
		},
	];

	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		if (cmd === "plugin:event|listen") {
			if (!eventListeners.has(args.event)) eventListeners.set(args.event, []);
			eventListeners.get(args.event).push(args.handler);
			return args.handler;
		}
		if (cmd === "plugin:event|emit") return null;
		if (cmd === "plugin:event|unlisten") return;

		if (cmd === "memory_get_all_facts") {
			window.__MEMORY_SETTINGS_E2E__.factsRequested++;
			return MOCK_FACTS;
		}
		if (cmd === "memory_delete_fact") {
			window.__MEMORY_SETTINGS_E2E__.deletedFacts++;
			window.__MEMORY_SETTINGS_E2E__.lastDeletedFactId = args.factId;
			return true;
		}
		if (cmd === "memory_export_backup") {
			window.__MEMORY_SETTINGS_E2E__.exportCalls++;
			window.__MEMORY_SETTINGS_E2E__.lastExportPassword = args.password;
			return Array.from(new Uint8Array(10));
		}
		if (cmd === "memory_import_backup") {
			window.__MEMORY_SETTINGS_E2E__.importCalls++;
			return;
		}

		if (cmd === "sync_gateway_config") {
			window.__MEMORY_SETTINGS_E2E__.syncGatewayParams = args && args.params ? args.params : args;
			return;
		}

		// Standard stubs
		if (cmd === "sync_openclaw_config") return;
		if (cmd === "restart_gateway") return;
		if (cmd === "send_to_agent_command") return;
		if (cmd === "cancel_stream") return;
		if (cmd === "get_audit_log") return [];
		if (cmd === "get_audit_stats") return { totalCost: 0, messageCount: 0, toolCount: 0, errorCount: 0 };
		if (cmd === "list_skills") return [];
		if (cmd === "list_stt_models") return [];
		if (cmd === "list_audio_output_devices") return [];
		if (cmd === "fetch_linked_channels") return [];
		if (cmd === "gateway_health") return false;
		if (cmd === "read_openclaw_memory_files") return [];
		if (cmd && cmd.startsWith("plugin:store|")) return null;

		${overrides}

		return undefined;
	};
})();
`;
}

/** Navigate to SettingsTab and wait for the memory section to be visible. */
async function gotoSettings(page: import("@playwright/test").Page) {
	await page.goto("/");
	await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });

	// Open settings — use first() to avoid strict-mode violation if multiple matches
	await page
		.getByRole("button", { name: /settings|설정/i })
		.first()
		.click();

	// Wait for memory section heading
	await expect(page.getByText(/기억|Memory/i).first()).toBeVisible({
		timeout: 8_000,
	});
}

test.describe("Memory Settings UI", () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(buildMockScript());
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
		await page.addInitScript({ content: SEED_ADK_PATH });

		await page.addInitScript(
			(configJson: string) => {
				localStorage.setItem("naia-config", configJson);
			},
			JSON.stringify({
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: API_KEY,
				enableTools: true,
				locale: "ko",
				userName: "Luke",
				agentName: "Naia",
				onboardingComplete: true,
				discordSessionMigrated: true,
			}),
		);
	});

	test("memory section renders adapter and embedding options", async ({
		page,
	}) => {
		await gotoSettings(page);

		// Adapter radio buttons
		await expect(
			page.locator('input[name="memory-adapter"][value="local"]'),
		).toBeVisible();
		await expect(
			page.locator('input[name="memory-adapter"][value="qdrant"]'),
		).toBeVisible();

		// Embedding radio buttons — current options are: none, offline, vllm, ollama, naia
		// (openai-compat was removed in favor of dedicated vllm/ollama radios)
		await expect(
			page.locator('input[name="memory-embedding"][value="none"]'),
		).toBeVisible();
		await expect(
			page.locator('input[name="memory-embedding"][value="offline"]'),
		).toBeVisible();
		await expect(
			page.locator('input[name="memory-embedding"][value="vllm"]'),
		).toBeVisible();
		await expect(
			page.locator('input[name="memory-embedding"][value="ollama"]'),
		).toBeVisible();
		await expect(
			page.locator('input[name="memory-embedding"][value="naia"]'),
		).toBeVisible();
	});

	test("Qdrant adapter shows URL and API key fields when selected", async ({
		page,
	}) => {
		await gotoSettings(page);

		// Qdrant fields should be hidden initially (default = local)
		await expect(page.locator('input[placeholder*="6333"]')).not.toBeVisible();

		// Select Qdrant adapter
		await page.locator('input[name="memory-adapter"][value="qdrant"]').click();

		// Qdrant URL and API key fields should appear
		await expect(page.locator('input[placeholder*="6333"]')).toBeVisible();
		await expect(
			page.locator('input[type="password"][placeholder*="..."]').last(),
		).toBeVisible();
	});

	test("offline embedding shows model selection when selected", async ({
		page,
	}) => {
		await gotoSettings(page);

		// Select offline embedding
		await page
			.locator('input[name="memory-embedding"][value="offline"]')
			.click();

		// Model selection radio buttons should appear
		await expect(
			page.locator(
				'input[name="memory-offline-model"][value="all-MiniLM-L6-v2"]',
			),
		).toBeVisible();
		await expect(
			page.locator(
				'input[name="memory-offline-model"][value="all-mpnet-base-v2"]',
			),
		).toBeVisible();
	});

	test("vllm/ollama embedding shows base URL, key, and model fields", async ({
		page,
	}) => {
		// openai-compat radio was replaced with separate vllm + ollama radios that
		// share the same field layout (base URL / API key / model).
		await gotoSettings(page);

		await page
			.locator('input[name="memory-embedding"][value="vllm"]')
			.click();

		await expect(
			page.locator('input[placeholder*="localhost:11434"]'),
		).toBeVisible();
		await expect(
			page.locator('input[placeholder*="text-embedding-ada-002"]'),
		).toBeVisible();
		await expect(
			page.locator('input[type="password"][placeholder="sk-..."]').last(),
		).toBeVisible();
	});

	test("naia embedding shows Naia account required hint when not logged in", async ({
		page,
	}) => {
		await gotoSettings(page);

		await page.locator('input[name="memory-embedding"][value="naia"]').click();

		// No naiaKey in config, so should show "required" hint
		await expect(
			page.getByText(/Naia account required|Naia 계정 필요/i),
		).toBeVisible();
	});

	test("backup section shows password field and export/import buttons", async ({
		page,
	}) => {
		await gotoSettings(page);

		// Backup password input
		await expect(
			page
				.locator(
					'input[type="password"][placeholder*="password"], input[type="password"][placeholder*="비밀번호"]',
				)
				.first(),
		).toBeVisible();

		// Export button
		await expect(
			page.getByRole("button", { name: /export|내보내기/i }),
		).toBeVisible();

		// Import button
		await expect(
			page.getByRole("button", { name: /import|가져오기/i }),
		).toBeVisible();
	});

	test("facts list loads and displays memory stats", async ({ page }) => {
		await gotoSettings(page);

		// Wait for facts to load (mocked as 2 items)
		await page.waitForFunction(
			() => (window as any).__MEMORY_SETTINGS_E2E__?.factsRequested > 0,
			{},
			{ timeout: 10_000 },
		);

		// Memory stats should show fact count
		await expect(page.getByText(/2.*fact|사실 2/i)).toBeVisible({
			timeout: 5_000,
		});

		// Fact contents should be visible in the list
		await expect(page.getByText("User prefers TypeScript")).toBeVisible();
	});

	test("delete fact invokes memory_delete_fact IPC and removes from list", async ({
		page,
	}) => {
		await gotoSettings(page);

		// Wait for facts to load
		await page.waitForFunction(
			() => (window as any).__MEMORY_SETTINGS_E2E__?.factsRequested > 0,
			{},
			{ timeout: 10_000 },
		);

		// Click first delete button
		await page.locator(".fact-delete-btn").first().click();

		// IPC should have been called
		await page.waitForFunction(
			() => (window as any).__MEMORY_SETTINGS_E2E__?.deletedFacts > 0,
			{},
			{ timeout: 5_000 },
		);
		const deleteResult = await page.evaluate(() => ({
			deletedFacts: (window as any).__MEMORY_SETTINGS_E2E__?.deletedFacts,
			lastDeletedFactId: (window as any).__MEMORY_SETTINGS_E2E__
				?.lastDeletedFactId,
		}));
		expect(deleteResult.deletedFacts).toBe(1);
		// First fact is "f1" (User prefers TypeScript)
		expect(deleteResult.lastDeletedFactId).toBe("f1");

		// Fact should be removed from the list
		await expect(page.getByText("User prefers TypeScript")).not.toBeVisible();
	});

	test("export backup invokes memory_export_backup IPC", async ({ page }) => {
		await gotoSettings(page);

		// Find backup password input and fill it
		const pwInput = page
			.locator(
				'input[type="password"][placeholder*="password"], input[type="password"][placeholder*="비밀번호"]',
			)
			.last();
		await pwInput.fill("test-password");

		// Click Export
		await page.getByRole("button", { name: /export|내보내기/i }).click();

		// Verify IPC was called
		await page.waitForFunction(
			() => (window as any).__MEMORY_SETTINGS_E2E__?.exportCalls > 0,
			{},
			{ timeout: 5_000 },
		);
		const result = await page.evaluate(() => ({
			exportCalls: (window as any).__MEMORY_SETTINGS_E2E__?.exportCalls,
			lastExportPassword: (window as any).__MEMORY_SETTINGS_E2E__
				?.lastExportPassword,
		}));
		expect(result.exportCalls).toBe(1);
		expect(result.lastExportPassword).toBe("test-password");
	});

	test("save calls sync_gateway_config with memory fields", async ({
		page,
	}) => {
		await gotoSettings(page);

		// Select Qdrant adapter
		await page.locator('input[name="memory-adapter"][value="qdrant"]').click();
		await page
			.locator('input[placeholder*="6333"]')
			.fill("http://localhost:6333");

		// Select vllm embedding (openai-compat-style endpoint)
		await page
			.locator('input[name="memory-embedding"][value="vllm"]')
			.click();
		await page
			.locator('input[placeholder*="localhost:11434"]')
			.fill("http://localhost:11434");
		await page
			.locator('input[placeholder*="text-embedding-ada-002"]')
			.fill("nomic-embed-text");

		// Save
		await page.locator(".settings-save-btn").first().click();

		// Wait for sync_gateway_config IPC to be called
		await page.waitForFunction(
			() => (window as any).__MEMORY_SETTINGS_E2E__?.syncGatewayParams !== null,
			{},
			{ timeout: 5_000 },
		);

		const syncParams = await page.evaluate(
			() => (window as any).__MEMORY_SETTINGS_E2E__?.syncGatewayParams,
		);

		expect(syncParams?.memory_adapter).toBe("qdrant");
		expect(syncParams?.qdrant_url).toBe("http://localhost:6333");
		expect(syncParams?.memory_embedding_provider).toBe("vllm");
		expect(syncParams?.memory_embedding_base_url).toBe(
			"http://localhost:11434",
		);
		expect(syncParams?.memory_embedding_model).toBe("nomic-embed-text");
	});

	test("save calls sync_gateway_config with local adapter and no embedding (defaults)", async ({
		page,
	}) => {
		await gotoSettings(page);

		// local is default, none is default — just save without changing memory settings
		// (use class selector to avoid strict-mode collisions with other "save" buttons)
		await page.locator(".settings-save-btn").first().click();

		await page.waitForFunction(
			() => (window as any).__MEMORY_SETTINGS_E2E__?.syncGatewayParams !== null,
			{},
			{ timeout: 5_000 },
		);

		const syncParams = await page.evaluate(
			() => (window as any).__MEMORY_SETTINGS_E2E__?.syncGatewayParams,
		);

		// local adapter with no embedding should be synced
		expect(syncParams?.memory_adapter).toBe("local");
		expect(syncParams?.memory_embedding_provider).toBe("none");
		// qdrant fields should be null/absent
		expect(syncParams?.qdrant_url == null).toBe(true);
	});

	test("save persists memory fields to localStorage", async ({ page }) => {
		await gotoSettings(page);

		// Select Qdrant adapter
		await page.locator('input[name="memory-adapter"][value="qdrant"]').click();

		// Fill Qdrant URL
		await page
			.locator('input[placeholder*="6333"]')
			.fill("http://localhost:6333");

		// Select vllm embedding (openai-compat-style endpoint)
		await page
			.locator('input[name="memory-embedding"][value="vllm"]')
			.click();
		await page
			.locator('input[placeholder*="localhost:11434"]')
			.fill("http://localhost:11434");

		// Save
		await page.locator(".settings-save-btn").first().click();

		// Read back from localStorage
		const saved = await page.evaluate(() => {
			const raw = localStorage.getItem("naia-config");
			return raw ? JSON.parse(raw) : null;
		});

		expect(saved?.memoryAdapter).toBe("qdrant");
		expect(saved?.qdrantUrl).toBe("http://localhost:6333");
		expect(saved?.memoryEmbeddingProvider).toBe("vllm");
		expect(saved?.memoryEmbeddingBaseUrl).toBe("http://localhost:11434");
	});
});
