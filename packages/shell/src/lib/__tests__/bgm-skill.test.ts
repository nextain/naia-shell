// UC8 / FR-BGM.1 — skill_youtube_bgm 앱 도구 단위 테스트 (deps 주입 = 사이드카/Tauri 헤르메틱).
// 위젯(BgmPlayer) 리스너가 소비하는 bgm_youtube_* payload 형상이 계약이다.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapYoutubeSearchVideo } from "../../../../bgm-sidecar/src/youtube-server";
import { createBgmPlaybackPort } from "../bgm-playback";
import {
	BGM_ACTIONS,
	type BgmSearchResult,
	type BgmSkillDeps,
	SKILL_YOUTUBE_BGM,
	cancelRadioDjRecovery,
	clampVolume,
	continueRadioDjRecoveryAfterQueueAdvance,
	executeBgmSkill,
	filterSingleTrackCandidates,
	getBgmRecentTracks,
	normalizeBgmTitle,
	recordBgmPlayedTrack,
	recoverRadioDjPlayback,
	sanitizeRadioDjSearchQuery,
	shouldActivateRadioDj,
	waitForBgmObservedPlayback,
} from "../bgm-skill";

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
		favoriteCount: () => 1,
	};
	return { deps, emitted, searched };
}

beforeEach(() => cancelRadioDjRecovery());

describe("SKILL_YOUTUBE_BGM descriptor (계약)", () => {
	it("name/required/tier — App.tsx auto-allow(skill_youtube_bgm)와 일치, tier 0", () => {
		expect(SKILL_YOUTUBE_BGM.name).toBe("skill_youtube_bgm");
		expect(SKILL_YOUTUBE_BGM.parameters?.required).toEqual(["action"]);
		expect(SKILL_YOUTUBE_BGM.tier).toBe(0);
		const actionProp = SKILL_YOUTUBE_BGM.parameters?.properties?.action as {
			enum?: string[];
		};
		expect(actionProp.enum).toEqual([...BGM_ACTIONS]);
		const modeProp = SKILL_YOUTUBE_BGM.parameters?.properties?.mode as {
			enum?: string[];
			description?: string;
		};
		expect(modeProp.enum).toEqual(["player", "radio_dj"]);
		expect(modeProp.description).toContain("Semantic intent");
	});
});

describe("Radio DJ semantic mode boundary", () => {
	it("activates only from the LLM's structured radio_dj play choice", () => {
		expect(shouldActivateRadioDj({ action: "play", mode: "radio_dj" })).toBe(
			true,
		);
		expect(shouldActivateRadioDj({ action: "play", mode: "player" })).toBe(
			false,
		);
		expect(shouldActivateRadioDj({ action: "status", mode: "radio_dj" })).toBe(
			false,
		);
		expect(
			shouldActivateRadioDj({ action: "play", query: "라디오 DJ 해줘" }),
		).toBe(false);
	});

	it("replaces an active ordinary track and selects a fresh search result", async () => {
		const { deps, emitted } = mkDeps([
			{ id: "current", title: "Current Song", duration: "3:20" },
			{ id: "fresh", title: "Fresh Song", duration: "3:40" },
		]);
		await executeBgmSkill(
			{ action: "play", videoId: "current", title: "Current Song" },
			deps,
		);
		const result = JSON.parse(
			await executeBgmSkill(
				{ action: "play", query: "same mood", mode: "radio_dj" },
				deps,
			),
		);

		expect(result).not.toHaveProperty("selected");
		expect(deps.playback.current()?.selected.videoId).toBe("fresh");
		expect(deps.playback.queue()).toEqual([]);
		expect(emitted.at(-1)).toMatchObject({
			type: "bgm_youtube_play",
			videoId: "fresh",
		});
	});

	it("does not silently repeat when every automatic candidate is recent", async () => {
		const { deps, emitted } = mkDeps([
			{ id: "recent-id", title: "Recent Song" },
			{ id: "mirror", title: "Recent Song (Official Video)" },
		]);
		deps.recentTracks = () => [
			{ id: "recent-id", title: "Recent Song", playedAt: 1 },
		];

		expect(
			JSON.parse(
				await executeBgmSkill(
					{ action: "play", query: "same mood", mode: "radio_dj" },
					deps,
				),
			),
		).toEqual({
			ok: false,
			action: "play",
			reason: "no_fresh_search_results",
			query: "same mood",
		});
		expect(emitted).toEqual([]);
	});
});

describe("Radio DJ bounded playback recovery", () => {
	it("searches a fresh candidate after an unavailable DJ track", async () => {
		const emitted: Record<string, unknown>[] = [];
		let searchCall = 0;
		const deps: BgmSkillDeps = {
			search: async () => {
				searchCall += 1;
				return searchCall === 1
					? [{ id: "failed", title: "Unavailable Song", duration: "3:15" }]
					: [
							{ id: "mirror", title: "Unavailable Song (Official Video)", duration: "3:15" },
							{ id: "recovered", title: "Fresh Recovery", duration: "3:30" },
						];
			},
			emitBgm: async (payload) => {
				emitted.push(payload);
			},
			playback: createBgmPlaybackPort(),
		};
		await executeBgmSkill(
			{ action: "play", query: "night jazz", mode: "radio_dj" },
			deps,
		);
		const failed = deps.playback.current();
		expect(failed).not.toBeNull();
		deps.playback.observe({
			playbackId: failed?.playbackId ?? "",
			sequence: 2,
			status: "error",
		});

		const recovered = await recoverRadioDjPlayback(failed?.playbackId ?? "");

		expect(recovered).toMatchObject({
			recovered: true,
			selected: { id: "recovered" },
		});
		expect(searchCall).toBe(2);
		expect(emitted.at(-1)).toMatchObject({
			type: "bgm_youtube_play",
			videoId: "recovered",
			recovery: "radio_dj_search",
		});
		expect(deps.playback.current()?.selected.videoId).toBe("recovered");
	});

	it("continues the recovery session after a prepared queue is exhausted", async () => {
		let searchCall = 0;
		const deps: BgmSkillDeps = {
			search: async () => {
				searchCall += 1;
				return searchCall === 1
					? [{ id: "first", title: "First Candidate", duration: "3:10" }]
					: [{ id: "dynamic", title: "Dynamic Candidate", duration: "3:25" }];
			},
			emitBgm: async () => {},
			playback: createBgmPlaybackPort(),
		};
		await executeBgmSkill(
			{ action: "play", query: "focus", mode: "radio_dj" },
			deps,
		);
		await executeBgmSkill(
			{ action: "play", videoId: "prepared", title: "Prepared Candidate" },
			deps,
		);
		const first = deps.playback.current();
		deps.playback.observe({
			playbackId: first?.playbackId ?? "",
			sequence: 2,
			status: "error",
		});
		const prepared = deps.playback.advance();
		expect(prepared?.selected.videoId).toBe("prepared");
		continueRadioDjRecoveryAfterQueueAdvance(
			first?.playbackId ?? "",
			prepared?.playbackId ?? "",
		);
		deps.playback.observe({
			playbackId: prepared?.playbackId ?? "",
			sequence: 2,
			status: "error",
		});

		const recovered = await recoverRadioDjPlayback(prepared?.playbackId ?? "");
		expect(recovered).toMatchObject({
			recovered: true,
			selected: { id: "dynamic" },
		});
	});

	it("stops after two searches when every result is already attempted", async () => {
		let searchCall = 0;
		const deps: BgmSkillDeps = {
			search: async () => {
				searchCall += 1;
				return [{ id: "same", title: "Same Song", duration: "3:20" }];
			},
			emitBgm: async () => {},
			playback: createBgmPlaybackPort(),
		};
		await executeBgmSkill(
			{ action: "play", query: "repeat", mode: "radio_dj" },
			deps,
		);
		const failed = deps.playback.current();
		deps.playback.observe({
			playbackId: failed?.playbackId ?? "",
			sequence: 2,
			status: "error",
		});

		expect(await recoverRadioDjPlayback(failed?.playbackId ?? "")).toEqual({
			recovered: false,
			reason: "exhausted",
			searches: 2,
		});
		expect(searchCall).toBe(3);
		expect(await recoverRadioDjPlayback(failed?.playbackId ?? "")).toEqual({
			recovered: false,
			reason: "not_active",
			searches: 0,
		});
	});

	it("does not apply a delayed recovery after stop", async () => {
		let releaseSearch: ((results: BgmSearchResult[]) => void) | undefined;
		let searchCall = 0;
		const emitted: Record<string, unknown>[] = [];
		const deps: BgmSkillDeps = {
			search: async () => {
				searchCall += 1;
				if (searchCall === 1) return [{ id: "failed", title: "Failed", duration: "3:15" }];
				return new Promise<BgmSearchResult[]>((resolve) => {
					releaseSearch = resolve;
				});
			},
			emitBgm: async (payload) => {
				emitted.push(payload);
			},
			playback: createBgmPlaybackPort(),
		};
		await executeBgmSkill(
			{ action: "play", query: "late", mode: "radio_dj" },
			deps,
		);
		const failed = deps.playback.current();
		deps.playback.observe({
			playbackId: failed?.playbackId ?? "",
			sequence: 2,
			status: "error",
		});
		const recovery = recoverRadioDjPlayback(failed?.playbackId ?? "");
		await vi.waitFor(() => expect(releaseSearch).toBeTypeOf("function"));
		await executeBgmSkill({ action: "stop" }, deps);
		releaseSearch?.([{ id: "must-not-play", title: "Must Not Play", duration: "3:15" }]);

		expect(await recovery).toMatchObject({
			recovered: false,
			reason: "cancelled",
		});
		expect(emitted.map((event) => event.type)).toEqual([
			"bgm_youtube_play",
			"bgm_youtube_stop",
		]);
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

	it("replaces the active track for an activity-owned play request", async () => {
		const { deps, emitted } = mkDeps();
		await executeBgmSkill(
			{ action: "play", videoId: "first", title: "First" },
			deps,
		);
		const replacement = JSON.parse(
			await executeBgmSkill(
				{
					action: "play",
					videoId: "second",
					title: "Second",
					replace: true,
				},
				deps,
			),
		);

		expect(replacement).toMatchObject({
			playback: { status: "requested" },
		});
		expect(replacement).not.toHaveProperty("selected");
		expect(emitted.map((event) => event.type)).toEqual([
			"bgm_youtube_play",
			"bgm_youtube_play",
		]);
		expect(deps.playback.current()?.selected.videoId).toBe("second");
		expect(deps.playback.queue()).toEqual([]);
	});

	it("play acknowledgement can leave requested once the player observes playing", async () => {
		const { deps } = mkDeps();
		deps.waitForAck = async (playbackId) => {
			deps.playback.observe({
				playbackId,
				sequence: 2,
				status: "playing",
			});
			return deps.playback.current();
		};
		const out = JSON.parse(
			await executeBgmSkill(
				{ action: "play", videoId: "ack", title: "Ack", replace: true },
				deps,
			),
		);
		expect(out.playback.status).toBe("playing");
		expect(out.announceTrack).toBe(true);
		expect(out.currentTrack).toEqual({ videoId: "ack", title: "Ack" });
	});

	it("skips the current first search result for an activity-owned replacement", async () => {
		const { deps, emitted } = mkDeps([
			{ id: "first", title: "Repeated result" },
			{ id: "second", title: "Fresh result" },
		]);
		await executeBgmSkill(
			{ action: "play", videoId: "first", title: "Current" },
			deps,
		);

		const replacement = JSON.parse(
			await executeBgmSkill(
				{ action: "play", query: "next mood", replace: true },
				deps,
			),
		);

		expect(replacement).not.toHaveProperty("selected");
		expect(deps.playback.current()?.selected.videoId).toBe("second");
		expect(emitted.at(-1)).toMatchObject({
			type: "bgm_youtube_play",
			videoId: "second",
		});
	});

	it("skips recently played ids and normalized duplicate titles", async () => {
		const { deps } = mkDeps([
			{ id: "recent-id", title: "Song A" },
			{ id: "mirror-upload", title: "Song B (Official Video)" },
			{ id: "fresh-id", title: "Song C" },
		]);
		deps.recentTracks = () => [
			{ id: "recent-id", title: "Song A", playedAt: 1 },
			{ id: "older-upload", title: "Song B", playedAt: 2 },
		];

		const replacement = JSON.parse(
			await executeBgmSkill(
				{ action: "play", query: "similar", replace: true },
				deps,
			),
		);

		expect(replacement).not.toHaveProperty("selected");
		expect(deps.playback.current()?.selected.videoId).toBe("fresh-id");
	});

	it("adds/removes the current track and starts a non-current favorite", async () => {
		const { deps, emitted } = mkDeps();
		await executeBgmSkill(
			{ action: "play", videoId: "current", title: "Current" },
			deps,
		);
		await executeBgmSkill({ action: "favorite_add" }, deps);
		await executeBgmSkill({ action: "favorite_remove" }, deps);
		deps.favoriteTracks = () => [
			{ id: "current", title: "Current" },
			{ id: "favorite-2", title: "Favorite Two" },
		];
		const favorite = JSON.parse(
			await executeBgmSkill({ action: "favorites_play" }, deps),
		);

		expect(emitted.slice(1, 3)).toEqual([
			{ type: "bgm_youtube_fav_add" },
			{ type: "bgm_youtube_fav_remove" },
		]);
		expect(favorite).not.toHaveProperty("selected");
		expect(deps.playback.current()?.selected.videoId).toBe("favorite-2");
		expect(deps.playback.queue()).toEqual([]);
	});

	it("returns explicit failures for favorite actions without usable tracks", async () => {
		const { deps, emitted } = mkDeps();
		expect(
			JSON.parse(await executeBgmSkill({ action: "favorite_add" }, deps)),
		).toEqual({
			ok: false,
			action: "favorite_add",
			reason: "no_current_track",
		});
		deps.favoriteTracks = () => [];
		expect(
			JSON.parse(await executeBgmSkill({ action: "favorites_play" }, deps)),
		).toEqual({
			ok: false,
			action: "favorites_play",
			reason: "no_favorites",
		});
		expect(emitted).toEqual([]);
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
				playbackId: "bgm-playback-1",
				videoId: "v1",
				title: "Lofi Beats",
				thumbnail: "http://t/1.jpg",
			},
		]);
		expect(JSON.parse(out)).toMatchObject({
			ok: true,
			action: "play",
			playback: { status: "requested", sequence: 1 },
			announceTrack: false,
		});
		expect(JSON.parse(out)).not.toHaveProperty("selected");
	});

	it("play+videoId → 검색 없이 직접 재생", async () => {
		const { deps, emitted, searched } = mkDeps();
		const out = await executeBgmSkill(
			{ action: "play", videoId: "abc123", title: "직접곡" },
			deps,
		);
		expect(searched).toEqual([]); // 검색 미호출
		expect(emitted).toEqual([
			{
				type: "bgm_youtube_play",
				playbackId: "bgm-playback-1",
				videoId: "abc123",
				title: "직접곡",
			},
		]);
		expect(JSON.parse(out)).toMatchObject({
			ok: true,
			action: "play",
			playback: { status: "requested", sequence: 1 },
			announceTrack: false,
		});
		expect(JSON.parse(out)).not.toHaveProperty("selected");
	});

	it("status returns observed iframe playback without emitting a command", async () => {
		let now = 1_000;
		const playback = createBgmPlaybackPort(() => now);
		const { deps, emitted } = mkDeps();
		deps.playback = playback;
		deps.now = () => now;
		deps.recentTracks = () => [
			{ id: "old-1", title: "Old Track", playedAt: 900 },
		];
		deps.favoriteTracks = () => [{ id: "fav-1", title: "Favorite Track" }];
		const requested = playback.request({ videoId: "v1", title: "Track A" });
		playback.observe({
			playbackId: requested.playbackId,
			sequence: 2,
			status: "playing",
		});

		const playing = JSON.parse(
			await executeBgmSkill({ action: "status" }, deps),
		);
		expect(playing).toMatchObject({
			ok: true,
			action: "status",
			playback: {
				playbackId: requested.playbackId,
				status: "playing",
				sequence: 2,
			},
			currentTrack: { videoId: "v1", title: "Track A" },
			announceTrack: true,
			recentTracks: [{ videoId: "old-1", title: "Old Track" }],
			favoriteTracks: [{ videoId: "fav-1", title: "Favorite Track" }],
		});
		expect(emitted).toEqual([]);

		now += 1;
		playback.observe({
			playbackId: requested.playbackId,
			sequence: 3,
			status: "ended",
		});
		const ended = JSON.parse(await executeBgmSkill({ action: "status" }, deps));
		expect(ended).toMatchObject({
			ok: true,
			action: "status",
			playback: {
				playbackId: requested.playbackId,
				status: "ended",
				sequence: 3,
			},
			currentTrack: null,
			announceTrack: false,
		});
		expect(emitted).toEqual([]);
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
				throw new Error("BGM search server error (HTTP 503)");
			},
			emitBgm: async () => {},
			playback: createBgmPlaybackPort(),
		};
		await expect(
			executeBgmSkill({ action: "play", query: "x" }, deps),
		).rejects.toThrow("BGM search server error (HTTP 503)");
	});

	it("stop/pause/resume/next/prev → 위젯 리스너 타입 1:1 이벤트", async () => {
		for (const action of ["stop", "pause", "resume"] as const) {
			const { deps, emitted } = mkDeps();
			const out = await executeBgmSkill({ action }, deps);
			expect(emitted).toEqual([{ type: `bgm_youtube_${action}` }]);
			expect(JSON.parse(out)).toEqual({ ok: true, action });
		}
		for (const action of ["next", "prev"] as const) {
			const { deps, emitted } = mkDeps();
			const out = JSON.parse(await executeBgmSkill({ action }, deps));
			expect(emitted).toEqual([{ type: `bgm_youtube_${action}` }]);
			expect(out).toMatchObject({
				ok: false,
				action,
				reason: "no_next_track",
				announceTrack: false,
				currentTrack: null,
			});
		}
	});

	it("routes next/prev to the active playlist regardless of the likes count and advances queued tracks", async () => {
		for (const action of ["next", "prev"] as const) {
			const { deps, emitted } = mkDeps();
			deps.favoriteCount = () => 0;
			const out = JSON.parse(await executeBgmSkill({ action }, deps));
			expect(out).toMatchObject({
				ok: false,
				action,
				reason: "no_next_track",
				announceTrack: false,
			});
			expect(emitted).toEqual([{ type: `bgm_youtube_${action}` }]);
		}

		const { deps } = mkDeps();
		await executeBgmSkill(
			{ action: "play", videoId: "first", title: "First" },
			deps,
		);
		await executeBgmSkill(
			{ action: "play", videoId: "second", title: "Second" },
			deps,
		);
		const advanced = JSON.parse(await executeBgmSkill({ action: "next" }, deps));
		expect(advanced).toMatchObject({
			ok: true,
			action: "next",
			pendingTrack: {
				videoId: "second",
				title: "Second",
				confirmed: false,
			},
		});
	});

	it("filters long mixes into single tracks and pre-queues upcoming candidates in radio_dj mode", async () => {
		const { deps } = mkDeps([
			{ id: "mix-1h", title: "Relaxing Jazz 2 Hours Playlist", duration: "2:00:00" },
			{ id: "song-1", title: "Autumn Leaves", duration: "3:42" },
			{ id: "song-2", title: "Blue in Green", duration: "4:15" },
			{ id: "song-3", title: "Misty", duration: "3:18" },
		]);

		await executeBgmSkill(
			{ action: "play", query: "저녁 재즈", mode: "radio_dj" },
			deps,
		);

		expect(deps.playback.current()?.selected).toEqual({
			videoId: "song-1",
			title: "Autumn Leaves",
		});
		expect(deps.playback.queue().map((item) => item.selected.videoId)).toEqual([
			"song-2",
			"song-3",
		]);
	});

	it("sanitizes habitual playlist/radio keywords in radio_dj mode and excludes live streams", async () => {
		let capturedQuery = "";
		const { deps } = mkDeps([
			{ id: "live-1", title: "24/7 Chill Pop Radio", duration: "" },
			{ id: "pl-1", title: "감성 팝송 플레이리스트 모음", duration: "1:45:00" },
			{ id: "single-1", title: "Lauv - Paris in the Rain (Official Audio)", duration: "3:25" },
			{ id: "single-2", title: "Jeremy Zucker - comethru (Official Audio)", duration: "3:01" },
		]);
		const origSearch = deps.search;
		deps.search = async (q) => {
			capturedQuery = q;
			return origSearch(q);
		};

		await executeBgmSkill(
			{
				action: "play",
				query: "잔잔한 감성 팝 라디오 플레이리스트",
				mode: "radio_dj",
			},
			deps,
		);

		expect(capturedQuery).toBe("잔잔한 감성 팝 song Official Audio");
		expect(deps.playback.current()?.selected.videoId).toBe("single-1");
		expect(deps.playback.queue().map((item) => item.selected.videoId)).toEqual([
			"single-2",
		]);
	});

	it("preserves an active user-chosen song when preserveActive is set in radio_dj mode", async () => {
		const { deps, emitted } = mkDeps([
			{ id: "dj-1", title: "DJ Track 1", duration: "3:20" },
			{ id: "dj-2", title: "DJ Track 2", duration: "2:55" },
		]);
		const userReq = deps.playback.request({
			videoId: "user-gangnam",
			title: "PSY - GANGNAM STYLE",
		});
		deps.playback.observe({
			playbackId: userReq.playbackId,
			sequence: 2,
			status: "playing",
		});

		const out = JSON.parse(
			await executeBgmSkill(
				{
					action: "play",
					query: "신나는 가요",
					mode: "radio_dj",
					preserveActive: true,
				},
				deps,
			),
		);

		expect(out).toMatchObject({
			ok: true,
			action: "play",
			preservedActive: true,
			announceTrack: true,
			currentTrack: {
				videoId: "user-gangnam",
				title: "PSY - GANGNAM STYLE",
			},
		});
		expect(deps.playback.current()?.selected.videoId).toBe("user-gangnam");
		expect(deps.playback.queue().map((item) => item.selected.videoId)).toEqual([
			"dj-1",
			"dj-2",
		]);
		expect(emitted.map((e) => e.type)).toEqual([
			"bgm_youtube_enqueue",
			"bgm_youtube_enqueue",
		]);
	});

	it("does not treat a timed-out track as active when preserveActive is set in radio_dj mode", async () => {
		const { deps, emitted } = mkDeps([
			{ id: "fresh-1", title: "Fresh Song 1", duration: "3:20" },
			{ id: "fresh-2", title: "Fresh Song 2", duration: "3:05" },
		]);
		const timedOut = deps.playback.request({
			videoId: "stalled-track",
			title: "Stalled Track",
		});
		deps.playback.observe({
			playbackId: timedOut.playbackId,
			sequence: 2,
			status: "timeout",
			reason: "iframe_playing_not_observed",
		});

		await executeBgmSkill(
			{
				action: "play",
				query: "집중 재즈",
				mode: "radio_dj",
				preserveActive: true,
			},
			deps,
		);

		expect(deps.playback.current()?.selected.videoId).toBe("fresh-1");
		expect(emitted[0]).toMatchObject({
			type: "bgm_youtube_play",
			videoId: "fresh-1",
		});
	});

	it("filters multi-digit hour mixes (10 hours, 24시간, 12 hrs), live/radio/24-7 streams, and durationless candidates unless explicitly requested", () => {
		const candidates: BgmSearchResult[] = [
			{ id: "mix-10h", title: "Relaxing Jazz Piano 10 hours", duration: "3:30" },
			{ id: "mix-24kr", title: "비 오는 날 카페 음악 24시간 연속", duration: "3:40" },
			{ id: "mix-12hrs", title: "Study Beats 12 hrs Nonstop", duration: "3:20" },
			{ id: "live-radio", title: "lofi hip hop radio - beats to relax/study to", duration: "3:30" },
			{ id: "live-kr", title: "서울 야경 재즈 라이브 생방송", duration: "3:30" },
			{ id: "no-dur", title: "Durationless Stream", duration: "" },
			{ id: "single-ok", title: "백예린 - Square (2017)", duration: "4:12" },
			{ id: "short-3m", title: "짧은 피아노 소품곡", duration: "3:05" },
		];

		expect(
			filterSingleTrackCandidates(candidates, "잔잔한 카페 음악").map((c) => c.id),
		).toEqual(["single-ok", "short-3m"]);

		// SHORT_TRACK_QUERY_RE: "3분" 류 짧은 곡 요청은 210초(3분 30초) 이하 후보만 남긴다
		expect(
			filterSingleTrackCandidates(candidates, "3분 짧은 피아노 곡").map((c) => c.id),
		).toEqual(["short-3m"]);

		// EXPLICIT_LONG_MIX_QUERY_RE: "hrs", "24/7" 등 사용자가 명시 요청한 경우에는 필터링하지 않는다
		expect(sanitizeRadioDjSearchQuery("lofi 12 hrs mix")).toBe("lofi 12 hrs mix");
		expect(sanitizeRadioDjSearchQuery("24/7 chill radio")).toBe("24/7 chill radio");
		expect(
			filterSingleTrackCandidates(candidates, "lofi 12 hrs").map((c) => c.id),
		).toHaveLength(candidates.length);
		expect(
			filterSingleTrackCandidates(candidates, "24/7 chill stream").map((c) => c.id),
		).toHaveLength(candidates.length);
	});

	it("returns ok:false (no_single_track_candidates) with searchQuery and rejectedCounts after one single-track hint retry when all candidates are filtered out (FR-RADIO-DJ.14·16)", async () => {
		const { deps, emitted, searched } = mkDeps([
			{ id: "live-only", title: "lofi hip hop radio - beats to relax/study to", duration: "" },
			{ id: "mix-only", title: "10 hours chill jazz playlist", duration: "10:00:00" },
			{ id: "no-dur", title: "Unknown Duration Song", duration: "" },
			{ id: "too-long", title: "Extended Instrumental Version", duration: "7:31" },
			{ id: "too-short", title: "Intro Teaser", duration: "0:25" },
		]);

		const out = JSON.parse(
			await executeBgmSkill(
				{
					action: "play",
					query: "잔잔한 로파이",
					mode: "radio_dj",
				},
				deps,
			),
		);

		expect(searched).toEqual([
			"잔잔한 로파이 song Official Audio",
			"잔잔한 로파이 single track Official MV",
		]);
		expect(out).toEqual({
			ok: false,
			action: "play",
			reason: "no_single_track_candidates",
			query: "잔잔한 로파이",
			searchQuery: "잔잔한 로파이 song Official Audio",
			retrySearchQuery: "잔잔한 로파이 single track Official MV",
			rejectedCounts: {
				mix_title: 2,
				no_duration: 1,
				too_long: 1,
				too_short: 1,
			},
		});
		expect(emitted).toEqual([]);
	});

	it("retries once with an English single-track hint when the first mood search is all mixes and succeeds if the retry finds a single track", async () => {
		const searched: string[] = [];
		const emitted: Record<string, unknown>[] = [];
		const deps: BgmSkillDeps = {
			search: async (q) => {
				searched.push(q);
				if (searched.length === 1) {
					return [
						{
							id: "mix-1",
							title: "오후에 듣기 좋은 감성 노래 모음 플레이리스트",
							duration: "1:20:00",
						},
					];
				}
				return [
					{
						id: "single-ok",
						title: "Paul Kim - Every Day, Every Moment (Official Audio)",
						duration: "3:56",
					},
				];
			},
			emitBgm: async (payload) => {
				emitted.push(payload);
			},
			playback: createBgmPlaybackPort(),
		};

		const out = JSON.parse(
			await executeBgmSkill(
				{
					action: "play",
					query: "오후 듣기 좋은 감성 노래",
					mode: "radio_dj",
				},
				deps,
			),
		);

		expect(searched).toEqual([
			"오후 듣기 좋은 감성 노래",
			"오후 듣기 좋은 감성 노래 single track Official Audio",
		]);
		expect(out.ok).toBe(true);
		expect(deps.playback.current()?.selected.videoId).toBe("single-ok");
		expect(emitted).toHaveLength(1);
	});

	it("excludes alternate uploads of the same song (밤편지 4 variants) from the queue and recent-track filter (FR-RADIO-DJ.14)", async () => {
		const { deps } = mkDeps([
			{
				id: "iu-1",
				title: "Through the Night (밤편지)",
				duration: "4:13",
			},
			{
				id: "iu-2",
				title: "아이유(IU) - 밤편지 [가사/Lyrics]",
				duration: "4:14",
			},
			{
				id: "iu-3",
				title: "[MV] IU(아이유) _ Through the Night(밤편지)",
				duration: "4:45",
			},
			{
				id: "iu-4",
				title: "아이유 - 밤편지 [유희열의 스케치북/You Heeyeol’s Sketchbook] | KBS 200918 방송",
				duration: "4:20",
			},
		]);

		await executeBgmSkill(
			{ action: "play", query: "아이유 밤편지", mode: "radio_dj" },
			deps,
		);

		expect(deps.playback.current()?.selected.videoId).toBe("iu-1");
		expect(deps.playback.queue()).toEqual([]);
	});

	it("excludes mixes and >450s videos (e.g. 451s 힐링음악) from both primary selection and the pre-queue (FR-RADIO-DJ.14)", async () => {
		const { deps } = mkDeps([
			{
				id: "valid-1",
				title: "AKMU - How can I love the heartbreak, you're the one I love",
				duration: "4:50",
			},
			{
				id: "healing-451",
				title: "🎧4K🌳나홀로나무에서 듣는 감성촉촉 어쿠스틱 팝송 힐링음악 Emotional pop song,Relaxing Music, Stress Relief, Meditation Music",
				duration: "451",
			},
			{
				id: "over-450",
				title: "Long Acoustic Ballad Session",
				duration: "7:31",
			},
			{
				id: "mix-title",
				title: "Relaxing Music for Stress Relief",
				duration: "3:40",
			},
		]);

		await executeBgmSkill(
			{ action: "play", query: "어쿠스틱 감성 노래", mode: "radio_dj" },
			deps,
		);

		expect(deps.playback.current()?.selected.videoId).toBe("valid-1");
		expect(deps.playback.queue()).toEqual([]);
	});

	it("reports queuedCount:0 and nextPrepared:false when preserveActive finds 0 single-track candidates while keeping the active user song playing (FR-RADIO-DJ.5·11)", async () => {
		const { deps, emitted, searched } = mkDeps([
			{
				id: "mix-only",
				title: "오후에 듣기 좋은 감성 노래 모음 플레이리스트",
				duration: "1:15:00",
			},
			{
				id: "over-450",
				title: "힐링음악 Relaxing Music",
				duration: "451",
			},
		]);
		const userReq = deps.playback.request({
			videoId: "user-gangnam",
			title: "PSY - GANGNAM STYLE",
		});
		deps.playback.observe({
			playbackId: userReq.playbackId,
			sequence: 2,
			status: "playing",
		});

		const out = JSON.parse(
			await executeBgmSkill(
				{
					action: "play",
					query: "오후 듣기 좋은 감성 노래",
					mode: "radio_dj",
					preserveActive: true,
				},
				deps,
			),
		);

		expect(searched).toEqual([
			"오후 듣기 좋은 감성 노래",
			"오후 듣기 좋은 감성 노래 single track Official Audio",
		]);
		expect(out).toMatchObject({
			ok: true,
			action: "play",
			preservedActive: true,
			queuedCount: 0,
			nextPrepared: false,
			rejectedCounts: {
				mix_title: 2,
				no_duration: 0,
				too_long: 0,
				too_short: 0,
			},
			currentTrack: {
				videoId: "user-gangnam",
				title: "PSY - GANGNAM STYLE",
			},
		});
		expect(deps.playback.current()?.selected.videoId).toBe("user-gangnam");
		expect(deps.playback.queue()).toEqual([]);
		expect(emitted).toEqual([]);
	});

	it("pins the bgm-sidecar mapYoutubeSearchVideo duration field shape with filterSingleTrackCandidates", () => {
		const sidecarMapped = [
			mapYoutubeSearchVideo({
				id: "yt-live",
				title: { text: "Lofi Live Stream" },
				duration: { text: undefined, seconds: 0 },
				thumbnails: [{ url: "https://i.ytimg.com/vi/yt-live/hqdefault.jpg" }],
				author: { name: "Chilled" },
			}),
			mapYoutubeSearchVideo({
				id: "yt-single-text",
				title: { text: "AKMU - Love Lee (Official Audio)" },
				duration: { text: "3:00", seconds: 180 },
				thumbnails: [{ url: "https://i.ytimg.com/vi/yt-single-text/hqdefault.jpg" }],
				author: { name: "AKMU" },
			}),
			mapYoutubeSearchVideo({
				id: "yt-single-sec",
				title: "IU - Through the Night",
				duration: { seconds: 253 },
				thumbnail: [{ url: "https://i.ytimg.com/vi/yt-single-sec/hqdefault.jpg" }],
				channel: { name: "IU Official" },
			}),
		];

		expect(sidecarMapped[0]?.duration).toBe("");
		expect(sidecarMapped[1]?.duration).toBe("3:00");
		expect(sidecarMapped[2]?.duration).toBe("253");

		expect(
			filterSingleTrackCandidates(sidecarMapped, "감성 가요").map((c) => c.id),
		).toEqual(["yt-single-text", "yt-single-sec"]);
	});

	it("next returns the newly observed track when waitForNavigateAck confirms playing", async () => {
		const { deps, emitted } = mkDeps();
		await executeBgmSkill(
			{ action: "play", videoId: "first", title: "First" },
			deps,
		);
		const previousId = deps.playback.current()?.playbackId;
		deps.waitForNavigateAck = async () => {
			const next = deps.playback.request({
				videoId: "local:/music/two.mp3",
				title: "Two",
			});
			return (
				deps.playback.observe({
					playbackId: next.playbackId,
					sequence: 2,
					status: "playing",
				}) ?? next
			);
		};
		const out = JSON.parse(await executeBgmSkill({ action: "next" }, deps));
		expect(emitted.at(-1)).toEqual({ type: "bgm_youtube_next" });
		expect(out).toMatchObject({
			ok: true,
			action: "next",
			announceTrack: true,
			currentTrack: { videoId: "local:/music/two.mp3", title: "Two" },
		});
		expect(out.playback.playbackId).not.toBe(previousId);
	});

	it("waitForBgmObservedPlayback ignores loading and waits for playing", async () => {
		const playback = createBgmPlaybackPort();
		const requested = playback.request({ videoId: "a", title: "A" });
		playback.observe({
			playbackId: requested.playbackId,
			sequence: 2,
			status: "loading",
		});
		let t = 0;
		const pending = waitForBgmObservedPlayback(playback, {
			playbackId: requested.playbackId,
			timeoutMs: 1_000,
			pollMs: 200,
			now: () => t,
			sleep: async (ms) => {
				t += ms;
				if (t >= 200) {
					playback.observe({
						playbackId: requested.playbackId,
						sequence: 3,
						status: "playing",
					});
				}
			},
		});
		expect((await pending)?.status).toBe("playing");
	});

	it("keeps likes and playlist operations as distinct actions", async () => {
		const { deps, emitted } = mkDeps();
		await executeBgmSkill({ action: "play", videoId: "current", title: "Current" }, deps);
		await executeBgmSkill({ action: "like_add" }, deps);
		await executeBgmSkill({ action: "playlist_create", name: "Focus" }, deps);
		await executeBgmSkill({ action: "playlist_add_current", playlistId: "focus" }, deps);
		expect(emitted.slice(1)).toEqual([
			{ type: "bgm_library_like_add" },
			{ type: "bgm_playlist_create", name: "Focus" },
			{ type: "bgm_playlist_add_current", playlistId: "focus" },
		]);
	});

	it("routes playlist play, shuffle, and repeat with normalized arguments", async () => {
		const { deps, emitted } = mkDeps();
		expect(JSON.parse(await executeBgmSkill({ action: "playlist_play", playlistId: "p1", index: 2 }, deps))).toMatchObject({ ok: true, pending: true });
		await executeBgmSkill({ action: "shuffle", enabled: false }, deps);
		await executeBgmSkill({ action: "repeat", repeat: "one" }, deps);
		expect(emitted).toEqual([
			{ type: "bgm_playlist_play", playlistId: "p1", index: 2 },
			{ type: "bgm_playlist_shuffle", enabled: false },
			{ type: "bgm_playlist_repeat", repeat: "one" },
		]);
	});

	it("returns playlist summaries without treating likes as a playback list", async () => {
		const { deps } = mkDeps();
		deps.library = () => ({ schemaVersion: 1, updatedAt: 1, likes: [], playlists: [{ id: "p1", name: "Focus", tracks: [], createdAt: 1, updatedAt: 1 }], activePlaylistId: "p1", currentIndex: -1, shuffle: true, repeat: "all", queue: [], history: [] });
		const out = JSON.parse(await executeBgmSkill({ action: "playlist_list" }, deps));
		expect(out.library).toMatchObject({ likesCount: 0, activePlaylist: { id: "p1", name: "Focus" }, shuffle: true, repeat: "all" });
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

describe("recent BGM history", () => {
	beforeEach(() => {
		const values = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
			removeItem: (key: string) => values.delete(key),
			clear: () => values.clear(),
		});
	});

	it("normalizes upload decorations and records only one equivalent title", () => {
		localStorage.clear();
		expect(normalizeBgmTitle("Song B (Official Video)")).toBe("song b");
		recordBgmPlayedTrack({ id: "v1", title: "Song B (Official Video)" }, 10);
		recordBgmPlayedTrack({ id: "v2", title: "Song B" }, 20);
		expect(getBgmRecentTracks()).toEqual([
			{ id: "v2", title: "Song B", playedAt: 20 },
		]);
	});

	it("bounds playback history to twenty confirmed entries", () => {
		localStorage.clear();
		for (let index = 0; index < 25; index += 1) {
			recordBgmPlayedTrack(
				{ id: `v-${index}`, title: `Track ${index}` },
				index,
			);
		}
		expect(getBgmRecentTracks()).toHaveLength(20);
		expect(getBgmRecentTracks()[0].id).toBe("v-24");
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
