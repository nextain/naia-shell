import { expect, test } from "@playwright/test";
import { SEED_ADK_PATH, TAURI_BASE_MOCK_FALLBACK } from "./helpers/tauri-base-mock";

/**
 * UC-compaction 통합 E2E — agent 가 예산 압박으로 이전 대화를 요약(compact)했을 때 방출하는
 * wire AgentMessage({type:"compacted", droppedCount}) 가 **새 core 경유**(transport→message-router→
 * shell-compat→ChatPanel)로 사용자 알림 배너(data-testid="compaction-notice")로 표현되는지 기계 판정.
 *
 * 회귀 방지 앵커: 어제까지 compaction host-loop(agent)은 wire 이벤트를 안 내보내 UI 에 *완전 비가시* 였음.
 * 이 spec 은 compacted 이벤트 → 배너 표현 + 응답이 깨지지 않음(비-terminal)을 결정론적으로 고정한다.
 * 실 LLM/agent/rust 불요(헤르메틱) — protocol.encodeEmit/agent_grpc 의 {type:"compacted"} byte 와 동일.
 */
const NEW_CORE_FLAG = `window.__NAIA_NEW_CORE__ = true; window.__E2E_OUTBOUND__ = [];`;

const MOCK_SCRIPT = `
(function () {
  window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
  window.__TAURI_INTERNALS__.metadata = { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } };
  var callbacks = new Map(); var nextCbId = 1;
  window.__TAURI_INTERNALS__.transformCallback = function (fn, once) {
    var id = nextCbId++;
    callbacks.set(id, function (data) { if (once) callbacks.delete(id); return fn && fn(data); });
    return id;
  };
  window.__TAURI_INTERNALS__.unregisterCallback = function (id) { callbacks.delete(id); };
  window.__TAURI_INTERNALS__.runCallback = function (id, data) { var cb = callbacks.get(id); if (cb) cb(data); };
  var eventListeners = new Map();
  window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function () {};
  function emitEvent(event, payload) {
    var hs = eventListeners.get(event) || [];
    for (var i = 0; i < hs.length; i++) window.__TAURI_INTERNALS__.runCallback(hs[i], { event: event, payload: payload });
  }
  window.__TAURI_INTERNALS__.convertFileSrc = function (p, proto) { return (proto || "asset") + "://localhost/" + encodeURIComponent(p); };
  window.__NAIA_E2E__ = { emitEvent: emitEvent };

  window.__TAURI_INTERNALS__.invoke = async function (cmd, args) {
    if (cmd === "plugin:event|listen") {
      if (!eventListeners.has(args.event)) eventListeners.set(args.event, []);
      eventListeners.get(args.event).push(args.handler);
      return args.handler;
    }
    if (cmd === "plugin:event|emit") { emitEvent(args.event, args.payload); return null; }
    if (cmd === "plugin:event|unlisten") return;

    if (cmd === "send_to_agent_command") {
      var payload = JSON.parse(args.message);
      window.__E2E_OUTBOUND__.push(payload);
      if (payload && payload.type === "chat_request") {
        var rid = payload.requestId;
        // 예산 압박 요약(compacted) → 그 뒤 정상 응답 + finish. compacted 가 맨 앞(provider 라운드 전).
        var chunks = [
          { type: "compacted", requestId: rid, droppedCount: 3 },
          { type: "text", requestId: rid, text: "[compaction-e2e] 요약 후 응답" },
          { type: "finish", requestId: rid },
        ];
        var d = 120;
        for (var i = 0; i < chunks.length; i++) {
          (function (c, ms) { setTimeout(function () { emitEvent("agent_response", JSON.stringify(c)); }, ms); })(chunks[i], d);
          d += 120;
        }
      }
      return null;
    }
    if (cmd === "cancel_stream" || cmd === "send_approval_response") return null;
    return undefined;
  };
})();
`;

function configScript(cfg: Record<string, unknown>): string {
	return `localStorage.setItem("naia-config", ${JSON.stringify(JSON.stringify(cfg))});`;
}

async function boot(page: import("@playwright/test").Page, cfg: Record<string, unknown>) {
	await page.addInitScript(NEW_CORE_FLAG);
	await page.addInitScript(MOCK_SCRIPT);
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_ADK_PATH });
	await page.addInitScript({ content: configScript(cfg) });
	await page.goto("/");
	await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });
}

test.describe("UC-compaction — compacted wire → UI 알림 배너", () => {
	test.beforeEach(async ({ page }) => {
		await boot(page, {
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "e2e-mock-key",
			enableTools: false,
			locale: "ko",
			onboardingComplete: true,
		});
	});

	test("입력 → compacted 이벤트 → 요약 알림 배너 표시(droppedCount) + 응답 정상 렌더", async ({ page }) => {
		const input = page.locator(".chat-input");
		await expect(input).toBeEnabled({ timeout: 5_000 });
		await input.fill("긴 대화 이어가기");
		await input.press("Enter");

		// 1) compacted 청크 → ChatPanel 이 compaction-notice 배너 렌더(어제까지 비가시였던 갭 해소).
		const notice = page.getByTestId("compaction-notice");
		await expect(notice).toBeVisible({ timeout: 15_000 });
		await expect(notice).toContainText("3"); // droppedCount

		// 2) 응답도 정상 렌더 = compacted 가 비-terminal(turn 안 깸).
		await expect(page.locator(".chat-message.assistant").last()).toContainText("compaction-e2e", { timeout: 15_000 });

		// 3) dismiss(×) → 배너 사라짐.
		await notice.getByRole("button", { name: /dismiss/i }).click();
		await expect(notice).toBeHidden();
	});
});
