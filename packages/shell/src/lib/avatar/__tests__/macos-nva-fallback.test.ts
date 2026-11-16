// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveVrmPixelRatio } from "../../../components/AvatarCanvas";
import type { NvaManifest } from "../../nva";
import { shouldIncludeDesktopPublicAsset } from "../desktop-public-assets";
import {
	isStackedAlphaClipUrl,
	isStackedAlphaVideoElement,
	isWebKitWithoutVp9Alpha,
	markVideoStackedAlpha,
	resolveNvaClipCandidates,
	shouldUseStackedAlpha,
} from "../nva-stacked-alpha";
import { PrebakedAvatarRenderer } from "../prebaked-renderer";

const MACOS_INTEL_WKWEBVIEW_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const MACOS_SAFARI_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const MACOS_CHROME_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const LINUX_WEBKITGTK_UA =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const WINDOWS_WEBVIEW2_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";

function sampleManifest(withStackedMapping = false): NvaManifest {
	return {
		nva_version: "0.2",
		canvas: { width: 720, height: 1280 },
		background: { type: "transparent", color: "#00ff00" },
		animations: {
			idle: { clip: "clips/idle.webm", loop: true, can_talk: false },
			talking: { clip: "clips/talking-ko.webm", loop: true, can_talk: true },
		},
		...(withStackedMapping
			? {
					stacked_alpha: {
						layout: "color-top-alpha-bottom",
						clips: {
							"clips/idle.webm": "clips/idle.stacked.mp4",
							"clips/talking-ko.webm": "clips/talking-ko.stacked.mp4",
						},
					},
				}
			: {}),
	};
}

describe("macOS WKWebView NVA detection and stacked-alpha routing", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("identifies macOS WKWebView and Safari without misclassifying Chrome, WebView2, or Linux WebKitGTK", () => {
		expect(isWebKitWithoutVp9Alpha({ userAgent: MACOS_INTEL_WKWEBVIEW_UA })).toBe(
			true,
		);
		expect(isWebKitWithoutVp9Alpha({ userAgent: MACOS_SAFARI_UA })).toBe(true);
		expect(isWebKitWithoutVp9Alpha({ userAgent: MACOS_CHROME_UA })).toBe(false);
		expect(isWebKitWithoutVp9Alpha({ userAgent: LINUX_WEBKITGTK_UA })).toBe(
			false,
		);
		expect(isWebKitWithoutVp9Alpha({ userAgent: WINDOWS_WEBVIEW2_UA })).toBe(
			false,
		);
		expect(
			isWebKitWithoutVp9Alpha({
				userAgent: LINUX_WEBKITGTK_UA,
				canPlayVp9Webm: false,
			}),
		).toBe(true);
	});

	it("preserves stacked_alpha identity across extensionless desktop blob: URLs", () => {
		const blobUrl = "blob:tauri://localhost/8f9b7c12-3456-4abc-9def-0123456789ab";
		expect(isStackedAlphaClipUrl(blobUrl)).toBe(false);
		expect(isStackedAlphaClipUrl("clips/idle.stacked.mp4?v=1")).toBe(true);

		const video = document.createElement("video");
		video.src = blobUrl;
		markVideoStackedAlpha(video, true, "clips/idle.stacked.mp4");
		expect(video.dataset.naiaStackedAlpha).toBe("true");
		expect(video.dataset.naiaResolvedPath).toBe("clips/idle.stacked.mp4");
		expect(isStackedAlphaVideoElement(video, blobUrl)).toBe(true);

		markVideoStackedAlpha(video, false, "clips/idle.webm");
		expect(isStackedAlphaVideoElement(video, blobUrl)).toBe(false);
	});

	it("orders stacked MP4 and chromakey MP4 ahead of WebM on macOS WKWebView even without manifest.stacked_alpha", () => {
		const unmapped = sampleManifest(false);
		const macCandidates = resolveNvaClipCandidates(unmapped, "clips/idle.webm", {
			preferStackedAlpha: true,
			webmUnsupported: true,
		});
		expect(macCandidates).toEqual([
			{
				path: "clips/idle.stacked.mp4",
				stackedAlpha: true,
				inferredFallback: true,
			},
			{
				path: "clips/idle.mp4",
				stackedAlpha: false,
				inferredFallback: true,
			},
			{
				path: "clips/idle.webm",
				stackedAlpha: false,
				inferredFallback: false,
			},
		]);

		const mapped = sampleManifest(true);
		const desktopMapped = resolveNvaClipCandidates(mapped, "clips/idle.webm", {
			preferStackedAlpha: shouldUseStackedAlpha({ search: "" }),
			webmUnsupported: false,
		});
		expect(desktopMapped[0]).toEqual({
			path: "clips/idle.stacked.mp4",
			stackedAlpha: true,
			inferredFallback: false,
		});
		expect(desktopMapped[1]).toEqual({
			path: "clips/idle.webm",
			stackedAlpha: false,
			inferredFallback: false,
		});

		const forcedWebm = resolveNvaClipCandidates(mapped, "clips/idle.webm", {
			preferStackedAlpha: shouldUseStackedAlpha({ search: "?nva_alpha=webm" }),
			webmUnsupported: false,
		});
		expect(forcedWebm[0]?.path).toBe("clips/idle.webm");
	});

	it("composites blob: stacked_alpha clips at half height via StackedAlphaCompositor", async () => {
		const manifest = sampleManifest(true);
		const compositeCanvas = document.createElement("canvas");
		compositeCanvas.width = 720;
		compositeCanvas.height = 1280;
		const drawSpy = vi.fn(() => true);
		const disposeSpy = vi.fn();

		const rafCallbacks: FrameRequestCallback[] = [];
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
			rafCallbacks.push(cb);
			return 1;
		});
		vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
		vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});

		const drawImageSpy = vi.fn();
		const clearRectSpy = vi.fn();
		const canvas = document.createElement("canvas");
		canvas.width = 720;
		canvas.height = 1280;
		Object.defineProperty(canvas, "getContext", {
			configurable: true,
			value: () => ({
				clearRect: clearRectSpy,
				drawImage: drawImageSpy,
			}),
		});

		const video = document.createElement("video");
		Object.defineProperty(video, "readyState", { value: 4, configurable: true });
		Object.defineProperty(video, "videoWidth", {
			value: 720,
			configurable: true,
		});
		Object.defineProperty(video, "videoHeight", {
			value: 2560,
			configurable: true,
		});

		const renderer = new PrebakedAvatarRenderer({
			manifest,
			locale: "ko-KR",
			// Returns an extensionless desktop blob: URL!
			resolveAssetUrl: async () => "blob:tauri://localhost/stacked-idle-uuid",
			createStackedAlpha: () => ({
				canvas: compositeCanvas,
				draw: drawSpy,
				dispose: disposeSpy,
			}),
		});

		renderer.start(video, canvas);
		await vi.waitFor(() => {
			expect(video.dataset.naiaStackedAlpha).toBe("true");
		});
		expect(video.dataset.naiaResolvedPath).toBe("clips/idle.stacked.mp4");
		const firstRaf = rafCallbacks.shift();
		expect(firstRaf).toBeTypeOf("function");
		firstRaf?.(16);

		expect(drawSpy).toHaveBeenCalledWith(video);
		// 720 x (2560 / 2 = 1280) fits 720 x 1280 exactly without 2x vertical letterboxing!
		expect(drawImageSpy).toHaveBeenCalledWith(compositeCanvas, 0, 0, 720, 1280);

		renderer.stop();
		expect(disposeSpy).toHaveBeenCalledTimes(1);
	});

	it("falls back from unsupported WebM to H.264 MP4 and reports failure when all candidates fail", async () => {
		const manifest = sampleManifest(false);
		const attemptedUrls: string[] = [];
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
		vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
			this: HTMLMediaElement,
		) {
			attemptedUrls.push(this.src);
			if (this.src.includes("webm-blob")) {
				return Promise.reject(
					new DOMException("The operation is not supported.", "NotSupportedError"),
				);
			}
			return Promise.resolve();
		});

		const onPlaybackFailure = vi.fn();
		const video = document.createElement("video");
		document.body.appendChild(video);
		const canvas = document.createElement("canvas");

		const renderer = new PrebakedAvatarRenderer({
			manifest,
			locale: "ko-KR",
			resolveAssetUrl: async (path) => `blob:${path}`,
			resolveClipCandidates: async () => [
				{
					url: "blob:tauri://localhost/webm-blob",
					stackedAlpha: false,
					resolvedPath: "clips/idle.webm",
				},
				{
					url: "blob:tauri://localhost/mp4-stacked-blob",
					stackedAlpha: true,
					resolvedPath: "clips/idle.stacked.mp4",
				},
			],
			onPlaybackFailure,
		});

		renderer.start(video, canvas);
		await vi.waitFor(() => {
			expect(attemptedUrls.length).toBe(2);
		});
		expect(onPlaybackFailure).not.toHaveBeenCalled();
		renderer.stop();

		// Now verify that when ALL candidates fail, `onPlaybackFailure` is invoked once.
		vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(
			new Error("WebM/MP4 decode unsupported"),
		);
		const onTerminalFailure = vi.fn();
		const failingRenderer = new PrebakedAvatarRenderer({
			manifest,
			locale: "ko-KR",
			resolveAssetUrl: async () => "blob:tauri://localhost/broken",
			onPlaybackFailure: onTerminalFailure,
		});
		failingRenderer.start(video, canvas);
		await vi.waitFor(() => {
			expect(onTerminalFailure).toHaveBeenCalledWith("WebM/MP4 decode unsupported");
		});
		failingRenderer.stop();
		video.remove();
	});
});

describe("macOS desktop build asset filter, Retina DPR cap, and Korean font stack", () => {
	it("preserves NVA manifests, stacked.mp4 clips, and posters while excluding web-only assets", () => {
		expect(shouldIncludeDesktopPublicAsset("nva", true)).toBe(true);
		expect(shouldIncludeDesktopPublicAsset("nva/jina", true)).toBe(true);
		expect(shouldIncludeDesktopPublicAsset("nva/jina/clips", true)).toBe(true);
		expect(shouldIncludeDesktopPublicAsset("nva/jina/manifest.json")).toBe(true);
		expect(
			shouldIncludeDesktopPublicAsset("nva/jina/clips/idle.stacked.mp4"),
		).toBe(true);
		expect(shouldIncludeDesktopPublicAsset("nva/naia/idle.webp")).toBe(true);
		expect(
			shouldIncludeDesktopPublicAsset("nva/jina/speech/neutral-head.png"),
		).toBe(true);

		expect(shouldIncludeDesktopPublicAsset("nva/jina/clips/idle.webm")).toBe(
			false,
		);
		expect(shouldIncludeDesktopPublicAsset("nva/jina/speech/atlas.bin")).toBe(
			false,
		);
		expect(shouldIncludeDesktopPublicAsset("backgrounds/office.mp4")).toBe(
			false,
		);
		expect(shouldIncludeDesktopPublicAsset("kiosk-slides/01.webp")).toBe(false);
		expect(shouldIncludeDesktopPublicAsset("avatars/Naia.vrm")).toBe(true);
		expect(shouldIncludeDesktopPublicAsset("animations/idle.vrma")).toBe(true);
	});

	it("caps VRM WebGL devicePixelRatio at 1.5 on macOS Retina displays", () => {
		expect(resolveVrmPixelRatio(2, MACOS_INTEL_WKWEBVIEW_UA)).toBe(1.5);
		expect(resolveVrmPixelRatio(3, MACOS_SAFARI_UA)).toBe(1.5);
		expect(resolveVrmPixelRatio(1, MACOS_INTEL_WKWEBVIEW_UA)).toBe(1);
		expect(resolveVrmPixelRatio(2, WINDOWS_WEBVIEW2_UA)).toBe(2);
		expect(resolveVrmPixelRatio(Number.NaN, MACOS_INTEL_WKWEBVIEW_UA)).toBe(1);
	});

	it("prioritizes Apple SD Gothic Neo ahead of NanumGothic and Japanese/Chinese CJK fonts in global.css", () => {
		const cssPath = resolve(__dirname, "../../../styles/global.css");
		const css = readFileSync(cssPath, "utf8");

		const fontFaceBlock = css.match(/@font-face\s*\{[\s\S]*?\}/)?.[0] ?? "";
		expect(fontFaceBlock).toContain('font-family: "KoreanUI"');
		expect(fontFaceBlock.indexOf("Apple SD Gothic Neo")).toBeGreaterThan(-1);
		expect(fontFaceBlock.indexOf("Apple SD Gothic Neo")).toBeLessThan(
			fontFaceBlock.indexOf("NanumGothic"),
		);

		const rootBlock =
			css.match(/html,\s*body,\s*#root\s*\{[\s\S]*?\}/)?.[0] ?? "";
		const appleIdx = rootBlock.indexOf('"Apple SD Gothic Neo"');
		const koreanUiIdx = rootBlock.indexOf('"KoreanUI"');
		const nanumIdx = rootBlock.indexOf('"NanumGothic"');
		const jpIdx = rootBlock.indexOf('"Noto Sans CJK JP"');
		const scIdx = rootBlock.indexOf('"Noto Sans CJK SC"');
		expect(appleIdx).toBeGreaterThan(-1);
		expect(appleIdx).toBeLessThan(koreanUiIdx);
		expect(appleIdx).toBeLessThan(nanumIdx);
		expect(appleIdx).toBeLessThan(jpIdx);
		expect(appleIdx).toBeLessThan(scIdx);
	});
});
