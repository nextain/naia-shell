#!/usr/bin/env node
import { stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { loadLabConfig } from "./radio-dj-lab-contract.mjs";
import { writeDeterministicRun } from "./radio-dj-lab-model.mjs";
import { runPracticalCollector } from "./radio-dj-lab-practical.mjs";

export { createDeterministicRun, writeDeterministicRun } from "./radio-dj-lab-model.mjs";
export { loadLabConfig, sanitizeEvent, validateLabConfig } from "./radio-dj-lab-contract.mjs";
export { createVirtualClock } from "./radio-dj-lab-observations.mjs";
export { runPracticalCollector } from "./radio-dj-lab-practical.mjs";

function parseArgs(args) {
	const [mode = "deterministic", ...rest] = args;
	const options = { mode, config: undefined, output: undefined };
	for (let index = 0; index < rest.length; index += 1) {
		const option = rest[index];
		if (option === "--config" && rest[index + 1])
			options.config = resolve(rest[++index]);
		else if (option === "--output" && rest[index + 1])
			options.output = resolve(rest[++index]);
		else throw new Error("unknown or incomplete argument: " + option);
	}
	return options;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const config = await loadLabConfig(options.config);
	if (options.mode === "deterministic") {
		const result = await writeDeterministicRun(config, options.output ?? resolve("radio-dj-lab-output"));
		stdout.write(
			JSON.stringify(
				{
					mode: "deterministic",
					event_count: result.events.length,
					error_count: result.judgement.error_count,
					output_dir: result.outputDir,
				},
				null,
				2,
			) + "\n",
		);
		return;
	}
	if (options.mode === "practical") {
		await runPracticalCollector(config, options.output ?? resolve("radio-dj-lab-practical"));
		return;
	}
	throw new Error("mode must be deterministic or practical");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => {
		stdout.write("Radio DJ Lab error: " + (error instanceof Error ? error.message : String(error)) + "\n");
		process.exitCode = 1;
	});
}
