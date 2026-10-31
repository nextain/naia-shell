import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_OLLAMA_HOST } from "./config";
import type { TranslationKey } from "./i18n";

export interface OllamaRuntimeSnapshot {
	state: string;
	serverState: string;
	ownership: string;
	installedVersion: string | null;
	installedVersions: string[];
	modelCount: number | null;
	reservation: {
		kind: string | null;
		status: "not_requested" | "starting" | "running" | "denied" | string;
		bytes: number | null;
		reasonCode?: string | null;
	};
	operationId: string | null;
	phase: string | null;
	error: {
		code: string;
		stage: string;
		retryable: boolean;
		reasonCode?: string | null;
	} | null;
}

export interface QwenModelCandidate {
	id: string;
	displayName: string;
	tag: string;
	publishedSize: string;
	publishedSizeBytes: number | null;
	minimumFreeBytes: number | null;
	quantization: string;
	sourceUrl: string;
	license: string;
	licenseUrl: string;
	publishedContextTokens: number;
	parameterSize: string;
}

export interface QwenModelPolicy {
	candidates: QwenModelCandidate[];
	defaultModelTag: string | null;
	contextDefaultTokens: number | null;
	pullStartPolicy: string | null;
	modelStoreOverride: string | null;
	automaticSelectionPolicy: string | null;
	diskSpaceMultiplier: number | null;
	modelStoreAvailableBytes: number | null;
	showLicense: boolean | null;
	measuredPeakVramBytes: number | null;
	selectionHeadroomBytes: number | null;
}

export type ModelPullState =
	| "absent"
	| "preflight"
	| "pulling"
	| "paused"
	| "failed"
	| "verifying"
	| "ready";

export type ModelPullErrorCode =
	| "model_tag_unknown"
	| "model_confirmation_required"
	| "managed_server_required"
	| "pull_already_active"
	| "model_store_unresolved"
	| "disk_space_low"
	| "disk_margin_unset"
	| "pull_http_failed"
	| "pull_stream_malformed"
	| "model_tag_absent"
	| "model_digest_mismatch"
	| "model_details_mismatch"
	| "pull_cancel_timeout"
	| "pull_operation_unknown"
	| "accelerator_mapping_unverified"
	| "model_pull_active";

export interface ModelPullError {
	code: ModelPullErrorCode;
	stage: string;
	retryable: boolean;
	operationId?: string;
	requiredBytes?: number;
	availableBytes?: number;
}

export interface ModelPullSnapshot {
	operationId: string | null;
	tag: string;
	state: ModelPullState;
	stage: string;
	digest: string | null;
	error: ModelPullError | null;
}

export interface ModelPullProgress {
	operationId: string;
	tag: string;
	phase: string;
	digest: string | null;
	completed: number | null;
	total: number | null;
	layerPercent: number | null;
}

export interface ModelPullStartResponse {
	operationId: string;
	snapshot: ModelPullSnapshot;
}

export function ollamaAdmissionMessageKey(reasonCode: string): TranslationKey {
	switch (reasonCode) {
		case "same_device_conflict":
			return "settings.ollamaReservationSameDeviceConflict";
		case "policy_undecided":
			return "settings.ollamaReservationPolicyUndecided";
		case "device_selection_required":
			return "settings.ollamaDeviceSelectionRequired";
		case "device_mapping_unverified":
			return "settings.ollamaDeviceMappingUnverified";
		case "device_not_found":
			return "settings.ollamaDeviceNotFound";
		case "inventory_unavailable":
		case "accelerator_inventory_unavailable":
			return "settings.ollamaInventoryUnavailable";
		case "available_vram_unknown":
			return "settings.ollamaAvailableVramUnknown";
		case "insufficient_available_vram":
			return "settings.ollamaInsufficientVram";
		case "workload_already_reserved":
			return "settings.ollamaWorkloadAlreadyReserved";
		case "reservation_lease_lost":
			return "settings.ollamaReservationLeaseLost";
		default:
			return "settings.ollamaChatBlocked";
	}
}

export function ollamaServerStateMessageKey(
	serverState: string,
): TranslationKey {
	switch (serverState) {
		case "not_installed":
			return "settings.ollamaStateNotInstalled";
		case "checking_host":
			return "settings.ollamaStateCheckingHost";
		case "external_unavailable":
			return "settings.ollamaStateExternalUnavailable";
		case "installing":
			return "settings.ollamaStateInstalling";
		case "installed_stopped":
			return "settings.ollamaStateInstalledStopped";
		case "reserving":
			return "settings.ollamaStateReserving";
		case "starting":
			return "settings.ollamaStateStarting";
		case "ready_managed":
			return "settings.ollamaStateReadyManaged";
		case "ready_external_local":
			return "settings.ollamaStateReadyExternalLocal";
		case "connected_unreserved":
			return "settings.ollamaStateConnectedUnreserved";
		case "ready_remote":
			return "settings.ollamaStateReadyRemote";
		case "stopping":
			return "settings.ollamaStateStopping";
		case "stopped":
			return "settings.ollamaStateStopped";
		default:
			return "settings.ollamaStateFailed";
	}
}

export function ollamaModelPullStateMessageKey(state: string): TranslationKey {
	switch (state) {
		case "absent":
			return "settings.ollamaPullStateAbsent";
		case "preflight":
			return "settings.ollamaPullStatePreflight";
		case "pulling":
			return "settings.ollamaPullStatePulling";
		case "paused":
			return "settings.ollamaPullStatePaused";
		case "failed":
			return "settings.ollamaPullStateFailed";
		case "verifying":
			return "settings.ollamaPullStateVerifying";
		case "ready":
			return "settings.ollamaPullStateReady";
		default:
			return "settings.ollamaPullStateUnknown";
	}
}

export function ollamaModelPullErrorMessageKey(code: string): TranslationKey {
	switch (code) {
		case "model_tag_unknown":
			return "settings.ollamaPullErrorUnknownModel";
		case "model_confirmation_required":
			return "settings.ollamaPullErrorConfirmationRequired";
		case "managed_server_required":
			return "settings.ollamaPullErrorManagedServerRequired";
		case "pull_already_active":
			return "settings.ollamaPullErrorBusy";
		case "model_store_unresolved":
			return "settings.ollamaPullErrorStoreUnresolved";
		case "disk_space_low":
			return "settings.ollamaPullErrorDiskSpaceLow";
		case "disk_margin_unset":
			return "settings.ollamaPullErrorPolicyPending";
		case "pull_http_failed":
		case "pull_stream_malformed":
			return "settings.ollamaPullErrorTransfer";
		case "model_tag_absent":
		case "model_digest_mismatch":
		case "model_details_mismatch":
			return "settings.ollamaPullErrorVerification";
		case "pull_cancel_timeout":
		case "pull_operation_unknown":
			return "settings.ollamaPullErrorCancel";
		case "accelerator_mapping_unverified":
			return "settings.ollamaPullErrorAccelerator";
		case "model_pull_active":
			return "settings.ollamaPullErrorBusy";
		default:
			return "settings.ollamaPullErrorUnknown";
	}
}

export function isManagedOllamaHost(host: string | undefined): boolean {
	try {
		const configured = new URL(host?.trim() || DEFAULT_OLLAMA_HOST);
		const expected = new URL(DEFAULT_OLLAMA_HOST);
		return (
			configured.protocol === expected.protocol &&
			configured.hostname.toLowerCase() === expected.hostname.toLowerCase() &&
			configured.port === expected.port &&
			configured.pathname === expected.pathname
		);
	} catch {
		return false;
	}
}

export async function fetchOllamaRuntimeSnapshot(
	host: string | undefined,
	deviceId?: string | null,
): Promise<OllamaRuntimeSnapshot> {
	return invoke<OllamaRuntimeSnapshot>("ollama_runtime_status", {
		host: host || DEFAULT_OLLAMA_HOST,
		deviceId: deviceId ?? null,
	});
}

export function fetchOllamaModelCatalog(): Promise<QwenModelPolicy> {
	return invoke<QwenModelPolicy>("ollama_model_catalog_list");
}

export function fetchOllamaModelPullStatus(
	tag: string,
): Promise<ModelPullSnapshot> {
	return invoke<ModelPullSnapshot>("ollama_model_pull_status", { tag });
}

export function startOllamaModelPull(
	tag: string,
	confirmedTag: string,
): Promise<ModelPullStartResponse> {
	return invoke<ModelPullStartResponse>("ollama_model_pull_start", {
		tag,
		confirmedTag,
	});
}

export function cancelOllamaModelPull(
	operationId: string,
): Promise<ModelPullSnapshot> {
	return invoke<ModelPullSnapshot>("ollama_model_pull_cancel", {
		operationId,
	});
}

export function retryOllamaModelPull(
	tag: string,
): Promise<ModelPullStartResponse> {
	return invoke<ModelPullStartResponse>("ollama_model_pull_retry", { tag });
}
