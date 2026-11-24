import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	load: vi.fn(),
	save: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../config", () => ({
	loadConfig: mocks.load,
	saveConfig: mocks.save,
}));
import { refreshCliDetectionOnBoot } from "../cli-detection";
const result = {
	id: "codex",
	displayName: "Codex",
	installed: true,
	status: "ready",
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.load.mockReturnValue({
		enabledClis: ["codex"],
		cliDetection: { refreshedAt: "old", results: [result] },
	});
});
it("UC-B2C-026-R12 boot keeps identical detection without writing a new timestamp", async () => {
	mocks.invoke.mockResolvedValue({ refreshedAt: "new", results: [result] });
	await refreshCliDetectionOnBoot();
	expect(mocks.save).not.toHaveBeenCalled();
});
it("boot still saves a changed readiness result and prunes unavailable enabled CLIs", async () => {
	mocks.invoke.mockResolvedValue({
		refreshedAt: "new",
		results: [{ ...result, installed: false, status: "not-installed" }],
	});
	await refreshCliDetectionOnBoot();
	expect(mocks.save).toHaveBeenCalledWith(
		expect.objectContaining({
			enabledClis: [],
			cliDetection: expect.objectContaining({ refreshedAt: "new" }),
		}),
	);
});
