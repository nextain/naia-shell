import { describe, expect, it, vi } from "vitest";
import { makeModelToolBoundary } from "../model-facing-tools";

describe("makeModelToolBoundary", () => {
	it("turn 1 and turn 2 return the same disabledSkills for the same agent list", async () => {
		const agentTools = [
			{ name: "get_time" },
			{ name: "skill_memory_recall" },
			{ name: "skill_knowledge_ask" },
			{ name: "shell_exec" },
		];
		const fetchTools = vi.fn().mockResolvedValue(agentTools);
		const boundary = makeModelToolBoundary({ fetchTools });

		const turn1 = await boundary.resolve();
		const turn2 = await boundary.resolve();

		expect(turn1.toolsAllowed).toBe(true);
		expect(turn1.disabledSkills).toEqual(["shell_exec"]);
		expect(turn2.toolsAllowed).toBe(true);
		expect(turn2.disabledSkills).toEqual(["shell_exec"]);
		expect(turn1.disabledSkills).toEqual(turn2.disabledSkills);
	});

	it("knowledge + memory tools never in disabledSkills, shell_exec/write_file/skill_example_from_adk always in", async () => {
		const agentTools = [
			{ name: "skill_knowledge_ask" },
			{ name: "skill_knowledge_search" },
			{ name: "skill_knowledge_graph" },
			{ name: "skill_knowledge_scope" },
			{ name: "skill_memory_recall" },
			{ name: "shell_exec" },
			{ name: "write_file" },
			{ name: "skill_example_from_adk" },
		];
		const boundary = makeModelToolBoundary({
			fetchTools: async () => agentTools,
		});

		const res = await boundary.resolve();

		expect(res.toolsAllowed).toBe(true);
		expect(res.disabledSkills).toContain("shell_exec");
		expect(res.disabledSkills).toContain("write_file");
		expect(res.disabledSkills).toContain("skill_example_from_adk");
		expect(res.disabledSkills).not.toContain("skill_knowledge_ask");
		expect(res.disabledSkills).not.toContain("skill_knowledge_search");
		expect(res.disabledSkills).not.toContain("skill_knowledge_graph");
		expect(res.disabledSkills).not.toContain("skill_knowledge_scope");
		expect(res.disabledSkills).not.toContain("skill_memory_recall");
	});

	it("fetch rejects on the very first call → toolsAllowed:false, disabledSkills: [] and warn called", async () => {
		const warn = vi.fn();
		const boundary = makeModelToolBoundary({
			fetchTools: async () => {
				throw new Error("Agent connection failed");
			},
			warn,
		});

		const res = await boundary.resolve();

		expect(res).toEqual({ disabledSkills: [], toolsAllowed: false });
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("success then failure → closed (toolsAllowed false)", async () => {
		let shouldFail = false;
		const warn = vi.fn();
		const boundary = makeModelToolBoundary({
			fetchTools: async () => {
				if (shouldFail) {
					throw new Error("Network transient error");
				}
				return [
					{ name: "get_time" },
					{ name: "shell_exec" },
					{ name: "skill_knowledge_ask" },
				];
			},
			warn,
		});

		const res1 = await boundary.resolve();
		expect(res1).toEqual({
			disabledSkills: ["shell_exec"],
			toolsAllowed: true,
		});
		expect(warn).not.toHaveBeenCalled();

		shouldFail = true;
		const res2 = await boundary.resolve();
		expect(res2).toEqual({
			disabledSkills: [],
			toolsAllowed: false,
		});
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("a tool registered after the first fetch is disabled on the next turn", async () => {
		let registeredTools = [
			{ name: "get_time" },
			{ name: "shell_exec" },
			{ name: "skill_knowledge_ask" },
		];
		const boundary = makeModelToolBoundary({
			fetchTools: async () => registeredTools,
		});

		const turn1 = await boundary.resolve();
		expect(turn1.toolsAllowed).toBe(true);
		expect(turn1.disabledSkills).toEqual(["shell_exec"]);

		registeredTools = [
			{ name: "get_time" },
			{ name: "shell_exec" },
			{ name: "skill_knowledge_ask" },
			{ name: "skill_example_from_adk" },
		];

		const turn2 = await boundary.resolve();
		expect(turn2.toolsAllowed).toBe(true);
		expect(turn2.disabledSkills).toContain("shell_exec");
		expect(turn2.disabledSkills).toContain("skill_example_from_adk");
	});

	it("timeout (fetch never resolves, timeoutMs 20) with no history → closed", async () => {
		const warn = vi.fn();
		const boundary = makeModelToolBoundary({
			fetchTools: () => new Promise<readonly { name: string }[]>(() => {}),
			timeoutMs: 20,
			warn,
		});

		const res = await boundary.resolve();

		expect(res).toEqual({ disabledSkills: [], toolsAllowed: false });
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("concurrent resolve() calls share one fetch", async () => {
		let callCount = 0;
		let finishFetch!: (tools: readonly { name: string }[]) => void;
		const fetchTools = vi.fn(() => {
			callCount++;
			return new Promise<readonly { name: string }[]>((resolve) => {
				finishFetch = resolve;
			});
		});

		const boundary = makeModelToolBoundary({ fetchTools });

		const p1 = boundary.resolve();
		const p2 = boundary.resolve();

		expect(callCount).toBe(1);

		finishFetch([{ name: "shell_exec" }, { name: "get_time" }]);

		const [r1, r2] = await Promise.all([p1, p2]);
		expect(r1).toEqual({ disabledSkills: ["shell_exec"], toolsAllowed: true });
		expect(r2).toEqual({ disabledSkills: ["shell_exec"], toolsAllowed: true });
		expect(callCount).toBe(1);
	});

	it("malformed result (not an array, entries without names) handled", async () => {
		const warn = vi.fn();
		// Not an array
		const boundaryNotArray = makeModelToolBoundary({
			fetchTools: async () => "invalid" as unknown as readonly { name: string }[],
			warn,
		});
		const resNotArray = await boundaryNotArray.resolve();
		expect(resNotArray).toEqual({ disabledSkills: [], toolsAllowed: false });
		expect(warn).toHaveBeenCalledTimes(1);

		// Entries without names or empty strings
		const boundaryBadEntries = makeModelToolBoundary({
			fetchTools: async () =>
				[
					null,
					undefined,
					{},
					{ name: "" },
					{ name: 42 },
					{ name: "shell_exec" },
					{ name: "skill_knowledge_search" },
				] as unknown as readonly { name: string }[],
		});
		const resBadEntries = await boundaryBadEntries.resolve();
		expect(resBadEntries).toEqual({
			disabledSkills: ["shell_exec"],
			toolsAllowed: true,
		});
	});

	it("prefetch calls resolve and does not throw", async () => {
		const fetchTools = vi.fn().mockResolvedValue([{ name: "shell_exec" }]);
		const boundary = makeModelToolBoundary({ fetchTools });

		boundary.prefetch();
		expect(fetchTools).toHaveBeenCalledTimes(1);

		const res = await boundary.resolve();
		expect(res.toolsAllowed).toBe(true);
	});

	it("a fetch that throws synchronously fails closed", async () => {
		const warn = vi.fn();
		const boundary = makeModelToolBoundary({
			fetchTools: () => {
				throw new Error("boom");
			},
			warn,
		});

		const res = await boundary.resolve();

		expect(res).toEqual({ toolsAllowed: false, disabledSkills: [] });
		expect(warn).toHaveBeenCalledTimes(1);
	});
});
