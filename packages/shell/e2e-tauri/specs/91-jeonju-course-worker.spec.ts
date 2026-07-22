import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { E2E_WORKSPACE } from "../codex-e2e-environment.js";

const COURSE_ROOT = resolve(E2E_WORKSPACE, "jeonju-course-fixture");
// A Codex-hosted development session imposes a read-only sandbox on every
// child `codex exec`, independently of the child's own CLI environment. This
// test is an acceptance test for a signed-in standalone Shell, so fail closed
// here instead of treating that host-policy rejection as product evidence.
const courseAcceptance = process.env.CODEX_THREAD_ID ? it.skip : it;

function git(args: string[]): string {
	return execFileSync("git", args, { cwd: COURSE_ROOT, encoding: "utf8" });
}

function createCleanCourseRepository(): void {
	mkdirSync(COURSE_ROOT, { recursive: true });
	git(["init", "--initial-branch=main"]);
	git(["config", "user.name", "Naia E2E"]);
	git(["config", "user.email", "naia-e2e@example.invalid"]);
	git(["commit", "--allow-empty", "-m", "chore: initial course fixture"]);
	git(["remote", "add", "origin", "https://example.invalid/jeonju-course-fixture.git"]);
}

function changedFiles(): string[] {
	return git(["status", "--porcelain", "--untracked-files=all"])
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => line.slice(3));
}

async function waitForCourseTerminal(cardIndex: number) {
	const cards = await $$(".coding-workers__list article");
	const card = cards[cardIndex];
	if (!card) throw new Error(`course worker card ${cardIndex} was not rendered`);
	const state = await card.$("[data-testid^='coding-worker-state-']");
	await browser.waitUntil(async () => ["completed", "failed", "cancelled"].includes(await state.getText()), {
		timeout: 300_000,
		timeoutMsg: `course worker ${cardIndex} did not reach a terminal state`,
	});
	expect(await state.getText()).toBe("completed");
	return card;
}

describe("Jeonju course worker through the isolated real Tauri Shell", () => {
	before(() => createCleanCourseRepository());

	courseAcceptance("completes the initial build and a revision in one student Git root without escaping the two-file boundary", async () => {
		const workspacePanel = await $("button[data-panel-id='workspace']");
		await workspacePanel.waitForClickable({ timeout: 45_000 });
		await workspacePanel.click();
		const workersToggle = await $("[data-testid='coding-workers-toggle']");
		await workersToggle.waitForClickable({ timeout: 45_000 });
		await workersToggle.click();

		await (await $("[data-testid='coding-worker-worktree']")).setValue(COURSE_ROOT);
		await (await $("[data-testid='coding-worker-task']")).setValue(
			"Create a simple Korean course introduction page. Create exactly index.html and hero.svg. index.html must reference ./hero.svg, include the heading '나의 첫 AI 웹페이지', a short introduction, a same-page contact 안내 link, and mobile-friendly CSS. hero.svg must be a blue #2563EB illustration. Do not run any git, package, or deployment command.",
		);
		await (await $("[data-testid='coding-worker-jeonju-course-preset']")).click();
		await (await $("[data-testid='coding-worker-start']")).click();

		await browser.waitUntil(
			async () => (await $$(".coding-workers__list article")).length === 1,
			{ timeout: 60_000, timeoutMsg: "initial course worker card did not render" },
		);
		const card = await waitForCourseTerminal(0);
		await expect(card.$("[data-testid^='coding-worker-course-boundary-']")).toHaveText(
			"Course mode: index.html, hero.svg",
		);
		expect(
			await card.$("[data-testid^='coding-worker-verification-']").getText(),
		).toContain("only index.html and hero.svg changed");

		expect(changedFiles().sort()).toEqual(["hero.svg", "index.html"]);
		expect(git(["rev-list", "--count", "HEAD"]).trim()).toBe("1");
		expect(readFileSync(resolve(COURSE_ROOT, "index.html"), "utf8")).toContain("./hero.svg");
		expect(readFileSync(resolve(COURSE_ROOT, "hero.svg"), "utf8")).toContain("#2563EB");

		await (await $("[data-testid='coding-worker-task']")).setValue(
			"Revise only index.html in the existing course repository. Preserve its hero.svg reference and existing content, then add a visible section headed 'Updated lesson plan' with a short mobile-friendly revision note. Do not create, delete, rename, commit, push, install, or deploy anything.",
		);
		// The form deliberately resets after each submission; reselect the fixed
		// course boundary so this is a revision in the same student Git root,
		// not an ordinary isolated-worktree job.
		await (await $("[data-testid='coding-worker-jeonju-course-preset']")).click();
		await (await $("[data-testid='coding-worker-start']")).click();
		await browser.waitUntil(
			async () => (await $$(".coding-workers__list article")).length === 2,
			{ timeout: 60_000, timeoutMsg: "revision course worker card did not render" },
		);
		await waitForCourseTerminal(1);

		expect(changedFiles().sort()).toEqual(["hero.svg", "index.html"]);
		expect(git(["rev-list", "--count", "HEAD"]).trim()).toBe("1");
		const revisedIndex = readFileSync(resolve(COURSE_ROOT, "index.html"), "utf8");
		expect(revisedIndex).toContain("./hero.svg");
		expect(revisedIndex).toContain("Updated lesson plan");
	});
});
