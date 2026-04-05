/**
 * Raw mem0 OSS benchmark adapter — no Naia layer.
 *
 * LLM/Embedding backend selection (priority order):
 *   1. Gateway (GATEWAY_URL + GATEWAY_MASTER_KEY env vars) — Vertex AI, no rate limits
 *   2. Direct AI Studio (GEMINI_API_KEY) — 1500 RPD free tier, may rate-limit
 *
 * Set env vars to use gateway:
 *   GATEWAY_URL=https://your-gateway GATEWAY_MASTER_KEY=your-key
 */
import { randomUUID } from "node:crypto";
import type { BenchmarkAdapter } from "./types.js";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai/";
const GATEWAY_BASE = process.env.GATEWAY_URL ?? "";
const GATEWAY_KEY = process.env.GATEWAY_MASTER_KEY ?? "";
const GATEWAY_USER = "benchmark";
const THROTTLE_MS = 2000;
const ADD_TIMEOUT_MS = 60000; // 60s — mem0 LLM dedup call timeout

export class Mem0Adapter implements BenchmarkAdapter {
	readonly name = "mem0";
	readonly description =
		"mem0 OSS — vector search only, no importance gating or decay";

	private mem0: any = null;
	private apiKey: string;

	constructor(apiKey: string) {
		this.apiKey = apiKey;
	}

	async init(cacheId?: string): Promise<void> {
		const { Memory } = await import("mem0ai/oss");
		// cacheId: fixed path for --skip-encode reuse. Without it, use random UUID (fresh DB).
		const dbPath = cacheId
			? `/tmp/mem0-bench-mem0-${cacheId}`
			: `/tmp/mem0-bench-raw-${randomUUID()}`;

		const useGateway = !!(GATEWAY_BASE && GATEWAY_KEY);

		// EmbeddingConfig/LLMConfig types omit `user` but the openai provider accepts it
		this.mem0 = new Memory({
			embedder: {
				provider: "openai",
				config: (useGateway
					? {
							apiKey: GATEWAY_KEY,
							baseURL: `${GATEWAY_BASE}/v1/`,
							model: "vertexai:text-embedding-004",
							user: GATEWAY_USER,
						}
					: {
							apiKey: this.apiKey,
							baseURL: GEMINI_BASE,
							model: "gemini-embedding-001",
						}) as any,
			},
			vectorStore: {
				provider: "memory",
				config: {
					collectionName: "bench",
					// gateway: text-embedding-004 default dim=768; direct: gemini-embedding-001 dim=3072
					dimension: useGateway ? 768 : 3072,
					dbPath: `${dbPath}-vec.db`,
				},
			},
			llm: {
				provider: "openai",
				config: (useGateway
					? {
							apiKey: GATEWAY_KEY,
							baseURL: `${GATEWAY_BASE}/v1/`,
							model: "vertexai:gemini-2.5-flash",
							user: GATEWAY_USER,
						}
					: {
							apiKey: this.apiKey,
							baseURL: GEMINI_BASE,
							model: "gemini-2.5-flash",
							// NOTE: mem0ai JS v2.4.2 OpenAILLM constructor ignores `timeout` config —
							// it only passes apiKey+baseURL to OpenAI client. Real hang protection is
							// via Promise.race in addFact() below.
						}) as any,
			},
			historyDbPath: `${dbPath}-hist.db`,
		});
	}

	async addFact(content: string): Promise<boolean> {
		if (!this.mem0) throw new Error("Not initialized");
		await new Promise((r) => setTimeout(r, THROTTLE_MS));
		try {
			const timeout = new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error(`mem0 addFact timeout after ${ADD_TIMEOUT_MS}ms`)), ADD_TIMEOUT_MS),
			);
			await Promise.race([
				this.mem0.add([{ role: "user", content }], { userId: "bench" }),
				timeout,
			]);
			return true;
		} catch (err: any) {
			// mem0 internal errors (e.g. "Memory with ID undefined not found") or
			// LLM timeout — log and continue, don't hang.
			console.error(`  mem0 addFact error: ${err?.message?.slice(0, 120)}`);
			return false;
		}
	}

	async search(query: string, topK: number): Promise<string[]> {
		if (!this.mem0) throw new Error("Not initialized");
		await new Promise((r) => setTimeout(r, THROTTLE_MS));
		const raw = await this.mem0.search(query, { userId: "bench", limit: topK });
		return [
			...new Set(
				(raw?.results ?? raw ?? []).map((r: any) => r.memory ?? r.text ?? ""),
			),
		] as string[];
	}

	async cleanup(): Promise<void> {
		// mem0 has no explicit close
	}
}
