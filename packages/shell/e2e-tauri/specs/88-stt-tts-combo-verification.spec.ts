import { S } from "../helpers/selectors.js";
import {
	ensureAppReady,
	navigateToSettings,
	scrollToSection,
} from "../helpers/settings.js";

/**
 * 88 — STT×TTS Provider Combo Verification E2E
 *
 * Tests all STT×TTS provider combinations that have API keys available.
 * For each combo:
 * 1. Set STT + TTS providers via localStorage
 * 2. Click voice button → verify STT initializes (active state)
 * 3. Deactivate
 *
 * Provider combos tested:
 * - google STT × edge TTS
 * - google STT × openai TTS
 * - google STT × google TTS
 * - google STT × elevenlabs TTS
 * - elevenlabs STT × edge TTS
 */

const GOOGLE_KEY = process.env.GEMINI_API_KEY ?? "";
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const ELEVENLABS_KEY =
	process.env.ELEVENLABS_API_KEY ?? process.env.ELEVENLAPS_API_KEY ?? "";

/** Inject silent mic stream for API STT */
async function injectSilentMic() {
	await browser.execute(() => {
		if ((window as any).__SILENT_MIC_INSTALLED__) return;
		(window as any).__SILENT_MIC_INSTALLED__ = true;
		const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
			navigator.mediaDevices,
		);
		navigator.mediaDevices.getUserMedia = async (
			constraints?: MediaStreamConstraints,
		) => {
			if (constraints?.audio) {
				const ctx = new AudioContext();
				const osc = ctx.createOscillator();
				osc.frequency.value = 0;
				const dest = ctx.createMediaStreamDestination();
				osc.connect(dest);
				osc.start();
				return dest.stream;
			}
			return origGetUserMedia(constraints);
		};
	});
}

/** Set STT+TTS config directly in localStorage */
async function setConfig(
	sttProvider: string,
	ttsProvider: string,
	extras: Record<string, string> = {},
) {
	await browser.execute(
		(stt: string, tts: string, ext: Record<string, string>) => {
			const cfg = JSON.parse(localStorage.getItem("naia-config") ?? "{}");
			cfg.sttProvider = stt;
			cfg.ttsEnabled = true;
			cfg.ttsProvider = tts;
			for (const [k, v] of Object.entries(ext)) cfg[k] = v;
			localStorage.setItem("naia-config", JSON.stringify(cfg));
		},
		sttProvider,
		ttsProvider,
		extras,
	);
	await browser.pause(300);
}

/** Click voice button and check activation */
async function activateAndCheck(): Promise<boolean> {
	await browser.execute(
		(sel: string) => (document.querySelector(sel) as HTMLElement)?.click(),
		S.chatTab,
	);
	const chatInput = await $(S.chatInput);
	await chatInput.waitForDisplayed({ timeout: 5_000 });

	await browser.execute(() =>
		(document.querySelector(".chat-voice-btn") as HTMLElement)?.click(),
	);
	await browser.pause(3000);

	const classes = await browser.execute(
		() => document.querySelector(".chat-voice-btn")?.className ?? "",
	);
	const isActive = classes.includes("active") || classes.includes("preparing");

	// Deactivate
	await browser.execute(() =>
		(document.querySelector(".chat-voice-btn") as HTMLElement)?.click(),
	);
	await browser.pause(1000);

	return isActive;
}

const COMBOS = [
	{
		label: "Google STT × Edge TTS",
		stt: "google",
		tts: "edge",
		skip: () => !GOOGLE_KEY,
		extras: { googleApiKey: GOOGLE_KEY },
	},
	{
		label: "Google STT × OpenAI TTS",
		stt: "google",
		tts: "openai",
		skip: () => !GOOGLE_KEY || !OPENAI_KEY,
		extras: { googleApiKey: GOOGLE_KEY, openaiTtsApiKey: OPENAI_KEY },
	},
	{
		label: "Google STT × Google TTS",
		stt: "google",
		tts: "google",
		skip: () => !GOOGLE_KEY,
		extras: { googleApiKey: GOOGLE_KEY },
	},
	{
		label: "Google STT × ElevenLabs TTS",
		stt: "google",
		tts: "elevenlabs",
		skip: () => !GOOGLE_KEY || !ELEVENLABS_KEY,
		extras: { googleApiKey: GOOGLE_KEY, elevenlabsApiKey: ELEVENLABS_KEY },
	},
	{
		label: "ElevenLabs STT × Edge TTS",
		stt: "elevenlabs",
		tts: "edge",
		skip: () => !ELEVENLABS_KEY,
		extras: { elevenlabsApiKey: ELEVENLABS_KEY },
	},
];

describe("88 — STT×TTS combo verification", () => {
	before(async () => {
		await ensureAppReady();
		await injectSilentMic();
	});

	for (const combo of COMBOS) {
		it(`${combo.label}: voice activation succeeds`, async () => {
			if (combo.skip()) {
				console.log(`[SKIP] missing API key for ${combo.label}`);
				return;
			}

			await setConfig(combo.stt, combo.tts, combo.extras);
			const active = await activateAndCheck();
			console.log(`[${combo.label}] active: ${active}`);
			expect(active).toBe(true);
		});
	}

	it("should navigate back to chat tab", async () => {
		// Restore edge
		await setConfig("", "edge");
		await browser.execute(
			(sel: string) => (document.querySelector(sel) as HTMLElement)?.click(),
			S.chatTab,
		);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
