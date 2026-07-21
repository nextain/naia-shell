import { describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { tauriCodingWorkersAdapter } from "../coding-workers-tauri";

const worker = {
	id: "job-1",
	provider: "codex" as const,
	worktree: "D:\\worktrees\\job-1",
	task: "Inspect the current implementation",
	state: "running" as const,
	updatedAt: "2026-07-22T01:30:00.000Z",
	resumable: false,
};

describe("tauri coding-worker adapter", () => {
	it("maps the UI start request to the paired Agent workspace contract", async () => {
		invoke.mockResolvedValueOnce(worker);

		await expect(
			tauriCodingWorkersAdapter.create({
				provider: "codex",
				worktree: "D:\\alpha-adk\\projects\\naia-shell",
				task: worker.task,
			}),
		).resolves.toEqual(worker);
		expect(invoke).toHaveBeenCalledWith("start_coding_job", {
			workspacePath: "D:\\alpha-adk\\projects\\naia-shell",
			task: worker.task,
		});
	});

	it("uses target job ids for cancellation and never exposes a checkpoint id", async () => {
		invoke.mockResolvedValueOnce({ ...worker, state: "cancelled", resumable: true });

		await expect(tauriCodingWorkersAdapter.cancel("job-1")).resolves.toMatchObject({
			id: "job-1",
			state: "cancelled",
			resumable: true,
		});
		expect(invoke).toHaveBeenCalledWith("cancel_coding_job", { jobId: "job-1" });
	});
});
