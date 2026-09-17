import { describe, expect, it, vi } from "vitest";
import {
	nativeRelaunchRestartsApp,
	resetAdkPathWithRelaunch,
} from "../adk-path-reset";

function deps(
	overrides: Partial<Parameters<typeof resetAdkPathWithRelaunch>[0]> = {},
) {
	return {
		dev: false,
		prepareAppRelaunch: vi.fn().mockResolvedValue(undefined),
		cancelAppRelaunch: vi.fn().mockResolvedValue(undefined),
		resetAdkPathBinding: vi.fn().mockResolvedValue(undefined),
		relaunch: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

describe("ADK path reset relaunch (#642)", () => {
	it("native relaunch only restarts packaged builds", () => {
		expect(nativeRelaunchRestartsApp(true)).toBe(false);
		expect(nativeRelaunchRestartsApp(false)).toBe(true);
	});

	it("keeps the window in tauri:dev and does not call relaunch", async () => {
		const d = deps({ dev: true });
		await expect(resetAdkPathWithRelaunch(d)).resolves.toEqual({
			outcome: "restart-required",
		});
		expect(d.resetAdkPathBinding).toHaveBeenCalledOnce();
		expect(d.prepareAppRelaunch).not.toHaveBeenCalled();
		expect(d.relaunch).not.toHaveBeenCalled();
		expect(d.cancelAppRelaunch).not.toHaveBeenCalled();
	});

	it("relaunches packaged builds after resetting the binding", async () => {
		const d = deps({ dev: false });
		await expect(resetAdkPathWithRelaunch(d)).resolves.toEqual({
			outcome: "relaunched",
		});
		expect(d.prepareAppRelaunch).toHaveBeenCalledOnce();
		expect(d.resetAdkPathBinding).toHaveBeenCalledOnce();
		expect(d.relaunch).toHaveBeenCalledOnce();
		expect(d.cancelAppRelaunch).not.toHaveBeenCalled();
	});

	it("releases the relaunch guard when packaged relaunch fails", async () => {
		const d = deps({
			dev: false,
			relaunch: vi.fn().mockRejectedValue(new Error("relaunch failed")),
		});
		await expect(resetAdkPathWithRelaunch(d)).rejects.toThrow(
			"relaunch failed",
		);
		expect(d.cancelAppRelaunch).toHaveBeenCalledOnce();
	});
});
