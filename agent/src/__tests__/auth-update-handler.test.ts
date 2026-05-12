/**
 * auth-update-handler.test.ts — index.ts handler test (factory mocked)
 * Tests: handleAuthUpdate calls setAgentNaiaKey
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../providers/factory.js", () => ({
	buildProvider: vi.fn(),
	setAgentNaiaKey: vi.fn(),
	getAgentNaiaKey: vi.fn().mockReturnValue(undefined),
	setProviderApiKey: vi.fn(),
	getProviderApiKey: vi.fn().mockReturnValue(undefined),
	setTtsApiKey: vi.fn(),
	getTtsApiKey: vi.fn().mockReturnValue(undefined),
	setGatewayToken: vi.fn(),
	getGatewayToken: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../tts/index.js", () => ({ synthesize: vi.fn() }));
vi.mock("../providers/cost.js", () => ({ calculateCost: vi.fn().mockReturnValue(0) }));

describe("handleAuthUpdate — sets agent naiaKey via factory", () => {
	let setAgentNaiaKeySpy: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		vi.clearAllMocks();
		const factory = await import("../providers/factory.js");
		setAgentNaiaKeySpy = vi.mocked(factory.setAgentNaiaKey);
	});

	it("calls setAgentNaiaKey with the received naiaKey", async () => {
		const { handleAuthUpdate } = await import("../index.js");
		handleAuthUpdate({ type: "auth_update", naiaKey: "gw-live-key" });
		expect(setAgentNaiaKeySpy).toHaveBeenCalledWith("gw-live-key");
		expect(setAgentNaiaKeySpy).toHaveBeenCalledTimes(1);
	});

	it("handles empty string naiaKey (credential clear)", async () => {
		const { handleAuthUpdate } = await import("../index.js");
		handleAuthUpdate({ type: "auth_update", naiaKey: "" });
		expect(setAgentNaiaKeySpy).toHaveBeenCalledWith("");
	});

	it("multiple auth_update calls overwrite previous key", async () => {
		const { handleAuthUpdate } = await import("../index.js");
		handleAuthUpdate({ type: "auth_update", naiaKey: "first" });
		handleAuthUpdate({ type: "auth_update", naiaKey: "second" });
		expect(setAgentNaiaKeySpy).toHaveBeenCalledTimes(2);
		expect(setAgentNaiaKeySpy).toHaveBeenLastCalledWith("second");
	});
});
