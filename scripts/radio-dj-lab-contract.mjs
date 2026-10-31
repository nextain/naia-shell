import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = resolve(SCRIPT_DIR, "radio-dj-lab-example.json");
const EVENT_TYPES = new Set([
	"radio.profile",
	"radio.turn",
	"radio.activity",
	"radio.voice",
	"bgm.tool",
	"bgm.playback",
	"bgm.volume",
	"ui.state",
]);
const APP_CONFIG_FIELDS = new Set([
	"provider",
	"model",
	"apiKey",
	"ttsEnabled",
	"bgmSource",
	"bgmVolume",
	"proactiveSpeechProfile",
	"proactiveSpeechPermitted",
	"proactiveSpeechIdleMs",
	"proactiveSpeechIntervalMs",
	"proactiveSpeechTimezone",
	"proactiveSpeechBgmAutoPlay",
]);
export const SHELL_REPOSITORY = "naia-shell";
export const AGENT_REPOSITORY = "paired-agent";
export const REDACTION_POLICY_VERSION = "allowlist-v1";

export function currentShellCommit() {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: SCRIPT_DIR,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

export function pairedAgentCommit() {
	const value = process.env.NAIA_RADIO_DJ_LAB_AGENT_COMMIT;
	return typeof value === "string" && /^[a-f0-9]{40,64}$/i.test(value)
		? value
		: null;
}

export function componentForEvent(eventType) {
	if (eventType.startsWith("radio.")) return "chat-area";
	if (eventType === "bgm.tool") return "bgm-skill";
	return "bgm-player";
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanEnum(value, choices) {
	return typeof value === "string" && choices.has(value) ? value : undefined;
}

function cleanNumber(value, min, max) {
	return typeof value === "number" &&
		Number.isFinite(value) &&
		value >= min &&
		value <= max
		? value
		: undefined;
}

/** Node-side equivalent of the Shell observer's event allowlist. */
export function sanitizeEvent(eventType, input) {
	if (!EVENT_TYPES.has(eventType) || !isRecord(input)) return null;
	const data = {};
	if (eventType === "radio.profile") {
		const profile = cleanEnum(
			input.profile,
			new Set(["disabled", "personal_radio_dj", "exhibition_intro"]),
		);
		if (!profile) return null;
		data.profile = profile;
	} else if (eventType === "radio.turn") {
		const phase = cleanEnum(
			input.phase,
			new Set([
				"user_started",
				"assistant_started",
				"assistant_finished",
				"cancelled",
			]),
		);
		if (!phase) return null;
		data.phase = phase;
	} else if (eventType === "radio.activity") {
		const state = cleanEnum(
			input.state,
			new Set(["started", "stopped", "paused", "resumed"]),
		);
		if (!state) return null;
		data.state = state;
	} else if (eventType === "radio.voice") {
		const phase = cleanEnum(
			input.phase,
			new Set(["started", "ended", "error"]),
		);
		const source = cleanEnum(input.source, new Set(["tts", "fixture-tone"]));
		if (!phase || !source) return null;
		data.phase = phase;
		data.source = source;
	} else if (eventType === "bgm.tool") {
		const action = cleanEnum(
			input.action,
			new Set([
				"play",
				"stop",
				"pause",
				"resume",
				"next",
				"prev",
				"favorite_add",
				"favorite_remove",
				"favorites_play",
				"like_add",
				"like_remove",
				"playlist_list",
				"playlist_create",
				"playlist_add_current",
				"playlist_play",
				"shuffle",
				"repeat",
				"status",
				"volume",
			]),
		);
		const phase = cleanEnum(input.phase, new Set(["request", "result"]));
		const outcome =
			input.outcome === undefined
				? undefined
				: cleanEnum(
						input.outcome,
						new Set(["accepted", "queued", "rejected", "failed"]),
					);
		if (!action || !phase || (input.outcome !== undefined && !outcome))
			return null;
		data.action = action;
		data.phase = phase;
		if (outcome) data.outcome = outcome;
	} else if (eventType === "bgm.playback") {
		const status = cleanEnum(
			input.status,
			new Set([
				"requested",
				"loading",
				"playing",
				"paused",
				"ended",
				"error",
				"timeout",
			]),
		);
		const source = cleanEnum(input.source, new Set(["local", "youtube"]));
		if (!status || !source) return null;
		data.status = status;
		data.source = source;
		if (
			source === "youtube" &&
			typeof input.track_id === "string" &&
			/^[A-Za-z0-9_-]{11}$/.test(input.track_id)
		) {
			data.track_id = input.track_id;
		}
		const currentTime = cleanNumber(input.current_time_s, 0, 86_400);
		const duration = cleanNumber(input.duration_s, 0, 86_400);
		if (currentTime !== undefined) data.current_time_s = currentTime;
		if (duration !== undefined) data.duration_s = duration;
	} else if (eventType === "bgm.volume") {
		const volume = cleanNumber(input.volume, 0, 1);
		if (volume === undefined) return null;
		data.volume = volume;
	} else if (eventType === "ui.state") {
		const surface = cleanEnum(input.surface, new Set(["bgm_player"]));
		const state = cleanEnum(
			input.state,
			new Set(["playback_status_refreshed"]),
		);
		const playbackStatus = cleanEnum(
			input.playback_status,
			new Set(["requested", "loading", "playing", "paused", "ended", "error", "timeout"]),
		);
		if (!surface || !state || !playbackStatus) return null;
		data.surface = surface;
		data.state = state;
		data.playback_status = playbackStatus;
	}
	return { event_type: eventType, data };
}

export function validateLabConfig(config) {
	if (!isRecord(config) || config.schema_version !== "1.0") {
		throw new Error("config schema_version must be 1.0");
	}
	if (
		typeof config.scenario_id !== "string" ||
		!/^[a-z0-9-]{1,64}$/.test(config.scenario_id)
	) {
		throw new Error("scenario_id must be a lowercase identifier");
	}
	if (config.opening_utterance !== "일하면서 뭐라도 얘기해봐") {
		throw new Error(
			"opening_utterance must match the baseline scenario wording",
		);
	}
	if (!isRecord(config.shell_config))
		throw new Error("shell_config must be an AppConfig-shaped object");
	for (const key of Object.keys(config.shell_config)) {
		if (!APP_CONFIG_FIELDS.has(key))
			throw new Error(`unknown Shell AppConfig field: ${key}`);
	}
	const shell = config.shell_config;
	if (shell.apiKey !== "")
		throw new Error("example shell_config must not contain a credential");
	if (shell.bgmSource !== "youtube" && shell.bgmSource !== "local")
		throw new Error("shell_config.bgmSource is invalid");
	if (shell.proactiveSpeechProfile !== "personal_radio_dj")
		throw new Error(
			"shell_config.proactiveSpeechProfile must use the personal_radio_dj profile",
		);
	if (
		typeof shell.proactiveSpeechPermitted !== "boolean" ||
		typeof shell.proactiveSpeechBgmAutoPlay !== "boolean"
	) {
		throw new Error(
			"Shell speech permission and BGM settings must be booleans",
		);
	}
	if (!isRecord(config.thresholds))
		throw new Error("thresholds must be an object");
	for (const [name, value] of Object.entries(config.thresholds)) {
		if (
			value !== null &&
			(typeof value !== "number" || !Number.isFinite(value) || value < 0)
		) {
			throw new Error(
				`threshold ${name} must be a non-negative number or null`,
			);
		}
	}
	if (
		!isRecord(config.deterministic) ||
		!Number.isInteger(config.deterministic.seed)
	) {
		throw new Error("deterministic.seed must be an integer");
	}
	if (
		!Array.isArray(config.deterministic.events) ||
		config.deterministic.events.length === 0
	) {
		throw new Error("deterministic.events must contain fixture events");
	}
	let previousAt = -1;
	for (const fixture of config.deterministic.events) {
		if (
			!isRecord(fixture) ||
			!Number.isInteger(fixture.at_ms) ||
			fixture.at_ms < previousAt
		) {
			throw new Error("fixture events must be ordered by non-negative at_ms");
		}
		if (!sanitizeEvent(fixture.event_type, fixture.data)) {
			throw new Error(
				`invalid deterministic fixture event: ${String(fixture.event_type)}`,
			);
		}
		previousAt = fixture.at_ms;
	}
	if (
		!isRecord(config.practical) ||
		!Number.isInteger(config.practical.duration_minutes) ||
		config.practical.duration_minutes < 30 ||
		config.practical.duration_minutes > 60
	) {
		throw new Error("practical.duration_minutes must be between 30 and 60");
	}
	if (!Number.isInteger(Date.parse(config.virtual_epoch_utc)))
		throw new Error("virtual_epoch_utc must be a UTC timestamp");
	return config;
}

export async function loadLabConfig(configPath = DEFAULT_CONFIG) {
	const config = JSON.parse(await readFile(configPath, "utf8"));
	return validateLabConfig(config);
}
