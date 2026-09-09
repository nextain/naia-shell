import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { BatchResultsReporter } from "./batch-results.mjs";

function makeAdk() {
	return mkdtempSync(join(tmpdir(), "naia-shell-e2e-results-"));
}

function records(reporter) {
	return readFileSync(reporter.resultsPath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

test("records a failure and continues recording a later pass immediately", () => {
	const adkPath = makeAdk();
	try {
		const reporter = new BatchResultsReporter({
			adkPath,
			planPath: join(adkPath, "e2e-batch-plan.json"),
			runId: "same-run",
		});
		const secondReporter = new BatchResultsReporter({ adkPath, runId: "same-run" });
		const smokeFile = join(adkPath, "smoke.spec.ts");
		const smokeUrl = pathToFileURL(smokeFile).href;
		assert.notEqual(reporter.runId, secondReporter.runId);
		assert.ok(reporter.resultsPath.startsWith(join(adkPath, "e2e-batch-results")));
		reporter.emit("runner:start", { sessionId: "session-a", cid: "0-0", specs: ["smoke.spec.ts"] });
		reporter.emit("test:start", {
			uid: "test-fail",
			cid: "0-0",
			file: smokeUrl,
			fullTitle: "fails first",
		});
		reporter.emit("test:fail", {
			uid: "test-fail",
			cid: "0-0",
			file: smokeUrl,
			error: new Error("Authorization: Bearer do-not-write-this-token"),
		});

		const beforeSecondTest = records(reporter);
		assert.equal(beforeSecondTest.at(-1).status, "FAIL");
		assert.equal(beforeSecondTest.length, 3);
		assert.equal(beforeSecondTest.at(-1).file, smokeFile);
		assert.ok(!JSON.stringify(beforeSecondTest).includes("do-not-write-this-token"));

		reporter.emit("test:start", {
			uid: "test-pass",
			cid: "0-0",
			file: smokeUrl,
			fullTitle: "passes after failure",
		});
		reporter.emit("test:pass", {
			uid: "test-pass",
			cid: "0-0",
			file: smokeUrl,
			duration: 4,
		});
		const afterSecondTest = records(reporter);
		assert.deepEqual(afterSecondTest.slice(-2).map((record) => record.status), ["RUNNING", "PASS"]);
		reporter.emit("runner:end", { sessionId: "session-a", cid: "0-0", failures: 1 });
		assert.equal(records(reporter).at(-1).event, "run_finished");
		assert.equal(records(reporter).at(-1).status, "FAIL");
	} finally {
		rmSync(adkPath, { recursive: true, force: true });
	}
});

test("keeps hook failure distinct and classifies skipped/unvisited tests without PASS", () => {
	const adkPath = makeAdk();
	try {
		const reporter = new BatchResultsReporter({ adkPath, runId: "hook-run" });
		reporter.emit("runner:start", { sessionId: "session-hook", cid: "0-1", specs: ["settings.spec.ts"] });
		reporter.emit("hook:end", {
			uid: "before-all",
			cid: "0-1",
			file: "settings.spec.ts",
			title: "before all",
			state: "failed",
			error: new Error("api_key=secret-value"),
		});
		const afterHook = records(reporter);
		assert.equal(afterHook.at(-1).kind, "hook");
		assert.equal(afterHook.at(-1).status, "BLOCKED");
		assert.ok(!JSON.stringify(afterHook).includes("secret-value"));

		reporter.emit("test:start", { uid: "blocked", cid: "0-1", file: "settings.spec.ts" });
		reporter.emit("test:start", { uid: "skipped", cid: "0-1", file: "settings.spec.ts" });
		reporter.emit("test:skip", {
			uid: "skipped",
			cid: "0-1",
			file: "settings.spec.ts",
			reason: "requires optional service",
		});
		reporter.emit("runner:end", { sessionId: "session-hook", cid: "0-1", failures: 0 });

		const output = records(reporter);
		const blocked = output.find((record) => record.uid === "blocked" && record.event === "test_blocked");
		const skipped = output.find((record) => record.uid === "skipped" && record.event === "test_skipped");
		const finished = output.at(-1);
		assert.equal(blocked.status, "BLOCKED");
		assert.equal(skipped.status, "SKIP");
		assert.equal(finished.status, "BLOCKED");
		assert.equal(finished.unvisitedStatus, "NOT_RUN");
		assert.equal(finished.scope.unresolvedTests, 1);
		assert.equal(output.filter((record) => record.uid === "blocked" && record.status === "PASS").length, 0);
		assert.equal(output.filter((record) => record.kind === "run").length, 2);
	} finally {
		rmSync(adkPath, { recursive: true, force: true });
	}
});

test("fails synchronously when the JSONL target cannot be written", () => {
	const adkPath = makeAdk();
	try {
		const reporter = new BatchResultsReporter({ adkPath, runId: "broken-run" });
		mkdirSync(reporter.resultsPath, { recursive: true });
		assert.throws(
			() => reporter.emit("runner:start", { sessionId: "write-failure", cid: "0-2" }),
			/ directory|EISDIR|is a directory/i,
		);
		assert.ok(reporter.writeError);
		assert.throws(() => reporter.flush(), / directory|EISDIR|is a directory/i);
	} finally {
		rmSync(adkPath, { recursive: true, force: true });
	}
});
