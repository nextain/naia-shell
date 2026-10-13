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
