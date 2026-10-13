import { componentForEvent, sanitizeEvent, SHELL_REPOSITORY } from "./radio-dj-lab-contract.mjs";

export function createVirtualClock(startAtMs = 0) {
	if (!Number.isInteger(startAtMs) || startAtMs < 0)
		throw new Error("virtual clock start must be a non-negative integer");
	let currentMs = startAtMs;
	let paused = false;
	return {
		now: () => currentMs,
		isPaused: () => paused,
		pause: () => {
			paused = true;
		},
		resume: () => {
			paused = false;
		},
		advanceBy: (deltaMs) => {
			if (!Number.isInteger(deltaMs) || deltaMs < 0)
				throw new Error("virtual clock delta must be a non-negative integer");
			if (!paused) currentMs += deltaMs;
			return currentMs;
		},
		advanceTo: (atMs) => {
			if (!Number.isInteger(atMs) || atMs < currentMs)
				throw new Error(
					"virtual clock target must be an integer at or after now",
				);
			if (!paused) currentMs = atMs;
			return currentMs;
		},
	};
}

export function buildEvent({
	runId,
	sequence,
	eventType,
	data,
	mode,
	elapsedMs,
	observationSource,
	occurredAt,
	shellCommit,
}) {
	const safe = sanitizeEvent(eventType, data);
	if (!safe) throw new Error(`invalid event ${eventType}`);
	return {
		schema_version: "1.0",
		run_id: runId,
		event_id: `evt-${String(sequence).padStart(3, "0")}`,
		sequence,
		event_type: safe.event_type,
		source: {
			repo: SHELL_REPOSITORY,
			commit: shellCommit,
			component: componentForEvent(eventType),
		},
		mode,
		clock_domain: mode === "deterministic" ? "virtual" : "monotonic",
		observation_source: observationSource,
		occurred_at_utc: new Date(occurredAt).toISOString(),
		elapsed_ms: elapsedMs,
		data: safe.data,
	};
}

function eventTime(events, eventType, predicate = () => true) {
	return (
		events.find((event) => event.event_type === eventType && predicate(event))
			?.elapsed_ms ?? null
	);
}

function playbackLatency(events) {
	const requested = eventTime(
		events,
		"bgm.playback",
		(event) => event.data.status === "requested",
	);
	const playing = eventTime(
		events,
		"bgm.playback",
		(event) => event.data.status === "playing",
	);
	return requested === null || playing === null ? null : playing - requested;
}

function voiceOverlapMs(events) {
	const voiceStart = eventTime(
		events,
		"radio.voice",
		(event) => event.data.phase === "started",
	);
	const voiceEnd = eventTime(
		events,
		"radio.voice",
		(event) => event.data.phase === "ended",
	);
	const musicStart = eventTime(
		events,
		"bgm.playback",
		(event) => event.data.status === "playing",
	);
	const musicEnd = eventTime(
		events,
		"bgm.playback",
		(event) => event.data.status === "ended",
	);
	if (voiceStart === null || voiceEnd === null || musicStart === null)
		return null;
	return Math.max(
		0,
		Math.min(voiceEnd, musicEnd ?? voiceEnd) - Math.max(voiceStart, musicStart),
	);
}

function observedCheck(checkId, observed, evidenceEventIds, note) {
	return {
		check_id: checkId,
		observed,
		threshold_key: null,
		threshold: null,
		unit: null,
		status: observed ? "pass" : "fail",
		evidence_event_ids: evidenceEventIds,
		note: observed ? note : `${note} Required evidence was not observed.`,
	};
}

function thresholdCheck(config, name, actual, rule, evidenceEventIds) {
	const threshold = config.thresholds[name] ?? null;
	const status =
		actual === null || threshold === null
			? "unscored"
			: rule === "max"
				? actual <= threshold
					? "pass"
					: "fail"
				: actual >= threshold
					? "pass"
					: "fail";
	return {
		check_id: `threshold.${name}`,
		observed: actual,
		threshold_key: name,
		threshold,
		unit: "ms",
		status,
		evidence_event_ids: evidenceEventIds,
		note:
			status === "unscored"
				? "Threshold is unset or its measurement is unavailable."
				: `Observed value was evaluated against the configured ${rule} threshold.`,
	};
}

export function createJudgement(config, events, mode) {
	const firstPlaybackMs = playbackLatency(events);
	const overlapMs = voiceOverlapMs(events);
	const statuses = events
		.filter((event) => event.event_type === "bgm.playback")
		.map((event) => event.data.status);
	const toolEvents = events.filter((event) => event.event_type === "bgm.tool");
	const voiceEvents = events.filter(
		(event) => event.event_type === "radio.voice",
	);
	const playbackEvents = events.filter(
		(event) => event.event_type === "bgm.playback",
	);
	const openingEvents = events.filter(
		(event) =>
			event.event_type === "radio.turn" &&
			event.data.phase === "user_started",
	);
	const checks = [
		observedCheck(
			"baseline-opening-turn",
			openingEvents.length > 0,
			openingEvents.map((event) => event.event_id),
			"The baseline opening turn event was observed.",
		),
		observedCheck(
			"bgm-tool-request-and-result",
			toolEvents.some(
				(event) =>
					event.data.action === "play" && event.data.phase === "request",
			) &&
				toolEvents.some(
					(event) =>
						event.data.action === "play" && event.data.phase === "result",
				),
			toolEvents.map((event) => event.event_id),
			"The play tool request and result events were observed.",
		),
		observedCheck(
			"playback-state-sequence",
			["requested", "loading", "playing"].every((status) =>
				statuses.includes(status),
			),
			playbackEvents.map((event) => event.event_id),
			"The requested, loading, and playing states were observed.",
		),
		observedCheck(
			"fixture-voice-window",
			voiceEvents.some((event) => event.data.phase === "started") &&
				voiceEvents.some((event) => event.data.phase === "ended"),
			voiceEvents.map((event) => event.event_id),
			"The fixture voice start and end events were observed.",
		),
		observedCheck(
			"ui-state-observed",
			events.some((event) => event.event_type === "ui.state"),
			events
				.filter((event) => event.event_type === "ui.state")
				.map((event) => event.event_id),
			"A player UI state event was observed.",
		),
	];
	const metrics = {
		first_playback_after_request_ms: firstPlaybackMs,
		voice_music_overlap_ms: overlapMs,
		playing_observation_count: statuses.filter((status) => status === "playing")
			.length,
	};
	const firstPlaybackEvidence = playbackEvents
		.filter((event) => ["requested", "playing"].includes(event.data.status))
		.map((event) => event.event_id);
	const overlapEvidence = [
		...voiceEvents,
		...playbackEvents.filter((event) =>
			["playing", "ended"].includes(event.data.status),
		),
	].map((event) => event.event_id);
	const playingEvidence = playbackEvents
		.filter((event) => ["playing", "ended"].includes(event.data.status))
		.map((event) => event.event_id);
	for (const [name, actual, rule, evidenceEventIds] of [
		[
			"max_first_playback_ms",
			firstPlaybackMs,
			"max",
			firstPlaybackEvidence,
		],
		[
			"max_voice_music_overlap_ms",
			overlapMs,
			"max",
			overlapEvidence,
		],
		["min_playing_ms", null, "min", playingEvidence],
	]) {
		checks.push(
			thresholdCheck(config, name, actual, rule, evidenceEventIds),
		);
	}
	const errorCount = checks.filter((check) => check.status === "fail").length;
	return {
		schema_version: "1.0",
		run_id:
			mode === "deterministic"
				? `deterministic-seed-${config.deterministic.seed}`
				: "practical-run",
		mode,
		result: errorCount === 0 ? "recorded" : "observations_incomplete",
		error_count: errorCount,
		metrics,
		checks,
		judgement_note:
			"Threshold values left null are unscored. Tool receipts are not evidence of actual audio playback.",
	};
}
