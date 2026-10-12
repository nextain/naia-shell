import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect } from "@wdio/globals";

type NativeScan = {
	readonly ok: boolean;
	readonly value?: {
		readonly projects: Array<{
			readonly directoryName: string;
			readonly projectId: string;
			readonly repository: string | null;
			readonly profile: string | null;
			readonly configErrors: Array<{
				readonly file: string;
				readonly reason: string;
			}>;
		}>;
	};
	readonly error?: string;
};

const TEMP_ROOT = resolve(process.cwd(), "../../.agy-work/756-s1/tmp");
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
			"id: template\nprofile: server\n",
		);
		writeFixture(
			"projects/_template-local/project.yaml",
			"id: template-local\nprofile: local\n",
		);
		writeFixture(
			"projects/alpha/project.yaml",
			"id: alpha\nname: Alpha\nrepository: nextain/alpha\nissue_tracker: github\nprofile: local\n",
		);
		writeFixture("projects/broken/project.yaml", "id: [invalid\n");
		writeFixture("profiles/local/profile.yaml", "mode: local\n");
		writeFixture("profiles/local/workspace/repos.json", "{invalid json");
	});

	after(() => {
		if (checkoutRoot) rmSync(checkoutRoot, { recursive: true, force: true });
	});

	it("reads only checkout configuration, excludes templates, and reports malformed local metadata", async () => {
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
			"alpha",
			"broken",
		]);
		const alpha = firstProjects.find(
			(project) => project.directoryName === "alpha",
		);
		expect(alpha?.projectId).toBe("alpha");
		expect(alpha?.repository).toBe("nextain/alpha");
		expect(alpha?.profile).toBe("local");
		expect(alpha?.configErrors).toEqual([
			{ file: "profiles/local/workspace/repos.json", reason: "invalid_json" },
		]);
		expect(
			firstProjects.find((project) => project.directoryName === "broken")
				?.configErrors[0]?.reason,
		).toBe("invalid_yaml");

		writeFixture(
			"profiles/local/workspace/repos.json",
			JSON.stringify({ repositories: [] }),
		);
		const second = await nativeScan(checkoutRoot);
		expect(second.ok).toBe(true);
		expect(
			second.value?.projects.find(
				(project) => project.directoryName === "alpha",
			)?.configErrors,
		).toEqual([]);
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
