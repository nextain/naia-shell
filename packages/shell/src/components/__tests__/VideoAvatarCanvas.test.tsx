// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setWebAssetsModeForTests } from "../../lib/web-runtime/web-assets";
import { useCascadeAvatarStore } from "../../stores/cascade-avatar";
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
		mockInvoke.mockReset();
		mockGetAdkPath.mockReset();
		mockGetAdkPath.mockReturnValue("D:\\alpha-adk");
		mockInvoke.mockImplementation((command: string) =>
			command === "read_local_binary" ? Promise.resolve(manifest) : Promise.reject(new Error(command)),
		);
		mockToLocalBlobUrl.mockResolvedValue("blob:nva-asset");
		vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
		Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
	});
	afterEach(() => {
		setWebAssetsModeForTests(null);
		cleanup();
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
});
