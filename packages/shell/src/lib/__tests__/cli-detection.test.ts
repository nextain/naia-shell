// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import {
	getEnabledClis,
	refreshCliDetection,
	setCliEnabled,
} from "../cli-detection";

const CONFIG = {
	provider: "ollama",
	model: "e2e",
	apiKey: "",
	enabledClis: ["claude", "missing"],
};

describe("descriptor-driven CLI persistence", () => {
	beforeEach(() => {
		localStorage.setItem("naia-config", JSON.stringify(CONFIG));
		mockInvoke.mockReset();
	});

	afterEach(() => {
		localStorage.clear();
	});

	it("normalizes detection results and removes disappeared enabled CLIs", async () => {
		mockInvoke.mockResolvedValue({
			refreshedAt: "e2e",
			results: [
				{
					id: "claude",
					displayName: "Claude Code",
					installed: true,
					status: "ready",
				},
				{
					id: "codex",
					displayName: "Codex",
					installed: false,
					status: "unknown-status",
				},
			],
		});

		const snapshot = await refreshCliDetection();
		expect(snapshot.results).toHaveLength(2);
		expect(snapshot.results[0]).toMatchObject({
			id: "claude",
			status: "ready",
		});
		const saved = JSON.parse(localStorage.getItem("naia-config") ?? "{}");
		expect(saved.enabledClis).toEqual(["claude"]);
		expect(saved.cliDetection.results[1].status).toBe("error");
	});

	it("filters persisted enabled names to currently installed CLIs", () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				...CONFIG,
				cliDetection: {
					refreshedAt: "e2e",
					results: [
						{
							id: "claude",
							displayName: "Claude Code",
							installed: true,
							status: "ready",
						},
						{
							id: "codex",
							displayName: "Codex",
							installed: false,
							status: "not-installed",
						},
					],
				},
			}),
		);

		expect(getEnabledClis()).toEqual(["claude"]);
		setCliEnabled("codex", true);
		expect(getEnabledClis()).toEqual(["claude"]);
		setCliEnabled("claude", false);
		expect(getEnabledClis()).toEqual([]);
	});

	it("rejects an invalid native response without writing a partial snapshot", async () => {
		mockInvoke.mockResolvedValue(undefined);
		await expect(refreshCliDetection()).rejects.toThrow(
			"cli_detect_invalid_snapshot",
		);
		expect(JSON.parse(localStorage.getItem("naia-config") ?? "{}")).toEqual(
			CONFIG,
		);
	});
});
