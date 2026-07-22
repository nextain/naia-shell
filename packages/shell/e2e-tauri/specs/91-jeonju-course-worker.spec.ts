import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { E2E_WORKSPACE } from "../codex-e2e-environment.js";

const COURSE_ROOT = resolve(E2E_WORKSPACE, "jeonju-course-fixture");
// A Codex-hosted development session injects its own read-only tool sandbox
// into every child `codex exec`. That is not a standalone Shell acceptance
// environment: fail closed rather than treating its forced worker failure as
// product evidence. A signed-in standalone CLI has no CODEX_THREAD_ID.
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

describe("Jeonju course worker through the isolated real Tauri Shell", () => {
	before(() => createCleanCourseRepository());

	courseAcceptance("starts one real Codex course job, shows its verified completion, and preserves the two-file Git boundary", async () => {
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

		const card = await $(".coding-workers__list article");
		await card.waitForExist({ timeout: 60_000 });
		const state = await card.$("[data-testid^='coding-worker-state-']");
		await browser.waitUntil(async () => ["completed", "failed", "cancelled"].includes(await state.getText()), {
			timeout: 300_000,
			timeoutMsg: "course worker did not reach a terminal state",
		});
		expect(await state.getText()).toBe("completed");
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
	});
});
