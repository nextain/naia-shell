import { ttsSyncMocks, capturedOnChunk, capturedRequests } from "./chat-area-fixture";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { registerCameraActions } from "../../lib/avatar/camera-actions";
import { useCascadeAvatarStore } from "../../stores/cascade-avatar";
import { useChatStore } from "../../stores/chat";
import { ChatArea } from "../ChatArea";
import * as voiceSessionApi from "../../lib/voice/index";
import type { VoiceSession } from "./chat-area-fixture";

export function registerChatAreaCases03() {
	it("does not record a manual hotkey when the renderer refuses playback", async () => {
		const playAction = vi
			.fn()
			.mockResolvedValueOnce(false)
			.mockResolvedValue(true);
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
				ttsEnabled: false,
			}),
		);
		render(<ChatArea />);

		const hotkey = new KeyboardEvent("keydown", {
			bubbles: true,
			cancelable: true,
			key: "¡",
			code: "Digit1",
			altKey: true,
		});
		window.dispatchEvent(hotkey);
		expect(hotkey.defaultPrevented).toBe(true);
		await waitFor(() => expect(playAction).toHaveBeenCalledTimes(1));

		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "another response" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		capturedRequests[0].onChunk({
			type: "text",
			requestId: capturedRequests[0].requestId,
			text: "[[gesture:wave]]",
		});
		await waitFor(() => expect(playAction).toHaveBeenCalledTimes(2));
		expect(playAction).toHaveBeenLastCalledWith("wave");
		localStorage.removeItem("naia-config");
	});

	it("discards a deferred gesture when its active avatar is replaced", async () => {
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
		act(() =>
			useCascadeAvatarStore.getState().setRenderer({
				interrupt: vi.fn(),
				hasAuthoredClip: vi.fn(() => false),
				setSpeakingVisual: vi.fn(),
			} as never),
		);
		request.onChunk({ type: "finish", requestId: request.requestId });
		await waitFor(() => expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalled());
		act(() => {
			ttsSyncMocks.audioQueueActive = false;
			ttsSyncMocks.audioQueueCallbacks?.onPlaybackEnd?.();
		});
		expect(playAction).not.toHaveBeenCalled();
		localStorage.removeItem("naia-config");
	});

	it("discards a deferred gesture when the response is cancelled", async () => {
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
		fireEvent.keyDown(window, { key: "Escape" });
		expect(playAction).not.toHaveBeenCalled();
		localStorage.removeItem("naia-config");
	});

	it("plays AI gestures immediately with TTS off and limits the next response", async () => {
		const playAction = vi.fn().mockResolvedValue(true);
		registerCameraActions({
			getGestureActions: () => [
				{ key: "wave", label: "Wave" },
				{ key: "cheer", label: "Cheer" },
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
				ttsEnabled: false,
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "first response" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const first = capturedRequests[0];
		first.onChunk({
			type: "text",
			requestId: first.requestId,
			text: "Hello [[gesture:wave]]",
		});
		expect(playAction).toHaveBeenCalledTimes(1);
		expect(playAction).toHaveBeenCalledWith("wave");
		first.onChunk({ type: "finish", requestId: first.requestId });

		fireEvent.change(input, { target: { value: "second response" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(2));
		const second = capturedRequests[1];
		second.onChunk({
			type: "text",
			requestId: second.requestId,
			text: "Great [[gesture:cheer]]",
		});
		expect(playAction).toHaveBeenCalledTimes(1);
		second.onChunk({ type: "finish", requestId: second.requestId });
		localStorage.removeItem("naia-config");
	});

	it.each(["onTurnEnd", "onInterrupted"] as const)(
		"records pending live voice text when %s flushes the response",
		async (terminalEvent) => {
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					provider: "nextain",
					model: "test-omni",
					naiaKey: "test-key",
				}),
			);
			const originalAudioContext = globalThis.AudioContext;
			vi.stubGlobal(
				"AudioContext",
				class {
					sampleRate = 24000;
					state = "running";
					currentTime = 0;
					destination = {};
					close = vi.fn().mockResolvedValue(undefined);
				},
			);
			const session: VoiceSession = {
				audioInput: {
					sampleRate: 24000,
					autoGainControl: false,
					gateWhilePlaying: false,
				},
				connect: vi.fn().mockResolvedValue(undefined),
				sendAudio: vi.fn(),
				sendText: vi.fn(),
				sendToolResponse: vi.fn(),
				disconnect: vi.fn(),
				isConnected: true,
				onAudio: null,
				onInputTranscript: null,
				onOutputTranscript: null,
				onToolCall: null,
				onTurnEnd: null,
				onInterrupted: null,
				onError: null,
				onDisconnect: null,
			};
			const createSession = vi
				.spyOn(voiceSessionApi, "createVoiceSession")
				.mockReturnValue(session);
			render(<ChatArea />);
			fireEvent.click(
				document.querySelector(".chat-voice-btn") as HTMLButtonElement,
			);
			await waitFor(() => expect(session.connect).toHaveBeenCalledTimes(1));

			act(() => session.onOutputTranscript?.("Live answer ["));
			expect(
				useChatStore
					.getState()
					.messages.find((message) => message.role === "assistant")?.content,
			).toBe("Live answer");
			act(() => session[terminalEvent]?.());

			expect(
				useChatStore
					.getState()
					.messages.find((message) => message.role === "assistant")?.content,
			).toBe("Live answer [");
			expect(createSession).toHaveBeenCalledTimes(1);
			vi.stubGlobal("AudioContext", originalAudioContext);
			localStorage.removeItem("naia-config");
		},
	);

	it("refreshes live gesture actions at the next voice turn boundary", async () => {
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
				provider: "nextain",
				model: "test-omni",
				naiaKey: "test-key",
			}),
		);
		const originalAudioContext = globalThis.AudioContext;
		vi.stubGlobal(
			"AudioContext",
			class {
				sampleRate = 24000;
				state = "running";
				currentTime = 0;
				destination = {};
				close = vi.fn().mockResolvedValue(undefined);
			},
		);
		const session: VoiceSession = {
			audioInput: {
				sampleRate: 24000,
				autoGainControl: false,
				gateWhilePlaying: false,
			},
			connect: vi.fn().mockResolvedValue(undefined),
			sendAudio: vi.fn(),
			sendText: vi.fn(),
			sendToolResponse: vi.fn(),
			disconnect: vi.fn(),
			isConnected: true,
			onAudio: null,
			onInputTranscript: null,
			onOutputTranscript: null,
			onToolCall: null,
			onTurnEnd: null,
			onInterrupted: null,
			onError: null,
			onDisconnect: null,
		};
		vi.spyOn(voiceSessionApi, "createVoiceSession").mockReturnValue(session);
		render(<ChatArea />);
		fireEvent.click(
			document.querySelector(".chat-voice-btn") as HTMLButtonElement,
		);
		await waitFor(() => expect(session.connect).toHaveBeenCalledTimes(1));

		registerCameraActions({
			getGestureActions: () => [{ key: "cheer", label: "Cheer" }],
		});
		act(() => session.onTurnEnd?.());
		act(() => session.onOutputTranscript?.("Hello [[gesture:cheer]]"));
		act(() => session.onTurnEnd?.());

		await waitFor(() => expect(playAction).toHaveBeenCalledWith("cheer"));
		expect(
			useChatStore
				.getState()
				.messages.find((message) => message.role === "assistant")?.content,
		).not.toContain("[[gesture:cheer]]");
		vi.stubGlobal("AudioContext", originalAudioContext);
		localStorage.removeItem("naia-config");
	});

	it("never sends textual reasoning to sentence TTS", async () => {
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
		fireEvent.change(input, { target: { value: "speak final only" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		for (const text of [
			"<think>Secret sentence.",
			" Still secret.</think>",
			"Public sentence.",
		]) {
			request.onChunk({ type: "text", requestId: request.requestId, text });
		}
		request.onChunk({ type: "finish", requestId: request.requestId });

		await waitFor(() => expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalled());
		expect(
			ttsSyncMocks.synthesizeTts.mock.calls.map(([input]) => input.text),
		).toEqual(["Public sentence."]);
		localStorage.removeItem("naia-config");
	});

	it("renders ToolActivity for tool_use chunk during streaming", async () => {
		// Set up API key so sendChatMessage is actually called
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "파일 읽어줘" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await new Promise((r) => setTimeout(r, 50));

		expect(capturedOnChunk).not.toBeNull();
		const requestId = capturedRequests[0].requestId;
		capturedOnChunk?.({
			type: "tool_use",
			requestId,
			toolCallId: "tc-1",
			toolName: "read_file",
			args: { path: "/test.txt" },
		});

		// Store should have the tool call
		const { streamingToolCalls } = useChatStore.getState();
		expect(streamingToolCalls).toHaveLength(1);
		expect(streamingToolCalls[0].toolName).toBe("read_file");
		expect(streamingToolCalls[0].status).toBe("running");

		localStorage.removeItem("naia-config");
	});

}
