// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebModelStatusBar } from "../WebModelStatusBar";
import { t } from "../../lib/i18n";
import {
	resetWebModelStatusForTests,
	setWebModelStatus,
} from "../../lib/web-runtime/web-model-status";
import {
	WEB_LLM_FALLBACK_F16,
	WEB_LLM_FALLBACK_F32,
	WEB_LLM_MODEL_ID,
} from "../../lib/web-runtime/webllm-model";

describe("WebModelStatusBar", () => {
	beforeEach(() => {
		resetWebModelStatusForTests();
	});

	afterEach(() => {
		cleanup();
		resetWebModelStatusForTests();
	});

	it("renders checking phase as role status", () => {
		setWebModelStatus({ phase: "checking" });
		render(<WebModelStatusBar />);

		const el = screen.getByTestId("web-model-status");
		expect(el.getAttribute("role")).toBe("status");
		expect(el.getAttribute("data-phase")).toBe("checking");
		expect(el.getAttribute("data-model")).toBe(WEB_LLM_MODEL_ID);
		expect(el.textContent).toContain(t("webModel.checking"));
	});

	it("renders loading phase with 42% progress and role status", () => {
		setWebModelStatus({
			phase: "loading",
			progress: 0.42,
			model: WEB_LLM_MODEL_ID,
		});
		render(<WebModelStatusBar />);

		const el = screen.getByTestId("web-model-status");
		expect(el.getAttribute("role")).toBe("status");
		expect(el.getAttribute("data-phase")).toBe("loading");
		expect(el.textContent).toContain("42%");
	});

	it("renders ready phase as role status", () => {
		setWebModelStatus({
			phase: "ready",
			progress: 1,
			model: WEB_LLM_MODEL_ID,
			adapter: { vendor: "NVIDIA", architecture: "Ada", description: "RTX 4060" },
			shaderF16: true,
		});
		render(<WebModelStatusBar />);

		const el = screen.getByTestId("web-model-status");
		expect(el.getAttribute("role")).toBe("status");
		expect(el.getAttribute("data-phase")).toBe("ready");
		expect(el.textContent).toContain("Qwen3 8B (4bit f16)");
		expect(el.textContent).toContain("NVIDIA · Ada · RTX 4060");
	});

	it("renders ready phase with fallback model and invokes onSwitchModel on return to default", () => {
		const onSwitchModel = vi.fn();
		setWebModelStatus({
			phase: "ready",
			progress: 1,
			model: WEB_LLM_FALLBACK_F32,
		});
		render(<WebModelStatusBar onSwitchModel={onSwitchModel} />);

		const el = screen.getByTestId("web-model-status");
		expect(el.getAttribute("role")).toBe("status");
		expect(el.textContent).toContain(t("webModel.fallbackActive"));

		const backBtn = screen.getByTestId("web-model-back-to-default");
		fireEvent.click(backBtn);
		expect(onSwitchModel).toHaveBeenCalledWith(WEB_LLM_MODEL_ID);
	});

	it("renders no-webgpu error as role alert with no fallback button and functional retry", () => {
		const onRetry = vi.fn();
		setWebModelStatus({
			phase: "error",
			errorKind: "no-webgpu",
			errorMessage: "navigator.gpu 없음",
		});
		render(<WebModelStatusBar onRetry={onRetry} />);

		const el = screen.getByTestId("web-model-status");
		expect(el.getAttribute("role")).toBe("alert");
		expect(el.getAttribute("data-phase")).toBe("error");
		expect(el.getAttribute("data-error-kind")).toBe("no-webgpu");
		expect(screen.queryByTestId("web-model-fallback")).toBeNull();

		const retryBtn = screen.getByTestId("web-model-retry");
		fireEvent.click(retryBtn);
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("renders no-shader-f16 error with 4B f32 fallback button", () => {
		const onSwitchModel = vi.fn();
		setWebModelStatus({
			phase: "error",
			errorKind: "no-shader-f16",
			model: WEB_LLM_MODEL_ID,
			shaderF16: false,
		});
		render(<WebModelStatusBar onSwitchModel={onSwitchModel} />);

		const el = screen.getByTestId("web-model-status");
		expect(el.getAttribute("role")).toBe("alert");
		expect(el.getAttribute("data-error-kind")).toBe("no-shader-f16");

		const fallbackBtn = screen.getByTestId("web-model-fallback");
		expect(fallbackBtn.textContent).toContain("Qwen3 4B (4bit f32)");
		fireEvent.click(fallbackBtn);
		expect(onSwitchModel).toHaveBeenCalledWith(WEB_LLM_FALLBACK_F32);
	});

	it("renders device-lost error with shaderF16 true proposing 4B f16 fallback button", () => {
		const onSwitchModel = vi.fn();
		setWebModelStatus({
			phase: "error",
			errorKind: "device-lost",
			model: WEB_LLM_MODEL_ID,
			shaderF16: true,
		});
		render(<WebModelStatusBar onSwitchModel={onSwitchModel} />);

		const el = screen.getByTestId("web-model-status");
		expect(el.getAttribute("role")).toBe("alert");
		expect(el.getAttribute("data-error-kind")).toBe("device-lost");

		const fallbackBtn = screen.getByTestId("web-model-fallback");
		expect(fallbackBtn.textContent).toContain("Qwen3 4B (4bit f16)");
		fireEvent.click(fallbackBtn);
		expect(onSwitchModel).toHaveBeenCalledWith(WEB_LLM_FALLBACK_F16);
	});

	it("renders load-failed error with expandable original error details and retry button", () => {
		const onRetry = vi.fn();
		setWebModelStatus({
			phase: "error",
			errorKind: "load-failed",
			errorMessage: "Shader compilation error: out of bounds",
		});
		render(<WebModelStatusBar onRetry={onRetry} />);

		const el = screen.getByTestId("web-model-status");
		expect(el.getAttribute("role")).toBe("alert");
		expect(el.getAttribute("data-error-kind")).toBe("load-failed");
		expect(el.textContent).toContain("Shader compilation error: out of bounds");

		const retryBtn = screen.getByTestId("web-model-retry");
		fireEvent.click(retryBtn);
		expect(onRetry).toHaveBeenCalledTimes(1);
	});
});
