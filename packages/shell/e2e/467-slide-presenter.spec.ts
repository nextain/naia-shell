import { existsSync } from "node:fs";
import { type Page, expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

const SPEECH_MOCK = `
(function() {
	window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
	window.__TAURI_INTERNALS__.metadata = {
		currentWindow: { label: "main" },
		currentWebview: { windowLabel: "main", label: "main" }
	};
	var callbacks = new Map();
	var listeners = new Map();
	var nextCallbackId = 1;
	window.__TAURI_INTERNALS__.transformCallback = function(fn, once) {
		var id = nextCallbackId++;
		callbacks.set(id, function(data) {
			if (once) callbacks.delete(id);
			return fn && fn(data);
		});
		return id;
	};
	window.__TAURI_INTERNALS__.unregisterCallback = function(id) { callbacks.delete(id); };
	window.__TAURI_INTERNALS__.runCallback = function(id, data) {
		var callback = callbacks.get(id);
		if (callback) callback(data);
	};
	function emit(event, payload) {
		(listeners.get(event) || []).forEach(function(handler) {
			window.__TAURI_INTERNALS__.runCallback(handler, { event: event, payload: payload });
		});
	}
	window.__NAIA_E2E_EMIT__ = emit;
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function(event, id) {
		listeners.set(event, (listeners.get(event) || []).filter(function(handler) { return handler !== id; }));
		callbacks.delete(id);
	};
	window.__TAURI_INTERNALS__.convertFileSrc = function(path, protocol) {
		if (String(path).includes("land.naia.slides")) return "/slides.html";
		return (protocol || "asset") + "://localhost/" + encodeURIComponent(path);
	};
	window.__TAURI_INTERNALS__.invoke = async function(command, args) {
		if (command === "plugin:event|listen") {
			if (!listeners.has(args.event)) listeners.set(args.event, []);
			listeners.get(args.event).push(args.handler);
			return args.handler;
		}
		if (command === "plugin:event|emit") { emit(args.event, args.payload); return null; }
		if (command === "plugin:event|unlisten") return null;
		if (command === "send_to_agent_command" || command === "cancel_stream") return null;
		if (command === "app_store_has_entitlement") return window.__STORE_ENTITLED__ !== false;
		if (command === "app_install_store") return await new Promise(function(resolve) { window.__STORE_FINISH__ = function() { resolve({ id: args.appId, name: "Naia Slides", path: "/tmp/app" }); }; });
		if (command === "app_list_installed") return [{
			id: "land.naia.slides",
			name: "Naia Slides",
			description: "Present PDF and PPTX decks with Naia voice and avatar.",
			version: "0.1.0",
			icon: "📽️",
			htmlEntry: "/tmp/naia-e2e/apps/land.naia.slides/index.html",
			tools: [{ name: "slides_presenter", description: "Control the slide presentation" }]
		}];
		if (command === "browser_wv_page_info") return ["about:blank", ""];
		if (command.startsWith("browser_wv_")) return null;
		return undefined;
	};
	window.__SLIDE_E2E__ = { spoken: [], cancelled: 0, delayMs: 40 };
	Object.defineProperty(window, "speechSynthesis", { configurable: true, value: {
		speak: function(utterance) {
			window.__SLIDE_E2E__.spoken.push(utterance.text);
			setTimeout(function() {
				if (utterance.onstart) utterance.onstart();
				if (utterance.onend) utterance.onend();
			}, window.__SLIDE_E2E__.delayMs);
		},
		cancel: function() { window.__SLIDE_E2E__.cancelled += 1; },
		getVoices: function() { return []; },
		pause: function() {},
		resume: function() {}
	}});
	Object.defineProperty(window, "SpeechSynthesisUtterance", {
		configurable: true,
		writable: true,
		value: function(text) {
			this.text = text;
			this.lang = "";
			this.onstart = null;
			this.onend = null;
			this.onerror = null;
		}
	});
	window.addEventListener("naia:slide-presenter-speak", function(event) {
		var utterance = new window.SpeechSynthesisUtterance(event.detail.text);
		utterance.onend = function() {
			window.dispatchEvent(new CustomEvent("naia:slide-presenter-speech-result", { detail: { requestId: event.detail.requestId, generation: event.detail.generation, page: event.detail.page, status: "finished" } }));
		};
		window.speechSynthesis.speak(utterance);
	});
	window.addEventListener("naia:slide-presenter-cancel", function() {
		window.speechSynthesis.cancel();
	});
})();
`;

function makeTwoPagePdf(): Buffer {
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		"<< /Length 212 >>\nstream\n0.025 0.055 0.12 rg 0 0 960 540 re f 0.1 0.8 0.95 rg 64 414 118 8 re f 1 1 1 rg BT /F1 52 Tf 64 330 Td (NAIA SLIDES) Tj ET 0.62 0.72 0.84 rg BT /F1 24 Tf 64 278 Td (Present with your AI partner) Tj ET\nendstream",
		"<< /Length 221 >>\nstream\n0.04 0.075 0.16 rg 0 0 960 540 re f 0.48 0.35 0.96 rg 64 414 118 8 re f 1 1 1 rg BT /F1 48 Tf 64 330 Td (STORY IN MOTION) Tj ET 0.65 0.75 0.9 rg BT /F1 22 Tf 64 278 Td (Voice, avatar, and slides in sync) Tj ET\nendstream",
	];
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	for (let index = 0; index < objects.length; index += 1) {
		offsets.push(Buffer.byteLength(pdf, "ascii"));
		pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
	}
	const xref = Buffer.byteLength(pdf, "ascii");
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1)) {
		pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
	}
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(pdf, "ascii");
}

async function setup(page: Page) {
	page.on("pageerror", (error) =>
		console.error("[slide-e2e pageerror]", error),
	);
	page.on("console", (message) => {
		if (message.type() === "error") {
			console.error("[slide-e2e console]", message.text());
		}
	});
	await page.addInitScript(SPEECH_MOCK);
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_ADK_PATH });
	await page.addInitScript(() => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "ollama",
				model: "qwen3.6:27b",
				ttsEnabled: true,
				ttsProvider: "browser",
				locale: "ko",
				onboardingComplete: true,
			}),
		);
	});
	await page.goto("/slides.html");
	await expect(page.locator(".slides-app")).toBeVisible();
}

async function loadFiles(
	page: Page,
	pdf: string | { name: string; mimeType: string; buffer: Buffer },
	script: string | { name: string; mimeType: string; buffer: Buffer },
) {
	await page
		.locator('input[type="file"][accept*="application/pdf"]')
		.setInputFiles(pdf);
	await page
		.locator('input[type="file"][accept*="text/markdown"]')
		.setInputFiles(script);
}

async function expectRenderedSlide(page: Page) {
	const canvas = page.locator(".slides-app__page canvas");
	await expect(canvas).toBeVisible({ timeout: 30_000 });
	await expect
		.poll(
			() =>
				canvas.evaluate((element: HTMLCanvasElement) => {
					const context = element.getContext("2d");
					if (!context || element.width === 0 || element.height === 0) return 0;
					const pixels = context.getImageData(
						0,
						0,
						element.width,
						element.height,
					).data;
					let ink = 0;
					for (let index = 0; index < pixels.length; index += 400) {
						if (
							pixels[index] < 245 ||
							pixels[index + 1] < 245 ||
							pixels[index + 2] < 245
						) {
							ink += 1;
						}
					}
					return ink;
				}),
			{ timeout: 30_000 },
		)
		.toBeGreaterThan(10);
}

test.describe("#467 slide presenter", () => {
	test("runs the deterministic browser-TTS presentation loop", async ({
		page,
	}) => {
		await setup(page);
		await loadFiles(
			page,
			{
				name: "two-slides.pdf",
				mimeType: "application/pdf",
				buffer: makeTwoPagePdf(),
			},
			{
				name: "two-slides.md",
				mimeType: "text/markdown",
				buffer: Buffer.from(
					"## 1. First\n\n첫 번째 발표입니다.\n\n## 2. Second\n\n두 번째 발표입니다.",
				),
			},
		);

		await expect(page.locator('.slides-app[data-state="ready"]')).toBeVisible();
		await expect(page.locator(".slides-app__progress strong")).toHaveText(
			"1 / 2",
		);
		await expect(page.getByTestId("slides-current-note")).toContainText(
			"첫 번째 발표입니다.",
		);

		await page
			.getByRole("button", { name: /^(발표 시작|Start presenting)$/ })
			.click();
		await expect
			.poll(() =>
				page.evaluate(() => [...(window as any).__SLIDE_E2E__.spoken]),
			)
			.toEqual(["첫 번째 발표입니다.", "두 번째 발표입니다."]);
		await expect(
			page.locator('.slides-app[data-state="completed"]'),
		).toBeVisible();
		await expect(page.locator(".slides-app__progress strong")).toHaveText(
			"2 / 2",
		);
	});

	test("loads the packaged app in Shell and shows one deep-link install confirmation", async ({
		page,
	}) => {
		await page.addInitScript(SPEECH_MOCK);
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
		await page.addInitScript({ content: SEED_ADK_PATH });
		await page.addInitScript(() => {
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					provider: "ollama",
					model: "qwen3.6:27b",
					ttsEnabled: true,
					ttsProvider: "browser",
					locale: "ko",
					onboardingComplete: true,
					agentName: "Naia",
					vrmModel: "/avatars/03-OL_Woman.vrm",
				}),
			);
		});
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto("/");
		const slidesButton = page.locator('button[data-app-id="land.naia.slides"]');
		await expect(slidesButton).toBeVisible({ timeout: 15_000 });
		await slidesButton.click();

		const installed = page.frameLocator(".generic-installed-app__iframe");
		await expect(installed.locator(".slides-app")).toBeVisible({
			timeout: 15_000,
		});
		await installed
			.locator('input[type="file"][accept*="application/pdf"]')
			.setInputFiles({
				name: "naia-slides-showcase.pdf",
				mimeType: "application/pdf",
				buffer: makeTwoPagePdf(),
			});
		await installed
			.locator('input[type="file"][accept*="text/markdown"]')
			.setInputFiles({
				name: "naia-slides-showcase.md",
				mimeType: "text/markdown",
				buffer: Buffer.from(
					"## 1. Naia Slides\n\n나이아와 함께 이야기를 시작합니다.\n\n## 2. Story\n\n음성과 아바타, 슬라이드가 하나로 이어집니다.",
				),
			});
		await expect(
			installed.locator('.slides-app[data-state="ready"]'),
		).toBeVisible({ timeout: 30_000 });
		await expect(installed.locator(".slides-app__page canvas")).toBeVisible({
			timeout: 30_000,
		});
		await expect(page.locator(".avatar-canvas-layer canvas")).toBeVisible({
			timeout: 30_000,
		});
		await page.waitForTimeout(5_000);
		await page.screenshot({
			path: "test-results/issue-471-installed-naia-slides.png",
			fullPage: true,
		});
		await page.route("http://localhost:3000/thumbnail.png", (route) => route.fulfill({
			contentType: "image/png",
			body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
		}));
		await page.route("**/v1/apps/products", async (route) => {
			await route.fulfill({
				contentType: "application/json",
				body: JSON.stringify({
					data: [
						{
							app_id: "land.naia.slides",
							manifest: { name: "Slides", nameKo: "나이아 슬라이드", descriptionKo: "나이아와 발표합니다", thumbnailUrl: "/thumbnail.png" },
						},
					],
				}),
			});
		});

		await page.evaluate(() => {
			(window as any).__NAIA_E2E_EMIT__("app_install_requested", {
				appId: "land.naia.slides",
				storeOrigin: "http://localhost:3000",
				state: "ir-capture-once",
			});
		});
		await expect(page.locator(".app-install-dialog")).toBeVisible();
		await expect(page.getByTestId("app-install-product")).toHaveCount(1);
		await expect(
			page.getByTestId("app-install-product").locator("strong"),
		).toHaveText("나이아 슬라이드");
		await expect(page.getByText("나이아와 발표합니다")).toBeVisible();
		await expect(page.getByTestId("app-install-product").locator("img")).toHaveAttribute("src", "http://localhost:3000/thumbnail.png");
		await page.setViewportSize({ width: 360, height: 800 });
		const dialog = page.getByRole("dialog", { name: "Naia Apps" });
		await expect(dialog).toBeVisible();
		const bounds = await dialog.boundingBox();
		expect(bounds).not.toBeNull();
		expect(bounds!.x).toBeGreaterThanOrEqual(0);
		expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
		const install = dialog.getByRole("button", { name: "설치" });
		await install.focus();
		await expect(install).toBeFocused();
		await page.screenshot({
			path: "test-results/issue-471-single-install-confirmation.png",
			fullPage: true,
		});
	});

	test("installation recovers from an ownership error and exposes progress and success", async ({ page }) => {
		await page.addInitScript(SPEECH_MOCK);
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
		await page.addInitScript({ content: SEED_ADK_PATH });
		await page.addInitScript(() => localStorage.setItem("naia-config", JSON.stringify({ provider: "ollama", model: "qwen3.6:27b", locale: "ko", onboardingComplete: true })));
		await page.route("**/v1/apps/products", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: [] }) }));
		await page.goto("/");
		await expect(page.locator('button[data-app-id="land.naia.slides"]')).toBeVisible({ timeout: 15000 });
		await page.evaluate(() => {
			(window as any).__STORE_ENTITLED__ = false;
			(window as any).__NAIA_E2E_EMIT__("app_install_requested", { appId: "land.naia.slides", storeOrigin: "http://localhost:3000", state: "retry" });
		});
		const dialog = page.getByRole("dialog", { name: "Naia Apps" });
		await expect(dialog.getByTestId("app-install-product").locator("strong")).toHaveText("land.naia.slides");
		await expect(dialog.locator("img")).toHaveCount(0);
		await dialog.getByRole("button", { name: "설치" }).click();
		await expect(dialog.getByRole("alert")).toBeVisible();
		await page.evaluate(() => { (window as any).__STORE_ENTITLED__ = true; });
		await dialog.getByRole("button", { name: "설치" }).click();
		await expect(dialog.getByRole("status")).toBeVisible();
		await expect(dialog.getByRole("button", { name: "설치 중..." })).toBeDisabled();
		await page.evaluate(() => (window as any).__STORE_FINISH__());
		await expect(dialog.getByRole("status").filter({ hasText: /설치 완료|Installed/ })).toBeVisible();
	});

	test("keeps the installed Slides deck loaded after switching apps and back", async ({
		page,
	}) => {
		// Regression: switching away from an installed app unmounted its iframe,
		// destroying in-page state — an open PDF deck vanished on return. The fix
		// keeps installed apps mounted (keepAlive) like built-ins, so the same
		// iframe DOM node survives a round-trip to another app.
		await page.addInitScript(SPEECH_MOCK);
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
		await page.addInitScript({ content: SEED_ADK_PATH });
		await page.addInitScript(() => {
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					provider: "ollama",
					model: "qwen3.6:27b",
					ttsEnabled: true,
					ttsProvider: "browser",
					locale: "ko",
					onboardingComplete: true,
					agentName: "Naia",
					vrmModel: "/avatars/03-OL_Woman.vrm",
				}),
			);
		});
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto("/");

		// Open the installed Slides app and load a deck.
		const slidesButton = page.locator('button[data-app-id="land.naia.slides"]');
		await expect(slidesButton).toBeVisible({ timeout: 15_000 });
		await slidesButton.click();

		const installed = page.frameLocator(".generic-installed-app__iframe");
		await expect(installed.locator(".slides-app")).toBeVisible({
			timeout: 15_000,
		});
		await installed
			.locator('input[type="file"][accept*="application/pdf"]')
			.setInputFiles({
				name: "persist-check.pdf",
				mimeType: "application/pdf",
				buffer: makeTwoPagePdf(),
			});
		await installed
			.locator('input[type="file"][accept*="text/markdown"]')
			.setInputFiles({
				name: "persist-check.md",
				mimeType: "text/markdown",
				buffer: Buffer.from("## 1. Alpha\n\n첫 장.\n\n## 2. Beta\n\n둘째 장."),
			});
		await expect(
			installed.locator('.slides-app[data-state="ready"]'),
		).toBeVisible({ timeout: 30_000 });
		await expect(installed.locator(".slides-app__page canvas")).toBeVisible({
			timeout: 30_000,
		});

		// Tag the live iframe DOM node. If the shell unmounts/remounts the app on
		// switch, React creates a fresh element and this marker is gone.
		await page
			.locator(".generic-installed-app__iframe")
			.evaluate((el) => el.setAttribute("data-e2e-persist", "marker-1"));

		// Switch to another app (Settings) and back to Slides. Assert on the tab
		// active class — the slot stays in the DOM either way (keepAlive), so the
		// active marker, not visibility, is what confirms the switch happened.
		await page.locator(".app-bar-settings").click();
		await expect(page.locator(".app-bar-settings--active")).toBeVisible({
			timeout: 15_000,
		});
		await slidesButton.click();
		await expect(
			page.locator(
				'button[data-app-id="land.naia.slides"].app-bar-tab--active',
			),
		).toBeVisible({ timeout: 15_000 });

		// Same iframe node survived the round-trip …
		await expect(
			page.locator(
				'.generic-installed-app__iframe[data-e2e-persist="marker-1"]',
			),
		).toHaveCount(1);
		// … and the deck is still loaded — no re-upload, still on the ready state
		// with a rendered slide canvas.
		await expect(
			installed.locator('.slides-app[data-state="ready"]'),
		).toBeVisible({ timeout: 15_000 });
		await expect(installed.locator(".slides-app__page canvas")).toBeVisible({
			timeout: 15_000,
		});
	});

	test("loads and presents the current 21-slide IR deck", async ({ page }) => {
		const pdfPath = process.env.NAIA_SLIDE_IR_PDF ?? "";
		const scriptPath = process.env.NAIA_SLIDE_IR_SCRIPT ?? "";
		test.skip(
			!existsSync(pdfPath) || !existsSync(scriptPath),
			"Current local IR artifacts are not available on this machine.",
		);

		await setup(page);
		await loadFiles(page, pdfPath, scriptPath);
		await expect(page.locator('.slides-app[data-state="ready"]')).toBeVisible({
			timeout: 60_000,
		});
		await expect(page.locator(".slides-app__progress strong")).toHaveText(
			"1 / 21",
		);
		await expect(page.getByTestId("slides-current-note")).not.toBeEmpty();
		await expectRenderedSlide(page);
		await page.screenshot({
			path: "test-results/issue-467-ir-desktop.png",
			fullPage: true,
		});

		await page.evaluate(() => {
			(window as any).__SLIDE_E2E__.delayMs = 1_500;
		});
		await page
			.getByRole("button", { name: /^(발표 시작|Start presenting)$/ })
			.click();
		await expect(page.locator(".slides-app__progress strong")).toHaveText(
			"2 / 21",
			{ timeout: 30_000 },
		);
		await expect
			.poll(() =>
				page.evaluate(() => (window as any).__SLIDE_E2E__.spoken.length),
			)
			.toBeGreaterThan(0);
		await page.getByRole("button", { name: /^(일시정지|Pause)$/ }).click();
		await expectRenderedSlide(page);
		await page.locator(".slides-app").evaluate((element) => {
			element.scrollTop = 0;
		});

		await page.setViewportSize({ width: 900, height: 700 });
		await page.screenshot({
			path: "test-results/issue-467-ir-narrow.png",
			fullPage: true,
		});
	});
});
