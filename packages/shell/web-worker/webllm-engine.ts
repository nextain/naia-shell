import { CreateMLCEngine } from "@mlc-ai/web-llm";
import type { WebLLMEngineLike } from "@naia-agent/composition/browser-agent.js";

export function createWebLLMEngine(
	modelId: string,
	onProgress: (p: { progress: number; text: string }) => void,
): Promise<WebLLMEngineLike> {
	return CreateMLCEngine(modelId, {
		initProgressCallback: (report) => {
			onProgress({ progress: report.progress, text: report.text });
		},
	});
}
