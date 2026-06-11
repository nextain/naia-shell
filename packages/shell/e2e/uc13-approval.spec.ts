import { expect, test } from "@playwright/test";
import { SEED_ADK_PATH, TAURI_BASE_MOCK_FALLBACK } from "./helpers/tauri-base-mock";

/**
 * UC13 통합 E2E — 실 셸 UI 로 승인 게이트 outbound 검증: agent 가 approval_request 를 보내면
 * ChatPanel(PermissionModal) 이 렌더 → 사용자 approve/reject → **새 core 경유 approval_response 송신**.
 * 점검서 발견한 vocab 버그(once/always→reject 둔갑) 회귀 가드: approve(once) → wire decision "approve" 단언.
 * window.__NAIA_NEW_CORE__=true 로 새 경로 강제. mock agent 가 approval_request emit + outbound 캡처. 헤르메틱.
 */
const NEW_CORE_FLAG = `window.__NAIA_NEW_CORE__ = true; window.__E2E_OUTBOUND__ = [];`;

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

  window.__TAURI_INTERNALS__.invoke = async function (cmd, args) {
    if (cmd === "plugin:event|listen") { if (!eventListeners.has(args.event)) eventListeners.set(args.event, []); eventListeners.get(args.event).push(args.handler); return args.handler; }
    if (cmd === "plugin:event|emit") { emitEvent(args.event, args.payload); return null; }
    if (cmd === "plugin:event|unlisten") return;
    if (cmd === "send_to_agent_command") {
      var p = JSON.parse(args.message);
      window.__E2E_OUTBOUND__.push(p);
      if (p && p.type === "chat_request") {
        var rid = p.requestId;
        // 승인 필요 도구 호출 — approval_request emit(턴 열어둠, finish 안 함). 승인 응답은 outbound 로 캡처.
        setTimeout(function () { emitEvent("agent_response", JSON.stringify({ type: "tool_use", requestId: rid, toolCallId: "call-x", toolName: "danger", args: {} })); }, 60);
        setTimeout(function () { emitEvent("agent_response", JSON.stringify({ type: "approval_request", requestId: rid, toolCallId: "call-x", toolName: "danger", tier: "ask" })); }, 120);
      }
      if (p && p.type === "approval_response") {
        // 승인/거부 후 턴 종결(현실 agent 처럼)
        setTimeout(function () { emitEvent("agent_response", JSON.stringify({ type: "tool_result", requestId: p.requestId, toolCallId: p.toolCallId, output: p.decision === "approve" ? "ran" : "rejected" })); emitEvent("agent_response", JSON.stringify({ type: "finish", requestId: p.requestId })); }, 30);
      }
      return null;
    }
    if (cmd === "cancel_stream" || cmd === "send_approval_response") return null;
    return undefined;
  };
})();
`;

const CONFIG = { provider: "gemini", model: "gemini-2.5-flash", apiKey: "e2e-mock-key", enableTools: true, locale: "ko", onboardingComplete: true };

async function boot(page: import("@playwright/test").Page) {
  await page.addInitScript(NEW_CORE_FLAG);
  await page.addInitScript(MOCK_SCRIPT);
  await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
  await page.addInitScript({ content: SEED_ADK_PATH });
  await page.addInitScript((c: string) => localStorage.setItem("naia-config", c), JSON.stringify(CONFIG));
  await page.goto("/");
  await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });
}
async function triggerApproval(page: import("@playwright/test").Page) {
  const input = page.locator(".chat-input");
  await expect(input).toBeEnabled({ timeout: 5_000 });
  await input.fill("위험 작업 해줘");
  await input.press("Enter");
  await expect(page.locator(".permission-modal")).toBeVisible({ timeout: 15_000 }); // PermissionModal 렌더
}
const approvalResponses = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as unknown as { __E2E_OUTBOUND__: Array<{ type?: string; decision?: string }> }).__E2E_OUTBOUND__.filter((o) => o.type === "approval_response"));

test.describe("UC13 승인 게이트 — 실 UI outbound", () => {
  test.beforeEach(async ({ page, context }) => { await context.grantPermissions(["microphone"]).catch(() => {}); await boot(page); });

  test("approve(once) → wire approval_response decision 'approve'(vocab 버그 회귀 가드)", async ({ page }) => {
    await triggerApproval(page);
    await page.locator(".permission-btn-once").click();
    await expect.poll(async () => (await approvalResponses(page)).length, { timeout: 5_000 }).toBeGreaterThan(0);
    const resp = await approvalResponses(page);
    expect(resp[resp.length - 1].decision).toBe("approve"); // once → approve(reject 둔갑 아님)
  });

  test("always → 'approve'", async ({ page }) => {
    await triggerApproval(page);
    await page.locator(".permission-btn-always").click();
    await expect.poll(async () => (await approvalResponses(page)).length, { timeout: 5_000 }).toBeGreaterThan(0);
    expect((await approvalResponses(page)).pop()?.decision).toBe("approve");
  });

  test("reject → 'reject'", async ({ page }) => {
    await triggerApproval(page);
    await page.locator(".permission-btn-reject").click();
    await expect.poll(async () => (await approvalResponses(page)).length, { timeout: 5_000 }).toBeGreaterThan(0);
    expect((await approvalResponses(page)).pop()?.decision).toBe("reject");
  });
});
