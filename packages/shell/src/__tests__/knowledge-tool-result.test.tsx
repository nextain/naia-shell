// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();
const activatePanel = vi.fn();
const openFile = vi.fn();
const setActiveApp = vi.fn();

vi.mock("../lib/app-registry", () => ({
	appRegistry: {
		getApi: (id: string) =>
			id === "browser" ? { navigate, activatePanel } : id === "workspace" ? { openFile } : undefined,
	},
}));
vi.mock("../stores/app", () => ({
	useAppStore: { getState: () => ({ setActiveApp }) },
}));

import { KnowledgeToolResult } from "../components/KnowledgeToolResult";
import type { ParsedKnowledge } from "../lib/knowledge-result";

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("KnowledgeToolResult (K2 — 답변 + 출처 칩 + 근거→원문 dispatch)", () => {
	it("ask: 답변 렌더 + URL 칩 클릭 → 브라우저 navigate(+패널 전환)", () => {
		const data: ParsedKnowledge = { kind: "ask", abstained: false, answer: "신분증입니다", sources: [{ title: "전입신고", sourceUris: ["https://gov.kr/x"] }] };
		render(<KnowledgeToolResult data={data} />);
		expect(screen.getByText("신분증입니다")).toBeTruthy();
		fireEvent.click(screen.getByText("전입신고"));
		expect(navigate).toHaveBeenCalledWith("https://gov.kr/x");
		expect(activatePanel).toHaveBeenCalled();
		expect(setActiveApp).toHaveBeenCalledWith("browser");
		expect(openFile).not.toHaveBeenCalled();
	});

	it("ask: 파일 출처 칩 클릭 → workspace openFile(file:// 제거) + 패널 전환", () => {
		const data: ParsedKnowledge = { kind: "ask", abstained: false, answer: "내용", sources: [{ title: "문서", sourceUris: ["file:///ws/doc.md"] }] };
		render(<KnowledgeToolResult data={data} />);
		fireEvent.click(screen.getByText("문서"));
		expect(openFile).toHaveBeenCalledWith("/ws/doc.md");
		expect(setActiveApp).toHaveBeenCalledWith("workspace");
		expect(navigate).not.toHaveBeenCalled();
	});

	it("ask: 기권 → 답변만, 출처 칩 없음", () => {
		const data: ParsedKnowledge = { kind: "ask", abstained: true, answer: "관련 근거를 찾지 못했습니다.", sources: [] };
		const { container } = render(<KnowledgeToolResult data={data} />);
		expect(screen.getByText("관련 근거를 찾지 못했습니다.")).toBeTruthy();
		expect(container.querySelector(".knowledge-source-chip")).toBeNull();
	});

	it("search: hits 렌더 + 칩 클릭 dispatch", () => {
		const data: ParsedKnowledge = { kind: "search", hits: [{ title: "여권", snippet: "수수료 53000원", score: 0.8, sourceUris: ["https://gov.kr/passport"] }] };
		const { container } = render(<KnowledgeToolResult data={data} />);
		expect(screen.getByText("수수료 53000원")).toBeTruthy();
		const chip = container.querySelector(".knowledge-source-chip") as HTMLElement;
		expect(chip).toBeTruthy();
		fireEvent.click(chip);
		expect(navigate).toHaveBeenCalledWith("https://gov.kr/passport");
	});

	it("출처 sourceUris 빈 배열 → 칩 없음(클릭 대상 없음)", () => {
		const data: ParsedKnowledge = { kind: "ask", abstained: false, answer: "a", sources: [{ title: "출처없음", sourceUris: [] }] };
		const { container } = render(<KnowledgeToolResult data={data} />);
		expect(container.querySelector(".knowledge-source-chip")).toBeNull();
	});
});
