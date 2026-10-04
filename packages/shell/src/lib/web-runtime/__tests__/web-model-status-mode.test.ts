// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("web-model-status-mode", () => {
	beforeEach(() => {
		cleanup();
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	it("returns fixed ready status without model key in production mode", async () => {
		vi.stubEnv("MODE", "production");
		vi.resetModules();

		const { useWebModelStatus } = await import(
			"../../../components/WebModelStatusBar"
		);
		const { setWebModelStatus } = await import("../web-model-status");

		const { result } = renderHook(() => useWebModelStatus());
		expect(result.current.phase).toBe("ready");
		expect("model" in result.current).toBe(false);

		act(() => {
			setWebModelStatus({ phase: "error", errorKind: "load-failed" });
		});

		expect(result.current.phase).toBe("ready");
		expect("model" in result.current).toBe(false);
	});

	it("returns fixed ready status without model key in development mode", async () => {
		vi.stubEnv("MODE", "development");
		vi.resetModules();

		const { useWebModelStatus } = await import(
			"../../../components/WebModelStatusBar"
		);
		const { setWebModelStatus } = await import("../web-model-status");

		const { result } = renderHook(() => useWebModelStatus());
		expect(result.current.phase).toBe("ready");
		expect("model" in result.current).toBe(false);

		act(() => {
			setWebModelStatus({ phase: "error", errorKind: "load-failed" });
		});

		expect(result.current.phase).toBe("ready");
		expect("model" in result.current).toBe(false);
	});

	it("returns store status and reflects updates in web mode", async () => {
		vi.stubEnv("MODE", "web");
		vi.resetModules();

		const { useWebModelStatus } = await import(
			"../../../components/WebModelStatusBar"
		);
		const { resetWebModelStatusForTests, setWebModelStatus } = await import(
			"../web-model-status"
		);

		resetWebModelStatusForTests();

		const { result } = renderHook(() => useWebModelStatus());
		expect(result.current.phase).toBe("checking");

		act(() => {
			setWebModelStatus({ phase: "error", errorKind: "load-failed" });
		});

		expect(result.current.phase).toBe("error");
		expect(result.current.errorKind).toBe("load-failed");
	});

	it("returns store status and reflects updates in default test mode", async () => {
		vi.unstubAllEnvs();
		vi.resetModules();

		const { useWebModelStatus } = await import(
			"../../../components/WebModelStatusBar"
		);
		const { resetWebModelStatusForTests, setWebModelStatus } = await import(
			"../web-model-status"
		);

		resetWebModelStatusForTests();

		const { result } = renderHook(() => useWebModelStatus());
		expect(result.current.phase).toBe("checking");

		act(() => {
			setWebModelStatus({ phase: "error", errorKind: "load-failed" });
		});

		expect(result.current.phase).toBe("error");
		expect(result.current.errorKind).toBe("load-failed");
	});
});
