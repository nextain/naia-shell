// Shell 역할 설정 모델 — 저장/migration/UI에서 공통 사용.
// provider 목록은 registry capability가 권위이며 이 파일에 역할별 배열을 두지 않는다.
import type { AppConfig, LlmRoleConfig, LlmRoleId } from "../config";
import { providerSupportsRole } from "./registry";

export type RoleProvenance = "explicit" | "inherit" | "legacy-inherit";
export interface EffectiveShellLlmRole {
	role: LlmRoleId;
	provider: string;
	model: string;
	baseUrl?: string;
	credentialRef?: string;
	provenance: RoleProvenance;
	inheritedFromRole?: LlmRoleId;
}

const clean = (value: string | undefined): string | undefined => value?.trim() || undefined;

/** 신규 필드 우선 + legacy 무손실 읽기. */
export function readConfiguredLlmRoles(config: AppConfig): Partial<Record<LlmRoleId, LlmRoleConfig>> {
	const structured = config.llmRoles ?? {};
	const main = structured.main ?? { provider: config.provider, model: config.model };
	const memory = structured.memory ?? (
		config.memoryLlmProvider && config.memoryLlmProvider !== "none"
			? {
					provider: config.memoryLlmProvider,
					model: config.memoryLlmModel,
					baseUrl: config.memoryLlmBaseUrl,
					credentialRef: config.memoryLlmCredentialRef,
				}
			: undefined
	);
	const sub = structured.sub ?? (
		config.subLlmProvider
			? {
					provider: config.subLlmProvider,
					model: config.subLlmModel,
					baseUrl: config.subLlmBaseUrl,
					credentialRef: config.subLlmCredentialRef,
				}
			: memory
				? { inherit: "memory" }
				: undefined
	);
	const effectiveMemory = memory ?? (sub ? { inherit: "sub" as const } : undefined);
	return {
		...(main ? { main } : {}),
		...(sub ? { sub } : {}),
		...(effectiveMemory ? { memory: effectiveMemory } : {}),
	};
}

/** 한 역할만 갱신. 구조화 정본과 전환기 flat 필드를 dual-write하며 다른 역할은 보존한다. */
export function writeConfiguredLlmRole(
	config: AppConfig,
	role: LlmRoleId,
	value: LlmRoleConfig,
): AppConfig {
	const next: AppConfig = {
		...config,
		llmRoles: { ...(config.llmRoles ?? {}), [role]: { ...value } },
	};
	if (role === "main" && !value.inherit) {
		if (value.provider) next.provider = value.provider;
		if (value.model) next.model = value.model;
	} else if (role === "sub") {
		next.subLlmProvider = value.inherit ? undefined : value.provider;
		next.subLlmModel = value.inherit ? undefined : value.model;
		next.subLlmBaseUrl = value.inherit ? undefined : value.baseUrl;
		next.subLlmCredentialRef = value.inherit ? undefined : value.credentialRef;
	} else if (role === "memory") {
		next.memoryLlmProvider = value.inherit
			? undefined
			: value.provider as AppConfig["memoryLlmProvider"];
		next.memoryLlmModel = value.inherit ? undefined : value.model;
		next.memoryLlmBaseUrl = value.inherit ? undefined : value.baseUrl;
		next.memoryLlmCredentialRef = value.inherit ? undefined : value.credentialRef;
	}
	return next;
}

export function resolveEffectiveLlmRoles(config: AppConfig):
	| { ok: true; roles: readonly [EffectiveShellLlmRole, EffectiveShellLlmRole, EffectiveShellLlmRole] }
	| { ok: false; role: LlmRoleId; reason: "missing" | "incomplete" | "cycle" | "unsupported" } {
	const configured = readConfiguredLlmRoles(config);
	const cache = new Map<LlmRoleId, EffectiveShellLlmRole>();
	const stack = new Set<LlmRoleId>();
	const resolveOne = (role: LlmRoleId): EffectiveShellLlmRole | { ok: false; role: LlmRoleId; reason: "missing" | "incomplete" | "cycle" | "unsupported" } => {
		const cached = cache.get(role);
		if (cached) return cached;
		if (stack.has(role)) return { ok: false, role, reason: "cycle" };
		const selected = configured[role];
		if (!selected) return { ok: false, role, reason: "missing" };
		stack.add(role);
		if (selected.inherit) {
			const parent = resolveOne(selected.inherit);
			if ("ok" in parent) {
				stack.delete(role);
				return parent;
			}
			const effective: EffectiveShellLlmRole = {
				...parent,
				role,
				provenance: role === "sub" && selected.inherit === "memory" && !config.llmRoles?.sub
					? "legacy-inherit"
					: "inherit",
				inheritedFromRole: selected.inherit,
			};
			stack.delete(role);
			cache.set(role, effective);
			return effective;
		}
		const provider = clean(selected.provider);
		const model = clean(selected.model);
		if (!provider || !model) {
			stack.delete(role);
			return { ok: false, role, reason: provider || model ? "incomplete" : "missing" };
		}
		if (!providerSupportsRole(provider, role)) {
			stack.delete(role);
			return { ok: false, role, reason: "unsupported" };
		}
		const effective: EffectiveShellLlmRole = {
			role,
			provider,
			model,
			...(clean(selected.baseUrl) ? { baseUrl: clean(selected.baseUrl) } : {}),
			...(clean(selected.credentialRef) ? { credentialRef: clean(selected.credentialRef) } : {}),
			provenance: "explicit",
		};
		stack.delete(role);
		cache.set(role, effective);
		return effective;
	};
	const roles: EffectiveShellLlmRole[] = [];
	for (const role of ["main", "sub", "memory"] as const) {
		const effective = resolveOne(role);
		if ("ok" in effective) return effective;
		roles.push(effective);
	}
	return {
		ok: true,
		roles: roles as unknown as readonly [EffectiveShellLlmRole, EffectiveShellLlmRole, EffectiveShellLlmRole],
	};
}
