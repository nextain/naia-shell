/**
 * Graphiti benchmark adapter — temporal knowledge graph memory.
 *
 * Graphiti (by getzep) builds a knowledge graph from conversation messages,
 * extracting entities and relationships with temporal validity tracking.
 * Unlike vector stores, it stores typed facts (edges) between entity nodes.
 *
 * https://github.com/getzep/graphiti
 *
 * Requires a running Graphiti server + Neo4j:
 *   See scripts in benchmark/comparison/scripts/graphiti/
 *
 * Note: POST /messages is async (202 Accepted). After all facts are ingested,
 * we must wait for the async queue to drain before querying.
 *
 * Env:
 *   GRAPHITI_URL=http://localhost:8000  (default)
 */
import type { BenchmarkAdapter } from "./types.js";

const BASE_URL = process.env.GRAPHITI_URL ?? "http://localhost:8000";
const THROTTLE_MS = 300;
// Wait after all facts ingested for async graph-build to complete
const POST_INGEST_WAIT_MS = 60_000;

export class GraphitiAdapter implements BenchmarkAdapter {
	readonly name = "graphiti";
	readonly description =
		"Graphiti — temporal knowledge graph (entity + edge extraction via LLM)";

	private groupId = "";
	private factCount = 0;

	async init(): Promise<void> {
		// Health check
		const res = await fetch(`${BASE_URL}/healthcheck`);
		if (!res.ok) throw new Error(`Graphiti not running at ${BASE_URL}`);

		this.groupId = `bench-${Date.now()}`;
		this.factCount = 0;
	}

	async addFact(content: string): Promise<boolean> {
		await new Promise((r) => setTimeout(r, THROTTLE_MS));
		const res = await fetch(`${BASE_URL}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				group_id: this.groupId,
				messages: [
					{
						content,
						role_type: "user",
						role: "user",
						source_description: "benchmark fact",
					},
				],
			}),
		});
		// 202 Accepted = queued for async processing
		if (res.status === 202 || res.ok) {
			this.factCount++;
			return true;
		}
		console.error(
			`  graphiti addFact: ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`,
		);
		return false;
	}

	/**
	 * Called by the benchmark runner after all facts are ingested.
	 * Graphiti processes episodes asynchronously — we wait for the queue to drain.
	 */
	async waitForReady(): Promise<void> {
		if (this.factCount === 0) return;
		console.log(
			`  graphiti: waiting ${POST_INGEST_WAIT_MS / 1000}s for async graph build (${this.factCount} facts queued)...`,
		);
		await new Promise((r) => setTimeout(r, POST_INGEST_WAIT_MS));
	}

	async search(query: string, topK: number): Promise<string[]> {
		const res = await fetch(`${BASE_URL}/search`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				group_ids: [this.groupId],
				query,
				max_facts: topK,
			}),
		});
		if (!res.ok) {
			console.error(`  graphiti search: ${res.status}`);
			return [];
		}
		const data = await res.json();
		return (data.facts ?? []).map((f: { fact: string }) => f.fact).filter(Boolean);
	}

	async cleanup(): Promise<void> {
		if (!this.groupId) return;
		try {
			await fetch(`${BASE_URL}/group/${this.groupId}`, { method: "DELETE" });
		} catch {}
	}
}
