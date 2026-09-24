import { expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

/**
 * Naia Shell E2E — 생각 세기 설정(끔/낮음/높음) 및 전송 검증 (#709 / FR-CHAT-THINKING.3~5).
 *
 * 1. 설정 창 Brain 탭에서 생각 세기 라디오 분절 버튼("높음") 선택
 * 2. 키보드 포커스, 넓은 폭, 좁은 폭(360px) 스크린샷 캡처
 * 3. 메시지 전송 시 IPC 목이 받은 send_to_agent_command 인자에 thinking.level == "high", enableThinking == true 검증
 */

const TAURI_MOCK = `
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
  window.__NAIA_E2E__ = { emitEvent: emitEvent };
  window.__E2E_OUTBOUND__ = [];

  window.__TAURI_INTERNALS__.invoke = async function (cmd, args) {
    if (cmd === "plugin:event|listen") {
      if (!eventListeners.has(args.event)) eventListeners.set(args.event, []);
      eventListeners.get(args.event).push(args.handler);
      return args.handler;
    }
    if (cmd === "plugin:event|emit") { emitEvent(args.event, args.payload); return null; }
    if (cmd === "plugin:event|unlisten") return;

    if (cmd === "read_naia_config") {
      return localStorage.getItem("naia-config") || null;
    }
    if (cmd === "secure_store_get") {
      var cfg = JSON.parse(localStorage.getItem("naia-config") || "{}");
      if (args && args.name) {
        return cfg[args.name] || "e2e-mock-key";
      }
      return "e2e-mock-key";
    }
    if (cmd === "write_naia_config") {
      return null;
    }
    if (cmd === "detect_gpu_vram") {
      return null;
    }

    if (cmd === "send_to_agent_command") {
      var payload = JSON.parse(args.message);
      window.__E2E_OUTBOUND__.push(payload);
      if (payload && payload.type === "chat_request") {
        setTimeout(function () {
          emitEvent("agent_response", JSON.stringify({
            type: "text",
            requestId: payload.requestId,
            text: "생각 세기 높음 응답 수신 완료",
          }));
          emitEvent("agent_response", JSON.stringify({
            type: "finish",
            requestId: payload.requestId,
          }));
        }, 50);
      }
      return undefined;
    }

    return undefined;
  };
})();
`;

test("설정에서 생각 세기 '높음' 선택 후 메시지 전송 시 thinking.level과 enableThinking이 정확히 전달된다 (#709)", async ({
	page,
}, testInfo) => {
	await page.addInitScript(TAURI_MOCK);
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_ADK_PATH });
	await page.addInitScript(() => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "e2e-mock-key",
				thinkingLevel: "off",
				enableThinking: false,
				enableTools: false,
				locale: "ko",
				onboardingComplete: true,
			}),
		);
	});

	await page.goto("/");
	await expect(page.locator(".chat-app")).toBeVisible({ timeout: 15_000 });

	// 1. 설정 탭 열기
	await page.getByRole("button", { name: /^(Settings|설정)$/ }).click();
	await page.locator('[data-settings-tab="brain"]').click();

	const thinkingSection = page.getByTestId("thinking-level-section");
	await expect(thinkingSection).toBeVisible();

	const highRadio = page.getByTestId("thinking-level-high");
	await expect(highRadio).toBeVisible();

	// 2. 키보드 포커스 스크린샷 (포커스 outline 캡처)
	await highRadio.focus();
	await thinkingSection.screenshot({
		path: testInfo.outputPath("thinking-focus.png"),
	});

	// 3. '높음' 라디오 선택 및 넓은 폭 스크린샷
	await highRadio.click();
	await expect(highRadio).toHaveAttribute("aria-checked", "true");
	await thinkingSection.screenshot({
		path: testInfo.outputPath("thinking-wide.png"),
	});

	// 4. 좁은 폭(360px) 설정 및 분절 버튼 영역 스크린샷
	// 좌측 아바타 패널을 숨겨(Ctrl+B) 설정 창이 360px 전체 폭을 사용하도록 함
	const hideNaiaBtn = page.getByRole("button", { name: /채팅 숨기기/i });
	if (await hideNaiaBtn.isVisible()) {
		await hideNaiaBtn.click();
	}
	await page.setViewportSize({ width: 360, height: 740 });
	await expect(thinkingSection).toBeVisible();
	await thinkingSection.screenshot({
		path: testInfo.outputPath("thinking-narrow.png"),
	});

	// 뷰포트 및 패널 원복
	await page.setViewportSize({ width: 1280, height: 800 });
	const showNaiaBtn = page.getByRole("button", { name: /채팅 보이기/i });
	if (await showNaiaBtn.isVisible()) {
		await showNaiaBtn.click();
	} else if (await hideNaiaBtn.isVisible()) {
		await hideNaiaBtn.click();
	}

	// 5. 바탕화면(채팅 영역)으로 돌아가기
	const desktopTab = page.locator('[data-app-id="desktop"]');
	if (await desktopTab.isVisible()) {
		await desktopTab.click();
	} else {
		await page.evaluate(() => {
			(
				window as unknown as {
					useAppStore?: { getState: () => { setActiveApp: (a: null) => void } };
				}
			).useAppStore
				?.getState()
				.setActiveApp(null);
		});
	}

	// 6. 채팅 메시지 전송
	const input = page.locator(".chat-input");
	await expect(input).toBeEnabled({ timeout: 5_000 });
	await input.fill("생각 세기 테스트 메시지");
	await input.press("Enter");

	// 7. IPC 목에 기록된 outbound 확인
	await expect
		.poll(
			async () => {
				const outbound = await page.evaluate(
					() =>
						(
							window as unknown as {
								__E2E_OUTBOUND__?: Array<Record<string, unknown>>;
							}
						).__E2E_OUTBOUND__ || [],
				);
				return outbound.some((o) => o.type === "chat_request");
			},
			{ timeout: 10_000 },
		)
		.toBe(true);

	const outbound = await page.evaluate(
		() =>
			(
				window as unknown as {
					__E2E_OUTBOUND__?: Array<Record<string, unknown>>;
				}
			).__E2E_OUTBOUND__ || [],
	);
	const chatReqs = outbound.filter((o) => o.type === "chat_request");
	expect(chatReqs.length).toBeGreaterThan(0);
	const lastReq = chatReqs[chatReqs.length - 1];

	expect(lastReq.thinking).toEqual({ level: "high" });
	expect(lastReq.enableThinking).toBe(true);
});
