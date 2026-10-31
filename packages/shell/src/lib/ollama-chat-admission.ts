import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_OLLAMA_HOST } from "./config";
import type { TranslationKey } from "./i18n";
import type { OllamaRuntimeSnapshot } from "./ollama-runtime";

export class OllamaRuntimeAdmissionError extends Error {
	constructor(readonly reasonCode: string) {
		super(`ollama_runtime_blocked:${reasonCode}`);
		this.name = "OllamaRuntimeAdmissionError";
	}
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

function isLocalOllamaHost(host: string | undefined): boolean {
	try {
		const parsed = new URL(host?.trim() || DEFAULT_OLLAMA_HOST);
		const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
		return (
			hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
		);
	} catch {
		return false;
	}
}

export async function assertOllamaChatAdmitted(
	host: string | undefined,
): Promise<void> {
	if (!isLocalOllamaHost(host)) return;
	const snapshot = await invoke<OllamaRuntimeSnapshot>(
		"ollama_runtime_status",
		{
			host: host || DEFAULT_OLLAMA_HOST,
			deviceId: null,
		},
	);
	const ready =
		snapshot.serverState === "ready_managed" ||
		snapshot.serverState === "ready_external_local";
	if (
		ready &&
		snapshot.reservation?.kind === "local_llm" &&
		snapshot.reservation.status === "running"
	) {
		return;
	}
	throw new OllamaRuntimeAdmissionError(
		snapshot.reservation?.reasonCode ??
			snapshot.error?.reasonCode ??
			snapshot.error?.code ??
			snapshot.serverState ??
			"reservation_denied",
	);
}
