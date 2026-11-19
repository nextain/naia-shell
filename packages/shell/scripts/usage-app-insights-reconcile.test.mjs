import test from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "./usage-app-insights-reconcile.mjs";

const live = { runMarker: "test", expectedEventCount: 2, retriedDuplicateEventId: "a", events: [{ event_id: "a" }, { event_id: "b" }] };
const row = (event_id, sequence, occurred_at = "2026-11-18T16:00:00Z") => ({ name: "shell.launch.start", event_id, installation_id: "test", sequence, occurred_at });
const rows = [row("a", "1"), row("a", "1"), row("b", "2")];
test("reconciles duplicates and uses the r2 report calculation", () => {
  const result = reconcile(live, rows, "2026-11-19");
  assert.ok(Object.values(result.checks).every(Boolean));
  assert.equal(result.reconciledDailyEventCount, 2);
  assert.equal(result.report.shell.dailyActiveInstallations, 1);
  assert.equal(result.report.web.status, "미확인");
});
test("rejects wrong identity even when counts match", () => {
  const result = reconcile(live, [rows[0], rows[1], row("c", "2")], "2026-11-19");
  assert.equal(result.checks.eventIdsMatch, false);
});
test("rejects rows outside the requested KST day", () => {
  const result = reconcile(live, [rows[0], rows[1], row("b", "2", "2026-11-19T15:00:00Z")], "2026-11-19");
  assert.equal(result.checks.rowsInDay, false);
  assert.equal(result.reconciledDailyEventCount, 1);
});
test("rejects invalid or unrelated query rows", () => {
  assert.throws(() => reconcile(live, [{ ...rows[0], installation_id: "other" }], "2026-11-19"), /out-of-run/);
  assert.throws(() => reconcile(live, [{ ...rows[0], sequence: "" }], "2026-11-19"), /Invalid/);
});
test("accepts Azure table response", () => {
  const columns = Object.keys(rows[0]);
  const table = { tables: [{ name: "PrimaryResult", columns: columns.map((name) => ({ name })), rows: rows.map((r) => columns.map((name) => r[name])) }] };
  assert.equal(reconcile(live, table, "2026-11-19").checks.eventIdsMatch, true);
});
