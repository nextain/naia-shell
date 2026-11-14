import { describe, expect, it } from "vitest";

// `@naia-agent/*` resolves only in web mode (NAIA_WEB_AGENT_DIR, see vite.config.ts),
// so the default desktop `vitest run` skips this suite. Run it with:
//   NAIA_WEB_AGENT_DIR=<naia-agent worktree> npx vitest run --mode web web-worker/__tests__/web-app-tools.test.ts
const mod = await import("../web-app-tools").catch(() => null);
const WEB_APP_TOOL_NAMES = mod?.WEB_APP_TOOL_NAMES ?? [];
const WEB_MEMO_FILE = mod?.WEB_MEMO_FILE ?? "";
const WEB_PC_ONLY_NOTICE = mod?.WEB_PC_ONLY_NOTICE ?? "";
const withWebAppTools = mod?.withWebAppTools as NonNullable<
	typeof mod
>["withWebAppTools"];
type ToolExecutorPort = ReturnType<typeof withWebAppTools>;

function fakeRoot(initial?: string) {
	const files = new Map<string, string>();
	if (initial !== undefined) files.set(WEB_MEMO_FILE, initial);
	const root = {
		files,
		async getFileHandle(name: string, opts?: { create?: boolean }) {
			if (!files.has(name) && !opts?.create) {
				throw new DOMException("nf", "NotFoundError");
			}
			return {
				async getFile() {
					const text = files.get(name) ?? "";
					return { size: text.length, text: async () => text };
				},
				async createWritable() {
					return {
						async write(d: string) {
							files.set(name, d);
						},
						async close() {},
					};
				},
			};
		},
	};
	return root;
}

const base: ToolExecutorPort = {
	specs: () => [{ name: "read_file", description: "r", parameters: {} }],
	execute: async () => ({ output: "base" }),
};

const call = (name: string, args: Record<string, unknown> = {}) => ({
	id: "c1",
	name,
	args,
});

function make(root = fakeRoot()) {
	const ex = withWebAppTools(base, {
		getRoot: async () => root as never,
		clock: () => new Date("2026-11-14T04:00:00Z"),
	});
	return { ex, root };
}

describe.skipIf(!mod)("web app tools", () => {
	it("lists the app names only (no get_weather, base kept)", () => {
		const names = make()
			.ex.specs()
			.map((s) => s.name);
		for (const n of WEB_APP_TOOL_NAMES) expect(names).toContain(n);
		expect(names).toContain("read_file");
		expect(names).not.toContain("get_weather");
	});

	it("get_time answers with the clock", async () => {
		const r = await make().ex.execute(call("get_time"), {});
		expect(r.output).toBe("2026-11-14T04:00:00.000Z");
	});

	it("memo_save requires approval tier like the app", () => {
		const s = make()
			.ex.specs()
			.find((x) => x.name === "memo_save");
		expect(s?.tier).toBe("ask");
	});

	it("memo_save / memo_list / memo_get round-trip and persist to OPFS", async () => {
		const { ex, root } = make();
		const saved = await ex.execute(
			call("memo_save", { title: "t", content: "hello" }),
			{},
		);
		expect(saved.output).toContain("t");
		expect((await ex.execute(call("memo_list"), {})).output).toBe("t");
		expect(
			(await ex.execute(call("memo_get", { title: "t" }), {})).output,
		).toBe("hello");
		await new Promise((r) => setTimeout(r, 0));
		expect(JSON.parse(root.files.get(WEB_MEMO_FILE) ?? "{}")).toEqual({
			t: "hello",
		});
	});

	it("memo_list/get see memos stored before the worker started", async () => {
		const { ex } = make(fakeRoot(JSON.stringify({ old: "v" })));
		expect(
			(await ex.execute(call("memo_get", { title: "old" }), {})).output,
		).toBe("v");
	});

	it("PC-only / not-yet tools answer with the single notice", async () => {
		const { ex } = make();
		for (const n of ["skill_workspace_terminal_exec", "skill_memory_recall"]) {
			const r = await ex.execute(call(n), {});
			expect(r.output).toBe(WEB_PC_ONLY_NOTICE);
			expect(r.isError).toBeUndefined();
		}
	});

	it("other tools still reach the base executor", async () => {
		expect((await make().ex.execute(call("read_file"), {})).output).toBe(
			"base",
		);
	});
});
