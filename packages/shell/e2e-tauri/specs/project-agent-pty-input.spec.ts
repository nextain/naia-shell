// platforms: linux
// Uses an isolated fake CLI and local PTY; it needs no credentials or devices.
// The fake child records complete input lines so the test checks PTY delivery directly.

import { readFileSync } from "node:fs";
import { expect } from "@wdio/globals";

const PROJECT_A = "pty-input-756-a";
const PROJECT_B = "pty-input-756-b";
const PTY_INPUT_TRACE = process.env.NAIA_E2E_PTY_TRACE;

async function clickInWebView(selector: string): Promise<void> {
	const clicked = await browser.execute((query: string) => {
		const element = document.querySelector(query) as HTMLElement | null;
		if (!element) return false;
		element.click();
		return true;
	}, selector);
	expect(clicked).toBe(true);
}

async function openProject(projectId: string): Promise<void> {
	const clicked = await browser.execute((id: string) => {
		const button = Array.from(
			document.querySelectorAll<HTMLElement>(".projects-app__project-button"),
		).find((candidate) => candidate.textContent?.includes(id));
		if (!button) return false;
		button.click();
		return true;
	}, projectId);
	expect(clicked).toBe(true);
	await browser.waitUntil(
		async () =>
			(await browser.execute(
				(expectedId: string) =>
					document
						.querySelector(".projects-app__project-header h1")
						?.textContent?.includes(expectedId) ?? false,
				projectId,
			)) === true,
		{
			timeout: 20_000,
			timeoutMsg: `project ${projectId} did not open`,
		},
	);
}

async function sendWebDriverLine(line: string): Promise<void> {
	if (!PTY_INPUT_TRACE)
		throw new Error("missing isolated PTY input trace path");
	const focused = await browser.execute(() => {
		const textarea = document.querySelector(
			'[data-project-terminal="true"] .xterm-helper-textarea',
		) as HTMLTextAreaElement | null;
		textarea?.focus({ preventScroll: true });
		return Boolean(textarea && document.activeElement === textarea);
	});
	expect(focused).toBe(true);
	const textarea = await browser.$(
		'[data-project-terminal="true"] .xterm-helper-textarea',
	);
	await textarea.setValue(line);
	await browser.keys("Enter");
	await browser.waitUntil(
		async () => {
			try {
				return readFileSync(PTY_INPUT_TRACE, "utf8")
					.split(/\r?\n/)
					.includes(line);
			} catch {
				return false;
			}
		},
		{
			timeout: 15_000,
			timeoutMsg: `fake CLI did not receive ${line}`,
		},
	);
	await browser.waitUntil(
		async () =>
			(await browser.execute((expectedLine: string) => {
				const host = document.querySelector('[data-project-terminal="true"]') as
					| (HTMLDivElement & {
							__naiaXterm?: {
								buffer: {
									active: {
										length: number;
										getLine: (
											index: number,
										) =>
											| { translateToString: (trimRight?: boolean) => string }
											| undefined;
									};
								};
							};
					  })
					| null;
				const buffer = host?.__naiaXterm?.buffer.active;
				if (!buffer) return false;
				for (let index = 0; index < buffer.length; index += 1) {
					const row = buffer.getLine(index)?.translateToString(true) ?? "";
					if (row.includes(`ECHO:${expectedLine}`)) return true;
				}
				return false;
			}, line)) === true,
		{
			timeout: 15_000,
			timeoutMsg: `project terminal did not render ECHO:${line}`,
		},
	);
}

describe("Project coding-agent PTY input — #756 stage 3", () => {
	it("round-trips WebDriver keys before and after switching projects", async () => {
		await browser.waitUntil(
			async () =>
				(await browser.execute(
					() => document.querySelector('[data-app-id="projects"]') !== null,
				)) === true,
			{ timeout: 60_000, timeoutMsg: "Projects app tab did not appear" },
		);
		await clickInWebView('button[data-app-id="projects"]');
		try {
			await browser.waitUntil(
				async () =>
					(await browser.execute(
						() =>
							document.querySelector(".projects-app__project-button") !== null,
					)) === true,
				{
					timeout: 20_000,
					timeoutMsg: "project catalog did not load",
				},
			);
		} catch (error) {
			const snapshot = await browser.execute(() => ({
				url: document.location.href,
				title: document.title,
				bodyText: document.body.innerText.slice(0, 1_200),
				projectAppHtml:
					document
						.querySelector('[data-app-id="projects"]')
						?.outerHTML.slice(0, 500) ?? null,
				projectPanelHtml:
					document.querySelector(".projects-app")?.outerHTML.slice(0, 1_200) ??
					null,
			}));
			console.error(
				`[pty-input-e2e] project catalog snapshot ${JSON.stringify(snapshot)}`,
			);
			throw error;
		}

		await openProject(PROJECT_A);
		await clickInWebView('input[name="project-coding-agent"][value="claude"]');
		await browser.waitUntil(
			async () =>
				(await browser.execute(() =>
					Array.from(
						document.querySelectorAll<HTMLButtonElement>(
							".projects-app__primary-button",
						),
					).some((button) => button.textContent?.includes("Claude")),
				)) === true,
			{ timeout: 20_000, timeoutMsg: "fake Claude was not detected" },
		);
		await clickInWebView(".projects-app__primary-button");
		await browser.waitUntil(
			async () =>
				(await browser.execute(
					() => document.querySelector(".projects-app__agent-running") !== null,
				)) === true,
			{ timeout: 20_000, timeoutMsg: "PTY session did not start" },
		);
		await browser.waitUntil(
			async () =>
				(await browser.execute(
					() =>
						document.querySelector(
							'[data-project-terminal="true"] .xterm-helper-textarea',
						) !== null,
				)) === true,
			{
				timeout: 20_000,
				timeoutMsg: "project terminal did not mount",
			},
		);

		await sendWebDriverLine("pty-input-roundtrip-a");

		await clickInWebView(".projects-app__project-header button");
		await browser.waitUntil(
			async () =>
				(await browser.execute(
					() =>
						document.querySelector(".projects-app__project-button") !== null,
				)) === true,
			{ timeout: 20_000, timeoutMsg: "project catalog did not reopen" },
		);
		await openProject(PROJECT_B);
		await clickInWebView(".projects-app__project-header button");
		await browser.waitUntil(
			async () =>
				(await browser.execute(
					() =>
						document.querySelector(".projects-app__project-button") !== null,
				)) === true,
			{ timeout: 20_000, timeoutMsg: "project catalog did not reopen" },
		);
		await openProject(PROJECT_A);
		await browser.waitUntil(
			async () =>
				(await browser.execute(
					() => document.querySelector(".projects-app__agent-running") !== null,
				)) === true,
			{ timeout: 20_000, timeoutMsg: "PTY session did not reattach" },
		);

		await sendWebDriverLine("pty-input-roundtrip-after-attach");
	});
});
