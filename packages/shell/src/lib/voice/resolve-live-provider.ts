import type { LiveProviderId } from "./types";

export function resolveLiveProvider(opts: {
	isOmni: boolean;
	provider?: string;
	model?: string;
	hasNaiaKey: boolean;
}): LiveProviderId {
	const model = opts.model ?? "";
	if (opts.isOmni && (model === "azure-realtime" || model.startsWith("azure-realtime"))) {
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
	if (opts.provider === "openai") {
		return "openai-realtime";
	}
	if (opts.hasNaiaKey) {
		return "naia";
	}
	return "gemini-live";
}
