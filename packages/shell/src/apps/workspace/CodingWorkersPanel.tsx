import { useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import {
	type CodingWorker,
	CodingWorkerApiUnavailableError,
	type CodingWorkersAdapter,
	CourseWorkspaceNotReadyError,
	canCancelCodingWorker,
	canResumeCodingWorker,
	isWorktreeOccupied,
	reconcileCodingWorkers,
} from "./coding-workers";
import {
	type JeonjuCourseTarget,
	CourseTargetNotReadyError,
	readJeonjuCourseTarget,
	saveJeonjuCourseTarget,
} from "./jeonju-course-target";

interface CodingWorkersPanelProps {
	adapter: CodingWorkersAdapter;
	initialWorkers?: CodingWorker[];
	/** ADK control plane: settings and skills live here; Codex writes at the target. */
	controlRoot?: string;
}

function safeWorkerError(error: unknown): string {
	if (error instanceof CodingWorkerApiUnavailableError) {
		return t("workspace.codingWorkersUnavailable");
	}
	if (error instanceof CourseWorkspaceNotReadyError) {
		return t("workspace.codingWorkersCourseUnready");
	}
	// Adapter failures can include provider output or credentials. Never render it.
	return t("workspace.codingWorkersRequestFailed");
}

function mergeWorker(
	workers: readonly CodingWorker[],
	next: CodingWorker,
): CodingWorker[] {
	const index = workers.findIndex((worker) => worker.id === next.id);
	if (index === -1) return [...workers, next];
	return workers.map((worker) => (worker.id === next.id ? next : worker));
}

export function CodingWorkersPanel({
	adapter,
	initialWorkers = [],
	controlRoot,
}: CodingWorkersPanelProps) {
	const [workers, setWorkers] = useState<CodingWorker[]>(initialWorkers);
	const [worktree, setWorktree] = useState("");
	const [task, setTask] = useState("");
	const [coursePreset, setCoursePreset] = useState(false);
	const [courseTarget, setCourseTarget] = useState<JeonjuCourseTarget | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		let refreshing = false;
		const refresh = async () => {
			// A gRPC request can outlive the two-second timer. Keep just one
			// snapshot in flight so an old `running` response cannot overwrite a
			// later terminal state in the card.
			if (refreshing) return;
			refreshing = true;
			try {
				const listed = await adapter.list();
				if (active) {
					setWorkers((current) => reconcileCodingWorkers(current, listed));
				}
			} catch (reason) {
				if (active) setError(safeWorkerError(reason));
			} finally {
				refreshing = false;
			}
		};
		void refresh();
		const interval = window.setInterval(() => void refresh(), 2_000);
		return () => {
			active = false;
			window.clearInterval(interval);
		};
	}, [adapter]);

	useEffect(() => {
		let active = true;
		if (!controlRoot) {
			setCourseTarget(null);
			return () => {
				active = false;
			};
		}
		void readJeonjuCourseTarget(controlRoot)
			.then((target) => {
				if (active) setCourseTarget(target);
			})
			.catch((reason) => {
				if (!active) return;
				setError(
					reason instanceof CourseTargetNotReadyError
						? t("workspace.codingWorkersCourseTargetUnready")
						: t("workspace.codingWorkersCourseTargetInvalid"),
				);
			});
		return () => {
			active = false;
		};
	}, [controlRoot]);

	async function createWorker() {
		const normalizedWorktree = worktree.trim();
		const normalizedTask = task.trim();
		if (!normalizedWorktree || !normalizedTask) {
			setError(t("workspace.codingWorkersRequired"));
			return;
		}
		if (isWorktreeOccupied(workers, normalizedWorktree)) {
			setError(t("workspace.codingWorkersOccupied"));
			return;
		}
		setError(null);
		try {
			const created = await adapter.create({
				provider: "codex",
				worktree: normalizedWorktree,
				task: normalizedTask,
				coursePreset,
			});
			setWorkers((current) => mergeWorker(current, created));
			setWorktree("");
			setTask("");
			setCoursePreset(false);
		} catch (reason) {
			setError(safeWorkerError(reason));
		}
	}

	async function cancelWorker(worker: CodingWorker) {
		setError(null);
		try {
			const cancelled = await adapter.cancel(worker.id);
			setWorkers((current) => mergeWorker(current, cancelled));
		} catch (reason) {
			setError(safeWorkerError(reason));
		}
	}

	async function resumeWorker(worker: CodingWorker) {
		setError(null);
		try {
			const resumed = await adapter.resume(worker.id);
			setWorkers((current) => mergeWorker(current, resumed));
		} catch (reason) {
			setError(safeWorkerError(reason));
		}
	}

	async function saveCourseTarget() {
		const workspacePath = worktree.trim();
		if (!controlRoot || !workspacePath) {
			setError(t("workspace.codingWorkersCourseTargetRequired"));
			return;
		}
		setError(null);
		try {
			const saved = await saveJeonjuCourseTarget(controlRoot, workspacePath);
			setCourseTarget(saved);
			setWorktree(saved.workspacePath);
		} catch (reason) {
			setError(
				reason instanceof CourseTargetNotReadyError
					? t("workspace.codingWorkersCourseTargetUnready")
					: t("workspace.codingWorkersCourseTargetInvalid"),
			);
		}
	}

	return (
		<section className="coding-workers" data-testid="coding-workers">
			<header className="coding-workers__header">
				<h3>{t("workspace.codingWorkersTitle")}</h3>
				<p>{t("workspace.codingWorkersDescription")}</p>
			</header>
			<div className="coding-workers__form" data-testid="coding-worker-create">
				<p data-testid="coding-worker-control-root">
					<strong>{t("workspace.codingWorkersControlRoot")}: </strong>
					<code>{controlRoot || t("workspace.codingWorkersControlRootUnavailable")}</code>
				</p>
				<p data-testid="coding-worker-target-hint">
					{t("workspace.codingWorkersTargetHint")}
				</p>
				<label>
					{t("workspace.codingWorkersProvider")}
					<select data-testid="coding-worker-provider" value="codex" disabled>
						<option value="codex">Codex</option>
					</select>
				</label>
				<label>
					{coursePreset
						? t("workspace.codingWorkersCourseTarget")
						: t("workspace.codingWorkersExecutionTarget")}
					<input
						data-testid="coding-worker-worktree"
						value={worktree}
						onChange={(event) => setWorktree(event.target.value)}
						placeholder={t("workspace.codingWorkersWorkspaceExample")}
					/>
				</label>
				<label>
					{t("workspace.codingWorkersTask")}
					<textarea
						data-testid="coding-worker-task"
						value={task}
						onChange={(event) => setTask(event.target.value)}
					/>
				</label>
				<label>
					<input
						type="checkbox"
						data-testid="coding-worker-jeonju-course-preset"
						checked={coursePreset}
						onChange={(event) => {
							const enabled = event.target.checked;
							setCoursePreset(enabled);
							if (enabled && !worktree && courseTarget) {
								setWorktree(courseTarget.workspacePath);
							}
						}}
					/>
					{t("workspace.codingWorkersCourseMode")}
				</label>
				{coursePreset && (
					<>
						<p data-testid="coding-worker-course-mode-hint">
							{t("workspace.codingWorkersCourseHint")}
						</p>
						<p data-testid="coding-worker-course-target-hint">
							{t("workspace.codingWorkersCourseTargetHint")}
						</p>
						<button
							type="button"
							data-testid="coding-worker-save-course-target"
							onClick={() => void saveCourseTarget()}
						>
							{t("workspace.codingWorkersSaveCourseTarget")}
						</button>
						{courseTarget && (
							<p data-testid="coding-worker-course-target-saved">
								{t("workspace.codingWorkersSavedCourseTarget")}: {courseTarget.workspacePath} ({courseTarget.allowedFiles.join(", ")})
							</p>
						)}
					</>
				)}
				<button
					type="button"
					data-testid="coding-worker-start"
					onClick={() => void createWorker()}
				>
					{t("workspace.codingWorkersStart")}
				</button>
			</div>
			{error && (
				<p role="alert" data-testid="coding-worker-error">
					{error}
				</p>
			)}
			<div className="coding-workers__list" aria-live="polite">
				{workers.map((worker) => (
					<article key={worker.id} data-testid={`coding-worker-${worker.id}`}>
						<strong>{worker.provider}</strong>
						<span data-testid={`coding-worker-state-${worker.id}`}>
							{worker.state}
						</span>
						<p>{worker.worktree}</p>
						<p>{worker.task}</p>
						{worker.executionMode === "selected_workspace" && (
							<p data-testid={`coding-worker-course-boundary-${worker.id}`}>
								{t("workspace.codingWorkersCourseBoundary")}: {worker.allowedFiles.join(", ")}
							</p>
						)}
						{worker.verificationSummary && (
							<p data-testid={`coding-worker-verification-${worker.id}`}>
								{t("workspace.codingWorkersVerification")}: {worker.verificationSummary}
							</p>
						)}
						<time dateTime={worker.updatedAt}>{worker.updatedAt}</time>
						{canCancelCodingWorker(worker) && (
							<button
								type="button"
								data-testid={`coding-worker-cancel-${worker.id}`}
								onClick={() => void cancelWorker(worker)}
							>
								{t("workspace.codingWorkersCancel")}
							</button>
						)}
						{canResumeCodingWorker(worker) && (
							<button
								type="button"
								data-testid={`coding-worker-resume-${worker.id}`}
								onClick={() => void resumeWorker(worker)}
							>
								{t("workspace.codingWorkersResume")}
							</button>
						)}
					</article>
				))}
			</div>
		</section>
	);
}
