import { describe, expect, it } from "vitest";
import { isMacSafari } from "../MacSafariNotice";

const safari =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";
const chrome =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const info = (
	userAgent: string,
	platform = "MacIntel",
	maxTouchPoints = 0,
) => ({ userAgent, platform, maxTouchPoints });

describe("Mac Safari notice browser detection", () => {
	it("accepts desktop Safari and excludes other browsers and iPad desktop mode", () => {
		expect(isMacSafari(info(safari))).toBe(true);
		for (const ua of [
			chrome,
			`${chrome} Edg/130.0.0.0`,
			`${chrome} OPR/1.0`,
			safari.replace("Version/17.6", "Version/17.6 Chrome/130"),
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0",
			safari.replace("Macintosh", "iPhone"),
		]) {
			expect(isMacSafari(info(ua))).toBe(false);
		}
		expect(isMacSafari(info(safari, "MacIntel", 5))).toBe(false);
		expect(isMacSafari(info(safari, "Win32"))).toBe(false);
	});
});
