import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { SEED_ADK_PATH, TAURI_BASE_MOCK_FALLBACK } from "./helpers/tauri-base-mock";

// 정본 transport=gRPC. agent 는 이제 gRPC 서버(GRPC_LISTENING addr 출력). 브리지는 send_to_agent_command wire 를
// Node gRPC 클라로 dispatch → AgentEvent(proto) → UI agent_response JSON(encodeEmit 동형)로 재구성해 emit.
// (실 Tauri webview + Rust gRPC 클라의 chromium 프록시 — Rust 클라는 별도 런타임 검증됨. 여기선 UI 렌더+agent gRPC 검증.)
const PROTO_PATH = "/var/home/luke/alpha-adk/projects/new-naia/new-naia-agent/src/main/adapters/grpc/naia_agent.proto";
function agentEventToUiJson(ev: Record<string, any>): Record<string, unknown> {
	const rid = ev.requestId;
	const p = (s: string) => { try { return JSON.parse(s); } catch { return null; } };
	if (ev.text) return { type: "text", requestId: rid, text: ev.text.text };
	if (ev.thinking) return { type: "thinking", requestId: rid, text: ev.thinking.text };
	if (ev.toolUse) return { type: "tool_use", requestId: rid, toolCallId: ev.toolUse.toolCallId, toolName: ev.toolUse.toolName, args: p(ev.toolUse.argsJson) };
	if (ev.toolResult) return { type: "tool_result", requestId: rid, toolCallId: ev.toolResult.toolCallId, output: ev.toolResult.output };
	if (ev.usage) return { type: "usage", requestId: rid, inputTokens: ev.usage.inputTokens, outputTokens: ev.usage.outputTokens, ...(ev.usage.cost !== undefined ? { cost: ev.usage.cost } : {}), ...(ev.usage.model ? { model: ev.usage.model } : {}) };
	if (ev.finish) return { type: "finish", requestId: rid };
	if (ev.error) return { type: "error", requestId: rid, message: ev.error.message };
	if (ev.logEntry) return { type: "log_entry", requestId: rid, level: ev.logEntry.level, message: ev.logEntry.message };
	if (ev.tokenWarning) return { type: "token_warning", requestId: rid, raw: p(ev.tokenWarning.rawJson) };
	return { type: "error", requestId: rid, message: "unknown event" };
}

/**
 * UC provider 출처(provider provenance) — **풀 파이프라인 통합테스트(실 agent + 실 LLM)**.
 *
 * 골(루크): 각 UC 는 Tauri 앱(여기선 실 셸 UI=크로미움) 에서 수행 → naia-agent 에서 동작 → 다시 앱이 제대로 반응
 * 하는 파이프라인까지 통합테스트. 이 spec 은 mock agent 대신 **진짜 new-naia-agent 서브프로세스로 브리지**한다:
 *
 *   실 셸 UI(ChatPanel + chat-service + 새 hexagonal core)
 *     → send_to_agent_command(wire chat_request)  ── exposeFunction 브리지 ──▶  실 agent-stdio-entry(node)
 *         · NAIA_ADK_PATH=/home/luke/naia-adk → naia-settings/config.json(zai/glm-5.1) 기동 로딩(정본)
 *         · 키는 wire 에 없음(셸 strip) → agent 가 OS 키체인(GLM_API_KEY)서 read(credentials 포트)
 *     → z.ai 직결 실 스트리밍 ──▶ agent_response 이벤트 ──▶ UI 렌더
 *
 * = "설정(naia-adk/naia-settings) → agent 가 그 provider 로 → 대화 → UI 반영" 을 실 LLM 까지 기계 판정.
 * Tauri Rust IPC 층만 mock(Playwright 헤드리스 — 시스템 디스플레이 불요). 실 Rust 의 NAIA_ADK_PATH 주입은
 * src-tauri/src/lib.rs(~/.naia/adk-path → env)로 별도 확인됨. e2e-tauri(실 Rust)는 디스플레이 필요 → 가용 시 재확인.
 *
 * ⚠️ 실 네트워크(z.ai) + 실 키체인 필요 → CI 기본 skip(RUN_LIVE_AGENT_E2E=1 일 때만). 로컬 검증용.
 */

const AGENT_ENTRY = "/var/home/luke/alpha-adk/projects/new-naia/new-naia-agent/scripts/builds/agent-stdio-entry.mjs";
const ADK_PATH = "/home/luke/naia-adk"; // 셸이 config.json(zai/glm-5.1) 쓴 실 워크스페이스(~/.naia/adk-path)

const NEW_CORE_FLAG = `window.__NAIA_NEW_CORE__ = true; window.__E2E_OUTBOUND__ = [];`;

// Tauri IPC mock — send_to_agent_command 를 실 agent 로 브리지(exposeFunction __e2eAgentSend).
const BRIDGE_MOCK = `
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
      window.__E2E_OUTBOUND__.push(JSON.parse(args.message));
      // 실 agent 로 브리지 — Node 가 stdin 에 쓰고, stdout 라인을 agent_response 로 다시 emit.
      if (window.__e2eAgentSend) window.__e2eAgentSend(args.message);
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

const LIVE = process.env.RUN_LIVE_AGENT_E2E === "1";

test.describe("UC provider 출처 — 실 agent + 실 z.ai 풀 파이프라인", () => {
	test.skip(!LIVE, "실 네트워크(z.ai)+키체인 필요 — RUN_LIVE_AGENT_E2E=1 로 활성");

	let agent: ChildProcess | null = null;

	test.afterEach(() => {
		try { agent?.kill("SIGKILL"); } catch { /* noop */ }
		agent = null;
	});

	test("입력 → 실 new-naia-agent(naia-settings config + 키체인 키) → z.ai 실응답 UI 렌더", async ({ page }) => {
		// 실 agent 서브프로세스 — 이제 gRPC 서버. config.json(zai/glm-5.1) + 키체인 GLM_API_KEY. skills/memory off.
		agent = spawn("node", [AGENT_ENTRY], {
			env: { ...process.env, NAIA_ADK_PATH: ADK_PATH, NAIA_AGENT_SKILLS: "off", NAIA_AGENT_MEMORY: "off" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		// GRPC_LISTENING <addr> 핸드셰이크 수신.
		const addr = await new Promise<string>((res, rej) => {
			const onData = (b: Buffer) => { const m = String(b).match(/GRPC_LISTENING (\S+)/); if (m) res(m[1]); };
			agent!.stdout!.on("data", onData);
			agent!.stderr!.on("data", onData);
			setTimeout(() => rej(new Error("agent gRPC addr 핸드셰이크 timeout")), 15_000);
		});
		// Node gRPC 클라(실 Tauri Rust 클라의 프록시 — Rust 클라는 별도 런타임 검증).
		const pkgDef = protoLoader.loadSync(PROTO_PATH, { keepCase: false, longs: Number, defaults: true, oneofs: true });
		const proto = grpc.loadPackageDefinition(pkgDef) as any;
		const grpcClient = new proto.naia.agent.v1.NaiaAgent(addr, grpc.credentials.createInsecure());
		await new Promise<void>((res, rej) => grpcClient.SetWorkspace({ adkPath: ADK_PATH }, (e: unknown) => (e ? rej(e) : res())));

		// 셸 send_to_agent_command(wire) → gRPC dispatch. chat=Chat stream → AgentEvent → UI agent_response.
		await page.exposeFunction("__e2eAgentSend", (message: string) => {
			let v: Record<string, any>;
			try { v = JSON.parse(message); } catch { return; }
			if (v.type === "chat_request") {
				const stream = grpcClient.Chat({ requestId: v.requestId, messages: v.messages ?? [], systemPrompt: v.systemPrompt, enableTools: v.enableTools, enableThinking: v.enableThinking, gatewayUrl: v.gatewayUrl, disabledSkills: v.disabledSkills ?? [] });
				stream.on("data", (ev: Record<string, any>) => {
					const ui = JSON.stringify(agentEventToUiJson(ev));
					page.evaluate((l) => (window as unknown as { __NAIA_E2E__: { emitEvent: (e: string, p: string) => void } }).__NAIA_E2E__.emitEvent("agent_response", l), ui).catch(() => {});
				});
				stream.on("error", (e: unknown) => {
					const ui = JSON.stringify({ type: "error", requestId: v.requestId, message: `grpc: ${String(e)}` });
					page.evaluate((l) => (window as unknown as { __NAIA_E2E__: { emitEvent: (e: string, p: string) => void } }).__NAIA_E2E__.emitEvent("agent_response", l), ui).catch(() => {});
				});
			} else if (v.type === "creds_update") {
				grpcClient.UpdateCreds({ provider: v.provider, apiKey: v.apiKey, naiaKey: v.naiaKey }, () => {});
			} else if (v.type === "cancel_stream") {
				grpcClient.Cancel({ requestId: v.requestId }, () => {});
			}
		});

		await page.addInitScript(NEW_CORE_FLAG);
		await page.addInitScript({ content: BRIDGE_MOCK });
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
		await page.addInitScript({ content: SEED_ADK_PATH });
		// 셸 config = zai/glm-5.1(= naia-settings/config.json 거울). 키는 wire 에 안 실림(셸 strip) → agent 키체인.
		await page.addInitScript({ content: configScript({ provider: "zai", model: "glm-5.1", agentName: "Naia", userName: "Tester", enableTools: false, locale: "ko", onboardingComplete: true }) });
		await page.goto("/");
		await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });

		const input = page.locator(".chat-input");
		await expect(input).toBeEnabled({ timeout: 5_000 });
		await input.fill("한 문장으로 인사해줘");
		await input.press("Enter");

		// 실 z.ai 응답이 UI 에 렌더 = UI→신코어→실 agent→z.ai→back→UI 전체 체인 입증.
		// ⚠️ 렌더 메시지 = "{응답본문}\n\n$cost · {tokens} 토큰"(응답 + usage footer 합본). 단순 length>5 +
		//   에러정규식만 보면 키가 401 로 죽어도 footer "$0.000000 · 0 토큰" 만으로 통과한다(false-success —
		//   2026-06-13 뮤테이션 프로브로 입증: 가짜 키 secret-tool 섀도 시에도 GREEN 이었음). 판별자 3중:
		//   (1) usage 토큰>0(실 LLM 호출), (2) footer 제거한 응답 본문 존재, (3) 에러 마커 부재.
		const assistant = page.locator(".chat-message.assistant").last();
		await expect(assistant).toBeVisible({ timeout: 45_000 });
		// 스트리밍 완료 판정 = usage footer("N 토큰") 도달(첫 글자 레이스 회피).
		await expect
			.poll(async () => /\d+\s*토큰/.test(await assistant.innerText()), { timeout: 45_000, intervals: [300, 500, 1000] })
			.toBe(true);
		const full = (await assistant.innerText()).trim();
		const FOOTER = /\$[\d.]+\s*·\s*(\d+)\s*토큰\s*$/;
		const tokens = Number(full.match(FOOTER)?.[1] ?? "0");
		const body = full.replace(FOOTER, "").trim();
		// (1) 실 z.ai 호출 토큰>0 — 키 깨지면 0(뮤테이션 RED 게이트).
		expect(tokens, "usage 토큰>0 = 실 z.ai 호출 성공(키 깨지면 0 토큰)").toBeGreaterThan(0);
		// (2) footer 제외 실 응답 본문 존재 — 키 깨지면 본문 없음.
		expect(body.length, "footer 제외 실 응답 본문 존재").toBeGreaterThan(10);
		// (3) 에러 마커 부재(전체 텍스트 기준).
		expect(full).not.toMatch(/\[오류\]|API key|provider error|Bad Request|\b40[0-9]\b|\b500\b/i);

		// wire 가 chat_request(messages 배열, 키 미포함) 였는지 — 신코어 transport 입증.
		const outbound = await page.evaluate(() => (window as unknown as { __E2E_OUTBOUND__: Array<Record<string, unknown>> }).__E2E_OUTBOUND__);
		const chatReqs = outbound.filter((o) => o.type === "chat_request");
		expect(chatReqs.length).toBeGreaterThan(0);
		const prov = chatReqs[chatReqs.length - 1].provider as Record<string, unknown> | undefined;
		expect(prov?.apiKey).toBeUndefined(); // 키는 wire 에 없음(셸 strip) — agent 가 키체인서 공급
	});
});
