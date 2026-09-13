import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { keepClosure, nameVariants, scan, summarize } from "./check-excluded-traces.mjs";

function repo(files) {
	const root = mkdtempSync(join(tmpdir(), "naia-excluded-traces-"));
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	execFileSync("git", ["init", "-q", root]);
	execFileSync("git", ["-C", root, "add", "-A"]);
	return root;
}

const config = (over = {}) => ({
	terms: [
		{ term: "anthropic", bundle: 3, variants: false },
		{ term: "subLlm", bundle: 2 },
	],
	allow: [{ terms: ["anthropic"], lineContains: ["allowed-marker"], reason: "test allow" }],
	repos: {
		agent: {
			include: ["src/**", "package.json"],
			exclude: [],
			keepRoots: ["src/cli-provider.ts"],
			mustExist: ["src/cli-provider.ts"],
		},
	},
	...over,
});

test("nameVariants covers camel, snake, screaming and kebab case", () => {
	assert.deepEqual(nameVariants("subLlm").sort(), ["SUB_LLM", "sub-llm", "subLlm", "sub_llm"].sort());
	assert.deepEqual(nameVariants("discord"), ["discord"]);
});

test("keepClosure follows relative, dynamic and string imports to external packages", () => {
	const root = repo({
		"src/cli-provider.ts": 'import { run } from "./helper.js";\nconst sdk = await import("@anthropic-ai/claude-agent-sdk");\n',
		"src/helper.ts": 'import x from "left-pad";\nexport const run = 1;\n',
	});
	try {
		const closure = keepClosure(root, ["src/cli-provider.ts"]);
		assert.ok(closure.files.has("src/helper.ts"));
		assert.ok(closure.packages.has("@anthropic-ai/claude-agent-sdk"));
		assert.ok(closure.packages.has("left-pad"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a supported dependency name is kept wherever it appears, other hits are traces", () => {
	const root = repo({
		"src/cli-provider.ts": 'const sdk = await import("@anthropic-ai/claude-agent-sdk");\n',
		"package.json": '{ "dependencies": { "@anthropic-ai/claude-agent-sdk": "1" } }\n',
		"src/messages.ts": 'fetch("https://api.anthropic.com/v1/messages");\n// allowed-marker anthropic\n',
	});
	try {
		const result = scan({ config: config(), repos: { agent: root } });
		const find = (file, line) => result.hits.find((h) => h.file === file && h.line === line);
		assert.equal(find("src/cli-provider.ts", 1).status, "keep");
		assert.equal(find("package.json", 1).status, "keep");
		assert.equal(find("src/messages.ts", 1).status, "trace");
		assert.equal(find("src/messages.ts", 2).status, "keep");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("strict mode fails when a deleted name is brought back, and passes once it is gone", () => {
	const clean = repo({ "src/cli-provider.ts": "export const ok = 1;\n" });
	const revived = repo({
		"src/cli-provider.ts": "export const ok = 1;\n",
		"src/settings.ts": "export const sub_llm_model = '';\n",
	});
	try {
		assert.equal(summarize(scan({ config: config(), repos: { agent: clean } }), ["2"]).failed, false);
		const bad = summarize(scan({ config: config(), repos: { agent: revived } }), ["2"]);
		assert.equal(bad.failed, true);
		assert.equal(bad.blocking[0].term, "subLlm");
		assert.equal(summarize(scan({ config: config(), repos: { agent: revived } }), ["3"]).failed, false);
		assert.equal(summarize(scan({ config: config(), repos: { agent: revived } }), null).failed, false);
	} finally {
		rmSync(clean, { recursive: true, force: true });
		rmSync(revived, { recursive: true, force: true });
	}
});

test("strict mode fails when a file that must be kept is missing", () => {
	const root = repo({ "src/other.ts": "export {};\n" });
	try {
		const result = scan({ config: config(), repos: { agent: root } });
		assert.deepEqual(result.missing, [{ repo: "agent", path: "src/cli-provider.ts" }]);
		assert.equal(summarize(result, ["2"]).failed, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
