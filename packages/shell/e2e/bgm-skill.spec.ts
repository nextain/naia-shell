import { expect, test } from "@playwright/test";
import { SEED_ADK_PATH, TAURI_BASE_MOCK_FALLBACK } from "./helpers/tauri-base-mock";

/**
 * UC8 / FR-BGM.1 — skill_youtube_bgm 배선 회귀 가드 (실 UI, 새 core).
 *
 * 왜 이 테스트가 필요한가(회귀 방지 앵커):
 *  - 구 monolith 의 BGM 스킬이 new-core 이식에서 **도구 등록 배선만 누락**됐다 —
 *    위젯(BgmPlayer)·검색 사이드카(:18791)·agent UC8 어댑터는 전부 존재했으나
 *    나이아가 BGM 존재 자체를 몰랐다. 단위테스트(executeBgmSkill)는 초록불이어도
 *    **배선이 빠지면** 회귀를 못 잡는다 → 그 두 배선을 실 UI 로 고정한다:
 *      (A) 부팅 시 App 이 skill_youtube_bgm 을 agent 에 등록(panel_skills 발신)
 *      (B) 채팅 턴 중 agent 가 panel_tool_call(skill_youtube_bgm) 을 내면
 *          ChatArea 가 dispatch → 위젯이 실제로 재생 상태로 전환(.bgm-icon--playing)
 *
 * 환경: 실제 vite dev(localhost:1420). Tauri IPC 는 addInitScript 로 mock(React 마운트 전).
 *  - 데모와 동일하게 새 core(__NAIA_NEW_CORE__=true).
 *  - send_to_agent_command payload 를 __E2E_OUTBOUND__ 에 기록(부팅 panel_skills 캡처).
 *  - chat_request 수신 시 agent 대역으로 panel_tool_call(skill_youtube_bgm, play+videoId — 사이드카 불요)
 *    + finish 를 agent_response 로 emit. dispatch → executeBgmSkill → bgm_youtube_play 이벤트 → 위젯 반응.
 */

const NEW_CORE_FLAG = `window.__NAIA_NEW_CORE__ = true; window.__E2E_OUTBOUND__ = [];`;

// play+videoId 경로 = 사이드카(:18791) 미접촉(검색 skip) → 헤르메틱.
const BGM_TOOL_ARGS = { action: "play", videoId: "e2evid001", title: "E2E BGM Track" };

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
      // 채팅 턴 중 agent 가 BGM 도구를 부르는 상황 재현: chat_request 의 requestId 로
      // panel_tool_call(skill_youtube_bgm) → finish. requestId 일치라야 handleChunk 가 처리(실 계약).
      if (payload && payload.type === "chat_request") {
        var rid = payload.requestId;
        var chunks = [
          { type: "panel_tool_call", requestId: rid, toolCallId: "tc-bgm-1", toolName: "skill_youtube_bgm", args: ${JSON.stringify(BGM_TOOL_ARGS)} },
          { type: "text", requestId: rid, text: "재생을 요청했어요. 실제 재생이 확인되면 곡을 소개할게요." },
          { type: "finish", requestId: rid },
        ];
        var d = 150;
        for (var i = 0; i < chunks.length; i++) {
          (function (c, ms) { setTimeout(function () { emitEvent("agent_response", JSON.stringify(c)); }, ms); })(chunks[i], d);
          d += 200;
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

test.describe("UC8 BGM 스킬 배선 (FR-BGM.1)", () => {
	test.beforeEach(async ({ page }) => {
		// Deterministic local iframe: this e2e never contacts YouTube.
		await page.route("https://www.youtube-nocookie.com/embed/**", async (route) => {
			await route.fulfill({
				contentType: "text/html",
				body: `<!doctype html><script>
					parent.postMessage(JSON.stringify({ event: "onReady" }), "*");
					setTimeout(() => parent.postMessage(JSON.stringify({ event: "onStateChange", info: 1 }), "*"), 700);
				</script>`,
			});
		});
		await page.addInitScript(NEW_CORE_FLAG);
		await page.addInitScript(MOCK_SCRIPT);
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
		await page.addInitScript({ content: SEED_ADK_PATH });
		await page.addInitScript({
			content: configScript({
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "e2e-mock-key",
				enableTools: true,
				locale: "ko",
				onboardingComplete: true,
			}),
		});
		await page.goto("/");
		await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });
	});

	test("(A) 부팅 시 skill_youtube_bgm 이 agent 에 등록된다(panel_skills 발신)", async ({
		page,
	}) => {
		// App 부팅 effect 의 sendPanelSkills 가 outbound 에 쌓일 때까지 대기.
		await expect
			.poll(
				async () =>
					page.evaluate(() => {
						const out =
							(window as unknown as { __E2E_OUTBOUND__?: unknown[] })
								.__E2E_OUTBOUND__ ?? [];
						return out.some(
							(m) =>
								m &&
								typeof m === "object" &&
								(m as { type?: string }).type === "panel_skills" &&
								(m as { appId?: string }).appId === "bgm-widget" &&
								Array.isArray((m as { tools?: unknown[] }).tools) &&
								(m as { tools: { name?: string }[] }).tools.some(
									(t) => t?.name === "skill_youtube_bgm",
								),
						);
					}),
				{ timeout: 10_000 },
			)
			.toBe(true);
	});

	test("(B) 채팅 턴 중 panel_tool_call(skill_youtube_bgm) → 위젯이 실제 재생 상태로 전환", async ({
		page,
	}) => {
		// BGM 위젯이 마운트돼 있고 아직 재생 아님(초기).
		await expect(page.locator(".bgm-player")).toBeVisible({ timeout: 5_000 });
		await expect(page.locator(".bgm-icon--playing")).toHaveCount(0);

		// 채팅 전송 → mock 이 chat_request 의 requestId 로 panel_tool_call 발신 → dispatch → 재생.
		const input = page.locator(".chat-input");
		await expect(input).toBeEnabled({ timeout: 5_000 });
		await input.fill("잔잔한 음악 틀어줘");
		await input.press("Enter");

		await expect.poll(async () => page.evaluate(() => {
			const out = (window as unknown as { __E2E_OUTBOUND__?: Array<Record<string, unknown>> })
				.__E2E_OUTBOUND__ ?? [];
			return out.find((message) => message.type === "panel_tool_result")?.result ?? null;
		}), { timeout: 10_000 }).not.toBeNull();
		const toolResult = await page.evaluate(() => {
			const out = (window as unknown as { __E2E_OUTBOUND__?: Array<Record<string, unknown>> })
				.__E2E_OUTBOUND__ ?? [];
			return String(out.find((message) => message.type === "panel_tool_result")?.result ?? "");
		});
		expect(JSON.parse(toolResult)).toMatchObject({
			playback: { status: "requested" },
			announceTrack: false,
		});
		expect(JSON.parse(toolResult)).not.toHaveProperty("title");

		// 배선 end-to-end 입증: dispatch → executeBgmSkill → bgm_youtube_play → BgmPlayer 재생.
		// Replacing the iframe is only a request. The fixture has not reported
		// `playing` at this point, so the compact player must not claim it.
		await page.waitForTimeout(250);
		await expect(page.locator(".bgm-icon--playing")).toHaveCount(0);

		await expect(page.locator(".bgm-icon--playing")).toBeVisible({
			timeout: 15_000,
		});
	});
});
