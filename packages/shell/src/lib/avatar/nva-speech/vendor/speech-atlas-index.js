import { SPEECH_UNITS } from "./speech-plan.js";

const UNIT_SET = new Set(SPEECH_UNITS);
const SHA256 = /^[a-f0-9]{64}$/;
const CODEC = "vp09.00.10.08";

export function validateSpeechAtlasIndex(index, atlasBytes) {
  const errors = [];
  const fail = (message) => errors.push(message);

  if (!index || typeof index !== "object" || Array.isArray(index))
    return { ok: false, errors: ["atlas index must be an object"] };
  if (index.version !== "1") fail('version must be "1"');
  if (!Number.isSafeInteger(atlasBytes) || atlasBytes < 0)
    fail("atlasBytes must be a non-negative integer");

  const entries = index.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries) || !Object.keys(entries).length) {
    fail("entries must be a non-empty object");
    return { ok: false, errors };
  }
  const entryKeys = Object.keys(entries);
  const pairKeys = entryKeys.filter((key) => key.split(">").length === 2);
  const contextKeys = entryKeys.filter((key) => key.split(">").length === 3);
  if (pairKeys.length > 169) fail("atlas may contain at most 169 directional pair units");
  if (contextKeys.length > 64) fail("atlas may contain at most 64 three-unit contexts");
  const pairSet = new Set(pairKeys);
  for (const key of contextKeys) {
    const [previous, current] = key.split(">");
    if (!pairSet.has(`${previous}>${current}`))
      fail(`${key}: three-unit context requires pair fallback ${previous}>${current}`);
  }

  const ranges = [];
  for (const [key, entry] of Object.entries(entries)) {
    const units = key.split(">");
    if ((units.length !== 2 && units.length !== 3) || units.some((unit) => !UNIT_SET.has(unit)))
      fail(`${key}: key must be a frozen inventory transition or three-unit context`);
    if (!entry || typeof entry !== "object") {
      fail(`${key}: entry must be an object`);
      continue;
    }
    if (!Number.isSafeInteger(entry.offset) || entry.offset < 0)
      fail(`${key}: offset must be a non-negative integer`);
    if (!Number.isSafeInteger(entry.length) || entry.length <= 0)
      fail(`${key}: length must be a positive integer`);
    if (!SHA256.test(entry.sha256 || "")) fail(`${key}: invalid sha256`);
    if (entry.frames !== 5) fail(`${key}: frames must be 5`);
    if (entry.fps !== 25) fail(`${key}: fps must be 25`);
    if (entry.codec !== CODEC) fail(`${key}: codec must be ${CODEC}`);
    if (entry.lossless !== true) fail(`${key}: lossless must be true`);
    if (Number.isSafeInteger(entry.offset) && Number.isSafeInteger(entry.length) && entry.length > 0)
      ranges.push({ key, start: entry.offset, end: entry.offset + entry.length });
  }

  ranges.sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
  let cursor = 0;
  for (const range of ranges) {
    if (range.start !== cursor)
      fail(`${range.key}: byte range must start at ${cursor}, got ${range.start}`);
    cursor = Math.max(cursor, range.end);
  }
  if (Number.isSafeInteger(atlasBytes) && atlasBytes >= 0 && cursor !== atlasBytes)
    fail(`atlas coverage ends at ${cursor}, expected ${atlasBytes}`);

  return { ok: errors.length === 0, errors };
}
