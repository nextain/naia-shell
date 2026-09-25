import { sendMessage } from "../helpers/chat.js";
import {
	chooseSelectOption,
	openSettingsSection,
} from "../helpers/settings.js";

/**
 * Store certification: a key applied through Settings reaches the provider,
 * and a failing provider is shown as a failure — never as a silent
 * "$0.000000 · 0 tokens" success.
 *
 * 예전에는 Gemini 를 골랐다. #602 가 그 공급자를 지워 선택 자체가 헛돌았고,
 * select.value 를 직접 넣어 React onChange 도 돌지 않았다. 지금 설정에서 API
 * 키 칸이 뜨는 공급자는 ollama 다. 닫힌 포트를 호스트로 주면 공급자 실패가
 * 결정적으로 난다.
 */
const DEAD_OLLAMA_HOST = "http://127.0.0.1:9";

describe("Store certification native journey", () => {
	it("applies a provider key through Settings and exposes provider failure", async () => {
		await openSettingsSection("brain");
		const provider = await $("#provider-select");
		await provider.waitForDisplayed({ timeout: 30_000 });
		expect(await chooseSelectOption("#provider-select", "ollama")).toBe(true);

		const apiKey = await $("#apikey-input");
		await apiKey.waitForDisplayed({ timeout: 30_000 });
		await apiKey.setValue("store-invalid-key");

		// Ollama Host 칸에는 id 가 없다 — 라벨로 찾아 값을 넣고 blur 로 저장한다.
		await browser.execute((host: string) => {
			const label = Array.from(
				document.querySelectorAll(".settings-field > label"),
			).find((el) => el.textContent?.trim() === "Ollama Host");
			const input = label?.parentElement?.querySelector(
				"input",
			) as HTMLInputElement | null;
			if (!input) throw new Error("Ollama Host input not found");
			const setter = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set;
			setter?.call(input, host);
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("blur", { bubbles: true }));
			input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		}, DEAD_OLLAMA_HOST);

		const apply = await $(".settings-save-btn");
		await apply.waitForEnabled({ timeout: 30_000 });
		await apply.click();

		await browser.waitUntil(
			async () =>
				browser.execute(() => {
					const raw = localStorage.getItem("naia-config");
					const config = raw ? JSON.parse(raw) : {};
					return config.provider === "ollama";
				}),
			{
				timeout: 30_000,
				timeoutMsg: "Settings Apply did not persist ollama as the main provider",
			},
		);

		await browser.execute(() => {
			const tab = document.querySelector(".chat-tabs .chat-tab") as HTMLElement | null;
			tab?.click();
		});

		// 닿지 않는 공급자다 — 실패가 채팅 오류로 드러나야 통과다.
		let failure = "";
		try {
			await sendMessage("certification native probe");
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}
		expect(failure).toContain("Chat request failed");

		const pageText = await browser.execute(() => document.body.innerText);
		expect(pageText).not.toMatch(/\$0\.000000\s*[·•]?\s*0 tokens/i);
	});
});
