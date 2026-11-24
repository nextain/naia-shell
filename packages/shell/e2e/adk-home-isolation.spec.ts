import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { TAURI_BASE_MOCK_FALLBACK } from "./helpers/tauri-base-mock";

for (const state of ["selected", "empty", "unreadable"] as const) {
	test(`isolated data home ${state} ignores stale WebView home`, async ({
		page,
	}, info) => {
		const root = mkdtempSync(join(tmpdir(), "r12-homes-"));
		const homeA = join(root, "home-a");
		const homeB = join(root, "home-b");
		mkdirSync(homeA);
		mkdirSync(homeB);
		const adkA = join(homeA, "private-adk");
		const adkB = join(homeB, "test-adk");
		writeFileSync(join(homeA, "adk-path"), adkA);
		if (state === "selected") writeFileSync(join(homeB, "adk-path"), adkB);
		const calls: { cmd: string; args: any }[] = [];
		await page.exposeFunction("nativeHomeCommand", (cmd: string, args: any) => {
			calls.push({ cmd, args });
			if (cmd === "read_naia_path_cache") {
				if (state === "unreadable") throw new Error("permission denied");
				try {
					return readFileSync(join(homeB, "adk-path"), "utf8");
				} catch {
					return null;
				}
			}
			if (args?.adkPath === adkA || args?.root === adkA)
				throw new Error("cross-home access");
			if (cmd === "read_naia_config")
				return JSON.stringify({
					locale: "en",
					provider: "ollama",
					model: "test",
					onboardingComplete: true,
					agentName: "Isolated B",
				});
			if (cmd === "read_naia_ui_config") return "{}";
			return undefined;
		});
		await page.setViewportSize({ width: 360, height: 900 });
		await page.addInitScript(
			({ adkA }) => {
				localStorage.setItem("naia-adk-path", adkA);
				localStorage.setItem(
					"naia-config",
					JSON.stringify({
						workspaceRoot: adkA,
						agentName: "Private A",
						onboardingComplete: true,
					}),
				);
				const win = window as any;
			win.__E2E_EXPLICIT_NATIVE_POINTER__ = true;
				win.__TAURI_INTERNALS__ = {
					metadata: {
						currentWindow: { label: "main" },
						currentWebview: { label: "main", windowLabel: "main" },
					},
					transformCallback: () => 1,
					unregisterCallback: () => {},
					convertFileSrc: (path: string) => path,
					invoke: (cmd: string, args: any) => win.nativeHomeCommand(cmd, args),
				};
				win.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
			},
			{ adkA },
		);
		await page.addInitScript(TAURI_BASE_MOCK_FALLBACK);
		try {
			for (let boot = 0; boot < 2; boot++) {
				await page.goto("/");
				if (state === "selected") {
					await expect(page.locator(".chat-app")).toBeVisible();
					await expect
						.poll(() =>
							page.evaluate(() => localStorage.getItem("naia-adk-path")),
						)
						.toBe(adkB);
					await expect
						.poll(() =>
							page.evaluate(
								() =>
									JSON.parse(localStorage.getItem("naia-config") || "{}")
										.agentName,
							),
						)
						.toBe("Isolated B");
				} else if (state === "empty") {
					await expect(page.locator(".adk-setup-screen")).toBeVisible();
					expect(
						await page.evaluate(() => localStorage.getItem("naia-adk-path")),
					).toBeNull();
				} else {
					await expect(page.getByRole("alert")).toContainText(
						"Cannot read workspace selection",
					);
					expect(
						await page.evaluate(() => localStorage.getItem("naia-adk-path")),
					).toBeNull();
				}
			}
			expect(
				calls.some(({ args }) => args?.adkPath === adkA || args?.root === adkA),
			).toBe(false);
			expect(readFileSync(join(homeA, "adk-path"), "utf8")).toBe(adkA);
			if (state === "selected")
				expect(readFileSync(join(homeB, "adk-path"), "utf8")).toBe(adkB);
			if (state !== "unreadable") await expect(page.locator(".splash-screen")).toBeHidden();
			await page.screenshot({ path: info.outputPath(`home-${state}.png`) });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
