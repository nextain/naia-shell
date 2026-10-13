import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "@wdio/globals";

type NativeScan = {
	readonly ok: boolean;
	readonly value?: {
		readonly projects: Array<{
			readonly directoryName: string;
			readonly projectId: string;
			readonly name: string;
			readonly repository: string | null;
			readonly issueTracker: string | null;
			readonly configErrors: Array<{
				readonly file: string;
				readonly reason: string;
			}>;
		}>;
	};
	readonly error?: string;
};

const TEMP_ROOT = tmpdir();
let checkoutRoot = "";

function writeFixture(relativePath: string, content: string): void {
	const path = join(checkoutRoot, relativePath);
	mkdirSync(resolve(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf8");
}

async function nativeScan(path: string): Promise<NativeScan> {
	try {
		return (await browser.execute(async (checkoutPath: string) => {
			const tauri = (
				window as unknown as {
					__TAURI_INTERNALS__?: {
						invoke?: (command: string, args: unknown) => Promise<unknown>;
					};
				}
			).__TAURI_INTERNALS__;
			if (!tauri?.invoke) return { ok: false, error: "TAURI_INVOKE_MISSING" };
			try {
				return {
					ok: true,
					value: await tauri.invoke("projects_scan_checkout", { checkoutPath }),
				};
			} catch (error) {
				return { ok: false, error: String(error) };
			}
		}, path)) as NativeScan;
	} catch (error) {
		// Wry's synchronous WebDriver bridge can surface a rejected Tauri invoke
		// as an execute error before the async callback returns its catch value.
		return { ok: false, error: String(error) };
	}
}

describe("Project catalog native IPC — #756 stage 1", () => {
	before(async () => {
		mkdirSync(TEMP_ROOT, { recursive: true });
		checkoutRoot = mkdtempSync(join(TEMP_ROOT, "project-catalog-native-"));
		writeFixture(
			"projects/_template/project.yaml",
			"version: 1\nproject:\n  id: template\n",
		);
		writeFixture(
			"projects/_template-local/project.yaml",
			"version: 1\nproject:\n  id: template-local\n",
		);
		writeFixture(
			"projects/example-project/project.yaml",
			"version: 1\nproject:\n  id: example-project\n  repository: example-org/example-project\n  issue_tracker: github\n  default_branch: main\n  integration_branch: develop\nroles: {}\ndiscord: {}\ncommands: {}\n",
		);
		writeFixture("projects/broken/project.yaml", "id: [invalid\n");
		writeFixture(
			"projects/missing-id/project.yaml",
			"version: 1\nproject:\n  repository: example-org/missing-id\n",
		);
	});

	after(() => {
		if (checkoutRoot) rmSync(checkoutRoot, { recursive: true, force: true });
	});

	it("reads nested project metadata, ignores unrelated settings, and excludes templates", async () => {
		await browser.waitUntil(
			async () =>
				(await browser.execute(() => location.href.startsWith("http"))) ===
				true,
			{
				timeout: 60_000,
				timeoutMsg: "Tauri WebView did not reach the app origin",
			},
		);
		const first = await nativeScan(checkoutRoot);
		expect(first.ok).toBe(true);
		const firstProjects = first.value?.projects ?? [];
		expect(firstProjects.map((project) => project.directoryName)).toEqual([
			"broken",
			"example-project",
			"missing-id",
		]);
		const exampleProject = firstProjects.find(
			(project) => project.directoryName === "example-project",
		);
		expect(exampleProject?.projectId).toBe("example-project");
		expect(exampleProject?.name).toBe("example-project");
		expect(exampleProject?.repository).toBe("example-org/example-project");
		expect(exampleProject?.issueTracker).toBe("github");
		expect(exampleProject?.configErrors).toEqual([]);
		expect(exampleProject).not.toHaveProperty("profile");
		expect(
			firstProjects.find((project) => project.directoryName === "broken")
				?.configErrors[0]?.reason,
		).toBe("invalid_yaml");
		expect(
			firstProjects.find((project) => project.directoryName === "missing-id")
				?.configErrors,
		).toEqual([
			{
				file: "projects/missing-id/project.yaml",
				reason: "missing_project_id",
			},
		]);
	});

	it("rejects a selected directory without a projects folder", async () => {
		const nonCheckout = mkdtempSync(join(TEMP_ROOT, "not-a-checkout-"));
		try {
			const result = await nativeScan(nonCheckout);
			expect(result.ok).toBe(false);
			expect(result.error).toContain("projects folder");
		} finally {
			rmSync(nonCheckout, { recursive: true, force: true });
		}
	});
});
