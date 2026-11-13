// 로그인하지 않은 상태의 LLM 기본값 (FR-LLM-LOGOUT.1, #591).
//
// 셸이 지원하는 LLM 경로는 나이아 계정·CLI·로컬 셋뿐이다. 로그인이 없을 때
// 타사 키 제공자(gemini)나 키 없는 나이아 계정(nextain)을 기본값으로 쓰면
// 첫 대화가 지원하지 않는 곳으로 나가거나 실패한다. 그래서 로그인하지 않은
// 상태의 기본값은 제공자가 빈 "LLM 없음"이다. 로컬은 직접 선택한다.

import { fetchOllamaModels, getLlmProvider } from "./registry";

export type LoggedOutLlm =
	| { provider: "ollama"; model: string }
	| { provider: ""; model: "" };

export const NO_LLM: LoggedOutLlm = { provider: "", model: "" };

/**
 * 저장된 제공자를 로그인하지 않은 상태에서도 그대로 둘지.
 * 판정은 등록부 메타데이터로만 한다. API 키도 나이아 키도 필요 없는 활성 제공자는
 * CLI 이거나 로컬이다. 제공자 id 를 여기 나열하지 않는다.
 */
export function keepsProviderWhenLoggedOut(provider: string | undefined): boolean {
	if (!provider) return false;
	const meta = getLlmProvider(provider);
	return Boolean(meta && !meta.disabled && !meta.requiresApiKey && !meta.requiresNaiaKey);
}

/** 이전 probe 호출자와 호환하되 로컬 모델을 자동 선택하지 않는다. */
export function chooseLoggedOutLlm(_probe: {
	connected: boolean;
	modelIds: readonly string[];
}): LoggedOutLlm {
	return NO_LLM;
}

/** 기존 호출자와의 인터페이스 호환용 상수. */
export const OLLAMA_PROBE_TIMEOUT_MS = 2500;

/** 로그인하지 않은 상태에서 기본 모델은 비워 둔다. */
export async function resolveLoggedOutLlm(
	_ollamaHost: string | undefined,
	_probe: typeof fetchOllamaModels = fetchOllamaModels,
	_timeoutMs: number = OLLAMA_PROBE_TIMEOUT_MS,
): Promise<LoggedOutLlm> {
	return NO_LLM;
}
