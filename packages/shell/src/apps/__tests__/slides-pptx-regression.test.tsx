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
import {
	PPTX_MIME_TYPE,
	buildPptxPresentation,
	parsePptxPresentation,
	validatePptxBytes,
} from "../../lib/pptx-ooxml";

vi.mock("../../lib/logger", () => ({
	Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../lib/config", () => ({ addAllowedTool: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(),
	convertFileSrc: (path: string) =>
		`asset://localhost/${encodeURIComponent(path)}`,
}));

const picker = vi.hoisted(() => ({ available: false, open: vi.fn() }));
vi.mock("../../lib/slides-files", async () => {
	const actual = await vi.importActual<typeof import("../../lib/slides-files")>(
		"../../lib/slides-files",
	);
	return {
		...actual,
		openSlidesDocument: picker.open,
		openSlidesPdf: picker.open,
		watchSlidesPickerAvailable: (callback: (available: boolean) => void) => {
			callback(picker.available);
			return () => {};
		},
	};
});

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
						numPages: 2,
						getPage: async (page) => ({
							getTextContent: async () => ({
								items: [
									{ str: `PDF Slide ${page}`, hasEOL: true },
									{ str: `Key point ${page}` },
								],
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

import { SlidesCenterArea } from "../slides/SlidesCenterArea";

class TestSlidesBridge implements NaiaContextBridge {
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

async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
	if (typeof blob.arrayBuffer === "function") {
		return new Uint8Array(await blob.arrayBuffer());
	}
	return new Uint8Array(await new Response(blob).arrayBuffer());
}

describe("Slides PPTX browser import/export & drift-prevention regressions", () => {
	let capturedBlobs: Blob[] = [];
	let capturedDownloads: string[] = [];

	beforeEach(async () => {
		picker.available = false;
		picker.open.mockReset();
		capturedBlobs = [];
		capturedDownloads = [];
		await setLocale("ko");
		globalThis.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as typeof ResizeObserver;

		vi.spyOn(URL, "createObjectURL").mockImplementation((obj: Blob | MediaSource) => {
			if (obj instanceof Blob) capturedBlobs.push(obj);
			return `blob:naia-test/${capturedBlobs.length}`;
		});
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
			this: HTMLAnchorElement,
		) {
			capturedDownloads.push(this.download);
		});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("always exposes both PDF and PPTX in browser mode without hiding PPTX behind native picker", () => {
		render(<SlidesCenterArea naia={new TestSlidesBridge()} />);
		const input = screen.getByLabelText("PDF 또는 PPTX 열기") as HTMLInputElement;
		expect(input).toBeInTheDocument();
		expect(input.accept).toContain(".pdf");
		expect(input.accept).toContain(".pptx");
		expect(input.accept).toContain(PPTX_MIME_TYPE);
		expect(screen.getByText("PDF와 PPTX를 지원합니다.")).toBeInTheDocument();
		expect(screen.getByTestId("slides-export-pptx")).toBeDisabled();
	});

	it("opens a .pptx file directly in the browser, renders slides & notes, edits notes, and exports a valid updated .pptx", async () => {
		const bridge = new TestSlidesBridge();
		render(<SlidesCenterArea naia={bridge} />);

		const sourceBytes = buildPptxPresentation({
			title: "웹 스토어 발표",
			slides: [
				{
					title: "1장: 문제 진단",
					subtitle: "왜 PPTX가 빠졌는가",
					bullets: ["스토어 번들 드리프트", "브라우저 입력 제한 해제"],
					notes: "첫 번째 슬라이드 원래 발표문입니다.",
				},
				{
					title: "2장: 해결 방안",
					bullets: ["순수 브라우저 OOXML 파서·빌더", "자동 회귀 검증"],
					notes: "두 번째 슬라이드 원래 발표문입니다.",
				},
			],
		});
		const pptxFile = new File(
			[sourceBytes as unknown as BlobPart],
			"roadmap-2026.pptx",
			{ type: PPTX_MIME_TYPE },
		);

		fireEvent.change(screen.getByLabelText("PDF 또는 PPTX 열기"), {
			target: { files: [pptxFile] },
		});

		await waitFor(() =>
			expect(screen.getByTestId("pptx-slide-1")).toBeInTheDocument(),
		);
		expect(screen.getByText("1장: 문제 진단")).toBeInTheDocument();
		expect(screen.getByText("왜 PPTX가 빠졌는가")).toBeInTheDocument();
		expect(screen.getByText("스토어 번들 드리프트")).toBeInTheDocument();
		expect(screen.getByTestId("slides-current-note")).toHaveTextContent(
			"첫 번째 슬라이드 원래 발표문입니다.",
		);
		expect(bridge.contexts.at(-1)?.data.format).toBe("pptx");

		// Navigate to slide 2 and edit speaker note
		fireEvent.click(screen.getByRole("button", { name: "다음 슬라이드" }));
		await waitFor(() =>
			expect(screen.getByTestId("pptx-slide-2")).toBeInTheDocument(),
		);
		expect(screen.getByTestId("slides-current-note")).toHaveTextContent(
			"두 번째 슬라이드 원래 발표문입니다.",
		);

		fireEvent.click(screen.getByTestId("slides-edit-script"));
		fireEvent.change(screen.getByTestId("slides-script-editor"), {
			target: { value: "두 번째 슬라이드 편집 완료 발표문!" },
		});
		fireEvent.click(screen.getByTestId("slides-apply-script"));
		expect(screen.getByTestId("slides-current-note")).toHaveTextContent(
			"두 번째 슬라이드 편집 완료 발표문!",
		);

		// Export updated .pptx and validate binary OOXML integrity + round-trip
		const exportBtn = screen.getByTestId("slides-export-pptx");
		expect(exportBtn).toBeEnabled();
		fireEvent.click(exportBtn);

		expect(capturedDownloads).toContain("roadmap-2026.pptx");
		expect(capturedBlobs).toHaveLength(1);
		const exportedBytes = await blobToUint8Array(capturedBlobs[0]);
		const validation = await validatePptxBytes(exportedBytes);
		expect(validation.valid).toBe(true);
		expect(validation.slideCount).toBe(2);
		expect(validation.notesCount).toBe(2);

		const reparsed = await parsePptxPresentation(exportedBytes);
		expect(reparsed.slides[0].title).toBe("1장: 문제 진단");
		expect(reparsed.speakerNotes.get(1)).toBe(
			"첫 번째 슬라이드 원래 발표문입니다.",
		);
		expect(reparsed.slides[1].title).toBe("2장: 해결 방안");
		expect(reparsed.speakerNotes.get(2)).toBe(
			"두 번째 슬라이드 편집 완료 발표문!",
		);
	});

	it("exports a loaded PDF + speaker script into a valid .pptx presentation", async () => {
		render(<SlidesCenterArea naia={new TestSlidesBridge()} />);
		fireEvent.change(screen.getByLabelText("PDF 또는 PPTX 열기"), {
			target: {
				files: [new File(["%PDF-1.4"], "briefing.pdf", { type: "application/pdf" })],
			},
		});
		await waitFor(() =>
			expect(screen.getByTestId("pdf-page-1")).toBeInTheDocument(),
		);

		const mdScript = new File(["placeholder"], "briefing.md", {
			type: "text/markdown",
		});
		Object.defineProperty(mdScript, "text", {
			value: async () => "## 1\n첫 장 음성 안내\n\n## 2\n둘째 장 음성 안내",
		});
		fireEvent.change(screen.getByLabelText("발표 스크립트"), {
			target: { files: [mdScript] },
		});
		await waitFor(() =>
			expect(screen.getByTestId("slides-current-note")).toHaveTextContent(
				"첫 장 음성 안내",
			),
		);

		fireEvent.click(screen.getByTestId("slides-export-pptx"));
		expect(capturedDownloads).toEqual(["briefing.pptx"]);
		const exportedBytes = await blobToUint8Array(capturedBlobs[0]);
		const validation = await validatePptxBytes(exportedBytes);
		expect(validation.valid).toBe(true);
		expect(validation.slideCount).toBe(2);
		const reparsed = await parsePptxPresentation(exportedBytes);
		expect(reparsed.slides[0].title).toBe("PDF Slide 1");
		expect(reparsed.speakerNotes.get(1)).toBe("첫 장 음성 안내");
		expect(reparsed.speakerNotes.get(2)).toBe("둘째 장 음성 안내");
	});

	it("supports skill_slide_presenter create_deck and export_pptx actions and preserves deck on corrupt .pptx", async () => {
		const bridge = new TestSlidesBridge();
		render(<SlidesCenterArea naia={bridge} />);
		await waitFor(() =>
			expect(bridge.handlers.has("skill_slide_presenter")).toBe(true),
		);

		const created = JSON.parse(
			await bridge.callTool("skill_slide_presenter", {
				action: "create_deck",
				title: "나이아 실시간 발표",
				slides: [
					{
						title: "실시간 생성 1장",
						bullets: ["핵심 요약 A", "핵심 요약 B"],
						notes: "나이아가 직접 만든 첫 장 발표문",
					},
					{
						title: "실시간 생성 2장",
						bullets: ["결론"],
						notes: "나이아가 직접 만든 둘째 장 발표문",
					},
				],
			}),
		);
		expect(created).toMatchObject({
			ok: true,
			fileName: "나이아 실시간 발표.pptx",
			totalPages: 2,
		});
		await waitFor(() =>
			expect(screen.getByTestId("pptx-slide-1")).toBeInTheDocument(),
		);
		expect(screen.getByText("실시간 생성 1장")).toBeInTheDocument();

		const exported = JSON.parse(
			await bridge.callTool("skill_slide_presenter", {
				action: "export_pptx",
			}),
		);
		expect(exported).toMatchObject({
			ok: true,
			exported: "나이아 실시간 발표.pptx",
			totalPages: 2,
		});
		expect(capturedBlobs).toHaveLength(1);

		// Opening a corrupt .pptx shows invalidPptx alert while preserving the active deck
		const corruptFile = new File(["corrupt-bytes"], "corrupt.pptx", {
			type: PPTX_MIME_TYPE,
		});
		fireEvent.change(screen.getByLabelText("PDF 또는 PPTX 열기"), {
			target: { files: [corruptFile] },
		});
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent(
				"이 PPTX를 읽을 수 없거나 지원되지 않습니다",
			),
		);
		expect(screen.getByText("실시간 생성 1장")).toBeInTheDocument();
	});
});
