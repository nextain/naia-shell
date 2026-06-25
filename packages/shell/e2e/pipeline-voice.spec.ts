import { type Page, expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

/**
 * Pipeline Voice E2E — Vosk STT → LLM → Sentence TTS → AudioQueue
 *
 * Prerequisites:
 *   pnpm dev  (Vite serves UI at localhost:1420)
 *
 * Approach:
 *   - Tauri IPC mock (same as chat-tools.spec.ts)
 *   - STT plugin mock: simulates Vosk recognition results via events
 *   - TTS mock: agent responds to tts_request with fake audio data
 *   - Audio mock: HTMLAudioElement captured for playback verification
 */

const API_KEY = "e2e-mock-key";

/**
 * Extended Tauri IPC mock with:
 * - STT plugin simulation (plugin:stt:result, plugin:stt:stateChange events)
 * - TTS request handling (tts_request → audio chunk)
 * - Audio playback tracking
 */
const PIPELINE_VOICE_MOCK = `
(function() {
	window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};

	window.__TAURI_INTERNALS__.metadata = {
		currentWindow: { label: "main" },
		currentWebview: { windowLabel: "main", label: "main" },
	};

	var callbacks = new Map();
	var nextCbId = 1;
	window.__TAURI_INTERNALS__.transformCallback = function(fn, once) {
		var id = nextCbId++;
		callbacks.set(id, function(data) { if (once) callbacks.delete(id); return fn && fn(data); });
		return id;
	};
	window.__TAURI_INTERNALS__.unregisterCallback = function(id) { callbacks.delete(id); };
	window.__TAURI_INTERNALS__.runCallback = function(id, data) { var cb = callbacks.get(id); if (cb) cb(data); };
	window.__TAURI_INTERNALS__.callbacks = callbacks;

	var eventListeners = new Map();
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};

	function emitEvent(event, payload) {
		var handlers = eventListeners.get(event) || [];
		for (var i = 0; i < handlers.length; i++) {
			window.__TAURI_INTERNALS__.runCallback(handlers[i], { event: event, payload: payload });
		}
	}

	window.__TAURI_INTERNALS__.convertFileSrc = function(filePath, protocol) {
		protocol = protocol || "asset";
		return protocol + "://localhost/" + encodeURIComponent(filePath);
	};

	// ---- Pipeline voice test state ----
	window.__NAIA_E2E__ = {
		emitEvent: emitEvent,
		sttListening: false,
		lastSttConfig: null,  // Track engine/modelId passed to start_listening
		audioPlayed: [],      // Track enqueued audio base64 data
		ttsRequests: [],      // Track TTS requests sent to agent
		lastChatRequestId: null,
	};

	// Mock Audio element to track playback without real audio
	window.Audio = function(src) {
		var audio = { src: src || "", paused: true, _ended: false };
		audio.play = function() {
			audio.paused = false;
			if (src && src.startsWith("data:audio")) {
				window.__NAIA_E2E__.audioPlayed.push(src.substring(0, 60));
			}
			// Simulate quick playback completion
			setTimeout(function() {
				audio._ended = true;
				audio.paused = true;
				if (audio.onended) audio.onended();
			}, 50);
			return Promise.resolve();
		};
		audio.pause = function() { audio.paused = true; };
		Object.defineProperty(audio, "currentTime", { get: function() { return 0; }, set: function() {} });
		return audio;
	};

	// ---- Chat response builder ----
	function buildTextResponse(requestId, text) {
		// Split text into streaming chunks for realistic simulation
		var words = text.split("");
		var chunks = [];
		var chunkSize = 5;
		for (var i = 0; i < words.length; i += chunkSize) {
			chunks.push({ type: "text", requestId: requestId, text: words.slice(i, i + chunkSize).join("") });
		}
		chunks.push({ type: "finish", requestId: requestId });
		return chunks;
	}

	// ---- STT plugin mock ----
	// sttStart/sttStop are handled via invoke("plugin:stt|start_listening") etc.
	// STT results are injected via emitSttResult()

	function emitSttResult(transcript, isFinal, confidence) {
		emitEvent("plugin:stt:result", {
			transcript: transcript,
			isFinal: isFinal !== false,
			confidence: confidence || 0.95,
		});
	}

	function emitSttStateChange(state) {
		emitEvent("plugin:stt:stateChange", { state: state });
	}

	// Expose STT simulation controls for test code
	window.__NAIA_E2E__.emitSttResult = emitSttResult;
	window.__NAIA_E2E__.emitSttStateChange = emitSttStateChange;

	// ---- invoke handler ----
	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		// Event system
		if (cmd === "plugin:event|listen") {
			if (!eventListeners.has(args.event)) eventListeners.set(args.event, []);
			eventListeners.get(args.event).push(args.handler);
			return args.handler;
		}
		if (cmd === "plugin:event|emit") {
			emitEvent(args.event, args.payload);
			return null;
		}
		if (cmd === "plugin:event|unlisten") return;

		// STT plugin commands
		if (cmd === "plugin:stt|start_listening") {
			window.__NAIA_E2E__.sttListening = true;
			window.__NAIA_E2E__.lastSttConfig = (args && args.config) || {};
			setTimeout(function() {
				emitSttStateChange("listening");
			}, 100);
			return;
		}
		if (cmd === "plugin:stt|stop_listening") {
			window.__NAIA_E2E__.sttListening = false;
			emitSttStateChange("idle");
			return;
		}
		if (cmd === "plugin:stt|is_available") {
			return { available: true, reason: null };
		}
		if (cmd === "plugin:stt|check_permission") {
			return { microphone: "granted", speechRecognition: "granted" };
		}
		if (cmd === "plugin:stt|request_permission") {
			return { microphone: "granted", speechRecognition: "granted" };
		}
		if (cmd === "plugin:stt|get_supported_languages") {
			return { languages: [
				{ code: "ko-KR", name: "Korean", installed: true },
				{ code: "en-US", name: "English", installed: true },
			]};
		}

		// Agent communication
		if (cmd === "send_to_agent_command") {
			var request = JSON.parse(args.message);

			// TTS is now shell-direct (#363): the shell fetches the gateway
			// /v1/audio/speech directly (no tts_request IPC). The spec mocks that
			// fetch via page.route and verifies playback through AudioQueue
			// (window.Audio → __NAIA_E2E__.audioPlayed).

			// Chat request → stream text response
			if (request.type === "chat_request") {
				var chatReqId = request.requestId;
				window.__NAIA_E2E__.lastChatRequestId = chatReqId;
				var lastMsg = request.messages[request.messages.length - 1];
				var userText = lastMsg.content.toLowerCase();

				// Voice conversation responses (short, 2-3 sentences)
				var response;
				if (userText.indexOf("안녕") !== -1) {
					response = "안녕하세요! 오늘 기분이 어때요?";
				} else if (userText.indexOf("날씨") !== -1) {
					response = "오늘 서울 날씨는 맑고 기온은 15도예요. 외출하기 좋은 날씨네요!";
				} else if (userText.indexOf("이름") !== -1) {
					response = "저는 나이아예요. 반가워요!";
				} else {
					response = "네, 알겠습니다. 더 필요한 게 있으면 말씀해주세요.";
				}

				var chunks = buildTextResponse(chatReqId, response);
				var delay = 100;
				for (var ci = 0; ci < chunks.length; ci++) {
					(function(chunk, d) {
						setTimeout(function() {
							emitEvent("agent_response", JSON.stringify(chunk));
						}, d);
					})(chunks[ci], delay);
					delay += 80;
				}
				return;
			}

			// Cancel
			if (request.type === "cancel_stream") return;
			return;
		}

		if (cmd === "cancel_stream") return;
		if (cmd === "get_progress_data") return { events: [], stats: { totalCost: 0, messageCount: 0, toolCount: 0, errorCount: 0 } };

		// Store plugin (secure store for API keys)
		if (cmd === "plugin:store|load") return 1; // resource ID
		if (cmd === "plugin:store|get") return [null, false]; // [value, exists]
		if (cmd.startsWith("plugin:store|")) return null;

		// Dialog plugin
		if (cmd.startsWith("plugin:dialog|")) return null;

		// Opener plugin
		if (cmd.startsWith("plugin:opener|")) return null;

		// Window commands
		if (cmd.startsWith("plugin:window|")) return null;

		// Deep link
		if (cmd.startsWith("plugin:deep-link|")) return [];

		// Audit/memory DB
		if (cmd === "init_audit_db" || cmd === "init_memory_db") return;
		if (cmd === "query_events") return [];
		if (cmd === "get_all_facts") return [];
		if (cmd === "upsert_fact") return;

		// Log commands
		if (cmd === "get_log_path") return "/tmp/naia-test.log";

		// OpenClaw sync
		if (cmd === "sync_openclaw_config") return;

		// Gateway health
		if (cmd === "check_gateway_health") return false;

		// Window state
		if (cmd === "get_window_state") return { width: 800, height: 600, x: 0, y: 0 };
		if (cmd === "save_window_state") return;

		return undefined;
	};
})();
`;

async function sendMessage(page: Page, text: string) {
	const beforeCount = await page.locator(".chat-message.assistant").count();
	const input = page.locator(".chat-input");
	await expect(input).toBeEnabled({ timeout: 5_000 });
	await input.fill(text);
	await input.press("Enter");

	await Promise.race([
		expect(page.locator(".cursor-blink").first())
			.toBeVisible({ timeout: 10_000 })
			.catch(() => {}),
		expect(page.locator(".chat-message.assistant"))
			.toHaveCount(beforeCount + 1, { timeout: 10_000 })
			.catch(() => {}),
	]);
	await expect(page.locator(".cursor-blink")).toBeHidden({ timeout: 15_000 });
}

/** Inject a simulated STT recognition result. */
async function injectSttResult(
	page: Page,
	transcript: string,
	isFinal = true,
	confidence = 0.95,
) {
	await page.evaluate(
		({ t, f, c }) => {
			(window as any).__NAIA_E2E__.emitSttResult(t, f, c);
		},
		{ t: transcript, f: isFinal, c: confidence },
	);
}

/**
 * TTS synth requests captured from the shell-direct gateway fetch (#363).
 * P2 replaced the `tts_request` IPC (agent had no TTS → silent) with a direct
 * `fetch` to the gateway `/v1/audio/speech`; beforeEach routes that fetch and
 * records each request body here. Reset per test (fullyParallel: false).
 */
let synthRequests: Array<{ input?: string; voice?: string }> = [];

/** Count of shell-direct TTS synth requests. */
function getTtsRequestCount(): number {
	return synthRequests.length;
}

/** Texts sent for synthesis (sentence-level). */
function getTtsTexts(): string[] {
	return synthRequests.map((r) => r.input ?? "");
}

/** Get count of mock audio playback calls. */
async function getAudioPlayCount(page: Page): Promise<number> {
	return page.evaluate(() => (window as any).__NAIA_E2E__.audioPlayed.length);
}

/** Check if mock STT is in listening mode. */
async function isSttListening(page: Page): Promise<boolean> {
	return page.evaluate(() => (window as any).__NAIA_E2E__.sttListening);
}

/**
 * Route the shell-direct gateway TTS fetch (#363) to a deterministic fake and
 * record request bodies. Must be set before navigation. Resets synthRequests.
 */
async function routeTtsSynth(page: Page): Promise<void> {
	synthRequests = [];
	await page.route("**/v1/audio/speech", async (route) => {
		try {
			synthRequests.push(route.request().postDataJSON() as { input?: string });
		} catch {
			synthRequests.push({});
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			// ID3-tagged fake base64 (not WAV "UklGR") → AudioQueue plays as mp3.
			body: JSON.stringify({
				audio_content: "SUQzBAAAAAAAI1RTU0UAAAA",
				cost_usd: 0.001,
			}),
		});
	});
}

test.describe("Pipeline Voice E2E", () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(PIPELINE_VOICE_MOCK);
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
		await page.addInitScript({ content: SEED_ADK_PATH });

		// Config: LLM model (non-omni) so pipeline voice activates
		await page.addInitScript(
			(configJson: string) => {
				localStorage.setItem("naia-config", configJson);
			},
			JSON.stringify({
				provider: "gemini",
				model: "gemini-2.5-flash", // LLM model, not omni
				apiKey: API_KEY,
				enableTools: false,
				sttProvider: "vosk",
				sttModel: "vosk-model-small-ko-0.22",
				ttsEnabled: true,
				ttsProvider: "nextain",
				naiaKey: API_KEY,
				locale: "ko",
				onboardingComplete: true,
			}),
		);

		await routeTtsSynth(page);
		await page.goto("/");
		await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });
	});

	test("음성 버튼 — pipeline voice 모드 시작", async ({ page }) => {
		const voiceBtn = page.locator(".chat-voice-btn");
		await expect(voiceBtn).toBeVisible();

		await voiceBtn.click();

		// Should transition to active state
		await expect(voiceBtn).toHaveClass(/active/, { timeout: 5_000 });

		// Welcome message was removed in 7ba9fff0 — voice mode starts silently.
		// Verify placeholder text changes to listening state instead.
		const input = page.locator(".chat-input");
		await expect(input).toHaveAttribute(
			"placeholder",
			/듣고 있어요|텍스트 입력/,
			{ timeout: 5_000 },
		);

		// STT should be listening
		expect(await isSttListening(page)).toBe(true);
	});

	test("음성 버튼 — 토글 off", async ({ page }) => {
		const voiceBtn = page.locator(".chat-voice-btn");
		await voiceBtn.click();
		await expect(voiceBtn).toHaveClass(/active/, { timeout: 5_000 });

		// Click again to stop
		await voiceBtn.click();
		await expect(voiceBtn).not.toHaveClass(/active/, { timeout: 3_000 });
		await expect(voiceBtn).not.toHaveClass(/connecting/, { timeout: 3_000 });

		// STT should stop
		expect(await isSttListening(page)).toBe(false);
	});

	test("pipeline 모드에서 텍스트 입력 가능", async ({ page }) => {
		const voiceBtn = page.locator(".chat-voice-btn");
		await voiceBtn.click();
		await expect(voiceBtn).toHaveClass(/active/, { timeout: 5_000 });

		// Textarea should still be enabled in pipeline mode
		const input = page.locator(".chat-input");
		await expect(input).toBeEnabled();

		// Send a message via text
		await sendMessage(page, "안녕");

		// Should get response
		const msgs = page.locator(".chat-message.assistant .message-content");
		const lastMsg = msgs.last();
		await expect(lastMsg).toContainText("기분", { timeout: 10_000 });
	});

	test("STT 인식 → 자동 전송 → LLM 응답 → TTS", async ({ page }) => {
		const voiceBtn = page.locator(".chat-voice-btn");
		await voiceBtn.click();
		await expect(voiceBtn).toHaveClass(/active/, { timeout: 5_000 });

		// Simulate STT partial result (interim)
		await injectSttResult(page, "오늘 날", false);
		// Partial transcript should show in UI
		const sttPartial = page.locator(".stt-partial");
		await expect(sttPartial).toContainText("오늘 날", { timeout: 3_000 });

		// Simulate STT final result
		await injectSttResult(page, "오늘 날씨 어때", true);

		// Partial should clear
		await expect(sttPartial).toBeHidden({ timeout: 3_000 });

		// Wait for debounce (1000ms) + message send + response
		await page.waitForTimeout(1500);

		// User message should appear
		const userMsg = page.locator(".chat-message.user .message-content");
		await expect(userMsg.last()).toContainText("날씨", { timeout: 5_000 });

		// Assistant response should appear
		await expect(page.locator(".cursor-blink")).toBeHidden({ timeout: 15_000 });
		const assistantMsg = page.locator(
			".chat-message.assistant .message-content",
		);
		await expect(assistantMsg.last()).toContainText("날씨", { timeout: 5_000 });

		// TTS requests should have been made (sentence-level)
		const ttsCount = getTtsRequestCount();
		expect(ttsCount).toBeGreaterThan(0);

		// Audio should have been played
		const audioCount = await getAudioPlayCount(page);
		expect(audioCount).toBeGreaterThan(0);
	});

	test("STT 다중 발화 디바운스 병합", async ({ page }) => {
		const voiceBtn = page.locator(".chat-voice-btn");
		await voiceBtn.click();
		await expect(voiceBtn).toHaveClass(/active/, { timeout: 5_000 });

		// Send two quick final results within debounce window (300ms)
		await injectSttResult(page, "내", true);
		await page.waitForTimeout(100); // Well within 300ms debounce
		await injectSttResult(page, "이름이 뭐야", true);

		// Wait for debounce (300ms) + send + LLM response
		await page.waitForTimeout(2500);

		// Should merge into one user message containing both parts
		const userMsg = page.locator(".chat-message.user .message-content");
		await expect(userMsg.last()).toContainText("이름", { timeout: 5_000 });

		// Response should mention name
		await expect(page.locator(".cursor-blink")).toBeHidden({ timeout: 15_000 });
		const assistantMsg = page.locator(
			".chat-message.assistant .message-content",
		);
		await expect(assistantMsg.last()).toContainText("나이아", {
			timeout: 5_000,
		});
	});

	test("음성 대화 중 인터럽트", async ({ page }) => {
		const voiceBtn = page.locator(".chat-voice-btn");
		await voiceBtn.click();
		await expect(voiceBtn).toHaveClass(/active/, { timeout: 5_000 });

		// Start a conversation
		await injectSttResult(page, "안녕하세요", true);
		await page.waitForTimeout(1500);

		// Wait for response to start streaming (no welcome message — voice mode starts silently)
		await expect(page.locator(".chat-message.assistant")).toHaveCount(1, {
			timeout: 10_000,
		});

		// Now "interrupt" by speaking — wait for TTS playback + echo cooldown (800ms)
		// Mock TTS plays in ~50ms, so total cooldown ends ~850ms after response finishes.
		// Wait generously to avoid race conditions.
		await page.waitForTimeout(3000);
		await injectSttResult(page, "잠깐만", true);

		// Should get a new user message from the interrupt
		const userMsgs = page.locator(".chat-message.user .message-content");
		await expect(userMsgs.last()).toContainText("잠깐만", { timeout: 8_000 });
	});

	test("TTS 문장 분리 — 긴 응답이 문장별로 TTS 요청", async ({ page }) => {
		const voiceBtn = page.locator(".chat-voice-btn");
		await voiceBtn.click();
		await expect(voiceBtn).toHaveClass(/active/, { timeout: 5_000 });

		// Send message that triggers a response with multiple sentences
		await injectSttResult(page, "오늘 날씨 알려줘", true);

		// Wait for full response + TTS
		await page.waitForTimeout(3000);
		await expect(page.locator(".cursor-blink")).toBeHidden({ timeout: 15_000 });

		// Check TTS request texts — should be sentence-level chunks
		const ttsTexts = getTtsTexts();
		expect(ttsTexts.length).toBeGreaterThan(0);

		// Each TTS text should be a reasonable sentence length
		for (const text of ttsTexts) {
			expect(text.length).toBeGreaterThan(0);
			expect(text.length).toBeLessThanOrEqual(150); // max ~120 chars + buffer
		}
	});

	test("pipeline 종료 후 일반 채팅 복귀", async ({ page }) => {
		const voiceBtn = page.locator(".chat-voice-btn");
		await voiceBtn.click();
		await expect(voiceBtn).toHaveClass(/active/, { timeout: 5_000 });

		// Stop pipeline
		await voiceBtn.click();
		await expect(voiceBtn).not.toHaveClass(/active/, { timeout: 3_000 });

		// Normal chat should still work after pipeline stopped
		await sendMessage(page, "안녕");
		const assistantMsg = page.locator(
			".chat-message.assistant .message-content",
		);
		await expect(assistantMsg.last()).toContainText("기분", {
			timeout: 10_000,
		});

		// After TTS unification (52225fc5), chat TTS is active when ttsEnabled: true.
		// Wait for async TTS request to be dispatched, then verify.
		await page.waitForTimeout(1000);
		const ttsCount = getTtsRequestCount();
		expect(ttsCount).toBeGreaterThan(0);
	});
});

test.describe("Whisper Engine E2E", () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(PIPELINE_VOICE_MOCK);
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
		await page.addInitScript({ content: SEED_ADK_PATH });

		// Config: Whisper STT engine with whisper-medium model
		await page.addInitScript(
			(configJson: string) => {
				localStorage.setItem("naia-config", configJson);
			},
			JSON.stringify({
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: API_KEY,
				enableTools: false,
				sttProvider: "whisper",
				sttModel: "whisper-medium",
				ttsEnabled: true,
				ttsProvider: "nextain",
				naiaKey: API_KEY,
				locale: "ko",
				onboardingComplete: true,
			}),
		);

		await routeTtsSynth(page);
		await page.goto("/");
		await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });
	});

	test("Whisper — pipeline voice 모드 시작/종료", async ({ page }) => {
		const voiceBtn = page.locator(".chat-voice-btn");
		await expect(voiceBtn).toBeVisible();
		await voiceBtn.click();

		await expect(voiceBtn).toHaveClass(/active/, { timeout: 5_000 });
		expect(await isSttListening(page)).toBe(true);

		// Verify engine/modelId passed to STT start
		const sttConfig = await page.evaluate(
			() => (window as any).__NAIA_E2E__.lastSttConfig,
		);
		expect(sttConfig?.engine).toBe("whisper");
		expect(sttConfig?.modelId).toBe("whisper-medium");

		// Stop
		await voiceBtn.click();
		await expect(voiceBtn).not.toHaveClass(/active/, { timeout: 3_000 });
		expect(await isSttListening(page)).toBe(false);
	});

	test("Whisper — STT 인식 → LLM 응답 → TTS", async ({ page }) => {
		const voiceBtn = page.locator(".chat-voice-btn");
		await voiceBtn.click();
		await expect(voiceBtn).toHaveClass(/active/, { timeout: 5_000 });

		await injectSttResult(page, "오늘 날씨 어때", true);
		await page.waitForTimeout(1500);

		const userMsg = page.locator(".chat-message.user .message-content");
		await expect(userMsg.last()).toContainText("날씨", { timeout: 5_000 });

		await expect(page.locator(".cursor-blink")).toBeHidden({ timeout: 15_000 });
		const assistantMsg = page.locator(
			".chat-message.assistant .message-content",
		);
		await expect(assistantMsg.last()).toContainText("날씨", { timeout: 5_000 });

		const ttsCount = getTtsRequestCount();
		expect(ttsCount).toBeGreaterThan(0);
	});
});
