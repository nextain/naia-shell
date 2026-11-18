import {
	capturedRequests,
	FakeSpeechRecognition,
	mockInvoke,
	mockResetKioskMemory,
	mockSendAppSkills,
	ttsSyncMocks,
} from "./chat-area-fixture";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ensureBgmSidecar } from "../../lib/bgm-sidecar-url";
import { BGM_APP_ID, SKILL_YOUTUBE_BGM } from "../../lib/bgm-skill";
import { sendChatMessage } from "../../lib/chat-service";
import { getLocale, setLocale } from "../../lib/i18n";
import { requestKioskGreeting } from "../../lib/kiosk-demo/entry";
import {
	getKioskIrSlide,
	registerKioskSlidesController,
} from "../../lib/kiosk-demo/slides";
import type { EnvironmentSegment } from "../../lib/types";
import { setWebAdkStatus } from "../../lib/web-runtime/web-adk-status";
import { setWebAssetsModeForTests } from "../../lib/web-runtime/web-assets";
import { setWebModelStatus } from "../../lib/web-runtime/web-model-status";
import { useAppStore } from "../../stores/app";
import { useChatStore } from "../../stores/chat";
import { ChatArea } from "../ChatArea";

export function registerChatAreaCases08() {
	it("kiosk reset blocks duplicates and offers retry after safe storage failure", async () => {
		const previousLocale = getLocale();
		await setLocale("ko");
		try {
			vi.stubEnv("MODE", "web");
			vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
			let rejectReset!: (error: Error) => void;
			mockResetKioskMemory.mockImplementationOnce(
				() =>
					new Promise<void>((_, reject) => {
						rejectReset = reject;
					}),
			);
			render(<ChatArea />);
			const reset = screen.getByRole("button", { name: "처음으로" });
			fireEvent.click(reset);
			await waitFor(() => expect(mockResetKioskMemory).toHaveBeenCalledOnce());
			expect((reset as HTMLButtonElement).disabled).toBe(true);
			fireEvent.click(reset);
			expect(mockResetKioskMemory).toHaveBeenCalledOnce();
			await act(async () => rejectReset(new Error("private storage detail")));
			expect(
				(await screen.findByText(/기억을 초기화하지 못했어요/)).getAttribute(
					"role",
				),
			).toBe("alert");
			expect(screen.queryByText(/private storage detail/)).toBeNull();
			expect((reset as HTMLButtonElement).disabled).toBe(false);
			mockResetKioskMemory.mockRejectedValueOnce(new Error("still unavailable"));
			fireEvent.click(reset);
			await waitFor(() => expect(mockResetKioskMemory).toHaveBeenCalledTimes(2));
		} finally {
			await setLocale(previousLocale);
		}
	});

	it("S5: kiosk demo greeting respects config ttsProvider (nextain gateway) in web mode", async () => {
		setWebAssetsModeForTests(true);
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				agentName: "지나",
				ttsEnabled: true,
				ttsProvider: "nextain",
				ttsVoice: "ko-KR-Neural2-A",
			}),
		);
		requestKioskGreeting();
		render(<ChatArea />);
		await waitFor(() => expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalled());
		expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "nextain",
				voice: "ko-KR-Neural2-A",
			}),
		);
	});

	it("hides message cost-badge in kiosk mode and shows it in normal web mode", () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gpt-6.1-terra",
			}),
		);
		useChatStore.getState().setMessages([
			{
				id: "m-cost-1",
				role: "assistant",
				content: "답변입니다.",
				timestamp: 1000,
				cost: {
					provider: "nextain",
					model: "gpt-6.1-terra",
					inputTokens: 0,
					outputTokens: 0,
					cost: 0,
				},
			},
		]);

		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		const { container: kioskContainer, unmount } = render(<ChatArea />);
		expect(kioskContainer.querySelector(".cost-badge")).toBeNull();
		unmount();

		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "0");
		const { container: normalContainer } = render(<ChatArea />);
		expect(normalContainer.querySelector(".cost-badge")).not.toBeNull();
		expect(normalContainer.querySelector(".cost-badge")?.textContent).toContain(
			"0",
		);
	});

	it("sends request when pre-ready event subscription callback is invoked after ready in web mode", async () => {
		vi.stubEnv("MODE", "web");
		setWebModelStatus({ phase: "checking" });

		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "openai",
				model: "gpt-4o",
				apiKey: "test-key",
			}),
		);

		render(<ChatArea />);

		// Model and workspace transition to ready after mount
		setWebModelStatus({ phase: "ready" });
		setWebAdkStatus({ phase: "ready" });

		// Trigger event subscription callback registered before ready
		window.dispatchEvent(
			new CustomEvent("naia:interference-event", {
				detail: {
					source: "browser",
					action: "opened",
					url: "https://example.com",
				},
			}),
		);

		await waitFor(
			() => {
				expect(capturedRequests.length).toBeGreaterThan(0);
			},
			{ timeout: 1000 },
		);
		const req = capturedRequests[capturedRequests.length - 1];
		expect(req.message).toContain("https://example.com");
	});

	it("preserves pre-ready STT final result in input and prevents transmission after debounce in web mode", async () => {
		vi.stubEnv("MODE", "web");
		setWebModelStatus({ phase: "checking" });

		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "openai",
				model: "gpt-4o",
				sttProvider: "web-speech",
			}),
		);
		Object.defineProperty(window, "SpeechRecognition", {
			configurable: true,
			value: FakeSpeechRecognition,
		});

		render(<ChatArea />);

		const voiceBtn = document.querySelector(
			".chat-voice-btn",
		) as HTMLButtonElement;
		fireEvent.click(voiceBtn);

		await waitFor(() => {
			expect(FakeSpeechRecognition.latest?.start).toHaveBeenCalledTimes(1);
		});

		act(() => {
			FakeSpeechRecognition.latest?.emitResult([
				{ transcript: "준비 전 STT 텍스트", isFinal: true },
			]);
		});

		const input = document.querySelector(".chat-input") as HTMLTextAreaElement;
		await waitFor(() => expect(input.value).toBe("준비 전 STT 텍스트"));
		expect(capturedRequests).toHaveLength(0);
	});

	it("skips ensureBgmSidecar and does not render bgm-sidecar-error in web mode", async () => {
		vi.mocked(ensureBgmSidecar)
			.mockReset()
			.mockResolvedValue("http://localhost:18791");
		vi.stubEnv("MODE", "web");
		vi.mocked(ensureBgmSidecar).mockRejectedValueOnce(
			new Error("desktop_only:ensure_bgm_server"),
		);
		try {
			render(<ChatArea />);
			await screen.findByPlaceholderText(/메시지|message/i);
			expect(ensureBgmSidecar).toHaveBeenCalledTimes(0);
			expect(screen.queryByTestId("bgm-sidecar-error")).toBeNull();
		} finally {
			vi.unstubAllEnvs();
			vi.mocked(ensureBgmSidecar)
				.mockReset()
				.mockResolvedValue("http://localhost:18791");
		}
	});

	it("renders bgm-sidecar-error notification when ensureBgmSidecar fails in desktop mode", async () => {
		vi.mocked(ensureBgmSidecar)
			.mockReset()
			.mockResolvedValue("http://localhost:18791");
		vi.mocked(ensureBgmSidecar).mockRejectedValueOnce(
			new Error("desktop_only:ensure_bgm_server"),
		);
		try {
			render(<ChatArea />);
			const alert = await screen.findByTestId("bgm-sidecar-error");
			expect(alert).toBeDefined();
			expect(alert.textContent).toContain(
				"BGM 서버를 시작하지 못했습니다. 음악 검색이 동작하지 않습니다.",
			);
			expect(ensureBgmSidecar).toHaveBeenCalledTimes(1);
		} finally {
			vi.mocked(ensureBgmSidecar)
				.mockReset()
				.mockResolvedValue("http://localhost:18791");
		}
	});

	it("calls BGM sendAppSkills on send in web mode", async () => {
		vi.stubEnv("MODE", "web");
		setWebModelStatus({ phase: "ready" });
		setWebAdkStatus({ phase: "ready" });
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		mockSendAppSkills.mockClear();
		try {
			render(<ChatArea />);
			const input = await screen.findByPlaceholderText(/메시지|message/i);
			fireEvent.change(input, { target: { value: "hello web" } });
			fireEvent.keyDown(input, { key: "Enter" });
			await waitFor(() => expect(capturedRequests).toHaveLength(1));
			expect(mockSendAppSkills).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllEnvs();
			localStorage.removeItem("naia-config");
		}
	});

	it("calls BGM sendAppSkills once per turn in desktop mode", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		mockSendAppSkills.mockClear();
		try {
			render(<ChatArea />);
			const input = await screen.findByPlaceholderText(/메시지|message/i);
			fireEvent.change(input, { target: { value: "hello desktop" } });
			fireEvent.keyDown(input, { key: "Enter" });
			await waitFor(() => expect(capturedRequests).toHaveLength(1));
			expect(mockSendAppSkills).toHaveBeenCalledTimes(1);
			expect(mockSendAppSkills).toHaveBeenCalledWith(BGM_APP_ID, [
				SKILL_YOUTUBE_BGM,
			]);
		} finally {
			localStorage.removeItem("naia-config");
		}
	});

	it("FR-WEB-KIOSK-FIX.10 forces nextain + gpt-5.6-luna on send in kiosk mode even when saved config has gpt-6.1-terra or another provider, and transitions to unavailable screen on credit exhaustion without retry bubble", async () => {
		const { KIOSK_DEMO_UNAVAILABLE_EVENT } = await import(
			"../../lib/kiosk-demo/entry"
		);
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		setWebModelStatus({ phase: "ready" });
		setWebAdkStatus({ phase: "ready" });
		localStorage.setItem("naia-remote-key", "test-kiosk-fixture-only");
		const previousLocale = getLocale();
		await setLocale("ko");

		try {
			// 1. Saved gpt-6.1-terra + polluted thinkingLevel xhigh + enableTools false -> sent request uses nextain + gpt-5.6-luna + thinking low + enableTools true
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					provider: "nextain",
					model: "gpt-6.1-terra",
					apiKey: "",
					enableTools: false,
					thinkingLevel: "xhigh",
					enableThinking: false,
					environmentAwareness: "always",
					environmentTerminalInput: true,
					llmRoles: {
						main: {
							provider: "nextain",
							model: "gpt-6.1-terra",
							thinkingLevel: "xhigh",
						},
					},
					mainModelThinkingLevels: {
						"nextain:gpt-6.1-terra": "xhigh",
						"nextain:gpt-5.6-luna": "xhigh",
					},
				}),
			);
			const { unmount } = render(<ChatArea />);
			const input = await screen.findByPlaceholderText(/메시지|message/i);
			fireEvent.change(input, { target: { value: "terra test" } });
			fireEvent.keyDown(input, { key: "Enter" });
			await waitFor(() => expect(capturedRequests).toHaveLength(1));
			expect(capturedRequests[0]?.provider?.provider).toBe("nextain");
			expect(capturedRequests[0]?.provider?.model).toBe("gpt-5.6-luna");
			expect(capturedRequests[0]?.thinking).toEqual({ level: "low" });
			expect(capturedRequests[0]?.enableThinking).toBe(true);
			expect(capturedRequests[0]?.enableTools).toBe(true);
			unmount();

			// 2. Saved other provider (codex) + polluted xhigh + enableTools false -> sent request uses nextain + gpt-5.6-luna + thinking low + enableTools true
			capturedRequests.length = 0;
			useChatStore.getState().newConversation();
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					provider: "codex",
					model: "gpt-5.6-sol",
					apiKey: "",
					enableTools: false,
					thinkingLevel: "xhigh",
					enableThinking: false,
					environmentAwareness: "always",
					environmentTerminalInput: true,
					llmRoles: {
						main: {
							provider: "codex",
							model: "gpt-5.6-sol",
							thinkingLevel: "xhigh",
						},
					},
				}),
			);
			const unavailableEvents: Event[] = [];
			const onUnavailable = (e: Event) => unavailableEvents.push(e);
			window.addEventListener(KIOSK_DEMO_UNAVAILABLE_EVENT, onUnavailable);
			try {
				render(<ChatArea />);
				const input2 = await screen.findByPlaceholderText(/메시지|message/i);
				fireEvent.change(input2, { target: { value: "codex test" } });
				fireEvent.keyDown(input2, { key: "Enter" });
				await waitFor(() => expect(capturedRequests).toHaveLength(1));
				expect(capturedRequests[0]?.provider?.provider).toBe("nextain");
				expect(capturedRequests[0]?.provider?.model).toBe("gpt-5.6-luna");
				expect(capturedRequests[0]?.thinking).toEqual({ level: "low" });
				expect(capturedRequests[0]?.enableThinking).toBe(true);
				expect(capturedRequests[0]?.enableTools).toBe(true);

				// 3. Non-exhaustion or 402 error when balance > 0 -> retries once and shows polite message without triggering unavailable screen
				let balanceCredits = 67;
				mockInvoke.mockImplementation((command: string) => {
					if (command === "fetch_naia_balance") {
						return Promise.resolve({ credits: balanceCredits });
					}
					return Promise.resolve(undefined);
				});
				vi.stubGlobal(
					"fetch",
					vi.fn(async () =>
						new Response(JSON.stringify({ credits: balanceCredits }), {
							status: 200,
						}),
					),
				);

				await act(async () => {
					capturedRequests[0].onChunk({
						type: "error",
						requestId: capturedRequests[0].requestId,
						message:
							"OpenAI-compat https://gateway.nextain.io/v1 failed: 402 Payment Required: insufficient_quota",
					});
				});
				// Should NOT trigger unavailable when balance > 0; instead retries once
				await waitFor(() => expect(capturedRequests).toHaveLength(2));
				expect(unavailableEvents).toHaveLength(0);

				// Second failure after 1x auto-retry -> shows polite chat message "잠시 문제가 있어요, 다시 말해 주세요."
				await act(async () => {
					capturedRequests[1].onChunk({
						type: "error",
						requestId: capturedRequests[1].requestId,
						message: "upstream timeout",
					});
				});
				await waitFor(() =>
					expect(
						useChatStore
							.getState()
							.messages.some((m) =>
								m.content.includes("잠시 문제가 있어요, 다시 말해 주세요."),
							),
					).toBe(true),
				);
				expect(unavailableEvents).toHaveLength(0);
				expect(
					useChatStore
						.getState()
						.messages.some((m) => Boolean(m.failure)),
				).toBe(false);

				// 4. Error when balance lookup confirms credits <= 0 -> triggers unavailable screen
				balanceCredits = 0;
				fireEvent.change(input2, { target: { value: "zero credit test" } });
				fireEvent.keyDown(input2, { key: "Enter" });
				await waitFor(() => expect(capturedRequests).toHaveLength(3));
				await act(async () => {
					capturedRequests[2].onChunk({
						type: "error",
						requestId: capturedRequests[2].requestId,
						message: "402 Payment Required",
					});
				});
				await waitFor(() => expect(unavailableEvents).toHaveLength(1));
			} finally {
				vi.unstubAllGlobals();
				window.removeEventListener(
					KIOSK_DEMO_UNAVAILABLE_EVENT,
					onUnavailable,
				);
			}
		} finally {
			vi.unstubAllEnvs();
			localStorage.removeItem("naia-config");
			localStorage.removeItem("naia-remote-key");
			await setLocale(previousLocale);
		}
	});

	it("FR-WEB-KIOSK-ADK.3~4 renders evidence line below replies, opens clicked file in workspace, and defaults local answer toggle to OFF with 8GB notice", async () => {
		const previousLocale = getLocale();
		await setLocale("ko");
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		localStorage.removeItem("naia-kiosk-local-answer");
		try {
			useChatStore.setState({
				messages: [
					{
						id: "msg-kiosk-1",
						role: "assistant",
						content:
							"나이아는 비주얼 에이전트입니다.\n\n근거: naia.md (기준일 2026-10-31)",
						timestamp: Date.now(),
						toolCalls: [
							{
								toolCallId: "tc-kiosk-ev",
								toolName: "skill_knowledge_ask",
								args: { question: "나이아란?" },
								status: "success",
								output: JSON.stringify({
									abstained: false,
									sources: [
										{
											sourceUris: [
												"opfs://naia-adk/kiosk-demo/knowledge/naia.md",
											],
										},
									],
								}),
							},
						],
						localAnswer: true,
					},
				],
			});

			const openedPaths: string[] = [];
			const onOpenFile = (e: Event) => {
				const detail = (e as CustomEvent<{ path?: string }>).detail;
				if (detail?.path) openedPaths.push(detail.path);
			};
			window.addEventListener("naia-web-workspace-open-file", onOpenFile);

			try {
				render(<ChatArea />);

				const toggleBtn = screen.getByTestId("kiosk-local-answer-toggle");
				expect(toggleBtn).toHaveTextContent("내 PC 에서 대답하기");
				expect(toggleBtn).toHaveAttribute("aria-pressed", "false");
				expect(screen.getByTestId("kiosk-local-answer-hint")).toHaveTextContent(
					"그래픽 메모리 8GB 이상 기기에서만 됩니다",
				);

				expect(
					screen.getByTestId("kiosk-local-answer-badge"),
				).toHaveTextContent("내 PC 에서 나온 답");

				const evidence = screen.getByTestId("chat-kiosk-evidence");
				expect(evidence).toHaveTextContent("AGENTS.md");
				expect(evidence).toHaveTextContent("knowledge/naia.md");
				expect(evidence).toHaveTextContent("memory/guest-memory.md");

				const cardChip = screen.getByRole("button", {
					name: "knowledge/naia.md",
				});
				fireEvent.click(cardChip);
				expect(openedPaths).toContain("opfs://naia-adk/knowledge/naia.md");

				// Clicking local toggle without WebGPU shows notice and keeps toggle OFF
				fireEvent.click(toggleBtn);
				await waitFor(() =>
					expect(
						screen.getByTestId("kiosk-local-answer-notice"),
					).toHaveTextContent("그래픽 메모리 8GB 이상 기기에서만 됩니다"),
				);
				expect(toggleBtn).toHaveAttribute("aria-pressed", "false");

				// P2-3: With WebGPU available, clicking local toggle shows ~2.5GB + "처음 한 번 내려받아요" confirmation first; cancel does nothing, confirm enables local mode
				Object.defineProperty(navigator, "gpu", {
					value: {
						requestAdapter: async () => ({
							features: new Set(["shader-f16"]),
							limits: {
								maxBufferSize: 1024 * 1024 * 512,
								maxStorageBufferBindingSize: 1024 * 1024 * 256,
							},
						}),
					},
					configurable: true,
				});
				try {
					fireEvent.click(toggleBtn);
					const confirmBox = await screen.findByTestId(
						"kiosk-local-answer-confirm",
					);
					expect(confirmBox).toHaveTextContent("약 2.5GB");
					expect(confirmBox).toHaveTextContent("처음 한 번 내려받아요");
					expect(toggleBtn).toHaveAttribute("aria-pressed", "false");
					expect(localStorage.getItem("naia-kiosk-local-answer")).toBeNull();

					// Cancel -> does nothing
					fireEvent.click(
						screen.getByTestId("kiosk-local-answer-confirm-cancel"),
					);
					expect(
						screen.queryByTestId("kiosk-local-answer-confirm"),
					).toBeNull();
					expect(toggleBtn).toHaveAttribute("aria-pressed", "false");
					expect(localStorage.getItem("naia-kiosk-local-answer")).toBeNull();

					// Click again and confirm -> enables local answer mode
					fireEvent.click(toggleBtn);
					await screen.findByTestId("kiosk-local-answer-confirm");
					fireEvent.click(
						screen.getByTestId("kiosk-local-answer-confirm-accept"),
					);
					await waitFor(() =>
						expect(toggleBtn).toHaveAttribute("aria-pressed", "true"),
					);
					expect(localStorage.getItem("naia-kiosk-local-answer")).toBe("1");
				} finally {
					Reflect.deleteProperty(navigator, "gpu");
				}
			} finally {
				window.removeEventListener("naia-web-workspace-open-file", onOpenFile);
			}
		} finally {
			vi.unstubAllEnvs();
			localStorage.removeItem("naia-kiosk-local-answer");
			await setLocale(previousLocale);
		}
	});

	it("FR-WEB-KIOSK-S6 sends active slide body, speaker script, and rules in model input during slide questions and attaches only the active slide manuscript file as evidence", async () => {
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO_KEY", "naia_test_kiosk_fixture_123456");
		setWebModelStatus({ phase: "ready" });
		setWebAdkStatus({ phase: "ready" });
		localStorage.setItem("naia-remote-key", "naia_test_kiosk_fixture_123456");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gpt-5.6-luna",
				naiaKey: "naia_test_kiosk_fixture_123456",
				enableTools: true,
				enableThinking: true,
				thinkingLevel: "low",
				ttsEnabled: false,
			}),
		);

		const unregisterSlides = registerKioskSlidesController({
			performAction: vi.fn(),
			isPresenting: () => false,
			isAnsweringQuestion: () => true,
			getCurrentPage: () => 2,
			onTurnSettled: vi.fn(),
		});
		useAppStore.getState().setActiveApp("land.naia.slides");

		try {
			const capturedSlideRequests: any[] = [];
			vi.mocked(sendChatMessage).mockImplementation(async (opts: any) => {
				capturedSlideRequests.push(opts);
				return opts.requestId;
			});

			render(<ChatArea />);
			const input = await screen.findByPlaceholderText(/메시지|message/i);

			const slide2 = getKioskIrSlide(2)!;
			const testTurns = [
				{
					question: "방금 장에서 핵심 지표가 뭐예요?",
					reply:
						"게스트님, 이 장에는 핵심 지표가 없어요. 지금 보고 계신 2장 '브랜드 체계: 나이아와 별자리 모델 이름'에서는 물의 요정 나이아드에서 온 나이아(Naia)의 의미와 루나(달)·테라(지구)·솔(태양)·스텔라(별)·노바(신성) 별자리 모델 이름 체계를 안내하고 있어요. 이어 가기를 누르시면 발표를 계속 들으실 수 있어요.",
				},
				{
					question: "이 장에서 노바는 뭐예요?",
					reply:
						"이 장에서 노바(신성)는 루나(달)·테라(지구)·솔(태양)·스텔라(별)·노바(신성)으로 이어지는 나이아 자체 모델 라인업 가운데 하나예요.",
				},
			];

			for (let i = 0; i < testTurns.length; i += 1) {
				const turn = testTurns[i]!;
				fireEvent.change(input, { target: { value: turn.question } });
				fireEvent.keyDown(input, { key: "Enter" });
				await waitFor(() => expect(capturedSlideRequests).toHaveLength(i + 1));

				const req = capturedSlideRequests[i];
				expect(req.message).toBe(turn.question);
				expect(req.disabledSkills).toEqual(
					expect.arrayContaining([
						"skill_knowledge_search",
						"skill_knowledge_ask",
						"read_file",
					]),
				);

				const appSeg = (req.environmentSegments as EnvironmentSegment[]).find(
					(seg) => seg.kind === "app",
				);
				expect(appSeg).toBeDefined();
				const slideEntry =
					appSeg?.kind === "app"
						? appSeg.entries.find(
								(e) => e.type === "Active IR Slide Context",
							)
						: undefined;
				expect(slideEntry).toBeDefined();
				const slideData = slideEntry?.data as
					| Record<string, unknown>
					| undefined;
				expect(slideData?.page).toBe(2);
				expect(slideData?.source).toBe("brand.md");
				expect(slideData?.bullets).toEqual(slide2.bullets);
				expect(slideData?.script).toBe(slide2.script);
				expect(String(slideData?.instructions)).toContain(
					"별자리 코드명: 루나(달)·테라(지구)·솔(태양)·스텔라(별)·노바(신성)",
				);
				expect(String(slideData?.instructions)).toContain(slide2.script);
				expect(String(slideData?.instructions)).toContain(
					"근거 파일은 오직 knowledge/brand.md 하나만 사용하세요.",
				);

				await act(async () => {
					req.onChunk({
						type: "text",
						requestId: req.requestId,
						text: turn.reply,
					});
					req.onChunk({
						type: "finish",
						requestId: req.requestId,
					});
				});

				await waitFor(() =>
					expect(screen.getByText(turn.reply)).toBeInTheDocument(),
				);
			}

			// Verify evidence chips under slide question replies contain ONLY knowledge/brand.md
			const evidenceBlocks = screen.getAllByTestId("chat-kiosk-evidence");
			const lastEvidence = evidenceBlocks.at(-1)!;
			expect(lastEvidence).toHaveTextContent("knowledge/brand.md");
			expect(lastEvidence).not.toHaveTextContent("AGENTS.md");
			expect(lastEvidence).not.toHaveTextContent("marketing.md");
			expect(lastEvidence).not.toHaveTextContent("growth.md");
			expect(lastEvidence).not.toHaveTextContent("memory/guest-memory.md");
		} finally {
			unregisterSlides();
			useAppStore.getState().setActiveApp(null);
			vi.unstubAllEnvs();
			localStorage.removeItem("naia-config");
			localStorage.removeItem("naia-remote-key");
		}
	});

	it("P2-1 & P2-2 preserves past message evidence chips when slides open or change pages, and enables knowledge search with slide reference when presentation is completed or paused", async () => {
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO_KEY", "naia_test_kiosk_fixture_123456");
		setWebModelStatus({ phase: "ready" });
		setWebAdkStatus({ phase: "ready" });
		localStorage.setItem("naia-remote-key", "naia_test_kiosk_fixture_123456");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gpt-5.6-luna",
				naiaKey: "naia_test_kiosk_fixture_123456",
				enableTools: true,
				enableThinking: true,
				thinkingLevel: "low",
				ttsEnabled: false,
			}),
		);
		useAppStore.getState().setActiveApp(null);
		useChatStore.getState().newConversation();

		let slideMode: "presenting" | "answering" | "paused" | "completed" =
			"presenting";
		let slidePage = 3;
		let unregisterSlides: (() => void) | null = null;

		try {
			const capturedSlideRequests: any[] = [];
			vi.mocked(sendChatMessage).mockImplementation(async (opts: any) => {
				capturedSlideRequests.push(opts);
				return opts.requestId;
			});

			render(<ChatArea />);
			const input = await screen.findByPlaceholderText(/메시지|message/i);

			// 1. Before opening slides: ask "넥스테인은 뭘 하는 회사예요?" -> evidence is knowledge/company.md
			fireEvent.change(input, {
				target: { value: "넥스테인은 뭘 하는 회사예요?" },
			});
			fireEvent.keyDown(input, { key: "Enter" });
			await waitFor(() => expect(capturedSlideRequests).toHaveLength(1));

			const req1 = capturedSlideRequests[0];
			await act(async () => {
				req1.onChunk({
					type: "tool_use",
					requestId: req1.requestId,
					toolCallId: "tc-company",
					toolName: "skill_knowledge_search",
					args: { query: "넥스테인 회사 소개" },
				});
				req1.onChunk({
					type: "tool_result",
					requestId: req1.requestId,
					toolCallId: "tc-company",
					success: true,
					output: JSON.stringify({
						abstained: false,
						hits: [
							{
								id: "company-1",
								sourceUris: [
									"opfs://naia-adk/kiosk-demo/knowledge/company.md",
								],
							},
						],
					}),
				});
				req1.onChunk({
					type: "text",
					requestId: req1.requestId,
					text: "넥스테인은 비주얼 에이전트 나이아를 만드는 AI 기업이에요.",
				});
				req1.onChunk({
					type: "finish",
					requestId: req1.requestId,
				});
			});

			await waitFor(() =>
				expect(screen.getAllByTestId("chat-kiosk-evidence")).toHaveLength(1),
			);
			expect(screen.getAllByTestId("chat-kiosk-evidence")[0]).toHaveTextContent(
				"knowledge/company.md",
			);

			// 2. Open slides on slide 3 (naia.md) while presenting/answering and ask a mid-presentation question
			slideMode = "answering";
			slidePage = 3;
			unregisterSlides = registerKioskSlidesController({
				performAction: vi.fn(),
				isPresenting: () => slideMode === "presenting",
				isAnsweringQuestion: () => slideMode === "answering",
				getCurrentPage: () => slidePage,
				onTurnSettled: vi.fn(),
			});
			useAppStore.getState().setActiveApp("land.naia.slides");

			fireEvent.change(input, {
				target: { value: "방금 장에서 핵심 지표가 뭐예요?" },
			});
			fireEvent.keyDown(input, { key: "Enter" });
			await waitFor(() => expect(capturedSlideRequests).toHaveLength(2));

			const req2 = capturedSlideRequests[1];
			expect(req2.disabledSkills).toEqual(
				expect.arrayContaining([
					"skill_knowledge_search",
					"skill_knowledge_ask",
					"read_file",
				]),
			);
			await act(async () => {
				req2.onChunk({
					type: "text",
					requestId: req2.requestId,
					text: "이 장에는 핵심 지표가 없어요. 3장에서는 나이아 3종 구성을 소개하고 있어요.",
				});
				req2.onChunk({
					type: "finish",
					requestId: req2.requestId,
				});
			});

			await waitFor(() =>
				expect(screen.getAllByTestId("chat-kiosk-evidence")).toHaveLength(2),
			);

			// Navigate slides to slide 5 (adk.md) -> neither turn 1 (company.md) nor turn 2 (naia.md) may change to adk.md
			slidePage = 5;
			const evidencesAfterSlide5 = screen.getAllByTestId("chat-kiosk-evidence");
			expect(evidencesAfterSlide5[0]).toHaveTextContent("knowledge/company.md");
			expect(evidencesAfterSlide5[0]).not.toHaveTextContent(
				"knowledge/naia.md",
			);
			expect(evidencesAfterSlide5[0]).not.toHaveTextContent("knowledge/adk.md");
			expect(evidencesAfterSlide5[1]).toHaveTextContent("knowledge/naia.md");
			expect(evidencesAfterSlide5[1]).not.toHaveTextContent("knowledge/adk.md");

			// 3. P2-2: Presentation finishes on slide 9 (completed) while slides window stays open -> asking "기억의 주인은 누구인가요?" keeps slide 9 as reference but enables knowledge search
			slideMode = "completed";
			slidePage = 9;
			fireEvent.change(input, {
				target: { value: "기억의 주인은 누구인가요?" },
			});
			fireEvent.keyDown(input, { key: "Enter" });
			await waitFor(() => expect(capturedSlideRequests).toHaveLength(3));

			const req3 = capturedSlideRequests[2];
			expect(req3.disabledSkills ?? []).not.toContain(
				"skill_knowledge_search",
			);
			expect(req3.disabledSkills ?? []).not.toContain("skill_knowledge_ask");
			expect(req3.disabledSkills ?? []).not.toContain("read_file");

			const appSeg3 = (req3.environmentSegments as EnvironmentSegment[]).find(
				(seg) => seg.kind === "app",
			);
			const slideEntry3 =
				appSeg3?.kind === "app"
					? appSeg3.entries.find((e) => e.type === "Active IR Slide Context")
					: undefined;
			expect(slideEntry3).toBeDefined();
			const slideData3 = slideEntry3?.data as
				| Record<string, unknown>
				| undefined;
			expect(slideData3?.page).toBe(9);
			expect(slideData3?.source).toBe("future.md");
			expect(slideData3?.restrictToSlide).toBe(false);
			expect(String(slideData3?.instructions)).toContain(
				"skill_knowledge_search",
			);

			await act(async () => {
				req3.onChunk({
					type: "tool_use",
					requestId: req3.requestId,
					toolCallId: "tc-memory",
					toolName: "skill_knowledge_search",
					args: { query: "기억의 주인" },
				});
				req3.onChunk({
					type: "tool_result",
					requestId: req3.requestId,
					toolCallId: "tc-memory",
					success: true,
					output: JSON.stringify({
						abstained: false,
						hits: [
							{
								id: "memory-1",
								sourceUris: [
									"opfs://naia-adk/kiosk-demo/knowledge/memory.md",
								],
							},
						],
					}),
				});
				req3.onChunk({
					type: "text",
					requestId: req3.requestId,
					text: "나이아에서 기억의 주인은 사용자 자신이에요.",
				});
				req3.onChunk({
					type: "finish",
					requestId: req3.requestId,
				});
			});

			await waitFor(() =>
				expect(screen.getAllByTestId("chat-kiosk-evidence")).toHaveLength(3),
			);
			const finalEvidences = screen.getAllByTestId("chat-kiosk-evidence");
			expect(finalEvidences[0]).toHaveTextContent("knowledge/company.md");
			expect(finalEvidences[1]).toHaveTextContent("knowledge/naia.md");
			expect(finalEvidences[2]).toHaveTextContent("knowledge/memory.md");
			expect(finalEvidences[2]).not.toHaveTextContent("knowledge/future.md");
		} finally {
			unregisterSlides?.();
			useAppStore.getState().setActiveApp(null);
			vi.unstubAllEnvs();
			localStorage.removeItem("naia-config");
			localStorage.removeItem("naia-remote-key");
		}
	});

	it("handles conversational YouTube play and stop requests in web kiosk mode via skill_youtube_bgm tool call (fix7d)", async () => {
		const previousLocale = getLocale();
		await setLocale("ko");
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO_KEY", "naia_test_kiosk_fixture_123456");
		const { bgmPlayback } = await import("../../lib/bgm-playback");
		setWebModelStatus({ phase: "ready" });
		setWebAdkStatus({ phase: "ready" });
		bgmPlayback.reset();

		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "glm-5.1",
				naiaKey: "naia_test_kiosk_fixture_123456",
				ttsEnabled: false,
				enableTools: true,
			}),
		);

		try {
			render(<ChatArea />);
			const input = screen.getByPlaceholderText(/메시지|message/i);

			// 1. User requests YouTube playback in chat
			fireEvent.change(input, { target: { value: "유튜브 틀어 줘" } });
			fireEvent.keyDown(input, { key: "Enter" });

			await waitFor(() => {
				expect(bgmPlayback.current()?.status).toBe("playing");
			});

			const playMessages = useChatStore.getState().messages;
			const assistantPlayMsg = playMessages.at(-1);
			expect(assistantPlayMsg?.role).toBe("assistant");
			expect(assistantPlayMsg?.content).toContain("재생을 시작했어요");
			expect(assistantPlayMsg?.toolCalls?.[0]).toMatchObject({
				toolName: "skill_youtube_bgm",
				args: { action: "play", category: "lofi" },
				status: "success",
			});

			// 2. User requests stopping YouTube playback in chat
			fireEvent.change(input, { target: { value: "유튜브 멈춰 줘" } });
			fireEvent.keyDown(input, { key: "Enter" });

			await waitFor(() => {
				expect(bgmPlayback.current()?.status).toBe("ended");
			});

			const stopMessages = useChatStore.getState().messages;
			const assistantStopMsg = stopMessages.at(-1);
			expect(assistantStopMsg?.role).toBe("assistant");
			expect(assistantStopMsg?.content).toContain("재생을 멈췄어요");
			expect(assistantStopMsg?.toolCalls?.[0]).toMatchObject({
				toolName: "skill_youtube_bgm",
				args: { action: "stop" },
				status: "success",
			});
		} finally {
			bgmPlayback.reset();
			vi.unstubAllEnvs();
			localStorage.removeItem("naia-config");
			await setLocale(previousLocale);
		}
	});

	it("renders compactable local-answer toggle label and prevents overlap with '처음으로' across 1440x900 desktop card (368px), 412x915 mobile, and 360px widths (fix7f)", async () => {
		const previousLocale = getLocale();
		await setLocale("ko");
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO_KEY", "naia_test_kiosk_fixture_123456");
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");

		try {
			render(<ChatArea />);
			const headerWrap = screen.getByTestId("kiosk-local-answer-header");
			const toggleBtn = screen.getByTestId("kiosk-local-answer-toggle");
			const resetBtn = screen.getByRole("button", { name: "처음으로" });

			expect(toggleBtn).toHaveAttribute("aria-label", "내 PC 에서 대답하기");
			expect(toggleBtn.getAttribute("title")).toContain("내 PC 에서 대답하기");
			expect(toggleBtn.textContent).toBe("내 PC 에서 대답하기");

			const prefix = toggleBtn.querySelector(
				".kiosk-local-answer-label-prefix",
			);
			const suffix = toggleBtn.querySelector(
				".kiosk-local-answer-label-suffix",
			);
			expect(prefix?.textContent).toBe("내 PC");
			expect(suffix?.textContent).toBe(" 에서 대답하기");
			expect(headerWrap.compareDocumentPosition(resetBtn)).toBe(
				Node.DOCUMENT_POSITION_FOLLOWING,
			);

			const webModeCss = readFileSync(
				resolve(__dirname, "../../styles/web-mode.css"),
				"utf8",
			);
			const kioskCss = readFileSync(
				resolve(__dirname, "../KioskDemoGate.css"),
				"utf8",
			);
			expect(webModeCss).toContain("min-width: max-content;");
			expect(webModeCss).toContain(
				'[data-naia-web="true"] .chat-header .kiosk-local-answer-label-suffix',
			);
			expect(kioskCss).toContain(
				'.app-root[data-kiosk-demo="true"]:not([data-layout-orientation="portrait"]) .chat-header .kiosk-local-answer-hint',
			);
			expect(kioskCss).toContain(
				'.app-root[data-kiosk-demo="true"]:not([data-layout-orientation="portrait"]):not([data-ui-mode="workspace"])\n\t\t.chat-header\n\t\t.kiosk-local-answer-label-suffix',
			);

			// Verify single-row non-overlap budget across widths: 360px (narrow mobile), 368px (1440x900 desktop card), 412px (mobile portrait)
			for (const headerWidth of [360, 368, 412]) {
				const horizontalPad = headerWidth === 368 ? 20 : 12;
				const tabsWidth = 104;
				const aiControlWidth = 56;
				const compactToggleWidth = 42; // "내 PC" compact pill
				const resetWidth = 54; // "처음으로"
				const newChatWidth = 24; // "+"
				const gaps = headerWidth === 368 ? 24 : 15;
				const rightGroupStart =
					headerWidth -
					horizontalPad / 2 -
					(compactToggleWidth + resetWidth + newChatWidth + 8);
				const leftGroupEnd =
					horizontalPad / 2 + tabsWidth + aiControlWidth + gaps;
				const toggleRight = rightGroupStart + compactToggleWidth;
				const resetLeft = toggleRight + 4;
				expect(leftGroupEnd).toBeLessThanOrEqual(rightGroupStart);
				expect(toggleRight).toBeLessThanOrEqual(resetLeft);
			}
		} finally {
			vi.unstubAllEnvs();
			await setLocale(previousLocale);
		}
	});
}
