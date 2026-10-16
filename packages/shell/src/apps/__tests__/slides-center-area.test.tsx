// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AppContext,
	BehaviorEntry,
	NaiaContextBridge,
	ShellResult,
	ToolHandler,
} from "../../lib/app-registry";
import { setLocale } from "../../lib/i18n";
import { Logger } from "../../lib/logger";
import {
	SLIDE_PRESENTER_CANCEL_EVENT,
	SLIDE_PRESENTER_SPEAK_EVENT,
	SLIDE_PRESENTER_SPEECH_RESULT_EVENT,
	type SlidePresenterSpeechRequest,
} from "../../lib/slide-presenter-events";

vi.mock("../../lib/logger", () => ({
	Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../lib/config", () => ({ addAllowedTool: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const picker = vi.hoisted(() => ({ available: false, open: vi.fn() }));
const mediaPlayback = vi.hoisted(() => ({
	play: vi.fn(),
	pause: vi.fn(),
	load: vi.fn(),
}));
vi.mock("../../lib/slides-files", () => ({
	openSlidesDocument: picker.open,
	openSlidesPdf: picker.open,
	watchSlidesPickerAvailable: (callback: (available: boolean) => void) => {
		callback(picker.available);
		return () => {};
	},
}));

vi.mock("react-pdf", async () => {
	const React = await vi.importActual<typeof import("react")>("react");
	function Document({
		file,
		children,
		onLoadSuccess,
	}: {
		file: File;
		children: React.ReactNode;
		onLoadSuccess?: (document: {
			numPages: number;
			getPage(page: number): Promise<{
				getTextContent(): Promise<{ items: Array<{ str: string }> }>;
			}>;
		}) => void;
	}) {
		React.useEffect(() => {
			const timer = setTimeout(
				() =>
					onLoadSuccess?.({
						numPages: 3,
						getPage: async (page) => ({
							getTextContent: async () => ({
								items: [{ str: `PDF text ${page}` }],
							}),
						}),
					}),
				0,
			);
			return () => clearTimeout(timer);
		}, [file]);
		return <div data-testid="pdf-document">{children}</div>;
	}
	function Page({ pageNumber }: { pageNumber: number }) {
		return (
			<div data-testid={`pdf-page-${pageNumber}`}>PDF page {pageNumber}</div>
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

import {
	SlidesCenterArea,
	resolveSlidesPdfWorkerUrl,
} from "../slides/SlidesCenterArea";

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

describe("SlidesCenterArea", () => {
	const originalMediaPlay = Object.getOwnPropertyDescriptor(
		HTMLMediaElement.prototype,
		"play",
	);
	const originalMediaPause = Object.getOwnPropertyDescriptor(
		HTMLMediaElement.prototype,
		"pause",
	);
	const originalMediaLoad = Object.getOwnPropertyDescriptor(
		HTMLMediaElement.prototype,
		"load",
	);
	const originalCreateObjectURL = Object.getOwnPropertyDescriptor(
		URL,
		"createObjectURL",
	);
	const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(
		URL,
		"revokeObjectURL",
	);
	let objectUrlId = 0;

	it("rebases the PDF worker under a Tauri asset app path", () => {
		expect(
			resolveSlidesPdfWorkerUrl("/assets/pdf.worker.min-hash.mjs", {
				protocol: "asset:",
				host: "localhost",
				pathname:
					"/%2Fvar%2Ftmp%2Fnaia-store-proof%2Fadk%2F.naia%2Fapps%2Fland.naia.slides%2Findex.html",
			}),
		).toBe(
			"asset://localhost/%2Fvar%2Ftmp%2Fnaia-store-proof%2Fadk%2F.naia%2Fapps%2Fland.naia.slides%2Fassets%2Fpdf.worker.min-hash.mjs",
		);
	});

	it("leaves ordinary browser worker URLs unchanged", () => {
		const workerUrl = "/assets/pdf.worker.min-hash.mjs";
		expect(
			resolveSlidesPdfWorkerUrl(workerUrl, {
				protocol: "http:",
				host: "localhost:5173",
				pathname: "/src/apps/slides/index.html",
			}),
		).toBe(workerUrl);
	});

	it("rebases Windows asset.localhost drive paths from either encoded form", () => {
		const expected =
			"http://asset.localhost/C%3A%5CUsers%5CLuke%5C.naia%5Capps%5Cland.naia.slides%5Cassets%5Cpdf.worker.min-hash.mjs";
		for (const pathname of [
			"/C%3A%5CUsers%5CLuke%5C.naia%5Capps%5Cland.naia.slides%5Cindex.html",
			"/%2FC%3A%5CUsers%5CLuke%5C.naia%5Capps%5Cland.naia.slides%5Cindex.html",
		]) {
			expect(
				resolveSlidesPdfWorkerUrl("/assets/pdf.worker.min-hash.mjs", {
					protocol: "http:",
					host: "asset.localhost",
					pathname,
				}),
			).toBe(expected);
		}
	});

	beforeEach(async () => {
		picker.available = false;
		picker.open.mockReset();
		await setLocale("ko");
		mediaPlayback.play.mockReset().mockResolvedValue(undefined);
		mediaPlayback.pause.mockReset();
		mediaPlayback.load.mockReset();
		Object.defineProperty(HTMLMediaElement.prototype, "play", {
			configurable: true,
			value: mediaPlayback.play,
		});
		Object.defineProperty(HTMLMediaElement.prototype, "pause", {
			configurable: true,
			value: mediaPlayback.pause,
		});
		Object.defineProperty(HTMLMediaElement.prototype, "load", {
			configurable: true,
			value: mediaPlayback.load,
		});
		objectUrlId = 0;
		Object.defineProperty(URL, "createObjectURL", {
			configurable: true,
			value: () => `blob:slides-test/${++objectUrlId}`,
		});
		Object.defineProperty(URL, "revokeObjectURL", {
			configurable: true,
			value: vi.fn(),
		});
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
		for (const [key, descriptor] of [
			["play", originalMediaPlay],
			["pause", originalMediaPause],
			["load", originalMediaLoad],
		] as const) {
			if (descriptor)
				Object.defineProperty(HTMLMediaElement.prototype, key, descriptor);
			else Reflect.deleteProperty(HTMLMediaElement.prototype, key);
		}
		for (const [key, descriptor] of [
			["createObjectURL", originalCreateObjectURL],
			["revokeObjectURL", originalRevokeObjectURL],
		] as const) {
			if (descriptor) Object.defineProperty(URL, key, descriptor);
			else Reflect.deleteProperty(URL, key);
		}
		Reflect.deleteProperty(document, "fullscreenElement");
		Reflect.deleteProperty(document, "exitFullscreen");
	});

	it("closes and restores notes without interrupting presentation or discarding the script", async () => {
		picker.available = true;
		picker.open.mockResolvedValue({
			file: new File(["pdf"], "deck.pdf"),
			script: { name: "deck.md", text: "## 1. Cover\nKeep this narration" },
			scriptReadFailed: false,
		});
		const bridge = new MockBridge();
		render(<SlidesCenterArea naia={bridge} />);
		fireEvent.click(screen.getByLabelText(/PDF/));
		await waitFor(() =>
			expect(screen.getByTestId("slides-current-note")).toHaveTextContent(
				"Keep this narration",
			),
		);
		fireEvent.click(screen.getByRole("button", { name: "발표 시작" }));
		fireEvent.click(screen.getByRole("button", { name: "발표문 닫기" }));
		expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "일시정지" }),
		).toBeInTheDocument();
		const open = screen.getByRole("button", { name: "발표문 열기" });
		expect(open).toHaveAttribute("aria-expanded", "false");
		fireEvent.click(open);
		expect(screen.getByTestId("slides-current-note")).toHaveTextContent(
			"Keep this narration",
		);
		expect(
			JSON.parse(
				await bridge.callTool("skill_slide_presenter", {
					action: "get_context",
				}),
			).currentSpeakerNote,
		).toBe("Keep this narration");
	});

	it("enters fullscreen on the entire app, retains controls and tracks exit", async () => {
		render(<SlidesCenterArea naia={new MockBridge()} />);
		expect(screen.getByRole("button", { name: "전체 화면" })).toBeDisabled();
		fireEvent.change(screen.getByLabelText(/PDF/), {
			target: { files: [new File(["pdf"], "deck.pdf")] },
		});
		await waitFor(() =>
			expect(screen.getByTestId("pdf-page-1")).toBeInTheDocument(),
		);
		const app = screen.getByRole("region", { name: "슬라이드 발표" });
		const enter = vi.fn(async () => {
			Object.defineProperty(document, "fullscreenElement", {
				configurable: true,
				value: app,
			});
			document.dispatchEvent(new Event("fullscreenchange"));
		});
		Object.defineProperty(app, "requestFullscreen", { value: enter });
		const exit = vi.fn(async () => {
			Object.defineProperty(document, "fullscreenElement", {
				configurable: true,
				value: null,
			});
			document.dispatchEvent(new Event("fullscreenchange"));
		});
		Object.defineProperty(document, "exitFullscreen", {
			configurable: true,
			value: exit,
		});
		fireEvent.click(screen.getByRole("button", { name: "전체 화면" }));
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "전체 화면 종료" }),
			).toHaveAttribute("aria-pressed", "true"),
		);
		expect(enter).toHaveBeenCalledOnce();
		expect(
			app.contains(screen.getByRole("button", { name: "발표 종료" })),
		).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "전체 화면 종료" }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "전체 화면" })).toHaveAttribute(
				"aria-pressed",
				"false",
			),
		);
		expect(exit).toHaveBeenCalledOnce();
	});

	it("reports fullscreen rejection while leaving presentation usable", async () => {
		render(<SlidesCenterArea naia={new MockBridge()} />);
		fireEvent.change(screen.getByLabelText(/PDF/), {
			target: { files: [new File(["pdf"], "deck.pdf")] },
		});
		await waitFor(() =>
			expect(screen.getByTestId("pdf-page-1")).toBeInTheDocument(),
		);
		Object.defineProperty(
			screen.getByRole("region", { name: "슬라이드 발표" }),
			"requestFullscreen",
			{ value: vi.fn().mockRejectedValue(new Error("policy denied")) },
		);
		fireEvent.click(screen.getByRole("button", { name: "전체 화면" }));
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent(
				"전체 화면을 열지 못했습니다",
			),
		);
		expect(screen.getByRole("button", { name: "발표 시작" })).toBeEnabled();
	});

	it("auto-loads a companion, preserves it on cancel, and clears it for a different PDF", async () => {
		picker.available = true;
		picker.open.mockResolvedValueOnce({
			file: new File(["pdf"], "deck.pdf"),
			script: { name: "deck.md", text: "## 1. Cover\nAutomatic note" },
			scriptReadFailed: false,
		});
		render(<SlidesCenterArea naia={new MockBridge()} />);
		fireEvent.click(screen.getByLabelText(/PDF/));
		await waitFor(() =>
			expect(screen.getByTestId("slides-current-note")).toHaveTextContent(
				"Automatic note",
			),
		);
		expect(screen.getByText("deck.md")).toBeInTheDocument();
		picker.open.mockResolvedValueOnce(null);
		fireEvent.click(screen.getByLabelText(/PDF/));
		await waitFor(() => expect(screen.getByLabelText(/PDF/)).toBeEnabled());
		expect(screen.getByTestId("slides-current-note")).toHaveTextContent(
			"Automatic note",
		);
		picker.open.mockResolvedValueOnce({
			file: new File(["pdf2"], "second.pdf"),
			script: null,
			scriptReadFailed: false,
		});
		fireEvent.click(screen.getByLabelText(/PDF/));
		await waitFor(() =>
			expect(screen.getByTestId("slides-current-note")).toHaveTextContent(
				"PDF text 1",
			),
		);
		expect(screen.queryByText("deck.md")).not.toBeInTheDocument();
	});

	it("keeps PDF and manual script input usable when the sidecar cannot be read", async () => {
		picker.available = true;
		picker.open.mockResolvedValue({
			file: new File(["pdf"], "deck.pdf"),
			script: null,
			scriptReadFailed: true,
		});
		render(<SlidesCenterArea naia={new MockBridge()} />);
		fireEvent.click(screen.getByLabelText(/PDF/));
		await waitFor(() =>
			expect(screen.getByTestId("pdf-page-1")).toBeInTheDocument(),
		);
		expect(screen.getByRole("alert")).toHaveTextContent(
			"자동 대본을 읽지 못했습니다",
		);
		expect(screen.getByLabelText("발표 스크립트")).toBeEnabled();
	});

	it("ignores an old script read after a different PDF is selected", async () => {
		render(<SlidesCenterArea naia={new MockBridge()} />);
		const selectPdf = (name: string) =>
			fireEvent.change(screen.getByLabelText(/PDF/), {
				target: { files: [new File(["pdf"], name)] },
			});
		selectPdf("first.pdf");
		await waitFor(() =>
			expect(screen.getByTestId("pdf-page-1")).toBeInTheDocument(),
		);
		let resolve!: (text: string) => void;
		const script = new File(["note"], "old.md");
		Object.defineProperty(script, "text", {
			value: () =>
				new Promise<string>((r) => {
					resolve = r;
				}),
		});
		fireEvent.change(screen.getByLabelText("발표 스크립트"), {
			target: { files: [script] },
		});
		selectPdf("second.pdf");
		resolve("## 1. Cover\nStale note");
		await waitFor(() =>
			expect(screen.getByTestId("slides-current-note")).toHaveTextContent(
				"PDF text 1",
			),
		);
		expect(screen.queryByText("old.md")).not.toBeInTheDocument();
	});

	it("exposes a repeat toggle and loops only after the final narration", async () => {
		const requests: SlidePresenterSpeechRequest[] = [];
		const listener = (event: Event) =>
			requests.push((event as CustomEvent<SlidePresenterSpeechRequest>).detail);
		window.addEventListener(SLIDE_PRESENTER_SPEAK_EVENT, listener);
		try {
			render(<SlidesCenterArea naia={new MockBridge()} />);
			const repeat = screen.getByRole("button", { name: "반복 재생" });
			expect(repeat).toBeDisabled();
			expect(repeat).toHaveAttribute("aria-pressed", "false");
			fireEvent.change(screen.getByLabelText(/PDF/), {
				target: { files: [new File(["pdf"], "deck.pdf")] },
			});
			await waitFor(() => expect(repeat).toBeEnabled());
			fireEvent.click(repeat);
			expect(repeat).toHaveAttribute("aria-pressed", "true");
			fireEvent.click(screen.getByRole("button", { name: "발표 시작" }));
			for (let i = 0; i < 3; i++) {
				await waitFor(() => expect(requests).toHaveLength(i + 1));
				window.dispatchEvent(
					new CustomEvent(SLIDE_PRESENTER_SPEECH_RESULT_EVENT, {
						detail: { ...requests[i], status: "finished" },
					}),
				);
			}
			await waitFor(() => expect(requests).toHaveLength(4));
			expect(requests.map((request) => request.page)).toEqual([1, 2, 3, 1]);
			fireEvent.click(screen.getByRole("button", { name: "발표 종료" }));
			window.dispatchEvent(
				new CustomEvent(SLIDE_PRESENTER_SPEECH_RESULT_EVENT, {
					detail: { ...requests[3], status: "finished" },
				}),
			);
			await waitFor(() =>
				expect(
					screen.getByRole("button", { name: "발표 시작" }),
				).toBeInTheDocument(),
			);
			expect(requests).toHaveLength(4);
		} finally {
			window.removeEventListener(SLIDE_PRESENTER_SPEAK_EVENT, listener);
		}
	});

	it("initializes range from the script, accepts edits and resets it for another PDF", async () => {
		picker.available = true;
		picker.open.mockResolvedValueOnce({
			file: new File(["pdf"], "deck.pdf"),
			script: {
				name: "deck.md",
				text: "## 01. Main\nFirst\n## 02. Closing\nLast",
			},
			scriptReadFailed: false,
		});
		render(<SlidesCenterArea naia={new MockBridge()} />);
		fireEvent.click(screen.getByLabelText(/PDF/));
		await waitFor(() =>
			expect(screen.getByLabelText("발표 종료 페이지")).toHaveValue(2),
		);
		expect(screen.getByLabelText("발표 시작 페이지")).toHaveValue(1);
		fireEvent.change(screen.getByLabelText("발표 시작 페이지"), {
			target: { value: "2" },
		});
		expect(screen.getByLabelText("발표 시작 페이지")).toHaveValue(2);
		picker.open.mockResolvedValueOnce({
			file: new File(["pdf"], "other.pdf"),
			script: null,
			scriptReadFailed: false,
		});
		fireEvent.click(screen.getByLabelText(/PDF/));
		await waitFor(() =>
			expect(screen.getByLabelText("발표 종료 페이지")).toHaveValue(3),
		);
		expect(screen.getByLabelText("발표 시작 페이지")).toHaveValue(1);
	});

	it("loads a PDF and script, requests narration, then advances once", async () => {
		const bridge = new MockBridge();
		const requests: SlidePresenterSpeechRequest[] = [];
		window.addEventListener(SLIDE_PRESENTER_SPEAK_EVENT, (event) => {
			requests.push((event as CustomEvent<SlidePresenterSpeechRequest>).detail);
		});
		render(<SlidesCenterArea naia={bridge} />);

		const pdf = new File(["pdf"], "deck.pdf", { type: "application/pdf" });
		fireEvent.change(screen.getByLabelText(/PDF/), {
			target: { files: [pdf] },
		});
		await waitFor(() => expect(screen.getByText("1 / 3")).toBeInTheDocument());

		const script = new File(["placeholder"], "speaker.md", {
			type: "text/markdown",
		});
		Object.defineProperty(script, "text", {
			value: async () =>
				"## 1. Cover\n\nFirst narration.\n\n## 2. Next\n\nSecond narration.",
		});
		fireEvent.change(screen.getByLabelText("발표 스크립트"), {
			target: { files: [script] },
		});
		await waitFor(() =>
			expect(screen.getByText("First narration.")).toBeInTheDocument(),
		);

		fireEvent.click(screen.getByRole("button", { name: "발표 시작" }));
		await waitFor(() => expect(requests).toHaveLength(1));
		expect(requests[0]).toMatchObject({
			page: 1,
			text: "First narration.",
			nextPrefetch: {
				page: 2,
				text: "Second narration.",
				id: expect.stringMatching(/^slides-prefetch-/),
			},
		});

		window.dispatchEvent(
			new CustomEvent(SLIDE_PRESENTER_SPEECH_RESULT_EVENT, {
				detail: { ...requests[0], status: "finished" },
			}),
		);
		await waitFor(() => expect(screen.getByText("2 / 3")).toBeInTheDocument());
		await waitFor(() => expect(requests).toHaveLength(2));
		expect(requests[1]).toMatchObject({
			page: 2,
			text: "Second narration.",
			prefetchId: requests[0].nextPrefetch?.id,
		});
	});

	it("cancels only the following-page prefetch when repeat changes, then invalidates on pause", async () => {
		const requests: SlidePresenterSpeechRequest[] = [];
		const cancellations: Array<{
			requestId?: string;
			generation?: number;
			prefetchId?: string;
			invalidateGeneration?: boolean;
		}> = [];
		const onSpeak = (event: Event) =>
			requests.push((event as CustomEvent<SlidePresenterSpeechRequest>).detail);
		const onCancel = (event: Event) =>
			cancellations.push(
				(event as CustomEvent<(typeof cancellations)[number]>).detail,
			);
		window.addEventListener(SLIDE_PRESENTER_SPEAK_EVENT, onSpeak);
		window.addEventListener(SLIDE_PRESENTER_CANCEL_EVENT, onCancel);
		try {
			render(<SlidesCenterArea naia={new MockBridge()} />);
			fireEvent.change(screen.getByLabelText(/PDF/), {
				target: { files: [new File(["pdf"], "deck.pdf")] },
			});
			await waitFor(() =>
				expect(screen.getByText("1 / 3")).toBeInTheDocument(),
			);
			fireEvent.click(screen.getByRole("button", { name: "발표 시작" }));
			await waitFor(() => expect(requests).toHaveLength(1));
			const nextPrefetchId = requests[0].nextPrefetch?.id;
			expect(nextPrefetchId).toBeTruthy();

			fireEvent.click(screen.getByRole("button", { name: "반복 재생" }));
			expect(cancellations.at(-1)).toMatchObject({
				prefetchId: nextPrefetchId,
				invalidateGeneration: false,
			});
			expect(cancellations.at(-1)?.requestId).toBeUndefined();
			expect(
				screen.getByRole("button", { name: "일시정지" }),
			).toBeInTheDocument();

			fireEvent.click(screen.getByRole("button", { name: "일시정지" }));
			expect(cancellations.at(-1)).toMatchObject({
				requestId: requests[0].requestId,
				generation: requests[0].generation,
				invalidateGeneration: true,
			});
		} finally {
			window.removeEventListener(SLIDE_PRESENTER_SPEAK_EVENT, onSpeak);
			window.removeEventListener(SLIDE_PRESENTER_CANCEL_EVENT, onCancel);
		}
	});

	it("plays an authored video without narration and requests the next page as soon as it ends", async () => {
		picker.available = true;
		picker.open.mockResolvedValue({
			file: new File(["pdf"], "deck.pdf", { type: "application/pdf" }),
			script: {
				name: "deck.md",
				text: "## 1. Cover\nIntroduce the demo.\n## 1-1. [영상] demo.mp4\nNever narrate this paragraph.\n## 2. Next\nContinue the talk.",
			},
			scriptReadFailed: false,
			videos: [
				{
					name: "demo.mp4",
					file: new File(["video"], "demo.mp4", { type: "video/mp4" }),
				},
			],
			videoReadFailures: [],
		});
		const requests: SlidePresenterSpeechRequest[] = [];
		const onSpeak = (event: Event) =>
			requests.push((event as CustomEvent<SlidePresenterSpeechRequest>).detail);
		window.addEventListener(SLIDE_PRESENTER_SPEAK_EVENT, onSpeak);
		const srcDescriptor = Object.getOwnPropertyDescriptor(
			HTMLMediaElement.prototype,
			"src",
		);
		const setAttributeDescriptor = Object.getOwnPropertyDescriptor(
			Element.prototype,
			"setAttribute",
		);
		const setAttributeNsDescriptor = Object.getOwnPropertyDescriptor(
			Element.prototype,
			"setAttributeNS",
		);
		const srcWrites: HTMLVideoElement[] = [];
		const recordSrc = (element: Element, name: string) => {
			if (element instanceof HTMLVideoElement && name.toLowerCase() === "src")
				srcWrites.push(element);
		};
		if (srcDescriptor?.set)
			Object.defineProperty(HTMLMediaElement.prototype, "src", {
				...srcDescriptor,
				set(this: HTMLMediaElement, value: string) {
					if (this instanceof HTMLVideoElement) srcWrites.push(this);
					srcDescriptor.set?.call(this, value);
				},
			});
		if (setAttributeDescriptor?.value)
			Object.defineProperty(Element.prototype, "setAttribute", {
				...setAttributeDescriptor,
				value: function (this: Element, name: string, value: string) {
					recordSrc(this, name);
					return setAttributeDescriptor.value.call(this, name, value);
				},
			});
		if (setAttributeNsDescriptor?.value)
			Object.defineProperty(Element.prototype, "setAttributeNS", {
				...setAttributeNsDescriptor,
				value: function (
					this: Element,
					namespace: string | null,
					name: string,
					value: string,
				) {
					recordSrc(this, name);
					return setAttributeNsDescriptor.value.call(
						this,
						namespace,
						name,
						value,
					);
				},
			});
		try {
			render(<SlidesCenterArea naia={new MockBridge()} />);
			fireEvent.click(screen.getByLabelText(/PDF/));
			await waitFor(() =>
				expect(screen.getByTestId("slides-current-note")).toHaveTextContent(
					"Introduce the demo.",
				),
			);
			expect(Logger.debug).toHaveBeenCalledWith(
				"SlidesCenterArea",
				"demo video directives resolved",
				expect.objectContaining({
					loadedFileCount: 1,
					directives: expect.arrayContaining([
						expect.objectContaining({ fileName: "demo.mp4", available: true }),
					]),
				}),
			);
			fireEvent.click(screen.getByRole("button", { name: "발표 시작" }));
			await waitFor(() => expect(requests).toHaveLength(1));
			expect(requests[0].nextPrefetch).toMatchObject({
				page: 2,
				text: "Continue the talk.",
			});
			window.dispatchEvent(
				new CustomEvent(SLIDE_PRESENTER_SPEECH_RESULT_EVENT, {
					detail: { ...requests[0], status: "finished" },
				}),
			);
			await waitFor(() =>
				expect(screen.getByTestId("slides-video-viewer")).not.toHaveAttribute(
					"hidden",
				),
			);
			expect(Logger.info).toHaveBeenCalledWith(
				"SlidesCenterArea",
				"demo video playback started",
				expect.objectContaining({
					fileName: "demo.mp4",
					volume: 1,
					muted: false,
				}),
			);
			const video = screen.getByTestId(
				"slides-video-demo.mp4",
			) as HTMLVideoElement;
			expect(screen.getByTestId("slides-video-indicator")).toHaveTextContent(
				"1-1 / 영상",
			);
			expect(screen.getByTestId("slides-viewer")).toHaveAttribute("hidden");
			expect(video.volume).toBe(1);
			expect(video.muted).toBe(false);
			expect(video).toHaveClass("slides-app__video--active");
			expect(mediaPlayback.play).toHaveBeenCalledTimes(1);
			expect(requests).toHaveLength(1);
			fireEvent.ended(video);
			await waitFor(() => expect(requests).toHaveLength(2));
			expect(requests[1]).toMatchObject({
				page: 2,
				text: "Continue the talk.",
			});
			expect(screen.getByTestId("slides-video-demo.mp4")).toBe(video);
			expect(srcWrites.filter((element) => element === video)).toHaveLength(1);
			expect(mediaPlayback.load).not.toHaveBeenCalled();
		} finally {
			if (srcDescriptor)
				Object.defineProperty(HTMLMediaElement.prototype, "src", srcDescriptor);
			if (setAttributeDescriptor)
				Object.defineProperty(
					Element.prototype,
					"setAttribute",
					setAttributeDescriptor,
				);
			if (setAttributeNsDescriptor)
				Object.defineProperty(
					Element.prototype,
					"setAttributeNS",
					setAttributeNsDescriptor,
				);
			window.removeEventListener(SLIDE_PRESENTER_SPEAK_EVENT, onSpeak);
		}
	});

	it("announces missing videos and continues without pausing the presentation", async () => {
		picker.available = true;
		picker.open.mockResolvedValue({
			file: new File(["pdf"], "deck.pdf", { type: "application/pdf" }),
			script: {
				name: "deck.md",
				text: "## 1. Cover\nIntro.\n## 1-1. [video] missing.mp4\nSkipped body.\n## 2. Next\nContinue.",
			},
			scriptReadFailed: false,
			videos: [],
			videoReadFailures: ["missing.mp4"],
		});
		const requests: SlidePresenterSpeechRequest[] = [];
		window.addEventListener(SLIDE_PRESENTER_SPEAK_EVENT, (event) =>
			requests.push((event as CustomEvent<SlidePresenterSpeechRequest>).detail),
		);
		render(<SlidesCenterArea naia={new MockBridge()} />);
		fireEvent.click(screen.getByLabelText(/PDF/));
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent("missing.mp4"),
		);
		fireEvent.click(screen.getByRole("button", { name: "발표 시작" }));
		await waitFor(() => expect(requests).toHaveLength(1));
		window.dispatchEvent(
			new CustomEvent(SLIDE_PRESENTER_SPEECH_RESULT_EVENT, {
				detail: { ...requests[0], status: "finished" },
			}),
		);
		await waitFor(() => expect(requests).toHaveLength(2));
		expect(requests[1]).toMatchObject({ page: 2, text: "Continue." });
		expect(screen.getByTestId("slides-video-viewer")).toHaveAttribute("hidden");
	});

	it("skips a video when play is rejected", async () => {
		picker.available = true;
		mediaPlayback.play.mockRejectedValueOnce(new Error("blocked"));
		picker.open.mockResolvedValue({
			file: new File(["pdf"], "deck.pdf", { type: "application/pdf" }),
			script: {
				name: "deck.md",
				text: "## 1. Cover\nIntro.\n## 1-1. [video] blocked.mp4\nSkipped body.\n## 2. Next\nContinue.",
			},
			scriptReadFailed: false,
			videos: [
				{
					name: "blocked.mp4",
					file: new File(["video"], "blocked.mp4", { type: "video/mp4" }),
				},
			],
			videoReadFailures: [],
		});
		const requests: SlidePresenterSpeechRequest[] = [];
		window.addEventListener(SLIDE_PRESENTER_SPEAK_EVENT, (event) =>
			requests.push((event as CustomEvent<SlidePresenterSpeechRequest>).detail),
		);
		render(<SlidesCenterArea naia={new MockBridge()} />);
		fireEvent.click(screen.getByLabelText(/PDF/));
		await waitFor(() =>
			expect(screen.getByTestId("slides-current-note")).toHaveTextContent(
				"Intro.",
			),
		);
		fireEvent.click(screen.getByRole("button", { name: "발표 시작" }));
		await waitFor(() => expect(requests).toHaveLength(1));
		window.dispatchEvent(
			new CustomEvent(SLIDE_PRESENTER_SPEECH_RESULT_EVENT, {
				detail: { ...requests[0], status: "finished" },
			}),
		);
		await waitFor(() => expect(requests).toHaveLength(2));
		expect(requests[1]).toMatchObject({ page: 2, text: "Continue." });
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent("blocked.mp4"),
		);
	});

	it("pauses through the Naia tool and publishes bounded deck context", async () => {
		const bridge = new MockBridge();
		render(<SlidesCenterArea naia={bridge} />);
		const pdf = new File(["pdf"], "deck.pdf", { type: "application/pdf" });
		fireEvent.change(screen.getByLabelText(/PDF/), {
			target: { files: [pdf] },
		});
		await waitFor(() =>
			expect(bridge.handlers.has("skill_slide_presenter")).toBe(true),
		);
		await waitFor(() => expect(screen.getByText("1 / 3")).toBeInTheDocument());

		await bridge.callTool("skill_slide_presenter", { action: "start" });
		await bridge.callTool("skill_slide_presenter", { action: "question" });
		await waitFor(() =>
			expect(screen.getByText("질문 답변")).toBeInTheDocument(),
		);

		const context = JSON.parse(
			await bridge.callTool("skill_slide_presenter", { action: "get_context" }),
		) as { page: number; totalPages: number; deckContext: string };
		expect(context).toMatchObject({ page: 1, totalPages: 3 });
		expect(context.deckContext).toContain("PDF text 1");
		await waitFor(() =>
			expect(bridge.contexts.at(-1)?.data.state).toBe("answering"),
		);
	});

	it("pauses when the deferred narration consumer cancels an active request", async () => {
		const bridge = new MockBridge();
		const requests: SlidePresenterSpeechRequest[] = [];
		window.addEventListener(SLIDE_PRESENTER_SPEAK_EVENT, (event) => {
			requests.push((event as CustomEvent<SlidePresenterSpeechRequest>).detail);
		});
		render(<SlidesCenterArea naia={bridge} />);
		fireEvent.change(screen.getByLabelText(/PDF/), {
			target: {
				files: [new File(["pdf"], "deck.pdf", { type: "application/pdf" })],
			},
		});
		await waitFor(() => expect(screen.getByText("1 / 3")).toBeInTheDocument());
		fireEvent.click(screen.getByRole("button", { name: "발표 시작" }));
		await waitFor(() => expect(requests).toHaveLength(1));

		window.dispatchEvent(
			new CustomEvent(SLIDE_PRESENTER_SPEECH_RESULT_EVENT, {
				detail: { ...requests[0], status: "cancelled" },
			}),
		);
		await waitFor(() =>
			expect(screen.getByText("일시정지")).toBeInTheDocument(),
		);
	});
});
