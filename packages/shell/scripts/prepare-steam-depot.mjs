#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SHELL_DIR = resolve(SCRIPT_DIR, "..");
const MATRIX_PATH = resolve(SHELL_DIR, "src-tauri/platform-matrix.json");

function walkFiles(root, current = root) {
	const files = [];
	for (const entry of readdirSync(current, { withFileTypes: true })) {
		const absolute = resolve(current, entry.name);
		if (entry.isDirectory()) files.push(...walkFiles(root, absolute));
		else if (entry.isFile()) files.push(absolute);
	}
	return files;
}

export function prepareSteamDepot({
	sourceDir,
	bundleDir,
	contract,
}) {
	if (!sourceDir || !statSync(sourceDir, { throwIfNoEntry: false })?.isDirectory()) {
		throw new Error(`Steam source directory not found: ${sourceDir}`);
	}
	const depotDir = resolve(bundleDir, contract.path);
	rmSync(depotDir, { recursive: true, force: true });
	mkdirSync(depotDir, { recursive: true });

	const excluded = new Set(contract.excludedFiles);
	for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
		if (excluded.has(entry.name)) continue;
		cpSync(resolve(sourceDir, entry.name), resolve(depotDir, entry.name), {
			recursive: entry.isDirectory(),
			force: true,
		});
	}

	for (const required of contract.requiredFiles) {
		const path = resolve(depotDir, required);
		if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
			throw new Error(`Steam portable depot is missing required file: ${required}`);
		}
	}
	for (const excludedFile of contract.excludedFiles) {
		if (existsSync(resolve(depotDir, excludedFile))) {
			throw new Error(`Steam portable depot contains excluded file: ${excludedFile}`);
		}
	}

	const manifestPath = resolve(depotDir, contract.manifest);
	const lines = walkFiles(depotDir)
		.filter((file) => file !== manifestPath)
		.map((file) => ({
			path: relative(depotDir, file).split(sep).join("/"),
			hash: createHash("sha256").update(readFileSync(file)).digest("hex"),
		}))
		.sort((a, b) => a.path.localeCompare(b.path))
		.map(({ hash, path }) => `${hash}  ${path}`);
	if (lines.length === 0) throw new Error("Steam portable depot is empty");
	writeFileSync(manifestPath, `${lines.join("\n")}\n`, "utf8");

	return { depotDir, entrypoint: resolve(depotDir, contract.entrypoint), manifestPath };
}

function parseArgs(argv) {
	const values = {};
	for (let i = 0; i < argv.length; i += 2) {
		const key = argv[i];
		const value = argv[i + 1];
		if (!key?.startsWith("--") || value === undefined) {
			throw new Error(`Invalid argument near: ${key ?? "<end>"}`);
		}
		values[key.slice(2)] = value;
	}
	return values;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = parseArgs(process.argv.slice(2));
	const matrix = JSON.parse(readFileSync(MATRIX_PATH, "utf8"));
	const result = prepareSteamDepot({
		sourceDir: resolve(args.source),
		bundleDir: resolve(args["bundle-dir"]),
		contract: matrix.os.win32.steamDepot,
	});
	if (args["github-output"]) {
		writeFileSync(
			args["github-output"],
			`depot=${result.depotDir}\nentrypoint=${result.entrypoint}\n`,
			{ encoding: "utf8", flag: "a" },
		);
	}
	process.stdout.write(`${result.depotDir}\n`);
}
