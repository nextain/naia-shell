import { type Page, expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

/**
 * Full-stack naia-os ↔ naia-agent IPC E2E tests.
 *
 * Covers:
 *   A. config_sync — agent pushes config on ready → shell merges into localStorage
 *   B. Model config — shell sends config_update with correct provider/model env vars
 *   C. Multi-turn conversation — two back-to-back chat turns complete correctly
 *   D. Skill (panel tool) usage — agent calls panel tool, shell executes + responds
 *
 * All tests use Playwright + mocked Tauri IPC (no real Tauri runtime needed).
 * Agent responses are simulated via the agent_response event emitter.
 */

// ─── Mock script shared by all tests ────────────────────────────────────────

const TAURI_MOCK_SCRIPT = `
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
	window.__TAURI_INTERNALS__.runCallback = function(id, data) {
		var cb = callbacks.get(id);
		if (cb) cb(data);
	};
	window.__TAURI_INTERNALS__.callbacks = callbacks;

	window.__TAURI_INTERNALS__.convertFileSrc = function(filePath) {
		return "asset://localhost/" + encodeURIComponent(filePath);
	};

	var eventListeners = new Map();
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};

	window.__NAIA_EMIT__ = function(event, payload) {
		var handlers = eventListeners.get(event) || [];
		for (var i = 0; i < handlers.length; i++) {
			window.__TAURI_INTERNALS__.runCallback(handlers[i], { event: event, payload: payload });
		}
	};

	// Capture all send_to_agent_command calls
	window.__AGENT_COMMANDS__ = [];

	var tcCounter = 0;

	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		if (cmd === "plugin:event|listen") {
			if (!eventListeners.has(args.event)) eventListeners.set(args.event, []);
			eventListeners.get(args.event).push(args.handler);
			return args.handler;
		}
		if (cmd === "plugin:event|emit") {
			window.__NAIA_EMIT__(args.event, args.payload);
			return null;
		}
		if (cmd === "plugin:event|unlisten") return;

		if (cmd === "send_to_agent_command") {
			var msg = JSON.parse(args.message);
			window.__AGENT_COMMANDS__.push(msg);

			// Respond to chat_request with a simulated streaming response
			if (msg.type === "chat_request") {
				var reqId = msg.requestId;
				var lastMsg = (msg.messages || []).slice(-1)[0] || {};
				var text = lastMsg.content || "";

				// Skill usage test: trigger a panel_tool_call for "naia skill" keyword
				if (text.toLowerCase().indexOf("naia skill") !== -1) {
					var tcId = "tc-skill-" + (++tcCounter);
					setTimeout(function() {
						window.__NAIA_EMIT__("agent_response", JSON.stringify(
							{ type: "panel_tool_call", requestId: reqId, toolCallId: tcId, toolName: "skill_panel", args: { action: "status" } }
						));
					}, 100);
					// After panel_tool_result arrives, send text + finish
					// The shell will reply with panel_tool_result via send_to_agent_command
					window.__PENDING_PANEL_TC__ = { reqId: reqId, tcId: tcId };
					return;
				}

				// Multi-turn: echo the user text
				var chunks = [
					{ type: "text", requestId: reqId, text: "Echo: " + text },
					{ type: "finish", requestId: reqId },
				];
				var delay = 200;
				for (var i = 0; i < chunks.length; i++) {
					(function(chunk, d) {
						setTimeout(function() {
							window.__NAIA_EMIT__("agent_response", JSON.stringify(chunk));
						}, d);
					})(chunks[i], delay);
					delay += 200;
				}
				return;
			}

			// panel_tool_result: finish the pending skill request
			if (msg.type === "panel_tool_result" && window.__PENDING_PANEL_TC__) {
				var pt = window.__PENDING_PANEL_TC__;
				window.__PENDING_PANEL_TC__ = null;
				var skillChunks = [
					{ type: "text", requestId: pt.reqId, text: "Skill executed successfully." },
					{ type: "finish", requestId: pt.reqId },
				];
				var d2 = 100;
				for (var j = 0; j < skillChunks.length; j++) {
					(function(sc, d) {
						setTimeout(function() {
							window.__NAIA_EMIT__("agent_response", JSON.stringify(sc));
						}, d);
					})(skillChunks[j], d2);
					d2 += 200;
				}
			}

			return;
		}

		return undefined;
	};
})();
`;

const SEED_CONFIG = JSON.stringify({
	// Use ollama (no API key required) so chat requests reach the mock IPC layer.
	// Tests A and B override provider in-page when needed.
	provider: "ollama",
	model: "llama3.2",
	agentName: "Naia",
	onboardingComplete: true,
	workspaceRoot: "/tmp/mock-naia-adk-workspace",
});

async function waitForMainShell(page: Page) {
	await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
	await page.waitForTimeout(2_500);
	await expect(page.locator(".adk-setup-screen")).toBeHidden({ timeout: 5_000 });
}

async function sendChat(page: Page, text: string) {
	const beforeCount = await page.locator(".chat-message.assistant").count();
	const input = page.locator(".chat-input");
	await expect(input).toBeEnabled({ timeout: 8_000 });
	await input.fill(text);
	await input.press("Enter");
	await Promise.race([
		expect(page.locator(".cursor-blink").first()).toBeVisible({ timeout: 10_000 }).catch(() => {}),
		expect(page.locator(".chat-message.assistant")).toHaveCount(beforeCount + 1, { timeout: 10_000 }).catch(() => {}),
	]);
	await expect(page.locator(".cursor-blink")).toBeHidden({ timeout: 15_000 });
}

// ─── Test suite ──────────────────────────────────────────────────────────────

test.describe("naia-os ↔ naia-agent full-stack IPC", () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript({ content: TAURI_MOCK_SCRIPT });
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
		await page.addInitScript({ content: SEED_ADK_PATH });
		await page.addInitScript(
			(cfg: string) => localStorage.setItem("naia-config", cfg),
			SEED_CONFIG,
		);
	});

	// ── A. config_sync ────────────────────────────────────────────────────────

	test("A: config_sync from agent merges non-secret fields into localStorage", async ({ page }) => {
		await page.goto("/");
		await waitForMainShell(page);

		// Simulate agent sending config_sync (happens automatically on real agent startup)
		await page.evaluate(() => {
			window.__NAIA_EMIT__("agent_response", JSON.stringify({
				type: "config_sync",
				config: {
					provider: "zai",
					model: "glm-5.1",
					agentName: "TestAgent",
					NAIA_MAIN_PROVIDER: "zai",    // env-var keys should be skipped
					NAIA_ANYLLM_API_KEY: "secret", // secret key should be skipped
				},
			}));
		});

		await page.waitForTimeout(500);

		// Verify shell merged the config into localStorage
		const config = await page.evaluate(() => {
			const raw = localStorage.getItem("naia-config");
			return raw ? JSON.parse(raw) : null;
		});

		// agentName from config_sync should be merged
		expect(config?.agentName, "agentName merged from config_sync").toBe("TestAgent");
		// NAIA_ env-var keys should NOT be in localStorage
		expect(config?.["NAIA_MAIN_PROVIDER"], "env-var keys skipped").toBeUndefined();
		// Secret keys should NOT be in localStorage
		expect(config?.["NAIA_ANYLLM_API_KEY"], "secret keys skipped").toBeUndefined();
	});

	// ── B. Model config — shell → agent config_update ────────────────────────

	test("B: shell sends config_update with NAIA_ANYLLM_BASE_URL on settings save", async ({ page }) => {
		await page.goto("/");
		await waitForMainShell(page);

		// Trigger a config save with gateway provider (simulates user changing settings)
		await page.evaluate(() => {
			const existing = JSON.parse(localStorage.getItem("naia-config") || "{}");
			const next = {
				...existing,
				provider: "zai",
				model: "glm-5.1",
			};
			localStorage.setItem("naia-config", JSON.stringify(next));
			window.dispatchEvent(new CustomEvent("naia-config-changed"));
		});

		// Wait for debounced write + config_update IPC
		await page.waitForTimeout(1_500);

		const commands = await page.evaluate(
			() => (window as unknown as { __AGENT_COMMANDS__: Record<string, unknown>[] }).__AGENT_COMMANDS__ ?? [],
		);

		// Shell should have sent config_update to agent
		const configUpdates = commands.filter((c) => c.type === "config_update");
		expect(configUpdates.length, "config_update IPC fired").toBeGreaterThanOrEqual(1);

		// writeNaiaConfig also sends config_update; verify it contains NAIA_ keys
		const withNaia = configUpdates.find(
			(c) => c.config && typeof c.config === "object" &&
				("NAIA_MAIN_PROVIDER" in (c.config as object) || "NAIA_MAIN_MODEL" in (c.config as object)),
		);
		expect(withNaia, "config_update includes NAIA env-var fields").toBeDefined();
	});

	// ── C. Multi-turn conversation ────────────────────────────────────────────

	test("C: multi-turn conversation — two turns complete and render in chat", async ({ page }) => {
		await page.goto("/");
		await waitForMainShell(page);

		// Turn 1
		await sendChat(page, "Hello, first turn");
		const turn1 = await page.locator(".chat-message.assistant").last().textContent();
		expect(turn1, "turn 1 response rendered").toContain("Echo: Hello, first turn");

		// Turn 2
		await sendChat(page, "Second turn follow-up");
		const msgs = await page.locator(".chat-message.assistant").all();
		expect(msgs.length, "two assistant messages").toBeGreaterThanOrEqual(2);
		const turn2 = await msgs[msgs.length - 1].textContent();
		expect(turn2, "turn 2 response rendered").toContain("Echo: Second turn follow-up");

		// Verify second chat_request included conversation history
		const commands = await page.evaluate(
			() => (window as unknown as { __AGENT_COMMANDS__: Record<string, unknown>[] }).__AGENT_COMMANDS__ ?? [],
		);
		const chatRequests = commands.filter((c) => c.type === "chat_request") as Array<{
			type: string;
			messages: { role: string; content: string }[];
		}>;
		expect(chatRequests.length, "two chat_requests sent").toBeGreaterThanOrEqual(2);
		const secondReq = chatRequests[1];
		expect(secondReq.messages.length, "second request includes history").toBeGreaterThanOrEqual(2);
	});

	// ── D. Skill (panel tool) usage ───────────────────────────────────────────

	test("D: agent panel_tool_call is handled and panel_tool_result is sent back", async ({ page }) => {
		await page.goto("/");
		await waitForMainShell(page);

		// Trigger skill usage scenario
		await sendChat(page, "Use naia skill to check status");

		// shell should have sent panel_tool_result back to agent
		const commands = await page.evaluate(
			() => (window as unknown as { __AGENT_COMMANDS__: Record<string, unknown>[] }).__AGENT_COMMANDS__ ?? [],
		);
		const toolResults = commands.filter((c) => c.type === "panel_tool_result");
		expect(toolResults.length, "panel_tool_result sent after panel_tool_call").toBeGreaterThanOrEqual(1);

		// The agent then sends text + finish
		const lastMsg = await page.locator(".chat-message.assistant").last().textContent();
		expect(lastMsg, "skill response rendered").toContain("Skill executed successfully");
	});
});
