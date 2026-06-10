import { S } from "../helpers/selectors.js";
import {
	ensureAppReady,
	navigateToSettings,
	scrollToSection,
} from "../helpers/settings.js";

/**
 * 80 — TTS Preview All Providers E2E
 *
 * Runs actual TTS preview for each provider with real API keys.
 * Verifies no error message appears after preview (`.settings-error`).
 *
 * Requires: OPENAI_API_KEY env var. ELEVENLAPS_API_KEY for ElevenLabs.
 * Google Cloud TTS requires separate GOOGLE_CLOUD_TTS_KEY (not GEMINI_API_KEY).
 */
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const ELEVENLABS_KEY =
	process.env.ELEVENLABS_API_KEY ?? process.env.ELEVENLAPS_API_KEY ?? "";

function setSelectValue(sel: string, value: string) {
	return browser.execute(
		(s: string, v: string) => {
			const select = document.querySelector(s) as HTMLSelectElement | null;
			if (!select) return false;
			select.value = v;
			select.dispatchEvent(new Event("change", { bubbles: true }));
			return true;
		},
		sel,
		value,
	);
}

function setInputValue(sel: string, value: string) {
	return browser.execute(
		(s: string, v: string) => {
			const input = document.querySelector(s) as HTMLInputElement | null;
			if (!input) return false;
			const setter = Object.getOwnPropertyDescriptor(
				window.HTMLInputElement.prototype,
				"value",
			)?.set;
			setter?.call(input, v);
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("change", { bubbles: true }));
			return true;
		},
		sel,
		value,
	);
}

/** Clear any existing error, click preview, wait, check for error. */
async function previewAndCheckError(timeout = 45_000): Promise<string> {
	// Clear previous error
	await browser.execute(() => {
		const errEl = document.querySelector(".settings-error");
		if (errEl) errEl.textContent = "";
	});

	await scrollToSection(S.voicePreviewBtn);
	await browser.execute((sel: string) => {
		const btn = document.querySelector(sel) as HTMLButtonElement | null;
		if (btn && !btn.disabled) btn.click();
	}, S.voicePreviewBtn);

	// Wait for preview to finish (button re-enables)
	await browser.waitUntil(
		async () =>
			browser.execute((sel: string) => {
				const btn = document.querySelector(sel) as HTMLButtonElement | null;
				return btn ? !btn.disabled : true;
			}, S.voicePreviewBtn),
		{ timeout, timeoutMsg: `Preview did not finish in ${timeout / 1000}s` },
	);

	await browser.pause(500);

	// Check for error message
	const error = await browser.execute(() => {
		const el = document.querySelector(".settings-error");
		return el?.textContent?.trim() ?? "";
	});

	return error;
}

describe("80 — TTS preview all providers", () => {
	before(async () => {
		await ensureAppReady();
		await navigateToSettings();
		const settingsTab = await $(S.settingsTab);
		await settingsTab.waitForDisplayed({ timeout: 10_000 });
	});

	it("Edge TTS: preview succeeds without error", async () => {
		await setSelectValue(S.ttsProviderSelect, "edge");
		await browser.pause(500);
		const error = await previewAndCheckError();
		expect(error).toBe("");
	});

	it("OpenAI TTS: preview succeeds with API key", async () => {
		if (!OPENAI_KEY) {
			console.log("[SKIP] no OPENAI_API_KEY");
			return;
		}
		await setSelectValue(S.ttsProviderSelect, "openai");
		await browser.pause(500);
		await setInputValue(S.ttsApiKeyInput, OPENAI_KEY);
		await browser.pause(300);
		await setSelectValue(S.ttsVoiceSelect, "alloy");
		await browser.pause(300);
		const error = await previewAndCheckError();
		expect(error).toBe("");
	});

	it("ElevenLabs TTS: preview succeeds with API key (default voice)", async () => {
		if (!ELEVENLABS_KEY) {
			console.log("[SKIP] no ELEVENLABS_API_KEY");
			return;
		}
		await setSelectValue(S.ttsProviderSelect, "elevenlabs");
		await browser.pause(500);
		await setInputValue(S.ttsApiKeyInput, ELEVENLABS_KEY);
		await browser.pause(300);
		// Uses default voice (Sarah) when no voice selected
		const error = await previewAndCheckError();
		if (error) console.error("[ElevenLabs]", error);
		expect(error).toBe("");
	});

	it("Google Cloud TTS: preview succeeds with GEMINI_API_KEY", async () => {
		const googleKey = process.env.GEMINI_API_KEY ?? "";
		if (!googleKey) {
			console.log("[SKIP] no GEMINI_API_KEY");
			return;
		}
		await setSelectValue(S.ttsProviderSelect, "google");
		await browser.pause(500);
		await setInputValue(S.ttsApiKeyInput, googleKey);
		await browser.pause(300);
		await setSelectValue(S.ttsVoiceSelect, "ko-KR-Neural2-A");
		await browser.pause(300);
		const error = await previewAndCheckError();
		if (error) console.error("[Google TTS]", error);
		expect(error).toBe("");
	});

	it("should restore edge and navigate back", async () => {
		await setSelectValue(S.ttsProviderSelect, "edge");
		await browser.pause(300);
		await browser.execute((sel: string) => {
			(document.querySelector(sel) as HTMLElement)?.click();
		}, S.chatTab);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
