import { S } from "../helpers/selectors.js";
import { safeRefresh } from "../helpers/settings.js";

describe("19 — skills bulk migration", () => {
	before(async () => {
		// Ensure enableTools is set
		await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			const config = raw ? JSON.parse(raw) : {};
			config.enableTools = true;
			localStorage.setItem("naia-config", JSON.stringify(config));
		});
		await safeRefresh();
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	it("should show built-in skills in skills tab", async () => {
		// Navigate to Skills tab
		await browser.execute((sel: string) => {
			const el = document.querySelector(sel) as HTMLButtonElement | null;
			el?.click();
		}, S.skillsTab);
		await browser.pause(1000);

		// Count skill cards (not .skill-item)
		const count = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.skillsCard,
		);

		// At least 7 built-in skills should be visible
		expect(count).toBeGreaterThanOrEqual(7);
	});

	it("should find time skill via search", async () => {
		// Search for a skill using the search input
		const hasSearch = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.skillsSearch,
		);

		if (hasSearch) {
			await browser.execute((sel: string) => {
				const input = document.querySelector(
					`${sel} input`,
				) as HTMLInputElement | null;
				if (input) {
					const setter = Object.getOwnPropertyDescriptor(
						HTMLInputElement.prototype,
						"value",
					)?.set;
					if (setter) setter.call(input, "time");
					else input.value = "time";
					input.dispatchEvent(new Event("input", { bubbles: true }));
				}
			}, S.skillsSearch);
			await browser.pause(500);

			const results = await browser.execute(
				(sel: string) => document.querySelectorAll(sel).length,
				S.skillsCard,
			);
			expect(results).toBeGreaterThan(0);
		}
	});

	it("should find weather skill via search", async () => {
		const hasSearch = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.skillsSearch,
		);

		if (hasSearch) {
			await browser.execute((sel: string) => {
				const input = document.querySelector(
					`${sel} input`,
				) as HTMLInputElement | null;
				if (input) {
					const setter = Object.getOwnPropertyDescriptor(
						HTMLInputElement.prototype,
						"value",
					)?.set;
					if (setter) setter.call(input, "weather");
					else input.value = "weather";
					input.dispatchEvent(new Event("input", { bubbles: true }));
				}
			}, S.skillsSearch);
			await browser.pause(500);

			const results = await browser.execute(
				(sel: string) => document.querySelectorAll(sel).length,
				S.skillsCard,
			);
			expect(results).toBeGreaterThan(0);
		}

		// Go back to chat tab
		await browser.execute((sel: string) => {
			const el = document.querySelector(sel) as HTMLButtonElement | null;
			el?.click();
		}, S.chatTab);
	});
});
