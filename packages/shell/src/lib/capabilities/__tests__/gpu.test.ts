import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { detectGpuVramGb, parseVramResult } from "../gpu";

describe("detectGpuVramGb", () => {
	it("asks for the flow's card when an index is given, the first card otherwise", async () => {
		invoke.mockResolvedValue(24);
		await expect(detectGpuVramGb(1)).resolves.toBe(24);
		expect(invoke).toHaveBeenCalledWith("detect_gpu_vram", { gpuIndex: 1 });
		invoke.mockClear();
		await detectGpuVramGb();
		expect(invoke).toHaveBeenCalledWith("detect_gpu_vram");
	});
});

describe("parseVramResult", () => {
	it("accepts a positive finite number", () => {
		expect(parseVramResult(12)).toBe(12);
		expect(parseVramResult(24)).toBe(24);
	});

	it("rejects null / non-number / non-positive / non-finite → null", () => {
		expect(parseVramResult(null)).toBeNull();
		expect(parseVramResult(undefined)).toBeNull();
		expect(parseVramResult("12")).toBeNull();
		expect(parseVramResult(0)).toBeNull();
		expect(parseVramResult(-8)).toBeNull();
		expect(parseVramResult(Number.NaN)).toBeNull();
		expect(parseVramResult(Number.POSITIVE_INFINITY)).toBeNull();
	});
});
