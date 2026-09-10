import { describe, expect, it } from "vitest";
import { resolveLiveProvider } from "../resolve-live-provider";

describe("resolveLiveProvider", () => {
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

	it("keeps gemini live on the naia gateway path", () => {
		expect(
			resolveLiveProvider({
				isOmni: true,
				provider: "nextain",
				model: "gemini-2.5-flash-live",
				hasNaiaKey: true,
			}),
		).toBe("naia");
	});

	it("does not send azure-realtime to Gemini /v1/live", () => {
		expect(
			resolveLiveProvider({
				isOmni: true,
				provider: "nextain",
				model: "azure-realtime",
				hasNaiaKey: true,
			}),
		).not.toBe("naia");
	});
});
