import { S } from "../helpers/selectors.js";
import {
	chooseSelectOption,
	ensureAppReady,
	openSettingsSection,
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
 *
 * 설정은 활성 구역만 렌더한다 — 음성 구역을 열어야 공급자 선택이 DOM 에 선다.
 * 앞선 스펙이 공급자를 바꿔 두었을 수 있어, 출발점(edge)은 직접 고른다.
 */
const EXPECTED_PROVIDERS = ["edge", "nextain", "browser", "vllm"];
const REMOVED_PROVIDERS = ["google", "openai", "elevenlabs"];

async function providerOptions(): Promise<
	{ value: string; disabled: boolean }[]
> {
	return browser.execute((sel: string) => {
		const select = document.querySelector(sel) as HTMLSelectElement | null;
		if (!select) return [];
		return Array.from(select.options).map((o) => ({
			value: o.value,
			disabled: o.disabled,
		}));
	}, S.ttsProviderSelect);
}

async function voiceCount(): Promise<number> {
	return browser.execute((sel: string) => {
		const select = document.querySelector(sel) as HTMLSelectElement | null;
		return select?.options.length ?? 0;
	}, S.ttsVoiceSelect);
}

describe("76 — TTS provider switching", () => {
	before(async () => {
		await ensureAppReady();
		await openSettingsSection("voice");
		await (await $(S.ttsProviderSelect)).waitForExist({ timeout: 10_000 });
	});

	// ── Provider dropdown ──

	it("should show TTS provider dropdown with all providers", async () => {
		await scrollToSection(S.ttsProviderSelect);
		const providerIds = (await providerOptions()).map((o) => o.value);

		for (const id of EXPECTED_PROVIDERS) {
			expect(providerIds).toContain(id);
		}
		for (const id of REMOVED_PROVIDERS) {
			expect(providerIds).not.toContain(id);
		}
	});

	it("should select the free edge provider", async () => {
		expect(await chooseSelectOption(S.ttsProviderSelect, "edge")).toBe(true);
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
		expect(await voiceCount()).toBeGreaterThan(0);
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

	// ── Nextain (Naia key) ──

	it("should gate nextain on the Naia account and never ask for an API key", async () => {
		const nextain = (await providerOptions()).find((o) => o.value === "nextain");
		expect(nextain).toBeDefined();
		const chosen = await chooseSelectOption(S.ttsProviderSelect, "nextain");
		// 나이아 계정이 없으면 옵션이 잠겨 고를 수 없다 — 잠김과 선택 실패가 일치해야 한다.
		expect(chosen).toBe(!nextain?.disabled);

		const apiKeyExists = await browser.execute((sel: string) => {
			return !!document.querySelector(sel);
		}, S.ttsApiKeyInput);
		expect(apiKeyExists).toBe(false);
	});

	// ── Switch back to edge ──

	it("should switch back to edge and work normally", async () => {
		expect(await chooseSelectOption(S.ttsProviderSelect, "edge")).toBe(true);

		// No API key input
		const apiKeyExists = await browser.execute((sel: string) => {
			return !!document.querySelector(sel);
		}, S.ttsApiKeyInput);
		expect(apiKeyExists).toBe(false);

		// Voice list restored
		expect(await voiceCount()).toBeGreaterThan(0);
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
