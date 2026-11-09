import { describe, expect, it, vi } from "vitest";
import { checkWebGpu, type GpuLike, readNavigatorGpu } from "../webgpu-check";

describe("webgpu-check", () => {
	it("returns error if gpu is undefined", async () => {
		const res = await checkWebGpu(undefined);
		expect(res).toEqual({ ok: false, message: "navigator.gpu 없음" });
	});

	it("returns error if requestAdapter returns null", async () => {
		const gpu: GpuLike = {
			requestAdapter: vi.fn().mockResolvedValue(null),
		};
		const res = await checkWebGpu(gpu);
		expect(res).toEqual({ ok: false, message: "어댑터 없음" });
		expect(gpu.requestAdapter).toHaveBeenCalledWith({
			powerPreference: "high-performance",
		});
	});

	it("returns error if requestAdapter throws", async () => {
		const gpu: GpuLike = {
			requestAdapter: vi.fn().mockRejectedValue(new Error("GPU crash")),
		};
		const res = await checkWebGpu(gpu);
		expect(res).toEqual({ ok: false, message: "GPU crash" });
	});

	it("detects shader-f16 support and adapter info", async () => {
		const hasMock = vi.fn((feature: string) => feature === "shader-f16");
		const gpu: GpuLike = {
			requestAdapter: vi.fn().mockResolvedValue({
				features: { has: hasMock },
				info: {
					vendor: "nvidia",
					architecture: "ada-lovelace",
					description: "RTX 4060",
				},
			}),
		};
		const res = await checkWebGpu(gpu);
		expect(res).toEqual({
			ok: true,
			adapter: {
				vendor: "nvidia",
				architecture: "ada-lovelace",
				description: "RTX 4060",
			},
			shaderF16: true,
		});
	});

	it("handles missing shader-f16 and missing info gracefully", async () => {
		const gpu: GpuLike = {
			requestAdapter: vi.fn().mockResolvedValue({
				features: { has: () => false },
			}),
		};
		const res = await checkWebGpu(gpu);
		expect(res).toEqual({
			ok: true,
			adapter: {
				vendor: "",
				architecture: "",
				description: "",
			},
			shaderF16: false,
		});
	});

	it("readNavigatorGpu reads from global navigator", () => {
		const originalGpu = (navigator as { gpu?: unknown }).gpu;
		try {
			const mockGpu = { requestAdapter: vi.fn() };
			Object.defineProperty(navigator, "gpu", {
				value: mockGpu,
				configurable: true,
			});
			expect(readNavigatorGpu()).toBe(mockGpu);

			Object.defineProperty(navigator, "gpu", {
				value: undefined,
				configurable: true,
			});
			expect(readNavigatorGpu()).toBeUndefined();
		} finally {
			Object.defineProperty(navigator, "gpu", {
				value: originalGpu,
				configurable: true,
			});
		}
	});
});
