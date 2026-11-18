import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { loadConfigFromFile } from "vite";

test("built standalone Slides starts without undefined usage version", async ({
	page,
}, testInfo) => {
	test.setTimeout(120_000);
	const outDir = testInfo.outputPath("slides-build");
	execFileSync(
		"pnpm",
		[
			"exec",
			"vite",
			"build",
			"--config",
			"vite.slides.config.ts",
			"--outDir",
			outDir,
			"--emptyOutDir",
		],
		{ cwd: process.cwd(), stdio: "pipe", timeout: 100_000 },
	);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("http://slides.test/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		const file = path === "/" ? "slides.html" : path.slice(1);
		const contentType =
			(
				{
					".html": "text/html",
					".js": "text/javascript",
					".css": "text/css",
					".svg": "image/svg+xml",
				} as Record<string, string>
			)[extname(file)] ?? "application/octet-stream";
		try {
			await route.fulfill({
				body: await readFile(join(outDir, file)),
				contentType,
			});
		} catch {
			await route.fulfill({ status: 404 });
		}
	});
	await page.goto("http://slides.test/");
	expect(errors).toEqual([]);
	await expect(page.locator("#root")).not.toBeEmpty();
	expect(errors).toEqual([]);
});

test("shell and Slides use the shell package version", async () => {
	const env = { command: "build" as const, mode: "production" };
	const shell = await loadConfigFromFile(env, "vite.config.ts");
	const slides = await loadConfigFromFile(env, "vite.slides.config.ts");
	const { version } = JSON.parse(await readFile("package.json", "utf8"));
	expect(shell?.config.define?.__USAGE_VERSION__).toBe(JSON.stringify(version));
	expect(slides?.config.define?.__USAGE_VERSION__).toBe(
		JSON.stringify(version),
	);
});
