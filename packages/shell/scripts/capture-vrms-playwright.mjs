import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

async function waitPort(port) {
	for (let i = 0; i < 30; i++) {
		try {
			const res = await fetch(`http://localhost:${port}`);
			if (res.ok || res.status === 404) return;
		} catch (e) {}
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(`Port ${port} not ready`);
}

async function main() {
	console.log("Waiting for Vite dev server...");
	await waitPort(1420);
	console.log("Vite is ready. Launching browser...");

	const browser = await chromium.launch({ headless: true });
	const page = await browser.newPage();

	const avatarsDir = path.join(process.cwd(), "public", "avatars");
	const files = fs.readdirSync(avatarsDir).filter((f) => f.endsWith(".vrm"));

	for (const file of files) {
		const vrmUrl = `/avatars/${file}`;
		const targetUrl = `http://localhost:1420/capture.html?vrm=${encodeURIComponent(vrmUrl)}`;
		console.log(`Navigating to ${targetUrl}`);

		await page.goto(targetUrl);

		try {
			await page.waitForFunction(
				() => window.__RENDERED === true || window.__RENDER_ERROR,
				{ timeout: 15000 },
			);

			const error = await page.evaluate(() => window.__RENDER_ERROR);
			if (error) {
				console.error(`Failed to load ${file}:`, error);
				continue;
			}

			// Wait a brief moment for materials to fully compile
			await page.waitForTimeout(1000);

			const pngPath = path.join(avatarsDir, file.replace(".vrm", ".png"));
			await page.screenshot({
				path: pngPath,
				clip: { x: 0, y: 0, width: 400, height: 400 },
			});
			console.log(`Captured ${pngPath}`);

			const webpPath = path.join(avatarsDir, file.replace(".vrm", ".webp"));
			execSync(`cwebp -q 85 "${pngPath}" -o "${webpPath}"`, {
				stdio: "ignore",
			});
			fs.unlinkSync(pngPath);
			console.log(`Converted to ${webpPath}`);
		} catch (e) {
			console.error(`Timeout or error while capturing ${file}:`, e);
		}
	}

	await browser.close();
	console.log("All captures complete.");
}

main().catch(console.error);
