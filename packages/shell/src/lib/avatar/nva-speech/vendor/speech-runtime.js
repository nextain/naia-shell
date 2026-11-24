import {
  normalizeShortSpeechEvents,
  validateSpeechPlan,
} from "./speech-plan.js";

const FRAME_OFFSETS_US = Object.freeze([-80_000, -40_000, 0, 40_000, 80_000]);
const CROSSFADE_HALF_WIDTH_US = 40_000;
const FRAME_INTERVAL_US = 40_000;
const UNIT_SPAN_US = 80_000;
const MAX_PLAYBACK_RATE = 2;

// Protocol line 103: "할당 구간이 80ms보다 짧으면 playback rate를 최대 2배로
// 올린다. 그래도 40ms 미만이면 ... 합친다." The allocated span is the current
// event's duration after normalizeShortSpeechEvents, so every span is >= 40ms
// and the rate 80ms/span never exceeds 2. Spans of 80ms or more keep rate 1
// and the a0c9715 frame times unchanged.
export function speechPlaybackRate(durationUs) {
  if (!Number.isSafeInteger(durationUs) || durationUs <= 0) return 1;
  if (durationUs >= UNIT_SPAN_US) return 1;
  return Math.min(MAX_PLAYBACK_RATE, UNIT_SPAN_US / durationUs);
}

// Convert an audio-clock SpeechPlan to language-independent atlas operations.
// Decoding/compositing is deliberately kept behind a browser adapter.
export function buildSpeechSchedule(plan, { availableKeys } = {}) {
  const validation = validateSpeechPlan(plan);
  if (!validation.ok) throw new TypeError(`invalid SpeechPlan: ${validation.errors.join("; ")}`);

  const events = normalizeShortSpeechEvents(plan.events);
  const available = availableKeys === undefined ? null : new Set(availableKeys);
  const transitions = [];
  for (let index = 1; index < events.length; index++) {
    const previous = events[index - 1];
    const current = events[index];
    const pairKey = `${previous.unit}>${current.unit}`;
    const next = events[index + 1];
    const contextKey = next ? `${previous.unit}>${current.unit}>${next.unit}` : null;
    const key = contextKey && available?.has(contextKey) ? contextKey : pairKey;
    if (available && !available.has(key)) throw new Error(`missing atlas unit: ${key}`);
    const boundaryUs = current.start_us;
    const playbackRate = speechPlaybackRate(current.end_us - current.start_us);
    transitions.push({
      key,
      previous_unit: previous.unit,
      current_unit: current.unit,
      boundary_us: boundaryUs,
      frame_times_us: FRAME_OFFSETS_US.map((offset) => boundaryUs + Math.round(offset / playbackRate)),
      frames: 5,
      fps: 25,
      playback_rate: playbackRate,
    });
  }

  return {
    version: "1",
    audio_sha256: plan.audio.sha256,
    duration_us: plan.audio.duration_us,
    quality_mode: plan.quality_mode,
    events,
    transitions,
  };
}

// HTTP callers translate start/end to Range: bytes=start-end. Local callers
// use Blob.slice(start, end + 1). Only the first two unique units are primed.
export function prefetchSpeechRanges(schedule, atlasIndex, limit = 2) {
  if (!schedule || !Array.isArray(schedule.transitions))
    throw new TypeError("schedule.transitions is required");
  if (!atlasIndex || atlasIndex.version !== "1" || !atlasIndex.entries)
    throw new TypeError("atlas index v1 is required");
  if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError("limit must be a non-negative integer");

  const ranges = [];
  const seen = new Set();
  for (const transition of schedule.transitions) {
    if (ranges.length >= limit) break;
    if (seen.has(transition.key)) continue;
    seen.add(transition.key);
    const entry = atlasIndex.entries[transition.key];
    if (!entry) throw new Error(`missing atlas index entry: ${transition.key}`);
    if (!Number.isSafeInteger(entry.offset) || entry.offset < 0
      || !Number.isSafeInteger(entry.length) || entry.length <= 0)
      throw new TypeError(`invalid atlas byte range: ${transition.key}`);
    ranges.push({
      key: transition.key,
      start: entry.offset,
      end: entry.offset + entry.length - 1,
    });
  }
  return ranges;
}

function transitionFrame(transition, timeUs) {
  const intervalUs = FRAME_INTERVAL_US / (transition.playback_rate ?? 1);
  const frame = Math.round((timeUs - transition.frame_times_us[0]) / intervalUs);
  return Math.max(0, Math.min(4, frame));
}

// Resolve the atlas layers for one audio-clock instant. Adjacent transition
// clips change ownership at their midpoint and overlap for exactly two 25fps
// frames (80ms) with a raised-cosine blend.
export function resolveSpeechLayers(schedule, timeUs) {
  if (!schedule || !Array.isArray(schedule.transitions))
    throw new TypeError("schedule.transitions is required");
  if (!Number.isSafeInteger(timeUs) || timeUs < 0)
    throw new TypeError("timeUs must be a non-negative safe integer");
  const transitions = schedule.transitions;
  if (!transitions.length || timeUs < transitions[0].frame_times_us[0]) return [];

  for (let index = 0; index < transitions.length - 1; index++) {
    const left = transitions[index];
    const right = transitions[index + 1];
    const midpoint = Math.round((left.boundary_us + right.boundary_us) / 2);
    const start = midpoint - CROSSFADE_HALF_WIDTH_US;
    const end = midpoint + CROSSFADE_HALF_WIDTH_US;
    if (timeUs < start) {
      return [{ index, key: left.key, frame: transitionFrame(left, timeUs), opacity: 1 }];
    }
    if (timeUs <= end) {
      const progress = Math.max(0, Math.min(1, (timeUs - start) / (end - start)));
      const rightOpacity = (1 - Math.cos(Math.PI * progress)) / 2;
      return [
        { index, key: left.key, frame: transitionFrame(left, timeUs), opacity: 1 - rightOpacity },
        { index: index + 1, key: right.key, frame: transitionFrame(right, timeUs), opacity: rightOpacity },
      ].filter((layer) => layer.opacity > 0);
    }
  }

  const index = transitions.length - 1;
  const transition = transitions[index];
  return [{ index, key: transition.key, frame: transitionFrame(transition, timeUs), opacity: 1 }];
}

export class SpeechPlaybackState {
  constructor(getState, setState) {
    if (typeof getState !== "function" || typeof setState !== "function")
      throw new TypeError("getState and setState callbacks are required");
    this.getState = getState;
    this.setState = setState;
    this.sequence = 0;
    this.active = null;
    this.lastOutcome = null;
  }

  begin(speakingState) {
    const token = Object.freeze({ id: ++this.sequence });
    const original = this.active?.original ?? this.getState();
    this.active = { token, original };
    this.setState(speakingState);
    return token;
  }

  settle(token, outcome) {
    if (!this.active || token?.id !== this.active.token.id) return false;
    if (!new Set(["complete", "cancel", "error"]).has(outcome))
      throw new TypeError("outcome must be complete, cancel, or error");
    const { original } = this.active;
    this.active = null;
    this.lastOutcome = outcome;
    this.setState(original);
    return true;
  }
}
