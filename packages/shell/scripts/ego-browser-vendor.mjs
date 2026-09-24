/**
 * ego-browser-vendor.mjs — build the vendored ego-browser SDK before any Rust build (#587).
 *
 * `src-tauri/tauri.conf.json` bundles
 * `ego-host/vendor/ego-lite/package/ego-browser/dist/` as a resource, and
 * tauri-build fails its build script with `resource path ... doesn't exist`
 * when that directory is missing. The directory is a build output, ignored by
 * `packages/ego-host/.gitignore`, so a fresh checkout never has it. Every path
 * that compiles the Tauri crate (installer staging, tauri dev/prod, native
 * E2E) calls this first.
 *
 * `npm ci --ignore-scripts`: the vendor `prepare` script is POSIX shell that
 * installs lefthook hooks for the upstream repository. It fails under cmd.exe
 * on Windows and has no role in producing `dist/`.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const SHELL = resolve(import.meta.dirname, "..");

export function egoBrowserVendorPaths(shellDir = SHELL) {
	const root = resolve(
		shellDir,
		"..",
		"ego-host",
		"vendor",
		"ego-lite",
		"package",
		"ego-browser",
	);
	return {
		root,
		entry: resolve(root, "dist", "out", "index.js"),
		nodeModules: resolve(root, "node_modules"),
	};
}

function runStep(command, args, cwd, spawn) {
	const result = spawn(command, args, {
		cwd,
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	if (result.status !== 0) {
		throw new Error(
			`[ego-browser-vendor] ${command} ${args.join(" ")} failed in ${cwd} (exit ${result.status ?? result.signal ?? "unknown"})`,
		);
	}
}

/**
 * Ensure the vendored SDK entry exists. Returns "present" when an earlier
 * build is reused and "built" after building it. Throws when the build fails
 * or does not produce the entry, so the caller stops before cargo reports the
 * less helpful missing-resource error.
 */
export function ensureEgoBrowserVendor({
	shellDir = SHELL,
	spawn = spawnSync,
	log = (line) => process.stdout.write(`${line}\n`),
} = {}) {
	const paths = egoBrowserVendorPaths(shellDir);
	if (existsSync(paths.entry)) return "present";
	if (!existsSync(resolve(paths.root, "package.json"))) {
		throw new Error(
			`[ego-browser-vendor] vendored ego-browser package is missing: ${paths.root}`,
		);
	}
	if (!existsSync(paths.nodeModules)) {
		log("[ego-browser-vendor] installing vendored ego-browser build dependencies");
		runStep("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], paths.root, spawn);
	}
	log("[ego-browser-vendor] building vendored ego-browser dist/");
	runStep("node", ["scripts/build.mjs"], paths.root, spawn);
	if (!existsSync(paths.entry)) {
		throw new Error(
			`[ego-browser-vendor] build finished without ${paths.entry}`,
		);
	}
	return "built";
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
	try {
		ensureEgoBrowserVendor();
	} catch (error) {
		console.error(error?.message ?? error);
		process.exit(1);
	}
}
