export const WEB_LLM_MODEL_ID = "Qwen3-8B-q4f16_1-MLC";
export const WEB_LLM_FALLBACK_F16 = "Qwen3-4B-q4f16_1-MLC";
export const WEB_LLM_FALLBACK_F32 = "Qwen3-4B-q4f32_1-MLC";

export const WEB_LLM_MODEL_IDS = [
	WEB_LLM_MODEL_ID,
	WEB_LLM_FALLBACK_F16,
	WEB_LLM_FALLBACK_F32,
] as const;

export type WebLlmModelId = (typeof WEB_LLM_MODEL_IDS)[number];

export function isWebLlmModelId(value: unknown): value is WebLlmModelId {
	return (
		typeof value === "string" &&
		(WEB_LLM_MODEL_IDS as readonly string[]).includes(value)
	);
}

export function modelNeedsShaderF16(id: WebLlmModelId): boolean {
	return id.includes("q4f16");
}

export const WEB_LLM_MODEL_PREF_KEY = "naia-web-llm-model";

export function readWebLlmModelPreference(
	storage: { getItem(key: string): string | null } | null,
	buildOverride?: string,
): WebLlmModelId {
	if (storage) {
		try {
			const saved = storage.getItem(WEB_LLM_MODEL_PREF_KEY);
			if (isWebLlmModelId(saved)) {
				return saved;
			}
		} catch {
			// getItem 이 던지면 저장값이 없는 것으로 본다.
		}
	}
	if (isWebLlmModelId(buildOverride)) {
		return buildOverride;
	}
	return WEB_LLM_MODEL_ID;
}

export const WEB_LLM_MODEL_LABELS: Record<WebLlmModelId, string> = {
	"Qwen3-8B-q4f16_1-MLC": "Qwen3 8B (4bit f16)",
	"Qwen3-4B-q4f16_1-MLC": "Qwen3 4B (4bit f16)",
	"Qwen3-4B-q4f32_1-MLC": "Qwen3 4B (4bit f32)",
};
