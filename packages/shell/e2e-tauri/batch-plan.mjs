import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const BATCH_PLAN_VERSION = 1;
export const BATCH_PLAN_FILENAME = "e2e-batch-plan.json";

function fail(message) {
	throw new Error(`[e2e-batch] invalid plan: ${message}`);
}

function isWithin(parent, candidate) {
	const rel = relative(parent, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertExplicitSpec(spec, index) {
	if (typeof spec !== "string" || spec.trim() === "") {
		fail(`specs[0][${index}] must be a non-empty path`);
	}
	if (/[?*\[\]{}]/.test(spec)) {
		fail(`specs[0][${index}] must be explicit; globs are not allowed`);
	}
	if (spec.includes("\0")) {
		fail(`specs[0][${index}] contains a NUL byte`);
	}
}

export function resolveBatchPlanPath(adkPath = process.env.NAIA_E2E_ADK_PATH) {
	if (typeof adkPath !== "string" || adkPath.trim() === "") {
		fail("NAIA_E2E_ADK_PATH must point to the ADK directory");
	}
	if (!isAbsolute(adkPath)) {
		fail("NAIA_E2E_ADK_PATH must be absolute");
	}
	const root = resolve(adkPath);
	const planPath = resolve(root, BATCH_PLAN_FILENAME);
	if (!isWithin(root, planPath)) {
		fail("plan path escaped the ADK directory");
	}
	return planPath;
}

export function validateBatchPlan(input, { adkPath = process.env.NAIA_E2E_ADK_PATH } = {}) {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		fail("root must be an object");
	}
	if (input.version !== BATCH_PLAN_VERSION) {
		fail(`version must be ${BATCH_PLAN_VERSION}`);
	}
	if (input.contract !== "single-session-ui") {
		fail('contract must be "single-session-ui"');
	}
	if (input.restartInstallExcluded !== true) {
		fail("restartInstallExcluded must be true");
	}
	if (!Array.isArray(input.specs) || input.specs.length !== 1) {
		fail("specs must contain exactly one nested worker group");
	}
	const [group] = input.specs;
	if (!Array.isArray(group) || group.length === 0) {
		fail("specs[0] must be a non-empty array of explicit spec paths");
	}
	group.forEach(assertExplicitSpec);

	const root = adkPath ? dirname(resolveBatchPlanPath(adkPath)) : undefined;
	const normalizedGroup = group.map((spec) => {
		if (isAbsolute(spec)) return resolve(spec);
		if (spec.split(/[\\/]/).includes("..")) {
			fail(`relative spec escapes the E2E project: ${spec}`);
		}
		return spec;
	});
	return {
		version: BATCH_PLAN_VERSION,
		contract: input.contract,
		restartInstallExcluded: true,
		specs: [normalizedGroup],
		...(typeof input.name === "string" && input.name.trim()
			? { name: input.name.trim() }
			: {}),
		...(root ? { adkPath: root } : {}),
	};
}

export function resolveBatchSpecPath(spec, { baseDir = process.cwd() } = {}) {
	if (typeof baseDir !== "string" || baseDir.trim() === "") {
		fail("spec base directory must be non-empty");
	}
	const root = resolve(baseDir);
	const candidate = isAbsolute(spec) ? resolve(spec) : resolve(root, spec);
	if (!existsSync(candidate) || !statSync(candidate).isFile()) {
		fail(`missing explicit spec file: ${candidate}`);
	}
	return candidate;
}

export function loadBatchPlan({
	adkPath = process.env.NAIA_E2E_ADK_PATH,
	specBaseDir = process.cwd(),
} = {}) {
	const planPath = resolveBatchPlanPath(adkPath);
	if (!existsSync(planPath)) {
		fail(`missing ${planPath}`);
	}
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(planPath, "utf8"));
	} catch (error) {
		fail(`could not read ${planPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const plan = validateBatchPlan(parsed, { adkPath });
	const resolvedSpecs = plan.specs.map((group) =>
		group.map((spec) => resolveBatchSpecPath(spec, { baseDir: specBaseDir })),
	);
	return { path: planPath, plan: { ...plan, specs: resolvedSpecs } };
}

export function hasSpecOverride(argv = process.argv) {
	return argv.some((arg) => arg === "--spec" || arg.startsWith("--spec="));
}

export function assertNoSpecOverride(argv = process.argv) {
	if (hasSpecOverride(argv)) {
		throw new Error(
			"[e2e-batch] --spec is disabled; edit the explicit ADK e2e-batch-plan.json instead",
		);
	}
}
