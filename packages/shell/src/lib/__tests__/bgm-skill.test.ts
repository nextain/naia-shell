// UC8 / FR-BGM.1 — skill_youtube_bgm 패널 도구 단위 테스트 (deps 주입 = 사이드카/Tauri 헤르메틱).
// 위젯(BgmPlayer) 리스너가 소비하는 bgm_youtube_* payload 형상이 계약이다.
import { describe, expect, it } from "vitest";
import {
	BGM_ACTIONS,
	SKILL_YOUTUBE_BGM,
	clampVolume,
	executeBgmSkill,
	type BgmSearchResult,
	type BgmSkillDeps,
} from "../bgm-skill";
import { createBgmPlaybackPort } from "../bgm-playback";

function mkDeps(results: BgmSearchResult[] = []) {
	const emitted: Record<string, unknown>[] = [];
	const searched: string[] = [];
	const deps: BgmSkillDeps = {
		search: async (q) => {
			searched.push(q);
			return results;
		},
		emitBgm: async (p) => {
			emitted.push(p);
		},
		playback: createBgmPlaybackPort(),
	};
	return { deps, emitted, searched };
}

describe("SKILL_YOUTUBE_BGM descriptor (계약)", () => {
	it("name/required/tier — App.tsx auto-allow(skill_youtube_bgm)와 일치, tier 0", () => {
		expect(SKILL_YOUTUBE_BGM.name).toBe("skill_youtube_bgm");
		expect(SKILL_YOUTUBE_BGM.parameters?.required).toEqual(["action"]);
		expect(SKILL_YOUTUBE_BGM.tier).toBe(0);
		const actionProp = SKILL_YOUTUBE_BGM.parameters?.properties?.action as {
			enum?: string[];
		};
		expect(actionProp.enum).toEqual([...BGM_ACTIONS]);
	});
});

describe("executeBgmSkill", () => {
	it("preserves the active track and returns an explicit queued receipt for the next request", async () => {
		const { deps, emitted } = mkDeps();
		const first = JSON.parse(
			await executeBgmSkill(
				{ action: "play", videoId: "first", title: "First" },
				deps,
			),
		);
		const second = JSON.parse(
			await executeBgmSkill(
				{ action: "play", videoId: "second", title: "Second" },
				deps,
			),
		);

		expect(first.playback.status).toBe("requested");
		expect(second).toMatchObject({
			queued: { position: 1, selected: { videoId: "second" } },
			announceTrack: false,
		});
		expect(emitted.map((event) => event.type)).toEqual([
			"bgm_youtube_play",
			"bgm_youtube_enqueue",
		]);
		expect(deps.playback.current()?.selected.videoId).toBe("first");
	});

	it("play+query → 검색 후 첫 결과 재생 (bgm_youtube_play {videoId,title} — 위젯 리스너 형상)", async () => {
		const { deps, emitted, searched } = mkDeps([
			{ id: "v1", title: "Lofi Beats", thumbnail: "http://t/1.jpg" },
			{ id: "v2", title: "Other" },
		]);
		const out = await executeBgmSkill({ action: "play", query: "lofi" }, deps);
		expect(searched).toEqual(["lofi"]);
		expect(emitted).toEqual([
			{
				type: "bgm_youtube_play",
				videoId: "v1",
				title: "Lofi Beats",
				thumbnail: "http://t/1.jpg",
			},
		]);
		expect(JSON.parse(out)).toMatchObject({
			ok: true,
			action: "play",
			playback: { status: "requested", sequence: 1 },
			selected: { videoId: "v1", title: "Lofi Beats" },
			announceTrack: false,
		});
	});

	it("play+videoId → 검색 없이 직접 재생", async () => {
		const { deps, emitted, searched } = mkDeps();
		const out = await executeBgmSkill(
			{ action: "play", videoId: "abc123", title: "직접곡" },
			deps,
		);
		expect(searched).toEqual([]); // 검색 미호출
		expect(emitted).toEqual([
			{ type: "bgm_youtube_play", videoId: "abc123", title: "직접곡" },
		]);
		expect(JSON.parse(out)).toMatchObject({
			ok: true,
			action: "play",
			playback: { status: "requested", sequence: 1 },
			selected: { videoId: "abc123", title: "직접곡" },
			announceTrack: false,
		});
	});

	it("play — query·videoId 둘 다 없음 → throw", async () => {
		const { deps } = mkDeps();
		await expect(executeBgmSkill({ action: "play" }, deps)).rejects.toThrow(
			/query.*videoId|videoId.*query/,
		);
	});

	it("play — 검색 결과 0 → 구조화 실패 (emit 안 함)", async () => {
		const { deps, emitted } = mkDeps([]);
		const out = await executeBgmSkill(
			{ action: "play", query: "없는곡" },
			deps,
		);
		expect(JSON.parse(out)).toEqual({
			ok: false,
			action: "play",
			reason: "no_search_results",
			query: "없는곡",
		});
		expect(emitted).toEqual([]);
	});

	it("play — 사이드카 검색 실패 → reject (dispatch 가 실패로 보고)", async () => {
		const deps: BgmSkillDeps = {
			search: async () => {
				throw new Error("BGM 검색 서버 오류 (HTTP 503)");
			},
			emitBgm: async () => {},
			playback: createBgmPlaybackPort(),
		};
		await expect(
			executeBgmSkill({ action: "play", query: "x" }, deps),
		).rejects.toThrow(/503/);
	});

	it("stop/pause/resume/next/prev → 위젯 리스너 타입 1:1 이벤트", async () => {
		for (const action of ["stop", "pause", "resume", "next", "prev"] as const) {
			const { deps, emitted } = mkDeps();
			const out = await executeBgmSkill({ action }, deps);
			expect(emitted).toEqual([{ type: `bgm_youtube_${action}` }]);
			expect(JSON.parse(out)).toEqual({ ok: true, action });
		}
	});

	it("volume → clamp 후 bgm_youtube_volume", async () => {
		const { deps, emitted } = mkDeps();
		const out = await executeBgmSkill({ action: "volume", volume: 0.3 }, deps);
		expect(emitted).toEqual([{ type: "bgm_youtube_volume", volume: 0.3 }]);
		expect(JSON.parse(out)).toEqual({
			ok: true,
			action: "volume",
			volume: 0.3,
		});
	});

	it("unknown/누락 action → throw", async () => {
		const { deps } = mkDeps();
		await expect(executeBgmSkill({ action: "dance" }, deps)).rejects.toThrow(
			/unknown action/,
		);
		await expect(executeBgmSkill({}, deps)).rejects.toThrow(/unknown action/);
	});
});

describe("clampVolume (도메인 — agent UC8 어댑터 동형)", () => {
	it("범위/비수치 clamp", () => {
		expect(clampVolume(0.7)).toBe(0.7);
		expect(clampVolume(1.5)).toBe(1);
		expect(clampVolume(-0.2)).toBe(0);
		expect(clampVolume("loud")).toBe(0.5);
		expect(clampVolume(Number.NaN)).toBe(0.5);
		expect(clampVolume(undefined)).toBe(0.5);
	});
});
