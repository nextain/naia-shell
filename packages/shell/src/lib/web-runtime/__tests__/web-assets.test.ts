import { setLocale } from "../../i18n";
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
	isLegacyWebNaiaSelection,
	isWebBundledAssetUrl,
	isWebMode,
	mobileWebLayout,
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

	it("exposes 10 background entries in catalog order with Korean labels and image/video kinds", () => {
		expect(WEB_BACKGROUND_ASSETS).toHaveLength(10);
		expect(WEB_BACKGROUND_ASSETS.map((asset) => asset.filename)).toEqual([
			"naia-dawn-city-uhd.webp",
			"naia-jina-minho-war-room-uhd.webp",
			"naia-sunrise-river.webp",
			"naia-rainy-studio.webp",
			"naia-autumn-office.webp",
			"naia-starlight-lake.webp",
			"naia-sky-garden.webp",
			"naia-autumn-office-live.mp4",
			"naia-starlight-lake-live.mp4",
			"naia-rainy-studio-live.mp4",
		]);
		expect(WEB_BACKGROUND_ASSETS.map((asset) => asset.label)).toEqual([
			"새벽 도시",
			"작전실 — 나이아·지나·민호",
			"강변 해돋이",
			"비 오는 작업실",
			"가을 사무실",
			"별빛 호수",
			"하늘 정원",
			"가을 사무실 (움직임)",
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
			"image",
			"video",
			"video",
			"video",
		]);
		for (const asset of WEB_BACKGROUND_ASSETS) {
			expect(asset.url).toBe(`/backgrounds/${asset.filename}`);
		}
	});

	it("exposes 5 NVA bundle names with naia as default", () => {
		expect(WEB_NVA_ASSETS).toEqual([
			"naia",
			"jina",
			"jina-anime",
			"minho",
			"minho-anime",
		]);
		expect(WEB_DEFAULT_NVA).toBe("naia");
	});

	it("maps saved naia-anime nvaModel to naia when reading config", () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				avatarProvider: "naia-video-avatar",
				nvaModel: "naia-anime",
			}),
		);
		expect(loadConfig()?.nvaModel).toBe("naia");
	});

	it("maps legacy Naia VRMs to Naia NVA without changing other selections", () => {
		for (const model of ["Naia.vrm", "Naia-Base.vrm", "Naia-Hair.vrm"]) {
			expect(
				isLegacyWebNaiaSelection({
					avatarProvider: "vrm",
					vrmModel: `/avatars/${model}`,
				}),
			).toBe(true);
		}
		expect(
			isLegacyWebNaiaSelection({
				avatarProvider: "vrm",
				vrmModel: "/avatars/03-OL_Woman.vrm",
			}),
		).toBe(false);
		expect(
			isLegacyWebNaiaSelection({
				avatarProvider: "naia-video-avatar",
				vrmModel: "Naia.vrm",
			}),
		).toBe(false);
	});

	it("defaults to the animated autumn office", () => {
		expect(WEB_DEFAULT_VRM).toBe(WEB_VRM_ASSETS[0].url);
		expect(WEB_DEFAULT_BACKGROUND).toBe("naia-autumn-office-live.mp4");
		expect(
			WEB_BACKGROUND_ASSETS.find(
				(asset) => asset.filename === WEB_DEFAULT_BACKGROUND,
			)?.kind,
		).toBe("video");
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

beforeEach(async () => { await setLocale("ko"); });


describe("web phone layout", () => {
 it("recognizes phones including desktop-site mode and excludes PCs and landscape tablets", () => {
  expect(mobileWebLayout(true, 412, 892, true, 412)).toEqual({ mobile: true, zoom: 1 });
  expect(mobileWebLayout(true, 412, 892, true, 980)).toEqual({ mobile: true, zoom: 980 / 412 });
  expect(mobileWebLayout(false, 1920, 1080, false, 1920)).toEqual({ mobile: false, zoom: 1 });
  expect(mobileWebLayout(true, 1024, 768, false, 1024)).toEqual({ mobile: false, zoom: 1 });
 });
 it("updates and removes root attributes and zoom on resize and mode changes", () => {
  const width = vi.spyOn(screen, "width", "get").mockReturnValue(412);
  const height = vi.spyOn(screen, "height", "get").mockReturnValue(892);
  const viewport = vi.spyOn(window, "innerWidth", "get").mockReturnValue(980);
  const viewportHeight = vi.spyOn(window, "innerHeight", "get").mockReturnValue(2120);
  const match = vi.fn().mockImplementation((query) => ({ matches: query.includes("coarse") || query.includes("portrait") }) as MediaQueryList);
  vi.stubGlobal("matchMedia", match);
  setWebAssetsModeForTests(true);
  expect(document.documentElement.dataset.naiaMobile).toBe("true");
  expect(Number(document.documentElement.style.zoom)).toBeCloseTo(980 / 412);
  expect(parseFloat(document.documentElement.style.getPropertyValue("--naia-vh"))).toBeCloseTo(2120 / (980 / 412) / 100);
  expect(parseFloat(document.documentElement.style.getPropertyValue("--naia-vw"))).toBeCloseTo(4.12);
  viewportHeight.mockReturnValue(1800);
  window.dispatchEvent(new Event("resize"));
  expect(parseFloat(document.documentElement.style.getPropertyValue("--naia-vh"))).toBeCloseTo(1800 / (980 / 412) / 100);
  height.mockReturnValue(412); width.mockReturnValue(892);
  match.mockImplementation(() => ({ matches: false }) as MediaQueryList);
  window.dispatchEvent(new Event("orientationchange"));
  expect(document.documentElement.dataset.naiaMobile).toBeUndefined();
  expect(document.documentElement.style.zoom).toBe("");
  expect(document.documentElement.style.getPropertyValue("--naia-vh")).toBe("");
  expect(document.documentElement.style.getPropertyValue("--naia-vw")).toBe("");
  width.mockRestore(); height.mockRestore(); viewport.mockRestore(); viewportHeight.mockRestore(); vi.unstubAllGlobals();
 });
});
