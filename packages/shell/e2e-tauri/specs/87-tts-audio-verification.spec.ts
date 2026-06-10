import { S } from "../helpers/selectors.js";
import {
	ensureAppReady,
	navigateToSettings,
	scrollToSection,
} from "../helpers/settings.js";

/**
 * 87 — TTS Audio Verification E2E
 *
 * Verifies that TTS ACTUALLY produces audio data after chat.
 * NOT just "no error" — checks that:
 * 1. Agent returns audio data (base64)
 * 2. Audio.play() is called
 * 3. Works for each TTS provider
 *
 * Method: inject agent_response listener to count audio events.
 */

const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const ELEVENLABS_KEY =
	process.env.ELEVENLABS_API_KEY ?? process.env.ELEVENLAPS_API_KEY ?? "";
const GOOGLE_KEY = process.env.GEMINI_API_KEY ?? "";

/** Inject audio tracking before each test */
async function injectAudioTracker() {
	await browser.execute(() => {
		(window as any).__TTS_AUDIO_EVENTS__ = 0;
		(window as any).__TTS_AUDIO_SIZES__ = [];

		// Listen for agent_response events containing audio
		const origAddEventListener = EventTarget.prototype.addEventListener;
		if (!(window as any).__AUDIO_TRACKER_INSTALLED__) {
			(window as any).__AUDIO_TRACKER_INSTALLED__ = true;

			// Patch Audio constructor to track play() calls
			const OrigAudio = window.Audio;
			(window as any).__OrigAudio__ = OrigAudio;
			window.Audio = ((src?: string) => {
				const audio = new OrigAudio(src);
				const origPlay = audio.play.bind(audio);
				audio.play = () => {
					if (src?.includes("base64")) {
						(window as any).__TTS_AUDIO_EVENTS__++;
						(window as any).__TTS_AUDIO_SIZES__.push(src.length);
					}
					return origPlay();
				};
				return audio;
			}) as any;
		}
	});
}

/** Get audio event count */
async function getAudioCount(): Promise<number> {
	return browser.execute(() => (window as any).__TTS_AUDIO_EVENTS__ ?? 0);
}

/** Reset audio counter */
async function resetAudioCounter() {
	await browser.execute(() => {
		(window as any).__TTS_AUDIO_EVENTS__ = 0;
		(window as any).__TTS_AUDIO_SIZES__ = [];
	});
}

/** Configure TTS provider by writing directly to localStorage config */
async function setTtsProvider(providerId: string, apiKey?: string) {
	await browser.execute(
		(provider: string, key: string | null) => {
			const cfg = JSON.parse(localStorage.getItem("naia-config") ?? "{}");
			cfg.ttsEnabled = true;
			cfg.ttsProvider = provider;
			// Reset voice to provider default — prevent cross-provider voice contamination
			cfg.ttsVoice = "";
			if (provider === "openai" && key) cfg.openaiTtsApiKey = key;
			if (provider === "elevenlabs" && key) cfg.elevenlabsApiKey = key;
			if (provider === "google" && key) cfg.googleApiKey = key;
			localStorage.setItem("naia-config", JSON.stringify(cfg));
		},
		providerId,
		apiKey ?? null,
	);
	// Brief pause for React to pick up localStorage change on next render
	await browser.pause(500);
}

/** Send chat message and wait for response */
async function chatAndWait(text: string) {
	await browser.execute(
		(sel: string) => (document.querySelector(sel) as HTMLElement)?.click(),
		S.chatTab,
	);
	const chatInput = await $(S.chatInput);
	await chatInput.waitForDisplayed({ timeout: 5_000 });

	await browser.execute(
		(sel: string, val: string) => {
			const textarea = document.querySelector(sel) as HTMLTextAreaElement;
			if (!textarea) return;
			const setter = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)?.set;
			setter?.call(textarea, val);
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		},
		S.chatInput,
		text,
	);
	await browser.pause(100);
	await browser.execute(
		(sel: string) =>
			(document.querySelector(sel) as HTMLButtonElement)?.click(),
		S.chatSendBtn,
	);

	// Wait for response to finish
	await browser.waitUntil(
		async () => browser.execute(() => !document.querySelector(".cursor-blink")),
		{ timeout: 60_000, timeoutMsg: "Chat response timeout" },
	);

	// Wait for TTS audio to arrive (SentenceChunker → requestTts → agent → audio)
	await browser
		.waitUntil(
			async () => {
				const count = await browser.execute(
					() => (window as any).__TTS_AUDIO_EVENTS__ ?? 0,
				);
				return count > 0;
			},
			{ timeout: 30_000, timeoutMsg: "No TTS audio received within 30s" },
		)
		.catch(() => {
			// Timeout is ok — we'll check count in the test assertion
		});
}

describe("87 — TTS audio verification", () => {
	before(async () => {
		await ensureAppReady();
		await injectAudioTracker();
	});

	// ── Edge TTS (free, must always produce audio) ──

	it("Edge TTS: chat produces audio data", async () => {
		await setTtsProvider("edge");
		await resetAudioCounter();
		await chatAndWait("한마디만.");

		const count = await getAudioCount();
		console.log(`[Edge TTS] Audio events: ${count}`);
		expect(count).toBeGreaterThan(0);
	});

	// ── OpenAI TTS ──

	it("OpenAI TTS: chat produces audio data", async () => {
		if (!OPENAI_KEY) {
			console.log("[SKIP] no OPENAI_API_KEY");
			return;
		}
		await setTtsProvider("openai", OPENAI_KEY);

		// Verify config was saved correctly
		const savedConfig = await browser.execute(() => {
			const cfg = JSON.parse(localStorage.getItem("naia-config") ?? "{}");
			return {
				ttsProvider: cfg.ttsProvider,
				ttsVoice: cfg.ttsVoice,
				openaiTtsApiKey: cfg.openaiTtsApiKey?.slice(0, 5),
			};
		});
		console.log("[OpenAI config]", JSON.stringify(savedConfig));

		await resetAudioCounter();
		await chatAndWait("한마디만.");

		const count = await getAudioCount();
		console.log(`[OpenAI TTS] Audio events: ${count}`);
		expect(count).toBeGreaterThan(0);
	});

	// ── Google Cloud TTS ──

	it("Google Cloud TTS: chat produces audio data", async () => {
		if (!GOOGLE_KEY) {
			console.log("[SKIP] no GEMINI_API_KEY");
			return;
		}
		await setTtsProvider("google", GOOGLE_KEY);
		await resetAudioCounter();
		await chatAndWait("한마디만.");

		const count = await getAudioCount();
		console.log(`[Google TTS] Audio events: ${count}`);
		expect(count).toBeGreaterThan(0);
	});

	// ── ElevenLabs TTS ──

	it("ElevenLabs TTS: chat produces audio data", async () => {
		if (!ELEVENLABS_KEY) {
			console.log("[SKIP] no ELEVENLABS_API_KEY");
			return;
		}
		await setTtsProvider("elevenlabs", ELEVENLABS_KEY);
		await resetAudioCounter();
		await chatAndWait("한마디만.");

		const count = await getAudioCount();
		console.log(`[ElevenLabs TTS] Audio events: ${count}`);
		expect(count).toBeGreaterThan(0);
	});

	// ── Cleanup ──

	it("should restore edge and navigate back", async () => {
		await setTtsProvider("edge");
		await browser.execute(
			(sel: string) => (document.querySelector(sel) as HTMLElement)?.click(),
			S.chatTab,
		);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
