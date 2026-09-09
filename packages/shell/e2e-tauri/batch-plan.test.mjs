import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import {
	assertNoSpecOverride,
	loadBatchPlan,
	validateBatchPlan,
} from "./batch-plan.mjs";

function makeAdk() {
	return mkdtempSync(join(tmpdir(), "naia-e2e-batch-plan-"));
}

function validPlan(...specs) {
	return {
		version: 1,
		contract: "single-session-ui",
		restartInstallExcluded: true,
		specs: [specs],
	};
}

test("loads one explicit nested spec group from the selected ADK", () => {
	const adkPath = makeAdk();
	const specPath = join(adkPath, "smoke.spec.ts");
	writeFileSync(specPath, "describe('smoke', () => {});\n");
	writeFileSync(
		join(adkPath, "e2e-batch-plan.json"),
		JSON.stringify({ ...validPlan(specPath), name: "smoke" }),
	);

	const loaded = loadBatchPlan({ adkPath });

	assert.equal(loaded.path, join(adkPath, "e2e-batch-plan.json"));
	assert.deepEqual(loaded.plan.specs, [[specPath]]);
	assert.equal(loaded.plan.name, "smoke");
	assert.equal(loaded.plan.adkPath, adkPath);
});

test("resolves relative specs from the configured batch directory and rejects missing files", () => {
	const adkPath = makeAdk();
	const specBaseDir = makeAdk();
	writeFileSync(join(specBaseDir, "case-a.spec.ts"), "describe('case-a', () => {});\n");
	writeFileSync(
		join(adkPath, "e2e-batch-plan.json"),
		JSON.stringify(validPlan("./case-a.spec.ts")),
	);

	const loaded = loadBatchPlan({ adkPath, specBaseDir });
	assert.deepEqual(loaded.plan.specs, [[join(specBaseDir, "case-a.spec.ts")]]);

	writeFileSync(
		join(adkPath, "e2e-batch-plan.json"),
		JSON.stringify(validPlan("./missing.spec.ts")),
	);
	assert.throws(
		() => loadBatchPlan({ adkPath, specBaseDir }),
		/missing explicit spec file/,
	);
});

test("rejects globs, flat specs, traversal, and restart/install plans", () => {
	const adkPath = makeAdk();
	const invalidPlans = [
		{ ...validPlan("e2e-tauri/specs/**/*.spec.ts") },
		{
			version: 1,
			contract: "single-session-ui",
			restartInstallExcluded: true,
			specs: ["e2e-tauri/specs/98-smoke-a.spec.ts"],
		},
		{ ...validPlan("../outside.spec.ts") },
		{ ...validPlan("e2e-tauri/specs/98-smoke-a.spec.ts"), restartInstallExcluded: false },
	];

	for (const plan of invalidPlans) {
		assert.throws(() => validateBatchPlan(plan, { adkPath }), /\[e2e-batch\] invalid plan/);
	}
});

test("rejects command-line spec overrides so the plan remains the selected scope", () => {
	assert.doesNotThrow(() => assertNoSpecOverride(["node", "wdio"]));
	assert.throws(
		() => assertNoSpecOverride(["node", "wdio", "--spec", "other.spec.ts"]),
		/--spec is disabled/,
	);
	assert.throws(
		() => assertNoSpecOverride(["node", "wdio", "--spec=other.spec.ts"]),
		/--spec is disabled/,
	);
});

test("requires an absolute selected ADK path", () => {
	assert.throws(
		() => validateBatchPlan(validPlan("smoke.spec.ts"), { adkPath: "relative-adk" }),
		/NAIA_E2E_ADK_PATH must be absolute/,
	);
});
