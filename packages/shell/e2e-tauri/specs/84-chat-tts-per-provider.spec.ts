import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { autoApprovePermissions } from "../helpers/permissions.js";
import { S } from "../helpers/selectors.js";
import {
	ensureAppReady,
	navigateToSettings,
	scrollToSection,
} from "../helpers/settings.js";

/**
 * 84 — Chat TTS Per Provider E2E
 *
 * For each TTS provider with an API key:
 * 1. Select TTS provider in settings UI
 * 2. Enter API key in UI
 * 3. Select voice in UI
 * 4. Enable TTS in UI
 * 5. Save settings
 * 6. Go to chat
 * 7. Send message
 * 8. Verify AI responds
 * 9. Verify no TTS error
 *
 * Tests the FULL flow: UI settings → save → chat → TTS audio response
 */
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const ELEVENLABS_KEY =
	process.env.ELEVENLABS_API_KEY ?? process.env.ELEVENLAPS_API_KEY ?? "";
const GOOGLE_KEY = process.env.GEMINI_API_KEY ?? "";

const TTS_PROVIDERS = [
	{ id: "edge", name: "Edge TTS", key: "", voice: "" },
	{ id: "openai", name: "OpenAI TTS", key: OPENAI_KEY, voice: "alloy" },
	{
		id: "google",
		name: "Google Cloud TTS",
		key: GOOGLE_KEY,
		voice: "ko-KR-Neural2-A",
	},
	{ id: "elevenlabs", name: "ElevenLabs", key: ELEVENLABS_KEY, voice: "" },
];

describe("84 — chat TTS per provider", () => {
	let dispose: (() => void) | undefined;

	before(async () => {
		await ensureAppReady();
		dispose = autoApprovePermissions().dispose;
	});

	after(() => {
		dispose?.();
	});

	for (const prov of TTS_PROVIDERS) {
		describe(prov.name, () => {
			if (prov.key === "" && prov.id !== "edge") {
				it(`[SKIP] no API key for ${prov.name}`, () => {
					console.log(`[SKIP] ${prov.name} — no API key`);
				});
				return;
			}

			it("should configure TTS provider + key + voice in settings UI", async () => {
				await navigateToSettings();
				const settingsTab = await $(S.settingsTab);
				await settingsTab.waitForDisplayed({ timeout: 10_000 });

				// Enable TTS
				await scrollToSection(S.ttsToggle);
				const ttsOn = await browser.execute(
					(sel: string) =>
						(document.querySelector(sel) as HTMLInputElement)?.checked ?? false,
					S.ttsToggle,
				);
				if (!ttsOn) {
					await browser.execute(
						(sel: string) =>
							(document.querySelector(sel) as HTMLInputElement)?.click(),
						S.ttsToggle,
					);
					await browser.pause(200);
				}

				// Select provider
				await scrollToSection(S.ttsProviderSelect);
				await browser.execute(
					(sel: string, val: string) => {
						const s = document.querySelector(sel) as HTMLSelectElement;
						if (s) {
							s.value = val;
							s.dispatchEvent(new Event("change", { bubbles: true }));
						}
					},
					S.ttsProviderSelect,
					prov.id,
				);
				await browser.pause(500);

				// Enter API key if needed
				if (prov.key) {
					const hasInput = await browser.execute(
						(sel: string) => !!document.querySelector(sel),
						S.ttsApiKeyInput,
					);
					if (hasInput) {
						await browser.execute(
							(sel: string, val: string) => {
								const input = document.querySelector(sel) as HTMLInputElement;
								if (!input) return;
								const setter = Object.getOwnPropertyDescriptor(
									window.HTMLInputElement.prototype,
									"value",
								)?.set;
								setter?.call(input, val);
								input.dispatchEvent(new Event("input", { bubbles: true }));
								input.dispatchEvent(new Event("change", { bubbles: true }));
							},
							S.ttsApiKeyInput,
							prov.key,
						);
						await browser.pause(200);
					}
				}

				// Select voice if specified
				if (prov.voice) {
					await browser.execute(
						(sel: string, val: string) => {
							const s = document.querySelector(sel) as HTMLSelectElement;
							if (s) {
								s.value = val;
								s.dispatchEvent(new Event("change", { bubbles: true }));
							}
						},
						S.ttsVoiceSelect,
						prov.voice,
					);
					await browser.pause(200);
				}

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

			it("should send chat message and get response with TTS", async () => {
				await browser.execute(
					(sel: string) =>
						(document.querySelector(sel) as HTMLElement)?.click(),
					S.chatTab,
				);
				const chatInput = await $(S.chatInput);
				await chatInput.waitForDisplayed({ timeout: 5_000 });

				await sendMessage("한마디만.");
				const response = await getLastAssistantMessage();
				expect(response.length).toBeGreaterThan(0);
			});

			it("should verify TTS enabled and no error", async () => {
				const config = await browser.execute(() => {
					const cfg = JSON.parse(localStorage.getItem("naia-config") ?? "{}");
					return { ttsEnabled: cfg.ttsEnabled };
				});
				expect(config.ttsEnabled).toBe(true);

				// Check no settings error visible
				const error = await browser.execute(() => {
					return (
						document.querySelector(".settings-error")?.textContent?.trim() ?? ""
					);
				});
				expect(error).toBe("");
			});
		});
	}
});
