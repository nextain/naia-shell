import { S } from "../helpers/selectors.js";
import {
	clickBySelector,
	ensureAppReady,
	navigateToSettings,
	openSettingsSection,
	scrollToSection,
} from "../helpers/settings.js";

/**
 * 64 — Settings: Gateway TTS Provider
 *
 * Verifies the TTS provider control in the Settings voice section:
 * - Gateway TTS provider select renders
 * - Value can be changed
 */
describe("64 — settings gateway TTS", () => {
	before(async () => {
		await ensureAppReady();
		await navigateToSettings();
		const settingsTab = await $(S.settingsTab);
		await settingsTab.waitForDisplayed({ timeout: 10_000 });
	});

	it("should scroll to Gateway TTS section", async () => {
		await openSettingsSection("voice");
		await scrollToSection(S.gatewayTtsProvider);
		const exists = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.gatewayTtsProvider,
		);
		expect(exists).toBe(true);
	});

	it("should have TTS provider select with options", async () => {
		await openSettingsSection("voice");
		const exists = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.gatewayTtsProvider,
		);
		expect(exists).toBe(true);

		const optionCount = await browser.execute((sel: string) => {
			const select = document.querySelector(sel) as HTMLSelectElement | null;
			return select?.options.length ?? 0;
		}, S.gatewayTtsProvider);

		expect(optionCount).toBeGreaterThanOrEqual(1);
	});

	it("should show current TTS provider value", async () => {
		await openSettingsSection("voice");
		const exists = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.gatewayTtsProvider,
		);
		expect(exists).toBe(true);

		const value = await browser.execute(
			(sel: string) =>
				(document.querySelector(sel) as HTMLSelectElement)?.value ?? "",
			S.gatewayTtsProvider,
		);
		expect(value.length).toBeGreaterThan(0);
	});

	it("should change TTS provider value", async () => {
		await openSettingsSection("voice");
		const optionCount = await browser.execute((sel: string) => {
			const select = document.querySelector(sel) as HTMLSelectElement | null;
			return select?.options.length ?? 0;
		}, S.gatewayTtsProvider);
		expect(optionCount).toBeGreaterThanOrEqual(2);

		const alternative = await browser.execute((sel: string) => {
			const select = document.querySelector(sel) as HTMLSelectElement | null;
			if (!select) return "";
			const current = select.value;
			return (
				Array.from(select.options).find(
					(option) =>
						!option.disabled &&
						option.value !== current &&
						option.value !== "naia-local-voice",
				)?.value ?? ""
			);
		}, S.gatewayTtsProvider);
		expect(alternative.length).toBeGreaterThan(0);

		await browser.execute(
			(sel: string, value: string) => {
				const select = document.querySelector(sel) as HTMLSelectElement | null;
				if (!select) throw new Error(`TTS provider select ${sel} not found`);
				select.value = value;
				select.dispatchEvent(new Event("change", { bubbles: true }));
			},
			S.gatewayTtsProvider,
			alternative,
		);
		await browser.pause(500);

		const updated = await browser.execute(
			(sel: string) =>
				(document.querySelector(sel) as HTMLSelectElement)?.value ?? "",
			S.gatewayTtsProvider,
		);

		expect(updated).toBe(alternative);
	});

	it("should navigate back to chat tab", async () => {
		await clickBySelector(S.chatTab);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
