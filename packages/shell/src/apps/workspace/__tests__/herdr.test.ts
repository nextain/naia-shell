import { describe, expect, it } from "vitest";
import { parseFileLocation, shouldOpenTerminalFileLink } from "../Terminal";
import {
	type HerdrSnapshot,
	activeHerdrRoot,
	assertHerdrSnapshot,
	focusedHerdrAgent,
	herdrProtocolSupported,
	waitForHerdrReady,
} from "../herdr";

const snapshot: HerdrSnapshot = {
	protocol: 19,
	version: "0.8.0",
	focused_workspace_id: "w1",
	focused_pane_id: "w1:p2",
	workspaces: [
		{
			workspace_id: "w1",
			label: "Naia",
			focused: true,
			pane_count: 2,
			tab_count: 1,
			worktree: { checkout_path: "/work/naia" },
		},
	],
	agents: [
		{
			workspace_id: "w1",
			tab_id: "w1:t1",
			pane_id: "w1:p2",
			agent: "codex",
			agent_status: "working",
			cwd: "/work/naia",
			focused: true,
		},
	],
};

describe("Herdr workspace boundary", () => {
	it("waits through the startup race until the shared server is ready", async () => {
		let attempts = 0;
		const ready = await waitForHerdrReady(
			async () => {
				attempts += 1;
				if (attempts < 3) throw new Error("socket not ready");
				return snapshot;
			},
			{ timeoutMs: 1_000, retryMs: 0 },
		);

		expect(ready).toBe(snapshot);
		expect(attempts).toBe(3);
	});

	it("validates protocol and derives the focused root and agent", () => {
		expect(assertHerdrSnapshot(snapshot)).toBe(snapshot);
		expect(activeHerdrRoot(snapshot)).toBe("/work/naia");
		expect(focusedHerdrAgent(snapshot)?.pane_id).toBe("w1:p2");
		expect(() => assertHerdrSnapshot({ ...snapshot, protocol: 18 })).toThrow(
			"Unsupported Herdr snapshot protocol",
		);
		expect(assertHerdrSnapshot({ ...snapshot, protocol: 22 }).protocol).toBe(
			22,
		);
		expect(() => assertHerdrSnapshot({ ...snapshot, protocol: 23 })).toThrow(
			"Unsupported Herdr snapshot protocol",
		);
	});

	it("accepts Herdr snapshot protocol 19 through 22 (#645)", () => {
		expect(herdrProtocolSupported(19)).toBe(true);
		expect(herdrProtocolSupported(22)).toBe(true);
		expect(herdrProtocolSupported(18)).toBe(false);
		expect(herdrProtocolSupported(23)).toBe(false);
		expect(herdrProtocolSupported("22")).toBe(false);
	});

	it("rejects malformed workspace and agent entries", () => {
		expect(() =>
			assertHerdrSnapshot({
				protocol: 19,
				version: "0.8.0",
				workspaces: [{ workspace_id: "w1" }],
				agents: [],
			}),
		).toThrow("Malformed Herdr snapshot entries");
		expect(() => assertHerdrSnapshot({ ...snapshot, version: 8 })).toThrow(
			"Unsupported Herdr snapshot protocol",
		);
		expect(() =>
			assertHerdrSnapshot({ ...snapshot, focused_pane_id: 7 }),
		).toThrow("Unsupported Herdr snapshot protocol");
		for (const field of [
			"agent",
			"label",
			"terminal_title_stripped",
		] as const) {
			expect(() =>
				assertHerdrSnapshot({
					...snapshot,
					agents: [{ ...snapshot.agents[0], [field]: { invalid: true } }],
				}),
			).toThrow("Malformed Herdr snapshot entries");
		}
	});

	it("keeps a non-worktree space rooted at its stable agent cwd", () => {
		const noWorktree = {
			...snapshot,
			workspaces: [{ ...snapshot.workspaces[0], worktree: undefined }],
			agents: [
				{
					...snapshot.agents[0],
					cwd: "/work/naia",
					foreground_cwd: "/work/naia/packages/shell",
				},
			],
		};
		expect(activeHerdrRoot(noWorktree)).toBe("/work/naia");
	});

	it("parses terminal file locations without expanding trust-boundary paths", () => {
		expect(parseFileLocation("src/App.tsx:42:7", "/work/naia")).toEqual({
			path: "src/App.tsx",
			line: 42,
			column: 7,
		});
		expect(parseFileLocation("main.rs:9", "/work/naia")).toEqual({
			path: "/work/naia/main.rs",
			line: 9,
			column: undefined,
		});
		expect(parseFileLocation("~/notes.md:3", "/work/naia")?.path).toBe(
			"~/notes.md",
		);
		expect(parseFileLocation("../../secrets.pem:2", "/work/naia")).toBeNull();
	});

	it("requires the platform primary modifier to activate terminal file links", () => {
		expect(
			shouldOpenTerminalFileLink({ ctrlKey: true, metaKey: false }, "other"),
		).toBe(true);
		expect(
			shouldOpenTerminalFileLink({ ctrlKey: false, metaKey: true }, "macos"),
		).toBe(true);
		expect(
			shouldOpenTerminalFileLink({ ctrlKey: false, metaKey: false }, "other"),
		).toBe(false);
		expect(
			shouldOpenTerminalFileLink({ ctrlKey: true, metaKey: false }, "macos"),
		).toBe(false);
	});
});
