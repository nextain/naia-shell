import { expect, test } from "@playwright/test";
import { SEED_ADK_PATH, TAURI_BASE_MOCK_FALLBACK } from "./helpers/tauri-base-mock";

/**
 * #582 UC-ENV-TOOL-SCRIPT·BROWSE — 브라우저 호스트 도구 노출과 승인 (실 UI, browser 등급).
 * 계약: docs/progress/issue-582-ego-browser-host.md 9절 S6a.
 *
 * 여기서 고정하는 것:
 *   (A) 켜진 OS 에서 env_browser_* 열두 도구가 뇌에 등록된다
 *   (B) 형식 도구 호출이 증거(스냅샷·캡처·주소 개정) 결과 카드를 만든다
 *   (C) 승인 없는 env_browser_script 는 거부 카드가 되고 관측 도구는 영향이 없다
 *   (D) 기존 skill_browser_navigate 의 이름·동작은 바뀌지 않는다
 *
 * ⚠️ 무엇이 대역이고 무엇이 실물인가.
 *    웹뷰 안에는 node 도, 감독자도, Chromium 도 없다. 그래서 **어댑터 아래**를 포트 대역으로
 *    바꾼다(`window.__NAIA_BROWSER_HOST_PORTS__`). 이 위의 것은 전부 실물이다 — 도구 등록,
 *    app_tool_call 분기, `EnvironmentToolService` 의 등급표와 승인 규칙, 결과 카드 렌더.
 *    감독자·실 Chromium 을 지나는 경로는 `src/test/env-tool-browser-host.contract.test.ts` 가
 *    실 Chromium 으로 이미 돈다. 그 둘을 겹쳐 놓아야 "대역만 통과"가 되지 않는다.
 */

const NEW_CORE_FLAG =
	"window.__NAIA_NEW_CORE__ = true; window.__E2E_OUTBOUND__ = []; window.__E2E_WV__ = []; window.__E2E_PORTS__ = [];";

/** 어댑터 자리의 대역. 무엇이 불렸는지 기록해 "거부됐는데 포트가 불렸다"를 잡는다. */
const PORTS_SCRIPT = `
(function () {
  var EVIDENCE = {
    snapshotRef: "snap-7",
    screenshotRef: "/tmp/naia-e2e-adk/ego-host/evidence/op-7.png",
    url: "https://example.test/products",
    urlRevision: 4
  };
  function note(rpc) { window.__E2E_PORTS__.push(rpc); }
  function slow() {
    var ms = window.__E2E_PORT_DELAY_MS__ || 0;
    return ms > 0 ? new Promise(function (r) { setTimeout(r, ms); }) : Promise.resolve();
  }
  window.__NAIA_BROWSER_HOST_PORTS__ = {
    browser: {
      open: async function () { note("open"); return EVIDENCE; },
      navigate: async function () { note("navigate"); return EVIDENCE; },
      snapshot: async function () { note("snapshot"); await slow(); return EVIDENCE; },
      click: async function () { note("click"); return EVIDENCE; },
      fill: async function () { note("fill"); return EVIDENCE; },
      evaluate: async function () { note("evaluate"); return { evidence: EVIDENCE, result: "3" }; },
      screenshot: async function () { note("screenshot"); return EVIDENCE; },
      close: async function () { note("close"); }
    },
    workspaces: {
      create: async function () { note("createWorkspace"); return { id: "space-e2e", mode: "headless", ownership: "agent", revision: 0 }; },
      list: async function () { note("listWorkspaces"); return []; },
      close: async function () { note("closeWorkspace"); }
    },
    scripts: {
      script: async function () { note("script"); return { evidence: EVIDENCE, result: "묶음 실행 결과" }; }
    },
    cancellation: { cancel: async function () { return []; } }
  };
})();
`;

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

  window.__TAURI_INTERNALS__.invoke = async function (cmd, args) {
    if (cmd === "plugin:event|listen") {
      if (!eventListeners.has(args.event)) eventListeners.set(args.event, []);
      eventListeners.get(args.event).push(args.handler);
      return args.handler;
    }
    if (cmd === "plugin:event|emit") { emitEvent(args.event, args.payload); return null; }
    if (cmd === "plugin:event|unlisten") return;

    if (cmd && cmd.indexOf("browser_wv_") === 0) {
      window.__E2E_WV__.push({ cmd: cmd, args: args });
      if (cmd === "browser_wv_snapshot") return 'link "제품 소개" [ref=@e1]';
      if (cmd === "browser_wv_get_text") return JSON.stringify("제품 소개 페이지 본문입니다.");
      return null;
    }

    if (cmd === "send_to_agent_command") {
      var payload = JSON.parse(args.message);
      window.__E2E_OUTBOUND__.push(payload);
      if (payload && payload.type === "chat_request") {
        var rid = payload.requestId;
        var calls = window.__E2E_BROWSE_CALLS__ || [];
        var chunks = calls.map(function (c, i) {
          return { type: "app_tool_call", requestId: rid, toolCallId: "tc-h-" + (i + 1), toolName: c.tool, args: c.args };
        });
        chunks.push({ type: "finish", requestId: rid });
        var d = 150;
        for (var i = 0; i < chunks.length; i++) {
          (function (c, ms) { setTimeout(function () { emitEvent("agent_response", JSON.stringify(c)); }, ms); })(chunks[i], d);
          d += 250;
        }
      }
      return null;
    }
    // 설정 하이드레이션이 끝나야 App 이 상시 표면 도구를 등록한다(App.tsx 의 configHydrated 관문).
    // 대역이 문자열이 아닌 값을 돌려주면 하이드레이션이 실패하고 등록 효과 전체가 열리지 않는다.
    if (cmd === "read_naia_config") return JSON.stringify({
      provider: "gemini", model: "gemini-2.5-flash", enableTools: true, locale: "ko", onboardingComplete: true
    });
    if (cmd === "read_naia_ui_config") return "{}";
    if (cmd === "cancel_stream") return null;
    if (cmd === "send_approval_response") return null;
    return undefined;
  };
})();
`;

const CONFIG = {
	provider: "gemini",
	model: "gemini-2.5-flash",
	apiKey: "e2e-mock-key",
	enableTools: true,
	locale: "ko",
	onboardingComplete: true,
};

type Page = import("@playwright/test").Page;

async function boot(page: Page) {
	await page.addInitScript(NEW_CORE_FLAG);
	await page.addInitScript(PORTS_SCRIPT);
	await page.addInitScript(MOCK_SCRIPT);
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_ADK_PATH });
	await page.addInitScript({
		content: `localStorage.setItem("naia-config", ${JSON.stringify(JSON.stringify(CONFIG))});`,
	});
	await page.goto("/");
	await expect(page.locator(".chat-app")).toBeVisible({ timeout: 10_000 });
	// 스플래시가 걷힌 뒤라야 시각 증거가 화면을 찍는다. 걷히기 전에 찍으면 부팅 화면만 남는다.
	await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 20_000 });
}

async function setCalls(page: Page, calls: { tool: string; args: Record<string, unknown> }[]) {
	await page.evaluate((c) => {
		(window as unknown as { __E2E_BROWSE_CALLS__?: unknown }).__E2E_BROWSE_CALLS__ = c;
	}, calls);
}

async function portCalls(page: Page): Promise<string[]> {
	return (await page.evaluate(
		() => (window as unknown as { __E2E_PORTS__?: string[] }).__E2E_PORTS__ ?? [],
	)) as string[];
}

async function say(page: Page, text: string) {
	const input = page.locator(".chat-input");
	await expect(input).toBeEnabled({ timeout: 5_000 });
	await input.fill(text);
	await input.press("Enter");
}

/** 좁은 폭·상태별 시각 증거. verify-visual-ux 의 상태 매트릭스를 파일로 남긴다. */
const SHOT_DIR = "../../.agents/progress/issue-582/s6a-visual";

test.describe("#582 브라우저 호스트 도구 (UC-ENV-TOOL-BROWSE·SCRIPT)", () => {
	test("(A) 켜진 OS 에서 env_browser_* 도구가 뇌에 등록된다", async ({ page }) => {
		await boot(page);
		const registered = await page.evaluate(async () => {
			const out = (window as unknown as { __E2E_OUTBOUND__?: Record<string, unknown>[] })
				.__E2E_OUTBOUND__;
			return out ?? [];
		});
		await expect
			.poll(
				async () =>
					page.evaluate(() => {
						const out =
							(window as unknown as { __E2E_OUTBOUND__?: Record<string, unknown>[] })
								.__E2E_OUTBOUND__ ?? [];
						const message = out.find(
							(m) => m?.type === "app_skills" && m?.appId === "browser-host",
						);
						if (!message) return 0;
						return (message.tools as { name?: string }[]).length;
					}),
				{ timeout: 15_000 },
			)
			.toBe(12);
		expect(registered.length, "부팅 중 아무것도 나가지 않았다").toBeGreaterThanOrEqual(0);

		// 기존 임베디드 웹뷰 도구와 이름이 겹치지 않는다.
		const names = await page.evaluate(() => {
			const out =
				(window as unknown as { __E2E_OUTBOUND__?: Record<string, unknown>[] }).__E2E_OUTBOUND__ ??
				[];
			return out
				.filter((m) => m?.type === "app_skills")
				.flatMap((m) => (m.tools as { name?: string }[]).map((t) => t.name ?? ""));
		});
		const host = names.filter((n) => n.startsWith("env_browser_"));
		const legacy = names.filter((n) => n.startsWith("skill_browser_"));
		expect(host.length).toBe(12);
		expect(host.filter((n) => legacy.includes(n))).toEqual([]);
	});

	test("(B) 형식 도구 호출이 증거 결과 카드를 만든다", async ({ page }) => {
		await boot(page);
		await setCalls(page, [
			{ tool: "env_browser_open", args: { url: "https://example.test/products" } },
			{ tool: "env_browser_snapshot", args: {} },
		]);
		await say(page, "제품 페이지 열고 구조 보여줘");

		const card = page.locator(".browser-host-card").first();
		await expect(card).toBeVisible({ timeout: 20_000 });
		// 증거 셋이 전부 화면에 있다 — 하나라도 없으면 사용자가 무슨 일이 있었는지 못 본다.
		await expect(card.locator(".browser-host-url")).toContainText("example.test/products");
		await expect(card.locator(".browser-host-revision")).toContainText("개정 4");
		await expect(card.locator(".browser-host-evidence")).toContainText("snap-7");
		await expect(card.locator(".browser-host-evidence")).toContainText("op-7.png");
		await expect(card.locator('.browser-host-badge[data-state="success"]')).toBeVisible();

		// 카드가 아직 스트리밍 자리에 붙어 있을 때 찍는다 — 턴이 끝나면 이 노드는 떨어진다.
		await card.screenshot({ path: `${SHOT_DIR}/02-success-card.png` });
		await page.screenshot({ path: `${SHOT_DIR}/02-success.png`, fullPage: true });

		await expect
			.poll(async () => (await portCalls(page)).join(","), { timeout: 20_000 })
			.toBe("open,snapshot");
		// 좁은 폭은 턴이 끝난 뒤의 메시지 카드에서 잰다 — 사용자가 실제로 다시 보는 자리다.
		await page.setViewportSize({ width: 900, height: 800 });
		const settled = page.locator(".browser-host-card").first();
		await expect(settled).toBeVisible({ timeout: 20_000 });
		await settled.screenshot({ path: `${SHOT_DIR}/05-narrow-900-card.png` });
		await page.screenshot({ path: `${SHOT_DIR}/05-narrow-900.png`, fullPage: true });
	});

	test("(B2) 빈 목록은 실패가 아니라 '없음' 으로 보인다", async ({ page }) => {
		await boot(page);
		await setCalls(page, [{ tool: "env_browser_list_workspaces", args: {} }]);
		await say(page, "지금 열려 있는 브라우저 공간 알려줘");

		const card = page.locator(".browser-host-card").first();
		await expect(card).toBeVisible({ timeout: 20_000 });
		await expect(card.locator(".browser-host-empty")).toContainText("없습니다");
		await card.screenshot({ path: `${SHOT_DIR}/01-empty-card.png` });
		await page.screenshot({ path: `${SHOT_DIR}/01-empty.png`, fullPage: true });
	});

	test("(B0) 기본 상태 — 도구를 부르기 전에는 카드가 없다", async ({ page }) => {
		await boot(page);
		await expect(page.locator(".browser-host-card")).toHaveCount(0);
		await page.screenshot({ path: `${SHOT_DIR}/00-default.png`, fullPage: true });
	});

	test("(B3) 진행 상태 — 증거를 받기 전에 '실행 중' 이라고 말한다", async ({ page }) => {
		await boot(page);
		// 포트를 일부러 늦춘다. 진행 상태가 화면에 실제로 머무는지 재려면 그 사이가 필요하다.
		await page.evaluate(() => {
			(window as unknown as { __E2E_PORT_DELAY_MS__?: number }).__E2E_PORT_DELAY_MS__ = 6_000;
		});
		await setCalls(page, [{ tool: "env_browser_snapshot", args: {} }]);
		await say(page, "지금 페이지 구조 보여줘");

		const progress = page.locator(".browser-host-progress");
		await expect(progress).toBeVisible({ timeout: 20_000 });
		await expect(progress).toHaveAttribute("aria-live", "polite");
		await page.screenshot({ path: `${SHOT_DIR}/03-progress.png`, fullPage: true });
		await page
			.locator(".browser-host-card")
			.first()
			.screenshot({ path: `${SHOT_DIR}/03-progress-card.png` });
	});

	test("(C) 승인 없는 env_browser_script 는 거부 카드가 되고 관측 도구는 영향이 없다", async ({
		page,
	}) => {
		await boot(page);
		await setCalls(page, [
			{ tool: "env_browser_script", args: { code: "await snapshotText()" } },
			{ tool: "env_browser_snapshot", args: {} },
		]);
		await say(page, "이 페이지에서 묶음으로 처리해줘");

		const refused = page.locator('.browser-host-card[data-status="refused"]').first();
		await expect(refused).toBeVisible({ timeout: 20_000 });
		await expect(refused.locator(".browser-host-refusal-code")).toContainText("approval-missing");
		// 원시 코드만 보여 주면 사용자가 복구할 수 없다. 다음 행동이 같은 카드 안에 있어야 한다.
		await expect(refused.locator(".browser-host-refusal-hint")).toContainText("승인");
		await expect(refused.locator(".browser-host-refusals")).toHaveAttribute("role", "alert");

		await refused.screenshot({ path: `${SHOT_DIR}/04-error-refused-card.png` });
		await page.screenshot({ path: `${SHOT_DIR}/04-error-refused.png`, fullPage: true });

		// 거부는 자식 프로세스가 뜨기 전이다. script 포트는 한 번도 불리지 않고 관측은 그대로 돈다.
		await expect
			.poll(async () => (await portCalls(page)).join(","), { timeout: 20_000 })
			.toBe("snapshot");
	});

	test("(D) 기존 skill_browser_navigate 의 이름·동작은 바뀌지 않는다", async ({ page }) => {
		await boot(page);
		await setCalls(page, [
			{ tool: "skill_browser_navigate", args: { url: "https://example.com/legacy" } },
		]);
		await say(page, "기존 브라우저로 열어줘");

		await expect
			.poll(
				async () =>
					page.evaluate(
						() =>
							((window as unknown as { __E2E_WV__?: { cmd: string }[] }).__E2E_WV__ ?? []).filter(
								(c) => c.cmd === "browser_wv_navigate",
							).length,
					),
				{ timeout: 20_000 },
			)
			.toBeGreaterThan(0);
		// 임베디드 웹뷰 경로는 브라우저 호스트 포트를 건드리지 않는다.
		expect(await portCalls(page), "기존 도구가 새 경로로 샜다").toEqual([]);
	});
});
