import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const eventListeners = vi.hoisted(
	() =>
		new Map<string, (event: { payload: unknown }) => void | Promise<void>>(),
);

vi.mock("@tauri-apps/plugin-store", () => {
	const store = {
		get: vi.fn().mockResolvedValue(null),
		set: vi.fn().mockResolvedValue(undefined),
		delete: vi.fn().mockResolvedValue(undefined),
	};
	return { load: vi.fn().mockResolvedValue(store) };
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

vi.mock("../../lib/chat-service", () => ({
	directToolCall: vi.fn().mockResolvedValue({ success: false }),
	sendAuthUpdate: vi.fn().mockResolvedValue(undefined),
	sendNotifyConfig: vi.fn().mockResolvedValue(undefined),
	sendCredsUpdate: vi.fn().mockResolvedValue(undefined),
}));

// (gateway-sync mock 제거됨 2026-06-12 — 모듈 삭제)

import { SettingsTab } from "../SettingsTab";

// SettingsTab 9-tab restructure (#FR-SLOT.4, 2026-06-29):
// profile | brain | voice | avatar | persona | memory | knowledge | skills | general
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
	general: 8,
} as const;
function gotoSettingsTab(name: keyof typeof SETTINGS_TAB_INDEX) {
	const btn = document.querySelector(
		`[data-settings-tab="${name}"]`,
	) as HTMLButtonElement | null;
	expect(btn).toBeTruthy();
	fireEvent.click(btn!);
}

describe("SettingsTab", () => {
	afterEach(() => {
		cleanup();
		localStorage.clear();
		eventListeners.clear();
		vi.clearAllMocks();
		vi.unstubAllGlobals();
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

	it("persists Naia auth callback even when no config exists yet", async () => {
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
		expect(saved.model).toBeTruthy();
		expect(saved.apiKey).toBe("");
		expect(saved.naiaKey).toBe("gw-test-key");
		expect(saved.naiaUserId).toBe("user-123");
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

	it("renders VRM model picker — shows empty state when no VRMs in naia-settings", () => {
		// No adkPath set → listNaiaAssets returns [] without calling invoke
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		// Empty state message is shown in the vrm-list
		gotoSettingsTab("avatar");
		expect(screen.getByText(/vrm-files|VRM 파일을 추가/i)).toBeDefined();
	});

	it("renders VRM items from naia-settings when invoke returns filenames", async () => {
		// Set adkPath so listNaiaAssets actually calls invoke
		localStorage.setItem("naia-adk-path", "/home/user/naia-adk");
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "list_naia_assets")
				return Promise.resolve(["03-OL_Woman.vrm", "04-Hood_Boy.vrm"]);
			return Promise.resolve([]);
		});
		render(<SettingsTab />);
		gotoSettingsTab("avatar");

		await vi.waitFor(() => {
			// VRM items rendered with alt text matching filenames (minus .vrm)
			expect(screen.getByAltText("03-OL_Woman")).toBeDefined();
			expect(screen.getByAltText("04-Hood_Boy")).toBeDefined();
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
		gotoSettingsTab("avatar");
		expect(screen.getByText(/파일 추가|Add file/i)).toBeDefined();
	});

	it("preserves the configured NVA Host without forcing a local TRT profile", () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-3.5-flash",
				naiaKey: "nk",
				localGpuTier: "auto",
				cascadeRuntimeUrl: "https://pc-bazzite.tail4f7a25.ts.net:9449",
			}),
		);
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "detect_gpu_vram") return Promise.resolve(4);
			return Promise.resolve([]);
		});
		render(<SettingsTab />);
		gotoSettingsTab("avatar");

		const option = document.querySelector(
			'option[value="naia-video-avatar"]',
		) as HTMLOptionElement;
		expect(option.disabled).toBe(false);
		fireEvent.change(option.parentElement as HTMLSelectElement, {
			target: { value: "naia-video-avatar" },
		});

		const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(saved.avatarProvider).toBe("naia-video-avatar");
		expect(saved.nvaModel).toBeTruthy();
		expect(saved.cascadeRuntimeUrl).toBe(
			"https://pc-bazzite.tail4f7a25.ts.net:9449",
		);
		expect(saved.local8gFocus).toBeUndefined();
	});

	it("selects VRM item from naia-settings and marks as active", async () => {
		localStorage.setItem("naia-adk-path", "/home/user/naia-adk");
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "list_naia_assets")
				return Promise.resolve(["03-OL_Woman.vrm"]);
			return Promise.resolve([]);
		});
		render(<SettingsTab />);
		gotoSettingsTab("avatar");

		const vrmBtn = await screen.findByAltText("03-OL_Woman");
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
				return Promise.resolve(["03-OL_Woman.vrm"]);
			return Promise.resolve([]);
		});
		render(<SettingsTab />);

		// VRM picker lives on the avatar tab — select VRM (auto-applies via handleVrmSelect)
		gotoSettingsTab("avatar");
		const vrmImg = await screen.findByAltText("03-OL_Woman");
		fireEvent.click(vrmImg.closest("button")!);

		// VRM auto-applied — verify immediately without Save
		const savedVrm = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(savedVrm.vrmModel).toContain("03-OL_Woman.vrm");
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
		// 9-tab restructure: profile|brain|voice|avatar|persona|memory|knowledge|skills|general
		const tabBtns = document.querySelectorAll(".settings-tab-btn");
		expect(tabBtns.length).toBe(9);
	});

	it("GPU 프로파일 = 자동 설정 — local-llm-voice-16g 선택 시 두뇌·음성·호스트가 로컬로 전환 (2026-07-15)", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-3.5-flash",
				naiaKey: "nk",
				ttsProvider: "nextain",
				// localhost raw /tts 잔재 — 로컬 티어 선택이 로컬 façade 기본(:8910)으로 교정해야 한다.
				vllmTtsHost: "http://localhost:8892",
				// 아바타 티어를 거쳐온 잔재 — LLM+음성 티어(아바타 비포함)는 VRM 으로 복원해야 한다.
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
			target: { value: "local-llm-voice-16g" },
		});

		const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
		// 두뇌: 프로파일이 로컬 LLM 을 포함 → ollama + compact 기본(DNA3.0-4B)으로 자동 전환.
		expect(saved.provider).toBe("ollama");
		expect(saved.model).toBe("hf.co/mradermacher/DNA3.0-4B-GGUF:Q4_K_M");
		// 음성: 로컬 음성으로 자동 전환 + 원격 호스트 잔재를 로컬 façade 기본으로 교정.
		expect(saved.ttsProvider).toBe("naia-local-voice");
		expect(saved.ttsEnabled).toBe(true);
		expect(saved.vllmTtsHost).toBe("http://localhost:8910");
		expect(saved.localGpuTier).toBe("local-llm-voice-16g");
		// 아바타: 이 티어는 Ditto 비포함 → VRM 으로 복원 (nva 잔재 버그 수정, 2026-07-15).
		expect(saved.avatarProvider).toBe("vrm");
	});

	it("always tears down the local cascade and unloads Ollama when profile is None", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "ollama",
				model: "demo-local-model",
				ollamaHost: "http://localhost:11434",
				naiaKey: "nk",
				localGpuTier: "local-llm-voice-16g",
			}),
		);
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "detect_gpu_vram") return Promise.resolve(16);
			if (cmd === "cascade_status") return Promise.resolve(false);
			return Promise.resolve(undefined);
		});
		const fetchMock = vi.fn().mockImplementation(async (url: string) => ({
			ok: true,
			status: 200,
			json: async () => (url.endsWith("/api/tags") ? { models: [] } : []),
		}));
		vi.stubGlobal("fetch", fetchMock);

		render(<SettingsTab />);
		gotoSettingsTab("profile");
		fireEvent.change(document.getElementById("local-gpu-tier") as HTMLElement, {
			target: { value: "off" },
		});

		await vi.waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith("stop_cascade");
			expect(fetchMock).toHaveBeenCalledWith(
				"http://localhost:11434/api/generate",
				expect.objectContaining({
					body: JSON.stringify({
						model: "demo-local-model",
						keep_alive: 0,
					}),
				}),
			);
		});
	});

	it("renders S-SLOT gate + 3 groups (Brain/Voice/Avatar) without moving canonical controls", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-3.5-flash",
				naiaKey: "nk",
				localGpuTier: "auto",
			}),
		);
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "detect_gpu_vram") return Promise.resolve(6);
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
		// FR-SLOT.2: 3 groups + 6 slots.
		expect(document.querySelector("[data-testid='slot-groups']")).toBeTruthy();
		expect(document.querySelector("[data-testid='slot-group-brain']")).toBeTruthy();
		expect(document.querySelector("[data-testid='slot-group-voice']")).toBeTruthy();
		expect(document.querySelector("[data-testid='slot-group-avatar']")).toBeTruthy();
		expect(document.querySelector("[data-testid='slot-main']")).toBeTruthy();
		expect(document.querySelector("[data-testid='slot-sub']")).toBeTruthy();
		expect(document.querySelector("[data-testid='slot-embedding']")).toBeTruthy();
		expect(document.querySelector("[data-testid='slot-stt']")).toBeTruthy();
		expect(document.querySelector("[data-testid='slot-tts']")).toBeTruthy();
		expect(document.querySelector("[data-testid='slot-avatar']")).toBeTruthy();
		// R1-7: 3-profile residue removed.
		expect(document.querySelector("[data-testid='engine-profile-summary']")).toBeNull();
		expect(document.querySelector("[data-testid='engine-profile-naia']")).toBeNull();
		expect(document.querySelector("[data-testid='engine-profile-byo']")).toBeNull();
		expect(document.querySelector("[data-testid='engine-profile-local']")).toBeNull();
		// engine-core-summary 제거(2026-06-30): slot-groups 두뇌 그룹과 100% 중복.
		// engine-gpu-summary·tier-recommendations 제거(2026-07-07): GPU 프로파일 드롭다운 +
		// 로컬 집중 + 슬롯 개요와 중복 → 자리 절약. capability 요약만 고유 정보로 유지.
		expect(document.querySelector("[data-testid='engine-core-summary']")).toBeNull();
		expect(document.querySelector("[data-testid='engine-gpu-summary']")).toBeNull();
		expect(document.querySelector("[data-testid='tier-recommendations']")).toBeNull();
		expect(document.querySelector("[data-testid='engine-capability-summary']")).toBeTruthy();
		// Canonical controls remain on ai tab, not engine.
		expect(document.getElementById("provider-select")).toBeNull();
		expect(document.getElementById("model-select")).toBeNull();
		gotoSettingsTab("brain");
		expect(document.getElementById("provider-select")).toBeTruthy();
		expect(document.getElementById("model-select")).toBeTruthy();
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

	it("apply Gemini defaults fills unset slots non-destructively (FR-SLOT.3)", async () => {
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
		expect(saved.memoryLlmProvider).toBe("naia");
		expect(saved.memoryLlmModel).toBe("gemini-3.1-flash-lite");
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

// ── #296: Agent health check panel ───────────────────────────────────────────

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
