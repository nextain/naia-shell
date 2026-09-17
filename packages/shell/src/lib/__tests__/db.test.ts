import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock Tauri invoke
const mockInvoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));

describe("db (agent memory)", () => {
	beforeEach(() => {
		mockInvoke.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
	});

	it("getAllAgentFacts calls Tauri backend", async () => {
		const facts = [
			{
				id: "f1",
				content: "User prefers TypeScript",
				entities: ["TypeScript"],
				topics: ["preference"],
				createdAt: 1000,
				updatedAt: 1000,
				importance: 0.8,
				recallCount: 2,
				lastAccessed: 2000,
				strength: 0.7,
				sourceEpisodes: ["ep1"],
			},
		];
		mockInvoke.mockResolvedValueOnce(facts);

		const { getAllAgentFacts } = await import("../db");
		const result = await getAllAgentFacts();

		expect(mockInvoke).toHaveBeenCalledWith("memory_get_all_facts");
		expect(result).toEqual(facts);
	});

	it("deleteAgentFact calls Tauri with correct args", async () => {
		mockInvoke.mockResolvedValueOnce(true);

		const { deleteAgentFact } = await import("../db");
		const result = await deleteAgentFact("f1");

		expect(mockInvoke).toHaveBeenCalledWith("memory_delete_fact", {
			factId: "f1",
		});
		expect(result).toBe(true);
	});
});
