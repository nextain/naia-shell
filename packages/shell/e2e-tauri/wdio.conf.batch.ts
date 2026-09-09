import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { assertNoSpecOverride, loadBatchPlan } from "./batch-plan.mjs";
import { config as base } from "./wdio.conf.js";

// This configuration is deliberately opt-in. The normal config keeps its broad
// spec discovery; a batch run must name its plan through the selected ADK.
assertNoSpecOverride();
const batchConfigDir = dirname(fileURLToPath(import.meta.url));
const { path: planPath, plan } = loadBatchPlan({ specBaseDir: batchConfigDir });

const baseConfig = base as Record<string, unknown>;
const reporterPath = fileURLToPath(new URL("./batch-results.mjs", import.meta.url));
const baseReporters = Array.isArray(baseConfig.reporters)
	? baseConfig.reporters
	: ["spec"];

export const config = {
	...base,
	// WDIO accepts a nested group as one worker's explicit spec list. Do not
	// flatten it: the one session is part of the batch contract.
	specs: plan.specs,
	maxInstances: 1,
	bail: 0,
	reporters: [
		...baseReporters,
		[
			reporterPath,
			{
				adkPath: dirname(planPath),
				planPath,
				runId: process.env.NAIA_E2E_RUN_ID?.trim() || "e2e-batch",
			},
		],
	],
};
