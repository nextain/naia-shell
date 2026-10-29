import { expect, test } from "@playwright/test";
import { SEED_ADK_PATH, TAURI_BASE_MOCK_FALLBACK } from "./helpers/tauri-base-mock";

function localeWriteMock(failFirstWrite = false): string {
	return `
(function() {
	window.__localeConfigWrites = [];
	window.__localeReloads = 0;
	window.__failLocaleNextWrite = false;
	window.__holdLocaleWrite = false;
		window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
		window.__TAURI_INTERNALS__.metadata = { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } };
		window.__TAURI_INTERNALS__.transformCallback = function(fn) { return 1; };
		window.__TAURI_INTERNALS__.unregisterCallback = function() {};
		window.__TAURI_INTERNALS__.convertFileSrc = function(path, proto) { return (proto || "asset") + "://localhost/" + encodeURIComponent(path); };
	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		if (cmd === "write_naia_config") {
			if (window.__failLocaleNextWrite) { window.__failLocaleNextWrite = false; throw new Error("locale write failed"); }
			if (window.__holdLocaleWrite) await new Promise(function(resolve) { window.__localeWriteRelease = resolve; });
			window.__localeConfigWrites.push(JSON.parse(args.json));
			return null;
		}
		if (cmd === "reload_agent_settings") { window.__localeReloads += 1; return null; }
		return undefined;
	};
})();
`;
}

async function openSettings(page: import("@playwright/test").Page, failFirstWrite = false) {
	await page.addInitScript(`${localeWriteMock(failFirstWrite)}\n${TAURI_BASE_MOCK_FALLBACK}\n${SEED_ADK_PATH}\n(${() => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "test-key",
				locale: "ko",
				onboardingComplete: true,
			}),
		);
	}})();`);
	await page.goto("/");
	await expect(page.locator(".chat-app")).toBeVisible({ timeout: 15_000 });
	await page.locator(".app-bar-settings").click();
	await page.locator('[data-settings-tab="general"]').click();
	if (failFirstWrite) {
		await page.evaluate(() => ((window as any).__failLocaleNextWrite = true));
	}
}

test.describe("Settings locale persistence", () => {
	test("updates the screen, config cache and agent config immediately, including at narrow width", async ({ page }) => {
		await openSettings(page);
		await page.setViewportSize({ width: 800, height: 800 });

		const picker = page.locator("#locale-select");
		await expect(picker).toHaveAttribute("data-value", "ko");
		const reloadsBeforeSelection = await page.evaluate(
			() => (window as any).__localeReloads,
		);
		const writesBeforeSelection = await page.evaluate(
			() => (window as any).__localeConfigWrites.length,
		);
		await page.evaluate(() => ((window as any).__holdLocaleWrite = true));
		await picker.focus();
		await page.keyboard.press("Enter");
		await page.getByRole("button", { name: "English" }).click();
		await expect(picker).toHaveAttribute("data-value", "en");
		await expect
			.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("naia-config") ?? "{}").locale))
			.toBe("en");
		await expect
			.poll(() => page.evaluate(() => typeof (window as any).__localeWriteRelease))
			.toBe("function");
		await expect
			.poll(() => page.evaluate(() => (window as any).__localeConfigWrites.length))
			.toBe(writesBeforeSelection);
		await expect(page.locator(".app-bar-settings")).toBeVisible();
		await page.evaluate(() => (window as any).__localeWriteRelease());
		await expect
			.poll(() => page.evaluate(() => (window as any).__localeConfigWrites?.at(-1)?.locale))
			.toBe("en");
		await expect
			.poll(() => page.evaluate(() => (window as any).__localeConfigWrites?.at(-1)?.NAIA_LOCALE))
			.toBe("en");
		await expect
			.poll(() => page.evaluate(() => (window as any).__localeReloads))
			.toBeGreaterThan(reloadsBeforeSelection);

		const bounds = await picker.evaluate((element) => {
			const rect = element.getBoundingClientRect();
			return { left: rect.left, right: rect.right, viewport: window.innerWidth };
		});
		expect(bounds.left).toBeGreaterThanOrEqual(0);
		expect(bounds.right).toBeLessThanOrEqual(bounds.viewport);
	});

	test("shows a retryable save error and succeeds when the locale is selected again", async ({ page }) => {
		await openSettings(page, true);
		const picker = page.locator("#locale-select");
		const reloadsBeforeFailure = await page.evaluate(
			() => (window as any).__localeReloads,
		);
		await picker.click();
		await page.getByRole("button", { name: "English" }).click();
		await expect(page.locator(".settings-error")).toContainText("locale write failed");
		await expect(picker).toHaveAttribute("data-value", "en");

		await picker.click();
		await page.getByRole("button", { name: "English" }).click();
		await expect(page.locator(".settings-error")).toHaveCount(0);
		await expect
			.poll(() => page.evaluate(() => (window as any).__localeConfigWrites?.at(-1)?.locale))
			.toBe("en");
		await expect
			.poll(() => page.evaluate(() => (window as any).__localeReloads))
			.toBe(reloadsBeforeFailure + 1);
	});
});
