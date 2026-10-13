import { Logger } from "./logger";

export type RadioDjLabEventType =
	| "radio.profile"
	| "radio.turn"
	| "radio.activity"
	| "radio.voice"
	| "bgm.tool"
	| "bgm.playback"
	| "bgm.volume"
	| "ui.state";

export interface RadioDjLabEvent {
	event_type: RadioDjLabEventType;
	data: Record<string, string | number | boolean>;
}

interface RadioDjLabBridge {
	record: (event: RadioDjLabEvent) => void;
}

declare global {
	interface Window {
		__NAIA_RADIO_DJ_LAB__?: RadioDjLabBridge;
	}
}

const PROFILE_VALUES = new Set([
	"disabled",
	"personal_radio_dj",
	"exhibition_intro",
]);
const TURN_PHASES = new Set([
	"user_started",
	"assistant_started",
	"assistant_finished",
	"cancelled",
]);
const ACTIVITY_STATES = new Set(["started", "stopped", "paused", "resumed"]);
const VOICE_PHASES = new Set(["started", "ended", "error"]);
const VOICE_SOURCES = new Set(["tts", "fixture-tone"]);
const BGM_ACTIONS = new Set([
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
]);
const TOOL_PHASES = new Set(["request", "result"]);
const TOOL_OUTCOMES = new Set(["accepted", "queued", "rejected", "failed"]);
const PLAYBACK_STATUSES = new Set([
	"requested",
	"loading",
	"playing",
	"paused",
	"ended",
	"error",
	"timeout",
]);

function enumValue(
	value: unknown,
	allowed: ReadonlySet<string>,
): string | undefined {
	return typeof value === "string" && allowed.has(value) ? value : undefined;
}

function finiteNumber(
	value: unknown,
	min: number,
	max: number,
): number | undefined {
	return typeof value === "number" &&
		Number.isFinite(value) &&
		value >= min &&
		value <= max
		? value
		: undefined;
}

/** Return an allowlisted event payload; arbitrary text and URLs are discarded. */
export function sanitizeRadioDjLabEvent(
	eventType: string,
	input: Record<string, unknown>,
): RadioDjLabEvent | null {
	const data: Record<string, string | number | boolean> = {};
	if (eventType === "radio.profile") {
		const profile = enumValue(input.profile, PROFILE_VALUES);
		if (!profile) return null;
		data.profile = profile;
	} else if (eventType === "radio.turn") {
		const phase = enumValue(input.phase, TURN_PHASES);
		if (!phase) return null;
		data.phase = phase;
	} else if (eventType === "radio.activity") {
		const state = enumValue(input.state, ACTIVITY_STATES);
		if (!state) return null;
		data.state = state;
	} else if (eventType === "radio.voice") {
		const phase = enumValue(input.phase, VOICE_PHASES);
		const source = enumValue(input.source, VOICE_SOURCES);
		if (!phase || !source) return null;
		data.phase = phase;
		data.source = source;
	} else if (eventType === "bgm.tool") {
		const action = enumValue(input.action, BGM_ACTIONS);
		const phase = enumValue(input.phase, TOOL_PHASES);
		const outcome =
			input.outcome === undefined
				? undefined
				: enumValue(input.outcome, TOOL_OUTCOMES);
		if (!action || !phase || (input.outcome !== undefined && !outcome))
			return null;
		data.action = action;
		data.phase = phase;
		if (outcome) data.outcome = outcome;
	} else if (eventType === "bgm.playback") {
		const status = enumValue(input.status, PLAYBACK_STATUSES);
		const source = enumValue(input.source, new Set(["local", "youtube"]));
		if (!status || !source) return null;
		data.status = status;
		data.source = source;
		const trackId = input.track_id;
		if (
			source === "youtube" &&
			typeof trackId === "string" &&
			/^[A-Za-z0-9_-]{11}$/.test(trackId)
		) {
			data.track_id = trackId;
		}
		const currentTime = finiteNumber(input.current_time_s, 0, 86_400);
		const duration = finiteNumber(input.duration_s, 0, 86_400);
		if (currentTime !== undefined) data.current_time_s = currentTime;
		if (duration !== undefined) data.duration_s = duration;
	} else if (eventType === "bgm.volume") {
		const volume = finiteNumber(input.volume, 0, 1);
		if (volume === undefined) return null;
		data.volume = volume;
	} else if (eventType === "ui.state") {
		const surface = enumValue(input.surface, new Set(["bgm_player"]));
		const state = enumValue(input.state, new Set(["playback_status_refreshed"]));
		const playbackStatus = enumValue(input.playback_status, PLAYBACK_STATUSES);
		if (!surface || !state || !playbackStatus) return null;
		data.surface = surface;
		data.state = state;
		data.playback_status = playbackStatus;
	} else {
		return null;
	}
	return { event_type: eventType as RadioDjLabEventType, data };
}

export function isRadioDjLabObserverAttached(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof window.__NAIA_RADIO_DJ_LAB__?.record === "function"
	);
}

/** Forward only allowlisted observations to the explicitly attached practical recorder. */
export function recordRadioDjLabEvent(
	eventType: RadioDjLabEventType,
	input: Record<string, unknown>,
): void {
	const observer =
		typeof window === "undefined" ? undefined : window.__NAIA_RADIO_DJ_LAB__;
	if (!observer || typeof observer.record !== "function") return;
	const event = sanitizeRadioDjLabEvent(eventType, input);
	if (!event) {
		Logger.debug("RadioDjLabObserver", "discarded invalid event", {
			eventType,
		});
		return;
	}
	Logger.debug("RadioDjLabObserver", "forwarding event", {
		eventType: event.event_type,
		fieldCount: Object.keys(event.data).length,
	});
	try {
		observer.record(event);
	} catch {
		// Instrumentation must never interrupt the app action being observed.
		Logger.debug("RadioDjLabObserver", "recorder callback failed", {
			eventType: event.event_type,
		});
	}
}
