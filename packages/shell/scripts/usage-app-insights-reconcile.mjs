#!/usr/bin/env node
// Reconcile a saved Azure query with the recorded client run; never sends events.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { calculateDailyUsageReport, deduplicateDailyUsageEvents } from "../src/lib/usage-daily-report.ts";

function rowsFromQuery(input) {
  if (Array.isArray(input)) return input;
  const table = input?.tables?.find((entry) => entry.name === "PrimaryResult");
  if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) throw new Error("Missing PrimaryResult query table");
  return table.rows.map((row) => Object.fromEntries(table.columns.map((col, i) => [col.name, row[i]])));
}

export function reconcile(live, query, daily, dateKst) {
  if (!live || typeof live.runMarker !== "string" || !Array.isArray(live.events) || !Number.isSafeInteger(live.expectedEventCount)) throw new Error("Invalid client run evidence");
  const rows = rowsFromQuery(query).map((row) => {
    if (!row || typeof row.name !== "string" || !row.name || typeof row.event_id !== "string" || !row.event_id || row.installation_id !== live.runMarker || typeof row.occurred_at !== "string" || !/(?:Z|[+-]\d\d:\d\d)$/.test(row.occurred_at) || !Number.isFinite(Date.parse(row.occurred_at)) || !/^\d+$/.test(String(row.sequence)) || !Number.isSafeInteger(Number(row.sequence))) throw new Error("Invalid or out-of-run query row");
    return { name: row.name, event_id: row.event_id, installation_id: row.installation_id, occurred_at: row.occurred_at, sequence: Number(row.sequence), screen: row.screen };
  });
  const report = calculateDailyUsageReport(dateKst, new Date().toISOString(), {
    web: { status: "unknown", source: "미확인" },
    webgpu: { status: "unknown", source: "미확인" },
    shell: { status: "known", source: "appi-naia-shell-dev-r3-20261119", events: rows },
  });
  const start = Date.parse(report.interval.startInclusive);
  const end = Date.parse(report.interval.endExclusive);
  const dailyRows = rows.filter((row) => Date.parse(row.occurred_at) >= start && Date.parse(row.occurred_at) < end);
  const unique = deduplicateDailyUsageEvents(dailyRows);
  const expectedIds = live.events.map((event) => event.event_id);
  const receivedIds = new Set(unique.map((event) => event.event_id));
  const retryId = live.retriedDuplicateEventId;
  const checks = {
    clientCount: expectedIds.length === live.expectedEventCount && new Set(expectedIds).size === live.expectedEventCount,
    rowsInDay: dailyRows.length === rows.length,
    rowsAndRetry: rows.length === live.expectedEventCount + 1 && rows.filter((event) => event.event_id === retryId).length === 2,
    eventIdsMatch: receivedIds.size === expectedIds.length && expectedIds.every((id) => receivedIds.has(id)),
    oneDuplicateRemoved: dailyRows.length - unique.length === 1,
    uniqueCount: unique.length === live.expectedEventCount,
    reportedCount: daily?.dateKst === dateKst && daily?.runMarker === live.runMarker && Number.isSafeInteger(daily?.reportedEventCount) && daily.reportedEventCount === unique.length && daily?.report?.dateKst === dateKst && daily?.report?.shell?.eventCount === unique.length,
  };
  return { dateKst, runMarker: live.runMarker, expectedUniqueEvents: live.expectedEventCount, storedRowsIncludingRetry: rows.length, duplicatesRemoved: dailyRows.length - unique.length, reconciledDailyEventCount: unique.length, reportedEventCount: daily?.reportedEventCount ?? null, checks, report };
}

async function main() {
  const [livePath, rowsPath, dailyPath, dateKst] = process.argv.slice(2);
  if (!livePath || !rowsPath || !dailyPath || !dateKst || process.argv.length !== 6) throw new Error("Usage: node --experimental-strip-types usage-app-insights-reconcile.mjs LIVE.json QUERY.json DAILY.json YYYY-MM-DD");
  const result = reconcile(JSON.parse(await readFile(livePath, "utf8")), JSON.parse(await readFile(rowsPath, "utf8")), JSON.parse(await readFile(dailyPath, "utf8")), dateKst);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (Object.values(result.checks).some((pass) => !pass)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
