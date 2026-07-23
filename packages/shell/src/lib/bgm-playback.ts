/**
 * BGM playback fact boundary.
 *
 * A request to replace an iframe is not evidence that YouTube started audio.
 * The tool and DJ context therefore expose a selected track only after the
 * iframe reports `playing` for the same playback id.
 */

export const BGM_PLAYBACK_STATUSES = [
	"requested",
	"loading",
	"playing",
	"paused",
	"ended",
	"error",
	"timeout",
] as const;

export type BgmPlaybackStatus = (typeof BGM_PLAYBACK_STATUSES)[number];

export interface BgmSelectedTrack {
	videoId: string;
	title: string;
}

export interface BgmPlaybackSnapshot {
	playbackId: string;
	commandId: string;
	sequence: number;
	status: BgmPlaybackStatus;
	updatedAt: number;
	freshUntil: number;
	selected: BgmSelectedTrack;
	reason?: string;
}

export interface BgmQueuedTrack {
	queueId: string;
	position: number;
	requestedAt: number;
	selected: BgmSelectedTrack;
}

export type BgmEnqueueResult =
	| { disposition: "play"; playback: BgmPlaybackSnapshot }
	| { disposition: "queued"; queued: BgmQueuedTrack; queueLength: number };

export interface BgmPlaybackPort {
	request(track: BgmSelectedTrack): BgmPlaybackSnapshot;
	/** Starts a track or queues it without replacing the active iframe. */
	enqueue(track: BgmSelectedTrack): BgmEnqueueResult;
	/** Promotes a queued track only after the active iframe reports ended. */
	advance(): BgmPlaybackSnapshot | null;
	queue(): readonly BgmQueuedTrack[];
	clearQueue(): void;
	observe(input: {
		playbackId: string;
		sequence: number;
		status: Exclude<BgmPlaybackStatus, "requested">;
		reason?: string;
	}): BgmPlaybackSnapshot | null;
	current(): BgmPlaybackSnapshot | null;
	reset(): void;
}

const FRESH_MS = 5_000;

/** A small in-process authority shared by the panel command and iframe owner. */
export function createBgmPlaybackPort(
	now: () => number = Date.now,
): BgmPlaybackPort {
	let current: BgmPlaybackSnapshot | null = null;
	let nextCommand = 0;
	let nextPlayback = 0;
	let nextQueue = 0;
	let queued: BgmQueuedTrack[] = [];

	function start(track: BgmSelectedTrack): BgmPlaybackSnapshot {
		const at = now();
		current = {
			playbackId: `bgm-playback-${++nextPlayback}`,
			commandId: `bgm-command-${++nextCommand}`,
			sequence: 1,
			status: "requested",
			updatedAt: at,
			freshUntil: at + FRESH_MS,
			selected: track,
		};
		return current;
	}

	return {
		request(track) {
			queued = [];
			return start(track);
		},
		enqueue(track) {
			if (!current || ["ended", "error", "timeout"].includes(current.status))
				return { disposition: "play", playback: start(track) };
			const queuedTrack: BgmQueuedTrack = {
				queueId: `bgm-queue-${++nextQueue}`,
				position: queued.length + 1,
				requestedAt: now(),
				selected: track,
			};
			queued = [...queued, queuedTrack];
			return {
				disposition: "queued",
				queued: queuedTrack,
				queueLength: queued.length,
			};
		},
		advance() {
			const next = queued[0];
			if (!next) return null;
			queued = queued
				.slice(1)
				.map((item, index) => ({ ...item, position: index + 1 }));
			return start(next.selected);
		},
		queue: () => queued,
		clearQueue: () => {
			queued = [];
		},
		observe(input) {
			if (
				!current ||
				input.playbackId !== current.playbackId ||
				input.sequence <= current.sequence
			) {
				return null;
			}
			const at = now();
			current = {
				...current,
				sequence: input.sequence,
				status: input.status,
				updatedAt: at,
				freshUntil: at + FRESH_MS,
				...(input.reason ? { reason: input.reason } : {}),
			};
			return current;
		},
		current: () => current,
		reset: () => {
			current = null;
			nextCommand = 0;
			nextPlayback = 0;
			nextQueue = 0;
			queued = [];
		},
	};
}

/** Application instance. Tests use createBgmPlaybackPort for isolated state. */
export const bgmPlayback = createBgmPlaybackPort();

/**
 * Tool result deliberately has no top-level `title`/`currentlyPlaying` field.
 * LLMs may acknowledge a selected track, but must not introduce it until this
 * exact snapshot has an observed, fresh `playing` status.
 */
export function toBgmPlayToolResult(snapshot: BgmPlaybackSnapshot) {
	return {
		ok: true,
		action: "play" as const,
		commandId: snapshot.commandId,
		playback: {
			playbackId: snapshot.playbackId,
			sequence: snapshot.sequence,
			status: snapshot.status,
			updatedAt: snapshot.updatedAt,
			freshUntil: snapshot.freshUntil,
		},
		selected: snapshot.selected,
		announceTrack: snapshot.status === "playing",
		instruction:
			"This only confirms the play request. Do not say the selected track is playing or introduce its title until a later observation has status=playing and announceTrack=true.",
	};
}

export function toBgmQueuedToolResult(
	queued: BgmQueuedTrack,
	queueLength: number,
) {
	return {
		ok: true,
		action: "play" as const,
		queued: {
			queueId: queued.queueId,
			position: queued.position,
			queueLength,
			selected: queued.selected,
		},
		announceTrack: false,
		instruction:
			"This track is queued, not playing. You may say it is next, but do not say it is playing until a later observation reports playing for its playbackId.",
	};
}

/** Safe context for an agent: no current track metadata before confirmed play. */
export function toBgmObservedContext(
	snapshot: BgmPlaybackSnapshot | null,
	now = Date.now(),
	queue: readonly BgmQueuedTrack[] = [],
) {
	if (!snapshot)
		return { playback: null, currentTrack: null, announceTrack: false };
	const isFreshPlaying =
		snapshot.status === "playing" && snapshot.freshUntil >= now;
	return {
		playback: {
			playbackId: snapshot.playbackId,
			commandId: snapshot.commandId,
			sequence: snapshot.sequence,
			status: snapshot.status,
			updatedAt: snapshot.updatedAt,
			freshUntil: snapshot.freshUntil,
			...(snapshot.reason ? { reason: snapshot.reason } : {}),
		},
		currentTrack: isFreshPlaying ? snapshot.selected : null,
		announceTrack: isFreshPlaying,
		queue: queue.map((item) => ({
			queueId: item.queueId,
			position: item.position,
			selected: item.selected,
		})),
	};
}
