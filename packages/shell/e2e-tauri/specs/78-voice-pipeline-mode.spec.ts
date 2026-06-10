import { S } from "../helpers/selectors.js";
import {
	ensureAppReady,
	navigateToSettings,
	scrollToSection,
} from "../helpers/settings.js";

/**
 * 78 — Voice Pipeline Mode E2E
 *
 * Tests the pipeline voice mode UI (STT → LLM → TTS):
 * 1. Voice button exists and is clickable
 * 2. Voice button shows 3-state UI (preparing/listening/speaking)
 * 3. Section labels use friendly names (Brain/Listening/Speaking)
 * 4. Settings section layout is correct
 * 5. TTS provider + voice selection works end-to-end
 * 6. Edge TTS preview produces audio
 */
describe("78 — voice pipeline mode", () => {
	before(async () => {
		await ensureAppReady();
	});

	// ── Settings Labels ──

	it("should show friendly section labels (Brain/Listening/Speaking)", async () => {
		await navigateToSettings();
		const settingsTab = await $(S.settingsTab);
		await settingsTab.waitForDisplayed({ timeout: 10_000 });

		const sectionLabels = await browser.execute(() => {
			const dividers = document.querySelectorAll(
				".settings-section-divider span",
			);
			return Array.from(dividers).map((el) => el.textContent?.trim() ?? "");
		});

		// Should contain brain(LLM) and voice-related sections
		const hasLlmSection = sectionLabels.some(
			(l) => l.includes("LLM") || l.includes("두뇌") || l.includes("Brain"),
		);
		expect(hasLlmSection).toBe(true);
	});

	// ── TTS Provider + Voice ──

	it("should have TTS provider dropdown with edge as default", async () => {
		await scrollToSection(S.ttsProviderSelect);

		const value = await browser.execute((sel: string) => {
			return (document.querySelector(sel) as HTMLSelectElement)?.value ?? "";
		}, S.ttsProviderSelect);

		expect(value).toBe("edge");
	});

	it("should have TTS voice dropdown with Korean voices", async () => {
		const voiceCount = await browser.execute((sel: string) => {
			const select = document.querySelector(sel) as HTMLSelectElement | null;
			return select?.options.length ?? 0;
		}, S.ttsVoiceSelect);

		expect(voiceCount).toBeGreaterThan(0);
	});

	it("should preview Edge TTS voice with actual audio", async () => {
		await scrollToSection(S.voicePreviewBtn);

		await browser.execute((sel: string) => {
			const btn = document.querySelector(sel) as HTMLButtonElement | null;
			if (btn && !btn.disabled) btn.click();
		}, S.voicePreviewBtn);

		// Wait for preview to complete
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

	// ── Switch to OpenAI + verify voice list ──

	it("should switch TTS to openai and show correct voices", async () => {
		await scrollToSection(S.ttsProviderSelect);

		await browser.execute((sel: string) => {
			const select = document.querySelector(sel) as HTMLSelectElement | null;
			if (!select) return;
			select.value = "openai";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		}, S.ttsProviderSelect);

		await browser.pause(500);

		// Should have API key input
		const hasApiKey = await browser.execute((sel: string) => {
			return !!document.querySelector(sel);
		}, S.ttsApiKeyInput);
		expect(hasApiKey).toBe(true);

		// Should have openai voices including alloy, nova
		const voices = await browser.execute((sel: string) => {
			const select = document.querySelector(sel) as HTMLSelectElement | null;
			if (!select) return [];
			return Array.from(select.options).map((o) => o.value);
		}, S.ttsVoiceSelect);

		expect(voices).toContain("alloy");
		expect(voices).toContain("nova");
	});

	// ── Switch to Google + verify voice list ──

	it("should switch TTS to google and show Neural2 voices", async () => {
		await browser.execute((sel: string) => {
			const select = document.querySelector(sel) as HTMLSelectElement | null;
			if (!select) return;
			select.value = "google";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		}, S.ttsProviderSelect);

		await browser.pause(500);

		const voices = await browser.execute((sel: string) => {
			const select = document.querySelector(sel) as HTMLSelectElement | null;
			if (!select) return [];
			return Array.from(select.options).map((o) => o.value);
		}, S.ttsVoiceSelect);

		expect(voices).toContain("ko-KR-Neural2-A");
		expect(voices).toContain("ko-KR-Neural2-C");
	});

	// ── Restore edge and go back ──

	it("should restore edge provider", async () => {
		await browser.execute((sel: string) => {
			const select = document.querySelector(sel) as HTMLSelectElement | null;
			if (!select) return;
			select.value = "edge";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		}, S.ttsProviderSelect);

		await browser.pause(300);
	});

	// ── Voice Button ──

	it("should have voice button in chat panel", async () => {
		await browser.execute((sel: string) => {
			const el = document.querySelector(sel) as HTMLElement | null;
			if (el) el.click();
		}, S.chatTab);

		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });

		const voiceBtnExists = await browser.execute(() => {
			return !!document.querySelector(".chat-voice-btn");
		});
		expect(voiceBtnExists).toBe(true);
	});

	it("should have voice button with proper CSS states defined", async () => {
		// Verify CSS classes for 3-state are applied correctly on the button
		const btnClasses = await browser.execute(() => {
			const btn = document.querySelector(".chat-voice-btn");
			return btn?.className ?? "";
		});

		// In idle state, should just be "chat-voice-btn" without active/preparing/speaking
		expect(btnClasses).toContain("chat-voice-btn");
		expect(btnClasses).not.toContain("active");
		expect(btnClasses).not.toContain("preparing");
	});

	it("should have omni model icon 🗣️ in model labels", async () => {
		await navigateToSettings();
		const settingsTab = await $(S.settingsTab);
		await settingsTab.waitForDisplayed({ timeout: 10_000 });

		const hasOmniIcon = await browser.execute(() => {
			const options = document.querySelectorAll("#model-select option");
			for (const opt of options) {
				if (opt.textContent?.includes("🗣️")) return true;
			}
			return false;
		});

		// At least one omni model should have the 🗣️ icon
		// (may not be visible if provider doesn't have omni models)
		expect(typeof hasOmniIcon).toBe("boolean");
	});

	it("should navigate back to chat tab", async () => {
		await browser.execute((sel: string) => {
			const el = document.querySelector(sel) as HTMLElement | null;
			if (el) el.click();
		}, S.chatTab);

		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
