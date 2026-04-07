/**
 * Super Agent Party benchmark adapter — mem0 + FAISS backend.
 *
 * Uses a persistent Python subprocess to maintain FAISS in-memory state
 * across addFact/search calls (FAISS is in-memory only).
 *
 * Requires: pip install mem0ai faiss-cpu in /tmp/sap-bench/ venv
 *
 * LLM/Embedding backend selection (priority order):
 *   1. Gateway (GATEWAY_URL + GATEWAY_MASTER_KEY env vars) — Vertex AI, no rate limits
 *   2. Direct AI Studio (GEMINI_API_KEY) — 1500 RPD free tier, may rate-limit
 *
 * Set env vars to use gateway:
 *   GATEWAY_URL=https://your-gateway GATEWAY_MASTER_KEY=your-key
 */
import { type ChildProcess, execSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { BenchmarkAdapter } from "./types.js";

const VENV = "/tmp/sap-bench";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai/";
const GATEWAY_BASE = process.env.GATEWAY_URL ?? "";
const GATEWAY_KEY = process.env.GATEWAY_MASTER_KEY ?? "";
const GATEWAY_USER = "benchmark";

export class SapAdapter implements BenchmarkAdapter {
	readonly name = "sap";
	readonly description =
		"Super Agent Party — mem0 + FAISS vector store + BM25 hybrid";

	private apiKey: string;
	private proc: ChildProcess | null = null;
	private buffer = "";

	constructor(apiKey: string) {
		this.apiKey = apiKey;
	}

	async init(cacheId?: string): Promise<void> {
		// Ensure venv and deps exist
		execSync(`python3 -m venv ${VENV} 2>/dev/null || true`, {
			stdio: "ignore",
		});
		execSync(
			`${VENV}/bin/pip install -q mem0ai faiss-cpu chromadb 2>/dev/null || true`,
			{ stdio: "ignore", timeout: 120000 },
		);

		const useGateway = !!(GATEWAY_BASE && GATEWAY_KEY);
		// cacheId: use ChromaDB (persistent) instead of FAISS (in-memory) so --skip-encode works
		const chromaPath = cacheId ? `/tmp/sap-bench-chroma-${cacheId}` : null;

		// Write persistent worker script
		// argv[1] = api_key, argv[2] = base_url, argv[3] = embed_dims, argv[4] = chroma_path (or "")
		const workerScript = `
import sys, json, os
from mem0 import Memory

api_key = sys.argv[1]
base_url = sys.argv[2]
embed_dims = int(sys.argv[3])
chroma_path = sys.argv[4] if len(sys.argv) > 4 else ""
embed_model = "vertexai:text-embedding-004" if "gateway" in base_url or embed_dims == 768 else "gemini-embedding-001"
llm_model = "vertexai:gemini-2.5-flash" if "gateway" in base_url or embed_dims == 768 else "gemini-2.5-flash"

if chroma_path:
    # Persistent vector store — reusable across runs (--skip-encode)
    vector_store = {"provider": "chroma", "config": {
        "collection_name": "bench",
        "path": chroma_path
    }}
else:
    # In-memory FAISS — fresh every run
    vector_store = {"provider": "faiss", "config": {"embedding_model_dims": embed_dims}}

config = {
    "embedder": {"provider": "openai", "config": {
        "api_key": api_key,
        "openai_base_url": base_url,
        "model": embed_model,
        "embedding_dims": embed_dims
    }},
    "vector_store": vector_store,
    "llm": {"provider": "openai", "config": {
        "api_key": api_key,
        "openai_base_url": base_url,
        "model": llm_model
    }}
}
m = Memory.from_config(config)

# Gemini rejects unknown fields like "store" that mem0ai injects into the request.
# Patch the LLM client to strip it from extra_body before sending.
_orig_post = m.llm.client.chat.completions.create
def _patched_create(**kwargs):
    kwargs.pop("store", None)
    return _orig_post(**kwargs)
m.llm.client.chat.completions.create = _patched_create

print("READY", flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        cmd = json.loads(line)
        if cmd["op"] == "add":
            m.add(cmd["content"], user_id="bench")
            print(json.dumps({"ok": True}), flush=True)
        elif cmd["op"] == "search":
            results = m.search(cmd["query"], user_id="bench", limit=cmd.get("topK", 10))
            if isinstance(results, dict):
                results = results.get("results", [])
            memories = [r.get("memory", r.get("text", "")) for r in results]
            print(json.dumps({"memories": memories}), flush=True)
        else:
            print(json.dumps({"error": "unknown op"}), flush=True)
    except Exception as e:
        print(json.dumps({"error": str(e)}), flush=True)
`;
		writeFileSync("/tmp/sap-bench-worker.py", workerScript);

		// Start persistent subprocess
		// Pass: api_key, base_url, embed_dims, chroma_path (empty = FAISS)
		const workerApiKey = useGateway ? GATEWAY_KEY : this.apiKey;
		const workerBaseUrl = useGateway ? `${GATEWAY_BASE}/v1/` : GEMINI_BASE;
		const workerEmbedDims = useGateway ? "768" : "3072";
		this.proc = spawn(
			`${VENV}/bin/python3`,
			["/tmp/sap-bench-worker.py", workerApiKey, workerBaseUrl, workerEmbedDims, chromaPath ?? ""],
			{
				stdio: ["pipe", "pipe", "pipe"],
				// mem0ai reads api_key from OPENAI_API_KEY env (config.api_key is ignored in some versions)
				env: { ...process.env, OPENAI_API_KEY: workerApiKey },
			},
		);

		// Wait for READY (mem0 init can take ~30s on first run — allow 90s)
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error("SAP worker timeout")),
				90000,
			);
			const onData = (data: Buffer) => {
				const text = data.toString();
				if (text.includes("READY")) {
					clearTimeout(timeout);
					this.proc?.stdout?.off("data", onData);
					resolve();
				}
			};
			this.proc?.stdout?.on("data", onData);
			this.proc?.stderr?.on("data", (d: Buffer) => {
				const err = d.toString();
				if (err.includes("Error") || err.includes("Traceback")) {
					console.error(`  SAP init stderr: ${err.slice(0, 200)}`);
				}
			});
		});
	}

	async addFact(content: string): Promise<boolean> {
		const result = await this.sendCommand({ op: "add", content });
		return result?.ok === true;
	}

	async search(query: string, topK: number): Promise<string[]> {
		const result = await this.sendCommand({ op: "search", query, topK });
		return result?.memories ?? [];
	}

	async cleanup(): Promise<void> {
		if (this.proc) {
			this.proc.stdin?.end();
			this.proc.kill();
			this.proc = null;
		}
	}

	private sendCommand(cmd: any): Promise<any> {
		return new Promise((resolve) => {
			if (!this.proc?.stdin?.writable) {
				resolve(null);
				return;
			}

			const timeout = setTimeout(() => {
				this.proc?.stdout?.off("data", onData);
				resolve(null);
			}, 60000);

			const onData = (data: Buffer) => {
				this.buffer += data.toString();
				const lines = this.buffer.split("\n");
				for (let i = 0; i < lines.length - 1; i++) {
					const line = lines[i].trim();
					if (line.startsWith("{")) {
						try {
							const parsed = JSON.parse(line);
							clearTimeout(timeout);
							this.proc?.stdout?.off("data", onData);
							this.buffer = lines.slice(i + 1).join("\n");
							resolve(parsed);
							return;
						} catch {}
					}
				}
				this.buffer = lines[lines.length - 1];
			};

			this.proc?.stdout?.on("data", onData);
			this.proc?.stdin?.write(`${JSON.stringify(cmd)}\n`);
		});
	}
}
