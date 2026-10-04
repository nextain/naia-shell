import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { TAURI_BASE_MOCK_FALLBACK } from "./helpers/tauri-base-mock";

/**
 * #447 onboarding character step — real-UI acceptance for the launch-QA fixes.
 *
 *   #447-1: the chat is at its default dock, not a full-window bar.
 *   #447-2 (VRM thumbnails): every VRM card shows a loaded /avatars/*.webp image
 *           (the .vrm↔.webp name mismatch is fixed).
 *   #447-2 (single focus): with the NVA default selected, exactly one card is
 *           highlighted — the OL_Woman VRM is no longer focused at the same time.
 *
 * IPC is mocked (no Tauri backend); the VRM thumbnails are served from the real
 * public/avatars by the Vite dev server, which is what these assertions cover.
 */

const ADK = "/tmp/mock-naia-adk-workspace";

// The official naia-adk vrm-files names (see D:/naia-adk/naia-settings/vrm-files).
const VRM_FILES = [
	"01-OL_Woman.vrm",
	"02-Hood_Boy.vrm",
	"03-Sendagaya-Shino-uniform.vrm",
	"04-Sakurada-Fumiriya.vrm",
	"naia_char_skin_head.vrm",
	"naia_char_with_hair.vrm",
];
const NVA_DIRS = ["naia", "minho", "jina"];
const NVA_VIDEO_BASE64 = readFileSync(
	path.resolve(process.cwd(), "e2e/fixtures/head-green-100.mp4"),
).toString("base64");
const LIVE_NAIA_CLIP = process.env.NVA_LIVE_NAIA_CLIP
	? path.resolve(process.env.NVA_LIVE_NAIA_CLIP)
	: path.resolve(
			process.cwd(),
			"../../../naia-adk/naia-settings/nva-files/naia/clips/idle.webm",
		);
const LIVE_NAIA_VIDEO_BASE64 = existsSync(LIVE_NAIA_CLIP)
	? readFileSync(LIVE_NAIA_CLIP).toString("base64")
	: NVA_VIDEO_BASE64;
const NVA_MANIFEST = {
	nva_version: "0.2",
	meta: { name: "QA portrait" },
	canvas: { width: 720, height: 1280, fps: 24 },
	background: { type: "transparent" },
	poses: ["default"],
	animations: {
		idle: {
			clip: "clips/idle.mp4",
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

function buildInvokeMock() {
	return `
(function() {
	window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
	window.__avatarPreviewEvents = [];
	window.addEventListener("naia-avatar-preview", function(event) {
		window.__avatarPreviewEvents.push(event.detail);
	});
	window.__TAURI_INTERNALS__.metadata = {
		currentWindow: { label: "main" },
		currentWebview: { windowLabel: "main", label: "main" },
	};
	var cbs = new Map(); var nextId = 1;
	window.__TAURI_INTERNALS__.transformCallback = function(fn, once) {
		var id = nextId++;
		cbs.set(id, function(d) { if (once) cbs.delete(id); return fn && fn(d); });
		return id;
	};
	window.__TAURI_INTERNALS__.unregisterCallback = function(id) { cbs.delete(id); };
	window.__TAURI_INTERNALS__.runCallback = function(id, d) { var cb = cbs.get(id); if (cb) cb(d); };
	window.__TAURI_INTERNALS__.convertFileSrc = function(p, proto) {
		return (proto || "asset") + "://localhost/" + encodeURIComponent(p);
	};
	var eventListeners = new Map();
	window.__eventListeners = eventListeners;
	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		if (cmd === "plugin:event|listen") {
			if (!eventListeners.has(args.event)) eventListeners.set(args.event, []);
			eventListeners.get(args.event).push({ callbackId: args.handler });
			return args.handler;
		}
		if (cmd === "plugin:event|emit" || cmd === "plugin:event|unlisten") return null;
		if (cmd === "detect_gpu_vram") return 8;
		if (cmd === "list_naia_assets") {
			if (args && args.subdir === "vrm-files") return ${JSON.stringify(VRM_FILES)};
			if (args && args.subdir === "nva-files") return ${JSON.stringify(NVA_DIRS)};
			return [];
		}
		if (cmd === "read_local_binary") {
			var normalizedPath = String(args.path).replaceAll("\\\\", "/");
			var isLiveNaia = normalizedPath.includes("/nva-files/naia/");
			if (args.path.endsWith("manifest.json")) {
				var manifest = ${JSON.stringify(NVA_MANIFEST)};
				if (isLiveNaia) manifest.animations.idle.clip = "clips/idle.webm";
				return btoa(JSON.stringify(manifest));
			}
			return isLiveNaia ? ${JSON.stringify(LIVE_NAIA_VIDEO_BASE64)} : ${JSON.stringify(NVA_VIDEO_BASE64)};
		}
		if (cmd === "write_naia_path_cache") return null;
		if (cmd === "workspace_detect_adk_root") return ${JSON.stringify(ADK)};
		if (cmd === "read_naia_config" || cmd === "read_naia_ui_config") return "";
		return undefined;
	};
})();
`;
}

async function gotoCharacterStep(page: import("@playwright/test").Page) {
	await page.addInitScript(buildInvokeMock());
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript((adk) => {
		localStorage.setItem("naia-adk-path", adk);
		localStorage.removeItem("naia-config");
	}, ADK);
	await page.goto("/");
	await expect(page.locator(".onboarding-app")).toBeVisible({
		timeout: 20_000,
	});

	// welcome → agentName → userName → speechStyle → character.
	// Advance with the step Next button; fill the two text steps on the way.
	async function next() {
		await page.locator(".onboarding-step__next-btn").first().click();
		await page.waitForTimeout(450); // 300ms transition lock + margin
	}
	await next(); // welcome → agentName
	await page.locator(".onboarding-step__input").first().fill("Mochi");
	await next(); // agentName → userName
	await page.locator(".onboarding-step__input").first().fill("Alex");
	await next(); // userName → speechStyle
	await next(); // speechStyle → character
	await expect(page.locator(".onboarding-step__avatar-grid")).toBeVisible({
		timeout: 10_000,
	});
}

test.describe("#447 onboarding avatar grid", () => {
	test("VRM thumbnails load and only one avatar is focused (#447-2)", async ({
		page,
	}) => {
		await gotoCharacterStep(page);

		// VRM badge cards: all six official avatars from a fresh ADK are present.
		const vrmBadges = page.locator(".onboarding-step__avatar-badge", {
			hasText: "VRM",
		});
		await expect(vrmBadges).toHaveCount(VRM_FILES.length);

		// Every VRM card's thumbnail image is actually loaded (the .vrm↔.webp name
		// fix): a broken/missing src has naturalWidth 0.
		const vrmImgs = page.locator(
			".onboarding-step__avatar-card img.onboarding-step__avatar-img",
		);
		const imgCount = await vrmImgs.count();
		expect(imgCount).toBe(VRM_FILES.length);
		for (let i = 0; i < imgCount; i += 1) {
			const natural = await vrmImgs
				.nth(i)
				.evaluate((el) => (el as HTMLImageElement).naturalWidth);
			expect(natural, `VRM thumbnail ${i} should be loaded`).toBeGreaterThan(0);
		}

		// Exactly one card is selected (the default NVA) — no double focus with a
		// VRM card.
		await expect(
			page.locator(".onboarding-step__avatar-card--selected"),
		).toHaveCount(1);

		// The selected card is an NVA card (default provider = NVA).
		const selected = page.locator(".onboarding-step__avatar-card--selected");
		await expect(selected.locator(".onboarding-step__avatar-badge")).toHaveText(
			"NVA",
		);
		await expect(selected).toHaveAttribute("aria-pressed", "true");
		await expect(
			page.locator('.onboarding-step__avatar-card[aria-pressed="true"]'),
		).toHaveCount(1);
		await expect
			.poll(() =>
				page.evaluate(
					() =>
						(
							window as Window & {
								__avatarPreviewEvents?: Array<{
									provider?: string;
									model?: string;
								}>;
							}
						).__avatarPreviewEvents?.some(
							(event) =>
								event.provider === "naia-video-avatar" &&
								event.model === "naia",
						) ?? false,
				),
			)
			.toBe(true);

		for (const filename of [
			"naia_char_skin_head.vrm",
			"naia_char_with_hair.vrm",
		]) {
			const label = filename.replace(/\.vrm$/i, "");
			const card = page.locator(".onboarding-step__avatar-card", {
				hasText: label,
			});
			await card.click();
			await expect(card).toHaveAttribute("aria-pressed", "true");
			await expect
				.poll(() =>
					page.evaluate(
						(model) =>
							(
								window as Window & {
									__avatarPreviewEvents?: Array<{
										provider?: string;
										model?: string;
									}>;
								}
							).__avatarPreviewEvents?.some(
								(event) => event.provider === "vrm" && event.model === model,
							) ?? false,
						filename,
					),
				)
				.toBe(true);
		}
	});

	test("live-action Naia portrait is lowered on desktop and narrow grids (#448)", async ({
		page,
	}, testInfo) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await gotoCharacterStep(page);

		const app = page.locator(".onboarding-app");
		const grid = page.locator(".onboarding-step__avatar-grid");
		const naiaCard = page.locator(".onboarding-step__avatar-card", {
			hasText: "naia",
		});
		const liveCrop = naiaCard.locator(".onboarding-step__nva-crop");
		const genericCrop = page.locator(".onboarding-step__nva-crop").nth(1);
		const liveMedia = liveCrop.locator(".onboarding-step__nva-crop-media");
		const genericMedia = genericCrop.locator(
			".onboarding-step__nva-crop-media",
		);
		await expect(liveCrop).toHaveCount(1);
		await expect(liveCrop).toBeVisible();
		await expect(liveMedia).toBeAttached();

		const [
			appBox,
			gridBox,
			cropBox,
			liveMediaBox,
			genericCropBox,
			genericMediaBox,
		] = await Promise.all([
			app.boundingBox(),
			grid.boundingBox(),
			liveCrop.boundingBox(),
			liveMedia.boundingBox(),
			genericCrop.boundingBox(),
			genericMedia.boundingBox(),
		]);
		expect(appBox).not.toBeNull();
		expect(gridBox).not.toBeNull();
		expect(cropBox).not.toBeNull();
		expect(liveMediaBox).not.toBeNull();
		expect(genericCropBox).not.toBeNull();
		expect(genericMediaBox).not.toBeNull();
		expect(gridBox!.x).toBeGreaterThanOrEqual(appBox!.x);
		expect(gridBox!.x + gridBox!.width).toBeLessThanOrEqual(
			appBox!.x + appBox!.width + 1,
		);
		expect(cropBox!.width).toBe(76);
		expect(cropBox!.height).toBe(88);
		expect(liveMediaBox!.width).toBeGreaterThan(cropBox!.width);
		expect(liveMediaBox!.x).toBeLessThan(cropBox!.x);
		// Naia and other NVA portraits both use the standard top-biased framing.
		await expect(liveMedia).toHaveCSS("top", "-12px");
		await expect(liveMedia).toHaveCSS("width", "125px");
		await expect(genericMedia).toHaveCSS("top", "-12px");
		await expect(genericMedia).toHaveCSS("width", "125px");

		await liveMedia.evaluate((el) => {
			if (el.tagName === "IMG") {
				const img = el as HTMLImageElement;
				if (img.complete && img.naturalWidth > 0) return Promise.resolve();
				return new Promise((resolve) => {
					img.addEventListener("load", () => resolve(undefined), { once: true });
				});
			}
			const video = el as HTMLVideoElement;
			if (video.readyState >= 2) return Promise.resolve();
			return new Promise((resolve) => {
				video.addEventListener("loadeddata", () => resolve(undefined), {
					once: true,
				});
			});
		});

		await app.screenshot({
			path: testInfo.outputPath("nva-crop-desktop.png"),
		});

		await page.setViewportSize({ width: 420, height: 720 });
		await expect(liveCrop).toBeVisible();
		const [narrowApp, narrowGrid, narrowCrop, narrowMedia] =
			await Promise.all([
				app.boundingBox(),
				grid.boundingBox(),
				liveCrop.boundingBox(),
				liveMedia.boundingBox(),
			]);
		expect(narrowApp).not.toBeNull();
		expect(narrowGrid).not.toBeNull();
		expect(narrowCrop).not.toBeNull();
		expect(narrowMedia).not.toBeNull();
		expect(narrowGrid!.x).toBeGreaterThanOrEqual(narrowApp!.x);
		expect(narrowGrid!.x + narrowGrid!.width).toBeLessThanOrEqual(
			narrowApp!.x + narrowApp!.width + 1,
		);
		await expect(liveMedia).toHaveCSS("top", "-12px");

		await app.screenshot({
			path: testInfo.outputPath("nva-crop-narrow.png"),
		});
	});

	test("chat is at its default dock, not a full-window bar (#447-1)", async ({
		page,
	}) => {
		await gotoCharacterStep(page);
		const chat = page.locator(".naia-chat-area");
		await expect(chat).toBeVisible();
		const box = await chat.boundingBox();
		const viewport = page.viewportSize();
		expect(box).not.toBeNull();
		expect(viewport).not.toBeNull();
		// The retired centered layout must not return: the compact chat is pinned
		// to the lower-left avatar column, not merely constrained in width.
		expect(box!.width).toBeLessThan(viewport!.width * 0.6);
		expect(box!.x).toBeLessThan(viewport!.width * 0.05);
		expect(
			Math.abs(box!.y + box!.height - viewport!.height),
		).toBeLessThanOrEqual(1);
	});
});
