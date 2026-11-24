import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_ACCOUNT_NAME = "naiairdemo20261106";
export const DEFAULT_CONTAINER = "$web";
export const NO_CACHE_CONTROL = "no-cache";
export const LONG_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const MEDIA_CACHE_CONTROL = "public, max-age=3600";

const NO_CACHE_FILE_RE =
	/^(?:.+\/)?(?:index\.html|sw\.js|service-worker\.js|register[-_]?sw[^/]*\.m?js|sw[-_]?register[^/]*\.m?js|manifest\.webmanifest)$/i;
const NO_CACHE_EXACT = new Set([".vite/manifest.json"]);
const HASHED_ASSET_RES = [
	/^assets\/.+-[A-Za-z0-9_-]{8,}\.(?:js|mjs|css|woff2?|svg|png|webp|jpg|jpeg|wasm|json)$/,
	/^kiosk-slides\/(?:private\/)?[0-9a-f]{12,}\.(?:jpg|jpeg|png|webp)$/i,
	/^web-adk\/[0-9a-f]{12,}\.json$/i,
];

/**
 * Normalize relative POSIX paths and reject path traversal outside siteDir.
 */
function normalizeRelPath(relPath) {
	const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
	if (!normalized || normalized.split("/").includes("..")) {
		throw new Error(`Invalid relative site path: ${relPath}`);
	}
	return normalized;
}

/**
 * Determine the Cache-Control tier and header policy for a built static site file.
 */
export function classifyDeployCacheControl(relPath) {
	const normalized = normalizeRelPath(relPath);
	if (NO_CACHE_EXACT.has(normalized) || NO_CACHE_FILE_RE.test(normalized)) {
		return {
			relPath: normalized,
			tier: "no-cache",
			cacheControl: NO_CACHE_CONTROL,
		};
	}
	if (HASHED_ASSET_RES.some((re) => re.test(normalized))) {
		return {
			relPath: normalized,
			tier: "immutable",
			cacheControl: LONG_CACHE_CONTROL,
		};
	}
	return {
		relPath: normalized,
		tier: "media",
		cacheControl: MEDIA_CACHE_CONTROL,
	};
}

function walkSiteFiles(rootDir, currentDir = rootDir, out = []) {
	const entries = fs.readdirSync(currentDir, { withFileTypes: true });
	for (const entry of entries) {
		const absPath = path.join(currentDir, entry.name);
		if (entry.isDirectory()) {
			walkSiteFiles(rootDir, absPath, out);
		} else if (entry.isFile()) {
			out.push(normalizeRelPath(path.relative(rootDir, absPath)));
		}
	}
	return out.sort();
}

function validateAccountName(accountName) {
	if (typeof accountName !== "string" || !/^[a-z0-9]{3,24}$/.test(accountName)) {
		throw new Error(`Invalid Azure Storage account name: ${accountName}`);
	}
	return accountName;
}

/**
 * Build a deterministic, ordered multi-tier Azure $web upload plan:
 * 1) hashed/immutable assets, 2) static media assets, 3) no-cache entrypoints last.
 */
export function buildUploadPlan({
	siteDir,
	accountName = DEFAULT_ACCOUNT_NAME,
	container = DEFAULT_CONTAINER,
	authMode = "key",
	stageBaseDir,
} = {}) {
	if (!siteDir) {
		throw new Error("siteDir is required");
	}
	const absSiteDir = path.resolve(siteDir);
	if (!fs.existsSync(absSiteDir) || !fs.statSync(absSiteDir).isDirectory()) {
		throw new Error(`Site directory does not exist: ${absSiteDir}`);
	}
	const validAccount = validateAccountName(accountName);
	const relFiles = walkSiteFiles(absSiteDir);
	const fileSet = new Set(relFiles);
	for (const requiredFile of ["index.html", "sw.js"]) {
		if (!fileSet.has(requiredFile)) {
			throw new Error(`Required site entry file is missing: ${requiredFile}`);
		}
	}

	const grouped = {
		immutable: [],
		media: [],
		"no-cache": [],
	};
	for (const relPath of relFiles) {
		const classified = classifyDeployCacheControl(relPath);
		grouped[classified.tier].push(classified);
	}

	const stageRoot = stageBaseDir
		? path.resolve(stageBaseDir)
		: path.join(os.tmpdir(), "naia-web-demo-upload-stage");

	const tierOrder = [
		{ tier: "immutable", cacheControl: LONG_CACHE_CONTROL },
		{ tier: "media", cacheControl: MEDIA_CACHE_CONTROL },
		{ tier: "no-cache", cacheControl: NO_CACHE_CONTROL },
	];

	const steps = [];
	for (const { tier, cacheControl } of tierOrder) {
		const files = grouped[tier];
		if (files.length === 0) continue;
		const stageDir = path.join(stageRoot, tier);
		const args = [
			"storage",
			"blob",
			"upload-batch",
			"--account-name",
			validAccount,
			"-d",
			container,
			"-s",
			stageDir,
			"--overwrite",
			"--content-cache-control",
			cacheControl,
			"--auth-mode",
			authMode,
			"-o",
			"none",
		];
		steps.push({
			tier,
			cacheControl,
			stageDir,
			files: files.map((f) => f.relPath),
			command: "az",
			args,
		});
	}

	return {
		siteDir: absSiteDir,
		accountName: validAccount,
		container,
		totalFiles: relFiles.length,
		steps,
	};
}

function shellQuoteArg(arg) {
	if (/^[A-Za-z0-9_./:-]+$/.test(arg)) return arg;
	return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Format an upload plan for human inspection and dry-run verification.
 */
export function formatDryRunPlan(plan) {
	const lines = [
		`[deploy-web-demo] dry-run plan for ${plan.siteDir} (${plan.totalFiles} files -> ${plan.accountName}/${plan.container})`,
	];
	for (const step of plan.steps) {
		lines.push(
			`step tier=${step.tier} files=${step.files.length} cache-control="${step.cacheControl}"`,
		);
		lines.push(
			`  cmd: az ${step.args.map(shellQuoteArg).join(" ")}`,
		);
		const preview =
			step.tier === "no-cache" ? step.files : step.files.slice(0, 5);
		for (const file of preview) {
			lines.push(`  - ${file} => Cache-Control: ${step.cacheControl}`);
		}
		if (step.files.length > preview.length) {
			lines.push(`  - ... (${step.files.length - preview.length} more)`);
		}
	}
	return `${lines.join("\n")}\n`;
}

function populateStageDir(absSiteDir, stageDir, relFiles) {
	fs.rmSync(stageDir, { recursive: true, force: true });
	for (const relPath of relFiles) {
		const src = path.join(absSiteDir, relPath);
		const dst = path.join(stageDir, relPath);
		fs.mkdirSync(path.dirname(dst), { recursive: true });
		try {
			fs.linkSync(src, dst);
		} catch {
			fs.copyFileSync(src, dst);
		}
	}
}

/**
 * Execute (or dry-run) the multi-tier upload plan. Uses hardlinked staging directories on execution and cleans them up.
 */
export function deployWebDemo({
	siteDir,
	accountName = DEFAULT_ACCOUNT_NAME,
	container = DEFAULT_CONTAINER,
	authMode = "key",
	dryRun = false,
	runner = execFileSync,
} = {}) {
	const absSiteDir = path.resolve(siteDir);
	const stageRoot = dryRun
		? undefined
		: fs.mkdtempSync(path.join(path.dirname(absSiteDir), ".deploy-stage-"));
	const plan = buildUploadPlan({
		siteDir: absSiteDir,
		accountName,
		container,
		authMode,
		stageBaseDir: stageRoot,
	});
	if (dryRun) {
		return { dryRun: true, plan, output: formatDryRunPlan(plan) };
	}

	try {
		for (const step of plan.steps) {
			populateStageDir(plan.siteDir, step.stageDir, step.files);
			runner(step.command, step.args, { stdio: "inherit" });
		}
		return { dryRun: false, plan };
	} finally {
		if (stageRoot) {
			fs.rmSync(stageRoot, { recursive: true, force: true });
		}
	}
}

function parseCliArgs(argv) {
	const parsed = {
		dryRun: false,
		json: false,
		accountName: DEFAULT_ACCOUNT_NAME,
		container: DEFAULT_CONTAINER,
		siteDir: "",
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dry-run") {
			parsed.dryRun = true;
		} else if (arg === "--json") {
			parsed.json = true;
		} else if (arg === "--site-dir" || arg === "-s") {
			parsed.siteDir = argv[++i] ?? "";
		} else if (arg === "--account-name") {
			parsed.accountName = argv[++i] ?? "";
		} else if (arg === "--container" || arg === "-d") {
			parsed.container = argv[++i] ?? "";
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	return parsed;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
	const opts = parseCliArgs(process.argv.slice(2));
	const result = deployWebDemo(opts);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify(result.plan, null, 2)}\n`);
	} else if (result.output) {
		process.stdout.write(result.output);
	}
}
