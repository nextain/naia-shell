#!/usr/bin/env tsx
/**
 * 사용자 직접 검증용 smoke script — 실 LLM API call 라운드트립.
 *
 * 사용법:
 *   1. env file source (alpha-adk private-data):
 *      set -a; source ../../../data-private/llm-keys/llm.env; set +a
 *      (또는 원본: source ~/dev/my-envs/naia.nextain.io.env)
 *   2. provider별 실행:
 *      pnpm exec tsx scripts/smoke-chat.ts gemini
 *      pnpm exec tsx scripts/smoke-chat.ts gemini-external  # NEXTAIN_GEMINI=1 시뮬
 *      pnpm exec tsx scripts/smoke-chat.ts gemini-compat    # NEXTAIN_GEMINI=openai-compat
 *      pnpm exec tsx scripts/smoke-chat.ts zai
 *      pnpm exec tsx scripts/smoke-chat.ts zai-external
 *      pnpm exec tsx scripts/smoke-chat.ts lab-proxy        # naiaKey + GATEWAY_URL
 *      pnpm exec tsx scripts/smoke-chat.ts lab-proxy-external
 *
 * Required env (provider별):
 *   - gemini, gemini-external, gemini-compat: GEMINI_API_KEY
 *   - zai, zai-external: GLM_API_KEY
 *   - lab-proxy, lab-proxy-external: GATEWAY_URL + GATEWAY_MASTER_KEY
 *
 * 검증 내용:
 *   1. provider 인스턴스 생성 (factory.buildProvider)
 *   2. provider.stream() 라운드트립 (실 API call)
 *   3. text chunk 수신 + 누적
 *   4. usage / finish chunk 수신
 *   5. AbortSignal 정상 작동 (5초 timeout)
 *
 * Break 발생 시:
 *   - stack trace 전체 공유 → 본 세션에서 fix
 */

import { buildProvider } from "../src/providers/factory.js";
import type { ChatMessage } from "../src/providers/types.js";

const TARGET = process.argv[2];
if (!TARGET) {
	console.error("Usage: smoke-chat.ts <provider>");
	console.error("  providers: gemini | gemini-external | gemini-compat | zai | zai-external | lab-proxy | lab-proxy-external");
	process.exit(1);
}

interface SmokeConfig {
	provider: string;
	model: string;
	apiKey: string;
	naiaKey?: string;
	labGatewayUrl?: string;
	envFlags: Record<string, string>;
}

function configFor(target: string): SmokeConfig {
	const env = process.env;
	switch (target) {
		case "gemini":
			return {
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: env["GEMINI_API_KEY"] ?? "",
				envFlags: {},
			};
		case "gemini-external":
			return {
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: env["GEMINI_API_KEY"] ?? "",
				envFlags: { NEXTAIN_GEMINI: "1" },
			};
		case "gemini-compat":
			return {
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: env["GEMINI_API_KEY"] ?? "",
				envFlags: { NEXTAIN_GEMINI: "openai-compat" },
			};
		case "zai":
			return {
				provider: "zai",
				model: "glm-4-plus",
				apiKey: env["GLM_API_KEY"] ?? env["ZHIPU_API_KEY"] ?? "",
				envFlags: {},
			};
		case "zai-external":
			return {
				provider: "zai",
				model: "glm-4-plus",
				apiKey: env["GLM_API_KEY"] ?? env["ZHIPU_API_KEY"] ?? "",
				envFlags: { NEXTAIN_ZAI: "1" },
			};
		case "lab-proxy":
			return {
				provider: "anthropic",  // ignored when naiaKey set
				model: "claude-opus-4-7",
				apiKey: "",
				naiaKey: env["GATEWAY_MASTER_KEY"] ?? "",
				labGatewayUrl: env["GATEWAY_URL"],
				envFlags: {},
			};
		case "lab-proxy-external":
			return {
				provider: "anthropic",
				model: "claude-opus-4-7",
				apiKey: "",
				naiaKey: env["GATEWAY_MASTER_KEY"] ?? "",
				labGatewayUrl: env["GATEWAY_URL"],
				envFlags: { NEXTAIN_LAB_PROXY: "1" },
			};
		default:
			console.error(`Unknown provider target: ${target}`);
			process.exit(1);
	}
}

async function main() {
	const cfg = configFor(TARGET);

	// Validate required key
	if (!cfg.apiKey && !cfg.naiaKey) {
		console.error(`[smoke-chat] Missing required key for ${TARGET}.`);
		console.error("Source env file first: set -a; source ~/dev/my-envs/naia.nextain.io.env; set +a");
		process.exit(2);
	}

	// Apply env flags (per-provider strangler routing)
	for (const [k, v] of Object.entries(cfg.envFlags)) {
		process.env[k] = v;
	}

	console.log(`[smoke-chat] target=${TARGET}`);
	console.log(`[smoke-chat]   provider=${cfg.provider}, model=${cfg.model}`);
	console.log(`[smoke-chat]   env flags: ${JSON.stringify(cfg.envFlags)}`);
	console.log(`[smoke-chat]   apiKey=${cfg.apiKey ? "<set>" : "<empty>"} naiaKey=${cfg.naiaKey ? "<set>" : "<empty>"}`);
	console.log(`[smoke-chat]   gateway=${cfg.labGatewayUrl ?? "<default>"}`);
	console.log("");

	const buildOpts: Parameters<typeof buildProvider>[0] = {
		provider: cfg.provider,
		model: cfg.model,
		apiKey: cfg.apiKey,
	};
	if (cfg.naiaKey) buildOpts.naiaKey = cfg.naiaKey;
	if (cfg.labGatewayUrl) buildOpts.labGatewayUrl = cfg.labGatewayUrl;

	let provider;
	try {
		provider = buildProvider(buildOpts);
	} catch (err) {
		console.error(`[smoke-chat] buildProvider FAIL:`, err);
		process.exit(3);
	}

	console.log(`[smoke-chat] provider built ✓`);

	const messages: ChatMessage[] = [{ role: "user", content: "Say 'hi' in one word." }];
	const systemPrompt = "You are a helpful assistant. Reply concisely.";

	const ac = new AbortController();
	const timeout = setTimeout(() => ac.abort(), 30_000);

	let totalText = "";
	let chunkCount = 0;
	let usageInput = 0;
	let usageOutput = 0;
	let toolCallCount = 0;
	const start = Date.now();

	try {
		for await (const chunk of provider.stream(messages, systemPrompt, undefined, ac.signal)) {
			chunkCount++;
			if (chunk.type === "text") {
				totalText += chunk.text;
				process.stdout.write(chunk.text);
			} else if (chunk.type === "thinking") {
				// silent — internal reasoning
			} else if (chunk.type === "tool_use") {
				toolCallCount++;
				console.log(`\n[smoke-chat] tool_use: ${chunk.name}(${JSON.stringify(chunk.args)})`);
			} else if (chunk.type === "usage") {
				usageInput = chunk.inputTokens;
				usageOutput = chunk.outputTokens;
			} else if (chunk.type === "audio") {
				console.log(`\n[smoke-chat] audio chunk: ${chunk.data.length} bytes base64`);
			} else if (chunk.type === "finish") {
				// end
			}
		}
	} catch (err) {
		clearTimeout(timeout);
		console.error(`\n[smoke-chat] stream FAIL:`, err);
		console.error(`[smoke-chat] partial text: "${totalText}"`);
		process.exit(4);
	}
	clearTimeout(timeout);

	const elapsed = Date.now() - start;
	console.log("");
	console.log("");
	console.log(`[smoke-chat] DONE ✓`);
	console.log(`  text length: ${totalText.length}`);
	console.log(`  chunk count: ${chunkCount}`);
	console.log(`  tool_use calls: ${toolCallCount}`);
	console.log(`  usage: ${usageInput} in / ${usageOutput} out tokens`);
	console.log(`  elapsed: ${elapsed}ms`);
}

main().catch((err) => {
	console.error("[smoke-chat] uncaught:", err);
	process.exit(99);
});
