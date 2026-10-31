// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, (event: unknown) => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/test", join: async (...parts: string[]) => parts.join("/") }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (event: string, handler: (event: unknown) => void) => { mock.listeners.set(event, handler); return () => mock.listeners.delete(event); } }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), openPath: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn().mockResolvedValue({ get: vi.fn().mockResolvedValue(null), set: vi.fn(), delete: vi.fn(), save: vi.fn() }) }));
vi.mock("../../lib/chat-service", () => ({
	activateNaiaLlm: vi.fn(), directToolCall: vi.fn().mockResolvedValue({ success: false }),
	reloadAgentSettings: vi.fn().mockResolvedValue(undefined), sendAuthUpdate: vi.fn(),
	sendAuthUpdateStrict: vi.fn(), sendNotifyConfig: vi.fn(), sendCredsUpdate: vi.fn(),
}));
vi.mock("../../lib/voice/host-profile", () => ({ voiceHostProfile: async () => ({ profile: "windows_trt_6g", gpus: [], gpuChoiceIsMeaningful: false }), resetVoiceHostProfileCache: () => {} }));

import { readNaiaConfig } from "../../lib/adk-store";
import { type AppConfig, mergeBootConfig } from "../../lib/config";
import { readConfiguredLlmRoles } from "../../lib/llm/roles";
import { setLocale } from "../../lib/i18n";
import { AdkSetupScreen } from "../AdkSetupScreen";
import { SettingsTab } from "../SettingsTab";

describe("IT-SM-14 imported workspace and delayed catalog", () => {
	afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); mock.listeners.clear(); });
	it("imports the existing file, preserves legacy memory after Luna arrives, and reopens the saved small selection", async () => {
		await setLocale("en");
		const workspace = "/test/existing";
		const files = new Map<string, string>();
		const legacy = { provider: "nextain", model: "solar-pro4", apiKey: "", memoryLlmProvider: "ollama", memoryLlmModel: "old-memory", memoryLlmBaseUrl: "http://localhost:11434", memoryLlmCredentialRef: "memory-ref", memorySurfacing: "off" };
		files.set(`${workspace}/config`, JSON.stringify(legacy));
		mock.invoke.mockReset().mockImplementation(async (command: string, args?: { adkPath?: string; json?: string }) => {
			if (command === "workspace_detect_adk_root") return "";
			if (command === "inspect_adk_dir") return "has_settings";
			if (command === "read_naia_config" || command === "read_naia_ui_config") return files.get(`${args?.adkPath}/${command === "read_naia_config" ? "config" : "ui"}`) ?? "";
			if (command === "write_naia_config" || command === "write_naia_ui_config") { files.set(`${args?.adkPath}/${command === "write_naia_config" ? "config" : "ui"}`, args?.json ?? ""); return; }
			if (command === "secure_store_get") return null;
			return [];
		});
		let releaseCatalog!: () => void;
		const catalogGate = new Promise<void>((resolve) => { releaseCatalog = resolve; });
		vi.stubGlobal("fetch", vi.fn(async (url: string) => {
			if (String(url).includes("/v1/pricing")) { await catalogGate; return { ok: true, json: async () => [{ model_key: "azure:gpt-5.6-luna", input_price_per_million: 0.1, output_price_per_million: 0.5 }] }; }
			return { ok: false, json: async () => [] };
		}));
		const complete = vi.fn();
		const setup = render(<AdkSetupScreen onComplete={complete} />);
		fireEvent.click(setup.container.querySelector<HTMLButtonElement>(".adk-setup-option-card")!);
		const input = setup.container.querySelector<HTMLInputElement>(".adk-setup-input")!;
		fireEvent.change(input, { target: { value: workspace } });
		fireEvent.click(setup.container.querySelector<HTMLButtonElement>(".adk-setup-confirm-btn")!);
		fireEvent.click((await screen.findByText("Use existing data")).closest("button")!);
		await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
		expect(localStorage.getItem("naia-adk-path")).toBe(workspace);
		expect(JSON.parse(localStorage.getItem("naia-config")!)).toMatchObject(legacy);
		setup.unmount();
		const settings = render(<SettingsTab />);
		fireEvent.click(settings.container.querySelector<HTMLButtonElement>('[data-settings-tab="brain"]')!);
		const select = screen.getByTestId("small-model-select") as HTMLSelectElement;
		expect(select.value).toBe(JSON.stringify(["ollama", "old-memory"]));
		await act(async () => { releaseCatalog(); await catalogGate; });
		await waitFor(() => expect([...select.options].some(option => option.value === JSON.stringify(["nextain", "gpt-5.6-luna"]))).toBe(true));
		expect(select.value).toBe(JSON.stringify(["ollama", "old-memory"]));
		expect(JSON.parse(localStorage.getItem("naia-config")!).subLlmModel).toBeUndefined();
		fireEvent.change(select, { target: { value: JSON.stringify(["nextain", "gpt-5.6-luna"]) } });
		await waitFor(() => expect(JSON.parse(files.get(`${workspace}/config`)!).subLlmModel).toBe("gpt-5.6-luna"));
		settings.unmount();
		localStorage.removeItem("naia-config");
		const saved = await readNaiaConfig(workspace);
		const restored = mergeBootConfig(null, saved ? { ...saved } : null, null);
		expect(restored).toMatchObject({ memoryLlmProvider: "ollama", memoryLlmModel: "old-memory", memoryLlmBaseUrl: "http://localhost:11434", memoryLlmCredentialRef: "memory-ref", memorySurfacing: "off", subLlmModel: "gpt-5.6-luna" });
		expect(readConfiguredLlmRoles(restored as unknown as AppConfig).sub).toMatchObject({ provider: "nextain", model: "gpt-5.6-luna", thinkingLevel: "low" });
	});
});
