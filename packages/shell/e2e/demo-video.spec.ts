import * as fs from "node:fs";
import * as path from "node:path";
import { type Page, expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";
import {
	DEMO_INPUTS,
	DEMO_MOCK_DATA,
	DEMO_MOCK_RESPONSES,
	DEMO_SECTION_LABELS,
	type NarrationLang,
} from "./demo-narrations-i18n";
import { DEMO_SCENES } from "./demo-script";

/**
 * Naia OS 3-minute Demo Video — Playwright Recording (Multilingual)
 *
 * Records a WebM video of the full demo flow:
 *   Phase 1: Onboarding (provider → API key → agent name → user name → character → personality → messenger → complete)
 *   Phase 2: Main app tour (chat, history, skills, channels, agents, diagnostics, settings, progress)
 *
 * Run:
 *   cd shell && pnpm test:e2e -- demo-video.spec.ts                  # Korean (default)
 *   cd shell && DEMO_LANG=en pnpm test:e2e -- demo-video.spec.ts     # English
 *   cd shell && DEMO_LANG=ja pnpm test:e2e -- demo-video.spec.ts     # Japanese
 *
 * Output:
 *   shell/e2e/demo-output/{lang}/demo-raw.webm
 *   shell/e2e/demo-output/{lang}/timeline.json
 */

const DEMO_LANG = (process.env.DEMO_LANG || "ko") as NarrationLang;
const OUTPUT_DIR = path.resolve(import.meta.dirname, "demo-output");
const LANG_OUTPUT_DIR = path.join(OUTPUT_DIR, DEMO_LANG);
const VIEWPORT = { width: 400, height: 768 };
const MOCK_API_KEY = "e2e-mock-key-demo";

// ---- Mock data (language-independent) ----

const MOCK_SKILLS = [
	{
		name: "skill_time",
		description: "현재 시간/날짜 조회",
		type: "built-in",
		tier: 0,
		source: "built-in",
	},
	{
		name: "skill_system_status",
		description: "시스템 상태 확인",
		type: "built-in",
		tier: 0,
		source: "built-in",
	},
	{
		name: "skill_memo",
		description: "메모 저장/조회/삭제",
		type: "built-in",
		tier: 1,
		source: "built-in",
	},
	{
		name: "skill_weather",
		description: "현재 날씨 조회",
		type: "built-in",
		tier: 0,
		source: "built-in",
	},
	{
		name: "skill_skill_manager",
		description: "스킬 관리 (검색/활성화/비활성화)",
		type: "built-in",
		tier: 1,
		source: "built-in",
	},
	{
		name: "execute_command",
		description: "셸 명령 실행",
		type: "gateway",
		tier: 2,
		source: "gateway",
		gatewaySkill: "execute_command",
	},
	{
		name: "write_file",
		description: "파일 쓰기",
		type: "gateway",
		tier: 2,
		source: "gateway",
		gatewaySkill: "write_file",
	},
	{
		name: "read_file",
		description: "파일 읽기",
		type: "gateway",
		tier: 1,
		source: "gateway",
		gatewaySkill: "read_file",
	},
	{
		name: "search_files",
		description: "파일 검색",
		type: "gateway",
		tier: 1,
		source: "gateway",
		gatewaySkill: "search_files",
	},
	{
		name: "list_files",
		description: "디렉토리 목록",
		type: "gateway",
		tier: 1,
		source: "gateway",
		gatewaySkill: "list_files",
	},
	{
		name: "code_review",
		description: "코드 리뷰",
		type: "gateway",
		tier: 1,
		source: "gateway",
		gatewaySkill: "code_review",
	},
	{
		name: "web_search",
		description: "웹 검색",
		type: "gateway",
		tier: 0,
		source: "gateway",
		gatewaySkill: "web_search",
	},
];

const MOCK_AUDIT_LOG = [
	{
		id: 1,
		timestamp: "2026-02-19T10:00:00Z",
		request_id: "r1",
		event_type: "tool_use",
		tool_name: "skill_time",
		tool_call_id: "tc1",
		tier: 0,
		success: true,
		payload: '{"args":{"timezone":"Asia/Seoul"}}',
	},
	{
		id: 2,
		timestamp: "2026-02-19T10:00:01Z",
		request_id: "r1",
		event_type: "tool_result",
		tool_name: "skill_time",
		tool_call_id: "tc1",
		tier: 0,
		success: true,
		payload: '{"output":"2026-02-19 19:00 KST"}',
	},
	{
		id: 3,
		timestamp: "2026-02-19T10:01:00Z",
		request_id: "r2",
		event_type: "tool_use",
		tool_name: "execute_command",
		tool_call_id: "tc2",
		tier: 2,
		success: true,
		payload: '{"args":{"command":"ls"}}',
	},
	{
		id: 4,
		timestamp: "2026-02-19T10:01:02Z",
		request_id: "r2",
		event_type: "tool_result",
		tool_name: "execute_command",
		tool_call_id: "tc2",
		tier: 2,
		success: true,
		payload: '{"output":"file1.txt\\nfile2.txt"}',
	},
	{
		id: 5,
		timestamp: "2026-02-19T10:02:00Z",
		request_id: "r3",
		event_type: "usage",
		tool_name: null,
		tool_call_id: null,
		tier: null,
		success: null,
		payload: '{"cost":0.003,"inputTokens":150,"outputTokens":80}',
	},
];

const MOCK_AUDIT_STATS = {
	total_events: 5,
	by_event_type: [
		["tool_use", 2],
		["tool_result", 2],
		["usage", 1],
	],
	by_tool_name: [
		["skill_time", 2],
		["execute_command", 2],
	],
	total_cost: 0.005,
};

const MOCK_CHANNELS_STATUS = {
	channels: [
		{
			name: "discord",
			status: "connected",
			account: "Naia#1234",
			lastActivity: "2026-02-19T10:00:00Z",
		},
	],
};

const MOCK_DIAGNOSTICS = {
	gateway: { status: "ok", port: 18789, uptime: "2h 15m" },
	agent: { status: "ok", pid: 12345, model: "gemini-2.5-flash" },
	memory: { status: "ok", dbSize: "2.1 MB", sessions: 15 },
	system: {
		os: "Naia OS (Bazzite)",
		kernel: "6.12.5",
		memory: "8.2 GB / 16 GB",
	},
};

// ---- Tauri IPC Mock (extended for demo) ----

function buildDemoMockScript(lang: NarrationLang): string {
	const mockData = DEMO_MOCK_DATA[lang];
	const mockResponses = DEMO_MOCK_RESPONSES[lang];
	const mockInputs = DEMO_INPUTS[lang];

	const mockAgentsList = {
		agents: [
			{
				id: "agent-1",
				name: "naia-main",
				status: "running",
				uptime: "2h 15m",
				model: "gemini-2.5-flash",
			},
		],
		sessions: [mockData.agentSession],
	};

	const skillsJson = JSON.stringify(MOCK_SKILLS);
	const auditLogJson = JSON.stringify(MOCK_AUDIT_LOG);
	const auditStatsJson = JSON.stringify(MOCK_AUDIT_STATS);
	const sessionsJson = JSON.stringify(mockData.sessions);
	const channelsJson = JSON.stringify(MOCK_CHANNELS_STATUS);
	const agentsJson = JSON.stringify(mockAgentsList);
	const diagnosticsJson = JSON.stringify(MOCK_DIAGNOSTICS);
	const factsJson = JSON.stringify(mockData.facts);
	const discordMsgsJson = JSON.stringify(mockData.discordMessages);
	const greetingJson = JSON.stringify(mockResponses.greeting);
	const weatherJson = JSON.stringify(mockResponses.weather);
	const timeJson = JSON.stringify(mockResponses.time);

	// Weather/time keywords per language for matching user input
	const weatherKeywords = JSON.stringify([
		"날씨",
		"weather",
		"天気",
		"天气",
		"météo",
		"wetter",
		"погод",
		"clima",
		"cuaca",
		"thời tiết",
		"طقس",
		"मौसम",
		"আবহাওয়া",
		"tempo",
	]);
	const timeKeywords = JSON.stringify([
		"시간",
		"몇 시",
		"time",
		"何時",
		"今何時",
		"几点",
		"heure",
		"uhr",
		"spät",
		"час",
		"hora",
		"jam",
		"giờ",
		"الساعة",
		"समय",
		"সময়",
		"কটা",
		"horas",
	]);

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

	window.__NAIA_E2E__ = { emitEvent: emitEvent };

	var tcCounter = 0;
	var weatherKws = ${weatherKeywords};
	var timeKws = ${timeKeywords};
	var greetingText = ${greetingJson};
	var weatherText = ${weatherJson};
	var timeText = ${timeJson};

	function buildTextResponse(requestId, text) {
		return [
			{ type: "text", requestId: requestId, text: text },
			{ type: "usage", requestId: requestId, inputTokens: 10, outputTokens: 20, cost: 0.001, model: "gemini-2.5-flash" },
			{ type: "finish", requestId: requestId },
		];
	}

	function buildToolResponse(requestId, toolName, args, output, followUpText) {
		var tcId = "tc-" + (++tcCounter);
		return [
			{ type: "tool_use", requestId: requestId, toolCallId: tcId, toolName: toolName, args: args },
			{ type: "tool_result", requestId: requestId, toolCallId: tcId, toolName: toolName, output: output, success: true },
			{ type: "text", requestId: requestId, text: followUpText },
			{ type: "usage", requestId: requestId, inputTokens: 30, outputTokens: 50, cost: 0.002, model: "gemini-2.5-flash" },
			{ type: "finish", requestId: requestId },
		];
	}

	function matchesAny(msg, keywords) {
		for (var i = 0; i < keywords.length; i++) {
			if (msg.indexOf(keywords[i].toLowerCase()) !== -1) return true;
		}
		return false;
	}

	function getResponseChunks(requestId, userMessage) {
		var msg = (userMessage || "").toLowerCase();

		if (matchesAny(msg, weatherKws)) {
			return buildToolResponse(requestId, "skill_weather",
				{ location: "Seoul" },
				JSON.stringify({ location: "Seoul", temperature: "3°C", condition: "Clear", humidity: "45%" }),
				weatherText);
		}
		if (matchesAny(msg, timeKws)) {
			return buildToolResponse(requestId, "skill_time",
				{ timezone: "Asia/Seoul" },
				"2026-02-19 19:00 KST (Wednesday)",
				timeText);
		}
		return buildTextResponse(requestId, greetingText);
	}

	function getToolRequestChunks(requestId, toolName) {
		if (toolName === "skill_agents" || toolName === "list_agents") {
			return [
				{ type: "tool_result", requestId: requestId, success: true, output: JSON.stringify({ agents: mockAgents.agents }) },
				{ type: "finish", requestId: requestId },
			];
		}
		if (toolName === "skill_sessions" || toolName === "list_sessions") {
			return [
				{ type: "tool_result", requestId: requestId, success: true, output: JSON.stringify({ sessions: mockAgents.sessions }) },
				{ type: "finish", requestId: requestId },
			];
		}
		if (toolName === "skill_diagnostics" || toolName === "diagnostics") {
			return [
				{ type: "tool_result", requestId: requestId, success: true, output: JSON.stringify(mockDiagnostics) },
				{ type: "finish", requestId: requestId },
			];
		}
		return [
			{ type: "tool_result", requestId: requestId, success: true, output: "{}" },
			{ type: "finish", requestId: requestId },
		];
	}

	var mockSkills = ${skillsJson};
	var mockAuditLog = ${auditLogJson};
	var mockAuditStats = ${auditStatsJson};
	var mockSessions = ${sessionsJson};
	var mockChannels = ${channelsJson};
	var mockAgents = ${agentsJson};
	var mockDiagnostics = ${diagnosticsJson};
	var mockFacts = ${factsJson};
	var mockDiscordMsgs = ${discordMsgsJson};

	// Mock Discord API fetch (window.fetch override)
	var originalFetch = window.fetch;
	window.fetch = function(url, opts) {
		var urlStr = typeof url === "string" ? url : url.toString();
		if (urlStr.indexOf("discord.com/api") !== -1) {
			if (urlStr.indexOf("/messages") !== -1) {
				return Promise.resolve(new Response(JSON.stringify(mockDiscordMsgs),
					{ status: 200, headers: { "Content-Type": "application/json" } }));
			}
			return Promise.resolve(new Response("{}",
				{ status: 200, headers: { "Content-Type": "application/json" } }));
		}
		return originalFetch.apply(window, arguments);
	};

	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		if (cmd === "plugin:event|listen") {
			if (!eventListeners.has(args.event)) eventListeners.set(args.event, []);
			eventListeners.get(args.event).push(args.handler);
			return args.handler;
		}
		if (cmd === "plugin:event|emit") { emitEvent(args.event, args.payload); return null; }
		if (cmd === "plugin:event|unlisten") return;

		if (cmd === "send_to_agent_command") {
			var request = JSON.parse(args.message);
			var requestId = request.requestId;

			// Handle tool_request (directToolCall)
			if (request.type === "tool_request") {
				var toolChunks = getToolRequestChunks(requestId, request.toolName);
				setTimeout(function() { emitEvent("agent_response", JSON.stringify(toolChunks[0])); }, 100);
				setTimeout(function() { emitEvent("agent_response", JSON.stringify(toolChunks[1])); }, 200);
				return;
			}

			// Regular chat message
			var lastMsg = request.messages[request.messages.length - 1];
			var chunks = getResponseChunks(requestId, lastMsg.content);
			var delay = 300;
			for (var i = 0; i < chunks.length; i++) {
				(function(chunk, d) {
					setTimeout(function() { emitEvent("agent_response", JSON.stringify(chunk)); }, d);
				})(chunks[i], delay);
				delay += 300;
			}
			return;
		}

		if (cmd === "send_approval_response") return;
		if (cmd === "cancel_stream") return;
		if (cmd === "reset_window_state") return;

		// Skills
		if (cmd === "list_skills") return mockSkills;

		// Audit / Progress
		if (cmd === "get_audit_log") return mockAuditLog;
		if (cmd === "get_audit_stats") return mockAuditStats;
		if (cmd === "get_progress_data") return { events: mockAuditLog, stats: mockAuditStats };

		// Memory / History
		if (cmd === "memory_get_sessions" || cmd === "memory_get_sessions_with_count") return mockSessions;
		if (cmd === "memory_get_last_session") return mockSessions[0] || null;
		if (cmd === "memory_create_session") return args.id;
		if (cmd === "memory_get_messages") return [];
		if (cmd === "memory_save_message") return;
		if (cmd === "memory_delete_session") return;
		if (cmd === "memory_update_title") return;
		if (cmd === "memory_update_summary") return;
		if (cmd === "memory_search") return [];
		if (cmd === "memory_search_fts") return [];
		if (cmd === "memory_get_all_facts") return mockFacts;
		if (cmd === "memory_upsert_fact") return;
		if (cmd === "memory_delete_fact") return;

		// API key validation
		if (cmd === "validate_api_key") return { valid: true };

		// directToolCall — for Channels/Agents/Diagnostics tabs (legacy IPC path)
		if (cmd === "tool_request") {
			var toolArgs = args;
			if (toolArgs.tool === "skill_sessions" || toolArgs.tool === "list_sessions") {
				return JSON.stringify(mockAgents.sessions);
			}
			if (toolArgs.tool === "skill_agents" || toolArgs.tool === "list_agents") {
				return JSON.stringify(mockAgents.agents);
			}
			if (toolArgs.tool === "skill_diagnostics" || toolArgs.tool === "diagnostics") {
				return JSON.stringify(mockDiagnostics);
			}
			return JSON.stringify({});
		}

		// Discord
		if (cmd === "discord_bot_token_available") return true;
		if (cmd === "discord_api") return JSON.stringify({ status: "ok" });

		// OpenClaw sync
		if (cmd === "sync_openclaw_config") return undefined;

		// Gateway status (channels/agents/diagnostics fetch via direct IPC)
		if (cmd === "get_channels_status") return mockChannels;
		if (cmd === "get_agents_status") return mockAgents;
		if (cmd === "get_diagnostics") return mockDiagnostics;

		return undefined;
	};
})();
`;
}

function makeConfig(locale: NarrationLang = "ko") {
	const inputs = DEMO_INPUTS[locale];
	return {
		provider: "gemini",
		model: "gemini-2.5-flash",
		apiKey: MOCK_API_KEY,
		agentName: inputs.agentName,
		userName: inputs.userName,
		vrmModel: "/avatars/01-Sendagaya-Shino-uniform.vrm",
		persona: "Friendly AI companion",
		enableTools: true,
		locale,
		onboardingComplete: true,
		gatewayUrl: "ws://localhost:18789",
		gatewayToken: "mock-token",
		discordDmChannelId: "mock-dm-channel-123",
		discordDefaultUserId: "mock-user-456",
	};
}

// ---- Scene Timeline Logger ----

interface SceneLog {
	id: string;
	startMs: number;
	endMs: number;
	notes: string;
}

class SceneTimeline {
	private t0 = Date.now();
	private logs: SceneLog[] = [];
	private currentScene: { id: string; startMs: number } | null = null;

	/** Mark the start of a new scene */
	enter(id: string, notes = "") {
		this.endCurrent();
		const startMs = Date.now() - this.t0;
		this.currentScene = { id, startMs };
		console.log(
			`[timeline] ${this.fmt(startMs)} ENTER  ${id}${notes ? ` — ${notes}` : ""}`,
		);
	}

	/** Mark a point-in-time event within the current scene */
	mark(label: string) {
		const ms = Date.now() - this.t0;
		console.log(`[timeline] ${this.fmt(ms)}   ├─ ${label}`);
	}

	/** End the current scene */
	private endCurrent() {
		if (this.currentScene) {
			const endMs = Date.now() - this.t0;
			this.logs.push({ ...this.currentScene, endMs, notes: "" });
			console.log(
				`[timeline] ${this.fmt(endMs)} EXIT   ${this.currentScene.id}  (${endMs - this.currentScene.startMs}ms)`,
			);
			this.currentScene = null;
		}
	}

	/** Finalize and save the timeline JSON */
	save(filepath: string) {
		this.endCurrent();
		const totalMs = Date.now() - this.t0;
		console.log(`[timeline] Total recording: ${this.fmt(totalMs)}`);
		const output = {
			totalMs,
			scenes: this.logs,
		};
		fs.writeFileSync(filepath, JSON.stringify(output, null, 2));
		console.log(`[timeline] Saved to: ${filepath}`);
	}

	private fmt(ms: number): string {
		const sec = Math.floor(ms / 1000);
		const m = Math.floor(sec / 60);
		const s = sec % 60;
		const frac = Math.floor((ms % 1000) / 10);
		return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(frac).padStart(2, "0")}`;
	}
}

// ---- Helpers ----

/** Wait for all fonts and icons to load */
async function ensureIconsLoaded(page: Page) {
	await page.waitForLoadState("networkidle");
	await page.evaluate(async () => {
		await document.fonts.ready;
	});
	await page.waitForTimeout(4000);
}

/** Get scene duration by id */
function sceneDuration(id: string): number {
	return (DEMO_SCENES.find((s) => s.id === id)?.duration ?? 5) * 1000;
}

/** Click a tab by nth-child index (1-based) */
async function clickTabByIndex(page: Page, index: number) {
	const tab = page.locator(`.chat-tab:nth-child(${index})`);
	await expect(tab).toBeVisible({ timeout: 5_000 });
	await tab.click();
}

/** Type text with realistic delays for demo effect */
async function typeSlowly(page: Page, selector: string, text: string) {
	const el = page.locator(selector);
	await expect(el).toBeVisible({ timeout: 5_000 });
	await el.click();
	for (const char of text) {
		await page.keyboard.type(char, { delay: 80 + Math.random() * 40 });
	}
}

/** Send chat message and wait for response */
async function sendChatMessage(page: Page, text: string) {
	const beforeCount = await page.locator(".chat-message.assistant").count();
	const input = page.locator(".chat-input");
	await expect(input).toBeEnabled({ timeout: 5_000 });
	await typeSlowly(page, ".chat-input", text);
	await page.waitForTimeout(500);
	await input.press("Enter");

	await Promise.race([
		expect(page.locator(".cursor-blink").first())
			.toBeVisible({ timeout: 10_000 })
			.catch(() => {}),
		expect(page.locator(".chat-message.assistant"))
			.toHaveCount(beforeCount + 1, { timeout: 10_000 })
			.catch(() => {}),
	]);
	await expect(page.locator(".cursor-blink")).toBeHidden({ timeout: 15_000 });
}

// ---- Test Configuration ----

const inputs = DEMO_INPUTS[DEMO_LANG];
const sectionLabels = DEMO_SECTION_LABELS[DEMO_LANG];

test.setTimeout(300_000); // 5 minutes max
test.use({
	viewport: VIEWPORT,
	video: { mode: "on", size: VIEWPORT },
	deviceScaleFactor: 2,
});

// SKIPPED: 3-minute demo video walks the old onboarding UI (provider cards),
// which has been replaced. Re-enable after the demo script is updated for the
// agentName-first wizard. Run manually with `pnpm test:e2e -- demo-video.spec.ts`
// when the demo flow is rewritten.
test.describe.skip("Demo Video Recording", () => {
	test(`full 3-minute demo [${DEMO_LANG}]`, async ({ page }, testInfo) => {
		fs.mkdirSync(LANG_OUTPUT_DIR, { recursive: true });
		const tl = new SceneTimeline();

		// ══════════════════════════════════════════════
		// Phase 1: Onboarding
		// ══════════════════════════════════════════════

		tl.enter("init", `page setup + mock injection [${DEMO_LANG}]`);
		await page.addInitScript(buildDemoMockScript(DEMO_LANG));
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
		await page.addInitScript({ content: SEED_ADK_PATH });
		await page.addInitScript((loc: string) => {
			localStorage.setItem("naia-config", JSON.stringify({ locale: loc }));
		}, DEMO_LANG);

		await page.goto("/");
		tl.mark("page loaded");
		const overlay = page.locator(".onboarding-panel");
		await expect(overlay).toBeVisible({ timeout: 15_000 });
		tl.mark("onboarding overlay visible");
		await ensureIconsLoaded(page);
		tl.mark("icons loaded");

		// Scene: intro
		tl.enter("intro", "onboarding first screen");
		await page.waitForTimeout(sceneDuration("intro"));

		// Scene: provider
		tl.enter("provider", "select Gemini");
		await expect(page.locator(".onboarding-content")).toBeVisible({
			timeout: 5_000,
		});
		await page.waitForTimeout(2000);
		const providerCard = page.locator(".onboarding-provider-card").first();
		if (await providerCard.isVisible()) {
			await providerCard.click();
			tl.mark("provider card clicked");
		}
		await page.waitForTimeout(1000);
		await page.locator(".onboarding-next-btn").click();
		tl.mark("next clicked");
		await page.waitForTimeout(sceneDuration("provider") - 3000);

		// Scene: apikey
		tl.enter("apikey", "type API key");
		await expect(page.locator(".onboarding-input")).toBeVisible({
			timeout: 5_000,
		});
		await typeSlowly(page, ".onboarding-input", "AIzaSyxxxxxxxxxxxxxxxx");
		tl.mark("key typed");
		await page.waitForTimeout(1000);
		await page.locator(".onboarding-next-btn").click();
		tl.mark("next clicked");
		await page.waitForTimeout(sceneDuration("apikey") - 4000);

		// Scene: agent-name
		tl.enter("agent-name", `type ${inputs.agentName}`);
		const agentInput = page.locator(".onboarding-input");
		await expect(agentInput).toBeVisible({ timeout: 5_000 });
		await typeSlowly(page, ".onboarding-input", inputs.agentName);
		tl.mark("name typed");
		await page.waitForTimeout(1000);
		await page.locator(".onboarding-next-btn").click();
		tl.mark("next clicked");
		await page.waitForTimeout(sceneDuration("agent-name") - 3000);

		// Scene: user-name
		tl.enter("user-name", `type ${inputs.userName}`);
		const userInput = page.locator(".onboarding-input");
		await expect(userInput).toBeVisible({ timeout: 5_000 });
		await typeSlowly(page, ".onboarding-input", inputs.userName);
		tl.mark("name typed");
		await page.waitForTimeout(1000);
		await page.locator(".onboarding-next-btn").click();
		tl.mark("next clicked");
		await page.waitForTimeout(sceneDuration("user-name") - 3000);

		// Scene: character
		tl.enter("character", "VRM selection");
		const vrmCard = page.locator(".onboarding-vrm-card");
		await expect(vrmCard.first()).toBeVisible({ timeout: 10_000 });
		tl.mark("vrm cards visible");
		await page.waitForTimeout(3000);
		await vrmCard.first().click();
		tl.mark("vrm selected");
		await page.waitForTimeout(1000);
		await page.locator(".onboarding-next-btn").click();
		tl.mark("next clicked");
		await page.waitForTimeout(sceneDuration("character") - 4000);

		// Scene: personality
		tl.enter("personality", "select personality");
		const personalityCard = page.locator(".onboarding-personality-card");
		await expect(personalityCard.first()).toBeVisible({ timeout: 5_000 });
		await page.waitForTimeout(2000);
		await personalityCard.first().click();
		tl.mark("personality selected");
		await page.waitForTimeout(1000);
		await page.locator(".onboarding-next-btn").click();
		tl.mark("next clicked");
		await page.waitForTimeout(sceneDuration("personality") - 3000);

		// Scene: messenger
		tl.enter("messenger", "skip messenger step");
		const messengerBtn = page.locator(".onboarding-next-btn");
		await expect(messengerBtn).toBeVisible({ timeout: 5_000 });
		await page.waitForTimeout(2000);
		await messengerBtn.click();
		tl.mark("next clicked");
		await page.waitForTimeout(sceneDuration("messenger") - 2000);

		// Scene: complete
		tl.enter("complete", "onboarding done");
		await page.waitForTimeout(sceneDuration("complete"));

		// ══════════════════════════════════════════════
		// Phase 2: Main App Tour
		// ══════════════════════════════════════════════

		tl.enter("reload", "reload with completed config");
		await page.addInitScript(buildDemoMockScript(DEMO_LANG));
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
		await page.addInitScript({ content: SEED_ADK_PATH });
		await page.addInitScript(
			(configJson: string) => {
				localStorage.setItem("naia-config", configJson);
			},
			JSON.stringify(makeConfig(DEMO_LANG)),
		);
		await page.goto("/");
		tl.mark("page reloaded");
		await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 15_000 });
		tl.mark("chat panel visible");
		await ensureIconsLoaded(page);
		tl.mark("icons loaded (phase 2)");

		// Scene: chat-hello
		tl.enter("chat-hello", `send "${inputs.chatHello}"`);
		await sendChatMessage(page, inputs.chatHello);
		tl.mark("response received");
		await page.waitForTimeout(sceneDuration("chat-hello") - 3000);

		// Scene: chat-response
		tl.enter("chat-response", "pause on response");
		await page.waitForTimeout(sceneDuration("chat-response"));

		// Scene: chat-weather
		tl.enter("chat-weather", `send "${inputs.chatWeather}"`);
		await sendChatMessage(page, inputs.chatWeather);
		tl.mark("weather response received");
		await page.waitForTimeout(sceneDuration("chat-weather") - 3000);

		// Scene: chat-tool-result
		tl.enter("chat-tool-result", "expand tool card");
		const toolHeader = page.locator(".tool-activity-header").first();
		if (await toolHeader.isVisible()) {
			await page.waitForTimeout(2000);
			await toolHeader.click();
			tl.mark("tool card expanded");
			await page.waitForTimeout(sceneDuration("chat-tool-result") - 2000);
		} else {
			tl.mark("tool card NOT visible — skipped");
			await page.waitForTimeout(sceneDuration("chat-tool-result"));
		}

		// Scene: chat-time
		tl.enter("chat-time", `send "${inputs.chatTime}"`);
		await sendChatMessage(page, inputs.chatTime);
		tl.mark("time response received");
		await page.waitForTimeout(sceneDuration("chat-time") - 3000);

		// Scene: history-tab
		tl.enter("history-tab", "navigate to history");
		await clickTabByIndex(page, 2);
		tl.mark("tab clicked");
		await page.waitForTimeout(sceneDuration("history-tab"));

		// Scene: skills-list
		tl.enter("skills-list", "navigate to skills");
		await clickTabByIndex(page, 4);
		tl.mark("tab clicked");
		await page.waitForTimeout(sceneDuration("skills-list"));

		// Scene: skills-detail
		tl.enter("skills-detail", "expand skill card");
		const skillCard = page.locator(".skill-card").first();
		if (await skillCard.isVisible()) {
			const header = skillCard.locator(".skill-card-header");
			if (await header.isVisible()) {
				await header.click();
				tl.mark("skill card expanded");
				await page.waitForTimeout(sceneDuration("skills-detail") - 1000);
				await header.click();
				tl.mark("skill card collapsed");
				await page.waitForTimeout(1000);
			} else {
				tl.mark("skill header NOT visible");
				await page.waitForTimeout(sceneDuration("skills-detail"));
			}
		} else {
			tl.mark("skill card NOT visible");
			await page.waitForTimeout(sceneDuration("skills-detail"));
		}

		// Scene: channels-tab
		tl.enter("channels-tab", "navigate to channels");
		await clickTabByIndex(page, 5);
		tl.mark("tab clicked");
		await page.waitForTimeout(sceneDuration("channels-tab"));

		// Scene: agents-tab
		tl.enter("agents-tab", "navigate to agents");
		await clickTabByIndex(page, 6);
		tl.mark("tab clicked");
		await page.waitForTimeout(sceneDuration("agents-tab"));

		// Scene: diagnostics-tab
		tl.enter("diagnostics-tab", "navigate to diagnostics");
		await clickTabByIndex(page, 7);
		tl.mark("tab clicked");
		await page.waitForTimeout(sceneDuration("diagnostics-tab"));

		// Scene: settings-ai
		tl.enter("settings-ai", "navigate to settings");
		await clickTabByIndex(page, 8);
		tl.mark("tab clicked");
		await page.waitForTimeout(sceneDuration("settings-ai"));

		// Scene: settings-voice
		tl.enter("settings-voice", "scroll to voice section");
		const voiceLabel = sectionLabels.voice;
		await page.evaluate((label: string) => {
			const dividers = document.querySelectorAll(".settings-section-divider");
			for (const d of dividers) {
				if (d.textContent?.includes(label)) {
					d.scrollIntoView({ behavior: "smooth", block: "start" });
					break;
				}
			}
		}, voiceLabel);
		tl.mark("scrolled to voice");
		await page.waitForTimeout(sceneDuration("settings-voice"));

		// Scene: settings-memory
		tl.enter("settings-memory", "scroll to memory section");
		const memoryLabel = sectionLabels.memory;
		await page.evaluate((label: string) => {
			const dividers = document.querySelectorAll(".settings-section-divider");
			for (const d of dividers) {
				if (d.textContent?.includes(label)) {
					d.scrollIntoView({ behavior: "smooth", block: "start" });
					break;
				}
			}
		}, memoryLabel);
		tl.mark("scrolled to memory");
		await page.waitForTimeout(sceneDuration("settings-memory"));

		// Scene: progress-tab
		tl.enter("progress-tab", "navigate to progress");
		await clickTabByIndex(page, 3);
		tl.mark("tab clicked");
		await page.waitForTimeout(sceneDuration("progress-tab"));

		// Scene: outro
		tl.enter("outro", "back to chat, closing");
		await clickTabByIndex(page, 1);
		tl.mark("back on chat tab");
		await page.waitForTimeout(sceneDuration("outro"));

		// ── Save timeline + video ──
		tl.save(path.join(LANG_OUTPUT_DIR, "timeline.json"));

		const video = page.video();
		if (video) {
			const dest = path.join(LANG_OUTPUT_DIR, "demo-raw.webm");
			await page.close();
			await video.saveAs(dest);
			console.log(`[demo] Video saved to: ${dest}`);
		}
	});
});
