import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
	invoke: mockInvoke,
}));

import {
	ensureBgmSidecar,
	resetBgmSidecarBaseUrl,
} from "../bgm-sidecar-url";

describe("ensureBgmSidecar", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
		resetBgmSidecarBaseUrl();
	});

	it("uses the native sidecar's actual port", async () => {
		mockInvoke.mockResolvedValue({ ready: true, port: 18901 });
		await expect(ensureBgmSidecar()).resolves.toBe("http://127.0.0.1:18901");
		expect(mockInvoke).toHaveBeenCalledWith("ensure_bgm_server");
	});

	it("surfaces a failed native readiness result", async () => {
		mockInvoke.mockResolvedValue({
			ready: false,
			port: 0,
			error: "port 18891 occupied",
		});
		await expect(ensureBgmSidecar()).rejects.toThrow("port 18891 occupied");
	});

	it("surfaces native launch failures", async () => {
		mockInvoke.mockRejectedValue(new Error("owned health check failed"));
		await expect(ensureBgmSidecar()).rejects.toThrow("owned health check failed");
	});
});
