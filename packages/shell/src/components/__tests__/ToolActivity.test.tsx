import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../lib/i18n";
import type { ToolCall } from "../../lib/types";
import { isToolResultDump } from "../../lib/visible-chat-text";
import { ToolActivity } from "../ToolActivity";

describe("ToolActivity", () => {
	afterEach(() => {
		cleanup();
		vi.unstubAllEnvs();
	});

	const baseTool: ToolCall = {
		toolCallId: "tc-1",
		toolName: "read_file",
		args: { path: "/test.txt" },
		status: "running",
	};

	it("renders tool name in Korean", () => {
		render(<ToolActivity tool={baseTool} />);
		expect(screen.getByText(/파일 읽기|Read File/)).toBeDefined();
	});

	it("shows running indicator for running status", () => {
		const { container } = render(<ToolActivity tool={baseTool} />);
		const header = container.querySelector(".tool-activity-header");
		expect(header?.textContent).toMatch(/⟳/);
	});

	it("shows success indicator for success status", () => {
		const tool = { ...baseTool, status: "success" as const, output: "ok" };
		const { container } = render(<ToolActivity tool={tool} />);
		const header = container.querySelector(".tool-activity-header");
		expect(header?.textContent).toMatch(/✓/);
	});

	it("shows error indicator for error status", () => {
		const tool = {
			...baseTool,
			status: "error" as const,
			output: "fail",
		};
		const { container } = render(<ToolActivity tool={tool} />);
		const header = container.querySelector(".tool-activity-header");
		expect(header?.textContent).toMatch(/✗/);
	});

	it("toggles body on header click", () => {
		const tool = {
			...baseTool,
			status: "success" as const,
			output: "file contents here",
		};
		render(<ToolActivity tool={tool} />);

		// Body should be collapsed by default
		expect(screen.queryByText("file contents here")).toBeNull();

		// Click header to expand
		const header = screen.getByText(/파일 읽기|Read File/);
		fireEvent.click(header);
		expect(screen.getByText("file contents here")).toBeDefined();

		// Click again to collapse
		fireEvent.click(header);
		expect(screen.queryByText("file contents here")).toBeNull();
	});

	it("truncates output longer than 500 chars", () => {
		const longOutput = "a".repeat(600);
		const tool = {
			...baseTool,
			status: "success" as const,
			output: longOutput,
		};
		render(<ToolActivity tool={tool} />);

		// Expand
		fireEvent.click(screen.getByText(/파일 읽기|Read File/));
		const body = screen.getByText(/^a+…$/);
		expect(body.textContent?.length).toBeLessThanOrEqual(504); // 500 + "…" + possible whitespace
	});

	it("maps unknown tool name to fallback", () => {
		const tool = { ...baseTool, toolName: "some_new_tool" };
		render(<ToolActivity tool={tool} />);
		expect(screen.getByText(/도구 실행|Tool Execution/)).toBeDefined();
	});

	it("shows args in body when expanded", () => {
		render(<ToolActivity tool={baseTool} />);
		fireEvent.click(screen.getByText(/파일 읽기|Read File/));
		expect(screen.getByText(/\/test\.txt/)).toBeDefined();
	});

	it("renders removed knowledge tools as ordinary tool activity", () => {
		const tool: ToolCall = {
			...baseTool,
			toolName: "skill_knowledge_graph",
			status: "success",
			output: JSON.stringify({
				nodes: [{ id: "a", label: "Alpha" }],
				edges: [],
				communityCount: 1,
			}),
		};

		const { container } = render(<ToolActivity tool={tool} />);
		expect(container.querySelector(".tool-knowledge-graph")).toBeNull();
		expect(screen.queryByTestId("knowledge-graph")).toBeNull();
		expect(screen.getByText(/도구 실행|Tool Execution|skill_knowledge_graph/)).toBeDefined();
	});

	it("does not dump empty knowledge JSON into the transcript body", () => {
		const tool: ToolCall = {
			...baseTool,
			toolName: "skill_knowledge_graph",
			status: "success",
			args: {},
			output: "{}",
		};
		render(<ToolActivity tool={tool} />);
		fireEvent.click(screen.getByRole("button"));
		expect(screen.queryByText("{}")).toBeNull();
		expect(screen.getByText("No results")).toBeDefined();
	});

	it("WO13C-S3 list-dir-label", async () => {
		const listTool: ToolCall = {
			toolCallId: "tc-list",
			toolName: "list_dir",
			args: { path: "/test" },
			status: "running",
		};
		try {
			await setLocale("ko");
			const { unmount } = render(<ToolActivity tool={listTool} />);
			expect(screen.getByText("폴더 보기")).toBeDefined();
			expect(screen.queryByText("도구 실행")).toBeNull();
			unmount();

			await setLocale("en");
			render(<ToolActivity tool={listTool} />);
			expect(screen.getByText("List folder")).toBeDefined();
			expect(screen.queryByText("Tool Execution")).toBeNull();
		} finally {
			await setLocale("en");
		}
	});

	it("FR-WEB-KIOSK-R3.1 hides raw tool args/output JSON and expand button in kiosk demo mode", () => {
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		const runningTool: ToolCall = {
			toolCallId: "tc-kiosk-1",
			toolName: "skill_knowledge_search",
			args: { query: "나이아 서비스 소개" },
			status: "running",
		};
		const { container, rerender } = render(<ToolActivity tool={runningTool} />);
		expect(screen.getByText("자료 찾는 중")).toBeDefined();
		expect(container.querySelector("button.tool-activity-header")).toBeNull();
		expect(container.querySelector(".tool-expand")).toBeNull();
		expect(container.querySelector(".tool-activity-body")).toBeNull();
		expect(screen.queryByText(/나이아 서비스 소개/)).toBeNull();

		const finishedTool: ToolCall = {
			...runningTool,
			status: "success",
			output: JSON.stringify({
				abstained: false,
				hits: [{ id: "card-naia-1", title: "나이아 서비스 소개" }],
			}),
		};
		rerender(<ToolActivity tool={finishedTool} />);
		expect(screen.getByText("자료 찾음")).toBeDefined();
		expect(container.querySelector(".tool-activity-body")).toBeNull();
		expect(screen.queryByText(/abstained/)).toBeNull();
		expect(screen.queryByText(/card-naia-1/)).toBeNull();

		expect(isToolResultDump(JSON.stringify({ query: "나이아" }))).toBe(true);
		expect(
			isToolResultDump(
				JSON.stringify({ abstained: false, hits: [{ id: "1" }] }),
			),
		).toBe(true);
	});
});
