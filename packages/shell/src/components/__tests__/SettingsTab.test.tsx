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

// SettingsTab was rewritten into a 5-tab layout (#313): the old flat / 2-tab
// structure split into general | ai | skills | memory | info. Provider+API key,
// STT/TTS and the model list moved to the "ai" tab; memory to "memory";
// log viewer + danger zone to "info". Tests navigate via this helper.
// 탭 순서: general | ai | models | skills | memory | info. "models"(통합 AI 모델 탭, 3-컴포넌트)
// 가 ai 와 skills 사이에 추가되며 skills/memory/info 인덱스가 +1 시프트됨.
const SETTINGS_TAB_INDEX = {
	general: 0,
	engine: 1,
	ai: 2,
	models: 3,
	skills: 4,
	memory: 5,
	info: 6,
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
		gotoSettingsTab("ai");

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
		gotoSettingsTab("ai");

		await vi.waitFor(() => {
			expect(screen.getByText(/gemini-ultra-test/)).toBeDefined();
		});
	});

	it("renders provider select and API key input", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		gotoSettingsTab("ai");
		const providerSelect = document.getElementById("provider-select");
		expect(providerSelect).toBeDefined();
		expect(screen.getByLabelText(/^API/i)).toBeDefined();
	});

	it("hides API key input for Naia (nextain) provider", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		gotoSettingsTab("ai");
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
		gotoSettingsTab("ai");

		// STT provider selector is in the voice section of the AI tab
		const sttSelect = screen
			.getAllByText(/Naia Voice/)[0]
			?.closest("select") as HTMLSelectElement;
		expect(sttSelect).toBeDefined();
		// Default is empty (no provider set) — vosk is an available option
		expect(sttSelect.querySelector('option[value="vosk"]')).toBeDefined();
	});

	it("hides API key input for Claude Code CLI provider", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		gotoSettingsTab("ai");
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
		gotoSettingsTab("general");
		// Empty state message is shown in the vrm-list
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
		gotoSettingsTab("general");

		await vi.waitFor(() => {
			// VRM items rendered with alt text matching filenames (minus .vrm)
			expect(screen.getByAltText("03-OL_Woman")).toBeDefined();
			expect(screen.getByAltText("04-Hood_Boy")).toBeDefined();
		});
	});

	it("renders background image picker with 없음(기본) option", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		gotoSettingsTab("general");
		// The "clear" button is always present (hardcoded Korean, exact text)
		expect(screen.getByRole("button", { name: "없음 (기본)" })).toBeDefined();
	});

	it("renders VRM custom file button", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		gotoSettingsTab("general");
		expect(screen.getByText(/커스텀|Custom/i)).toBeDefined();
	});

	it("selects VRM item from naia-settings and marks as active", async () => {
		localStorage.setItem("naia-adk-path", "/home/user/naia-adk");
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "list_naia_assets")
				return Promise.resolve(["03-OL_Woman.vrm"]);
			return Promise.resolve([]);
		});
		render(<SettingsTab />);
		gotoSettingsTab("general");

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
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "list_naia_assets")
				return Promise.resolve(["03-OL_Woman.vrm"]);
			return Promise.resolve([]);
		});
		render(<SettingsTab />);

		// Set API key (AI tab); state persists across tab switches
		gotoSettingsTab("ai");
		const apiInput = screen.getByLabelText(/^API/i);
		fireEvent.change(apiInput, { target: { value: "test-key" } });

		// VRM picker lives on the general tab — switch back, then select it
		gotoSettingsTab("general");
		const vrmImg = await screen.findByAltText("03-OL_Woman");
		fireEvent.click(vrmImg.closest("button")!);

		// Save via the settings-save-btn (button with "Apply" or "적용" text)
		const saveBtn = document.querySelector(".settings-save-btn") as HTMLElement;
		fireEvent.click(saveBtn);

		const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(saved.apiKey).toBe("test-key");
		// vrmModel is the full naia-settings path
		expect(saved.vrmModel).toContain("03-OL_Woman.vrm");
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
		gotoSettingsTab("ai");
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
		// general | ai | models | skills | memory | info (models 통합 탭 추가)
		const tabBtns = document.querySelectorAll(".settings-tab-btn");
		expect(tabBtns.length).toBe(7);
	});

	it("renders Profile & Engine entrypoint without moving canonical controls", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-2.5-flash",
				localGpuTier: "auto",
			}),
		);
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "detect_gpu_vram") return Promise.resolve(6);
			return Promise.resolve([]);
		});
		render(<SettingsTab />);
		gotoSettingsTab("engine");

		expect(screen.getAllByText("Profile & Engine").length).toBeGreaterThan(0);
		expect(
			document.querySelector("[data-testid='engine-profile-summary']"),
		).toBeTruthy();
		expect(
			document.querySelector("[data-testid='engine-core-summary']"),
		).toBeTruthy();
		expect(document.querySelector("[data-testid='engine-profile-naia']")).toBeTruthy();
		expect(document.querySelector("[data-testid='engine-profile-byo']")).toBeTruthy();
		expect(document.querySelector("[data-testid='engine-profile-local']")).toBeTruthy();
		expect(
			document.querySelector("[data-testid='engine-gpu-summary']"),
		).toBeTruthy();
		expect(
			document.querySelector("[data-testid='engine-capability-summary']"),
		).toBeTruthy();
		await vi.waitFor(() => {
			expect(screen.getByText(/Detected VRAM: 6 GB/)).toBeDefined();
		});
		expect(
			screen.getByText(/6GB: external LLM \+ local voice candidate/),
		).toBeDefined();
		expect(screen.getByText(/Local capabilities: tts/)).toBeDefined();
		expect(screen.getByText("Voice output needs external TTS")).toBeDefined();
		expect(document.getElementById("provider-select")).toBeNull();
		expect(document.getElementById("model-select")).toBeNull();
		expect(document.getElementById("local-gpu-tier")).toBeNull();

		gotoSettingsTab("ai");
		expect(document.getElementById("provider-select")).toBeTruthy();
		expect(document.getElementById("model-select")).toBeTruthy();
		const localGpuTier = document.getElementById(
			"local-gpu-tier",
		) as HTMLSelectElement | null;
		expect(localGpuTier).toBeTruthy();
		expect(screen.getByLabelText("Local GPU profile")).toBe(localGpuTier);
		expect(
			Array.from(localGpuTier!.options).some((option) =>
				option.textContent?.includes("local voice candidate"),
			),
		).toBe(true);
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

	it("profile cards persist provider, memory routing, and GPU budget atomically", async () => {
		localStorage.setItem("naia-adk-path", "D:\\alpha-adk");
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);

		fireEvent.click(screen.getByTestId("engine-profile-local"));
		let saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(saved.provider).toBe("ollama");
		expect(saved.memoryLlmProvider).toBe("ollama");
		expect(saved.memoryEmbeddingProvider).toBe("ollama");
		expect(saved.localGpuTier).toBe("auto");
		await vi.waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith(
				"write_naia_config",
				expect.objectContaining({
					adkPath: "D:\\alpha-adk",
					json: expect.stringContaining('"provider": "ollama"'),
				}),
			);
		});
		const writeCall = mockInvoke.mock.calls.find(
			(call) => call[0] === "write_naia_config",
		);
		expect(writeCall).toBeTruthy();
		const written = JSON.parse((writeCall![1] as { json: string }).json);
		expect(written.memoryLlmProvider).toBe("ollama");
		expect(written.memoryEmbeddingProvider).toBe("ollama");
		expect(written.localGpuTier).toBe("auto");
		gotoSettingsTab("ai");
		expect((document.getElementById("provider-select") as HTMLSelectElement).value).toBe(
			"ollama",
		);
		expect((document.getElementById("local-gpu-tier") as HTMLSelectElement).value).toBe(
			"auto",
		);

		gotoSettingsTab("models");
		expect(
			(document.querySelector(
				'input[name="memory-llm"][value="ollama"]',
			) as HTMLInputElement).checked,
		).toBe(true);
		expect(
			(document.querySelector(
				'input[name="memory-embedding"][value="ollama"]',
			) as HTMLInputElement).checked,
		).toBe(true);

		gotoSettingsTab("engine");
		fireEvent.click(screen.getByTestId("engine-profile-byo"));
		saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(saved.provider).toBe("gemini");
		expect(saved.memoryLlmProvider).toBeUndefined();
		expect(saved.memoryEmbeddingProvider).toBeUndefined();
		expect(saved.localGpuTier).toBeUndefined();
		gotoSettingsTab("ai");
		expect((document.getElementById("provider-select") as HTMLSelectElement).value).toBe(
			"gemini",
		);
		expect((document.getElementById("local-gpu-tier") as HTMLSelectElement).value).toBe(
			"off",
		);
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
		gotoSettingsTab("info");
		expect(document.querySelector(".settings-danger-zone")).toBeTruthy();
		// Switch to memory tab — danger zone hidden
		gotoSettingsTab("memory");
		expect(document.querySelector(".settings-danger-zone")).toBeNull();
	});

	it("switching back to info tab restores danger-zone and hides memory section", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		// Info tab → memory tab → back to info tab (danger zone lives on info).
		gotoSettingsTab("info");
		gotoSettingsTab("memory");
		gotoSettingsTab("info");
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
		gotoSettingsTab("info");
		expect(
			document.querySelector("[data-testid='log-viewer-btn']"),
		).toBeTruthy();
	});

	it("log viewer button is on info tab only (not memory tab)", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		// Info tab: visible
		gotoSettingsTab("info");
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
		gotoSettingsTab("info");
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
