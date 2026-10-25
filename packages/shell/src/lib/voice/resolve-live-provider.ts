import type { LiveProviderId } from "./types";

/** Resolve live VoiceSession adapter. Removed (#603): gemini-live / openai-realtime / naia. */
export function resolveLiveProvider(opts: {
	isOmni: boolean;
	provider?: string;
	model?: string;
	hasNaiaKey: boolean;
}): LiveProviderId {
	const model = opts.model ?? "";
	if (
		opts.isOmni &&
		(model === "azure-realtime" || model.startsWith("azure-realtime"))
	) {
		return "azure-voice-live";
	}
	if (opts.isOmni && model.startsWith("naia-")) {
		return "naia-omni";
	}
	if (opts.isOmni && opts.provider === "vllm") {
		return "naia-omni";
	}
	if (opts.provider === "vllm") {
		return "vllm-omni";
	}
	if (opts.isOmni && opts.hasNaiaKey) {
		return "azure-voice-live";
	}
	throw new Error(
		`No live voice provider for model=${model || "(none)"} provider=${opts.provider ?? "(none)"}`,
	);
}

/**
 * Whether a live voice session must have the Naia login key before connecting.
 *
 * Azure Voice Live and the cloud naia-omni gateway are Naia-account routes.
 * A user's own vLLM omni server (provider "vllm") is the retained keyless
 * direct route (FR-VOICE-CLOUD-OFF.1 keeps vLLM); the naia-omni connect path
 * dials `vllmHost` directly when no key is present. Naia Local (model
 * "naia-local") checks its own login requirement inside that connect path.
 */
export function liveVoiceRequiresNaiaKey(opts: {
	liveProvider: LiveProviderId;
	provider?: string;
}): boolean {
	if (opts.liveProvider === "azure-voice-live") return true;
	if (opts.liveProvider === "naia-omni") return opts.provider !== "vllm";
	return false;
}
