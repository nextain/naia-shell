import { ttsSyncMocks, capturedOnChunk, capturedRequests } from "./chat-area-fixture";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useAvatarStore } from "../../stores/avatar";
import { useCascadeAvatarStore } from "../../stores/cascade-avatar";
import { useChatStore } from "../../stores/chat";
import { ChatArea } from "../ChatArea";

export function registerChatAreaCases04() {
	it("updates tool call on tool_result chunk", async () => {
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

		const requestId = capturedRequests[0].requestId;
		capturedOnChunk?.({
			type: "tool_use",
			requestId,
			toolCallId: "tc-1",
			toolName: "read_file",
			args: { path: "/test.txt" },
		});

		capturedOnChunk?.({
			type: "tool_result",
			requestId,
			toolCallId: "tc-1",
			toolName: "read_file",
			output: "file contents",
			success: true,
		});

		const { streamingToolCalls } = useChatStore.getState();
		expect(streamingToolCalls[0].status).toBe("success");
		expect(streamingToolCalls[0].output).toBe("file contents");

		localStorage.removeItem("naia-config");
	});

	it("keeps UC-WIRE-V1 structured chunks visible in the chat stream", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/硫붿떆吏|message/i);
		fireEvent.change(input, { target: { value: "wire check" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests.length).toBe(1));
		const requestId = capturedRequests[0].requestId;
		capturedOnChunk?.({
			type: "grounding",
			requestId,
			status: "grounded",
			sources: [{ title: "KB", sourceUris: ["kb://workshop"] }],
		});
		capturedOnChunk?.({
			type: "artifact",
			requestId,
			artifact: {
				id: "artifact-1",
				kind: "image",
				mimeType: "image/png",
				sizeBytes: 2048,
				localRef: "img_1",
				name: "preview.png",
			},
		});
		capturedOnChunk?.({
			type: "provider_session",
			requestId,
			sessionId: "session-1",
			providerSessionRef: "opaque-provider-ref",
			state: "started",
		});
		capturedOnChunk?.({
			type: "processing_disclosure",
			requestId,
			workload: "embedding",
			destination: "external_cloud",
			decision: "allowed",
			processingProfileRef: "profile-local-cloud-001",
			provider: "openai",
			model: "gpt-4.1",
		});
		capturedOnChunk?.({ type: "finish", requestId });

		await waitFor(() => {
			const assistant = useChatStore
				.getState()
				.messages.find((msg) => msg.role === "assistant");
			expect(assistant?.content).toContain("[Grounding: grounded] KB");
			expect(assistant?.content).toContain("[Artifact: image preview.png]");
			expect(assistant?.content).toContain("id=artifact-1");
			expect(assistant?.content).toContain("localRef=img_1");
			expect(assistant?.content).toContain(
				"[Provider session: started] sessionId=session-1 providerSessionRef=opaque-provider-ref",
			);
			expect(assistant?.content).toContain(
				"[Processing: embedding -> external_cloud, allowed] processingProfileRef=profile-local-cloud-001 openai/gpt-4.1",
			);
		});

		localStorage.removeItem("naia-config");
	});

	it("renders ToolActivity for completed messages with toolCalls", async () => {
		useChatStore.setState({
			messages: [
				{
					id: "msg-1",
					role: "assistant",
					content: "파일을 읽었습니다.",
					timestamp: Date.now(),
					toolCalls: [
						{
							toolCallId: "tc-1",
							toolName: "read_file",
							args: { path: "/test.txt" },
							status: "success",
							output: "contents",
						},
					],
				},
			],
		});

		render(<ChatArea />);
		// Should render the tool activity label
		expect(
			await screen.findByText(/파일 읽기|Read File/, {}, { timeout: 5_000 }),
		).toBeDefined();
	});

	it("sets pendingApproval on approval_request chunk", async () => {
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
		fireEvent.change(input, { target: { value: "npm test 실행해" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await new Promise((r) => setTimeout(r, 50));

		expect(capturedOnChunk).not.toBeNull();
		const requestId = capturedRequests[0].requestId;
		capturedOnChunk?.({
			type: "approval_request",
			requestId,
			toolCallId: "tc-1",
			toolName: "execute_command",
			args: { command: "npm test" },
			tier: 2,
			description: "명령 실행: npm test",
		});

		const { pendingApproval } = useChatStore.getState();
		expect(pendingApproval).not.toBeNull();
		expect(pendingApproval?.toolName).toBe("execute_command");

		localStorage.removeItem("naia-config");
	});

	it("queues rapid sends until the active stream finishes", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		const { sendChatMessage } = await import("../../lib/chat-service");
		vi.mocked(sendChatMessage).mockClear();

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);

		fireEvent.change(input, { target: { value: "첫번째" } });
		fireEvent.keyDown(input, { key: "Enter" });
		fireEvent.change(input, { target: { value: "두번째" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(sendChatMessage).toHaveBeenCalledTimes(1));
		expect(useChatStore.getState().messageQueue).toEqual(["두번째"]);

		const first = capturedRequests[0];
		first.onChunk({
			type: "text",
			requestId: first.requestId,
			text: "첫 응답",
		});
		first.onChunk({ type: "finish", requestId: first.requestId });

		await waitFor(() => expect(sendChatMessage).toHaveBeenCalledTimes(2));
		expect(capturedRequests[1].message).toBe("두번째");
		expect(capturedRequests[1].history).toEqual([
			{ role: "user", content: "첫번째" },
			{ role: "assistant", content: "첫 응답" },
		]);

		localStorage.removeItem("naia-config");
	});

	it("auto-approves when tool is in allowedTools", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				allowedTools: ["execute_command"],
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "npm test 실행해" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await new Promise((r) => setTimeout(r, 50));

		expect(capturedOnChunk).not.toBeNull();
		const requestId = capturedRequests[0].requestId;
		capturedOnChunk?.({
			type: "approval_request",
			requestId,
			toolCallId: "tc-1",
			toolName: "execute_command",
			args: { command: "npm test" },
			tier: 2,
			description: "명령 실행: npm test",
		});

		// Should NOT set pendingApproval (auto-approved)
		const { pendingApproval } = useChatStore.getState();
		expect(pendingApproval).toBeNull();

		localStorage.removeItem("naia-config");
	});

	it("renders PermissionModal when pendingApproval is set", async () => {
		useChatStore.setState({
			isStreaming: true,
			streamingContent: "",
			pendingApproval: {
				requestId: "req-1",
				toolCallId: "tc-1",
				toolName: "execute_command",
				args: { command: "npm test" },
				tier: 2,
				description: "명령 실행: npm test",
			},
		});

		render(<ChatArea />);
		expect(
			await screen.findByText(/도구 실행 승인|Tool Execution Approval/),
		).toBeDefined();
	});

	it("sets isSpeaking and pendingAudio on audio chunk", async () => {
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
		fireEvent.change(input, { target: { value: "안녕" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await new Promise((r) => setTimeout(r, 50));

		// Simulate audio chunk via captured callback
		expect(capturedOnChunk).not.toBeNull();
		const requestId = capturedRequests[0].requestId;
		capturedOnChunk?.({
			type: "audio",
			requestId,
			data: "base64audio==",
		});

		// isSpeaking should be set (Audio element playback triggers this)
		expect(useAvatarStore.getState().isSpeaking).toBe(true);
		expect(useAvatarStore.getState().pendingAudio).toBe("base64audio==");

		localStorage.removeItem("naia-config");
	});

	// === Local conversation ownership ===

	it("plays authored NVA clips in order without Shell synthesis", async () => {
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
				avatarProvider: "naia-video-avatar",
				nvaModel: "naia",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "ordering test" } });
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
		await waitFor(() => expect(playAuthoredClip).toHaveBeenCalledTimes(2));
		expect(playAuthoredClip.mock.calls[0][0]).toBe("First sentence.");
		expect(playAuthoredClip.mock.calls[0][1]).toEqual(
			expect.objectContaining({
				onPlaybackReady: expect.any(Function),
				onPlaybackFailure: expect.any(Function),
			}),
		);
		expect(playAuthoredClip.mock.calls[1][0]).toBe("Second sentence.");
		expect(ttsSyncMocks.synthesizeTts).not.toHaveBeenCalled();
		expect(ttsSyncMocks.enqueueOrdered).not.toHaveBeenCalled();
		localStorage.removeItem("naia-config");
	});

	it("routes dynamic NVA speech through Shell TTS instead of the renderer", async () => {
		const playAuthoredClip = vi.fn();
		const setSpeakingVisual = vi.fn();
		useCascadeAvatarStore.setState({
			renderer: {
				hasAuthoredClip: () => false,
				playAuthoredClip,
				setSpeakingVisual,
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
				avatarProvider: "naia-video-avatar",
				nvaModel: "naia",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "dynamic speech test" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "No authored clip matches this sentence.",
		});

		await waitFor(() => expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalled());
		expect(playAuthoredClip).not.toHaveBeenCalled();
		localStorage.removeItem("naia-config");
	});

}
