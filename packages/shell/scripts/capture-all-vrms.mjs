import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

async function main() {
	console.log("Launching browser...");
	const browser = await chromium.launch({ headless: true });
	const context = await browser.newContext();
	const page = await context.newPage();

	// Clear local storage to trigger onboarding wizard
	await page.goto("http://localhost:1420/");
	await page.evaluate(() => localStorage.clear());
	await page.goto("http://localhost:1420/");

	console.log("Navigating through onboarding wizard to Character step...");
	// 1. Provider
	await page.click("button.onboarding-next-btn");

	// 2. API Key
	await page.waitForSelector('input[type="password"]');
	await page.fill('input[type="password"]', "test-key");
	await page.click("button.onboarding-next-btn");

	// 3. Agent Name
	await page.waitForSelector('input[placeholder*="이름"]');
	await page.fill('input[placeholder*="이름"]', "Naia");
	await page.click("button.onboarding-next-btn");

	// 4. User Name
	await page.waitForSelector('input[placeholder*="이름"]');
	await page.fill('input[placeholder*="이름"]', "Luke");
	await page.click("button.onboarding-next-btn");

	// 5. Character Step
	console.log("Waiting for 3D Canvas...");
	await page.waitForSelector(".vrm-preview-container canvas", {
		timeout: 15000,
	});

	const vrms = [
		"Sendagaya-Shino-dark-uniform",
		"Sendagaya-Shino-light-uniform",
		"vrm-ol-girl",
		"vrm-sample-boy",
	];

	for (let i = 0; i < vrms.length; i++) {
		// Find cards again because DOM might update
		const cards = await page.$$(".onboarding-vrm-card");
		console.log(`Clicking card ${i + 1} (${vrms[i]})...`);
		await cards[i].click();

		// Wait for model to load and render
		await page.waitForTimeout(4000);

		const canvas = await page.$(".vrm-preview-container");
		if (canvas) {
			const pngPath = path.join(process.cwd(), `public/avatars/${vrms[i]}.png`);
			await canvas.screenshot({ path: pngPath });
			console.log(`Captured ${pngPath}`);

			const webpPath = path.join(
				process.cwd(),
				`public/avatars/${vrms[i]}.webp`,
			);
			execSync(`cwebp -q 85 "${pngPath}" -o "${webpPath}"`, {
				stdio: "ignore",
			});
			fs.unlinkSync(pngPath);
			console.log(`Converted to ${webpPath}`);
		}
	}

	await browser.close();
	console.log("All captures completed successfully!");
}

main().catch(console.error);
