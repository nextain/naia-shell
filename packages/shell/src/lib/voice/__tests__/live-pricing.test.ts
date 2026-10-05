// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLiveVoiceHourlyRate } from "../live-pricing";

function stubFetch(body: unknown, ok = true) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({ ok, json: () => Promise.resolve(body) }),
	);
}

describe("fetchLiveVoiceHourlyRate (#727)", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("returns the hourly row price from the gateway", async () => {
		stubFetch([
			{ model_key: "naia-omni-tokens", pricing_unit: "per_token" },
			{ model_key: "naia-omni", pricing_unit: "hourly", price_per_hour: 0.43 },
		]);
		expect(await fetchLiveVoiceHourlyRate("https://gw", "naia-omni")).toBe(
			0.43,
		);
	});

	it("returns null when no hourly row exists (amount omitted)", async () => {
		stubFetch([{ model_key: "naia-omni", pricing_unit: "per_token" }]);
		expect(
			await fetchLiveVoiceHourlyRate("https://gw", "naia-omni"),
		).toBeNull();
	});

	it("returns null on HTTP failure, network failure, or unknown provider", async () => {
		stubFetch([], false);
		expect(
			await fetchLiveVoiceHourlyRate("https://gw", "naia-omni"),
		).toBeNull();
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
		expect(
			await fetchLiveVoiceHourlyRate("https://gw", "naia-omni"),
		).toBeNull();
		expect(
			await fetchLiveVoiceHourlyRate("https://gw", "gemini-live"),
		).toBeNull();
	});
});
