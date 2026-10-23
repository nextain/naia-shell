// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listNaiaAssets, toLocalBlobUrl } from "../../lib/adk-store";
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
	ensureBgmSidecar: vi.fn().mockResolvedValue("http://localhost:18791"),
	bgmSidecarBaseUrl: () => "http://localhost:18791",
	BGM_SIDECAR_BASE_URL: "http://localhost:18791",
}));

import * as chatService from "../../lib/chat-service";
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

function confirmCurrentFrame(
	videoId = bgmPlayback.current()?.selected.videoId ?? "",
	title = bgmPlayback.current()?.selected.title ?? "",
	source: MessageEventSource | null = activeFrameSource(),
) {
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: JSON.stringify({
					event: "initialDelivery",
					info: {
						playerState: -1,
						currentTime: 0,
						videoData: { video_id: videoId, title },
					},
				}),
				source,
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

	it("finalizes an unresponsive load on timeout with track_error(timeout) and advances to the prepared next candidate once (FR-RADIO-DJ.2·16)", async () => {
		vi.useFakeTimers();
		const controlSpy = vi
			.spyOn(chatService, "controlSpeechActivity")
			.mockResolvedValue(true);
		chatService.setCurrentSpeechActivityId("dj-activity-timeout");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				proactiveSpeechProfile: "personal_radio_dj",
				proactiveSpeechPermitted: true,
			}),
		);

		const { container } = render(<BgmPlayer />);
		await startTrack("v1", "Song One (watchdog)");
		const v1PlaybackId = bgmPlayback.current()?.playbackId ?? "";
		attachIframeForCurrentPlayback();
		await enqueueTrack("v2", "Song Two (next candidate)");
		await enqueueTrack("v1", "Song One (duplicate failed)");

		const events: string[] = [];
		const unlisten = onAiInterferenceEvent((event) =>
			events.push(event.action),
		);

		// No confirmation or playing arrives within PLAYBACK_TIMEOUT_MS.
		await act(async () => {
			vi.advanceTimersByTime(13_000);
			await Promise.resolve();
		});

		expect(
			container
				.querySelector(".bgm-player")
				?.getAttribute("data-bgm-current-title"),
		).toBe("Song Two (next candidate)");
		expect(bgmPlayback.current()?.selected.videoId).toBe("v2");
		expect(events).toContain("music_timeout");
		expect(events).not.toContain("music_ended");
		expect(
			controlSpy.mock.calls.some(([arg]) => {
				if (!String(arg).startsWith("bgm_event:")) return false;
				const parsed = JSON.parse(String(arg).slice("bgm_event:".length));
				return (
					parsed.kind === "track_error" &&
					parsed.playbackId === v1PlaybackId &&
					parsed.previousVideoId === "v1" &&
					parsed.reason === "timeout" &&
					parsed.nextVideoId === "v2" &&
					parsed.continued === true
				);
			}),
		).toBe(true);
		unlisten();
		chatService.setCurrentSpeechActivityId(undefined);
		controlSpy.mockRestore();
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
			info: {
				currentTime: 2,
				duration: 180,
				videoData: { video_id: "v1", title: "Late Song" },
			},
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
			info: {
				currentTime: 5,
				duration: 200,
				videoData: { video_id: "v1", title: "Song One (info-delivery)" },
			},
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

		confirmCurrentFrame("v1", "Confirmed Song");
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
		confirmCurrentFrame("v1", "Song One (ended)");

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

		confirmCurrentFrame("v1", "Playing Song");
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
		confirmCurrentFrame("v1", "Stop Race Song");
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

	it("accepts a genuine resume after manual stop instead of re-stopping it forever (#614)", async () => {
		const { container } = render(<BgmPlayer />);
		await startTrack("v1", "Resume Race Song");
		const iframe = attachIframeForCurrentPlayback();
		const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
		confirmCurrentFrame("v1", "Resume Race Song");
		postYtMessage({ event: "onStateChange", info: 1 });

		// User stops playback via the button.
		fireEvent.click(screen.getByRole("button", { name: /^(Stop|정지)$/ }));
		expect(
			screen.getByRole("button", { name: /^(Play|재생)$/ }),
		).toHaveTextContent("▶");

		// User presses Play again — a deliberate, fresh resume.
		fireEvent.click(screen.getByRole("button", { name: /^(Play|재생)$/ }));
		postMessage.mockClear();
		// The iframe genuinely starts playing in response to that resume.
		postYtMessage({ event: "onStateChange", info: 1 });

		// The resume must be accepted: no further stopVideo sent, and the
		// button must reflect the real playing state instead of snapping
		// back to "stopped" forever.
		expect(postMessage).not.toHaveBeenCalledWith(
			JSON.stringify({ event: "command", func: "stopVideo", args: [] }),
			"*",
		);
		expect(
			screen.getByRole("button", { name: /^(Stop|정지)$/ }),
		).toHaveTextContent("■");
		expect(container.querySelector(".bgm-player")).toHaveAttribute(
			"data-bgm-playback-status",
			"playing",
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

		confirmCurrentFrame("v1", "Unconfirmed Song");
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
		confirmCurrentFrame("v1", "Failing Song");
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
			info: {
				currentTime: 2,
				duration: 180,
				videoData: { video_id: "v1", title: "Late Confirmed Song" },
			},
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
		confirmCurrentFrame("v-played", "Played Before Like");
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

		await waitFor(() => {
			expect(screen.getByRole("option", { name: "Focus" })).toBeInTheDocument();
		});
		await waitFor(() => {
			const cfg = JSON.parse(localStorage.getItem("naia-config") ?? "{}");
			expect(cfg.bgmLibrary.playlists).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: "Focus", tracks: [] }),
				]),
			);
		});
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
		confirmCurrentFrame("first", "First");
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
		confirmCurrentFrame("v1", "Song One");
		postYtMessage({ event: "onStateChange", info: 1 });

		await act(async () => {
			vi.advanceTimersByTime(13_000);
			await Promise.resolve();
		});

		expect(diagnosisCall(warn)).toBeUndefined();
	});

	it("treats Tauri null-source playing as observed playback (#671)", async () => {
		const { container } = render(<BgmPlayer />);
		await startTrack("v1", "Audible Song");
		attachIframeForCurrentPlayback();
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({
						event: "initialDelivery",
						info: {
							playerState: -1,
							currentTime: 0,
							videoData: { video_id: "v1", title: "Audible Song" },
						},
					}),
					source: null,
				}),
			);
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({ event: "onStateChange", info: 1 }),
					source: null,
				}),
			);
		});
		expect(container.querySelector(".bgm-player")).toHaveAttribute(
			"data-bgm-playback-status",
			"playing",
		);
	});

	it("(1)(2)(3)(5) enforces generation-based confirmation: late unconfirmed numeric playing/ended/onError do not promote to playing or skip the track; pre-confirmation onError 150 survives mismatched videoData or unconfirmed playing and advances once upon current-frame confirmation; normal confirmed ended immediately emits track_ended (FR-RADIO-DJ.2·16 + FR-BGM.18)", async () => {
		const controlSpy = vi
			.spyOn(chatService, "controlSpeechActivity")
			.mockResolvedValue(true);
		chatService.setCurrentSpeechActivityId("dj-activity-1");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				proactiveSpeechProfile: "personal_radio_dj",
				proactiveSpeechPermitted: true,
			}),
		);

		render(<BgmPlayer />);
		await startTrack("v1", "First Candidate");
		bgmPlayback.enqueue({ videoId: "v2", title: "Second Candidate" });
		bgmPlayback.enqueue({ videoId: "v3", title: "Third Candidate" });
		bgmPlayback.enqueue({ videoId: "v1", title: "First Candidate" });
		const iframe = attachIframeForCurrentPlayback();
		const postMessage = vi.fn();
		Object.defineProperty(iframe, "contentWindow", {
			configurable: true,
			value: { postMessage },
		});

		// (1) Before "v1" confirms its videoData, a late numeric playing(1) only sets status="loading"
		// (must NOT promote to "playing" or emit track_playing), and late numeric onError(150) / ended(0)
		// are pended for this generation without immediately skipping "v1" -> queries active iframe once.
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({ event: "onStateChange", info: 1 }),
					source: null,
				}),
			);
		});
		expect(bgmPlayback.current()?.selected.videoId).toBe("v1");
		expect(bgmPlayback.current()?.status).toBe("loading");
		expect(controlSpy).not.toHaveBeenCalled();

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({ event: "onError", info: 150 }),
					source: null,
				}),
			);
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({ event: "onStateChange", info: 0 }),
					source: null,
				}),
			);
		});
		expect(bgmPlayback.current()?.selected.videoId).toBe("v1");
		expect(bgmPlayback.current()?.status).toBe("loading");
		const getPlayerStateCalls = postMessage.mock.calls.filter(([payload]: unknown[]) =>
			String(payload).includes('"func":"getPlayerState"'),
		);
		const getVideoDataCalls = postMessage.mock.calls.filter(([payload]: unknown[]) =>
			String(payload).includes('"func":"getVideoData"'),
		);
		expect(getPlayerStateCalls).toHaveLength(1);
		expect(getVideoDataCalls).toHaveLength(1);

		// (3) Interleaved messages from a detached frame with a mismatched video_id ("v-stale")
		// or unconfirmed numeric playing(1) / infoDelivery without matching videoData
		// must NOT clear the pended onError(150) or change playback state.
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({
						event: "infoDelivery",
						info: {
							playerState: 1,
							currentTime: 42,
							duration: 180,
							videoData: { video_id: "v-stale", title: "Detached Song" },
						},
					}),
					source: null,
				}),
			);
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({ event: "onStateChange", info: 1 }),
					source: null,
				}),
			);
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({
						event: "infoDelivery",
						info: { playerState: 1, currentTime: 0.5 },
					}),
					source: null,
				}),
			);
		});
		expect(bgmPlayback.current()?.selected.videoId).toBe("v1");
		expect(bgmPlayback.current()?.status).toBe("loading");
		expect(controlSpy).not.toHaveBeenCalled();

		// (2) As soon as "v1" confirms its frame via initialDelivery/infoDelivery with matching video_id="v1",
		// the pended onError(150) is processed immediately -> emits track_error(150) once and advances to "v2".
		const v1PlaybackId = bgmPlayback.current()?.playbackId;
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({
						event: "initialDelivery",
						info: {
							playerState: -1,
							currentTime: 0,
							videoData: { video_id: "v1", title: "First Candidate" },
						},
					}),
					source: null,
				}),
			);
		});
		expect(bgmPlayback.current()?.selected.videoId).toBe("v2");
		expect(bgmPlayback.current()?.playbackId).not.toBe(v1PlaybackId);
		expect(
			controlSpy.mock.calls.some(([arg]) => {
				if (!String(arg).startsWith("bgm_event:")) return false;
				const parsed = JSON.parse(String(arg).slice("bgm_event:".length));
				return (
					parsed.kind === "track_error" &&
					parsed.playbackId === v1PlaybackId &&
					parsed.previousVideoId === "v1" &&
					parsed.nextVideoId === "v2" &&
					parsed.reason === "150" &&
					parsed.continued === true
				);
			}),
		).toBe(true);

		// For "v2", late unconfirmed numeric playing(1) from detached "v1" before "v2" confirmation
		// must NOT promote "v2" to playing; once "v2" confirms its videoData, numeric playing promotes to playing.
		for (const f of document.querySelectorAll(".app-bg-iframe")) f.remove();
		attachIframeForCurrentPlayback();
		controlSpy.mockClear();
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({ event: "onStateChange", info: 1 }),
					source: null,
				}),
			);
		});
		expect(bgmPlayback.current()?.selected.videoId).toBe("v2");
		expect(bgmPlayback.current()?.status).toBe("loading");
		expect(controlSpy).not.toHaveBeenCalled();

		// (5) "v2" confirms its frame and plays, then normal numeric ended(0) immediately emits track_ended
		// even without near-end currentTime/duration progress, advancing to "v3".
		const v2PlaybackId = bgmPlayback.current()?.playbackId ?? "";
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({
						event: "infoDelivery",
						info: {
							playerState: 1,
							currentTime: 3,
							duration: 180,
							videoData: { video_id: "v2", title: "Second Candidate" },
						},
					}),
					source: null,
				}),
			);
		});
		expect(bgmPlayback.current()?.status).toBe("playing");
		controlSpy.mockClear();

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({ event: "onStateChange", info: 0 }),
					source: null,
				}),
			);
		});
		expect(bgmPlayback.current()?.selected.videoId).toBe("v3");
		expect(
			controlSpy.mock.calls.some(([arg]) => {
				if (!String(arg).startsWith("bgm_event:")) return false;
				const parsed = JSON.parse(String(arg).slice("bgm_event:".length));
				return (
					parsed.kind === "track_ended" &&
					parsed.playbackId === v2PlaybackId &&
					parsed.previousVideoId === "v2" &&
					parsed.nextVideoId === "v3" &&
					parsed.continued === true
				);
			}),
		).toBe(true);

		// When "v3" also ends, the duplicate queued "v1" (which already failed once in this session) is skipped.
		for (const f of document.querySelectorAll(".app-bg-iframe")) f.remove();
		attachIframeForCurrentPlayback();
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({
						event: "infoDelivery",
						info: {
							playerState: 1,
							currentTime: 10,
							duration: 120,
							videoData: { video_id: "v3", title: "Third Candidate" },
						},
					}),
					source: null,
				}),
			);
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({ event: "onStateChange", info: 0 }),
					source: null,
				}),
			);
		});
		expect(bgmPlayback.current()?.selected.videoId).toBe("v3");
		expect(bgmPlayback.current()?.status).toBe("ended");

		chatService.setCurrentSpeechActivityId(undefined);
		controlSpy.mockRestore();
	});

	it("processes infoDelivery playerState=0 as track_ended without promoting to playing when confirmed while still loading, and does not pend onError 150 arriving before DOM iframe src updates so the new track plays when confirmed or falls back to timeout track_error once if never confirmed (FR-RADIO-DJ.2·16)", async () => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout",
				"setInterval",
				"clearInterval",
				"Date",
			],
		});
		const controlSpy = vi
			.spyOn(chatService, "controlSpeechActivity")
			.mockResolvedValue(true);
		chatService.setCurrentSpeechActivityId("dj-activity-1");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				proactiveSpeechProfile: "personal_radio_dj",
				proactiveSpeechPermitted: true,
			}),
		);

		render(<BgmPlayer />);
		await startTrack("v-loading-end", "Loading End Candidate");
		bgmPlayback.enqueue({
			videoId: "v-stale-src-err",
			title: "Stale Src Error Candidate",
		});
		bgmPlayback.enqueue({
			videoId: "v-unconfirmed-err",
			title: "Unconfirmed Error Candidate",
		});
		bgmPlayback.enqueue({ videoId: "v-final", title: "Final Candidate" });
		const firstPlaybackId = bgmPlayback.current()?.playbackId ?? "";
		const iframe = attachIframeForCurrentPlayback();

		// 1) "v-loading-end" confirms its videoData in initialDelivery (status="loading"), then receives
		// infoDelivery with playerState=0 and currentTime > 0 while still status="loading".
		// Must emit track_ended (and advance to "v-stale-src-err") without promoting to "playing".
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({
						event: "initialDelivery",
						info: {
							playerState: -1,
							currentTime: 0,
							videoData: {
								video_id: "v-loading-end",
								title: "Loading End Candidate",
							},
						},
					}),
					source: null,
				}),
			);
		});
		expect(bgmPlayback.current()?.status).toBe("loading");
		controlSpy.mockClear();

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({
						event: "infoDelivery",
						info: {
							playerState: 0,
							currentTime: 1.2,
							duration: 1.2,
							videoData: {
								video_id: "v-loading-end",
								title: "Loading End Candidate",
							},
						},
					}),
					source: null,
				}),
			);
		});
		const secondPlaybackId = bgmPlayback.current()?.playbackId ?? "";
		expect(bgmPlayback.current()?.selected.videoId).toBe("v-stale-src-err");
		expect(bgmPlayback.current()?.status).toBe("requested");
		const firstEvents = controlSpy.mock.calls
			.filter(([arg]) => String(arg).startsWith("bgm_event:"))
			.map(([arg]) => JSON.parse(String(arg).slice("bgm_event:".length)));
		expect(firstEvents).toEqual([
			expect.objectContaining({
				kind: "track_ended",
				playbackId: firstPlaybackId,
				previousVideoId: "v-loading-end",
				nextVideoId: "v-stale-src-err",
				continued: true,
			}),
		]);

		// 2) Immediately after advancing to "v-stale-src-err", before DOM iframe.src updates
		// (iframe.src still has v-loading-end and firstPlaybackId), a null-source onError(150) arrives.
		// Because eventPlaybackId (firstPlaybackId) !== current.playbackId (secondPlaybackId),
		// that error must NOT be pended; when "v-stale-src-err" confirms and plays, it plays normally.
		controlSpy.mockClear();
		expect(iframe.src).toContain("v-loading-end");
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({ event: "onError", info: 150 }),
					source: null,
				}),
			);
		});
		expect(bgmPlayback.current()?.selected.videoId).toBe("v-stale-src-err");
		expect(controlSpy).not.toHaveBeenCalled();

		// Now DOM iframe.src catches up to the new generation and confirms + plays "v-stale-src-err".
		for (const f of document.querySelectorAll(".app-bg-iframe")) f.remove();
		const secondIframe = attachIframeForCurrentPlayback();
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({
						event: "infoDelivery",
						info: {
							playerState: 1,
							currentTime: 1.5,
							duration: 180,
							videoData: {
								video_id: "v-stale-src-err",
								title: "Stale Src Error Candidate",
							},
						},
					}),
					source: null,
				}),
			);
		});
		expect(bgmPlayback.current()?.playbackId).toBe(secondPlaybackId);
		expect(bgmPlayback.current()?.selected.videoId).toBe("v-stale-src-err");
		expect(bgmPlayback.current()?.status).toBe("playing");
		const secondEvents = controlSpy.mock.calls
			.filter(([arg]) => String(arg).startsWith("bgm_event:"))
			.map(([arg]) => JSON.parse(String(arg).slice("bgm_event:".length)));
		expect(secondEvents).toEqual([
			expect.objectContaining({
				kind: "track_playing",
				playbackId: secondPlaybackId,
				videoId: "v-stale-src-err",
			}),
		]);

		// Now end "v-stale-src-err" so it advances to "v-unconfirmed-err", and test the case where
		// an early onError(150) arrives before DOM iframe.src updates and then neither confirmation
		// nor playing ever arrives -> timeout path emits track_error(timeout) once and advances to "v-final".
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({ event: "onStateChange", info: 0 }),
					source: null,
				}),
			);
		});
		const thirdPlaybackId = bgmPlayback.current()?.playbackId ?? "";
		expect(bgmPlayback.current()?.selected.videoId).toBe("v-unconfirmed-err");
		expect(secondIframe.src).toContain("v-stale-src-err");
		controlSpy.mockClear();

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({ event: "onError", info: 150 }),
					source: null,
				}),
			);
		});
		for (const f of document.querySelectorAll(".app-bg-iframe")) f.remove();
		attachIframeForCurrentPlayback();

		await act(async () => {
			vi.advanceTimersByTime(12_500);
			await Promise.resolve();
		});
		expect(bgmPlayback.current()?.selected.videoId).toBe("v-final");
		const thirdEvents = controlSpy.mock.calls
			.filter(([arg]) => String(arg).startsWith("bgm_event:"))
			.map(([arg]) => JSON.parse(String(arg).slice("bgm_event:".length)));
		expect(thirdEvents).toEqual([
			expect.objectContaining({
				kind: "track_error",
				playbackId: thirdPlaybackId,
				previousVideoId: "v-unconfirmed-err",
				nextVideoId: "v-final",
				reason: "timeout",
				continued: true,
			}),
		]);

		chatService.setCurrentSpeechActivityId(undefined);
		controlSpy.mockRestore();
	});

	it("ignores delayed onStateChange(0) and onError from track A while DOM iframe src is still A after advancing to track B, keeping B playing without skipping to C (FR-RADIO-DJ.2)", async () => {
		const controlSpy = vi
			.spyOn(chatService, "controlSpeechActivity")
			.mockResolvedValue(true);
		chatService.setCurrentSpeechActivityId("dj-activity-1");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				proactiveSpeechProfile: "personal_radio_dj",
				proactiveSpeechPermitted: true,
			}),
		);

		render(<BgmPlayer />);
		await startTrack("v-track-a", "Track A");
		bgmPlayback.enqueue({ videoId: "v-track-b", title: "Track B" });
		bgmPlayback.enqueue({ videoId: "v-track-c", title: "Track C" });
		const aPlaybackId = bgmPlayback.current()?.playbackId ?? "";
		const iframeA = attachIframeForCurrentPlayback();

		// Track A confirms and plays, then ends -> advances to generation B while DOM iframe.src is still A.
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({
						event: "infoDelivery",
						info: {
							playerState: 1,
							currentTime: 10,
							duration: 180,
							videoData: { video_id: "v-track-a", title: "Track A" },
						},
					}),
					source: null,
				}),
			);
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({ event: "onStateChange", info: 0 }),
					source: null,
				}),
			);
		});
		const bPlaybackId = bgmPlayback.current()?.playbackId ?? "";
		expect(bPlaybackId).not.toBe(aPlaybackId);
		expect(bgmPlayback.current()?.selected.videoId).toBe("v-track-b");
		expect(iframeA.src).toContain(aPlaybackId);
		controlSpy.mockClear();

		// Delayed onStateChange(0) and onError from A (both null-source and activeWindow-source)
		// arrive while iframe.src still has A's playbackId.
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({ event: "onStateChange", info: 0 }),
					source: null,
				}),
			);
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({ event: "onError", info: 150 }),
					source: null,
				}),
			);
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({ event: "onStateChange", info: 0 }),
					source: iframeA.contentWindow,
				}),
			);
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({ event: "onError", info: 150 }),
					source: iframeA.contentWindow,
				}),
			);
		});
		expect(bgmPlayback.current()?.selected.videoId).toBe("v-track-b");
		expect(controlSpy).not.toHaveBeenCalled();

		// Now DOM iframe.src updates to B and B confirms its videoData and transitions to playing.
		for (const f of document.querySelectorAll(".app-bg-iframe")) f.remove();
		attachIframeForCurrentPlayback();
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({
						event: "initialDelivery",
						info: {
							playerState: -1,
							currentTime: 0,
							videoData: { video_id: "v-track-b", title: "Track B" },
						},
					}),
					source: null,
				}),
			);
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({ event: "onStateChange", info: 1 }),
					source: null,
				}),
			);
		});

		expect(bgmPlayback.current()?.playbackId).toBe(bPlaybackId);
		expect(bgmPlayback.current()?.selected.videoId).toBe("v-track-b");
		expect(bgmPlayback.current()?.status).toBe("playing");

		const eventsForB = controlSpy.mock.calls
			.filter(([arg]) => String(arg).startsWith("bgm_event:"))
			.map(([arg]) => JSON.parse(String(arg).slice("bgm_event:".length)));
		expect(
			eventsForB.filter(
				(ev) => ev.kind === "track_ended" || ev.kind === "track_error",
			),
		).toHaveLength(0);
		expect(eventsForB).toEqual([
			expect.objectContaining({
				kind: "track_playing",
				playbackId: bPlaybackId,
				videoId: "v-track-b",
				title: "Track B",
			}),
		]);

		chatService.setCurrentSpeechActivityId(undefined);
		controlSpy.mockRestore();
	});

	it("(4)(6) emits track_error(timeout) and advances to the next candidate once when a load never confirms or plays within PLAYBACK_TIMEOUT_MS, and clears all timers on stop so no timeout fires after stop (FR-RADIO-DJ.2·12·16)", async () => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout",
				"setInterval",
				"clearInterval",
				"Date",
			],
		});
		const controlSpy = vi
			.spyOn(chatService, "controlSpeechActivity")
			.mockResolvedValue(true);
		chatService.setCurrentSpeechActivityId("dj-activity-1");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				proactiveSpeechProfile: "personal_radio_dj",
				proactiveSpeechPermitted: true,
			}),
		);

		render(<BgmPlayer />);
		await startTrack("v-silent-1", "Silent Candidate 1");
		bgmPlayback.enqueue({ videoId: "v-silent-2", title: "Silent Candidate 2" });
		bgmPlayback.enqueue({ videoId: "v-silent-1", title: "Silent Candidate 1" });
		const silent1PlaybackId = bgmPlayback.current()?.playbackId ?? "";
		attachIframeForCurrentPlayback();

		// (4) No confirmation or playing arrives within PLAYBACK_TIMEOUT_MS (12_000ms) ->
		// emits track_error(reason: "timeout") once, records "v-silent-1" as failed for this session,
		// and advances to "v-silent-2" once.
		await act(async () => {
			vi.advanceTimersByTime(12_500);
			await Promise.resolve();
		});

		expect(bgmPlayback.current()?.selected.videoId).toBe("v-silent-2");
		expect(bgmPlayback.current()?.status).toBe("requested");
		const timeoutEvents = controlSpy.mock.calls
			.filter(([arg]) => String(arg).startsWith("bgm_event:"))
			.map(([arg]) => JSON.parse(String(arg).slice("bgm_event:".length)));
		expect(timeoutEvents).toEqual([
			expect.objectContaining({
				activityId: "dj-activity-1",
				kind: "track_error",
				playbackId: silent1PlaybackId,
				previousVideoId: "v-silent-1",
				previousTitle: "Silent Candidate 1",
				nextVideoId: "v-silent-2",
				nextTitle: "Silent Candidate 2",
				reason: "timeout",
				continued: true,
			}),
		]);

		// (6) Stopping playback clears the active generation's timeout and handshake timers;
		// advancing time past PLAYBACK_TIMEOUT_MS after stop emits zero additional events.
		controlSpy.mockClear();
		await act(async () => {
			bgmCommandHandler()({
				payload: JSON.stringify({ type: "bgm_youtube_stop" }),
			});
			await Promise.resolve();
		});
		act(() => {
			vi.advanceTimersByTime(0);
		});
		expect(bgmPlayback.current()?.status).toBe("ended");
		expect(vi.getTimerCount()).toBe(0);

		await act(async () => {
			vi.advanceTimersByTime(30_000);
			await Promise.resolve();
		});
		expect(controlSpy).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);

		chatService.setCurrentSpeechActivityId(undefined);
		controlSpy.mockRestore();
	});

	it("ignores mismatched infoDelivery videoData while playing, and when advancing the queue updates expected videoId first before emitting track_playing on observed playing (FR-RADIO-DJ.2·5)", async () => {
		const controlSpy = vi
			.spyOn(chatService, "controlSpeechActivity")
			.mockResolvedValue(true);
		chatService.setCurrentSpeechActivityId("dj-activity-1");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				proactiveSpeechProfile: "personal_radio_dj",
				proactiveSpeechPermitted: true,
			}),
		);

		render(<BgmPlayer />);
		await startTrack("v1", "첫 곡");
		bgmPlayback.enqueue({ videoId: "v2", title: "다음 곡" });
		attachIframeForCurrentPlayback();

		// Confirm "v1" is playing
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({
						event: "infoDelivery",
						info: {
							playerState: 1,
							currentTime: 12,
							duration: 180,
							videoData: { video_id: "v1", title: "첫 곡" },
						},
					}),
					source: null,
				}),
			);
		});
		expect(bgmPlayback.current()?.status).toBe("playing");
		controlSpy.mockClear();

		// 1) While "v1" is playing, a detached frame sends infoDelivery with videoData.video_id="v-detached" (mismatching expected "v1"):
		// Must record and ignore without emitting track_changed or track_playing!
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({
						event: "infoDelivery",
						info: {
							playerState: 1,
							currentTime: 5,
							duration: 200,
							videoData: { video_id: "v-detached", title: "엉뚱한 이전 곡" },
						},
					}),
					source: null,
				}),
			);
		});
		expect(controlSpy).not.toHaveBeenCalled();
		expect(bgmPlayback.current()?.selected.videoId).toBe("v1");

		// 2) When "v1" ends and the shell advances to queued "v2", expected videoId becomes "v2" first (emitting track_ended),
		// and track_playing is emitted only when "v2" is observed playing.
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({
						event: "infoDelivery",
						info: {
							playerState: 1,
							currentTime: 179.5,
							duration: 180,
							videoData: { video_id: "v1", title: "첫 곡" },
						},
					}),
					source: null,
				}),
			);
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({ event: "onStateChange", info: 0 }),
					source: null,
				}),
			);
		});
		const nextSnap = bgmPlayback.current();
		expect(nextSnap?.selected.videoId).toBe("v2");
		expect(nextSnap?.status).toBe("requested");
		const eventsAfterEnd = controlSpy.mock.calls.map(([arg]) =>
			JSON.parse(String(arg).slice("bgm_event:".length)),
		);
		expect(eventsAfterEnd).toEqual([
			expect.objectContaining({
				kind: "track_ended",
				previousVideoId: "v1",
				nextVideoId: "v2",
				nextTitle: "다음 곡",
				continued: true,
			}),
		]);

		controlSpy.mockClear();
		for (const f of document.querySelectorAll(".app-bg-iframe")) f.remove();
		attachIframeForCurrentPlayback();
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({
						event: "infoDelivery",
						info: {
							playerState: 1,
							currentTime: 1.5,
							duration: 210,
							videoData: { video_id: "v2", title: "다음 곡" },
						},
					}),
					source: null,
				}),
			);
		});
		expect(bgmPlayback.current()?.status).toBe("playing");
		const eventsAfterNextPlaying = controlSpy.mock.calls.map(([arg]) =>
			JSON.parse(String(arg).slice("bgm_event:".length)),
		);
		expect(eventsAfterNextPlaying).toEqual([
			expect.objectContaining({
				kind: "track_playing",
				playbackId: nextSnap?.playbackId,
				videoId: "v2",
				title: "다음 곡",
			}),
		]);

		chatService.setCurrentSpeechActivityId(undefined);
		controlSpy.mockRestore();
	});

	it("forwards bgm_event with activityId, playbackId, and sequence matching the Agent contract shape", async () => {
		const controlSpy = vi
			.spyOn(chatService, "controlSpeechActivity")
			.mockResolvedValue(true);
		chatService.setCurrentSpeechActivityId("dj-activity-1");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				proactiveSpeechProfile: "personal_radio_dj",
				proactiveSpeechPermitted: true,
			}),
		);

		render(<BgmPlayer />);
		await startTrack("v-1", "첫 곡");
		const playbackId = bgmPlayback.current()?.playbackId ?? "";
		attachIframeForCurrentPlayback();

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({
						event: "initialDelivery",
						info: {
							playerState: -1,
							currentTime: 0,
							videoData: { video_id: "v-1", title: "첫 곡" },
						},
					}),
					source: null,
				}),
			);
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({ event: "onStateChange", info: 1 }),
					source: null,
				}),
			);
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({ event: "onStateChange", info: 0 }),
					source: null,
				}),
			);
		});

		expect(controlSpy).toHaveBeenLastCalledWith(
			`bgm_event:${JSON.stringify({
				activityId: "dj-activity-1",
				kind: "track_ended",
				playbackId,
				sequence: 4,
				previousVideoId: "v-1",
				previousTitle: "첫 곡",
				continued: false,
			})}`,
			"dj-activity-1",
		);
		chatService.setCurrentSpeechActivityId(undefined);
		controlSpy.mockRestore();
	});
});

describe("BgmPlayer AI next on mixed local/YouTube playlists (#671)", () => {
	beforeEach(() => {
		bgmPlayback.reset();
		useAppStore.setState({ aiInterferenceEnabled: true });
		vi.mocked(listNaiaAssets).mockResolvedValue(["/music/local-two.mp3"]);
		vi.mocked(toLocalBlobUrl).mockResolvedValue("blob:local-two");
		vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
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

	it("plays the local file and confirms playing when AI next advances the playlist", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				locale: "en",
				bgmLibrary: {
					schemaVersion: 1,
					likes: [],
					playlists: [
						{
							id: "mix",
							name: "Mix",
							createdAt: 1,
							updatedAt: 1,
							tracks: [
								{
									id: "youtube:first",
									source: "youtube",
									youtubeId: "first",
									title: "YouTube One",
								},
								{
									id: "local:/music/local-two.mp3",
									source: "local",
									path: "/music/local-two.mp3",
									title: "Local Two",
								},
							],
						},
					],
					activePlaylistId: "mix",
					currentIndex: 0,
					shuffle: false,
					repeat: "off",
					queue: [],
					history: [],
				},
			}),
		);
		const { container } = render(<BgmPlayer />);
		await waitFor(() =>
			expect(container.querySelector(".bgm-player")).toHaveAttribute(
				"data-bgm-local-count",
				"1",
			),
		);
		await startTrack("first", "YouTube One");
		bgmCommandHandler()({
			payload: JSON.stringify({ type: "bgm_youtube_next" }),
		});
		await waitFor(() => {
			expect(bgmPlayback.current()?.selected.title).toBe("Local Two");
			expect(bgmPlayback.current()?.status).toBe("playing");
		});
		expect(container.querySelector(".bgm-player")).toHaveAttribute(
			"data-bgm-playback-status",
			"playing",
		);
		expect(container.querySelector(".bgm-player")).toHaveAttribute(
			"data-bgm-announced-title",
			"Local Two",
		);
	});

	it("initiates listening handshake on iframe load and subscribes to onStateChange/onError upon first player message (#521)", async () => {
		vi.useFakeTimers();
		render(<BgmPlayer />);
		await startTrack("v-handshake", "Handshake Song");
		const iframe = attachIframeForCurrentPlayback();
		const postMessageSpy = vi.fn();
		Object.defineProperty(iframe, "contentWindow", {
			configurable: true,
			value: { postMessage: postMessageSpy },
		});

		act(() => {
			iframe.dispatchEvent(new Event("load"));
		});

		const postedEvents = () =>
			postMessageSpy.mock.calls.map(([payload]) => JSON.parse(String(payload)));

		expect(postedEvents()[0]).toEqual({
			event: "listening",
			id: 1,
			channel: "widget",
		});

		act(() => {
			vi.advanceTimersByTime(250);
		});
		expect(
			postedEvents().filter((m) => m.event === "listening").length,
		).toBeGreaterThanOrEqual(2);

		postMessageSpy.mockClear();
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({
						event: "initialDelivery",
						info: {
							playerState: 1,
							currentTime: 1.5,
							videoData: { video_id: "v-handshake", title: "Handshake Song" },
						},
					}),
					origin: "https://www.youtube.com",
					source: iframe.contentWindow,
				}),
			);
		});

		expect(postedEvents()).toEqual(
			expect.arrayContaining([
				{
					event: "command",
					func: "addEventListener",
					args: ["onStateChange"],
					id: 1,
					channel: "widget",
				},
				{
					event: "command",
					func: "addEventListener",
					args: ["onError"],
					id: 1,
					channel: "widget",
				},
			]),
		);
		expect(bgmPlayback.current()?.status).toBe("playing");

		postMessageSpy.mockClear();
		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(postedEvents().filter((m) => m.event === "listening")).toHaveLength(0);
	});
});
