import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRequest } from "../protocol.js";

// Mock provider factory
vi.mock("../providers/factory.js", () => ({
	buildProvider: vi.fn(),
	setAgentNaiaKey: vi.fn(),
	getAgentNaiaKey: vi.fn().mockReturnValue(undefined),
}));

// Mock TTS registry synthesize
vi.mock("../tts/index.js", () => ({
	synthesize: vi.fn(),
}));

// Mock cost
vi.mock("../providers/cost.js", () => ({
	calculateCost: vi.fn().mockReturnValue(0.001),
}));

describe("parseRequest", () => {
	it("parses valid chat_request JSON", () => {
		const input = JSON.stringify({
			type: "chat_request",
			requestId: "req-1",
			provider: {
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "key",
			},
			messages: [{ role: "user", content: "Hello" }],
		});
		const result = parseRequest(input) as
			| import("../protocol.js").ChatRequest
			| null;
		expect(result).not.toBeNull();
		expect(result?.type).toBe("chat_request");
		expect(result?.requestId).toBe("req-1");
		expect(result?.messages).toHaveLength(1);
	});

	it("returns null for invalid JSON", () => {
		expect(parseRequest("not json")).toBeNull();
	});

	it("returns null for missing type field", () => {
		const input = JSON.stringify({ requestId: "req-1" });
		expect(parseRequest(input)).toBeNull();
	});

	it("returns null for unknown type", () => {
		const input = JSON.stringify({ type: "unknown", requestId: "req-1" });
		expect(parseRequest(input)).toBeNull();
	});

	it("parses cancel_stream request", () => {
		const input = JSON.stringify({
			type: "cancel_stream",
			requestId: "req-1",
		});
		const result = parseRequest(input);
		expect(result).not.toBeNull();
		expect(result?.type).toBe("cancel_stream");
	});

	it("parses approval_response with decision=once", () => {
		const input = JSON.stringify({
			type: "approval_response",
			requestId: "req-1",
			toolCallId: "tc-1",
			decision: "once",
		});
		const result = parseRequest(input);
		expect(result).not.toBeNull();
		expect(result?.type).toBe("approval_response");
		if (result?.type === "approval_response") {
			expect(result?.toolCallId).toBe("tc-1");
			expect(result?.decision).toBe("once");
		}
	});

	it("parses approval_response with decision=always", () => {
		const input = JSON.stringify({
			type: "approval_response",
			requestId: "req-1",
			toolCallId: "tc-2",
			decision: "always",
		});
		const result = parseRequest(input);
		expect(result).not.toBeNull();
		if (result?.type === "approval_response") {
			expect(result?.decision).toBe("always");
		}
	});

	it("parses approval_response with decision=reject and message", () => {
		const input = JSON.stringify({
			type: "approval_response",
			requestId: "req-1",
			toolCallId: "tc-3",
			decision: "reject",
			message: "위험해 보여요",
		});
		const result = parseRequest(input);
		expect(result).not.toBeNull();
		if (result?.type === "approval_response") {
			expect(result?.decision).toBe("reject");
			expect(result?.message).toBe("위험해 보여요");
		}
	});

	it("parses skill_list request", () => {
		const input = JSON.stringify({
			type: "skill_list",
			requestId: "sl-1",
		});
		const result = parseRequest(input);
		expect(result).not.toBeNull();
		expect(result?.type).toBe("skill_list");
		if (result?.type === "skill_list") {
			expect(result.requestId).toBe("sl-1");
		}
	});
});

describe("skill_list handler", () => {
	let writeSpy: ReturnType<typeof vi.spyOn>;
	let outputs: unknown[];

	beforeEach(() => {
		outputs = [];
		vi.clearAllMocks();
		writeSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation((data: string | Uint8Array) => {
				if (typeof data === "string") {
					for (const line of data.trim().split("\n")) {
						outputs.push(JSON.parse(line));
					}
				}
				return true;
			});
	});

	afterEach(() => {
		writeSpy.mockRestore();
	});

	it("returns skill_list_response with registered skills", async () => {
		const { skillRegistry } = await import("../gateway/tool-bridge.js");

		// Simulate the handler logic (same as index.ts skill_list handler)
		const tools = skillRegistry.toToolDefinitions(false);
		process.stdout.write(
			`${JSON.stringify({ type: "skill_list_response", requestId: "sl-test", tools })}\n`,
		);

		const response = outputs.find(
			(o: any) => o.type === "skill_list_response",
		) as any;
		expect(response).toBeDefined();
		expect(response.requestId).toBe("sl-test");
		expect(response.tools).toBeInstanceOf(Array);
		expect(response.tools.length).toBeGreaterThan(0);

		// Verify built-in skills are included
		const names = response.tools.map((t: any) => t.name);
		expect(names).toContain("skill_time");
		expect(names).toContain("skill_memo");
		expect(names).toContain("skill_weather");

		// Verify each tool has required fields
		for (const tool of response.tools) {
			expect(tool.name).toEqual(expect.any(String));
			expect(tool.description).toEqual(expect.any(String));
			expect(tool.parameters).toEqual(expect.any(Object));
		}

		// Verify gateway-dependent skills are excluded (hasGateway=false)
		expect(names).not.toContain("skill_agents");
		expect(names).not.toContain("skill_naia_discord");
	});
});

describe("handleChatRequest TTS integration", () => {
	let writeSpy: ReturnType<typeof vi.spyOn>;
	let outputs: unknown[];

	beforeEach(() => {
		outputs = [];
		vi.clearAllMocks();
		writeSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation((data: string | Uint8Array) => {
				if (typeof data === "string") {
					for (const line of data.trim().split("\n")) {
						outputs.push(JSON.parse(line));
					}
				}
				return true;
			});
	});

	afterEach(() => {
		writeSpy.mockRestore();
	});

	async function* fakeStream() {
		yield { type: "text" as const, text: "[HAPPY] 안녕하세요!" };
		yield {
			type: "usage" as const,
			inputTokens: 10,
			outputTokens: 20,
		};
		yield { type: "finish" as const };
	}

	it("sends audio chunk when provider is gemini", async () => {
		const { buildProvider } = await import("../providers/factory.js");
		const { synthesize } = await import("../tts/index.js");
		const { handleChatRequest } = await import("../index.js");

		vi.mocked(buildProvider).mockReturnValue({
			stream: () => fakeStream(),
		});
		vi.mocked(synthesize).mockResolvedValue({ audio: "base64audio==" });

		await handleChatRequest({
			type: "chat_request",
			requestId: "req-tts",
			provider: {
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "key123",
			},
			messages: [{ role: "user", content: "Hello" }],
			ttsVoice: "ko-KR-Neural2-A",
		});

		const types = outputs
			.filter((o: any) => o.type !== "ready" && o.type !== "log_entry")
			.map((o: any) => o.type);
		// Order: text → audio → usage → finish
		expect(types).toEqual(["text", "audio", "usage", "finish"]);

		const audioChunk = outputs.find((o: any) => o.type === "audio") as any;
		expect(audioChunk.data).toBe("base64audio==");
		expect(audioChunk.requestId).toBe("req-tts");

		// TTS synthesize called via registry with emotion tag stripped
		expect(synthesize).toHaveBeenCalledWith(
			"edge",
			expect.objectContaining({ text: "안녕하세요!" }),
		);
	});

	it("skips TTS for non-gemini providers", async () => {
		const { buildProvider } = await import("../providers/factory.js");
		const { synthesize } = await import("../tts/index.js");
		const { handleChatRequest } = await import("../index.js");

		vi.mocked(buildProvider).mockReturnValue({
			stream: () => fakeStream(),
		});

		await handleChatRequest({
			type: "chat_request",
			requestId: "req-xai",
			provider: { provider: "xai", model: "grok-3", apiKey: "key" },
			messages: [{ role: "user", content: "Hello" }],
		});

		expect(synthesize).not.toHaveBeenCalled();
		const types = outputs
			.filter((o: any) => o.type !== "log_entry")
			.map((o: any) => o.type);
		expect(types).toEqual(["text", "usage", "finish"]);
	});

	it("continues normally when TTS fails", async () => {
		const { buildProvider } = await import("../providers/factory.js");
		const { synthesize } = await import("../tts/index.js");
		const { handleChatRequest } = await import("../index.js");

		vi.mocked(buildProvider).mockReturnValue({
			stream: () => fakeStream(),
		});
		vi.mocked(synthesize).mockResolvedValue(null);

		await handleChatRequest({
			type: "chat_request",
			requestId: "req-fail",
			provider: {
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "key",
			},
			messages: [{ role: "user", content: "Test" }],
		});

		const types = outputs
			.filter((o: any) => o.type !== "log_entry")
			.map((o: any) => o.type);
		// No audio chunk, but usage + finish still sent
		expect(types).toEqual(["text", "usage", "finish"]);
	});
});
