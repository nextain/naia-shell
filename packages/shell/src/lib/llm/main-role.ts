// main 역할 읽기·쓰기 — 대화 두뇌 선택의 유일한 경로(#589).
// 보조·전문가·기억 역할(roles.ts)과 떨어져 있어, 그 역할들을 지워도 main 은 모양 그대로 남는다.
import type { AppConfig, LlmRoleConfig } from "../config";

/**
 * 저장된 main 역할을 모양 그대로 읽는다.
 *
 * `llmRoles.main` 이 정본이다. 없으면 최상위 `provider`/`model` 거울에서 만든다.
 * `baseUrl`·`credentialRef` 도 함께 돌려주므로, 저장·모델 선택이 #515 주소와 키 참조를 잃지 않는다.
 */
export function readMainRole(config: AppConfig): LlmRoleConfig {
	return config.llmRoles?.main ?? { provider: config.provider, model: config.model };
}

/** main 역할만 갱신한다. 다른 역할은 보존하고, 최상위 `provider`/`model` 거울을 함께 맞춘다. */
export function writeMainRole(config: AppConfig, value: LlmRoleConfig): AppConfig {
	const next: AppConfig = {
		...config,
		llmRoles: { ...(config.llmRoles ?? {}), main: { ...value } },
	};
	if (!value.inherit) {
		if (value.provider) next.provider = value.provider;
		if (value.model) next.model = value.model;
	}
	return next;
}

/**
 * 새 main 선택을 만든다. 공급자가 그대로면 저장돼 있던 `credentialRef`·`baseUrl` 을 이어받고,
 * 공급자가 바뀌면 옛 공급자의 주소와 키 참조를 버린다.
 */
export function selectMainRole(
	persisted: AppConfig | null | undefined,
	provider: LlmRoleConfig["provider"],
	model: string,
): LlmRoleConfig {
	const previous = persisted ? readMainRole(persisted) : undefined;
	const sameProvider = previous?.provider === provider;
	return {
		provider,
		model,
		...(sameProvider && previous?.credentialRef !== undefined
			? { credentialRef: previous.credentialRef }
			: {}),
		...(sameProvider && previous?.baseUrl !== undefined
			? { baseUrl: previous.baseUrl }
			: {}),
	};
}
