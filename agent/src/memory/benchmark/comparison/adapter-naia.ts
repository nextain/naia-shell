/**
 * Naia MemorySystem(Mem0Adapter) benchmark adapter.
 *
 * Supports multiple embedding backends:
 * - gemini: Gemini API (gemini-embedding-001, 3072d)
 * - solar: Upstage Solar API (embedding-query/passage, 4096d)
 * - qwen3: ollama local (qwen3-embedding, 2048d)
 * - bge-m3: ollama local (bge-m3, 1024d)
 */
import { randomUUID } from "node:crypto";
import { Mem0Adapter } from "../../adapters/mem0.js";
import { MemorySystem } from "../../index.js";
import type { BenchmarkAdapter } from "./types.js";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai/";
const GATEWAY_BASE = process.env.GATEWAY_URL ?? "";
const GATEWAY_KEY = process.env.GATEWAY_MASTER_KEY ?? "";
const GATEWAY_USER = "benchmark";
const UPSTAGE_BASE = "https://api.upstage.ai/v1/";
const OLLAMA_BASE = "http://localhost:11434/v1/";
const THROTTLE_MS = 3000;

export type EmbeddingBackend = "gemini" | "solar" | "qwen3" | "bge-m3";

interface EmbedderConfig {
	provider: string;
	config: Record<string, any>;
	dimension: number;
}

function getEmbedderConfig(
	backend: EmbeddingBackend,
	apiKey: string,
): EmbedderConfig {
	switch (backend) {
		case "gemini":
			// Use gateway (Vertex AI) if available, else direct AI Studio
			// Note: OpenAI SDK truncates text-embedding-004 to 192d by default,
			// so we set dimension to match (or pass dimensions param explicitly)
			return GATEWAY_KEY
				? {
						provider: "openai",
						config: {
							apiKey: GATEWAY_KEY,
							baseURL: `${GATEWAY_BASE}/v1/`,
							model: "vertexai:text-embedding-004",
							user: GATEWAY_USER,
						},
						dimension: 768,
					}
				: {
						provider: "openai",
						config: { apiKey, baseURL: GEMINI_BASE, model: "gemini-embedding-001" },
						dimension: 3072,
					};
		case "solar":
			return {
				provider: "openai",
				config: {
					apiKey: process.env.UPSTAGE_KEY ?? apiKey,
					baseURL: UPSTAGE_BASE,
					model: "embedding-passage",
				},
				dimension: 4096,
			};
		case "qwen3":
			return {
				provider: "openai",
				config: {
					apiKey: "ollama",
					baseURL: OLLAMA_BASE,
					model: "qwen3-embedding",
				},
				dimension: 4096,
			};
		case "bge-m3":
			return {
				provider: "openai",
				config: {
					apiKey: "ollama",
					baseURL: OLLAMA_BASE,
					model: "bge-m3",
				},
				dimension: 1024,
			};
	}
}

export class NaiaAdapter implements BenchmarkAdapter {
	readonly name: string;
	readonly description: string;

	private system: MemorySystem | null = null;
	private apiKey: string;
	private embedBackend: EmbeddingBackend;

	constructor(apiKey: string, embedBackend: EmbeddingBackend = "gemini") {
		this.apiKey = apiKey;
		this.embedBackend = embedBackend;
		this.name = embedBackend === "gemini" ? "naia" : `naia-${embedBackend}`;
		this.description = `MemorySystem(Mem0Adapter) — embed: ${embedBackend}`;
	}

	async init(cacheId?: string): Promise<void> {
		const dbPath = cacheId
			? `/tmp/mem0-bench-${this.name}-${cacheId}`
			: `/tmp/mem0-bench-${this.name}-${randomUUID()}`;
		const embedder = getEmbedderConfig(this.embedBackend, this.apiKey);
		const mem0Config = {
			embedder: {
				provider: embedder.provider,
				config: embedder.config,
			},
			vectorStore: {
				provider: "memory",
				config: {
					collectionName: "bench",
					dimension: embedder.dimension,
					dbPath: `${dbPath}-vec.db`,
				},
			},
			llm: GATEWAY_KEY
				? {
						provider: "openai",
						config: {
							apiKey: GATEWAY_KEY,
							baseURL: `${GATEWAY_BASE}/v1/`,
							model: "vertexai:gemini-2.5-flash",
							user: GATEWAY_USER,
						},
					}
				: this.embedBackend === "qwen3" || this.embedBackend === "bge-m3"
					? {
							provider: "openai",
							config: {
								apiKey: "ollama",
								baseURL: OLLAMA_BASE,
								model: "qwen3:8b",
							},
						}
					: {
							provider: "openai",
							config: {
								apiKey: this.apiKey,
								baseURL: GEMINI_BASE,
								model: "gemini-2.5-flash",
							},
						},
			historyDbPath: `${dbPath}-hist.db`,
		};
		const adapter = new Mem0Adapter({ mem0Config, userId: "bench" });
		this.system = new MemorySystem({ adapter });
	}

	async addFact(content: string): Promise<boolean> {
		if (!this.system) throw new Error("Not initialized");
		for (let attempt = 0; attempt < 3; attempt++) {
			await new Promise((r) => setTimeout(r, THROTTLE_MS * (attempt + 1)));
			try {
				const episode = await this.system.encode(
					{ content, role: "user" },
					{ project: "benchmark" },
				);
				return episode !== null;
			} catch (err: any) {
				if (attempt < 2) continue;
				return false;
			}
		}
		return false;
	}

	async search(query: string, topK: number): Promise<string[]> {
		if (!this.system) throw new Error("Not initialized");
		await new Promise((r) => setTimeout(r, THROTTLE_MS));
		const result = await this.system.recall(query, {
			project: "benchmark",
			topK,
		});
		const fmt = (ts: number) => new Date(ts).toISOString().slice(0, 10);
		const raw = [
			...result.facts.map((f) => `[${fmt(f.updatedAt)}] ${f.content}`),
			...result.episodes.map((e) => `[${fmt(e.timestamp)}] ${e.content}`),
		];
		return [...new Set(raw)];
	}

	async cleanup(): Promise<void> {
		if (this.system) await this.system.close();
	}
}
