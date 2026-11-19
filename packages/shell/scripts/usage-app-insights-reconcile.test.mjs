import test from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "./usage-app-insights-reconcile.mjs";

const live = { runMarker: "test", expectedEventCount: 2, retriedDuplicateEventId: "a", events: [{ event_id: "a" }, { event_id: "b" }] };
const row = (event_id, sequence, occurred_at = "2026-11-18T16:00:00Z") => ({ name: "shell.launch.start", event_id, installation_id: "test", sequence, occurred_at });
const rows = [row("a", "1"), row("a", "1"), row("b", "2")];
const daily = { dateKst: "2026-11-19", runMarker: "test", reportedEventCount: 2, report: { dateKst: "2026-11-19", shell: { eventCount: 2 } } };
test("reconciles duplicates and uses the r2 report calculation", () => {
  const result = reconcile(live, rows, daily, "2026-11-19");
  assert.deepEqual(result.checks, { clientCount: true, rowsInDay: true, rowsAndRetry: true, eventIdsMatch: true, oneDuplicateRemoved: true, uniqueCount: true, reportedCount: true });
  assert.equal(result.reconciledDailyEventCount, 2);
  assert.equal(result.report.shell.dailyActiveInstallations, 1);
  assert.equal(result.report.web.status, "미확인");
});
test("rejects wrong identity even when counts match", () => {
  const result = reconcile(live, [rows[0], rows[1], row("c", "2")], daily, "2026-11-19");
  assert.equal(result.checks.eventIdsMatch, false);
});
test("rejects rows outside the requested KST day", () => {
  const result = reconcile(live, [rows[0], rows[1], row("b", "2", "2026-11-19T15:00:00Z")], daily, "2026-11-19");
  assert.equal(result.checks.rowsInDay, false);
  assert.equal(result.reconciledDailyEventCount, 1);
});
test("rejects invalid or unrelated query rows", () => {
  assert.throws(() => reconcile(live, [{ ...rows[0], installation_id: "other" }], daily, "2026-11-19"), /out-of-run/);
  assert.throws(() => reconcile(live, [{ ...rows[0], sequence: "" }], daily, "2026-11-19"), /Invalid/);
});
test("accepts Azure table response", () => {
  const columns = Object.keys(rows[0]);
  const table = { tables: [{ name: "PrimaryResult", columns: columns.map((name) => ({ name })), rows: rows.map((r) => columns.map((name) => r[name])) }] };
  assert.equal(reconcile(live, table, daily, "2026-11-19").checks.eventIdsMatch, true);
});

test("empty query fails receipt checks while rowsInDay remains true", () => {
  const result = reconcile(live, [], daily, "2026-11-19");
  assert.equal(result.checks.rowsInDay, true);
  assert.equal(result.checks.rowsAndRetry, false);
  assert.equal(result.checks.eventIdsMatch, false);
  assert.equal(result.checks.uniqueCount, false);
  assert.equal(result.checks.reportedCount, false);
});
test("rejects mismatched or unrelated daily report counts", () => {
  assert.equal(reconcile(live, rows, { ...daily, reportedEventCount: 3 }, "2026-11-19").checks.reportedCount, false);
  assert.equal(reconcile(live, rows, { ...daily, report: { ...daily.report, shell: { eventCount: 3 } } }, "2026-11-19").checks.reportedCount, false);
  assert.equal(reconcile(live, rows, { ...daily, runMarker: "other" }, "2026-11-19").checks.reportedCount, false);
  assert.equal(reconcile(live, rows, { ...daily, dateKst: "2026-11-20" }, "2026-11-19").checks.reportedCount, false);
});
