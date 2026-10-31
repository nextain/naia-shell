import { expect, test } from "@playwright/test";
import { SEED_ADK_PATH, TAURI_BASE_MOCK_FALLBACK } from "./helpers/tauri-base-mock";

/**
 * #582 UC-ENV-TOOL-SCRIPT·BROWSE — 브라우저 호스트 도구 노출과 승인 (실 UI, browser 등급).
 * 계약: docs/progress/issue-582-ego-browser-host.md 9절 S6a.
 *
 * 여기서 고정하는 것:
 *   (A) 켜진 OS 에서도 env_browser_* 열두 도구는 뇌에 등록되지 않고, 옛 등록은 지운다
 *   (B) 에이전트가 env_browser_* 를 불러도 셸 경계가 거절하고 포트·다리는 한 번도 불리지 않는다
 *   (C) env_browser_script 도 같은 경계에서 거절된다 — 승인 판정 이전에 막힌다
 *   (D) 기존 skill_browser_navigate 의 이름·동작은 바뀌지 않는다
 *
 * ⚠️ #611 (3f806d2b "모델에 직접 일 도구를 노출하지 않게 한다", cfc97d55 "직접 작업 도구의 모델
 *    경계를 닫는다") 이후 결정: 모델이 보는 도구는 keep list 와 정확히 같다
 *    (docs/requirements.md FR-TOOLS-SURFACE.1·.2, src/lib/model-facing-tools.ts). env_browser_* 는
 *    그 목록에 없고, model-facing-tools.contract.test.ts 가 env_browser_navigate 를 제거 대상으로 못박는다.
 *    sendAppSkills 는 걸러서 빈 목록이면 app_skills_clear 를 보내고(src/lib/chat-service.ts),
 *    ChatArea 의 app_tool_call 분기는 keep list 밖의 도구를 "Tool is not available" 로 돌려보낸다.
 *    아래 (A)~(C) 는 #582 S6a 때의 노출·결과 카드 기대를 이 경계에 맞춰 고쳐 쓴 것이다.
 *
 * ⚠️ 무엇이 대역이고 무엇이 실물인가.
 *    웹뷰 안에는 node 도, 감독자도, Chromium 도 없다. 그래서 **어댑터 아래**를 포트 대역으로
 *    바꾼다(`window.__NAIA_BROWSER_HOST_PORTS__`). 이 위의 것은 전부 실물이다 — 도구 등록,
 *    app_tool_call 분기, `EnvironmentToolService` 의 등급표와 승인 규칙, 결과 카드 렌더.
 *    감독자·실 Chromium 을 지나는 경로는 `src/test/env-tool-browser-host.contract.test.ts` 가
 *    실 Chromium 으로 이미 돈다. 그 둘을 겹쳐 놓아야 "대역만 통과"가 되지 않는다.
 */

const NEW_CORE_FLAG =
	"window.__NAIA_NEW_CORE__ = true; window.__E2E_OUTBOUND__ = []; window.__E2E_WV__ = []; window.__E2E_PORTS__ = []; window.__E2E_EGO_HOST__ = [];";

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

    // #582 S6c: 프로덕션에서 도구가 지나는 다리(ego_host_*). 이 스펙은 어댑터 **아래**를
    // 포트 대역으로 바꾸므로 여기에 닿을 일이 없고, 닿았다면 대역이 안 걸렸다는 뜻이다.
    // 그 사실을 기록해 두고 형식 있는 실패로 돌려준다 — 조용한 성공을 만들지 않는다.
    if (cmd && cmd.indexOf("ego_host_") === 0) {
      window.__E2E_EGO_HOST__ = window.__E2E_EGO_HOST__ || [];
      window.__E2E_EGO_HOST__.push(cmd);
      return Promise.reject("ego-host 다리는 이 대역에 없다");
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

/** 셸이 agent 로 돌려보낸 app_tool_result 들. 거절을 성공으로 바꾸지 않았는지 본다. */
async function toolResults(
	page: Page,
): Promise<{ toolCallId: string; success: boolean; result: string }[]> {
	return page.evaluate(() =>
		(
			(window as unknown as { __E2E_OUTBOUND__?: Record<string, unknown>[] }).__E2E_OUTBOUND__ ?? []
		)
			.filter((m) => m?.type === "app_tool_result")
			.map((m) => ({
				toolCallId: String(m.toolCallId),
				success: m.success === true,
				result: String(m.result),
			})),
	);
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
	test("(A) 켜진 OS 에서도 env_browser_* 도구는 뇌에 등록되지 않는다 (#611)", async ({ page }) => {
		await boot(page);
		// 리눅스 기본 켬이라 셸은 browser-host 묶음을 등록하려 한다. 걸러진 결과가 비었으므로
		// 옛 agent 에 남은 등록을 지우는 app_skills_clear 가 나가야 한다.
		await expect
			.poll(
				async () =>
					page.evaluate(() => {
						const out =
							(window as unknown as { __E2E_OUTBOUND__?: Record<string, unknown>[] })
								.__E2E_OUTBOUND__ ?? [];
						return out.some(
							(m) => m?.type === "app_skills_clear" && m?.appId === "browser-host",
						);
					}),
				{ timeout: 15_000 },
			)
			.toBe(true);

		const outbound = await page.evaluate(
			() =>
				(window as unknown as { __E2E_OUTBOUND__?: Record<string, unknown>[] }).__E2E_OUTBOUND__ ??
				[],
		);
		// browser-host 이름으로 도구 목록을 실어 보낸 적이 없다.
		expect(
			outbound.filter((m) => m?.type === "app_skills" && m?.appId === "browser-host"),
		).toEqual([]);
		// 어떤 앱 묶음에도 env_browser_* 가 섞여 나가지 않는다.
		const names = outbound
			.filter((m) => m?.type === "app_skills")
			.flatMap((m) => ((m.tools as { name?: string }[]) ?? []).map((t) => t.name ?? ""));
		expect(names.filter((n) => n.startsWith("env_browser_"))).toEqual([]);
	});

	test("(B) 에이전트의 env_browser_open·snapshot 호출은 셸 경계에서 거절되고 포트는 불리지 않는다 (#611)", async ({
		page,
	}) => {
		await boot(page);
		await setCalls(page, [
			{ tool: "env_browser_open", args: { url: "https://example.test/products" } },
			{ tool: "env_browser_snapshot", args: {} },
		]);
		await say(page, "제품 페이지 열고 구조 보여줘");

		// 두 호출 모두 실패 결과로 돌아간다 — 거절을 성공으로 바꾸지 않는다.
		await expect
			.poll(async () => toolResults(page), { timeout: 20_000 })
			.toEqual([
				{ toolCallId: "tc-h-1", success: false, result: "Tool is not available: env_browser_open" },
				{ toolCallId: "tc-h-2", success: false, result: "Tool is not available: env_browser_snapshot" },
			]);
		// 경계는 실행기 앞이다. 포트 대역도, 프로덕션 다리(ego_host_*)도 한 번도 불리지 않는다.
		expect(await portCalls(page)).toEqual([]);
		expect(
			await page.evaluate(() => (window as unknown as { __E2E_EGO_HOST__: string[] }).__E2E_EGO_HOST__),
		).toEqual([]);
		// 결과 카드도 만들지 않는다. 실행되지 않은 도구의 증거를 보여 주면 거짓이 된다.
		await expect(page.locator(".browser-host-card")).toHaveCount(0);
	});

	test("(B2) 관측 전용 env_browser_list_workspaces 도 거절된다 (#611)", async ({ page }) => {
		await boot(page);
		await setCalls(page, [{ tool: "env_browser_list_workspaces", args: {} }]);
		await say(page, "지금 열려 있는 브라우저 공간 알려줘");

		await expect
			.poll(async () => toolResults(page), { timeout: 20_000 })
			.toEqual([
				{
					toolCallId: "tc-h-1",
					success: false,
					result: "Tool is not available: env_browser_list_workspaces",
				},
			]);
		expect(await portCalls(page)).toEqual([]);
		await expect(page.locator(".browser-host-card")).toHaveCount(0);
	});

	test("(B0) 기본 상태 — 도구를 부르기 전에는 카드가 없다", async ({ page }) => {
		await boot(page);
		await expect(page.locator(".browser-host-card")).toHaveCount(0);
		await page.screenshot({ path: `${SHOT_DIR}/00-default.png`, fullPage: true });
	});

	test("(B3) 거절은 즉시다 — 느린 포트를 기다리는 '실행 중' 상태가 생기지 않는다 (#611)", async ({
		page,
	}) => {
		await boot(page);
		// 포트를 일부러 늦춘다. 경계가 실행기 앞이면 이 지연은 화면에 나타날 수 없다.
		await page.evaluate(() => {
			(window as unknown as { __E2E_PORT_DELAY_MS__?: number }).__E2E_PORT_DELAY_MS__ = 6_000;
		});
		await setCalls(page, [{ tool: "env_browser_snapshot", args: {} }]);
		await say(page, "지금 페이지 구조 보여줘");

		await expect
			.poll(async () => toolResults(page), { timeout: 5_000 })
			.toEqual([
				{ toolCallId: "tc-h-1", success: false, result: "Tool is not available: env_browser_snapshot" },
			]);
		await expect(page.locator(".browser-host-progress")).toHaveCount(0);
		expect(await portCalls(page)).toEqual([]);
	});

	test("(C) env_browser_script 는 승인 판정 전에 경계에서 거절되고 script 포트는 불리지 않는다 (#611)", async ({
		page,
	}) => {
		await boot(page);
		await setCalls(page, [
			{ tool: "env_browser_script", args: { code: "await snapshotText()" } },
			{ tool: "env_browser_snapshot", args: {} },
		]);
		await say(page, "이 페이지에서 묶음으로 처리해줘");

		await expect
			.poll(async () => toolResults(page), { timeout: 20_000 })
			.toEqual([
				{ toolCallId: "tc-h-1", success: false, result: "Tool is not available: env_browser_script" },
				{ toolCallId: "tc-h-2", success: false, result: "Tool is not available: env_browser_snapshot" },
			]);
		// 승인 창도 뜨지 않는다 — 모델에 없는 도구를 사용자에게 승인받게 하지 않는다.
		await expect(page.locator(".permission-modal")).toHaveCount(0);
		// 자식 프로세스는 뜨지 않는다. script 포트도 관측 포트도 한 번도 불리지 않는다.
		expect(await portCalls(page)).toEqual([]);
		await expect(page.locator(".browser-host-card")).toHaveCount(0);
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
