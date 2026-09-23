import { describe, expect, it } from "vitest";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeNoFollow } from "../../e2e-tauri/safe-remove.mjs";

describe("removeTreeNoFollow", () => {
	it("removes a tree with nested files", () => {
		const tempBase = mkdtempSync(join(tmpdir(), "naia-safe-remove-"));
		const root = join(tempBase, "tree-to-remove");
		const nestedDir = join(root, "a", "b");
		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(join(nestedDir, "test.txt"), "hello");
		writeFileSync(join(root, "root.txt"), "root file");

		expect(existsSync(join(nestedDir, "test.txt"))).toBe(true);

		removeTreeNoFollow(root);

		expect(existsSync(root)).toBe(false);

		removeTreeNoFollow(tempBase);
	});

	it("removes a directory symlink/junction inside the tree pointing to an OUTSIDE directory while outside directory and file survive", () => {
		const tempBase = mkdtempSync(join(tmpdir(), "naia-safe-remove-"));
		const outsideDir = join(tempBase, "outside-dir");
		const treeToRemove = join(tempBase, "tree-to-remove");

		mkdirSync(outsideDir, { recursive: true });
		const outsideFile = join(outsideDir, "survivor.txt");
		writeFileSync(outsideFile, "survivor content");

		mkdirSync(treeToRemove, { recursive: true });
		const linkPath = join(treeToRemove, "link-to-outside");

		symlinkSync(
			outsideDir,
			linkPath,
			process.platform === "win32" ? "junction" : "dir",
		);

		expect(existsSync(linkPath)).toBe(true);
		expect(existsSync(outsideFile)).toBe(true);

		removeTreeNoFollow(treeToRemove);

		expect(existsSync(treeToRemove)).toBe(false);
		expect(existsSync(linkPath)).toBe(false);
		expect(existsSync(outsideDir)).toBe(true);
		expect(existsSync(outsideFile)).toBe(true);
		expect(readFileSync(outsideFile, "utf8")).toBe("survivor content");

		removeTreeNoFollow(tempBase);
	});

	it("is a no-op when root is missing", () => {
		const tempBase = mkdtempSync(join(tmpdir(), "naia-safe-remove-"));
		const missingPath = join(tempBase, "does-not-exist");

		expect(() => removeTreeNoFollow(missingPath)).not.toThrow();
		expect(existsSync(missingPath)).toBe(false);

		removeTreeNoFollow(tempBase);
	});
});
