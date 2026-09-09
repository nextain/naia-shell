// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AppContext,
	BehaviorEntry,
	NaiaContextBridge,
	ShellResult,
	ToolHandler,
} from "../../lib/app-registry";
import { setLocale } from "../../lib/i18n";
import { startSlidesRecording, stopSlidesRecording } from "../../lib/slides-host";

vi.mock("../../lib/logger", () => ({
	Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../lib/config", () => ({ addAllowedTool: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../lib/slides-host", () => ({
	startSlidesRecording: vi.fn(),
	stopSlidesRecording: vi.fn(),
}));

const picker = vi.hoisted(() => ({ available: false, open: vi.fn() }));
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
							getTextContent: async () => ({ items: [{ str: `PDF text ${page}` }] }),
						}),
					}),
				0,
			);
			return () => clearTimeout(timer);
		}, [file]);
		return <div data-testid="pdf-document">{children}</div>;
	}
	function Page({ pageNumber }: { pageNumber: number }) {
		return <div data-testid={`pdf-page-${pageNumber}`}>PDF page {pageNumber}</div>;
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

class EditorBridge implements NaiaContextBridge {
	contexts: AppContext[] = [];
	handlers = new Map<string, ToolHandler>();
	pushContext(context: AppContext) {
		this.contexts.push(context);
	}
	onToolCall(name: string, handler: ToolHandler) {
		this.handlers.set(name, handler);
		return () => this.handlers.delete(name);
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

function openPdf(name = "deck.pdf") {
	fireEvent.change(screen.getByLabelText("Open PDF"), {
		target: { files: [new File(["pdf"], name, { type: "application/pdf" })] },
	});
}

async function waitForDeck() {
	await waitFor(() => expect(screen.getByTestId("pdf-page-1")).toBeInTheDocument());
}

describe("Slides script editor", () => {
	it("retains Stop after a failed recording stop so the user can retry", async () => {
		vi.mocked(startSlidesRecording).mockResolvedValueOnce(undefined);
		vi.mocked(stopSlidesRecording)
			.mockRejectedValueOnce(new Error("stop failed"))
			.mockResolvedValueOnce("");
		render(<SlidesCenterArea naia={new EditorBridge()} />);
		openPdf();
		await waitForDeck();
		fireEvent.click(screen.getByRole("button", { name: "Record MP4" }));
		await waitFor(() => expect(screen.getByRole("button", { name: "Stop recording" })).toBeEnabled());
		fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("stop failed"));
		fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
		await waitFor(() => expect(screen.getByRole("button", { name: "Record MP4" })).toBeEnabled());
		expect(stopSlidesRecording).toHaveBeenCalledTimes(2);
	});

	beforeEach(async () => {
		picker.available = false;
		picker.open.mockReset();
		await setLocale("en");
		globalThis.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as typeof ResizeObserver;
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("pauses narration while editing and applies the current page script", async () => {
		render(<SlidesCenterArea naia={new EditorBridge()} />);
		openPdf();
		await waitForDeck();
		fireEvent.click(screen.getByTestId("slides-edit-script"));
		expect(screen.getByTestId("slides-script-editor")).toHaveValue("PDF text 1");
		fireEvent.keyDown(document.body, { key: "ArrowRight" });
		expect(screen.getByText("1 / 3")).toBeInTheDocument();
		fireEvent.change(screen.getByTestId("slides-script-editor"), {
			target: { value: "A rewritten narration" },
		});
		fireEvent.click(screen.getByTestId("slides-apply-script"));
		await waitFor(() =>
			expect(screen.getByTestId("slides-current-note")).toHaveTextContent(
				"A rewritten narration",
			),
		);
		expect(screen.getByTestId("slides-script-unexported")).toBeInTheDocument();
	});

	it("cancels a draft and keeps the existing narration", async () => {
		render(<SlidesCenterArea naia={new EditorBridge()} />);
		openPdf();
		await waitForDeck();
		fireEvent.click(screen.getByTestId("slides-edit-script"));
		fireEvent.change(screen.getByTestId("slides-script-editor"), {
			target: { value: "discard this" },
		});
		fireEvent.click(screen.getByTestId("slides-cancel-script"));
		expect(screen.getByTestId("slides-current-note")).toHaveTextContent("PDF text 1");
		expect(screen.queryByTestId("slides-script-unsaved")).not.toBeInTheDocument();
	});

	it("downloads an applied edit as a separate Markdown copy", async () => {
		const createUrl = vi.fn(() => "blob:slides");
		const revokeUrl = vi.fn();
		Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createUrl });
		Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeUrl });
		const click = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(() => {});
		render(<SlidesCenterArea naia={new EditorBridge()} />);
		openPdf("deck.pdf");
		await waitForDeck();
		fireEvent.click(screen.getByTestId("slides-edit-script"));
		fireEvent.change(screen.getByTestId("slides-script-editor"), {
			target: { value: "download me" },
		});
		fireEvent.click(screen.getByTestId("slides-apply-script"));
		fireEvent.click(screen.getByTestId("slides-download-script"));
		await waitFor(() => expect(click).toHaveBeenCalled());
		expect(createUrl).toHaveBeenCalledOnce();
		expect(screen.queryByTestId("slides-script-unexported")).not.toBeInTheDocument();
		await waitFor(() => expect(revokeUrl).toHaveBeenCalledWith("blob:slides"));
	});

	it("reports a draft instead of exporting it", async () => {
		const createUrl = vi.fn(() => "blob:should-not-export");
		Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createUrl });
		render(<SlidesCenterArea naia={new EditorBridge()} />);
		openPdf();
		await waitForDeck();
		fireEvent.click(screen.getByTestId("slides-edit-script"));
		fireEvent.change(screen.getByTestId("slides-script-editor"), {
			target: { value: "still a draft" },
		});
		fireEvent.click(screen.getByTestId("slides-download-script"));
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Apply or cancel the draft before downloading.",
		);
		expect(createUrl).not.toHaveBeenCalled();
	});

	it("cancels a native import and keeps the current deck", async () => {
		picker.available = true;
		picker.open.mockImplementation(
			(signal: AbortSignal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () =>
						reject(new DOMException("Aborted", "AbortError")),
					);
				}),
		);
		render(<SlidesCenterArea naia={new EditorBridge()} />);
		fireEvent.change(screen.getByLabelText("Open PDF or PPTX"), {
			target: { files: [new File(["pdf"], "old.pdf")] },
		});
		await waitForDeck();
		fireEvent.click(screen.getByLabelText("Open PDF or PPTX"));
		await waitFor(() => expect(screen.getByTestId("slides-cancel-import")).toBeInTheDocument());
		fireEvent.click(screen.getByTestId("slides-cancel-import"));
		await waitFor(() => expect(screen.queryByTestId("slides-import-status")).not.toBeInTheDocument());
		expect(screen.getByText("old.pdf")).toBeInTheDocument();
	});
});
