import { expect, test } from "@playwright/test";
import { SEED_ADK_PATH, TAURI_BASE_MOCK_FALLBACK } from "./helpers/tauri-base-mock";

/**
 * UC1 통합 E2E — *실제 셸 UI*(ChatPanel + chat-service + 새 hexagonal core)를 자동 구동해
 * "사용자 한 줄 입력 → 스트리밍 응답"이 **새 core 경유**로 끝까지 manifest 되는지 기계가 판정.
 *
 * 왜 이 테스트가 필요한가(회귀 방지 앵커):
 *  - 라이브 디버깅에서 "채팅이 새 core(new-naia-agent)를 탔는가?"를 사람이 클릭·로그로 추정하던 게
 *    통합테스트 부재의 증거였음. omni 모델이면 sendChatMessage 전에 realtime WS로 우회한다는
 *    라우팅을 *자동으로* 못 잡아 매번 수동 확인이 필요했음.
 *  - 이 spec 은 (A) 텍스트 모델 → 새 core wire(chat_request) 전송 + 스트리밍 렌더,
 *    (B) omni 모델 → realtime 우회(새 core chat_request 미전송)를 결정론적으로 고정한다.
 *
 * 환경: 실제 vite dev(localhost:1420). Tauri IPC 는 addInitScript 로 mock(React 마운트 전).
 *  - window.__NAIA_NEW_CORE__=true 로 새 core 경로 강제(빌드 env 불요 — chat-service 게이트가 런타임 플래그도 인정).
 *  - send_to_agent_command 수신 payload 를 window.__E2E_OUTBOUND__ 에 기록(=새 core transport 가 보낸 wire).
 *  - chat_request 면 agent 대역으로 wire AgentMessage({type:"text"|"finish"}) 를 agent_response 로 emit
 *    (= new-naia-agent protocol.encodeEmit 와 byte 동일). 실 LLM/agent/rust 불요(헤르메틱).
 */

const ASSISTANT_TEXT = "[new-core-e2e] 안녕하세요 루크";

// 새 core 경로 강제 플래그 — 어떤 mock/모듈보다 먼저.
const NEW_CORE_FLAG = `window.__NAIA_NEW_CORE__ = true; window.__E2E_OUTBOUND__ = [];`;

/**
 * Tauri IPC mock — 이벤트 시스템 + send_to_agent_command 캡처/대역.
 * chat_request 면 스트리밍 2청크 + finish 를 agent_response 로 발신(진짜 agent 형태와 동일 바이트).
 */
const MOCK_SCRIPT = `
(function () {
  window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
  window.__TAURI_INTERNALS__.metadata = {
    currentWindow: { label: "main" },
    currentWebview: { windowLabel: "main", label: "main" },
  };
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
      // 새 core transport: chat_request·creds_update·approval_response 가 이 명령으로 옴.
      // chat_request 만 agent 대역 응답(스트리밍 text 2청크 + finish) — wire AgentMessage 형태.
      if (payload && payload.type === "chat_request") {
        var rid = payload.requestId;
        var chunks = [
          { type: "text", requestId: rid, text: "[new-core-e2e] 안녕하세요" },
          { type: "text", requestId: rid, text: " 루크" },
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
    return undefined; // → TAURI_BASE_MOCK_FALLBACK 가 부트 기본값 처리
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

test.describe("UC1 — 텍스트 모델 → 새 core 경유", () => {
	test.beforeEach(async ({ page }) => {
		// gemini = 비-omni → ChatPanel 이 sendChatMessage 경로 사용(omni early-return 미해당).
		await boot(page, {
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "e2e-mock-key",
			enableTools: false,
			locale: "ko",
			onboardingComplete: true,
		});
	});

	test("입력 → 새 core wire(chat_request) 전송 + 스트리밍 응답 렌더", async ({ page }) => {
		const input = page.locator(".chat-input");
		await expect(input).toBeEnabled({ timeout: 5_000 });
		await input.fill("안녕");
		await input.press("Enter");

		// 1) 응답이 UI 에 렌더 = 새 core 전체 체인(transport→router→ChatService→onChunk→UI) 입증.
		const assistant = page.locator(".chat-message.assistant");
		await expect(assistant.last()).toContainText("new-core-e2e", { timeout: 15_000 });
		await expect(assistant.last()).toContainText("루크");

		// 2) 새 core 플래그가 실제 ON 이었는지 + outbound 가 wire chat_request(messages 배열) 였는지.
		const flag = await page.evaluate(() => (window as unknown as { __NAIA_NEW_CORE__?: boolean }).__NAIA_NEW_CORE__);
		expect(flag).toBe(true);
		const outbound = await page.evaluate(() => (window as unknown as { __E2E_OUTBOUND__: Array<Record<string, unknown>> }).__E2E_OUTBOUND__);
		const chatReqs = outbound.filter((o) => o.type === "chat_request");
		expect(chatReqs.length).toBeGreaterThan(0);
		const last = chatReqs[chatReqs.length - 1];
		expect(Array.isArray(last.messages)).toBe(true);
		// S4 (두벌 제거): 텍스트 채팅 경로는 raw systemPrompt 를 굽지 않고 environmentSegments 만 보낸다.
		// 코어가 persona/locale/honorific 을 config.json 에서 스스로 조립 → 셸은 환경고유 컨텍스트(아바타 감정)만 운반.
		expect(last.systemPrompt).toBeUndefined();
		const segs = last.environmentSegments as Array<{ kind: string }> | undefined;
		expect(Array.isArray(segs)).toBe(true);
		expect(segs?.some((s) => s.kind === "avatarEmotion")).toBe(true);
	});
});

test.describe("UC1 라우팅 가드 — omni 모델 → realtime 우회", () => {
	test.beforeEach(async ({ page, context }) => {
		await context.grantPermissions(["microphone"]).catch(() => {});
		// naia omni 모델 = isOmniModel true → ChatPanel 784: sendChatMessage 전에 realtime WS 로 early-return.
		await boot(page, {
			provider: "nextain",
			model: "naia-0.9-omni-24g",
			naiaKey: "e2e-naia-key",
			locale: "ko",
			onboardingComplete: true,
		});
	});

	test("omni 모델 입력 → 새 core chat_request 미전송(=realtime 직행)", async ({ page }) => {
		const input = page.locator(".chat-input");
		await expect(input).toBeEnabled({ timeout: 5_000 });
		await input.fill("안녕");
		await input.press("Enter");

		// realtime 경로로 갈라지므로 새 core 텍스트 chat_request 는 나오면 안 됨(이 라우팅이 우리를 매번 헷갈리게 한 지점).
		await page.waitForTimeout(2_500);
		const outbound = await page.evaluate(() => (window as unknown as { __E2E_OUTBOUND__: Array<Record<string, unknown>> }).__E2E_OUTBOUND__);
		const chatReqs = outbound.filter((o) => o.type === "chat_request");
		expect(chatReqs.length).toBe(0);
	});
});
