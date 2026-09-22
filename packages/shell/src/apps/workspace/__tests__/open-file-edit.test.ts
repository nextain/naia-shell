import { describe, expect, it } from "vitest";
import {
	applyOpenFileEdit,
	diffLines,
	editResult,
} from "../open-file-edit";

describe("applyOpenFileEdit", () => {
	const base = "line 1\nline 2\nline 3\nline 2\n";

	it("replaces entire file in content mode", () => {
		const res = applyOpenFileEdit(base, {
			path: "/test/file.ts",
			content: "new content",
		});
		expect(res).toEqual({ ok: true, next: "new content" });
	});

	it("replaces uniquely matched oldText", () => {
		const res = applyOpenFileEdit("alpha\nbeta\ngamma\n", {
			path: "/test/file.ts",
			oldText: "beta",
			newText: "BETA",
		});
		expect(res).toEqual({ ok: true, next: "alpha\nBETA\ngamma\n" });
	});

	it("inserts replacement strings containing $&, $1, and $$ literally", () => {
		const res = applyOpenFileEdit("price: old_value;\n", {
			path: "/test/file.ts",
			oldText: "old_value",
			newText: "cost: $& and $1 and $$",
		});
		expect(res).toEqual({
			ok: true,
			next: "price: cost: $& and $1 and $$;\n",
		});
	});

	it("fails when oldText is not found", () => {
		const res = applyOpenFileEdit(base, {
			path: "/test/file.ts",
			oldText: "nonexistent",
			newText: "foo",
		});
		expect(res).toEqual({
			ok: false,
			error: "invalid: oldText not found in the open file",
		});
	});

	it("fails when oldText matches multiple times and reports count", () => {
		const res = applyOpenFileEdit(base, {
			path: "/test/file.ts",
			oldText: "line 2",
			newText: "line two",
		});
		expect(res).toEqual({
			ok: false,
			error: "invalid: oldText matches 2 places; include more surrounding text",
		});
	});

	it("fails when both content and oldText/newText are provided", () => {
		const res = applyOpenFileEdit(base, {
			path: "/test/file.ts",
			content: "all new",
			oldText: "line 1",
			newText: "line one",
		});
		expect(res).toEqual({
			ok: false,
			error: "invalid: pass either content, or oldText and newText",
		});
	});

	it("fails when neither content nor oldText/newText is provided", () => {
		const res = applyOpenFileEdit(base, {
			path: "/test/file.ts",
		});
		expect(res).toEqual({
			ok: false,
			error: "invalid: pass either content, or oldText and newText",
		});
	});

	it("fails when only oldText without newText is provided", () => {
		const res = applyOpenFileEdit(base, {
			path: "/test/file.ts",
			oldText: "line 1",
		});
		expect(res).toEqual({
			ok: false,
			error: "invalid: pass either content, or oldText and newText",
		});
	});

	it("fails on no-op edits", () => {
		const resContent = applyOpenFileEdit(base, {
			path: "/test/file.ts",
			content: base,
		});
		expect(resContent).toEqual({
			ok: false,
			error: "invalid: the edit does not change the file",
		});

		const resOldNew = applyOpenFileEdit("alpha\nbeta\ngamma", {
			path: "/test/file.ts",
			oldText: "beta",
			newText: "beta",
		});
		expect(resOldNew).toEqual({
			ok: false,
			error: "invalid: the edit does not change the file",
		});
	});
});

describe("diffLines", () => {
	it("handles pure additions", () => {
		const diff = diffLines("", "line 1\nline 2");
		expect(diff.added).toBe(2);
		expect(diff.removed).toBe(0);
		expect(diff.lines.every((l) => l.kind === "add")).toBe(true);
		expect(diff.truncated).toBe(false);
	});

	it("handles pure deletions", () => {
		const diff = diffLines("line 1\nline 2", "");
		expect(diff.added).toBe(0);
		expect(diff.removed).toBe(2);
		expect(diff.lines.every((l) => l.kind === "del")).toBe(true);
		expect(diff.truncated).toBe(false);
	});

	it("change in the middle keeps <=3 context lines and separator", () => {
		const before = [
			"c1",
			"c2",
			"c3",
			"c4",
			"c5",
			"c6",
			"c7",
			"target",
			"c8",
			"c9",
			"c10",
			"c11",
			"c12",
			"c13",
		].join("\n");
		const after = [
			"c1",
			"c2",
			"c3",
			"c4",
			"c5",
			"c6",
			"c7",
			"REPLACED",
			"c8",
			"c9",
			"c10",
			"c11",
			"c12",
			"c13",
		].join("\n");

		const diff = diffLines(before, after);
		expect(diff.added).toBe(1);
		expect(diff.removed).toBe(1);
		expect(diff.truncated).toBe(false);

		// Must have separator "…"
		const hasSeparator = diff.lines.some((l) => l.text === "…");
		expect(hasSeparator).toBe(true);

		// Must not contain far context lines
		expect(diff.lines.some((l) => l.text === "c1")).toBe(false);
		expect(diff.lines.some((l) => l.text === "c13")).toBe(false);

		// Must contain close context lines (within 3 lines)
		expect(diff.lines.some((l) => l.text === "c5")).toBe(true);
		expect(diff.lines.some((l) => l.text === "c6")).toBe(true);
		expect(diff.lines.some((l) => l.text === "c7")).toBe(true);
		expect(diff.lines.some((l) => l.text === "c8")).toBe(true);
		expect(diff.lines.some((l) => l.text === "c9")).toBe(true);
		expect(diff.lines.some((l) => l.text === "c10")).toBe(true);
	});

	it("identical text produces no add/del and empty lines", () => {
		const diff = diffLines("same\ncontent\n", "same\ncontent\n");
		expect(diff.added).toBe(0);
		expect(diff.removed).toBe(0);
		expect(diff.lines).toEqual([]);
		expect(diff.truncated).toBe(false);
	});

	it("sets truncation flag when lines exceed maxLines", () => {
		const before = "a\nb\nc\nd\ne\nf\ng\nh";
		const after = "A\nB\nC\nD\nE\nF\nG\nH";
		const diff = diffLines(before, after, 4);
		expect(diff.truncated).toBe(true);
		expect(diff.lines.length).toBe(4);
	});
});

describe("editResult", () => {
	it("formats status and details as JSON", () => {
		const str = editResult("applied", { path: "/a/b.ts", sha256: "abc", added: 2, removed: 1 });
		const parsed = JSON.parse(str);
		expect(parsed).toEqual({
			status: "applied",
			path: "/a/b.ts",
			sha256: "abc",
			added: 2,
			removed: 1,
		});
	});

	it("formats error statuses", () => {
		const str = editResult("denied", { reason: "path is sensitive" });
		expect(JSON.parse(str)).toEqual({
			status: "denied",
			reason: "path is sensitive",
		});
	});
});
