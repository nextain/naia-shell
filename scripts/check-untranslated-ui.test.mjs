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

test("kiosk harness and response rules are available as Markdown seed documents", () => {
	const workspace = new URL("../packages/shell/src/lib/kiosk-demo/workspace/", import.meta.url);
	assert.match(readFileSync(new URL("harness.md", workspace), "utf8"), /^# AGENTS\.md/m);
	assert.match(
		readFileSync(new URL("response-rules.md", workspace), "utf8"),
		/^# .*Response Rules/m,
	);
});

test("web entry and kiosk status copy use the locale tables", () => {
	const files = [
		"components/AiControlBar.tsx",
		"components/KioskDemoGate.tsx",
		"components/KioskVoiceNotice.tsx",
		"components/SkillsTab.tsx",
		"components/ToolActivity.tsx",
		"apps/slides/SlidesControls.tsx",
		"apps/workspace/WebWorkspace.tsx",
	];
	for (const name of files) {
		const source = readFileSync(
			new URL("../packages/shell/src/" + name, import.meta.url),
			"utf8",
		);
		const hardcoded = source.split("\n").filter((line) =>
			!/^\s*(?:\/\/|\/\*|\*)/.test(line) && /[가-힣]/u.test(line),
		);
		assert.deepEqual(hardcoded, [], name);
	}
});
