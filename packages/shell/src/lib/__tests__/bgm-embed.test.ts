import { describe, expect, it } from "vitest";
import {
	bgmIframeIsolationAttrs,
	pickYoutubeStartTrack,
	webCatalogStartTrack,
	youtubeNeverStarted,
} from "../bgm-embed";
import { WEB_YOUTUBE_CATALOG } from "../bgm-skill";

const song = (id: string) => ({
	id,
	title: `t-${id}`,
	thumbnail: "",
	duration: "3:00",
	channel: "c",
});

describe("R31 bgm-embed", () => {
	it("R31 marks the BGM iframe credentialless only on a cross-origin isolated page", () => {
		expect(bgmIframeIsolationAttrs(true)).toEqual({ credentialless: "" });
		expect(bgmIframeIsolationAttrs(false)).toEqual({});
	});

	it("R31 ▶ resumes the current song, then the last one, else nothing", () => {
		expect(pickYoutubeStartTrack(song("a"), song("b"))?.id).toBe("a");
		expect(pickYoutubeStartTrack(null, song("b"))?.id).toBe("b");
		expect(pickYoutubeStartTrack(null, null)).toBeNull();
	});

	it("R31 web fallback is the first real catalog song with its thumbnail", () => {
		const first = webCatalogStartTrack(WEB_YOUTUBE_CATALOG);
		expect(first?.id).toBe(WEB_YOUTUBE_CATALOG[0].id);
		expect(first?.title).toBe(WEB_YOUTUBE_CATALOG[0].title);
		expect(first?.thumbnail).toBe(
			`https://i.ytimg.com/vi/${WEB_YOUTUBE_CATALOG[0].id}/hqdefault.jpg`,
		);
		expect(webCatalogStartTrack([])).toBeNull();
	});

	describe("R31 youtubeNeverStarted", () => {
		const base = {
			checkedPlaybackId: "p1",
			currentPlaybackId: "p1",
			observedPlaybackId: "p1",
			lastCurrentTime: null as number | null,
			manuallyStopped: false,
		};
		it("is true when the player never reported progress", () => {
			expect(youtubeNeverStarted(base)).toBe(true);
			expect(youtubeNeverStarted({ ...base, lastCurrentTime: 0 })).toBe(true);
		});
		it("is false once currentTime moved", () => {
			expect(youtubeNeverStarted({ ...base, lastCurrentTime: 1.2 })).toBe(false);
		});
		it("is false after a manual stop or a newer song", () => {
			expect(youtubeNeverStarted({ ...base, manuallyStopped: true })).toBe(false);
			expect(youtubeNeverStarted({ ...base, currentPlaybackId: "p2" })).toBe(false);
			expect(youtubeNeverStarted({ ...base, observedPlaybackId: "p2" })).toBe(false);
		});
	});
});
