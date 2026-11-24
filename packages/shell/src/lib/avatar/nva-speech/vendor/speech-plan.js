// Provider-neutral speech timing contract for the NVA player.
// Times are integer microseconds so plans stay deterministic across browsers.

export const SPEECH_UNITS = Object.freeze([
  "sil",
  "closed",
  "labiodental",
  "dental",
  "alveolar",
  "postalveolar",
  "palatal",
  "velar",
  "glottal",
  "vowel-open",
  "vowel-mid",
  "vowel-spread",
  "vowel-round",
]);

const UNIT_SET = new Set(SPEECH_UNITS);
const SHA256 = /^[a-f0-9]{64}$/;

export function validateSpeechPlan(plan) {
  const errors = [];
  const fail = (message) => errors.push(message);

  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return { ok: false, errors: ["speech plan must be an object"] };
  }
  if (plan.version !== "1") fail('version must be "1"');
  if (typeof plan.text !== "string") fail("text must be a string");
  // aligned: aligner phone boundaries on an audio file (SoT 2).
  // browser-timed: browser speech start/boundary/end events, no audio file (SoT 5).
  if (!new Set(["aligned", "browser-timed"]).has(plan.quality_mode))
    fail("quality_mode must be aligned or browser-timed");
  if (plan.quality_mode === "aligned" && (!plan.audio || !SHA256.test(plan.audio.sha256 || "")))
    fail("audio.sha256 must identify the exact input audio");
  if (!Number.isSafeInteger(plan.audio?.duration_us) || plan.audio.duration_us <= 0)
    fail("audio.duration_us must be a positive integer");

  if (plan.quality_mode === "aligned") {
    if (!plan.aligner || typeof plan.aligner !== "object")
      fail("aligned plans require aligner provenance");
    else {
      if (typeof plan.aligner.provider !== "string" || !plan.aligner.provider)
        fail("aligner.provider is required");
      if (typeof plan.aligner.version !== "string" || !plan.aligner.version)
        fail("aligner.version is required");
      if (!SHA256.test(plan.aligner.model_sha256 || ""))
        fail("aligner.model_sha256 is required");
    }
  }

  if (!Array.isArray(plan.events) || plan.events.length === 0) {
    fail("events must be a non-empty array");
  } else {
    let cursor = 0;
    for (const [index, event] of plan.events.entries()) {
      if (!event || typeof event !== "object") {
        fail(`events[${index}] must be an object`);
        continue;
      }
      if (!UNIT_SET.has(event.unit)) fail(`events[${index}].unit is not in the frozen inventory`);
      if (!Number.isSafeInteger(event.start_us) || !Number.isSafeInteger(event.end_us)) {
        fail(`events[${index}] times must be integer microseconds`);
        continue;
      }
      if (event.start_us !== cursor) fail(`events[${index}] must start at ${cursor}`);
      if (event.end_us <= event.start_us) fail(`events[${index}] must have positive duration`);
      cursor = event.end_us;
    }
    if (Number.isSafeInteger(plan.audio?.duration_us) && cursor !== plan.audio.duration_us)
      fail("events must cover the complete audio duration");
  }

  return { ok: errors.length === 0, errors };
}

// Events shorter than 40 ms cannot provide a stable transition. Remove the
// globally shortest event (earlier wins a duration tie), then merge it into
// the longer neighbor (right wins a neighbor tie). Confidence is ignored.
export function normalizeShortSpeechEvents(events, minimumDurationUs = 40_000) {
  if (!Array.isArray(events)) return [];
  const normalized = events.map((event) => ({ ...event }));
  if (!Number.isSafeInteger(minimumDurationUs) || minimumDurationUs < 0)
    throw new TypeError("minimumDurationUs must be a non-negative integer");

  while (normalized.length > 1) {
    let index = -1;
    let shortest = Infinity;
    for (let candidate = 0; candidate < normalized.length; candidate++) {
      const event = normalized[candidate];
      const duration = event.end_us - event.start_us;
      if (Number.isSafeInteger(event.start_us) && Number.isSafeInteger(event.end_us)
        && duration < minimumDurationUs && duration < shortest) {
        index = candidate;
        shortest = duration;
      }
    }
    if (index < 0) break;

    const previousDuration = index > 0
      ? normalized[index - 1].end_us - normalized[index - 1].start_us
      : -1;
    const nextDuration = index + 1 < normalized.length
      ? normalized[index + 1].end_us - normalized[index + 1].start_us
      : -1;
    if (index === 0 || nextDuration >= previousDuration) {
      normalized[index + 1].start_us = normalized[index].start_us;
    } else {
      normalized[index - 1].end_us = normalized[index].end_us;
    }
    normalized.splice(index, 1);
  }
  return normalized;
}
