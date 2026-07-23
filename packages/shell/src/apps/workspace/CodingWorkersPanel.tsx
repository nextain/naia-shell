import { useEffect, useState } from "react";
import { getLocale, t } from "../../lib/i18n";
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
	CourseTargetNotReadyError,
	type JeonjuCourseTarget,
	readJeonjuCourseTarget,
	saveJeonjuCourseTarget,
} from "./jeonju-course-target";

interface CodingWorkersPanelProps {
	adapter: CodingWorkersAdapter;
	initialWorkers?: CodingWorker[];
	/** ADK control plane: settings and skills live here; Codex writes at the target. */
	controlRoot?: string;
}

type PendingAction =
	| "create"
	| "save-course-target"
	| `cancel:${string}`
	| `resume:${string}`;

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

function workerStateLabel(worker: CodingWorker): string {
	switch (worker.state) {
		case "queued":
			return t("workspace.codingWorkersStateQueued");
		case "running":
			return t("workspace.codingWorkersStateRunning");
		case "cancelling":
			return t("workspace.codingWorkersStateCancelling");
		case "cancelled":
			return t("workspace.codingWorkersStateCancelled");
		case "completed":
			return t("workspace.codingWorkersStateCompleted");
		case "failed":
			return t("workspace.codingWorkersStateFailed");
	}
}

function formatUpdatedAt(updatedAt: string): string {
	const date = new Date(updatedAt);
	if (Number.isNaN(date.getTime())) return updatedAt;
	return new Intl.DateTimeFormat(getLocale(), {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(date);
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
	const [courseTarget, setCourseTarget] = useState<JeonjuCourseTarget | null>(
		null,
	);
	const [actionError, setActionError] = useState<string | null>(null);
	const [connectionError, setConnectionError] = useState<string | null>(null);
	const [pendingAction, setPendingAction] = useState<PendingAction | null>(
		null,
	);

	useEffect(() => {
		let active = true;
		let refreshing = false;
		const refresh = async () => {
			if (refreshing) return;
			refreshing = true;
			try {
				const listed = await adapter.list();
				if (active) {
					setWorkers((current) => reconcileCodingWorkers(current, listed));
					setConnectionError(null);
				}
			} catch (reason) {
				if (active) {
					setConnectionError(
						reason instanceof CodingWorkerApiUnavailableError
							? t("workspace.codingWorkersUnavailable")
							: t("workspace.codingWorkersConnectionIssue"),
					);
				}
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
				setActionError(
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
			setActionError(t("workspace.codingWorkersRequired"));
			return;
		}
		if (isWorktreeOccupied(workers, normalizedWorktree)) {
			setActionError(t("workspace.codingWorkersOccupied"));
			return;
		}
		setActionError(null);
		setPendingAction("create");
		try {
			const created = await adapter.create({
				provider: "codex",
				worktree: normalizedWorktree,
				task: normalizedTask,
				coursePreset,
			});
			setWorkers((current) => mergeWorker(current, created));
			setTask("");
			if (!coursePreset) setWorktree("");
		} catch (reason) {
			setActionError(safeWorkerError(reason));
		} finally {
			setPendingAction(null);
		}
	}

	async function cancelWorker(worker: CodingWorker) {
		setActionError(null);
		setPendingAction(`cancel:${worker.id}`);
		try {
			const cancelled = await adapter.cancel(worker.id);
			setWorkers((current) => mergeWorker(current, cancelled));
		} catch (reason) {
			setActionError(safeWorkerError(reason));
		} finally {
			setPendingAction(null);
		}
	}

	async function resumeWorker(worker: CodingWorker) {
		setActionError(null);
		setPendingAction(`resume:${worker.id}`);
		try {
			const resumed = await adapter.resume(worker.id);
			setWorkers((current) => mergeWorker(current, resumed));
		} catch (reason) {
			setActionError(safeWorkerError(reason));
		} finally {
			setPendingAction(null);
		}
	}

	async function saveCourseTarget() {
		const workspacePath = worktree.trim();
		if (!controlRoot || !workspacePath) {
			setActionError(t("workspace.codingWorkersCourseTargetRequired"));
			return;
		}
		setActionError(null);
		setPendingAction("save-course-target");
		try {
			const saved = await saveJeonjuCourseTarget(controlRoot, workspacePath);
			setCourseTarget(saved);
			setWorktree(saved.workspacePath);
		} catch (reason) {
			setActionError(
				reason instanceof CourseTargetNotReadyError
					? t("workspace.codingWorkersCourseTargetUnready")
					: t("workspace.codingWorkersCourseTargetInvalid"),
			);
		} finally {
			setPendingAction(null);
		}
	}

	const isMutating = pendingAction !== null;

	return (
		<section className="coding-workers" data-testid="coding-workers">
			<header className="coding-workers__header">
				<h3>{t("workspace.codingWorkersTitle")}</h3>
				<p>{t("workspace.codingWorkersDescription")}</p>
			</header>
			<div className="coding-workers__summary">
				<p data-testid="coding-worker-control-root">
					<strong>{t("workspace.codingWorkersControlRoot")}: </strong>
					<code>
						{controlRoot || t("workspace.codingWorkersControlRootUnavailable")}
					</code>
				</p>
				<p data-testid="coding-worker-target-hint">
					{t("workspace.codingWorkersTargetSummary")}
				</p>
			</div>
			<form
				className="coding-workers__form"
				data-testid="coding-worker-create"
				onSubmit={(event) => {
					event.preventDefault();
					void createWorker();
				}}
				aria-busy={isMutating}
			>
				<div className="coding-workers__form-grid">
					<div
						className="coding-workers__provider"
						data-testid="coding-worker-provider"
					>
						<span>{t("workspace.codingWorkersCodingBrain")}</span>
						<strong>Codex</strong>
					</div>
					<label>
						{coursePreset
							? t("workspace.codingWorkersCourseTarget")
							: t("workspace.codingWorkersTaskWorkspace")}
						<input
							data-testid="coding-worker-worktree"
							value={worktree}
							onChange={(event) => setWorktree(event.target.value)}
							placeholder={t("workspace.codingWorkersWorkspaceExample")}
							disabled={isMutating}
						/>
					</label>
					<label className="coding-workers__task-field">
						{t("workspace.codingWorkersTaskRequest")}
						<textarea
							data-testid="coding-worker-task"
							value={task}
							onChange={(event) => setTask(event.target.value)}
							disabled={isMutating}
						/>
					</label>
				</div>
				<fieldset
					className="coding-workers__course-settings"
					disabled={isMutating}
				>
					<legend>{t("workspace.codingWorkersCourseSettings")}</legend>
					<label className="coding-workers__course-toggle">
						<input
							type="checkbox"
							data-testid="coding-worker-jeonju-course-preset"
							checked={coursePreset}
							onChange={(event) => {
								const enabled = event.target.checked;
								setCoursePreset(enabled);
								if (enabled && !worktree && courseTarget)
									setWorktree(courseTarget.workspacePath);
							}}
						/>
						{t("workspace.codingWorkersCourseMode")}
					</label>
					{coursePreset && (
						<div className="coding-workers__course-content">
							<p data-testid="coding-worker-course-mode-hint">
								{t("workspace.codingWorkersCourseSummary")}
							</p>
							<p data-testid="coding-worker-course-target-hint">
								{t("workspace.codingWorkersCourseTargetHint")}
							</p>
							<output
								className="coding-workers__course-target-status"
								data-testid="coding-worker-course-target-status"
							>
								{courseTarget ? (
									<>
										<strong>
											{t("workspace.codingWorkersCourseTargetPending")}
										</strong>
										<code data-testid="coding-worker-course-target-saved">
											{courseTarget.workspacePath}
										</code>
										<span>{courseTarget.allowedFiles.join(", ")}</span>
									</>
								) : (
									t("workspace.codingWorkersCourseTargetNone")
								)}
							</output>
							<button
								type="button"
								className="coding-workers__secondary-action"
								data-testid="coding-worker-save-course-target"
								onClick={() => void saveCourseTarget()}
							>
								{pendingAction === "save-course-target"
									? t("workspace.codingWorkersSavePending")
									: t("workspace.codingWorkersSaveCourseTarget")}
							</button>
						</div>
					)}
				</fieldset>
				<div className="coding-workers__form-actions">
					<button
						type="submit"
						className="coding-workers__primary-action"
						data-testid="coding-worker-start"
						disabled={isMutating}
					>
						{pendingAction === "create"
							? t("workspace.codingWorkersCreatePending")
							: t("workspace.codingWorkersStart")}
					</button>
				</div>
			</form>
			{actionError && (
				<p role="alert" data-testid="coding-worker-error">
					{actionError}
				</p>
			)}
			{connectionError && (
				<output
					className="coding-workers__connection-error"
					data-testid="coding-worker-connection-error"
				>
					{connectionError}
				</output>
			)}
			<div className="coding-workers__list" aria-live="polite">
				{workers.length === 0 ? (
					<p
						className="coding-workers__empty"
						data-testid="coding-workers-empty"
					>
						{t("workspace.codingWorkersEmpty")}
					</p>
				) : (
					workers.map((worker) => (
						<article
							className={`coding-workers__card coding-workers__card--${worker.state}`}
							key={worker.id}
							data-testid={`coding-worker-${worker.id}`}
						>
							<header>
								<strong>{worker.provider}</strong>
								<span
									className="coding-workers__state"
									data-testid={`coding-worker-state-${worker.id}`}
																																																																																																																			data-worker-state={worker.state}
								>
									{workerStateLabel(worker)}
								</span>
							</header>
							<dl>
								<div>
									<dt>{t("workspace.codingWorkersTaskWorkspace")}</dt>
									<dd>
										<code>{worker.worktree}</code>
									</dd>
								</div>
								<div>
									<dt>{t("workspace.codingWorkersTaskRequest")}</dt>
									<dd>{worker.task}</dd>
								</div>
							</dl>
							{worker.executionMode === "selected_workspace" && (
								<p
									className="coding-workers__boundary"
									data-testid={`coding-worker-course-boundary-${worker.id}`}
								>
									{t("workspace.codingWorkersCourseBoundary")}:{" "}
									{worker.allowedFiles.join(", ")}
								</p>
							)}
							{worker.verificationSummary && (
								<p
									className="coding-workers__verification"
									data-testid={`coding-worker-verification-${worker.id}`}
								>
									{t("workspace.codingWorkersVerification")}:{" "}
									{worker.verificationSummary}
								</p>
							)}
							<footer>
								<time dateTime={worker.updatedAt} title={worker.updatedAt}>
									{t("workspace.codingWorkersUpdated")}:{" "}
									{formatUpdatedAt(worker.updatedAt)}
								</time>
								<div className="coding-workers__card-actions">
									{canCancelCodingWorker(worker) && (
										<button
											type="button"
											data-testid={`coding-worker-cancel-${worker.id}`}
											disabled={isMutating}
											onClick={() => void cancelWorker(worker)}
										>
											{pendingAction === `cancel:${worker.id}`
												? t("workspace.codingWorkersCancelPending")
												: t("workspace.codingWorkersCancel")}
										</button>
									)}
									{canResumeCodingWorker(worker) && (
										<button
											type="button"
											data-testid={`coding-worker-resume-${worker.id}`}
											disabled={isMutating}
											onClick={() => void resumeWorker(worker)}
										>
											{pendingAction === `resume:${worker.id}`
												? t("workspace.codingWorkersResumePending")
												: t("workspace.codingWorkersResume")}
										</button>
									)}
								</div>
							</footer>
						</article>
					))
				)}
			</div>
		</section>
	);
}
