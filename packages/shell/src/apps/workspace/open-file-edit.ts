// Pure helpers for workspace open-file AI editing (#687).

// Approval timeout for the user diff review.
// Must stay below naia-agent's 60 s app-tool timeout (chat-turn-handler.ts:40 TOOL_EXEC_TIMEOUT_MS = 60_000).
export const OPEN_FILE_EDIT_APPROVAL_TIMEOUT_MS = 50_000;

export interface OpenFileEditArgs {
  path: string;
  oldText?: string;
  newText?: string;
  content?: string;
}

export interface OpenFileEditProposal {
  id: string;
  path: string;
  lines: DiffLine[];
  truncated: boolean;
  added: number;
  removed: number;
  summary?: string;
  expiresAt: number;
  timeoutMs: number;
}

export function applyOpenFileEdit(
  base: string,
  args: OpenFileEditArgs,
): { ok: true; next: string } | { ok: false; error: string } {
  const hasContent = typeof args.content === "string";
  const hasOld = typeof args.oldText === "string";
  const hasNew = typeof args.newText === "string";

  if ((hasContent && (hasOld || hasNew)) || (!hasContent && (!hasOld || !hasNew))) {
    return { ok: false, error: "invalid: pass either content, or oldText and newText" };
  }

  if (typeof args.content === "string") {
    const next = args.content;
    if (next === base) {
      return { ok: false, error: "invalid: the edit does not change the file" };
    }
    return { ok: true, next };
  }

  const oldText = args.oldText ?? "";
  const newText = args.newText ?? "";

  if (oldText.length === 0) {
    return { ok: false, error: "invalid: oldText not found in the open file" };
  }

  let matches = 0;
  let pos = base.indexOf(oldText);
  while (pos !== -1) {
    matches++;
    pos = base.indexOf(oldText, pos + oldText.length);
  }

  if (matches === 0) {
    return { ok: false, error: "invalid: oldText not found in the open file" };
  }
  if (matches > 1) {
    return {
      ok: false,
      error: `invalid: oldText matches ${matches} places; include more surrounding text`,
    };
  }

  const at = base.indexOf(oldText);
  const next = base.slice(0, at) + newText + base.slice(at + oldText.length);
  if (next === base) {
    return { ok: false, error: "invalid: the edit does not change the file" };
  }

  return { ok: true, next };
}

export type DiffLine = {
  kind: "context" | "add" | "del";
  text: string;
  oldNo?: number;
  newNo?: number;
};

export function diffLines(
  before: string,
  after: string,
  maxLines = 4000,
): { lines: DiffLine[]; truncated: boolean; added: number; removed: number } {
  if (before === after) {
    return { lines: [], truncated: false, added: 0, removed: 0 };
  }

  const oldLines = before === "" ? [] : before.split("\n");
  const newLines = after === "" ? [] : after.split("\n");

  let prefixLen = 0;
  while (
    prefixLen < oldLines.length &&
    prefixLen < newLines.length &&
    oldLines[prefixLen] === newLines[prefixLen]
  ) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < oldLines.length - prefixLen &&
    suffixLen < newLines.length - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const prefixDiff: DiffLine[] = [];
  for (let i = 0; i < prefixLen; i++) {
    prefixDiff.push({
      kind: "context",
      text: oldLines[i],
      oldNo: i + 1,
      newNo: i + 1,
    });
  }

  const suffixDiff: DiffLine[] = [];
  for (let i = 0; i < suffixLen; i++) {
    const oldIdx = oldLines.length - suffixLen + i;
    const newIdx = newLines.length - suffixLen + i;
    suffixDiff.push({
      kind: "context",
      text: oldLines[oldIdx],
      oldNo: oldIdx + 1,
      newNo: newIdx + 1,
    });
  }

  const middleOld = oldLines.slice(prefixLen, oldLines.length - suffixLen);
  const middleNew = newLines.slice(prefixLen, newLines.length - suffixLen);
  const middleDiff: DiffLine[] = [];

  const n = middleOld.length;
  const m = middleNew.length;

  if (n === 0) {
    for (let j = 0; j < m; j++) {
      middleDiff.push({
        kind: "add",
        text: middleNew[j],
        newNo: prefixLen + j + 1,
      });
    }
  } else if (m === 0) {
    for (let i = 0; i < n; i++) {
      middleDiff.push({
        kind: "del",
        text: middleOld[i],
        oldNo: prefixLen + i + 1,
      });
    }
  } else if (n * m <= 4_000_000) {
    const dp = new Int32Array((n + 1) * (m + 1));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) {
        if (middleOld[i] === middleNew[j]) {
          dp[(i + 1) * (m + 1) + (j + 1)] = dp[i * (m + 1) + j] + 1;
        } else {
          const a = dp[(i + 1) * (m + 1) + j];
          const b = dp[i * (m + 1) + (j + 1)];
          dp[(i + 1) * (m + 1) + (j + 1)] = a > b ? a : b;
        }
      }
    }

    let i = n;
    let j = m;
    const rev: DiffLine[] = [];
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && middleOld[i - 1] === middleNew[j - 1]) {
        rev.push({
          kind: "context",
          text: middleOld[i - 1],
          oldNo: prefixLen + i,
          newNo: prefixLen + j,
        });
        i--;
        j--;
      } else if (
        j > 0 &&
        (i === 0 || dp[i * (m + 1) + (j - 1)] >= dp[(i - 1) * (m + 1) + j])
      ) {
        rev.push({
          kind: "add",
          text: middleNew[j - 1],
          newNo: prefixLen + j,
        });
        j--;
      } else {
        rev.push({
          kind: "del",
          text: middleOld[i - 1],
          oldNo: prefixLen + i,
        });
        i--;
      }
    }
    rev.reverse();
    middleDiff.push(...rev);
  } else {
    for (let i = 0; i < n; i++) {
      middleDiff.push({
        kind: "del",
        text: middleOld[i],
        oldNo: prefixLen + i + 1,
      });
    }
    for (let j = 0; j < m; j++) {
      middleDiff.push({
        kind: "add",
        text: middleNew[j],
        newNo: prefixLen + j + 1,
      });
    }
  }

  const allRaw: DiffLine[] = [...prefixDiff, ...middleDiff, ...suffixDiff];

  let added = 0;
  let removed = 0;
  for (const line of allRaw) {
    if (line.kind === "add") added++;
    if (line.kind === "del") removed++;
  }

  if (added === 0 && removed === 0) {
    return { lines: [], truncated: false, added: 0, removed: 0 };
  }

  const keep = new Uint8Array(allRaw.length);
  for (let k = 0; k < allRaw.length; k++) {
    if (allRaw[k].kind !== "context") {
      const start = Math.max(0, k - 3);
      const end = Math.min(allRaw.length - 1, k + 3);
      for (let c = start; c <= end; c++) {
        keep[c] = 1;
      }
    }
  }

  let hasOmission = false;
  const resultLines: DiffLine[] = [];

  for (let i = 0; i < allRaw.length; i++) {
    if (keep[i]) {
      if (hasOmission) {
        resultLines.push({ kind: "context", text: "…" });
        hasOmission = false;
      }
      resultLines.push(allRaw[i]);
    } else {
      hasOmission = true;
    }
  }
  if (hasOmission) {
    resultLines.push({ kind: "context", text: "…" });
  }

  const truncated = resultLines.length > maxLines;
  const lines = truncated ? resultLines.slice(0, maxLines) : resultLines;

  return { lines, truncated, added, removed };
}

export function editResult(
  status: "applied" | "rejected" | "stale" | "denied" | "invalid" | "error",
  detail: Record<string, unknown> = {},
): string {
  return JSON.stringify({ status, ...detail });
}
