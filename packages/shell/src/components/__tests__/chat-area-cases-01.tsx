import { ttsSyncMocks, capturedRequests, mockInvoke, FakeSpeechRecognition } from "./chat-area-fixture";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { appRegistry } from "../../lib/app-registry";
import { registerCameraActions } from "../../lib/avatar/camera-actions";
import { isNewCore } from "../../lib/chat-service";
import { SLIDE_PRESENTER_SPEAK_EVENT } from "../../lib/slide-presenter-events";
import { useAvatarStore } from "../../stores/avatar";
import { useCascadeAvatarStore } from "../../stores/cascade-avatar";
import { useChatStore } from "../../stores/chat";
import { ChatArea } from "../ChatArea";

export function registerChatAreaCases01() {
	it("renders input field and buttons", () => {
		render(<ChatArea />);
		expect(screen.getByPlaceholderText(/메시지|message/i)).toBeDefined();
		const buttons = screen.getAllByRole("button");
		expect(buttons.length).toBeGreaterThanOrEqual(2);
	});

	it("blocks local Ollama chat when its fresh runtime status is unreserved", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "ollama",
				model: "qwen3:8b",
				ollamaHost: "http://localhost:11434",
			}),
		);
		mockInvoke.mockImplementation((command: string) =>
			command === "ollama_runtime_status"
				? Promise.resolve({
						serverState: "connected_unreserved",
						reservation: {
							kind: "local_llm",
							status: "denied",
							bytes: null,
							reasonCode: "same_device_conflict",
						},
						error: {
							code: "reservation_denied",
							reasonCode: "same_device_conflict",
						},
					})
				: Promise.resolve(undefined),
		);
		const { sendChatMessage } = await import("../../lib/chat-service");
		vi.mocked(sendChatMessage).mockClear();
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "hello local model" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith(
				"ollama_runtime_status",
				expect.objectContaining({ host: "http://localhost:11434" }),
			);
		});
		expect(sendChatMessage).not.toHaveBeenCalled();
		expect(capturedRequests).toHaveLength(0);
	});

	it("admits local Ollama chat only with a running LocalLlm lease", async () => {
		const confirmedTag = "huihui_ai/qwen3.5-abliterated:2B";
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "ollama",
				model: confirmedTag,
				ollamaHost: "http://localhost:11434",
			}),
		);
		mockInvoke.mockImplementation((command: string) => {
			if (command === "ollama_runtime_status") {
				return Promise.resolve({
					serverState: "ready_managed",
					reservation: {
						kind: "local_llm",
						status: "running",
						bytes: null,
					},
				});
			}
			if (command === "ollama_model_catalog_list") {
				return Promise.resolve({
					candidates: [{ tag: confirmedTag }],
					contextDefaultTokens: 8192,
				});
			}
			return Promise.resolve(undefined);
		});
		const { sendChatMessage } = await import("../../lib/chat-service");
		vi.mocked(sendChatMessage).mockClear();
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "hello local model" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(sendChatMessage).toHaveBeenCalledTimes(1));
		expect(capturedRequests[0]?.provider).toMatchObject({
			provider: "ollama",
			model: confirmedTag,
			ollamaHost: "http://localhost:11434",
			ollamaNumCtx: 8192,
		});
	});

	it("preserves context settings for a managed noncatalog Ollama model", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "ollama",
				model: "qwen3:8b",
				ollamaHost: "http://localhost:11434",
			}),
		);
		mockInvoke.mockImplementation((command: string) => {
			if (command === "ollama_runtime_status") {
				return Promise.resolve({
					serverState: "ready_managed",
					reservation: { kind: "local_llm", status: "running", bytes: null },
				});
			}
			if (command === "ollama_model_catalog_list") {
				return Promise.resolve({
					candidates: [{ tag: "huihui_ai/qwen3.5-abliterated:4B" }],
					contextDefaultTokens: 8192,
				});
			}
			return Promise.resolve(undefined);
		});
		const { sendChatMessage } = await import("../../lib/chat-service");
		vi.mocked(sendChatMessage).mockClear();
		render(<ChatArea />);
		fireEvent.change(screen.getByPlaceholderText(/메시지|message/i), {
			target: { value: "hello other local model" },
		});
		fireEvent.keyDown(screen.getByPlaceholderText(/메시지|message/i), {
			key: "Enter",
		});

		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		expect(capturedRequests[0]?.provider).toMatchObject({
			provider: "ollama",
			model: "qwen3:8b",
		});
		expect(capturedRequests[0]?.provider?.ollamaNumCtx).toBeUndefined();
	});

	it("cleans up the pipeline when Web Speech reports a permission error", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "ollama",
				model: "qwen3:8b",
				sttProvider: "web-speech",
				sttModel: "",
				ttsEnabled: true,
			}),
		);
		Object.defineProperty(window, "SpeechRecognition", {
			configurable: true,
			value: FakeSpeechRecognition,
		});

		render(<ChatArea />);
		fireEvent.click(
			document.querySelector(".chat-voice-btn") as HTMLButtonElement,
		);

		await waitFor(() =>
			expect(FakeSpeechRecognition.latest?.start).toHaveBeenCalledTimes(1),
		);
		FakeSpeechRecognition.latest?.onerror?.({
			error: "not-allowed",
			message: "Permission denied",
		});

		await waitFor(() => {
			expect(useChatStore.getState().messages.at(-1)?.content).toContain(
				"Voice connection failed: not-allowed: Permission denied",
			);
		});
		expect(FakeSpeechRecognition.latest?.abort).toHaveBeenCalledTimes(1);
		expect(FakeSpeechRecognition.latest?.onerror).toBeNull();
		expect(document.querySelector(".chat-voice-btn")?.className).not.toContain(
			"active",
		);
	});

	it("does not send while the lazy at-mention picker is opening", () => {
		vi.spyOn(appRegistry, "get").mockReturnValueOnce({} as never);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);

		fireEvent.change(input, {
			target: { value: "@", selectionStart: 1 },
		});
		fireEvent.keyDown(input, { key: "Enter" });

		expect(capturedRequests).toHaveLength(0);
	});

	it("interrupts the active speech pipeline when the global TTS toggle turns off", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({ ttsEnabled: true, ttsProvider: "edge" }),
		);
		useAvatarStore.getState().setSpeaking(true);
		render(<ChatArea />);

		window.dispatchEvent(
			new CustomEvent("naia:tts-enabled-change", {
				detail: { enabled: false },
			}),
		);

		await waitFor(() =>
			expect(useAvatarStore.getState().isSpeaking).toBe(false),
		);
		localStorage.removeItem("naia-config");
	});

	it("drops a deferred AI gesture when the global TTS toggle turns off", async () => {
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
		request.onChunk({ type: "finish", requestId: request.requestId });
		await waitFor(() => expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalled());
		window.dispatchEvent(
			new CustomEvent("naia:tts-enabled-change", {
				detail: { enabled: false },
			}),
		);
		act(() => {
			ttsSyncMocks.audioQueueActive = false;
			ttsSyncMocks.audioQueueCallbacks?.onPlaybackEnd?.();
		});
		expect(playAction).not.toHaveBeenCalled();
		localStorage.removeItem("naia-config");
	});

	it("drops a deferred AI gesture when slide narration interrupts TTS", async () => {
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
		request.onChunk({ type: "finish", requestId: request.requestId });
		await waitFor(() => expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalled());
		window.dispatchEvent(
			new CustomEvent(SLIDE_PRESENTER_SPEAK_EVENT, {
				detail: {
					requestId: "slide-speak-gesture",
					generation: 1,
					page: 1,
					text: "Slide narration",
				},
			}),
		);
		act(() => {
			ttsSyncMocks.audioQueueActive = false;
			ttsSyncMocks.audioQueueCallbacks?.onPlaybackEnd?.();
		});
		expect(playAction).not.toHaveBeenCalled();
		localStorage.removeItem("naia-config");
	});

	it("shows think while waiting and returns to neutral when a silent turn finishes", async () => {
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
		fireEvent.change(input, { target: { value: "complex question" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		expect(useAvatarStore.getState().currentEmotion).toBe("think");
		const request = capturedRequests[0];
		request.onChunk({ type: "finish", requestId: request.requestId });
		expect(useAvatarStore.getState().currentEmotion).toBe("neutral");
		localStorage.removeItem("naia-config");
	});

	it("routes the structured main role when the flat provider mirror is stale", async () => {
		vi.mocked(isNewCore).mockReturnValue(true);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "gemini",
				model: "gemini-2.5-flash",
				llmRoles: {
					main: { provider: "nextain", model: "deepseek-v4-flash" },
				},
				enableTools: false,
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "structured role route" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		expect(capturedRequests[0].provider).toMatchObject({
			provider: "nextain",
			model: "deepseek-v4-flash",
		});
		localStorage.removeItem("naia-config");
	});

	it("does not send and shows the three-way guide when no LLM is configured (FR-LLM-LOGOUT.2)", async () => {
		vi.mocked(isNewCore).mockReturnValue(true);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({ provider: "", model: "", enableTools: false }),
		);
		const before = capturedRequests.length;

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "hello without llm" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => {
			const last = useChatStore.getState().messages.at(-1);
			expect(last?.role).toBe("assistant");
		});
		const guide = useChatStore.getState().messages.at(-1)?.content ?? "";
		expect(guide).toMatch(/Naia/);
		expect(guide).toMatch(/Ollama/);
		expect(guide).toMatch(/CLI/);
		expect(capturedRequests.length).toBe(before);
		localStorage.removeItem("naia-config");
	});

	it("preserves a dynamically catalogued structured main model", async () => {
		vi.mocked(isNewCore).mockReturnValue(true);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "gemini",
				model: "gemini-2.5-flash",
				llmRoles: {
					main: { provider: "nextain", model: "gemini-3.7-flash" },
				},
				enableTools: false,
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "dynamic gateway model" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		expect(capturedRequests[0].provider).toMatchObject({
			provider: "nextain",
			model: "gemini-3.7-flash",
		});
		localStorage.removeItem("naia-config");
	});

}
