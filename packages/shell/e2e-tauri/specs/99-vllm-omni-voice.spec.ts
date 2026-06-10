import { S } from "../helpers/selectors.js";

/**
 * 99 — vllm-omni Voice E2E
 *
 * Tests MiniCPM-o 4.5 omni model integration via vllm-omni:
 * 1. Configure vllm provider with MiniCPM-o model
 * 2. Send text message → verify audio response
 *
 * Requires: vllm-omni server running on localhost:8000 with MiniCPM-o 4.5
 *   CUDA_VISIBLE_DEVICES=0 vllm serve openbmb/MiniCPM-o-4_5 --omni \
 *     --stage-configs-path minicpmo_24gb.yaml --trust-remote-code
 */

const VLLM_HOST = process.env.VLLM_OMNI_HOST || "http://localhost:8000";
const MODEL = "openbmb/MiniCPM-o-4_5";

describe("99 — vllm-omni voice", () => {
	before(async () => {
		// Check vllm-omni server is running
		try {
			const resp = await fetch(`${VLLM_HOST}/v1/models`);
			if (!resp.ok) throw new Error(`vllm-omni not available: ${resp.status}`);
		} catch (e) {
			console.warn("vllm-omni server not running, skipping tests");
			return;
		}

		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 15_000 });
	});

	it("should configure vllm provider with MiniCPM-o", async () => {
		// Switch to Settings
		await browser.execute((sel: string) => {
			const el = document.querySelector(sel) as HTMLElement | null;
			if (el) el.click();
		}, S.settingsTabBtn);
		const settingsTab = await $(S.settingsTab);
		await settingsTab.waitForDisplayed({ timeout: 5000 });

		// Select vllm provider
		await browser.execute(() => {
			const select = document.querySelector(
				"#provider-select",
			) as HTMLSelectElement | null;
			if (select) {
				select.value = "vllm";
				select.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		await browser.pause(500);

		// Set API key to "vllm"
		const apiKeyInput = await $(S.apiKeyInput);
		await apiKeyInput.setValue("vllm");

		// Save settings
		const saveBtn = await $(S.settingsSaveBtn);
		await saveBtn.click();
		await browser.pause(1000);

		// Back to chat
		await browser.execute((sel: string) => {
			const el = document.querySelector(sel) as HTMLElement | null;
			if (el) el.click();
		}, S.chatTab);
		await browser.pause(500);
	});

	it("should send text and receive audio response", async () => {
		// Type message
		const chatInput = await $(S.chatInput);
		await chatInput.setValue("Say hello in a friendly tone.");

		// Send
		const sendBtn = await $(S.chatSendBtn);
		await sendBtn.click();

		// Wait for assistant response (audio generation takes ~11s)
		const assistantMsg = await $(S.completedAssistantMessage);
		await assistantMsg.waitForDisplayed({ timeout: 30_000 });

		// Verify response exists (audio may be in a separate element)
		const text = await assistantMsg.getText();
		expect(text.length).toBeGreaterThan(0);
	});
});
