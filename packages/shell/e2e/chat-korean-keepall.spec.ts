import { expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

const LONG_ADDRESS = `https://${"a".repeat(72)}`;
const ASSISTANT_TEXT = `그냥… 우연히 여기 있었을 뿐이야.\n\n${LONG_ADDRESS}`;
const BASELINE_CSS = `
.chat-message.assistant .message-content { word-break: break-word !important; overflow-wrap: normal !important; }
.chat-message.user .message-content { word-break: normal !important; overflow-wrap: normal !important; }
.dm-message-bubble { word-break: break-word !important; overflow-wrap: normal !important; }
`;

const NEW_CORE_FLAG = `window.__NAIA_NEW_CORE__ = true; window.__E2E_OUTBOUND__ = []; window.__E2E_ASSISTANT_TEXT__ = ${JSON.stringify(ASSISTANT_TEXT)};`;
const CONFIG = {
	provider: "gemini",
	model: "gemini-2.5-flash",
	apiKey: "e2e-mock-key",
	enableTools: false,
	locale: "ko",
	onboardingComplete: true,
};
const CONFIG_SCRIPT = `window.__E2E_CONFIG__ = ${JSON.stringify(CONFIG)}; localStorage.setItem("naia-config", ${JSON.stringify(JSON.stringify(CONFIG))});`;

const MOCK_SCRIPT = `
(function () {
  window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
  window.__TAURI_INTERNALS__.metadata = { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } };
  var callbacks = new Map(); var nextCallbackId = 1;
  window.__TAURI_INTERNALS__.transformCallback = function (fn, once) { var id = nextCallbackId++; callbacks.set(id, function (data) { if (once) callbacks.delete(id); return fn && fn(data); }); return id; };
  window.__TAURI_INTERNALS__.unregisterCallback = function (id) { callbacks.delete(id); };
  window.__TAURI_INTERNALS__.runCallback = function (id, data) { var callback = callbacks.get(id); if (callback) callback(data); };
  var listeners = new Map();
  window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function () {};
  function emitEvent(event, payload) { (listeners.get(event) || []).forEach(function (id) { window.__TAURI_INTERNALS__.runCallback(id, { event: event, payload: payload }); }); }
  window.__TAURI_INTERNALS__.convertFileSrc = function (p, proto) { return (proto || "asset") + "://localhost/" + encodeURIComponent(p); };
  window.__NAIA_E2E__ = { emitEvent: emitEvent };
  window.__TAURI_INTERNALS__.invoke = async function (cmd, args) {
    if (cmd === "plugin:event|listen") { if (!listeners.has(args.event)) listeners.set(args.event, []); listeners.get(args.event).push(args.handler); return args.handler; }
    if (cmd === "plugin:event|emit") { emitEvent(args.event, args.payload); return null; }
    if (cmd === "plugin:event|unlisten") return null;
    if (cmd === "read_naia_config") return window.__E2E_CONFIG__ ? JSON.stringify(window.__E2E_CONFIG__) : null;
    if (cmd === "send_to_agent_command") {
      var payload = JSON.parse(args.message);
      window.__E2E_OUTBOUND__.push(payload);
      if (payload && payload.type === "chat_request") {
        setTimeout(function () { emitEvent("agent_response", JSON.stringify({ type: "text", requestId: payload.requestId, text: window.__E2E_ASSISTANT_TEXT__ })); }, 100);
        setTimeout(function () { emitEvent("agent_response", JSON.stringify({ type: "finish", requestId: payload.requestId })); }, 200);
      }
      return null;
    }
    if (cmd === "cancel_stream" || cmd === "send_approval_response") return null;
    return undefined;
  };
})();
`;

test("UC1: 360px 채팅에서 한글 낱말은 함께 줄바꿈하고 긴 주소는 말풍선 안에 둔다", async ({
	page,
}) => {
	test.setTimeout(180_000);
	await page.setViewportSize({ width: 360, height: 760 });
	await page.addInitScript(NEW_CORE_FLAG);
	await page.addInitScript(MOCK_SCRIPT);
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_ADK_PATH });
	await page.addInitScript({ content: CONFIG_SCRIPT });
	await page.goto("/", { waitUntil: "commit" });
	await expect(page.locator(".chat-app")).toBeVisible({ timeout: 120_000 });

	const baseline = process.env.KEEPALL_BASELINE === "1";
	// Keep the viewport at 360px while reproducing the narrow vertical bubble
	// from the report; the normal dock is wide enough for this short answer.
	await page.addStyleTag({
		content: ".chat-message.assistant .message-content { max-width: 105px; }",
	});
	if (baseline) await page.addStyleTag({ content: BASELINE_CSS });

	const input = page.locator(".chat-input");
	await expect(input).toBeEnabled({ timeout: 5_000 });
	await input.fill("대답해줘");
	await input.press("Enter");

	const content = page
		.locator(".chat-message.assistant .message-content")
		.last();
	await expect(content).toContainText("그냥… 우연히 여기 있었을 뿐이야.", {
		timeout: 15_000,
	});
	await expect(content).toContainText(LONG_ADDRESS);

	const shotDir = process.env.KEEPALL_SHOT_DIR;
	if (shotDir)
		await page.screenshot({
			path: `${shotDir}/${baseline ? "before" : "after"}.png`,
			fullPage: true,
		});

	const layout = await content.evaluate((element) => {
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		let phraseNode: Text | null = null;
		while (walker.nextNode()) {
			if (walker.currentNode.textContent?.includes("뿐이야.")) {
				phraseNode = walker.currentNode as Text;
				break;
			}
		}
		if (!phraseNode)
			throw new Error("Could not find the Korean phrase text node");
		const start = phraseNode.textContent!.indexOf("뿐이야.");
		const range = document.createRange();
		range.setStart(phraseNode, start);
		range.setEnd(phraseNode, start + "뿐이야.".length);
		const rects = Array.from(range.getClientRects());
		const topValues = rects.map((rect) => Math.round(rect.top));
		return {
			wordLineCount: new Set(topValues).size,
			wordRects: rects.length,
			clientWidth: (element as HTMLElement).clientWidth,
			scrollWidth: (element as HTMLElement).scrollWidth,
			text: element.textContent,
		};
	});

	expect(
		layout.wordLineCount,
		`뿐이야. must stay on one line; Range rects=${layout.wordRects}`,
	).toBe(1);
	expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
});
