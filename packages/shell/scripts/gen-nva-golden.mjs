// 골든 재생성 (divergence 가드용) — **자립**: 크로스레포 절대경로 없이 in-repo vendored 정본으로 생성.
//   실행: node scripts/gen-nva-golden.mjs  (또는 `pnpm gen:nva-golden`)
//   정본 변경 시: __tests__/canonical/nva-core.reference.mjs 재복사 → 이 스크립트 실행 → diff 로 divergence 검출.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/shell/scripts
const AVATAR = resolve(HERE, "../src/lib/avatar/__tests__");
const CANON = resolve(AVATAR, "canonical/nva-core.reference.mjs");
const FIXTURES = resolve(AVATAR, "fixtures");

const { derive, animKind, isTransition } = await import(`file://${CANON}`);

// 픽스처: 실 naia(vendored) + 합성(gesture/transition/talk우선순위) 케이스.
const naia = JSON.parse(
	readFileSync(resolve(FIXTURES, "naia-manifest.json"), "utf8"),
);
const synth = {
	nva_version: "0.2",
	canvas: { width: 400, height: 700, fps: 25 },
	animations: {
		wait: { clip: "w.webm", loop: true, can_talk: false, label: "대기" },
		talk: {
			clip: "t.webm",
			loop: true,
			can_talk: true,
			face_bbox: [0.2, 0.3, 0.4],
			label: "말하기",
		},
		wave: { clip: "wv.webm", loop: false, can_talk: false, label: "손흔들기" },
		sit: {
			clip: "s.webm",
			entry_pose: "stand",
			exit_pose: "sit",
			loop: false,
			label: "앉기",
		},
	},
	scenario: {
		nodes: {
			start: { type: "start" },
			n0: { type: "scene", animation: "wait" },
		},
		edges: [{ from: "start", to: "n0" }],
	},
};
const fixtures = { naia, synth };
const golden = {};
for (const [name, m] of Object.entries(fixtures)) {
	const d = derive(m);
	golden[name] = {
		derive: { idleKey: d.idleKey, talkKey: d.talkKey, events: d.events },
		animKind: Object.fromEntries(
			Object.entries(m.animations).map(([k, a]) => [k, animKind(a)]),
		),
		isTransition: Object.fromEntries(
			Object.entries(m.animations).map(([k, a]) => [k, isTransition(a)]),
		),
	};
}
const out = {
	_note:
		"정본 nva-core.js(vendored canonical/nva-core.reference.mjs) 생성 골든. 정본 변경 시 재복사+재생성. vendor nva-core.ts 대조.",
	fixtures,
	golden,
};
writeFileSync(
	resolve(FIXTURES, "nva-golden.json"),
	`${JSON.stringify(out, null, 2)}\n`,
);
console.log(
	"golden 생성:",
	Object.keys(golden),
	"| naia idle/talk:",
	golden.naia.derive.idleKey,
	golden.naia.derive.talkKey,
	"| synth idle/talk:",
	golden.synth.derive.idleKey,
	golden.synth.derive.talkKey,
);
