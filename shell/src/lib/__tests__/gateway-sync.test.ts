import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock Tauri invoke
const mockInvoke = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));

const mockLoadConfig = vi.fn();
vi.mock("../config", () => ({
	loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
	LAB_GATEWAY_URL: "https://naia-gateway.test",
}));

vi.mock("../i18n", () => ({ getLocale: () => "ko" }));
vi.mock("../logger", () => ({ Logger: { warn: vi.fn(), info: vi.fn() } }));

import { syncToGateway } from "../gateway-sync";

beforeEach(() => {
	mockInvoke.mockClear();
	mockLoadConfig.mockReturnValue(null);
});

describe("syncToGateway", () => {
	it("passes provider and model to Tauri command", async () => {
		await syncToGateway("gemini", "gemini-3-flash-preview");
		expect(mockInvoke).toHaveBeenCalledWith(
			"sync_gateway_config",
			expect.objectContaining({
				params: expect.objectContaining({
					provider: "gemini",
					model: "gemini-3-flash-preview",
				}),
			}),
		);
	});

	it("TTS settings are always null (TTS handled by Shell, not Gateway)", async () => {
		await syncToGateway("gemini", "gemini-3-flash-preview");

		const callArgs = mockInvoke.mock.calls[0];
		const params = callArgs[1].params;
		expect(params.tts_provider).toBeNull();
		expect(params.tts_voice).toBeNull();
		expect(params.tts_auto).toBeNull();
		expect(params.tts_mode).toBeNull();
	});

	it("persona does not include facts (handled by Agent MemorySystem)", async () => {
		await syncToGateway("gemini", "gemini-3-flash-preview");

		const callArgs = mockInvoke.mock.calls[0];
		const persona: string = callArgs[1].params.persona;
		expect(persona).not.toContain("Known facts");
	});

	it("ignores _systemPrompt parameter and always builds internally", async () => {
		mockLoadConfig.mockReturnValue({
			persona: "Custom persona",
			userName: "Luke",
		});

		await syncToGateway(
			"gemini",
			"gemini-3-flash-preview",
			undefined, // apiKey
			undefined, // persona (will fall back to config)
			undefined, // agentName
			undefined, // userName
			"This should be ignored", // _systemPrompt
		);

		const callArgs = mockInvoke.mock.calls[0];
		const persona: string = callArgs[1].params.persona;
		expect(persona).toContain("Custom persona");
		expect(persona).not.toBe("This should be ignored");
		expect(persona).toContain("Luke");
	});

	it("merges caller overrides with config fallbacks", async () => {
		mockLoadConfig.mockReturnValue({
			persona: "You are Naia (낸), a friendly AI companion.",
			agentName: "Naia",
			userName: "ConfigUser",
			discordDefaultUserId: "config-discord-id",
		});

		await syncToGateway(
			"gemini",
			"gemini-3-flash-preview",
			undefined, // apiKey
			undefined, // persona (falls back to config)
			"CallerAgent", // agentName override
		);

		const callArgs = mockInvoke.mock.calls[0];
		const persona: string = callArgs[1].params.persona;
		expect(persona).toContain("CallerAgent");
		expect(persona).not.toContain("Naia (낸)");
		expect(persona).toContain("ConfigUser");
	});
});
