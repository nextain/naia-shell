import { useEffect, useState } from "react";
import {
	type CodingWorker,
	CodingWorkerApiUnavailableError,
	CourseWorkspaceNotReadyError,
	type CodingWorkersAdapter,
	canCancelCodingWorker,
	canResumeCodingWorker,
	isWorktreeOccupied,
} from "./coding-workers";

interface CodingWorkersPanelProps {
	adapter: CodingWorkersAdapter;
	initialWorkers?: CodingWorker[];
}

function safeWorkerError(error: unknown): string {
	if (error instanceof CodingWorkerApiUnavailableError) {
		return "Coding worker service is not connected yet.";
	}
	if (error instanceof CourseWorkspaceNotReadyError) {
		return "Course mode requires a clean Git root with a remote. Review the selected folder and try again.";
	}
	// Adapter failures can include provider output or credentials. Never render it.
	return "Coding worker request could not be completed.";
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
}: CodingWorkersPanelProps) {
	const [workers, setWorkers] = useState<CodingWorker[]>(initialWorkers);
	const [worktree, setWorktree] = useState("");
	const [task, setTask] = useState("");
	const [coursePreset, setCoursePreset] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		const refresh = async () => {
			try {
				const listed = await adapter.list();
				if (active) setWorkers(listed);
			} catch (reason) {
				if (active) setError(safeWorkerError(reason));
			}
		};
		void refresh();
		const interval = window.setInterval(() => void refresh(), 2_000);
		return () => {
			active = false;
			window.clearInterval(interval);
		};
	}, [adapter]);

	async function createWorker() {
		const normalizedWorktree = worktree.trim();
		const normalizedTask = task.trim();
		if (!normalizedWorktree || !normalizedTask) {
			setError("Worktree and task are required.");
			return;
		}
		if (isWorktreeOccupied(workers, normalizedWorktree)) {
			setError("This worktree already has an active coding worker.");
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

	return (
		<section className="coding-workers" data-testid="coding-workers">
			<header className="coding-workers__header">
				<h3>Coding Workers</h3>
				<p>Codex workers require a paired Agent lifecycle service.</p>
			</header>
			<div className="coding-workers__form" data-testid="coding-worker-create">
				<label>
					Provider
					<select data-testid="coding-worker-provider" value="codex" disabled>
						<option value="codex">Codex</option>
					</select>
				</label>
				<label>
					Workspace root (a dedicated worktree is created automatically)
					<input
						data-testid="coding-worker-worktree"
						value={worktree}
						onChange={(event) => setWorktree(event.target.value)}
						placeholder="D:\\alpha-adk\\projects\\naia-shell"
					/>
				</label>
				<label>
					Task
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
						onChange={(event) => setCoursePreset(event.target.checked)}
					/>
					Jeonju course mode — work directly in this selected Git root; only index.html and hero.svg may change.
				</label>
				<button
					type="button"
					data-testid="coding-worker-start"
					onClick={() => void createWorker()}
				>
					Start worker
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
								Course mode: {worker.allowedFiles.join(", ")}
							</p>
						)}
						{worker.verificationSummary && (
							<p data-testid={`coding-worker-verification-${worker.id}`}>
								Verification: {worker.verificationSummary}
							</p>
						)}
						<time dateTime={worker.updatedAt}>{worker.updatedAt}</time>
						{canCancelCodingWorker(worker) && (
							<button
								type="button"
								data-testid={`coding-worker-cancel-${worker.id}`}
								onClick={() => void cancelWorker(worker)}
							>
								Cancel
							</button>
						)}
						{canResumeCodingWorker(worker) && (
							<button
								type="button"
								data-testid={`coding-worker-resume-${worker.id}`}
								onClick={() => void resumeWorker(worker)}
							>
								Resume
							</button>
						)}
					</article>
				))}
			</div>
		</section>
	);
}
