import { registerLlmProvider } from "../llm/registry";
import {
	WEB_LLM_MODEL_ID,
	WEB_LLM_MODEL_IDS,
	WEB_LLM_MODEL_LABELS,
} from "./webllm-model";

export function registerWebLlmProvider(): void {
	registerLlmProvider({
		id: "webllm",
		name: "WebLLM",
		description: "브라우저 WebGPU 로컬 모델",
		requiresApiKey: false,
		isLocal: true,
		defaultModel: WEB_LLM_MODEL_ID,
		models: WEB_LLM_MODEL_IDS.map((id) => ({
			id,
			label: WEB_LLM_MODEL_LABELS[id],
			capabilities: ["llm"],
		})),
	});
}
