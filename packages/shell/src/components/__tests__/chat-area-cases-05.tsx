import { ttsSyncMocks, deferred, capturedRequests } from "./chat-area-fixture";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useAvatarStore } from "../../stores/avatar";
import { useCascadeAvatarStore } from "../../stores/cascade-avatar";
import { ChatArea } from "../ChatArea";

export function registerChatAreaCases05() {
	it("applies a local voice preset to the active Shell TTS pipeline", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				voiceRefUrl: "http://127.0.0.1:8910/ref/audio/ref_ko_485.wav",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "voice switch test" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));

		window.dispatchEvent(
			new CustomEvent("naia:voice-ref-url", {
				detail: "http://127.0.0.1:8910/ref/audio/male-20s-01.wav",
			}),
		);
		capturedRequests[0].onChunk({
			type: "text",
			requestId: capturedRequests[0].requestId,
			text: "The selected voice is active.",
		});

		await waitFor(() => expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalled());
		expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "naia-local-voice",
				voice: "male-20s-01.wav",
			}),
		);
		localStorage.removeItem("naia-config");
	});

	it("keeps the video avatar visible without synthesizing speech when TTS is off", async () => {
		const playAuthoredClip = vi.fn();
		useCascadeAvatarStore.setState({
			renderer: {
				hasAuthoredClip: () => true,
				playAuthoredClip,
				setSpeakingVisual: vi.fn(),
				setVoice: vi.fn().mockResolvedValue(false),
				interrupt: vi.fn(),
				stop: vi.fn(),
			} as never,
		});
		ttsSyncMocks.streamsAvatarPcm.mockReturnValue(true);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: false,
				ttsProvider: "naia-local-voice",
				avatarProvider: "naia-video-avatar",
				nvaModel: "naia",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "silent avatar test" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "The avatar remains visible without voice.",
		});

		await waitFor(() =>
			expect(
				screen.getByText("The avatar remains visible without voice."),
			).toBeDefined(),
		);
		expect(ttsSyncMocks.synthesizeTts).not.toHaveBeenCalled();
		expect(playAuthoredClip).not.toHaveBeenCalled();
		localStorage.removeItem("naia-config");
	});

	it("serializes 6GB local sentence synthesis while playback queues independently", async () => {
		// A resolved test promise can take <1ms. Control elapsed synthesis time
		// so the intended cold-engine RTF>1 condition does not depend on CPU load.
		let elapsed = 0;
		vi.spyOn(performance, "now").mockImplementation(() => (elapsed += 100));
		const firstTts = deferred<{ audioBase64: string; costUsd: number }>();
		const secondTts = deferred<{ audioBase64: string; costUsd: number }>();
		ttsSyncMocks.streamsAvatarPcm.mockReturnValue(false);
		ttsSyncMocks.wavDurationSeconds.mockReturnValue(0.001);
		ttsSyncMocks.synthesizeTts.mockImplementation(
			({ text }: { text: string }) =>
				text.startsWith("First") ? firstTts.promise : secondTts.promise,
		);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "voice queue test" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "First sentence.",
		});
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "Second sentence.",
		});

		await waitFor(() =>
			expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalledTimes(1),
		);
		expect(ttsSyncMocks.synthesizeTts.mock.calls[0][0].text).toBe(
			"First sentence.",
		);
		firstTts.resolve({ audioBase64: "audio-1", costUsd: 0 });

		await waitFor(() =>
			expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalledWith(
				0,
				"audio-1",
				expect.any(Object),
			),
		);
		expect(ttsSyncMocks.pauseBeforePlayback).toHaveBeenCalledTimes(1);
		expect(ttsSyncMocks.resumePlayback).not.toHaveBeenCalled();
		// #688 (Luke 2026-09-22): supersedes FR-VOICE.19 complete-then-play.
		// Playback window releases after a 1 s grace for the first sentence
		// when RTF>1, without waiting for the whole turn or finishStream.
		await waitFor(
			() => expect(ttsSyncMocks.resumePlayback).toHaveBeenCalledTimes(1),
			{ timeout: 3000 },
		);
		await waitFor(() =>
			expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalledTimes(2),
		);
		expect(ttsSyncMocks.synthesizeTts.mock.calls[1][0].text).toBe(
			"Second sentence.",
		);
		secondTts.resolve({ audioBase64: "audio-2", costUsd: 0 });
		await waitFor(() =>
			expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalledWith(
				1,
				"audio-2",
				expect.any(Object),
			),
		);
		// Later sentences never re-hold playback; resumePlayback is still 1.
		expect(ttsSyncMocks.resumePlayback).toHaveBeenCalledTimes(1);
		request.onChunk({ type: "finish", requestId: request.requestId });
		expect(ttsSyncMocks.resumePlayback).toHaveBeenCalledTimes(1);
		localStorage.removeItem("naia-config");
	});

	it("reveals text without duplicate AudioQueue playback when media runtime fails", async () => {
		const playAuthoredClip = vi
			.fn()
			.mockImplementation(
				(_text: string, opts: { onPlaybackFailure?: () => void }) => {
					opts.onPlaybackFailure?.();
					return Promise.resolve();
				},
			);
		useCascadeAvatarStore.setState({
			renderer: {
				hasAuthoredClip: () => true,
				playAuthoredClip,
				setSpeakingVisual: vi.fn(),
				setVoice: vi.fn().mockResolvedValue(false),
				interrupt: vi.fn(),
				stop: vi.fn(),
			} as never,
		});
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "failure test" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "Avatar failure sentence.",
		});

		await waitFor(() => expect(playAuthoredClip).toHaveBeenCalledTimes(1));
		await waitFor(() =>
			expect(screen.getByText("Avatar failure sentence.")).toBeDefined(),
		);
		expect(ttsSyncMocks.synthesizeTts).not.toHaveBeenCalled();
		expect(ttsSyncMocks.enqueueOrdered).not.toHaveBeenCalled();
		localStorage.removeItem("naia-config");
	});

	// #571 — 예전 계약은 "재생이 시작될 때까지 본문을 감춘다" 였다. 그 감춤이 음성이
	// 느린 기계에서 본문을 인질로 잡았다(win-rtx4060: 비용 배지만 찍히고 60초 공백).
	// 지금 계약은 그 반대다 — 본문은 재생과 무관하게 즉시 그려지고, 재생 상태는
	// 별도의 진행 표시로만 나타난다.
	it("renders chat text immediately and tracks avatar playback only in the voice chip", async () => {
		const playback = deferred<void>();
		const interrupt = vi.fn();
		const playAuthoredClip = vi.fn(
			(_text: string, _options: { onPlaybackReady?: () => void }) =>
				playback.promise,
		);
		useCascadeAvatarStore.setState({
			renderer: {
				hasAuthoredClip: () => true,
				playAuthoredClip,
				setSpeakingVisual: vi.fn(),
				setVoice: vi.fn().mockResolvedValue(false),
				interrupt,
				stop: vi.fn(),
			} as never,
		});
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "sync test" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "Visible with speech.",
		});

		await waitFor(() => expect(playAuthoredClip).toHaveBeenCalledTimes(1));
		// 재생이 시작되기 전에 이미 읽을 수 있어야 한다.
		expect(screen.getByText("Visible with speech.")).toBeDefined();
		expect(screen.getByRole("status").getAttribute("data-stage")).toBe(
			"render",
		);
		const playbackOptions = playAuthoredClip.mock.calls[0][1] as {
			onPlaybackReady?: () => void;
		};
		playbackOptions.onPlaybackReady?.();
		await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
		expect(screen.getByText("Visible with speech.")).toBeDefined();
		interrupt.mockClear();
		const cancel = screen.getByTitle("ESC");
		fireEvent.click(cancel);
		await waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(screen.queryByTitle("ESC")).toBeNull());
		expect(useAvatarStore.getState().currentEmotion).toBe("neutral");
		expect(screen.getByText("Visible with speech.")).toBeDefined();

		playback.resolve();
		localStorage.removeItem("naia-config");
	});

	// #572 — 현장 관측: 메모 저장을 시키면 답변 자리에 `[오류] provider error:
	// invalid tool_call index` 가 그대로 찍혔다. 계약은 셋이다 — 원시 문자열이
	// 답변 버블에 없을 것, 사용자 말로 된 안내와 재시도가 있을 것, 원문은 접힌
	// 영역에만 있을 것. 재시도는 같은 입력을 다시 보낸다.
	it("replaces a raw provider error with a recoverable notice and retries the same input", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "save a memo" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		const raw = "provider error: invalid tool_call index";
		request.onChunk({
			type: "error",
			requestId: request.requestId,
			message: raw,
		});

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("I could not finish that answer");
		// 원문은 접힌 영역 안에만 둔다.
		expect(alert.querySelector("details")?.textContent).toContain(raw);
		// 답변 버블 어디에도 원시 문자열이 없다.
		for (const bubble of document.querySelectorAll(".message-content")) {
			expect(bubble.textContent ?? "").not.toContain("invalid tool_call index");
		}

		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		await waitFor(() => expect(capturedRequests).toHaveLength(2));
		expect(capturedRequests[1].message).toBe("save a memo");
		localStorage.removeItem("naia-config");
	});

	// #571 — 이 기계(리눅스)는 음성이 빨라 현장 증상이 재현되지 않는다. 그래서
	// 합성을 5초 뒤에 끝나게 만들어 느린 기계를 흉내낸다. 계약은 하나다:
	// **답 텍스트는 TTS 합성이 끝나기 전에 이미 DOM 에 있다.** 현장 보고(win-rtx4060)
	// 에서 비용 배지는 즉시 찍히는데 본문만 없었으므로, 둘이 같은 시점에 있는지도
	// 함께 잰다.
	it("shows the answer and its cost badge before a slow TTS synthesis finishes", async () => {
		let finishSynthesis!: () => void;
		const synthesis = new Promise<{ audioBase64: string; costUsd: number }>(
			(resolve) => {
				finishSynthesis = () =>
					resolve({ audioBase64: "slow-audio", costUsd: 0 });
			},
		);
		ttsSyncMocks.synthesizeTts.mockReturnValue(synthesis);
		ttsSyncMocks.streamsAvatarPcm.mockReturnValue(false);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "slow voice" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		const answer = "Text must not wait for the voice.";
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: answer,
		});
		request.onChunk({
			type: "usage",
			requestId: request.requestId,
			inputTokens: 1,
			outputTokens: 2,
			cost: 0.0059,
			model: "test",
		});
		request.onChunk({ type: "finish", requestId: request.requestId });
		await waitFor(() => expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalled());

		// 합성은 아직 끝나지 않았다 — 그런데도 본문과 비용 배지가 함께 있어야 한다.
		expect(screen.getByText(answer)).toBeDefined();
		await waitFor(() =>
			expect(document.querySelector(".cost-badge")).not.toBeNull(),
		);
		expect(screen.getByText(answer)).toBeDefined();

		// 느린 기계 흉내: 합성은 5초 뒤에야 끝난다. 그 뒤에도 본문은 그대로다.
		vi.useFakeTimers();
		setTimeout(finishSynthesis, 5_000);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});
		expect(screen.getByText(answer)).toBeDefined();
		vi.useRealTimers();
		ttsSyncMocks.synthesizeTts.mockResolvedValue({
			audioBase64: "default-audio",
			costUsd: 0,
		});
		localStorage.removeItem("naia-config");
	});

}
