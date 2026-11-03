import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { TAURI_BASE_MOCK_FALLBACK } from "./helpers/tauri-base-mock";

const videoBase64 = readFileSync(
	resolve("e2e/fixtures/base-alpha-200.webm"),
).toString("base64");
const authoredAvBase64 = readFileSync(
	resolve("e2e/fixtures/sync-5s-25fps-av.webm"),
).toString("base64");
const config = {
	provider: "ollama",
	model: "test-local",
	apiKey: "",
	locale: "en",
	onboardingComplete: true,
	persona: "previous persona",
	nvaModel: "naia",
	backgroundVideo: "garden.png",
	avatarProvider: "naia-video-avatar",
	ttsProvider: "edge",
	ttsVoice: "ko-KR-SunHiNeural",
};
for (const width of [274, 1100, 360]) {
	test(`card and theme settings ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		await page.addInitScript(
			({ seed, videoBase64, authoredAvBase64 }) => {
				localStorage.setItem("naia-adk-path", "/mock/b2c-adk");
				if (!localStorage.getItem("b2c-test-initialized")) {
					localStorage.setItem("naia-config", JSON.stringify(seed));
					localStorage.setItem("b2c-test-initialized", "1");
				}
				const win = window as any;
				win.__writes = [];
				win.__chatWire = [];
				win.__badThemeClip = false;
				win.__failNextWrite = false;
				win.__denyConfigWrites = false;
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
						if (cmd === "send_to_agent_command") {
							win.__chatWire.push(JSON.parse(args.message));
							return null;
						}
						if (cmd === "read_naia_config")
							return (
								localStorage.getItem("b2c-test-native-config") ??
								JSON.stringify(seed)
							);
						if (cmd === "read_naia_ui_config")
							return localStorage.getItem("b2c-test-ui-config") ?? "{}";
						if (cmd === "write_naia_config" || cmd === "write_naia_ui_config") {
							if (win.__denyConfigWrites && cmd === "write_naia_config")
								throw new Error("fixture config writes denied");
							if (cmd === "write_naia_ui_config" && win.__failUiWrites)
								throw new Error("fixture UI write failed");
							if (
								win.__failNextWrite &&
								args.json.includes("A kind gardener")
							) {
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
							localStorage.setItem(
								"b2c-test-write-log",
								JSON.stringify(history),
							);
							localStorage.setItem(
								cmd === "write_naia_config"
									? "b2c-test-native-config"
									: "b2c-test-ui-config",
								args.json,
							);
							return null;
						}
						if (cmd === "read_local_binary") {
							if (args.path.endsWith("manifest.json"))
								return btoa(
									JSON.stringify({
										nva_version: "0.2",
										canvas: { width: 200, height: 200 },
										speech_clips: {
											greeting: {
												text: "Welcome to my garden",
												clip: "greeting.webm",
												locale: "en",
											},
										},
										animations: {
											idle: { clip: "idle.webm", loop: true },
											speak: { clip: "speak.webm", can_talk: true },
										},
									}),
								);
							if (args.path.endsWith("greeting.webm")) return authoredAvBase64;
							if (args.path.endsWith("garden.png"))
								return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==";
							return win.__badThemeClip ? btoa("broken video") : videoBase64;
						}
						if (cmd === "list_naia_assets")
							return args.subdir === "nva-files"
								? ["naia"]
								: args.subdir === "background"
									? ["/mock/b2c-adk/naia-settings/background/garden.png"]
									: [];
						return undefined;
					},
				};
				win.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
			},
			{ seed: config, videoBase64, authoredAvBase64 },
		);
		await page.addInitScript(TAURI_BASE_MOCK_FALLBACK);
		await page.goto("/");
		await expect(page.locator(".chat-app")).toBeVisible();
		await expect(page.locator(".splash-screen")).toBeHidden();
		// All chat actions fit the physical viewport before opening settings.
		const sendBounds = await page.locator(".chat-send-btn").boundingBox();
		expect(sendBounds!.x).toBeGreaterThanOrEqual(0);
		expect(sendBounds!.x + sendBounds!.width).toBeLessThanOrEqual(width);
		if (width === 274) {
			const input = page.locator(".chat-input");
			await input.fill("Narrow window message");
			for (const element of [input, page.locator(".chat-send-btn")]) {
				const box = await element.boundingBox();
				expect(box!.x).toBeGreaterThanOrEqual(0);
				expect(box!.x + box!.width).toBeLessThanOrEqual(width);
			}
			await page.screenshot({ path: test.info().outputPath("chat-274.png") });
			await input.press("Enter");
			await expect(page.locator(".chat-messages")).toContainText("Narrow window message");
			return;
		}
		// Open actual Shell settings, then its persona tab.
		const settingsEntry = page.locator(".app-bar-settings");
		const entryBounds = await settingsEntry.boundingBox();
		expect(entryBounds!.x).toBeGreaterThanOrEqual(0);
		expect(entryBounds!.x + entryBounds!.width).toBeLessThanOrEqual(width);
		await settingsEntry.click();
		const settings = page.locator(".content-app__slot--active");
		await expect(settings.locator(".settings-tab")).toBeVisible();
		await expect
			.poll(() =>
				settings.evaluate((el) => el.contains(document.activeElement)),
			)
			.toBe(true);
		for (let i = 0; i < 140; i++) {
			await page.keyboard.press(i < 70 ? "Tab" : "Shift+Tab");
			expect(
				await settings.evaluate((el) => el.contains(document.activeElement)),
			).toBe(true);
		}
		await page.keyboard.press("Escape");
		await expect(settingsEntry).toBeFocused();
		await expect.poll(() => page.locator('.content-app__slot').evaluateAll(els => els.every(el => el.hasAttribute('inert') && getComputedStyle(el).visibility === 'hidden'))).toBe(true);
		await settingsEntry.click();
		const personaTab = page.locator('[data-settings-tab="persona"]');
		await expect
			.poll(async () => {
				if (await personaTab.evaluate((el) => el === document.activeElement))
					return true;
				await page.keyboard.press("Tab");
				return false;
			})
			.toBe(true);
		await page.keyboard.press("Enter");
		await page.setViewportSize({ width, height: 900 });
		const section = page.getByRole("region", {
			name: "Character cards and NVA themes",
		});
		await expect(section.getByText("No card selected.")).toBeVisible();
		const autoplay = section.getByRole("checkbox", {
			name: "Read first greeting aloud",
			exact: false,
		});
		await autoplay.uncheck();
		await expect(autoplay).not.toBeChecked();
		await expect(autoplay).toBeEnabled();
		expect(
			await page.evaluate(
				() =>
					JSON.parse(localStorage.getItem("naia-config")!).uiPreferences
						.b2cGreetingAutoplay,
			),
		).toBe(false);
		await autoplay.check();
		await expect(autoplay).toBeChecked();
		await expect(autoplay).toBeEnabled();
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
		await page
			.locator(".chat-input")
			.fill("Keep my words during card preparation");
		await apply.focus();
		await page.keyboard.press("Enter");
		await expect(apply).toBeDisabled();
		await expect(input).toBeDisabled();
		await page
			.locator(".chat-input")
			.dispatchEvent("keydown", { key: "Enter", code: "Enter", bubbles: true });
		await expect(page.locator(".chat-input")).toHaveValue(
			"Keep my words during card preparation",
		);
		await expect(section.getByRole("status")).toContainText("Card applied");
		const firstCard = await page.evaluate(
			() =>
				JSON.parse(localStorage.getItem("naia-config")!).uiPreferences
					.b2cCardLibrary[0],
		);
		await input.setInputFiles({
			name: "renamed.json",
			mimeType: "application/json",
			buffer: Buffer.from(firstCard.sourceBase64, "base64"),
		});
		await apply.click();
		await expect(section.getByRole("status")).toContainText("Card applied");
		const afterRepeat = await page.evaluate(
			() => JSON.parse(localStorage.getItem("naia-config")!).uiPreferences,
		);
		expect(afterRepeat.b2cCardLibrary).toHaveLength(1);
		expect(afterRepeat.b2cActiveCardId).toBe(firstCard.id);
		// Real authored A/V playback through ChatArea -> sentence-pipeline -> NVA.
		await page.evaluate(async () => {
			const { loadConfig, saveConfig } = await import("/src/lib/config.ts");
			const { useCascadeAvatarStore } = await import(
				"/src/stores/cascade-avatar.ts"
			);
			const renderer = useCascadeAvatarStore.getState().renderer!;
			const original = renderer.playAuthoredClip.bind(renderer);
			(window as any).__authoredGreeting = "";
			renderer.playAuthoredClip = (text, opts) => {
				(window as any).__authoredGreeting = text;
				return original(text, opts);
			};
			document.addEventListener(
				"playing",
				(event) => {
					const video = event.target;
					if (
						video instanceof HTMLVideoElement &&
						!video.muted &&
						video.videoWidth > 0
					)
						(window as any).__greetingAvPlaying = true;
				},
				true,
			);
			saveConfig({ ...loadConfig()!, ttsEnabled: true });
			window.dispatchEvent(new Event("naia-character-new-conversation"));
		});
		await expect
			.poll(() => page.evaluate(() => (window as any).__authoredGreeting))
			.toBe("Welcome to my garden");
		await expect
			.poll(() => page.evaluate(() => (window as any).__greetingAvPlaying))
			.toBe(true);
		await page.evaluate(async () => {
			const { loadConfig, saveConfig } = await import("/src/lib/config.ts");
			saveConfig({ ...loadConfig()!, ttsEnabled: false });
			window.dispatchEvent(
				new CustomEvent("naia:tts-enabled-change", {
					detail: { enabled: false },
				}),
			);
		});
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
		await page.evaluate(async () => {
			const { loadConfig, saveConfig } = await import("/src/lib/config.ts");
			const { writeNaiaConfigAtPath } = await import("/src/lib/adk-store.ts");
			const previous = {
				...loadConfig()!,
				nvaModel: "previous",
				ttsVoice: "en-US-AriaNeural",
				backgroundVideo: "garden.png",
			};
			// Seed both file fixture and cache after queued preference writes.
			// Cache-only mutation races file-SoT rehydration of theme saving.
			await writeNaiaConfigAtPath(previous, '/mock/b2c-adk');
			saveConfig(previous);
		});
		// Compare the settings owned by this operation; config loading strips empty
		// credentials and independent BGM runtime writers update unrelated keys.
		const themeSnapshot = () =>
			page.evaluate(() => {
				const cfg = JSON.parse(localStorage.getItem("naia-config")!);
				return Object.fromEntries(
					[
						"provider",
						"model",
						"persona",
						"agentName",
						"avatarProvider",
						"nvaModel",
						"ttsProvider",
						"ttsVoice",
						"backgroundVideo",
						"uiPreferences",
					].map((key) => [key, cfg[key]]),
				);
			});
		const beforeThemeFailure = await themeSnapshot();
		await page.evaluate(() => {
			(window as any).__badThemeClip = true;
		});
		await section
			.getByRole("button", { name: "Apply theme", exact: true })
			.click();
		await expect(section.getByRole("alert")).toContainText(
			"Previous settings were kept",
		);
		expect(await themeSnapshot()).toEqual(beforeThemeFailure);
		await page.evaluate(() => {
			(window as any).__badThemeClip = false;
			(window as any).__denyConfigWrites = true;
		});
		await section
			.getByRole("button", { name: "Apply theme", exact: true })
			.click();
		await expect(section.getByRole("alert")).toContainText(
			"Previous settings were kept",
		);
		await expect(
			section.getByRole("button", { name: "Apply theme", exact: true }),
		).toBeEnabled();
		expect(await themeSnapshot()).toEqual(beforeThemeFailure);
		await page.evaluate(() => {
			(window as any).__denyConfigWrites = false;
		});
		await section
			.getByRole("button", { name: "Apply theme", exact: true })
			.click();
		await expect(section.getByRole("status")).toContainText("Theme applied");
		expect(
			await page.evaluate(
				() => JSON.parse(localStorage.getItem("naia-config")!).nvaModel,
			),
		).toBe("naia");
		expect(
			await page.evaluate(
				() => JSON.parse(localStorage.getItem("naia-config")!).ttsVoice,
			),
		).toBe("ko-KR-SunHiNeural");
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
		// UC-B2C-026-R6: real browser module → Tauri seam, independent of model fixtures.
		const wire = await page.evaluate(async () => {
			const modulePath = "/src/lib/chat-service.ts";
			const { sendChatMessage } = await import(modulePath);
			for (const appName of ["달빛 카페", undefined]) {
				await sendChatMessage({
					message: "hello",
					provider: { provider: "ollama", model: "test-local", apiKey: "" },
					history: [],
					onChunk: () => {},
					requestId: appName ? "r6-app" : "r6-normal",
					...(appName ? { appName } : {}),
				});
			}
			return (window as any).__chatWire.filter((m: any) =>
				m.requestId?.startsWith("r6-"),
			);
		});
		expect(wire).toHaveLength(2);
		expect(wire[0]).toMatchObject({
			requestId: "r6-app",
			appName: "달빛 카페",
		});
		expect(wire[1]).not.toHaveProperty("appName");
		// Field reproduction: type at 300ms while greeting secrets/renderer await.
		await page.keyboard.press("Escape");
		await page.evaluate(async () => {
			const { loadConfig, saveConfig } = await import("/src/lib/config.ts");
			saveConfig({ ...loadConfig()!, ttsEnabled: true });
			const win = window as any;
			const originalInvoke = win.__TAURI_INTERNALS__.invoke;
			win.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
				if (cmd === "secure_store_get")
					await new Promise((resolve) => setTimeout(resolve, 800));
				return originalInvoke(cmd, args);
			};
			window.dispatchEvent(new Event("naia-character-new-conversation"));
		});
		await page.waitForTimeout(300);
		await expect(page.locator("output[role=status]")).toContainText("Preparing character");
		await expect(page.locator("output[role=status]")).toContainText("Enter or Send again");
		await page
			.locator(".chat-input")
			.fill("300ms greeting interruption keeps my words");
		await page.locator(".chat-input").press("Enter");
		await expect(page.locator(".chat-app")).toContainText(
			"300ms greeting interruption keeps my words",
		);
		await page.waitForTimeout(1200);
		await expect(page.locator(".chat-app")).toContainText(
			"300ms greeting interruption keeps my words",
		);
		await page.screenshot({
			path: test.info().outputPath(`greeting-input-${width}.png`),
			fullPage: true,
		});
	});
}
