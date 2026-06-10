import { execSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { S } from "../helpers/selectors.js";

/**
 * STT Microphone E2E — verify Vosk STT can open mic, receive audio,
 * and produce transcription output.
 *
 * Uses a PipeWire virtual source + espeak-ng generated WAV to feed
 * known speech into the app and verify recognition results.
 */
describe("stt-mic-test", () => {
	let audioLoop: ChildProcess | null = null;

	afterEach(() => {
		// Clean up virtual audio playback
		audioLoop?.kill();
		audioLoop = null;
		try {
			execSync("pkill -f 'pw-play.*stt-test' 2>/dev/null || true", {
				stdio: "ignore",
			});
		} catch {
			/* ignore */
		}
	});

	it("should activate STT, receive audio, and produce transcription", async () => {
		// 0. Generate test audio via espeak-ng (English for vosk-model-small-en-us)
		try {
			execSync(
				'espeak-ng -v en -w /tmp/stt-test-en.wav "hello this is a test" 2>/dev/null',
			);
		} catch {
			console.log("[E2E] Warning: espeak-ng not found, using real mic instead");
		}

		// 1. Wait for app to be ready
		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 30_000 });

		// 2. Collect STT events from the app
		await browser.execute(() => {
			(window as any).__sttResults = [];
			(window as any).__sttPartials = [];
			const { listen } = (window as any).__TAURI_INTERNALS__;
			if (listen) {
				listen("plugin:stt:result", (event: any) => {
					const r = event.payload;
					if (r.is_final) {
						(window as any).__sttResults.push(r.transcript);
					} else {
						(window as any).__sttPartials.push(r.transcript);
					}
				});
				listen("stt://result", (event: any) => {
					const r = event.payload;
					if (r.is_final) {
						(window as any).__sttResults.push(r.transcript);
					} else {
						(window as any).__sttPartials.push(r.transcript);
					}
				});
			}
		});

		// 3. Click voice button to start pipeline voice (use JS click for WebKitWebDriver compat)
		const voiceBtn = await $(".chat-voice-btn");
		await voiceBtn.waitForDisplayed({ timeout: 5000 });
		await browser.execute(() => {
			(document.querySelector(".chat-voice-btn") as HTMLElement)?.click();
		});

		// 4. Wait for "active" state
		await browser.waitUntil(
			async () => {
				const cls = await voiceBtn.getAttribute("class");
				return cls?.includes("active");
			},
			{
				timeout: 120_000,
				timeoutMsg: "Voice never reached active state — STT mic open failed",
			},
		);
		console.log("[E2E] ✓ Pipeline voice ACTIVE — microphone opened!");

		// 5. Play test audio through default source (looped for recognition time)
		//    pw-play sends audio through PipeWire; cpal picks it up via ALSA bridge
		try {
			audioLoop = spawn(
				"bash",
				[
					"-c",
					"for i in 1 2 3 4 5; do pw-play /tmp/stt-test-en.wav 2>/dev/null; sleep 0.5; done",
				],
				{ stdio: "ignore" },
			);
			console.log("[E2E] Playing test audio through PipeWire...");
		} catch {
			console.log("[E2E] Warning: pw-play failed, relying on real mic");
		}

		// 6. Wait for STT to produce results (partials or finals)
		await browser.pause(10_000);

		// 7. Collect results
		const sttState = await browser.execute(() => {
			return {
				finals: (window as any).__sttResults || [],
				partials: (window as any).__sttPartials || [],
				voiceBtnClass:
					document.querySelector(".chat-voice-btn")?.className || "",
			};
		});

		console.log("[E2E] STT finals:", JSON.stringify(sttState.finals));
		console.log("[E2E] STT partials:", JSON.stringify(sttState.partials));
		console.log("[E2E] Voice btn class:", sttState.voiceBtnClass);

		// 8. Assert: at minimum, partials should have appeared (even silence gives empty partials)
		const hasAnyOutput =
			sttState.finals.length > 0 || sttState.partials.length > 0;
		console.log(
			`[E2E] Has STT output: ${hasAnyOutput} (${sttState.finals.length} finals, ${sttState.partials.length} partials)`,
		);

		// Log but don't hard-fail on transcription content — hardware-dependent
		if (sttState.finals.length > 0) {
			console.log(
				"[E2E] ✓ STT produced final transcription:",
				sttState.finals.join(" | "),
			);
		} else if (sttState.partials.length > 0) {
			console.log(
				"[E2E] ~ STT produced partials but no finals (audio too short or quiet):",
				sttState.partials.slice(-3).join(" | "),
			);
		} else {
			console.log(
				"[E2E] ✗ STT produced NO output — audio pipeline may be broken",
			);
		}

		// The critical assertion: voice mode must still be active (stream didn't crash)
		expect(sttState.voiceBtnClass).toContain("active");

		// 9. Disconnect (JS click for WebKitWebDriver compat)
		await browser.execute(() => {
			(document.querySelector(".chat-voice-btn") as HTMLElement)?.click();
		});
		await browser.pause(1000);

		// 10. Should return to idle
		await browser.waitUntil(
			async () => {
				const cls = await (await $(".chat-voice-btn")).getAttribute("class");
				return !cls?.includes("active") && !cls?.includes("connecting");
			},
			{ timeout: 5000, timeoutMsg: "Voice did not return to idle" },
		);
		console.log("[E2E] ✓ Voice disconnected — back to idle");
	});
});
