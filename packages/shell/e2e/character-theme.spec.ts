import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { TAURI_BASE_MOCK_FALLBACK } from "./helpers/tauri-base-mock";

const config = {
	provider: "ollama",
	model: "test-local",
	apiKey: "",
	locale: "en",
	onboardingComplete: true,
	persona: "previous persona",
	nvaModel: "naia",
	avatarProvider: "naia-video-avatar",
	ttsProvider: "edge",
	ttsVoice: "ko-KR-SunHiNeural",
};
for (const width of [1100, 360]) {
	test(`card and theme settings ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width: 1100, height: 900 });
		await page.addInitScript((seed) => {
			localStorage.setItem("naia-adk-path", "/mock/b2c-adk");
			if (!localStorage.getItem("b2c-test-initialized")) {
				localStorage.setItem("naia-config", JSON.stringify(seed));
				localStorage.setItem("b2c-test-initialized", "1");
			}
			const win = window as any;
			win.__writes = [];
			win.__failNextWrite = false;
			win.__failUiWrites = false;
			win.__TAURI_INTERNALS__ = {
				metadata: {
					currentWindow: { label: "main" },
					currentWebview: { label: "main", windowLabel: "main" },
				},
				transformCallback: () => 1,
				unregisterCallback: () => {},
				convertFileSrc: (p: string) => p,
				invoke: async (cmd: string, args: any) => {
					if (cmd === "plugin:event|listen") return 1;
					if (cmd === "read_naia_config")
						return (
							localStorage.getItem("b2c-test-native-config") ??
							JSON.stringify(seed)
						);
					if (cmd === "read_naia_ui_config")
						return localStorage.getItem("b2c-test-ui-config") ?? "{}";
					if (cmd === "write_naia_config" || cmd === "write_naia_ui_config") {
						if (cmd === "write_naia_ui_config" && win.__failUiWrites)
							throw new Error("fixture UI write failed");
						if (win.__failNextWrite && args.json.includes("A kind gardener")) {
							win.__failNextWrite = false;
							throw new Error("fixture write failed");
						}
						await new Promise((resolve) => setTimeout(resolve, 200));
						win.__writes.push({ cmd, json: JSON.parse(args.json) });
						const history = JSON.parse(
							localStorage.getItem("b2c-test-write-log") ?? "[]",
						);
						history.push({
							cmd,
							agentName: JSON.parse(args.json).agentName,
							card: JSON.parse(args.json).uiPreferences?.b2cActiveCardId,
							at: Date.now(),
						});
						localStorage.setItem("b2c-test-write-log", JSON.stringify(history));
						localStorage.setItem(
							cmd === "write_naia_config"
								? "b2c-test-native-config"
								: "b2c-test-ui-config",
							args.json,
						);
						return null;
					}
					if (cmd === "list_naia_assets")
						return args.subdir === "nva-files" ? ["naia"] : [];
					return undefined;
				},
			};
			win.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
		}, config);
		await page.addInitScript(TAURI_BASE_MOCK_FALLBACK);
		await page.goto("/");
		await expect(page.locator(".chat-app")).toBeVisible();
		// Open actual Shell settings, then its persona tab.
		await page.locator(".app-bar-settings").click();
		await page.locator('[data-settings-tab="persona"]').click();
		await page.setViewportSize({ width, height: 900 });
		const section = page.getByRole("region", {
			name: "Character cards and NVA themes",
		});
		await expect(section.getByText("No card selected.")).toBeVisible();
		await expect(
			section.getByText("No saved themes.", { exact: false }),
		).toBeVisible();
		const input = page.locator("#character-card-file");
		await input.setInputFiles({
			name: "bad.json",
			mimeType: "application/json",
			buffer: Buffer.from("{broken"),
		});
		await expect(section.getByRole("alert")).toContainText("Choose a valid");
		await expect(page.locator("#persona-input")).toHaveValue(
			"previous persona",
		);
		await input.setInputFiles({
			name: "card.json",
			mimeType: "application/json",
			buffer: Buffer.from(
				JSON.stringify({
					spec: "chara_card_v3",
					spec_version: "3.0",
					data: {
						name: "Garden friend",
						description: "A kind gardener",
						first_mes: "Welcome to my garden",
						mes_example: "{{char}}: Flowers bloom",
					},
				}),
			),
		});
		await expect(
			section.getByText("Welcome to my garden", { exact: true }),
		).toBeVisible();
		const apply = section.getByRole("button", {
			name: "Apply card",
			exact: true,
		});
		await page.evaluate(() => {
			(window as any).__failNextWrite = true;
		});
		await apply.click();
		await expect(section.getByRole("alert")).toContainText("try again");
		await expect(page.locator("#persona-input")).toHaveValue(
			"previous persona",
		);
		await apply.focus();
		await page.keyboard.press("Enter");
		await expect(apply).toBeDisabled();
		await expect(input).toBeDisabled();
		await expect(section.getByRole("status")).toContainText("Card applied");
		await page.screenshot({
			path: test.info().outputPath(`card-import-${width}.png`),
			fullPage: true,
		});
		await expect(page.locator("#persona-input")).toHaveValue(/A kind gardener/);
		await expect(page.locator("#persona-input")).toHaveValue(/Flowers bloom/);
		await section
			.getByLabel("Theme name", { exact: true })
			.fill("Garden theme");
		await page.evaluate(() => {
			(window as any).__failUiWrites = true;
		});
		await section.getByRole("button", { name: "Save current theme" }).click();
		await expect(section.getByRole("alert")).toContainText("try again");
		await expect(
			section.getByText("No saved themes.", { exact: false }),
		).toBeVisible();
		await page.evaluate(() => {
			(window as any).__failUiWrites = false;
		});
		await section.getByRole("button", { name: "Save current theme" }).click();
		await expect(section.getByRole("status")).toContainText("Theme saved");
		await section
			.getByRole("button", { name: "Apply theme", exact: true })
			.click();
		await expect(section.getByRole("status")).toContainText("Theme applied");
		await apply.click();
		await expect(section.getByRole("status")).toContainText("Card applied");
		await page.screenshot({
			path: test.info().outputPath(`theme-select-${width}.png`),
			fullPage: true,
		});
		const linked = await page.evaluate(() =>
			JSON.parse(localStorage.getItem("naia-config")!),
		);
		expect(linked.uiPreferences.b2cCardLibrary).toHaveLength(1);
		expect(linked.uiPreferences.b2cCardLibrary[0].themeId).toBe(
			linked.uiPreferences.b2cNvaThemes[0].id,
		);
		expect(
			JSON.parse(atob(linked.uiPreferences.b2cCardLibrary[0].sourceBase64)).data
				.name,
		).toBe("Garden friend");
		await section
			.getByLabel("Theme name", { exact: true })
			.fill("Updated garden");
		await section
			.getByRole("button", { name: "Update selected theme" })
			.click();
		await expect(section.getByRole("status")).toContainText("Theme updated");
		await expect(
			section
				.getByLabel("Saved themes", { exact: true })
				.locator("option:checked"),
		).toHaveText("Updated garden");
		await section
			.getByRole("button", { name: "Delete selected theme" })
			.click();
		await expect(section.getByRole("status")).toContainText("Theme deleted");
		expect(
			await page.evaluate(
				() =>
					JSON.parse(localStorage.getItem("naia-config")!).uiPreferences
						.b2cCardLibrary[0].themeId,
			),
		).toBeUndefined();
		const pngPath = resolve(
			"src/apps/charcard/package-public/samples/greenhouse-keeper.png",
		);
		await input.setInputFiles(pngPath);
		await apply.click();
		await expect(section.getByRole("status")).toContainText("Card applied");
		const downloadPromise = page.waitForEvent("download");
		await section.getByRole("button", { name: "Export original card" }).click();
		const download = await downloadPromise;
		const exportedPath = test.info().outputPath("exported-original.png");
		await download.saveAs(exportedPath);
		expect(readFileSync(exportedPath).equals(readFileSync(pngPath))).toBe(true);
		await section
			.getByLabel("Card library", { exact: true })
			.selectOption(linked.uiPreferences.b2cCardLibrary[0].id);
		await apply.click();
		await expect(section.getByRole("status")).toContainText("Card applied");
		await page.locator(".app-bar-settings").click();
		await expect(page.locator(".chat-app")).toContainText(
			"Welcome to my garden",
		);
		await expect(page.locator(".chat-app")).not.toContainText("온새미");
		await page.screenshot({
			path: test.info().outputPath(`card-conversation-${width}.png`),
			fullPage: true,
		});
		await page.reload();
		await page.setViewportSize({ width: 1100, height: 900 });
		await page.locator(".app-bar-settings").click();
		await page.locator('[data-settings-tab="persona"]').click();
		await page.setViewportSize({ width, height: 900 });
		await expect(
			section.getByLabel("Card library", { exact: true }).locator("option"),
		).toHaveCount(3);
		await section
			.getByLabel("Card library", { exact: true })
			.selectOption(linked.uiPreferences.b2cCardLibrary[0].id);
		await expect(
			section.getByText("Welcome to my garden", { exact: true }),
		).toBeVisible();
		const saved = await page.evaluate(() =>
			JSON.parse(localStorage.getItem("naia-config")!),
		);
		expect(saved.provider).toBe("ollama");
		expect(saved.model).toBe("test-local");
		expect(saved.uiPreferences.b2cNvaThemes).toEqual([]);
		expect(saved.nvaModel).toBe("naia");
		const persisted = await page.evaluate(() => ({
			config: JSON.parse(localStorage.getItem("b2c-test-native-config")!),
			writes: JSON.parse(localStorage.getItem("b2c-test-write-log") ?? "[]"),
		}));
		expect(
			persisted.config.persona,
			JSON.stringify(persisted.writes),
		).toContain("Flowers bloom");
		await page.screenshot({
			path: test.info().outputPath(`before-bounds-${width}.png`),
			fullPage: true,
		});
		for (const element of [
			input,
			apply,
			section.getByLabel("Theme name", { exact: true }),
		]) {
			const box = await element.boundingBox();
			expect(box).not.toBeNull();
			expect(box!.x).toBeGreaterThanOrEqual(0);
			expect(
				box!.x + box!.width,
				JSON.stringify({
					box,
					html: await element.evaluate((e) => e.outerHTML),
				}),
			).toBeLessThanOrEqual(width);
		}
		await page.screenshot({
			path: test.info().outputPath(`character-theme-${width}.png`),
			fullPage: true,
		});
	});
}
