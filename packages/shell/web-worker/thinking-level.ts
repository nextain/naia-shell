import type { WebLLMChatRequest } from "@naia-agent/composition/browser-agent.js";

export type WebThinkingLevel = "off" | "low" | "high";

export function isWebThinkingLevel(value: unknown): value is WebThinkingLevel {
	return value === "off" || value === "low" || value === "high";
}

/**
 * 웹 에이전트 chat_request 줄과 OPFS config.json 스냅샷에서 생각 세기(off/low/high)를 결정한다.
 * 우선순위:
 * 1. chat_request.thinking.level ("off" | "low" | "high")
 * 2. chat_request.provider.thinkingLevel ("off" | "low" | "high")
 * 3. config.json 의 thinkingLevel ("off" | "low" | "high")
 * 4. chat_request.enableThinking (true -> "low", false -> "off")
 * 5. config.json 의 enableThinking (true -> "low", false -> "off")
 * 6. 기본값 "off"
 */
export function resolveChatTurnThinkingLevel(
	rawChatRequestLine: string | null | undefined,
	configText: string | null | undefined,
): WebThinkingLevel {
	let parsedReq: Record<string, unknown> | null = null;
	if (typeof rawChatRequestLine === "string" && rawChatRequestLine.trim()) {
		try {
			const val = JSON.parse(rawChatRequestLine);
			if (val && typeof val === "object" && !Array.isArray(val)) {
				parsedReq = val as Record<string, unknown>;
			}
		} catch {
			parsedReq = null;
		}
	}

	if (parsedReq) {
		const thinkingObj = parsedReq.thinking;
		if (thinkingObj && typeof thinkingObj === "object") {
			const level = (thinkingObj as Record<string, unknown>).level;
			if (isWebThinkingLevel(level)) return level;
		}
		const provObj = parsedReq.provider;
		if (provObj && typeof provObj === "object") {
			const provLevel = (provObj as Record<string, unknown>).thinkingLevel;
			if (isWebThinkingLevel(provLevel)) return provLevel;
		}
	}

	let parsedConfig: Record<string, unknown> | null = null;
	if (typeof configText === "string" && configText.trim()) {
		try {
			const val = JSON.parse(configText);
			if (val && typeof val === "object" && !Array.isArray(val)) {
				parsedConfig = val as Record<string, unknown>;
			}
		} catch {
			parsedConfig = null;
		}
	}

	if (parsedConfig && isWebThinkingLevel(parsedConfig.thinkingLevel)) {
		// 단, 요청이 명시적으로 enableThinking: false 를 보낸 경우는 "off" 우선
		if (parsedReq && parsedReq.enableThinking === false) {
			return "off";
		}
		return parsedConfig.thinkingLevel;
	}

	if (parsedReq && typeof parsedReq.enableThinking === "boolean") {
		return parsedReq.enableThinking ? "low" : "off";
	}

	if (parsedConfig && typeof parsedConfig.enableThinking === "boolean") {
		return parsedConfig.enableThinking ? "low" : "off";
	}

	return "off";
}

const LOW_THINKING_HINT =
	"[Thinking budget: low — keep <think> reasoning brief (1-3 sentences) before answering.]";
const HIGH_THINKING_HINT =
	"[Thinking budget: high — reason thoroughly step-by-step in <think> before answering.]";

/**
 * WebLLM(Qwen3 MLC) 요청에 생각 세기(off/low/high)를 반영한다.
 * - off: extra_body.enable_thinking = false
 * - low: extra_body.enable_thinking = true + 간결 추론 예산 지시문
 * - high: extra_body.enable_thinking = true + 심층 추론 예산 지시문
 */
export function applyThinkingLevelToWebLLMRequest(
	req: WebLLMChatRequest,
	level: WebThinkingLevel,
): WebLLMChatRequest {
	const enableThinking = level !== "off";
	const hint =
		level === "low"
			? LOW_THINKING_HINT
			: level === "high"
				? HIGH_THINKING_HINT
				: null;

	let messages = req.messages;
	if (hint) {
		const sysIdx = messages.findIndex((m) => m.role === "system");
		if (sysIdx >= 0) {
			messages = messages.map((m, i) =>
				i === sysIdx && !m.content.includes(hint)
					? { ...m, content: `${m.content}\n\n${hint}` }
					: m,
			);
		} else {
			messages = [{ role: "system", content: hint }, ...messages];
		}
	}

	return {
		...req,
		messages,
		extra_body: {
			...req.extra_body,
			enable_thinking: enableThinking,
		},
	};
}
