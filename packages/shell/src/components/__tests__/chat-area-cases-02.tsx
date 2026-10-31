import { ttsSyncMocks, mockSendAppSkills, capturedRequests } from "./chat-area-fixture";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { registerCameraActions } from "../../lib/avatar/camera-actions";
import { useAvatarStore } from "../../stores/avatar";
import { useCascadeAvatarStore } from "../../stores/cascade-avatar";
import { useChatStore } from "../../stores/chat";
import { ChatArea } from "../ChatArea";

export function registerChatAreaCases02() {
	it("shows the provider error when a zero-token usage event precedes failure", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "invalid-test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "certification probe" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "usage",
			requestId: request.requestId,
			inputTokens: 0,
			outputTokens: 0,
			cost: 0,
			model: "gemini-2.5-flash",
		});
		request.onChunk({
			type: "error",
			requestId: request.requestId,
			message: "provider rejected the API key",
		});

		// #572 — 원문은 답변 본문이 아니라 실패 표시의 접힌 상세로 간다.
		await waitFor(() =>
			expect(
				useChatStore.getState().messages.at(-1)?.failure?.detail,
			).toContain("provider rejected the API key"),
		);
		expect(useChatStore.getState().messages.at(-1)?.content).toBe("");
		expect(useChatStore.getState().isStreaming).toBe(false);
		localStorage.removeItem("naia-config");
	});

	it("keeps an explicit emotion until queued speech ends", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "edge",
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "tell me good news" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "[HAPPY] Great news!",
		});
		await waitFor(() => expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalled());
		await waitFor(() => expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalled());
		expect(useAvatarStore.getState().currentEmotion).toBe("happy");

		request.onChunk({ type: "finish", requestId: request.requestId });
		expect(useAvatarStore.getState().currentEmotion).toBe("happy");

		ttsSyncMocks.audioQueueActive = false;
		ttsSyncMocks.audioQueueCallbacks?.onPlaybackEnd?.();
		expect(useAvatarStore.getState().currentEmotion).toBe("neutral");
		localStorage.removeItem("naia-config");
	});

	it("does not send a turn when pre-turn BGM skill registration fails", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		mockSendAppSkills.mockResolvedValueOnce(false);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "radio please" } });
		fireEvent.keyDown(input, { key: "Enter" });

		expect(
			await screen.findByText(/skill_youtube_bgm_registration_failed/),
		).toBeDefined();
		expect(capturedRequests).toHaveLength(0);
	});

	it("does not send empty message", () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		render(<ChatArea />);
		// Send button is the last button in the input bar
		const buttons = screen.getAllByRole("button");
		const sendBtn = buttons.find((b) => b.textContent === "↑")!;
		fireEvent.click(sendBtn);
		// No messages should be added
		expect(useChatStore.getState().messages).toHaveLength(0);
		localStorage.removeItem("naia-config");
	});

	it("sends message on Enter", async () => {
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "안녕" } });
		fireEvent.keyDown(input, { key: "Enter" });

		// Wait for async state updates
		await new Promise((r) => setTimeout(r, 50));

		// User message + assistant error message (no API key)
		const { messages } = useChatStore.getState();
		expect(messages.length).toBeGreaterThanOrEqual(1);
		expect(messages[0].content).toBe("안녕");
		expect(messages[0].role).toBe("user");
	});

	it("displays session cost header", () => {
		useChatStore.setState({ totalSessionCost: 0.005 });
		render(<ChatArea />);
		expect(screen.getByText(/\$0\.005/)).toBeDefined();
	});

	it("shows Naia-account session cost in credits, not dollars (#727)", () => {
		useChatStore.setState({
			provider: "nextain",
			totalSessionCost: 0.005,
			totalSessionCostNaia: 0.005,
		});
		render(<ChatArea />);
		expect(screen.getByText("≈ 5 credits")).toBeDefined();
		expect(screen.queryByText(/\$0\.005/)).toBeNull();
	});

	it("labels own-key session cost as a provider-price estimate (#727)", () => {
		useChatStore.setState({
			provider: "gemini",
			totalSessionCost: 0.005,
			totalSessionCostNaia: 0,
		});
		render(<ChatArea />);
		expect(screen.getByText("$0.0050 (provider price est.)")).toBeDefined();
	});

	it("shows streaming indicator when streaming", () => {
		useChatStore.setState({
			isStreaming: true,
			streamingContent: "응답 중...",
		});
		render(<ChatArea />);
		expect(screen.getByText(/응답 중/)).toBeDefined();
	});

	it("separates split think-tag text and keeps streaming reasoning collapsed", async () => {
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
		fireEvent.change(input, { target: { value: "reason carefully" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		for (const text of [
			"<thi",
			"nk>private chain",
			"</thi",
			"nk>Final answer.",
		]) {
			request.onChunk({ type: "text", requestId: request.requestId, text });
		}

		expect(useChatStore.getState().streamingThinking).toBe("private chain");
		expect(useChatStore.getState().streamingContent).toBe("Final answer.");
		const reasoning = (await screen.findAllByText("private chain")).find(
			(node) => node.classList.contains("thinking-inline-content"),
		);
		expect(reasoning).toBeDefined();
		expect(reasoning?.closest("details")?.hasAttribute("open")).toBe(false);
		expect(
			reasoning
				?.closest("details")
				?.querySelector(".thinking-inline-preview-live > span")?.textContent,
		).toBe("private chain");

		request.onChunk({ type: "finish", requestId: request.requestId });
		const assistant = useChatStore
			.getState()
			.messages.find((message) => message.role === "assistant");
		expect(assistant?.thinking).toBe("private chain");
		expect(assistant?.content).toBe("Final answer.");
		localStorage.removeItem("naia-config");
	});

	it("strips split NVA gesture markers from chat and TTS and sends active actions to the core", async () => {
		const playAction = vi.fn().mockResolvedValue(true);
		registerCameraActions({
			getGestureActions: () => [
				{ key: "wave", label: "Wave" },
				{ key: "nod", label: "Nod" },
			],
			playAction,
		});
		useCascadeAvatarStore.getState().setRenderer({
			interrupt: vi.fn(),
			hasAuthoredClip: vi.fn(() => false),
			setSpeakingVisual: vi.fn(),
		} as never);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "edge",
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "say hello" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		const actionsSegment = request.environmentSegments?.find(
			(segment) =>
				segment.kind === "app" &&
				segment.entries.some((entry) => entry.type === "NVA gesture actions"),
		);
		expect(actionsSegment).toBeDefined();
		if (actionsSegment?.kind === "app") {
			const actionData = actionsSegment.entries[0]?.data as
				| { instructions?: string }
				| undefined;
			expect(actionData?.instructions).toContain("[[gesture:key]]");
		}

		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "Hello [[ges",
		});
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "ture:wave]] [[gesture:nod]] there.",
		});
		expect(useChatStore.getState().streamingContent).toBe("Hello there.");
		expect(useChatStore.getState().streamingContent).not.toContain(
			"[[gesture:",
		);
		expect(playAction).not.toHaveBeenCalled();

		request.onChunk({ type: "finish", requestId: request.requestId });
		await waitFor(() => expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalled());
		await waitFor(() => expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalled());
		expect(playAction).not.toHaveBeenCalled();
		act(() => ttsSyncMocks.audioQueueCallbacks?.onPlaybackStart?.());
		expect(playAction).not.toHaveBeenCalled();
		act(() => {
			ttsSyncMocks.audioQueueActive = false;
			ttsSyncMocks.audioQueueCallbacks?.onPlaybackEnd?.();
		});
		await waitFor(() => expect(playAction).toHaveBeenCalledTimes(1));
		expect(playAction).toHaveBeenCalledWith("wave");
		expect(
			ttsSyncMocks.synthesizeTts.mock.calls.map(([input]) => input.text),
		).toEqual(["Hello there."]);
		expect(
			useChatStore
				.getState()
				.messages.find((message) => message.role === "assistant")?.content,
		).toBe("Hello there.");
		localStorage.removeItem("naia-config");
	});

	it("keeps a deferred AI gesture while the user edits a draft", async () => {
		const playAction = vi.fn().mockResolvedValue(true);
		registerCameraActions({
			getGestureActions: () => [{ key: "wave", label: "Wave" }],
			playAction,
		});
		useCascadeAvatarStore.getState().setRenderer({
			interrupt: vi.fn(),
			hasAuthoredClip: vi.fn(() => false),
			setSpeakingVisual: vi.fn(),
		} as never);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "first request" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "Hello [[gesture:wave]]",
		});
		expect(playAction).not.toHaveBeenCalled();

		fireEvent.change(input, { target: { value: "new user draft" } });
		request.onChunk({ type: "finish", requestId: request.requestId });
		await waitFor(() => expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalled());
		act(() => {
			ttsSyncMocks.audioQueueActive = false;
			ttsSyncMocks.audioQueueCallbacks?.onPlaybackEnd?.();
		});
		await waitFor(() => expect(playAction).toHaveBeenCalledWith("wave"));
		localStorage.removeItem("naia-config");
	});

	it("drops a deferred AI gesture after a new message is sent", async () => {
		const playAction = vi.fn().mockResolvedValue(true);
		registerCameraActions({
			getGestureActions: () => [{ key: "wave", label: "Wave" }],
			playAction,
		});
		useCascadeAvatarStore.getState().setRenderer({
			interrupt: vi.fn(),
			hasAuthoredClip: vi.fn(() => false),
			setSpeakingVisual: vi.fn(),
		} as never);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "first request" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const first = capturedRequests[0];
		first.onChunk({
			type: "text",
			requestId: first.requestId,
			text: "Hello [[gesture:wave]]",
		});
		first.onChunk({ type: "finish", requestId: first.requestId });
		await waitFor(() => expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalled());

		fireEvent.change(input, { target: { value: "new submitted message" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(2));
		capturedRequests[1].onChunk({
			type: "finish",
			requestId: capturedRequests[1].requestId,
		});
		act(() => {
			ttsSyncMocks.audioQueueActive = false;
			ttsSyncMocks.audioQueueCallbacks?.onPlaybackEnd?.();
		});
		expect(playAction).not.toHaveBeenCalled();
		localStorage.removeItem("naia-config");
	});

}
