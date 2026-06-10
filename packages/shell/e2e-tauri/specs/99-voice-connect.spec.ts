import { S } from "../helpers/selectors.js";

/**
 * Voice connection E2E — verify Gemini Direct connects (orange → green).
 */
describe("voice-connect", () => {
	it("should connect Gemini Direct voice via Rust proxy", async () => {
		// 1. Wait for app to be ready
		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 30_000 });

		// 2. Go to Settings
		await browser.execute((sel: string) => {
			(document.querySelector(sel) as HTMLElement)?.click();
		}, S.settingsTabBtn);
		const settings = await $(S.settingsTab);
		await settings.waitForDisplayed({ timeout: 5000 });

		// 3. Set live provider to gemini-live
		await browser.execute(() => {
			const sel = document.querySelector(
				"#live-provider-select",
			) as HTMLSelectElement;
			if (sel) {
				sel.value = "gemini-live";
				sel.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		await browser.pause(300);

		// 4. Set Google API key
		const apiKey = process.env.GEMINI_API_KEY || "";
		if (!apiKey) {
			console.log("[E2E] GEMINI_API_KEY not set, skipping");
			return;
		}
		await browser.execute((key: string) => {
			const input = document.querySelector(
				"#google-apikey-input",
			) as HTMLInputElement;
			if (input) {
				const setter = Object.getOwnPropertyDescriptor(
					window.HTMLInputElement.prototype,
					"value",
				)?.set;
				setter?.call(input, key);
				input.dispatchEvent(new Event("input", { bubbles: true }));
				input.dispatchEvent(new Event("change", { bubbles: true }));
			}
		}, apiKey);
		await browser.pause(300);

		// 5. Save settings
		await browser.execute(() => {
			(document.querySelector(".settings-save-btn") as HTMLElement)?.click();
		});
		await browser.pause(1000);

		// 6. Go back to Chat
		await browser.execute((sel: string) => {
			(document.querySelector(sel) as HTMLElement)?.click();
		}, S.chatTab);
		await chatInput.waitForDisplayed({ timeout: 5000 });

		// 7. Click voice button
		const voiceBtn = await $(".chat-voice-btn");
		await voiceBtn.waitForDisplayed({ timeout: 5000 });
		await voiceBtn.click();

		// 8. Should go to "connecting" (orange) first
		await browser.waitUntil(
			async () => {
				const cls = await voiceBtn.getAttribute("class");
				return cls?.includes("connecting") || cls?.includes("active");
			},
			{
				timeout: 5000,
				timeoutMsg: "Voice button never entered connecting state",
			},
		);
		console.log("[E2E] Voice button is connecting...");

		// 9. Wait for "active" (green) — connection succeeded
		await browser.waitUntil(
			async () => {
				const cls = await voiceBtn.getAttribute("class");
				return cls?.includes("active");
			},
			{
				timeout: 20_000,
				timeoutMsg:
					"Voice never reached active (green) state — still stuck on orange",
			},
		);
		console.log("[E2E] ✓ Voice connected — GREEN!");

		// 10. Disconnect
		await voiceBtn.click();
		await browser.pause(1000);
	});
});
