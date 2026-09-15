import { describe, expect, it } from "vitest";
import { setLocale } from "../i18n";
import {
	WIRE_ERROR_CODES,
	isNaiaAuthWireError,
	wireErrorMessage,
} from "../wire-errors";

describe("UC-WIRE-V1 stable error code i18n", () => {
	it("24개 안정 code를 모두 현지화하고 raw agent message를 표시하지 않는다", async () => {
		await setLocale("ko");
		expect(WIRE_ERROR_CODES).toHaveLength(24);
		for (const code of WIRE_ERROR_CODES) {
			const message = wireErrorMessage(code, "provider leaked detail");
			expect(message.length).toBeGreaterThan(0);
			expect(message).not.toContain("leaked");
		}
	});

	it("알 수 없는 legacy error는 기존 message와 호환된다", () => {
		expect(wireErrorMessage(undefined, "legacy error")).toBe("legacy error");
	});
});

describe("isNaiaAuthWireError (#402)", () => {
	it("flags the two provider codes a rejected Naia key surfaces as", () => {
		expect(isNaiaAuthWireError("PROVIDER_AUTH_EXPIRED")).toBe(true);
		expect(isNaiaAuthWireError("PROVIDER_LOGIN_REQUIRED")).toBe(true);
	});

	it("does not flag unrelated or retryable provider codes", () => {
		expect(isNaiaAuthWireError("PROVIDER_NETWORK")).toBe(false);
		expect(isNaiaAuthWireError("PROVIDER_NOT_INSTALLED")).toBe(false);
		expect(isNaiaAuthWireError(undefined)).toBe(false);
	});
});
