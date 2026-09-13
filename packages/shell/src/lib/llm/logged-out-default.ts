// 로그인하지 않은 상태의 LLM 기본값 (FR-LLM-LOGOUT.1, #591).
//
// 셸이 지원하는 LLM 경로는 나이아 계정·CLI·로컬 셋뿐이다. 로그인이 없을 때
// 타사 키 제공자(gemini)나 키 없는 나이아 계정(nextain)을 기본값으로 쓰면
// 첫 대화가 지원하지 않는 곳으로 나가거나 실패한다. 그래서 로그인하지 않은
// 상태의 기본값은 로컬 Ollama 이거나, 없으면 제공자가 빈 "LLM 없음"이다.

import { DEFAULT_LOCAL_LLM_MODEL, DEFAULT_OLLAMA_HOST } from "../config";
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

/** Ollama 확인 결과에서 기본 LLM 을 고른다. 부수효과 없는 순수 함수. */
export function chooseLoggedOutLlm(probe: {
	connected: boolean;
	modelIds: readonly string[];
}): LoggedOutLlm {
	if (!probe.connected || probe.modelIds.length === 0) return NO_LLM;
	const model = probe.modelIds.includes(DEFAULT_LOCAL_LLM_MODEL)
		? DEFAULT_LOCAL_LLM_MODEL
		: probe.modelIds[0];
	return { provider: "ollama", model };
}

/** Ollama 확인을 기다리는 최대 시간. 응답 없는 원격 호스트가 로그아웃을 붙잡지 않게 한다. */
export const OLLAMA_PROBE_TIMEOUT_MS = 2500;

/** Ollama 에 물어 로그인하지 않은 상태의 기본 LLM 을 정한다. */
export async function resolveLoggedOutLlm(
	ollamaHost: string | undefined,
	probe: typeof fetchOllamaModels = fetchOllamaModels,
	timeoutMs: number = OLLAMA_PROBE_TIMEOUT_MS,
): Promise<LoggedOutLlm> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), timeoutMs);
	});
	try {
		const result = await Promise.race([
			probe(ollamaHost || DEFAULT_OLLAMA_HOST),
			timedOut,
		]);
		if (!result) return NO_LLM;
		return chooseLoggedOutLlm({
			connected: result.connected,
			modelIds: result.models.map((model) => model.id),
		});
	} catch {
		return NO_LLM;
	} finally {
		clearTimeout(timer);
	}
}
