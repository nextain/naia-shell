import { describe, expect, it, vi } from "vitest";
import { addTrackToPlaylist, createEmptyBgmLibrary, createPlaylist, findLocalRelink, loadBgmLibrary, movePlaylistTrack, nextPlaylistIndex, removeTrackFromPlaylist, toggleBgmLike, type BgmLibraryTrack } from "../bgm-library";

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
});
