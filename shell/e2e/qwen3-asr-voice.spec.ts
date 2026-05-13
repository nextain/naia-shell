import { existsSync, readFileSync } from "node:fs";
import { type Page, expect, test } from "@playwright/test";

/**
 * vLLM STT E2E (Qwen3-ASR-1.7B)
 *
 * Tests the full pipeline through Naia app:
 *   getUserMedia (WAV injection) → AudioContext (ScriptProcessor, SW gain 0.3)
 *   → PCM → WAV → vLLM /v1/audio/transcriptions → ChatPanel user message
 *
 * Prerequisites:
 *   - pnpm dev running (localhost:1420)
 *   - vLLM server at localhost:8100 with Qwen/Qwen3-ASR-1.7B
 *   - /tmp/test-ko.wav (Korean speech: "안녕하세요 테스트입니다.")
 *
 * Key fix verified:
 *   - GainNode removed from audio graph (caused WebKitGTK buffer freeze)
 *   - SW_GAIN = 0.3 applied in onaudioprocess callback instead
 */

const VLLM_HOST = "http://localhost:8100";

const TEST_WAV_PATH = "/tmp/test-ko.wav";
const TEST_WAV_AVAILABLE = existsSync(TEST_WAV_PATH);
const TEST_WAV_BASE64 = TEST_WAV_AVAILABLE
	? readFileSync(TEST_WAV_PATH).toString("base64")
	: "";

const AUDIO_INJECT_SCRIPT = (wavB64: string) => `
(function() {
	const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
	navigator.mediaDevices.getUserMedia = async function(constraints) {
		if (!constraints || !constraints.audio) return origGetUserMedia(constraints);
		try {
			const audioCtx = new AudioContext({ sampleRate: 16000 });
			const wavBytes = Uint8Array.from(atob(${JSON.stringify(wavB64)}), (c) => c.charCodeAt(0));
			const audioBuffer = await audioCtx.decodeAudioData(wavBytes.buffer.slice(0));
			const source = audioCtx.createBufferSource();
			source.buffer = audioBuffer;
			source.loop = true;
			const dest = audioCtx.createMediaStreamDestination();
			source.connect(dest);
			source.start();
			return dest.stream;
		} catch (e) {
			return origGetUserMedia(constraints);
		}
	};
})();
`;

const TAURI_MOCK = `
(function() {
	window.__TAURI_INTERNALS__ = {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {};
	window.__TAURI_INTERNALS__.metadata = {
		currentWindow: { label: "main" },
		currentWebview: { windowLabel: "main", label: "main" },
	};
	var cbs = new Map(); var n = 1;
	window.__TAURI_INTERNALS__.transformCallback = function(fn, once) {
		var id = n++; cbs.set(id, function(d) { if (once) cbs.delete(id); return fn && fn(d); }); return id;
	};
	window.__TAURI_INTERNALS__.unregisterCallback = function(id) { cbs.delete(id); };
	window.__TAURI_INTERNALS__.runCallback = function(id, data) { var cb = cbs.get(id); if (cb) cb(data); };
	window.__TAURI_INTERNALS__.callbacks = cbs;
	window.__TAURI_INTERNALS__.convertFileSrc = function(p) { return p; };
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};
	var evts = new Map();
	function emit(event, payload) {
		var hs = evts.get(event) || [];
		for (var h of hs) window.__TAURI_INTERNALS__.runCallback(h, { event: event, payload: payload });
	}
	window.__NAIA_E2E__ = { chatRequests: [], transcripts: [] };

	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		if (cmd === "plugin:event|listen") {
			if (!evts.has(args.event)) evts.set(args.event, []);
			evts.get(args.event).push(args.handler);
			return args.handler;
		}
		if (cmd === "plugin:event|emit") { emit(args.event, args.payload); return null; }
		if (cmd === "plugin:event|unlisten") return;
		if (cmd === "plugin:stt|is_available") return { available: false, reason: "vllm uses JS" };
		if (cmd === "plugin:stt|check_permission") return { microphone: "granted", speechRecognition: "granted" };
		if (cmd === "plugin:stt|request_permission") return { microphone: "granted", speechRecognition: "granted" };
		if (cmd === "plugin:stt|get_supported_languages") return { languages: [] };
		if (cmd === "send_to_agent_command") {
			var msg = JSON.parse(args.message);
			if (msg.type === "chat_request") {
				var last = msg.messages[msg.messages.length-1];
				window.__NAIA_E2E__.chatRequests.push(last.content);
				var rid = msg.requestId;
				setTimeout(function() {
					emit("agent_response", JSON.stringify({ type: "text", requestId: rid, text: "확인." }));
					setTimeout(function() { emit("agent_response", JSON.stringify({ type: "finish", requestId: rid })); }, 50);
				}, 100);
			}
			if (msg.type === "tts_request") {
				setTimeout(function() { emit("agent_response", JSON.stringify({ type: "finish", requestId: msg.requestId })); }, 50);
			}
			if (msg.type === "cancel_stream") return;
			return;
		}
		if (cmd === "cancel_stream") return;
		if (cmd === "get_progress_data") return { events: [], stats: { totalCost: 0, messageCount: 0, toolCount: 0, errorCount: 0 } };
		if (cmd === "plugin:store|load") return 1;
		if (cmd === "plugin:store|get") return [null, false];
		if (cmd.startsWith("plugin:store|")) return null;
		if (cmd.startsWith("plugin:dialog|")) return null;
		if (cmd.startsWith("plugin:opener|")) return null;
		if (cmd.startsWith("plugin:window|")) return null;
		if (cmd.startsWith("plugin:deep-link|")) return [];
		if (cmd === "init_audit_db" || cmd === "init_memory_db") return;
		if (cmd === "query_events") return [];
		if (cmd === "get_all_facts") return [];
		if (cmd === "upsert_fact") return;
		if (cmd === "get_log_path") return "/tmp/naia-e2e-test.log";
		if (cmd === "sync_openclaw_config") return;
		if (cmd === "check_gateway_health") return false;
		if (cmd === "get_window_state") return { width: 800, height: 600, x: 0, y: 0 };
		if (cmd === "save_window_state") return;
		if (cmd === "workspace_list_dirs") return [];
		if (cmd === "workspace_get_sessions") return [];
		if (cmd === "workspace_classify_dirs") return [];
		if (cmd === "workspace_read_file") return "";
		if (cmd === "panel_list_installed") return [];
		if (cmd === "list_audio_output_devices") return [];
		if (cmd === "list_audio_input_devices") return [];
		return undefined;
	};
})();
`;

async function setupPage(page: Page) {
	await page.addInitScript(AUDIO_INJECT_SCRIPT(TEST_WAV_BASE64));
	await page.addInitScript(TAURI_MOCK);
	await page.addInitScript(
		(cfg: string) => localStorage.setItem("naia-config", cfg),
		JSON.stringify({
			provider: "vllm",
			model: "Qwen/Qwen3-ASR-1.7B",
			vllmHost: VLLM_HOST,
			sttProvider: "vllm",
			vllmSttHost: VLLM_HOST,
			vllmSttModel: "Qwen/Qwen3-ASR-1.7B",
			enableTools: false,
			ttsEnabled: false,
			ttsProvider: "edge",
			locale: "ko",
			onboardingComplete: true,
		}),
	);
	await page.goto("/");
	await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });
}

test.describe("vLLM STT E2E (Qwen3-ASR-1.7B)", () => {
	test.skip(
		!TEST_WAV_AVAILABLE,
		`requires ${TEST_WAV_PATH} (Korean WAV: "안녕하세요 테스트입니다.")`,
	);

	test("vLLM 서버 직접 접근 확인", async ({ page }) => {
		const result = await page.evaluate(async (host) => {
			try {
				const resp = await fetch(`${host}/v1/models`);
				if (!resp.ok) return { ok: false, status: resp.status };
				const data = await resp.json();
				return {
					ok: true,
					models: data.data?.map((m: { id: string }) => m.id) ?? [],
				};
			} catch (e) {
				return { ok: false, error: String(e) };
			}
		}, VLLM_HOST);

		expect(result.ok).toBe(true);
		const models = (result as any).models as string[];
		expect(models.some((m) => m.toLowerCase().includes("qwen"))).toBe(true);
	});

	test("API-based STT: 마이크 캡처 → vLLM 전사 → 채팅 전송", async ({
		page,
	}) => {
		await setupPage(page);

		const voiceBtn = page.locator(".chat-voice-btn");
		await expect(voiceBtn).toBeVisible({ timeout: 5_000 });
		await voiceBtn.click();

		await expect(voiceBtn).toHaveClass(/active|connecting/, { timeout: 8_000 });

		// Wait for 2 transcription cycles (3s each + API latency)
		await page.waitForTimeout(8_500);

		const chatRequests = await page.evaluate(
			() => (window as any).__NAIA_E2E__.chatRequests as string[],
		);

		expect(chatRequests.length).toBeGreaterThan(0);
		const allText = chatRequests.join(" ");
		expect(allText).toMatch(/[\uAC00-\uD7A3]/);
		expect(allText).toMatch(/안녕|테스트/);
	});

	test("STT 결과가 사용자 메시지로 UI에 표시", async ({ page }) => {
		await setupPage(page);

		const voiceBtn = page.locator(".chat-voice-btn");
		await voiceBtn.click();
		await expect(voiceBtn).toHaveClass(/active|connecting/, { timeout: 8_000 });

		await page.waitForTimeout(10_000);

		const userMsgs = page.locator(".chat-message.user .message-content");
		const count = await userMsgs.count();
		expect(count).toBeGreaterThan(0);

		const lastText = await userMsgs.last().textContent();
		expect(lastText).toMatch(/[\uAC00-\uD7A3]/);
	});

	test("SW gain 적용 확인 — audio chunk rms ≠ peak (비상수 신호)", async ({
		page,
	}) => {
		const audioStats: Array<{ rms: number; peak: number }> = [];
		page.on("console", (msg) => {
			const text = msg.text();
			const m = text.match(/"rms":(\d+),"peak":(\d+)/);
			if (m && text.includes("transcribeChunk called")) {
				audioStats.push({ rms: Number(m[1]), peak: Number(m[2]) });
			}
		});

		await setupPage(page);
		const voiceBtn = page.locator(".chat-voice-btn");
		await voiceBtn.click();
		await expect(voiceBtn).toHaveClass(/active|connecting/, { timeout: 8_000 });

		await page.waitForTimeout(8_000);

		expect(audioStats.length).toBeGreaterThan(0);
		for (const stat of audioStats) {
			expect(stat.rms).toBeLessThan(stat.peak);
			// Above silence threshold — headless Playwright/Chromium gives lower amplitude than Tauri/WebKitGTK
			expect(stat.rms).toBeGreaterThan(50);
		}
	});
});
