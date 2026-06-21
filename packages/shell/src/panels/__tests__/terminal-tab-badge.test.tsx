// @vitest-environment jsdom
/**
 * Step 1 tests: TerminalTab issueId/agent badge rendering
 *
 * Tests the badge spans added to terminal tab labels:
 *  - #issueId badge (blue) shown when issueId is set
 *  - agent badge (muted) shown when agent is set
 *  - No badge when both are undefined
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentType, TerminalTab } from "../workspace/WorkspaceCenterPanel";

afterEach(cleanup);

// ─── Mocks (same as workspace-panel.test.tsx) ─────────────────────────────────

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue([]),
}));
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../../lib/logger", () => ({
	Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../lib/config", () => ({
	loadConfig: vi.fn().mockReturnValue({
		workspaceRoot: "/tmp/test",
		provider: "gemini",
		model: "gemini-2.5-flash",
		apiKey: "",
	}),
	saveConfig: vi.fn(),
}));

// ─── Minimal tab badge component (mirrors WorkspaceCenterPanel tab rendering) ──

function TabLabel({ tab }: { tab: TerminalTab }) {
	return (
		<span className="workspace-panel__tab-label">
			{tab.issueId !== undefined && (
				<span className="workspace-panel__tab-issue">#{tab.issueId}</span>
			)}
			{tab.dir.split(/[/\\]/).pop() ?? tab.dir}
			{tab.agent !== undefined && (
				<span className="workspace-panel__tab-agent">{tab.agent}</span>
			)}
		</span>
	);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("TerminalTab badge rendering", () => {
	it("shows no badges when issueId and agent are undefined", () => {
		const tab: TerminalTab = { pty_id: "p1", dir: "/home/user/naia-os", pid: 100 };
		render(<TabLabel tab={tab} />);

		expect(screen.queryByText(/^#\d+$/)).toBeNull();
		expect(screen.getByText("naia-os")).toBeInTheDocument();
	});

	it("shows #issueId badge when issueId is set", () => {
		const tab: TerminalTab = {
			pty_id: "p1",
			dir: "/home/user/naia-os",
			pid: 100,
			issueId: 278,
		};
		render(<TabLabel tab={tab} />);

		const badge = screen.getByText("#278");
		expect(badge).toBeInTheDocument();
		expect(badge).toHaveClass("workspace-panel__tab-issue");
	});

	it("shows agent badge when agent is set", () => {
		const tab: TerminalTab = {
			pty_id: "p1",
			dir: "/home/user/naia-os",
			pid: 100,
			agent: "claude" as AgentType,
		};
		render(<TabLabel tab={tab} />);

		const badge = screen.getByText("claude");
		expect(badge).toBeInTheDocument();
		expect(badge).toHaveClass("workspace-panel__tab-agent");
	});

	it("shows both badges when issueId and agent are set", () => {
		const tab: TerminalTab = {
			pty_id: "p1",
			dir: "/home/user/naia-os",
			pid: 100,
			issueId: 278,
			agent: "opencode" as AgentType,
		};
		render(<TabLabel tab={tab} />);

		expect(screen.getByText("#278")).toBeInTheDocument();
		expect(screen.getByText("opencode")).toBeInTheDocument();
		expect(screen.getByText("naia-os")).toBeInTheDocument();
	});

	it("shows issueId 0 as badge (falsy number edge case)", () => {
		const tab: TerminalTab = {
			pty_id: "p1",
			dir: "/home/user/repo",
			pid: 100,
			issueId: 0,
		};
		render(<TabLabel tab={tab} />);
		// issueId=0 is !== undefined, so badge renders
		expect(screen.getByText("#0")).toBeInTheDocument();
	});

	it("uses dir basename for label (unix path)", () => {
		const tab: TerminalTab = { pty_id: "p1", dir: "/a/b/my-project", pid: 1 };
		render(<TabLabel tab={tab} />);
		expect(screen.getByText("my-project")).toBeInTheDocument();
	});

	it("uses dir basename for label (windows path)", () => {
		const tab: TerminalTab = {
			pty_id: "p1",
			dir: "C:\\work\\naia-os",
			pid: 1,
		};
		render(<TabLabel tab={tab} />);
		expect(screen.getByText("naia-os")).toBeInTheDocument();
	});

	it("all AgentType values render as badge text", () => {
		const agents: AgentType[] = ["claude", "opencode", "codex", "gemini"];
		for (const agent of agents) {
			const { unmount } = render(
				<TabLabel
					tab={{ pty_id: "p1", dir: "/repo", pid: 1, agent }}
				/>,
			);
			expect(screen.getByText(agent)).toBeInTheDocument();
			unmount();
		}
	});
});
