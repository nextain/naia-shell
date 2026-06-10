import { expect, test } from "@playwright/test";
import { SEED_ADK_PATH, TAURI_BASE_MOCK_FALLBACK } from "./helpers/tauri-base-mock";

/**
 * UC1 변종 통합 E2E — 새 hexagonal core 가 *이미 구현한* chat-turn 변종 전 표면을 실 UI 자동구동으로 고정.
 * (thinking / 도구 tool_use+tool_result / 멀티턴 history / 취소 cancel_stream / 에러)
 *
 * ⚠️ 범위: 새 core 에 실재하는 시나리오만. UC2 음성·UC3 기억 등은 아직 새 core 미배선(backlog,
 *   assembly-matrix) → 통과 테스트를 쓰면 vapor 테스트가 되므로 제외(uc-backlog-pending.spec 에 fixme 로 표식).
 *
 * 모든 mock 응답은 new-naia-agent protocol.encodeEmit 와 동일 바이트(type/requestId/toolName/output/...).
 * window.__NAIA_NEW_CORE__=true 로 새 경로 강제. 실 LLM/agent/rust 불요(헤르메틱).
 */

const NEW_CORE_FLAG = `window.__NAIA_NEW_CORE__ = true; window.__E2E_OUTBOUND__ = []; window.__E2E_CANCELLED__ = [];`;

const MOCK_SCRIPT = `
(function () {
  window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
  window.__TAURI_INTERNALS__.metadata = { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } };
  var callbacks = new Map(); var nextCbId = 1;
  window.__TAURI_INTERNALS__.transformCallback = function (fn, once) { var id = nextCbId++; callbacks.set(id, function (d) { if (once) callbacks.delete(id); return fn && fn(d); }); return id; };
  window.__TAURI_INTERNALS__.unregisterCallback = function (id) { callbacks.delete(id); };
  window.__TAURI_INTERNALS__.runCallback = function (id, d) { var cb = callbacks.get(id); if (cb) cb(d); };
  var eventListeners = new Map();
  window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function () {};
  function emitEvent(event, payload) { var hs = eventListeners.get(event) || []; for (var i = 0; i < hs.length; i++) window.__TAURI_INTERNALS__.runCallback(hs[i], { event: event, payload: payload }); }
  window.__TAURI_INTERNALS__.convertFileSrc = function (p, proto) { return (proto || "asset") + "://localhost/" + encodeURIComponent(p); };
  window.__NAIA_E2E__ = { emitEvent: emitEvent };

  var tc = 0;
  function emitSeq(rid, chunks, step) {
    var d = step || 120;
    for (var i = 0; i < chunks.length; i++) (function (c, ms) { setTimeout(function () { emitEvent("agent_response", JSON.stringify(c)); }, ms); })(chunks[i], d), (d += step || 120);
  }
  function scenarioFor(msg) {
    var m = (msg || "").toLowerCase();
    if (m.indexOf("생각") !== -1 || m.indexOf("think") !== -1) return "thinking";
    if (m.indexOf("도구") !== -1 || m.indexOf("ls") !== -1 || m.indexOf("써줘") !== -1) return "tool";
    if (m.indexOf("길게") !== -1 || m.indexOf("천천히") !== -1) return "long";
    return "simple";
  }
  function chunksFor(rid, scenario, msg) {
    var id = "tc-" + (++tc);
    switch (scenario) {
      case "thinking": return [ { type: "thinking", requestId: rid, text: "깊이 생각하는 중…" }, { type: "text", requestId: rid, text: "[variant] 생각 끝, 답이야" }, { type: "finish", requestId: rid } ];
      case "tool": return [ { type: "tool_use", requestId: rid, toolCallId: id, toolName: "execute_command", args: { command: "ls" } }, { type: "tool_result", requestId: rid, toolCallId: id, toolName: "execute_command", output: "a.txt\\nb.txt", success: true }, { type: "text", requestId: rid, text: "[variant] 파일 목록입니다" }, { type: "finish", requestId: rid } ];
      case "long": { var cs = []; for (var i = 0; i < 12; i++) cs.push({ type: "text", requestId: rid, text: "조각" + i + " " }); cs.push({ type: "finish", requestId: rid }); return cs; }
      default: return [ { type: "text", requestId: rid, text: "turnreply 안녕하세요 루크" }, { type: "finish", requestId: rid } ];
    }
  }

  window.__TAURI_INTERNALS__.invoke = async function (cmd, args) {
    if (cmd === "plugin:event|listen") { if (!eventListeners.has(args.event)) eventListeners.set(args.event, []); eventListeners.get(args.event).push(args.handler); return args.handler; }
    if (cmd === "plugin:event|emit") { emitEvent(args.event, args.payload); return null; }
    if (cmd === "plugin:event|unlisten") return;
    if (cmd === "send_to_agent_command") {
      var p = JSON.parse(args.message);
      window.__E2E_OUTBOUND__.push(p);
      if (p && p.type === "chat_request") {
        var last = (p.messages && p.messages.length) ? p.messages[p.messages.length - 1].content : "";
        var sc = scenarioFor(last);
        emitSeq(p.requestId, chunksFor(p.requestId, sc, last), sc === "long" ? 350 : 120);
      }
      return null;
    }
    if (cmd === "cancel_stream") { window.__E2E_CANCELLED__.push(args && args.requestId); return null; }
    if (cmd === "send_approval_response") return null;
    return undefined;
  };
})();
`;

const TEXT_CONFIG = {
	provider: "gemini",
	model: "gemini-2.5-flash",
	apiKey: "e2e-mock-key",
	enableTools: true,
	locale: "ko",
	onboardingComplete: true,
};

async function boot(page: import("@playwright/test").Page) {
	await page.addInitScript(NEW_CORE_FLAG);
	await page.addInitScript(MOCK_SCRIPT);
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_ADK_PATH });
	await page.addInitScript((c: string) => localStorage.setItem("naia-config", c), JSON.stringify(TEXT_CONFIG));
	await page.goto("/");
	await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });
}

async function send(page: import("@playwright/test").Page, text: string) {
	const input = page.locator(".chat-input");
	await expect(input).toBeEnabled({ timeout: 5_000 });
	await input.fill(text);
	await input.press("Enter");
}

test.describe("UC1 변종 — 새 core 경유", () => {
	test.beforeEach(async ({ page, context }) => {
		await context.grantPermissions(["microphone"]).catch(() => {});
		await boot(page);
	});

	test("thinking 변종: 사고 블록 + 본문 렌더", async ({ page }) => {
		await send(page, "이 문제 생각해줘");
		await expect(page.locator(".thinking-inline").first()).toBeVisible({ timeout: 15_000 });
		await expect(page.locator(".chat-message.assistant").last()).toContainText("생각 끝", { timeout: 15_000 });
	});

	test("도구 변종: tool_use+tool_result → tool-activity 렌더", async ({ page }) => {
		await send(page, "현재 디렉토리 ls 해줘 (도구)");
		await expect(page.locator(".tool-activity").first()).toBeVisible({ timeout: 15_000 });
		await expect(page.locator(".chat-message.assistant").last()).toContainText("파일 목록", { timeout: 15_000 });
	});

	test("멀티턴: 2번째 turn 의 chat_request 에 이전 대화 history 포함", async ({ page }) => {
		const assistant = page.locator(".chat-message.assistant");
		await send(page, "내 이름은 루크야");
		await expect(assistant).toHaveCount(1, { timeout: 15_000 });
		await expect(assistant.last()).toContainText("turnreply");
		await expect(page.locator(".cursor-blink")).toBeHidden({ timeout: 10_000 }); // turn1 종료
		await send(page, "내 이름 뭐라고 했지");
		await expect(assistant).toHaveCount(2, { timeout: 15_000 });
		const outbound = await page.evaluate(() => (window as unknown as { __E2E_OUTBOUND__: Array<{ type?: string; messages?: unknown[] }> }).__E2E_OUTBOUND__);
		const chatReqs = outbound.filter((o) => o.type === "chat_request");
		expect(chatReqs.length).toBeGreaterThanOrEqual(2);
		// 2번째 요청의 messages 가 1번째보다 많음 = history(사용자/어시스턴트 누적) 전달.
		const firstLen = (chatReqs[0].messages || []).length;
		const lastLen = (chatReqs[chatReqs.length - 1].messages || []).length;
		expect(lastLen).toBeGreaterThan(firstLen);
	});

	test("취소: 스트리밍 중 취소 → cancel_stream 발신 + 스트리밍 종료", async ({ page }) => {
		await send(page, "아주 길게 천천히 설명해줘");
		// 스트리밍 시작(커서) 확인 후 취소 버튼 클릭.
		await expect(page.locator(".cursor-blink").first()).toBeVisible({ timeout: 10_000 });
		const cancelBtn = page.locator(".chat-cancel-btn");
		await expect(cancelBtn).toBeVisible({ timeout: 5_000 });
		await cancelBtn.click();
		// cancel_stream 이 새 core transport 를 통해 발신됐는지(=취소 배선).
		await expect.poll(async () => page.evaluate(() => (window as unknown as { __E2E_CANCELLED__: string[] }).__E2E_CANCELLED__.length), { timeout: 5_000 }).toBeGreaterThan(0);
		// 스트리밍 종료(커서 사라짐).
		await expect(page.locator(".cursor-blink")).toBeHidden({ timeout: 10_000 });
	});
});
