import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	errorKindFromEngineErrorName,
	fallbackModelFor,
	getWebModelStatus,
	isWebSendBlocked,
	resetWebModelStatusForTests,
	setWebModelStatus,
	subscribeWebModelStatus,
} from "../web-model-status";
import {
	WEB_LLM_FALLBACK_F16,
	WEB_LLM_FALLBACK_F32,
	WEB_LLM_MODEL_ID,
} from "../webllm-model";

describe("web-model-status", () => {
	beforeEach(() => {
		resetWebModelStatusForTests();
	});

	it("manages state patching, subscription and unsubscription", () => {
		const listener = vi.fn();
		const unsubscribe = subscribeWebModelStatus(listener);

		expect(getWebModelStatus()).toEqual({
			phase: "checking",
			model: WEB_LLM_MODEL_ID,
			progress: 0,
		});

		setWebModelStatus({ phase: "loading", progress: 0.5 });
		expect(listener).toHaveBeenCalledTimes(1);
		expect(getWebModelStatus()).toEqual({
			phase: "loading",
			model: WEB_LLM_MODEL_ID,
			progress: 0.5,
		});

		unsubscribe();
		setWebModelStatus({ phase: "ready", progress: 1 });
		expect(listener).toHaveBeenCalledTimes(1);
		expect(getWebModelStatus().phase).toBe("ready");
	});

	it("clears errorKind and errorMessage when transitioning to a non-error phase", () => {
		setWebModelStatus({
			phase: "error",
			errorKind: "no-shader-f16",
			errorMessage: "F16 required",
		});
		expect(getWebModelStatus().errorKind).toBe("no-shader-f16");
		expect(getWebModelStatus().errorMessage).toBe("F16 required");

		setWebModelStatus({ phase: "loading", progress: 0 });
		expect(getWebModelStatus().phase).toBe("loading");
		expect(getWebModelStatus().errorKind).toBeUndefined();
		expect(getWebModelStatus().errorMessage).toBeUndefined();
	});

	it("evaluates isWebSendBlocked correctly", () => {
		expect(isWebSendBlocked({ phase: "checking", model: WEB_LLM_MODEL_ID, progress: 0 })).toBe(true);
		expect(isWebSendBlocked({ phase: "loading", model: WEB_LLM_MODEL_ID, progress: 0.4 })).toBe(true);
		expect(isWebSendBlocked({ phase: "error", model: WEB_LLM_MODEL_ID, progress: 0 })).toBe(true);
		expect(isWebSendBlocked({ phase: "ready", model: WEB_LLM_MODEL_ID, progress: 1 })).toBe(false);
	});

	it("calculates fallbackModelFor according to specification matrix", () => {
		// 1. If model is already a fallback (not default), returns null
		expect(
			fallbackModelFor({
				phase: "error",
				model: WEB_LLM_FALLBACK_F16,
				progress: 0,
				shaderF16: true,
			}),
		).toBeNull();

		// 2. If errorKind is no-webgpu, returns null
		expect(
			fallbackModelFor({
				phase: "error",
				model: WEB_LLM_MODEL_ID,
				progress: 0,
				errorKind: "no-webgpu",
				shaderF16: true,
			}),
		).toBeNull();

		// 3. If shaderF16 is true, returns 4B f16
		expect(
			fallbackModelFor({
				phase: "error",
				model: WEB_LLM_MODEL_ID,
				progress: 0,
				errorKind: "device-lost",
				shaderF16: true,
			}),
		).toBe(WEB_LLM_FALLBACK_F16);

		// 4. If shaderF16 is false or undefined, returns 4B f32
		expect(
			fallbackModelFor({
				phase: "error",
				model: WEB_LLM_MODEL_ID,
				progress: 0,
				errorKind: "no-shader-f16",
				shaderF16: false,
			}),
		).toBe(WEB_LLM_FALLBACK_F32);
		expect(
			fallbackModelFor({
				phase: "error",
				model: WEB_LLM_MODEL_ID,
				progress: 0,
				errorKind: "load-failed",
			}),
		).toBe(WEB_LLM_FALLBACK_F32);
	});

	it("maps engine error name to WebModelErrorKind (5 cases)", () => {
		expect(errorKindFromEngineErrorName("WebGPUNotAvailableError")).toBe("no-webgpu");
		expect(errorKindFromEngineErrorName("WebGPUNotFoundError")).toBe("no-webgpu");
		expect(errorKindFromEngineErrorName("ShaderF16SupportError")).toBe("no-shader-f16");
		expect(errorKindFromEngineErrorName("DeviceLostError")).toBe("device-lost");
		expect(errorKindFromEngineErrorName("UnknownOrRandomError")).toBe("load-failed");
		expect(errorKindFromEngineErrorName(undefined)).toBe("load-failed");
	});
});
