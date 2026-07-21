/**
 * Shell-side contract for a coding-worker service.
 *
 * This is deliberately independent of the Agent gRPC schema.  Until that
 * schema is paired, the default adapter rejects every lifecycle mutation so
 * the UI cannot fabricate a worker or confuse a terminal with a worker.
 */
export const CODING_WORKER_STATES = [
	"queued",
	"running",
	"cancelling",
	"cancelled",
	"completed",
	"failed",
] as const;

export type CodingWorkerState = (typeof CODING_WORKER_STATES)[number];

export interface CodingWorker {
	id: string;
	provider: "codex";
	worktree: string;
	task: string;
	state: CodingWorkerState;
	updatedAt: string;
	/** The Agent exposes only whether a durable checkpoint exists, never its id. */
	resumable: boolean;
}

export interface CreateCodingWorkerRequest {
	provider: "codex";
	worktree: string;
	task: string;
}

export interface CodingWorkersAdapter {
	list(): Promise<CodingWorker[]>;
	create(request: CreateCodingWorkerRequest): Promise<CodingWorker>;
	cancel(workerId: string): Promise<CodingWorker>;
	resume(workerId: string): Promise<CodingWorker>;
}

export class CodingWorkerApiUnavailableError extends Error {
	constructor() {
		super("Coding-worker API is not paired with the Agent runtime.");
		this.name = "CodingWorkerApiUnavailableError";
	}
}

/** Default boundary until the paired Agent lifecycle RPC is available. */
export const unavailableCodingWorkersAdapter: CodingWorkersAdapter = {
	async list() {
		throw new CodingWorkerApiUnavailableError();
	},
	async create() {
		throw new CodingWorkerApiUnavailableError();
	},
	async cancel() {
		throw new CodingWorkerApiUnavailableError();
	},
	async resume() {
		throw new CodingWorkerApiUnavailableError();
	},
};

export function isWorktreeOccupied(
	workers: readonly CodingWorker[],
	worktree: string,
): boolean {
	return workers.some(
		(worker) =>
			worker.worktree === worktree &&
			(worker.state === "queued" ||
				worker.state === "running" ||
				worker.state === "cancelling"),
	);
}

export function canResumeCodingWorker(worker: CodingWorker): boolean {
	return (
		worker.resumable &&
		(worker.state === "cancelled" || worker.state === "failed")
	);
}

export function canCancelCodingWorker(worker: CodingWorker): boolean {
	return worker.state === "queued" || worker.state === "running";
}
