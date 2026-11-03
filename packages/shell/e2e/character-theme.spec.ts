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
			localStorage.setItem("naia-config", JSON.stringify(seed));
			const win = window as any;
			win.__writes = [];
			win.__failNextWrite = false;
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
					if (cmd === "read_naia_config") return JSON.stringify(seed);
					if (cmd === "read_naia_ui_config") return "{}";
					if (cmd === "write_naia_config" || cmd === "write_naia_ui_config") {
						if (win.__failNextWrite && args.json.includes("A kind gardener")) {
							win.__failNextWrite = false;
							throw new Error("fixture write failed");
						}
						await new Promise((resolve) => setTimeout(resolve, 200));
						win.__writes.push({ cmd, json: JSON.parse(args.json) });
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
		await expect(page.locator("#persona-input")).toHaveValue(/A kind gardener/);
		await expect(page.locator("#persona-input")).toHaveValue(/Flowers bloom/);
		await section
			.getByLabel("Theme name", { exact: true })
			.fill("Garden theme");
		await section.getByRole("button", { name: "Save current theme" }).click();
		await expect(section.getByRole("status")).toContainText("Theme saved");
		await section
			.getByRole("button", { name: "Apply theme", exact: true })
			.click();
		await expect(section.getByRole("status")).toContainText("Theme applied");
		const saved = await page.evaluate(() =>
			JSON.parse(localStorage.getItem("naia-config")!),
		);
		expect(saved.provider).toBe("ollama");
		expect(saved.model).toBe("test-local");
		expect(saved.uiPreferences.b2cNvaThemes[0].name).toBe("Garden theme");
		expect(saved.nvaModel).toBe("naia");
		expect(
			await page.evaluate(() =>
				(window as any).__writes.some(
					(w: any) =>
						w.cmd === "write_naia_config" &&
						w.json.persona?.includes("Flowers bloom"),
				),
			),
		).toBe(true);
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
