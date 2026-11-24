// ambient-idle — the one place that picks the NVA idle loop from broadcast / BGM state.
//   Song (YouTube BGM) playing → "singing-keyboard"; broadcast on or local BGM playing →
//   "keyboard-idle". A bundle without that animation (지나·민호) keeps its own idle (null).

import type { NvaManifest } from "../nva";

export type AmbientBgm = "" | "youtube" | "local";

export interface AmbientState {
	broadcastActive: boolean;
	/** Which BGM source is playing right now ("" = none). */
	bgmPlaying: AmbientBgm;
}

export const SINGING_IDLE_KEY = "singing-keyboard";
export const KEYBOARD_IDLE_KEY = "keyboard-idle";

/** Animation key to use as idle instead of the bundle default, or null. */
export function selectAmbientIdle(
	state: AmbientState,
	manifest: Pick<NvaManifest, "animations">,
): string | null {
	const has = (key: string) => Boolean(manifest.animations[key]?.clip);
	if (state.bgmPlaying === "youtube" && has(SINGING_IDLE_KEY))
		return SINGING_IDLE_KEY;
	if ((state.broadcastActive || state.bgmPlaying) && has(KEYBOARD_IDLE_KEY))
		return KEYBOARD_IDLE_KEY;
	return null;
}
