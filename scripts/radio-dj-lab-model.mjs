import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	AGENT_REPOSITORY,
	REDACTION_POLICY_VERSION,
	SHELL_REPOSITORY,
	currentShellCommit,
	pairedAgentCommit,
	validateLabConfig,
} from "./radio-dj-lab-contract.mjs";
import { buildEvent, createJudgement, createVirtualClock } from "./radio-dj-lab-observations.mjs";
import { createFixtureToneWav, jsonl, renderTimelineSvg, writeEmptyOutputDir } from "./radio-dj-lab-render.mjs";

export function createDeterministicRun(config, options = {}) {
	validateLabConfig(config);
	const epoch = Date.parse(config.virtual_epoch_utc);
	const clock = createVirtualClock();
	const runId = `deterministic-seed-${config.deterministic.seed}`;
	const shellCommit = options.shellCommit ?? currentShellCommit();
	const events = config.deterministic.events.map((fixture, index) => {
		clock.advanceTo(fixture.at_ms);
		return buildEvent({
			runId,
			sequence: index + 1,
			eventType: fixture.event_type,
			data: fixture.data,
			mode: "deterministic",
			elapsedMs: clock.now(),
			observationSource: "simulated",
			occurredAt: epoch + clock.now(),
			shellCommit,
		});
	});
	return {
		runId,
		shellCommit,
		events,
		judgement: createJudgement(config, events, "deterministic"),
	};
}

export async function writeDeterministicRun(config, outputPath) {
	const outputDir = resolve(outputPath);
	await writeEmptyOutputDir(outputDir);
	const { runId, shellCommit, events, judgement } =
		createDeterministicRun(config);
	const createdAt = new Date().toISOString();
	const manifest = {
		schema_version: "1.0",
		run_id: runId,
		scenario_id: config.scenario_id,
		mode: "deterministic",
		clock_domain: "virtual",
		seed: config.deterministic.seed,
		created_at_utc: createdAt,
		virtual_epoch_utc: config.virtual_epoch_utc,
		repositories: [
			{ name: SHELL_REPOSITORY, commit: shellCommit },
			{ name: AGENT_REPOSITORY, commit: pairedAgentCommit() },
		],
		protocol_version: "1.0",
		redaction_policy_version: REDACTION_POLICY_VERSION,
		capture_refs: [],
		opening_utterance: config.opening_utterance,
		shell_config_shape: Object.keys(config.shell_config).sort(),
		thresholds: config.thresholds,
		threshold_profile: { schema_version: "1.0", values: config.thresholds },
		configured_model: {
			provider: config.shell_config.provider,
			model_id: config.shell_config.model,
			quantization: null,
			device: null,
		},
		music_source: {
			kind: "synthetic-fixture",
			configured_source: config.shell_config.bgmSource,
			track_id: "FAKE76201xx",
		},
		downstream_adapter_contract: {
			memory_input_fields: [
				"content",
				"role",
				"timestamp",
				"context",
				"idempotencyKey",
			],
			memory_input_context_type: "string",
			memory_write_performed: false,
			persona_atom_fields: [
				"id",
				"layer",
				"domain",
				"claim",
				"evidence.source_path",
				"evidence.quote",
				"volatility",
				"rationale",
			],
			persona_promotion_performed: false,
			training_performed: false,
		},
		external_network_calls: 0,
		actual_llm_calls: 0,
		fixture_audio: {
			file: "fixture-tone.wav",
			kind: "synthetic-tone-not-speech",
			sample_rate_hz: 16000,
			duration_ms: 350,
		},
		limits: [
			"No app, YouTube, network, model, or speech service was started.",
			"Playback and voice events are fixture observations.",
			"No screen or audio capture was recorded; capture_refs is empty.",
		],
	};
	const files = [
		["manifest.json", `${JSON.stringify(manifest, null, 2)}\n`],
		["events.jsonl", jsonl(events)],
		["judgement.json", `${JSON.stringify(judgement, null, 2)}\n`],
		["checks.json", `${JSON.stringify(judgement.checks, null, 2)}\n`],
		[
			"timeline.svg",
			renderTimelineSvg(events, "Radio DJ Lab · deterministic run"),
		],
		[
			"timeline.html",
			`<!doctype html><meta charset="utf-8"><title>Radio DJ Lab timeline</title><style>body{margin:24px;background:#f4f6f8}img{max-width:100%;height:auto}</style><img src="timeline.svg" alt="Radio DJ Lab deterministic time-axis timeline">`,
		],
		[
			"candidate-fixes.md",
			"# Candidate fixes\n\nThe deterministic fixture produced no product-fix candidate. It records synthetic events only.\n",
		],
	];
	for (const [name, contents] of files)
		await writeFile(resolve(outputDir, name), contents, { flag: "wx" });
	await writeFile(
		resolve(outputDir, "fixture-tone.wav"),
		createFixtureToneWav(),
		{ flag: "wx" },
	);
	return { outputDir, manifest, events, judgement };
}
