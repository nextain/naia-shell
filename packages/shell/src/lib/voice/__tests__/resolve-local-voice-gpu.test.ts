import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
	isTransientLocalVoiceError,
	localVoiceHostArgs,
	resolveLocalVoiceGpu,
	resolveLocalVoiceHost,
} from "../local-runtime";

// Logger 도 invoke 를 쓰므로 해석 명령만 실패시킨다.
function failResolve() {
	invoke.mockImplementation(async (command: string) => {
		if (command === "resolve_voxcpm2_gpu") throw new Error("ipc down");
		return undefined;
	});
}

describe("resolveLocalVoiceHost", () => {
	beforeEach(() => invoke.mockReset());

	it("returns the card and the accelerator the backend decided together", async () => {
		invoke.mockResolvedValue({ accelerator: "cuda", gpuIndex: 1, profile: "linux_trt" });
		const host = await resolveLocalVoiceHost(null);
		expect(host).toEqual({ gpuIndex: 1, accelerator: "cuda", profile: "linux_trt" });
		expect(invoke).toHaveBeenCalledWith("resolve_voxcpm2_gpu", { gpuIndex: null });
		// 설치·상태·시작이 같은 판정을 넘겨받는다.
		expect(localVoiceHostArgs(host)).toEqual({ gpuIndex: 1, accelerator: "cuda" });
		await expect(resolveLocalVoiceGpu(null)).resolves.toBe(1);
	});

	it("resolves read-only: no record flag is ever sent", async () => {
		invoke.mockResolvedValue({ accelerator: "cuda", gpuIndex: 0 });
		await resolveLocalVoiceHost(null);
		expect(invoke).toHaveBeenLastCalledWith("resolve_voxcpm2_gpu", { gpuIndex: null });
	});

	it("accepts the legacy number answer without an accelerator", async () => {
		invoke.mockResolvedValue(2);
		const host = await resolveLocalVoiceHost(null);
		expect(host).toEqual({ gpuIndex: 2 });
		expect(localVoiceHostArgs(host)).toEqual({ gpuIndex: 2 });
	});

	it("aborts the flow on IPC failure, with or without an explicit card", async () => {
		failResolve();
		await expect(resolveLocalVoiceHost(null)).rejects.toThrow("ipc down");
		await expect(resolveLocalVoiceHost(2)).rejects.toThrow("ipc down");
	});

	it("recognizes the transient marker", () => {
		expect(
			isTransientLocalVoiceError(new Error("voxcpm2_gpu_unresolved: query failed")),
		).toBe(true);
		expect(isTransientLocalVoiceError("voxcpm2_gpu_unresolved: x")).toBe(true);
		expect(isTransientLocalVoiceError(new Error("boom"))).toBe(false);
	});
});
