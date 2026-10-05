/**
 * scripts/r2-iso-prune.mjs
 *
 * R2 naia-releases ISO build candidate & promote backup retention planner.
 * Calculates pruning plan for builds/<variant>/<buildId>/, builds/<buildId>/,
 * and previous/<STAMP>/ prefixes while protecting public keys, unapproved variants,
 * nested directories, and recent builds.
 *
 * Reference: nextain/naia-shell#744
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED_VARIANTS = new Set(["nvidia", "amd", "amd-server"]);
const BUILD_ID_RE = /^[0-9][0-9A-Za-z._-]*$/;
const STAMP_RE = /^[0-9]{8}T[0-9]{6}Z$/;

/**
 * Normalizes an ETag by trimming whitespace and removing surrounding double quotes.
 * Returns null if not a valid non-empty string.
 *
 * @param {any} raw
 * @returns {string|null}
 */
export function normalizeEtag(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const unquoted = trimmed.replace(/^"|"$/g, "");
  return unquoted.length > 0 ? unquoted : null;
}

/**
 * Calculates ISO candidate prune plan.
 *
 * @param {Array<{ key?: string, Key?: string, size?: number, Size?: number, lastModified?: string|Date, LastModified?: string|Date, etag?: string, ETag?: string, Etag?: string }>} objects
 * @param {string|Date} [now=new Date()]
 * @param {{ keepPerGroup?: number, minAgeDays?: number, maxDelete?: number }} [opts={}]
 * @returns {{
 *   delete: Array<{ prefix: string, group: string, builtAt: string, bytes: number, keys: string[], objects: Array<{ key: string, size: number, lastModified: string, etag: string }> }>,
 *   keep: Array<{ prefix: string, group: string, builtAt: string, bytes: number, keys: string[], objects: Array<{ key: string, size: number, lastModified: string, etag: string }>, reason?: string }>,
 *   skipped: Array<{ prefix?: string, key?: string, reason: string }>,
 *   totalDeleteBytes: number,
 *   truncated: boolean
 * }}
 */
export function planIsoPrune(objects, now = new Date(), opts = {}) {
  const keepPerGroup = opts.keepPerGroup ?? 2;
  const minAgeDays = opts.minAgeDays ?? 3;
  const maxDelete = opts.maxDelete ?? 10;

  const nowMs = new Date(now).getTime();
  if (Number.isNaN(nowMs)) {
    throw new Error(`Invalid now timestamp: ${now}`);
  }
  const minAgeMs = minAgeDays * 24 * 60 * 60 * 1000;
  const cutoffMs = nowMs - minAgeMs;

  if (!Array.isArray(objects) || objects.length === 0) {
    return {
      delete: [],
      keep: [],
      skipped: [],
      totalDeleteBytes: 0,
      truncated: false,
    };
  }

  // Map of candidate prefix -> { prefix, group, objects: [{ key, size, lastModifiedMs, etag }] }
  const prefixMap = new Map();
  // Map of prefix -> reason (for prefixes that contain deeper subkeys)
  const deeperPrefixes = new Map();
  // Map of prefix -> reason (for prefixes that have invalid/missing timestamp)
  const invalidTimestampPrefixes = new Map();
  // Map of prefix -> reason (for prefixes that have missing/empty ETag)
  const missingEtagPrefixes = new Map();
  // List of skipped items
  const skippedEntries = [];

  for (const item of objects) {
    if (!item) continue;
    const key = item.Key ?? item.key;
    if (typeof key !== "string" || !key) continue;

    const size = Number(item.Size ?? item.size ?? 0);
    const rawLm = item.LastModified ?? item.lastModified;
    let lastModifiedMs = NaN;
    if (rawLm) {
      const parsed = new Date(rawLm).getTime();
      if (!Number.isNaN(parsed)) {
        lastModifiedMs = parsed;
      }
    }

    const rawEtag = item.ETag ?? item.etag ?? item.Etag;
    const etag = normalizeEtag(rawEtag);

    // 1. Check builds/ hierarchy
    if (key.startsWith("builds/")) {
      const rest = key.slice(7); // after "builds/"
      const parts = rest.split("/");

      if (parts.length < 2) {
        // Files directly under builds/ (e.g. builds/something.iso) are ignored
        continue;
      }

      // Case 1A: Legacy format without variant: builds/<buildId>/<file>
      if (BUILD_ID_RE.test(parts[0])) {
        const buildId = parts[0];
        const prefix = `builds/${buildId}/`;
        const group = "nvidia";

        if (parts.length > 2) {
          // Has deeper subkey (more than one level below prefix)
          deeperPrefixes.set(prefix, "Contains deeper subkeys");
        } else if (Number.isNaN(lastModifiedMs)) {
          invalidTimestampPrefixes.set(prefix, "invalid-timestamp");
        } else if (!etag) {
          missingEtagPrefixes.set(prefix, "missing-etag");
        } else {
          let entry = prefixMap.get(prefix);
          if (!entry) {
            entry = { prefix, group, objects: [] };
            prefixMap.set(prefix, entry);
          }
          entry.objects.push({ key, size, lastModifiedMs, etag });
        }
        continue;
      }

      // Case 1B: Variant format: builds/<variant>/<buildId>/<file>
      if (ALLOWED_VARIANTS.has(parts[0])) {
        const variant = parts[0];
        if (parts.length < 3) {
          // File directly under variant without buildId (e.g. builds/nvidia/readme.txt)
          continue;
        }

        const buildId = parts[1];
        if (!BUILD_ID_RE.test(buildId)) {
          // Malformed build ID (does not match ^[0-9][0-9A-Za-z._-]*$)
          continue;
        }

        const prefix = `builds/${variant}/${buildId}/`;
        const group = variant;

        if (parts.length > 3) {
          // Has deeper subkey
          deeperPrefixes.set(prefix, "Contains deeper subkeys");
        } else if (Number.isNaN(lastModifiedMs)) {
          invalidTimestampPrefixes.set(prefix, "invalid-timestamp");
        } else if (!etag) {
          missingEtagPrefixes.set(prefix, "missing-etag");
        } else {
          let entry = prefixMap.get(prefix);
          if (!entry) {
            entry = { prefix, group, objects: [] };
            prefixMap.set(prefix, entry);
          }
          entry.objects.push({ key, size, lastModifiedMs, etag });
        }
        continue;
      }

      // Case 1C: Variant name not in whitelist (e.g. builds/foo/0.1/x.iso)
      const invalidVariant = parts[0];
      const prefix = parts.length >= 2 ? `builds/${parts[0]}/${parts[1]}/` : `builds/${parts[0]}/`;
      skippedEntries.push({
        prefix,
        key,
        reason: `Disallowed variant '${invalidVariant}'`,
      });
      continue;
    }

    // 2. Check previous/ hierarchy
    if (key.startsWith("previous/")) {
      const rest = key.slice(9); // after "previous/"
      const parts = rest.split("/");

      if (parts.length < 2) {
        // Directly under previous/ (e.g. previous/naia-os-live-amd64.iso) -> NEVER a candidate
        continue;
      }

      const stamp = parts[0];
      if (STAMP_RE.test(stamp)) {
        const prefix = `previous/${stamp}/`;
        const group = "previous";

        if (parts.length > 2) {
          // Has deeper subkey
          deeperPrefixes.set(prefix, "Contains deeper subkeys");
        } else if (Number.isNaN(lastModifiedMs)) {
          invalidTimestampPrefixes.set(prefix, "invalid-timestamp");
        } else if (!etag) {
          missingEtagPrefixes.set(prefix, "missing-etag");
        } else {
          let entry = prefixMap.get(prefix);
          if (!entry) {
            entry = { prefix, group, objects: [] };
            prefixMap.set(prefix, entry);
          }
          entry.objects.push({ key, size, lastModifiedMs, etag });
        }
        continue;
      }

      // Stamp does not match regex -> ignore
      continue;
    }

    // 3. Other keys (public download keys, logos/, private-transfer/, stats-reports/, etc.)
    // Out of scope -> ignore completely
  }

  // Remove any prefixes marked with deeper subkeys and move them to skipped
  for (const [prefix, reason] of deeperPrefixes.entries()) {
    prefixMap.delete(prefix);
    skippedEntries.push({ prefix, reason });
  }

  // Remove any prefixes marked with invalid timestamps and move them to skipped
  for (const [prefix, reason] of invalidTimestampPrefixes.entries()) {
    prefixMap.delete(prefix);
    if (!deeperPrefixes.has(prefix)) {
      skippedEntries.push({ prefix, reason });
    }
  }

  // Remove any prefixes marked with missing/empty ETag and move them to skipped
  for (const [prefix, reason] of missingEtagPrefixes.entries()) {
    prefixMap.delete(prefix);
    if (!deeperPrefixes.has(prefix) && !invalidTimestampPrefixes.has(prefix)) {
      skippedEntries.push({ prefix, reason });
    }
  }

  // Group candidate prefixes by group
  const groupCandidates = new Map();
  for (const entry of prefixMap.values()) {
    let list = groupCandidates.get(entry.group);
    if (!list) {
      list = [];
      groupCandidates.set(entry.group, list);
    }

    let maxLm = 0;
    let totalBytes = 0;
    const objList = [];
    for (const o of entry.objects) {
      if (o.lastModifiedMs > maxLm) maxLm = o.lastModifiedMs;
      totalBytes += o.size;
      objList.push({
        key: o.key,
        size: o.size,
        lastModified: new Date(o.lastModifiedMs).toISOString(),
        etag: o.etag,
      });
    }
    objList.sort((a, b) => a.key.localeCompare(b.key));
    const keys = objList.map((o) => o.key);

    list.push({
      prefix: entry.prefix,
      group: entry.group,
      builtAt: new Date(maxLm).toISOString(),
      builtAtMs: maxLm,
      bytes: totalBytes,
      keys,
      objects: objList,
    });
  }

  const keepList = [];
  const deleteCandidates = [];

  // Evaluate retention for each group
  for (const [, prefixes] of groupCandidates.entries()) {
    // Sort descending by builtAtMs (newest first). Tie-break by prefix.
    prefixes.sort((a, b) => b.builtAtMs - a.builtAtMs || a.prefix.localeCompare(b.prefix));

    for (let i = 0; i < prefixes.length; i++) {
      const p = prefixes[i];
      const isLatestN = i < keepPerGroup;
      // Strict comparison: must be strictly newer than cutoffMs to be retained as < minAgeDays
      const isRecent = p.builtAtMs > cutoffMs;

      if (isLatestN || isRecent) {
        keepList.push({
          prefix: p.prefix,
          group: p.group,
          builtAt: p.builtAt,
          bytes: p.bytes,
          keys: p.keys,
          objects: p.objects,
          reason: isLatestN ? `Latest ${keepPerGroup} in group` : `Created within ${minAgeDays} days`,
        });
      } else {
        deleteCandidates.push({
          prefix: p.prefix,
          group: p.group,
          builtAt: p.builtAt,
          builtAtMs: p.builtAtMs,
          bytes: p.bytes,
          keys: p.keys,
          objects: p.objects,
        });
      }
    }
  }

  // Sort delete candidates ascending by builtAtMs (oldest first). Tie-break by prefix.
  deleteCandidates.sort((a, b) => a.builtAtMs - b.builtAtMs || a.prefix.localeCompare(b.prefix));

  let truncated = false;
  let deleteList = [];

  if (deleteCandidates.length > maxDelete) {
    truncated = true;
    deleteList = deleteCandidates.slice(0, maxDelete).map(({ prefix, group, builtAt, bytes, keys, objects }) => ({
      prefix,
      group,
      builtAt,
      bytes,
      keys,
      objects,
    }));

    for (const d of deleteCandidates.slice(maxDelete)) {
      keepList.push({
        prefix: d.prefix,
        group: d.group,
        builtAt: d.builtAt,
        bytes: d.bytes,
        keys: d.keys,
        objects: d.objects,
        reason: "Deferred due to maxDelete limit",
      });
    }
  } else {
    deleteList = deleteCandidates.map(({ prefix, group, builtAt, bytes, keys, objects }) => ({
      prefix,
      group,
      builtAt,
      bytes,
      keys,
      objects,
    }));
  }

  const totalDeleteBytes = deleteList.reduce((sum, item) => sum + item.bytes, 0);

  // Sort keepList deterministically
  keepList.sort((a, b) => a.group.localeCompare(b.group) || b.builtAt.localeCompare(a.builtAt));

  return {
    delete: deleteList,
    keep: keepList,
    skipped: skippedEntries,
    totalDeleteBytes,
    truncated,
  };
}

/**
 * CLI runner function.
 *
 * @param {string[]} [args=process.argv.slice(2)]
 * @param {{ exit?: Function, log?: Function, error?: Function }} [io]
 */
export function runCli(args = process.argv.slice(2), io = { exit: process.exit, log: console.log, error: console.error }) {
  let listingPath = null;
  let now = new Date();
  let maxDelete = 10;
  let prefixesOutPath = null;
  let planOutPath = null;
  let keepPerGroup = 2;
  let minAgeDays = 3;

  const exitFailure = (msg) => {
    io.error(msg);
    if (typeof io.exit === "function") {
      io.exit(1);
    }
    throw new Error(msg);
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--listing") {
      if (i + 1 >= args.length) exitFailure("Error: --listing requires a file path");
      listingPath = args[++i];
    } else if (arg === "--now") {
      if (i + 1 >= args.length) exitFailure("Error: --now requires a timestamp value");
      const val = args[++i];
      if (Number.isNaN(new Date(val).getTime())) {
        exitFailure(`Error: --now must be a valid date/timestamp (got '${val}')`);
      }
      now = val;
    } else if (arg === "--max-delete") {
      if (i + 1 >= args.length) exitFailure("Error: --max-delete requires a number value");
      const val = args[++i];
      if (!/^[0-9]+$/.test(val) || parseInt(val, 10) < 1) {
        exitFailure(`Error: --max-delete must be an integer >= 1 (got '${val}')`);
      }
      maxDelete = parseInt(val, 10);
    } else if (arg === "--prefixes-out") {
      if (i + 1 >= args.length) exitFailure("Error: --prefixes-out requires a file path");
      prefixesOutPath = args[++i];
    } else if (arg === "--plan-out") {
      if (i + 1 >= args.length) exitFailure("Error: --plan-out requires a file path");
      planOutPath = args[++i];
    } else if (arg === "--keep-per-group") {
      if (i + 1 >= args.length) exitFailure("Error: --keep-per-group requires a number value");
      const val = args[++i];
      if (!/^[0-9]+$/.test(val) || parseInt(val, 10) < 0) {
        exitFailure(`Error: --keep-per-group must be an integer >= 0 (got '${val}')`);
      }
      keepPerGroup = parseInt(val, 10);
    } else if (arg === "--min-age-days") {
      if (i + 1 >= args.length) exitFailure("Error: --min-age-days requires a number value");
      const val = args[++i];
      const parsed = Number(val);
      if (Number.isNaN(parsed) || parsed < 0) {
        exitFailure(`Error: --min-age-days must be a non-negative number (got '${val}')`);
      }
      minAgeDays = parsed;
    } else {
      exitFailure(`Error: Unknown argument '${arg}'`);
    }
  }

  if (!listingPath) {
    exitFailure("Error: --listing <file.json> is required");
  }

  let items = [];
  let raw;
  try {
    raw = readFileSync(listingPath, "utf-8");
  } catch (err) {
    exitFailure(`Error: Failed to read listing file '${listingPath}': ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    exitFailure(`Error: Failed to parse listing JSON from '${listingPath}': ${err.message}`);
  }

  if (Array.isArray(parsed)) {
    items = parsed.flatMap((x) => x?.Contents || (x?.Key || x?.key ? [x] : []));
  } else if (parsed && typeof parsed === "object") {
    items = parsed.Contents || [];
  } else {
    exitFailure(`Error: Invalid listing format in '${listingPath}'`);
  }

  if (!items || items.length === 0) {
    io.error("Warning: Listing contains no Contents");
    const emptyPlan = {
      delete: [],
      keep: [],
      skipped: [],
      totalDeleteBytes: 0,
      truncated: false,
    };
    if (prefixesOutPath) {
      writeFileSync(prefixesOutPath, "", "utf-8");
    }
    if (planOutPath) {
      writeFileSync(planOutPath, JSON.stringify(emptyPlan, null, 2), "utf-8");
    }
    io.log(JSON.stringify(emptyPlan, null, 2));
    return emptyPlan;
  }

  let plan;
  try {
    plan = planIsoPrune(items, now, { keepPerGroup, minAgeDays, maxDelete });
  } catch (err) {
    exitFailure(`Error: ${err.message}`);
  }

  if (prefixesOutPath) {
    const lines = plan.delete.map((d) => d.prefix).join("\n");
    writeFileSync(prefixesOutPath, lines ? lines + "\n" : "", "utf-8");
  }

  if (planOutPath) {
    writeFileSync(planOutPath, JSON.stringify(plan, null, 2), "utf-8");
  }

  io.log(JSON.stringify(plan, null, 2));
  return plan;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runCli();
}
