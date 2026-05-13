/**
 * Parse a GitHub issue number from a git branch name.
 *
 * Supports common conventions:
 *   issue-278        → 278
 *   issue/278        → 278
 *   issues-278       → 278
 *   feat/issue-278   → 278
 *   fix/issue-278    → 278
 *   fix-issue-278    → 278
 *   feature/278-...  → (not matched — too ambiguous)
 *   #278             → 278  (rare but valid)
 *
 * Returns undefined when no issue number is detectable.
 */
export function parseIssueIdFromBranch(branch: string): number | undefined {
	if (!branch || branch === "main" || branch === "master" || branch === "HEAD") {
		return undefined;
	}

	// Pattern 1: issue[-/]NNN  (with optional prefix like feat/ or fix-)
	// Matches: issue-278, issue/278, feat/issue-278, fix-issue-278, issues/278
	const issuePattern = /issues?[-/](\d+)/i;
	const m1 = issuePattern.exec(branch);
	if (m1) {
		const n = parseInt(m1[1], 10);
		return Number.isFinite(n) && n > 0 ? n : undefined;
	}

	// Pattern 2: #NNN anywhere in branch name
	const hashPattern = /#(\d+)/;
	const m2 = hashPattern.exec(branch);
	if (m2) {
		const n = parseInt(m2[1], 10);
		return Number.isFinite(n) && n > 0 ? n : undefined;
	}

	return undefined;
}
