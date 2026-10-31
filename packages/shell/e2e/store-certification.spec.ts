import { expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

const TAURI_MOCK = `
(function() {
	window.__NAIA_NEW_CORE__ = true;
	window.__STORE_CERT_E2E__ = { calls: [] };
	window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
	window.__TAURI_INTERNALS__.metadata = { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } };
	var callbacks = new Map(); var nextCbId = 1; var listeners = new Map();
	window.__TAURI_INTERNALS__.transformCallback = function(fn, once) { var id = nextCbId++; callbacks.set(id, function(data) { if (once) callbacks.delete(id); return fn && fn(data); }); return id; };
	window.__TAURI_INTERNALS__.unregisterCallback = function(id) { callbacks.delete(id); };
	window.__TAURI_INTERNALS__.runCallback = function(id, data) { var cb = callbacks.get(id); if (cb) cb(data); };
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};
	function emit(event, payload) { (listeners.get(event) || []).forEach(function(id) { window.__TAURI_INTERNALS__.runCallback(id, { event: event, payload: payload }); }); }
	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		window.__STORE_CERT_E2E__.calls.push({ cmd: cmd, args: args });
		if (cmd === "plugin:event|listen") { if (!listeners.has(args.event)) listeners.set(args.event, []); listeners.get(args.event).push(args.handler); return args.handler; }
		if (cmd === "plugin:event|emit" || cmd === "plugin:event|unlisten") return null;
		if (cmd === "write_naia_config" || cmd === "write_agent_key" || cmd === "reload_agent_settings" || cmd === "detect_gpu_vram") return null;
		if (cmd === "agent_key_exists") return false;
		// Settings(도구 기본 켜짐)의 DevicePairingSection 이 읽는다. Rust device_pairing.rs 는
		// 항상 배열을 돌려주므로 mock 도 []. undefined 면 Settings 가 오류 경계로 무너진다.
		if (cmd === "device_list" || cmd === "device_list_requests") return [];
		if (cmd === "send_to_agent_command") {
			var request = JSON.parse(args.message);
			if (request.type === "panel_skills" || request.type === "panel_skills_clear") return null;
			setTimeout(function() {
				emit("agent_response", JSON.stringify({ type: "usage", requestId: request.requestId, inputTokens: 0, outputTokens: 0, cost: 0, model: "qwen3" }));
				emit("agent_response", JSON.stringify({ type: "error", requestId: request.requestId, message: "provider rejected the API key" }));
			}, 20);
			return null;
		}
		return undefined;
	};
})();
`;

test("Store reviewer journey keeps a zero-token provider failure actionable", async ({
	page,
}) => {
	const serverErrors: string[] = [];
	page.on("response", (response) => {
		if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
	});
	await page.addInitScript(TAURI_MOCK);
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_ADK_PATH });
	await page.addInitScript(() => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "ollama",
				model: "qwen3",
				// API 키는 원격 Ollama 에만 의미가 있다. 로컬 호스트면 채팅 전에
				// ollama_runtime_status 예약 관문(ollama-chat-admission.ts)이 먼저 막는다.
				ollamaHost: "https://ollama.store-review.test",
				locale: "en",
				onboardingComplete: true,
			}),
		);
	});

	// 원격 Ollama 모델 목록 조회는 외부망으로 나가지 않게 여기서 답한다.
	await page.route("https://ollama.store-review.test/**", (route) =>
		route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: [{ name: "qwen3" }] }) }),
	);
	await page.goto("/");
	// panel → app 리네임(#502 wire 계약) 이후 이 클래스는 chat-app 이다. 이 스펙은 리네임
	// 전 브랜치에서 작성돼 옛 선택자를 들고 왔고, git 은 충돌 없이 병합했지만 의미가
	// 어긋나 있었다(2026-08-28 병합 후 실 UI 에서 드러남).
	await expect(page.locator(".chat-app")).toBeVisible({ timeout: 15_000 });
	await page.locator(".app-bar-settings").click();
	await page.locator('[data-settings-tab="brain"]').click();
	// #602(0221930f)로 Gemini 등 타사 직결 클라우드 공급자는 제거됐다. 키를 저장하는
	// 공급자는 원격 Ollama(OpenAI 호환) 하나만 남는다(adk-store.ts resolveAgentEnvKey).
	await page.locator("#provider-select").selectOption("ollama");
	await page.locator("#apikey-input").fill("store-review-key");
	await page.locator(".settings-save-btn").first().click();

	await expect
		.poll(() =>
			page.evaluate(() => {
				const calls = (window as any).__STORE_CERT_E2E__.calls as Array<{ cmd: string; args: Record<string, unknown> }>;
				const keyIndex = calls.findIndex(
					(call) =>
						call.cmd === "write_agent_key" &&
						call.args.envKey === "OPENAI_API_KEY" &&
						call.args.value === "store-review-key",
				);
				return keyIndex >= 0 && calls.slice(keyIndex + 1).some((call) => call.cmd === "reload_agent_settings");
			}),
		)
		.toBe(true);

	await page.locator(".chat-tabs .chat-tab").first().click();
	await page.locator(".chat-input").fill("certification probe");
	await page.locator(".chat-input").press("Enter");
	// #572(be28a151): 답을 못 만든 턴은 원문 대신 사용자 말 한 줄 + 다시 시도 + 접힌 원문을
	// role="alert" 로 보인다(ChatArea.tsx ChatErrorNotice). 원문은 Details 를 펼치면 보여야 한다.
	const notice = page.getByRole("alert").filter({ hasText: "I could not finish that answer. Try again?" });
	await expect(notice).toBeVisible({ timeout: 10_000 });
	await expect(notice.getByRole("button", { name: "Try again" })).toBeVisible();
	await notice.getByText("Details").click();
	await expect(notice.getByText("provider rejected the API key")).toBeVisible();
	await expect(page.getByText(/\$0\.000000.*0 tokens/)).toHaveCount(0);
	expect(serverErrors).toEqual([]);
});
