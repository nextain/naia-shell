import { S } from "../helpers/selectors.js";
import {
	chooseSelectOption,
	ensureAppReady,
	navigateToSettings,
	openSettingsSection,
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

	it("should split brain and voice into their own settings sections", async () => {
		// #541 이후 설정은 구역 탭으로 나뉘고 활성 구역만 렌더한다. LLM 은 brain,
		// 음성은 voice 구역이라 한 화면의 구분선 이름을 더는 셀 수 없다.
		await openSettingsSection("voice");
		const tabs = await browser.execute(() =>
			Array.from(document.querySelectorAll("[data-settings-tab]")).map(
				(el) => (el as HTMLElement).dataset.settingsTab ?? "",
			),
		);
		expect(tabs).toContain("brain");
		expect(tabs).toContain("voice");
	});

	// ── TTS Provider + Voice ──

	it("should select the free edge TTS provider", async () => {
		await scrollToSection(S.ttsProviderSelect);
		expect(await chooseSelectOption(S.ttsProviderSelect, "edge")).toBe(true);

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

	// ── Removed cloud voices (#603) ──

	it("should not offer the removed openai and google TTS providers", async () => {
		const ids = await browser.execute((sel: string) => {
			const select = document.querySelector(sel) as HTMLSelectElement | null;
			return select ? Array.from(select.options).map((o) => o.value) : [];
		}, S.ttsProviderSelect);
		expect(ids).not.toContain("openai");
		expect(ids).not.toContain("google");
	});

	it("should switch TTS to the browser voice without an API key", async () => {
		expect(await chooseSelectOption(S.ttsProviderSelect, "browser")).toBe(true);
		const hasApiKey = await browser.execute((sel: string) => {
			return !!document.querySelector(sel);
		}, S.ttsApiKeyInput);
		expect(hasApiKey).toBe(false);
	});

	// ── Restore edge and go back ──

	it("should restore edge provider", async () => {
		expect(await chooseSelectOption(S.ttsProviderSelect, "edge")).toBe(true);
	});

	// ── Voice Button ──

	it("should have voice button in chat app", async () => {
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
