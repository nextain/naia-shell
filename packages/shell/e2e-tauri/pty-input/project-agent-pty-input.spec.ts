import { expect } from "@wdio/globals";

const PROJECT_A = "pty-input-756-a";
const PROJECT_B = "pty-input-756-b";

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
			document.querySelectorAll<HTMLElement>(
				".projects-app__project-button",
			),
		).find((candidate) => candidate.textContent?.includes(id));
		if (!button) return false;
		button.click();
		return true;
	}, projectId);
	expect(clicked).toBe(true);
	await browser.waitUntil(
		async () =>
			(await browser.execute((expectedId: string) =>
				document.querySelector(".projects-app__project-header h1")
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
	try {
		await browser.waitUntil(
			async () =>
				(await browser.execute((expected: string) => {
					const rows = document.querySelector(
						'[data-project-terminal="true"] .xterm-rows',
					);
					return rows?.textContent?.includes(`ECHO:${expected}`) ?? false;
				}, line)) === true,
			{
				timeout: 15_000,
				timeoutMsg: `terminal did not display ECHO:${line}`,
			},
		);
	} catch (error) {
		const snapshot = await browser.execute(() => ({
			terminalText:
				document.querySelector('[data-project-terminal="true"] .xterm-rows')
					?.textContent?.slice(-1_200) ?? null,
				activeElementClass: (document.activeElement as HTMLElement | null)
					?.className ?? null,
		}));
		console.error(`[pty-input-e2e] terminal snapshot ${JSON.stringify(snapshot)}`);
		throw error;
	}
}

describe("Project coding-agent PTY input — #756 stage 3", () => {
	it("round-trips WebDriver keys before and after switching projects", async () => {
		await browser.waitUntil(
			async () =>
				(await browser.execute(() =>
					document.querySelector('[data-app-id="projects"]') !== null,
				)) === true,
			{ timeout: 60_000, timeoutMsg: "Projects app tab did not appear" },
		);
		await clickInWebView('button[data-app-id="projects"]');
		try {
			await browser.waitUntil(
				async () =>
					(await browser.execute(() =>
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
					document.querySelector('[data-app-id="projects"]')?.outerHTML.slice(0, 500) ??
					null,
				projectPanelHtml:
					document.querySelector(".projects-app")?.outerHTML.slice(0, 1_200) ??
					null,
			}));
			console.error(`[pty-input-e2e] project catalog snapshot ${JSON.stringify(snapshot)}`);
			throw error;
		}

		await openProject(PROJECT_A);
		await clickInWebView(
			'input[name="project-coding-agent"][value="claude"]',
		);
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
				(await browser.execute(() =>
					document.querySelector(".projects-app__agent-running") !== null,
				)) === true,
			{ timeout: 20_000, timeoutMsg: "PTY session did not start" },
		);
		await browser.waitUntil(
			async () =>
				(await browser.execute(() =>
					document
						.querySelector('[data-project-terminal="true"] .xterm-rows')
						?.textContent?.includes("PTY_INPUT_READY") ?? false,
				)) === true,
			{
				timeout: 15_000,
				timeoutMsg: "fake Claude readiness output was not displayed",
			},
		);

		await sendWebDriverLine("pty-input-roundtrip-a");

		await clickInWebView(".projects-app__project-header button");
		await browser.waitUntil(
			async () =>
				(await browser.execute(() =>
					document.querySelector(".projects-app__project-button") !== null,
				)) === true,
			{ timeout: 20_000, timeoutMsg: "project catalog did not reopen" },
		);
		await openProject(PROJECT_B);
		await clickInWebView(".projects-app__project-header button");
		await browser.waitUntil(
			async () =>
				(await browser.execute(() =>
					document.querySelector(".projects-app__project-button") !== null,
				)) === true,
			{ timeout: 20_000, timeoutMsg: "project catalog did not reopen" },
		);
		await openProject(PROJECT_A);
		await browser.waitUntil(
			async () =>
				(await browser.execute(() =>
					document.querySelector(".projects-app__agent-running") !== null,
				)) === true,
			{ timeout: 20_000, timeoutMsg: "PTY session did not reattach" },
		);

		await sendWebDriverLine("pty-input-roundtrip-after-attach");
	});
});
