import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { resolveLocalVoiceGpu } from "../local-runtime";

// Logger 도 invoke 를 쓰므로 해석 명령만 실패시킨다.
function failResolve() {
	invoke.mockImplementation(async (command: string) => {
		if (command === "resolve_voxcpm2_gpu") throw new Error("ipc down");
		return undefined;
	});
}

describe("resolveLocalVoiceGpu", () => {
	beforeEach(() => invoke.mockReset());

	it("returns the concrete number the backend resolved", async () => {
		invoke.mockResolvedValue(1);
		await expect(resolveLocalVoiceGpu(null)).resolves.toBe(1);
		expect(invoke).toHaveBeenCalledWith("resolve_voxcpm2_gpu", { gpuIndex: null });
	});

	it("aborts the flow when automatic cannot be resolved (IPC failure)", async () => {
		failResolve();
		await expect(resolveLocalVoiceGpu(null)).rejects.toThrow("ipc down");
	});

	it("keeps going with the explicit choice when IPC fails", async () => {
		failResolve();
		await expect(resolveLocalVoiceGpu(2)).resolves.toBe(2);
	});

	it("strict mode (out-of-flow status check) throws even with an explicit choice", async () => {
		failResolve();
		await expect(resolveLocalVoiceGpu(2, { strict: true })).rejects.toThrow("ipc down");
	});
});
