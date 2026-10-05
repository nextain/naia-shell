// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { recoverLocalVoiceToken } from "../local-runtime";

describe("recoverLocalVoiceToken", () => {
	beforeEach(() => invoke.mockReset());

	it("re-attaches to the running engine without recording a card choice", async () => {
		invoke.mockImplementation(async (command: string) => {
			if (command === "resolve_voxcpm2_gpu")
				return { accelerator: "cuda", gpuIndex: 0, profile: "linux_trt" };
			if (command === "start_voxcpm2") return "CASCADE_READY {}";
			return undefined;
		});
		await recoverLocalVoiceToken({ force: true });
		const resolveCall = invoke.mock.calls.find(([c]) => c === "resolve_voxcpm2_gpu");
		expect(resolveCall?.[1]).toEqual({ gpuIndex: null });
		expect(resolveCall?.[1]).not.toHaveProperty("record");
		expect(invoke).toHaveBeenCalledWith(
			"start_voxcpm2",
			expect.objectContaining({ gpuIndex: 0, accelerator: "cuda" }),
		);
	});
});
