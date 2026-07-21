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
	executionMode: "isolated_worktree" as const,
	allowedFiles: [],
};

describe("tauri coding-worker adapter", () => {
	it("maps the UI start request to the paired Agent workspace contract", async () => {
		invoke.mockResolvedValueOnce(worker);

		await expect(
			tauriCodingWorkersAdapter.create({
				provider: "codex",
				worktree: "D:\\alpha-adk\\projects\\naia-shell",
				task: worker.task,
				coursePreset: false,
			}),
		).resolves.toEqual(worker);
		expect(invoke).toHaveBeenCalledWith("start_coding_job", {
			workspacePath: "D:\\alpha-adk\\projects\\naia-shell",
			task: worker.task,
			coursePreset: false,
		});
	});

	it("forwards only a course-preset boolean, never caller-supplied allowed files", async () => {
		invoke.mockResolvedValueOnce({
			...worker,
			executionMode: "selected_workspace",
			allowedFiles: ["index.html", "hero.svg"],
		});

		await tauriCodingWorkersAdapter.create({
			provider: "codex",
			worktree: "D:\\student-site",
			task: "Change the hero",
			coursePreset: true,
		});

		expect(invoke).toHaveBeenCalledWith("start_coding_job", {
			workspacePath: "D:\\student-site",
			task: "Change the hero",
			coursePreset: true,
		});
	});

	it("maps native course preflight rejection to a safe typed error", async () => {
		invoke.mockRejectedValueOnce("course_workspace_not_ready");

		await expect(
			tauriCodingWorkersAdapter.create({
				provider: "codex",
				worktree: "D:\\student-site",
				task: "Change the hero",
				coursePreset: true,
			}),
		).rejects.toMatchObject({ name: "CourseWorkspaceNotReadyError" });
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
