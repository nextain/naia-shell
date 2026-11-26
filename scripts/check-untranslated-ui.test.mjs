import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("shell copy uses locale tables and the app catalog uses manifest translations", () => {
	const gate = spawnSync(process.execPath, ["scripts/check-untranslated-ui.mjs"], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.ifError(gate.error);
	assert.match(gate.stdout, /\[untranslated-ui\]/, gate.stderr);
	assert.doesNotMatch(gate.stderr, /로케일 밖에서 언어로 분기하는 번역표/, gate.stderr);
});

test("character card editor labels use the shell locale", () => {
	const editor = readFileSync(
		new URL("../packages/shell/src/components/CharacterThemeSettings.tsx", import.meta.url),
		"utf8",
	);
	assert.doesNotMatch(editor, /[가-힣]/u);
});
