import type { AppConfig, LlmRoleConfig, LlmRoleId } from "../config";
import { readConfiguredLlmRoles, writeConfiguredLlmRole } from "./roles";

/** Naia account default for the small (memory) LLM — Luke 2026-09-22, billed to the Naia account. */
export const NAIA_SMALL_LLM_DEFAULT = {
	provider: "nextain",
	model: "gpt-5.4-nano",
} as const;

export type SmallLlmChoice = "naia" | "ollama" | "vllm" | "other" | "none";

export interface SmallLlmSelection {
	readonly choice: SmallLlmChoice;
	readonly provider?: string; // effective provider (lowercase), "naia" normalized to "nextain"
	readonly model?: string;
	readonly baseUrl?: string;
	readonly inherited: boolean; // true when the memory role reached its provider through `inherit`
	readonly surfacingOff: boolean; // config.memorySurfacing === "off"
}

export function readSmallLlmSelection(
	config: AppConfig | null | undefined,
): SmallLlmSelection {
	const surfacingOff = config?.memorySurfacing === "off";
	if (!config) {
		return { choice: "none", inherited: false, surfacingOff: false };
	}

	const roles = readConfiguredLlmRoles(config);
	let currentId: LlmRoleId | undefined = "memory";
	let hops = 0;
	const visited = new Set<LlmRoleId>();

	while (currentId) {
		const current: LlmRoleConfig | undefined = roles[currentId];
		if (!current) {
			return { choice: "none", inherited: false, surfacingOff };
		}
		if (current.inherit) {
			if (visited.has(currentId)) {
				return { choice: "none", inherited: false, surfacingOff };
			}
			visited.add(currentId);
			if (hops >= 4) {
				return { choice: "none", inherited: false, surfacingOff };
			}
			const nextId: LlmRoleId = current.inherit;
			if (visited.has(nextId) || !roles[nextId]) {
				return { choice: "none", inherited: false, surfacingOff };
			}
			currentId = nextId;
			hops++;
			continue;
		}

		const rawProvider = current.provider?.trim();
		const rawModel = current.model?.trim();
		if (!rawProvider || !rawModel) {
			return { choice: "none", inherited: false, surfacingOff };
		}

		let provider = rawProvider.toLowerCase();
		if (provider === "naia") {
			provider = "nextain";
		}

		let choice: SmallLlmChoice;
		if (provider === "nextain") {
			choice = "naia";
		} else if (provider === "ollama") {
			choice = "ollama";
		} else if (provider === "vllm") {
			choice = "vllm";
		} else {
			choice = "other";
		}

		return {
			choice,
			provider,
			model: rawModel,
			baseUrl: current.baseUrl?.trim() || undefined,
			inherited: hops > 0,
			surfacingOff,
		};
	}

	return { choice: "none", inherited: false, surfacingOff };
}

export function normalizeOpenAiCompatBaseUrl(url: string): string {
	let trimmed = url.trim();
	if (!trimmed) return "";
	trimmed = trimmed.replace(/\/+$/, "");
	if (!trimmed.endsWith("/v1")) {
		trimmed += "/v1";
	}
	return trimmed;
}

export type SmallLlmWrite =
	| { readonly choice: "naia" }
	| {
			readonly choice: "ollama" | "vllm";
			readonly baseUrl: string;
			readonly model: string;
	  }
	| { readonly choice: "threshold" }
	| { readonly choice: "off" };

export function writeSmallLlmSelection(
	config: AppConfig,
	write: SmallLlmWrite,
): AppConfig {
	if (write.choice === "naia") {
		const next = writeConfiguredLlmRole(config, "memory", {
			provider: "nextain",
			model: NAIA_SMALL_LLM_DEFAULT.model,
		});
		return { ...next, memorySurfacing: "on", memorySurfacingJudge: "llm" };
	}
	if (write.choice === "ollama" || write.choice === "vllm") {
		const next = writeConfiguredLlmRole(config, "memory", {
			provider: write.choice,
			model: write.model.trim(),
			baseUrl: normalizeOpenAiCompatBaseUrl(write.baseUrl),
		});
		return { ...next, memorySurfacing: "on", memorySurfacingJudge: "llm" };
	}
	if (write.choice === "threshold") {
		return {
			...config,
			memorySurfacing: "on",
			memorySurfacingJudge: "threshold",
		};
	}
	if (write.choice === "off") {
		return { ...config, memorySurfacing: "off" };
	}
	return { ...config };
}

export const SURFACING_LEVELS = ["less", "normal", "more"] as const;
export type SurfacingLevel = (typeof SURFACING_LEVELS)[number];

export const SURFACING_LEVEL_THRESHOLDS: Record<SurfacingLevel, number> = {
	less: 0.88,
	normal: 0.86,
	more: 0.84,
};

export function readSurfacingLevel(
	config: AppConfig | null | undefined,
): SurfacingLevel {
	const level = config?.memorySurfacingLevel;
	if (level === "less" || level === "more" || level === "normal") {
		return level;
	}
	return "normal";
}

export function writeSurfacingLevel(
	config: AppConfig,
	level: unknown,
): AppConfig {
	const validLevel: SurfacingLevel =
		level === "less" || level === "more" || level === "normal"
			? (level as SurfacingLevel)
			: "normal";
	return { ...config, memorySurfacingLevel: validLevel };
}

export type SurfacingState =
	| {
			readonly kind: "on";
			readonly billing: "naia" | "local" | "own";
			readonly provider: string;
			readonly model: string;
	  }
	| {
			readonly kind: "on-threshold";
			readonly reason:
				| "no-small-llm"
				| "inherited-billed"
				| "pending-gateway"
				| "user-choice";
			readonly threshold: number;
			readonly provider?: string;
			readonly model?: string;
	  }
	| { readonly kind: "off-disabled" }
	| { readonly kind: "off-no-embedding" };

export function describeSurfacingState(
	config: AppConfig | null | undefined,
	opts: {
		readonly naiaKeyPresent: boolean;
		readonly gatewayModels?: ReadonlySet<string> | null;
	},
): SurfacingState {
	const sel = readSmallLlmSelection(config);
	if (sel.surfacingOff) {
		return { kind: "off-disabled" };
	}
	if (!config?.memoryEmbeddingProvider || config.memoryEmbeddingProvider === "none") {
		return { kind: "off-no-embedding" };
	}

	const threshold = SURFACING_LEVEL_THRESHOLDS[readSurfacingLevel(config)];

	if (config?.memorySurfacingJudge === "threshold") {
		return { kind: "on-threshold", reason: "user-choice", threshold };
	}

	if (sel.choice === "none") {
		return { kind: "on-threshold", reason: "no-small-llm", threshold };
	}
	if (sel.choice === "naia") {
		if (!opts.naiaKeyPresent) {
			return { kind: "on-threshold", reason: "no-small-llm", threshold };
		}
		if (
			opts.gatewayModels &&
			typeof opts.gatewayModels.has === "function" &&
			sel.model &&
			!opts.gatewayModels.has(sel.model)
		) {
			return {
				kind: "on-threshold",
				reason: "pending-gateway",
				threshold,
				model: sel.model,
			};
		}
		return {
			kind: "on",
			billing: "naia",
			provider: sel.provider ?? "nextain",
			model: sel.model ?? NAIA_SMALL_LLM_DEFAULT.model,
		};
	}
	if (sel.choice === "ollama" || sel.choice === "vllm") {
		return {
			kind: "on",
			billing: "local",
			provider: sel.provider!,
			model: sel.model!,
		};
	}
	if (sel.choice === "other") {
		if (sel.inherited) {
			return {
				kind: "on-threshold",
				reason: "inherited-billed",
				threshold,
				provider: sel.provider!,
				model: sel.model!,
			};
		}
		return {
			kind: "on",
			billing: "own",
			provider: sel.provider!,
			model: sel.model!,
		};
	}
	return { kind: "on-threshold", reason: "no-small-llm", threshold };
}
