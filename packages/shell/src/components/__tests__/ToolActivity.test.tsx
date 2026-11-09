import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../lib/i18n";
import { registerKioskSlidesController } from "../../lib/kiosk-demo/slides";
import type { ToolCall } from "../../lib/types";
import { isToolResultDump } from "../../lib/visible-chat-text";
import { useAppStore } from "../../stores/app";
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
				hits: [
					{
						id: "card-naia-1",
						title: "나이아 서비스 소개",
						sourceUris: ["opfs://naia-adk/kiosk-demo/knowledge/naia.md"],
					},
				],
			}),
		};
		rerender(<ToolActivity tool={finishedTool} />);
		expect(screen.getByText("자료 찾음")).toBeDefined();
		expect(screen.getByText("knowledge/naia.md")).toBeDefined();
		expect(
			container.querySelector(".tool-status-icon")?.textContent,
		).toBe("✓");
		expect(container.querySelector(".tool-activity-body")).toBeNull();
		expect(screen.queryByText(/abstained/)).toBeNull();
		expect(screen.queryByText(/card-naia-1/)).toBeNull();

		// Even if a tool call returns status="error" in kiosk mode, "자료 찾음" shows ✓ instead of red ✗
		rerender(<ToolActivity tool={{ ...finishedTool, status: "error" }} />);
		expect(screen.getByText("자료 찾음")).toBeDefined();
		expect(
			container.querySelector(".tool-status-icon")?.textContent,
		).toBe("✓");
		expect(container.querySelector(".tool-error")).toBeNull();

		expect(isToolResultDump(JSON.stringify({ query: "나이아" }))).toBe(true);
		expect(
			isToolResultDump(
				JSON.stringify({ abstained: false, hits: [{ id: "1" }] }),
			),
		).toBe(true);
	});

	it("P2-1 reads kiosk tool file label only from tool payload and never overwrites past tool badges when slides open or change pages", () => {
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		const companyTool: ToolCall = {
			toolCallId: "tc-company-1",
			toolName: "skill_knowledge_search",
			args: { query: "넥스테인은 뭘 하는 회사예요?" },
			status: "success",
			output: JSON.stringify({
				abstained: false,
				hits: [
					{
						id: "card-company-1",
						sourceUris: ["opfs://naia-adk/kiosk-demo/knowledge/company.md"],
					},
				],
			}),
		};

		const { rerender } = render(<ToolActivity tool={companyTool} />);
		expect(screen.getByText("자료 찾음")).toBeDefined();
		expect(screen.getByText("knowledge/company.md")).toBeDefined();

		let currentPage = 3;
		useAppStore.getState().setActiveApp("land.naia.slides");
		const unregister = registerKioskSlidesController({
			performAction: vi.fn(),
			isPresenting: () => true,
			isAnsweringQuestion: () => false,
			getCurrentPage: () => currentPage,
			onTurnSettled: vi.fn(),
		});
		try {
			// Opening slides on slide 3 (naia.md) or moving to slide 5 (adk.md) must not overwrite past tool file badge
			rerender(<ToolActivity tool={{ ...companyTool }} />);
			expect(screen.getByText("knowledge/company.md")).toBeDefined();
			expect(screen.queryByText("knowledge/naia.md")).toBeNull();

			currentPage = 5;
			rerender(<ToolActivity tool={{ ...companyTool }} />);
			expect(screen.getByText("knowledge/company.md")).toBeDefined();
			expect(screen.queryByText("knowledge/adk.md")).toBeNull();
		} finally {
			unregister();
			useAppStore.getState().setActiveApp(null);
		}
	});
});
