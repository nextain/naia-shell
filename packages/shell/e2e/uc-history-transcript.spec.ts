import { expect, test } from "@playwright/test";
import { SEED_ADK_PATH, TAURI_BASE_MOCK_FALLBACK } from "./helpers/tauri-base-mock";

/**
 * S05 (sessions 관리 — 대화 transcript 영속/로드) UC E2E. 실 셸 UI(ChatPanel 탭 → HistoryTab →
 * conversation-store → Rust IPC)를 자동 구동해 "History 탭 = 로컬 transcript 목록/복원/삭제"가 끝까지 manifest 되는지 판정.
 *
 * 직교(UC ⊥ gRPC naia-agent): Tauri IPC(list/read/delete_conversation)만 mock — 실 agent/gRPC/Rust 불요(헤르메틱).
 *   → agent 부재여도 동작(E1, brain-body-environment)을 e2e 로도 증명. UC(History UI 행동)를 transport 와 분리해 고정.
 * 계약: conversation-store.ts(getAdkPath + invoke) ↔ Rust list_conversations({adkPath}) / read_conversation({adkPath,sessionId}) / delete_conversation.
 */

type Page = import("@playwright/test").Page;

const SESSIONS = [
	{ key: "chat-2", label: "날씨 어때", messageCount: 2, createdAt: 2000, updatedAt: 2001 },
	{ key: "chat-1", label: "안녕 반가워", messageCount: 4, createdAt: 1000, updatedAt: 1500 },
];
const TRANSCRIPT_CHAT1 = [
	JSON.stringify({ role: "user", content: "안녕 반가워", timestamp: 1000 }),
	JSON.stringify({ role: "assistant", content: "저도 반가워요 루크", timestamp: 1001 }),
].join("\n");

const FLAGS = `window.__NAIA_NEW_CORE__ = true; window.__E2E_OUTBOUND__ = []; window.__E2E_DELETED__ = [];`;

// IPC mock: list_conversations → {sessions} JSON 문자열(conversation-store 가 JSON.parse), read_conversation → JSONL,
// delete_conversation → null(성공) + 호출 sessionId 기록. 그 외 cmd 는 undefined → TAURI_BASE_MOCK_FALLBACK.
const MOCK_SCRIPT = `
(function () {
  window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
  window.__TAURI_INTERNALS__.metadata = { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } };
  var callbacks = new Map(); var nextCbId = 1;
  window.__TAURI_INTERNALS__.transformCallback = function (fn, once) { var id = nextCbId++; callbacks.set(id, function (data) { if (once) callbacks.delete(id); return fn && fn(data); }); return id; };
  window.__TAURI_INTERNALS__.unregisterCallback = function (id) { callbacks.delete(id); };
  window.__TAURI_INTERNALS__.runCallback = function (id, data) { var cb = callbacks.get(id); if (cb) cb(data); };
  var eventListeners = new Map();
  window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function () {};
  function emitEvent(event, payload) { var hs = eventListeners.get(event) || []; for (var i = 0; i < hs.length; i++) window.__TAURI_INTERNALS__.runCallback(hs[i], { event: event, payload: payload }); }
  window.__TAURI_INTERNALS__.convertFileSrc = function (p, proto) { return (proto || "asset") + "://localhost/" + encodeURIComponent(p); };

  var SESSIONS_JSON = ${JSON.stringify(JSON.stringify({ sessions: SESSIONS }))};
  var TRANSCRIPT = ${JSON.stringify(TRANSCRIPT_CHAT1)};

  window.__TAURI_INTERNALS__.invoke = async function (cmd, args) {
    if (cmd === "plugin:event|listen") { if (!eventListeners.has(args.event)) eventListeners.set(args.event, []); eventListeners.get(args.event).push(args.handler); return args.handler; }
    if (cmd === "plugin:event|emit") { emitEvent(args.event, args.payload); return null; }
    if (cmd === "plugin:event|unlisten") return;
    if (cmd === "list_conversations") return SESSIONS_JSON;
    if (cmd === "read_conversation") return (args && args.sessionId === "chat-1") ? TRANSCRIPT : "";
    if (cmd === "delete_conversation") { window.__E2E_DELETED__.push(args && args.sessionId); return null; }
    return undefined;
  };
})();
`;

function configScript(cfg: Record<string, unknown>): string {
	return `localStorage.setItem("naia-config", ${JSON.stringify(JSON.stringify(cfg))});`;
}

async function boot(page: Page) {
	await page.addInitScript(FLAGS);
	await page.addInitScript({ content: MOCK_SCRIPT });
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_ADK_PATH });
	await page.addInitScript({
		content: configScript({ provider: "gemini", model: "gemini-2.5-flash", apiKey: "e2e-mock-key", enableTools: false, locale: "ko", onboardingComplete: true }),
	});
	await page.goto("/");
	await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });
}

const openHistory = (page: Page) => page.locator(".chat-tab", { hasText: "🕘" });

test.describe("S05 — 대화 transcript History (list/restore/delete · IPC mock = UC⊥gRPC agent)", () => {
	test("History 탭 → list_conversations 세션 목록 렌더(updatedAt desc)", async ({ page }) => {
		await boot(page);
		await openHistory(page).click();
		await expect(page.locator(".history-item")).toHaveCount(2, { timeout: 10_000 });
		// 정렬: chat-2(updatedAt 2001) 먼저
		await expect(page.locator(".history-item-title").first()).toContainText("날씨 어때");
		await expect(page.locator(".history-item-title").nth(1)).toContainText("안녕 반가워");
	});

	test("세션 클릭 → read_conversation 복원 + chat 탭 전환(E1: agent 불요)", async ({ page }) => {
		await boot(page);
		await openHistory(page).click();
		await page.locator(".history-item-main", { hasText: "안녕 반가워" }).click();
		// 복원된 메시지가 chat 에 렌더(setMessages + chat 탭 전환)
		await expect(page.locator(".chat-message", { hasText: "안녕 반가워" })).toBeVisible({ timeout: 10_000 });
		await expect(page.locator(".chat-message", { hasText: "저도 반가워요 루크" })).toBeVisible();
		await expect(page.locator(".chat-input")).toBeVisible();
	});

	test("삭제 → delete_conversation 호출 + 목록에서 제거", async ({ page }) => {
		await boot(page);
		page.on("dialog", (d) => d.accept()); // window.confirm 수락
		await openHistory(page).click();
		await expect(page.locator(".history-item")).toHaveCount(2);
		await page.locator(".history-item").first().locator(".history-delete-btn").click();
		await expect(page.locator(".history-item")).toHaveCount(1, { timeout: 10_000 });
		const deleted = await page.evaluate(() => (window as unknown as { __E2E_DELETED__: string[] }).__E2E_DELETED__);
		expect(deleted).toContain("chat-2");
	});
});
