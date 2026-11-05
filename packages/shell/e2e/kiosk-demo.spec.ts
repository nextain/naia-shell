import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
	await page.route(/^https?:\/\//, (route) => {
		const host = new URL(route.request().url()).hostname;
		return host === "localhost" || host === "127.0.0.1"
			? route.continue()
			: route.abort();
	});
});

// Run with VITE_NAIA_KIOSK_DEMO=1 in web mode. Only synthetic credentials are used.
test("S3 missing build credential stops even with a previous login", async ({
	page,
}) => {
	await page.addInitScript(() => {
		localStorage.setItem("naia-remote-key", "test-personal-fixture-only");
	});
	await page.goto(process.env.S3_MISSING_KEY_URL || "http://localhost:1433");
	await expect(page.getByRole("alert")).toHaveText("시연 열쇠 없음");
	await expect(
		page.getByRole("button", { name: "들어가기", exact: true }),
	).toBeDisabled();
	await expect(page.locator(".chat-area")).toHaveCount(0);
});

test("S3 fresh browser prepares Jina, enters by keyboard and speaks once", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 360, height: 780 });
	await page.addInitScript(() => {
		const spoken: string[] = [];
		Object.defineProperty(window, "__s3Spoken", { value: spoken });
		Object.defineProperty(window, "speechSynthesis", {
			value: {
				getVoices: () => [],
				cancel: () => {},
				pause: () => {},
				resume: () => {},
				addEventListener: () => {},
				removeEventListener: () => {},
				speak: (utterance: SpeechSynthesisUtterance) => {
					spoken.push(utterance.text);
					utterance.onstart?.(new Event("start") as SpeechSynthesisEvent);
					setTimeout(
						() => utterance.onend?.(new Event("end") as SpeechSynthesisEvent),
						20,
					);
				},
			},
		});
	});
	await page.goto("/");
	const enter = page.getByRole("button", { name: "들어가기", exact: true });
	await expect(enter).toBeEnabled();
	await expect(
		page.getByRole("heading", { name: "지나와 이야기해 보세요" }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "처음으로" })).toBeDisabled();
	expect(
		await page.evaluate(
			() => (window as unknown as { __s3Spoken: string[] }).__s3Spoken.length,
		),
	).toBe(0);
	const before = await page.evaluate(() =>
		JSON.parse(localStorage.getItem("naia-config") || "{}"),
	);
	expect(before).toMatchObject({
		agentName: "지나",
		userName: "게스트",
		honorific: "님",
		speechStyle: "formal",
		onboardingComplete: true,
	});
	const box = await enter.boundingBox();
	expect(box).toBeTruthy();
	expect(box!.x).toBeGreaterThanOrEqual(0);
	expect(box!.x + box!.width).toBeLessThanOrEqual(360);
	await page.screenshot({ path: testInfo.outputPath("entry-360.png") });
	await enter.focus();
	await page.keyboard.press("Enter");
	await expect(page.locator(".kiosk-entry")).toHaveCount(0);
	await expect
		.poll(
			() =>
				page.evaluate(
					() =>
						(window as unknown as { __s3Spoken: string[] }).__s3Spoken.filter(
							(text) => text.includes("게스트님, 안녕하세요"),
						).length,
				),
			{ timeout: 60_000 },
		)
		.toBe(1);
	await expect(page.getByText(/게스트님, 안녕하세요/).first()).toBeVisible();
	await expect(page.getByTestId("onboarding")).toHaveCount(0);
});

test("S3 preparation progress and failure are safe and retryable", async ({ page }) => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => { release = resolve; });
	let first = true;
	await page.route("**/web-adk/*.json", async (route) => {
		if (!first) return route.continue();
		first = false;
		await pending;
		return route.fulfill({ status: 503, body: "unavailable" });
	});
	await page.goto("/");
	await expect(page.getByRole("status")).toContainText("준비");
	await expect(page.getByRole("button", { name: "들어가기", exact: true })).toBeDisabled();
	release();
	await expect(page.getByRole("alert")).toContainText("다시 시도");
	await page.getByRole("button", { name: "다시 시도" }).click();
	await expect(page.getByRole("button", { name: "들어가기", exact: true })).toBeEnabled();
	await expect(page.locator(".chat-area")).toHaveCount(0);
});
