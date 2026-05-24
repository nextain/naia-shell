import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const eventListeners = vi.hoisted(
	() => new Map<string, (event: { payload: unknown }) => void | Promise<void>>(),
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

import { directToolCall } from "../../lib/chat-service";
vi.mock("../../lib/chat-service", () => ({
	directToolCall: vi.fn().mockResolvedValue({ success: false }),
	sendAuthUpdate: vi.fn().mockResolvedValue(undefined),
	sendNotifyConfig: vi.fn().mockResolvedValue(undefined),
	sendCredsUpdate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/gateway-sync", () => ({
	restartGateway: vi.fn().mockResolvedValue(undefined),
	syncToGateway: vi.fn().mockResolvedValue(undefined),
}));

import { SettingsTab } from "../SettingsTab";

describe("SettingsTab", () => {
	afterEach(() => {
		cleanup();
		localStorage.clear();
		eventListeners.clear();
		vi.clearAllMocks();
		vi.unstubAllGlobals();
	});

	it("renders dynamic models with pricing info", async () => {
		mockInvoke.mockResolvedValue([]);
		(directToolCall as any).mockResolvedValueOnce({
			success: true,
			output: JSON.stringify({
				models: [
					{
						id: "test-model-1",
						name: "Test Model",
						provider: "gemini",
						price: { input: 1.5, output: 2.5 },
					},
				],
			}),
		});
		render(<SettingsTab />);

		await vi.waitFor(() => {
			expect(screen.getByText("Test Model ($1.5 / $2.5)")).toBeDefined();
		});
	});

	it("accepts gateway model payload as plain array", async () => {
		mockInvoke.mockResolvedValue([]);
		(directToolCall as any).mockResolvedValueOnce({
			success: true,
			output: JSON.stringify([
				{
					id: "gemini/gemini-ultra-test",
					name: "Gemini Ultra Test",
				},
			]),
		});
		render(<SettingsTab />);

		await vi.waitFor(() => {
			expect(screen.getByText("Gemini Ultra Test")).toBeDefined();
		});
	});

	it("renders provider select and API key input", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		const providerSelect = document.getElementById("provider-select");
		expect(providerSelect).toBeDefined();
		expect(screen.getByLabelText(/^API/i)).toBeDefined();
	});

	it("replaces API key input with Naia account UI", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		const providerSelect = document.getElementById(
			"provider-select",
		) as HTMLSelectElement;
		fireEvent.change(providerSelect, { target: { value: "nextain" } });
		expect(screen.queryByLabelText(/^API/i)).toBeNull();
		expect(
			screen.getByText("Naia 계정 로그인으로 API 키 없이 사용할 수 있습니다."),
		).toBeDefined();
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

		// STT provider selector is always visible in voice section
		const sttSelect = screen
			.getByText(/Vosk/)
			?.closest("select") as HTMLSelectElement;
		expect(sttSelect).toBeDefined();
		// Default is empty (no provider set) — vosk is an available option
		expect(sttSelect.querySelector('option[value="vosk"]')).toBeDefined();
	});

	it("hides API key input for Claude Code CLI provider", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		const providerSelect = document.getElementById(
			"provider-select",
		) as HTMLSelectElement;
		fireEvent.change(providerSelect, { target: { value: "claude-code-cli" } });
		expect(screen.queryByLabelText(/^API/i)).toBeNull();
		expect(
			screen.getByText(
				"Claude Code CLI provider는 로컬 CLI 로그인 세션을 사용합니다.",
			),
		).toBeDefined();
	});

	it("renders VRM model picker — shows empty state when no VRMs in naia-settings", () => {
		// No adkPath set → listNaiaAssets returns [] without calling invoke
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		// Empty state message is shown in the vrm-list
		expect(screen.getByText(/vrm-files|VRM 파일을 추가/i)).toBeDefined();
	});

	it("renders VRM items from naia-settings when invoke returns filenames", async () => {
		// Set adkPath so listNaiaAssets actually calls invoke
		localStorage.setItem("naia-adk-path", "/home/user/naia-adk");
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "list_naia_assets") return Promise.resolve(["03-OL_Woman.vrm", "04-Hood_Boy.vrm"]);
			return Promise.resolve([]);
		});
		render(<SettingsTab />);

		await vi.waitFor(() => {
			// VRM items rendered with alt text matching filenames (minus .vrm)
			expect(screen.getByAltText("03-OL_Woman")).toBeDefined();
			expect(screen.getByAltText("04-Hood_Boy")).toBeDefined();
		});
	});

	it("renders background image picker with 없음(기본) option", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		// The "clear" button is always present (hardcoded Korean, exact text)
		expect(screen.getByRole("button", { name: "없음 (기본)" })).toBeDefined();
	});

	it("renders VRM custom file button", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		expect(screen.getByText(/커스텀|Custom/i)).toBeDefined();
	});

	it("selects VRM item from naia-settings and marks as active", async () => {
		localStorage.setItem("naia-adk-path", "/home/user/naia-adk");
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "list_naia_assets") return Promise.resolve(["03-OL_Woman.vrm"]);
			return Promise.resolve([]);
		});
		render(<SettingsTab />);

		const vrmBtn = await screen.findByAltText("03-OL_Woman");
		// Click the parent button
		fireEvent.click(vrmBtn.closest("button")!);
		expect(vrmBtn.closest("button")!.className).toContain("active");
	});

	it("renders memory section with empty state", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		// Switch to memory tab first (tab bar separates memory from settings)
		const memoryTabBtn = document.querySelector(
			".settings-tab-btn:not(.settings-tab-btn--active)",
		) as HTMLButtonElement;
		fireEvent.click(memoryTabBtn);
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
		// Switch to memory tab first
		const memoryTabBtn = document.querySelector(
			".settings-tab-btn:not(.settings-tab-btn--active)",
		) as HTMLButtonElement;
		fireEvent.click(memoryTabBtn);

		await vi.waitFor(() => {
			expect(screen.getByText("favorite_lang is Rust")).toBeDefined();
			expect(screen.getByText("Rust")).toBeDefined();
		});
	});

	it("saves config with VRM model from naia-settings", async () => {
		localStorage.setItem("naia-adk-path", "/home/user/naia-adk");
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "list_naia_assets") return Promise.resolve(["03-OL_Woman.vrm"]);
			return Promise.resolve([]);
		});
		render(<SettingsTab />);

		// Set API key
		const apiInput = screen.getByLabelText(/^API/i);
		fireEvent.change(apiInput, { target: { value: "test-key" } });

		// Wait for VRM item to appear and select it
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
		expect(screen.getByTitle("Light")).toBeDefined();
		expect(screen.getByTitle("Dark")).toBeDefined();
	});

	it("shows error for empty API key", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		// Use the settings-save-btn class to find the correct save button
		// (avoid matching "저장된 기억이..." text nodes that also contain "저장")
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

	it("renders settings tab bar with two tab buttons", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		const tabBar = document.querySelector(".settings-tab-bar");
		expect(tabBar).toBeTruthy();
		const tabBtns = document.querySelectorAll(".settings-tab-btn");
		expect(tabBtns.length).toBe(2);
	});

	it("first tab button is active by default", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		const activeBtn = document.querySelector(".settings-tab-btn--active");
		expect(activeBtn).toBeTruthy();
		// The active tab is the first one (settings)
		const allBtns = document.querySelectorAll(".settings-tab-btn");
		expect(allBtns[0]?.classList.contains("settings-tab-btn--active")).toBe(
			true,
		);
		expect(allBtns[1]?.classList.contains("settings-tab-btn--active")).toBe(
			false,
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
		// Click the second tab button (memory)
		const tabBtns = document.querySelectorAll(".settings-tab-btn");
		fireEvent.click(tabBtns[1]!);
		// Now the second button is active
		expect(tabBtns[1]?.classList.contains("settings-tab-btn--active")).toBe(
			true,
		);
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
		// Initially danger zone is visible (settings tab)
		expect(document.querySelector(".settings-danger-zone")).toBeTruthy();
		// Switch to memory tab (second button)
		const tabBtns = document.querySelectorAll(".settings-tab-btn");
		fireEvent.click(tabBtns[1]!);
		expect(document.querySelector(".settings-danger-zone")).toBeNull();
	});

	it("switching back to settings tab restores danger-zone and hides memory section", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		const tabBtns = document.querySelectorAll(".settings-tab-btn");
		// Go to memory tab
		fireEvent.click(tabBtns[1]!);
		// Go back to settings tab (first button)
		fireEvent.click(tabBtns[0]!);
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
		expect(document.querySelector("[data-testid='agent-health-section']")).toBeTruthy();
		expect(document.querySelector("[data-testid='agent-health-check-btn']")).toBeTruthy();
	});

	it("shows idle status initially", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		const statusEl = document.querySelector("[data-testid='agent-health-status']") as HTMLElement;
		expect(statusEl).toBeTruthy();
		// In English test env, "Not checked" is shown
		expect(statusEl.classList.contains("agent-health-status--idle")).toBe(true);
	});

	it("clicking check button calls gateway_health invoke", async () => {
		mockInvoke.mockResolvedValue(true);
		render(<SettingsTab />);
		const btn = document.querySelector("[data-testid='agent-health-check-btn']") as HTMLButtonElement;
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
		const btn = document.querySelector("[data-testid='agent-health-check-btn']") as HTMLButtonElement;
		fireEvent.click(btn);

		await vi.waitFor(() => {
			const statusEl = document.querySelector("[data-testid='agent-health-status']") as HTMLElement;
			expect(statusEl.classList.contains("agent-health-status--healthy")).toBe(true);
		});
	});

	it("shows unhealthy status when gateway_health returns false", async () => {
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "gateway_health") return false;
			return [];
		});
		render(<SettingsTab />);
		const btn = document.querySelector("[data-testid='agent-health-check-btn']") as HTMLButtonElement;
		fireEvent.click(btn);

		await vi.waitFor(() => {
			const statusEl = document.querySelector("[data-testid='agent-health-status']") as HTMLElement;
			expect(statusEl.classList.contains("agent-health-status--unhealthy")).toBe(true);
		});
	});

	it("agent-health-section is on the settings tab (not memory tab)", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		// By default on settings tab — health section should be visible
		expect(document.querySelector("[data-testid='agent-health-section']")).toBeTruthy();
		// Switch to memory tab — health section should disappear
		const tabBtns = document.querySelectorAll(".settings-tab-btn");
		fireEvent.click(tabBtns[1]!);
		expect(document.querySelector("[data-testid='agent-health-section']")).toBeNull();
	});

	it("shows unhealthy status when gateway_health throws", async () => {
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "gateway_health") throw new Error("Agent not running");
			return [];
		});
		render(<SettingsTab />);
		const btn = document.querySelector("[data-testid='agent-health-check-btn']") as HTMLButtonElement;
		fireEvent.click(btn);

		await vi.waitFor(() => {
			const statusEl = document.querySelector("[data-testid='agent-health-status']") as HTMLElement;
			expect(statusEl.classList.contains("agent-health-status--unhealthy")).toBe(true);
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

	it("renders log viewer button on settings tab", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		expect(document.querySelector("[data-testid='log-viewer-btn']")).toBeTruthy();
	});

	it("log viewer button is on settings tab only (not memory tab)", () => {
		mockInvoke.mockResolvedValue([]);
		render(<SettingsTab />);
		// Settings tab: visible
		expect(document.querySelector("[data-testid='log-viewer-btn']")).toBeTruthy();
		// Switch to memory tab: hidden
		const tabBtns = document.querySelectorAll(".settings-tab-btn");
		fireEvent.click(tabBtns[1]!);
		expect(document.querySelector("[data-testid='log-viewer-btn']")).toBeNull();
	});

	it("clicking log viewer button calls get_gateway_log_path then openPath", async () => {
		const logPath = "/home/user/.naia/logs/gateway.log";
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "get_gateway_log_path") return logPath;
			return [];
		});
		mockOpenPath.mockResolvedValue(undefined);

		render(<SettingsTab />);
		const btn = document.querySelector("[data-testid='log-viewer-btn']") as HTMLButtonElement;
		fireEvent.click(btn);

		await vi.waitFor(() => {
			const logPathCalls = (mockInvoke as any).mock.calls.filter(
				([cmd]: [string]) => cmd === "get_gateway_log_path",
			);
			expect(logPathCalls.length).toBeGreaterThanOrEqual(1);
		});

		await vi.waitFor(() => {
			expect(mockOpenPath).toHaveBeenCalledWith(logPath);
		});
	});
});
