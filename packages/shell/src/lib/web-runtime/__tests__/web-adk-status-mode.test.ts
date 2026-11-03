// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("web-adk-status-mode", () => {
	beforeEach(() => {
		cleanup();
		vi.unstubAllEnvs();
		Reflect.deleteProperty(window, "__NAIA_WEB_ADK_STATUS__");
		vi.resetModules();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllEnvs();
		Reflect.deleteProperty(window, "__NAIA_WEB_ADK_STATUS__");
		vi.resetModules();
	});

	it("does not attach __NAIA_WEB_ADK_STATUS__ to window in desktop mode", async () => {
		vi.unstubAllEnvs();
		vi.resetModules();

		await import("../web-adk-status");

		expect(window.__NAIA_WEB_ADK_STATUS__).toBeUndefined();
	});

	it("attaches __NAIA_WEB_ADK_STATUS__ to window in web mode", async () => {
		vi.stubEnv("MODE", "web");
		vi.resetModules();

		await import("../web-adk-status");

		expect(typeof window.__NAIA_WEB_ADK_STATUS__).toBe("function");
		expect(window.__NAIA_WEB_ADK_STATUS__?.()).toEqual({ phase: "checking" });
	});

	it("returns fixed ready status from useWebAdkStatus in desktop mode", async () => {
		vi.unstubAllEnvs();
		vi.resetModules();

		const { useWebAdkStatus } = await import(
			"../../../components/WebWorkspaceSetup"
		);
		const { setWebAdkStatus } = await import("../web-adk-status");

		const { result } = renderHook(() => useWebAdkStatus());
		expect(result.current).toEqual({ phase: "ready" });

		act(() => {
			setWebAdkStatus({ phase: "installing", done: 1, total: 2 });
		});

		expect(result.current).toEqual({ phase: "ready" });
	});

	it("returns store status from useWebAdkStatus and reflects updates in web mode", async () => {
		vi.stubEnv("MODE", "web");
		vi.resetModules();

		const { useWebAdkStatus } = await import(
			"../../../components/WebWorkspaceSetup"
		);
		const { resetWebAdkStatusForTests, setWebAdkStatus } = await import(
			"../web-adk-status"
		);

		resetWebAdkStatusForTests();

		const { result } = renderHook(() => useWebAdkStatus());
		expect(result.current).toEqual({ phase: "checking" });

		act(() => {
			setWebAdkStatus({ phase: "installing", done: 1, total: 2 });
		});

		expect(result.current).toEqual({
			phase: "installing",
			done: 1,
			total: 2,
		});
	});
});
