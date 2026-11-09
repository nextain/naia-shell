import { beforeEach, describe, expect, it, vi } from "vitest";
import { startWebModel } from "../model-start";
import {
	getWebModelStatus,
	resetWebModelStatusForTests,
} from "../web-model-status";
import {
	WEB_LLM_FALLBACK_F32,
	WEB_LLM_MODEL_ID,
	WEB_LLM_MODEL_PREF_KEY,
} from "../webllm-model";
import { Logger } from "../../logger";

describe("model-start", () => {
	beforeEach(() => {
		resetWebModelStatusForTests();
		vi.restoreAllMocks();
	});

	it("starts without pre-checks when engineKind is fake", async () => {
		const bridge = { start: vi.fn() };
		await startWebModel({
			gpu: undefined,
			storage: null,
			engineKind: "fake",
			bridge,
		});

		expect(bridge.start).toHaveBeenCalledWith({ model: WEB_LLM_MODEL_ID });
		expect(getWebModelStatus().phase).toBe("loading");
	});

	it("sets no-webgpu error and starts with model null when gpu is undefined", async () => {
		const bridge = { start: vi.fn() };
		await startWebModel({
			gpu: undefined,
			storage: null,
			engineKind: undefined,
			bridge,
		});

		expect(bridge.start).toHaveBeenCalledWith({ model: null });
		const status = getWebModelStatus();
		expect(status.phase).toBe("error");
		expect(status.errorKind).toBe("no-webgpu");
	});

	it("WO13C-S4 auto-f32", async () => {
		const bridge = { start: vi.fn() };
		const gpu = {
			requestAdapter: vi.fn().mockResolvedValue({
				features: { has: () => false },
				info: { vendor: "vendor-x", architecture: "arch-y", description: "" },
			}),
		};
		const setItemSpy = vi.fn();
		const storage = {
			getItem: vi.fn(() => null),
			setItem: setItemSpy,
		};

		await startWebModel({
			gpu,
			storage,
			engineKind: undefined,
			bridge,
		});

		expect(bridge.start).toHaveBeenCalledTimes(1);
		expect(bridge.start).toHaveBeenCalledWith({ model: "Qwen3-4B-q4f32_1-MLC" });
		const status = getWebModelStatus();
		expect(status.phase).toBe("loading");
		expect(status.model).toBe("Qwen3-4B-q4f32_1-MLC");
		expect(status.errorKind).toBeUndefined();
		expect(setItemSpy).not.toHaveBeenCalled();
	});

	it("WO13C-S5 explicit-f16-error", async () => {
		const gpu = {
			requestAdapter: vi.fn().mockResolvedValue({
				features: { has: () => false },
				info: { vendor: "vendor-x", architecture: "arch-y", description: "" },
			}),
		};

		// 1. 저장값이 f16 인 경우
		{
			const bridge = { start: vi.fn() };
			const storage = {
				getItem: vi.fn((key: string) => {
					if (key === WEB_LLM_MODEL_PREF_KEY) return WEB_LLM_MODEL_ID;
					return null;
				}),
			};

			await startWebModel({
				gpu,
				storage,
				engineKind: undefined,
				bridge,
			});

			expect(bridge.start).toHaveBeenCalledWith({ model: null });
			const status = getWebModelStatus();
			expect(status.phase).toBe("error");
			expect(status.errorKind).toBe("no-shader-f16");
			expect(status.shaderF16).toBe(false);
			expect(status.adapter?.vendor).toBe("vendor-x");
		}

		// 2. 빌드 지정값이 f16 일 때 (별도 경우)
		{
			resetWebModelStatusForTests();
			const bridge = { start: vi.fn() };

			await startWebModel({
				gpu,
				storage: null,
				engineKind: undefined,
				buildModel: WEB_LLM_MODEL_ID,
				bridge,
			});

			expect(bridge.start).toHaveBeenCalledWith({ model: null });
			const status = getWebModelStatus();
			expect(status.phase).toBe("error");
			expect(status.errorKind).toBe("no-shader-f16");
			expect(status.shaderF16).toBe(false);
			expect(status.adapter?.vendor).toBe("vendor-x");
		}
	});

	it("WO13C-S6 f16-capable-unchanged", async () => {
		const bridge = { start: vi.fn() };
		const gpu = {
			requestAdapter: vi.fn().mockResolvedValue({
				features: { has: (f: string) => f === "shader-f16" },
				info: { vendor: "vendor-x", architecture: "arch-y", description: "" },
			}),
		};

		await startWebModel({
			gpu,
			storage: null,
			engineKind: undefined,
			bridge,
		});

		expect(bridge.start).toHaveBeenCalledWith({ model: WEB_LLM_MODEL_ID });
		const status = getWebModelStatus();
		expect(status.phase).toBe("loading");
		expect(status.model).toBe(WEB_LLM_MODEL_ID);
		expect(status.shaderF16).toBe(true);
	});

	it("starts with 4B f32 when f16 is missing but user preferred 4B f32", async () => {
		const bridge = { start: vi.fn() };
		const gpu = {
			requestAdapter: vi.fn().mockResolvedValue({
				features: { has: () => false },
				info: { vendor: "vendor-x", architecture: "arch-y", description: "" },
			}),
		};
		const storage = {
			getItem: vi.fn((key: string) => {
				if (key === WEB_LLM_MODEL_PREF_KEY) return WEB_LLM_FALLBACK_F32;
				return null;
			}),
		};

		await startWebModel({
			gpu,
			storage,
			engineKind: undefined,
			bridge,
		});

		expect(bridge.start).toHaveBeenCalledWith({ model: WEB_LLM_FALLBACK_F32 });
		const status = getWebModelStatus();
		expect(status.phase).toBe("loading");
		expect(status.model).toBe(WEB_LLM_FALLBACK_F32);
	});

	it("uses default model when storage contains an invalid model id", async () => {
		const bridge = { start: vi.fn() };
		const storage = {
			getItem: vi.fn(() => "invalid-model-name"),
		};

		await startWebModel({
			gpu: undefined,
			storage,
			engineKind: "fake",
			bridge,
		});

		expect(bridge.start).toHaveBeenCalledWith({ model: WEB_LLM_MODEL_ID });
		expect(getWebModelStatus().model).toBe(WEB_LLM_MODEL_ID);
	});

	it("uses buildModel when buildModel is 4B f32 and storage is empty", async () => {
		const bridge = { start: vi.fn() };

		await startWebModel({
			gpu: undefined,
			storage: null,
			engineKind: "fake",
			buildModel: WEB_LLM_FALLBACK_F32,
			bridge,
		});

		expect(bridge.start).toHaveBeenCalledWith({ model: WEB_LLM_FALLBACK_F32 });
		expect(getWebModelStatus().model).toBe(WEB_LLM_FALLBACK_F32);
	});

	it("prioritizes storage preference over buildModel", async () => {
		const bridge = { start: vi.fn() };
		const storage = {
			getItem: vi.fn(() => WEB_LLM_MODEL_ID),
		};

		await startWebModel({
			gpu: undefined,
			storage,
			engineKind: "fake",
			buildModel: WEB_LLM_FALLBACK_F32,
			bridge,
		});

		expect(bridge.start).toHaveBeenCalledWith({ model: WEB_LLM_MODEL_ID });
		expect(getWebModelStatus().model).toBe(WEB_LLM_MODEL_ID);
	});

	it("falls back to default model when storage contains legacy removed model id", async () => {
		const bridge = { start: vi.fn() };
		const storage = {
			getItem: vi.fn(() => "Qwen3-8B-q4f16_1-MLC"),
		};

		await startWebModel({
			gpu: undefined,
			storage,
			engineKind: "fake",
			bridge,
		});

		expect(bridge.start).toHaveBeenCalledWith({ model: WEB_LLM_MODEL_ID });
		expect(getWebModelStatus().model).toBe(WEB_LLM_MODEL_ID);
	});

	it("warns and falls back to default model when buildModel is not in whitelist", async () => {
		const warnSpy = vi.spyOn(Logger, "warn").mockImplementation(() => {});
		const bridge = { start: vi.fn() };

		await startWebModel({
			gpu: undefined,
			storage: null,
			engineKind: "fake",
			buildModel: "Qwen-Unsupported-Model",
			bridge,
		});

		expect(warnSpy).toHaveBeenCalledWith(
			"WebModel",
			"ignored VITE_NAIA_WEB_LLM_MODEL",
			{ value: "Qwen-Unsupported-Model" },
		);
		expect(bridge.start).toHaveBeenCalledWith({ model: WEB_LLM_MODEL_ID });
		expect(getWebModelStatus().model).toBe(WEB_LLM_MODEL_ID);
	});
});
