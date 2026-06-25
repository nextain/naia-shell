import { type Page, expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

/**
 * TTS keyless / fallback E2E — the user's report (Claude brain, no naiaKey:
 * "TTS doesn't work / doesn't change").
 *
 * Root cause found by running the real code in Chromium (≈ Windows WebView2):
 *  - edge-tts WS is rejected by MS (browser can't set the required handshake
 *    headers/Origin) → never produced audio.
 *  - nextain needs a naiaKey a Claude-brain user doesn't have.
 * Fix: edge → browser speechSynthesis; any cloud-TTS failure → browser fallback
 * (never silent). This spec verifies the chat path always speaks.
 */

const CHAT_TTS_MOCK = `
(function() {
	window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
	window.__TAURI_INTERNALS__.metadata = { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } };
	var cbs = new Map(); var n = 1;
	window.__TAURI_INTERNALS__.transformCallback = function(fn, once){ var id=n++; cbs.set(id, function(d){ if(once) cbs.delete(id); return fn&&fn(d); }); return id; };
	window.__TAURI_INTERNALS__.unregisterCallback = function(id){ cbs.delete(id); };
	window.__TAURI_INTERNALS__.runCallback = function(id, d){ var cb = cbs.get(id); if (cb) cb(d); };
	var listeners = new Map();
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function(){};
	function emit(ev, p){ (listeners.get(ev)||[]).forEach(function(h){ window.__TAURI_INTERNALS__.runCallback(h, { event: ev, payload: p }); }); }
	window.__TAURI_INTERNALS__.convertFileSrc = function(p, proto){ return (proto||"asset") + "://localhost/" + encodeURIComponent(p); };

	// Record TTS surfaces. speechSynthesis is a read-only getter on window, so it
	// must be replaced via defineProperty (plain assignment is silently ignored).
	window.__TTS_E2E__ = { speakCount: 0, audioPlayed: 0 };
	Object.defineProperty(window, "speechSynthesis", { configurable: true, value: {
		speak: function(u){ window.__TTS_E2E__.speakCount++; setTimeout(function(){ if (u && u.onstart) u.onstart(); if (u && u.onend) u.onend(); }, 10); },
		cancel: function(){}, getVoices: function(){ return []; }, pause: function(){}, resume: function(){},
	}});
	Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, writable: true, value: function(t){ this.text = t; this.lang=""; this.onstart=null; this.onend=null; this.onerror=null; } });
	window.Audio = function(src){ var a={src:src||"",paused:true}; a.play=function(){ if(src&&src.startsWith("data:audio")) window.__TTS_E2E__.audioPlayed++; setTimeout(function(){ if(a.onended) a.onended(); },10); return Promise.resolve(); }; a.pause=function(){}; Object.defineProperty(a,"currentTime",{get:function(){return 0;},set:function(){}}); return a; };

	window.__TAURI_INTERNALS__.invoke = async function(cmd, args){
		if (cmd === "plugin:event|listen"){ if(!listeners.has(args.event)) listeners.set(args.event, []); listeners.get(args.event).push(args.handler); return args.handler; }
		if (cmd === "plugin:event|emit"){ emit(args.event, args.payload); return null; }
		if (cmd === "plugin:event|unlisten") return;
		if (cmd === "send_to_agent_command"){
			var req = JSON.parse(args.message);
			if (req.type === "chat_request"){
				var id = req.requestId;
				var chunks = [{type:"text",requestId:id,text:"안녕하세요. "},{type:"text",requestId:id,text:"반가워요."},{type:"finish",requestId:id}];
				var d = 60;
				chunks.forEach(function(c){ setTimeout(function(){ emit("agent_response", JSON.stringify(c)); }, d); d += 60; });
			}
			return;
		}
		return undefined;
	};
})();
`;

async function setup(page: Page, ttsProvider: string, naiaKey?: string) {
	await page.addInitScript(CHAT_TTS_MOCK);
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_ADK_PATH });
	await page.addInitScript(
		(cfg: string) => localStorage.setItem("naia-config", cfg),
		JSON.stringify({
			provider: "claude-code-cli",
			model: "claude-sonnet-4-6",
			enableTools: false,
			ttsEnabled: true,
			ttsProvider,
			...(naiaKey ? { naiaKey } : {}),
			locale: "ko",
			onboardingComplete: true,
		}),
	);
	// Fail any cloud TTS fetch (simulates no creds / unreachable) so we exercise
	// the browser fallback. Count whether it was even attempted.
	let speechFetches = 0;
	await page.route("**/v1/audio/speech", (route) => {
		speechFetches++;
		return route.fulfill({ status: 401, contentType: "application/json", body: "{}" });
	});
	await page.goto("/");
	await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });
	return () => speechFetches;
}

async function sendAndWait(page: Page) {
	const input = page.locator(".chat-input");
	await expect(input).toBeEnabled({ timeout: 5_000 });
	await input.fill("안녕");
	await input.press("Enter");
	await expect(page.locator(".cursor-blink")).toBeHidden({ timeout: 15_000 });
	await page.waitForTimeout(1200); // allow sentence-TTS dispatch + fallback
}

async function speakCount(page: Page): Promise<number> {
	return page.evaluate(() => (window as any).__TTS_E2E__.speakCount);
}
async function audioPlayedCount(page: Page): Promise<number> {
	return page.evaluate(() => (window as any).__TTS_E2E__.audioPlayed);
}

test.describe("TTS keyless fallback (chat path always speaks)", () => {
	test("edge → bgm sidecar /edge-tts (real neural path) → audio plays", async ({
		page,
	}) => {
		await setup(page, "edge");
		// Sidecar reachable → returns MP3 bytes → AudioQueue plays them.
		await page.route("**/edge-tts**", (route) =>
			route.fulfill({
				status: 200,
				contentType: "audio/mpeg",
				body: Buffer.from([0xff, 0xf3, 0x64, 0xc4, 0x00, 0x01, 0x02]),
			}),
		);
		await sendAndWait(page);
		expect(await audioPlayedCount(page)).toBeGreaterThan(0);
	});

	test("edge → browser fallback when the sidecar is down", async ({ page }) => {
		await setup(page, "edge");
		await page.route("**/edge-tts**", (route) => route.abort());
		await sendAndWait(page);
		// sidecar fetch fails → universal browser fallback speaks (never silent).
		expect(await speakCount(page)).toBeGreaterThan(0);
	});

	test("nextain without naiaKey → browser fallback (never silent)", async ({
		page,
	}) => {
		await setup(page, "nextain");
		await sendAndWait(page);
		// synthNextain throws (no naiaKey) → universal browser fallback speaks.
		expect(await speakCount(page)).toBeGreaterThan(0);
	});
});

test.describe("TTS provider path wiring (real module, no mock)", () => {
	test("nextain without naiaKey throws a clear error", async ({ page }) => {
		await page.addInitScript(CHAT_TTS_MOCK);
		await page.goto("/");
		const r = await page.evaluate(async () => {
			try {
				const mod = await import("/src/lib/tts/synthesize.ts");
				await mod.synthesizeTts({
					text: "안녕",
					provider: "nextain",
					gatewayUrl: "https://api.nextain.io",
				});
				return { ok: true };
			} catch (e) {
				return { ok: false, error: String(e) };
			}
		});
		expect(r.ok).toBe(false);
		expect(r.error).toContain("naiaKey");
	});

	test("google REST path reaches the API (no CORS/wiring break)", async ({
		page,
	}) => {
		await page.addInitScript(CHAT_TTS_MOCK);
		await page.goto("/");
		const r = await page.evaluate(async () => {
			try {
				const mod = await import("/src/lib/tts/synthesize.ts");
				await mod.synthesizeTts({
					text: "hi",
					voice: "ko-KR-Neural2-A",
					provider: "google",
					apiKey: "invalid-key-diag",
				});
				return { ok: true };
			} catch (e) {
				return { ok: false, error: String(e) };
			}
		});
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/Google TTS 실패|4\d\d/);
	});
});
