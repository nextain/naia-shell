import { cleanup, render, waitFor } from "@testing-library/react";
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const eventListeners = vi.hoisted(
	() => new Map<string, (event: { payload: any }) => void>(),
);
const secureStore = vi.hoisted(() => ({
	get: vi.fn().mockResolvedValue(null),
	set: vi.fn().mockResolvedValue(undefined),
	delete: vi.fn().mockResolvedValue(undefined),
}));

// Mock Tauri invoke
const loggedOutMocks = vi.hoisted(() => ({
	resolveLoggedOutLlm: vi.fn(async () => ({ provider: "", model: "" })),
}));
vi.mock("../../lib/llm/logged-out-default", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../lib/llm/logged-out-default")
	>()),
	resolveLoggedOutLlm: loggedOutMocks.resolveLoggedOutLlm,
}));

vi.mock("../../lib/voice/host-profile", () => ({
	// 이 테스트들이 흉내 내는 기계는 카드 한 장짜리 Windows 다 (#537).
	// 프로파일 이름은 하드웨어 사실이라 화면이 아니라 여기서 정한다.
	voiceHostProfile: () =>
		Promise.resolve({
			profile: "windows_trt_6g",
			gpus: [{ index: 0, freeMib: 8192, totalMib: 8192 }],
			gpuChoiceIsMeaningful: false,
			defaultGpuIndex: 0,
		}),
	resetVoiceHostProfileCache: () => {},
}));

const chan = vi.hoisted(() => ({ value: "steam" }));
const defaultInvoke = vi.hoisted(
	() => (command: string) =>
		command === "get_distribution_channel"
			? Promise.resolve(chan.value)
			: command === "fetch_naia_balance"
				? Promise.resolve({ balance: 1_000_000 })
				: command === "secure_store_get"
					? Promise.resolve(null)
					: command === "read_naia_ui_config"
						? Promise.resolve("{}")
						: Promise.resolve(true),
);

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(defaultInvoke),
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

vi.mock("../../lib/chat-service", () => ({
	activateNaiaLlm: vi.fn().mockResolvedValue({
		available: true,
		loaded: true,
		provider: "nextain",
		model: "deepseek-v4-flash",
		llm: "naia",
	}),
	sendAuthUpdate: vi.fn().mockResolvedValue(undefined),
	sendAuthUpdateStrict: vi.fn().mockResolvedValue(undefined),
	reloadAgentSettings: vi.fn().mockResolvedValue(undefined),
	isNewCore: () => false, // 기본 old 경로(비파괴 graft) — new-core graft 검증은 onboarding-core.test.ts
}));
vi.mock("../../lib/onboarding-core", () => ({
	completeOnboardingNewCore: vi.fn().mockResolvedValue(undefined),
	// isNewCore=false 라 core() 는 null → makeOnboardingSession 미호출. 안전상 stub 제공.
	makeOnboardingSession: vi.fn(() => ({
		assets: vi.fn().mockResolvedValue([]),
		submit: vi.fn().mockResolvedValue({ step: "welcome" }),
		onNaiaAuthCallback: vi.fn().mockResolvedValue({ step: "provider" }),
		currentStep: () => "welcome",
		completeWith: vi.fn().mockResolvedValue(undefined),
	})),
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

import { resetDistributionChannelForTests } from "../../lib/distribution";
import { OnboardingWizard } from "../OnboardingWizard";

const DONATION = "[data-testid=onboarding-discord-connect-btn]";

// #727: the welcome-step donation button opens the naia.land donation page, a
// web payment path. It must not render on Steam or while the channel is unknown.
describe("OnboardingWizard donation button (#727)", () => {
	beforeEach(() => resetDistributionChannelForTests());
	afterEach(() => cleanup());

	async function renderWelcome(channel: string) {
		chan.value = channel;
		const view = render(<OnboardingWizard onComplete={() => {}} />);
		// The discord button sits beside the donation button in the same row.
		await waitFor(() =>
			expect(view.container.querySelector(DONATION)).not.toBeNull(),
		);
		await new Promise((r) => setTimeout(r, 30));
		const row = view.container.querySelector(DONATION)!.parentElement!;
		return row.querySelectorAll("button").length;
	}

	it("renders the donation button on the standard channel", async () => {
		const standard = await renderWelcome("standard");
		cleanup();
		resetDistributionChannelForTests();
		expect(await renderWelcome("steam")).toBe(standard - 1);
	});

	it("hides it when the channel is unknown (fail closed)", async () => {
		const standard = await renderWelcome("standard");
		cleanup();
		resetDistributionChannelForTests();
		expect(await renderWelcome("bogus")).toBe(standard - 1);
	});
});
