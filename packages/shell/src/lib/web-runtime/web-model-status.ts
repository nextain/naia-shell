import {
	WEB_LLM_FALLBACK_F16,
	WEB_LLM_FALLBACK_F32,
	WEB_LLM_MODEL_ID,
	type WebLlmModelId,
} from "./webllm-model";

export type WebModelPhase = "checking" | "loading" | "ready" | "error";
export type WebModelErrorKind =
	| "no-webgpu"
	| "no-shader-f16"
	| "device-lost"
	| "load-failed";

export interface WebGpuAdapterSummary {
	vendor: string;
	architecture: string;
	description: string;
}

export interface WebModelStatus {
	phase: WebModelPhase;
	model: WebLlmModelId;
	progress: number; // 0..1
	adapter?: WebGpuAdapterSummary;
	shaderF16?: boolean;
	errorKind?: WebModelErrorKind;
	errorMessage?: string;
}

let currentStatus: WebModelStatus = {
	phase: "checking",
	model: WEB_LLM_MODEL_ID,
	progress: 0,
};

const listeners = new Set<() => void>();

export function getWebModelStatus(): WebModelStatus {
	return currentStatus;
}

export function subscribeWebModelStatus(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function setWebModelStatus(patch: Partial<WebModelStatus>): void {
	const nextPhase = patch.phase ?? currentStatus.phase;
	const nextStatus: WebModelStatus = {
		...currentStatus,
		...patch,
	};
	if (nextPhase !== "error") {
		delete nextStatus.errorKind;
		delete nextStatus.errorMessage;
	}
	currentStatus = nextStatus;
	for (const listener of listeners) {
		listener();
	}
}

export function resetWebModelStatusForTests(): void {
	currentStatus = {
		phase: "checking",
		model: WEB_LLM_MODEL_ID,
		progress: 0,
	};
	listeners.clear();
}

export function isWebSendBlocked(status: WebModelStatus): boolean {
	return status.phase !== "ready";
}

export function fallbackModelFor(
	status: WebModelStatus,
): WebLlmModelId | null {
	if (status.model !== WEB_LLM_MODEL_ID || status.errorKind === "no-webgpu") {
		return null;
	}
	return status.shaderF16 === true
		? WEB_LLM_FALLBACK_F16
		: WEB_LLM_FALLBACK_F32;
}

export function errorKindFromEngineErrorName(
	name: string | undefined,
): WebModelErrorKind {
	if (name === "WebGPUNotAvailableError" || name === "WebGPUNotFoundError") {
		return "no-webgpu";
	}
	if (name === "ShaderF16SupportError") {
		return "no-shader-f16";
	}
	if (name === "DeviceLostError") {
		return "device-lost";
	}
	return "load-failed";
}
