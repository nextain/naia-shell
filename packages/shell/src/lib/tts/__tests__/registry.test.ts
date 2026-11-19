import { describe, expect, it } from "vitest";
import {
	DRAGON_CLOUD_VOICES,
	browserVoicesToTtsVoiceMetas,
	groupTtsVoicesForLocale,
	listTtsProviderMetas,
} from "../registry";

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

describe("R25-v voice list grouped by UI language", () => {
	const LOCALES = ["ko", "en", "ja", "zh", "fr", "de", "ru", "es", "ar", "hi", "bn", "pt", "id", "vi"];

	it("R25-v puts only voices that speak the current language in the first group", () => {
		const groups = groupTtsVoicesForLocale(DRAGON_CLOUD_VOICES, "ko");
		expect(groups[0]).toMatchObject({ language: "ko", current: true, label: "한국어" });
		const first = groups[0].voices;
		expect(first.map((v) => v.id)).toContain("ko-KR-SunHi:DragonHDLatestNeural");
		expect(first.every((v) => v.language === "ko" || v.secondaryLocales?.includes("ko"))).toBe(true);
		expect(first.some((v) => v.id.startsWith("pt-BR-Thalita"))).toBe(false);
		const pt = groups.find((g) => g.language === "pt");
		expect(pt?.current).toBe(false);
		expect(pt?.voices.map((v) => v.id)).toContain("pt-BR-Thalita:DragonHDLatestNeural");
	});

	it.each(LOCALES)("R25-v every voice appears exactly once and the first group speaks %s", (locale) => {
		const groups = groupTtsVoicesForLocale(DRAGON_CLOUD_VOICES, locale);
		const ids = groups.flatMap((g) => g.voices.map((v) => v.id));
		expect(ids.sort()).toEqual(DRAGON_CLOUD_VOICES.map((v) => v.id).sort());
		expect(groups[0].current).toBe(true);
		for (const voice of groups[0].voices) {
			expect(voice.language === locale || voice.secondaryLocales?.includes(locale)).toBe(true);
		}
		expect(groups.slice(1).every((g) => !g.current)).toBe(true);
	});

	it("R25-v orders other groups by the 14 UI languages, then other languages", () => {
		const order = groupTtsVoicesForLocale(DRAGON_CLOUD_VOICES, "pt").map((g) => g.language);
		expect(order[0]).toBe("pt");
		expect(order.indexOf("ko")).toBeLessThan(order.indexOf("ja"));
		expect(order.indexOf("vi")).toBeLessThan(order.indexOf("it"));
		expect(order.slice(-2).sort()).toEqual(["it", "th"]);
	});

	it("R25-v groups browser speechSynthesis voices by their lang tag", () => {
		const metas = browserVoicesToTtsVoiceMetas([
			{ name: "Google português do Brasil", lang: "pt-BR", voiceURI: "Google português do Brasil" },
			{ name: "Google 한국의", lang: "ko-KR", voiceURI: "Google 한국의" },
			{ name: "Google US English", lang: "en-US", voiceURI: "Google US English" },
			{ name: "Mystery", lang: "" },
		]);
		expect(metas[0]).toEqual({ id: "Google português do Brasil", label: "Google português do Brasil (pt-BR)", language: "pt" });
		expect(metas[3]).toEqual({ id: "Mystery", label: "Mystery" });
		const groups = groupTtsVoicesForLocale(metas, "ko");
		expect(groups.map((g) => g.language)).toEqual(["ko", "en", "pt", ""]);
		expect(groups[0].voices.map((v) => v.id)).toEqual(["Google 한국의"]);
	});

	it("R25-v an empty voice list gives no groups", () => {
		expect(groupTtsVoicesForLocale([], "ko")).toEqual([]);
	});
});
