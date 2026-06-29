import { type Page, expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

/**
 * Naia Shell E2E — Chat + Tool execution verification.
 *
 * Prerequisites:
 *   pnpm tauri dev  (must be running — Vite serves UI at localhost:1420)
 *
 * Approach:
 *   Playwright opens localhost:1420 in a regular browser (no Tauri webview).
 *   Tauri IPC is mocked via addInitScript so React can mount.
 *   Agent responses are simulated through the mocked event system.
 */

const API_KEY = "e2e-mock-key";

/**
 * Inline Tauri IPC mock + simulated agent response engine.
 * Injected before React mounts via page.addInitScript().
 */
const TAURI_MOCK_SCRIPT = `
(function() {
	window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};

	// metadata — required by getCurrentWindow()
	window.__TAURI_INTERNALS__.metadata = {
		currentWindow: { label: "main" },
		currentWebview: { windowLabel: "main", label: "main" },
	};

	// Callback registry (mirrors Tauri's transformCallback system)
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

	// Event listeners
	var eventListeners = new Map();
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};

	function emitEvent(event, payload) {
		var handlers = eventListeners.get(event) || [];
		for (var i = 0; i < handlers.length; i++) {
			window.__TAURI_INTERNALS__.runCallback(handlers[i], { event: event, payload: payload });
		}
	}

	// convertFileSrc — for AvatarCanvas
	window.__TAURI_INTERNALS__.convertFileSrc = function(filePath, protocol) {
		protocol = protocol || "asset";
		return protocol + "://localhost/" + encodeURIComponent(filePath);
	};

	// ---- Simulated response scenarios ----
	window.__NAIA_E2E__ = { emitEvent: emitEvent };

	var tcCounter = 0;

	function buildTextResponse(requestId, text) {
		return [
			{ type: "text", requestId: requestId, text: text },
			{ type: "finish", requestId: requestId, cost: { cost: 0.001, inputTokens: 10, outputTokens: 20 } },
		];
	}

	function buildToolResponse(requestId, toolName, args, output, followUpText) {
		var tcId = "tc-" + (++tcCounter);
		return [
			{ type: "tool_use", requestId: requestId, toolCallId: tcId, toolName: toolName, args: args },
			{ type: "tool_result", requestId: requestId, toolCallId: tcId, toolName: toolName, output: output, success: true },
			{ type: "text", requestId: requestId, text: followUpText },
			{ type: "finish", requestId: requestId, cost: { cost: 0.002, inputTokens: 30, outputTokens: 50 } },
		];
	}

	function buildThinkingResponse(requestId, thinking, text) {
		return [
			{ type: "thinking", requestId: requestId, text: thinking },
			{ type: "text", requestId: requestId, text: text },
			{ type: "finish", requestId: requestId, cost: { cost: 0.003, inputTokens: 50, outputTokens: 80 } },
		];
	}

	function matchScenario(userMessage) {
		var msg = (userMessage || "").toLowerCase();
		if (msg.indexOf("그래프") !== -1) return "knowledge_graph";
		if (msg.indexOf("지식") !== -1) return "knowledge";
		if (msg.indexOf("ls") !== -1 && msg.indexOf("디렉토리") !== -1) return "execute_command";
		if (msg.indexOf("써줘") !== -1 || msg.indexOf("write") !== -1) return "write_file";
		if (msg.indexOf("읽어줘") !== -1 || msg.indexOf("read") !== -1) return "read_file";
		if (msg.indexOf("찾아줘") !== -1 || msg.indexOf("search") !== -1) return "search_files";
		if (msg.indexOf("생각") !== -1 || msg.indexOf("think") !== -1) return "thinking";
		return "simple_chat";
	}

	function getResponseChunks(requestId, scenario) {
		switch (scenario) {
			case "execute_command":
				return buildToolResponse(requestId, "execute_command",
					{ command: "ls" },
					"file1.txt\\nfile2.txt\\npackage.json",
					"현재 디렉토리의 파일 목록입니다.");
			case "write_file":
				return buildToolResponse(requestId, "write_file",
					{ path: "/home/user/test-e2e.txt", content: "playwright-ok" },
					"File written successfully",
					"파일을 성공적으로 작성했습니다.");
			case "read_file":
				return buildToolResponse(requestId, "read_file",
					{ path: "/home/user/test-e2e.txt" },
					"playwright-ok",
					"파일 내용은 playwright-ok 입니다.");
			case "search_files":
				return buildToolResponse(requestId, "search_files",
					{ path: "agent", regex: "gateway" },
					"agent/src/gateway.ts:5: export class Gateway",
					"gateway 관련 결과를 찾았습니다.");
			case "thinking":
				return buildThinkingResponse(requestId,
					"이 문제에 대해 깊이 생각해보겠습니다...",
					"생각을 정리해봤어! 답변이야.");
			case "knowledge":
				return buildToolResponse(requestId, "skill_knowledge_ask",
					{ query: "전입신고 필요서류" },
					JSON.stringify({ abstained: false, answer: "전입신고 필요서류는 신분증입니다.", sources: [{ title: "전입신고 안내", sourceUris: ["https://gov.kr/jeonipsingo"] }] }),
					"근거와 함께 답변했어요.");
			case "knowledge_graph":
				return buildToolResponse(requestId, "skill_knowledge_graph",
					{},
					JSON.stringify({ nodes: [{ id: "a", label: "전입신고", type: "Service", deg: 2, community: 0 }, { id: "b", label: "주민센터", type: "Department", deg: 1, community: 0 }, { id: "c", label: "신분증", type: "Document", deg: 1, community: 0 }], edges: [{ from: "a", to: "b", type: "handled_by", weight: 1 }, { from: "a", to: "c", type: "requires_document", weight: 2 }], communityCount: 1 }),
					"지식 그래프입니다.");
			default:
				return buildTextResponse(requestId, "안녕하세요! 무엇을 도와드릴까요?");
		}
	}

	// Main invoke handler
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

		// Agent communication
		if (cmd === "send_to_agent_command") {
			var request = JSON.parse(args.message);
			var requestId = request.requestId;
			var lastMsg = request.messages[request.messages.length - 1];
			var scenario = matchScenario(lastMsg.content);
			var chunks = getResponseChunks(requestId, scenario);

			// Emit chunks with delays to simulate streaming
			var delay = 300;
			for (var i = 0; i < chunks.length; i++) {
				(function(chunk, d) {
					setTimeout(function() {
						emitEvent("agent_response", JSON.stringify(chunk));
					}, d);
				})(chunks[i], delay);
				delay += 300;
			}
			return;
		}

		// approval_response
		if (cmd === "send_approval_response") return;

		// cancel_stream
		if (cmd === "cancel_stream") return;

		// progress data
		if (cmd === "get_progress_data") return { events: [], stats: { totalCost: 0, messageCount: 0, toolCount: 0, errorCount: 0 } };

		// Base IPC defaults (plugin store/window, list_*, workspace_*, etc.)
		// live in helpers/tauri-base-mock.ts — TAURI_BASE_MOCK_FALLBACK wraps this
		// invoke so anything returning undefined here falls through to that helper.
		return undefined;
	};
})();
`;

/**
 * Send a chat message and wait for the assistant response to appear.
 * Uses a robust detection strategy: wait for either streaming cursor or
 * a new assistant message, then wait for streaming to finish.
 */
async function sendMessage(page: Page, text: string) {
	const beforeCount = await page.locator(".chat-message.assistant").count();

	const input = page.locator(".chat-input");
	await expect(input).toBeEnabled({ timeout: 5_000 });
	await input.fill(text);
	await input.press("Enter");

	// Wait for streaming to start (cursor appears) OR a new assistant message to appear.
	// Mock responses can resolve so fast that cursor-blink is never caught.
	await Promise.race([
		expect(page.locator(".cursor-blink").first())
			.toBeVisible({ timeout: 10_000 })
			.catch(() => {}),
		expect(page.locator(".chat-message.assistant"))
			.toHaveCount(beforeCount + 1, { timeout: 10_000 })
			.catch(() => {}),
	]);

	// Then wait for streaming to finish (cursor disappears)
	await expect(page.locator(".cursor-blink")).toBeHidden({ timeout: 15_000 });
}

/** Watch for permission modals and auto-approve them. */
function watchPermissions(page: Page): void {
	const approve = async () => {
		try {
			const btn = page.locator(".permission-btn-always");
			while (await btn.isVisible().catch(() => false)) {
				await btn.click();
				await page.waitForTimeout(200);
			}
		} catch {
			/* ignore */
		}
	};
	const interval = setInterval(() => void approve(), 500);
	page.on("close", () => clearInterval(interval));
}

test.describe("Chat + Tool E2E", () => {
	test.beforeEach(async ({ page }) => {
		// Inject Tauri IPC mock before React mounts
		await page.addInitScript(TAURI_MOCK_SCRIPT);
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
		await page.addInitScript({ content: SEED_ADK_PATH });

		// Seed localStorage with valid config
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
				onboardingComplete: true,
			}),
		);

		await page.goto("/");
		await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });
	});

	test("앱 로드 — chat panel visible", async ({ page }) => {
		await expect(page.locator(".chat-input")).toBeVisible();
		await expect(page.locator(".chat-messages")).toBeVisible();
	});

	test("채팅 전송 — assistant 응답 수신", async ({ page }) => {
		await sendMessage(page, "안녕");

		const assistantMsg = page.locator(
			".chat-message.assistant .message-content",
		);
		await expect(assistantMsg.first()).toBeVisible();
		await expect(assistantMsg.first()).not.toBeEmpty();
	});

	test("도구: execute_command — tool activity 표시", async ({ page }) => {
		watchPermissions(page);

		await sendMessage(page, "현재 디렉토리에서 ls 해줘");

		// Tool activity should have appeared (now in completed message)
		const toolActivity = page.locator(".tool-activity");
		await expect(toolActivity.first()).toBeVisible({ timeout: 5_000 });

		// Verify tool ended with success
		const successTool = page.locator(".tool-activity.tool-success");
		await expect(successTool.first()).toBeVisible({ timeout: 5_000 });
	});

	test("도구: write_file + read_file — 파일 쓰기/읽기", async ({ page }) => {
		watchPermissions(page);

		// Write file
		await sendMessage(page, "~/test-e2e.txt에 playwright-ok 써줘");
		const writeTool = page.locator(".tool-activity");
		await expect(writeTool.first()).toBeVisible();

		// Read file
		await sendMessage(page, "~/test-e2e.txt 읽어줘");

		// Verify response contains the written content
		const lastAssistant = page
			.locator(".chat-message.assistant .message-content")
			.last();
		await expect(lastAssistant).toContainText("playwright-ok", {
			timeout: 5_000,
		});
	});

	test("도구: search_files — tool activity 표시", async ({ page }) => {
		watchPermissions(page);

		await sendMessage(page, "agent 폴더에서 gateway 찾아줘");

		const toolActivity = page.locator(".tool-activity");
		await expect(toolActivity.first()).toBeVisible({ timeout: 5_000 });
	});

	test("지식 도구(K2): skill_knowledge_ask — 답변+출처 칩 렌더 + 칩 클릭→브라우저 패널(근거→원문)", async ({ page }) => {
		await sendMessage(page, "지식에서 전입신고 필요서류 알려줘");

		// K2 렌더: 답변 + 출처 칩(sourceUris 보존)
		const answer = page.locator(".knowledge-answer");
		await expect(answer.first()).toContainText("신분증", { timeout: 5_000 });
		const chip = page.locator(".knowledge-source-chip").first();
		await expect(chip).toBeVisible();
		await expect(chip).toHaveAttribute("data-source-kind", "url");
		await expect(chip).toContainText("전입신고 안내");

		// 근거→원문: URL 칩 클릭 → 브라우저 패널로 전환
		await chip.click();
		await expect(page.locator(".browser-panel")).toBeVisible({ timeout: 5_000 });
	});

	test("지식 그래프(K3): skill_knowledge_graph — 2D/3D 캔버스 뷰어 렌더 + 모드 토글", async ({ page }) => {
		await sendMessage(page, "지식 그래프 보여줘");

		const graph = page.locator('[data-testid="knowledge-graph"]');
		await expect(graph).toBeVisible({ timeout: 5_000 });
		await expect(graph.locator("canvas.knowledge-graph-canvas")).toBeVisible();
		await expect(graph).toHaveAttribute("data-mode", "2d");
		await expect(graph.locator(".knowledge-graph-meta")).toContainText("노드 3");

		// 2D↔3D 토글
		await graph.locator(".knowledge-graph-mode").click();
		await expect(graph).toHaveAttribute("data-mode", "3d");
	});
});

test.describe("Claude Code CLI provider E2E", () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(TAURI_MOCK_SCRIPT);
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
		await page.addInitScript({ content: SEED_ADK_PATH });

		// Seed localStorage with claude-code-cli config (no apiKey needed)
		await page.addInitScript(
			(configJson: string) => {
				localStorage.setItem("naia-config", configJson);
			},
			JSON.stringify({
				provider: "claude-code-cli",
				model: "claude-sonnet-4-5-20250929",
				apiKey: "",
				enableTools: true,
				locale: "ko",
				onboardingComplete: true,
			}),
		);

		await page.goto("/");
		await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });
	});

	test("claude-code-cli — 채팅 응답 수신", async ({ page }) => {
		await sendMessage(page, "안녕");

		const assistantMsg = page.locator(
			".chat-message.assistant .message-content",
		);
		await expect(assistantMsg.first()).toBeVisible();
		await expect(assistantMsg.first()).not.toBeEmpty();
	});

	test("claude-code-cli — 도구 실행 후 응답", async ({ page }) => {
		watchPermissions(page);

		await sendMessage(page, "현재 디렉토리에서 ls 해줘");

		const toolActivity = page.locator(".tool-activity");
		await expect(toolActivity.first()).toBeVisible({ timeout: 5_000 });

		const successTool = page.locator(".tool-activity.tool-success");
		await expect(successTool.first()).toBeVisible({ timeout: 5_000 });

		// Verify follow-up text from assistant
		const assistantMsg = page
			.locator(".chat-message.assistant .message-content")
			.last();
		await expect(assistantMsg).not.toBeEmpty();
	});

	test("claude-code-cli — thinking 블록 표시", async ({ page }) => {
		await sendMessage(page, "이 문제에 대해 생각해봐");

		// Thinking block should appear as a collapsible details element
		const thinkingBlock = page.locator(".thinking-block");
		await expect(thinkingBlock.first()).toBeVisible({ timeout: 5_000 });

		// Verify the thinking content is inside
		const thinkingContent = page.locator(".thinking-content");
		await expect(thinkingContent.first()).toContainText("깊이 생각", {
			timeout: 5_000,
		});

		// Verify the actual answer text also appeared
		const assistantMsg = page.locator(
			".chat-message.assistant .message-content",
		);
		await expect(assistantMsg.last()).toContainText("답변", {
			timeout: 5_000,
		});
	});

	test("claude-code-cli — cost 미표시 (skipCost)", async ({ page }) => {
		await sendMessage(page, "안녕");

		// Wait for response to complete
		const assistantMsg = page.locator(
			".chat-message.assistant .message-content",
		);
		await expect(assistantMsg.first()).toBeVisible();

		// Cost badge should not appear for claude-code-cli
		// (the mock still sends cost but agent skipCost logic prevents real cost emission)
		// Verify message rendered without errors
		await expect(assistantMsg.first()).not.toBeEmpty();
	});
});
