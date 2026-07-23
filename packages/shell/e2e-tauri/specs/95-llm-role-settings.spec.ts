import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const adkPath = process.env.NAIA_E2E_ADK_PATH;

function readPersistedConfig(): Record<string, unknown> {
	if (!adkPath) throw new Error("NAIA_E2E_ADK_PATH is required for role settings E2E");
	return JSON.parse(
		readFileSync(resolve(adkPath, "naia-settings/config.json"), "utf8"),
	) as Record<string, unknown>;
}

async function setSelect(selector: string, value: string): Promise<void> {
	await browser.execute((target: string, next: string) => {
		const select = document.querySelector<HTMLSelectElement>(target);
		if (!select) throw new Error(`Missing select ${target}`);
		const setter = Object.getOwnPropertyDescriptor(
			window.HTMLSelectElement.prototype,
			"value",
		)?.set;
		setter?.call(select, next);
		select.dispatchEvent(new Event("change", { bubbles: true }));
	}, selector, value);
}

async function setInput(selector: string, value: string): Promise<void> {
	await browser.execute((target: string, next: string) => {
		const input = document.querySelector<HTMLInputElement>(target);
		if (!input) throw new Error(`Missing input ${target}`);
		const setter = Object.getOwnPropertyDescriptor(
			window.HTMLInputElement.prototype,
			"value",
		)?.set;
		setter?.call(input, next);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));
		input.dispatchEvent(new Event("blur", { bubbles: true }));
	}, selector, value);
}

describe("LLM role settings through the real Tauri Shell", () => {
	it("stores separate sub settings, inherits memory from main, and restores both after a WebView restart", async () => {
		if (!adkPath) throw new Error("NAIA_E2E_ADK_PATH is required for role settings E2E");
		const settings = await $(".app-bar-settings");
		await settings.waitForClickable({ timeout: 30_000 });
		await settings.click();
		const brainTab = await $("[data-settings-tab='brain']");
		await brainTab.waitForClickable({ timeout: 30_000 });
		await brainTab.click();

		const subMode = await $("[data-testid='sub-llm-mode']");
		const memoryMode = await $("[data-testid='memory-llm-mode']");
		expect(await subMode.getValue()).toBe("inherit:main");
		expect(await memoryMode.getValue()).toBe("inherit:sub");

		await setSelect("[data-testid='sub-llm-mode']", "explicit");
		const subProvider = await $("[data-testid='sub-llm-provider']");
		expect(await subProvider.$("option[value='codex']").isExisting()).toBe(false);
		await setSelect("[data-testid='sub-llm-provider']", "gemini");
		await setInput("[data-testid='sub-llm-model']", "gemini-3.1-flash-lite");
		await setSelect("[data-testid='memory-llm-mode']", "inherit:main");

		await browser.waitUntil(() => {
			const roles = readPersistedConfig().llmRoles as Record<string, unknown>;
			const sub = roles?.sub as Record<string, unknown> | undefined;
			const memory = roles?.memory as Record<string, unknown> | undefined;
			return (
				sub?.provider === "gemini" &&
				sub?.model === "gemini-3.1-flash-lite" &&
				memory?.inherit === "main"
			);
		}, { timeout: 30_000, timeoutMsg: "role settings were not written to the isolated ADK config" });

		await browser.refresh();
		const restartedSettings = await $(".app-bar-settings");
		await restartedSettings.waitForClickable({ timeout: 45_000 });
		await restartedSettings.click();
		const restartedBrainTab = await $("[data-settings-tab='brain']");
		await restartedBrainTab.waitForClickable({ timeout: 30_000 });
		await restartedBrainTab.click();
		await browser.waitUntil(
			async () =>
				(await (await $("[data-testid='sub-llm-mode']")).getValue()) ===
					"explicit" &&
				(await (await $("[data-testid='memory-llm-mode']")).getValue()) ===
					"inherit:main",
			{
				timeout: 30_000,
				timeoutMsg: "persisted LLM role settings did not hydrate after WebView restart",
			},
		);
		expect(await (await $("[data-testid='sub-llm-mode']")).getValue()).toBe("explicit");
		expect(await (await $("[data-testid='sub-llm-provider']")).getValue()).toBe("gemini");
		expect(await (await $("[data-testid='sub-llm-model']")).getValue()).toBe(
			"gemini-3.1-flash-lite",
		);
		expect(await (await $("[data-testid='memory-llm-mode']")).getValue()).toBe(
			"inherit:main",
		);
	});
});
