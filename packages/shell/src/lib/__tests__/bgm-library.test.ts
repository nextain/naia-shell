import { describe, expect, it, vi } from "vitest";
import { addTrackToPlaylist, createEmptyBgmLibrary, createPlaylist, extractBgmSongCoreKeys, findLocalRelink, isSameBgmSong, loadBgmLibrary, movePlaylistTrack, nextPlaylistIndex, removeTrackFromPlaylist, toggleBgmLike, type BgmLibraryTrack } from "../bgm-library";

const yt = (id: string): BgmLibraryTrack => ({ id: `youtube:${id}`, source: "youtube", youtubeId: id, title: `YouTube ${id}` });
const local = (path: string): BgmLibraryTrack => ({ id: `local:${path}`, source: "local", path, title: path.split("/").pop()! });

describe("BGM persistent library", () => {
	it("creates a default persistent playlist and migrates legacy favorites into likes", () => {
		const library = loadBgmLibrary(null, [{ source: "youtube", youtubeId: "a", id: "youtube:a", title: "A" }], 10);
		expect(library.playlists).toEqual([expect.objectContaining({ id: "default", name: "My Playlist", tracks: [] })]);
		expect(library.likes.map((track) => track.youtubeId)).toEqual(["a"]);
	});

	it("normalizes malformed persisted data instead of applying it", () => {
		const library = loadBgmLibrary({ playlists: [{ id: "p", name: "P", tracks: [{ source: "local" }, yt("ok")], createdAt: -1 }], activePlaylistId: "missing", currentIndex: 99, repeat: "forever" }, [], 20);
		expect(library.playlists[0].tracks).toEqual([yt("ok")]);
		expect(library.activePlaylistId).toBe("p");
		expect(library.currentIndex).toBe(-1);
		expect(library.repeat).toBe("off");
	});

	it("keeps likes separate from playlist membership", () => {
		let library = createEmptyBgmLibrary(1);
		library = toggleBgmLike(library, yt("a"));
		expect(library.likes).toHaveLength(1);
		expect(library.playlists[0].tracks).toHaveLength(0);
		library = addTrackToPlaylist(library, "default", yt("a"), 2);
		expect(library.likes).toHaveLength(1);
		expect(library.playlists[0].tracks).toHaveLength(1);
	});

	it("creates, adds, reorders, and removes mixed-source playlist tracks", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.1);
		let library = createPlaylist(createEmptyBgmLibrary(1), "Road trip", 2);
		const id = library.activePlaylistId!;
		library = addTrackToPlaylist(library, id, yt("a"), 3);
		library = addTrackToPlaylist(library, id, local("C:/Music/b.mp3"), 4);
		expect(library.playlists[1].tracks.map((track) => track.source)).toEqual(["youtube", "local"]);
		library = { ...library, currentIndex: 0 };
		library = movePlaylistTrack(library, id, 0, 1, 5);
		expect(library.currentIndex).toBe(1);
		library = removeTrackFromPlaylist(library, id, 0, 6);
		expect(library.playlists[1].tracks.map((track) => track.youtubeId)).toEqual(["a"]);
		expect(library.currentIndex).toBe(0);
		vi.restoreAllMocks();
	});

	it("handles sequential, repeat-all, repeat-one, and deterministic shuffle", () => {
		const base = { ...createEmptyBgmLibrary(1), playlists: [{ ...createEmptyBgmLibrary(1).playlists[0], tracks: [yt("a"), yt("b"), yt("c")] }], currentIndex: 1 };
		expect(nextPlaylistIndex(base, 1)).toBe(2);
		expect(nextPlaylistIndex({ ...base, currentIndex: 2 }, 1)).toBe(-1);
		expect(nextPlaylistIndex({ ...base, currentIndex: 2, repeat: "all" }, 1)).toBe(0);
		expect(nextPlaylistIndex({ ...base, repeat: "one" }, 1)).toBe(1);
		expect(nextPlaylistIndex({ ...base, shuffle: true }, 1, () => 0)).toBe(2);
	});

	it("auto-relinks a missing local track only when one candidate is unambiguous", () => {
		const track = { ...local("D:/old/song.mp3"), fileSize: 100, durationSeconds: 180, fingerprint: "abc" };
		expect(findLocalRelink(track, [{ path: "/home/user/Music/song.mp3", fileName: "song.mp3", fileSize: 100, durationSeconds: 180, fingerprint: "abc" }])).toBe("/home/user/Music/song.mp3");
		expect(findLocalRelink(track, [
			{ path: "/a/song.mp3", fileName: "song.mp3" },
			{ path: "/b/song.mp3", fileName: "song.mp3" },
		])).toBeNull();
	});

	it("distinguishes distinct songs that share a short prefix or have different extracted artists while keeping parenthesized alternate titles (FR-RADIO-DJ.14)", () => {
		expect(isSameBgmSong("Love", "Love Story")).toBe(false);
		expect(isSameBgmSong("Taylor Swift - Love", "Taylor Swift - Love Story")).toBe(false);
		expect(isSameBgmSong("사랑", "사랑하기 때문에")).toBe(false);
		expect(isSameBgmSong("유재하 - 사랑", "유재하 - 사랑하기 때문에")).toBe(false);
		expect(isSameBgmSong("아이유 - 밤편지", "10CM - 밤편지")).toBe(false);
		expect(isSameBgmSong("Through the Night (밤편지)", "[MV] IU(아이유) _ Through the Night(밤편지)")).toBe(true);
	});

	it("matches bilingual/HQ variant uploads without stripping ambiguous title words globally or mutating global state (#778, FR-RADIO-DJ.14)", async () => {
		const beforeAliasCall = isSameBgmSong("IU 밤편지", "밤편지");
		const beforeKoreanAliasCall = isSameBgmSong("아이유 밤편지", "밤편지");
		expect(isSameBgmSong("아이유(IU) - 좋은 날", "IU - 좋은 날")).toBe(true);
		expect(isSameBgmSong("IU 밤편지", "밤편지")).toBe(beforeAliasCall);
		expect(isSameBgmSong("아이유 밤편지", "밤편지")).toBe(beforeKoreanAliasCall);
		vi.resetModules();
		const freshModule = await import("../bgm-library");
		expect(freshModule.isSameBgmSong("IU 밤편지", "밤편지")).toBe(beforeAliasCall);
		expect(freshModule.isSameBgmSong("아이유 밤편지", "밤편지")).toBe(beforeKoreanAliasCall);

		expect(
			isSameBgmSong(
				"Through the Night (밤편지)",
				"아이유 밤편지 초고음질 IU Through the Night super HQ sound",
			),
		).toBe(true);
		expect(
			isSameBgmSong(
				"아이유 밤편지 초고음질 IU Through the Night super HQ sound",
				"Through the Night (밤편지)",
			),
		).toBe(true);
		expect(
			isSameBgmSong(
				"아이유(IU) - 밤편지",
				"아이유 밤편지 초고음질 IU Through the Night super HQ sound",
			),
		).toBe(true);

		expect(isSameBgmSong("Sound of Silence", "The Sound of Music")).toBe(false);
		expect(isSameBgmSong("Sound of Silence", "Silence")).toBe(false);

		expect(isSameBgmSong("Video Killed the Radio Star", "Radio Star")).toBe(false);
		expect(
			isSameBgmSong(
				"The Buggles - Video Killed the Radio Star (Official Music Video)",
				"Video Killed the Radio Star",
			),
		).toBe(true);
		expect(extractBgmSongCoreKeys("Video Killed the Radio Star")).toContain(
			"videokilledtheradiostar",
		);

		expect(isSameBgmSong("Super Shy", "Shy")).toBe(false);
		expect(isSameBgmSong("Loop", "Loop (Official Audio)")).toBe(true);
		expect(isSameBgmSong("Full Moon", "Moon")).toBe(false);

		expect(isSameBgmSong("Love", "Love Story")).toBe(false);
		expect(isSameBgmSong("사랑", "사랑하기 때문에")).toBe(false);
		expect(isSameBgmSong("Love (사랑)", "사랑 Love Story")).toBe(false);

		expect(isSameBgmSong("아이유 - 밤편지", "10CM - 밤편지")).toBe(false);
		expect(
			isSameBgmSong(
				"Simon & Garfunkel - The Sound of Silence",
				"Disturbed - The Sound of Silence",
			),
		).toBe(false);

		// A lone ambiguous word at the end or in the body stays part of the title.
		expect(extractBgmSongCoreKeys("The Sound")).toContain("thesound");
		expect(extractBgmSongCoreKeys("Mr. Brightside")).toContain("mrbrightside");
		// Square-bracket label/channel tags are not alternate titles, so two songs sharing one stay distinct.
		expect(
			isSameBgmSong(
				"Mainvocal (메인 보컬)_새하얀 겨울 [PurplePine Entertainment]",
				"다른 가수 - 봄날의 노래 [PurplePine Entertainment]",
			),
		).toBe(false);
	});
});
