import { t } from "../i18n";
import { isKioskDemo } from "../kiosk-demo/flag";
import { registerLlmProvider, unregisterLlmProvider } from "../llm/registry";
import {
	WEB_LLM_MODEL_ID,
	WEB_LLM_MODEL_IDS,
	formatWebLlmModelLabel,
} from "./webllm-model";

export function registerWebLlmProvider(): void {
	if (isKioskDemo()) {
		unregisterLlmProvider("webllm");
		return;
	}
	registerLlmProvider({
		id: "webllm",
		name: "WebLLM",
		description: t("webModel.providerDescription"),
		requiresApiKey: false,
		isLocal: true,
		defaultModel: WEB_LLM_MODEL_ID,
		models: WEB_LLM_MODEL_IDS.map((id) => ({
			id,
			label: formatWebLlmModelLabel(id),
			capabilities: ["llm"],
		})),
	});
}
