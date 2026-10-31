import { describe, expect, it } from "vitest";
import { webGatewayBaseUrl } from "../gateway-url";

describe("web gateway instance", () => {
	it("uses the configured instance and normalizes its API prefix", () => {
		expect(webGatewayBaseUrl("https://dev.example.test/")).toBe("https://dev.example.test/v1");
		expect(webGatewayBaseUrl("https://dev.example.test/v1")).toBe("https://dev.example.test/v1");
	});
	it("refuses a missing instance rather than selecting production", () => {
		expect(() => webGatewayBaseUrl(undefined)).toThrow("Naia gateway URL is required");
		expect(() => webGatewayBaseUrl("  ")).toThrow("Naia gateway URL is required");
	});
});
