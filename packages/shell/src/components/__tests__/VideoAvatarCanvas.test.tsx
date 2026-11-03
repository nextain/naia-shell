// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setWebAssetsModeForTests } from "../../lib/web-runtime/web-assets";
import { useCascadeAvatarStore } from "../../stores/cascade-avatar";
import {
	clearCameraActions,
	getCameraActions,
} from "../../lib/avatar/camera-actions";
import {
	getUiPreferencesSnapshot,
	resetUiPreferencesForTests,
	UI_PREFERENCE_KEYS,
} from "../../lib/ui-preferences";
import { VideoAvatarCanvas } from "../VideoAvatarCanvas";

const mockInvoke = vi.hoisted(() => vi.fn());
const mockGetAdkPath = vi.hoisted(() => vi.fn(() => "D:\\alpha-adk"));
const mockToLocalBlobUrl = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }));
vi.mock("../../lib/adk-store", () => ({
	getAdkPath: () => mockGetAdkPath(),
	toLocalBlobUrl: (...args: unknown[]) => mockToLocalBlobUrl(...args),
}));
const manifest = btoa(JSON.stringify({
	nva_version: "0.2",
	canvas: { width: 406, height: 720 },
	animations: { idle: { clip: "clips/body.webm", loop: true, can_talk: false } },
	vrm_slots: {
		profile: { generation_mode: "prebaked_webm_only", default_locale: "ko-KR" },
		visemes: { aiueo: { clip: "clips/viseme-aiueo.webm" } },
		speech: {},
	},
}));
const gestureManifest = btoa(JSON.stringify({
	nva_version: "0.2",
	canvas: { width: 406, height: 720 },
	animations: {
		idle: { clip: "clips/body.webm", loop: true, can_talk: false },
		wave: { clip: "clips/wave.webm", loop: false, can_talk: false, label: "Wave" },
	},
	vrm_slots: {
		profile: { generation_mode: "prebaked_webm_only", default_locale: "ko-KR" },
		visemes: { aiueo: { clip: "clips/viseme-aiueo.webm" } },
		speech: {},
	},
}));
let activeManifest = manifest;

const webManifestJson = JSON.stringify({
	nva_version: "0.2",
	canvas: { width: 720, height: 1280 },
	animations: {
		idle: { clip: "clips/idle.webm", loop: true, can_talk: false },
		talking: { clip: "clips/talking-ko.webm", loop: true, can_talk: true },
	},
	stacked_alpha: {
		layout: "color-top-alpha-bottom",
		clips: {
			"clips/idle.webm": "clips/idle.stacked.mp4",
			"clips/talking-ko.webm": "clips/talking-ko.stacked.mp4",
		},
	},
});

describe("VideoAvatarCanvas pre-baked contract", () => {
	beforeEach(() => {
		activeManifest = manifest;
		mockInvoke.mockReset();
		mockGetAdkPath.mockReset();
		mockGetAdkPath.mockReturnValue("D:\\alpha-adk");
		mockInvoke.mockImplementation((command: string) =>
			command === "read_local_binary" ? Promise.resolve(activeManifest) : Promise.reject(new Error(command)),
		);
		mockToLocalBlobUrl.mockResolvedValue("blob:nva-asset");
		vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
		Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
	});
	afterEach(() => {
		setWebAssetsModeForTests(null);
		cleanup();
		clearCameraActions();
		resetUiPreferencesForTests();
		vi.restoreAllMocks();
		useCascadeAvatarStore.getState().setRenderer(null);
	});

	it("loads WebM slots without probing or starting cascade", async () => {
		const { container } = render(<VideoAvatarCanvas nvaModel="naia" />);
		await vi.waitFor(() => expect(container.querySelector("[data-video-avatar]")).toHaveAttribute("data-video-avatar-mode", "prebaked"));
		expect(container.querySelector("[data-video-avatar-prebaked]")).toBeTruthy();
		expect(mockInvoke).not.toHaveBeenCalledWith("start_voxcpm2", expect.anything());
		expect(useCascadeAvatarStore.getState().renderer).toBeTruthy();
	});

	it("works without a detected GPU because no GPU probe is made", async () => {
		const { container } = render(<VideoAvatarCanvas nvaModel="naia" />);
		await vi.waitFor(() => expect(container.querySelector("[data-video-avatar]")).toHaveAttribute("data-video-avatar-loaded", "true"));
		expect(new Set(mockInvoke.mock.calls.map(([command]) => command))).toEqual(new Set(["read_local_binary"]));
	});

	it("clamps, saves, and resets zoom together with pan", async () => {
		const { container } = render(<VideoAvatarCanvas nvaModel="naia" />);
		await vi.waitFor(() => expect(container.querySelector("[data-video-avatar]")).toHaveAttribute("data-video-avatar-loaded", "true"));
		const canvas = container.querySelector("[data-video-avatar-prebaked]") as HTMLCanvasElement;
		expect(canvas.style.transform).toContain("scale(1)");

		act(() => {
			getCameraActions().zoom(9);
			getCameraActions().pan(12, -8);
			getCameraActions().save();
		});
		expect(canvas.style.transform).toContain("translate(");
		expect(canvas.style.transform).toContain("12px");
		expect(canvas.style.transform).toContain("-8px");
		expect(canvas.style.transform).toContain("scale(3)");
		expect(getUiPreferencesSnapshot()[UI_PREFERENCE_KEYS.nvaZoom]).toBe(3);
		expect(getUiPreferencesSnapshot()[UI_PREFERENCE_KEYS.nvaPan]).toEqual({ x: 12, y: -8 });

		act(() => getCameraActions().zoom(-20));
		expect(canvas.style.transform).toContain("scale(0.5)");
		act(() => getCameraActions().reset());
		expect(canvas.style.transform).toContain("scale(1)");
		expect(canvas.style.transform).toContain("0px");
		expect(getUiPreferencesSnapshot()[UI_PREFERENCE_KEYS.nvaZoom]).toBeUndefined();
		expect(getUiPreferencesSnapshot()[UI_PREFERENCE_KEYS.nvaPan]).toBeUndefined();
	});

	it("uses a non-passive wheel handler and exposes only manifest gestures", async () => {
		activeManifest = gestureManifest;
		const addListener = vi.spyOn(HTMLElement.prototype, "addEventListener");
		const { container } = render(<VideoAvatarCanvas nvaModel="naia" />);
		await vi.waitFor(() => expect(container.querySelector("[data-video-avatar]")).toHaveAttribute("data-video-avatar-loaded", "true"));
		expect(addListener.mock.calls.some(([type, , options]) =>
			type === "wheel" && typeof options === "object" && options?.passive === false,
		)).toBe(true);
		const area = container.querySelector("[data-video-avatar]") as HTMLElement;
		act(() => fireEvent.wheel(area, { deltaY: -120, cancelable: true }));
		expect(container.querySelector("[data-video-avatar-prebaked]")?.getAttribute("style"))
			.toContain("scale(1.1)");
		expect(getCameraActions().getGestureActions()).toEqual([{ key: "wave", label: "Wave" }]);
		await expect(getCameraActions().playAction("missing")).resolves.toBe(false);
		await expect(getCameraActions().playAction("wave")).resolves.toBe(true);
	});

	it("fetches /nva/<bundle>/manifest.json without invoke or getAdkPath in web mode and resolves .webm on Chrome UA", async () => {
		setWebAssetsModeForTests(true);
		mockGetAdkPath.mockReturnValue(null as unknown as string);
		vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
		);
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(webManifestJson, { status: 200 }));

		const { container } = render(<VideoAvatarCanvas nvaModel="naia" />);
		await vi.waitFor(() =>
			expect(container.querySelector("[data-video-avatar]")).toHaveAttribute(
				"data-video-avatar-mode",
				"prebaked",
			),
		);
		await vi.waitFor(() => {
			const video = container.querySelector("video");
			expect(video?.dataset.naiaClipUrl).toBe("/nva/naia/clips/idle.webm");
		});
		expect(fetchSpy).toHaveBeenCalledWith("/nva/naia/manifest.json");
		expect(mockInvoke).not.toHaveBeenCalled();
		expect(mockGetAdkPath).not.toHaveBeenCalled();
	});

	it("resolves .stacked.mp4 clip URL on WebKit/Safari UA in web mode without calling invoke", async () => {
		setWebAssetsModeForTests(true);
		mockGetAdkPath.mockReturnValue(null as unknown as string);
		vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
		);
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(webManifestJson, { status: 200 }));

		const { container } = render(<VideoAvatarCanvas nvaModel="naia" />);
		await vi.waitFor(() =>
			expect(container.querySelector("[data-video-avatar]")).toHaveAttribute(
				"data-video-avatar-mode",
				"prebaked",
			),
		);
		await vi.waitFor(() => {
			const video = container.querySelector("video");
			expect(video?.dataset.naiaClipUrl).toBe(
				"/nva/naia/clips/idle.stacked.mp4",
			);
		});
		expect(fetchSpy).toHaveBeenCalledWith("/nva/naia/manifest.json");
		expect(mockInvoke).not.toHaveBeenCalled();
	});

	it("rejects invalid bundle names in web mode without calling fetch or invoke", async () => {
		setWebAssetsModeForTests(true);
		mockGetAdkPath.mockReturnValue(null as unknown as string);
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(webManifestJson, { status: 200 }));

		for (const badModel of ["", "Naia", "../etc", "naia/Bad_Name", "naia$"]) {
			cleanup();
			useCascadeAvatarStore.getState().setRenderer(null);
			useCascadeAvatarStore.getState().setNvaLoadError(null);
			const { container } = render(<VideoAvatarCanvas nvaModel={badModel} />);
			await vi.waitFor(() =>
				expect(container.querySelector("[data-video-avatar]")).toHaveAttribute(
					"data-video-avatar-mode",
					"error",
				),
			);
			expect(
				container.querySelector("output[data-video-avatar-status='error']"),
			).toBeTruthy();
			expect(
				container.querySelector("video")?.dataset.naiaClipUrl,
			).toBeUndefined();
			expect(useCascadeAvatarStore.getState().renderer).toBeNull();
			expect(useCascadeAvatarStore.getState().nvaLoadError).toBe(
				badModel === "" ? "missing-nva-model" : "invalid-nva-model",
			);
		}
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(mockInvoke).not.toHaveBeenCalled();
	});

	it("enters error state in web mode when manifest fetch returns 404 without calling invoke or passing clips to renderer", async () => {
		setWebAssetsModeForTests(true);
		mockGetAdkPath.mockReturnValue(null as unknown as string);
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("Not Found", { status: 404 }));

		const { container } = render(<VideoAvatarCanvas nvaModel="naia" />);
		await vi.waitFor(() =>
			expect(container.querySelector("[data-video-avatar]")).toHaveAttribute(
				"data-video-avatar-mode",
				"error",
			),
		);
		expect(fetchSpy).toHaveBeenCalledWith("/nva/naia/manifest.json");
		expect(mockInvoke).not.toHaveBeenCalled();
		expect(
			container.querySelector("output[data-video-avatar-status='error']"),
		).toBeTruthy();
		expect(
			container.querySelector("video")?.dataset.naiaClipUrl,
		).toBeUndefined();
		expect(useCascadeAvatarStore.getState().renderer).toBeNull();
		expect(useCascadeAvatarStore.getState().nvaLoadError).toContain("HTTP 404");
	});

	it("enters error state in web mode when manifest JSON is malformed or missing required fields without calling invoke", async () => {
		setWebAssetsModeForTests(true);
		mockGetAdkPath.mockReturnValue(null as unknown as string);
		const invalidPayloads = [
			"{not-valid-json",
			JSON.stringify({ nva_version: "0.2" }),
		];

		for (const payload of invalidPayloads) {
			cleanup();
			useCascadeAvatarStore.getState().setRenderer(null);
			useCascadeAvatarStore.getState().setNvaLoadError(null);
			vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
				new Response(payload, { status: 200 }),
			);

			const { container } = render(<VideoAvatarCanvas nvaModel="naia" />);
			await vi.waitFor(() =>
				expect(container.querySelector("[data-video-avatar]")).toHaveAttribute(
					"data-video-avatar-mode",
					"error",
				),
			);
			expect(
				container.querySelector("output[data-video-avatar-status='error']"),
			).toBeTruthy();
			expect(
				container.querySelector("video")?.dataset.naiaClipUrl,
			).toBeUndefined();
			expect(useCascadeAvatarStore.getState().renderer).toBeNull();
			expect(useCascadeAvatarStore.getState().nvaLoadError).toBeTruthy();
		}
		expect(mockInvoke).not.toHaveBeenCalled();
	});

	it("rejects manifest clip relative paths containing '..' in web mode without calling invoke or passing clips to renderer", async () => {
		setWebAssetsModeForTests(true);
		mockGetAdkPath.mockReturnValue(null as unknown as string);
		const traversalManifest = JSON.stringify({
			nva_version: "0.2",
			canvas: { width: 720, height: 1280 },
			animations: {
				idle: {
					clip: "clips/../../secret.webm",
					loop: true,
					can_talk: false,
				},
			},
		});
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(traversalManifest, { status: 200 }),
		);

		const { container } = render(<VideoAvatarCanvas nvaModel="naia" />);
		await vi.waitFor(() =>
			expect(container.querySelector("[data-video-avatar]")).toHaveAttribute(
				"data-video-avatar-mode",
				"error",
			),
		);
		expect(mockInvoke).not.toHaveBeenCalled();
		expect(
			container.querySelector("output[data-video-avatar-status='error']"),
		).toBeTruthy();
		expect(
			container.querySelector("video")?.dataset.naiaClipUrl,
		).toBeUndefined();
		expect(useCascadeAvatarStore.getState().renderer).toBeNull();
		expect(useCascadeAvatarStore.getState().nvaLoadError).toContain(
			"Invalid NVA asset path",
		);
	});

	it("rejects manifest speech clip paths containing '..' across speech_clips, prebaked_speech, and vrm_slots.speech (default and by_locale) in web mode without calling invoke or registering renderer", async () => {
		setWebAssetsModeForTests(true);
		mockGetAdkPath.mockReturnValue(null as unknown as string);
		const speechTraversalManifests = [
			{
				speech_clips: {
					"speech-ko": { clip: "clips/../../escape-speech-clips.webm", text: "안녕" },
				},
			},
			{
				speech_clips: {
					"speech-ko": {
						clip: "clips/talking-ko.webm",
						by_locale: { "en-US": { clip: "../escape-speech-clips-locale.webm" } },
					},
				},
			},
			{
				prebaked_speech: {
					utterances: {
						hello: { clip: "clips/../escape-prebaked.webm", text: "안녕" },
					},
				},
			},
			{
				prebaked_speech: {
					utterances: {
						hello: {
							clip: "clips/talking-ko.webm",
							by_locale: { "ko-KR": { clip: "clips/../../escape-prebaked-locale.webm" } },
						},
					},
				},
			},
			{
				vrm_slots: {
					speech: {
						hello: { clip: "../escape-vrm-speech.webm", text: "안녕" },
					},
				},
			},
			{
				vrm_slots: {
					speech: {
						hello: {
							clip: "clips/talking-ko.webm",
							by_locale: { "ko-KR": { clip: "clips/../../escape-vrm-speech-locale.webm" } },
						},
					},
				},
			},
		];

		for (const extra of speechTraversalManifests) {
			cleanup();
			useCascadeAvatarStore.getState().setRenderer(null);
			useCascadeAvatarStore.getState().setNvaLoadError(null);
			const payload = JSON.stringify({
				nva_version: "0.2",
				canvas: { width: 720, height: 1280 },
				animations: {
					idle: { clip: "clips/idle.webm", loop: true, can_talk: false },
				},
				...extra,
			});
			vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
				new Response(payload, { status: 200 }),
			);

			const { container } = render(<VideoAvatarCanvas nvaModel="naia" />);
			await vi.waitFor(() =>
				expect(container.querySelector("[data-video-avatar]")).toHaveAttribute(
					"data-video-avatar-mode",
					"error",
				),
			);
			expect(
				container.querySelector("output[data-video-avatar-status='error']"),
			).toBeTruthy();
			expect(
				container.querySelector("video")?.dataset.naiaClipUrl,
			).toBeUndefined();
			expect(useCascadeAvatarStore.getState().renderer).toBeNull();
			expect(useCascadeAvatarStore.getState().nvaLoadError).toContain(
				"Invalid NVA asset path",
			);
		}
		expect(mockInvoke).not.toHaveBeenCalled();
	});
});
