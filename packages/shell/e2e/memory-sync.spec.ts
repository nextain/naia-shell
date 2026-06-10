import { expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

/**
 * Naia Shell E2E — Memory sync verification.
 *
 * Tests that:
 * 1. syncToOpenClaw includes facts in the persona (SOUL.md content)
 * 2. Startup sync fires on app mount
 * 3. read_openclaw_memory_files IPC is called by memory-sync
 *
 * Prerequisites:
 *   Vite dev server running at localhost:1420
 */

const API_KEY = "e2e-mock-key";

/**
 * IPC mock that captures sync_openclaw_config calls for assertion.
 * Also provides mock facts via memory_get_all_facts.
 */
const MEMORY_MOCK_SCRIPT = `
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

	function emitEvent(event, payload) {
		var handlers = eventListeners.get(event) || [];
		for (var i = 0; i < handlers.length; i++) {
			window.__TAURI_INTERNALS__.runCallback(handlers[i], { event: event, payload: payload });
		}
	}

	window.__TAURI_INTERNALS__.convertFileSrc = function(filePath, protocol) {
		protocol = protocol || "asset";
		return protocol + "://localhost/" + encodeURIComponent(filePath);
	};

	// ---- E2E capture state ----
	window.__MEMORY_E2E__ = {
		syncCalls: [],           // captured sync_openclaw_config calls
		memoryFileReads: 0,      // count of read_openclaw_memory_files calls
		factsRequested: 0,       // count of memory_get_all_facts calls
	};

	// Mock facts to be returned by memory_get_all_facts
	var MOCK_FACTS = [
		{ id: "f1", key: "birthday", value: "1990-01-15", source_session: null, created_at: 1000, updated_at: 1000 },
		{ id: "f2", key: "favorite_color", value: "blue", source_session: null, created_at: 1000, updated_at: 1000 },
	];

	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		// Event system
		if (cmd === "plugin:event|listen") {
			if (!eventListeners.has(args.event)) eventListeners.set(args.event, []);
			eventListeners.get(args.event).push(args.handler);
			return args.handler;
		}
		if (cmd === "plugin:event|emit") {
			emitEvent(args.event, args.payload);
			return null;
		}
		if (cmd === "plugin:event|unlisten") return;

		// Memory facts
		if (cmd === "memory_get_all_facts") {
			window.__MEMORY_E2E__.factsRequested++;
			return MOCK_FACTS;
		}
		if (cmd === "memory_upsert_fact") return;
		if (cmd === "memory_delete_fact") return;

		// OpenClaw sync — capture the persona content
		if (cmd === "sync_openclaw_config") {
			window.__MEMORY_E2E__.syncCalls.push({
				persona: args.params.persona,
				provider: args.params.provider,
				model: args.params.model,
			});
			return;
		}

		// Memory file reads
		if (cmd === "read_openclaw_memory_files") {
			window.__MEMORY_E2E__.memoryFileReads++;
			return []; // No memory files in mock
		}

		// Gateway session stubs
		if (cmd === "restart_gateway") return;
		if (cmd === "send_to_agent_command") return;
		if (cmd === "cancel_stream") return;
		if (cmd === "get_audit_log") return [];
		if (cmd === "get_audit_stats") return { totalCost: 0, messageCount: 0, toolCount: 0, errorCount: 0 };
		if (cmd === "list_skills") return [];
		if (cmd === "fetch_linked_channels") return [];
		if (cmd === "gateway_health") return false;

		// Store plugin — load returns RID, get returns [value, exists] tuple
		if (cmd === "plugin:store|load") return 1;
		if (cmd === "plugin:store|get") return [null, false];
		if (cmd && cmd.startsWith("plugin:store|")) return null;

		return undefined;
	};
})();
`;

// SKIPPED: OpenClaw was migrated to Naia Gateway in #201 — sync_openclaw_config and
// read_openclaw_memory_files no longer exist. Spec needs a full rewrite against the
// new sync_gateway_config flow + memory_get_all_facts persistence.
test.describe.skip("Memory Sync E2E", () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(MEMORY_MOCK_SCRIPT);
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
		await page.addInitScript({ content: SEED_ADK_PATH });

		// Seed config with discordSessionMigrated to skip migration
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
				persona: "Friendly AI companion",
				onboardingComplete: true,
				discordSessionMigrated: true,
			}),
		);

		await page.goto("/");
		await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });
	});

	test("startup sync: syncToOpenClaw fires on app mount with facts", async ({
		page,
	}) => {
		// Wait for startup sync to complete (async, fires in useEffect)
		await page.waitForFunction(
			() => (window as any).__MEMORY_E2E__?.syncCalls.length > 0,
			{},
			{ timeout: 10_000 },
		);

		const e2eState = await page.evaluate(() => (window as any).__MEMORY_E2E__);

		// syncToOpenClaw should have been called at least once
		expect(e2eState.syncCalls.length).toBeGreaterThanOrEqual(1);

		// The persona (SOUL.md content) should include mock facts
		const lastSync = e2eState.syncCalls[e2eState.syncCalls.length - 1];
		expect(lastSync.persona).toContain("birthday: 1990-01-15");
		expect(lastSync.persona).toContain("favorite_color: blue");
		expect(lastSync.persona).toContain("Known facts about the user");
	});

	test("startup sync: persona includes user context from config", async ({
		page,
	}) => {
		await page.waitForFunction(
			() => (window as any).__MEMORY_E2E__?.syncCalls.length > 0,
			{},
			{ timeout: 10_000 },
		);

		const e2eState = await page.evaluate(() => (window as any).__MEMORY_E2E__);
		const lastSync = e2eState.syncCalls[e2eState.syncCalls.length - 1];

		// Should include userName from config
		expect(lastSync.persona).toContain("Luke");
		// Should include Korean language instruction
		expect(lastSync.persona).toContain("Korean");
		// Should include emotion tags
		expect(lastSync.persona).toContain("Emotion tags");
	});

	test("getAllFacts is called during sync", async ({ page }) => {
		await page.waitForFunction(
			() => (window as any).__MEMORY_E2E__?.factsRequested > 0,
			{},
			{ timeout: 10_000 },
		);

		const e2eState = await page.evaluate(() => (window as any).__MEMORY_E2E__);
		expect(e2eState.factsRequested).toBeGreaterThanOrEqual(1);
	});

	test("memory-sync: read_openclaw_memory_files called on startup", async ({
		page,
	}) => {
		// startMemorySync fires after 5s delay
		await page.waitForFunction(
			() => (window as any).__MEMORY_E2E__?.memoryFileReads > 0,
			{},
			{ timeout: 15_000 },
		);

		const e2eState = await page.evaluate(() => (window as any).__MEMORY_E2E__);
		expect(e2eState.memoryFileReads).toBeGreaterThanOrEqual(1);
	});
});
