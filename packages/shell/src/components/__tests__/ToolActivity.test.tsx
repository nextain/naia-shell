import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { ToolCall } from "../../lib/types";
import { ToolActivity } from "../ToolActivity";

describe("ToolActivity", () => {
	afterEach(cleanup);

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

	it("maps execute_command tool name", () => {
		const tool = { ...baseTool, toolName: "execute_command" };
		render(<ToolActivity tool={tool} />);
		expect(screen.getByText(/명령 실행|Execute Command/)).toBeDefined();
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
});
