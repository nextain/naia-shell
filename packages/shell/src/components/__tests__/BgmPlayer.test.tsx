// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onAiInterferenceEvent } from "../../lib/ai-interference";
import { bgmPlayback } from "../../lib/bgm-playback";
import { loadBgmLibraryFromSandbox, resetBgmLibraryCache } from "../../lib/bgm-library-store";
import { useAppStore } from "../../stores/app";
import { useAvatarStore } from "../../stores/avatar";

const listeners = new Map<string, (event: { payload: string }) => void>();

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(
		(event: string, handler: (event: { payload: string }) => void) => {
			listeners.set(event, handler);
			return Promise.resolve(() => listeners.delete(event));
		},
	),
}));
vi.mock("../../lib/adk-store", () => ({
	getAdkPath: vi.fn().mockReturnValue(null),
	listNaiaAssets: vi.fn().mockResolvedValue([]),
	toLocalBlobUrl: vi.fn().mockResolvedValue("blob:mock"),
}));
vi.mock("../../lib/bgm-sidecar-url", () => ({
	ensureBgmSidecar: vi.fn().mockResolvedValue(undefined),
	BGM_SIDECAR_BASE_URL: "http://localhost:18791",
}));

import { Logger } from "../../lib/logger";
import { BgmPlayer } from "../BgmPlayer";

function bgmCommandHandler() {
	const handler = listeners.get("bgm_command");
	expect(handler).toBeDefined();
	return handler!;
}

async function startTrack(videoId: string, title: string) {
	bgmCommandHandler()({
		payload: JSON.stringify({ type: "bgm_youtube_play", videoId, title }),
	});
	await act(async () => {
		await Promise.resolve();
	});
}

async function enqueueTrack(videoId: string, title: string) {
	bgmCommandHandler()({
		payload: JSON.stringify({ type: "e2e_bgm_enqueue", videoId, title }),
	});
	await act(async () => {
		await Promise.resolve();
	});
}

/** Attach a `.app-bg-iframe` matching the current playbackId, the way the
 * real background-rendering component does from useAvatarStore. The YouTube
 * message handler derives eventPlaybackId from this iframe's own `src`. */
function attachIframeForCurrentPlayback(): HTMLIFrameElement {
	const src = useAvatarStore.getState().backgroundVideoUrl;
	const iframe = document.createElement("iframe");
	iframe.className = "app-bg-iframe";
	iframe.src = src;
	document.body.appendChild(iframe);
	return iframe;
}

/**
 * 브라우저는 메시지를 보낸 창을 언제나 `source` 에 담는다. 시뮬레이션에서 그
 * 칸을 비워 두면 셸의 출처 필터를 그냥 지나가므로, 실제 브라우저였다면 버려질
 * 메시지가 테스트에서만 통과한다 — #557 에서 그 틈으로 떨어져 나간 곡 A 의 늦은
 * 오류가 곡 B 를 덮어썼다. 화면에 붙어 있는 iframe 이 보낸 것으로 만든다.
 */
function activeFrameSource(): MessageEventSource | null {
	const iframe = document.querySelector(
		".app-bg-iframe",
	) as HTMLIFrameElement | null;
	return (iframe?.contentWindow as MessageEventSource | null) ?? null;
}

function postYtObjectMessage(payload: Record<string, unknown>) {
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: payload,
				source: activeFrameSource(),
			}),
		);
	});
}

function postYtMessage(payload: Record<string, unknown>) {
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: JSON.stringify(payload),
				source: activeFrameSource(),
			}),
		);
	});
}

describe("BgmPlayer YouTube playback state machine", () => {
	beforeEach(() => {
		bgmPlayback.reset();
		useAppStore.setState({ aiInterferenceEnabled: true });
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.clearAllMocks();
		listeners.clear();
		bgmPlayback.reset();
		useAppStore.setState(useAppStore.getInitialState());
		useAvatarStore.setState(useAvatarStore.getInitialState());
		for (const iframe of document.querySelectorAll(".app-bg-iframe"))
			iframe.remove();
		localStorage.clear();
	});

	it("does not skip to another track when the 12s watchdog fires without any real evidence of failure", async () => {
		vi.useFakeTimers();
		const { container } = render(<BgmPlayer />);
		await startTrack("v1", "Song One (watchdog)");
		attachIframeForCurrentPlayback();
		await enqueueTrack("v2", "Song Two (should not play)");

		const events: string[] = [];
		const unlisten = onAiInterferenceEvent((event) =>
			events.push(event.action),
		);

		// No onStateChange/infoDelivery ever arrives — simulates a lost status
		// message on a track that may actually be playing fine.
		await act(async () => {
			vi.advanceTimersByTime(13_000);
			await Promise.resolve();
		});

		expect(
			container
				.querySelector(".bgm-player")
				?.getAttribute("data-bgm-current-title"),
		).toBe("Song One (watchdog)");
		expect(
			container
				.querySelector(".bgm-player")
				?.getAttribute("data-bgm-playback-status"),
		).toBe("timeout");
		// The old behavior called recoverAfterQueueExhausted here, which would
		// have promoted "Song Two" from the queue. It must not have.
		expect(bgmPlayback.queue().length).toBe(1);
		expect(events).toContain("music_timeout");
		expect(events).not.toContain("music_ended");
		unlisten();
	});

	it("notifies the agent when late progress recovers a diagnostic timeout", async () => {
		vi.useFakeTimers();
		const { container } = render(<BgmPlayer />);
		await startTrack("v1", "Late Song");
		attachIframeForCurrentPlayback();
		const events: string[] = [];
		const unlisten = onAiInterferenceEvent((event) =>
			events.push(event.action),
		);

		await act(async () => {
			vi.advanceTimersByTime(13_000);
			await Promise.resolve();
		});
		postYtMessage({
			event: "infoDelivery",
			info: { currentTime: 2, duration: 180 },
		});

		expect(container.querySelector(".bgm-player")).toHaveAttribute(
			"data-bgm-playback-status",
			"playing",
		);
		expect(events).toEqual(
			expect.arrayContaining(["music_timeout", "music_recovered"]),
		);
		unlisten();
	});

	it("promotes requested/loading to playing from infoDelivery progress alone, surviving a lost onStateChange message", async () => {
		vi.useFakeTimers();
		const { container } = render(<BgmPlayer />);
		await startTrack("v1", "Song One (info-delivery)");
		attachIframeForCurrentPlayback();

		// No onStateChange "playing" (state=1) ever arrives — only infoDelivery,
		// simulating the documented WebView2 handshake-loss case.
		postYtMessage({
			event: "infoDelivery",
			info: { currentTime: 5, duration: 200 },
		});

		expect(
			container
				.querySelector(".bgm-player")
				?.getAttribute("data-bgm-playback-status"),
		).toBe("playing");

		// The 12s watchdog must not override a status it already knows is playing.
		await act(async () => {
			vi.advanceTimersByTime(13_000);
			await Promise.resolve();
		});
		expect(
			container
				.querySelector(".bgm-player")
				?.getAttribute("data-bgm-playback-status"),
		).toBe("playing");
	});

	it("actively starts the internal iframe on ready and announces only confirmed playback", async () => {
		render(<BgmPlayer />);
		await startTrack("v1", "Confirmed Song");
		const iframe = attachIframeForCurrentPlayback();
		const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
		const events: string[] = [];
		const unlisten = onAiInterferenceEvent((event) => events.push(event.action));

		postYtObjectMessage({ event: "onReady" });
		expect(postMessage).toHaveBeenCalledWith(
			JSON.stringify({ event: "command", func: "playVideo", args: [] }),
			"*",
		);
		expect(events).not.toContain("music_started");

		postYtMessage({ event: "onStateChange", info: 1 });
		expect(events).toContain("music_started");
		expect(bgmPlayback.current()?.status).toBe("playing");
		unlisten();
	});

	it("ignores non-YouTube iframe messages", async () => {
		render(<BgmPlayer />);
		await startTrack("v1", "Protected Song");
		attachIframeForCurrentPlayback();
		act(() => {
			window.dispatchEvent(new MessageEvent("message", {
				data: JSON.stringify({ event: "onStateChange", info: 1 }),
				origin: "https://example.com",
			}));
		});
		expect(bgmPlayback.current()?.status).toBe("requested");
	});

	it("notifies the agent the moment a track genuinely ends, not from the watchdog timer", async () => {
		render(<BgmPlayer />);
		await startTrack("v1", "Song One (ended)");
		attachIframeForCurrentPlayback();

		const events: { action: string; summary?: string }[] = [];
		const unlisten = onAiInterferenceEvent((event) =>
			events.push({ action: event.action, summary: event.summary }),
		);

		postYtMessage({ event: "onStateChange", info: 0 });

		expect(events).toHaveLength(1);
		expect(events[0].action).toBe("music_ended");
		expect(events[0].summary).toContain("Song One (ended)");
		unlisten();
	});

	it("shows the animated note and a Stop action only while YouTube is playing", async () => {
		const { container } = render(<BgmPlayer />);
		await startTrack("v1", "Playing Song");
		const iframe = attachIframeForCurrentPlayback();
		const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");

		postYtMessage({ event: "onStateChange", info: 1 });
		expect(container.querySelector(".bgm-icon")).toHaveClass(
			"bgm-icon--playing",
		);
		const stop = screen.getByRole("button", { name: /Stop|정지/ });
		expect(stop).toHaveTextContent("■");
		fireEvent.click(stop);
		expect(postMessage).toHaveBeenCalledWith(
			JSON.stringify({ event: "command", func: "stopVideo", args: [] }),
			"*",
		);
		expect(
			screen.getByRole("button", { name: /^(Play|재생)$/ }),
		).toHaveTextContent("▶");
		expect(container.querySelector(".bgm-icon")).not.toHaveClass(
			"bgm-icon--playing",
		);
	});

	it("keeps a one-click manual stop when a stale playing event arrives", async () => {
		const { container } = render(<BgmPlayer />);
		await startTrack("v1", "Stop Race Song");
		const iframe = attachIframeForCurrentPlayback();
		const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
		postYtMessage({ event: "onStateChange", info: 1 });

		fireEvent.click(
			screen.getByRole("button", { name: /^(Stop|정지)$/ }),
		);
		postMessage.mockClear();
		postYtMessage({ event: "onStateChange", info: 1 });

		expect(postMessage).toHaveBeenCalledWith(
			JSON.stringify({ event: "command", func: "stopVideo", args: [] }),
			"*",
		);
		expect(screen.getByRole("button", { name: /^(Play|재생)$/ })).toHaveTextContent(
			"▶",
		);
		expect(container.querySelector(".bgm-player")).toHaveAttribute(
			"data-bgm-playback-status",
			"paused",
		);
	});

	it("shows the requested iframe immediately when background video is checked", async () => {
		render(<BgmPlayer />);
		await startTrack("v1", "Unconfirmed Song");
		attachIframeForCurrentPlayback();

		// UI follows the user's accepted autoplay intent immediately, while the
		// playback fact boundary remains requested until iframe evidence arrives.
		expect(bgmPlayback.current()?.status).toBe("requested");
		expect(
			screen.getByRole("button", { name: /Stop|정지/ }),
		).toHaveTextContent("■");
		expect(document.documentElement).toHaveAttribute(
			"data-bgm-youtube-live",
			"true",
		);

		postYtMessage({ event: "onStateChange", info: 1 });
		expect(document.documentElement).toHaveAttribute(
			"data-bgm-youtube-live",
			"true",
		);
	});

	it("restores the previous background when the embed reports a genuine error", async () => {
		render(<BgmPlayer />);
		await startTrack("v1", "Failing Song");
		attachIframeForCurrentPlayback();
		postYtMessage({ event: "onStateChange", info: 1 });
		expect(document.documentElement).toHaveAttribute(
			"data-bgm-youtube-live",
			"true",
		);

		postYtMessage({ event: "onError", info: 150 });
		expect(document.documentElement).toHaveAttribute(
			"data-bgm-youtube-live",
			"false",
		);
	});

	it("keeps the requested background visible across a diagnostic-only timeout", async () => {
		vi.useFakeTimers();
		render(<BgmPlayer />);
		await startTrack("v1", "Late Confirmed Song");
		attachIframeForCurrentPlayback();

		await act(async () => {
			vi.advanceTimersByTime(13_000);
			await Promise.resolve();
		});
		expect(document.documentElement).toHaveAttribute(
			"data-bgm-youtube-live",
			"true",
		);

		postYtMessage({
			event: "infoDelivery",
			info: { currentTime: 2, duration: 180 },
		});
		expect(document.documentElement).toHaveAttribute(
			"data-bgm-youtube-live",
			"true",
		);
	});

	it("migrates legacy localStorage favorites into persistent likes and clears the legacy key", async () => {
		localStorage.setItem("naia-config", JSON.stringify({ locale: "en" }));
		localStorage.setItem(
			"yt-bgm-favorites",
			JSON.stringify([
				{
					id: "old-1",
					title: "Legacy Fav",
					thumbnail: "",
					duration: "",
					channel: "",
				},
			]),
		);
		render(<BgmPlayer />);
		await act(async () => {
			await Promise.resolve();
		});

		const cfg = JSON.parse(localStorage.getItem("naia-config") ?? "{}");
		expect(cfg.bgmLibrary.likes).toEqual([
			expect.objectContaining({ youtubeId: "old-1", title: "Legacy Fav" }),
		]);
		expect(localStorage.getItem("yt-bgm-favorites")).toBeNull();
	});

	it("persists a newly added like into the workspace library, not webview localStorage", async () => {
		localStorage.setItem("naia-config", JSON.stringify({ locale: "en" }));
		render(<BgmPlayer />);
		await startTrack("v-fav", "Favorite Candidate");
		attachIframeForCurrentPlayback();

		bgmCommandHandler()({
			payload: JSON.stringify({ type: "bgm_youtube_fav_add" }),
		});
		await act(async () => {
			await Promise.resolve();
		});

		const cfg = JSON.parse(localStorage.getItem("naia-config") ?? "{}");
		expect(cfg.bgmLibrary.likes).toEqual([
			expect.objectContaining({ youtubeId: "v-fav", title: "Favorite Candidate" }),
		]);
		expect(localStorage.getItem("yt-bgm-favorites")).toBeNull();
	});

	it("keeps confirmed play history when a like update follows before library reload", async () => {
		resetBgmLibraryCache();
		localStorage.setItem("naia-config", JSON.stringify({ locale: "en" }));
		render(<BgmPlayer />);
		await startTrack("v-played", "Played Before Like");
		attachIframeForCurrentPlayback();
		postYtMessage({ event: "onStateChange", info: 1 });

		// The PLAYING event records history through the store cache first. The like
		// command follows before React has rendered that cache update.
		bgmCommandHandler()({
			payload: JSON.stringify({ type: "bgm_youtube_fav_add" }),
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		resetBgmLibraryCache();
		const restored = await loadBgmLibraryFromSandbox();
		expect(restored.history).toEqual([
			expect.objectContaining({ youtubeId: "v-played", title: "Played Before Like" }),
		]);
		expect(restored.likes).toEqual([
			expect.objectContaining({ youtubeId: "v-played", title: "Played Before Like" }),
		]);
	});

	it("creates and persists a named playlist from the player UI", async () => {
		localStorage.setItem("naia-config", JSON.stringify({ locale: "en" }));
		const { container } = render(<BgmPlayer />);
		fireEvent.click(container.querySelector(".bgm-icon")!);
		fireEvent.click(await screen.findByRole("button", { name: "Playlists" }));
		fireEvent.change(screen.getByPlaceholderText("New playlist name"), {
			target: { value: "Focus" },
		});
		fireEvent.submit(screen.getByPlaceholderText("New playlist name").closest("form")!);

		const cfg = JSON.parse(localStorage.getItem("naia-config") ?? "{}");
		expect(cfg.bgmLibrary.playlists).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "Focus", tracks: [] })]),
		);
		expect(screen.getByRole("option", { name: "Focus" })).toBeInTheDocument();
	});

	it("plays next from the active playlist instead of the likes collection", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				locale: "en",
				bgmLibrary: {
					schemaVersion: 1,
					likes: [
						{
							id: "youtube:liked",
							source: "youtube",
							youtubeId: "liked",
							title: "Liked but not queued",
						},
					],
					playlists: [
						{
							id: "focus",
							name: "Focus",
							createdAt: 1,
							updatedAt: 1,
							tracks: [
								{
									id: "youtube:first",
									source: "youtube",
									youtubeId: "first",
									title: "First",
								},
								{
									id: "youtube:second",
									source: "youtube",
									youtubeId: "second",
									title: "Second",
								},
							],
						},
					],
					activePlaylistId: "focus",
					currentIndex: -1,
					shuffle: false,
					repeat: "off",
					queue: [],
					history: [],
				},
			}),
		);
		const { container } = render(<BgmPlayer />);
		fireEvent.click(container.querySelector(".bgm-icon")!);
		fireEvent.click(await screen.findByRole("button", { name: "Playlists" }));
		fireEvent.click(screen.getByRole("button", { name: /First/ }));
		expect(bgmPlayback.current()?.selected.videoId).toBe("first");
		fireEvent.click(screen.getByTitle("Next"));
		expect(bgmPlayback.current()?.selected.videoId).toBe("second");
	});

	it("automatically advances to the next active-playlist track when YouTube ends", async () => {
		localStorage.setItem("naia-config", JSON.stringify({ locale: "en", bgmLibrary: { schemaVersion: 1, likes: [], playlists: [{ id: "focus", name: "Focus", createdAt: 1, updatedAt: 1, tracks: [{ id: "youtube:first", source: "youtube", youtubeId: "first", title: "First" }, { id: "youtube:second", source: "youtube", youtubeId: "second", title: "Second" }] }], activePlaylistId: "focus", currentIndex: 0, shuffle: false, repeat: "off", queue: [], history: [] } }));
		render(<BgmPlayer />);
		await startTrack("first", "First");
		attachIframeForCurrentPlayback();
		postYtObjectMessage({ event: "onStateChange", info: 0 });
		expect(bgmPlayback.current()?.selected.videoId).toBe("second");
	});

	it("hides only the YouTube picture while keeping its iframe mounted", async () => {
		localStorage.setItem("naia-config", JSON.stringify({ locale: "en" }));
		const { container } = render(<BgmPlayer />);
		await startTrack("v1", "Audio-only Song");
		const iframe = attachIframeForCurrentPlayback();
		fireEvent.click(container.querySelector(".bgm-icon")!);
		const option = await screen.findByRole("checkbox", {
			name: /Show background video|배경 비디오 표시/,
		});
		fireEvent.click(option);

		expect(iframe).toBeInTheDocument();
		expect(document.documentElement).toHaveAttribute(
			"data-bgm-youtube-background",
			"hidden",
		);
		expect(
			JSON.parse(localStorage.getItem("naia-config") ?? "{}"),
		).toHaveProperty("bgmYoutubeBackgroundVideo", false);
	});
});

/**
 * #521 — 설치본에서 음악이 실제로 들리는데도 재생 관측이 12초 뒤 timeout 으로
 * 끝났다. 관측 경로가 로그를 남기지 않아 재현될 때마다 원인을 다시 추측해야
 * 했다. 실패했을 때 어느 관문에서 끊겼는지가 로그 한 줄로 나와야 한다.
 */
describe("BgmPlayer 재생 관측 실패 진단 (#521)", () => {
	beforeEach(() => {
		bgmPlayback.reset();
		useAppStore.setState({ aiInterferenceEnabled: true });
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
		listeners.clear();
		bgmPlayback.reset();
		useAppStore.setState(useAppStore.getInitialState());
		useAvatarStore.setState(useAvatarStore.getInitialState());
		for (const iframe of document.querySelectorAll(".app-bg-iframe"))
			iframe.remove();
		localStorage.clear();
	});

	type WarnCall = [string, string, Record<string, unknown>?];

	function diagnosisCall(warn: { mock: { calls: unknown[][] } }) {
		return (warn.mock.calls as WarnCall[]).find((call) =>
			String(call[1]).includes("재생 관측 실패"),
		);
	}

	it("브리지 메시지가 한 건도 없으면 그렇게 적는다", async () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(Logger, "warn").mockImplementation(() => {});
		render(<BgmPlayer />);
		await startTrack("v1", "Song One");
		attachIframeForCurrentPlayback();

		await act(async () => {
			vi.advanceTimersByTime(13_000);
			await Promise.resolve();
		});

		const call = diagnosisCall(warn);
		expect(call, "관측 실패는 반드시 한 줄을 남긴다").toBeDefined();
		expect(String(call?.[1])).toContain("한 건도 도착하지 않았다");
		expect((call?.[2] as { cause: string }).cause).toBe("no_bridge_messages");
	});

	it("소스 필터가 전부 버렸으면 필터로 특정한다", async () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(Logger, "warn").mockImplementation(() => {});
		render(<BgmPlayer />);
		await startTrack("v1", "Song One");
		const iframe = attachIframeForCurrentPlayback();
		// 화면의 iframe 과 다른 창이 보낸 메시지 — 실제 코드가 버리는 경우다.
		Object.defineProperty(iframe, "contentWindow", {
			configurable: true,
			value: {},
		});
		for (let i = 0; i < 3; i++) {
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: JSON.stringify({ event: "infoDelivery", info: {} }),
						source: window as unknown as MessageEventSource,
					}),
				);
			});
		}

		await act(async () => {
			vi.advanceTimersByTime(13_000);
			await Promise.resolve();
		});

		const call = diagnosisCall(warn);
		expect(call).toBeDefined();
		expect((call?.[2] as { cause: string }).cause).toBe(
			"source_filter_dropped",
		);
		expect((call?.[2] as { filteredOut: number }).filteredOut).toBe(3);
	});

	it("메시지는 왔는데 재생 상태가 없으면 그렇게 갈린다", async () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(Logger, "warn").mockImplementation(() => {});
		render(<BgmPlayer />);
		await startTrack("v1", "Song One");
		attachIframeForCurrentPlayback();
		// 진행이 0 인 infoDelivery — 재생 증거가 되지 못한다.
		postYtMessage({ event: "infoDelivery", info: { currentTime: 0 } });

		await act(async () => {
			vi.advanceTimersByTime(13_000);
			await Promise.resolve();
		});

		const call = diagnosisCall(warn);
		expect(call).toBeDefined();
		expect((call?.[2] as { cause: string }).cause).toBe("no_playing_state");
		expect((call?.[2] as { infoDeliverySeen: boolean }).infoDeliverySeen).toBe(
			true,
		);
	});

	it("실제로 재생이 관측되면 진단을 남기지 않는다", async () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(Logger, "warn").mockImplementation(() => {});
		render(<BgmPlayer />);
		await startTrack("v1", "Song One");
		attachIframeForCurrentPlayback();
		postYtMessage({ event: "onStateChange", info: 1 });

		await act(async () => {
			vi.advanceTimersByTime(13_000);
			await Promise.resolve();
		});

		expect(diagnosisCall(warn)).toBeUndefined();
	});
});
