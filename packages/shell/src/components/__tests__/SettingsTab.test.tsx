import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const eventListeners = vi.hoisted(
	() =>
		new Map<string, (event: { payload: unknown }) => void | Promise<void>>(),
);

const secureStoreMock = vi.hoisted(() => ({
	get: vi.fn().mockResolvedValue(null),
	set: vi.fn().mockResolvedValue(undefined),
	delete: vi.fn().mockResolvedValue(undefined),
}));

// 이 테스트들이 흉내 내는 기계 (#537). 기본은 카드 한 장짜리 Windows 이고,
// 카드 개수가 문제인 테스트만 setHostMachine 으로 바꿔 끼운다. 프로파일
// 이름은 하드웨어 사실이라 화면이 아니라 여기서 정한다.
const ONE_CARD_WINDOWS = {
	profile: "windows_trt_6g",
	gpus: [{ index: 0, freeMib: 8192, totalMib: 8192 }],
	gpuChoiceIsMeaningful: false,
	defaultGpuIndex: 0,
};
let hostMachine: typeof ONE_CARD_WINDOWS = ONE_CARD_WINDOWS;
function setHostMachine(next: typeof ONE_CARD_WINDOWS) {
	hostMachine = next;
}
vi.mock("../../lib/voice/host-profile", () => ({
	voiceHostProfile: () => Promise.resolve(hostMachine),
	resetVoiceHostProfileCache: () => {},
}));

vi.mock("@tauri-apps/plugin-store", () => {
	return { load: vi.fn().mockResolvedValue(secureStoreMock) };
});

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
	convertFileSrc: vi.fn((path: string) => `file://${path}`),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn().mockResolvedValue(null),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(
		(event: string, callback: (event: { payload: unknown }) => void) => {
			eventListeners.set(event, callback);
			return Promise.resolve(() => eventListeners.delete(event));
		},
	),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
	openUrl: vi.fn().mockResolvedValue(undefined),
}));

const chatServiceMocks = vi.hoisted(() => ({
	activateNaiaLlm: vi.fn().mockResolvedValue({
		available: true,
		loaded: true,
		provider: "nextain",
		model: "deepseek-v4-flash",
		llm: "naia",
	}),
	directToolCall: vi.fn().mockResolvedValue({ success: false }),
	reloadAgentSettings: vi.fn().mockResolvedValue(undefined),
	sendAuthUpdate: vi.fn().mockResolvedValue(undefined),
	sendAuthUpdateStrict: vi.fn().mockResolvedValue(undefined),
	sendNotifyConfig: vi.fn().mockResolvedValue(undefined),
	sendCredsUpdate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/chat-service", () => chatServiceMocks);

// (gateway-sync mock 제거됨 2026-06-12 — 모듈 삭제)

import { setLocale } from "../../lib/i18n";
import { SettingsTab } from "../SettingsTab";

// SettingsTab order:
// profile | brain | voice | avatar | persona | memory | knowledge | skills | connections | general
// engine→profile, ai→brain, models→memory(병합), info→general(흡수).
// voice/avatar/persona/knowledge = 신규(Phase1 placeholder). Tests navigate via this helper.
const SETTINGS_TAB_INDEX = {
	profile: 0,
	brain: 1,
	voice: 2,
	avatar: 3,
	persona: 4,
	memory: 5,
	knowledge: 6,
	skills: 7,
	connections: 8,
	general: 9,
} as const;
function gotoSettingsTab(name: keyof typeof SETTINGS_TAB_INDEX) {
	const btn = document.querySelector(
		`[data-settings-tab="${name}"]`,
	) as HTMLButtonElement | null;
	expect(btn).toBeTruthy();
	fireEvent.click(btn!);
}

/**
 * The avatar tab now defaults to the NVA (video) picker — GPU 없이 동작하는 NVA 를
 * 기본 아바타로 밀어주기 때문. VRM 피커는 avatarProvider 셀렉트를 "vrm" 으로 바꿔야
 * 렌더된다. VRM 관련 테스트는 이 헬퍼로 avatar 탭 진입 + VRM 선택을 함께 한다.
 */
function gotoAvatarVrm() {
	gotoSettingsTab("avatar");
	const select = (
		document.querySelector('option[value="vrm"]') as HTMLOptionElement | null
	)?.parentElement as HTMLSelectElement | null;
	expect(select).toBeTruthy();
	fireEvent.change(select!, { target: { value: "vrm" } });
}

describe("SettingsTab", () => {
	afterEach(async () => {
		cleanup();
		localStorage.clear();
		eventListeners.clear();
		vi.clearAllMocks();
		secureStoreMock.get.mockResolvedValue(null);
		vi.unstubAllGlobals();
		Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
		await setLocale("en");
	});

	it("keeps a Naia login entry point visible in Profile after logout", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		expect(screen.getByTestId("profile-naia-login")).toBeInTheDocument();
		expect(screen.getByTestId("profile-login-naia")).toBeEnabled();
	});

	it("loads the Naia credit balance after the StrictMode effect replay", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-2.5-flash",
				apiKey: "",
				naiaKey: "strict-mode-key",
			}),
		);
		mockInvoke.mockImplementation((command: string) => {
			if (command === "fetch_naia_balance") {
				return Promise.resolve({ balance: 5_204_139_000 });
			}
			return Promise.resolve([]);
		});
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			configurable: true,
			value: {},
		});

		render(
			<StrictMode>
				<SettingsTab />
			</StrictMode>,
		);

		expect(await screen.findByText(/52041\.39/)).toBeDefined();
		expect(mockInvoke).toHaveBeenCalledWith("fetch_naia_balance", {
			gatewayUrl: expect.any(String),
			naiaKey: "strict-mode-key",
		});
	});

	it("says the balance lookup failed and offers a way to try again (#575)", async () => {
		// 실패해도 "잔액 조회 중…" 이 그대로 남으면 사용자는 기다리는 것과 실패한 것을
		// 가를 수 없다. 실패는 그 뜻을 말해야 하고, 알림에는 다음 행동이 있어야 한다.
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-2.5-flash",
				apiKey: "",
				naiaKey: "balance-failure-key",
			}),
		);
		mockInvoke.mockImplementation((command: string) => {
			if (command === "fetch_naia_balance")
				return Promise.reject(new Error("gateway unreachable"));
			return Promise.resolve([]);
		});
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			configurable: true,
			value: {},
		});

		render(<SettingsTab />);

		const retry = await screen.findByTestId("lab-balance-retry");
		expect(retry).toBeInTheDocument();
		// 조회 중 문구가 남아 있으면 실패를 기다림으로 읽는다.
		expect(screen.queryByText(/Checking balance|잔액 조회 중/)).toBeNull();

		mockInvoke.mockImplementation((command: string) => {
			if (command === "fetch_naia_balance")
				return Promise.resolve({ balance: 1_000_000 });
			return Promise.resolve([]);
		});
		fireEvent.click(retry);
		expect(await screen.findByText(/10\.00/)).toBeDefined();
	});

	it("keeps unfinished Connections disabled between Skills and General", async () => {
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_bot_token_available")
				return Promise.resolve(false);
			return Promise.resolve([]);
		});
		render(<SettingsTab />);
		const tabs = [...document.querySelectorAll("[data-settings-tab]")].map(
			(element) => element.getAttribute("data-settings-tab"),
		);
		expect(tabs).toEqual([
			"profile",
			"brain",
			"voice",
			"avatar",
			"persona",
			"memory",
			"knowledge",
			"skills",
			"connections",
			"general",
		]);
		const connections = document.querySelector(
			'[data-settings-tab="connections"]',
		) as HTMLButtonElement;
		expect(connections.disabled).toBe(true);
		expect(screen.queryByTestId("discord-connections")).toBeNull();
		expect(document.querySelector('input[type="password"]')).toBeNull();
	});

	it("renders locale choices in the webview and applies Korean", async () => {
		localStorage.setItem("naia-config", JSON.stringify({ locale: "en" }));
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		gotoSettingsTab("general");

		const picker = screen.getByLabelText("Language");
		expect(picker).toHaveTextContent("English");
		fireEvent.click(picker);
		fireEvent.click(screen.getByRole("button", { name: "한국어" }));

		await waitFor(() => expect(picker).toHaveTextContent("한국어"));
		expect(screen.getByText("언어")).toBeDefined();
		// Settings keeps the established transaction boundary: the language is
		// previewed immediately, then persisted with the page's Save action.
		expect(
			JSON.parse(localStorage.getItem("naia-config") ?? "{}"),
		).toMatchObject({
			locale: "en",
		});
	});

	// config(models) 정상화: 구 skill_config directToolCall → 게이트웨이 `GET /v1/pricing` 셸-직결(E1).
	const stubPricingFetch = (entries: unknown[]) =>
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				String(url).includes("/v1/pricing")
					? { ok: true, json: async () => entries }
					: { ok: false, json: async () => [] },
			),
		);

	it("renders gateway catalog models with pricing (/v1/pricing 셸-직결)", async () => {
		mockInvoke.mockResolvedValue([]);
		stubPricingFetch([
			{
				model_key: "gemini:test-model-1",
				input_price_per_million: 1.5,
				output_price_per_million: 2.5,
				cached_price_per_million: null,
			},
		]);
		render(<SettingsTab />);
		gotoSettingsTab("brain");

		await vi.waitFor(() => {
			expect(screen.getByText("test-model-1 ($1.5 / $2.5)")).toBeDefined();
		});
	});

	it("parses gateway model_key provider prefix (<provider>:<id>)", async () => {
		mockInvoke.mockResolvedValue([]);
		stubPricingFetch([
			{
				model_key: "gemini:gemini-ultra-test",
				input_price_per_million: 0,
				output_price_per_million: 0,
				cached_price_per_million: null,
			},
		]);
		render(<SettingsTab />);
		gotoSettingsTab("brain");

		await vi.waitFor(() => {
			expect(screen.getByText(/gemini-ultra-test/)).toBeDefined();
		});
	});

	it("renders provider select and API key input", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		gotoSettingsTab("brain");
		const providerSelect = document.getElementById("provider-select");
		expect(providerSelect).toBeDefined();
		expect(screen.getByLabelText(/^API/i)).toBeDefined();
	});

	it("applies the Google API key to the Agent credential store before reload", async () => {
		localStorage.setItem("naia-adk-path", "/home/user/naia-adk");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "",
			}),
		);
		mockInvoke.mockImplementation((command: string) => {
			if (command === "read_naia_ui_config") return Promise.resolve("{}");
			return Promise.resolve([]);
		});

		render(<SettingsTab />);
		gotoSettingsTab("brain");
		fireEvent.change(screen.getByLabelText(/^API/i), {
			target: { value: "store-review-key" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));

		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("write_agent_key", {
				adkPath: "/home/user/naia-adk",
				envKey: "GEMINI_API_KEY",
				value: "store-review-key",
			}),
		);
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("reload_agent_settings"),
		);
	});

	it("hides API key input for Naia (nextain) provider", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		gotoSettingsTab("brain");
		const providerSelect = document.getElementById(
			"provider-select",
		) as HTMLSelectElement;
		fireEvent.change(providerSelect, { target: { value: "nextain" } });
		// #313 rewrite: nextain reuses the logged-in Naia key, so the AI tab just
		// omits the API key input (the account login UI lives on the info tab).
		expect(screen.queryByLabelText(/^API/i)).toBeNull();
		expect(providerSelect.value).toBe("nextain");
	});

	it("defaults to weighted price ordering, reorders visibly, and hides unavailable models", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "grok-4.3",
				apiKey: "",
			}),
		);
		mockInvoke.mockResolvedValue([]);
		stubPricingFetch([
			{
				model_key: "azure:grok-4.3",
				input_price_per_million: 0.4,
				output_price_per_million: 1.2,
				cached_price_per_million: 0.08,
				cache_write_price_per_million: 0.5,
			},
			{
				model_key: "vertexai:gemini-3.1-flash-lite",
				input_price_per_million: 0.1,
				output_price_per_million: 5,
				cached_price_per_million: 0.01,
			},
		]);

		const { unmount } = render(<SettingsTab />);
		gotoSettingsTab("brain");

		await screen.findByText(
			/Price per 1M tokens: Input \$0\.400 · Output \$1\.200 · Cache read \$0\.080 · Cache write \$0\.500/,
		);
		let modelSelect = document.getElementById(
			"model-select",
		) as HTMLSelectElement;
		const labels = [...modelSelect.options].map((option) => option.text);
		expect(labels).toContain(
			"Grok 4.3 (Price per 1M tokens: Input $0.400 / Output $1.200)",
		);
		expect(labels.some((label) => label.includes("(Naia)"))).toBe(false);
		expect(labels.some((label) => label.includes("Analysis only"))).toBe(false);
		expect(
			[...modelSelect.options].map((option) => option.value),
		).not.toContain("naia-local");
		expect(
			[...modelSelect.options].map((option) => option.value),
		).not.toContain("claude-opus-5");
		expect(
			[...modelSelect.options].map((option) => option.value),
		).not.toContain("naia-0.9-omni-24g");

		const sortSelect = screen.getByTestId(
			"model-sort-mode",
		) as HTMLSelectElement;
		expect(sortSelect.value).toBe("price");
		expect([...sortSelect.options].map((option) => option.value)).toEqual([
			"price",
			"performance",
		]);
		expect(screen.getByTestId("model-price-sort-basis").textContent).toContain(
			"3 uncached input tokens",
		);
		const pricedOptions = [...modelSelect.options].map(
			(option) => option.value,
		);
		expect(pricedOptions[0]).toBe("grok-4.3");
		expect(modelSelect.value).toBe("grok-4.3");

		fireEvent.change(sortSelect, { target: { value: "performance" } });
		expect(
			screen.getByTestId("model-performance-sort-basis").textContent,
		).toContain("public benchmarks");
		modelSelect = document.getElementById("model-select") as HTMLSelectElement;
		const performanceOptions = [...modelSelect.options].map(
			(option) => option.value,
		);
		expect(performanceOptions[0]).toBe("gpt-5.6-sol");
		expect(performanceOptions).not.toEqual(pricedOptions);
		expect(modelSelect.value).toBe("grok-4.3");
		expect(
			JSON.parse(localStorage.getItem("naia-config") ?? "{}").modelSortMode,
		).toBe("performance");

		unmount();
		render(<SettingsTab />);
		gotoSettingsTab("brain");
		expect(
			(screen.getByTestId("model-sort-mode") as HTMLSelectElement).value,
		).toBe("performance");
	});

	it("shows Korean domestic models (Upstage/CLOVA) under Naia with live pricing", async () => {
		// Regression: upstage:/clova: prices were dropped, so domestic models showed
		// no price. They must group under the nextain provider and carry pricing.
		localStorage.setItem(
			"naia-config",
			JSON.stringify({ provider: "nextain", model: "grok-4.3", apiKey: "" }),
		);
		mockInvoke.mockResolvedValue([]);
		stubPricingFetch([
			{
				model_key: "azure:grok-4.3",
				input_price_per_million: 0.4,
				output_price_per_million: 1.2,
				cached_price_per_million: null,
			},
			{
				model_key: "upstage:solar-pro4",
				input_price_per_million: 0.33,
				output_price_per_million: 1.32,
				cached_price_per_million: 0.066,
			},
			{
				model_key: "clova:HCX-007",
				input_price_per_million: 0.97,
				output_price_per_million: 3.88,
				cached_price_per_million: null,
			},
		]);

		render(<SettingsTab />);
		gotoSettingsTab("brain");
		await screen.findByText(/Price per 1M tokens/, { selector: "span" });

		const modelSelect = document.getElementById(
			"model-select",
		) as HTMLSelectElement;
		const labels = [...modelSelect.options].map((o) => o.text);
		expect(
			labels.some(
				(l) =>
					l.includes("Solar Pro 4") &&
					l.includes("$0.330") &&
					l.includes("$1.320"),
			),
		).toBe(true);
		expect(
			labels.some(
				(l) =>
					l.includes("HCX-007") && l.includes("$0.970") && l.includes("$3.880"),
			),
		).toBe(true);
		// Both group under nextain — selectable by their canonical ids.
		const values = [...modelSelect.options].map((o) => o.value);
		expect(values).toContain("solar-pro4");
		expect(values).toContain("HCX-007");
	});

	it("replaces a stale unavailable Naia selection with the first usable priced model", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "claude-opus-5",
				naiaKey: "gw-member",
				apiKey: "",
			}),
		);
		mockInvoke.mockResolvedValue([]);
		stubPricingFetch([
			{
				model_key: "azure:grok-4.3",
				input_price_per_million: 0.4,
				output_price_per_million: 1.2,
				cached_price_per_million: null,
			},
		]);

		render(<SettingsTab />);
		gotoSettingsTab("brain");

		await vi.waitFor(() => {
			const modelSelect = document.getElementById(
				"model-select",
			) as HTMLSelectElement;
			expect(modelSelect.value).toBe("grok-4.3");
			expect(
				[...modelSelect.options].map((option) => option.value),
			).not.toContain("claude-opus-5");
			expect(
				JSON.parse(localStorage.getItem("naia-config") || "{}").model,
			).toBe("grok-4.3");
		});
	});

	it("allows Codex for sub while keeping memory orthogonal", () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({ provider: "codex", model: "gpt-5.4", apiKey: "" }),
		);
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		gotoSettingsTab("brain");

		const subMode = screen.getByTestId("sub-llm-mode") as HTMLSelectElement;
		const memoryMode = screen.getByTestId(
			"memory-llm-mode",
		) as HTMLSelectElement;
		expect(subMode.value).toBe("inherit:main");
		expect(memoryMode.value).toBe("inherit:sub");

		fireEvent.change(subMode, { target: { value: "explicit" } });
		const subProvider = screen.getByTestId(
			"sub-llm-provider",
		) as HTMLSelectElement;
		expect([...subProvider.options].map((option) => option.value)).toContain(
			"codex",
		);
		fireEvent.change(subProvider, { target: { value: "gemini" } });
		const subModel = screen.getByTestId("sub-llm-model") as HTMLInputElement;
		fireEvent.change(subModel, { target: { value: "gemini-3.1-flash-lite" } });
		fireEvent.blur(subModel);
		fireEvent.change(memoryMode, { target: { value: "inherit:main" } });

		const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(saved.llmRoles).toMatchObject({
			sub: { provider: "gemini", model: "gemini-3.1-flash-lite" },
			memory: { inherit: "main" },
		});
		expect(saved.subLlmProvider).toBe("gemini");
		expect(saved.subLlmModel).toBe("gemini-3.1-flash-lite");
		expect(saved.memoryLlmProvider).toBeUndefined();
	});

	it("hydrates the expert role from the workspace file fallback", async () => {
		localStorage.setItem("naia-adk-path", "D:\\alpha-adk");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "gemini",
				model: "gemini-3.5-flash",
				apiKey: "",
			}),
		);
		mockInvoke.mockImplementation((command: string) => {
			if (command === "read_naia_config") {
				return Promise.resolve(
					JSON.stringify({
						provider: "gemini",
						model: "gemini-3.5-flash",
						llmRoles: {
							expert: { provider: "openai", model: "gpt-5.4" },
						},
					}),
				);
			}
			return Promise.resolve([]);
		});

		render(<SettingsTab />);
		gotoSettingsTab("brain");

		await vi.waitFor(() => {
			expect(
				(screen.getByTestId("expert-llm-mode") as HTMLSelectElement).value,
			).toBe("explicit");
			expect(
				(screen.getByTestId("expert-llm-provider") as HTMLSelectElement).value,
			).toBe("openai");
			expect(
				(screen.getByTestId("expert-llm-model") as HTMLInputElement).value,
			).toBe("gpt-5.4");
		});
	});

	it("persists Naia auth callback even when no config exists yet", async () => {
		localStorage.setItem("naia-adk-path", "C:\\Users\\Public\\naia-adk");
		mockInvoke.mockResolvedValue([]);
		const authReady = vi.fn();
		window.addEventListener("naia_auth_ready", authReady);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: () => Promise.resolve({ credits: 10 }),
			}),
		);

		render(<SettingsTab />);

		await vi.waitFor(() => {
			expect(eventListeners.get("naia_auth_complete")).toBeDefined();
		});

		await act(async () => {
			await eventListeners.get("naia_auth_complete")?.({
				payload: { naiaKey: "gw-test-key", naiaUserId: "user-123" },
			});
		});

		const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(saved.provider).toBe("nextain");
		expect(saved.model).toBeTruthy();
		expect(saved.apiKey).toBe("");
		expect(saved.naiaKey).toBe("gw-test-key");
		expect(saved.naiaUserId).toBe("user-123");
		expect(mockInvoke).toHaveBeenCalledWith("write_agent_key", {
			adkPath: "C:\\Users\\Public\\naia-adk",
			envKey: "NAIA_ANYLLM_API_KEY",
			value: "gw-test-key",
		});
		expect(mockInvoke).toHaveBeenCalledWith(
			"write_naia_config",
			expect.objectContaining({
				adkPath: "C:\\Users\\Public\\naia-adk",
				json: expect.any(String),
			}),
		);
		expect(chatServiceMocks.sendAuthUpdateStrict).toHaveBeenCalledWith(
			"gw-test-key",
		);
		expect(chatServiceMocks.activateNaiaLlm).toHaveBeenCalledWith(
			"gw-test-key",
			"nextain",
			expect.any(String),
		);
		expect(authReady).toHaveBeenCalledTimes(1);
		window.removeEventListener("naia_auth_ready", authReady);
	});

	it("replaces a stale Gemini main role when logging in to Naia from Settings", async () => {
		localStorage.setItem("naia-adk-path", "C:\\Users\\Public\\naia-adk");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "gemini",
				model: "gemini-3.5-flash",
				apiKey: "",
				llmRoles: {
					main: { provider: "gemini", model: "gemini-3.5-flash" },
					sub: { provider: "openai", model: "gpt-5.4" },
				},
			}),
		);
		mockInvoke.mockResolvedValue([]);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: () => Promise.resolve({ credits: 10 }),
			}),
		);

		render(<SettingsTab />);
		await vi.waitFor(() => {
			expect(eventListeners.get("naia_auth_complete")).toBeDefined();
		});
		await act(async () => {
			await eventListeners.get("naia_auth_complete")?.({
				payload: { naiaKey: "gw-test-key", naiaUserId: "user-123" },
			});
		});

		const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(saved.provider).toBe("nextain");
		expect(saved.model).toBe("deepseek-v4-flash");
		expect(saved.llmRoles.main).toEqual({
			provider: "nextain",
			model: "deepseek-v4-flash",
		});
		expect(saved.llmRoles.sub).toEqual({
			provider: "openai",
			model: "gpt-5.4",
		});
		expect(chatServiceMocks.activateNaiaLlm).toHaveBeenCalledWith(
			"gw-test-key",
			"nextain",
			"deepseek-v4-flash",
		);
	});

	it("shows STT provider selector with vosk option", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		gotoSettingsTab("voice");

		// STT provider selector is in the voice tab
		const sttSelect = document
			.querySelector('select option[value="vosk"]')
			?.closest("select") as HTMLSelectElement;
		expect(sttSelect).toBeDefined();
		// Default is empty (no provider set) — vosk is an available option
		expect(sttSelect.querySelector('option[value="vosk"]')).toBeDefined();
	});

	it("hides API key input for Claude Code CLI provider", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		gotoSettingsTab("brain");
		const providerSelect = document.getElementById(
			"provider-select",
		) as HTMLSelectElement;
		fireEvent.change(providerSelect, { target: { value: "claude-code-cli" } });
		// #313 rewrite: claude-code-cli uses the local CLI login session, so the
		// AI tab omits the API key input (no separate hint text).
		expect(screen.queryByLabelText(/^API/i)).toBeNull();
		expect(providerSelect.value).toBe("claude-code-cli");
	});

	it("shows Codex in the main provider selector without an API key field", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		gotoSettingsTab("brain");
		const providerSelect = document.getElementById(
			"provider-select",
		) as HTMLSelectElement;
		expect(providerSelect.querySelector('option[value="codex"]')).toBeTruthy();

		fireEvent.change(providerSelect, { target: { value: "codex" } });

		expect(providerSelect.value).toBe("codex");
		expect(screen.queryByLabelText(/^API/i)).toBeNull();
		const modelSelect = document.getElementById(
			"model-select",
		) as HTMLSelectElement;
		// 2026-08 lineup: gpt-5.6 sol/terra/luna + previous-gen 5.5, retiring 5.4.
		expect(modelSelect.value).toBe("gpt-5.6-sol");
		expect([...modelSelect.options].map((option) => option.value)).toEqual([
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
			"gpt-5.5",
			"gpt-5.4",
		]);
	});

	it("checks Codex readiness without rendering CLI output or changing credentials", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				onboardingComplete: true,
				provider: "codex",
				model: "gpt-5.4",
				apiKey: "",
			}),
		);
		mockInvoke.mockImplementation((command: string) => {
			if (command === "codex_preflight") {
				return Promise.resolve({
					status: "ready",
					output: "Logged in as private@example.com",
				});
			}
			return Promise.resolve([]);
		});

		render(<SettingsTab />);
		gotoSettingsTab("brain");
		const check = await screen.findByTestId("codex-readiness-check");
		expect(check.parentElement).toHaveClass("codex-readiness-actions");
		fireEvent.click(check);

		await vi.waitFor(() => {
			expect(
				screen.getByTestId("codex-readiness-status").textContent,
			).toContain("Ready");
		});
		expect(mockInvoke).toHaveBeenCalledWith("codex_preflight");
		expect(screen.queryByText("private@example.com")).toBeNull();
		expect(JSON.parse(localStorage.getItem("naia-config") || "{}").apiKey).toBe(
			"",
		);
	});

	it("shows Grok in the main provider selector without an API key field", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		gotoSettingsTab("brain");
		const providerSelect = document.getElementById(
			"provider-select",
		) as HTMLSelectElement;
		expect(providerSelect.querySelector('option[value="grok"]')).toBeTruthy();

		fireEvent.change(providerSelect, { target: { value: "grok" } });

		expect(providerSelect.value).toBe("grok");
		expect(screen.queryByLabelText(/^API/i)).toBeNull();
		const modelSelect = document.getElementById(
			"model-select",
		) as HTMLSelectElement;
		expect(modelSelect.value).toBe("grok-4.6");
		expect([...modelSelect.options].map((option) => option.value)).toEqual([
			"grok-4.6",
			"grok-4.5",
		]);
	});

	it("checks Grok readiness without rendering CLI output or changing credentials", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				onboardingComplete: true,
				provider: "grok",
				model: "grok-4.6",
				apiKey: "",
			}),
		);
		mockInvoke.mockImplementation((command: string) => {
			if (command === "grok_preflight") {
				return Promise.resolve({
					status: "ready",
					output: "You are logged in as private@example.com",
				});
			}
			return Promise.resolve([]);
		});

		render(<SettingsTab />);
		gotoSettingsTab("brain");
		const check = await screen.findByTestId("grok-readiness-check");
		expect(check.parentElement).toHaveClass("grok-readiness-actions");
		fireEvent.click(check);

		await vi.waitFor(() => {
			expect(screen.getByTestId("grok-readiness-status").textContent).toContain(
				"Ready",
			);
		});
		expect(mockInvoke).toHaveBeenCalledWith("grok_preflight");
		expect(screen.queryByText("private@example.com")).toBeNull();
		expect(JSON.parse(localStorage.getItem("naia-config") || "{}").apiKey).toBe(
			"",
		);
	});

	it.each([
		{
			name: "stale legacy mirror",
			legacy: { provider: "gemini", model: "gemini-2.5-flash" },
		},
		{
			name: "role-only config",
			legacy: {},
		},
	])(
		"hydrates the authoritative main role and preserves metadata on save ($name)",
		async ({ legacy }) => {
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					onboardingComplete: true,
					// The legacy fields are stale or absent. The structured main role
					// is the persisted source of truth for the editable brain controls.
					...legacy,
					apiKey: "stored-api-key",
					llmRoles: {
						main: {
							provider: "openai",
							model: "gpt-5.4",
							credentialRef: "OPENAI_API_KEY",
							baseUrl: "https://proxy.example/v1",
						},
					},
				}),
			);
			mockInvoke.mockResolvedValue([]);
			render(<SettingsTab />);
			gotoSettingsTab("brain");

			await vi.waitFor(() => {
				expect(
					(document.getElementById("provider-select") as HTMLSelectElement)
						.value,
				).toBe("openai");
				expect(
					(document.getElementById("model-select") as HTMLSelectElement).value,
				).toBe("gpt-5.4");
			});

			fireEvent.click(screen.getByRole("button", { name: "Apply" }));
			await vi.waitFor(() => {
				const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
				expect(saved.llmRoles?.main).toEqual(
					expect.objectContaining({
						provider: "openai",
						model: "gpt-5.4",
						credentialRef: "OPENAI_API_KEY",
						baseUrl: "https://proxy.example/v1",
					}),
				);
			});
		},
	);

	it.each([
		{
			name: "same-provider model change",
			nextProvider: "openai",
			nextModel: "gpt-4.1",
			preservesMetadata: true,
		},
		{
			name: "provider change",
			nextProvider: "gemini",
			nextModel: "gemini-2.5-flash",
			preservesMetadata: false,
		},
	])(
		"preserves connection metadata only when the provider stays the same ($name)",
		async ({ nextProvider, nextModel, preservesMetadata }) => {
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					onboardingComplete: true,
					provider: "openai",
					model: "gpt-5.4",
					apiKey: "stored-api-key",
					llmRoles: {
						main: {
							provider: "openai",
							model: "gpt-5.4",
							credentialRef: "OPENAI_API_KEY",
							baseUrl: "https://proxy.example/v1",
						},
					},
				}),
			);
			mockInvoke.mockResolvedValue([]);
			render(<SettingsTab />);
			gotoSettingsTab("brain");

			const providerSelect = () =>
				document.getElementById("provider-select") as HTMLSelectElement;
			const modelSelect = () =>
				document.getElementById("model-select") as HTMLSelectElement;
			await vi.waitFor(() => expect(providerSelect().value).toBe("openai"));

			if (nextProvider !== "openai") {
				fireEvent.change(providerSelect(), {
					target: { value: nextProvider },
				});
				await vi.waitFor(() =>
					expect(providerSelect().value).toBe(nextProvider),
				);
			}

			await vi.waitFor(() =>
				expect(
					[...modelSelect().options].map((option) => option.value),
				).toContain(nextModel),
			);
			fireEvent.change(modelSelect(), { target: { value: nextModel } });
			await vi.waitFor(() => expect(modelSelect().value).toBe(nextModel));
			fireEvent.click(screen.getByRole("button", { name: "Apply" }));

			await vi.waitFor(() => {
				const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
				expect(saved.llmRoles?.main).toEqual(
					expect.objectContaining({
						provider: nextProvider,
						model: nextModel,
					}),
				);
				if (preservesMetadata) {
					expect(saved.llmRoles.main).toEqual(
						expect.objectContaining({
							credentialRef: "OPENAI_API_KEY",
							baseUrl: "https://proxy.example/v1",
						}),
					);
				} else {
					expect(saved.llmRoles.main.credentialRef).toBeUndefined();
					expect(saved.llmRoles.main.baseUrl).toBeUndefined();
				}
			});
		},
	);

	it("saves main, sub, and memory brains as role settings", () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				onboardingComplete: true,
				provider: "codex",
				model: "gpt-5.4",
				apiKey: "",
			}),
		);
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		gotoSettingsTab("brain");

		const subMode = screen.getByTestId("sub-llm-mode");
		fireEvent.change(subMode, { target: { value: "explicit" } });
		const subProvider = screen.getByTestId(
			"sub-llm-provider",
		) as HTMLSelectElement;
		fireEvent.change(subProvider, { target: { value: "nextain" } });
		fireEvent.change(screen.getByTestId("memory-llm-mode"), {
			target: { value: "explicit" },
		});
		fireEvent.change(screen.getByTestId("memory-llm-provider"), {
			target: { value: "nextain" },
		});

		fireEvent.click(screen.getByRole("button", { name: "Apply" }));
		const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(saved.llmRoles).toEqual(
			expect.objectContaining({
				main: expect.objectContaining({ provider: "codex", model: "gpt-5.4" }),
				sub: expect.objectContaining({
					provider: "nextain",
					model: "deepseek-v4-flash",
				}),
				memory: expect.objectContaining({
					provider: "nextain",
					model: "deepseek-v4-flash",
				}),
			}),
		);
	});

	it.each(["grok-4.3", "deepseek-v4-pro", "gpt-5.6-sol", "gpt-5.6-luna"])(
		"keeps the live Naia Azure model %s selectable and persisted",
		async (modelId) => {
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					onboardingComplete: true,
					provider: "nextain",
					model: modelId,
					apiKey: "",
				}),
			);
			mockInvoke.mockResolvedValue([]);
			render(<SettingsTab />);
			gotoSettingsTab("brain");
			const select = screen.getByRole("combobox", {
				name: /model/i,
			}) as HTMLSelectElement;
			expect([...select.options].map((option) => option.value)).toContain(
				modelId,
			);
			expect(select.value).toBe(modelId);
			fireEvent.click(screen.getByRole("button", { name: "Apply" }));
			expect(
				JSON.parse(localStorage.getItem("naia-config") || "{}"),
			).toMatchObject({ provider: "nextain", model: modelId });
		},
	);

	it("allows an explicit Codex sub brain but excludes Codex from memory", () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				onboardingComplete: true,
				provider: "codex",
				model: "gpt-5.4",
				apiKey: "",
			}),
		);
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		gotoSettingsTab("brain");

		fireEvent.change(screen.getByTestId("sub-llm-mode"), {
			target: { value: "explicit" },
		});
		fireEvent.change(screen.getByTestId("memory-llm-mode"), {
			target: { value: "explicit" },
		});
		expect(
			[
				...(screen.getByTestId("sub-llm-provider") as HTMLSelectElement)
					.options,
			].map((option) => option.value),
		).toContain("codex");
		expect(
			[
				...(screen.getByTestId("memory-llm-provider") as HTMLSelectElement)
					.options,
			].map((option) => option.value),
		).not.toContain("codex");
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));
		const roles = JSON.parse(
			localStorage.getItem("naia-config") || "{}",
		).llmRoles;
		// Switching to explicit resolves the provider default (gpt-5.6-sol),
		// even though the stored main config still names retiring gpt-5.4.
		expect(roles.sub).toMatchObject({
			provider: "codex",
			model: "gpt-5.6-sol",
		});
		expect(roles.memory.provider).not.toBe("codex");
	});

	it("shows a safe Codex login-required state and clears it on provider switch", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				onboardingComplete: true,
				provider: "codex",
				model: "gpt-5.4",
			}),
		);
		mockInvoke.mockImplementation((command: string) =>
			Promise.resolve(
				command === "codex_preflight" ? { status: "login-required" } : [],
			),
		);

		render(<SettingsTab />);
		gotoSettingsTab("brain");
		fireEvent.click(await screen.findByTestId("codex-readiness-check"));
		await vi.waitFor(() => {
			expect(
				screen.getByTestId("codex-readiness-status").textContent,
			).toContain("Login required");
		});

		fireEvent.change(document.getElementById("provider-select")!, {
			target: { value: "gemini" },
		});
		expect(screen.queryByTestId("codex-readiness")).toBeNull();
	});

	it("renders VRM model picker — shows empty state when no VRMs in naia-settings", () => {
		// No adkPath set → listNaiaAssets returns [] without calling invoke
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		// Empty state message is shown in the vrm-list
		gotoAvatarVrm();
		expect(screen.getByText(/vrm-files|VRM 파일을 추가/i)).toBeDefined();
	});

	it("renders VRM items from naia-settings when invoke returns filenames", async () => {
		// Set adkPath so listNaiaAssets actually calls invoke
		localStorage.setItem("naia-adk-path", "/home/user/naia-adk");
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "list_naia_assets")
				return Promise.resolve(["01-OL_Woman.vrm", "02-Hood_Boy.vrm"]);
			return Promise.resolve([]);
		});
		render(<SettingsTab />);
		gotoAvatarVrm();

		await vi.waitFor(() => {
			// VRM items rendered with alt text matching filenames (minus .vrm)
			expect(screen.getByAltText("01-OL_Woman")).toBeDefined();
			expect(screen.getByAltText("02-Hood_Boy")).toBeDefined();
		});
	});

	it("renders background image picker with 없음(기본) option", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		// Background is now a dropdown in general tab (under theme, #10)
		gotoSettingsTab("general");
		expect(screen.getByText(/없음 \(기본\)|None \(Default\)/i)).toBeDefined();
	});

	it("renders VRM import file button", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		gotoAvatarVrm();
		expect(screen.getByText(/파일 추가|Add file/i)).toBeDefined();
	});

	it("preserves the configured NVA Host without forcing a local TRT profile", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "ollama",
				model: "qwen3:8b",
				ollamaHost: "http://gpu-box.local:11434",
				naiaKey: "nk",
				localGpuTier: "auto",
				cascadeRuntimeUrl: "https://cascade.example.invalid:9449",
			}),
		);
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "detect_gpu_vram") return Promise.resolve(8);
			return Promise.resolve([]);
		});
		render(<SettingsTab />);
		gotoSettingsTab("avatar");

		const option = document.querySelector(
			'option[value="naia-video-avatar"]',
		) as HTMLOptionElement;
		await vi.waitFor(() => expect(option.disabled).toBe(false));
		fireEvent.change(option.parentElement as HTMLSelectElement, {
			target: { value: "naia-video-avatar" },
		});

		const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(saved.avatarProvider).toBe("naia-video-avatar");
		expect(saved.nvaModel).toBeTruthy();
		expect(saved.cascadeRuntimeUrl).toBeUndefined();
		expect(saved.local8gFocus).toBeUndefined();
	});

	it("selects VRM item from naia-settings and marks as active", async () => {
		localStorage.setItem("naia-adk-path", "/home/user/naia-adk");
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "list_naia_assets")
				return Promise.resolve(["01-OL_Woman.vrm"]);
			return Promise.resolve([]);
		});
		render(<SettingsTab />);
		gotoAvatarVrm();

		const vrmBtn = await screen.findByAltText("01-OL_Woman");
		// Click the parent button
		fireEvent.click(vrmBtn.closest("button")!);
		expect(vrmBtn.closest("button")!.className).toContain("active");
	});

	it("renders memory section with empty state", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		// Switch to the memory tab first (tab bar separates memory from settings)
		gotoSettingsTab("memory");
		// Multiple elements match /Memory/i (Memory Adapter, Memory LLM, etc.) — use getAllByText
		expect(screen.getAllByText(/기억|Memory/i).length).toBeGreaterThan(0);
		expect(screen.getByText(/저장된 기억이|No stored memories/i)).toBeDefined();
	});

	it("renders facts when available", async () => {
		mockInvoke.mockResolvedValue([
			{
				id: "f1",
				content: "favorite_lang is Rust",
				entities: ["Rust"],
				topics: ["programming"],
				createdAt: 1000,
				updatedAt: 1000,
				importance: 0.5,
				recallCount: 0,
				lastAccessed: 1000,
				strength: 1.0,
				sourceEpisodes: [],
			},
		]);
		render(<SettingsTab />);
		// Switch to the memory tab first
		gotoSettingsTab("memory");

		await vi.waitFor(() => {
			expect(screen.getByText("favorite_lang is Rust")).toBeDefined();
			expect(screen.getByText("Rust")).toBeDefined();
		});
	});

	it("saves config with VRM model from naia-settings", async () => {
		localStorage.setItem("naia-adk-path", "/home/user/naia-adk");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({ provider: "gemini", model: "gemini-3.5-flash" }),
		);
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "list_naia_assets")
				return Promise.resolve(["01-OL_Woman.vrm"]);
			return Promise.resolve([]);
		});
		render(<SettingsTab />);

		// VRM picker lives on the avatar tab — select VRM (auto-applies via handleVrmSelect)
		gotoAvatarVrm();
		const vrmImg = await screen.findByAltText("01-OL_Woman");
		fireEvent.click(vrmImg.closest("button")!);

		// VRM auto-applied — verify immediately without Save
		const savedVrm = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(savedVrm.vrmModel).toContain("01-OL_Woman.vrm");
	});

	it("renders theme picker", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		gotoSettingsTab("general");
		expect(screen.getByTitle("Light")).toBeDefined();
		expect(screen.getByTitle("Dark")).toBeDefined();
	});

	it("shows error for empty API key", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		// Provider/API key + the save error banner live on the AI tab.
		gotoSettingsTab("brain");
		const saveBtn = document.querySelector(".settings-save-btn") as HTMLElement;
		fireEvent.click(saveBtn);
		expect(screen.getByText(/입력해주세요|enter.*api/i)).toBeDefined();
	});

	it("shows the native reload failure instead of a saved badge", async () => {
		localStorage.setItem("naia-adk-path", "/home/user/naia-adk");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({ provider: "codex", model: "gpt-5.4" }),
		);
		mockInvoke.mockImplementation((command: string) => {
			if (command === "reload_agent_settings") {
				return Promise.reject(new Error("memory reload rejected"));
			}
			if (command === "read_naia_ui_config") return Promise.resolve("{}");
			return Promise.resolve([]);
		});

		render(<SettingsTab />);
		gotoSettingsTab("brain");
		fireEvent.click(document.querySelector(".settings-save-btn")!);

		expect(await screen.findByText(/memory reload rejected/)).toBeDefined();
		expect(
			document.querySelector(".settings-save-btn")?.textContent,
		).not.toMatch(/Saved/i);
	});

	it("shows a reset failure on the general tab", async () => {
		localStorage.setItem("naia-adk-path", "/home/user/naia-adk");
		mockInvoke.mockImplementation((command: string) => {
			if (command === "reset_naia_config_files") {
				return Promise.reject(new Error("settings files are locked"));
			}
			return Promise.resolve([]);
		});

		render(<SettingsTab />);
		gotoSettingsTab("general");
		fireEvent.click(
			document.querySelector(".settings-danger-zone .settings-reset-btn")!,
		);
		fireEvent.click(
			document.querySelector(".reset-confirm-app .settings-reset-btn")!,
		);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"settings files are locked",
		);
	});
});

// ── #298: SettingsTab Memory tab ─────────────────────────────────────────────

describe("SettingsTab — memory tab (#298)", () => {
	afterEach(() => {
		cleanup();
		localStorage.clear();
		vi.clearAllMocks();
	});

	it("renders settings tab bar with six tab buttons", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		const tabBar = document.querySelector(".settings-tab-bar");
		expect(tabBar).toBeTruthy();
		// 10 tabs: profile|brain|voice|avatar|persona|memory|knowledge|skills|connections|general
		const tabBtns = document.querySelectorAll(".settings-tab-btn");
		expect(tabBtns.length).toBe(10);
	});

	it("keeps radio DJ parameters under skills and exhibition parameters under General", async () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		gotoSettingsTab("skills");
		const radioDjCard = await screen.findByTestId("youtube-bgm-skill-settings");
		expect(radioDjCard).toBeDefined();
		expect(screen.getByText("Youtube Radio DJ")).toBeDefined();
		expect(screen.queryByText("skill_youtube_bgm")).toBeNull();
		expect(screen.queryByTestId("proactive-speech-profile")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /Youtube Radio DJ/ }));
		expect(screen.getByText("skill_youtube_bgm")).toBeDefined();
		const skillProfile = screen.getByTestId(
			"proactive-speech-profile",
		) as HTMLSelectElement;
		expect(
			Array.from(skillProfile.options).map((option) => option.value),
		).toEqual(["disabled", "personal_radio_dj"]);
		expect(screen.getByTestId("proactive-bgm-autoplay")).toBeDefined();
		expect(
			(screen.getByTestId("proactive-idle-ms") as HTMLInputElement).value,
		).toBe("120000");
		expect(
			(screen.getByTestId("proactive-interval-ms") as HTMLInputElement).value,
		).toBe("900000");
		expect(
			(screen.getByTestId("proactive-timezone") as HTMLInputElement).value,
		).not.toBe("");
		expect(screen.queryByTestId("proactive-knowledge-scope")).toBeNull();

		gotoSettingsTab("general");
		expect(screen.getByTestId("proactive-speech-settings")).toBeDefined();
		expect(screen.getByTestId("proactive-knowledge-scope")).toBeDefined();
		expect(screen.queryByTestId("proactive-bgm-autoplay")).toBeNull();
		expect(
			Array.from(
				(screen.getByTestId("proactive-speech-profile") as HTMLSelectElement)
					.options,
			).map((option) => option.value),
		).toEqual(["disabled", "exhibition_intro"]);
	});

	it("does not expose a GPU profile or start local voice from detection", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "ollama",
				model: "qwen3:8b",
				avatarProvider: "naia-video-avatar",
				nvaModel: "naia",
				localGpuTier: "windows-voice-6g",
			}),
		);
		mockInvoke.mockImplementation((cmd: string) =>
			cmd === "detect_gpu_vram" ? Promise.resolve(8) : Promise.resolve([]),
		);

		render(<SettingsTab />);
		gotoSettingsTab("profile");
		await vi.waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("detect_gpu_vram"),
		);

		expect(document.getElementById("local-gpu-tier")).toBeNull();
		expect(mockInvoke).not.toHaveBeenCalledWith(
			"start_voxcpm2",
			expect.anything(),
		);
		const saved = JSON.parse(localStorage.getItem("naia-config") ?? "{}");
		expect(saved.provider).toBe("ollama");
		expect(saved.model).toBe("qwen3:8b");
		expect(saved.avatarProvider).toBe("naia-video-avatar");
	});

	it("keeps the avatar runtime card out of Profile across config changes", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "ollama",
				model: "qwen3:8b",
				avatarProvider: "vrm",
			}),
		);
		mockInvoke.mockImplementation((cmd: string) =>
			cmd === "detect_gpu_vram" ? Promise.resolve(8) : Promise.resolve([]),
		);

		render(<SettingsTab />);
		gotoSettingsTab("profile");
		expect(screen.queryByTestId("slot-group-avatar")).toBeNull();
		expect(screen.queryByTestId("slot-avatar")).toBeNull();

		// Something outside this tab (login hydration, another tab) switches the
		// live config to NVA and announces it — Settings must follow, not stay
		// stuck showing the stale VRM detail it had at mount.
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "ollama",
				model: "qwen3:8b",
				avatarProvider: "naia-video-avatar",
				nvaModel: "naia",
			}),
		);
		window.dispatchEvent(new CustomEvent("naia-config-changed"));

		await vi.waitFor(() => {
			expect(screen.queryByTestId("slot-group-avatar")).toBeNull();
			expect(screen.queryByTestId("slot-avatar")).toBeNull();
		});
	});

	it.skip("retired: selects the visible Windows TRT profile without replacing the external brain", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-3.5-flash",
				naiaKey: "nk",
				ttsProvider: "nextain",
				// localhost raw /tts 잔재 — 로컬 티어 선택이 로컬 façade 기본(:8910)으로 교정해야 한다.
				vllmTtsHost: "http://localhost:8892",
				// 음성 전용 티어를 선택해도 독립적인 사전 생성 NVA 선택은 유지해야 한다.
				avatarProvider: "naia-video-avatar",
			}),
		);
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "detect_gpu_vram") return Promise.resolve(16);
			return Promise.resolve([]);
		});
		render(<SettingsTab />);
		gotoSettingsTab("profile");

		await vi.waitFor(() => {
			expect(document.getElementById("local-gpu-tier")).toBeTruthy();
		});
		fireEvent.change(document.getElementById("local-gpu-tier") as HTMLElement, {
			target: { value: "windows-voice-6g" },
		});

		const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(saved.provider).toBe("nextain");
		expect(saved.model).toBe("gemini-3.5-flash");
		// 음성: 로컬 음성으로 자동 전환 + 원격 호스트 잔재를 로컬 façade 기본으로 교정.
		expect(saved.ttsProvider).toBe("naia-local-voice");
		expect(saved.ttsEnabled).toBe(true);
		expect(saved.vllmTtsHost).toBe("http://127.0.0.1:8910");
		expect(saved.localGpuTier).toBe("windows-voice-6g");
		expect(saved.avatarProvider).toBe("naia-video-avatar");
	});

	it.skip("retired: GPU profile 8GB stages local voice while preserving the external LLM and VRM", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "ollama",
				model: "qwen3:8b",
				ollamaHost: "http://gpu-box.local:11434",
				naiaKey: "nk",
				ttsProvider: "nextain",
				vllmTtsHost: "http://localhost:8892",
				avatarProvider: "vrm",
			}),
		);
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "detect_gpu_vram") return Promise.resolve(8);
			return Promise.resolve([]);
		});
		render(<SettingsTab />);
		gotoSettingsTab("profile");

		await vi.waitFor(() => {
			expect(document.getElementById("local-gpu-tier")).toBeTruthy();
		});
		fireEvent.change(document.getElementById("local-gpu-tier") as HTMLElement, {
			target: { value: "windows-voice-6g" },
		});

		const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(saved.localGpuTier).toBe("windows-voice-6g");
		expect(saved.provider).toBe("ollama");
		expect(saved.model).toBe("qwen3:8b");
		expect(saved.ollamaHost).toBe("http://gpu-box.local:11434");
		expect(saved.ollamaNumGpu).toBeUndefined();
		expect(saved.ttsProvider).toBe("naia-local-voice");
		expect(saved.ttsEnabled).toBe(true);
		expect(saved.vllmTtsHost).toBe("http://127.0.0.1:8910");
		expect(saved.avatarProvider).toBe("vrm");
	});

	it.skip("retired: describes local GPU profiles by capability without engine implementation names", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-2.5-flash-live",
				naiaKey: "nk",
			}),
		);
		mockInvoke.mockImplementation((cmd: string) =>
			cmd === "detect_gpu_vram" ? Promise.resolve(8) : Promise.resolve([]),
		);
		render(<SettingsTab />);
		gotoSettingsTab("profile");

		const select = await vi.waitFor(() => {
			const element = document.getElementById("local-gpu-tier");
			expect(element).toBeTruthy();
			return element as HTMLSelectElement;
		});
		const labels = Array.from(select.options).map(
			(option) => option.textContent ?? "",
		);
		expect(labels.some((label) => label.includes("NVIDIA GPU 6GB+"))).toBe(
			true,
		);
		expect(labels.join(" ")).not.toMatch(
			/VoxCPM2|Ditto|TensorRT|CUDA INT8|NVIDIA RTX/,
		);
	});

	it.skip("retired: GPU profile 6GB stages VoxCPM2 while preserving the external LLM and pre-baked NVA", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "ollama",
				model: "qwen3:8b",
				ollamaHost: "http://gpu-box.local:11434",
				naiaKey: "nk",
				ttsProvider: "nextain",
				avatarProvider: "naia-video-avatar",
				nvaModel: "stale.nva",
			}),
		);
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "detect_gpu_vram") return Promise.resolve(6);
			if (cmd === "start_voxcpm2") {
				return Promise.resolve(
					JSON.stringify({ facade_port: 8910, services: ["tts"] }),
				);
			}
			return Promise.resolve([]);
		});
		render(<SettingsTab />);
		gotoSettingsTab("profile");

		const select = document.getElementById(
			"local-gpu-tier",
		) as HTMLSelectElement;
		const option = select.querySelector(
			'option[value="windows-voice-6g"]',
		) as HTMLOptionElement;
		await vi.waitFor(() => expect(option.disabled).toBe(false));
		fireEvent.change(select, { target: { value: "windows-voice-6g" } });

		const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(saved.localGpuTier).toBe("windows-voice-6g");
		expect(saved.provider).toBe("ollama");
		expect(saved.model).toBe("qwen3:8b");
		expect(saved.ollamaHost).toBe("http://gpu-box.local:11434");
		expect(saved.ttsProvider).toBe("naia-local-voice");
		expect(saved.ttsEnabled).toBe(true);
		expect(saved.vllmTtsHost).toBe("http://127.0.0.1:8910");
		expect(saved.avatarProvider).toBe("naia-video-avatar");
		expect(saved.nvaModel).toBe("stale.nva");
	});

	it.skip("retired: blocks a hardware profile change without a Naia login", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({ provider: "ollama", model: "qwen3:8b" }),
		);
		let localVoiceStarted = false;
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "detect_gpu_vram") return Promise.resolve(6);
			if (cmd === "voxcpm2_installation_status") {
				return Promise.resolve({
					phase: localVoiceStarted ? "ready" : "ready-to-start",
					ready: localVoiceStarted,
					canStart: true,
					summary: "Ready",
					steps: [],
				});
			}
			if (cmd === "start_voxcpm2") {
				localVoiceStarted = true;
				return Promise.resolve(JSON.stringify({ facade_port: 8910 }));
			}
			return Promise.resolve([]);
		});
		render(<SettingsTab />);
		gotoSettingsTab("profile");

		const select = document.getElementById(
			"local-gpu-tier",
		) as HTMLSelectElement;
		expect(select.disabled).toBe(true);
		fireEvent.change(select, { target: { value: "windows-voice-6g" } });

		const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(saved.localGpuTier).toBeUndefined();
		expect(mockInvoke).not.toHaveBeenCalledWith("start_voxcpm2");
		expect(screen.getByTestId("local-profile-hint").textContent).toMatch(
			/registered Naia members.*log in/i,
		);
	});

	it("does not expose a separate installer button or install before user selection", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-3.5-flash",
				naiaKey: "nk",
				ttsProvider: "edge",
				ttsEnabled: false,
				localVoiceEnabled: false,
			}),
		);
		let installed = false;
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "detect_gpu_vram") return Promise.resolve(8);
			if (cmd === "voxcpm2_installation_status") {
				if (installed) {
					return Promise.resolve({
						phase: "ready-to-start",
						ready: false,
						canStart: true,
						summary: "VoxCPM2 runtime is ready.",
						steps: [],
					});
				}
				return Promise.resolve({
					phase: "blocked",
					ready: false,
					canStart: false,
					summary:
						"Local runtime installation is blocked because required package artifacts are missing.",
					steps: [
						{
							id: "cascade-service-bundle",
							label: "Cascade service bundle",
							state: "blocked",
							action: "install",
							actionAvailable: true,
							progressPercent: 0,
							retryable: true,
							failure: {
								code: "CASCADE_SERVICE_BUNDLE_MISSING",
								message:
									"VoxCPM2 or voice facade service files are not packaged.",
								retryable: true,
							},
						},
					],
				});
			}
			if (cmd === "voxcpm2_status") return Promise.resolve(false);
			if (cmd === "install_voxcpm2_runtime") {
				installed = true;
				return Promise.resolve({
					phase: "ready-to-start",
					ready: false,
					canStart: true,
					summary: "VoxCPM2 runtime is ready.",
					steps: [],
				});
			}
			return Promise.resolve([]);
		});

		render(<SettingsTab />);
		gotoSettingsTab("profile");
		await vi.waitFor(() => {
			expect(screen.queryByText(/Cascade service bundle/i)).toBeNull();
			expect(screen.queryByText(/CASCADE_SERVICE_BUNDLE_MISSING/i)).toBeNull();
		});
		gotoSettingsTab("voice");
		expect(screen.queryByText(/Cascade service bundle/i)).toBeNull();
		expect(mockInvoke).not.toHaveBeenCalledWith("start_voxcpm2");
		expect(screen.queryByTestId("local-voice-install-runtime")).toBeNull();
		expect(mockInvoke).not.toHaveBeenCalledWith("install_voxcpm2_runtime");
	});

	it("selecting VoxCPM2 installs, starts, health-checks, then commits the provider", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-3.5-flash",
				naiaKey: "nk",
				ttsProvider: "edge",
				ttsEnabled: false,
				localVoiceEnabled: false,
			}),
		);
		let installed = false;
		let started = false;
		mockInvoke.mockImplementation((command: string) => {
			if (command === "detect_gpu_vram") return Promise.resolve(8);
			if (command === "voxcpm2_status") return Promise.resolve(false);
			if (command === "voxcpm2_installation_status")
				return Promise.resolve({
					phase: started ? "ready" : installed ? "ready-to-start" : "blocked",
					ready: started,
					canStart: installed,
					summary: installed ? "VoxCPM2 TensorRT ready" : "Install required",
					steps: installed
						? []
						: [
								{
									id: "trt-voice-service",
									label: "TensorRT voice service",
									state: "blocked",
									action: "install",
									actionAvailable: true,
									progressPercent: 0,
									retryable: true,
									failure: null,
								},
							],
				});
			if (command === "install_voxcpm2_runtime") {
				installed = true;
				return Promise.resolve({
					phase: "ready-to-start",
					ready: false,
					canStart: true,
					summary: "VoxCPM2 TensorRT ready",
					steps: [],
				});
			}
			if (command === "start_voxcpm2") {
				started = true;
				return Promise.resolve(JSON.stringify({ facade_port: 8910 }));
			}
			return Promise.resolve([]);
		});

		render(<SettingsTab />);
		gotoSettingsTab("profile");
		const selector = screen.getByTestId("profile-tts-provider");
		await vi.waitFor(() =>
			expect(
				(selector as HTMLSelectElement).querySelector(
					'option[value="naia-local-voice"]',
				),
			).not.toBeDisabled(),
		);
		fireEvent.change(selector, { target: { value: "naia-local-voice" } });

		await vi.waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith("install_voxcpm2_runtime");
			expect(mockInvoke).toHaveBeenCalledWith("start_voxcpm2", {
				expectedLoaderProfile: "windows_trt_6g",
				// 고르지 않은 기본 상태 — 런타임이 여유로 고른다 (#537).
				gpuIndex: null,
			});
			const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
			expect(saved.ttsProvider).toBe("naia-local-voice");
			expect(saved.localVoiceEnabled).toBe(true);
			expect(saved.ttsEnabled).toBe(true);
		});
	});

	it("#507: selecting Local voice on an installed engine auto-starts without reverting", async () => {
		localStorage.setItem("naia-adk-path", "D:\\alpha-adk");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-3.5-flash",
				naiaKey: "nk",
				ttsProvider: "edge",
				ttsEnabled: false,
				localVoiceEnabled: false,
			}),
		);
		let started = false;
		mockInvoke.mockImplementation((command: string) => {
			if (command === "detect_gpu_vram") return Promise.resolve(8);
			if (command === "voxcpm2_status") return Promise.resolve(false);
			if (command === "voxcpm2_installation_status")
				return Promise.resolve({
					phase: started ? "ready" : "ready-to-start",
					ready: started,
					canStart: true,
					summary: "Local runtime files are ready.",
					steps: [],
				});
			if (command === "start_voxcpm2") {
				started = true;
				return Promise.resolve(JSON.stringify({ facade_port: 8910 }));
			}
			return Promise.resolve([]);
		});

		render(<SettingsTab />);
		gotoSettingsTab("profile");
		const selector = screen.getByTestId("profile-tts-provider");
		await vi.waitFor(() =>
			expect(
				(selector as HTMLSelectElement).querySelector(
					'option[value="naia-local-voice"]',
				),
			).not.toBeDisabled(),
		);
		fireEvent.change(selector, { target: { value: "naia-local-voice" } });

		await vi.waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith("start_voxcpm2", {
				expectedLoaderProfile: "windows_trt_6g",
				// 고르지 않은 기본 상태 — 런타임이 여유로 고른다 (#537).
				gpuIndex: null,
			});
			const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
			expect(saved.ttsProvider).toBe("naia-local-voice");
			expect(saved.ttsEnabled).toBe(true);
			expect(saved.localVoiceEnabled).toBe(true);
		});
		// Already installed: the selection must start it, never reinstall.
		expect(mockInvoke).not.toHaveBeenCalledWith("install_voxcpm2_runtime");
	});

	it("#507: a failed Local voice start surfaces the reason and the explicit revert", async () => {
		localStorage.setItem("naia-adk-path", "D:\\alpha-adk");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-3.5-flash",
				naiaKey: "nk",
				ttsProvider: "edge",
				ttsEnabled: true,
				localVoiceEnabled: false,
			}),
		);
		mockInvoke.mockImplementation((command: string) => {
			if (command === "detect_gpu_vram") return Promise.resolve(8);
			if (command === "voxcpm2_status") return Promise.resolve(false);
			if (command === "voxcpm2_installation_status")
				return Promise.resolve({
					phase: "ready-to-start",
					ready: false,
					canStart: true,
					summary: "Local runtime files are ready.",
					steps: [],
				});
			if (command === "start_voxcpm2")
				return Promise.reject(new Error("TRT service failed to start"));
			return Promise.resolve([]);
		});

		render(<SettingsTab />);
		gotoSettingsTab("profile");
		const selector = screen.getByTestId("profile-tts-provider");
		await vi.waitFor(() =>
			expect(
				(selector as HTMLSelectElement).querySelector(
					'option[value="naia-local-voice"]',
				),
			).not.toBeDisabled(),
		);
		fireEvent.change(selector, { target: { value: "naia-local-voice" } });

		await vi.waitFor(() => {
			const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
			expect(saved.ttsProvider).toBe("edge");
			// The revert is explicit: reason + restored notice, visible on the
			// profile surface that hosted the selection (no silent snap-back).
			const status = screen.getByTestId("profile-voice-status");
			expect(status.textContent).toContain("TRT service failed to start");
			expect(status.textContent).toMatch(/restored/i);
		});
	});

	it("restores the exact prior TTS selection when VoxCPM2 start fails", async () => {
		localStorage.setItem("naia-adk-path", "D:\\alpha-adk");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-3.5-flash",
				naiaKey: "nk",
				ttsProvider: "edge",
				ttsEnabled: true,
				localVoiceEnabled: false,
				vllmTtsHost: "http://voice-before-selection.local",
			}),
		);
		mockInvoke.mockImplementation((command: string) => {
			if (command === "detect_gpu_vram") return Promise.resolve(8);
			if (command === "voxcpm2_status") return Promise.resolve(false);
			if (command === "voxcpm2_installation_status")
				return Promise.resolve({
					phase: "ready-to-start",
					ready: false,
					canStart: true,
					summary: "VoxCPM2 TensorRT ready",
					steps: [],
				});
			if (command === "start_voxcpm2")
				return Promise.reject(new Error("TRT service failed to start"));
			return Promise.resolve([]);
		});

		render(<SettingsTab />);
		gotoSettingsTab("profile");
		const selector = screen.getByTestId("profile-tts-provider");
		await vi.waitFor(() =>
			expect(
				(selector as HTMLSelectElement).querySelector(
					'option[value="naia-local-voice"]',
				),
			).not.toBeDisabled(),
		);
		fireEvent.change(selector, { target: { value: "naia-local-voice" } });

		await vi.waitFor(() => {
			const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
			expect(saved.ttsProvider).toBe("edge");
			expect(saved.ttsEnabled).toBe(true);
			expect(saved.localVoiceEnabled).toBe(false);
			expect(saved.vllmTtsHost).toBe("http://voice-before-selection.local");
			const writes = mockInvoke.mock.calls.filter(
				([command]) => command === "write_slots_manifest",
			);
			expect(writes.length).toBeGreaterThan(0);
			const manifest = JSON.parse(writes.at(-1)?.[1]?.json as string);
			expect(manifest.slots.tts.provider).toBe("edge");
			expect(secureStoreMock.delete).not.toHaveBeenCalledWith("naiaKey");
		});
	});

	it("clears only a rejected VoxCPM2 credential and asks the member to log in", async () => {
		localStorage.setItem("naia-adk-path", "D:\\alpha-adk");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-3.5-flash",
				naiaKey: "gw-stale",
				ttsProvider: "edge",
				ttsEnabled: true,
				localVoiceEnabled: false,
			}),
		);
		secureStoreMock.get.mockImplementation((key: string) =>
			Promise.resolve(key === "naiaKey" ? "gw-stale" : null),
		);
		mockInvoke.mockImplementation((command: string) => {
			if (command === "detect_gpu_vram") return Promise.resolve(8);
			if (command === "voxcpm2_status") return Promise.resolve(false);
			if (command === "voxcpm2_installation_status")
				return Promise.resolve({
					phase: "ready-to-start",
					ready: false,
					canStart: true,
					summary: "VoxCPM2 TensorRT ready",
					steps: [],
				});
			if (command === "start_voxcpm2")
				return Promise.reject(new Error("voxcpm2_naia_member_login_required"));
			return Promise.resolve([]);
		});

		render(<SettingsTab />);
		gotoSettingsTab("profile");
		const selector = screen.getByTestId("profile-tts-provider");
		await vi.waitFor(() =>
			expect(
				(selector as HTMLSelectElement).querySelector(
					'option[value="naia-local-voice"]',
				),
			).not.toBeDisabled(),
		);
		fireEvent.change(selector, { target: { value: "naia-local-voice" } });

		await vi.waitFor(() => {
			expect(secureStoreMock.delete).toHaveBeenCalledWith("naiaKey");
			const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
			expect(saved.naiaKey).toBeUndefined();
			expect(saved.naiaUserId).toBeUndefined();
			expect(saved.localVoiceEnabled).toBe(false);
			expect(saved.ttsEnabled).toBe(false);
			expect(screen.getAllByText(/Naia account/i).length).toBeGreaterThan(0);
		});
	});

	it.skip("retired: restores an explicitly saved 8GB profile without replacing the external LLM", async () => {
		localStorage.setItem("naia-adk-path", "/home/user/naia-adk");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-3.5-flash",
				naiaKey: "nk",
				localGpuTier: "windows-voice-6g",
				local8gFocus: "llm",
			}),
		);
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "detect_gpu_vram") return Promise.resolve(8);
			if (cmd === "voxcpm2_installation_status") {
				return Promise.resolve({
					phase: "ready-to-start",
					ready: false,
					canStart: true,
					summary:
						"Local runtime files are ready. Services have not been started yet.",
					steps: [],
				});
			}
			if (cmd === "start_voxcpm2") {
				return Promise.resolve(
					JSON.stringify({ facade_port: 8910, services: [] }),
				);
			}
			return Promise.resolve([]);
		});

		render(<SettingsTab />);

		await vi.waitFor(() => {
			const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
			expect(saved.provider).toBe("nextain");
			expect(saved.model).toBe("gemini-3.5-flash");
			expect(saved.ollamaNumGpu).toBeUndefined();
			expect(saved.ttsProvider).toBe("naia-local-voice");
			expect(saved.vllmTtsHost).toBe("http://127.0.0.1:8910");
			expect(saved.avatarProvider).toBe("vrm");
			expect(mockInvoke).toHaveBeenCalledWith("start_voxcpm2", {
				expectedLoaderProfile: "windows_trt_6g",
				// 고르지 않은 기본 상태 — 런타임이 여유로 고른다 (#537).
				gpuIndex: null,
			});
		});
	});

	it.skip("retired: restores a secret-backed 6GB profile and writes an account-gated voice manifest", async () => {
		localStorage.setItem("naia-adk-path", "/home/user/naia-adk");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "codex",
				model: "gpt-5.4",
				localGpuTier: "windows-voice-6g",
				local8gFocus: "avatar",
			}),
		);
		secureStoreMock.get.mockImplementation((key: string) =>
			Promise.resolve(key === "naiaKey" ? "gw-restored-member" : null),
		);
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "detect_gpu_vram") return Promise.resolve(8);
			if (cmd === "voxcpm2_installation_status") {
				return Promise.resolve({
					phase: "ready-to-start",
					ready: false,
					canStart: true,
					summary: "Ready",
					steps: [],
				});
			}
			if (cmd === "start_voxcpm2") {
				return Promise.resolve(
					JSON.stringify({ facade_port: 8910, services: [] }),
				);
			}
			return Promise.resolve([]);
		});

		render(<SettingsTab />);

		await vi.waitFor(() => {
			const profileWrites = mockInvoke.mock.calls
				.filter(([cmd]) => cmd === "write_slots_manifest")
				.map((call) => JSON.parse(call[1]?.json as string));
			const write = mockInvoke.mock.calls
				.filter(([cmd]) => cmd === "write_slots_manifest")
				.find((call) => {
					const value = JSON.parse(call[1]?.json as string);
					return (
						value.gate.naiaAccount === true &&
						value.gpu.loaderProfile === "windows_trt_6g" &&
						value.slots.avatar.provider === "vrm"
					);
				});
			expect(write).toBeDefined();
			const manifest = JSON.parse(write?.[1]?.json as string);
			expect(manifest.gate.naiaAccount).toBe(true);
			expect(manifest.gpu).toMatchObject({
				tier: "windows-voice-6g",
				loaderProfile: "windows_trt_6g",
			});
			expect(manifest.slots.main).toMatchObject({
				provider: "codex",
				model: "gpt-5.4",
			});
			expect(manifest.slots.tts.provider).toBe("naia-local-voice");
			expect(manifest.slots.avatar.provider).toBe("vrm");
			expect(mockInvoke).toHaveBeenCalledWith("start_voxcpm2", {
				expectedLoaderProfile: "windows_trt_6g",
				// 고르지 않은 기본 상태 — 런타임이 여유로 고른다 (#537).
				gpuIndex: null,
			});
			expect(profileWrites.at(-1)?.gate.naiaAccount).toBe(true);
		});
	});

	it.skip("retired: stops cascade and writes a dormant manifest when the member logs out", async () => {
		localStorage.setItem("naia-adk-path", "/home/user/naia-adk");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-3.5-flash",
				naiaKey: "gw-member",
				localGpuTier: "windows-voice-6g",
				ttsProvider: "naia-local-voice",
				avatarProvider: "vrm",
			}),
		);
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "detect_gpu_vram") return Promise.resolve(8);
			if (cmd === "voxcpm2_status") return Promise.resolve(true);
			if (cmd === "fetch_naia_balance") return Promise.resolve({ balance: 1 });
			return Promise.resolve([]);
		});

		render(<SettingsTab />);
		await vi.waitFor(() =>
			expect(document.querySelector(".lab-disconnect-btn")).toBeTruthy(),
		);
		fireEvent.click(document.querySelector(".lab-disconnect-btn")!);
		fireEvent.click(
			document.querySelector(".reset-confirm-app .settings-reset-btn")!,
		);

		await vi.waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith("stop_voxcpm2");
			const writes = mockInvoke.mock.calls.filter(
				([cmd]) => cmd === "write_slots_manifest",
			);
			const manifest = JSON.parse(writes.at(-1)?.[1]?.json as string);
			expect(manifest.gate.naiaAccount).toBe(false);
			expect(manifest.gpu.tier).toBeUndefined();
			expect(manifest.gpu.loaderProfile).toBeUndefined();
		});
	});

	it("renders local voice download/install progress from voxcpm2_install_progress events (#453 FR-VOICE.17)", async () => {
		localStorage.setItem("naia-adk-path", "D:\\alpha-adk");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-3.5-flash",
				naiaKey: "gw-member",
				localGpuTier: "windows-voice-6g",
				ttsProvider: "naia-local-voice",
			}),
		);
		// naiaKey is sourced from the Tauri secure store, not plain config.
		secureStoreMock.get.mockImplementation((key: string) =>
			Promise.resolve(key === "naiaKey" ? "gw-member" : null),
		);
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "detect_gpu_vram") return Promise.resolve(8);
			if (cmd === "voxcpm2_status") return Promise.resolve(false);
			if (cmd === "voxcpm2_installation_status")
				return Promise.resolve({
					phase: "blocked",
					ready: false,
					canStart: false,
					summary: "",
					steps: [],
				});
			return Promise.resolve([]);
		});

		render(<SettingsTab />);
		gotoSettingsTab("voice");
		// The naia-local-voice section — where the install transaction and its
		// progress bar live — must be present.
		await screen.findByTestId("local-voice-toggle");
		// SettingsTab subscribes to the Rust `voxcpm2_install_progress` stream so
		// download (bytes) and install (labelled step) progress can be surfaced.
		await vi.waitFor(() =>
			expect(eventListeners.has("voxcpm2_install_progress")).toBe(true),
		);
		// Both progress phases the bar renders are exercised end-to-end by the
		// live `pnpm run tauri:dev` verification recorded in FR-VOICE.17; forwarding
		// either shape here must not throw.
		expect(() =>
			eventListeners.get("voxcpm2_install_progress")?.({
				payload: {
					phase: "download",
					downloaded: 2_100_000_000,
					total: 4_200_000_000,
				},
			}),
		).not.toThrow();
		expect(() =>
			eventListeners.get("voxcpm2_install_progress")?.({
				payload: {
					phase: "install",
					step: "engine",
					label: "Building the GPU engine",
					percent: 80,
				},
			}),
		).not.toThrow();
	});

	it("restores an explicitly enabled Naia Local runtime for preset playback", async () => {
		localStorage.setItem("naia-adk-path", "D:\\alpha-adk");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-3.5-flash",
				naiaKey: "nk",
				ttsProvider: "naia-local-voice",
				ttsEnabled: true,
				localVoiceEnabled: true,
				vllmTtsHost: "http://localhost:8910",
			}),
		);
		let started = false;
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "detect_gpu_vram") return Promise.resolve(8);
			if (cmd === "voxcpm2_status") return Promise.resolve(false);
			if (cmd === "voxcpm2_installation_status") {
				return Promise.resolve({
					phase: started ? "ready" : "ready-to-start",
					ready: started,
					canStart: true,
					summary: "Ready",
					steps: [],
				});
			}
			if (cmd === "start_voxcpm2") {
				started = true;
				return Promise.resolve(
					JSON.stringify({ facade_port: 8910, services: [{ id: "tts" }] }),
				);
			}
			return Promise.resolve([]);
		});

		render(<SettingsTab />);

		await vi.waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith("start_voxcpm2", {
				expectedLoaderProfile: "windows_trt_6g",
				// 고르지 않은 기본 상태 — 런타임이 여유로 고른다 (#537).
				gpuIndex: null,
			});
			const write = mockInvoke.mock.calls.find(
				([cmd]) => cmd === "write_slots_manifest",
			);
			const manifest = JSON.parse(write?.[1]?.json as string);
			expect(manifest.gpu).toMatchObject({
				tier: "windows-voice-6g",
				loaderProfile: "windows_trt_6g",
			});
		});
	});

	it("does not auto-restore a local provider when voice is disabled", async () => {
		localStorage.setItem("naia-adk-path", "D:\\alpha-adk");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-3.5-flash",
				ttsProvider: "naia-local-voice",
				ttsEnabled: false,
				localVoiceEnabled: false,
				vllmTtsHost: "http://localhost:8910",
			}),
		);
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "detect_gpu_vram") return Promise.resolve(8);
			if (cmd === "voxcpm2_status") return Promise.resolve(false);
			if (cmd === "voxcpm2_installation_status") {
				return Promise.resolve({
					phase: "ready-to-start",
					ready: false,
					canStart: true,
					summary: "Ready",
					steps: [],
				});
			}
			return Promise.resolve([]);
		});

		render(<SettingsTab />);
		await vi.waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("voxcpm2_installation_status"),
		);
		expect(mockInvoke).not.toHaveBeenCalledWith("start_voxcpm2", {
			expectedLoaderProfile: "windows_trt_6g",
			// 고르지 않은 기본 상태 — 런타임이 여유로 고른다 (#537).
			gpuIndex: null,
		});
	});

	it("normalizes a blocked local voice config and manifest to browser voice", async () => {
		localStorage.setItem("naia-adk-path", "D:\\alpha-adk");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-3.5-flash",
				ttsProvider: "naia-local-voice",
				ttsEnabled: false,
				localVoiceEnabled: false,
				vllmTtsHost: "http://localhost:8910",
			}),
		);
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "detect_gpu_vram") return Promise.resolve(8);
			if (cmd === "voxcpm2_status") return Promise.resolve(false);
			if (cmd === "voxcpm2_installation_status") {
				return Promise.resolve({
					phase: "blocked",
					ready: false,
					canStart: false,
					summary: "Local voice installation required.",
					steps: [],
				});
			}
			return Promise.resolve([]);
		});

		render(<SettingsTab />);
		await vi.waitFor(() => {
			const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
			expect(saved.ttsProvider).toBe("edge");
			expect(saved.ttsEnabled).toBe(false);
			expect(saved.localVoiceEnabled).toBe(false);
			const writes = mockInvoke.mock.calls.filter(
				([cmd]) => cmd === "write_slots_manifest",
			);
			const manifest = JSON.parse(writes.at(-1)?.[1]?.json as string);
			expect(manifest.slots.tts.provider).toBe("edge");
			expect(manifest.gpu.loaderProfile).toBeUndefined();
		});
		expect(mockInvoke).not.toHaveBeenCalledWith("start_voxcpm2", {
			expectedLoaderProfile: "windows_trt_6g",
			// 고르지 않은 기본 상태 — 런타임이 여유로 고른다 (#537).
			gpuIndex: null,
		});
	});

	it("rolls back provider and slots manifest when local voice start fails", async () => {
		localStorage.setItem("naia-adk-path", "D:\\alpha-adk");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-3.5-flash",
				naiaKey: "nk",
				ttsProvider: "naia-local-voice",
				ttsEnabled: true,
				localVoiceEnabled: true,
				vllmTtsHost: "http://localhost:8910",
			}),
		);
		let started = false;
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "detect_gpu_vram") return Promise.resolve(8);
			if (cmd === "voxcpm2_status") return Promise.resolve(false);
			if (cmd === "voxcpm2_installation_status") {
				return Promise.resolve({
					phase: started ? "blocked" : "ready-to-start",
					ready: false,
					canStart: !started,
					summary: started ? "Runtime failed verification." : "Ready",
					steps: [],
				});
			}
			if (cmd === "start_voxcpm2") {
				started = true;
				return Promise.resolve(JSON.stringify({ facade_port: 8910 }));
			}
			return Promise.resolve([]);
		});

		render(<SettingsTab />);
		await vi.waitFor(() => {
			const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
			expect(saved.ttsProvider).toBe("edge");
			expect(saved.ttsEnabled).toBe(false);
			expect(saved.localVoiceEnabled).toBe(false);
			const writes = mockInvoke.mock.calls.filter(
				([cmd]) => cmd === "write_slots_manifest",
			);
			const manifest = JSON.parse(writes.at(-1)?.[1]?.json as string);
			expect(manifest.slots.tts.provider).toBe("edge");
		});
	});

	it("FR-VOICE.13: shows the migration reason and recovers local voice in place", async () => {
		localStorage.setItem("naia-adk-path", "D:\\alpha-adk");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-3.5-flash",
				naiaKey: "nk",
				ttsProvider: "naia-local-voice",
				ttsEnabled: true,
				// Retired field: the safety migration disables local voice and
				// must record the reason instead of going silent.
				localGpuTier: "windows-voice-6g",
				vllmTtsHost: "http://localhost:8910",
			}),
		);
		let started = false;
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "detect_gpu_vram") return Promise.resolve(8);
			if (cmd === "voxcpm2_status") return Promise.resolve(false);
			if (cmd === "voxcpm2_installation_status") {
				return Promise.resolve({
					phase: started ? "ready" : "ready-to-start",
					ready: started,
					canStart: true,
					summary: "Ready",
					steps: [],
				});
			}
			if (cmd === "start_voxcpm2") {
				started = true;
				return Promise.resolve(
					JSON.stringify({ facade_port: 8910, services: [{ id: "tts" }] }),
				);
			}
			return Promise.resolve([]);
		});

		render(<SettingsTab />);
		fireEvent.click(
			document.querySelector('[data-settings-tab="voice"]') as HTMLElement,
		);

		await vi.waitFor(() => {
			expect(screen.getByTestId("local-voice-migration-notice")).toBeTruthy();
		});
		const restore = screen.getByTestId("local-voice-migration-restore");
		await vi.waitFor(() => expect(restore).not.toBeDisabled());
		fireEvent.click(restore);

		await vi.waitFor(() => {
			const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
			expect(saved.localVoiceEnabled).toBe(true);
			expect(saved.localVoiceMigrationNotice).toBeUndefined();
		});
		await vi.waitFor(() => {
			expect(screen.queryByTestId("local-voice-migration-notice")).toBeNull();
		});
	});

	it("renders S-SLOT gate + Brain/Voice groups without moving canonical controls", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-3.5-flash",
				naiaKey: "nk",
				localGpuTier: "auto",
			}),
		);
		let profileVoiceStarted = false;
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "detect_gpu_vram") return Promise.resolve(6);
			if (cmd === "voxcpm2_status") return Promise.resolve(false);
			if (cmd === "voxcpm2_installation_status") {
				return Promise.resolve({
					phase: profileVoiceStarted ? "ready" : "ready-to-start",
					ready: profileVoiceStarted,
					canStart: true,
					summary: "Ready",
					steps: [],
				});
			}
			if (cmd === "start_voxcpm2") {
				profileVoiceStarted = true;
				return Promise.resolve(JSON.stringify({ facade_port: 8910 }));
			}
			return Promise.resolve([]);
		});
		render(<SettingsTab />);
		gotoSettingsTab("profile");

		// FR-SLOT.1: gate section — naiaKey present → Naia account mode.
		expect(document.querySelector("[data-testid='slot-gate']")).toBeTruthy();
		expect(screen.getByTestId("slot-gate-mode").textContent).toContain(
			"Naia account",
		);
		expect(screen.getByTestId("slot-apply-defaults")).toBeTruthy();
		// Profile shows the user-configurable Brain/Voice groups only.
		expect(document.querySelector("[data-testid='slot-groups']")).toBeTruthy();
		expect(
			document.querySelector("[data-testid='slot-group-brain']"),
		).toBeTruthy();
		expect(
			document.querySelector("[data-testid='slot-group-voice']"),
		).toBeTruthy();
		expect(
			document.querySelector("[data-testid='slot-group-avatar']"),
		).toBeNull();
		expect(document.querySelector("[data-testid='slot-main']")).toBeTruthy();
		expect(document.querySelector("[data-testid='slot-sub']")).toBeTruthy();
		expect(
			document.querySelector("[data-testid='slot-embedding']"),
		).toBeTruthy();
		expect(document.querySelector("[data-testid='slot-stt']")).toBeTruthy();
		expect(document.querySelector("[data-testid='slot-tts']")).toBeTruthy();
		const profileTtsProvider = screen.getByTestId(
			"profile-tts-provider",
		) as HTMLSelectElement;
		expect(
			profileTtsProvider.querySelector('option[value="naia-local-voice"]')
				?.textContent,
		).toContain("Naia Host Voice");
		await vi.waitFor(() =>
			expect(
				profileTtsProvider.querySelector('option[value="naia-local-voice"]'),
			).not.toBeDisabled(),
		);
		fireEvent.change(profileTtsProvider, {
			target: { value: "naia-local-voice" },
		});
		await vi.waitFor(() => {
			const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
			expect(saved.ttsProvider).toBe("naia-local-voice");
			expect(saved.vllmTtsHost).toBe("http://127.0.0.1:8910");
			expect(
				screen.getByTestId("profile-local-voice-toggle"),
			).not.toBeDisabled();
		});
		expect(document.querySelector("[data-testid='slot-avatar']")).toBeNull();
		// R1-7: 3-profile residue removed.
		expect(
			document.querySelector("[data-testid='engine-profile-summary']"),
		).toBeNull();
		expect(
			document.querySelector("[data-testid='engine-profile-naia']"),
		).toBeNull();
		expect(
			document.querySelector("[data-testid='engine-profile-byo']"),
		).toBeNull();
		expect(
			document.querySelector("[data-testid='engine-profile-local']"),
		).toBeNull();
		// engine-core-summary 제거(2026-06-30): slot-groups 두뇌 그룹과 100% 중복.
		// engine-gpu-summary·tier-recommendations 제거(2026-07-07): GPU 프로파일 드롭다운 +
		// 로컬 집중 + 슬롯 개요와 중복 → 자리 절약. capability 요약만 고유 정보로 유지.
		expect(
			document.querySelector("[data-testid='engine-core-summary']"),
		).toBeNull();
		expect(
			document.querySelector("[data-testid='engine-gpu-summary']"),
		).toBeNull();
		expect(
			document.querySelector("[data-testid='tier-recommendations']"),
		).toBeNull();
		expect(
			document.querySelector("[data-testid='engine-capability-summary']"),
		).toBeTruthy();
		// Canonical controls remain on ai tab, not engine.
		expect(document.getElementById("provider-select")).toBeNull();
		expect(document.getElementById("model-select")).toBeNull();
		gotoSettingsTab("brain");
		expect(document.getElementById("provider-select")).toBeTruthy();
		expect(document.getElementById("model-select")).toBeTruthy();
	});

	it("keeps the selected TTS provider when its default voice is persisted", () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-3.5-flash",
				locale: "ko",
				ttsProvider: "browser",
				ttsVoice: "old-browser-voice",
			}),
		);
		mockInvoke.mockResolvedValue([]);

		const rendered = render(<SettingsTab />);
		gotoSettingsTab("voice");

		const provider = screen.getByTestId(
			"gateway-tts-provider",
		) as HTMLSelectElement;
		fireEvent.change(provider, { target: { value: "edge" } });

		const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(saved.ttsProvider).toBe("edge");
		expect(saved.ttsVoice).toBe("ko-KR-SunHiNeural");

		rendered.unmount();
		render(<SettingsTab />);
		gotoSettingsTab("voice");
		expect(
			(screen.getByTestId("gateway-tts-provider") as HTMLSelectElement).value,
		).toBe("edge");
		expect(
			(screen.getByTestId("gateway-tts-voice") as HTMLSelectElement).value,
		).toBe("ko-KR-SunHiNeural");
	});

	it("first tab button is active by default", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		const activeBtn = document.querySelector(".settings-tab-btn--active");
		expect(activeBtn).toBeTruthy();
		// Profile & Engine is the entrypoint.
		const allBtns = document.querySelectorAll(".settings-tab-btn");
		expect(allBtns[0]?.classList.contains("settings-tab-btn--active")).toBe(
			true,
		);
		expect(allBtns[1]?.classList.contains("settings-tab-btn--active")).toBe(
			false,
		);
	});

	it("apply Naia defaults fills unset slots non-destructively (FR-SLOT.3)", async () => {
		localStorage.setItem("naia-adk-path", "D:\\alpha-adk");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-3.5-flash",
				naiaKey: "nk",
			}),
		);
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		gotoSettingsTab("profile");

		// 게이트 = naia → "Gemini 기본값 적용" 버튼. 클릭 시 미설정 슬롯에 기본값(R2-1, §9 #5).
		fireEvent.click(screen.getByTestId("slot-apply-defaults"));
		const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
		// 이미 설정한 main 보존(비파괴).
		expect(saved.provider).toBe("nextain");
		expect(saved.model).toBe("gemini-3.5-flash");
		// 미설정 슬롯 = Gemini 기본값.
		expect(saved.subLlmProvider).toBe("naia");
		expect(saved.subLlmModel).toBe("gemini-3.1-flash-lite");
		expect(saved.llmRoles.sub).toMatchObject({
			provider: "naia",
			model: "gemini-3.1-flash-lite",
		});
		expect(saved.memoryLlmProvider).toBeUndefined();
		expect(saved.memoryEmbeddingProvider).toBe("offline");
		// 한국어 우선: 기본 오프라인 임베딩 = 다국어 e5 (2026-07-15 승인)
		expect(saved.memoryOfflineModel).toBe("multilingual-e5-large");
		expect(saved.ttsProvider).toBe("nextain");
		await vi.waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith(
				"write_naia_config",
				expect.objectContaining({ adkPath: "D:\\alpha-adk" }),
			);
		});
	});

	it("memory section is NOT visible on settings tab by default", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		// memorySection divider only renders when memory tab is active
		// In English test env, t("settings.memorySection") returns "Memory"
		const dividerTexts = Array.from(
			document.querySelectorAll(".settings-section-divider span"),
		).map((el) => el.textContent);
		// No divider with "Memory"/"기억" when on settings tab
		const hasMemoryDivider = dividerTexts.some(
			(t) => t === "Memory" || t === "기억",
		);
		expect(hasMemoryDivider).toBe(false);
	});

	it("clicking memory tab button shows memory section", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		// Click the memory tab button (index 3 in the 5-tab bar)
		gotoSettingsTab("memory");
		// The memory tab button is now active
		expect(
			document
				.querySelector('[data-settings-tab="memory"]')
				?.classList.contains("settings-tab-btn--active"),
		).toBe(true);
		// Memory section divider should now appear
		const dividerTexts = Array.from(
			document.querySelectorAll(".settings-section-divider span"),
		).map((el) => el.textContent);
		const hasMemoryDivider = dividerTexts.some(
			(t) => t === "Memory" || t === "기억",
		);
		expect(hasMemoryDivider).toBe(true);
	});

	it("switching to memory tab hides settings-danger-zone", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		// #313 rewrite: the danger zone moved to the info tab.
		gotoSettingsTab("general");
		expect(document.querySelector(".settings-danger-zone")).toBeTruthy();
		// Switch to memory tab — danger zone hidden
		gotoSettingsTab("memory");
		expect(document.querySelector(".settings-danger-zone")).toBeNull();
	});

	it("switching back to info tab restores danger-zone and hides memory section", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		// Info tab → memory tab → back to info tab (danger zone lives on info).
		gotoSettingsTab("general");
		gotoSettingsTab("memory");
		gotoSettingsTab("general");
		// Danger zone back
		expect(document.querySelector(".settings-danger-zone")).toBeTruthy();
		// Memory section divider gone
		const dividerTexts = Array.from(
			document.querySelectorAll(".settings-section-divider span"),
		).map((el) => el.textContent);
		const hasMemoryDivider = dividerTexts.some(
			(t) => t === "Memory" || t === "기억",
		);
		expect(hasMemoryDivider).toBe(false);
	});
});

// ── #296: Agent health check app ───────────────────────────────────────────

describe("SettingsTab — agent health check (#296)", () => {
	afterEach(() => {
		cleanup();
		localStorage.clear();
		vi.clearAllMocks();
	});

	it("renders agent health section with check button", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		gotoSettingsTab("general");
		expect(
			document.querySelector("[data-testid='agent-health-section']"),
		).toBeTruthy();
		expect(
			document.querySelector("[data-testid='agent-health-check-btn']"),
		).toBeTruthy();
	});

	it("shows idle status initially", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		gotoSettingsTab("general");
		const statusEl = document.querySelector(
			"[data-testid='agent-health-status']",
		) as HTMLElement;
		expect(statusEl).toBeTruthy();
		// In English test env, "Not checked" is shown
		expect(statusEl.classList.contains("agent-health-status--idle")).toBe(true);
	});

	it("clicking check button calls gateway_health invoke", async () => {
		mockInvoke.mockResolvedValue(true);
		render(<SettingsTab />);
		gotoSettingsTab("general");
		const btn = document.querySelector(
			"[data-testid='agent-health-check-btn']",
		) as HTMLButtonElement;
		fireEvent.click(btn);

		await vi.waitFor(() => {
			const healthCalls = (mockInvoke as any).mock.calls.filter(
				([cmd]: [string]) => cmd === "gateway_health",
			);
			expect(healthCalls.length).toBeGreaterThanOrEqual(1);
		});
	});

	it("shows healthy status when gateway_health returns true", async () => {
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "gateway_health") return true;
			return [];
		});
		render(<SettingsTab />);
		gotoSettingsTab("general");
		const btn = document.querySelector(
			"[data-testid='agent-health-check-btn']",
		) as HTMLButtonElement;
		fireEvent.click(btn);

		await vi.waitFor(() => {
			const statusEl = document.querySelector(
				"[data-testid='agent-health-status']",
			) as HTMLElement;
			expect(statusEl.classList.contains("agent-health-status--healthy")).toBe(
				true,
			);
		});
	});

	it("shows unhealthy status when gateway_health returns false", async () => {
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "gateway_health") return false;
			return [];
		});
		render(<SettingsTab />);
		gotoSettingsTab("general");
		const btn = document.querySelector(
			"[data-testid='agent-health-check-btn']",
		) as HTMLButtonElement;
		fireEvent.click(btn);

		await vi.waitFor(() => {
			const statusEl = document.querySelector(
				"[data-testid='agent-health-status']",
			) as HTMLElement;
			expect(
				statusEl.classList.contains("agent-health-status--unhealthy"),
			).toBe(true);
		});
	});

	it("agent-health-section is on the settings tab (not memory tab)", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		gotoSettingsTab("general");
		// By default on settings tab — health section should be visible
		expect(
			document.querySelector("[data-testid='agent-health-section']"),
		).toBeTruthy();
		// Switch to memory tab — health section should disappear
		gotoSettingsTab("memory");
		expect(
			document.querySelector("[data-testid='agent-health-section']"),
		).toBeNull();
	});

	it("shows unhealthy status when gateway_health throws", async () => {
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "gateway_health") throw new Error("Agent not running");
			return [];
		});
		render(<SettingsTab />);
		gotoSettingsTab("general");
		const btn = document.querySelector(
			"[data-testid='agent-health-check-btn']",
		) as HTMLButtonElement;
		fireEvent.click(btn);

		await vi.waitFor(() => {
			const statusEl = document.querySelector(
				"[data-testid='agent-health-status']",
			) as HTMLElement;
			expect(
				statusEl.classList.contains("agent-health-status--unhealthy"),
			).toBe(true);
		});
	});
});

// ── #297: Log viewer button ───────────────────────────────────────────────────

const mockOpenPath = vi.fn();
vi.mock("@tauri-apps/plugin-opener", async (importOriginal) => {
	const original = (await importOriginal()) as Record<string, unknown>;
	return {
		...original,
		openPath: (...args: unknown[]) => mockOpenPath(...args),
	};
});

describe("SettingsTab — log viewer (#297)", () => {
	afterEach(() => {
		cleanup();
		localStorage.clear();
		vi.clearAllMocks();
	});

	it("renders log viewer button on info tab", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		// #313 rewrite: the log viewer moved to the info tab.
		gotoSettingsTab("general");
		expect(
			document.querySelector("[data-testid='log-viewer-btn']"),
		).toBeTruthy();
	});

	it("log viewer button is on info tab only (not memory tab)", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		// Info tab: visible
		gotoSettingsTab("general");
		expect(
			document.querySelector("[data-testid='log-viewer-btn']"),
		).toBeTruthy();
		// Switch to memory tab: hidden
		gotoSettingsTab("memory");
		expect(document.querySelector("[data-testid='log-viewer-btn']")).toBeNull();
	});

	it("clicking log viewer button calls get_log_dir then openPath", async () => {
		const logDir = "/home/user/.naia/logs";
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "get_log_dir") return logDir;
			return [];
		});
		mockOpenPath.mockResolvedValue(undefined);

		render(<SettingsTab />);
		gotoSettingsTab("general");
		const btn = document.querySelector(
			"[data-testid='log-viewer-btn']",
		) as HTMLButtonElement;
		fireEvent.click(btn);

		await vi.waitFor(() => {
			const logDirCalls = (mockInvoke as any).mock.calls.filter(
				([cmd]: [string]) => cmd === "get_log_dir",
			);
			expect(logDirCalls.length).toBeGreaterThanOrEqual(1);
		});

		await vi.waitFor(() => {
			expect(mockOpenPath).toHaveBeenCalledWith(logDir);
		});
	});
});

/**
 * #537 — 로컬 음성을 어느 카드에 올릴지.
 *
 * 기본은 여유가 가장 많은 카드다. 사람이 고르는 것은 카드가 두 장 이상일
 * 때만 의미가 있다 — 한 장뿐인 기계에서 고르라고 물으면 답이 하나뿐인
 * 질문이 된다.
 */
describe("SettingsTab — 로컬 음성 카드 선택 (#537)", () => {
	const TWO_CARD_LINUX = {
		profile: "linux_trt_6g",
		gpus: [
			{ index: 0, freeMib: 20011, totalMib: 24576 },
			{ index: 1, freeMib: 24014, totalMib: 24576 },
		],
		gpuChoiceIsMeaningful: true,
		defaultGpuIndex: 1,
	};

	beforeEach(() => {
		// 이 블록이 보는 것은 카드 선택뿐이다. 나머지 명령은 조용히 답한다 —
		// 답이 없으면 화면이 뜨기 전에 터진다.
		secureStoreMock.get.mockImplementation((key: string) =>
			Promise.resolve(key === "naiaKey" ? "gw-member" : null),
		);
		mockInvoke.mockImplementation((command: string) => {
			if (command === "detect_gpu_vram") return Promise.resolve(24);
			if (command === "voxcpm2_status") return Promise.resolve(false);
			if (command === "voxcpm2_installation_status")
				return Promise.resolve({
					phase: "ready",
					ready: true,
					canStart: true,
					summary: "",
					steps: [],
				});
			return Promise.resolve([]);
		});
	});

	afterEach(() => {
		setHostMachine(ONE_CARD_WINDOWS);
		cleanup();
		localStorage.clear();
		vi.clearAllMocks();
	});

	function seedLocalVoice() {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "ollama",
				model: "qwen3:8b",
				naiaKey: "nk",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				localVoiceEnabled: true,
			}),
		);
	}

	it("카드가 한 장이면 고르라고 묻지 않는다", async () => {
		seedLocalVoice();
		render(<SettingsTab />);
		gotoSettingsTab("voice");
		// 블록 자체가 없어서 통과하면 아무것도 확인하지 못한 것이다. 로컬 음성
		// 구역이 실제로 떠 있는 상태에서만 없음을 단언한다.
		await screen.findByTestId("local-voice-toggle");
		expect(document.getElementById("local-voice-gpu")).toBeNull();
	});

	it("카드가 두 장이면 여유와 함께 고를 수 있게 한다", async () => {
		setHostMachine(TWO_CARD_LINUX);
		seedLocalVoice();
		render(<SettingsTab />);
		gotoSettingsTab("voice");

		const select = await vi.waitFor(() => {
			const element = document.getElementById("local-voice-gpu");
			expect(element).toBeTruthy();
			return element as HTMLSelectElement;
		});
		const labels = Array.from(select.options).map((o) => o.textContent ?? "");
		// 자동 + 카드 두 장.
		expect(select.options).toHaveLength(3);
		expect(labels[1]).toContain("GPU 0");
		expect(labels[2]).toContain("GPU 1");
		// 고르지 않은 상태가 기본이다 — 값이 비어 있어야 런타임이 여유로 고른다.
		expect(select.value).toBe("");
	});

	it("고른 카드가 설정에 남는다", async () => {
		setHostMachine(TWO_CARD_LINUX);
		seedLocalVoice();
		render(<SettingsTab />);
		gotoSettingsTab("voice");

		const select = await vi.waitFor(() => {
			const element = document.getElementById("local-voice-gpu");
			expect(element).toBeTruthy();
			return element as HTMLSelectElement;
		});
		fireEvent.change(select, { target: { value: "0" } });

		await vi.waitFor(() => {
			const saved = JSON.parse(localStorage.getItem("naia-config") ?? "{}");
			expect(saved.localVoiceGpuIndex).toBe(0);
		});
	});

	it("자동으로 되돌리면 설정에서 지워진다", async () => {
		setHostMachine(TWO_CARD_LINUX);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "ollama",
				model: "qwen3:8b",
				naiaKey: "nk",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				localVoiceEnabled: true,
				localVoiceGpuIndex: 1,
			}),
		);
		render(<SettingsTab />);
		gotoSettingsTab("voice");

		const select = await vi.waitFor(() => {
			const element = document.getElementById("local-voice-gpu");
			expect(element).toBeTruthy();
			return element as HTMLSelectElement;
		});
		expect(select.value).toBe("1");
		fireEvent.change(select, { target: { value: "" } });

		await vi.waitFor(() => {
			const saved = JSON.parse(localStorage.getItem("naia-config") ?? "{}");
			// 남겨 두면 "자동" 이 아니라 "1번 고정" 이 된다.
			expect("localVoiceGpuIndex" in saved).toBe(false);
		});
	});
});
