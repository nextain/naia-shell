// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCascadeAvatarStore } from "../../stores/cascade-avatar";
import {
	presentationAvatarTransform,
	VideoAvatarCanvas,
} from "../VideoAvatarCanvas";

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
	animations: {
		idle: { clip: "clips/body.webm", loop: true, can_talk: false },
		speak: {
			clip: "clips/speak.webm",
			loop: true,
			can_talk: true,
			face_bbox: [0.25, 0.08, 0.5, 0.34],
		},
	},
	vrm_slots: {
		profile: { generation_mode: "prebaked_webm_only", default_locale: "ko-KR" },
		visemes: { aiueo: { clip: "clips/viseme-aiueo.webm" } },
		speech: {},
	},
}));

describe("VideoAvatarCanvas pre-baked contract", () => {
	beforeEach(() => {
		mockInvoke.mockImplementation((command: string) =>
			command === "read_local_binary" ? Promise.resolve(manifest) : Promise.reject(new Error(command)),
		);
		mockToLocalBlobUrl.mockResolvedValue("blob:nva-asset");
		vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
		Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
	});
	afterEach(() => { cleanup(); vi.restoreAllMocks(); useCascadeAvatarStore.getState().setRenderer(null); });

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

	it("uses the manifest face box for a presentation-only crop", async () => {
		const crop = presentationAvatarTransform(
			JSON.parse(atob(manifest)),
			140,
			333,
		);
		expect(crop.width / crop.height).toBeCloseTo(406 / 720);
		expect(crop.width).toBeLessThanOrEqual(140);
		expect(crop.height).toBeLessThanOrEqual(333);
		expect(crop.zoom).toBeGreaterThan(1);

		const { container } = render(
			<VideoAvatarCanvas nvaModel="naia" presentationMode />,
		);
		await vi.waitFor(() =>
			expect(container.querySelector("[data-video-avatar-loaded='true']")).toBeTruthy(),
		);
		const canvas = container.querySelector(
			"canvas[data-presentation-crop='face']",
		) as HTMLCanvasElement;
		expect(canvas.style.transformOrigin).toBe("50% 25%");
		expect(canvas.style.transform).toContain("scale(");
		expect(Number.parseFloat(canvas.style.width)).toBeGreaterThan(0);
		expect(Number.parseFloat(canvas.style.height)).toBeGreaterThan(0);
	});

	it("a legacy bundle's visemes.aiueo slot is never played, even while speaking (SoT 8)", async () => {
		const { container } = render(<VideoAvatarCanvas nvaModel="naia" />);
		await vi.waitFor(() => expect(container.querySelector("[data-video-avatar]")).toHaveAttribute("data-video-avatar-loaded", "true"));
		useCascadeAvatarStore.getState().renderer?.setSpeakingVisual(true);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const requested = mockToLocalBlobUrl.mock.calls.map(([path]) => String(path));
		expect(requested.some((path) => path.includes("viseme-aiueo"))).toBe(false);
		useCascadeAvatarStore.getState().renderer?.setSpeakingVisual(false);
	});
});
