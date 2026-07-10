import { describe, expect, it } from "vitest";
import { type NvaManifest, animKind, derive, isTransition } from "../nva-core";
import golden from "./fixtures/nva-golden.json";

/**
 * ★codex R2 CRITICAL C3 — 벤더 포팅(nva-core.ts) ↔ 정본(naia-video-avatar nva-core.js) divergence 가드.
 * 정본으로 생성한 골든(fixtures/nva-golden.json, gen-nva-golden.mjs)과 벤더 TS 출력을 대조한다.
 * 정본 규칙 변경 시 골든 재생성 → diff 로 divergence 검출. derive(idle/talk/events)+animKind+isTransition.
 */
const G = golden as unknown as {
	fixtures: Record<string, NvaManifest>;
	golden: Record<
		string,
		{
			derive: {
				idleKey: string | null;
				talkKey: string | null;
				events: Record<string, string>;
			};
			animKind: Record<string, string>;
			isTransition: Record<string, boolean>;
		}
	>;
};

describe("nva-core 벤더 포팅 ↔ 정본 골든 대조 (divergence 가드)", () => {
	for (const [name, m] of Object.entries(G.fixtures)) {
		const g = G.golden[name];
		it(`${name}: derive(idleKey/talkKey/events) 정본 일치`, () => {
			const d = derive(m);
			expect(d.idleKey).toBe(g.derive.idleKey);
			expect(d.talkKey).toBe(g.derive.talkKey);
			expect(d.events).toEqual(g.derive.events);
		});
		it(`${name}: animKind/isTransition 정본 일치`, () => {
			for (const [k, a] of Object.entries(m.animations)) {
				expect(animKind(a)).toBe(g.animKind[k]);
				expect(isTransition(a)).toBe(g.isTransition[k]);
			}
		});
	}
});
