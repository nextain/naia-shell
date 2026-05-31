import { type Page, expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

/**
 * naia-omni Voice Tool-call E2E.
 *
 * Verifies the #352 fix end-to-end: in a naia-omni (cascade /v1/realtime)
 * voice conversation, a spoken skill request must run and reply.
 *
 * Mocks (no real gateway / mic / audio):
 *   - window.WebSocket  → captures client→server frames, lets the test inject
 *     server→client events (session.created, function_call_arguments.done,
 *     audio_transcript.delta, response.done).
 *   - getUserMedia / AudioContext → no-op (mic-stream + audio-player mount).
 *   - invoke send_to_agent_command{tool_request} → emits an agent_response
 *     tool_result so directToolCall (ChatPanel.onToolCall) resolves.
 *
 * Flow per turn: inject function_call_arguments.done → onToolCall →
 * directToolCall → sendToolResponse (client sends function_call_output, which
 * we assert) → inject the transcript reply → assert it shows in chat.
 */

const NAIA_OMNI_VOICE_MOCK = `
(function() {
	window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
	window.__TAURI_INTERNALS__.metadata = {
		currentWindow: { label: "main" },
		currentWebview: { windowLabel: "main", label: "main" },
	};
	var callbacks = new Map(); var nextCbId = 1;
	window.__TAURI_INTERNALS__.transformCallback = function(fn, once) {
		var id = nextCbId++;
		callbacks.set(id, function(d) { if (once) callbacks.delete(id); return fn && fn(d); });
		return id;
	};
	window.__TAURI_INTERNALS__.unregisterCallback = function(id) { callbacks.delete(id); };
	window.__TAURI_INTERNALS__.runCallback = function(id, d) { var cb = callbacks.get(id); if (cb) cb(d); };
	window.__TAURI_INTERNALS__.callbacks = callbacks;
	var eventListeners = new Map();
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};
	function emitEvent(event, payload) {
		var hs = eventListeners.get(event) || [];
		for (var i = 0; i < hs.length; i++) window.__TAURI_INTERNALS__.runCallback(hs[i], { event: event, payload: payload });
	}
	window.__TAURI_INTERNALS__.convertFileSrc = function(f, p) { return (p || "asset") + "://localhost/" + encodeURIComponent(f); };

	window.__NAIA_E2E__ = { realtimeSent: [], lastWs: null, toolRequests: [] };

	// ---- WebSocket mock — ONLY /v1/realtime (naia-omni). Everything else
	// (vite HMR ws://localhost:1420/...) must use the real WebSocket, or vite's
	// client breaks ("(intermediate value) is not iterable") and lastWs gets
	// clobbered by the HMR socket. ----
	var OrigWS = window.WebSocket;
	function MockRealtimeWS(url) {
		var self = this; self.url = url; self.readyState = 0;
		self.onopen = null; self.onmessage = null; self.onerror = null; self.onclose = null;
		self.send = function(data) { window.__NAIA_E2E__.realtimeSent.push(data); };
		self.close = function() { self.readyState = 3; if (self.onclose) self.onclose({ code: 1000, reason: "", wasClean: true }); };
		window.__NAIA_E2E__.lastWs = self;
		setTimeout(function() {
			self.readyState = 1;
			if (self.onopen) self.onopen();
			// direct mode (no naiaKey) sends no setup; server greets with session.created
			setTimeout(function() { if (self.onmessage) self.onmessage({ data: JSON.stringify({ type: "session.created" }) }); }, 20);
		}, 10);
		return self;
	}
	window.WebSocket = function(url, protocols) {
		if (String(url).indexOf("/v1/realtime") !== -1) return new MockRealtimeWS(url);
		return protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
	};
	window.WebSocket.prototype = OrigWS.prototype;
	window.WebSocket.OPEN = OrigWS.OPEN; window.WebSocket.CLOSED = OrigWS.CLOSED;
	window.WebSocket.CONNECTING = OrigWS.CONNECTING; window.WebSocket.CLOSING = OrigWS.CLOSING;
	window.__NAIA_E2E__.emitRealtime = function(msg) {
		var ws = window.__NAIA_E2E__.lastWs;
		if (ws && ws.onmessage) ws.onmessage({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
	};

	// ---- mic / audio mock ----
	if (!navigator.mediaDevices) navigator.mediaDevices = {};
	navigator.mediaDevices.getUserMedia = function() {
		return Promise.resolve({ getTracks: function() { return [{ stop: function() {} }]; }, getAudioTracks: function() { return [{ stop: function() {} }]; } });
	};
	function MockAudioCtx() { this.sampleRate = 48000; this.state = "running"; this.currentTime = 0; this.destination = {}; }
	MockAudioCtx.prototype.createMediaStreamSource = function() { return { connect: function() {}, disconnect: function() {} }; };
	MockAudioCtx.prototype.createScriptProcessor = function() { return { connect: function() {}, disconnect: function() {}, onaudioprocess: null }; };
	MockAudioCtx.prototype.createBuffer = function(c, l, r) { return { getChannelData: function() { return new Float32Array(l || 1); }, duration: 0, length: l || 1, sampleRate: r || 48000 }; };
	MockAudioCtx.prototype.createBufferSource = function() { return { buffer: null, connect: function() {}, start: function() {}, stop: function() {}, onended: null }; };
	MockAudioCtx.prototype.resume = function() { return Promise.resolve(); };
	MockAudioCtx.prototype.close = function() { return Promise.resolve(); };
	window.AudioContext = MockAudioCtx; window.webkitAudioContext = MockAudioCtx;

	// ---- invoke ----
	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		if (cmd === "plugin:event|listen") { if (!eventListeners.has(args.event)) eventListeners.set(args.event, []); eventListeners.get(args.event).push(args.handler); return args.handler; }
		if (cmd === "plugin:event|emit") { emitEvent(args.event, args.payload); return null; }
		if (cmd === "plugin:event|unlisten") return;
		if (cmd === "send_to_agent_command") {
			var req = JSON.parse(args.message);
			if (req.type === "skill_list") {
				// Voice startup queries agent skills — answer immediately (empty)
				// so fetchAgentSkills doesn't 10s-timeout and stall the connect.
				var slid = req.requestId;
				setTimeout(function() {
					emitEvent("agent_response", JSON.stringify({ type: "skill_list_response", requestId: slid, tools: [] }));
				}, 20);
				return;
			}
			if (req.type === "tool_request") {
				window.__NAIA_E2E__.toolRequests.push({ toolName: req.toolName, args: req.args });
				var rid = req.requestId;
				setTimeout(function() {
					emitEvent("agent_response", JSON.stringify({
						type: "tool_result", requestId: rid, toolCallId: "tc",
						toolName: req.toolName, success: true, output: "검색 결과: 오늘 뉴스 3건",
					}));
					// directToolCall stores tool_result, resolves on finish — mirror it.
					setTimeout(function() {
						emitEvent("agent_response", JSON.stringify({ type: "finish", requestId: rid }));
					}, 10);
				}, 40);
			}
			return;
		}
		if (cmd === "cancel_stream") return;
		if (cmd === "get_progress_data") return { events: [], stats: { totalCost: 0, messageCount: 0, toolCount: 0, errorCount: 0 } };
		if (cmd === "plugin:store|load") return 1;
		if (cmd === "plugin:store|get") return [null, false];
		if (cmd.indexOf("plugin:store|") === 0) return null;
		// memory / audit / misc — keep buildMemoryContext + startup from hanging
		if (cmd === "init_audit_db" || cmd === "init_memory_db") return;
		if (cmd === "query_events") return [];
		if (cmd === "get_all_facts") return [];
		if (cmd === "upsert_fact") return;
		if (cmd === "recall_memory" || cmd === "search_memory") return [];
		if (cmd === "check_gateway_health") return false;
		if (cmd === "get_log_path") return "/tmp/naia-test.log";
		if (cmd === "sync_openclaw_config") return;
		if (cmd === "get_window_state") return { width: 800, height: 600, x: 0, y: 0 };
		if (cmd === "save_window_state") return;
		if (cmd.indexOf("plugin:dialog|") === 0) return null;
		if (cmd.indexOf("plugin:opener|") === 0) return null;
		if (cmd.indexOf("plugin:window|") === 0) return null;
		if (cmd.indexOf("plugin:deep-link|") === 0) return [];
		return undefined;
	};
})();
`;

async function emitRealtime(page: Page, msg: Record<string, unknown>) {
	await page.evaluate((m) => (window as any).__NAIA_E2E__.emitRealtime(m), msg);
}

async function realtimeSent(page: Page): Promise<Record<string, unknown>[]> {
	return page.evaluate(() =>
		(window as any).__NAIA_E2E__.realtimeSent.map((s: string) => {
			try {
				return JSON.parse(s);
			} catch {
				return { raw: s };
			}
		}),
	);
}

async function startVoice(page: Page) {
	const voiceBtn = page.locator(".chat-voice-btn");
	await expect(voiceBtn).toBeVisible({ timeout: 10_000 });
	await voiceBtn.click();
	await expect(voiceBtn).toHaveClass(/active/, { timeout: 10_000 });
}

test.describe("naia-omni Voice Tool E2E", () => {
	test.beforeEach(async ({ page }) => {
		page.on("console", (m) => console.log("[browser:" + m.type() + "]", m.text()));
		page.on("pageerror", (e) => console.log("[pageerror]", e.message));
		await page.addInitScript(NAIA_OMNI_VOICE_MOCK);
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
		await page.addInitScript({ content: SEED_ADK_PATH });
		await page.addInitScript(
			(configJson: string) => localStorage.setItem("naia-config", configJson),
			JSON.stringify({
				// naia-0.9-omni-24g → isOmniModel true (omni segment) → naia-omni
				// provider; no naiaKey → direct mode against vllmHost (mocked WS).
				provider: "vllm",
				model: "naia-0.9-omni-24g",
				vllmHost: "ws://localhost:8000",
				enableTools: true,
				locale: "ko",
				onboardingComplete: true,
			}),
		);
		await page.goto("/");
		await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });
	});

	test("tool call runs (function_call_output sent) and reply shows in chat", async ({
		page,
	}) => {
		await startVoice(page);

		// Server emits a tool call (the model wants to run a skill).
		await emitRealtime(page, {
			type: "response.function_call_arguments.done",
			call_id: "tc_1",
			name: "skill_agent_browser",
			arguments: JSON.stringify({ query: "오늘 뉴스" }),
		});

		// onToolCall → directToolCall (mock tool_result + finish) → sendToolResponse.
		await expect
			.poll(
				async () =>
					(await realtimeSent(page)).some(
						(m) =>
							m.type === "conversation.item.create" &&
							(m.item as { type?: string } | undefined)?.type ===
								"function_call_output",
					),
				{ timeout: 10_000 },
			)
			.toBe(true);

		// The tool actually ran through the agent bridge.
		const toolReqs = await page.evaluate(
			() => (window as any).__NAIA_E2E__.toolRequests,
		);
		expect(toolReqs.map((t: { toolName: string }) => t.toolName)).toContain(
			"skill_agent_browser",
		);

		// Server resumes with the spoken reply transcript.
		await emitRealtime(page, {
			type: "response.audio_transcript.delta",
			delta: "오늘 뉴스 3건 찾았어요.",
		});
		await emitRealtime(page, {
			type: "response.done",
			response: { id: "r1" },
		});

		const assistant = page.locator(
			".chat-message.assistant .message-content",
		);
		await expect(assistant.last()).toContainText("오늘 뉴스 3건", {
			timeout: 10_000,
		});
	});

	test("multi-turn: two consecutive tool calls each run and reply", async ({
		page,
	}) => {
		await startVoice(page);

		for (let turn = 1; turn <= 2; turn++) {
			const before = (await realtimeSent(page)).filter(
				(m) =>
					m.type === "conversation.item.create" &&
					(m.item as { type?: string } | undefined)?.type ===
						"function_call_output",
			).length;

			await emitRealtime(page, {
				type: "response.function_call_arguments.done",
				call_id: `tc_${turn}`,
				name: "skill_agent_browser",
				arguments: JSON.stringify({ query: `질문 ${turn}` }),
			});

			await expect
				.poll(
					async () =>
						(await realtimeSent(page)).filter(
							(m) =>
								m.type === "conversation.item.create" &&
								(m.item as { type?: string } | undefined)?.type ===
									"function_call_output",
						).length,
					{ timeout: 10_000 },
				)
				.toBe(before + 1);

			await emitRealtime(page, {
				type: "response.audio_transcript.delta",
				delta: `답변 ${turn} 입니다.`,
			});
			await emitRealtime(page, {
				type: "response.done",
				response: { id: `r${turn}` },
			});

			const assistant = page.locator(
				".chat-message.assistant .message-content",
			);
			await expect(assistant.last()).toContainText(`답변 ${turn}`, {
				timeout: 10_000,
			});
		}

		// Both turns drove a real tool execution through the agent bridge.
		const toolReqs = await page.evaluate(
			() => (window as any).__NAIA_E2E__.toolRequests,
		);
		expect(toolReqs.length).toBeGreaterThanOrEqual(2);
	});
});
