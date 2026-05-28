import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const eventListeners = vi.hoisted(
	() => new Map<string, (event: { payload: any }) => void>(),
);

// Mock Tauri invoke
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue(true),
	convertFileSrc: vi.fn((path: string) => `file://${path}`),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn((event: string, handler: (event: { payload: any }) => void) => {
		eventListeners.set(event, handler);
		return Promise.resolve(() => eventListeners.delete(event));
	}),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
	openUrl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn().mockResolvedValue(null),
}));

// #337 Phase 6c — chat-service no longer exports sendAuthUpdate; the test
// no longer needs to mock anything from this module. agent-ipc handles the
// post-login forwarding now.
vi.mock("../../lib/agent-ipc", () => ({
	agentAuthReceived: vi.fn().mockResolvedValue({ ok: true }),
}));

// Mock getLocale to return "ko" so Korean strings are used
vi.mock("../../lib/i18n", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../lib/i18n")>();
	return { ...actual, getLocale: () => "ko" as any };
});

// Mock VrmPreview (Three.js doesn't work in jsdom)
vi.mock("../VrmPreview", () => ({
	VrmPreview: ({ modelPath }: { modelPath: string }) => (
		<div data-testid="vrm-preview" data-model={modelPath} />
	),
}));

import { OnboardingWizard } from "../OnboardingWizard";

// Step order (without Naia key): agentName → userName → speechStyle → character → background → provider → complete
// goNext() sets transitioning.current = true; a 300ms timeout resets it.
// Use fake timers + act to advance through transitions.

describe("OnboardingWizard", () => {
	const onComplete = vi.fn();

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.runAllTimers();
		vi.useRealTimers();
		cleanup();
		onComplete.mockReset();
		eventListeners.clear();
		localStorage.removeItem("naia-config");
		localStorage.removeItem("naia-adk-path");
		localStorage.removeItem("naia-remote-key");
	});

	/** Advance past the goNext() 300ms transition lock. */
	function flush() {
		act(() => { vi.advanceTimersByTime(400); });
	}

	it("renders agentName step first", () => {
		render(<OnboardingWizard onComplete={onComplete} />);
		// First step is agentName — shows "Naia" placeholder input
		expect(screen.getByPlaceholderText("Naia")).toBeDefined();
		expect(screen.getByRole("button", { name: /다음|Next/ })).toBeDefined();
	});

	it("shows agentName input and advances to userName on Next", () => {
		render(<OnboardingWizard onComplete={onComplete} />);

		// First step: agentName
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();

		// Second step: userName — input with "Luke" placeholder
		expect(screen.getByPlaceholderText("Luke")).toBeDefined();
	});

	it("progresses through steps: agentName → userName → speechStyle → character → background → provider", () => {
		render(<OnboardingWizard onComplete={onComplete} />);

		// agentName → Next
		fireEvent.change(screen.getByPlaceholderText("Naia"), { target: { value: "Mochi" } });
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();

		// userName → Next
		fireEvent.change(screen.getByPlaceholderText("Luke"), { target: { value: "Luke" } });
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();

		// speechStyle → Next
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();

		// character step (no VRMs → shows empty state warning)
		expect(screen.getAllByText(/VRM/i).length).toBeGreaterThan(0);
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();

		// background → Next
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();

		// provider step — shows the skip link "나중에 설정"
		expect(screen.getByText(/나중에 설정/)).toBeDefined();
	});

	it("Next button is always enabled (agentName is optional)", () => {
		render(<OnboardingWizard onComplete={onComplete} />);

		// First step: Next button should not be disabled
		const nextBtn = screen.getByRole("button", { name: /다음|Next/ }) as HTMLButtonElement;
		expect(nextBtn.disabled).toBe(false);

		// Click Next without filling agentName → advances to userName step
		fireEvent.click(nextBtn);
		flush();
		expect(screen.getByPlaceholderText("Luke")).toBeDefined();
	});

	it("complete step calls onComplete and saves config", () => {
		render(<OnboardingWizard onComplete={onComplete} />);

		// agentName
		fireEvent.change(screen.getByPlaceholderText("Naia"), { target: { value: "Mochi" } });
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();

		// userName
		fireEvent.change(screen.getByPlaceholderText("Luke"), { target: { value: "Luke" } });
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();

		// speechStyle
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();

		// character
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();

		// background
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();

		// provider → skip via "나중에 설정"
		fireEvent.click(screen.getByText(/나중에 설정/));
		flush();

		// complete → click "시작하기"
		fireEvent.click(screen.getByRole("button", { name: /시작하기|Get Started/ }));
		flush();

		// Wait for the 1200ms onComplete setTimeout
		act(() => { vi.advanceTimersByTime(1300); });

		expect(onComplete).toHaveBeenCalled();

		const config = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(config.userName).toBe("Luke");
		expect(config.agentName).toBe("Mochi");
		expect(config.onboardingComplete).toBe(true);
		expect(config.persona).toContain("Mochi");
	});

	it("completes onboarding immediately after Naia login succeeds", () => {
		localStorage.setItem("naia-adk-path", "D:\\alpha-adk\\projects\\naia-adk");
		render(<OnboardingWizard onComplete={onComplete} />);

		const clickNext = () => {
			const buttons = screen.getAllByRole("button");
			const next = buttons.find((button) =>
				button.className.includes("onboarding-step__next-btn"),
			);
			expect(next).toBeDefined();
			fireEvent.click(next!);
			flush();
		};

		fireEvent.change(screen.getByPlaceholderText("Naia"), {
			target: { value: "Mochi" },
		});
		clickNext();

		fireEvent.change(screen.getByPlaceholderText("Luke"), {
			target: { value: "Luke" },
		});
		clickNext();
		clickNext();
		clickNext();
		clickNext();

		const loginButton = screen
			.getAllByRole("button")
			.find((button) => button.textContent?.includes("Naia"));
		expect(loginButton).toBeDefined();
		fireEvent.click(loginButton!);

		// #337 Phase 10-pre cross-review CRITICAL #1: the Rust payload no
		// longer carries `naiaKey`/`naiaUserId` — only `deepLinkUrl`. The
		// agent persists those into the encrypted ADK auth file. The wizard
		// only needs the arrival signal to advance to the complete step.
		act(() => {
			eventListeners.get("naia_auth_complete")?.({
				payload: { deepLinkUrl: "naia://auth?key=gw-test-key&user_id=user-1" },
			});
		});

		expect(onComplete).toHaveBeenCalled();
		expect(screen.queryByPlaceholderText("Naia")).toBeNull();

		const config = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(config.onboardingComplete).toBe(true);
		// Post-#337: naiaKey + naiaUserId must NOT be written to localStorage
		// by the onboarding wizard. The agent owns both via the encrypted
		// auth file.
		expect(config.naiaKey).toBeUndefined();
		expect(config.naiaUserId).toBeUndefined();
		expect(config.userName).toBe("Luke");
		expect(config.agentName).toBe("Mochi");
		expect(config.workspaceRoot).toBe("D:\\alpha-adk\\projects\\naia-adk");
	});
});

