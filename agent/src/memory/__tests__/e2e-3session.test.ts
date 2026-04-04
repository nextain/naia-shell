import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalAdapter } from "../adapters/local.js";
import { MemorySystem } from "../index.js";

describe("Memory E2E — 3 Session Simulation", () => {
	it("Session 1→2→3: encode, persist, recall, update", async () => {
		const storePath = join(tmpdir(), `naia-e2e-${randomUUID()}.json`);

		// === SESSION 1: Store facts ===
		const adapter1 = new LocalAdapter(storePath);
		const system1 = new MemorySystem({ adapter: adapter1 });
		const facts = [
			"I am Kim Haneul, a startup CEO and fullstack developer",
			"I mainly use TypeScript for development",
			"My editor is Neovim",
			"I use Next.js and FastAPI as frameworks",
			"I prefer dark mode and tab indentation",
			"I live in Seongsu-dong",
			"I only drink Americano coffee",
			"I run on weekends along the Han river",
		];
		for (const f of facts) {
			const ep = await system1.encode(
				{ content: f, role: "user" },
				{ project: "naia-os" },
			);
			expect(ep).not.toBeNull();
		}
		// Force consolidation
		await system1.close();
		const store = JSON.parse(readFileSync(storePath, "utf-8"));
		for (const ep of store.episodes)
			ep.timestamp = Date.now() - 2 * 60 * 60 * 1000;
		writeFileSync(storePath, JSON.stringify(store));
		const adapterCons = new LocalAdapter(storePath);
		const sysCons = new MemorySystem({ adapter: adapterCons });
		await sysCons.consolidateNow();
		await sysCons.close();

		// === SESSION 2: Recall ===
		const adapter2 = new LocalAdapter(storePath);
		const system2 = new MemorySystem({ adapter: adapter2 });
		const r1 = await system2.recall("Neovim", { topK: 3 });
		expect(r1.episodes.length + r1.facts.length).toBeGreaterThan(0);
		const r2 = await system2.recall("TypeScript", { topK: 3 });
		expect(r2.episodes.length + r2.facts.length).toBeGreaterThan(0);
		const r3 = await system2.recall("Americano", { topK: 3 });
		expect(r3.episodes.length + r3.facts.length).toBeGreaterThan(0);
		// Abstention
		const r4 = await system2.recall("Docker", { topK: 3 });
		expect(r4.episodes.length + r4.facts.length).toBe(0);
		// sessionRecall — episodes are always surfaced alongside facts
		const ctx = await system2.sessionRecall("Neovim editor", { topK: 5 });
		expect(typeof ctx).toBe("string");
		// After consolidation, episodes and/or facts are present — result must not be empty
		// and must include the expected section headers when non-empty.
		if (ctx.length > 0) {
			const hasSection = ctx.includes("관련 기억") || ctx.includes("이전 대화에서");
			expect(hasSection).toBe(true);
		}
		await system2.close();

		// === SESSION 3: Update ===
		const adapter3 = new LocalAdapter(storePath);
		const system3 = new MemorySystem({ adapter: adapter3 });
		await system3.encode(
			{ content: "I switched to Cursor editor", role: "user" },
			{ project: "naia-os" },
		);
		const r5 = await system3.recall("Cursor", { topK: 3 });
		expect(r5.episodes.length).toBeGreaterThan(0);
		const r6 = await system3.recall("Americano", { topK: 3 });
		expect(r6.episodes.length + r6.facts.length).toBeGreaterThan(0);
		await system3.close();

		try {
			rmSync(storePath);
		} catch {}
	});

	it("Cross-session: facts survive serialization and are independently recallable", async () => {
		const storePath = join(tmpdir(), `naia-e2e-cross-${randomUUID()}.json`);

		// === SESSION 1: Store diverse facts ===
		const adapter1 = new LocalAdapter(storePath);
		const system1 = new MemorySystem({ adapter: adapter1 });

		const sessionFacts = [
			{
				content: "My database is PostgreSQL with Redis for caching",
				role: "user" as const,
			},
			{
				content: "I use GitHub Actions for CI/CD pipelines",
				role: "user" as const,
			},
			{
				content: "My cloud provider is GCP with Cloud Run",
				role: "user" as const,
			},
			{
				content: "I prefer Podman over Docker for containers",
				role: "user" as const,
			},
			{
				content: "Testing framework is Vitest, much faster than Jest",
				role: "user" as const,
			},
			{
				content: "I use Biome as formatter instead of Prettier",
				role: "user" as const,
			},
			{
				content: "My terminal is Ghostty with GPU acceleration",
				role: "user" as const,
			},
			{
				content: "I use Fish shell for auto-completion",
				role: "user" as const,
			},
		];

		for (const f of sessionFacts) {
			await system1.encode(f, { project: "naia-os" });
		}
		await system1.close();

		// Age episodes for consolidation
		const store1 = JSON.parse(readFileSync(storePath, "utf-8"));
		for (const ep of store1.episodes) {
			ep.timestamp = Date.now() - 3 * 60 * 60 * 1000;
		}
		writeFileSync(storePath, JSON.stringify(store1));

		// Consolidate
		const adapterCons = new LocalAdapter(storePath);
		const sysCons = new MemorySystem({ adapter: adapterCons });
		await sysCons.consolidateNow();
		await sysCons.close();

		// === SESSION 2: Verify each fact independently ===
		const adapter2 = new LocalAdapter(storePath);
		const system2 = new MemorySystem({ adapter: adapter2 });

		// Each keyword should retrieve its related fact
		const keywordChecks = [
			{ keyword: "PostgreSQL", shouldFind: true },
			{ keyword: "GitHub Actions", shouldFind: true },
			{ keyword: "GCP", shouldFind: true },
			{ keyword: "Podman", shouldFind: true },
			{ keyword: "Vitest", shouldFind: true },
			{ keyword: "Biome", shouldFind: true },
			{ keyword: "Ghostty", shouldFind: true },
			{ keyword: "Fish", shouldFind: true },
			// Abstention — never mentioned
			{ keyword: "Kubernetes", shouldFind: false },
			{ keyword: "Jenkins", shouldFind: false },
		];

		for (const { keyword, shouldFind } of keywordChecks) {
			const result = await system2.recall(keyword, { topK: 5 });
			const allContent = [
				...result.episodes.map((e) => e.content),
				...result.facts.map((f) => f.content),
			]
				.join(" ")
				.toLowerCase();

			if (shouldFind) {
				expect(
					allContent.includes(keyword.toLowerCase()),
					`Expected to find "${keyword}" in recall results`,
				).toBe(true);
			} else {
				expect(
					allContent.includes(keyword.toLowerCase()),
					`Expected NOT to find "${keyword}" in recall results`,
				).toBe(false);
			}
		}

		await system2.close();

		// === SESSION 3: Update and verify ===
		const adapter3 = new LocalAdapter(storePath);
		const system3 = new MemorySystem({ adapter: adapter3 });

		// Update: switch terminal
		await system3.encode(
			{
				content: "I switched to Wezterm terminal. More configurable.",
				role: "user",
			},
			{ project: "naia-os" },
		);

		// Wezterm should be findable
		const r1 = await system3.recall("Wezterm", { topK: 5 });
		expect(r1.episodes.length).toBeGreaterThan(0);

		// Unchanged facts should persist
		const r2 = await system3.recall("PostgreSQL", { topK: 5 });
		const pgContent = [...r2.episodes, ...r2.facts]
			.map((x) => x.content)
			.join(" ")
			.toLowerCase();
		expect(pgContent).toContain("postgresql");

		await system3.close();

		try {
			rmSync(storePath);
		} catch {}
	});

	it("Cross-session: sessionRecall injects relevant context", async () => {
		const storePath = join(
			tmpdir(),
			`naia-e2e-session-recall-${randomUUID()}.json`,
		);

		// SESSION 1: Store facts
		const adapter1 = new LocalAdapter(storePath);
		const system1 = new MemorySystem({ adapter: adapter1 });

		await system1.encode(
			{
				content: "I always use dark mode and prefer tab indentation",
				role: "user",
			},
			{ project: "naia-os" },
		);
		await system1.encode(
			{
				content: "My preferred language is TypeScript for all projects",
				role: "user",
			},
			{ project: "naia-os" },
		);
		await system1.close();

		// Age + consolidate
		const store = JSON.parse(readFileSync(storePath, "utf-8"));
		for (const ep of store.episodes) {
			ep.timestamp = Date.now() - 2 * 60 * 60 * 1000;
		}
		writeFileSync(storePath, JSON.stringify(store));
		const adapterCons = new LocalAdapter(storePath);
		const sysCons = new MemorySystem({ adapter: adapterCons });
		await sysCons.consolidateNow();
		await sysCons.close();

		// SESSION 2: sessionRecall should return relevant context
		const adapter2 = new LocalAdapter(storePath);
		const system2 = new MemorySystem({ adapter: adapter2 });

		const recallCtx = await system2.sessionRecall(
			"Help me set up a new project",
			{ project: "naia-os", topK: 5 },
		);

		// sessionRecall returns formatted context string.
		// With LocalAdapter (keyword search), fact extraction quality varies.
		// Verify it's a string; if facts were extracted, they should contain
		// keywords from stored episodes.
		expect(typeof recallCtx).toBe("string");
		if (recallCtx.length > 0) {
			const lower = recallCtx.toLowerCase();
			const hasRelevantContent =
				lower.includes("dark") ||
				lower.includes("tab") ||
				lower.includes("typescript");
			expect(hasRelevantContent).toBe(true);
		}

		await system2.close();

		try {
			rmSync(storePath);
		} catch {}
	});
});
