import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { requiredTscBuild, tscBuild } from "../dev-setup.mjs";

const sourcePath = fileURLToPath(new URL("../dev-setup.mjs", import.meta.url));
const temporaryRoots = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureProject() {
	const root = mkdtempSync(join(tmpdir(), "naia-dev-setup-test-"));
	temporaryRoots.push(root);
	writeFileSync(join(root, "package.json"), '{"private":true}\n');
	return root;
}

describe("dev-setup ownership and build boundaries", () => {
	it("does not contain a process-wide kill path", () => {
		const source = readFileSync(sourcePath, "utf8");

		expect(source).toContain("process cleanup skipped");
		expect(source).not.toMatch(/\b(?:pkill|taskkill)\b/);
		expect(source).not.toMatch(/Get-(?:WmiObject|NetTCPConnection)/);
		expect(source).not.toContain("lsof -ti:1420");
		expect(source).not.toMatch(/\bkill\s+-9\b/);
	});

	it("uses the project build config and returns after a successful tsc", () => {
		const root = fixtureProject();
		writeFileSync(join(root, "tsconfig.build.json"), "{}\n");
		const calls = [];

		expect(tscBuild(root, "fixture", (command, options) => calls.push({ command, options }))).toBe(true);
		expect(calls).toEqual([
			{
				command: "npx --no-install tsc -p tsconfig.build.json",
				options: { cwd: root, stdio: "inherit" },
			},
		]);
	});

	it("propagates a tsc failure so the caller exits nonzero", () => {
		const root = fixtureProject();
		const failure = new Error("synthetic tsc failure");
		let observed;

		try {
			tscBuild(root, "fixture", () => {
				throw failure;
			});
		} catch (error) {
			observed = error;
		}

		expect(observed).toBe(failure);
	});

	it("fails when a required build project is missing", () => {
		const root = mkdtempSync(join(tmpdir(), "naia-dev-setup-missing-"));
		temporaryRoots.push(root);
		let observed;

		try {
			requiredTscBuild(root, "required fixture", () => {
				throw new Error("tsc must not run without package.json");
			});
		} catch (error) {
			observed = error;
		}

		expect(observed?.message).toMatch(/package\.json 없음/);
	});
});
