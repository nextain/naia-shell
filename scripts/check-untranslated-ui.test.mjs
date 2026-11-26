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

test("web media providers load their catalog and Korean pronunciation dictionary from data files", () => {
	const lib = new URL("../packages/shell/src/lib/", import.meta.url);
	const catalog = JSON.parse(readFileSync(new URL("bgm-web-catalog.json", lib), "utf8"));
	assert.ok(catalog.some((entry) => entry.keywords.includes("로파이")));
	const readings = JSON.parse(readFileSync(
		new URL("avatar/nva-speech/ko-speech-unit-readings.json", lib),
		"utf8",
	));
	assert.equal(readings.words.webgpu, "웹지피유");
	assert.equal(Object.keys(readings.letters).length, 26);
});

test("the built-in app catalog stores its localized manifest data separately", () => {
	const manifests = JSON.parse(readFileSync(
		new URL("../packages/shell/src/lib/stage1-hosted-apps.json", import.meta.url),
		"utf8",
	));
	assert.equal(manifests.length, 4);
	for (const { appId, manifest } of manifests) {
		assert.equal(manifest.id, appId);
		assert.ok(manifest.names.ko && manifest.names.en);
		assert.ok(manifest.descriptions.ko && manifest.descriptions.en);
	}
});

test("slide guidance and shipped deck metadata have standalone content resources", () => {
	const slides = new URL("../packages/shell/src/lib/kiosk-demo/slides/", import.meta.url);
	for (const name of ["question-context.md", "reference-context.md"]) {
		const template = readFileSync(new URL(name, slides), "utf8");
		assert.match(template, /\{title\}/u);
		assert.match(template, /\{script\}/u);
		assert.match(template, /\{evidenceFile\}/u);
	}
	const metadata = JSON.parse(readFileSync(new URL("presentation-copy.json", slides), "utf8"));
	assert.match(metadata.pdfName, /\.pdf$/u);
	assert.match(metadata.scriptName, /\.md$/u);
	assert.ok(metadata.forbiddenWords.includes("개인정보"));
});

test("the bundled kiosk character card is stored in character-card format", () => {
	const card = JSON.parse(readFileSync(
		new URL("../packages/shell/src/lib/kiosk-demo/jina-card.json", import.meta.url),
		"utf8",
	));
	assert.equal(card.spec, "chara_card_v2");
	assert.ok(card.data.first_mes && card.data.character_book.entries.length);
});

test("the kiosk knowledge compiler keeps Korean dictionary data independent of its algorithms", () => {
	const data = JSON.parse(readFileSync(
		new URL("../packages/shell/src/lib/kiosk-demo/kb-compiler/ko-lexicon.json", import.meta.url),
		"utf8",
	));
	assert.ok(data.questionFillers.includes("알려주세요"));
	assert.ok(data.markdownBoilerplate.includes("작성일"));
	assert.ok(data.confidentialTerms.includes("대외비"));
});
