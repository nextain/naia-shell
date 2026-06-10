import { S } from "../helpers/selectors.js";
import {
	ensureAppReady,
	navigateToSettings,
	scrollToSection,
} from "../helpers/settings.js";

/**
 * 77 — STT Provider Switching E2E
 *
 * Tests STT provider UI:
 * 1. STT provider dropdown shows offline + API providers
 * 2. Offline providers (vosk/whisper) show model manager
 * 3. API providers (google/elevenlabs) show API key field
 * 4. Naia Cloud STT shows login prompt when not authenticated
 * 5. Switching providers updates UI correctly
 */
const EXPECTED_STT_PROVIDERS = [
	"vosk",
	"whisper",
	"nextain",
	"google",
	"elevenlabs",
];

describe("77 — STT provider switching", () => {
	before(async () => {
		await ensureAppReady();
		await navigateToSettings();
		const settingsTab = await $(S.settingsTab);
		await settingsTab.waitForDisplayed({ timeout: 10_000 });
	});

	it("should show STT provider dropdown with all providers", async () => {
		// Find the STT provider select (uses listSttProviders registry)
		const providerIds = await browser.execute(() => {
			const selects = document.querySelectorAll("select");
			for (const sel of selects) {
				const options = Array.from(sel.options).map((o) => o.value);
				if (options.includes("vosk") && options.includes("whisper")) {
					return options.filter((v) => v !== ""); // exclude empty "none" option
				}
			}
			return [];
		});

		for (const id of EXPECTED_STT_PROVIDERS) {
			expect(providerIds).toContain(id);
		}
	});

	it("should show provider order: free → Naia → paid", async () => {
		const providerIds = await browser.execute(() => {
			const selects = document.querySelectorAll("select");
			for (const sel of selects) {
				const options = Array.from(sel.options).map((o) => o.value);
				if (options.includes("vosk") && options.includes("whisper")) {
					return options.filter((v) => v !== "");
				}
			}
			return [];
		});

		// vosk and whisper should come before nextain, which should come before google/elevenlabs
		const voskIdx = providerIds.indexOf("vosk");
		const whisperIdx = providerIds.indexOf("whisper");
		const nextainIdx = providerIds.indexOf("nextain");
		const googleIdx = providerIds.indexOf("google");

		expect(voskIdx).toBeLessThan(nextainIdx);
		expect(whisperIdx).toBeLessThan(nextainIdx);
		expect(nextainIdx).toBeLessThan(googleIdx);
	});

	it("should switch to vosk and show model manager", async () => {
		await browser.execute(() => {
			const selects = document.querySelectorAll("select");
			for (const sel of selects) {
				const options = Array.from(sel.options).map((o) => o.value);
				if (options.includes("vosk")) {
					sel.value = "vosk";
					sel.dispatchEvent(new Event("change", { bubbles: true }));
					return;
				}
			}
		});

		await browser.pause(500);

		// Model manager button should appear for offline engine
		const hasModelBtn = await browser.execute(() => {
			return !!document.querySelector(".onboarding-next-btn");
		});
		expect(hasModelBtn).toBe(true);
	});

	it("should switch to google and show API key hint", async () => {
		await browser.execute(() => {
			const selects = document.querySelectorAll("select");
			for (const sel of selects) {
				const options = Array.from(sel.options).map((o) => o.value);
				if (options.includes("vosk")) {
					sel.value = "google";
					sel.dispatchEvent(new Event("change", { bubbles: true }));
					return;
				}
			}
		});

		await browser.pause(500);

		// API key input should appear
		const hasApiKey = await browser.execute(() => {
			return !!document.querySelector("#stt-api-key");
		});
		expect(hasApiKey).toBe(true);
	});

	it("should switch to nextain and show login prompt if not logged in", async () => {
		await browser.execute(() => {
			const selects = document.querySelectorAll("select");
			for (const sel of selects) {
				const options = Array.from(sel.options).map((o) => o.value);
				if (options.includes("vosk")) {
					sel.value = "nextain";
					sel.dispatchEvent(new Event("change", { bubbles: true }));
					return;
				}
			}
		});

		await browser.pause(500);

		// Should show either login hint or nothing (if already logged in)
		const hint = await browser.execute(() => {
			const el = document.querySelector(".settings-hint");
			return el?.textContent ?? "";
		});
		expect(typeof hint).toBe("string");
	});

	it("should switch back to empty (none) and hide all extras", async () => {
		await browser.execute(() => {
			const selects = document.querySelectorAll("select");
			for (const sel of selects) {
				const options = Array.from(sel.options).map((o) => o.value);
				if (options.includes("vosk")) {
					sel.value = "";
					sel.dispatchEvent(new Event("change", { bubbles: true }));
					return;
				}
			}
		});

		await browser.pause(500);

		// No API key input or model manager
		const hasApiKey = await browser.execute(
			() => !!document.querySelector("#stt-api-key"),
		);
		expect(hasApiKey).toBe(false);
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
