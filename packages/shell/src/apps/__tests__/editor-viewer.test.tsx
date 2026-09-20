// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockInvoke = vi.fn();
const editorViewSpies = vi.hoisted(() => ({
	dispatch: vi.fn(),
	focus: vi.fn(),
	scrollIntoView: vi.fn((anchor: number) => ({ anchor })),
}));
vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
	convertFileSrc: (path: string) => `asset://${path}`,
}));

vi.mock("../../lib/logger", () => ({
	Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock CodeMirror — not available in jsdom
vi.mock("@codemirror/view", () => {
	class EditorView {
		destroy() {}
		state = {
			doc: {
				toString: () => "one\ntwo\nthree",
				lines: 3,
				line: (number: number) => ({
					from: number === 1 ? 0 : number === 2 ? 4 : 8,
					length: number === 3 ? 5 : 3,
				}),
			},
		};
		dispatch = editorViewSpies.dispatch;
		focus = editorViewSpies.focus;
		static lineWrapping = {};
		static updateListener = { of: () => ({}) };
		static scrollIntoView = editorViewSpies.scrollIntoView;
	}
	return {
		EditorView,
		keymap: { of: () => ({}) },
		lineNumbers: () => ({}),
	};
});
vi.mock("@codemirror/state", () => ({
	EditorState: { create: () => ({}), readOnly: { of: () => ({}) } },
	Transaction: { addToHistory: { of: () => ({}) } },
}));
vi.mock("@codemirror/commands", () => ({
	defaultKeymap: [],
	history: () => ({}),
	historyKeymap: [],
}));
vi.mock("@codemirror/theme-one-dark", () => ({ oneDark: {} }));
vi.mock("@codemirror/lang-javascript", () => ({ javascript: () => ({}) }));
vi.mock("@codemirror/lang-markdown", () => ({ markdown: () => ({}) }));
vi.mock("@codemirror/lang-python", () => ({ python: () => ({}) }));
vi.mock("@codemirror/lang-rust", () => ({ rust: () => ({}) }));
vi.mock("@codemirror/lang-yaml", () => ({ yaml: () => ({}) }));
vi.mock("@codemirror/lang-json", () => ({ json: () => ({}) }));
vi.mock("@codemirror/lang-css", () => ({ css: () => ({}) }));

// Mock react-pdf — pdf.js requires canvas/worker not available in jsdom
vi.mock("react-pdf", () => {
	function Document({
		children,
		onLoadSuccess,
		loading,
	}: {
		children: React.ReactNode;
		file: string;
		onLoadSuccess?: (info: { numPages: number }) => void;
		onLoadError?: (err: Error) => void;
		loading?: React.ReactNode;
	}) {
		// Simulate async load success
		setTimeout(() => onLoadSuccess?.({ numPages: 2 }), 0);
		return (
			<div data-testid="pdf-document">
				{loading}
				{children}
			</div>
		);
	}
	function Page({
		pageNumber,
		className,
	}: { pageNumber: number; width?: number; className?: string }) {
		return (
			<div data-testid={`pdf-page-${pageNumber}`} className={className}>
				PDF Page {pageNumber}
			</div>
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

// Mock mermaid — rendering requires DOM APIs not available in jsdom
const mockRender = vi
	.fn()
	.mockResolvedValue({ svg: '<svg data-testid="mermaid-svg">mocked</svg>' });
vi.mock("mermaid", () => ({
	default: {
		initialize: vi.fn(),
		render: (...args: unknown[]) => mockRender(...args),
	},
}));

// ─── Subject ──────────────────────────────────────────────────────────────────

import { Editor, type EditorHandle } from "../workspace/Editor";
import { t } from "../../lib/i18n";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("Editor — imperative location reveal", () => {
	it("moves the real editor selection to the requested one-based line and column", async () => {
		mockInvoke.mockResolvedValue("one\ntwo\nthree");
		const ref = createRef<EditorHandle>();
		render(<Editor ref={ref} filePath="/work/naia/src/App.tsx" />);
		await waitFor(() => expect(ref.current).not.toBeNull());

		ref.current?.revealLocation(2, 3, "/work/naia/src/App.tsx");

		expect(editorViewSpies.scrollIntoView).toHaveBeenCalledWith(6, {
			y: "center",
		});
		expect(editorViewSpies.dispatch).toHaveBeenCalledWith({
			selection: { anchor: 6 },
			effects: { anchor: 6 },
		});
		expect(editorViewSpies.focus).toHaveBeenCalled();
	});
});

// ─── Helper: file type detection ──────────────────────────────────────────────

describe("Editor — file type helpers (via render behaviour)", () => {
	it("renders image viewer for .png", async () => {
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "workspace_read_file_bytes")
				return Promise.resolve([137, 80, 78, 71]);
			return Promise.resolve("");
		});
		render(<Editor filePath="/dev/project/screenshot.png" />);
		// Image viewer shows <img>, not CodeMirror
		await waitFor(() => {
			expect(screen.getByRole("img")).toBeInTheDocument();
		});
		const img = screen.getByRole("img");
		expect(img.getAttribute("src")).toMatch(/^blob:/);
	});

	it("renders image viewer for .jpg", async () => {
		mockInvoke.mockResolvedValue("");
		render(<Editor filePath="/foo/photo.jpg" />);
		await waitFor(() => expect(screen.getByRole("img")).toBeInTheDocument());
	});

	it("renders image viewer for .webp", async () => {
		mockInvoke.mockResolvedValue("");
		render(<Editor filePath="/foo/banner.webp" />);
		await waitFor(() => expect(screen.getByRole("img")).toBeInTheDocument());
	});

	it("renders image viewer for .svg (not text editor)", async () => {
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "workspace_read_file_bytes")
				return Promise.resolve([60, 115, 118, 103]);
			return Promise.resolve("");
		});
		render(<Editor filePath="/assets/icon.svg" />);
		await waitFor(() => expect(screen.getByRole("img")).toBeInTheDocument());
		const img = screen.getByRole("img");
		expect(img.getAttribute("src")).toMatch(/^blob:/);
		// Confirm viewMode is "image": no markdown edit buttons rendered
		expect(screen.queryByText("편집")).not.toBeInTheDocument();
		expect(screen.queryByText("미리보기")).not.toBeInTheDocument();
	});

	it("does NOT call workspace_read_file for image files", () => {
		render(<Editor filePath="/foo/image.png" />);
		expect(mockInvoke).not.toHaveBeenCalledWith(
			"workspace_read_file",
			expect.anything(),
		);
	});

	it("renders CSV table viewer for .csv", async () => {
		mockInvoke.mockResolvedValueOnce(
			"name,age,city\nAlice,30,Seoul\nBob,25,Busan",
		);
		render(<Editor filePath="/data/users.csv" />);
		await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
		// Header row
		expect(screen.getByText("name")).toBeInTheDocument();
		expect(screen.getByText("age")).toBeInTheDocument();
		expect(screen.getByText("city")).toBeInTheDocument();
		// Data rows
		expect(screen.getByText("Alice")).toBeInTheDocument();
		expect(screen.getByText("Bob")).toBeInTheDocument();
	});

	it("CSV table is sortable — clicking header sorts ascending then descending", async () => {
		mockInvoke.mockResolvedValueOnce(
			"name,score\nCharlie,80\nAlice,95\nBob,70",
		);
		render(<Editor filePath="/data/scores.csv" />);
		await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());

		const nameHeader = screen.getByText("name");
		// Initial order: Charlie, Alice, Bob
		let cells = screen.getAllByRole("cell");
		expect(cells[0].textContent).toBe("Charlie");

		fireEvent.click(nameHeader);
		// After ascending sort by name: Alice, Bob, Charlie
		cells = screen.getAllByRole("cell");
		expect(cells[0].textContent).toBe("Alice");
		expect(screen.getByText("name ▲")).toBeInTheDocument();

		fireEvent.click(nameHeader);
		// After descending sort
		cells = screen.getAllByRole("cell");
		expect(cells[0].textContent).toBe("Charlie");
		expect(screen.getByText("name ▼")).toBeInTheDocument();
	});

	it("CSV header onKeyDown (Enter/Space) sorts the same as click", async () => {
		mockInvoke.mockResolvedValueOnce(
			"name,score\nCharlie,80\nAlice,95\nBob,70",
		);
		render(<Editor filePath="/data/scores.csv" />);
		await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());

		const nameHeader = screen.getByText("name");
		// Enter key → ascending sort
		fireEvent.keyDown(nameHeader, { key: "Enter" });
		expect(screen.getByText("name ▲")).toBeInTheDocument();

		// Space key → descending sort
		fireEvent.keyDown(nameHeader, { key: " " });
		expect(screen.getByText("name ▼")).toBeInTheDocument();
	});

	it("shows empty hint for empty CSV", async () => {
		mockInvoke.mockResolvedValueOnce("");
		render(<Editor filePath="/data/empty.csv" />);
		await waitFor(() =>
			expect(screen.getByText("CSV 데이터가 없습니다")).toBeInTheDocument(),
		);
	});

	it("renders log viewer for .log (contains pre element)", async () => {
		mockInvoke.mockResolvedValueOnce(
			"INFO: server started\nERROR: connection refused",
		);
		render(<Editor filePath="/var/log/app.log" />);
		await waitFor(() => {
			const pre = document.querySelector(".workspace-editor__log-pre");
			expect(pre).toBeInTheDocument();
		});
	});

	it("renders log content (ANSI stripped/converted)", async () => {
		mockInvoke.mockResolvedValueOnce("plain log line");
		render(<Editor filePath="/var/log/app.log" />);
		await waitFor(() => {
			const pre = document.querySelector(".workspace-editor__log-pre");
			expect(pre?.textContent).toContain("plain log line");
		});
	});

	it("does NOT show markdown view-mode buttons for image files", async () => {
		mockInvoke.mockResolvedValue("");
		render(<Editor filePath="/img/photo.png" />);
		await waitFor(() => expect(screen.getByRole("img")).toBeInTheDocument());
		expect(screen.queryByText("편집")).not.toBeInTheDocument();
		expect(screen.queryByText("미리보기")).not.toBeInTheDocument();
	});

	it("does NOT show markdown view-mode buttons for CSV files", async () => {
		mockInvoke.mockResolvedValueOnce("a,b\n1,2");
		render(<Editor filePath="/data/file.csv" />);
		await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
		expect(screen.queryByText("편집")).not.toBeInTheDocument();
	});

	it("shows file name in header for all viewer types", async () => {
		mockInvoke.mockResolvedValue("");
		render(<Editor filePath="/some/dir/photo.png" />);
		await waitFor(() => expect(screen.getByRole("img")).toBeInTheDocument());
		expect(screen.getByText("/some/dir/photo.png")).toBeInTheDocument();
	});

	it("resets sort when file changes", async () => {
		mockInvoke
			.mockResolvedValueOnce("name,val\nZeta,1\nAlpha,2")
			.mockResolvedValueOnce("col1,col2\nX,Y");
		const { rerender } = render(<Editor filePath="/data/a.csv" />);
		await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());

		// Sort by name
		fireEvent.click(screen.getByText("name"));
		expect(screen.getByText("name ▲")).toBeInTheDocument();

		// Switch file → sort should reset
		rerender(<Editor filePath="/data/b.csv" />);
		await waitFor(() => expect(screen.getByText("col1")).toBeInTheDocument());
		// No sort indicator
		expect(screen.queryByText(/▲|▼/)).not.toBeInTheDocument();
	});

	it("renders PDF viewer for .pdf", async () => {
		render(<Editor filePath="/docs/report.pdf" />);
		await waitFor(() =>
			expect(screen.getByTestId("pdf-document")).toBeInTheDocument(),
		);
		// After mock onLoadSuccess fires (numPages=2), pages render
		await waitFor(() => {
			expect(screen.getByTestId("pdf-page-1")).toBeInTheDocument();
			expect(screen.getByTestId("pdf-page-2")).toBeInTheDocument();
		});
	});

	it.each([
		["track.mp3", "audio", "audio player"],
		["recording.wav", "audio", "audio player"],
		["clip.mp4", "video", "video player"],
	])(
		"streams %s through an accessible local media element",
		async (name, tag, label) => {
			mockInvoke.mockImplementation((command: string) =>
				Promise.resolve(command === "workspace_read_file_bytes" ? [1, 2, 3] : ""),
			);
			render(<Editor filePath={`/media/${name}`} />);
			const media = screen.getByLabelText(new RegExp(label, "i"));
			expect(media.tagName.toLowerCase()).toBe(tag);
			await waitFor(() => expect(media.getAttribute("src")).toMatch(/^blob:/));
			expect(media).toHaveAttribute("preload", "metadata");
			expect(mockInvoke).toHaveBeenCalledWith("workspace_read_file_bytes", {
				path: `/media/${name}`,
			});
			expect(mockInvoke).not.toHaveBeenCalledWith(
				"workspace_read_file",
				expect.anything(),
			);
		},
	);

	it("reports codec errors and changes playback speed", () => {
		render(<Editor filePath="/media/clip.mp4" />);
		const video = screen.getByLabelText(/video player/i) as HTMLVideoElement;
		fireEvent.change(screen.getByLabelText("재생 속도"), {
			target: { value: "1.5" },
		});
		expect(video.playbackRate).toBe(1.5);
		fireEvent.error(video);
		expect(screen.getByRole("alert")).toHaveTextContent(
			t("workspace.videoCodecError"),
		);
	});

	it("does NOT call workspace_read_file for PDF files", () => {
		render(<Editor filePath="/docs/spec.pdf" />);
		expect(mockInvoke).not.toHaveBeenCalledWith(
			"workspace_read_file",
			expect.anything(),
		);
	});

	it("does NOT show markdown view-mode buttons for PDF files", async () => {
		render(<Editor filePath="/docs/report.pdf" />);
		await waitFor(() =>
			expect(screen.getByTestId("pdf-document")).toBeInTheDocument(),
		);
		expect(screen.queryByText("편집")).not.toBeInTheDocument();
		expect(screen.queryByText("미리보기")).not.toBeInTheDocument();
	});

	it("renders Mermaid diagram in Markdown preview", async () => {
		const mdContent = "# Test\n\n```mermaid\ngraph TD;\n  A-->B;\n```\n";
		mockInvoke.mockImplementation((cmd: string) =>
			Promise.resolve(
				cmd === "workspace_file_size" ? mdContent.length : mdContent,
			),
		);
		render(<Editor filePath="/docs/readme.md" />);
		// Markdown preview mode — mermaid.render should be called
		await waitFor(() => {
			expect(mockRender).toHaveBeenCalled();
		});
		// The rendered SVG should be injected
		await waitFor(() => {
			const mermaidDiv = document.querySelector(".workspace-editor__mermaid");
			expect(mermaidDiv).toBeInTheDocument();
			expect(mermaidDiv?.innerHTML).toContain("mermaid-svg");
		});
	});

	it("shows error for invalid Mermaid syntax", async () => {
		mockRender.mockRejectedValueOnce(new Error("Parse error"));
		const mdContent = "```mermaid\ninvalid syntax\n```\n";
		mockInvoke.mockImplementation((cmd: string) =>
			Promise.resolve(
				cmd === "workspace_file_size" ? mdContent.length : mdContent,
			),
		);
		render(<Editor filePath="/docs/bad.md" />);
		await waitFor(() =>
			expect(screen.getByText(t("chat.mermaidError"))).toBeInTheDocument(),
		);
	});

	it("shows load error for failed file read", async () => {
		mockInvoke.mockRejectedValueOnce(new Error("permission denied"));
		render(<Editor filePath="/root/secret.csv" />);
		await waitFor(() =>
			expect(screen.getByText(/파일을 열 수 없습니다/)).toBeInTheDocument(),
		);
		expect(
			screen.getByRole("button", { name: t("common.retry") }),
		).toBeInTheDocument();
	});

	it("shows reload button in editor header", async () => {
		mockInvoke.mockResolvedValueOnce("hello world");
		render(<Editor filePath="/docs/test.txt" />);
		await waitFor(() =>
			expect(screen.getByTitle("디스크에서 다시 읽기")).toBeInTheDocument(),
		);
		expect(screen.getByTitle("디스크에서 다시 읽기").textContent).toBe("↻");
	});

	it("reload button re-reads file from disk", async () => {
		mockInvoke.mockResolvedValueOnce("original content");
		render(<Editor filePath="/docs/test.txt" />);
		await waitFor(() =>
			expect(screen.getByTitle("디스크에서 다시 읽기")).toBeInTheDocument(),
		);
		// Second call returns updated content
		mockInvoke.mockResolvedValueOnce("updated content");
		fireEvent.click(screen.getByTitle("디스크에서 다시 읽기"));
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("workspace_read_file", {
				path: "/docs/test.txt",
			}),
		);
	});

	it("markdown files open in preview mode by default", async () => {
		mockInvoke.mockImplementation((cmd: string) =>
			Promise.resolve(cmd === "workspace_file_size" ? 7 : "# Hello"),
		);
		render(<Editor filePath="/docs/readme.md" />);
		await waitFor(() =>
			// Preview mode shows "편집" button to switch to edit mode
			expect(screen.getByTitle("편집 모드로 전환")).toBeInTheDocument(),
		);
		// The preview div should be rendered
		const preview = document.querySelector(".workspace-editor__preview");
		expect(preview).toBeInTheDocument();
	});

	it("rejects oversized Markdown before reading its contents", async () => {
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "workspace_file_size")
				return Promise.resolve(6 * 1024 * 1024);
			return Promise.resolve("must not be read");
		});
		render(<Editor filePath="/docs/huge.markdown" />);
		await waitFor(() =>
			expect(screen.getByText(/5 MiB 미리보기 한도/)).toBeInTheDocument(),
		);
		expect(mockInvoke).not.toHaveBeenCalledWith(
			"workspace_read_file",
			expect.anything(),
		);
	});
});

// ─── Editor — header and empty state ─────────────────────────────────────────
//
// 2026-09-05 에 `workspace-area.test.tsx` 에서 옮겨 왔다. 그 파일은 지운
// `WorkspaceCenterArea` 를 그려서 함께 지워야 했지만, 여기 다섯은 살아 있는
// `Editor` 만 재고 있었다.
describe("Editor — header and empty state", () => {
	it("renders empty hint when no file is selected", () => {
		render(<Editor filePath="" />);

		expect(screen.getByText(t("workspace.editorEmptyHint"))).toBeDefined();
	});

	it("shows filename in header when file is opened", () => {
		mockInvoke.mockResolvedValue("file content here");

		render(<Editor filePath="/home/user/dev/naia-os/AGENTS.md" />);

		expect(
			screen.getByText("/home/user/dev/naia-os/AGENTS.md"),
		).toBeDefined();
	});

	it("shows badge when provided", () => {
		mockInvoke.mockResolvedValue("content");

		render(
			<Editor filePath="/home/user/dev/naia-os/AGENTS.md" badge="#79 · Build" />,
		);

		expect(screen.getByText("#79 · Build")).toBeDefined();
	});

	it("shows edit toggle button for markdown files (default preview mode)", () => {
		mockInvoke.mockResolvedValue("# Heading\n\nContent");

		render(
			<Editor filePath="/home/user/dev/naia-os/docs/design/workspace-app.ko.md" />,
		);

		// 마크다운은 미리보기로 열리므로 "편집" 단추가 보인다.
		expect(screen.getByText("편집")).toBeDefined();
	});

	it("shows read-only label for ref- directories", async () => {
		mockInvoke.mockResolvedValue("readonly content");

		render(
			<Editor filePath="/home/user/dev/ref-cline/README.md" readOnly={true} />,
		);

		await waitFor(() => {
			expect(screen.getByText("읽기 전용")).toBeDefined();
		});
	});
});
