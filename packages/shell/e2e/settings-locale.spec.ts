import { expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

function localeWriteMock(failFirstWrite = false): string {
	return `
(function() {
	window.__localeConfigWrites = [];
	window.__localeReloads = 0;
	window.__localeEvents = [];
	window.addEventListener("naia:locale-change", function(event) {
		window.__localeEvents.push(event.detail);
	});
	window.__failLocaleReload = false;
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
		if (window.__holdLocaleWrite) await new Promise(function(resolve) {
			window.__localeWriteRelease = function() {
				window.__holdLocaleWrite = false;
				resolve();
			};
		});
			window.__localeConfigWrites.push(JSON.parse(args.json));
			return null;
		}
		if (cmd === "reload_agent_settings") {
			window.__localeReloads += 1;
			if (window.__failLocaleReload) throw new Error("agent not running");
			return null;
		}
		return undefined;
	};
})();
`;
}

async function openSettings(
	page: import("@playwright/test").Page,
	failFirstWrite = false,
) {
	await page.addInitScript(
		`${localeWriteMock(failFirstWrite)}\n${TAURI_BASE_MOCK_FALLBACK}\n${SEED_ADK_PATH}\n(${() => {
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
		}})();`,
	);
	await page.goto("/");
	await expect(page.locator(".chat-app")).toBeVisible({ timeout: 15_000 });
	await page.locator(".app-bar-settings").click();
	await page.locator('[data-settings-tab="general"]').click();
	await expect(page.locator("#locale-select")).toBeEnabled();
	if (failFirstWrite) {
		await page.evaluate(() => {
			(window as any).__failLocaleNextWrite = true;
		});
	}
}

test.describe("Settings locale persistence", () => {
	test("persists the detected locale once for a first-run workspace", async ({
		page,
	}) => {
		await page.addInitScript(
			`${localeWriteMock()}\n${TAURI_BASE_MOCK_FALLBACK}\n${SEED_ADK_PATH}`,
		);
		await page.goto("/");
		await expect(page.locator(".chat-app")).toBeVisible({ timeout: 15_000 });
		await expect
			.poll(() =>
				page.evaluate(() => (window as any).__localeConfigWrites.length),
			)
			.toBeGreaterThan(0);
		const writes = await page.evaluate(
			() => (window as any).__localeConfigWrites,
		);
		expect(writes[0].locale).toBe("en");
	});

	test("updates the screen, config cache and agent config immediately, including at narrow width", async ({
		page,
	}) => {
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
		await page.evaluate(() => {
			(window as any).__holdLocaleWrite = true;
		});
		await picker.focus();
		await page.keyboard.press("Enter");
		await page.getByRole("button", { name: "English" }).click();
		await expect(picker).toHaveAttribute("data-value", "en");
		await expect(picker).toBeDisabled();
		await expect(page.locator('.settings-hint[role="status"]')).toHaveText(
			"Saving…",
		);
		await picker.click({ force: true });
		await expect(page.getByRole("button", { name: "日本語" })).toHaveCount(0);
		await expect
			.poll(() =>
				page.evaluate(
					() => JSON.parse(localStorage.getItem("naia-config") ?? "{}").locale,
				),
			)
			.toBe("en");
		await expect
			.poll(() =>
				page.evaluate(() => typeof (window as any).__localeWriteRelease),
			)
			.toBe("function");
		await expect
			.poll(() =>
				page.evaluate(() => (window as any).__localeConfigWrites.length),
			)
			.toBe(writesBeforeSelection);
		await expect
			.poll(() => page.evaluate(() => (window as any).__localeEvents.length))
			.toBe(0);
		await expect(page.locator(".app-bar-settings")).toBeVisible();
		await page.evaluate(() => (window as any).__localeWriteRelease());
		await expect
			.poll(() =>
				page.evaluate(
					() => (window as any).__localeConfigWrites?.at(-1)?.locale,
				),
			)
			.toBe("en");
		await expect
			.poll(() =>
				page.evaluate(
					() => (window as any).__localeConfigWrites?.at(-1)?.NAIA_LOCALE,
				),
			)
			.toBe("en");
		await expect
			.poll(() => page.evaluate(() => (window as any).__localeReloads))
			.toBeGreaterThan(reloadsBeforeSelection);
		await expect
			.poll(() => page.evaluate(() => (window as any).__localeEvents))
			.toEqual(["en"]);
		await expect(picker).toHaveAttribute("data-value", "en");

		await picker.click();
		await page.getByRole("button", { name: "日本語" }).click();
		await expect(picker).toHaveAttribute("data-value", "ja");
		await expect
			.poll(() =>
				page.evaluate(
					() => (window as any).__localeConfigWrites?.at(-1)?.locale,
				),
			)
			.toBe("ja");
		await expect
			.poll(() => page.evaluate(() => (window as any).__localeEvents))
			.toEqual(["en", "ja"]);

		const bounds = await picker.evaluate((element) => {
			const rect = element.getBoundingClientRect();
			return {
				left: rect.left,
				right: rect.right,
				viewport: window.innerWidth,
			};
		});
		expect(bounds.left).toBeGreaterThanOrEqual(0);
		expect(bounds.right).toBeLessThanOrEqual(bounds.viewport);
	});

	test("shows a retryable save error and succeeds when the locale is selected again", async ({
		page,
	}) => {
		await openSettings(page, true);
		const picker = page.locator("#locale-select");
		const reloadsBeforeFailure = await page.evaluate(
			() => (window as any).__localeReloads,
		);
		await picker.click();
		await page.getByRole("button", { name: "English" }).click();
		await expect(page.locator(".settings-error")).toContainText(
			"설정을 저장하지 못했습니다",
		);
		await expect(picker).toHaveAttribute("data-value", "ko");
		await expect
			.poll(() =>
				page.evaluate(
					() => JSON.parse(localStorage.getItem("naia-config") ?? "{}").locale,
				),
			)
			.toBe("ko");
		await expect
			.poll(() => page.evaluate(() => (window as any).__localeEvents.length))
			.toBe(0);

		await picker.click();
		await page.getByRole("button", { name: "English" }).click();
		await expect(page.locator(".settings-error")).toHaveCount(0);
		await expect
			.poll(() =>
				page.evaluate(
					() => (window as any).__localeConfigWrites?.at(-1)?.locale,
				),
			)
			.toBe("en");
		await expect
			.poll(() => page.evaluate(() => (window as any).__localeReloads))
			.toBe(reloadsBeforeFailure + 1);
	});

	test("keeps the saved locale and emits the voice event when the agent is stopped", async ({
		page,
	}) => {
		await openSettings(page);
		await page.evaluate(() => {
			(window as any).__failLocaleReload = true;
		});
		const picker = page.locator("#locale-select");
		await picker.click();
		await page.getByRole("button", { name: "English" }).click();
		await expect(picker).toHaveAttribute("data-value", "en");
		await expect(page.locator(".settings-error")).toHaveCount(0);
		await expect
			.poll(() =>
				page.evaluate(
					() => (window as any).__localeConfigWrites?.at(-1)?.locale,
				),
			)
			.toBe("en");
		await expect
			.poll(() => page.evaluate(() => (window as any).__localeEvents))
			.toEqual(["en"]);
	});
});
