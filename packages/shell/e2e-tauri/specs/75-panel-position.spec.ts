import { S } from "../helpers/selectors.js";
import { safeRefresh } from "../helpers/settings.js";

const SHOT = "/tmp/panel-screenshots";

/** Click the panel toggle button in titlebar */
async function clickPanelToggle() {
	// Panel toggle is the first button in .titlebar-buttons
	const btn = await $(".titlebar-buttons button:first-child");
	await btn.click();
	await browser.pause(500);
}

describe("75 — Panel Position & Visibility", () => {
	before(async () => {
		// Reset config to defaults (clear stale state from previous runs)
		await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			const config = raw ? JSON.parse(raw) : {};
			config.panelPosition = "bottom";
			config.panelVisible = true;
			localStorage.setItem("naia-config", JSON.stringify(config));
		});
		await safeRefresh();
		await $(S.appRoot).waitForDisplayed({ timeout: 15_000 });
		await browser.pause(500);
	});

	it("01 — default: side-panel visible with avatar in main-area", async () => {
		const panel = await $(".side-panel");
		await panel.waitForDisplayed({ timeout: 10_000 });

		// Avatar is in main-area, not in side-panel
		const mainArea = await $(".main-area");
		expect(await mainArea.isDisplayed()).toBe(true);

		await browser.saveScreenshot(`${SHOT}/01-default.png`);
	});

	it("02 — titlebar toggle hides panel, keeps avatar", async () => {
		await clickPanelToggle();
		await browser.saveScreenshot(`${SHOT}/02-panel-hidden.png`);

		// Avatar in main-area remains
		const mainArea = await $(".main-area");
		expect(await mainArea.isDisplayed()).toBe(true);

		// Side panel gone
		const panel = await $(".side-panel");
		expect(await panel.isExisting()).toBe(false);
	});

	it("03 — titlebar toggle restores panel", async () => {
		await clickPanelToggle();
		await browser.saveScreenshot(`${SHOT}/03-panel-restored.png`);

		const panel = await $(".side-panel");
		await panel.waitForDisplayed({ timeout: 5_000 });
	});

	it("04 — panelVisible persists across refresh", async () => {
		// Hide
		await clickPanelToggle();

		await safeRefresh();
		await $(S.appRoot).waitForDisplayed({ timeout: 15_000 });
		await browser.pause(500);
		await browser.saveScreenshot(`${SHOT}/04-hidden-after-refresh.png`);

		// Avatar stays
		const mainArea = await $(".main-area");
		expect(await mainArea.isDisplayed()).toBe(true);
		// Panel gone
		const panel = await $(".side-panel");
		expect(await panel.isExisting()).toBe(false);

		// Restore
		await clickPanelToggle();
		await browser.pause(300);
	});

	it("05 — panelPosition=right", async () => {
		await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			const config = raw ? JSON.parse(raw) : {};
			config.panelPosition = "right";
			config.panelVisible = true;
			localStorage.setItem("naia-config", JSON.stringify(config));
		});

		await safeRefresh();
		await $(S.appRoot).waitForDisplayed({ timeout: 15_000 });
		await browser.pause(500);
		await browser.saveScreenshot(`${SHOT}/05-position-right.png`);

		const layout = await $(".app-layout");
		const pos = await layout.getAttribute("data-panel-position");
		expect(pos).toBe("right");
	});

	it("06 — panelPosition=bottom", async () => {
		await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			const config = raw ? JSON.parse(raw) : {};
			config.panelPosition = "bottom";
			config.panelVisible = true;
			localStorage.setItem("naia-config", JSON.stringify(config));
		});

		await safeRefresh();
		await $(S.appRoot).waitForDisplayed({ timeout: 15_000 });
		await browser.pause(500);
		await browser.saveScreenshot(`${SHOT}/06-position-bottom.png`);

		const layout = await $(".app-layout");
		const pos = await layout.getAttribute("data-panel-position");
		expect(pos).toBe("bottom");
	});

	it("07 — panelPosition=left + hidden persists", async () => {
		await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			const config = raw ? JSON.parse(raw) : {};
			config.panelPosition = "left";
			config.panelVisible = false;
			localStorage.setItem("naia-config", JSON.stringify(config));
		});

		await safeRefresh();
		await $(S.appRoot).waitForDisplayed({ timeout: 15_000 });
		await browser.pause(500);
		await browser.saveScreenshot(`${SHOT}/07-left-hidden.png`);

		// Avatar stays in main-area
		const mainArea = await $(".main-area");
		expect(await mainArea.isDisplayed()).toBe(true);
		// Panel gone
		const panel = await $(".side-panel");
		expect(await panel.isExisting()).toBe(false);

		// Restore
		await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			const config = raw ? JSON.parse(raw) : {};
			config.panelVisible = true;
			localStorage.setItem("naia-config", JSON.stringify(config));
		});
		await safeRefresh();
	});
});
