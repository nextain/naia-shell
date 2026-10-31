import { describe, expect, it } from "vitest";
import { normalizeTauriAssetUrl } from "../asset-url";

describe("normalizeTauriAssetUrl", () => {
	it("maps the Linux asset scheme to the CSP-compatible host", () => {
		expect(
			normalizeTauriAssetUrl(
				"asset://localhost/%2Fopt%2Fnaia%2Fapps%2Findex.html",
			),
		).toBe("http://asset.localhost/%2Fopt%2Fnaia%2Fapps%2Findex.html");
	});

	it("keeps an already normalized asset URL unchanged", () => {
		const source = "http://asset.localhost/C%3A%5CApps%5CNaia%5Cindex.html";

		expect(normalizeTauriAssetUrl(source)).toBe(source);
	});

	it("preserves percent-encoded path segments", () => {
		const path = "%E3%81%82%20slides%2Findex.html";

		expect(normalizeTauriAssetUrl(`asset://localhost/${path}`)).toBe(
			`http://asset.localhost/${path}`,
		);
	});

	it("keeps the Windows asset.localhost form unchanged", () => {
		const source = "http://asset.localhost";

		expect(normalizeTauriAssetUrl(source)).toBe(source);
	});

	it("does not rewrite a different localhost-prefixed host", () => {
		const source = "asset://localhost.example.invalid/index.html";

		expect(normalizeTauriAssetUrl(source)).toBe(source);
	});

	it("consumes the separator slash instead of doubling it", () => {
		expect(normalizeTauriAssetUrl("asset://localhost/slides/index.html")).toBe(
			"http://asset.localhost/slides/index.html",
		);
		expect(normalizeTauriAssetUrl("asset://localhost")).toBe(
			"http://asset.localhost/",
		);
	});

	it("normalizes the legacy localhost form used by AvatarCanvas", () => {
		expect(normalizeTauriAssetUrl("http://localhost/model.vrm")).toBe(
			"http://asset.localhost/model.vrm",
		);
	});
});
