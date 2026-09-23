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
	sendAuthUpdate: vi.fn(() => Promise.resolve()),
	sendCredsUpdate: vi.fn(() => Promise.resolve()),
	sendNotifyConfig: vi.fn(() => Promise.resolve()),
	loggerWarn: vi.fn(),
	getAdkPath: vi.fn<() => string | null>(() => null),
	fetchNaiaModelMetadata: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/adk-store", () => ({
	getAdkPath: mocks.getAdkPath,
}));
vi.mock("../../lib/chat-service", () => ({
	sendAuthUpdate: mocks.sendAuthUpdate,
	sendCredsUpdate: mocks.sendCredsUpdate,
	sendNotifyConfig: mocks.sendNotifyConfig,
}));
vi.mock("../../lib/config", () => ({
	LAB_GATEWAY_URL: "https://gateway.test",
	loadConfig: mocks.loadConfig,
	loadConfigWithSecrets: mocks.loadConfigWithSecrets,
	saveConfig: mocks.saveConfig,
}));
vi.mock("../../lib/llm/registry", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/llm/registry")>()),
	fetchNaiaModelMetadata: mocks.fetchNaiaModelMetadata,
}));
vi.mock("../../lib/logger", () => ({
	Logger: { warn: mocks.loggerWarn },
}));

import { useAgentAuthSync } from "../useAgentAuthSync";

describe("useAgentAuthSync — structured main model preservation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getAdkPath.mockReturnValue(null);
		mocks.fetchNaiaModelMetadata.mockResolvedValue(null);
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
		expect(mocks.fetchNaiaModelMetadata).not.toHaveBeenCalled();
	});

	it("still migrates a genuinely retired flat model", async () => {
		mocks.loadConfig.mockReturnValue({
			provider: "nextain",
			model: "retired-flat-model",
		});
		mocks.fetchNaiaModelMetadata.mockResolvedValue(new Map());

		renderHook(() => useAgentAuthSync(false, false, true));

		await vi.waitFor(() => {
			expect(mocks.saveConfig).toHaveBeenCalledWith(
				expect.objectContaining({ model: "deepseek-v4-flash" }),
			);
		});
		expect(mocks.fetchNaiaModelMetadata).toHaveBeenCalledWith(
			"https://gateway.test",
		);
	});

	it("keeps a gateway-served flat main model (#707)", async () => {
		mocks.loadConfig.mockReturnValue({
			provider: "nextain",
			model: "gpt-5.4-nano",
		});
		mocks.fetchNaiaModelMetadata.mockResolvedValue(
			new Map([
				[
					"gpt-5.4-nano",
					{
						capabilities: ["llm"],
						operationalStatus: "live",
					},
				],
			]),
		);

		renderHook(() => useAgentAuthSync(false, false, true));

		await vi.waitFor(() =>
			expect(mocks.fetchNaiaModelMetadata).toHaveBeenCalled(),
		);
		await new Promise((r) => setTimeout(r, 0));
		expect(mocks.saveConfig).not.toHaveBeenCalled();
	});

	it("migrates a #670-retired id at once without asking the gateway", () => {
		mocks.loadConfig.mockReturnValue({
			provider: "nextain",
			model: "grok-4.3",
		});

		renderHook(() => useAgentAuthSync(false, false, true));

		expect(mocks.saveConfig).toHaveBeenCalledWith(
			expect.objectContaining({ model: "deepseek-v4-flash" }),
		);
		expect(mocks.fetchNaiaModelMetadata).not.toHaveBeenCalled();
	});

	it("leaves the model alone when the gateway catalog is unavailable", async () => {
		mocks.loadConfig.mockReturnValue({
			provider: "nextain",
			model: "retired-flat-model",
		});
		mocks.fetchNaiaModelMetadata.mockResolvedValue(null);

		renderHook(() => useAgentAuthSync(false, false, true));

		await vi.waitFor(() =>
			expect(mocks.fetchNaiaModelMetadata).toHaveBeenCalled(),
		);
		await new Promise((r) => setTimeout(r, 0));
		expect(mocks.saveConfig).not.toHaveBeenCalled();
	});

	it("does not overwrite a model changed during the catalog fetch", async () => {
		mocks.loadConfig
			.mockReturnValueOnce({
				provider: "nextain",
				model: "retired-flat-model",
			})
			.mockReturnValue({
				provider: "nextain",
				model: "other-unlisted-model",
			});
		mocks.fetchNaiaModelMetadata.mockResolvedValue(new Map());

		renderHook(() => useAgentAuthSync(false, false, true));

		await vi.waitFor(() =>
			expect(mocks.fetchNaiaModelMetadata).toHaveBeenCalled(),
		);
		await new Promise((r) => setTimeout(r, 0));
		expect(mocks.saveConfig).not.toHaveBeenCalled();
	});

	it("leaves the model alone when the catalog fetch throws", async () => {
		mocks.loadConfig.mockReturnValue({
			provider: "nextain",
			model: "retired-flat-model",
		});
		mocks.fetchNaiaModelMetadata.mockRejectedValue(new Error("offline"));

		renderHook(() => useAgentAuthSync(false, false, true));

		await vi.waitFor(() =>
			expect(mocks.fetchNaiaModelMetadata).toHaveBeenCalled(),
		);
		await new Promise((r) => setTimeout(r, 0));
		expect(mocks.saveConfig).not.toHaveBeenCalled();
	});

	it("does not save when the ADK changed during the catalog fetch", async () => {
		mocks.loadConfig.mockReturnValue({
			provider: "nextain",
			model: "retired-flat-model",
		});
		mocks.getAdkPath.mockImplementation(() =>
			mocks.fetchNaiaModelMetadata.mock.calls.length === 0
				? "adk-a"
				: "adk-b",
		);
		mocks.fetchNaiaModelMetadata.mockResolvedValue(new Map());

		renderHook(() => useAgentAuthSync(false, false, true));

		await vi.waitFor(() =>
			expect(mocks.fetchNaiaModelMetadata).toHaveBeenCalled(),
		);
		await new Promise((r) => setTimeout(r, 0));
		expect(mocks.saveConfig).not.toHaveBeenCalled();
	});

	it("does not replay a Nextain direct key as naia-anyllm credentials", async () => {
		mocks.loadConfigWithSecrets.mockResolvedValue({
			provider: "nextain",
			model: "test-model",
			apiKey: "direct-key",
			naiaKey: "naia-key",
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
			},
			gatewayToken: "gateway-token",
		});
	});

	it("preserves a direct provider key alongside TTS credentials", async () => {
		mocks.loadConfigWithSecrets.mockResolvedValue({
			provider: "openai",
			model: "test-model",
			apiKey: "direct-key",
											});

		renderHook(() => useAgentAuthSync(false, false, true));

		await vi.waitFor(() =>
			expect(mocks.sendCredsUpdate).toHaveBeenCalledTimes(1),
		);
		expect(mocks.sendCredsUpdate).toHaveBeenCalledWith(
			{
				keys: { openai: "direct-key" },
				ttsKeys: {
				},
			},
			null,
		);
	});
});
