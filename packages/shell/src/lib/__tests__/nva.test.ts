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
		idle: { clip: "clips/idle.webm", entry_pose: "default", exit_pose: "default", loop: true, can_talk: false },
		talk: { clip: "clips/idle.webm", entry_pose: "default", exit_pose: "default", loop: true, can_talk: true, face_bbox: [0.4, 0.05, 0.2, 0.12] },
	},
	scenario: {
		nodes: { start: { type: "start" }, idle_node: { type: "scene", animation: "idle" } },
		edges: [{ from: "start", to: "idle_node" }],
	},
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
		expect(resolveDefaultAnimation(parseNvaManifest(JSON.stringify(m)))?.clip).toBe("clips/idle.webm");
	});

	it("scenario start wins over dict-first idle (priority actually exercised)", () => {
		// idle(첫 dict) 과 idle2(둘째, 다른 클립) 둘 다 유효 idle. start→idle2.
		// scenario-start 우선 로직이 없으면 dict-first idle 이 뽑혀 실패.
		const m = JSON.parse(JSON.stringify(V02));
		m.animations.idle2 = { clip: "clips/idle2.webm", entry_pose: "default", exit_pose: "default", loop: true, can_talk: false };
		m.scenario.nodes.idle_node.animation = "idle2";
		expect(resolveDefaultAnimation(parseNvaManifest(JSON.stringify(m)))?.clip).toBe("clips/idle2.webm");
	});

	it("ignores scenario start pointing at a can_talk anim (parity with cascade loader)", () => {
		// start→talk(can_talk) 면 idle base 가 아니므로 default 로 쓰면 안 됨 → 첫 idle 로 폴백.
		const m = JSON.parse(JSON.stringify(V02));
		m.scenario.nodes.idle_node.animation = "talk";
		expect(resolveDefaultAnimation(parseNvaManifest(JSON.stringify(m)))?.clip).toBe("clips/idle.webm");
	});

	it("rejects a non-v0.2 (v1) manifest", () => {
		expect(() =>
			parseNvaManifest(
				JSON.stringify({ schemaVersion: "naia-video-avatar/v1", defaultClip: "idle", clips: {} }),
			),
		).toThrow(/0\.2/);
	});

	it("rejects a v0.2 manifest with no playable animation", () => {
		expect(() =>
			parseNvaManifest(
				JSON.stringify({ nva_version: "0.2", canvas: { width: 720, height: 1280 }, animations: {}, scenario: { nodes: {}, edges: [] } }),
			),
		).toThrow();
	});

	it("resolves clip paths inside the extracted bundle directory", () => {
		expect(resolveNvaAssetPath("D:\\alpha\\naia-settings\\nva-files\\alpha", "clips/idle.webm")).toBe(
			"D:\\alpha\\naia-settings\\nva-files\\alpha\\clips\\idle.webm",
		);
	});

	it("blocks path traversal in clip paths", () => {
		expect(() => resolveNvaAssetPath("/adk/nva/alpha", "../secret.mp4")).toThrow(
			/Invalid NVA asset path/,
		);
	});
});
