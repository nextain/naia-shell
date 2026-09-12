import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
	ensureQcNumbers,
	qcNumberMapPath,
	readQcNumberMap,
} from "./qa-qc-numbers.mjs";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "naia-qa-qc-numbers-"));
	return { root, adk: resolve(root, "adk") };
}

test("QC assignments stay stable across reorder and append", () => {
	const f = fixture();
	try {
		const first = ensureQcNumbers({ adkPath: f.adk, caseIds: ["case-b", "case-a"] });
		assert.equal(first.byCaseId.get("case-b"), "QC-001");
		assert.equal(first.byCaseId.get("case-a"), "QC-002");
		assert.ok(existsSync(qcNumberMapPath(f.adk)));

		const second = ensureQcNumbers({ adkPath: f.adk, caseIds: ["case-a", "case-b", "case-c"] });
		assert.equal(second.byCaseId.get("case-a"), "QC-002");
		assert.equal(second.byCaseId.get("case-b"), "QC-001");
		assert.equal(second.byCaseId.get("case-c"), "QC-003");
		assert.deepEqual(second.assignments, [
			{ caseId: "case-b", qcNumber: "QC-001" },
			{ caseId: "case-a", qcNumber: "QC-002" },
			{ caseId: "case-c", qcNumber: "QC-003" },
		]);
		ensureQcNumbers({ adkPath: f.adk, caseIds: ["case-a", "case-b"] });
		const readded = ensureQcNumbers({ adkPath: f.adk, caseIds: ["case-c", "case-a"] });
		assert.equal(readded.byCaseId.get("case-c"), "QC-003", "removed cases retain their number when reintroduced");
		assert.deepEqual(readQcNumberMap({ adkPath: f.adk }).assignments, second.assignments);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("QC sidecar rejects duplicate assignments and does not become catalog data", () => {
	const f = fixture();
	try {
		const first = ensureQcNumbers({ adkPath: f.adk, caseIds: ["case-a"] });
		const path = first.path;
		const invalid = JSON.parse(readFileSync(path, "utf8"));
		invalid.assignments.push({ caseId: "case-a", qcNumber: "QC-002" });
		writeFileSync(path, `${JSON.stringify(invalid, null, 2)}\n`);
		assert.throws(() => readQcNumberMap({ adkPath: f.adk }), /repeats caseId/i);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});
