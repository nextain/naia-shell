import { describe, expect, it } from "vitest";
import {
	defaultClipOf,
	parseNvaManifest,
	resolveDefaultAnimation,
	resolveNvaAssetPath,
} from "../nva";

const V02 = {
	nva_version: "0.2",
	meta: { name: "Alpha Real Video" },
	canvas: { width: 720, height: 1280, fps: 24 },
	background: { type: "transparent" },
	poses: ["default"],
	animations: {
		idle: {
			clip: "clips/idle.webm",
			entry_pose: "default",
			exit_pose: "default",
			loop: true,
			can_talk: false,
		},
		talk: {
			clip: "clips/idle.webm",
			entry_pose: "default",
			exit_pose: "default",
			loop: true,
			can_talk: true,
			face_bbox: [0.4, 0.05, 0.2, 0.12],
		},
	},
	scenario: {
		nodes: {
			start: { type: "start" },
			idle_node: { type: "scene", animation: "idle" },
		},
		edges: [{ from: "start", to: "idle_node" }],
	},
};

// ★재정의 단일상태 번들(naia-video-avatar/examples/naia.nva) — scenario/poses/entry·exit 없음,
//   speak 에 head_image/head_chroma + face_bbox 정사각[x,y,l], expressions 맵.
const SINGLE_STATE = {
	nva_version: "0.2",
	meta: { name: "Naia (기본 캐릭터)", owner: "nextain" },
	canvas: { width: 406, height: 720, fps: 25 },
	background: { type: "transparent" },
	animations: {
		idle: {
			clip: "clips/sijak.webm",
			loop: true,
			can_talk: false,
			face_bbox: [0.34, 0.34, 0.3],
			label: "대기",
		},
		speak: {
			clip: "clips/speak_body.webm",
			loop: true,
			can_talk: true,
			face_bbox: [0.1, 0.1, 0.8, 0.4],
			head_image: "clips/speak_head.png",
			head_time: 1.27,
			head_chroma: "#00ff00",
			label: "말하기",
		},
		"gesture-1": {
			clip: "clips/water_drop.webm",
			loop: false,
			can_talk: false,
			label: "물방울",
		},
	},
	expressions: { neutral: "idle", speaking: "speak", playful: "gesture-1" },
};

describe("NVA manifest contract (v0.2)", () => {
	it("parses a v0.2 video avatar bundle manifest", () => {
		const manifest = parseNvaManifest(JSON.stringify(V02));
		expect(manifest.nva_version).toBe("0.2");
		expect(Object.keys(manifest.animations)).toEqual(["idle", "talk"]);
		expect(manifest.animations.talk.face_bbox).toEqual([0.4, 0.05, 0.2, 0.12]);
	});

	it("resolves the default clip via scenario start", () => {
		const manifest = parseNvaManifest(JSON.stringify(V02));
		// scenario start → idle_node → idle 애니.
		expect(resolveDefaultAnimation(manifest)?.clip).toBe("clips/idle.webm");
		expect(defaultClipOf(manifest)).toEqual({ video: "clips/idle.webm" });
	});

	it("falls back to first idle loop when scenario has no start edge", () => {
		const m = JSON.parse(JSON.stringify(V02));
		m.scenario = { nodes: {}, edges: [] };
		expect(
			resolveDefaultAnimation(parseNvaManifest(JSON.stringify(m)))?.clip,
		).toBe("clips/idle.webm");
	});

	it("scenario start wins over dict-first idle (priority actually exercised)", () => {
		// idle(첫 dict) 과 idle2(둘째, 다른 클립) 둘 다 유효 idle. start→idle2.
		// scenario-start 우선 로직이 없으면 dict-first idle 이 뽑혀 실패.
		const m = JSON.parse(JSON.stringify(V02));
		m.animations.idle2 = {
			clip: "clips/idle2.webm",
			entry_pose: "default",
			exit_pose: "default",
			loop: true,
			can_talk: false,
		};
		m.scenario.nodes.idle_node.animation = "idle2";
		expect(
			resolveDefaultAnimation(parseNvaManifest(JSON.stringify(m)))?.clip,
		).toBe("clips/idle2.webm");
	});

	it("ignores scenario start pointing at a can_talk anim (parity with cascade loader)", () => {
		// start→talk(can_talk) 면 idle base 가 아니므로 default 로 쓰면 안 됨 → 첫 idle 로 폴백.
		const m = JSON.parse(JSON.stringify(V02));
		m.scenario.nodes.idle_node.animation = "talk";
		expect(
			resolveDefaultAnimation(parseNvaManifest(JSON.stringify(m)))?.clip,
		).toBe("clips/idle.webm");
	});

	it("rejects a non-v0.2 (v1) manifest", () => {
		expect(() =>
			parseNvaManifest(
				JSON.stringify({
					schemaVersion: "naia-video-avatar/v1",
					defaultClip: "idle",
					clips: {},
				}),
			),
		).toThrow(/0\.2/);
	});

	it("rejects a v0.2 manifest with no playable animation", () => {
		expect(() =>
			parseNvaManifest(
				JSON.stringify({
					nva_version: "0.2",
					canvas: { width: 720, height: 1280 },
					animations: {},
					scenario: { nodes: {}, edges: [] },
				}),
			),
		).toThrow();
	});

	it("resolves clip paths inside the extracted bundle directory", () => {
		expect(
			resolveNvaAssetPath(
				"D:\\alpha\\naia-settings\\nva-files\\alpha",
				"clips/idle.webm",
			),
		).toBe("D:\\alpha\\naia-settings\\nva-files\\alpha\\clips\\idle.webm");
	});

	it("blocks path traversal in clip paths", () => {
		expect(() =>
			resolveNvaAssetPath("/adk/nva/alpha", "../secret.mp4"),
		).toThrow(/Invalid NVA asset path/);
	});

	// ── 재정의 단일상태(scenario/pose 없음) — cascade nva_loader.py 와 parity ──
	it("parses a redefined single-state bundle (no scenario/poses)", () => {
		const manifest = parseNvaManifest(JSON.stringify(SINGLE_STATE));
		expect(manifest.nva_version).toBe("0.2");
		expect(manifest.scenario).toBeUndefined();
		expect(Object.keys(manifest.animations)).toEqual([
			"idle",
			"speak",
			"gesture-1",
		]);
	});

	it("resolves idle default in single-state (no scenario, no entry/exit pose)", () => {
		const manifest = parseNvaManifest(JSON.stringify(SINGLE_STATE));
		// loop && !can_talk && 전환아님 → idle. scenario 부재라 dict-first idle.
		expect(resolveDefaultAnimation(manifest)?.clip).toBe("clips/sijak.webm");
		expect(defaultClipOf(manifest)).toEqual({ video: "clips/sijak.webm" });
	});

	it("preserves head_image/head_chroma + square face_bbox on the speak animation", () => {
		const manifest = parseNvaManifest(JSON.stringify(SINGLE_STATE));
		expect(manifest.animations.idle.face_bbox).toEqual([0.34, 0.34, 0.3]); // 3-tuple 정사각
		expect(manifest.animations.speak.head_image).toBe("clips/speak_head.png");
		expect(manifest.animations.speak.head_chroma).toBe("#00ff00");
		expect(manifest.expressions?.speaking).toBe("speak");
	});

	it("rejects a manifest missing animations even without scenario", () => {
		expect(() =>
			parseNvaManifest(
				JSON.stringify({
					nva_version: "0.2",
					canvas: { width: 406, height: 720 },
				}),
			),
		).toThrow(/Invalid NVA manifest/);
	});

	it("resolves to undefined (not first anim) when no idle base exists — parity with cascade idle=None", () => {
		// 클립은 있지만 idle(loop&&!can_talk) 이 없는 번들 → Python idle_key=None 과 동일하게 undefined.
		// 제스처(비루프)를 idle 로 오선택하지 않는다.
		const noIdle = {
			nva_version: "0.2",
			canvas: { width: 406, height: 720 },
			animations: {
				"gesture-1": { clip: "clips/wave.webm", loop: false, can_talk: false },
			},
		};
		expect(resolveDefaultAnimation(noIdle as never)).toBeUndefined();
		// 셸 검증 게이트(parseNvaManifest)는 idle 베이스를 요구 → 거부.
		expect(() => parseNvaManifest(JSON.stringify(noIdle))).toThrow(
			/no playable default clip/,
		);
	});
});
