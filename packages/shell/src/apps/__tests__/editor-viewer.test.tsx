// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockInvoke = vi.fn();
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
		state = { doc: { toString: () => "" } };
		dispatch = vi.fn();
		static lineWrapping = {};
		static updateListener = { of: () => ({}) };
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

import { Editor } from "../workspace/Editor";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
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
		expect(screen.getByText("photo.png")).toBeInTheDocument();
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
		mockInvoke.mockResolvedValueOnce(mdContent);
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
		mockInvoke.mockResolvedValueOnce(mdContent);
		render(<Editor filePath="/docs/bad.md" />);
		await waitFor(() =>
			expect(screen.getByText(/Mermaid 오류/)).toBeInTheDocument(),
		);
	});

	it("shows load error for failed file read", async () => {
		mockInvoke.mockRejectedValueOnce(new Error("permission denied"));
		render(<Editor filePath="/root/secret.csv" />);
		await waitFor(() =>
			expect(screen.getByText(/파일을 열 수 없습니다/)).toBeInTheDocument(),
		);
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
		mockInvoke.mockResolvedValueOnce("# Hello");
		render(<Editor filePath="/docs/readme.md" />);
		await waitFor(() =>
			// Preview mode shows "편집" button to switch to edit mode
			expect(screen.getByTitle("편집 모드로 전환")).toBeInTheDocument(),
		);
		// The preview div should be rendered
		const preview = document.querySelector(".workspace-editor__preview");
		expect(preview).toBeInTheDocument();
	});
});
