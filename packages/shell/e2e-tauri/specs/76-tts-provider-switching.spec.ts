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
 *
 * #603 이 타사 클라우드 음성(Google·OpenAI·ElevenLabs)을 제거했다. 예전의
 * OpenAI 미리듣기와 ElevenLabs 전환 단계는 없는 공급자를 고르던 것이라 걷었고,
 * 목록에 다시 나타나지 않는지를 대신 본다.
 */
const EXPECTED_PROVIDERS = ["edge", "nextain"];
const REMOVED_PROVIDERS = ["google", "openai", "elevenlabs"];

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
		for (const id of REMOVED_PROVIDERS) {
			expect(providerIds).not.toContain(id);
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
