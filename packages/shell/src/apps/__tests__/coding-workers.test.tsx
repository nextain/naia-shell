// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodingWorkersPanel } from "../workspace/CodingWorkersPanel";
import {
	type CodingWorker,
	type CodingWorkersAdapter,
	unavailableCodingWorkersAdapter,
} from "../workspace/coding-workers";
import {
	getCodingWorkersAdapter,
	setCodingWorkersAdapterFactory,
} from "../workspace/coding-workers-adapter";

const runningWorker: CodingWorker = {
	id: "worker-running",
	provider: "codex",
	worktree: "D:\\worktrees\\one",
	task: "Inspect the feature",
	state: "running",
	updatedAt: "2026-07-22T00:00:00.000Z",
};

function adapter(
	overrides: Partial<CodingWorkersAdapter> = {},
): CodingWorkersAdapter {
	return {
		list: vi.fn().mockResolvedValue([]),
		create: vi.fn(),
		cancel: vi.fn(),
		resume: vi.fn(),
		...overrides,
	};
}

function fillCreateForm(worktree: string, task: string): void {
	fireEvent.change(screen.getByTestId("coding-worker-worktree"), {
		target: { value: worktree },
	});
	fireEvent.change(screen.getByTestId("coding-worker-task"), {
		target: { value: task },
	});
}

describe("CodingWorkersPanel", () => {
	afterEach(() => {
		cleanup();
		setCodingWorkersAdapterFactory(() => unavailableCodingWorkersAdapter);
	});

	it("exposes a narrow adapter factory for the future Tauri bridge", () => {
		const workerAdapter = adapter();
		setCodingWorkersAdapterFactory(() => workerAdapter);

		expect(getCodingWorkersAdapter()).toBe(workerAdapter);
	});

	it("does not fabricate a queued worker when the Agent worker API is unavailable", async () => {
		render(<CodingWorkersPanel adapter={unavailableCodingWorkersAdapter} />);

		await waitFor(() =>
			expect(screen.getByTestId("coding-worker-error")).toHaveTextContent(
				"Coding worker service is not connected yet.",
			),
		);
		fillCreateForm("D:\\worktrees\\one", "Implement a worker");
		fireEvent.click(screen.getByTestId("coding-worker-start"));

		await waitFor(() =>
			expect(screen.getByTestId("coding-worker-error")).toHaveTextContent(
				"Coding worker service is not connected yet.",
			),
		);
		expect(
			screen.queryByTestId(/coding-worker-worker-/),
		).not.toBeInTheDocument();
	});

	it("renders a worker only when a paired adapter returns it", async () => {
		const queuedWorker: CodingWorker = {
			...runningWorker,
			id: "worker-created",
			state: "queued",
		};
		const workerAdapter = adapter({
			create: vi.fn().mockResolvedValue(queuedWorker),
		});
		render(<CodingWorkersPanel adapter={workerAdapter} />);

		fillCreateForm(queuedWorker.worktree, queuedWorker.task);
		fireEvent.click(screen.getByTestId("coding-worker-start"));

		await waitFor(() =>
			expect(
				screen.getByTestId("coding-worker-worker-created"),
			).toBeInTheDocument(),
		);
		expect(workerAdapter.create).toHaveBeenCalledWith({
			provider: "codex",
			worktree: queuedWorker.worktree,
			task: queuedWorker.task,
		});
		expect(
			screen.getByTestId("coding-worker-state-worker-created"),
		).toHaveTextContent("queued");
	});

	it("rejects a second active worker for the same worktree before calling the adapter", async () => {
		const workerAdapter = adapter({
			list: vi.fn().mockResolvedValue([runningWorker]),
		});
		render(
			<CodingWorkersPanel
				adapter={workerAdapter}
				initialWorkers={[runningWorker]}
			/>,
		);

		fillCreateForm(runningWorker.worktree, "A second task");
		fireEvent.click(screen.getByTestId("coding-worker-start"));

		expect(screen.getByTestId("coding-worker-error")).toHaveTextContent(
			"This worktree already has an active coding worker.",
		);
		expect(workerAdapter.create).not.toHaveBeenCalled();
	});

	it("uses the worker adapter for targeted cancel and exposes resume only with a checkpoint", async () => {
		const resumableWorker: CodingWorker = {
			...runningWorker,
			id: "worker-resumable",
			state: "failed",
			checkpointId: "checkpoint-1",
		};
		const completedWorker: CodingWorker = {
			...runningWorker,
			id: "worker-completed",
			state: "completed",
		};
		const workerAdapter = adapter({
			list: vi
				.fn()
				.mockResolvedValue([runningWorker, resumableWorker, completedWorker]),
			cancel: vi
				.fn()
				.mockResolvedValue({ ...runningWorker, state: "cancelling" }),
			resume: vi
				.fn()
				.mockResolvedValue({ ...resumableWorker, state: "running" }),
		});
		render(
			<CodingWorkersPanel
				adapter={workerAdapter}
				initialWorkers={[runningWorker, resumableWorker, completedWorker]}
			/>,
		);

		fireEvent.click(screen.getByTestId("coding-worker-cancel-worker-running"));
		await waitFor(() =>
			expect(
				screen.getByTestId("coding-worker-state-worker-running"),
			).toHaveTextContent("cancelling"),
		);
		expect(workerAdapter.cancel).toHaveBeenCalledWith("worker-running");

		fireEvent.click(
			screen.getByTestId("coding-worker-resume-worker-resumable"),
		);
		await waitFor(() =>
			expect(
				screen.getByTestId("coding-worker-state-worker-resumable"),
			).toHaveTextContent("running"),
		);
		expect(workerAdapter.resume).toHaveBeenCalledWith("worker-resumable");
		expect(
			screen.queryByTestId("coding-worker-resume-worker-completed"),
		).not.toBeInTheDocument();
	});
});
