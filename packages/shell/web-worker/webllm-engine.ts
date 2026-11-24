import { CreateMLCEngine } from "@mlc-ai/web-llm";
import type { WebLLMEngineLike } from "@naia-agent/composition/browser-agent.js";

// Prebuilt Qwen3 configs ship a 4096-token window, which a single character
// card plus system prompt already overflows. 8192 fits a card and a short
// conversation while keeping the f16 KV cache near 1.2 GB for 4B.
export const WEB_LLM_CONTEXT_WINDOW = 8192;

export function createWebLLMEngine(
	modelId: string,
	onProgress: (p: { progress: number; text: string }) => void,
): Promise<WebLLMEngineLike> {
	return CreateMLCEngine(
		modelId,
		{
			initProgressCallback: (report) => {
				onProgress({ progress: report.progress, text: report.text });
			},
		},
		{ context_window_size: WEB_LLM_CONTEXT_WINDOW },
	);
}
