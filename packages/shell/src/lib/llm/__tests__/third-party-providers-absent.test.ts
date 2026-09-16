/**
 * #602 회귀 가드 — 타사 직결 클라우드 LLM API 공급자가 흔적 없이 제거됐음을 증명한다.
 *
 * 에픽 #589 규칙: 로그인 = 나이아 계정 모델, 로그아웃 = 무료 → 로컬.
 * OpenAI·Anthropic·Gemini(Google)·xAI·Z.AI 처럼 BYO API 키를 요구하는 직결 클라우드
 * 공급자는 숨기는 게 아니라 제거한다. CLI(스킬 탭: Claude Code / Codex / Grok / Gemini CLI)
 * 와 로컬(ollama/vllm), 나이아 계정(nextain)만 남는다.
 */
import { describe, expect, it } from "vitest";
import {
	getDefaultLlmModel,
	getLlmProvider,
	isApiKeyOptional,
	listLlmProviders,
	providerSupportsRole,
} from "../registry";

// 제거된 타사 직결 클라우드 LLM API 공급자.
const REMOVED_PROVIDERS = [
	"openai",
	"gemini",
	"anthropic",
	"xai",
	"zai",
] as const;

// 남는 공급자: 나이아 계정 + CLI(스킬) + 로컬.
const KEPT_PROVIDERS = [
	"nextain",
	"claude-code-cli",
	"codex",
	"grok",
	"ollama",
	"vllm",
] as const;

describe("#602 — 타사 클라우드 LLM API 공급자 부재 증명", () => {
	it("등록부에서 제거된 공급자를 하나도 노출하지 않는다", () => {
		const ids = listLlmProviders().map((p) => p.id);
		for (const removed of REMOVED_PROVIDERS) {
			expect(ids).not.toContain(removed);
			expect(getLlmProvider(removed)).toBeUndefined();
			expect(getLlmProvider(removed)?.models ?? []).toEqual([]);
			expect(getDefaultLlmModel(removed)).toBe("");
			for (const role of ["expert", "main", "sub", "memory"] as const) {
				expect(providerSupportsRole(removed, role)).toBe(false);
			}
		}
	});

	it("남는 공급자는 나이아 계정·CLI·로컬뿐이며 BYO API 키를 요구하지 않는다", () => {
		const ids = listLlmProviders().map((p) => p.id).sort();
		expect(ids).toEqual([...KEPT_PROVIDERS].sort());
		for (const p of listLlmProviders()) {
			expect(p.requiresApiKey).toBe(false);
		}
	});

	it("키 없이 쓸 수 있는 공급자는 로컬(ollama/vllm)뿐이고, 제거된 공급자는 아니다", () => {
		expect(isApiKeyOptional("ollama")).toBe(true);
		expect(isApiKeyOptional("vllm")).toBe(true);
		for (const removed of REMOVED_PROVIDERS) {
			expect(isApiKeyOptional(removed)).toBe(false);
		}
	});
});
