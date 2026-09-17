import { describe, expect, it } from "vitest";
import { resolveLiveProvider } from "../resolve-live-provider";

describe("resolveLiveProvider (#603)", () => {
	it("routes azure-realtime omni to azure-voice-live", () => {
		expect(
			resolveLiveProvider({
				isOmni: true,
				provider: "nextain",
				model: "azure-realtime",
				hasNaiaKey: true,
			}),
		).toBe("azure-voice-live");
	});

	it("maps retired gemini live models to azure-voice-live", () => {
		expect(
			resolveLiveProvider({
				isOmni: true,
				provider: "nextain",
				model: "gemini-2.5-flash-live",
				hasNaiaKey: true,
			}),
		).toBe("azure-voice-live");
	});

	it("does not send azure-realtime to a removed Gemini live path", () => {
		expect(
			resolveLiveProvider({
				isOmni: true,
				provider: "nextain",
				model: "azure-realtime",
				hasNaiaKey: true,
			}),
		).toBe("azure-voice-live");
	});

	it("routes local vllm to vllm-omni", () => {
		expect(
			resolveLiveProvider({
				isOmni: false,
				provider: "vllm",
				hasNaiaKey: false,
			}),
		).toBe("vllm-omni");
	});
});
