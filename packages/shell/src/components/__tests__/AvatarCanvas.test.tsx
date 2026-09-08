// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAvatarStore } from "../../stores/avatar";
import { AvatarCanvas } from "../AvatarCanvas";

const rendererFailure = vi.hoisted(() => ({
	mode: "constructor" as "constructor" | "pixel-ratio" | "none",
}));
const rendererDispose = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
	convertFileSrc: (path: string) => `asset://${path}`,
	invoke: vi.fn(() => Promise.resolve("")),
}));

vi.mock("three", async (importOriginal) => {
	const actual = await importOriginal<typeof import("three")>();

	class TestWebGLRenderer {
		domElement = document.createElement("canvas");

		constructor() {
			if (rendererFailure.mode === "constructor") {
				throw new Error("WebGL context unavailable");
			}
		}

		setPixelRatio() {
			if (rendererFailure.mode === "pixel-ratio") {
				throw new Error("WebGL pixel ratio setup failed");
			}
		}

		setSize() {}
		addEventListener() {}
		setAnimationLoop() {}
		render() {}
		dispose() {
			rendererDispose();
		}
	}

	return { ...actual, WebGLRenderer: TestWebGLRenderer };
});

describe("AvatarCanvas WebGL initialization", () => {
	beforeEach(() => {
		rendererFailure.mode = "constructor";
		rendererDispose.mockClear();
		useAvatarStore.getState().setModelPath("/assets/test-avatar.vrm");
	});

	afterEach(() => {
		cleanup();
		useAvatarStore.getState().setModelPath("");
	});

	it("shows the existing localized failure notice when context creation throws", () => {
		const { container } = render(<AvatarCanvas />);

		const root = container.firstElementChild;
		expect(root).toHaveAttribute("data-avatar-load-stage", "error:webgl");
		expect(root).toHaveAttribute(
			"data-avatar-load-error",
			expect.stringContaining("webgl: Error: WebGL context unavailable"),
		);
		const notice = container.querySelector(
			"[data-testid='avatar-empty-state']",
		);
		expect(notice).toBeInTheDocument();
		expect(notice).toHaveTextContent("webgl");
	});

	it("disposes a renderer when setup fails after construction", () => {
		rendererFailure.mode = "pixel-ratio";

		const { container } = render(<AvatarCanvas />);

		expect(container.firstElementChild).toHaveAttribute(
			"data-avatar-load-stage",
			"error:webgl",
		);
		expect(rendererDispose).toHaveBeenCalledTimes(1);
	});

	it("retries WebGL setup when the selected model changes", async () => {
		const { container } = render(<AvatarCanvas />);

		rendererFailure.mode = "pixel-ratio";
		await act(async () => {
			useAvatarStore.getState().setModelPath("/assets/retry-avatar.vrm");
		});

		await vi.waitFor(() => {
			expect(container.firstElementChild).toHaveAttribute(
				"data-avatar-model-path",
				"/assets/retry-avatar.vrm",
			);
			expect(container.firstElementChild).toHaveAttribute(
				"data-avatar-load-stage",
				"error:webgl",
			);
		});
		expect(rendererDispose).toHaveBeenCalledTimes(1);
	});
});
