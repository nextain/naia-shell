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
