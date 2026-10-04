// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCascadeAvatarStore } from "../../stores/cascade-avatar";
import { calculateAvatarLayout } from "../AppMainContent";
import { VideoAvatarCanvas, videoTransform } from "../VideoAvatarCanvas";

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

	it("uses pan-only transform in app mode without 50vw offset", () => {
		const transform = videoTransform({ x: 12, y: -8 }, "app");
		expect(transform).toBe("translate(12px, -8px)");
		expect(transform).not.toContain("50vw");
	});

	it("uses --naia-chat-reserve as bottom offset for outer container in app mode", () => {
		const { container } = render(<VideoAvatarCanvas nvaModel="naia" layout="app" />);
		const outer = container.querySelector("[data-video-avatar]") as HTMLElement;
		expect(outer).toBeTruthy();
		expect(outer.style.position).toBe("absolute");
		expect(outer.style.left).toBe("0px");
		expect(outer.style.width).toBe("var(--naia-width, 320px)");
		expect(outer.style.top).toBe("var(--naia-avatar-top, 48px)");
		expect(outer.style.bottom).toBe("var(--naia-chat-reserve, 0px)");
		expect(outer.style.placeItems).toBe("end center");
	});

	it("preserves origin/main style and transform in workspace mode", () => {
		const transform = videoTransform({ x: 12, y: -8 }, "workspace");
		expect(transform).toBe(
			"translate(calc(var(--naia-width, 320px) / 2 - 50vw + 12px), -8px)",
		);
		const { container } = render(
			<VideoAvatarCanvas nvaModel="naia" layout="workspace" />,
		);
		const outer = container.querySelector("[data-video-avatar]") as HTMLElement;
		expect(outer).toBeTruthy();
		expect(outer.style.position).toBe("relative");
		expect(outer.style.width).toBe("100%");
		expect(outer.style.height).toBe("100%");
		expect(outer.style.placeItems).toBe("center");
	});
});

describe("calculateAvatarLayout distance and reserve calculation", () => {
	it("calculates chat reserve when chat is visible", () => {
		const result = calculateAvatarLayout({
			uiMode: "app",
			layerRect: { top: 32, bottom: 900 },
			chatRect: { top: 522, bottom: 900 },
			aiBarRect: { top: 36, bottom: 68 },
		});
		expect(result.chatReserve).toBe(378);
		expect(result.avatarTop).toBe(48);
		expect(result.isSpaceInsufficient).toBe(false);
	});

	it("calculates chat reserve when chat is collapsed", () => {
		const result = calculateAvatarLayout({
			uiMode: "app",
			layerRect: { top: 32, bottom: 900 },
			chatRect: { top: 882, bottom: 900 },
			aiBarRect: { top: 36, bottom: 68 },
		});
		expect(result.chatReserve).toBe(18);
		expect(result.isSpaceInsufficient).toBe(false);
	});

	it("returns null reserve in workspace mode", () => {
		const result = calculateAvatarLayout({
			uiMode: "workspace",
			layerRect: { top: 32, bottom: 900 },
			chatRect: { top: 522, bottom: 900 },
			aiBarRect: { top: 36, bottom: 68 },
		});
		expect(result.chatReserve).toBeNull();
		expect(result.isSpaceInsufficient).toBe(false);
	});

	it("flags insufficient space when height between aiBar and chat is less than 80px", () => {
		const result = calculateAvatarLayout({
			uiMode: "app",
			layerRect: { top: 32, bottom: 600 },
			chatRect: { top: 120, bottom: 600 },
			aiBarRect: { top: 36, bottom: 68 },
		});
		expect(result.isSpaceInsufficient).toBe(true);
	});
});
