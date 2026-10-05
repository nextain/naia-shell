/**
 * scripts/r2-iso-prune-helper.mjs
 *
 * Workflow helper script for R2 naia-releases ISO prune.
 * Handles active workflow run checks, paginated S3 listing with truncation validation,
 * planned summary rendering, in-memory target validation with per-key ETag verification,
 * single-object deletion, and JSON Lines execution result reporting.
 *
 * Reference: nextain/naia-shell#744
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { normalizeEtag, planIsoPrune } from "./r2-iso-prune.mjs";

export const ALLOWED_BUCKET = "naia-releases";

export const TARGET_WORKFLOWS = [
  { file: "naia-os-iso-promote.yml", reason: "promote-active" },
  { file: "naia-os-iso.yml", reason: "iso-build-active" },
];

export const UNCOMPLETED_STATUSES = [
  "queued",
  "in_progress",
  "waiting",
  "requested",
  "pending",
];

export const VALID_BUILD_RE = /^builds\/((nvidia|amd|amd-server)\/)?[0-9][0-9A-Za-z._-]*\/$/;
export const VALID_PREV_RE = /^previous\/[0-9]{8}T[0-9]{6}Z\/$/;
export const GLOB_CHARS = /[*?[\]]/;

/**
 * Sanitized command executor. Does NOT include raw stderr or sensitive args in thrown error.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts={}]
 * @returns {string}
 */
export function safeExec(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      ...opts,
    });
  } catch (err) {
    const exitCode = typeof err.status === "number" ? err.status : (err.code || 1);
    const sub = args[0] ? ` ${args[0]}` : "";
    throw new Error(`${cmd}${sub} failed (exit ${exitCode})`);
  }
}

/**
 * Exhaustively checks whether any target workflow has uncompleted runs.
 *
 * @param {object} [opts={}]
 * @param {(cmd: string, args: string[]) => string} [opts.execFn=safeExec]
 * @returns {{ active: boolean, reason?: string, error?: string }}
 */
export function checkActiveWorkflows(opts = {}) {
  const execFn = opts.execFn || safeExec;

  for (const wf of TARGET_WORKFLOWS) {
    for (const status of UNCOMPLETED_STATUSES) {
      let stdout;
      try {
        stdout = execFn("gh", [
          "run",
          "list",
          "--workflow",
          wf.file,
          "--status",
          status,
          "--limit",
          "100",
          "--json",
          "databaseId",
        ]);
      } catch (err) {
        return {
          active: true,
          reason: "gh-error",
          error: err.message,
        };
      }

      let runs;
      try {
        runs = JSON.parse(stdout);
      } catch {
        return {
          active: true,
          reason: "gh-error",
          error: "gh run list output JSON parse failed",
        };
      }

      if (!Array.isArray(runs)) {
        return {
          active: true,
          reason: "gh-error",
          error: "gh run list output not an array",
        };
      }

      // If any run is found (including saturation at 100 runs)
      if (runs.length > 0) {
        return {
          active: true,
          reason: wf.reason,
        };
      }
    }
  }

  return { active: false };
}

/**
 * Lists S3 objects for a bucket and prefix using direct manual pagination without AWS CLI auto-pagination.
 * Validates IsTruncated, NextContinuationToken, and Contents presence.
 *
 * @param {{ bucket: string, prefix: string, maxPages?: number }} options
 * @param {(cmd: string, args: string[]) => string} [execFn=safeExec]
 * @returns {Array<{ Key: string, Size: number, LastModified: string, ETag: string }>}
 */
export function listObjectsV2Pages(options, execFn = safeExec) {
  const { bucket, prefix, maxPages = 100 } = options;
  if (!bucket || typeof prefix !== "string") {
    throw new Error("bucket and prefix are required");
  }

  let continuationToken = null;
  let pageCount = 0;
  const allContents = [];

  while (true) {
    pageCount++;
    if (pageCount > maxPages) {
      throw new Error(`list-objects-v2 exceeded maximum allowed pages (${maxPages})`);
    }

    const args = [
      "s3api",
      "list-objects-v2",
      "--bucket",
      bucket,
      "--prefix",
      prefix,
      "--no-paginate",
      "--max-keys",
      "1000",
      "--output",
      "json",
    ];

    if (continuationToken) {
      args.push("--continuation-token", continuationToken);
    }

    const stdout = execFn("aws", args);
    let page;
    try {
      page = JSON.parse(stdout);
    } catch {
      throw new Error(`Failed to parse list-objects-v2 JSON on page ${pageCount}`);
    }

    if (!page || typeof page !== "object") {
      throw new Error(`Invalid list-objects-v2 response object on page ${pageCount}`);
    }

    if (typeof page.IsTruncated !== "boolean") {
      throw new Error(`list-objects-v2 response IsTruncated must be a boolean on page ${pageCount}`);
    }

    if (typeof page.KeyCount !== "number" || !Number.isInteger(page.KeyCount) || page.KeyCount < 0) {
      throw new Error(`list-objects-v2 response KeyCount must be a non-negative integer on page ${pageCount}`);
    }

    if (page.Contents !== undefined && page.Contents !== null) {
      if (!Array.isArray(page.Contents) || page.Contents.length !== page.KeyCount) {
        throw new Error(`list-objects-v2 Contents length must match KeyCount on page ${pageCount}`);
      }
    } else {
      if (page.KeyCount !== 0) {
        throw new Error(`list-objects-v2 Contents missing with non-zero KeyCount on page ${pageCount}`);
      }
    }

    if (Array.isArray(page.Contents)) {
      for (const item of page.Contents) {
        if (!item || typeof item !== "object") {
          throw new Error(`list-objects-v2 item is not an object on page ${pageCount}`);
        }
        if (typeof item.Key !== "string" || item.Key.length === 0) {
          throw new Error(`list-objects-v2 item Key must be a non-empty string on page ${pageCount}`);
        }
        if (typeof item.Size !== "number" || !Number.isInteger(item.Size) || item.Size < 0) {
          throw new Error(`list-objects-v2 item Size must be a non-negative integer on page ${pageCount}`);
        }
        if (typeof item.LastModified !== "string" || item.LastModified.length === 0) {
          throw new Error(`list-objects-v2 item LastModified must be a non-empty string on page ${pageCount}`);
        }
        if (typeof item.ETag !== "string" || item.ETag.trim().length === 0) {
          throw new Error(`list-objects-v2 item ETag must be a non-empty string on page ${pageCount}`);
        }
      }
      allContents.push(...page.Contents);
    }

    if (page.IsTruncated) {
      const nextToken = page.NextContinuationToken;
      if (!nextToken || typeof nextToken !== "string") {
        throw new Error(`list-objects-v2 response is truncated but NextContinuationToken is missing on page ${pageCount}`);
      }
      continuationToken = nextToken;
    } else {
      break;
    }
  }

  return allContents;
}

/**
 * Fetches builds/ and previous/ listings, merges them, and saves to a file.
 *
 * @param {{ bucket: string, outFile: string }} options
 * @param {(cmd: string, args: string[]) => string} [execFn=safeExec]
 * @returns {Array<object>}
 */
export function fetchListing(options, execFn = safeExec) {
  const { bucket, outFile } = options;
  const buildsContents = listObjectsV2Pages({ bucket, prefix: "builds/" }, execFn);
  const previousContents = listObjectsV2Pages({ bucket, prefix: "previous/" }, execFn);
  const allContents = [...buildsContents, ...previousContents];

  if (outFile) {
    writeFileSync(outFile, JSON.stringify({ Contents: allContents }, null, 2), "utf-8");
  }

  return allContents;
}

/**
 * Compares current objects in a prefix against the planned objects.
 * Verifies exact keys, unquoted ETags, sizes, LastModified timestamps, and prefix containment.
 *
 * @param {Array<{ key: string, size: number, lastModified: string, etag: string }>} plannedObjects
 * @param {Array<{ Key: string, Size: number, LastModified: string, ETag: string }>} currentContents
 * @param {string} prefix
 * @returns {{ match: boolean, reason?: string }}
 */
export function comparePrefixObjects(plannedObjects, currentContents, prefix) {
  if (!Array.isArray(plannedObjects) || !Array.isArray(currentContents)) {
    return { match: false, reason: "changed-since-plan" };
  }

  if (plannedObjects.length !== currentContents.length) {
    return { match: false, reason: "changed-since-plan" };
  }

  const currentMap = new Map();
  for (const c of currentContents) {
    if (!c || typeof c.Key !== "string") {
      return { match: false, reason: "changed-since-plan" };
    }
    if (!c.Key.startsWith(prefix)) {
      return { match: false, reason: "changed-since-plan" };
    }
    if (currentMap.has(c.Key)) {
      return { match: false, reason: "changed-since-plan" };
    }
    currentMap.set(c.Key, c);
  }

  for (const p of plannedObjects) {
    if (!p || typeof p.key !== "string" || !p.key.startsWith(prefix)) {
      return { match: false, reason: "changed-since-plan" };
    }

    const curr = currentMap.get(p.key);
    if (!curr) {
      return { match: false, reason: "changed-since-plan" };
    }

    if (curr.Size !== p.size) {
      return { match: false, reason: "changed-since-plan" };
    }

    const currEtag = normalizeEtag(curr.ETag);
    if (currEtag !== p.etag) {
      return { match: false, reason: "changed-since-plan" };
    }

    const currTime = new Date(curr.LastModified).getTime();
    const plannedTime = new Date(p.lastModified).getTime();
    if (currTime !== plannedTime) {
      return { match: false, reason: "changed-since-plan" };
    }
  }

  return { match: true };
}

/**
 * Deletes a single S3 object by key, ensuring it strictly begins with prefix.
 *
 * @param {string} bucket
 * @param {string} key
 * @param {string} prefix
 * @param {(cmd: string, args: string[]) => string} [execFn=safeExec]
 */
export function deleteObjectKey(bucket, key, prefix, execFn = safeExec) {
  if (bucket !== ALLOWED_BUCKET) {
    throw new Error(`Bucket '${bucket}' is not allowed for deletion (must be '${ALLOWED_BUCKET}')`);
  }
  if (typeof key !== "string" || !key.startsWith(prefix)) {
    throw new Error(`Key '${key}' does not start with prefix '${prefix}'`);
  }

  execFn("aws", [
    "s3api",
    "delete-object",
    "--bucket",
    bucket,
    "--key",
    key,
  ]);
}

/**
 * Appends JSON Lines result entries to a result file.
 */
export class ResultRecorder {
  constructor(filePath) {
    this.filePath = filePath;
    this.statusWritten = false;
  }

  init(mode, status = "running", reason = "") {
    this.statusWritten = false;
    if (this.filePath) {
      const line = JSON.stringify({ type: "header", mode, status, reason }) + "\n";
      writeFileSync(this.filePath, line, "utf-8");
    }
  }

  writeStatus(status, reason = "") {
    if (this.statusWritten) {
      return;
    }
    if (this.filePath) {
      if (existsSync(this.filePath)) {
        try {
          const content = readFileSync(this.filePath, "utf-8");
          for (const rawLine of content.split("\n")) {
            const trimmed = rawLine.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed);
              if (parsed && parsed.type === "status") {
                this.statusWritten = true;
                return;
              }
            } catch {}
          }
        } catch {}
      }
      const line = JSON.stringify({ type: "status", status, reason }) + "\n";
      appendFileSync(this.filePath, line, "utf-8");
      this.statusWritten = true;
    }
  }

  startPrefix(prefix, group, bytes = 0) {
    if (this.filePath) {
      const line = JSON.stringify({ type: "prefix-start", prefix, group, bytes }) + "\n";
      appendFileSync(this.filePath, line, "utf-8");
    }
  }

  finishPrefix(prefix, group, result, reason = "", bytes = 0, deletedKeys = undefined, totalKeys = undefined) {
    if (this.filePath) {
      const entry = { type: "prefix-result", prefix, group, result, reason, bytes };
      if (typeof deletedKeys === "number") entry.deletedKeys = deletedKeys;
      if (typeof totalKeys === "number") entry.totalKeys = totalKeys;
      const line = JSON.stringify(entry) + "\n";
      appendFileSync(this.filePath, line, "utf-8");
    }
  }
}

/**
 * Reads a JSON Lines result file and reconstructs execution summary.
 * If the file does not exist, returns status 'aborted' with reason 'missing-result'.
 *
 * @param {string} filePath
 * @returns {object}
 */
export function parseResultJsonlFile(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return {
      mode: "unknown",
      status: "aborted",
      reason: "missing-result",
      deleted: [],
      totalDeletedBytes: 0,
      skipped: [],
      failed: [],
      unknown: [],
    };
  }
  const content = readFileSync(filePath, "utf-8");
  return parseResultJsonl(content);
}

/**
 * Parses a JSON Lines result content string and reconstructs execution summary.
 * If an active prefix-start exists without a matching prefix-result, it is marked as unknown.
 *
 * @param {string} content
 * @returns {{
 *   mode: string,
 *   status: string,
 *   reason: string,
 *   deleted: Array<{ prefix: string, group: string, bytes: number }>,
 *   totalDeletedBytes: number,
 *   skipped: Array<{ prefix: string, group: string, reason: string, bytes: number }>,
 *   failed: Array<{ prefix: string, group: string, reason: string, bytes: number, deletedKeys?: number, totalKeys?: number, partial?: boolean }>,
 *   unknown: Array<{ prefix: string, group: string, bytes: number }>
 * }}
 */
export function parseResultJsonl(content) {
  const rawLines = typeof content === "string" ? content.split("\n") : [];
  const nonEmptyLines = rawLines.map((l) => l.trim()).filter((l) => l.length > 0);

  if (nonEmptyLines.length === 0) {
    return {
      mode: "unknown",
      status: "aborted",
      reason: "missing-result",
      deleted: [],
      totalDeletedBytes: 0,
      skipped: [],
      failed: [],
      unknown: [],
    };
  }

  let mode = "unknown";
  let hasValidHeader = false;
  let hasInvalidLine = false;
  let explicitStatus = null;
  let statusReason = "";

  const deleted = [];
  const skipped = [];
  const failed = [];
  const unknown = [];
  let totalDeletedBytes = 0;
  let activeStart = null;

  for (let i = 0; i < nonEmptyLines.length; i++) {
    const rawLine = nonEmptyLines[i];
    let entry;
    try {
      entry = JSON.parse(rawLine);
    } catch {
      hasInvalidLine = true;
      continue;
    }

    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      hasInvalidLine = true;
      continue;
    }

    if (i === 0) {
      if (entry.type === "header" && (entry.mode === "dry-run" || entry.mode === "live")) {
        hasValidHeader = true;
        mode = entry.mode;
        if (entry.status && entry.status !== "running") {
          explicitStatus = entry.status;
        }
        if (entry.reason) {
          statusReason = entry.reason;
        }
        continue;
      } else {
        hasInvalidLine = true;
      }
    } else {
      if (entry.type === "header") {
        continue;
      }
    }

    if (entry.type === "status") {
      if (!explicitStatus) {
        explicitStatus = entry.status;
        if (entry.reason) {
          statusReason = entry.reason;
        }
      }
    } else if (entry.type === "prefix-start") {
      if (activeStart) {
        unknown.push(activeStart);
      }
      activeStart = {
        prefix: entry.prefix,
        group: entry.group,
        bytes: entry.bytes || 0,
      };
    } else if (entry.type === "prefix-result") {
      if (activeStart && activeStart.prefix === entry.prefix) {
        activeStart = null;
      }

      if (entry.result === "deleted") {
        deleted.push({
          prefix: entry.prefix,
          group: entry.group,
          bytes: entry.bytes || 0,
        });
        totalDeletedBytes += (entry.bytes || 0);
      } else if (entry.result === "skipped") {
        skipped.push({
          prefix: entry.prefix,
          group: entry.group,
          reason: entry.reason || "",
          bytes: entry.bytes || 0,
        });
      } else if (entry.result === "failed") {
        failed.push({
          prefix: entry.prefix,
          group: entry.group,
          reason: entry.reason || "",
          bytes: entry.bytes || 0,
          deletedKeys: entry.deletedKeys,
          totalKeys: entry.totalKeys,
          partial: false,
        });
      } else if (entry.result === "partial-failed") {
        failed.push({
          prefix: entry.prefix,
          group: entry.group,
          reason: entry.reason || "",
          bytes: entry.bytes || 0,
          deletedKeys: entry.deletedKeys,
          totalKeys: entry.totalKeys,
          partial: true,
        });
        totalDeletedBytes += (entry.bytes || 0);
      }
    }
  }

  if (activeStart) {
    unknown.push(activeStart);
  }

  let finalStatus;
  let finalReason;

  if (!hasValidHeader || hasInvalidLine) {
    finalStatus = "aborted";
    finalReason = "invalid-result";
    if (!hasValidHeader) {
      mode = "unknown";
    }
  } else {
    finalStatus = explicitStatus;
    finalReason = statusReason;

    if (!finalStatus) {
      finalStatus = "aborted";
      if (unknown.length > 0) {
        finalReason = "Workflow was interrupted during prefix deletion";
      } else {
        finalReason = "interrupted";
      }
    }
  }

  return {
    mode,
    status: finalStatus,
    reason: finalReason,
    deleted,
    totalDeletedBytes,
    skipped,
    failed,
    unknown,
  };
}

/**
 * Renders Markdown for the planned retention step.
 *
 * @param {object} plan
 * @param {object} options
 * @returns {string}
 */
export function renderPlanMarkdown(plan, options = {}) {
  const { dryRun, maxDelete, modeNote, ref } = options;

  let md = "## Naia OS ISO Prune: Planned Retention\n\n";
  md += `- **Execution Mode:** ${dryRun ? "🔍 Dry Run (No objects deleted)" : "⚠️ LIVE RUN (deletion follows)"}\n`;
  if (ref) {
    md += `- **Branch / Ref:** \`${ref}\`\n`;
  }
  if (modeNote) {
    md += `- **Mode Note:** ${modeNote}\n`;
  }
  md += `- **Max Delete Limit:** ${maxDelete}\n`;
  md += `- **Truncated:** ${plan.truncated ? "Yes (more deletion candidates exist)" : "No"}\n`;
  md += `- **Total Deletion Candidates:** ${plan.delete.length}\n`;
  md += `- **Total Reclaimed Space:** ${(plan.totalDeleteBytes / 1e9).toFixed(2)} GB (${plan.totalDeleteBytes.toLocaleString()} bytes)\n\n`;

  md += "### Deletion Candidates\n\n";
  if (!plan.delete || plan.delete.length === 0) {
    md += "_No candidate prefixes marked for deletion._\n\n";
  } else {
    md += "| Prefix | Group | Built At | Size (GB) |\n";
    md += "|---|---|---|---|\n";
    for (const d of plan.delete) {
      md += `| \`${d.prefix}\` | ${d.group} | ${d.builtAt} | ${(d.bytes / 1e9).toFixed(2)} GB |\n`;
    }
    md += "\n";
  }

  md += "### Retained Prefixes\n\n";
  if (!plan.keep || plan.keep.length === 0) {
    md += "_No candidate prefixes retained._\n\n";
  } else {
    md += "| Prefix | Group | Built At | Size (GB) | Reason |\n";
    md += "|---|---|---|---|---|\n";
    for (const k of plan.keep) {
      md += `| \`${k.prefix}\` | ${k.group} | ${k.builtAt} | ${(k.bytes / 1e9).toFixed(2)} GB | ${k.reason || "retained"} |\n`;
    }
    md += "\n";
  }

  if (plan.skipped && plan.skipped.length > 0) {
    md += "### Skipped Keys / Prefixes\n\n";
    md += "| Key / Prefix | Reason |\n";
    md += "|---|---|\n";
    for (const s of plan.skipped) {
      md += `| \`${s.prefix || s.key}\` | ${s.reason} |\n`;
    }
    md += "\n";
  }

  return md;
}

/**
 * Renders Markdown for the execution result step from parsed JSON Lines data.
 *
 * @param {object} result
 * @returns {string}
 */
export function renderResultMarkdown(result) {
  let md = "\n\n## Naia OS ISO Prune: Execution Result\n\n";
  md += `- **Execution Status:** \`${result.status || "aborted"}\`\n`;
  md += `- **Mode:** \`${result.mode || "unknown"}\`\n`;
  if (result.reason) {
    md += `- **Status Reason:** ${result.reason}\n`;
  }
  md += `- **Actually Deleted Prefixes:** ${(result.deleted || []).length}\n`;
  md += `- **Total Reclaimed Space:** ${(((result.totalDeletedBytes || 0) / 1e9).toFixed(2))} GB (${(result.totalDeletedBytes || 0).toLocaleString()} bytes)\n\n`;

  md += "### Deleted Prefixes\n\n";
  if (!result.deleted || result.deleted.length === 0) {
    md += "_No prefixes were deleted._\n\n";
  } else {
    md += "| Prefix | Group | Size (GB) |\n";
    md += "|---|---|---|\n";
    for (const d of result.deleted) {
      md += `| \`${d.prefix}\` | ${d.group || "-"} | ${((d.bytes || 0) / 1e9).toFixed(2)} GB |\n`;
    }
    md += "\n";
  }

  if (result.skipped && result.skipped.length > 0) {
    md += "### Skipped During Execution\n\n";
    md += "| Prefix | Group | Reason |\n";
    md += "|---|---|---|\n";
    for (const s of result.skipped) {
      md += `| \`${s.prefix}\` | ${s.group || "-"} | ${s.reason} |\n`;
    }
    md += "\n";
  }

  if (result.failed && result.failed.length > 0) {
    md += "### Failed Deletions\n\n";
    md += "| Prefix | Group | Reason | Reclaimed Space |\n";
    md += "|---|---|---|---|\n";
    for (const f of result.failed) {
      let reclaimedStr = "0.00 GB (0 bytes)";
      if (f.bytes && f.bytes > 0) {
        const gb = (f.bytes / 1e9).toFixed(2);
        const keysPart = f.deletedKeys !== undefined ? `, ${f.deletedKeys}/${f.totalKeys} keys` : "";
        reclaimedStr = `${gb} GB (${f.bytes.toLocaleString()} bytes${keysPart})`;
      }
      md += `| \`${f.prefix}\` | ${f.group || "-"} | ${f.reason} | ${reclaimedStr} |\n`;
    }
    md += "\n";
  }

  if (result.unknown && result.unknown.length > 0) {
    md += "### Unknown State (Interrupted During Deletion)\n\n";
    md += "| Prefix | Group | Size (GB) |\n";
    md += "|---|---|---|\n";
    for (const u of result.unknown) {
      md += `| \`${u.prefix}\` | ${u.group || "-"} | ${((u.bytes || 0) / 1e9).toFixed(2)} GB |\n`;
    }
    md += "\n";
  }

  return md;
}

export const VALUE_FLAGS = [
  "--max-delete",
  "--now",
  "--dry-run",
  "--listing",
  "--out",
  "--plan-out",
  "--result-out",
  "--result-file",
  "--output-env",
  "--summary-file",
  "--mode-note",
  "--ref",
];

/**
 * Scans an argument array for any specified value-requiring flags that lack a value
 * (missing next argument, or next argument starts with '--').
 * Empty string ("") is treated as a present value.
 *
 * @param {string[]} argv
 * @param {string[]} [flags=VALUE_FLAGS]
 * @returns {string|null} The flag that lacks a value, or null if all checked flags have valid values.
 */
export function findMissingValueFlag(argv, flags = VALUE_FLAGS) {
  if (!Array.isArray(argv) || !Array.isArray(flags)) {
    return null;
  }
  const flagSet = new Set(
    flags.map((f) => (typeof f === "string" && f.startsWith("--") ? f : `--${f}`))
  );

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flagSet.has(arg)) {
      if (i + 1 >= argv.length || (typeof argv[i + 1] === "string" && argv[i + 1].startsWith("--"))) {
        return arg;
      }
      i++;
    }
  }
  return null;
}

/**
 * Resolves bucket from command arguments, enforcing ALLOWED_BUCKET ("naia-releases").
 *
 * @param {string[]} rest
 * @returns {{ ok: boolean, bucket?: string, error?: string }}
 */
export function resolveBucketArg(rest) {
  const idx = rest.indexOf("--bucket");
  if (idx === -1) {
    return { ok: true, bucket: ALLOWED_BUCKET };
  }
  if (idx + 1 >= rest.length) {
    return { ok: false, error: "Missing value for --bucket flag" };
  }
  const val = rest[idx + 1];
  if (val !== ALLOWED_BUCKET) {
    return { ok: false, error: `Invalid bucket '${val}' (only '${ALLOWED_BUCKET}' is allowed)` };
  }
  return { ok: true, bucket: val };
}

/**
 * Reads and strictly validates an S3 listing JSON file.
 * Must be a JSON object containing a 'Contents' array.
 *
 * @param {string} listingPath
 * @returns {Array<object>}
 */
export function loadAndValidateListing(listingPath) {
  let raw;
  try {
    raw = readFileSync(listingPath, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read listing file '${listingPath}': ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse listing JSON: ${err.message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid listing shape: root must be a non-null object");
  }

  if (!Array.isArray(parsed.Contents)) {
    throw new Error("Invalid listing shape: 'Contents' must be an array");
  }

  return parsed.Contents;
}

/**
 * Main CLI dispatcher for workflow runner actions.
 *
 * @param {string[]} [args=process.argv.slice(2)]
 */
export function runHelperCli(args = process.argv.slice(2), deps = {}) {
  const exitFn = deps.exit || process.exit;
  const logFn = deps.log || console.log;
  const errorFn = deps.error || console.error;
  const execFn = deps.execFn || safeExec;
  const checkActiveFn = deps.checkActiveFn || (() => checkActiveWorkflows({ execFn }));
  const listPagesFn = deps.listPagesFn || ((opts) => listObjectsV2Pages(opts, execFn));
  const deleteKeyFn = deps.deleteKeyFn || ((b, k, p) => deleteObjectKey(b, k, p, execFn));

  const subcommand = args[0];
  const rest = args.slice(1);

  const getArg = (name) => {
    const idx = rest.indexOf(`--${name}`);
    return idx !== -1 && idx + 1 < rest.length ? rest[idx + 1] : null;
  };

  if (subcommand === "check-active") {
    const missingFlag = findMissingValueFlag(rest, ["--result-out", "--output-env", "--dry-run"]);
    if (missingFlag) {
      errorFn(`Error: Flag '${missingFlag}' requires a value`);
      exitFn(1);
      return;
    }

    const resultOut = getArg("result-out");
    const outputEnv = getArg("output-env");
    const dryRunArg = getArg("dry-run");
    const mode = dryRunArg === "true" ? "dry-run" : "live";

    const recorder = resultOut ? new ResultRecorder(resultOut) : null;
    const res = checkActiveFn();

    if (res.active) {
      if (res.reason === "gh-error") {
        if (recorder) {
          recorder.init(mode, "aborted", "gh-error");
          recorder.writeStatus("aborted", "gh-error");
        }
        errorFn("Failed to check active workflows via gh CLI. Failing closed.");
        exitFn(1);
        return;
      } else {
        if (recorder) {
          recorder.init(mode, "aborted", res.reason);
          recorder.writeStatus("aborted", res.reason);
        }
        if (outputEnv) {
          appendFileSync(outputEnv, "should_skip=true\n");
          appendFileSync(outputEnv, `abort_reason=${res.reason}\n`);
        }
        logFn(`Active workflow detected: ${res.reason}. Skipping deletions.`);
        exitFn(0);
        return;
      }
    } else {
      if (outputEnv) {
        appendFileSync(outputEnv, "should_skip=false\n");
      }
      exitFn(0);
      return;
    }
  } else if (subcommand === "fetch-listing") {
    const missingFlag = findMissingValueFlag(rest, ["--out", "--result-out", "--dry-run"]);
    if (missingFlag) {
      errorFn(`Error: Flag '${missingFlag}' requires a value`);
      exitFn(1);
      return;
    }

    const outFile = getArg("out") || "listing.json";
    const resultOut = getArg("result-out");
    const dryRunArg = getArg("dry-run");
    const mode = dryRunArg === "true" ? "dry-run" : "live";

    const bucketRes = resolveBucketArg(rest);
    if (!bucketRes.ok) {
      if (resultOut) {
        const recorder = new ResultRecorder(resultOut);
        recorder.init(mode, "aborted", "invalid-bucket");
        recorder.writeStatus("aborted", "invalid-bucket");
      }
      errorFn(`fetch-listing failed: ${bucketRes.error}`);
      exitFn(1);
      return;
    }
    const bucket = bucketRes.bucket;

    try {
      fetchListing({ bucket, outFile }, execFn);
      logFn(`Listing fetched successfully into ${outFile}`);
    } catch (err) {
      if (resultOut) {
        const recorder = new ResultRecorder(resultOut);
        recorder.init(mode, "aborted", "listing-failed");
        recorder.writeStatus("aborted", "listing-failed");
      }
      errorFn(`fetch-listing failed: ${err.message}`);
      exitFn(1);
      return;
    }
    exitFn(0);
    return;
  } else if (subcommand === "plan") {
    const missingFlag = findMissingValueFlag(rest, [
      "--listing",
      "--result-out",
      "--max-delete",
      "--dry-run",
      "--mode-note",
      "--ref",
      "--plan-out",
      "--output-env",
      "--summary-file",
      "--now",
    ]);
    if (missingFlag) {
      errorFn(`Error: Flag '${missingFlag}' requires a value`);
      exitFn(1);
      return;
    }

    const listingPath = getArg("listing") || "listing.json";
    const resultOut = getArg("result-out");

    const rawMaxDelete = getArg("max-delete");
    let maxDelete = 10;
    if (rawMaxDelete !== null) {
      if (!/^[0-9]+$/.test(rawMaxDelete) || parseInt(rawMaxDelete, 10) < 1 || parseInt(rawMaxDelete, 10) > 50) {
        errorFn(`Error: --max-delete must be an integer between 1 and 50 (got '${rawMaxDelete}')`);
        exitFn(1);
        return;
      }
      maxDelete = parseInt(rawMaxDelete, 10);
    }

    const rawDryRun = getArg("dry-run");
    if (rawDryRun !== "true" && rawDryRun !== "false") {
      errorFn(`Error: --dry-run must be exactly 'true' or 'false' (got '${rawDryRun}')`);
      exitFn(1);
      return;
    }
    const dryRun = rawDryRun === "true";
    const mode = dryRun ? "dry-run" : "live";

    const modeNote = getArg("mode-note") || "";
    const ref = getArg("ref") || "";
    const planOut = getArg("plan-out") || "plan.json";
    const outputEnv = getArg("output-env");
    const summaryFile = getArg("summary-file");

    let items;
    try {
      items = loadAndValidateListing(listingPath);
    } catch (err) {
      if (resultOut) {
        const recorder = new ResultRecorder(resultOut);
        recorder.init(mode, "aborted", "listing-invalid");
        recorder.writeStatus("aborted", "listing-invalid");
      }
      errorFn(`plan failed to load listing: ${err.message}`);
      exitFn(1);
      return;
    }

    const now = getArg("now") || new Date().toISOString();
    let plan;
    try {
      plan = planIsoPrune(items, now, { maxDelete });
    } catch (err) {
      if (resultOut) {
        const recorder = new ResultRecorder(resultOut);
        recorder.init(mode, "aborted", "plan-failed");
        recorder.writeStatus("aborted", "plan-failed");
      }
      errorFn(`planIsoPrune failed: ${err.message}`);
      exitFn(1);
      return;
    }

    writeFileSync(planOut, JSON.stringify(plan, null, 2), "utf-8");

    if (outputEnv) {
      appendFileSync(outputEnv, `now=${now}\n`);
    }

    if (summaryFile) {
      const md = renderPlanMarkdown(plan, { dryRun, maxDelete, modeNote, ref });
      appendFileSync(summaryFile, md);
    }

    exitFn(0);
    return;
  } else if (subcommand === "execute") {
    const missingFlag = findMissingValueFlag(rest, [
      "--listing",
      "--now",
      "--dry-run",
      "--max-delete",
      "--result-out",
    ]);
    if (missingFlag) {
      errorFn(`Error: Flag '${missingFlag}' requires a value`);
      exitFn(1);
      return;
    }

    const listingPath = getArg("listing") || "listing.json";
    const now = getArg("now");
    if (!now || Number.isNaN(new Date(now).getTime())) {
      errorFn(`Error: --now must be a valid date/timestamp (got '${now}')`);
      exitFn(1);
      return;
    }

    const rawDryRun = getArg("dry-run");
    if (rawDryRun !== "true" && rawDryRun !== "false") {
      errorFn(`Error: --dry-run must be exactly 'true' or 'false' (got '${rawDryRun}')`);
      exitFn(1);
      return;
    }
    const isDryRun = rawDryRun === "true";

    const rawMaxDelete = getArg("max-delete");
    let maxDelete = 10;
    if (rawMaxDelete !== null) {
      if (!/^[0-9]+$/.test(rawMaxDelete) || parseInt(rawMaxDelete, 10) < 1 || parseInt(rawMaxDelete, 10) > 50) {
        errorFn(`Error: --max-delete must be an integer between 1 and 50 (got '${rawMaxDelete}')`);
        exitFn(1);
        return;
      }
      maxDelete = parseInt(rawMaxDelete, 10);
    }

    const resultOut = getArg("result-out") || "prune-result.jsonl";

    const recorder = new ResultRecorder(resultOut);
    recorder.init(isDryRun ? "dry-run" : "live", "running", "");

    // P1: Check bucket after dry-run validation and recorder.init
    const bucketRes = resolveBucketArg(rest);
    if (!bucketRes.ok) {
      recorder.writeStatus("aborted", "invalid-bucket");
      errorFn(`execute failed: ${bucketRes.error}`);
      exitFn(1);
      return;
    }
    const bucket = bucketRes.bucket;

    // P2: Validate listing with fail-closed try-catch
    let items;
    try {
      items = loadAndValidateListing(listingPath);
    } catch (err) {
      recorder.writeStatus("aborted", "listing-invalid");
      errorFn(`execute listing invalid: ${err.message}`);
      exitFn(1);
      return;
    }

    const plan = planIsoPrune(items, now, { maxDelete });
    const targets = plan.delete || [];

    // Target validation
    if (targets.length > maxDelete) {
      const err = `Prefix count (${targets.length}) exceeds maxDelete (${maxDelete})`;
      recorder.writeStatus("aborted", "validation-failed");
      errorFn(err);
      exitFn(1);
      return;
    }

    for (const t of targets) {
      if (t.prefix.includes("..") || /\s/.test(t.prefix) || GLOB_CHARS.test(t.prefix)) {
        recorder.writeStatus("aborted", "validation-failed");
        errorFn(`Target prefix '${t.prefix}' failed character validation`);
        exitFn(1);
        return;
      }
      if (!VALID_BUILD_RE.test(t.prefix) && !VALID_PREV_RE.test(t.prefix)) {
        recorder.writeStatus("aborted", "validation-failed");
        errorFn(`Target prefix '${t.prefix}' does not match regex`);
        exitFn(1);
        return;
      }
    }

    if (isDryRun) {
      recorder.writeStatus("dry-run", "Dry run mode (no deletions executed)");
      logFn("Dry run complete: no objects deleted.");
      exitFn(0);
      return;
    }

    // Live deletion loop
    let hasDeleted = false;
    let hasSkipped = false;
    let hasFailed = false;
    let totalDeletedBytes = 0;

    for (const t of targets) {
      // Re-verify regex
      if (!VALID_BUILD_RE.test(t.prefix) && !VALID_PREV_RE.test(t.prefix)) {
        recorder.writeStatus(totalDeletedBytes > 0 ? "partial" : "aborted", "validation-failed");
        errorFn(`Pre-rm regex re-validation failed for: ${t.prefix}`);
        exitFn(1);
        return;
      }

      // Check active workflows immediately before deleting
      const wfCheck = checkActiveFn();
      if (wfCheck.active) {
        if (wfCheck.reason === "gh-error") {
          recorder.finishPrefix(t.prefix, t.group, "failed", "gh-error", 0, 0, (t.objects || []).length);
          recorder.writeStatus(totalDeletedBytes > 0 ? "partial" : "aborted", "gh-error");
          exitFn(1);
          return;
        } else {
          logFn(`Workflow ${wfCheck.reason} became active. Aborting.`);
          const abortStatus = totalDeletedBytes > 0 ? "partial" : "aborted";
          recorder.writeStatus(abortStatus, wfCheck.reason);
          exitFn(0);
          return;
        }
      }

      // Re-query prefix state with pagination
      let currentContents;
      try {
        currentContents = listPagesFn({ bucket, prefix: t.prefix });
      } catch (err) {
        recorder.finishPrefix(t.prefix, t.group, "failed", err.message, 0, 0, (t.objects || []).length);
        recorder.writeStatus(totalDeletedBytes > 0 ? "partial" : "aborted", "listing-failed");
        exitFn(1);
        return;
      }

      // Compare current objects against planned objects
      const comp = comparePrefixObjects(t.objects, currentContents, t.prefix);
      if (!comp.match) {
        logFn(`Prefix ${t.prefix} changed since plan: skipping.`);
        recorder.finishPrefix(t.prefix, t.group, "skipped", "changed-since-plan", t.bytes);
        hasSkipped = true;
        continue;
      }

      // Delete objects one-by-one
      recorder.startPrefix(t.prefix, t.group, t.bytes);
      let prefixFailed = false;
      let prefixDeletedBytes = 0;
      let prefixDeletedKeys = 0;

      for (const obj of t.objects) {
        try {
          deleteKeyFn(bucket, obj.key, t.prefix);
          prefixDeletedBytes += obj.size;
          prefixDeletedKeys += 1;
          totalDeletedBytes += obj.size;
        } catch (err) {
          prefixFailed = true;
          hasFailed = true;
          const prefixResult = prefixDeletedKeys > 0 ? "partial-failed" : "failed";
          recorder.finishPrefix(
            t.prefix,
            t.group,
            prefixResult,
            err.message,
            prefixDeletedBytes,
            prefixDeletedKeys,
            t.objects.length
          );
          const failOverallStatus = totalDeletedBytes > 0 ? "partial" : "aborted";
          recorder.writeStatus(failOverallStatus, "delete-failed");
          errorFn(`Failed to delete key: ${obj.key}`);
          exitFn(1);
          return;
        }
      }

      if (!prefixFailed) {
        recorder.finishPrefix(t.prefix, t.group, "deleted", "ok", t.bytes, t.objects.length, t.objects.length);
        hasDeleted = true;
      }
    }

    let finalStatus = "completed";
    if (hasFailed) {
      finalStatus = totalDeletedBytes > 0 ? "partial" : "aborted";
    } else if (hasSkipped) {
      finalStatus = totalDeletedBytes > 0 ? "partial" : "completed";
    }
    recorder.writeStatus(finalStatus, "");
    exitFn(0);
    return;
  } else if (subcommand === "render-result-summary") {
    const missingFlag = findMissingValueFlag(rest, ["--result-file", "--summary-file"]);
    if (missingFlag) {
      errorFn(`Error: Flag '${missingFlag}' requires a value`);
      exitFn(1);
      return;
    }

    const resultFile = getArg("result-file") || "prune-result.jsonl";
    const summaryFile = getArg("summary-file");

    const parsed = parseResultJsonlFile(resultFile);
    const md = renderResultMarkdown(parsed);

    if (summaryFile) {
      appendFileSync(summaryFile, md);
    } else {
      logFn(md);
    }
    exitFn(0);
    return;
  } else {
    errorFn(`Unknown subcommand: ${subcommand}`);
    exitFn(1);
    return;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runHelperCli();
}
