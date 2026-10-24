import { describe, expect, it } from "vitest";
import {
	applyThinkingLevelToWebLLMRequest,
	resolveChatTurnThinkingLevel,
} from "../thinking-level";

describe("web-worker thinking-level (item 7)", () => {
	it("resolves thinking level from chat_request.thinking.level first, then config.json thinkingLevel, and defaults to off", () => {
		expect(
			resolveChatTurnThinkingLevel(
				JSON.stringify({ thinking: { level: "high" } }),
				null,
			),
		).toBe("high");
		expect(
			resolveChatTurnThinkingLevel(
				JSON.stringify({ thinking: { level: "off" } }),
				JSON.stringify({ thinkingLevel: "high" }),
			),
		).toBe("off");
		expect(
			resolveChatTurnThinkingLevel(
				JSON.stringify({}),
				JSON.stringify({ thinkingLevel: "high" }),
			),
		).toBe("high");
		expect(
			resolveChatTurnThinkingLevel(
				JSON.stringify({}),
				JSON.stringify({ thinkingLevel: "low" }),
			),
		).toBe("low");
		expect(
			resolveChatTurnThinkingLevel(
				JSON.stringify({}),
				JSON.stringify({ enableThinking: true }),
			),
		).toBe("low");
		expect(resolveChatTurnThinkingLevel(null, null)).toBe("off");
	});

	it("applies thinkingLevel='off' by setting extra_body.enable_thinking=false", () => {
		const req = {
			messages: [
				{ role: "system" as const, content: "You are Naia." },
				{ role: "user" as const, content: "안녕" },
			],
			stream: true as const,
		};
		const out = applyThinkingLevelToWebLLMRequest(req, "off");
		expect(out.extra_body).toEqual({ enable_thinking: false });
		expect(out.messages[0].content).toBe("You are Naia.");
	});

	it("applies thinkingLevel='low' and 'high' with enable_thinking=true and distinct reasoning depth instructions", () => {
		const baseReq = {
			messages: [
				{ role: "system" as const, content: "You are Naia." },
				{ role: "user" as const, content: "문제를 풀어줘" },
			],
			stream: true as const,
		};

		const lowOut = applyThinkingLevelToWebLLMRequest(baseReq, "low");
		expect(lowOut.extra_body).toEqual({ enable_thinking: true });
		expect(lowOut.messages[0].content).toContain("[Thinking budget: low");

		const highOut = applyThinkingLevelToWebLLMRequest(baseReq, "high");
		expect(highOut.extra_body).toEqual({ enable_thinking: true });
		expect(highOut.messages[0].content).toContain("[Thinking budget: high");
	});
});
