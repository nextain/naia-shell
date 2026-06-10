// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { panelRegistry } from "../../lib/panel-registry";
import { useChatStore } from "../../stores/chat";
import { usePanelStore } from "../../stores/panel";
import { ChatPanel } from "../ChatPanel";

// ─── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@tauri-apps/plugin-store", () => {
	const store = {
		get: vi.fn().mockResolvedValue(null),
		set: vi.fn().mockResolvedValue(undefined),
		delete: vi.fn().mockResolvedValue(undefined),
	};
	return { load: vi.fn().mockResolvedValue(store) };
});

vi.mock("../../lib/chat-service", () => ({
	sendChatMessage: vi.fn().mockResolvedValue(undefined),
	cancelChat: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
	convertFileSrc: vi.fn((p: string) => `asset://${p}`),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../../lib/gateway-sessions", () => ({
	getGatewayHistory: vi.fn().mockResolvedValue([]),
	resetGatewaySession: vi.fn().mockResolvedValue(true),
	patchGatewaySession: vi.fn().mockResolvedValue(true),
	discoverAndPersistDiscordDmChannel: vi.fn().mockResolvedValue(null),
}));

vi.stubGlobal(
	"Audio",
	class {
		src = "";
		onended: (() => void) | null = null;
		onerror: (() => void) | null = null;
		play() {
			return Promise.resolve();
		}
	},
);

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
	// isReadyToChat() reads localStorage — set an API key so ChatPanel defaults
	// to the "chat" tab (otherwise it defaults to "settings" and messages are hidden)
	localStorage.setItem(
		"naia-config",
		JSON.stringify({
			apiKey: "test-key",
			provider: "anthropic",
			model: "claude-opus-4-6",
		}),
	);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setAssistantMessage(content: string) {
	useChatStore.setState({
		messages: [
			{ id: "m1", role: "assistant" as const, content, timestamp: Date.now() },
		],
	});
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	localStorage.removeItem("naia-config");
	useChatStore.setState(useChatStore.getInitialState());
	usePanelStore.setState(usePanelStore.getInitialState());
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ChatPanel — file deep-links", () => {
	it("renders an absolute .ts file path as a clickable button", () => {
		setAssistantMessage(
			"수정한 파일은 /var/home/luke/dev/naia-os/shell/src/App.tsx 입니다.",
		);
		render(<ChatPanel />);
		const btn = screen.getByRole("button", {
			name: "/var/home/luke/dev/naia-os/shell/src/App.tsx",
		});
		expect(btn).toBeInTheDocument();
	});

	it("renders an absolute .png path as a deeplink button", () => {
		setAssistantMessage("스크린샷: /tmp/screenshot.png 확인해보세요.");
		render(<ChatPanel />);
		expect(
			screen.getByRole("button", { name: "/tmp/screenshot.png" }),
		).toBeInTheDocument();
	});

	it("clicking deeplink calls panelRegistry.getApi openFile with the path", () => {
		const mockOpenFile = vi.fn();
		vi.spyOn(panelRegistry, "getApi").mockReturnValue({
			openFile: mockOpenFile,
			focusSession: vi.fn(),
		} as never);

		setAssistantMessage("파일: /dev/project/data.csv 을 확인하세요.");
		render(<ChatPanel />);

		const btn = screen.getByRole("button", { name: "/dev/project/data.csv" });
		fireEvent.click(btn);

		expect(mockOpenFile).toHaveBeenCalledWith("/dev/project/data.csv");
	});

	it("clicking deeplink activates the workspace panel", () => {
		vi.spyOn(panelRegistry, "getApi").mockReturnValue({
			openFile: vi.fn(),
			focusSession: vi.fn(),
		} as never);

		setAssistantMessage("결과: /tmp/output.json");
		render(<ChatPanel />);

		fireEvent.click(screen.getByRole("button", { name: "/tmp/output.json" }));

		expect(usePanelStore.getState().activePanel).toBe("workspace");
	});

	it("does NOT render a deeplink for a relative path without leading slash", () => {
		setAssistantMessage("파일명: shell/src/App.tsx 참고.");
		render(<ChatPanel />);
		// No button for full relative path
		expect(
			screen.queryByRole("button", { name: "shell/src/App.tsx" }),
		).not.toBeInTheDocument();
		// No button for sub-path either — /src/App.tsx must NOT be extracted from shell/src/App.tsx
		expect(
			screen.queryByRole("button", { name: /\/src\/App\.tsx/ }),
		).not.toBeInTheDocument();
	});

	it("does NOT render deeplinks for paths in code blocks", () => {
		setAssistantMessage("```\n/var/home/luke/dev/App.tsx\n```");
		render(<ChatPanel />);
		// Path inside code block — code component, not p component — no button
		expect(
			screen.queryByRole("button", { name: /App\.tsx/ }),
		).not.toBeInTheDocument();
	});

	it("renders plain text segments unchanged alongside deeplink", () => {
		setAssistantMessage("앞 텍스트 /tmp/result.csv 뒤 텍스트");
		render(<ChatPanel />);
		const btn = screen.getByRole("button", { name: "/tmp/result.csv" });
		expect(btn).toBeInTheDocument();
		// Plain text segments are text nodes (not elements) inside the <p> —
		// check the surrounding paragraph's textContent instead.
		const para = btn.closest("p");
		expect(para?.textContent).toContain("앞 텍스트 ");
		expect(para?.textContent).toContain(" 뒤 텍스트");
	});

	it("renders multiple deeplinks in one message", () => {
		setAssistantMessage("파일 /tmp/a.ts 와 /tmp/b.rs 를 수정했습니다.");
		render(<ChatPanel />);
		expect(
			screen.getByRole("button", { name: "/tmp/a.ts" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "/tmp/b.rs" }),
		).toBeInTheDocument();
	});
});
