import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
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

vi.mock("../../lib/chat-service", () => ({
	sendAuthUpdate: vi.fn().mockResolvedValue(undefined),
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
		act(() => {
			vi.advanceTimersByTime(400);
		});
	}

	/**
	 * Render and advance past the welcome step (Naia Alpha intro, #313) to the
	 * first persona step (agentName). The persona-flow tests below assume
	 * agentName renders first; the welcome step is now step 0.
	 */
	function renderAtAgentName() {
		render(<OnboardingWizard onComplete={onComplete} />);
		// welcome → Next → agentName
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();
	}

	it("renders agentName step first", () => {
		renderAtAgentName();
		// First persona step is agentName — shows "Naia" placeholder input
		expect(screen.getByPlaceholderText("Naia")).toBeDefined();
		expect(screen.getByRole("button", { name: /다음|Next/ })).toBeDefined();
	});

	it("shows agentName input and advances to userName on Next", () => {
		renderAtAgentName();

		// First persona step: agentName
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();

		// Second step: userName — input with "Luke" placeholder
		expect(screen.getByPlaceholderText("Luke")).toBeDefined();
	});

	it("progresses through steps: agentName → userName → speechStyle → character → background → provider", () => {
		renderAtAgentName();

		// agentName → Next
		fireEvent.change(screen.getByPlaceholderText("Naia"), {
			target: { value: "Mochi" },
		});
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();

		// userName → Next
		fireEvent.change(screen.getByPlaceholderText("Luke"), {
			target: { value: "Luke" },
		});
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
		renderAtAgentName();

		// agentName step: Next button should not be disabled
		const nextBtn = screen.getByRole("button", {
			name: /다음|Next/,
		}) as HTMLButtonElement;
		expect(nextBtn.disabled).toBe(false);

		// Click Next without filling agentName → advances to userName step
		fireEvent.click(nextBtn);
		flush();
		expect(screen.getByPlaceholderText("Luke")).toBeDefined();
	});

	it("complete step calls onComplete and saves config", () => {
		renderAtAgentName();

		// agentName
		fireEvent.change(screen.getByPlaceholderText("Naia"), {
			target: { value: "Mochi" },
		});
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();

		// userName
		fireEvent.change(screen.getByPlaceholderText("Luke"), {
			target: { value: "Luke" },
		});
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
		fireEvent.click(
			screen.getByRole("button", { name: /시작하기|Get Started/ }),
		);
		flush();

		// Wait for the 1200ms onComplete setTimeout
		act(() => {
			vi.advanceTimersByTime(1300);
		});

		expect(onComplete).toHaveBeenCalled();

		const config = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(config.userName).toBe("Luke");
		expect(config.agentName).toBe("Mochi");
		expect(config.onboardingComplete).toBe(true);
		expect(config.persona).toContain("Mochi");
	});

	it("completes onboarding immediately after Naia login succeeds", () => {
		localStorage.setItem("naia-adk-path", "D:\\alpha-adk\\projects\\naia-adk");
		renderAtAgentName();

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

		act(() => {
			eventListeners.get("naia_auth_complete")?.({
				payload: { naiaKey: "gw-test-key", naiaUserId: "user-1" },
			});
		});

		// auth_complete advances to the complete step (no agentName input there);
		// config save + onComplete fire when the user clicks "시작하기"
		// (handleComplete → setTimeout(onComplete, 1200)). #313 added the welcome
		// step but the login→complete→start flow is unchanged.
		expect(screen.queryByPlaceholderText("Naia")).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: /시작하기|Get Started/ }),
		);
		flush();
		act(() => {
			vi.advanceTimersByTime(1300);
		});

		expect(onComplete).toHaveBeenCalled();

		const config = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(config.onboardingComplete).toBe(true);
		expect(config.naiaKey).toBe("gw-test-key");
		expect(config.naiaUserId).toBe("user-1");
		expect(config.userName).toBe("Luke");
		expect(config.agentName).toBe("Mochi");
		expect(config.workspaceRoot).toBe("D:\\alpha-adk\\projects\\naia-adk");
	});

	// #341 옵션 B (W1) — naia 로그인 OAuth URL 빌더 검증
	// Linux dev:tauri 에서 `naia://` scheme OS 미등록 우회 path. 운영 웹이
	// redirect_uri 받으면 그 URL 로 redirect; 받지 못해도 기존 deep-link path 가
	// fallback. 클라이언트 측은 무조건 redirect_uri 명시 + state CSRF token
	// 동봉. 운영 웹 contract = W9 별 협의 (서버 측 redirect_uri 화이트리스트).
	describe("#341 옵션 B — naia 로그인 OAuth URL", () => {
		// provider step 에서 "Naia 로그인" 버튼 render 조건이 provider 선택 후
		// 보이는 분기라 기본 render 만으로 잡히지 않음. cycle 내 follow-up =
		// provider 사전 설정 + step navigation 정확히. 지금은 listener path
		// 검증 (test #2) 만 의무 + component-level URL builder = TODO.
		it.skip("handleNaiaLogin 호출 시 redirect_uri + state CSRF token 포함된 URL 로 system browser 열어야", async () => {
			const { invoke } = await import("@tauri-apps/api/core");
			const { openUrl } = await import("@tauri-apps/plugin-opener");

			// generate_oauth_state Rust command mock — fixed CSRF token
			(invoke as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
				if (cmd === "generate_oauth_state") {
					return Promise.resolve("csrf-test-token-abc123");
				}
				return Promise.resolve(true);
			});

			render(<OnboardingWizard onComplete={onComplete} />);

			// agentName → userName → speechStyle → character → background → provider
			for (let i = 0; i < 5; i++) {
				fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
				flush();
			}

			// provider step: "Naia 로그인" 버튼 (i18n key onboard.lab.login, ko = "Naia 로그인")
			const naiaLoginBtn = screen.getByRole("button", {
				name: /Naia 로그인|Naia Login/,
			});
			fireEvent.click(naiaLoginBtn);

			// async handleNaiaLogin → await invoke + await openUrl
			await act(async () => {
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(openUrl).toHaveBeenCalledTimes(1);
			const calledUrl = (openUrl as ReturnType<typeof vi.fn>).mock
				.calls[0][0] as string;

			// 검증: redirect_uri 명시 + state CSRF + redirect=desktop + source=desktop
			expect(calledUrl).toContain("naia.nextain.io");
			expect(calledUrl).toContain("/login?");
			expect(calledUrl).toContain(
				"redirect_uri=http%3A%2F%2F127.0.0.1%3A18792%2Fauth%2Fcallback",
			);
			expect(calledUrl).toContain("state=csrf-test-token-abc123");
			expect(calledUrl).toContain("redirect=desktop");
			expect(calledUrl).toContain("source=desktop");
		});

		it("naia_auth_complete event 수신 시 naiaKey + naiaUserId localStorage 저장 + complete step 진입", async () => {
			render(<OnboardingWizard onComplete={onComplete} />);

			// 시뮬레이트: Rust callback server (또는 deep link) 가
			// naia_auth_complete event emit. listener 가 mount 시 등록되므로
			// step 진행 없이도 작동해야 한다 (= http callback 도 같은 listener
			// 호출, deep-link path 와 동등).
			const listener = eventListeners.get("naia_auth_complete");
			expect(listener).toBeDefined();
			act(() => {
				listener?.({
					payload: {
						naiaKey: "gw-test-key-from-http-callback",
						naiaUserId: "user-via-http",
					},
				});
			});

			await act(async () => {
				await Promise.resolve();
				await Promise.resolve();
			});

			// naiaKey + naiaUserId localStorage 저장 검증 (HTTP callback path 와
			// deep-link path 가 동일하게 처리)
			expect(localStorage.getItem("naia-remote-key")).toBe(
				"gw-test-key-from-http-callback",
			);
			expect(localStorage.getItem("naia-remote-user-id")).toBe("user-via-http");
			// onComplete 자체는 "시작하기" 버튼에서 호출되므로 listener 만으로는
			// 부르지 않음 (별 step 진행). 여기서는 localStorage 저장까지만 검증.
		});
	});
});
