import { describe, expect, it } from "vitest";
import { type NvaManifest, animKind, derive, isTransition } from "../nva-core";
// @ts-expect-error — vendored 정본 JS 스냅샷(타입 없음). in-repo 기준으로 실시간 대조.
import * as canon from "./canonical/nva-core.reference.mjs";
import golden from "./fixtures/nva-golden.json";

/**
 * ★codex P0 리뷰 C2 — **CI 자립 divergence 가드**. 정적 골든(nva-golden.json)은 재생성 누락 시 stale
 * 가능하지만, 이 테스트는 매 실행 **벤더 정본 JS(canonical/nva-core.reference.mjs)** 와 **벤더 TS(nva-core.ts)**
 * 를 같은 픽스처에 실시간으로 돌려 대조하므로 stale 될 수 없다(둘 다 테스트 시점 계산). 크로스레포 의존 0.
 * (정본 SoT=naia-video-avatar/src/main/nva-core.js. 그 스냅샷 vs 정본 drift 는 upstream 재복사 시 검출.)
 */
type CanonMod = {
	derive: (m: NvaManifest) => {
		idleKey: string | null;
		talkKey: string | null;
		events: Record<string, string>;
	};
	animKind: (a: unknown) => string;
	isTransition: (a: unknown) => boolean;
};
const C = canon as unknown as CanonMod;
const fixtures = (golden as { fixtures: Record<string, NvaManifest> }).fixtures;

describe("nva-core 벤더 TS ↔ 벤더 정본 JS 실시간 divergence 가드", () => {
	for (const [name, m] of Object.entries(fixtures)) {
		it(`${name}: derive 가 정본 JS 와 동일`, () => {
			const ts = derive(m);
			const js = C.derive(m);
			expect(ts.idleKey).toBe(js.idleKey);
			expect(ts.talkKey).toBe(js.talkKey);
			expect(ts.events).toEqual(js.events);
		});
		it(`${name}: animKind/isTransition 가 정본 JS 와 동일`, () => {
			for (const a of Object.values(m.animations)) {
				expect(animKind(a)).toBe(C.animKind(a));
				expect(isTransition(a)).toBe(C.isTransition(a));
			}
		});
	}
});
