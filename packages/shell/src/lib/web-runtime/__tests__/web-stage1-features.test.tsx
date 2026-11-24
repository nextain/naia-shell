// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WEB_WORKSPACE_OPEN_FILE_EVENT } from "../../../apps/workspace/WebWorkspace";
import { WebCreditChip } from "../../../components/WebCreditChip";
import { WebLoginPromptModal } from "../../../components/WebLoginPromptModal";
import { WebRuntimeHarnessBar } from "../../../components/WebRuntimeHarnessBar";
import { WebSlugOwnerGuard } from "../../../components/WebSlugOwnerGuard";
import { useAppStore } from "../../../stores/app";
import { useChatStore } from "../../../stores/chat";
import { loadConfig, saveConfig } from "../../config";
import { requestWebCreditRefresh } from "../../lab-balance";
import { setWebAssetsModeForTests } from "../web-assets";
import {
	WEB_REMOTE_KEY_STORAGE_KEY,
	WEB_REMOTE_USER_ID_STORAGE_KEY,
} from "../web-auth";
import { openWebLoginPrompt } from "../web-login-prompt";
import {
	resetWebModelStatusForTests,
	setWebModelStatus,
} from "../web-model-status";
import {
	extractWebSlugFromLocation,
	verifyWebSlugOwnership,
} from "../web-slug-guard";
import {
	STUDIO_PENDING_CHARACTER_STORAGE_KEY,
	consumePendingStudioCharacterCard,
} from "../web-studio-handoff";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue("standard"),
}));

function jsonResponse(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: {
			get: (h: string) =>
				h.toLowerCase() === "content-type" ? "application/json" : null,
		},
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as unknown as Response;
}

describe("Stage-1 Unified Web Shell Features", () => {
	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		setWebAssetsModeForTests(true);
		resetWebModelStatusForTests();
		useChatStore.getState().newConversation();
		useAppStore.getState().setActiveApp(null);
	});

	afterEach(() => {
		cleanup();
		setWebAssetsModeForTests(null);
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("consumes Studio SillyTavern V2/V3 character card from localStorage and ?character= (base64url & BFF URL) with extensions.naia_studio", async () => {
		const studioCard = {
			spec: "chara_card_v2",
			spec_version: "2.0",
			data: {
				name: "루아",
				description: "카페루아의 점성술 바리스타.",
				personality: "차분하고 다정함",
				scenario: "비 내리는 밤 카페루아",
				first_mes: "어서 오세요, {{user}}님. 오늘 밤 별자리를 봐드릴까요?",
				extensions: {
					naia_studio: {
						canonical_key: "av-def-jina-anime",
						tts_voice: "ko-KR-SunHi:DragonHDLatestNeural",
					},
				},
			},
		};
		localStorage.setItem(
			STUDIO_PENDING_CHARACTER_STORAGE_KEY,
			JSON.stringify(studioCard),
		);

		const res1 = await consumePendingStudioCharacterCard();
		expect(res1).toEqual({
			handled: true,
			ok: true,
			characterName: "루아",
		});
		expect(
			localStorage.getItem(STUDIO_PENDING_CHARACTER_STORAGE_KEY),
		).toBeNull();
		const cfg1 = loadConfig();
		expect(cfg1).toMatchObject({
			agentName: "루아",
			avatarProvider: "naia-video-avatar",
			nvaModel: "jina-anime",
			ttsVoice: "ko-KR-SunHi:DragonHDLatestNeural",
			onboardingComplete: true,
		});
		expect(useChatStore.getState().messages[0]?.content).toContain(
			"오늘 밤 별자리를 봐드릴까요?",
		);

		// Base64url `?character=` handoff + URL cleanup
		const b64url = btoa(
			unescape(
				encodeURIComponent(
					JSON.stringify({
						spec: "chara_card_v3",
						spec_version: "3.0",
						data: {
							name: "민호",
							description: "든든한 파트너",
							first_mes: "반가워!",
						},
					}),
				),
			),
		)
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		const replaceUrl = vi.fn();
		const res2 = await consumePendingStudioCharacterCard({
			location: {
				pathname: "/app",
				search: `?character=${b64url}&foo=1`,
				hash: "",
				origin: "https://dev.naia.land",
			},
			replaceUrl,
		});
		expect(res2).toEqual({ handled: true, ok: true, characterName: "민호" });
		expect(replaceUrl).toHaveBeenCalledWith("/app?foo=1");
		expect(loadConfig()?.agentName).toBe("민호");

		// Rejects untrusted third-party handoff URLs
		const untrusted = await consumePendingStudioCharacterCard({
			location: {
				pathname: "/app",
				search: "?character=https://evil.example.com/card.json",
				hash: "",
				origin: "https://dev.naia.land",
			},
			replaceUrl: () => {},
		});
		expect(untrusted).toEqual({
			handled: true,
			ok: false,
			error: "untrusted_character_handoff_url",
		});
	});

	it("verifies personal slug ownership (/u/<slug> & <slug>.dev.naia.land) with BFF fallback and renders WebSlugOwnerGuard", async () => {
		expect(
			extractWebSlugFromLocation({
				hostname: "dev.naia.land",
				pathname: "/app",
			}),
		).toBeNull();
		expect(
			extractWebSlugFromLocation({
				hostname: "dev.naia.land",
				pathname: "/u/demo-user",
			}),
		).toBe("demo-user");
		expect(
			extractWebSlugFromLocation({
				hostname: "demo-user.dev.naia.land",
				pathname: "/",
			}),
		).toBe("demo-user");

		// Gateway 401 (master-key protected) -> falls back to portal `/api/slug/demo-user`
		const fetchSlug = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/v1/slug/demo-user")) {
				return jsonResponse(401, { detail: "master key required" });
			}
			if (url.endsWith("/api/slug/demo-user")) {
				return jsonResponse(200, {
					user_id: "usr_owner_1",
					slug: "demo-user",
					redirect: false,
				});
			}
			return jsonResponse(404, {});
		}) as unknown as typeof fetch;

		// 1) Logged-out visitor -> login_required
		const loggedOut = await verifyWebSlugOwnership({
			fetchImpl: fetchSlug,
			gatewayUrl: "https://api-dev.naia.land",
			webBaseUrl: "https://dev.naia.land",
			authenticatedUserId: null,
			location: { hostname: "dev.naia.land", pathname: "/u/demo-user" },
		});
		expect(loggedOut).toEqual({
			status: "login_required",
			slug: "demo-user",
			ownerUserId: "usr_owner_1",
		});

		// 2) Different logged-in user -> forbidden_not_owner
		const otherUser = await verifyWebSlugOwnership({
			fetchImpl: fetchSlug,
			gatewayUrl: "https://api-dev.naia.land",
			webBaseUrl: "https://dev.naia.land",
			authenticatedUserId: "usr_intruder_9",
			location: { hostname: "demo-user.dev.naia.land", pathname: "/" },
		});
		expect(otherUser).toEqual({
			status: "forbidden_not_owner",
			slug: "demo-user",
			ownerUserId: "usr_owner_1",
			currentUserId: "usr_intruder_9",
		});

		// 3) Actual owner -> authorized
		const ownerOk = await verifyWebSlugOwnership({
			fetchImpl: fetchSlug,
			gatewayUrl: "https://api-dev.naia.land",
			webBaseUrl: "https://dev.naia.land",
			authenticatedUserId: "usr_owner_1",
			location: { hostname: "dev.naia.land", pathname: "/u/demo-user" },
		});
		expect(ownerOk).toEqual({
			status: "authorized",
			slug: "demo-user",
			ownerUserId: "usr_owner_1",
		});

		// Render WebSlugOwnerGuard UI for non-owner
		if (
			otherUser.status !== "none" &&
			otherUser.status !== "authorized"
		) {
			render(<WebSlugOwnerGuard decision={otherUser} />);
			expect(screen.getByTestId("web-slug-owner-guard")).toHaveAttribute(
				"data-guard-status",
				"forbidden_not_owner",
			);
			expect(
				screen.getByTestId("web-slug-owner-login-btn"),
			).toBeInTheDocument();
		}
	});

	it("opens SP-04 WebLoginPromptModal on paid feature selection and supports 1-click local WebGPU continuation", async () => {
		Object.defineProperty(navigator, "gpu", {
			value: { requestAdapter: vi.fn() },
			configurable: true,
		});
		render(<WebLoginPromptModal />);
		expect(screen.queryByTestId("web-login-prompt-card")).toBeNull();

		act(() => {
			openWebLoginPrompt("dragon-voice");
		});
		expect(await screen.findByTestId("web-login-prompt-card")).toHaveTextContent(
			"200",
		);

		fireEvent.click(screen.getByTestId("web-login-prompt-continue-local"));
		expect(screen.queryByTestId("web-login-prompt-card")).toBeNull();
		expect(loadConfig()).toMatchObject({
			provider: "webllm",
			ttsProvider: "browser",
		});
	});

	it("refreshes WebCreditChip on requestWebCreditRefresh() and switches to WebGPU + Browser TTS on 0-credit continueLocal (SP-10)", async () => {
		Object.defineProperty(navigator, "gpu", {
			value: { requestAdapter: vi.fn() },
			configurable: true,
		});
		localStorage.setItem(WEB_REMOTE_KEY_STORAGE_KEY, "gw-credit-loop-token");
		localStorage.setItem(WEB_REMOTE_USER_ID_STORAGE_KEY, "usr_credit_1");
		saveConfig({
			provider: "nextain",
			model: "gpt-6.1-terra",
			apiKey: "",
			ttsEnabled: true,
			ttsProvider: "nextain",
		});

		let currentCredits = 200;
		vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			jsonResponse(200, { credits: currentCredits }),
		);

		render(<WebCreditChip />);
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /200/ })).toBeInTheDocument(),
		);

		// Simulate chat + Dragon TTS credit deduction -> real-time refresh drops to 0 -> SP-10 alert appears
		currentCredits = 0;
		act(() => {
			requestWebCreditRefresh();
		});
		await waitFor(() =>
			expect(screen.getByRole("alert")).toBeInTheDocument(),
		);

		// Click [로컬로 계속] -> switches to webllm + browser TTS
		const buttons = screen.getByRole("alert").querySelectorAll("button");
		fireEvent.click(buttons[0]);
		expect(loadConfig()).toMatchObject({
			provider: "webllm",
			ttsProvider: "browser",
		});
	});

	it("renders WebRuntimeHarnessBar with WebGPU local brain status, Open Harness AGENTS.md launcher, and free 200-credit login chip", async () => {
		setWebModelStatus({
			phase: "ready",
			model: "Qwen3-4B-q4f16_1-MLC",
			progress: 1,
		});
		const openedPaths: string[] = [];
		const onOpenFile = (e: Event) => {
			const detail = (e as CustomEvent<{ path?: string }>).detail;
			if (detail?.path) openedPaths.push(detail.path);
		};
		window.addEventListener(WEB_WORKSPACE_OPEN_FILE_EVENT, onOpenFile);
		try {
			render(<WebRuntimeHarnessBar />);
			expect(screen.getByTestId("web-brain-status-badge")).toHaveTextContent(
				/WebGPU/,
			);
			expect(
				screen.getByTestId("web-login-free-credits-btn"),
			).toBeInTheDocument();
			expect(screen.getByTestId("web-login-credit-hint")).toHaveTextContent(
				/200 Cr/,
			);

			fireEvent.click(screen.getByTestId("web-open-harness-btn"));
			expect(useAppStore.getState().activeApp).toBe("workspace");
			expect(screen.queryByTestId("web-login-credit-hint")).toBeNull();
			expect(openedPaths).toEqual(["opfs://naia-adk/AGENTS.md"]);
		} finally {
			window.removeEventListener(WEB_WORKSPACE_OPEN_FILE_EVENT, onOpenFile);
		}
	});

	it("R21-3 renders Korean and English 200 Cr sign-up cost hints near login buttons", async () => {
		const { setLocale } = await import("../../i18n");
		try {
			await setLocale("ko");
			const koHarness = render(
				<>
					<WebRuntimeHarnessBar />
					<WebLoginPromptModal />
				</>,
			);
			expect(screen.getByTestId("web-login-credit-hint")).toHaveTextContent(
				"가입하면 200 Cr 무료 · 클라우드 대화 비용은 답 길이에 따라 달라요",
			);
			act(() => {
				openWebLoginPrompt("account");
			});
			expect(
				await screen.findByTestId("web-login-prompt-credit-hint"),
			).toHaveTextContent(
				"가입하면 200 Cr 무료 · 클라우드 대화 비용은 답 길이에 따라 달라요",
			);
			koHarness.unmount();

			await setLocale("en");
			render(
				<>
					<WebRuntimeHarnessBar />
					<WebLoginPromptModal />
				</>,
			);
			expect(screen.getByTestId("web-login-credit-hint")).toHaveTextContent(
				"200 Cr free on sign-up · Cloud chat cost varies by reply length",
			);
		} finally {
			await setLocale("en");
		}
	});
});
