import { describe, expect, it } from "vitest";
// @ts-ignore - scripts/lib/oss-token-shape.mjs is an ESM JavaScript module
import { isCodeIdentifierShape } from "../../scripts/lib/oss-token-shape.mjs";

describe("isCodeIdentifierShape contract", () => {
	it("returns true for public CamelCase type names with at least 3 segments", () => {
		expect(
			isCodeIdentifierShape("ICoreWebView2PermissionRequestedEventArgs3"),
		).toBe(true);
		expect(
			isCodeIdentifierShape("ICoreWebView2PermissionRequestedEventArgs"),
		).toBe(true);
		expect(
			isCodeIdentifierShape("PermissionRequestedEventHandlerFactory"),
		).toBe(true);
	});

	it("returns false for secret-like tokens, non-CamelCase shapes, and tokens with fewer than 3 segments", () => {
		// fake 40-char mixed token (still flagged as secret shape in entropy scanner).
		// Assembled from pieces so this tracked file does not itself carry a 40+ token.
		expect(
			isCodeIdentifierShape(["aZ9kQ2mX7pL4", "vB8nR1tY6wC3", "sD5fG0hJ2kL9qW4e"].join("")),
		).toBe(false);

		// single-lowercase segments
		expect(
			isCodeIdentifierShape(["Xk3Jq8Lm2Np7Qr4", "St9Uv1Wx6Yz5Ab0", "Cd3Ef8Gh2Ij"].join("")),
		).toBe(false);

		// base64-like string
		expect(
			isCodeIdentifierShape("QWxhZGRpbjpvcGVuIHNlc2FtZQ+abcDEF/ghiJKL=="),
		).toBe(false);

		// token with underscore (_)
		expect(
			isCodeIdentifierShape("Fake_Identifier_With_Underscore_Segment"),
		).toBe(false);

		// token with hyphen (-)
		expect(
			isCodeIdentifierShape("Fake-Identifier-With-Hyphen-Segment"),
		).toBe(false);

		// all-lowercase token
		expect(
			isCodeIdentifierShape("alllowercasetokenwithfortycharacterslong12345"),
		).toBe(false);

		// fewer than 3 segments
		expect(isCodeIdentifierShape("AbcDef")).toBe(false);
	});
});
