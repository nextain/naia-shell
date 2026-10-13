export interface RadioDjLabEvent {
	schema_version: "1.0";
	run_id: string;
	event_id: string;
	sequence: number;
	event_type: string;
	source: { repo: "naia-shell"; commit: string | null; component: string };
	mode: "deterministic" | "practical";
	clock_domain: "virtual" | "monotonic";
	observation_source: "simulated" | "observed";
	occurred_at_utc: string;
	elapsed_ms: number;
	data: Record<string, string | number | boolean>;
}

export interface RadioDjLabJudgement {
	schema_version: "1.0";
	run_id: string;
	mode: "deterministic" | "practical";
	result: "recorded" | "observations_incomplete";
	error_count: number;
	metrics: Record<string, number | null>;
	checks: RadioDjLabCheck[];
}

export interface RadioDjLabCheck {
	check_id: string;
	observed: boolean | number | null;
	threshold_key: string | null;
	threshold: number | null;
	unit: string | null;
	status: "pass" | "fail" | "unscored";
	evidence_event_ids: string[];
	note: string;
}

export interface RadioDjLabConfig {
	schema_version: "1.0";
	scenario_id: string;
	opening_utterance: string;
	virtual_epoch_utc: string;
	shell_config: Record<string, unknown>;
	thresholds: Record<string, number | null>;
	practical: { duration_minutes: number; port: number };
	deterministic: {
		seed: number;
		events: Array<{
			at_ms: number;
			event_type: string;
			data: Record<string, unknown>;
		}>;
	};
}

export function sanitizeEvent(
	eventType: string,
	input: Record<string, unknown>,
): {
	event_type: string;
	data: Record<string, string | number | boolean>;
} | null;
export function validateLabConfig(config: unknown): RadioDjLabConfig;
export function loadLabConfig(configPath?: string): Promise<RadioDjLabConfig>;
export function createVirtualClock(startAtMs?: number): {
	now(): number;
	isPaused(): boolean;
	pause(): void;
	resume(): void;
	advanceBy(deltaMs: number): number;
	advanceTo(atMs: number): number;
};
export function createDeterministicRun(
	config: RadioDjLabConfig,
	options?: { shellCommit?: string | null },
): {
	runId: string;
	shellCommit: string | null;
	events: RadioDjLabEvent[];
	judgement: RadioDjLabJudgement;
};
export function writeDeterministicRun(
	config: RadioDjLabConfig,
	outputPath: string,
): Promise<{
	outputDir: string;
	manifest: Record<string, unknown>;
	events: RadioDjLabEvent[];
	judgement: RadioDjLabJudgement;
}>;
