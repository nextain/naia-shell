/**
 * Zep CE benchmark adapter — session-based memory via REST API.
 *
 * Requires a running Zep CE stack (4 containers: zep, postgres, neo4j, graphiti):
 *   See https://github.com/getzep/zep/tree/main/legacy for docker-compose.ce.yaml
 *
 * Note: Zep CE is deprecated as of April 2025.
 */
import type { BenchmarkAdapter } from "./types.js";

const ZEP_BASE = "http://localhost:8000";

export class ZepAdapter implements BenchmarkAdapter {
	readonly name = "zep";
	readonly description =
		"Zep CE — session-based chat memory with vector + graph search";

	private sessionId = "";
	private userId = "";

	async init(): Promise<void> {
		// Check Zep is running
		const health = await this.fetchJson("GET", "/healthz");
		if (!health) throw new Error(`Zep not running at ${ZEP_BASE}`);

		// Create user and session
		this.userId = `bench-user-${Date.now()}`;
		this.sessionId = `bench-session-${Date.now()}`;

		await this.fetchJson("POST", "/api/v1/user", {
			user_id: this.userId,
			metadata: {},
		});

		await this.fetchJson("POST", "/api/v1/sessions", {
			session_id: this.sessionId,
			user_id: this.userId,
			metadata: {},
		});
	}

	async addFact(content: string): Promise<boolean> {
		if (!this.sessionId) throw new Error("Not initialized");
		const result = await this.fetchJson(
			"POST",
			`/api/v1/sessions/${this.sessionId}/memory`,
			{
				messages: [
					{ role: "user", content, metadata: {} },
					{ role: "assistant", content: "I'll remember that.", metadata: {} },
				],
			},
		);
		return !!result;
	}

	async search(query: string, topK: number): Promise<string[]> {
		if (!this.sessionId) throw new Error("Not initialized");
		const result = await this.fetchJson(
			"POST",
			`/api/v1/sessions/${this.sessionId}/search`,
			{
				text: query,
				search_type: "similarity",
				search_scope: "messages",
				limit: topK,
			},
		);
		const results = Array.isArray(result) ? result : (result?.results ?? []);
		return results
			.filter((r: any) => (r.message?.role ?? r.role) !== "assistant")
			.map((r: any) => r.message?.content ?? r.content ?? r.text ?? "")
			.filter((s: string) => s.length > 0);
	}

	async cleanup(): Promise<void> {
		// Zep CE doesn't have delete endpoints for cleanup
	}

	private async fetchJson(
		method: string,
		path: string,
		body?: any,
	): Promise<any> {
		try {
			const opts: RequestInit = {
				method,
				headers: { "Content-Type": "application/json" },
			};
			if (body) opts.body = JSON.stringify(body);
			const res = await fetch(`${ZEP_BASE}${path}`, opts);
			if (!res.ok) {
				const text = await res.text();
				console.error(
					`  Zep ${method} ${path}: ${res.status} ${text.slice(0, 200)}`,
				);
				return null;
			}
			return res.json();
		} catch (err: any) {
			console.error(`  Zep ${method} ${path}: ${err.message}`);
			return null;
		}
	}
}
