import { describe, expect, it } from "vitest";
import { parseIssueIdFromBranch } from "../issue-branch";

describe("parseIssueIdFromBranch", () => {
	// ── Positive cases ──────────────────────────────────────────────────────

	it("parses issue-NNN", () => {
		expect(parseIssueIdFromBranch("issue-278")).toBe(278);
	});

	it("parses issue/NNN", () => {
		expect(parseIssueIdFromBranch("issue/278")).toBe(278);
	});

	it("parses issues-NNN (plural)", () => {
		expect(parseIssueIdFromBranch("issues-278")).toBe(278);
	});

	it("parses feat/issue-NNN", () => {
		expect(parseIssueIdFromBranch("feat/issue-278")).toBe(278);
	});

	it("parses fix/issue-NNN", () => {
		expect(parseIssueIdFromBranch("fix/issue-278")).toBe(278);
	});

	it("parses fix-issue-NNN (dash prefix)", () => {
		expect(parseIssueIdFromBranch("fix-issue-278")).toBe(278);
	});

	it("parses chore/issue-NNN", () => {
		expect(parseIssueIdFromBranch("chore/issue-99")).toBe(99);
	});

	it("parses issue-NNN with trailing description", () => {
		expect(parseIssueIdFromBranch("issue-278-workspace-redesign")).toBe(278);
	});

	it("parses ISSUE-NNN (uppercase)", () => {
		expect(parseIssueIdFromBranch("ISSUE-278")).toBe(278);
	});

	it("parses #NNN anywhere in branch", () => {
		expect(parseIssueIdFromBranch("fix-#278")).toBe(278);
	});

	it("parses large issue numbers", () => {
		expect(parseIssueIdFromBranch("issue-12345")).toBe(12345);
	});

	it("parses issue number 1", () => {
		expect(parseIssueIdFromBranch("issue-1")).toBe(1);
	});

	// ── Negative cases ──────────────────────────────────────────────────────

	it("returns undefined for main", () => {
		expect(parseIssueIdFromBranch("main")).toBeUndefined();
	});

	it("returns undefined for master", () => {
		expect(parseIssueIdFromBranch("master")).toBeUndefined();
	});

	it("returns undefined for HEAD", () => {
		expect(parseIssueIdFromBranch("HEAD")).toBeUndefined();
	});

	it("returns undefined for empty string", () => {
		expect(parseIssueIdFromBranch("")).toBeUndefined();
	});

	it("returns undefined for feature branch without issue number", () => {
		expect(parseIssueIdFromBranch("feat/add-dark-mode")).toBeUndefined();
	});

	it("returns undefined for generic branch with number (ambiguous)", () => {
		// e.g. "v2.0" or "release-2024" — not an issue number
		expect(parseIssueIdFromBranch("release-2024")).toBeUndefined();
		expect(parseIssueIdFromBranch("v2.0")).toBeUndefined();
	});

	it("returns undefined for issue-0 (invalid issue number)", () => {
		expect(parseIssueIdFromBranch("issue-0")).toBeUndefined();
	});

	it("returns undefined for detached HEAD hash", () => {
		expect(parseIssueIdFromBranch("(HEAD abc123)")).toBeUndefined();
	});

	it("returns undefined for worktree-style without issue keyword", () => {
		expect(parseIssueIdFromBranch("worktree-278")).toBeUndefined();
	});
});
