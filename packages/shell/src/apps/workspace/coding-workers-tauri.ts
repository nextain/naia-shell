import { invoke } from "@tauri-apps/api/core";
import type {
	CodingWorker,
	CodingWorkersAdapter,
	CreateCodingWorkerRequest,
} from "./coding-workers";

interface TauriCodingWorker {
	id: string;
	provider: "codex";
	worktree: string;
	task: string;
	state: CodingWorker["state"];
	updatedAt: string;
	resumable: boolean;
}

function asWorker(value: TauriCodingWorker): CodingWorker {
	return {
		id: value.id,
		provider: value.provider,
		worktree: value.worktree,
		task: value.task,
		state: value.state,
		updatedAt: value.updatedAt,
		resumable: value.resumable,
	};
}

/** The only frontend boundary that calls the paired Agent coding-job RPCs. */
export const tauriCodingWorkersAdapter: CodingWorkersAdapter = {
	async list() {
		return (await invoke<TauriCodingWorker[]>("list_coding_jobs")).map(asWorker);
	},
	async create(request: CreateCodingWorkerRequest) {
		return asWorker(
			await invoke<TauriCodingWorker>("start_coding_job", {
				workspacePath: request.worktree,
				task: request.task,
			}),
		);
	},
	async cancel(workerId: string) {
		return asWorker(
			await invoke<TauriCodingWorker>("cancel_coding_job", { jobId: workerId }),
		);
	},
	async resume(workerId: string) {
		return asWorker(
			await invoke<TauriCodingWorker>("resume_coding_job", { jobId: workerId }),
		);
	},
};
