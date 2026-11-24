import { ttsSyncMocks, deferred, capturedRequests, mockInvoke } from "./chat-area-fixture";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { isNewCore } from "../../lib/chat-service";
import { useAvatarStore } from "../../stores/avatar";
import { useCascadeAvatarStore } from "../../stores/cascade-avatar";
import { useChatStore } from "../../stores/chat";
import { ChatArea } from "../ChatArea";

export function registerChatAreaCases06() {
	it("keeps the final text streaming after tool-round usage", async () => {
		localStorage.removeItem("naia-adk-path");
		vi.mocked(isNewCore).mockReturnValue(true);
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
		fireEvent.change(input, { target: { value: "continue after tool" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "tool_use",
			requestId: request.requestId,
			toolCallId: "tool-1",
			toolName: "list_dir",
			args: { path: "." },
		});
		request.onChunk({
			type: "tool_result",
			requestId: request.requestId,
			toolCallId: "tool-1",
			toolName: "list_dir",
			output: "[]",
			success: true,
		});
		request.onChunk({
			type: "usage",
			requestId: request.requestId,
			inputTokens: 3,
			outputTokens: 2,
			cost: 0.0059,
			model: "gemini-2.5-flash",
		});
		// The first text chunk is still inside a thinking tag, so there is no
		// visible text yet. The usage event must not commit a blank assistant.
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "<thi",
		});
		expect(useChatStore.getState().isStreaming).toBe(true);
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "nk>private chain</think>Visible answer.",
		});
		request.onChunk({ type: "finish", requestId: request.requestId });

		await waitFor(() =>
			expect(screen.getByText("Visible answer.")).toBeDefined(),
		);
		const assistants = useChatStore
			.getState()
			.messages.filter((message) => message.role === "assistant");
		expect(assistants).toHaveLength(1);
		expect(assistants[0].content).toContain("Visible answer.");
		await waitFor(() =>
			expect(document.querySelector(".cost-badge")).not.toBeNull(),
		);
		localStorage.removeItem("naia-config");
	});

	it("commits accumulated tool-round cost when a response is cancelled", async () => {
		localStorage.removeItem("naia-adk-path");
		vi.mocked(isNewCore).mockReturnValue(true);
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
		fireEvent.change(input, { target: { value: "cancel after tool usage" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "Partial answer.",
		});
		request.onChunk({
			type: "usage",
			requestId: request.requestId,
			inputTokens: 1,
			outputTokens: 2,
			cost: 0.001,
			model: "gemini-2.5-flash",
		});
		request.onChunk({
			type: "usage",
			requestId: request.requestId,
			inputTokens: 3,
			outputTokens: 4,
			cost: 0.002,
			model: "gemini-2.5-flash",
		});

		fireEvent.click(screen.getByTitle("ESC"));
		await waitFor(() =>
			expect(useChatStore.getState().isStreaming).toBe(false),
		);
		const assistants = useChatStore
			.getState()
			.messages.filter((message) => message.role === "assistant");
		expect(assistants).toHaveLength(1);
		expect(assistants[0].content).toContain("Partial answer.");
		expect(assistants[0].cost).toMatchObject({
			inputTokens: 4,
			outputTokens: 6,
			cost: 0.003,
		});
		localStorage.removeItem("naia-config");
	});

	// #571 — 문장 단위 공개가 사라지면서 "문장 사이에 공백이 끼는가" 는 이어 붙인
	// 본문을 그대로 그리는 문제가 됐다. 계약은 남는다: 두 문장이 붙어 나오되
	// 사이에 없던 공백이 생기지 않는다. 달라진 것은 시점뿐이다 — 재생을 기다리지
	// 않는다.
	it("renders both CJK sentences as they arrive without inserting a space", async () => {
		const playAuthoredClip = vi.fn().mockResolvedValue(undefined);
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
		fireEvent.change(input, { target: { value: "中文同步" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		const first = "这是第一句测试内容。";
		const second = "这是第二句测试内容。";
		let spacedApart = false;
		const spacingObserver = new MutationObserver(() => {
			if (document.body.textContent?.includes(`${first} ${second}`)) {
				spacedApart = true;
			}
		});
		spacingObserver.observe(document.body, {
			childList: true,
			characterData: true,
			subtree: true,
		});
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: first,
		});
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: second,
		});
		request.onChunk({
			type: "usage",
			requestId: request.requestId,
			inputTokens: 1,
			outputTokens: 2,
			cost: 0,
			model: "test",
		});
		request.onChunk({ type: "finish", requestId: request.requestId });

		await waitFor(() => expect(playAuthoredClip).toHaveBeenCalledTimes(2));
		// 재생 콜백이 하나도 오지 않은 지금 이미 전문이 읽힌다.
		expect(document.body.textContent).toContain(first + second);
		const firstOptions = playAuthoredClip.mock.calls[0][1] as {
			onPlaybackReady?: () => void;
		};
		firstOptions.onPlaybackReady?.();
		const secondOptions = playAuthoredClip.mock.calls[1][1] as {
			onPlaybackReady?: () => void;
		};
		secondOptions.onPlaybackReady?.();
		await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
		expect(document.body.textContent).toContain(first + second);
		spacingObserver.disconnect();
		expect(spacedApart).toBe(false);
		localStorage.removeItem("naia-config");
	});

	// #571 — 재생 준비 콜백이 유실돼도 본문은 애초에 가려져 있지 않다. 남은 계약은
	// "말하는 중" 표시가 영영 남지 않는가이다.
	it("keeps a completed answer readable and drops the voice chip when a playback-ready callback is lost", async () => {
		const playAuthoredClip = vi.fn().mockReturnValue(new Promise(() => {}));
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
		fireEvent.change(input, { target: { value: "lost callback" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		const answer = "The complete answer must remain readable.";
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: answer,
		});
		await waitFor(() => expect(playAuthoredClip).toHaveBeenCalledTimes(1));
		expect(screen.getByText(answer)).toBeDefined();

		vi.useFakeTimers();
		request.onChunk({ type: "finish", requestId: request.requestId });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(8_000);
		});
		expect(screen.getByText(answer)).toBeDefined();
		expect(screen.queryByRole("status")).toBeNull();
		vi.useRealTimers();
		localStorage.removeItem("naia-config");
	});

	it("does not retarget the completed-message mask to a later TTS failure notice", async () => {
		let rejectSynthesis!: (reason?: unknown) => void;
		const synthesis = new Promise<{ audioBase64: string; costUsd: number }>(
			(_resolve, reject) => {
				rejectSynthesis = reject;
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
		fireEvent.change(input, { target: { value: "failure mask" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		const answer = "This sentence remains the answer.";
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
			cost: 0,
			model: "test",
		});
		await waitFor(() => expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalled());
		request.onChunk({ type: "finish", requestId: request.requestId });
		expect(useAvatarStore.getState().currentEmotion).toBe("think");
		rejectSynthesis(new Error("voice offline"));

		await waitFor(() => expect(screen.getByText(answer)).toBeDefined());
		await waitFor(() =>
			expect(
				screen.getByText(/Can't reach the host voice engine/),
			).toBeDefined(),
		);
		await waitFor(() => expect(screen.getAllByText(answer)).toHaveLength(1));
		await waitFor(() =>
			expect(useAvatarStore.getState().currentEmotion).toBe("neutral"),
		);
		expect(screen.getByText(/Can't reach the host voice engine/)).toBeDefined();
		localStorage.removeItem("naia-config");
	});

	it("reports VoxCPM2 startup instead of an unreachable engine while cascade is starting", async () => {
		ttsSyncMocks.synthesizeTts.mockRejectedValue(new Error("voice starting"));
		mockInvoke.mockImplementation((command: string) =>
			Promise.resolve(
				command === "voxcpm2_runtime_status" ? "starting" : undefined,
			),
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
		fireEvent.change(input, { target: { value: "startup state" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "This sentence waits for the model.",
		});

		await waitFor(() =>
			expect(screen.getByText(/host voice model is starting/i)).toBeDefined(),
		);
		expect(screen.queryByText(/Can't reach the host voice engine/)).toBeNull();
		localStorage.removeItem("naia-config");
	});

	it("does not synthesize stale fallback audio after a media runtime interrupt", async () => {
		const playback = deferred<void>();
		let playbackFailure = () => {};
		const interrupt = vi.fn();
		const playAuthoredClip = vi.fn(
			(_text: string, opts: { onPlaybackFailure?: () => void }) => {
				playbackFailure = opts.onPlaybackFailure ?? (() => {});
				return playback.promise;
			},
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
		fireEvent.change(input, { target: { value: "interrupt test" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "Interrupted sentence.",
		});
		await waitFor(() => expect(playAuthoredClip).toHaveBeenCalledTimes(1));
		interrupt.mockClear();
		const cancel = screen.getByTitle("ESC");
		fireEvent.click(cancel);
		await waitFor(() => expect(screen.queryByTitle("ESC")).toBeNull());
		expect(interrupt).toHaveBeenCalledTimes(1);
		playbackFailure();
		playback.resolve();
		await Promise.resolve();
		expect(ttsSyncMocks.synthesizeTts).not.toHaveBeenCalled();
		expect(ttsSyncMocks.enqueueOrdered).not.toHaveBeenCalled();
		localStorage.removeItem("naia-config");
	});

}
