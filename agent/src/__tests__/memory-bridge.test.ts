import { describe, expect, it, vi } from "vitest";
import type { MemorySystem } from "@nextain/naia-memory";
import { createNaiaMemoryProvider } from "../memory-bridge.js";

/**
 * Day 4.5.1 — memory-bridge tests.
 * Verify shape conversion + capability detection. Mock MemorySystem (not testing
 * naia-memory itself).
 */

function mockMemorySystem(overrides: Partial<MemorySystem> = {}): MemorySystem {
	return {
		encode: vi.fn().mockResolvedValue(undefined),
		recall: vi.fn().mockResolvedValue({ episodes: [], facts: [], reflections: [] }),
		sessionRecall: vi.fn().mockResolvedValue(""),
		consolidateNow: vi.fn().mockResolvedValue({ factsCreated: 0 }),
		compact: vi.fn().mockResolvedValue({ summary: { role: "assistant", content: "" }, droppedCount: 0 }),
		close: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as unknown as MemorySystem;
}

describe("memory-bridge — MemoryProvider shape", () => {
	it("returns object with all required MemoryProvider methods", () => {
		const ms = mockMemorySystem();
		const provider = createNaiaMemoryProvider(ms);
		expect(typeof provider.encode).toBe("function");
		expect(typeof provider.recall).toBe("function");
		expect(typeof provider.consolidate).toBe("function");
		expect(typeof provider.close).toBe("function");
		expect(typeof provider.sessionRecall).toBe("function");
		expect(typeof provider.compact).toBe("function");
	});

	it("encode injects defaultProject context", async () => {
		const ms = mockMemorySystem();
		const provider = createNaiaMemoryProvider(ms, { defaultProject: "test-proj" });
		await provider.encode({ content: "hi", role: "user" });
		expect(ms.encode).toHaveBeenCalledWith(
			expect.objectContaining({ content: "hi", role: "user" }),
			expect.objectContaining({ project: "test-proj" }),
		);
	});

	it("encode preserves user-supplied project context override", async () => {
		const ms = mockMemorySystem();
		const provider = createNaiaMemoryProvider(ms, { defaultProject: "default" });
		await provider.encode({
			content: "hi",
			role: "user",
			context: { project: "override" },
		});
		expect(ms.encode).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ project: "override" }),
		);
	});

	it("recall converts facts to MemoryHit array", async () => {
		const ms = mockMemorySystem({
			recall: vi.fn().mockResolvedValue({
				episodes: [],
				facts: [
					{ id: "f1", content: "fact A", importance: 0.8, createdAt: 1000, status: "active" },
				],
				reflections: [],
			}),
		} as Partial<MemorySystem>);
		const provider = createNaiaMemoryProvider(ms);
		const hits = await provider.recall("query");
		expect(hits.length).toBe(1);
		expect(hits[0]?.id).toBe("f1");
		expect(hits[0]?.content).toBe("fact A");
		expect(hits[0]?.score).toBeCloseTo(0.8);
		expect(hits[0]?.metadata).toEqual(
			expect.objectContaining({ source: "fact", status: "active" }),
		);
	});

	it("recall converts episodes to MemoryHit array (with summary)", async () => {
		const ms = mockMemorySystem({
			recall: vi.fn().mockResolvedValue({
				episodes: [
					{
						id: "e1", content: "long event content", summary: "short",
						strength: 0.5, timestamp: 2000, role: "user",
					},
				],
				facts: [],
				reflections: [],
			}),
		} as Partial<MemorySystem>);
		const provider = createNaiaMemoryProvider(ms);
		const hits = await provider.recall("query");
		expect(hits.length).toBe(1);
		expect(hits[0]?.summary).toBe("short");
		expect(hits[0]?.metadata?.["source"]).toBe("episode");
		expect(hits[0]?.metadata?.["role"]).toBe("user");
	});

	it("recall sorts by score descending and respects topK", async () => {
		const ms = mockMemorySystem({
			recall: vi.fn().mockResolvedValue({
				episodes: [],
				facts: [
					{ id: "low", content: "L", importance: 0.2, createdAt: 1, status: "active" },
					{ id: "high", content: "H", importance: 0.9, createdAt: 2, status: "active" },
					{ id: "mid", content: "M", importance: 0.5, createdAt: 3, status: "active" },
				],
				reflections: [],
			}),
		} as Partial<MemorySystem>);
		const provider = createNaiaMemoryProvider(ms);
		const hits = await provider.recall("query", { topK: 2 });
		expect(hits.length).toBe(2);
		expect(hits[0]?.id).toBe("high");
		expect(hits[1]?.id).toBe("mid");
	});

	it("recall applies minStrength filter", async () => {
		const ms = mockMemorySystem({
			recall: vi.fn().mockResolvedValue({
				episodes: [],
				facts: [
					{ id: "low", content: "L", importance: 0.2, createdAt: 1, status: "active" },
					{ id: "high", content: "H", importance: 0.9, createdAt: 2, status: "active" },
				],
				reflections: [],
			}),
		} as Partial<MemorySystem>);
		const provider = createNaiaMemoryProvider(ms);
		const hits = await provider.recall("query", { minStrength: 0.5 });
		expect(hits.length).toBe(1);
		expect(hits[0]?.id).toBe("high");
	});

	it("consolidate maps consolidateNow → ConsolidationSummary", async () => {
		const ms = mockMemorySystem({
			consolidateNow: vi.fn().mockResolvedValue({ factsCreated: 7 }),
		} as Partial<MemorySystem>);
		const provider = createNaiaMemoryProvider(ms);
		const result = await provider.consolidate();
		expect(result.factsCreated).toBe(7);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("close delegates to MemorySystem.close", async () => {
		const ms = mockMemorySystem();
		const provider = createNaiaMemoryProvider(ms);
		await provider.close();
		expect(ms.close).toHaveBeenCalled();
	});

	it("sessionRecall returns null on empty string", async () => {
		const ms = mockMemorySystem({
			sessionRecall: vi.fn().mockResolvedValue(""),
		} as Partial<MemorySystem>);
		const provider = createNaiaMemoryProvider(ms);
		const result = await provider.sessionRecall("hello");
		expect(result).toBeNull();
	});

	it("sessionRecall returns string on non-empty content", async () => {
		const ms = mockMemorySystem({
			sessionRecall: vi.fn().mockResolvedValue("recalled context"),
		} as Partial<MemorySystem>);
		const provider = createNaiaMemoryProvider(ms);
		const result = await provider.sessionRecall("hello");
		expect(result).toBe("recalled context");
	});

	it("compact maps to MemorySystem.compact", async () => {
		const ms = mockMemorySystem({
			compact: vi.fn().mockResolvedValue({
				summary: { role: "assistant", content: "summary text" },
				droppedCount: 5,
				realtime: true,
			}),
		} as Partial<MemorySystem>);
		const provider = createNaiaMemoryProvider(ms);
		const result = await provider.compact({
			messages: [{ role: "user", content: "msg1" }],
			keepTail: 10,
			targetTokens: 500,
		});
		expect(result.summary.content).toBe("summary text");
		expect(result.droppedCount).toBe(5);
		expect(result.realtime).toBe(true);
	});
});
