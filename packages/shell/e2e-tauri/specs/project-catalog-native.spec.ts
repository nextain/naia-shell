import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "@wdio/globals";

type NativeScan = {
	readonly ok: boolean;
	readonly value?: {
		readonly projects: Array<{
			readonly projectPath: string;
			readonly sourcePath: string;
			readonly projectId: string;
			readonly name: string;
			readonly repository: string | null;
			readonly issueTracker: string | null;
		}>;
		readonly catalogErrors: Array<{
			readonly path: string;
			readonly reason: string;
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

async function nativeScan(adkPath: string): Promise<NativeScan> {
	try {
		return (await browser.execute(async (configuredAdkPath: string) => {
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
					value: await tauri.invoke("projects_scan_adk", {
						adkPath: configuredAdkPath,
					}),
				};
			} catch (error) {
				return { ok: false, error: String(error) };
			}
		}, adkPath)) as NativeScan;
	} catch (error) {
		// Wry's synchronous WebDriver bridge can surface a rejected Tauri invoke
		// as an execute error before the async callback returns its catch value.
		return { ok: false, error: String(error) };
	}
}

describe("Project catalog native IPC — #756 stage 2", () => {
	before(async () => {
		mkdirSync(TEMP_ROOT, { recursive: true });
		checkoutRoot = mkdtempSync(join(TEMP_ROOT, "project-catalog-native-"));
		writeFixture(
			"projects/naia-pj-adk/projects/_template/project.yaml",
			"version: 1\nproject:\n  id: template\n",
		);
		writeFixture(
			"projects/naia-pj-adk/projects/_template-local/project.yaml",
			"version: 1\nproject:\n  id: template-local\n",
		);
		writeFixture(
			"projects/group/naia-pj-adk/projects/example-project/project.yaml",
			"version: 1\nproject:\n  id: example-project\n  repository: octocat/Hello-World\n  issue_tracker: github\n  default_branch: main\n  integration_branch: develop\nroles: {}\ndiscord: {}\ncommands: {}\n",
		);
		writeFixture(
			"projects/naia-pj-adk/projects/broken/project.yaml",
			"id: [invalid\n",
		);
		writeFixture(
			"projects/naia-pj-adk/projects/missing-id/project.yaml",
			"version: 1\nproject:\n  repository: octocat/Hello-World\n",
		);
	});

	after(() => {
		if (checkoutRoot) rmSync(checkoutRoot, { recursive: true, force: true });
	});

	it("scans one- and two-level candidate roots and reads nested project metadata", async () => {
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
		expect(firstProjects.map((project) => project.projectId)).toEqual([
			"example-project",
		]);
		const exampleProject = firstProjects.find(
			(project) => project.projectId === "example-project",
		);
		expect(exampleProject?.projectId).toBe("example-project");
		expect(exampleProject?.name).toBe("example-project");
		expect(exampleProject?.repository).toBe("octocat/Hello-World");
		expect(exampleProject?.issueTracker).toBe("github");
		expect(exampleProject?.sourcePath).toBe(
			"projects/group/naia-pj-adk/projects/example-project",
		);
		expect(exampleProject).not.toHaveProperty("profile");
		expect(
			first.value?.catalogErrors.find((issue) =>
				issue.path.endsWith("/broken/project.yaml"),
			)?.reason,
		).toBe("invalid_yaml");
		expect(
			first.value?.catalogErrors.find((issue) =>
				issue.path.endsWith("/missing-id/project.yaml"),
			)?.reason,
		).toBe("missing_project_id");
	});

	it("rejects a configured naia-adk folder without a projects folder", async () => {
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
