import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

const CLIP_BASE64 = readFileSync(
	path.resolve(process.cwd(), "e2e/fixtures/head-green-100.mp4"),
).toString("base64");

const NVA_MANIFEST = {
	nva_version: "0.2",
	meta: { name: "Hood Naia Layout Mock" },
	canvas: { width: 720, height: 1280, fps: 24 },
	background: { type: "transparent" },
	poses: ["default"],
	animations: {
		idle: {
			clip: "clips/idle.webm",
			entry_pose: "default",
			exit_pose: "default",
			loop: true,
			can_talk: false,
		},
	},
	scenario: {
		nodes: {
			start: { type: "start" },
			idle: { type: "scene", animation: "idle" },
		},
		edges: [{ from: "start", to: "idle" }],
	},
};

function buildNvaMock() {
	return `
(function () {
  const manifest = ${JSON.stringify(NVA_MANIFEST)};
  const clipBase64 = ${JSON.stringify(CLIP_BASE64)};
  window.__nvaInvokes = [];
  window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
  window.__TAURI_INTERNALS__.metadata = { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } };
  window.__TAURI_INTERNALS__.transformCallback = window.__TAURI_INTERNALS__.transformCallback || ((fn) => fn);
  window.__TAURI_INTERNALS__.convertFileSrc = (p) => "asset://localhost/" + encodeURIComponent(p);
  window.__TAURI_INTERNALS__.invoke = async function (cmd, args) {
    window.__nvaInvokes.push({ cmd, args });
    if (cmd === "plugin:event|listen" || cmd === "plugin:event|unlisten" || cmd === "plugin:event|emit") return null;
    if (cmd === "detect_gpu_vram") return null;
    if (cmd === "read_naia_config") {
      return JSON.stringify(window.__mockFileConfig || {
        provider: "gemini",
        model: "gemini-3.5-flash",
        locale: "en",
        onboardingComplete: true,
        avatarProvider: "naia-video-avatar",
        nvaModel: "naia",
      });
    }
    if (cmd === "read_naia_ui_config") {
      return JSON.stringify(window.__mockUiConfig || {});
    }
    if (cmd === "write_naia_ui_config") {
      return null;
    }
    if (cmd === "read_local_binary") {
      if (String(args && args.path).endsWith("manifest.json")) {
        return btoa(unescape(encodeURIComponent(JSON.stringify(manifest))));
      }
      return clipBase64;
    }
    return undefined;
  };
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: function () { return Promise.resolve(); }
  });
  HTMLMediaElement.prototype.pause = function () {};
})();
`;
}

async function setupPage(
	page: Page,
	configOverrides: Record<string, unknown> = {},
) {
	await page.addInitScript((overrides) => {
		(window as unknown as { __mockUiConfig?: Record<string, unknown> }).__mockUiConfig = {
			uiPreferences: (overrides?.uiPreferences as Record<string, unknown>) || {},
		};
	}, configOverrides);
	await page.addInitScript(buildNvaMock());
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_ADK_PATH });
	await page.addInitScript((overrides) => {
		const baseConfig = {
			provider: "gemini",
			model: "gemini-3.5-flash",
			locale: "en",
			onboardingComplete: true,
			avatarProvider: "naia-video-avatar",
			nvaModel: "naia",
			...overrides,
		};
		localStorage.setItem("naia-config", JSON.stringify(baseConfig));
		if (overrides.uiPreferences) {
			const prefs = overrides.uiPreferences as Record<string, unknown>;
			if (prefs.nvaPan) localStorage.setItem("naia-nva-pan-v1", JSON.stringify(prefs.nvaPan));
			if (prefs.chatMode) localStorage.setItem("naia-chat-mode-v1", String(prefs.chatMode));
		}
	}, configOverrides);
}

async function waitForVideoReady(page: Page) {
	await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 10_000 });
	const video = page.locator("[data-video-avatar] video");
	await expect
		.poll(
			async () => {
				return await video.evaluate((el) => (el as HTMLVideoElement).readyState);
			},
			{ message: "Hidden video readyState >= 2 wait timeout", timeout: 10_000 },
		)
		.toBeGreaterThanOrEqual(2);
	await page.waitForTimeout(50);
}

async function dragChatToggleUp(page: Page, distancePx: number, steps = 15) {
	const toggle = page.locator(".naia-chat-toggle");
	await expect(toggle).toBeVisible();
	const toggleBox = await toggle.boundingBox();
	expect(toggleBox).not.toBeNull();
	const startX = toggleBox!.x + toggleBox!.width / 2;
	const startY = toggleBox!.y + toggleBox!.height / 2;

	await page.mouse.move(startX, startY);
	await page.mouse.down();
	await page.mouse.move(startX, startY - distancePx, { steps: Math.max(10, steps) });
	await page.mouse.up();
}

const RESULTS_DIR = path.resolve(process.cwd(), "test-results");

async function saveScreenshot(page: Page, filename: string) {
	mkdirSync(RESULTS_DIR, { recursive: true });
	await waitForVideoReady(page);
	const targetPath = path.join(RESULTS_DIR, filename);
	await page.screenshot({ path: targetPath });
	return targetPath;
}

async function assertContactAndBoundaries(
	page: Page,
	label: string,
	options: { naiaWidth?: number; checkBoundaries?: boolean } = {},
) {
	const canvas = page.locator("[data-video-avatar-prebaked]");
	const chatArea = page.locator(".naia-chat-area");
	const aiBar = page.locator(".ai-control-bar");

	await expect(canvas).toBeVisible();
	await expect(chatArea).toBeVisible();

	const canvasBox = await canvas.boundingBox();
	const chatBox = await chatArea.boundingBox();
	const aiBox = await aiBar.boundingBox();

	expect(canvasBox, `Canvas box exists at ${label}`).not.toBeNull();
	expect(chatBox, `Chat box exists at ${label}`).not.toBeNull();
	expect(aiBox, `AI bar box exists at ${label}`).not.toBeNull();

	const naiaWidth = options.naiaWidth ?? 320;

	const outer = page.locator("[data-video-avatar]");
	const outerBox = await outer.boundingBox();
	const layer = page.locator(".avatar-canvas-layer");
	const layerStyle = await layer.evaluate((el) => el.getAttribute("style"));

	console.log("DEBUG:", {
		label,
		canvasBox,
		chatBox,
		aiBox,
		outerBox,
		layerStyle,
	});

	// 맞닿음: 0 ≤ 대화창 위 끝 - 캔버스 아래 끝 ≤ 4px
	const diff = chatBox!.y - (canvasBox!.y + canvasBox!.height);
	expect(diff, `Contact diff at ${label}: ${diff}`).toBeGreaterThanOrEqual(-1);
	expect(diff, `Contact diff at ${label}: ${diff}`).toBeLessThanOrEqual(4);

	// 종횡비: width / height 가 720/1280 과 ±2% 안에서 같아야 함
	const ratio = canvasBox!.width / canvasBox!.height;
	const expectedRatio = 720 / 1280;
	const ratioError = Math.abs(ratio - expectedRatio) / expectedRatio;
	expect(
		ratioError,
		`Aspect ratio error at ${label}: ${ratioError}`,
	).toBeLessThanOrEqual(0.02);

	if (options.checkBoundaries !== false) {
		// 캔버스 위 끝 ≥ .ai-control-bar 아래 끝
		expect(
			canvasBox!.y,
			`Canvas top >= aiBar bottom at ${label}`,
		).toBeGreaterThanOrEqual(aiBox!.y + aiBox!.height - 1);

		// 캔버스 왼쪽 ≥ 0, 오른쪽 ≤ --naia-width + 2px
		expect(
			canvasBox!.x,
			`Canvas left >= 0 at ${label}: ${canvasBox!.x}`,
		).toBeGreaterThanOrEqual(-1);
		expect(
			canvasBox!.x + canvasBox!.width,
			`Canvas right <= naiaWidth + 2 at ${label}`,
		).toBeLessThanOrEqual(naiaWidth + 2);

		// 캔버스 높이 > 150px
		expect(
			canvasBox!.height,
			`Canvas height > 150 at ${label}: ${canvasBox!.height}`,
		).toBeGreaterThan(150);
	}

	return { canvasBox: canvasBox!, chatBox: chatBox!, aiBox: aiBox!, diff };
}

test.describe("UC-NVA-ABOVE-CHAT - Video Avatar positioned above chat area", () => {
	test("sits directly above chat area across viewports, resize, drag, and collapse", async ({
		page,
	}) => {
		await setupPage(page);

		// 1. 1440x900 viewport
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto("/");
		await expect(
			page.locator('[data-video-avatar-loaded="true"]'),
		).toBeVisible({ timeout: 15_000 });

		const box1440 = await assertContactAndBoundaries(page, "1440x900");
		await saveScreenshot(page, "nva-above-chat-1440x900.png");

		// 2. 1280x720 viewport
		await page.setViewportSize({ width: 1280, height: 720 });
		await page.waitForTimeout(100);
		await assertContactAndBoundaries(page, "1280x720");
		await saveScreenshot(page, "nva-above-chat-1280x720.png");

		// 3. Resize to 1100x700 on same page
		await page.setViewportSize({ width: 1100, height: 700 });
		await page.waitForTimeout(100);
		await assertContactAndBoundaries(page, "1100x700 resized");
		await saveScreenshot(page, "nva-above-chat-resized-1100x700.png");

		// Return to 1440x900 before dragging
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.waitForTimeout(100);
		const preDrag = await assertContactAndBoundaries(page, "1440x900 pre-drag");

		// 4. Drag chat toggle up by 120px
		const toggle = page.locator(".naia-chat-toggle");
		const toggleBox = await toggle.boundingBox();
		expect(toggleBox).not.toBeNull();

		await dragChatToggleUp(page, 120, 15);
		await page.waitForTimeout(350);

		const postDrag = await assertContactAndBoundaries(
			page,
			"dragged up 120px",
		);
		const preDragBottom = preDrag.canvasBox.y + preDrag.canvasBox.height;
		const postDragBottom = postDrag.canvasBox.y + postDrag.canvasBox.height;
		expect(
			postDragBottom,
			"Canvas bottom moved up after drag",
		).toBeLessThan(preDragBottom);
		await saveScreenshot(page, "nva-above-chat-dragged-up.png");

		// 5. Click toggle to collapse chat
		await toggle.click();
		await page.waitForTimeout(350);

		const collapsed = await assertContactAndBoundaries(page, "collapsed", {
			checkBoundaries: true,
		});
		const collapsedBottom =
			collapsed.canvasBox.y + collapsed.canvasBox.height;
		expect(
			collapsedBottom,
			"Canvas bottom moved down after collapse",
		).toBeGreaterThan(preDragBottom);
		await saveScreenshot(page, "nva-above-chat-collapsed.png");

		// 6. Insufficient space: uncollapse, drag to 600px, resize to 1100x600 -> hidden, restore -> visible
		await toggle.click();
		await page.waitForTimeout(150);

		await dragChatToggleUp(page, 350, 15);
		await page.waitForTimeout(100);

		await page.setViewportSize({ width: 1100, height: 600 });
		await page.waitForTimeout(150);

		const canvas = page.locator("[data-video-avatar-prebaked]");
		await expect(canvas).toBeHidden();

		await page.setViewportSize({ width: 1440, height: 900 });
		await page.waitForTimeout(150);
		await expect(canvas).toBeVisible();
		await assertContactAndBoundaries(page, "space recovered");
		await saveScreenshot(page, "nva-above-chat-recovered.png");
	});

	test("respects saved nvaPan translation", async ({ page }) => {
		// First get box at pan {0, 0}
		await setupPage(page);
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto("/");
		await expect(
			page.locator('[data-video-avatar-loaded="true"]'),
		).toBeVisible({ timeout: 15_000 });
		const { canvasBox: zeroBox } = await assertContactAndBoundaries(page, "pan 0");

		const panContext = await page.context().browser()!.newContext();
		const panPage = await panContext.newPage();
		await setupPage(panPage, {
			uiPreferences: { nvaPan: { x: 30, y: -20 } },
		});
		await panPage.setViewportSize({ width: 1440, height: 900 });
		await panPage.goto("/");
		await expect(
			panPage.locator('[data-video-avatar-loaded="true"]'),
		).toBeVisible({ timeout: 15_000 });

		const panCanvas = panPage.locator("[data-video-avatar-prebaked]");
		const panBox = await panCanvas.boundingBox();
		expect(panBox).not.toBeNull();

		// Check aspect ratio (width / height within ±2% of 720/1280)
		const panRatio = panBox!.width / panBox!.height;
		const expectedRatio = 720 / 1280;
		const panRatioError = Math.abs(panRatio - expectedRatio) / expectedRatio;
		expect(
			panRatioError,
			`Aspect ratio error in pan test: ${panRatioError}`,
		).toBeLessThanOrEqual(0.02);

		// Saved pan must move the canvas by exactly {x: +30, y: -20} from pan 0.
		expect(zeroBox).not.toBeNull();
		expect(Math.abs(panBox!.x - zeroBox!.x - 30)).toBeLessThanOrEqual(2);
		expect(Math.abs(panBox!.y - zeroBox!.y + 20)).toBeLessThanOrEqual(2);
		expect(Math.abs(panBox!.width - zeroBox!.width)).toBeLessThanOrEqual(2);
		expect(Math.abs(panBox!.height - zeroBox!.height)).toBeLessThanOrEqual(2);

		await saveScreenshot(panPage, "nva-above-chat-pan.png");
		await panContext.close();
	});

	test("restores avatar layout when unhidden after resize (hide then show)", async ({
		page,
	}) => {
		await setupPage(page);
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto("/");
		await expect(
			page.locator('[data-video-avatar-loaded="true"]'),
		).toBeVisible({ timeout: 15_000 });
		await waitForVideoReady(page);

		// 1440x900 에서 대화창을 600px 까지 끌기
		await dragChatToggleUp(page, 350, 15);
		await page.waitForTimeout(200);

		// 창을 1100x600 으로 줄여 캔버스가 숨겨진 것을 확인
		await page.setViewportSize({ width: 1100, height: 600 });
		await page.waitForTimeout(200);

		const canvas = page.locator("[data-video-avatar-prebaked]");
		await expect(canvas).toBeHidden();

		// 나이아 영역 숨기기 (타이틀바의 나이아 보이기 단추: toggleNaia)
		const toggleNaiaBtn = page.locator('.titlebar-btn[title*="Ctrl+B"]');
		await toggleNaiaBtn.click();
		await expect(page.locator(".naia-chat-area")).toHaveCount(0);

		// 창을 1440x900 으로 키우기
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.waitForTimeout(150);

		// 다시 보이게 하기
		await toggleNaiaBtn.click();
		await expect(page.locator(".naia-chat-area")).toBeVisible();

		// 이때 캔버스가 보이고, 대화창 위에 맞닿고, 비율이 맞아야 한다
		await expect(canvas).toBeVisible({ timeout: 5_000 });
		await assertContactAndBoundaries(page, "hide then show restored");
		await saveScreenshot(page, "nva-above-chat-hide-then-show.png");
	});

	test("preserves centered layout in workspace mode", async ({ page }) => {
		await setupPage(page, {
			uiPreferences: { chatMode: "workspace" },
		});
		await page.addInitScript(() => {
			(window as unknown as { __mockUiConfig?: Record<string, unknown> }).__mockUiConfig = {
				uiPreferences: { chatMode: "workspace" },
			};
			localStorage.setItem("naia-chat-mode-v1", "workspace");
		});

		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto("/");
		await expect(
			page.locator('[data-video-avatar-loaded="true"]'),
		).toBeVisible({ timeout: 15_000 });

		// Click workspace layout mode button if not already in workspace mode
		const wsModeBtn = page.locator('.naia-chat-mode[title="왼쪽 채움"]');
		if ((await wsModeBtn.getAttribute("aria-pressed")) !== "true") {
			await wsModeBtn.click();
			await page.waitForTimeout(100);
		}

		const canvas = page.locator("[data-video-avatar-prebaked]");
		await expect(canvas).toBeVisible();
		const canvasBox = await canvas.boundingBox();
		expect(canvasBox).not.toBeNull();

		// In workspace mode (origin/main behavior):
		// Horizontal center is at --naia-width / 2 = 160px (±4px)
		const centerX = canvasBox!.x + canvasBox!.width / 2;
		expect(Math.abs(centerX - 160), `Workspace horizontal center ${centerX} near 160`).toBeLessThanOrEqual(4);

		// Vertical position matches origin/main rendering:
		// Top y ≈ 68px (±6px), bottom y > 800px (canvas extends past chat area into bottom)
		expect(canvasBox!.y).toBeGreaterThanOrEqual(60);
		expect(canvasBox!.y).toBeLessThanOrEqual(76);
		expect(canvasBox!.y + canvasBox!.height).toBeGreaterThan(800);

		await saveScreenshot(page, "nva-above-chat-workspace.png");
	});
});
