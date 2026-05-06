/**
 * E2E tests: Custom skills discovery and tool delivery
 *
 * Verifies that:
 * 1. Custom skills from ~/.naia/skills/ are loaded into the registry
 * 2. Gateway-type skills are included/excluded based on hasGateway flag
 * 3. System prompt includes tool names for LLM visibility
 * 4. Korean keyword → English skill name mapping is viable
 * 5. skill_skill_manager can search for skills by keyword
 *
 * Run (unit — no Gateway needed):
 *   pnpm exec vitest run src/__tests__/custom-skills-discovery.test.ts
 *
 * Run (live — requires Gateway):
 *   CAFE_LIVE_GATEWAY_E2E=1 pnpm exec vitest run src/__tests__/custom-skills-discovery.test.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GatewayClient } from "../gateway/client.js";
import { loadDeviceIdentity } from "../gateway/device-identity.js";
import {
	executeTool,
	getAllTools,
	skillRegistry,
} from "../gateway/tool-bridge.js";
import type { ChatMessage, StreamChunk } from "../providers/types.js";
import {
	ALPHA_SYSTEM_PROMPT,
	buildToolStatusPrompt,
} from "../system-prompt.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Unit tests (no Gateway needed) ──

describe("custom skills: registry and tool delivery", () => {
	// Known custom skills that should be bootstrapped from assets/default-skills/
	const EXPECTED_CUSTOM_SKILLS = [
		"skill_obsidian",
		"skill_github",
		"skill_discord",
		"skill_slack",
		"skill_notion",
		"skill_canvas",
		"skill_trello",
		"skill_spotify-player",
	];

	const BUILT_IN_SKILLS = [
		"skill_time",
		"skill_system_status",
		"skill_memo",
		"skill_weather",
		"skill_skill_manager",
		"skill_naia_discord",
		"skill_cron",
	];

	const GATEWAY_TOOLS = [
		"execute_command",
		"read_file",
		"write_file",
		"search_files",
		"web_search",
		"apply_diff",
		"browser",
		"sessions_spawn",
	];

	describe("skill registry loading", () => {
		it("has at least 20 built-in skills registered", () => {
			for (const name of BUILT_IN_SKILLS) {
				expect(skillRegistry.has(name), `Missing built-in: ${name}`).toBe(true);
			}
			// Total should be well above 20 (built-in + custom)
			expect(skillRegistry.list().length).toBeGreaterThanOrEqual(20);
		});

		it("has custom skills loaded from ~/.naia/skills/", () => {
			const all = skillRegistry.list();
			const customCount = all.filter((s) => s.source).length;
			expect(customCount).toBeGreaterThan(0);
		});

		it("registers expected custom skills", () => {
			for (const name of EXPECTED_CUSTOM_SKILLS) {
				expect(
					skillRegistry.has(name),
					`Expected ${name} to be registered`,
				).toBe(true);
			}
		});

		it("registers expected built-in skills", () => {
			for (const name of BUILT_IN_SKILLS) {
				expect(
					skillRegistry.has(name),
					`Expected ${name} to be registered`,
				).toBe(true);
			}
		});

		it("custom gateway skills have requiresGateway=true", () => {
			for (const name of EXPECTED_CUSTOM_SKILLS) {
				const skill = skillRegistry.get(name);
				if (skill) {
					expect(skill.requiresGateway, `${name} should require gateway`).toBe(
						true,
					);
				}
			}
		});
	});

	describe("getAllTools gateway filtering", () => {
		it("includes custom skills when hasGateway=true", () => {
			const tools = getAllTools(true);
			const names = tools.map((t) => t.name);
			for (const name of EXPECTED_CUSTOM_SKILLS) {
				expect(names, `getAllTools(true) should include ${name}`).toContain(
					name,
				);
			}
		});

		it("excludes gateway-requiring custom skills when hasGateway=false", () => {
			const tools = getAllTools(false);
			const names = tools.map((t) => t.name);
			for (const name of EXPECTED_CUSTOM_SKILLS) {
				expect(
					names,
					`getAllTools(false) should NOT include ${name}`,
				).not.toContain(name);
			}
		});

		it("always includes built-in local skills regardless of gateway", () => {
			const toolsNoGw = getAllTools(false);
			const names = toolsNoGw.map((t) => t.name);
			expect(names).toContain("skill_time");
			expect(names).toContain("skill_weather");
			expect(names).toContain("skill_system_status");
			expect(names).toContain("skill_memo");
		});

		it("includes 8 gateway tools when hasGateway=true", () => {
			const tools = getAllTools(true);
			const names = tools.map((t) => t.name);
			for (const name of GATEWAY_TOOLS) {
				expect(names).toContain(name);
			}
		});

		it("total tools with gateway >= 50", () => {
			const tools = getAllTools(true);
			expect(tools.length).toBeGreaterThanOrEqual(50);
		});

		it("every tool has name, description, and parameters", () => {
			const tools = getAllTools(true);
			for (const tool of tools) {
				expect(tool.name, "tool must have name").toBeTruthy();
				expect(
					tool.description,
					`${tool.name} must have description`,
				).toBeTruthy();
				expect(
					tool.parameters,
					`${tool.name} must have parameters`,
				).toBeDefined();
			}
		});
	});

	describe("buildToolStatusPrompt injects tool usage rules", () => {
		const tools = getAllTools(true);
		const prompt = buildToolStatusPrompt("base", true, true, true, tools);

		it("contains Tool Usage Rules CRITICAL section", () => {
			expect(prompt).toContain("Tool Usage Rules (CRITICAL)");
		});

		it("contains skill_skill_manager search instruction", () => {
			expect(prompt).toContain("skill_skill_manager");
			expect(prompt).toContain("옵시디안");
		});

		it("forbids empty promises without tool calls", () => {
			expect(prompt).toContain("FORBIDDEN");
		});

		it("instructs to use skill_github for GitHub queries", () => {
			expect(prompt).toContain("skill_github");
		});

		it("contains Discord tool guide when skill_naia_discord available", () => {
			expect(prompt).toContain("[Tool Guide: skill_naia_discord]");
			expect(prompt).toContain("NEVER use a built-in 'message' tool");
		});

		it("lists available tool count and names", () => {
			expect(prompt).toContain(`사용 가능한 도구(${tools.length}개)`);
		});

		it("shows gateway connected status", () => {
			expect(prompt).toContain("Gateway 연결됨");
		});

		it("shows gateway failure with specific tool names when disconnected", () => {
			const failPrompt = buildToolStatusPrompt(
				"base",
				true,
				true,
				false,
				tools,
			);
			expect(failPrompt).toContain("execute_command");
			expect(failPrompt).toContain("로컬 스킬");
		});
	});

	describe("ALPHA_SYSTEM_PROMPT fallback content", () => {
		it("contains personality and app features", () => {
			expect(ALPHA_SYSTEM_PROMPT).toContain("Naia");
			expect(ALPHA_SYSTEM_PROMPT).toContain("App Features");
			expect(ALPHA_SYSTEM_PROMPT).toContain("skill_skill_manager");
		});

		it("does NOT contain duplicated tool usage rules (handled by buildToolStatusPrompt)", () => {
			expect(ALPHA_SYSTEM_PROMPT).not.toContain("Tool Usage (CRITICAL");
			expect(ALPHA_SYSTEM_PROMPT).not.toContain("FORBIDDEN");
		});

		it("does NOT contain duplicated emotion/discord instructions (handled by persona.ts/buildToolStatusPrompt)", () => {
			expect(ALPHA_SYSTEM_PROMPT).not.toContain(
				"Emotion tags (for Shell avatar only)",
			);
			expect(ALPHA_SYSTEM_PROMPT).not.toContain(
				"skill_naia_discord has EXACTLY 3 actions",
			);
		});
	});

	describe("Korean keyword → skill name mapping", () => {
		// Mapping of Korean keywords to expected skill names
		const KOREAN_SKILL_MAP: Record<string, string> = {
			obsidian: "skill_obsidian",
			github: "skill_github",
			discord: "skill_discord",
			slack: "skill_slack",
			notion: "skill_notion",
			trello: "skill_trello",
			spotify: "skill_spotify-player",
			canvas: "skill_canvas",
			weather: "skill_weather",
			memo: "skill_memo",
		};

		it("all mapped skills exist in registry", () => {
			for (const [keyword, skillName] of Object.entries(KOREAN_SKILL_MAP)) {
				expect(
					skillRegistry.has(skillName),
					`Keyword "${keyword}" should map to ${skillName}`,
				).toBe(true);
			}
		});

		it("tool descriptions or names contain searchable English keywords", () => {
			const tools = getAllTools(true);
			for (const [keyword, skillName] of Object.entries(KOREAN_SKILL_MAP)) {
				const tool = tools.find((t) => t.name === skillName);
				expect(tool, `${skillName} should be in tools`).toBeDefined();
				// Either description or tool name should contain the keyword
				const desc = tool?.description?.toLowerCase() ?? "";
				const tname = tool?.name?.toLowerCase() ?? "";
				const found =
					desc.includes(keyword.toLowerCase()) ||
					tname.includes(keyword.toLowerCase());
				expect(
					found,
					`${skillName} description or name should contain "${keyword}" but got name="${tool?.name}", desc="${tool?.description}"`,
				).toBe(true);
			}
		});
	});
});

// ── Live E2E tests (requires Gateway) ──

const LIVE_E2E = process.env.CAFE_LIVE_GATEWAY_E2E === "1";

function loadGatewayToken(): string | null {
	const paths = [
		join(homedir(), ".naia", "gateway.json"),
	];
	for (const p of paths) {
		try {
			const config = JSON.parse(readFileSync(p, "utf-8"));
			const token = config.gateway?.auth?.token;
			if (token) return token;
		} catch {}
	}
	return null;
}

const gatewayToken = loadGatewayToken();
const deviceIdentity = loadDeviceIdentity();
const canRunE2E =
	LIVE_E2E && gatewayToken !== null && deviceIdentity !== undefined;

let client: GatewayClient;

describe.skipIf(!canRunE2E)("E2E: Custom skills live execution", () => {
	beforeAll(async () => {
		client = new GatewayClient();
		await client.connect("ws://localhost:18789", {
			token: gatewayToken!,
			device: deviceIdentity,
		});
	});

	afterAll(() => {
		client?.close();
	});

	it("skill_skill_manager can list skills", async () => {
		const result = await executeTool(client, "skill_skill_manager", {
			action: "list",
		});
		expect(result.success).toBe(true);
		expect(result.output).toContain("skill_obsidian");
		expect(result.output).toContain("skill_github");
		expect(result.output).toContain("skill_discord");
	});

	it("skill_skill_manager can search by query 'obsidian'", async () => {
		const result = await executeTool(client, "skill_skill_manager", {
			action: "search",
			query: "obsidian",
		});
		expect(result.success).toBe(true);
		expect(result.output.toLowerCase()).toContain("obsidian");
	});

	it("skill_skill_manager can search by query 'github'", async () => {
		const result = await executeTool(client, "skill_skill_manager", {
			action: "search",
			query: "github",
		});
		expect(result.success).toBe(true);
		expect(result.output.toLowerCase()).toContain("github");
	});

	it("skill_skill_manager returns info for a specific skill", async () => {
		const result = await executeTool(client, "skill_skill_manager", {
			action: "info",
			skillName: "skill_obsidian",
		});
		expect(result.success).toBe(true);
		expect(result.output.toLowerCase()).toContain("obsidian");
	});
});

// ── Live LLM E2E: Korean natural language → tool_use verification ──
// Proves that the AI actually calls the right tool when asked in Korean

const LIVE_LLM_E2E = process.env.CAFE_LIVE_PROVIDER_E2E === "1" && LIVE_E2E;

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

const envKeys = LIVE_LLM_E2E ? loadEnvKeys() : {};
function getKey(name: string): string {
	return process.env[name] || envKeys[name] || "";
}

async function collectChunks(
	stream: AsyncGenerator<StreamChunk, void, undefined>,
): Promise<StreamChunk[]> {
	const chunks: StreamChunk[] = [];
	for await (const chunk of stream) {
		chunks.push(chunk);
	}
	return chunks;
}

/**
 * Run a single LLM call with tools and return which tools were called.
 * Does NOT execute tools — only checks if the LLM emits tool_use.
 */
async function checkToolSelection(
	provider: import("../providers/types.js").LLMProvider,
	userMessage: string,
	tools: import("../providers/types.js").ToolDefinition[],
	systemPrompt: string,
): Promise<{ toolsCalled: string[]; text: string }> {
	const messages: ChatMessage[] = [{ role: "user", content: userMessage }];
	const chunks = await collectChunks(
		provider.stream(messages, systemPrompt, tools),
	);

	const toolCalls = chunks
		.filter((c) => c.type === "tool_use")
		.map((c) => (c as { name: string }).name);

	const text = chunks
		.filter((c) => c.type === "text")
		.map((c) => (c as { text: string }).text)
		.join("");

	return { toolsCalled: toolCalls, text };
}

describe.skipIf(!LIVE_LLM_E2E)(
	"Live LLM E2E: Korean skill discovery via tool_use",
	() => {
		const tools = getAllTools(true);
		// Use buildToolStatusPrompt to get the real prompt the LLM sees
		const systemPrompt = buildToolStatusPrompt(
			ALPHA_SYSTEM_PROMPT,
			true,
			true,
			true,
			tools,
		);

		describe("Gemini", () => {
			const apiKey = getKey("GEMINI_API_KEY");

			it.skipIf(!apiKey)(
				"한국어 '옵시디안 스킬 찾아줘' → skill_skill_manager 호출",
				async () => {
					const { createGeminiProvider } = await import(
						"../providers/gemini.js"
					);
					const provider = createGeminiProvider(apiKey, "gemini-2.5-flash");
					const result = await checkToolSelection(
						provider,
						"옵시디안 스킬 찾아줘",
						tools,
						systemPrompt,
					);

					// Gemini should call skill_skill_manager or skill_obsidian
					const calledRelevant = result.toolsCalled.some(
						(name) =>
							name === "skill_skill_manager" || name === "skill_obsidian",
					);
					expect(
						calledRelevant,
						`Expected skill_skill_manager or skill_obsidian but got: [${result.toolsCalled.join(", ")}] text: "${result.text.substring(0, 100)}"`,
					).toBe(true);
				},
				60_000,
			);

			it.skipIf(!apiKey)(
				"한국어 'GitHub PR 확인해줘' → skill_github 호출",
				async () => {
					const { createGeminiProvider } = await import(
						"../providers/gemini.js"
					);
					const provider = createGeminiProvider(apiKey, "gemini-2.5-flash");
					const result = await checkToolSelection(
						provider,
						"nextain/naia-os GitHub PR 확인해줘",
						tools,
						systemPrompt,
					);

					const calledRelevant = result.toolsCalled.some(
						(name) => name === "skill_github" || name === "execute_command",
					);
					expect(
						calledRelevant,
						`Expected skill_github or execute_command but got: [${result.toolsCalled.join(", ")}] text: "${result.text.substring(0, 100)}"`,
					).toBe(true);
				},
				60_000,
			);

			it.skipIf(!apiKey)(
				"한국어 '지금 몇시야' → skill_time 호출",
				async () => {
					const { createGeminiProvider } = await import(
						"../providers/gemini.js"
					);
					const provider = createGeminiProvider(apiKey, "gemini-2.5-flash");
					const result = await checkToolSelection(
						provider,
						"지금 몇시야?",
						tools,
						systemPrompt,
					);

					const calledRelevant = result.toolsCalled.some(
						(name) => name === "skill_time",
					);
					expect(
						calledRelevant,
						`Expected skill_time but got: [${result.toolsCalled.join(", ")}] text: "${result.text.substring(0, 100)}"`,
					).toBe(true);
				},
				60_000,
			);
		});

		describe("Anthropic", () => {
			const apiKey = getKey("ANTHROPIC_API_KEY");

			it.skipIf(!apiKey)(
				"한국어 '옵시디안 스킬 찾아줘' → skill_skill_manager 호출",
				async () => {
					const { createAnthropicProvider } = await import(
						"../providers/anthropic.js"
					);
					const provider = createAnthropicProvider(
						apiKey,
						"claude-sonnet-4-5-20250929",
					);
					const result = await checkToolSelection(
						provider,
						"옵시디안 스킬 찾아줘",
						tools,
						systemPrompt,
					);

					const calledRelevant = result.toolsCalled.some(
						(name) =>
							name === "skill_skill_manager" || name === "skill_obsidian",
					);
					expect(
						calledRelevant,
						`Expected skill_skill_manager or skill_obsidian but got: [${result.toolsCalled.join(", ")}] text: "${result.text.substring(0, 100)}"`,
					).toBe(true);
				},
				60_000,
			);
		});

		describe("OpenAI", () => {
			const apiKey = getKey("OPENAI_API_KEY");

			it.skipIf(!apiKey)(
				"한국어 '옵시디안 스킬 찾아줘' → skill_skill_manager 호출",
				async () => {
					const { createOpenAIProvider } = await import(
						"../providers/openai.js"
					);
					const provider = createOpenAIProvider(apiKey, "gpt-4.1-mini");
					const result = await checkToolSelection(
						provider,
						"옵시디안 스킬 찾아줘",
						tools,
						systemPrompt,
					);

					const calledRelevant = result.toolsCalled.some(
						(name) =>
							name === "skill_skill_manager" || name === "skill_obsidian",
					);
					expect(
						calledRelevant,
						`Expected skill_skill_manager or skill_obsidian but got: [${result.toolsCalled.join(", ")}] text: "${result.text.substring(0, 100)}"`,
					).toBe(true);
				},
				60_000,
			);
		});

		// ── Multi-language skill discovery ──
		describe("Gemini multi-language", () => {
			const apiKey = getKey("GEMINI_API_KEY");

			// Native transliterations — NO English "Obsidian" in the query
			const LANGUAGE_TESTS = [
				{
					lang: "Japanese",
					query: "オブシディアンのスキルを探して",
					skill: "obsidian",
				},
				{ lang: "Chinese", query: "帮我找黑曜石笔记的技能", skill: "obsidian" },
				{
					lang: "English",
					query: "Find the obsidian note-taking skill",
					skill: "obsidian",
				},
				{
					lang: "French",
					query: "Cherche le skill pour les notes obsidienne",
					skill: "obsidian",
				},
				{
					lang: "Spanish",
					query: "Busca el skill de notas obsidiana",
					skill: "obsidian",
				},
			];

			for (const { lang, query, skill } of LANGUAGE_TESTS) {
				it.skipIf(!apiKey)(
					`${lang}: "${query}" → skill_skill_manager or skill_${skill}`,
					async () => {
						const { createGeminiProvider } = await import(
							"../providers/gemini.js"
						);
						const provider = createGeminiProvider(apiKey, "gemini-2.5-flash");
						const result = await checkToolSelection(
							provider,
							query,
							tools,
							systemPrompt,
						);

						const calledRelevant = result.toolsCalled.some(
							(name) =>
								name === "skill_skill_manager" || name === `skill_${skill}`,
						);
						expect(
							calledRelevant,
							`[${lang}] Expected skill_skill_manager or skill_${skill} but got: [${result.toolsCalled.join(", ")}] text: "${result.text.substring(0, 100)}"`,
						).toBe(true);
					},
					60_000,
				);
			}
		});
	},
);
