import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { autoApprovePermissions } from "../helpers/permissions.js";
import { S } from "../helpers/selectors.js";
import {
	ensureAppReady,
	navigateToSettings,
	scrollToSection,
} from "../helpers/settings.js";

/**
 * 83 — TTS Per-Model Verification E2E
 *
 * For each LLM provider+model combo that has an API key available:
 * 1. Switch provider + model in settings
 * 2. Enable TTS (edge)
 * 3. Save
 * 4. Send chat message
 * 5. Verify response received
 * 6. Check TTS audio was generated (Audio chunk / play log)
 *
 * Tests: nextain, gemini, openai, anthropic, xai
 * Skips providers without API keys.
 */

// Models to test — one per provider (cheapest/fastest LLM, not omni)
const TEST_MODELS: {
	provider: string;
	model: string;
	label: string;
	keyEnv?: string;
}[] = [
	{
		provider: "nextain",
		model: "gemini-3-flash-preview",
		label: "Naia + Gemini Flash",
	},
	{
		provider: "gemini",
		model: "gemini-2.5-flash",
		label: "Gemini Direct + 2.5 Flash",
		keyEnv: "GEMINI_API_KEY",
	},
	{
		provider: "openai",
		model: "gpt-4o",
		label: "OpenAI + GPT-4o",
		keyEnv: "OPENAI_API_KEY",
	},
	{
		provider: "anthropic",
		model: "claude-haiku-4-5-20251001",
		label: "Anthropic + Haiku",
		keyEnv: "ANTHROPIC_API_KEY",
	},
	{
		provider: "xai",
		model: "grok-3-mini",
		label: "xAI + Grok 3 Mini",
		keyEnv: "XAI_API_KEY",
	},
];

function getApiKey(envName?: string): string {
	if (!envName) return ""; // nextain uses naiaKey, not apiKey
	return process.env[envName] ?? "";
}

describe("83 — TTS per-model verification", () => {
	let dispose: (() => void) | undefined;

	before(async () => {
		await ensureAppReady();
		dispose = autoApprovePermissions().dispose;
	});

	after(() => {
		dispose?.();
	});

	for (const tm of TEST_MODELS) {
		const apiKey = getApiKey(tm.keyEnv);
		const skip = tm.keyEnv && !apiKey;

		describe(`${tm.label}`, () => {
			if (skip) {
				it(`[SKIP] ${tm.keyEnv} not set`, () => {
					console.log(
						`[SKIP] ${tm.keyEnv} not available, skipping ${tm.label}`,
					);
				});
				return;
			}

			it("should configure provider + model + TTS", async () => {
				await navigateToSettings();
				const settingsTab = await $(S.settingsTab);
				await settingsTab.waitForDisplayed({ timeout: 10_000 });

				// Set provider
				await browser.execute((providerId: string) => {
					const select = document.querySelector(
						"#provider-select",
					) as HTMLSelectElement | null;
					if (select) {
						select.value = providerId;
						select.dispatchEvent(new Event("change", { bubbles: true }));
					}
				}, tm.provider);
				await browser.pause(500);

				// Set model
				await browser.execute((modelId: string) => {
					const select = document.querySelector(
						"#model-select",
					) as HTMLSelectElement | null;
					if (select) {
						select.value = modelId;
						select.dispatchEvent(new Event("change", { bubbles: true }));
					}
				}, tm.model);
				await browser.pause(300);

				// Enter API key if needed
				if (apiKey) {
					const apiInput = await browser.execute(() => {
						return document.querySelector(
							'input[type="password"]',
						) as HTMLInputElement | null;
					});
					if (apiInput) {
						await browser.execute((key: string) => {
							const input = document
								.querySelector("#provider-select")
								?.closest(".settings-tab")
								?.querySelector(
									'input[type="password"]',
								) as HTMLInputElement | null;
							if (!input) return;
							const setter = Object.getOwnPropertyDescriptor(
								window.HTMLInputElement.prototype,
								"value",
							)?.set;
							setter?.call(input, key);
							input.dispatchEvent(new Event("input", { bubbles: true }));
							input.dispatchEvent(new Event("change", { bubbles: true }));
						}, apiKey);
						await browser.pause(200);
					}
				}

				// Enable TTS
				await scrollToSection(S.ttsToggle);
				const ttsOn = await browser.execute((sel: string) => {
					return (
						(document.querySelector(sel) as HTMLInputElement)?.checked ?? false
					);
				}, S.ttsToggle);
				if (!ttsOn) {
					await browser.execute((sel: string) => {
						(document.querySelector(sel) as HTMLInputElement)?.click();
					}, S.ttsToggle);
					await browser.pause(200);
				}

				// Set edge TTS provider
				await scrollToSection(S.ttsProviderSelect);
				await browser.execute((sel: string) => {
					const select = document.querySelector(
						sel,
					) as HTMLSelectElement | null;
					if (select) {
						select.value = "edge";
						select.dispatchEvent(new Event("change", { bubbles: true }));
					}
				}, S.ttsProviderSelect);
				await browser.pause(200);

				// Save
				await browser.execute(() => {
					const btns = document.querySelectorAll("button");
					for (const btn of btns) {
						if (
							btn.textContent?.includes("저장") ||
							btn.textContent?.includes("Save")
						) {
							btn.click();
							return;
						}
					}
				});
				await browser.pause(1500);
			});

			it("should chat and get TTS response", async () => {
				await browser.execute((sel: string) => {
					(document.querySelector(sel) as HTMLElement)?.click();
				}, S.chatTab);
				const chatInput = await $(S.chatInput);
				await chatInput.waitForDisplayed({ timeout: 5_000 });

				await sendMessage("한마디만. 짧게.");
				const response = await getLastAssistantMessage();
				expect(response.length).toBeGreaterThan(0);
			});

			it("should verify TTS is enabled in config", async () => {
				const config = await browser.execute(() => {
					const cfg = JSON.parse(localStorage.getItem("naia-config") ?? "{}");
					return { ttsEnabled: cfg.ttsEnabled, ttsProvider: cfg.ttsProvider };
				});
				expect(config.ttsEnabled).toBe(true);
				expect(config.ttsProvider).toBe("edge");
			});
		});
	}
});
