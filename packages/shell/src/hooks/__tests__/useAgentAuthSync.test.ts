// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(() => Promise.resolve()),
	listen: vi.fn(() => Promise.resolve(vi.fn())),
	loadConfig: vi.fn(),
	loadConfigWithSecrets: vi.fn(() => Promise.resolve(null)),
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
});
