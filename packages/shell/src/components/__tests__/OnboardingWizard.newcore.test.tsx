// UC-012 step-flow graft(step2) — newCore 컴포넌트 배선 검증(R2 리뷰 MEDIUM 닫기).
// 기존 OnboardingWizard.test.tsx 는 isNewCore=false(old 경로)만 검증 → newCore 분기
// (core()/buildStepInput/goNext submit mirror/assets/onNaiaAuthCallback/completeWith)가 무검증이었음.
// 여기서 isNewCore=true + spy session 으로 배선이 실제 호출되는지 앵커한다(실 core 흐름=onboarding-core.test.ts).
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

// 단일 spy 세션(sessionRef 가 1회 캐시하므로 makeOnboardingSession 은 동일 객체 반환).
const session = vi.hoisted(() => ({
	assets: vi.fn().mockResolvedValue([]),
	submit: vi.fn().mockResolvedValue({ step: "welcome" }),
	onNaiaAuthCallback: vi.fn().mockResolvedValue({ step: "provider" }),
	currentStep: vi.fn(() => "welcome"),
	completeWith: vi.fn().mockResolvedValue(undefined),
}));
const secureStore = vi.hoisted(() => ({
	get: vi.fn().mockResolvedValue(null),
	set: vi.fn().mockResolvedValue(undefined),
	delete: vi.fn().mockResolvedValue(undefined),
}));
const reloadAgentSettings = vi.hoisted(() =>
	vi.fn().mockResolvedValue(undefined),
);
const sendAuthUpdateStrict = vi.hoisted(() =>
	vi.fn().mockResolvedValue(undefined),
);
const activateNaiaLlm = vi.hoisted(() =>
	vi.fn().mockResolvedValue({
		available: true,
		loaded: true,
		provider: "nextain",
		model: "deepseek-v4-flash",
		llm: "naia",
	}),
);

// FR-LLM-LOGOUT.1: 로그인 없이 끝내는 경로는 Ollama 를 확인한다. 테스트에서는 즉시 "LLM 없음"을 돌려준다.
vi.mock("../../lib/llm/logged-out-default", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/llm/logged-out-default")>()),
	resolveLoggedOutLlm: vi.fn(async () => ({ provider: "", model: "" })),
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn((command: string) =>
		command === "fetch_naia_balance"
			? Promise.resolve({ balance: 1_000_000 })
			: Promise.resolve(true),
	),
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
vi.mock("@tauri-apps/plugin-store", () => ({
	load: vi.fn().mockResolvedValue(secureStore),
}));

// ★ newCore=true
vi.mock("../../lib/chat-service", () => ({
	activateNaiaLlm,
	sendAuthUpdate: vi.fn().mockResolvedValue(undefined),
	sendAuthUpdateStrict,
	reloadAgentSettings,
	isNewCore: () => true,
}));
vi.mock("../../lib/onboarding-core", () => ({
	completeOnboardingNewCore: vi.fn().mockResolvedValue(undefined),
	makeOnboardingSession: vi.fn(() => session),
}));
vi.mock("../../lib/i18n", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../lib/i18n")>();
	return { ...actual, getLocale: () => "ko" as any };
});
vi.mock("../VrmPreview", () => ({
	VrmPreview: ({ modelPath }: { modelPath: string }) => (
		<div data-testid="vrm-preview" data-model={modelPath} />
	),
}));

import { OnboardingWizard } from "../OnboardingWizard";

describe("OnboardingWizard — newCore 배선(step-flow graft step2)", () => {
	const onComplete = vi.fn();

	beforeEach(() => {
		vi.useFakeTimers();
		for (const f of [
			session.assets,
			session.submit,
			session.onNaiaAuthCallback,
			session.completeWith,
		])
			f.mockClear();
	});
	afterEach(() => {
		vi.runAllTimers();
		vi.useRealTimers();
		cleanup();
		onComplete.mockReset();
		secureStore.get.mockClear();
		secureStore.set.mockClear();
		secureStore.delete.mockClear();
		reloadAgentSettings.mockReset();
		reloadAgentSettings.mockResolvedValue(undefined);
		eventListeners.clear();
		localStorage.clear();
	});

	function flush() {
		act(() => {
			vi.advanceTimersByTime(400);
		});
	}

	it("mount 시 assets(vrm-files)+assets(background) 를 core 경유 로딩", () => {
		render(<OnboardingWizard onComplete={onComplete} />);
		expect(session.assets).toHaveBeenCalledWith("vrm-files");
		expect(session.assets).toHaveBeenCalledWith("background");
	});

	it("goNext = 떠나는 step 의 buildStepInput 을 core.submit 으로 전송(forward mirror)", () => {
		render(<OnboardingWizard onComplete={onComplete} />);
		// welcome → Next
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();
		expect(session.submit).toHaveBeenCalledWith({ step: "welcome" });
		// agentName 입력 후 Next → {step:"agentName", agentName}
		fireEvent.change(screen.getByPlaceholderText("Naia"), {
			target: { value: "모치" },
		});
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();
		expect(session.submit).toHaveBeenCalledWith({
			step: "agentName",
			agentName: "모치",
		});
	});

	it("naia_auth_complete → core.onNaiaAuthCallback(naiaKey) 호출(게이트 해제 mirror)", async () => {
		localStorage.setItem("naia-adk-path", "/tmp/onboarding-newcore-adk");
		render(<OnboardingWizard onComplete={onComplete} />);
		// The handler is async now (#449: login also activates credits before
		// advancing to the voice step) — await its promise chain before asserting.
		await act(async () => {
			await eventListeners.get("naia_auth_complete")?.({
				payload: { naiaKey: "gw-key", naiaUserId: "u1" },
			});
		});
		expect(session.onNaiaAuthCallback).toHaveBeenCalledWith("gw-key", "/tmp/onboarding-newcore-adk");
	});

	it("complete → core.completeWith(snapshot) 으로 영속", async () => {
		render(<OnboardingWizard onComplete={onComplete} />);
		// welcome → ... → background (Next 6회)
		for (let i = 0; i < 6; i++) {
			fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
			flush();
		}
		// provider → skip "나중에 설정"
		fireEvent.click(screen.getByText(/나중에 설정|Set up later/));
		flush();
		// voice → Next
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();
		// complete → 시작하기 (handleComplete is async after saveConfigSecure — flush promise chain)
		fireEvent.click(
			screen.getByRole("button", { name: /시작하기|Get Started/ }),
		);
		await act(async () => {
			await Promise.resolve();
		});
		expect(session.completeWith).toHaveBeenCalledTimes(1);
		expect(reloadAgentSettings).toHaveBeenCalledTimes(1);
		const arg = session.completeWith.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(arg.onboardingComplete).toBe(true);
	});

	it("commits onboarding only after live Agent reload succeeds", async () => {
		let releaseReload!: () => void;
		reloadAgentSettings.mockReturnValueOnce(
			new Promise<void>((resolve) => {
				releaseReload = resolve;
			}),
		);
		render(<OnboardingWizard onComplete={onComplete} />);
		for (let i = 0; i < 6; i++) {
			fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
			flush();
		}
		fireEvent.click(screen.getByText(/나중에 설정|Set up later/));
		flush();
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();
		fireEvent.click(
			screen.getByRole("button", { name: /시작하기|Get Started/ }),
		);

		await act(async () => Promise.resolve());
		expect(reloadAgentSettings).toHaveBeenCalledTimes(1);
		expect(session.completeWith).not.toHaveBeenCalled();
		expect(onComplete).not.toHaveBeenCalled();
		expect(screen.getByRole("button")).toBeDisabled();

		await act(async () => {
			releaseReload();
			await Promise.resolve();
		});
		expect(sendAuthUpdateStrict).not.toHaveBeenCalled();
		expect(session.completeWith).toHaveBeenCalledTimes(1);
		expect(onComplete).not.toHaveBeenCalled();
	});

	it("keeps completion open and retries when Agent reload fails", async () => {
		reloadAgentSettings.mockRejectedValueOnce(new Error("agent unavailable"));
		render(<OnboardingWizard onComplete={onComplete} />);
		for (let i = 0; i < 6; i++) {
			fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
			flush();
		}
		fireEvent.click(screen.getByText(/나중에 설정|Set up later/));
		flush();
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();
		fireEvent.click(
			screen.getByRole("button", { name: /시작하기|Get Started/ }),
		);

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(screen.getByRole("alert")).toHaveTextContent(/다시 시도|try again/i);
		expect(onComplete).not.toHaveBeenCalled();
		const retry = screen.getByRole("button", {
			name: /시작하기|Get Started/,
		});
		expect(retry).toBeEnabled();
		fireEvent.click(retry);
		await act(async () => Promise.resolve());
		expect(reloadAgentSettings).toHaveBeenCalledTimes(2);
	});
});
