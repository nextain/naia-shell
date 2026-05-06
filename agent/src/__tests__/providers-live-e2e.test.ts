/**
 * Live Provider E2E tests: verify each LLM provider can stream a real response.
 *
 * Prerequisites:
 *   - API keys in shell/.env (GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, XAI_API_KEY, ZHIPU_API_KEY)
 *   - For Gateway tool-loop tests: Naia Gateway running on localhost:18789
 *
 * These tests are opt-in and skipped by default.
 * Run manually:
 *   CAFE_LIVE_PROVIDER_E2E=1 pnpm exec vitest run src/__tests__/providers-live-e2e.test.ts
 *
 * With Gateway tool-loop tests:
 *   CAFE_LIVE_PROVIDER_E2E=1 CAFE_LIVE_GATEWAY_E2E=1 pnpm exec vitest run src/__tests__/providers-live-e2e.test.ts
 *
 * Or pass keys directly:
 *   CAFE_LIVE_PROVIDER_E2E=1 GEMINI_API_KEY=xxx pnpm exec vitest run src/__tests__/providers-live-e2e.test.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatMessage, StreamChunk } from "../providers/types.js";

const LIVE_E2E = process.env.CAFE_LIVE_PROVIDER_E2E === "1";
const GATEWAY_E2E = process.env.CAFE_LIVE_GATEWAY_E2E === "1";
const GATEWAY_URL = "ws://localhost:18789";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Load API keys from shell/.env, trying multiple paths */
function loadEnvKeys(): Record<string, string> {
	const candidates = [
		resolve(__dirname, "../../../shell/.env"),
		resolve(__dirname, "../../../../shell/.env"),
		"/home/luke/dev/naia-os/shell/.env",
	];

	for (const envPath of candidates) {
		if (!existsSync(envPath)) continue;
		try {
			const content = readFileSync(envPath, "utf-8");
			const keys: Record<string, string> = {};
			for (const line of content.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith("#")) continue;
				const eq = trimmed.indexOf("=");
				if (eq === -1) continue;
				keys[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
			}
			return keys;
		} catch {}
	}
	return {};
}

/** Get key from env var first, then from .env file */
function getKey(name: string): string {
	return process.env[name] || envKeys[name] || "";
}

const envKeys = LIVE_E2E ? loadEnvKeys() : {};

/** Collect all chunks from a provider stream */
async function collectChunks(
	stream: AsyncGenerator<StreamChunk, void, undefined>,
): Promise<StreamChunk[]> {
	const chunks: StreamChunk[] = [];
	for await (const chunk of stream) {
		chunks.push(chunk);
	}
	return chunks;
}

/** Common assertions for a simple chat response */
function assertBasicResponse(chunks: StreamChunk[]) {
	const textChunks = chunks.filter((c) => c.type === "text") as Array<{
		type: "text";
		text: string;
	}>;
	expect(textChunks.length).toBeGreaterThan(0);

	const combined = textChunks.map((c) => c.text).join("");
	expect(combined.length).toBeGreaterThan(0);

	const hasFinish = chunks.some((c) => c.type === "finish");
	expect(hasFinish).toBe(true);

	const usageChunks = chunks.filter((c) => c.type === "usage") as Array<{
		type: "usage";
		inputTokens: number;
		outputTokens: number;
	}>;
	if (usageChunks.length > 0) {
		expect(usageChunks[0].inputTokens).toBeGreaterThan(0);
		expect(usageChunks[0].outputTokens).toBeGreaterThan(0);
	}

	return combined;
}

const SYSTEM_PROMPT =
	"You are a helpful assistant. Reply briefly in one sentence.";
const TEST_MESSAGE = [
	{ role: "user" as const, content: "Say hello in Korean." },
];
const TIMEOUT = 30_000;

describe.skipIf(!LIVE_E2E)("Live Provider E2E", () => {
	describe("Gemini", () => {
		const apiKey = getKey("GEMINI_API_KEY");

		it.skipIf(!apiKey)(
			"streams text response from gemini-2.5-flash",
			async () => {
				const { createGeminiProvider } = await import("../providers/gemini.js");
				const provider = createGeminiProvider(apiKey, "gemini-2.5-flash");
				const chunks = await collectChunks(
					provider.stream(TEST_MESSAGE, SYSTEM_PROMPT),
				);
				const text = assertBasicResponse(chunks);
				expect(text.length).toBeGreaterThan(2);
			},
			TIMEOUT,
		);
	});

	describe("OpenAI", () => {
		const apiKey = getKey("OPENAI_API_KEY");

		it.skipIf(!apiKey)(
			"streams text response from gpt-4.1-mini",
			async () => {
				const { createOpenAIProvider } = await import("../providers/openai.js");
				const provider = createOpenAIProvider(apiKey, "gpt-4.1-mini");
				const chunks = await collectChunks(
					provider.stream(TEST_MESSAGE, SYSTEM_PROMPT),
				);
				const text = assertBasicResponse(chunks);
				expect(text.length).toBeGreaterThan(2);
			},
			TIMEOUT,
		);
	});

	describe("Anthropic", () => {
		const apiKey = getKey("ANTHROPIC_API_KEY");

		it.skipIf(!apiKey)(
			"streams text response from claude-sonnet-4-5-20250929",
			async () => {
				const { createAnthropicProvider } = await import(
					"../providers/anthropic.js"
				);
				const provider = createAnthropicProvider(
					apiKey,
					"claude-sonnet-4-5-20250929",
				);
				const chunks = await collectChunks(
					provider.stream(TEST_MESSAGE, SYSTEM_PROMPT),
				);
				const text = assertBasicResponse(chunks);
				expect(text.length).toBeGreaterThan(2);
			},
			TIMEOUT,
		);
	});

	describe("xAI (Grok)", () => {
		const apiKey = getKey("XAI_API_KEY");

		it.skipIf(!apiKey)(
			"streams text response from grok-3-mini",
			async () => {
				const { createXAIProvider } = await import("../providers/xai.js");
				const provider = createXAIProvider(apiKey, "grok-3-mini");
				const chunks = await collectChunks(
					provider.stream(TEST_MESSAGE, SYSTEM_PROMPT),
				);
				const text = assertBasicResponse(chunks);
				expect(text.length).toBeGreaterThan(2);
			},
			TIMEOUT,
		);
	});

	describe("ZAI (Zhipu GLM)", () => {
		const apiKey = getKey("ZHIPU_API_KEY");

		it.skipIf(!apiKey)(
			"streams text response from glm-4.7",
			async () => {
				const { createZAIProvider } = await import("../providers/zai.js");
				const provider = createZAIProvider(apiKey, "glm-4.7");
				const chunks = await collectChunks(
					provider.stream(TEST_MESSAGE, SYSTEM_PROMPT),
				);
				const text = assertBasicResponse(chunks);
				expect(text.length).toBeGreaterThan(2);
			},
			TIMEOUT,
		);
	});

	describe("Tool calling (provider-only)", () => {
		const geminiKey = getKey("GEMINI_API_KEY");

		const tools = [
			{
				name: "get_weather",
				description: "Get current weather for a location",
				parameters: {
					type: "object",
					properties: {
						location: { type: "string", description: "City name" },
					},
					required: ["location"],
				},
			},
		];

		it.skipIf(!geminiKey)(
			"Gemini returns tool_use when tool is available",
			async () => {
				const { createGeminiProvider } = await import("../providers/gemini.js");
				const provider = createGeminiProvider(geminiKey, "gemini-2.5-flash");
				const chunks = await collectChunks(
					provider.stream(
						[{ role: "user", content: "What is the weather in Seoul?" }],
						"You have access to tools. Use them when appropriate.",
						tools,
					),
				);

				// Model may or may not call the tool — both are valid
				const hasText = chunks.some((c) => c.type === "text");
				const hasToolUse = chunks.some((c) => c.type === "tool_use");
				expect(hasText || hasToolUse).toBe(true);

				if (hasToolUse) {
					const toolChunk = chunks.find((c) => c.type === "tool_use") as {
						type: "tool_use";
						id: string;
						name: string;
						args: Record<string, unknown>;
					};
					expect(toolChunk.name).toBe("get_weather");
					expect(toolChunk.args).toHaveProperty("location");
				}
			},
			TIMEOUT,
		);
	});
});

// ── Gateway Tool-Loop E2E ──
// Full path: Provider → tool_use → Gateway executeTool → tool result → Provider re-invoke

function loadGatewayToken(): string | null {
	const candidates = [
		join(homedir(), ".naia", "gateway.json"),
	];
	for (const p of candidates) {
		try {
			const config = JSON.parse(readFileSync(p, "utf-8"));
			return config.gateway?.auth?.token || null;
		} catch {}
	}
	return null;
}

const canRunGatewayE2E = LIVE_E2E && GATEWAY_E2E;

describe.skipIf(!canRunGatewayE2E)("Provider → Gateway Tool-Loop E2E", () => {
	let executeTool: typeof import("../gateway/tool-bridge.js").executeTool;
	let getAllTools: typeof import("../gateway/tool-bridge.js").getAllTools;
	let client: any;

	beforeAll(async () => {
		const clientModule = await import("../gateway/client.js");
		const bridgeModule = await import("../gateway/tool-bridge.js");
		const identityModule = await import("../gateway/device-identity.js");
		executeTool = bridgeModule.executeTool;
		getAllTools = bridgeModule.getAllTools;

		client = new clientModule.GatewayClient();
		const device = identityModule.loadDeviceIdentity();
		const token = loadGatewayToken() || "";

		await client.connect(GATEWAY_URL, {
			token,
			device,
			role: "operator",
			scopes: ["operator.read", "operator.write", "operator.admin"],
		});
	}, 15_000);

	afterAll(() => {
		client?.close();
	});

	/**
	 * Run a single tool-loop iteration:
	 * 1. Stream provider with tools
	 * 2. If tool_use returned, execute via Gateway
	 * 3. Send result back to provider
	 * 4. Return final text
	 */
	async function toolLoop(
		provider: import("../providers/types.js").LLMProvider,
		userMessage: string,
		tools: import("../providers/types.js").ToolDefinition[],
	): Promise<{ text: string; toolsExecuted: string[] }> {
		const systemPrompt =
			"You are a helpful assistant. You MUST use the available tools to answer. Reply briefly.";
		const messages: ChatMessage[] = [{ role: "user", content: userMessage }];
		const toolsExecuted: string[] = [];
		let fullText = "";

		for (let iteration = 0; iteration < 3; iteration++) {
			const chunks = await collectChunks(
				provider.stream(messages, systemPrompt, tools),
			);

			const textParts = chunks
				.filter((c) => c.type === "text")
				.map((c) => (c as { text: string }).text)
				.join("");

			const toolCalls = chunks.filter((c) => c.type === "tool_use") as Array<{
				type: "tool_use";
				id: string;
				name: string;
				args: Record<string, unknown>;
			}>;

			if (toolCalls.length === 0) {
				fullText += textParts;
				break;
			}

			// Add assistant message with tool calls
			messages.push({
				role: "assistant",
				content: textParts,
				toolCalls: toolCalls.map((tc) => ({
					id: tc.id,
					name: tc.name,
					args: tc.args,
				})),
			});

			// Execute each tool via Gateway
			for (const call of toolCalls) {
				toolsExecuted.push(call.name);
				const result = await executeTool(client, call.name, call.args, {});
				messages.push({
					role: "tool",
					content: result.success ? result.output : `Error: ${result.error}`,
					toolCallId: call.id,
					name: call.name,
				});
			}
		}

		return { text: fullText, toolsExecuted };
	}

	it("Gemini: tool_use → Gateway execute_command → follow-up response", async () => {
		const geminiKey = getKey("GEMINI_API_KEY");
		if (!geminiKey) return;

		const { createGeminiProvider } = await import("../providers/gemini.js");
		const provider = createGeminiProvider(geminiKey, "gemini-2.5-flash");

		const tools = getAllTools(true);
		const result = await toolLoop(
			provider,
			"현재 날짜와 시간이 뭐야? date 명령어로 확인해줘",
			tools,
		);

		// Model should have called execute_command
		expect(result.toolsExecuted.length).toBeGreaterThan(0);
		// Final text should contain some response
		expect(result.text.length).toBeGreaterThan(0);
	}, 60_000);

	it("Anthropic: tool_use → Gateway execute_command → follow-up response", async () => {
		const anthropicKey = getKey("ANTHROPIC_API_KEY");
		if (!anthropicKey) return;

		const { createAnthropicProvider } = await import(
			"../providers/anthropic.js"
		);
		const provider = createAnthropicProvider(
			anthropicKey,
			"claude-sonnet-4-5-20250929",
		);

		const tools = getAllTools(true);
		const result = await toolLoop(
			provider,
			"현재 날짜와 시간이 뭐야? date 명령어로 확인해줘",
			tools,
		);

		expect(result.toolsExecuted.length).toBeGreaterThan(0);
		expect(result.text.length).toBeGreaterThan(0);
	}, 60_000);

	it("xAI: tool_use → Gateway execute_command → follow-up response", async () => {
		const xaiKey = getKey("XAI_API_KEY");
		if (!xaiKey) return;

		const { createXAIProvider } = await import("../providers/xai.js");
		const provider = createXAIProvider(xaiKey, "grok-3-mini");

		const tools = getAllTools(true);
		const result = await toolLoop(
			provider,
			"현재 날짜와 시간이 뭐야? date 명령어로 확인해줘",
			tools,
		);

		expect(result.toolsExecuted.length).toBeGreaterThan(0);
		expect(result.text.length).toBeGreaterThan(0);
	}, 60_000);

	it("OpenAI: tool_use → Gateway execute_command → follow-up response", async () => {
		const openaiKey = getKey("OPENAI_API_KEY");
		if (!openaiKey) return;

		const { createOpenAIProvider } = await import("../providers/openai.js");
		const provider = createOpenAIProvider(openaiKey, "gpt-4.1-mini");

		const tools = getAllTools(true);
		const result = await toolLoop(
			provider,
			"현재 날짜와 시간이 뭐야? date 명령어로 확인해줘",
			tools,
		);

		expect(result.toolsExecuted.length).toBeGreaterThan(0);
		expect(result.text.length).toBeGreaterThan(0);
	}, 60_000);
});
