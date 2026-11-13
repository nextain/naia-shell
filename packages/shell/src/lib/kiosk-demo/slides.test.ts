// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlidesCenterArea } from "../../apps/slides/SlidesCenterArea";
import type {
	AppContext,
	BehaviorEntry,
	NaiaContextBridge,
	ShellResult,
	ToolHandler,
} from "../app-registry";
import { setLocale } from "../i18n";
import { parseSlideSpeakerNotes } from "../slide-presenter";
import {
	SLIDE_PRESENTER_SPEAK_EVENT,
	SLIDE_PRESENTER_SPEECH_RESULT_EVENT,
	type SlidePresenterSpeechRequest,
} from "../slide-presenter-events";
import { resetWarnedCommands, routeCommand } from "../web-runtime/router";
import { createMemoryWebFs } from "../web-runtime/web-fs";
import { useAppStore } from "../../stores/app";
import { useChatStore } from "../../stores/chat";
import * as kioskFlag from "./flag";
import {
	FORBIDDEN_IR_SLIDE_WORDS,
	type KioskIrDeck,
	assertPublicIrSlides,
	buildKioskIrPdfBytes,
	buildKioskIrScriptMarkdown,
	buildKioskSlideQuestionPrompt,
	buildKioskSlideReferencePrompt,
	classifyKioskSlidesIntent,
	getActiveKioskIrSlide,
	getKioskIrSlide,
	getKioskIrSlides,
	handleKioskSlidesChatTurn,
	isKioskSlideQuestionTurnActive,
	notifyKioskSlidesTurnSettled,
	registerKioskSlidesController,
	seedKioskSlidesWorkspace,
} from "./slides";
import rawIrPublicDeck from "./slides/ir-public.json";

vi.mock("../logger", () => ({
	Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (cmd: string, args?: unknown) => routeCommand(cmd, args),
}));

vi.mock("react-pdf", () => {
	function Document({ children }: { children: ReactNode }) {
		return createElement("div", { "data-testid": "pdf-document" }, children);
	}
	function Page({ pageNumber }: { pageNumber: number }) {
		return createElement(
			"div",
			{ "data-testid": `pdf-page-${pageNumber}` },
			`PDF page ${pageNumber}`,
		);
	}
	return {
		Document,
		Page,
		pdfjs: { GlobalWorkerOptions: { workerSrc: "" } },
	};
});
vi.mock("react-pdf/dist/Page/AnnotationLayer.css", () => ({}));
vi.mock("react-pdf/dist/Page/TextLayer.css", () => ({}));

class MockBridge implements NaiaContextBridge {
	contexts: AppContext[] = [];
	handlers = new Map<string, ToolHandler>();
	pushContext(ctx: AppContext): void {
		this.contexts.push(ctx);
	}
	onToolCall(name: string, handler: ToolHandler): () => void {
		this.handlers.set(name, handler);
		return () => this.handlers.delete(name);
	}
	async callTool(name: string, args: Record<string, unknown>): Promise<string> {
		return (await this.handlers.get(name)?.(args)) ?? "ok";
	}
	logBehavior(): Promise<void> {
		return Promise.resolve();
	}
	queryBehavior(): Promise<BehaviorEntry[]> {
		return Promise.resolve([]);
	}
	getSecret(): Promise<string | null> {
		return Promise.resolve(null);
	}
	setSecret(): Promise<void> {
		return Promise.resolve();
	}
	readFile(): Promise<string> {
		return Promise.resolve("");
	}
	runShell(): Promise<ShellResult> {
		return Promise.resolve({ stdout: "", stderr: "", code: 0 });
	}
}

describe("kiosk-demo S6 public IR slides", () => {
	beforeEach(async () => {
		resetWarnedCommands();
		await setLocale("ko");
		useAppStore.getState().setActiveApp(null);
		useChatStore.getState().newConversation();
		class ResizeObserverMock {
			observe() {}
			unobserve() {}
			disconnect() {}
		}
		globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		useAppStore.getState().setActiveApp(null);
	});

	it("provides an 8-10 slide public IR deck with <=3 bullets per slide and zero sensitive words", () => {
		const slides = getKioskIrSlides();
		expect(slides.length).toBeGreaterThanOrEqual(8);
		expect(slides.length).toBeLessThanOrEqual(10);

		const rawJson = JSON.stringify(rawIrPublicDeck);
		for (const forbidden of [
			"매출",
			"투자",
			"억",
			"밸류",
			"계약금",
			"계약 금액",
			"영업이익",
			"순이익",
			"지분",
			"기업가치",
			"개인 정보",
			"개인정보",
			...FORBIDDEN_IR_SLIDE_WORDS,
		]) {
			expect(rawJson).not.toContain(forbidden);
		}

		for (let i = 0; i < slides.length; i += 1) {
			const slide = slides[i]!;
			expect(slide.page).toBe(i + 1);
			expect(slide.title.trim().length).toBeGreaterThan(0);
			expect(slide.bullets.length).toBeGreaterThanOrEqual(1);
			expect(slide.bullets.length).toBeLessThanOrEqual(3);
			for (const bullet of slide.bullets) {
				expect(bullet.trim().length).toBeGreaterThan(0);
				expect(bullet).not.toContain("\n");
			}
			expect(slide.script.trim().length).toBeGreaterThan(20);
			expect(getKioskIrSlide(slide.page)?.id).toBe(slide.id);
		}
	});

	it("rejects decks containing sensitive financial terms or >3 bullet lines", () => {
		const baseDeck = structuredClone(rawIrPublicDeck) as KioskIrDeck;
		for (const word of ["매출", "투자", "억", "밸류", "계약금"]) {
			const mutated = structuredClone(baseDeck);
			mutated.slides[0]!.script += ` 올해 ${word} 목표`;
			expect(() => assertPublicIrSlides(mutated)).toThrow(
				`forbidden_ir_slide_word:${word}:page_1`,
			);
		}

		const tooManyBullets = structuredClone(baseDeck);
		tooManyBullets.slides[0]!.bullets.push("네 번째 줄");
		expect(() => assertPublicIrSlides(tooManyBullets)).toThrow(
			"invalid_ir_deck:bullets_count_page_1",
		);
	});

	it("builds a valid multi-page PDF and companion speaker script markdown", () => {
		const slides = getKioskIrSlides();
		const pdfBytes = buildKioskIrPdfBytes(slides);
		const pdfText = new TextDecoder().decode(new Uint8Array(pdfBytes));
		expect(pdfText.startsWith("%PDF-1.4\n")).toBe(true);
		expect(pdfText).toContain(`/Count ${slides.length}`);

		const markdown = buildKioskIrScriptMarkdown(slides);
		const parsedNotes = parseSlideSpeakerNotes(markdown);
		expect(parsedNotes.size).toBe(slides.length);
		expect(parsedNotes.get(1)).toBe(slides[0]!.script);
		expect(parsedNotes.get(slides.length)).toBe(slides.at(-1)!.script);
	});

	it("opens only the needed slides web commands when kiosk flag is ON and keeps them blocked when OFF", async () => {
		vi.spyOn(kioskFlag, "isKioskDemo").mockReturnValue(false);
		await expect(routeCommand("slides_open_document")).rejects.toThrow(
			"desktop_only:slides_open_document",
		);
		await expect(routeCommand("slides_open_pdf")).rejects.toThrow(
			"desktop_only:slides_open_pdf",
		);
		await expect(routeCommand("slides_cancel_open")).rejects.toThrow(
			"desktop_only:slides_cancel_open",
		);
		await expect(routeCommand("slides_recording_start")).rejects.toThrow(
			"desktop_only:slides_recording_start",
		);

		vi.spyOn(kioskFlag, "isKioskDemo").mockReturnValue(true);
		const doc = (await routeCommand("slides_open_document")) as {
			name: string;
			sourceFormat: string;
			bytes: number[];
			scriptContent: string;
		};
		expect(doc.name).toBe("넥스테인 공개 IR 발표.pdf");
		expect(doc.sourceFormat).toBe("pdf");
		expect(doc.bytes.length).toBeGreaterThan(500);
		expect(doc.scriptContent).toContain("## 1.");
		await expect(routeCommand("slides_cancel_open")).resolves.toBe(false);

		// Recording commands remain desktop-only even in kiosk mode
		await expect(routeCommand("slides_recording_start")).rejects.toThrow(
			"desktop_only:slides_recording_start",
		);
		await expect(routeCommand("slides_recording_stop")).rejects.toThrow(
			"desktop_only:slides_recording_stop",
		);
	});

	it("classifies presentation start and control intents without misclassifying questions", () => {
		expect(classifyKioskSlidesIntent("IR 발표해 줘")).toEqual({
			kind: "start",
		});
		expect(classifyKioskSlidesIntent("ir 자료 발표해줘")).toEqual({
			kind: "start",
		});
		expect(classifyKioskSlidesIntent("슬라이드 발표 시작해 줘")).toEqual({
			kind: "start",
		});
		expect(classifyKioskSlidesIntent("멈춤")).toEqual({ kind: "pause" });
		expect(classifyKioskSlidesIntent("이어 가기")).toEqual({ kind: "resume" });
		expect(classifyKioskSlidesIntent("다음 장")).toEqual({ kind: "next" });
		expect(classifyKioskSlidesIntent("이전 장")).toEqual({ kind: "previous" });
		expect(classifyKioskSlidesIntent("끝내기")).toEqual({ kind: "stop" });
		expect(
			classifyKioskSlidesIntent("나이아 웹판과 데스크톱판의 차이가 뭐야?"),
		).toBeNull();
	});

	it("opens slides on 'IR 발표해 줘', narrates slide by slide, pauses for a mid-presentation question, resumes, and closes on '끝내기'", async () => {
		vi.spyOn(kioskFlag, "isKioskDemo").mockReturnValue(true);
		const speechRequests: SlidePresenterSpeechRequest[] = [];
		const onSpeak = (event: Event) => {
			speechRequests.push(
				(event as CustomEvent<SlidePresenterSpeechRequest>).detail,
			);
		};
		window.addEventListener(SLIDE_PRESENTER_SPEAK_EVENT, onSpeak);

		try {
			const handledStart = await handleKioskSlidesChatTurn("IR 발표해 줘");
			expect(handledStart).toBe(true);
			expect(useAppStore.getState().activeApp).toBe("land.naia.slides");

			render(createElement(SlidesCenterArea, { naia: new MockBridge() }));

			await waitFor(() =>
				expect(screen.getByTestId("slides-card-title")).toHaveTextContent(
					"넥스테인(Nextain)과 나이아의 출발",
				),
			);
			expect(screen.getByText("1 / 9")).toBeInTheDocument();
			await waitFor(() => expect(speechRequests.length).toBeGreaterThanOrEqual(1));
			expect(speechRequests.at(-1)?.page).toBe(1);

			// Finish speech for Slide 1 -> automatically advances to Slide 2
			window.dispatchEvent(
				new CustomEvent(SLIDE_PRESENTER_SPEECH_RESULT_EVENT, {
					detail: { ...speechRequests.at(-1)!, status: "finished" },
				}),
			);

			await waitFor(() => expect(screen.getByText("2 / 9")).toBeInTheDocument());
			expect(screen.getByTestId("slides-card-title")).toHaveTextContent(
				"브랜드 체계: 나이아와 별자리 모델 이름",
			);
			await waitFor(() =>
				expect(speechRequests.at(-1)?.page).toBe(2),
			);

			// Ask a question mid-presentation -> pauses slide into answering state and lets chat turn proceed
			const handledQuestion = await handleKioskSlidesChatTurn(
				"나이아의 세 가지 제품 판은 무엇인가요?",
			);
			expect(handledQuestion).toBe(false);
			await waitFor(() =>
				expect(
					screen.getByRole("region", { name: "슬라이드 발표" }),
				).toHaveAttribute("data-state", "answering"),
			);
			expect(
				screen.getByRole("button", { name: "이어 가기" }),
			).toBeInTheDocument();

			// Resume via button or turn settled
			fireEvent.click(screen.getByRole("button", { name: "이어 가기" }));
			await waitFor(() =>
				expect(
					screen.getByRole("region", { name: "슬라이드 발표" }),
				).toHaveAttribute("data-state", "presenting"),
			);

			// Pause again for question, verify a follow-up question within 1.2s cancels auto-resume timer (P3-1), and auto-resumes only after the follow-up turn settles
			vi.useFakeTimers();
			try {
				await handleKioskSlidesChatTurn("ADK가 무엇인가요?");
				expect(
					screen.getByRole("region", { name: "슬라이드 발표" }),
				).toHaveAttribute("data-state", "answering");
				notifyKioskSlidesTurnSettled();
				await vi.advanceTimersByTimeAsync(500);
				expect(
					screen.getByRole("region", { name: "슬라이드 발표" }),
				).toHaveAttribute("data-state", "answering");

				// Second question arrives within the 1.2s auto-resume window -> cancels the pending timer
				const handledSecondQuestion = await handleKioskSlidesChatTurn(
					"이 장에서 별자리 이름은 뭐예요?",
				);
				expect(handledSecondQuestion).toBe(false);
				await vi.advanceTimersByTimeAsync(900);
				// 1,400ms total elapsed since first settle, but presentation must still be answering
				expect(
					screen.getByRole("region", { name: "슬라이드 발표" }),
				).toHaveAttribute("data-state", "answering");

				// Now the second question turn settles -> auto-resumes after 1.2s
				notifyKioskSlidesTurnSettled();
				await vi.advanceTimersByTimeAsync(1300);
				expect(
					screen.getByRole("region", { name: "슬라이드 발표" }),
				).toHaveAttribute("data-state", "presenting");
			} finally {
				vi.useRealTimers();
			}

			// Click '끝내기' -> stops presentation and closes Slides app
			fireEvent.click(screen.getByRole("button", { name: "끝내기" }));
			expect(useAppStore.getState().activeApp).toBeNull();
		} finally {
			window.removeEventListener(SLIDE_PRESENTER_SPEAK_EVENT, onSpeak);
		}
	});

	it("builds model-input slide grounding prompt containing active slide body, speaker script, single source file, and rules for diverse questions", () => {
		vi.spyOn(kioskFlag, "isKioskDemo").mockReturnValue(true);
		const slide2 = getKioskIrSlide(2)!;
		expect(slide2.title).toBe("브랜드 체계: 나이아와 별자리 모델 이름");
		expect(slide2.source).toBe("brand.md");

		const questions = [
			"방금 장에서 핵심 지표가 뭐예요?",
			"이 장에서 노바는 뭐예요?",
			"방금 장 요약해 줘",
			"가격은 얼마예요?",
		];

		for (const q of questions) {
			const prompt = buildKioskSlideQuestionPrompt(slide2, q);
			expect(prompt).toContain(
				"[현재 발표 중인 슬라이드: 2장 — 브랜드 체계: 나이아와 별자리 모델 이름 (Brand & Naming Universe)]",
			);
			expect(prompt).toContain("장 원고 파일: knowledge/brand.md");
			expect(prompt).toContain(
				"별자리 코드명: 루나(달)·테라(지구)·솔(태양)·스텔라(별)·노바(신성)",
			);
			expect(prompt).toContain(slide2.script);
			expect(prompt).toContain("이 장에는 지표가 없어요");
			expect(prompt).toContain("이 장에는 가격 내용이 없어요");
			expect(prompt).toContain("근거 파일은 오직 knowledge/brand.md 하나만 사용하세요.");
			expect(prompt).toContain(`사용자 질문: ${q}`);
			expect(prompt).not.toContain("안드로메다");
			expect(prompt).not.toContain("카시오페아");
			expect(prompt).not.toContain("센타우루스");
		}

		expect(isKioskSlideQuestionTurnActive()).toBe(false);
		useAppStore.getState().setActiveApp("land.naia.slides");
		// P2-2: Simply having the slides window open (ready/paused/completed) does NOT activate strict single-slide lock
		expect(isKioskSlideQuestionTurnActive()).toBe(false);
		expect(getActiveKioskIrSlide()?.page).toBe(1);

		let mode: "ready" | "presenting" | "answering" | "paused" | "completed" =
			"presenting";
		let currentPage = 2;
		const unregister = registerKioskSlidesController({
			performAction: vi.fn(),
			isPresenting: () => mode === "presenting",
			isAnsweringQuestion: () => mode === "answering",
			getCurrentPage: () => currentPage,
			onTurnSettled: vi.fn(),
		});
		try {
			expect(isKioskSlideQuestionTurnActive()).toBe(true);
			expect(getActiveKioskIrSlide()?.page).toBe(2);

			mode = "answering";
			expect(isKioskSlideQuestionTurnActive()).toBe(true);

			mode = "paused";
			expect(isKioskSlideQuestionTurnActive()).toBe(false);
			expect(getActiveKioskIrSlide()?.page).toBe(2);

			mode = "completed";
			currentPage = 9;
			expect(isKioskSlideQuestionTurnActive()).toBe(false);
			const slide9 = getActiveKioskIrSlide()!;
			expect(slide9.page).toBe(9);
			expect(slide9.source).toBe("future.md");

			const refPrompt = buildKioskSlideReferencePrompt(
				slide9,
				"기억의 주인은 누구인가요?",
			);
			expect(refPrompt).toContain("[현재 열려 있는 슬라이드 참고: 9장");
			expect(refPrompt).toContain("장 원고 파일: knowledge/future.md");
			expect(refPrompt).toContain("skill_knowledge_search");
			expect(refPrompt).toContain("사용자 질문: 기억의 주인은 누구인가요?");
		} finally {
			unregister();
		}
	});

	it("registers land.naia.slides in the app list via app_list_installed in kiosk mode and advances to page 2 on '다음 장'", async () => {
		vi.spyOn(kioskFlag, "isKioskDemo").mockReturnValue(true);
		const { appRegistry } = await import("../app-registry");
		const installed = await routeCommand("app_list_installed");
		expect(installed).toEqual([]);
		expect(appRegistry.get("land.naia.slides")).toBeDefined();

		useAppStore.getState().setActiveApp("land.naia.slides");
		render(createElement(SlidesCenterArea, { naia: new MockBridge() }));

		await waitFor(() =>
			expect(screen.getByTestId("slides-card-title")).toHaveTextContent(
				"넥스테인(Nextain)과 나이아의 출발",
			),
		);
		expect(screen.getByText("1 / 9")).toBeInTheDocument();

		const handledNext = await handleKioskSlidesChatTurn("다음 장");
		expect(handledNext).toBe(true);
		await waitFor(() => expect(screen.getByText("2 / 9")).toBeInTheDocument());
		expect(screen.getByTestId("slides-card-title")).toHaveTextContent(
			"브랜드 체계: 나이아와 별자리 모델 이름",
		);
	});

	it("seeds the read-aloud script into the explorer's slides folder without the old folder name or 키오스크", async () => {
		const flag = vi.spyOn(kioskFlag, "isKioskDemo").mockReturnValue(true);
		const fs = createMemoryWebFs();
		await seedKioskSlidesWorkspace(fs);
		expect(Object.keys(fs.snapshot()).sort()).toEqual([
			"naia-adk",
			"naia-adk/slides",
			"naia-adk/slides/nextain-ir-public.md",
		]);
		const script = await fs.readText("naia-adk/slides/nextain-ir-public.md");
		expect(script).toContain("## 9. 앞으로의 확장");
		expect(script).not.toContain("키오스크");
		expect(JSON.stringify(rawIrPublicDeck)).not.toContain("키오스크");
		const write = vi.spyOn(fs, "writeBytes");
		await seedKioskSlidesWorkspace(fs);
		expect(write).not.toHaveBeenCalled();
		flag.mockRestore();
	});
});
