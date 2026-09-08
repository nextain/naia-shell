// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../lib/config";

type StartupMessageArgs = {
	adkPath: string | null;
	message: string;
};

const mocks = vi.hoisted(() => ({
	invoke: vi.fn<(command: string, args: StartupMessageArgs) => Promise<void>>(
		() => Promise.resolve(),
	),
	listen: vi.fn(() => Promise.resolve(vi.fn())),
	loadConfig: vi.fn(),
	loadConfigWithSecrets: vi.fn<() => Promise<AppConfig | null>>(() =>
		Promise.resolve(null),
	),
	saveConfig: vi.fn(),
	syncLinkedChannels: vi.fn(() => Promise.resolve()),
	sendAuthUpdate: vi.fn(() => Promise.resolve()),
	sendCredsUpdate: vi.fn(() => Promise.resolve()),
	sendNotifyConfig: vi.fn(() => Promise.resolve()),
	loggerWarn: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../../lib/channel-sync", () => ({
	syncLinkedChannels: mocks.syncLinkedChannels,
}));
vi.mock("../../lib/chat-service", () => ({
	sendAuthUpdate: mocks.sendAuthUpdate,
	sendCredsUpdate: mocks.sendCredsUpdate,
	sendNotifyConfig: mocks.sendNotifyConfig,
}));
vi.mock("../../lib/config", () => ({
	loadConfig: mocks.loadConfig,
	loadConfigWithSecrets: mocks.loadConfigWithSecrets,
	saveConfig: mocks.saveConfig,
}));
vi.mock("../../lib/logger", () => ({
	Logger: { warn: mocks.loggerWarn },
}));

import { useAgentAuthSync } from "../useAgentAuthSync";

describe("useAgentAuthSync — structured main model preservation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.loadConfig.mockReturnValue(undefined);
		mocks.loadConfigWithSecrets.mockResolvedValue(null);
	});

	it("does not migrate the legacy flat model over a dynamic structured main", () => {
		mocks.loadConfig.mockReturnValue({
			provider: "nextain",
			model: "retired-flat-model",
			llmRoles: {
				main: {
					provider: "nextain",
					model: "gemini-3.7-flash",
					inherit: false,
				},
			},
		});

		renderHook(() => useAgentAuthSync(false, false, true));

		expect(mocks.saveConfig).not.toHaveBeenCalled();
	});

	it("still migrates a genuinely retired flat model", () => {
		mocks.loadConfig.mockReturnValue({
			provider: "nextain",
			model: "retired-flat-model",
		});

		renderHook(() => useAgentAuthSync(false, false, true));

		expect(mocks.saveConfig).toHaveBeenCalledWith(
			expect.objectContaining({ model: "deepseek-v4-flash" }),
		);
	});

	it("does not replay a Nextain direct key as naia-anyllm credentials", async () => {
		mocks.loadConfigWithSecrets.mockResolvedValue({
			provider: "nextain",
			model: "test-model",
			apiKey: "direct-key",
			naiaKey: "naia-key",
			googleApiKey: "google-tts-key",
			openaiTtsApiKey: "openai-tts-key",
			elevenlabsApiKey: "elevenlabs-tts-key",
			gatewayToken: "gateway-token",
		});

		renderHook(() => useAgentAuthSync(false, false, true));

		await vi.waitFor(() =>
			expect(mocks.sendCredsUpdate).toHaveBeenCalledTimes(1),
		);
		expect(mocks.sendAuthUpdate).toHaveBeenCalledWith("naia-key", null);
		expect(mocks.sendCredsUpdate).toHaveBeenCalledWith(
			{
				keys: {},
				ttsKeys: {
					google: "google-tts-key",
					openai: "openai-tts-key",
					elevenlabs: "elevenlabs-tts-key",
				},
				gatewayToken: "gateway-token",
			},
			null,
		);

		const startupMessages = mocks.invoke.mock.calls
			.filter(([command]) => command === "store_startup_message")
			.map(([, args]) => JSON.parse(args.message));
		expect(startupMessages).toContainEqual({
			type: "auth_update",
			naiaKey: "naia-key",
		});
		expect(startupMessages).toContainEqual({
			type: "creds_update",
			keys: {},
			ttsKeys: {
				google: "google-tts-key",
				openai: "openai-tts-key",
				elevenlabs: "elevenlabs-tts-key",
			},
			gatewayToken: "gateway-token",
		});
	});

	it("preserves a direct provider key alongside TTS credentials", async () => {
		mocks.loadConfigWithSecrets.mockResolvedValue({
			provider: "openai",
			model: "test-model",
			apiKey: "direct-key",
			googleApiKey: "google-tts-key",
			openaiTtsApiKey: "openai-tts-key",
			elevenlabsApiKey: "elevenlabs-tts-key",
		});

		renderHook(() => useAgentAuthSync(false, false, true));

		await vi.waitFor(() =>
			expect(mocks.sendCredsUpdate).toHaveBeenCalledTimes(1),
		);
		expect(mocks.sendCredsUpdate).toHaveBeenCalledWith(
			{
				keys: { openai: "direct-key" },
				ttsKeys: {
					google: "google-tts-key",
					openai: "openai-tts-key",
					elevenlabs: "elevenlabs-tts-key",
				},
			},
			null,
		);
	});
});
