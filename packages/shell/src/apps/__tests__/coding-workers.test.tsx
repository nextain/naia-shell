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
import { getLocale, setLocale } from "../../lib/i18n";
import { CodingWorkersPanel } from "../workspace/CodingWorkersPanel";
import {
	type CodingWorker,
	type CodingWorkersAdapter,
	CourseWorkspaceNotReadyError,
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
	resumable: false,
	executionMode: "isolated_worktree",
	allowedFiles: [],
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
			coursePreset: false,
		});
		expect(
			screen.getByTestId("coding-worker-state-worker-created"),
		).toHaveTextContent("queued");
	});

	it("uses the reviewed Jeonju preset without accepting editable file allowances", async () => {
		const selectedWorkspaceWorker: CodingWorker = {
			...runningWorker,
			id: "course-worker",
			worktree: "D:\\student-site",
			executionMode: "selected_workspace",
			allowedFiles: ["index.html", "hero.svg"],
			verificationSummary: "selected workspace verified",
		};
		const workerAdapter = adapter({
			create: vi.fn().mockResolvedValue(selectedWorkspaceWorker),
		});
		render(<CodingWorkersPanel adapter={workerAdapter} />);

		fillCreateForm(selectedWorkspaceWorker.worktree, selectedWorkspaceWorker.task);
		fireEvent.click(screen.getByTestId("coding-worker-jeonju-course-preset"));
		fireEvent.click(screen.getByTestId("coding-worker-start"));

		await waitFor(() =>
			expect(workerAdapter.create).toHaveBeenCalledWith({
				provider: "codex",
				worktree: selectedWorkspaceWorker.worktree,
				task: selectedWorkspaceWorker.task,
				coursePreset: true,
			}),
		);
		expect(screen.getByTestId("coding-worker-course-boundary-course-worker")).toHaveTextContent("index.html, hero.svg");
		expect(screen.getByTestId("coding-worker-verification-course-worker")).toHaveTextContent("selected workspace verified");
		expect(screen.queryByLabelText(/allowed files/i)).not.toBeInTheDocument();
	});

	it("switches the workspace guidance immediately when course mode is selected", () => {
		render(<CodingWorkersPanel adapter={adapter()} />);
		const workspaceInput = screen.getByTestId("coding-worker-worktree");
		expect(workspaceInput.closest("label")).toHaveTextContent(
			"Workspace root — a dedicated worktree is created automatically.",
		);
		expect(
			screen.queryByTestId("coding-worker-course-mode-hint"),
		).not.toBeInTheDocument();

		fireEvent.click(screen.getByTestId("coding-worker-jeonju-course-preset"));

		expect(workspaceInput.closest("label")).toHaveTextContent(
			"Course workspace Git root",
		);
		expect(screen.getByTestId("coding-worker-course-mode-hint")).toHaveTextContent(
			"Only index.html and hero.svg may change.",
		);
	});

	it("renders the course boundary in Korean without removing the technical terms", () => {
		const previousLocale = getLocale();
		try {
			setLocale("ko");
			render(<CodingWorkersPanel adapter={adapter()} />);
			fireEvent.click(screen.getByTestId("coding-worker-jeonju-course-preset"));

			expect(screen.getByText("Coding Workers(코딩 작업자)")).toBeInTheDocument();
			expect(screen.getByText("Course workspace Git root(수업 워크스페이스 Git 루트)")).toBeInTheDocument();
			expect(screen.getByTestId("coding-worker-course-mode-hint")).toHaveTextContent(
				"index.html과 hero.svg만 변경할 수 있습니다.",
			);
		} finally {
			setLocale(previousLocale);
		}
	});

	it("blocks an unready selected Git workspace before rendering a course worker", async () => {
		const workerAdapter = adapter({
			create: vi.fn().mockRejectedValue(new CourseWorkspaceNotReadyError()),
		});
		render(<CodingWorkersPanel adapter={workerAdapter} />);
		fillCreateForm("D:\\not-a-clean-git-root", "Change the hero");
		fireEvent.click(screen.getByTestId("coding-worker-jeonju-course-preset"));
		fireEvent.click(screen.getByTestId("coding-worker-start"));

		await waitFor(() =>
			expect(screen.getByTestId("coding-worker-error")).toHaveTextContent(
				"Course mode requires a clean Git root with a remote.",
			),
		);
		expect(screen.queryByTestId(/coding-worker-worker-/)).not.toBeInTheDocument();
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
		resumable: true,
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
