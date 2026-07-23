import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { E2E_WORKSPACE } from "../codex-e2e-environment.js";

// Model the product topology: E2E_WORKSPACE is the Naia ADK control root.
// The proposal worker reads the independently versioned course project; Naia
// applies and verifies the accepted two-file proposal.
const COURSE_ROOT = resolve(E2E_WORKSPACE, "projects", "jeonju-course-fixture");

function git(args: string[]): string {
	return execFileSync("git", args, { cwd: COURSE_ROOT, encoding: "utf8" });
}

function createCleanCourseRepository(): void {
	mkdirSync(COURSE_ROOT, { recursive: true });
	git(["init", "--initial-branch=main"]);
	git(["config", "user.name", "Naia E2E"]);
	git(["config", "user.email", "naia-e2e@example.invalid"]);
	git(["commit", "--allow-empty", "-m", "chore: initial course fixture"]);
	git([
		"remote",
		"add",
		"origin",
		"https://example.invalid/jeonju-course-fixture.git",
	]);
}

function changedFiles(): string[] {
	return git(["status", "--porcelain", "--untracked-files=all"])
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => line.slice(3));
}

async function waitForCourseTerminal(cardIndex: number) {
	// The panel polls gRPC and React replaces the card on each snapshot. Do not
	// retain a WebDriver element from the initial `running` render: doing so can
	// make a completed Agent job look permanently running to this native test.
	await browser.waitUntil(async () => {
		const card = (await $$(".coding-workers__list article"))[cardIndex];
		if (!card) return false;
		const state = await card.$("[data-testid^='coding-worker-state-']");
		try {
			return ["completed", "failed", "cancelled"].includes(await state.getAttribute("data-worker-state") ?? "");
		} catch {
			return false;
		}
	}, {
		timeout: 300_000,
		timeoutMsg: `course worker ${cardIndex} did not reach a terminal state`,
	});
	const card = (await $$(".coding-workers__list article"))[cardIndex];
	if (!card) throw new Error(`course worker card ${cardIndex} was not rendered`);
	const state = await card.$("[data-testid^='coding-worker-state-']");
	expect(await state.getAttribute("data-worker-state")).toBe("completed");
	return card;
}

describe("Jeonju course worker through the isolated real Tauri Shell", () => {
	before(() => createCleanCourseRepository());

	it("completes the initial build and a revision in one student Git root without escaping the two-file boundary", async () => {
		const workspacePanel = await $("button[data-panel-id='workspace']");
		await workspacePanel.waitForClickable({ timeout: 45_000 });
		await workspacePanel.click();
		const workersToggle = await $("[data-testid='coding-workers-toggle']");
		await workersToggle.waitForClickable({ timeout: 45_000 });
		await workersToggle.click();

		await (await $("[data-testid='coding-worker-worktree']")).setValue(
			COURSE_ROOT,
		);
		await (await $("[data-testid='coding-worker-task']")).setValue(
			"Create a simple Korean course introduction page. Create exactly index.html and hero.svg. index.html must reference ./hero.svg, include the heading '나의 첫 AI 웹페이지', a short introduction, a same-page contact 안내 link, and mobile-friendly CSS. hero.svg must be a blue #2563EB illustration. Do not run any git, package, or deployment command.",
		);
		await (
			await $("[data-testid='coding-worker-jeonju-course-preset']")
		).click();
		// Persist the same constrained target that a Discord /course request will
		// load when the Agent next starts. This exercises the native Rust bridge
		// (clean Git root + origin + control-root containment), rather than merely
		// relying on the direct coding-worker form state below.
		await (await $("[data-testid='coding-worker-save-course-target']")).click();
		const savedCourseTarget = await $(
			"[data-testid='coding-worker-course-target-saved']",
		);
		await savedCourseTarget.waitForDisplayed({ timeout: 30_000 });
		expect(await savedCourseTarget.getText()).toBe(COURSE_ROOT);
		expect(
			await $("[data-testid='coding-worker-course-target-status']").getText(),
		).toContain("index.html, hero.svg");
		await (await $("[data-testid='coding-worker-start']")).click();

		await browser.waitUntil(
			async () => (await $$(".coding-workers__list article")).length === 1,
			{
				timeout: 60_000,
				timeoutMsg: "initial course worker card did not render",
			},
		);
		const card = await waitForCourseTerminal(0);
		expect(
			await card.$("[data-testid^='coding-worker-course-boundary-']").getText(),
		).toContain("index.html, hero.svg");
		expect(
			await card.$("[data-testid^='coding-worker-verification-']").getText(),
		).toContain("only index.html and hero.svg changed");

		expect(changedFiles().sort()).toEqual(["hero.svg", "index.html"]);
		expect(git(["rev-list", "--count", "HEAD"]).trim()).toBe("1");
		expect(readFileSync(resolve(COURSE_ROOT, "index.html"), "utf8")).toContain(
			"./hero.svg",
		);
		expect(readFileSync(resolve(COURSE_ROOT, "hero.svg"), "utf8")).toContain(
			"#2563EB",
		);
		// The student owns Git.  Commit the initial reviewable result before a
		// follow-up request, matching the course's minimum-Git lesson rather than
		// asking the coding worker to commit on their behalf.
		git(["add", "index.html", "hero.svg"]);
		git(["commit", "-m", "student: initial course page"]);
		expect(changedFiles()).toEqual([]);
		expect(git(["rev-list", "--count", "HEAD"]).trim()).toBe("2");

		await (await $("[data-testid='coding-worker-worktree']")).setValue(
			COURSE_ROOT,
		);
		await (await $("[data-testid='coding-worker-task']")).setValue(
			"Revise only hero.svg in the existing course repository. Change its primary blue color from #2563EB to #7C3AED while preserving a valid SVG illustration. Do not modify index.html. Do not create, delete, rename, commit, push, install, or deploy anything.",
		);
		// The selected course boundary persists across requests. Do not toggle it
		// here: doing so would turn this revision into an ordinary isolated-worktree
		// job and would no longer verify the saved student Git root.
		await (await $("[data-testid='coding-worker-start']")).click();
		await browser.waitUntil(
			async () => (await $$(".coding-workers__list article")).length === 2,
			{
				timeout: 60_000,
				timeoutMsg: "revision course worker card did not render",
			},
		);
		await waitForCourseTerminal(1);

		expect(changedFiles()).toEqual(["hero.svg"]);
		expect(git(["rev-list", "--count", "HEAD"]).trim()).toBe("2");
		const revisedIndex = readFileSync(
			resolve(COURSE_ROOT, "index.html"),
			"utf8",
		);
		expect(revisedIndex).toContain("./hero.svg");
		expect(readFileSync(resolve(COURSE_ROOT, "hero.svg"), "utf8")).toContain(
			"#7C3AED",
		);
	});
});
