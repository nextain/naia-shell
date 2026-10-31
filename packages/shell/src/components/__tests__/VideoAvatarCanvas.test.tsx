// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const mockToLocalBlobUrl = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }));
vi.mock("../../lib/adk-store", () => ({
	getAdkPath: () => "D:\\alpha-adk",
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

describe("VideoAvatarCanvas pre-baked contract", () => {
	beforeEach(() => {
		activeManifest = manifest;
		mockInvoke.mockImplementation((command: string) =>
			command === "read_local_binary" ? Promise.resolve(activeManifest) : Promise.reject(new Error(command)),
		);
		mockToLocalBlobUrl.mockResolvedValue("blob:nva-asset");
		vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
		Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
	});
	afterEach(() => {
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
});
