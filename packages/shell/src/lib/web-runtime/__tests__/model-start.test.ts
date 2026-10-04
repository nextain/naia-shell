import { beforeEach, describe, expect, it, vi } from "vitest";
import { startWebModel } from "../model-start";
import {
	getWebModelStatus,
	resetWebModelStatusForTests,
} from "../web-model-status";
import {
	WEB_LLM_FALLBACK_F16,
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

	it("sets no-shader-f16 error and starts with model null when f16 is missing and default 8B model is chosen", async () => {
		const bridge = { start: vi.fn() };
		const gpu = {
			requestAdapter: vi.fn().mockResolvedValue({
				features: { has: () => false },
				info: { vendor: "vendor-x", architecture: "arch-y", description: "" },
			}),
		};

		await startWebModel({
			gpu,
			storage: null,
			engineKind: undefined,
			bridge,
		});

		expect(bridge.start).toHaveBeenCalledWith({ model: null });
		const status = getWebModelStatus();
		expect(status.phase).toBe("error");
		expect(status.errorKind).toBe("no-shader-f16");
		expect(status.shaderF16).toBe(false);
		expect(status.adapter?.vendor).toBe("vendor-x");
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
			getItem: vi.fn(() => WEB_LLM_FALLBACK_F16),
		};

		await startWebModel({
			gpu: undefined,
			storage,
			engineKind: "fake",
			buildModel: WEB_LLM_FALLBACK_F32,
			bridge,
		});

		expect(bridge.start).toHaveBeenCalledWith({ model: WEB_LLM_FALLBACK_F16 });
		expect(getWebModelStatus().model).toBe(WEB_LLM_FALLBACK_F16);
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
