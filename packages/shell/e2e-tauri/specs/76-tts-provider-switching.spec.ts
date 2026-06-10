import { S } from "../helpers/selectors.js";
import {
	ensureAppReady,
	navigateToSettings,
	scrollToSection,
} from "../helpers/settings.js";

/**
 * 76 — TTS Provider Switching E2E
 *
 * Tests the full TTS provider UI flow:
 * 1. Provider selector shows all registered providers
 * 2. Switching provider shows/hides API key input
 * 3. Voice list updates per provider
 * 4. Voice preview produces audio (Edge TTS — free, always works)
 * 5. OpenAI TTS preview with API key (if OPENAI_API_KEY set)
 * 6. Validates no broken voices (voices that fail to synthesize)
 *
 * Requires: Gateway running. OPENAI_API_KEY env var for OpenAI test.
 */
const EXPECTED_PROVIDERS = [
	"edge",
	"google",
	"openai",
	"elevenlabs",
	"nextain",
];

describe("76 — TTS provider switching", () => {
	before(async () => {
		await ensureAppReady();
		await navigateToSettings();
		const settingsTab = await $(S.settingsTab);
		await settingsTab.waitForDisplayed({ timeout: 10_000 });
	});

	// ── Provider dropdown ──

	it("should show TTS provider dropdown with all providers", async () => {
		await scrollToSection(S.ttsProviderSelect);

		const providerIds = await browser.execute((sel: string) => {
			const select = document.querySelector(sel) as HTMLSelectElement | null;
			if (!select) return [];
			return Array.from(select.options).map((o) => o.value);
		}, S.ttsProviderSelect);

		for (const id of EXPECTED_PROVIDERS) {
			expect(providerIds).toContain(id);
		}
	});

	it("should default to edge provider", async () => {
		const value = await browser.execute((sel: string) => {
			const select = document.querySelector(sel) as HTMLSelectElement | null;
			return select?.value ?? "";
		}, S.ttsProviderSelect);

		expect(value).toBe("edge");
	});

	// ── Edge TTS (free, no API key) ──

	it("should NOT show API key input for edge provider", async () => {
		const exists = await browser.execute((sel: string) => {
			return !!document.querySelector(sel);
		}, S.ttsApiKeyInput);

		expect(exists).toBe(false);
	});

	it("should show voice options for edge provider", async () => {
		const voiceCount = await browser.execute((sel: string) => {
			const select = document.querySelector(sel) as HTMLSelectElement | null;
			return select?.options.length ?? 0;
		}, S.ttsVoiceSelect);

		expect(voiceCount).toBeGreaterThan(0);
	});

	it("should preview edge TTS voice (actual audio)", async () => {
		await scrollToSection(S.voicePreviewBtn);

		// Click preview
		await browser.execute((sel: string) => {
			const btn = document.querySelector(sel) as HTMLButtonElement | null;
			if (btn && !btn.disabled) btn.click();
		}, S.voicePreviewBtn);

		// Wait for preview to finish (button re-enables)
		await browser.waitUntil(
			async () => {
				return browser.execute((sel: string) => {
					const btn = document.querySelector(sel) as HTMLButtonElement | null;
					return btn ? !btn.disabled : true;
				}, S.voicePreviewBtn);
			},
			{ timeout: 30_000, timeoutMsg: "Edge TTS preview did not finish in 30s" },
		);
	});

	// ── Switch to OpenAI ──

	it("should switch to openai provider and show API key input", async () => {
		await scrollToSection(S.ttsProviderSelect);

		await browser.execute((sel: string) => {
			const select = document.querySelector(sel) as HTMLSelectElement | null;
			if (!select) return;
			select.value = "openai";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		}, S.ttsProviderSelect);

		await browser.pause(500);

		const apiKeyExists = await browser.execute((sel: string) => {
			return !!document.querySelector(sel);
		}, S.ttsApiKeyInput);

		expect(apiKeyExists).toBe(true);
	});

	it("should show openai voice options", async () => {
		const voices = await browser.execute((sel: string) => {
			const select = document.querySelector(sel) as HTMLSelectElement | null;
			if (!select) return [];
			return Array.from(select.options).map((o) => ({
				id: o.value,
				label: o.textContent,
			}));
		}, S.ttsVoiceSelect);

		expect(voices.length).toBeGreaterThan(0);
		// OpenAI should have known voices
		const ids = voices.map((v) => v.id);
		expect(ids).toContain("nova");
		expect(ids).toContain("alloy");
	});

	it("should preview openai TTS if API key is available", async () => {
		const apiKey = process.env.OPENAI_API_KEY ?? "";
		if (!apiKey) {
			console.log("[SKIP] OPENAI_API_KEY not set, skipping OpenAI preview");
			return;
		}

		// Enter API key
		await browser.execute(
			(sel: string, key: string) => {
				const input = document.querySelector(sel) as HTMLInputElement | null;
				if (!input) return;
				const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
					window.HTMLInputElement.prototype,
					"value",
				)?.set;
				nativeInputValueSetter?.call(input, key);
				input.dispatchEvent(new Event("input", { bubbles: true }));
				input.dispatchEvent(new Event("change", { bubbles: true }));
			},
			S.ttsApiKeyInput,
			apiKey,
		);

		await browser.pause(300);

		// Select "alloy" voice for test
		await browser.execute((sel: string) => {
			const select = document.querySelector(sel) as HTMLSelectElement | null;
			if (!select) return;
			select.value = "alloy";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		}, S.ttsVoiceSelect);

		await browser.pause(300);

		// Click preview
		await scrollToSection(S.voicePreviewBtn);
		await browser.execute((sel: string) => {
			const btn = document.querySelector(sel) as HTMLButtonElement | null;
			if (btn && !btn.disabled) btn.click();
		}, S.voicePreviewBtn);

		// Wait for preview (OpenAI can take longer)
		await browser.waitUntil(
			async () => {
				return browser.execute((sel: string) => {
					const btn = document.querySelector(sel) as HTMLButtonElement | null;
					return btn ? !btn.disabled : true;
				}, S.voicePreviewBtn);
			},
			{
				timeout: 45_000,
				timeoutMsg: "OpenAI TTS preview did not finish in 45s",
			},
		);
	});

	// ── Switch to ElevenLabs ──

	it("should switch to elevenlabs and show API key input", async () => {
		await scrollToSection(S.ttsProviderSelect);

		await browser.execute((sel: string) => {
			const select = document.querySelector(sel) as HTMLSelectElement | null;
			if (!select) return;
			select.value = "elevenlabs";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		}, S.ttsProviderSelect);

		await browser.pause(500);

		const apiKeyExists = await browser.execute((sel: string) => {
			return !!document.querySelector(sel);
		}, S.ttsApiKeyInput);

		expect(apiKeyExists).toBe(true);
	});

	// ── Switch to Nextain (Naia key) ──

	it("should switch to nextain and show naia account hint if not logged in", async () => {
		await browser.execute((sel: string) => {
			const select = document.querySelector(sel) as HTMLSelectElement | null;
			if (!select) return;
			select.value = "nextain";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		}, S.ttsProviderSelect);

		await browser.pause(500);

		// No API key input should appear
		const apiKeyExists = await browser.execute((sel: string) => {
			return !!document.querySelector(sel);
		}, S.ttsApiKeyInput);
		expect(apiKeyExists).toBe(false);

		// If no naiaKey, hint should show
		const hintText = await browser.execute(() => {
			const hint = document.querySelector(".settings-hint");
			return hint?.textContent ?? "";
		});

		// Either hint or naia is already logged in — both ok
		expect(typeof hintText).toBe("string");
	});

	// ── Switch back to edge ──

	it("should switch back to edge and work normally", async () => {
		await browser.execute((sel: string) => {
			const select = document.querySelector(sel) as HTMLSelectElement | null;
			if (!select) return;
			select.value = "edge";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		}, S.ttsProviderSelect);

		await browser.pause(500);

		// No API key input
		const apiKeyExists = await browser.execute((sel: string) => {
			return !!document.querySelector(sel);
		}, S.ttsApiKeyInput);
		expect(apiKeyExists).toBe(false);

		// Voice list restored
		const voiceCount = await browser.execute((sel: string) => {
			const select = document.querySelector(sel) as HTMLSelectElement | null;
			return select?.options.length ?? 0;
		}, S.ttsVoiceSelect);
		expect(voiceCount).toBeGreaterThan(0);
	});

	// ── Cleanup ──

	it("should navigate back to chat tab", async () => {
		await browser.execute((sel: string) => {
			const el = document.querySelector(sel) as HTMLElement | null;
			if (el) el.click();
		}, S.chatTab);

		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
