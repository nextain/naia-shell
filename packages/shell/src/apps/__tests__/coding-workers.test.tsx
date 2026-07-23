// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLocale } from "../../lib/i18n";

const { readJeonjuCourseTarget, saveJeonjuCourseTarget } = vi.hoisted(() => ({
	readJeonjuCourseTarget: vi.fn().mockResolvedValue(null),
	saveJeonjuCourseTarget: vi.fn(),
}));

vi.mock("../workspace/jeonju-course-target", () => ({
	CourseTargetNotReadyError: class CourseTargetNotReadyError extends Error {},
	CourseTargetInvalidError: class CourseTargetInvalidError extends Error {},
	readJeonjuCourseTarget,
	saveJeonjuCourseTarget,
}));

import { CodingWorkersPanel } from "../workspace/CodingWorkersPanel";
import {
	type CodingWorker,
	type CodingWorkersAdapter,
	CourseWorkspaceNotReadyError,
	reconcileCodingWorkers,
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
		readJeonjuCourseTarget.mockReset();
		readJeonjuCourseTarget.mockResolvedValue(null);
		saveJeonjuCourseTarget.mockReset();
	});

	it("exposes a narrow adapter factory for the future Tauri bridge", () => {
		const workerAdapter = adapter();
		setCodingWorkersAdapterFactory(() => workerAdapter);

		expect(getCodingWorkersAdapter()).toBe(workerAdapter);
	});

	it("does not fabricate a queued worker when the Agent worker API is unavailable", async () => {
		render(<CodingWorkersPanel adapter={unavailableCodingWorkersAdapter} />);

		await waitFor(() =>
			expect(
				screen.getByTestId("coding-worker-connection-error"),
			).toHaveTextContent("Coding worker service is not connected yet."),
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
		).toHaveTextContent("Queued");
		expect(screen.getByTestId("coding-worker-provider")).toHaveTextContent(
			"Codex",
		);
		expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
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

		fillCreateForm(
			selectedWorkspaceWorker.worktree,
			selectedWorkspaceWorker.task,
		);
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
		expect(
			screen.getByTestId("coding-worker-course-boundary-course-worker"),
		).toHaveTextContent("index.html, hero.svg");
		expect(
			screen.getByTestId("coding-worker-verification-course-worker"),
		).toHaveTextContent("selected workspace verified");
		expect(screen.queryByLabelText(/allowed files/i)).not.toBeInTheDocument();
	});

	it("does not issue overlapping polls or regress a terminal card to an older running snapshot", async () => {
		vi.useFakeTimers();
		let resolveFirstList: ((workers: CodingWorker[]) => void) | undefined;
		const list = vi.fn(
			() =>
				new Promise<CodingWorker[]>((resolve) => {
					resolveFirstList = resolve;
				}),
		);
		try {
			render(
				<CodingWorkersPanel
					adapter={adapter({ list })}
					initialWorkers={[runningWorker]}
				/>,
			);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(6_000);
			});
			expect(list).toHaveBeenCalledTimes(1);

			await act(async () => {
				resolveFirstList?.([{ ...runningWorker, state: "completed" }]);
				await Promise.resolve();
			});
			expect(
				screen.getByTestId("coding-worker-state-worker-running"),
			).toHaveTextContent("Completed");
		} finally {
			vi.useRealTimers();
		}
	});

	it("preserves a terminal card when an older Agent snapshot arrives afterward", () => {
		expect(
			reconcileCodingWorkers(
				[{ ...runningWorker, state: "completed" }],
				[{ ...runningWorker, state: "running" }],
			),
		).toEqual([{ ...runningWorker, state: "completed" }]);
	});

	it("saves the Discord course target through the explicit course-mode control", async () => {
		const target = {
			version: 1 as const,
			workspacePath: "D:\\alpha-adk\\projects\\course-site",
			allowedFiles: ["index.html", "hero.svg"] as const,
		};
		saveJeonjuCourseTarget.mockResolvedValue(target);
		render(
			<CodingWorkersPanel adapter={adapter()} controlRoot={"D:\\alpha-adk"} />,
		);

		fillCreateForm(target.workspacePath, "Prepare the course page");
		fireEvent.click(screen.getByTestId("coding-worker-jeonju-course-preset"));
		fireEvent.click(screen.getByTestId("coding-worker-save-course-target"));

		await waitFor(() =>
			expect(saveJeonjuCourseTarget).toHaveBeenCalledWith(
				"D:\\alpha-adk",
				target.workspacePath,
			),
		);
		expect(
			screen.getByTestId("coding-worker-course-target-saved"),
		).toHaveTextContent(target.workspacePath);
		expect(
			screen.getByTestId("coding-worker-course-target-status"),
		).toHaveTextContent("applies on the next Agent start");
		expect(screen.queryByLabelText(/allowed files/i)).not.toBeInTheDocument();
	});

	it("requires the fixed course preset again for a follow-up request in the same student repository", async () => {
		const first: CodingWorker = {
			...runningWorker,
			id: "course-first",
			worktree: "D:\\student-site",
			state: "completed",
			executionMode: "selected_workspace",
			allowedFiles: ["index.html", "hero.svg"],
		};
		const second: CodingWorker = { ...first, id: "course-second" };
		const create = vi
			.fn()
			.mockResolvedValueOnce(first)
			.mockResolvedValueOnce(second);
		const workerAdapter = adapter({ create });
		render(<CodingWorkersPanel adapter={workerAdapter} />);

		fillCreateForm(first.worktree, "Create the initial course page");
		fireEvent.click(screen.getByTestId("coding-worker-jeonju-course-preset"));
		fireEvent.click(screen.getByTestId("coding-worker-start"));
		await waitFor(() => expect(create).toHaveBeenCalledTimes(1));

		fillCreateForm(first.worktree, "Revise the existing course page");
		fireEvent.click(screen.getByTestId("coding-worker-start"));
		await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
		expect(create).toHaveBeenNthCalledWith(2, {
			provider: "codex",
			worktree: first.worktree,
			task: "Revise the existing course page",
			coursePreset: true,
		});
	});

	it("shows the ADK control root separately and switches execution-target guidance for course mode", () => {
		render(
			<CodingWorkersPanel
				adapter={adapter()}
				controlRoot="D:\\alpha-adk\\projects\\naia-adk"
			/>,
		);
		const workspaceInput = screen.getByTestId("coding-worker-worktree");
		expect(screen.getByTestId("coding-worker-control-root")).toHaveTextContent(
			"ADK control root:",
		);
		expect(screen.getByTestId("coding-worker-control-root")).toHaveTextContent(
			"naia-adk",
		);
		expect(screen.getByTestId("coding-worker-target-hint")).toHaveTextContent(
			"The worker changes only this work target.",
		);
		expect(workspaceInput.closest("label")).toHaveTextContent("Work target");
		expect(
			screen.queryByTestId("coding-worker-course-mode-hint"),
		).not.toBeInTheDocument();

		fireEvent.click(screen.getByTestId("coding-worker-jeonju-course-preset"));

		expect(workspaceInput.closest("label")).toHaveTextContent(
			"Course execution-target Git root",
		);
		expect(
			screen.getByTestId("coding-worker-course-mode-hint"),
		).toHaveTextContent(
			"Naia applies and verifies the proposal. Changes are limited to index.html and hero.svg.",
		);
	});

	it("renders the course boundary in Korean without removing the technical terms", () => {
		const previousLocale = getLocale();
		try {
			setLocale("ko");
			render(<CodingWorkersPanel adapter={adapter()} />);
			fireEvent.click(screen.getByTestId("coding-worker-jeonju-course-preset"));

			expect(screen.getByText("코딩 작업")).toBeInTheDocument();
			expect(screen.getByText("수업 작업 대상 Git 루트")).toBeInTheDocument();
			expect(
				screen.getByTestId("coding-worker-course-mode-hint"),
			).toHaveTextContent(
				"Naia가 제안을 적용하고 검증합니다. 변경 범위는 index.html, hero.svg로 고정됩니다.",
			);
		} finally {
			setLocale(previousLocale);
		}
	});

	it("keeps empty, saved-target, and in-flight states distinct for the course instructor", async () => {
		let resolveSave:
			| ((value: {
					version: 1;
					workspacePath: string;
					allowedFiles: readonly ["index.html", "hero.svg"];
			  }) => void)
			| undefined;
		saveJeonjuCourseTarget.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveSave = resolve;
				}),
		);
		render(
			<CodingWorkersPanel adapter={adapter()} controlRoot="D:\\alpha-adk" />,
		);

		expect(screen.getByTestId("coding-workers-empty")).toBeInTheDocument();
		fillCreateForm(
			"D:\\alpha-adk\\projects\\course-site",
			"Prepare the course page",
		);
		fireEvent.click(screen.getByTestId("coding-worker-jeonju-course-preset"));
		expect(
			screen.getByTestId("coding-worker-course-target-status"),
		).toHaveTextContent("No Discord course target has been saved.");

		fireEvent.click(screen.getByTestId("coding-worker-save-course-target"));
		expect(
			screen.getByTestId("coding-worker-save-course-target"),
		).toBeDisabled();
		expect(screen.getByTestId("coding-worker-start")).toBeDisabled();

		await act(async () => {
			resolveSave?.({
				version: 1,
				workspacePath: "D:\\alpha-adk\\projects\\course-site",
				allowedFiles: ["index.html", "hero.svg"],
			});
		});
		await waitFor(() =>
			expect(
				screen.getByTestId("coding-worker-course-target-status"),
			).toHaveTextContent("Saved · applies on the next Agent start"),
		);
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
		expect(
			screen.queryByTestId(/coding-worker-worker-/),
		).not.toBeInTheDocument();
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
			).toHaveTextContent("Cancelling"),
		);
		expect(workerAdapter.cancel).toHaveBeenCalledWith("worker-running");

		fireEvent.click(
			screen.getByTestId("coding-worker-resume-worker-resumable"),
		);
		await waitFor(() =>
			expect(
				screen.getByTestId("coding-worker-state-worker-resumable"),
			).toHaveTextContent("Running"),
		);
		expect(workerAdapter.resume).toHaveBeenCalledWith("worker-resumable");
		expect(
			screen.queryByTestId("coding-worker-resume-worker-completed"),
		).not.toBeInTheDocument();
	});
});
