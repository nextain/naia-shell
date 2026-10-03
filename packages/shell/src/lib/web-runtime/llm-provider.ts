import { registerLlmProvider } from "../llm/registry";
import { WEB_LLM_MODEL_ID } from "./webllm-model";

export function registerWebLlmProvider(): void {
	registerLlmProvider({
		id: "webllm",
		name: "WebLLM",
		description: "브라우저 WebGPU 로컬 모델",
		requiresApiKey: false,
		isLocal: true,
		defaultModel: WEB_LLM_MODEL_ID,
		models: [
			{
				id: WEB_LLM_MODEL_ID,
				label: "Qwen3 8B (4bit)",
				capabilities: ["llm"],
			},
		],
	});
}
