import type { AppConfig } from "../config";
import { isKioskDemo } from "./flag";
import { WEB_LLM_MODEL_ID, isWebLlmModelId } from "../web-runtime/webllm-model";

export const KIOSK_DEMO_LLM_PROVIDER = "nextain" as const;
export const KIOSK_DEMO_LLM_MODEL = "gpt-5.6-luna" as const;
export const KIOSK_DEMO_THINKING_LEVEL = "low" as const;
export const KIOSK_DEMO_ENABLE_TOOLS = true as const;
export const KIOSK_DEMO_ENVIRONMENT_AWARENESS = "off" as const;
export const KIOSK_DEMO_ENVIRONMENT_TERMINAL_INPUT = false as const;
export const KIOSK_DEMO_LLM_FALLBACK_MODELS = [
	"deepseek-v4-pro",
	"deepseek-v4-flash",
	"solar-pro4",
	"solar-mini",
] as const;
export const KIOSK_DEMO_TTS_PROVIDER = "nextain" as const;
// 지나 고유 목소리(naia-voice:tpl-jina)가 운영 게이트웨이에 등록된 뒤 이 상수 한 곳만 바꾼다.
export const KIOSK_DEMO_TTS_VOICE = "ko-KR-Neural2-A" as const;
let kioskGatewayServedModels: ReadonlySet<string> | null = null;

export function setKioskDemoGatewayServedModels(
	gatewayServed: ReadonlySet<string> | null,
): void {
	kioskGatewayServedModels = gatewayServed;
}

/**
 * 키오스크 시연의 주 모델은 크레딧 보호를 위해 gpt-5.6-luna로 고정하고,
 * 게이트웨이 /v1/models 목록에 luna가 없을 때만 대체 모델로 내린다.
 */
export function resolveKioskDemoMainModel(
	gatewayServed?: ReadonlySet<string> | null,
): string {
	const served =
		gatewayServed === undefined ? kioskGatewayServedModels : gatewayServed;
	if (!served || served.has(KIOSK_DEMO_LLM_MODEL)) {
		return KIOSK_DEMO_LLM_MODEL;
	}
	return (
		KIOSK_DEMO_LLM_FALLBACK_MODELS.find((id) => served.has(id)) ??
		KIOSK_DEMO_LLM_MODEL
	);
}

/**
 * 키오스크 시연 판에서는 저장값(terra·다른 프로바이더·생각 세기·도구·작업 표면 설정 등)과 무관하게
 * 주 공급자("nextain"), 주 모델(resolveKioskDemoMainModel), 생각 세기(KIOSK_DEMO_THINKING_LEVEL = "low"),
 * 도구 사용(KIOSK_DEMO_ENABLE_TOOLS = true), 작업 표면 인지(KIOSK_DEMO_ENVIRONMENT_AWARENESS = "off"),
 * 터미널 직접 입력(KIOSK_DEMO_ENVIRONMENT_TERMINAL_INPUT = false)을 한 곳에서 강제한다.
 */
export const KIOSK_LOCAL_ANSWER_STORAGE_KEY = "naia-kiosk-local-answer" as const;

export const isKioskLocalAnswerEnabled = (): boolean => {
	if (!isKioskDemo()) return false;
	try {
		if (typeof localStorage === "undefined") return false;
		return localStorage.getItem(KIOSK_LOCAL_ANSWER_STORAGE_KEY) === "1";
	} catch {
		return false;
	}
};

export const setKioskLocalAnswerEnabled = (enabled: boolean): void => {
	try {
		if (typeof localStorage === "undefined") return;
		if (enabled) {
			localStorage.setItem(KIOSK_LOCAL_ANSWER_STORAGE_KEY, "1");
		} else {
			localStorage.removeItem(KIOSK_LOCAL_ANSWER_STORAGE_KEY);
		}
	} catch {
		// ignore storage errors
	}
};

export function applyKioskDemoMainModel<T extends Partial<AppConfig>>(
	config: T,
	gatewayServed?: ReadonlySet<string> | null,
): T {
	if (!isKioskDemo()) return config;
	const useLocalWebLlm =
		isKioskLocalAnswerEnabled() && config.provider === "webllm";
	const provider = useLocalWebLlm ? "webllm" : KIOSK_DEMO_LLM_PROVIDER;
	const model = useLocalWebLlm
		? typeof config.model === "string" && isWebLlmModelId(config.model)
			? config.model
			: WEB_LLM_MODEL_ID
		: resolveKioskDemoMainModel(gatewayServed);
	const currentMain =
		config.llmRoles?.main && typeof config.llmRoles.main === "object"
			? config.llmRoles.main
			: undefined;
	const { inherit: _ignoredInherit, ...restMain } = currentMain ?? {};
	const next = {
		...config,
		provider,
		model,
		enableTools: KIOSK_DEMO_ENABLE_TOOLS,
		thinkingLevel: KIOSK_DEMO_THINKING_LEVEL,
		enableThinking: (KIOSK_DEMO_THINKING_LEVEL as string) !== "off",
		environmentAwareness: KIOSK_DEMO_ENVIRONMENT_AWARENESS,
		environmentTerminalInput: KIOSK_DEMO_ENVIRONMENT_TERMINAL_INPUT,
		llmRoles: {
			...config.llmRoles,
			main: {
				...restMain,
				provider,
				model,
				thinkingLevel: KIOSK_DEMO_THINKING_LEVEL,
			},
		},
	};
	if ("mainModelThinkingLevels" in (next as Record<string, unknown>)) {
		delete (next as Record<string, unknown>).mainModelThinkingLevels;
	}
	return next;
}

