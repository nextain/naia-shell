// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebHttpAppStoreAdapter, readPackageIconSvg } from "../app-store-adapter";
import { setWebAssetsModeForTests } from "../web-runtime/web-assets";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

const TAROT_SVG =
	'<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle r="4"/></svg>';

function response(status: number, body: string): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => JSON.parse(body),
		text: async () => body,
	} as unknown as Response;
}

function hostedFetch(files: Record<string, string>) {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith("/v1/apps/products")) return response(200, '{"data":[]}');
		const body = files[url];
		return body === undefined ? response(404, "") : response(200, body);
	});
}

describe("R6: web app icons use the package icon like desktop", () => {
	beforeEach(() => {
		localStorage.clear();
		setWebAssetsModeForTests(true);
	});
	afterEach(() => {
		setWebAssetsModeForTests(null);
		vi.restoreAllMocks();
	});

	it("R6: reads app.json iconUrl next to the hosted entry", async () => {
		const fetchMock = hostedFetch({
			"https://dev.naia.land/hosted-apps/cafelua-tarot/app.json": '{"iconUrl":"icon.svg"}',
			"https://dev.naia.land/hosted-apps/cafelua-tarot/icon.svg": TAROT_SVG,
		});
		await expect(
			readPackageIconSvg(
				fetchMock as unknown as typeof fetch,
				"https://dev.naia.land/hosted-apps/cafelua-tarot/index.html",
			),
		).resolves.toBe(TAROT_SVG);
	});

	it("R6: rejects HTML fallbacks, escapes and non-SVG icons", async () => {
		const entry = "https://dev.naia.land/hosted-apps/x/index.html";
		const cases: Record<string, string>[] = [
			{
				"https://dev.naia.land/hosted-apps/x/app.json": '{"iconUrl":"icon.svg"}',
				"https://dev.naia.land/hosted-apps/x/icon.svg": "<!doctype html><html></html>",
			},
			{ "https://dev.naia.land/hosted-apps/x/app.json": '{"iconUrl":"../y/icon.svg"}' },
			{ "https://dev.naia.land/hosted-apps/x/app.json": '{"iconUrl":"https://evil.test/i.svg"}' },
			{ "https://dev.naia.land/hosted-apps/x/app.json": '{"iconUrl":"icon.png"}' },
			{},
		];
		for (const files of cases) {
			await expect(
				readPackageIconSvg(hostedFetch(files) as unknown as typeof fetch, entry),
			).resolves.toBeUndefined();
		}
	});

	it("R6: installed hosted apps carry the package SVG and keep the emoji fallback", async () => {
		const fetchMock = hostedFetch({
			"https://dev.naia.land/hosted-apps/cafelua-tarot/app.json": '{"iconUrl":"icon.svg"}',
			"https://dev.naia.land/hosted-apps/cafelua-tarot/icon.svg": TAROT_SVG,
		});
		const adapter = new WebHttpAppStoreAdapter({
			stage1HostedCatalog: true,
			fetchImpl: fetchMock as unknown as typeof fetch,
			getGatewayUrl: () => "https://api-dev.naia.land",
			getShellOrigin: () => "https://dev.naia.land",
		});
		const manifests = await adapter.listInstalledManifests();
		const tarot = manifests.find((m) => m.id === "land.naia.cafelua-tarot");
		const charcard = manifests.find((m) => m.id === "land.naia.charcard");
		expect(tarot?.iconSvg).toBe(TAROT_SVG);
		expect(tarot?.icon).toBe("🔮");
		expect(charcard?.iconSvg).toBeUndefined();
		expect(charcard?.icon).toBe("🃏");

		// Second listing reuses the cached icon instead of refetching.
		const iconFetches = () =>
			fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/icon.svg")).length;
		expect(iconFetches()).toBe(1);
		await adapter.listInstalledManifests();
		expect(iconFetches()).toBe(1);
	});
});
