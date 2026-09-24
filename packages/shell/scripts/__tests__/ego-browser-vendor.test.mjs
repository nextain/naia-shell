import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	egoBrowserVendorPaths,
	ensureEgoBrowserVendor,
} from "../ego-browser-vendor.mjs";

const temporaryRoots = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A fake packages/ tree: packages/shell next to the vendored ego-browser package. */
function fixture({ packageJson = true, nodeModules = false, entry = false } = {}) {
	const root = mkdtempSync(join(tmpdir(), "naia-ego-vendor-test-"));
	temporaryRoots.push(root);
	const shellDir = join(root, "shell");
	mkdirSync(shellDir, { recursive: true });
	const paths = egoBrowserVendorPaths(shellDir);
	mkdirSync(paths.root, { recursive: true });
	if (packageJson) writeFileSync(join(paths.root, "package.json"), "{}\n");
	if (nodeModules) mkdirSync(paths.nodeModules, { recursive: true });
	if (entry) {
		mkdirSync(dirname(paths.entry), { recursive: true });
		writeFileSync(paths.entry, "");
	}
	return { shellDir, paths };
}

/** Records every step; `node scripts/build.mjs` writes the entry when `produces` is set. */
function recordingSpawn(paths, { produces = true, failOn = null } = {}) {
	const calls = [];
	const spawn = (command, args, options) => {
		calls.push({ command, args, cwd: options.cwd });
		if (failOn === command) return { status: 1 };
		if (command === "node" && produces) {
			mkdirSync(dirname(paths.entry), { recursive: true });
			writeFileSync(paths.entry, "");
		}
		return { status: 0 };
	};
	return { calls, spawn };
}

const quiet = () => {};

describe("ensureEgoBrowserVendor (#587)", () => {
	it("points at the vendored package next to packages/shell", () => {
		const { shellDir, paths } = fixture();
		expect(paths.root).toBe(
			join(dirname(shellDir), "ego-host", "vendor", "ego-lite", "package", "ego-browser"),
		);
		expect(paths.entry).toBe(join(paths.root, "dist", "out", "index.js"));
	});

	it("reuses an existing build without touching the network", () => {
		const { shellDir, paths } = fixture({ entry: true });
		const { calls, spawn } = recordingSpawn(paths);
		expect(ensureEgoBrowserVendor({ shellDir, spawn, log: quiet })).toBe("present");
		expect(calls).toEqual([]);
	});

	it("installs without lifecycle scripts, then builds, on a fresh checkout", () => {
		const { shellDir, paths } = fixture();
		const { calls, spawn } = recordingSpawn(paths);
		expect(ensureEgoBrowserVendor({ shellDir, spawn, log: quiet })).toBe("built");
		expect(calls).toEqual([
			{ command: "npm", args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], cwd: paths.root },
			{ command: "node", args: ["scripts/build.mjs"], cwd: paths.root },
		]);
	});

	it("skips the install when dependencies are already present", () => {
		const { shellDir, paths } = fixture({ nodeModules: true });
		const { calls, spawn } = recordingSpawn(paths);
		ensureEgoBrowserVendor({ shellDir, spawn, log: quiet });
		expect(calls.map((call) => call.command)).toEqual(["node"]);
	});

	it("stops when the install fails", () => {
		const { shellDir, paths } = fixture();
		const { spawn } = recordingSpawn(paths, { failOn: "npm" });
		expect(() => ensureEgoBrowserVendor({ shellDir, spawn, log: quiet })).toThrow(/npm ci/);
	});

	it("stops when the build exits cleanly without producing the entry", () => {
		const { shellDir, paths } = fixture({ nodeModules: true });
		const { spawn } = recordingSpawn(paths, { produces: false });
		expect(() => ensureEgoBrowserVendor({ shellDir, spawn, log: quiet })).toThrow(/without/);
	});

	it("stops when the vendored package itself is missing", () => {
		const { shellDir, paths } = fixture({ packageJson: false });
		const { spawn } = recordingSpawn(paths);
		expect(() => ensureEgoBrowserVendor({ shellDir, spawn, log: quiet })).toThrow(/missing/);
	});
});
