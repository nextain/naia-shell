import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { E2E_WORKSPACE } from "../codex-e2e-environment.js";
import {
	countCompletedAssistantMessages,
	getNewAssistantMessages,
	sendMessage,
} from "../helpers/chat.js";

const COURSE_ROOT = resolve(E2E_WORKSPACE, "projects", "codex-chat-delegation");
const COURSE_RELATIVE_ROOT = "projects/codex-chat-delegation";
const RESPONSE_MARKER = "NAIA_CODEX_DELEGATION_OK_20260726";
const CODEX_MODEL = process.env.NAIA_E2E_MAIN_MODEL ?? "gpt-5.6-sol";
let logPath = "";
let logStart = 0;

function git(args: string[]): string {
	return execFileSync("git", args, { cwd: COURSE_ROOT, encoding: "utf8" });
}

function createCleanCourseRepository(): void {
	mkdirSync(COURSE_ROOT, { recursive: true });
	git(["init", "--initial-branch=main"]);
	git(["config", "user.name", "Naia E2E"]);
	git(["config", "user.email", "naia-e2e@example.invalid"]);
	git([
		"commit",
		"--allow-empty",
		"-m",
		"chore: initial chat delegation fixture",
	]);
}

function changedFiles(): string[] {
	return git(["status", "--porcelain", "--untracked-files=all"])
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => line.slice(3))
		.sort();
}

async function tauriInvoke<T>(command: string): Promise<T> {
	return (await browser.execute(async (cmd: string) => {
		const w = window as unknown as {
			__TAURI_INTERNALS__?: { invoke: (name: string) => Promise<unknown> };
			__TAURI__?: { core?: { invoke: (name: string) => Promise<unknown> } };
		};
		const invoke = w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.core?.invoke;
		if (!invoke) throw new Error("Tauri invoke unavailable");
		return invoke(cmd);
	}, command)) as T;
}

function readCurrentRunLog(): string {
	try {
		return readFileSync(logPath).subarray(logStart).toString("utf8");
	} catch {
		return "";
	}
}

async function waitForRunLog(fragment: string): Promise<void> {
	await browser.waitUntil(() => readCurrentRunLog().includes(fragment), {
		timeout: 30_000,
		timeoutMsg: `Naia runtime log did not contain: ${fragment}`,
	});
}

describe("Codex chat delegates one workspace-bound coding session", () => {
	before(async () => {
		createCleanCourseRepository();
		const seeded = JSON.parse(
			readFileSync(resolve(E2E_WORKSPACE, "naia-settings/config.json"), "utf8"),
		) as Record<string, unknown>;
		expect(seeded.provider).toBe("codex");
		expect(seeded.model).toBe(CODEX_MODEL);
		expect(seeded).not.toHaveProperty("NAIA_MAIN_PROVIDER");
		expect(seeded).not.toHaveProperty("llmRoles");
		logPath = await tauriInvoke<string>("get_gateway_log_path");
		try {
			logStart = statSync(logPath).size;
		} catch {
			logStart = 0;
		}
	});

	it("runs delegate_agent and shows its terminal result without committing student files", async () => {
		const before = await countCompletedAssistantMessages();
		logStart = statSync(logPath).size;
		await sendMessage(
			`Use the delegate_agent tool exactly once with agent=main. The host has already selected the workspace; do not provide a workdir override. Give the child this task: in ${COURSE_RELATIVE_ROOT}, create exactly index.html and hero.svg. index.html must contain the heading Jeonju Codex Workshop and reference ./hero.svg. hero.svg must be valid SVG and contain #2563EB. Do not commit, push, install, or deploy. After the tool succeeds, answer with ${RESPONSE_MARKER} and a short result summary.`,
		);
		await waitForRunLog("[E2E-DEBUG] chat_request requestId=");
		const requestMatch = readCurrentRunLog().match(
			/\[E2E-DEBUG\] chat_request requestId=([^ ]+) provider=codex\b/,
		);
		expect(requestMatch).not.toBeNull();
		const requestId = requestMatch?.[1] ?? "";

		await browser.waitUntil(
			async () => {
				const state = await browser.execute(() => {
					const activities = Array.from(
						document.querySelectorAll<HTMLElement>(
							'.tool-activity[data-tool-name="delegate_agent"]',
						),
					);
					const latest = activities.at(-1);
					return {
						count: activities.length,
						running: latest?.classList.contains("tool-running") ?? false,
						success: latest?.classList.contains("tool-success") ?? false,
						error: latest?.classList.contains("tool-error") ?? false,
					};
				});
				if (state.error)
					throw new Error("delegate_agent rendered a failed terminal state");
				if (state.count > 1)
					throw new Error("delegate_agent was called more than once");
				return state.count === 1 && state.success;
			},
			{
				timeout: 300_000,
				timeoutMsg: "delegate_agent did not reach a successful terminal state",
			},
		);

		// A fast tool result can be batched into the terminal render before WDIO
		// samples the transient running class. The unique success activity is the
		// stable UI contract; request-scoped usage/finish prove terminal delivery.
		await waitForRunLog(`requestId=${requestId} type=usage`);
		await waitForRunLog(`requestId=${requestId} type=finish`);
		const response = (await getNewAssistantMessages(before)).at(-1) ?? "";
		expect(response).toContain(RESPONSE_MARKER);
		expect(changedFiles()).toEqual(["hero.svg", "index.html"]);
		expect(git(["rev-list", "--count", "HEAD"]).trim()).toBe("1");
		expect(readFileSync(resolve(COURSE_ROOT, "index.html"), "utf8")).toContain(
			"./hero.svg",
		);
		expect(readFileSync(resolve(COURSE_ROOT, "hero.svg"), "utf8")).toContain(
			"#2563EB",
		);
	});
});
