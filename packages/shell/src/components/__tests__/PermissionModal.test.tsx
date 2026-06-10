import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingApproval } from "../../stores/chat";
import { PermissionModal } from "../PermissionModal";

// Mock Tauri APIs
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
}));

const basePending: PendingApproval = {
	requestId: "req-1",
	toolCallId: "tc-1",
	toolName: "execute_command",
	args: { command: "npm test" },
	tier: 2,
	description: "명령 실행: npm test",
};

describe("PermissionModal", () => {
	afterEach(() => {
		cleanup();
	});

	it("renders tool name and description", () => {
		render(<PermissionModal pending={basePending} onDecision={vi.fn()} />);
		expect(screen.getByText(/명령 실행: npm test/)).toBeDefined();
	});

	it("shows tier 2 badge as caution", () => {
		render(<PermissionModal pending={basePending} onDecision={vi.fn()} />);
		expect(screen.getByText(/주의|Caution/)).toBeDefined();
	});

	it("shows tier 1 badge as notice", () => {
		render(
			<PermissionModal
				pending={{ ...basePending, tier: 1, toolName: "write_file" }}
				onDecision={vi.fn()}
			/>,
		);
		expect(screen.getByText(/알림|Notice/)).toBeDefined();
	});

	it("calls onDecision with 'once' when allow once clicked", () => {
		const onDecision = vi.fn();
		render(<PermissionModal pending={basePending} onDecision={onDecision} />);
		const btn = screen.getByText(/이번만 허용|Allow Once/);
		fireEvent.click(btn);
		expect(onDecision).toHaveBeenCalledWith("once");
	});

	it("calls onDecision with 'always' when always allow clicked", () => {
		const onDecision = vi.fn();
		render(<PermissionModal pending={basePending} onDecision={onDecision} />);
		const btn = screen.getByText(/항상 허용|Always Allow/);
		fireEvent.click(btn);
		expect(onDecision).toHaveBeenCalledWith("always");
	});

	it("calls onDecision with 'reject' when reject clicked", () => {
		const onDecision = vi.fn();
		render(<PermissionModal pending={basePending} onDecision={onDecision} />);
		const btn = screen.getByText(/거부|Reject/);
		fireEvent.click(btn);
		expect(onDecision).toHaveBeenCalledWith("reject");
	});

	it("displays tool args as JSON", () => {
		render(<PermissionModal pending={basePending} onDecision={vi.fn()} />);
		// Args are rendered as JSON in a <pre> element
		const pre = screen.getByText(/command/);
		expect(pre).toBeDefined();
	});

	it("renders the title", () => {
		render(<PermissionModal pending={basePending} onDecision={vi.fn()} />);
		expect(
			screen.getByText(/도구 실행 승인|Tool Execution Approval/),
		).toBeDefined();
	});
});
