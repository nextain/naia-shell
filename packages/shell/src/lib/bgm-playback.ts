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

export interface BgmPlaybackPort {
	request(track: BgmSelectedTrack): BgmPlaybackSnapshot;
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
export function createBgmPlaybackPort(now: () => number = Date.now): BgmPlaybackPort {
	let current: BgmPlaybackSnapshot | null = null;
	let nextCommand = 0;
	let nextPlayback = 0;

	return {
		request(track) {
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

/** Safe context for an agent: no current track metadata before confirmed play. */
export function toBgmObservedContext(snapshot: BgmPlaybackSnapshot | null, now = Date.now()) {
	if (!snapshot) return { playback: null, currentTrack: null, announceTrack: false };
	const isFreshPlaying = snapshot.status === "playing" && snapshot.freshUntil >= now;
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
	};
}
