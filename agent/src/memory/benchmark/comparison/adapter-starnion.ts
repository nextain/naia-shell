/**
 * Starnion benchmark adapter u2014 Go Gateway + PostgreSQL + pgvector.
 *
 * Starnion (by jikime) is an AI agent with hybrid vector+FTS memory.
 * https://github.com/jikime/starnion
 *
 * Requires a running Starnion stack:
 *   starnion setup && starnion start
 *   (Web: :3893, Gateway: :8080, Agent gRPC: :50051)
 *
 * Set env vars:
 *   STARNION_URL=http://localhost:8080   (default)
 *   STARNION_EMAIL=bench@example.com
 *   STARNION_PASSWORD=Benchmark1234!
 */
import type { BenchmarkAdapter } from "./types.js";

const BASE_URL = process.env.STARNION_URL ?? "http://localhost:8080";
const EMAIL = process.env.STARNION_EMAIL ?? "bench@example.com";
const PASSWORD = process.env.STARNION_PASSWORD ?? "Benchmark1234!";
const THROTTLE_MS = 500;

export class StarnionAdapter implements BenchmarkAdapter {
	readonly name = "starnion";
	readonly description =
		"Starnion u2014 Go Gateway + PostgreSQL + pgvector hybrid (FTS + vector) search";

	private token = "";
	private sessionId = "";

	async init(): Promise<void> {
		// Authenticate
		const loginRes = await this.fetchJson("POST", "/auth/login", {
			email: EMAIL,
			password: PASSWORD,
		});
		if (!loginRes?.token) throw new Error(`Starnion login failed at ${BASE_URL}`);
		this.token = loginRes.token;

		// Create a dedicated benchmark session
		const session = await this.fetchJson("POST", "/api/v1/sessions", {
			title: `alpha-memory-bench-${Date.now()}`,
		});
		if (!session?.id) throw new Error("Starnion session creation failed");
		this.sessionId = session.id;
	}

	async addFact(content: string): Promise<boolean> {
		if (!this.sessionId) throw new Error("Not initialized");
		await new Promise((r) => setTimeout(r, THROTTLE_MS));
		// Send fact as a chat message so Starnion stores it in its memory
		const res = await this.fetchJson(
			"POST",
			`/api/v1/sessions/${this.sessionId}/chat`,
			{ message: content },
		);
		return !!res;
	}

	async search(query: string, topK: number): Promise<string[]> {
		if (!this.token) throw new Error("Not initialized");
		await new Promise((r) => setTimeout(r, THROTTLE_MS));
		const res = await this.fetchJson(
			"GET",
			`/api/v1/search/hybrid?q=${encodeURIComponent(query)}&limit=${topK}`,
		);
		const results = res?.results ?? [];
		return results
			.map((r: any) => r.text ?? r.title ?? "")
			.filter((s: string) => s.length > 0);
	}

	async cleanup(): Promise<void> {
		if (this.sessionId && this.token) {
			try {
				await this.fetchJson(
					"DELETE",
					`/api/v1/sessions/${this.sessionId}`,
				);
			} catch {}
		}
	}

	private async fetchJson(
		method: string,
		path: string,
		body?: any,
	): Promise<any> {
		try {
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
			};
			if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
			const opts: RequestInit = { method, headers };
			if (body && method !== "GET") opts.body = JSON.stringify(body);
			const res = await fetch(`${BASE_URL}${path}`, opts);
			if (!res.ok) {
				const text = await res.text();
				console.error(
					`  starnion ${method} ${path}: ${res.status} ${text.slice(0, 200)}`,
				);
				return null;
			}
			if (res.status === 204) return {};
			return res.json();
		} catch (err: any) {
			console.error(`  starnion ${method} ${path}: ${err.message}`);
			return null;
		}
	}
}
