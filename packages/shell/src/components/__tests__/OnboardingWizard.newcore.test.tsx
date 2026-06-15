// UC-012 step-flow graft(step2) — newCore 컴포넌트 배선 검증(R2 리뷰 MEDIUM 닫기).
// 기존 OnboardingWizard.test.tsx 는 isNewCore=false(old 경로)만 검증 → newCore 분기
// (core()/buildStepInput/goNext submit mirror/assets/onNaiaAuthCallback/completeWith)가 무검증이었음.
// 여기서 isNewCore=true + spy session 으로 배선이 실제 호출되는지 앵커한다(실 core 흐름=onboarding-core.test.ts).
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));

// ★ newCore=true
vi.mock("../../lib/chat-service", () => ({
	sendAuthUpdate: vi.fn().mockResolvedValue(undefined),
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

	it("naia_auth_complete → core.onNaiaAuthCallback(naiaKey) 호출(게이트 해제 mirror)", () => {
		render(<OnboardingWizard onComplete={onComplete} />);
		act(() => {
			eventListeners.get("naia_auth_complete")?.({
				payload: { naiaKey: "gw-key", naiaUserId: "u1" },
			});
		});
		expect(session.onNaiaAuthCallback).toHaveBeenCalledWith("gw-key");
	});

	it("complete → core.completeWith(snapshot) 으로 영속", () => {
		render(<OnboardingWizard onComplete={onComplete} />);
		// welcome → ... → background (Next 6회)
		for (let i = 0; i < 6; i++) {
			fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
			flush();
		}
		// provider → skip "나중에 설정"
		fireEvent.click(screen.getByText(/나중에 설정/));
		flush();
		// complete → 시작하기
		fireEvent.click(screen.getByRole("button", { name: /시작하기|Get Started/ }));
		flush();
		expect(session.completeWith).toHaveBeenCalledTimes(1);
		const arg = session.completeWith.mock.calls[0][0] as Record<string, unknown>;
		expect(arg.onboardingComplete).toBe(true);
	});
});
