// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebModelStatusBar } from "../WebModelStatusBar";
import { setLocale, t } from "../../lib/i18n";
import * as labBalance from "../../lib/lab-balance";
import { setWebAssetsModeForTests } from "../../lib/web-runtime/web-assets";
import * as webAuth from "../../lib/web-runtime/web-auth";
import {
	resetWebModelStatusForTests,
	setWebModelStatus,
} from "../../lib/web-runtime/web-model-status";
import {
	WEB_LLM_FALLBACK_F32,
	WEB_LLM_MODEL_ID,
} from "../../lib/web-runtime/webllm-model";

const tauriMocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	convertFileSrc: vi.fn((path: string) => path),
}));
vi.mock("@tauri-apps/api/core", () => tauriMocks);
vi.mock("../../lib/web-runtime/agent-bridge", () => ({
	getStartableAgentBridge: () => ({ start: vi.fn(), sendLine: vi.fn() }),
}));

describe("WebModelStatusBar", () => {
	beforeEach(() => {
		resetWebModelStatusForTests();
		localStorage.clear();
		setWebAssetsModeForTests(true);
		tauriMocks.invoke.mockReset().mockResolvedValue([]);
	});

	afterEach(async () => {
		cleanup();
		resetWebModelStatusForTests();
		setWebAssetsModeForTests(null);
		localStorage.clear();
		vi.restoreAllMocks();
		await setLocale("en");
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

	it("shows plain-language progress with the exact model hidden until expanded", () => {
		setWebModelStatus({
			phase: "loading",
			progress: 0.42,
			model: WEB_LLM_MODEL_ID,
		});
		render(<WebModelStatusBar />);

		const el = screen.getByTestId("web-model-status");
		expect(el.getAttribute("role")).toBe("status");
		expect(el.getAttribute("data-phase")).toBe("loading");
		const summary = el.querySelector("summary")!;
		expect(summary).toHaveTextContent("Preparing on-device model (42%)");
		const name = screen.getByText("Qwen3 4B (4bit f16)");
		expect(name).not.toBeVisible();
		fireEvent.click(summary);
		expect(name).toBeVisible();
	});

	it("shows one ready label with the default model and adapter in the details", () => {
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
		const summary = el.querySelector("summary")!;
		expect(summary).toHaveTextContent(/^On-device model ready$/);
		expect(summary).toHaveAttribute("title", "Qwen3 4B (4bit f16)");
		const name = screen.getByText(/Qwen3 4B \(4bit f16\)/);
		const adapter = screen.getByText(/NVIDIA · Ada · RTX 4060/);
		expect(name).not.toBeVisible();
		expect(adapter).not.toBeVisible();
		fireEvent.click(summary);
		expect(name).toBeVisible();
		expect(adapter).toBeVisible();
	});

	it("uses a one-line Korean compatibility label and keeps the default-model action in the details", async () => {
		await setLocale("ko");
		const onSwitchModel = vi.fn();
		setWebModelStatus({
			phase: "ready",
			progress: 1,
			model: WEB_LLM_FALLBACK_F32,
		});
		render(<WebModelStatusBar onSwitchModel={onSwitchModel} />);

		const el = screen.getByTestId("web-model-status");
		expect(el.getAttribute("role")).toBe("status");
		const details = screen.getByTestId("web-model-ready-details") as HTMLDetailsElement;
		const summary = details.querySelector("summary");
		expect(details.open).toBe(false);
		expect(el.hasAttribute("tabindex")).toBe(false);
		if (!summary) throw new Error("model details summary missing");
		expect(summary).toHaveTextContent(/^내 기기 모델 · 호환 모드$/);
		expect(summary).toHaveAttribute("title", "Qwen3 4B (4bit f32)");
		const model = screen.getByText(/Qwen3 4B \(4bit f32\)/);
		expect(model).not.toBeVisible();
		fireEvent.click(summary);
		expect(details.open).toBe(true);
		expect(model).toBeVisible();
		await waitFor(() => expect(el.getAttribute("tabindex")).toBe("0"));

		const backBtn = screen.getByTestId("web-model-back-to-default");
		expect(backBtn.textContent).toContain("Qwen3 4B (4bit f16)");
		fireEvent.click(backBtn);
		expect(onSwitchModel).toHaveBeenCalledWith(WEB_LLM_MODEL_ID);
		fireEvent.click(summary);
		expect(model).not.toBeVisible();
		await waitFor(() => expect(el.hasAttribute("tabindex")).toBe(false));
	});

	it("withholds the switch back to the default model while the workspace is preparing", () => {
		setWebModelStatus({ phase: "ready", model: WEB_LLM_FALLBACK_F32, progress: 1 });
		render(<WebModelStatusBar scrollDuringSetup />);

		expect(screen.getByTestId("web-model-ready-details")).toBeInTheDocument();
		expect(screen.queryByTestId("web-model-back-to-default")).not.toBeInTheDocument();
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

	it("renders a plain-language compatibility action for the fallback model", () => {
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
		expect(fallbackBtn).toHaveTextContent("Try a compatible model");
		fireEvent.click(fallbackBtn);
		expect(onSwitchModel).toHaveBeenCalledWith(WEB_LLM_FALLBACK_F32);
	});

	it.each([
		["ko", "이 기기에서는 내 기기 대화를 시작할 수 없어요.", "로그인하고 클라우드로 대화하기 (무료 200 Cr)"],
		["en", "On-device chat couldn't start.", "Sign in for cloud chat (free 200 Cr)"],
	] as const)("offers an actionable sign-in in %s after local startup fails", async (locale, heading, label) => {
		await setLocale(locale);
		const login = vi.spyOn(webAuth, "startWebLoginRedirect").mockImplementation(() => ({
			url: "", state: "", redirectUri: "",
		}));
		setWebModelStatus({ phase: "error", errorKind: "no-webgpu" });
		render(<WebModelStatusBar offerCloudRecovery />);
		expect(screen.getByRole("alert")).toHaveTextContent(heading);
		fireEvent.click(screen.getByRole("button", { name: label }));
		expect(login).toHaveBeenCalledOnce();
		expect(login).toHaveBeenCalledWith({ keepLocalModel: true });
	});

	it("shows cloud login recovery without reporting an on-device model failure", async () => {
		await setLocale("en");
		const login = vi.spyOn(webAuth, "startWebLoginRedirect").mockImplementation(() => ({
			url: "", state: "", redirectUri: "",
		}));
		render(<WebModelStatusBar cloudRecoveryOnly />);

		const status = screen.getByTestId("web-model-status");
		expect(status).toHaveAttribute("data-phase", "cloud-recovery");
		expect(status).toHaveAttribute("role", "status");
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByText("On-device chat couldn't start.")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Sign in for cloud chat (free 200 Cr)" }));
		expect(login).toHaveBeenCalledOnce();
		expect(login).toHaveBeenCalledWith({ keepLocalModel: true });
	});

	it("allows a new balance check after the account service is unavailable", async () => {
		localStorage.setItem(webAuth.WEB_REMOTE_KEY_STORAGE_KEY, "fixture-account-key");
		const fetchBalance = vi.spyOn(labBalance, "fetchLabBalancePayload")
			.mockRejectedValueOnce(new Error("HTTP 503"))
			.mockResolvedValueOnce({ credits: 6 });
		setWebModelStatus({ phase: "error", errorKind: "no-webgpu" });
		render(<WebModelStatusBar offerCloudRecovery />);
		expect(screen.getByText("Checking credits for cloud chat…")).toBeVisible();
		expect(await screen.findByText("Couldn't check your cloud chat credits.")).toBeVisible();
		expect(screen.queryByRole("button", { name: "Switch to cloud chat" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Check credits again" }));
		expect(await screen.findByRole("button", { name: "Switch to cloud chat" })).toBeEnabled();
		expect(fetchBalance).toHaveBeenCalledTimes(2);
	});

	it("applies the cloud default model with xhigh thinking on switch", async () => {
		localStorage.setItem(webAuth.WEB_REMOTE_KEY_STORAGE_KEY, "fixture-account-key");
		vi.spyOn(labBalance, "fetchLabBalancePayload").mockResolvedValue({ credits: 6 });
		localStorage.setItem("naia-config", JSON.stringify({ provider: "webllm", model: WEB_LLM_FALLBACK_F32 }));
		localStorage.setItem("naia-adk-path", "opfs://naia-adk");
		setWebModelStatus({ phase: "error", errorKind: "no-webgpu" });
		render(<WebModelStatusBar offerCloudRecovery />);
		const button = await screen.findByRole("button", { name: "Switch to cloud chat" });
		expect(button).toBeEnabled();
		fireEvent.click(button);
		await waitFor(() => {
			expect(JSON.parse(localStorage.getItem("naia-config")!).llmRoles?.main).toMatchObject({
				provider: "nextain",
				model: "deepseek-v4.1-flash",
				thinkingLevel: "xhigh",
			});
		});
	});

	it("offers sign-in again when the account service rejects the saved sign-in", async () => {
		localStorage.setItem(webAuth.WEB_REMOTE_KEY_STORAGE_KEY, "fixture-account-key");
		vi.spyOn(labBalance, "fetchLabBalancePayload").mockRejectedValue(new Error("HTTP 401"));
		setWebModelStatus({ phase: "error", errorKind: "no-webgpu" });
		render(<WebModelStatusBar offerCloudRecovery />);
		expect(await screen.findByRole("button", { name: "Sign in again for cloud chat" })).toBeEnabled();
		expect(screen.queryByRole("button", { name: "Switch to cloud chat" })).toBeNull();
	});

	it("renders device-lost error with shaderF16 true proposing retry button only and no fallback button", () => {
		const onRetry = vi.fn();
		setWebModelStatus({
			phase: "error",
			errorKind: "device-lost",
			model: WEB_LLM_MODEL_ID,
			shaderF16: true,
		});
		render(<WebModelStatusBar onRetry={onRetry} />);

		const el = screen.getByTestId("web-model-status");
		expect(el.getAttribute("role")).toBe("alert");
		expect(el.getAttribute("data-error-kind")).toBe("device-lost");

		expect(screen.queryByTestId("web-model-fallback")).toBeNull();
		const retryBtn = screen.getByTestId("web-model-retry");
		expect(retryBtn).toBeDefined();
		fireEvent.click(retryBtn);
		expect(onRetry).toHaveBeenCalledTimes(1);
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

	it("hides the default model ready line after a short notice but keeps fallback notices", async () => {
		vi.useFakeTimers();
		try {
			setWebModelStatus({ phase: "ready", progress: 1, model: WEB_LLM_MODEL_ID });
			const { unmount } = render(<WebModelStatusBar />);
			const el = screen.getByTestId("web-model-status");
			expect(el.hidden).toBe(false);
			await act(async () => {
				vi.advanceTimersByTime(4100);
			});
			expect(el.hidden).toBe(true);
			expect(el.getAttribute("data-phase")).toBe("ready");
			unmount();

			setWebModelStatus({ phase: "ready", progress: 1, model: WEB_LLM_FALLBACK_F32 });
			render(<WebModelStatusBar />);
			await act(async () => {
				vi.advanceTimersByTime(4100);
			});
			expect(screen.getByTestId("web-model-status").hidden).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});
