import { invoke } from "@tauri-apps/api/core";
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
const secureStore = vi.hoisted(() => ({
	get: vi.fn().mockResolvedValue(null),
	set: vi.fn().mockResolvedValue(undefined),
	delete: vi.fn().mockResolvedValue(undefined),
}));

// Mock Tauri invoke
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

const defaultInvoke = vi.hoisted(
	() => (command: string) =>
		command === "fetch_naia_balance"
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

import { useAppStore } from "../../stores/app";
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
		vi.unstubAllGlobals();
		vi.runAllTimers();
		vi.useRealTimers();
		cleanup();
		onComplete.mockReset();
		secureStore.get.mockReset();
		secureStore.get.mockResolvedValue(null);
		secureStore.set.mockClear();
		secureStore.delete.mockClear();
		(invoke as ReturnType<typeof vi.fn>).mockClear();
		(invoke as ReturnType<typeof vi.fn>).mockImplementation(defaultInvoke);
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

	function clickNextByClass() {
		const buttons = screen.getAllByRole("button");
		const next = buttons.find((button) =>
			button.className.includes("onboarding-step__next-btn"),
		);
		expect(next).toBeDefined();
		fireEvent.click(next!);
		flush();
	}

	function advanceFromAgentNameToProvider() {
		fireEvent.change(screen.getByPlaceholderText("Naia"), {
			target: { value: "Mochi" },
		});
		clickNextByClass();

		fireEvent.change(
			screen.getByPlaceholderText(/Enter a name|이름을 입력하세요/),
			{
				target: { value: "Alex" },
			},
		);
		clickNextByClass();
		clickNextByClass();
		clickNextByClass();
		clickNextByClass();
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

		// Second step: userName — generic localized placeholder
		expect(
			screen.getByPlaceholderText(/Enter a name|이름을 입력하세요/),
		).toBeDefined();
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
		fireEvent.change(
			screen.getByPlaceholderText(/Enter a name|이름을 입력하세요/),
			{
				target: { value: "Alex" },
			},
		);
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

		// provider step — shows the skip link
		expect(screen.getByText(/Set up later/)).toBeDefined();
	});

	it("restores the Naia gate from the selected ADK without localStorage", async () => {
		localStorage.setItem("naia-adk-path", "/adk-a");
		(invoke as ReturnType<typeof vi.fn>).mockImplementation(
			(command: string) =>
				command === "secure_store_get"
					? Promise.resolve("adk-a-key")
					: defaultInvoke(command),
		);

		renderAtAgentName();
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		advanceFromAgentNameToProvider();

		expect(screen.getByTestId("onboarding-next")).toBeDefined();
		expect(
			screen.queryByRole("button", { name: /Naia 로그인|Naia Login/ }),
		).toBeNull();
		expect(localStorage.getItem("naia-remote-key")).toBeNull();
	});

	it("does not apply a deferred key after switching from one ADK to another", async () => {
		let resolveA!: (value: string | null) => void;
		const deferredA = new Promise<string | null>((resolve) => {
			resolveA = resolve;
		});
		(invoke as ReturnType<typeof vi.fn>).mockImplementation(
			(command: string, args?: { expectedStorePath?: string }) => {
				if (command !== "secure_store_get") return defaultInvoke(command);
				if (args?.expectedStorePath?.includes("/adk-a/")) return deferredA;
				return Promise.resolve(null);
			},
		);

		localStorage.setItem("naia-adk-path", "/adk-a");
		renderAtAgentName();
		await act(async () => {
			await Promise.resolve();
		});

		localStorage.setItem("naia-adk-path", "/adk-b");
		act(() => {
			window.dispatchEvent(new Event("naia-adk-path-changed"));
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		await act(async () => {
			resolveA("stale-a-key");
			await Promise.resolve();
			await Promise.resolve();
		});
		advanceFromAgentNameToProvider();

		expect(screen.queryByTestId("onboarding-next")).toBeNull();
		expect(
			screen.getByRole("button", {
				name: /Start with Naia|Naia 로그인|Naia Login/,
			}),
		).toBeDefined();
	});

	it("shows that detected GPU voice choices live in Voice Settings", async () => {
		const { invoke } = await import("@tauri-apps/api/core");
		(invoke as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
			if (cmd === "detect_gpu_vram") return Promise.resolve(16);
			return defaultInvoke(cmd);
		});

		renderAtAgentName();
		await act(async () => {
			await Promise.resolve();
		});

		advanceFromAgentNameToProvider();

		expect(screen.getByText(/Detected VRAM: 16 GB/)).toBeDefined();
		expect(
			screen.getByText(/choose local and reference voices in Voice Settings/),
		).toBeDefined();
		expect(
			screen.getByText(/does not download or launch local models/),
		).toBeDefined();
	});

	it("offers installed NVA appearances independently of the GPU profile", async () => {
		const { invoke } = await import("@tauri-apps/api/core");
		const preview = vi.fn();
		window.addEventListener("naia-avatar-preview", preview);
		localStorage.setItem("naia-adk-path", "D:\\alpha-adk");
		(invoke as ReturnType<typeof vi.fn>).mockImplementation(
			(cmd: string, args?: { subdir?: string }) => {
				if (cmd === "detect_gpu_vram") return Promise.resolve(8);
				if (cmd === "list_naia_assets") {
					return Promise.resolve(
						args?.subdir === "nva-files"
							? ["alpha", "naia", "naia-prebaked"]
							: [],
					);
				}
				return defaultInvoke(cmd);
			},
		);

		renderAtAgentName();
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();

		expect(preview).toHaveBeenCalledWith(
			expect.objectContaining({
				detail: { provider: "naia-video-avatar", model: "naia" },
			}),
		);
		const cards = screen.getAllByRole("button", { name: /NVA/ });
		expect(cards).toHaveLength(3);
		const defaultNaia = cards.find(
			(card) => card.textContent?.replace("NVA", "").trim() === "naia",
		);
		expect(defaultNaia?.className).toContain("selected");
		expect(screen.getAllByText("NVA")).toHaveLength(3);

		const nva = screen.getByRole("button", { name: /naia-prebaked/ });
		fireEvent.click(nva);
		expect(nva.className).toContain("selected");

		clickNextByClass();
		clickNextByClass();
		fireEvent.click(screen.getByText(/Set up later/));
		flush();
		clickNextByClass(); // voice step
		fireEvent.click(
			screen.getByRole("button", { name: /시작하기|Get Started/ }),
		);
		await act(async () => {
			await Promise.resolve();
		});

		const config = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(config.avatarProvider).toBe("naia-video-avatar");
		expect(config.nvaModel).toMatch(/naia-prebaked$/);
		expect(config.localGpuTier).toBeUndefined();
		window.removeEventListener("naia-avatar-preview", preview);
	});

	it("uses a video frame instead of a play glyph for video backgrounds", async () => {
		const { invoke } = await import("@tauri-apps/api/core");
		localStorage.setItem("naia-adk-path", "D:\\alpha-adk");
		(invoke as ReturnType<typeof vi.fn>).mockImplementation(
			(cmd: string, args?: { subdir?: string }) => {
				if (cmd === "list_naia_assets") {
					return Promise.resolve(
						args?.subdir === "background" ? ["space.webm"] : [],
					);
				}
				return defaultInvoke(cmd);
			},
		);

		renderAtAgentName();
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		for (let index = 0; index < 4; index += 1) {
			fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
			flush();
		}

		expect(screen.getByLabelText("space")).toBeDefined();
		expect(screen.queryByText("▶")).toBeNull();
	});

	// #447-5: own-key/provider setup left onboarding. "직접 설정" now finishes
	// onboarding with the Naia-account default and opens the full Settings screen
	// (which owns provider + model + key) — it never collects a provider-less key.
	it("routes 'Direct setup' to Settings and completes onboarding without a BYO key", async () => {
		const { invoke } = await import("@tauri-apps/api/core");
		(invoke as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
			if (cmd === "detect_gpu_vram") return Promise.resolve(16);
			return defaultInvoke(cmd);
		});
		useAppStore.getState().setActiveApp(null);

		renderAtAgentName();
		await act(async () => {
			await Promise.resolve();
		});
		advanceFromAgentNameToProvider();

		// The provider-less inline BYO key entry is gone.
		expect(screen.queryByPlaceholderText("sk-... / gw-...")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /Direct setup/ }));
		await act(async () => {
			await Promise.resolve();
		});
		act(() => {
			vi.advanceTimersByTime(1300);
		});

		const config = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(config.provider).toBe("nextain"); // Naia-account default, not a BYO provider
		expect(config.apiKey).toBeUndefined();
		expect(config.naiaKey).toBeUndefined();
		expect(config.onboardingComplete).toBe(true);
		expect(secureStore.set).not.toHaveBeenCalledWith(
			"apiKey",
			expect.anything(),
		);
		// Settings screen is focused for the user to configure a provider.
		expect(useAppStore.getState().activeApp).toBe("settings");
	});

	it("actually starts VoxCPM2 from the voice step instead of only saving a preference", async () => {
		localStorage.setItem("naia-adk-path", "/adk-voxcpm2");
		const { invoke } = await import("@tauri-apps/api/core");
		let installed = false;
		let cascadeStarted = false;
		(invoke as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
			if (cmd === "detect_gpu_vram") return Promise.resolve(16);
			if (cmd === "voxcpm2_installation_status") {
				return Promise.resolve({
					phase: cascadeStarted ? "ready" : "ready-to-start",
					ready: cascadeStarted,
					canStart: installed,
					summary: "ok",
					steps: installed ? [] : [{ actionAvailable: true }],
				});
			}
			if (cmd === "install_voxcpm2_runtime") {
				installed = true;
				return Promise.resolve(true);
			}
			if (cmd === "start_voxcpm2") {
				cascadeStarted = true;
				return Promise.resolve(
					JSON.stringify({
						facade_port: 8910,
						services: [{ kind: "tts" }],
					}),
				);
			}
			return defaultInvoke(cmd);
		});

		renderAtAgentName();
		await act(async () => {
			await Promise.resolve();
		});
		advanceFromAgentNameToProvider();
		const loginButton = screen
			.getAllByRole("button")
			.find((button) => button.textContent?.includes("Naia"));
		expect(loginButton).toBeDefined();
		fireEvent.click(loginButton!);
		act(() => {
			eventListeners.get("naia_auth_complete")?.({
				payload: { naiaKey: "gw-member", naiaUserId: "member-1" },
			});
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		// voice step
		expect(screen.getByText(/GPU detected/)).toBeDefined();
		const localToggle = screen.getByRole("button", {
			name: /Turn on host voice/,
		});
		fireEvent.click(localToggle);
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(invoke).toHaveBeenCalledWith("start_voxcpm2", {
			expectedLoaderProfile: "windows_trt_6g",
			// 고르지 않은 기본 상태 — 런타임이 여유로 고른다 (#537).
			gpuIndex: null,
		});
		expect(invoke).toHaveBeenCalledWith("install_voxcpm2_runtime");
		expect(screen.getByRole("button", { name: /Host voice on/ })).toBeDefined();

		clickNextByClass();
		fireEvent.click(
			screen.getByRole("button", { name: /시작하기|Get Started/ }),
		);
		await act(async () => {
			await Promise.resolve();
		});

		const config = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(config.ttsProvider).toBe("naia-local-voice");
		expect(config.localVoiceEnabled).toBe(true);
		expect(config.ttsEnabled).toBe(true);
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
		expect(
			screen.getByPlaceholderText(/Enter a name|이름을 입력하세요/),
		).toBeDefined();
	});

	it("complete step calls onComplete and saves config", async () => {
		renderAtAgentName();

		// agentName
		fireEvent.change(screen.getByPlaceholderText("Naia"), {
			target: { value: "Mochi" },
		});
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();

		// userName
		fireEvent.change(
			screen.getByPlaceholderText(/Enter a name|이름을 입력하세요/),
			{
				target: { value: "Alex" },
			},
		);
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

		// provider → skip via "Set up later"
		fireEvent.click(screen.getByText(/Set up later/));
		flush();

		// voice → Next
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();

		// complete → click "시작하기"
		fireEvent.click(
			screen.getByRole("button", { name: /시작하기|Get Started/ }),
		);
		await act(async () => {
			await Promise.resolve();
		});

		// Wait for the 1200ms onComplete setTimeout
		act(() => {
			vi.advanceTimersByTime(1300);
		});

		expect(onComplete).toHaveBeenCalled();

		const config = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(config.userName).toBe("Alex");
		expect(config.agentName).toBe("Mochi");
		expect(config.onboardingComplete).toBe(true);
		expect(config.persona).toContain("Mochi");
	});

	it("offers the local voice choice after Naia login before completing onboarding", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ balance: 1_000_000 }),
			}),
		);
		const { invoke } = await import("@tauri-apps/api/core");
		(invoke as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
			if (cmd === "detect_gpu_vram") return Promise.resolve(16);
			if (cmd === "fetch_naia_balance")
				return Promise.resolve({ balance: 1_000_000 });
			return defaultInvoke(cmd);
		});
		localStorage.setItem("naia-adk-path", "D:\\alpha-adk\\projects\\naia-adk");
		renderAtAgentName();
		await act(async () => {
			await Promise.resolve();
		});

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

		fireEvent.change(
			screen.getByPlaceholderText(/Enter a name|이름을 입력하세요/),
			{
				target: { value: "Alex" },
			},
		);
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
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(
			screen.getByRole("button", { name: /Turn on host voice/ }),
		).toBeDefined();
		expect(screen.queryByTestId("onboarding-install-voxcpm2")).toBeNull();
		clickNext();
		fireEvent.click(
			screen.getByRole("button", { name: /시작하기|Get Started/ }),
		);
		await act(async () => {
			await Promise.resolve();
		});
		act(() => {
			vi.advanceTimersByTime(1300);
		});

		expect(onComplete).toHaveBeenCalled();

		const config = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(config.onboardingComplete).toBe(true);
		expect(config.naiaKey).toBeUndefined();
		expect(config.naiaUserId).toBe("user-1");
		expect(config.userName).toBe("Alex");
		expect(config.agentName).toBe("Mochi");
		expect(config.workspaceRoot).toBe("D:\\alpha-adk\\projects\\naia-adk");
		expect(config.localGpuTier).toBeUndefined();
		expect(invoke).toHaveBeenCalledWith(
			"secure_store_set",
			expect.objectContaining({
				name: "naiaKey",
				value: "gw-test-key",
				expectedStorePath: expect.stringContaining(
					"D:\\alpha-adk\\projects\\naia-adk",
				),
			}),
		);
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
		it.skip("rewrite-needed: handleNaiaLogin 이 redirect_uri + state CSRF 토큰을 담은 URL 로 시스템 브라우저를 연다 (provider 사전 설정과 단계 이동이 필요)", async () => {
			const { invoke } = await import("@tauri-apps/api/core");
			const { openUrl } = await import("@tauri-apps/plugin-opener");

			// generate_oauth_state Rust command mock — fixed CSRF token
			(invoke as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
				if (cmd === "generate_oauth_state") {
					return Promise.resolve("csrf-test-token-abc123");
				}
				return defaultInvoke(cmd);
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
			expect(calledUrl).toContain("www.naia.land");
			expect(calledUrl).toContain("/login?");
			expect(calledUrl).toContain(
				"redirect_uri=http%3A%2F%2F127.0.0.1%3A18792%2Fauth%2Fcallback",
			);
			expect(calledUrl).toContain("state=csrf-test-token-abc123");
			expect(calledUrl).toContain("redirect=desktop");
			expect(calledUrl).toContain("source=desktop");
		});

		it("naia_auth_complete event 수신 시 naiaKey + naiaUserId localStorage 저장 + complete step 진입", async () => {
			localStorage.setItem("naia-adk-path", "/adk-oauth");
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

			await vi.waitFor(() =>
				expect(localStorage.getItem("naia-remote-key")).toBe(
					"gw-test-key-from-http-callback",
				),
			);

			// naiaKey + naiaUserId localStorage 저장 검증 (HTTP callback path 와
			// deep-link path 가 동일하게 처리)
			expect(localStorage.getItem("naia-remote-key")).toBe(
				"gw-test-key-from-http-callback",
			);
			expect(localStorage.getItem("naia-remote-user-id")).toBe("user-via-http");
			expect(invoke).toHaveBeenCalledWith(
				"secure_store_set",
				expect.objectContaining({
					name: "naiaKey",
					value: "gw-test-key-from-http-callback",
					expectedStorePath: "/adk-oauth/data-private/secure-keys.dat",
				}),
			);
			// onComplete 자체는 "시작하기" 버튼에서 호출되므로 listener 만으로는
			// 부르지 않음 (별 step 진행). 여기서는 localStorage 저장까지만 검증.
		});
	});
});
