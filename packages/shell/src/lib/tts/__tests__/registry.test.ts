import { describe, expect, it } from "vitest";
import { listTtsProviderMetas } from "../registry";

describe("TTS provider presentation order", () => {
	it("orders free Edge, local GPU, then Naia Azure HD", () => {
		const providers = listTtsProviderMetas();
		expect(providers.slice(0, 3).map((provider) => provider.id)).toEqual([
			"edge",
			"naia-local-voice",
			"nextain",
		]);
		expect(
			providers.find((provider) => provider.id === "naia-local-voice")
				?.requiresNaiaKey,
		).toBe(true);
		expect(
			providers.find((provider) => provider.id === "nextain")?.voices?.[0]?.id,
		).toBe("ko-KR-SunHi:DragonHDLatestNeural");
	});
});
