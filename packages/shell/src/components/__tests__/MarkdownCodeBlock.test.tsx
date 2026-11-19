// @vitest-environment jsdom
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, t } from "../../lib/i18n";
import {
	MarkdownCodeBlock,
	MermaidBlock,
	highlightCode,
} from "../MarkdownCodeBlock";

const renderMermaid = vi.fn();
const initializeMermaid = vi.fn();
vi.mock("mermaid", () => ({
	default: {
		initialize: initializeMermaid,
		render: (...args: unknown[]) => renderMermaid(...args),
	},
}));

describe("MarkdownCodeBlock", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: vi.fn().mockResolvedValue(undefined) },
		});
	});

	it("shows language controls, copies the exact code, and confirms success", async () => {
		const openWorkspace = vi.fn();
		render(
			<MarkdownCodeBlock
				className="language-ts"
				onOpenWorkspace={openWorkspace}
			>
				{"const answer = 42;\n"}
			</MarkdownCodeBlock>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Copy" }));
		expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
			"const answer = 42;",
		);
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Copied" }),
			).toBeInTheDocument(),
		);
		fireEvent.click(
			screen.getByRole("button", { name: t("chat.openInWorkspace") }),
		);
		expect(openWorkspace).toHaveBeenCalledWith("const answer = 42;", "ts");
	});

	it("renders the workspace action in the selected locale", async () => {
		await setLocale("ko");
		const { rerender, container } = render(<MarkdownCodeBlock className="language-ts" onOpenWorkspace={() => {}}>x</MarkdownCodeBlock>);
		expect(within(container).getByRole("button", { name: "워크스페이스에서 열기" })).toBeInTheDocument();
		await setLocale("en");
		rerender(<MarkdownCodeBlock className="language-ts" onOpenWorkspace={() => {}}>x</MarkdownCodeBlock>);
		expect(within(container).getByRole("button", { name: "Open in workspace" })).toBeInTheDocument();
	});

	it("highlights known languages and escapes executable markup", () => {
		expect(highlightCode("const answer = 42;", "typescript")).toContain(
			"hljs-keyword",
		);
		const hostile = highlightCode('<script>alert("x")</script>', "html");
		expect(hostile).not.toContain("<script>");
		expect(hostile).toContain("&lt;");
	});

	it("renders unknown languages as escaped plaintext", () => {
		const { container } = render(
			<MarkdownCodeBlock className="language-not-a-real-language">
				{"<img src=x onerror=alert(1)>"}
			</MarkdownCodeBlock>,
		);
		expect(container.querySelector("code")?.innerHTML).toContain("&lt;img");
		expect(container.querySelector("img")).toBeNull();
	});

	it("loads Mermaid on demand and initializes it only once", async () => {
		renderMermaid.mockResolvedValue({ svg: "<svg><text>ok</text></svg>" });
		const { rerender } = render(<MermaidBlock code="graph TD; A-->B" />);
		await waitFor(() => expect(renderMermaid).toHaveBeenCalledTimes(1));
		rerender(<MermaidBlock code="graph TD; B-->C" />);
		await waitFor(() => expect(renderMermaid).toHaveBeenCalledTimes(2));
		expect(initializeMermaid).toHaveBeenCalledTimes(1);
		expect(initializeMermaid).toHaveBeenCalledWith(
			expect.objectContaining({ securityLevel: "strict", startOnLoad: false }),
		);
	});

	it("falls back to Mermaid source when strict rendering fails", async () => {
		renderMermaid.mockRejectedValue(new Error("unsafe syntax"));
		render(<MermaidBlock code="graph TD; A-->B" />);
		await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
		expect(screen.getByText("graph TD; A-->B")).toBeInTheDocument();
	});

	// 실패 화면이 원문만 보여 주면 사용자가 할 수 있는 일은 글자를 직접 긁는
	// 것뿐이다. 원문을 그대로 클립보드로 보낼 수 있어야 다른 곳에서 고쳐 볼 수
	// 있다 (#558).
	it("copies the exact Mermaid source from the failure screen", async () => {
		renderMermaid.mockRejectedValue(new Error("unsafe syntax"));
		// 이 파일의 앞선 테스트가 그린 것이 문서에 남아 있어, 문서 전체를 보면
		// 같은 이름의 단추가 여럿 잡힌다. 이 렌더 안만 본다.
		const { container } = render(<MermaidBlock code="graph TD; A-->B" />);
		const screen = within(container);
		await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

		const copy = screen.getByRole("button", { name: "Copy" });
		fireEvent.click(copy);
		expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
			"graph TD; A-->B",
		);
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Copied" }),
			).toBeInTheDocument(),
		);
	});

	// 실패가 일시적일 수 있다 — mermaid 모듈을 못 불러왔거나 한 번 삐끗한
	// 경우다. 다시 그리기를 누르면 같은 원문으로 한 번 더 시도한다.
	it("re-renders the same source when the failure screen retries", async () => {
		renderMermaid.mockRejectedValue(new Error("unsafe syntax"));
		const { container } = render(<MermaidBlock code="graph TD; A-->B" />);
		const screen = within(container);
		await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
		expect(renderMermaid).toHaveBeenCalledTimes(1);

		renderMermaid.mockResolvedValue({ svg: "<svg><text>ok</text></svg>" });
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));

		await waitFor(() => expect(renderMermaid).toHaveBeenCalledTimes(2));
		expect(renderMermaid).toHaveBeenLastCalledWith(
			expect.any(String),
			"graph TD; A-->B",
		);
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
	});
});
