// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncWebSttOnSpeakingChange } from "../../../components/ChatArea";
import {
	isReadyToChat,
	loadConfig,
	resolveThinkingLevel,
	resolveWebThinkingEnabled,
	saveConfig,
} from "../../config";
import {
	RETIRED_WEB_BACKGROUND_FILENAMES,
	WEB_BACKGROUND_ASSETS,
	WEB_DEFAULT_BACKGROUND,
	WEB_DEFAULT_BACKGROUND_URL,
	WEB_DEFAULT_NVA,
	WEB_DEFAULT_VRM,
	WEB_NVA_ASSETS,
	WEB_VRM_ASSETS,
	isRetiredWebBackground,
	isWebBundledAssetUrl,
	isWebMode,
	normalizeRetiredWebBackgroundInRecord,
	setWebAssetsModeForTests,
} from "../web-assets";

afterEach(() => {
	setWebAssetsModeForTests(null);
	localStorage.clear();
});

describe("isWebMode", () => {
	it("follows the test override when set", () => {
		setWebAssetsModeForTests(true);
		expect(isWebMode()).toBe(true);
		setWebAssetsModeForTests(false);
		expect(isWebMode()).toBe(false);
	});

	it("falls back to the build mode when the override is cleared", () => {
		// vitest runs with MODE=test, never "web".
		expect(import.meta.env.MODE).not.toBe("web");
		expect(isWebMode()).toBe(false);
	});
});

describe("web bundled catalogs", () => {
	it("exposes 4 VRM entries with absolute dist URLs", () => {
		expect(WEB_VRM_ASSETS).toHaveLength(4);
		for (const asset of WEB_VRM_ASSETS) {
			expect(asset.filename).toMatch(/\.vrm$/);
			expect(asset.url).toBe(`/avatars/${asset.filename}`);
			expect(asset.label.length).toBeGreaterThan(0);
		}
	});

	it("exposes 8 background entries in catalog order with Korean labels and image/video kinds", () => {
		expect(WEB_BACKGROUND_ASSETS).toHaveLength(8);
		expect(WEB_BACKGROUND_ASSETS.map((asset) => asset.filename)).toEqual([
			"naia-dawn-city-uhd.webp",
			"naia-jina-minho-war-room-uhd.webp",
			"naia-sunrise-river.webp",
			"naia-rainy-studio.webp",
			"naia-starlight-lake.webp",
			"naia-sky-garden.webp",
			"naia-starlight-lake-live.mp4",
			"naia-rainy-studio-live.mp4",
		]);
		expect(WEB_BACKGROUND_ASSETS.map((asset) => asset.label)).toEqual([
			"새벽 도시",
			"작전실 — 나이아·지나·민호",
			"강변 해돋이",
			"비 오는 작업실",
			"별빛 호수",
			"하늘 정원",
			"별빛 호수 (움직이는 배경)",
			"비 오는 작업실 (움직이는 배경)",
		]);
		expect(WEB_BACKGROUND_ASSETS.map((asset) => asset.kind)).toEqual([
			"image",
			"image",
			"image",
			"image",
			"image",
			"image",
			"video",
			"video",
		]);
		for (const asset of WEB_BACKGROUND_ASSETS) {
			expect(asset.url).toBe(`/backgrounds/${asset.filename}`);
		}
	});

	it("exposes 6 NVA bundle names with naia as default", () => {
		expect(WEB_NVA_ASSETS).toEqual([
			"naia",
			"naia-anime",
			"jina",
			"jina-anime",
			"minho",
			"minho-anime",
		]);
		expect(WEB_DEFAULT_NVA).toBe("naia");
	});

	it("defaults point at the first catalog entries", () => {
		expect(WEB_DEFAULT_VRM).toBe(WEB_VRM_ASSETS[0].url);
		expect(WEB_DEFAULT_BACKGROUND).toBe("naia-dawn-city-uhd.webp");
		expect(WEB_DEFAULT_BACKGROUND).toBe(WEB_BACKGROUND_ASSETS[0].filename);
		expect(WEB_DEFAULT_BACKGROUND_URL).toBe(
			`/backgrounds/${WEB_DEFAULT_BACKGROUND}`,
		);
	});
});

describe("isWebBundledAssetUrl", () => {
	it("accepts dist asset URLs", () => {
		expect(isWebBundledAssetUrl("/avatars/03-OL_Woman.vrm")).toBe(true);
		expect(isWebBundledAssetUrl("/backgrounds/naia-dawn-city-uhd.webp")).toBe(
			true,
		);
		expect(isWebBundledAssetUrl("avatars/03-OL_Woman.vrm")).toBe(true);
	});

	it("rejects workspace absolute paths and remote URLs", () => {
		expect(isWebBundledAssetUrl("/home/user/naia-adk/naia-settings")).toBe(
			false,
		);
		expect(isWebBundledAssetUrl("https://example.com/a.vrm")).toBe(false);
		expect(isWebBundledAssetUrl("blob:https://x/y")).toBe(false);
	});
});

describe("retired face-crop web backgrounds", () => {
	it("identifies retired ol-woman-dusk and shino-uniform-dusk filenames and paths", () => {
		for (const retired of RETIRED_WEB_BACKGROUND_FILENAMES) {
			expect(isRetiredWebBackground(retired)).toBe(true);
			expect(isRetiredWebBackground(`/backgrounds/${retired}`)).toBe(true);
		}
		expect(isRetiredWebBackground("naia-dawn-city-uhd.webp")).toBe(false);
		expect(isRetiredWebBackground("/backgrounds/naia-dawn-city-uhd.webp")).toBe(
			false,
		);
		expect(isRetiredWebBackground("")).toBe(false);
		expect(isRetiredWebBackground(null)).toBe(false);
	});

	it("replaces retired backgroundVideo and backgroundImage in stored records with default background", () => {
		const record: Record<string, unknown> = {
			backgroundVideo: "ol-woman-dusk.webp",
			backgroundImage: "/backgrounds/shino-uniform-dusk.webp",
		};
		expect(normalizeRetiredWebBackgroundInRecord(record)).toBe(true);
		expect(record.backgroundVideo).toBe(WEB_DEFAULT_BACKGROUND);
		expect(record.backgroundImage).toBe(WEB_DEFAULT_BACKGROUND_URL);

		expect(normalizeRetiredWebBackgroundInRecord(record)).toBe(false);
	});

	it("preserves desktop background filenames and provider readiness in loadConfig/saveConfig when isWebMode() is false", () => {
		setWebAssetsModeForTests(false);
		saveConfig({
			provider: "webllm",
			model: "Qwen3-4B-q4f16_1-MLC",
			apiKey: "",
			backgroundVideo: "ol-woman-dusk.webp",
			backgroundImage: "/backgrounds/shino-uniform-dusk.webp",
		});

		const desktopLoaded = loadConfig();
		expect(desktopLoaded?.backgroundVideo).toBe("ol-woman-dusk.webp");
		expect(desktopLoaded?.backgroundImage).toBe(
			"/backgrounds/shino-uniform-dusk.webp",
		);
		expect(isReadyToChat()).toBe(false);

		// In web mode, retired face-crop backgrounds are migrated and webllm needs no API key
		setWebAssetsModeForTests(true);
		const webLoaded = loadConfig();
		expect(webLoaded?.backgroundVideo).toBe(WEB_DEFAULT_BACKGROUND);
		expect(webLoaded?.backgroundImage).toBe(WEB_DEFAULT_BACKGROUND_URL);
		expect(isReadyToChat()).toBe(true);
	});

	it("does not pause or schedule resume of STT on desktop when setSpeaking fires, and only pauses/resumes in web mode", () => {
		const clearCooldownTimer = vi.fn();
		const pauseStt = vi.fn();
		const scheduleResumeStt = vi.fn();

		// Desktop mode: no STT pause or resume side effects
		setWebAssetsModeForTests(false);
		syncWebSttOnSpeakingChange({
			isSpeaking: true,
			pipelineActive: true,
			hasActiveSpeechActivity: false,
			clearCooldownTimer,
			pauseStt,
			scheduleResumeStt,
		});
		syncWebSttOnSpeakingChange({
			isSpeaking: false,
			pipelineActive: true,
			hasActiveSpeechActivity: false,
			clearCooldownTimer,
			pauseStt,
			scheduleResumeStt,
		});
		expect(clearCooldownTimer).not.toHaveBeenCalled();
		expect(pauseStt).not.toHaveBeenCalled();
		expect(scheduleResumeStt).not.toHaveBeenCalled();

		// Web mode: pauses on speaking start and schedules 800ms resume on speaking end
		setWebAssetsModeForTests(true);
		syncWebSttOnSpeakingChange({
			isSpeaking: true,
			pipelineActive: true,
			hasActiveSpeechActivity: false,
			clearCooldownTimer,
			pauseStt,
			scheduleResumeStt,
		});
		expect(clearCooldownTimer).toHaveBeenCalledTimes(1);
		expect(pauseStt).toHaveBeenCalledTimes(1);

		syncWebSttOnSpeakingChange({
			isSpeaking: false,
			pipelineActive: true,
			hasActiveSpeechActivity: false,
			clearCooldownTimer,
			pauseStt,
			scheduleResumeStt,
		});
		expect(scheduleResumeStt).toHaveBeenCalledWith(800);
	});

	it("maps legacy thinkingLevel low/high to on (true) in resolveWebThinkingEnabled while preserving desktop resolveThinkingLevel", () => {
		expect(resolveWebThinkingEnabled({ thinkingLevel: "off" })).toBe(false);
		expect(resolveWebThinkingEnabled({ thinkingLevel: "low" })).toBe(true);
		expect(resolveWebThinkingEnabled({ thinkingLevel: "high" })).toBe(true);
		expect(resolveWebThinkingEnabled({ enableThinking: true })).toBe(true);
		expect(resolveWebThinkingEnabled({ enableThinking: false })).toBe(false);

		expect(resolveThinkingLevel({ thinkingLevel: "off" })).toBe("off");
		expect(resolveThinkingLevel({ thinkingLevel: "low" })).toBe("low");
		expect(resolveThinkingLevel({ thinkingLevel: "high" })).toBe("high");
		expect(resolveThinkingLevel({ enableThinking: true })).toBe("low");
	});
});
