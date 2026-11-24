// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
	fetchPortalCatalog,
	formatStoreProductPrice,
	isOfferedInLocale,
	localizeStoreProduct,
	parsePortalCatalog,
	portalCatalogUrl,
	resolvePortalHostedEntryUrl,
} from "../app-catalog";
import { WebHttpAppStoreAdapter } from "../app-store-adapter";
import { loadConfig, saveConfig } from "../config";

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const SHELL = "https://dev.naia.land";
const BUILTIN_IDS = [
	"land.naia.charcard",
	"land.naia.slides",
	"land.naia.ieumoffice",
	"land.naia.cafelua-tarot",
];

function adapterWith(
	routes: Record<string, () => Response | Promise<Response>>,
	locale = "ko",
) {
	const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		const route = Object.entries(routes).find(([prefix]) =>
			url.startsWith(prefix),
		);
		if (!route) throw new TypeError(`network down: ${url}`);
		const [, handleRoute] = route;
		return handleRoute();
	}) as unknown as typeof fetch;
	return {
		fetchImpl,
		adapter: new WebHttpAppStoreAdapter({
			stage1HostedCatalog: true,
			fetchImpl,
			getGatewayUrl: () => "https://api-dev.naia.land",
			getShellOrigin: () => SHELL,
			getPortalBaseUrl: () => SHELL,
			getLocale: () => locale,
			getAuthKey: () => undefined,
		}),
	};
}

describe("R4 portal catalog contract (GET /api/apps)", () => {
	it("R4 parses the contract shape and hides non-public items", () => {
		const entries = parsePortalCatalog({
			apps: [
				{
					id: "land.naia.quiz",
					name: "Quiz",
					icon: "❓",
					url: `${SHELL}/hosted-apps/quiz/index.html`,
					description: "Daily quiz",
					locales: ["ko", "en"],
					version: "0.3.0",
					visibility: "public",
				},
				{ id: "land.naia.draft", name: "Draft", visibility: "draft" },
				{ id: "bad id!", name: "Broken" },
				{ id: "land.naia.quiz", name: "Duplicate" },
			],
		});
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			appId: "land.naia.quiz",
			version: "0.3.0",
			hostedEntryUrl: `${SHELL}/hosted-apps/quiz/index.html`,
			offeredLocales: ["ko", "en"],
			manifest: { name: "Quiz", icon: "❓", description: "Daily quiz" },
		});
	});

	it("R4 accepts the legacy portal AppRecord shape and per-locale names", () => {
		const [legacy, localized] = parsePortalCatalog({
			apps: [
				{
					id: "db-row-1",
					slug: "land.naia.memo",
					nameKo: "메모",
					nameEn: "Memo",
					descriptionKo: "짧은 메모",
					version: "1.2.0",
				},
				{
					id: "poem",
					name: "Poem",
					icon: "https://cdn.example.com/poem.png",
					locales: { ko: { name: "시", description: "시 쓰기" } },
				},
				{ slug: "land.naia.soon", nameKo: "곧", comingSoon: true },
			],
		});
		expect(legacy.appId).toBe("land.naia.memo");
		expect(legacy.manifest.names).toEqual({ ko: "메모", en: "Memo" });
		expect(legacy.manifest.descriptions).toEqual({ ko: "짧은 메모" });
		expect(localized.appId).toBe("land.naia.poem");
		expect(localized.manifest.names).toEqual({ ko: "시" });
		expect(localized.manifest.icon).toBeUndefined();
		expect(localized.iconUrl).toBe("https://cdn.example.com/poem.png");
		expect(parsePortalCatalog({ data: [] })).toEqual([]);
		expect(parsePortalCatalog(null)).toEqual([]);
	});

	it("R4 locale filter matches base language", () => {
		expect(isOfferedInLocale({ offeredLocales: ["en"] }, "en-US")).toBe(true);
		expect(isOfferedInLocale({ offeredLocales: ["en"] }, "ko")).toBe(false);
		expect(isOfferedInLocale({}, "ko")).toBe(true);
	});

	it("R4 fetchPortalCatalog never throws on server failure", async () => {
		const down = vi.fn(async () => {
			throw new TypeError("offline");
		}) as unknown as typeof fetch;
		await expect(fetchPortalCatalog(down, SHELL)).resolves.toEqual([]);
		const err = vi.fn(async () =>
			jsonResponse(500, { error: "x" }),
		) as unknown as typeof fetch;
		await expect(fetchPortalCatalog(err, SHELL)).resolves.toEqual([]);
		const notJson = vi.fn(
			async () => new Response("<html>", { status: 200 }),
		) as unknown as typeof fetch;
		await expect(fetchPortalCatalog(notJson, SHELL)).resolves.toEqual([]);
		const ok = vi.fn(async () =>
			jsonResponse(200, { apps: [{ id: "quiz", name: "Quiz" }] }),
		) as unknown as typeof fetch;
		const result = await fetchPortalCatalog(ok, `${SHELL}/`);
		expect(result.map((e) => e.appId)).toEqual(["land.naia.quiz"]);
		expect(String(vi.mocked(ok).mock.calls[0][0])).toBe(`${SHELL}/api/apps`);
	});
});

describe("R3 unified web catalog (built-in + gateway + admin)", () => {
	it("R3 shows only built-in apps when gateway and portal are both down", async () => {
		const { adapter } = adapterWith({});
		const catalog = await adapter.listCatalog();
		expect(catalog.map((c) => c.appId)).toEqual(BUILTIN_IDS);
	});

	it("R3 R4 appends admin apps after built-in and gateway apps without overriding them", async () => {
		const { adapter } = adapterWith({
			"https://api-dev.naia.land/v1/apps/products": () =>
				jsonResponse(200, {
					data: [
						{
							app_id: "land.naia.gateway-extra",
							version: "1.0.0",
							price_credits: "10",
							hosted_entry_url: `${SHELL}/hosted-apps/gateway-extra/index.html`,
							manifest: { name: "Gateway Extra" },
						},
					],
				}),
			[`${SHELL}/api/apps`]: () =>
				jsonResponse(200, {
					apps: [
						{
							id: "land.naia.slides",
							name: "Hijacked slides",
							url: "https://evil.example/x",
						},
						{ id: "land.naia.gateway-extra", name: "Dup" },
						{
							id: "land.naia.quiz",
							name: "Quiz",
							icon: "❓",
							version: "0.3.0",
						},
						{ id: "land.naia.english-only", name: "EN", locales: ["en"] },
						{
							id: "land.naia.external",
							name: "Ext",
							url: "https://evil.example/app",
						},
						{ id: "land.naia.blackjack", name: "Blackjack" },
					],
				}),
		});
		const catalog = await adapter.listCatalog();
		expect(catalog.map((c) => c.appId)).toEqual([
			...BUILTIN_IDS,
			"land.naia.gateway-extra",
			"land.naia.quiz",
		]);
		const slides = catalog.find((c) => c.appId === "land.naia.slides")!;
		expect(slides.manifest.name).toBe("슬라이드");
		expect(slides.hostedEntryUrl).toBe(
			`${SHELL}/hosted-apps/naia-slides/index.html`,
		);
		const quiz = catalog.find((c) => c.appId === "land.naia.quiz")!;
		expect(quiz).toMatchObject({
			version: "0.3.0",
			priceCredits: 0,
			hostedEntryUrl: `${SHELL}/hosted-apps/land.naia.quiz/index.html`,
		});
	});

	it("R3 R4 short admin slug becomes a canonical land.naia id in the catalog", async () => {
		const { adapter } = adapterWith(
			{
				[`${SHELL}/api/apps`]: () =>
					jsonResponse(200, {
						apps: [
							{
								id: "quiz",
								name: "Quiz",
								url: `${SHELL}/hosted-apps/quiz/index.html`,
							},
						],
					}),
			},
			"en",
		);
		const catalog = await adapter.listCatalog();
		expect(catalog.at(-1)?.appId).toBe("land.naia.quiz");
	});

	it("R4 admin apps launch without login and join the installed list", async () => {
		localStorage.clear();
		const { adapter, fetchImpl } = adapterWith({
			[`${SHELL}/api/apps`]: () =>
				jsonResponse(200, { apps: [{ id: "quiz", name: "Quiz" }] }),
		});
		await adapter.listCatalog();
		await expect(adapter.checkEntitlement("land.naia.quiz")).resolves.toBe(
			true,
		);
		await adapter.installApp("land.naia.quiz");
		const purchases = vi
			.mocked(fetchImpl)
			.mock.calls.filter(([url]) => String(url).includes("/v1/apps/purchases"));
		expect(purchases).toEqual([]);
		const installed = await adapter.listInstalledManifests();
		const quiz = installed.find((m) => m.id === "land.naia.quiz");
		expect(quiz?.htmlEntry).toBe(
			`${SHELL}/hosted-apps/land.naia.quiz/index.html`,
		);
		// A gateway-only app still needs login.
		await expect(adapter.checkEntitlement("land.naia.other")).rejects.toThrow(
			/login is required/,
		);
		localStorage.clear();
	});

	it.each([
		{ name: "an unset installation list", config: {}, expected: BUILTIN_IDS },
		{
			name: "a previously removed default app",
			config: { deletedApps: ["land.naia.slides"] },
			expected: BUILTIN_IDS.filter((id) => id !== "land.naia.slides"),
		},
		{ name: "an explicitly empty installation list", config: { installedWebApps: [] }, expected: [] },
		{
			name: "an explicit installation list",
			config: { installedWebApps: ["land.naia.charcard"] },
			expected: ["land.naia.charcard"],
		},
	])("R4 preserves $name on initial and repeated installation", async ({ config, expected }) => {
		localStorage.clear();
		try {
			saveConfig({ provider: "nextain", model: "gpt-6.1-terra", apiKey: "", ...config });
			const { adapter } = adapterWith({
				[`${SHELL}/api/apps`]: () => jsonResponse(200, { apps: [{ id: "quiz", name: "Quiz" }] }),
			});
			const installedIds = async () => (await adapter.listInstalledManifests()).map(({ id }) => id);
			expect(await installedIds()).toEqual(expected);

			await adapter.listCatalog();
			await adapter.installApp("land.naia.quiz");
			expect(await installedIds()).toEqual([...expected, "land.naia.quiz"]);

			await adapter.installApp("land.naia.quiz");
			expect(await installedIds()).toEqual([...expected, "land.naia.quiz"]);
		} finally {
			localStorage.clear();
		}
	});

	it("R4 explicitly reinstalling a removed default app clears only its own removal marker", async () => {
		localStorage.clear();
		try {
			saveConfig({
				provider: "nextain", model: "gpt-6.1-terra", apiKey: "",
				deletedApps: ["land.naia.slides", "land.naia.ieumoffice"],
			});
			const { adapter } = adapterWith({});

			await adapter.installApp("land.naia.slides");
			expect((await adapter.listInstalledManifests()).map(({ id }) => id)).toEqual([
				"land.naia.charcard", "land.naia.cafelua-tarot", "land.naia.slides",
			]);
			expect(loadConfig()?.deletedApps).toEqual(["land.naia.ieumoffice"]);
		} finally {
			localStorage.clear();
		}
	});

	it.each([false, true])("R4 persists first default removal with an existing config: %s", async (withConfig) => {
		localStorage.clear();
		try {
			const previousRemoval = "land.naia.ieumoffice";
			const removed = "land.naia.slides";
			if (withConfig) {
				saveConfig({
					provider: "nextain",
					model: "gpt-6.1-terra",
					apiKey: "",
					deletedApps: [previousRemoval],
				});
			}
			const { adapter } = adapterWith({});
			const before = BUILTIN_IDS.filter((id) => !withConfig || id !== previousRemoval);
			const installedIds = async () => (await adapter.listInstalledManifests()).map(({ id }) => id);
			expect(await installedIds()).toEqual(before);

			await adapter.uninstallApp(removed);
			const after = before.filter((id) => id !== removed);
			expect(await installedIds()).toEqual(after);
			expect(loadConfig()?.installedWebApps).toEqual(after);
			expect(loadConfig()?.deletedApps).toEqual(withConfig ? [previousRemoval] : undefined);

			const changed = vi.fn();
			window.addEventListener("naia-config-changed", changed);
			try {
				await adapter.uninstallApp(removed);
				expect(changed).not.toHaveBeenCalled();
			} finally {
				window.removeEventListener("naia-config-changed", changed);
			}
		} finally {
			localStorage.clear();
		}
	});

	it("R4 uninstall leaves an unset or explicitly empty list intact if the app is absent", async () => {
		localStorage.clear();
		const changed = vi.fn();
		window.addEventListener("naia-config-changed", changed);
		try {
			const { adapter } = adapterWith({});
			await adapter.uninstallApp("land.naia.quiz");
			expect(loadConfig()).toBeNull();
			expect(changed).not.toHaveBeenCalled();

			saveConfig({ provider: "nextain", model: "gpt-6.1-terra", apiKey: "", installedWebApps: [] });
			changed.mockClear();
			await adapter.uninstallApp("land.naia.slides");
			expect(loadConfig()?.installedWebApps).toEqual([]);
			expect(changed).not.toHaveBeenCalled();
		} finally {
			window.removeEventListener("naia-config-changed", changed);
			localStorage.clear();
		}
	});

	it("R4 uninstall removes a Stage-1 alias but preserves the prior non-Stage-1 behavior", async () => {
		localStorage.clear();
		try {
			const config = { provider: "nextain" as const, model: "gpt-6.1-terra", apiKey: "" };
			const adapter = new WebHttpAppStoreAdapter({ stage1HostedCatalog: false });
			await adapter.uninstallApp("land.naia.slides");
			expect(loadConfig()).toBeNull();

			saveConfig({ ...config, installedWebApps: ["naia-slides", "land.naia.charcard"] });
			await adapter.uninstallApp("land.naia.slides");
			expect(loadConfig()?.installedWebApps).toEqual(["naia-slides", "land.naia.charcard"]);
			await adapter.uninstallApp("land.naia.charcard");
			expect(loadConfig()?.installedWebApps).toEqual(["naia-slides"]);

			const { adapter: stage1 } = adapterWith({});
			await stage1.uninstallApp("land.naia.slides");
			expect(loadConfig()?.installedWebApps).toEqual([]);
		} finally {
			localStorage.clear();
		}
	});

	it("R3 normalizes portal /hosted-apps/ URLs under /app/ base path and preserves paid store records", async () => {
		localStorage.clear();
		const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.startsWith(`${SHELL}/api/apps`)) {
				return jsonResponse(200, {
					apps: [
						{
							id: "land.naia.rel-quiz",
							name: "Relative Quiz",
							url: "/hosted-apps/rel-quiz/index.html",
							source: "registry",
						},
						{
							id: "land.naia.abs-quiz",
							name: "Absolute Quiz",
							url: `${SHELL}/hosted-apps/abs-quiz/index.html`,
							source: "registry",
						},
						{
							id: "db-123",
							slug: "land.naia.paid-pro",
							name: "Paid Pro",
							url: "/apps/land.naia.paid-pro",
							creditPrice: 1500,
							source: "store",
						},
					],
				});
			}
			throw new TypeError(`network down: ${url}`);
		}) as unknown as typeof fetch;

		const adapter = new WebHttpAppStoreAdapter({
			stage1HostedCatalog: true,
			fetchImpl,
			getGatewayUrl: () => "https://api-dev.naia.land",
			getShellOrigin: () => SHELL,
			getShellBasePath: () => "/app/",
			getPortalBaseUrl: () => SHELL,
			getLocale: () => "ko",
			getAuthKey: () => undefined,
		});

		const catalog = await adapter.listCatalog();
		const relQuiz = catalog.find((c) => c.appId === "land.naia.rel-quiz");
		const absQuiz = catalog.find((c) => c.appId === "land.naia.abs-quiz");
		const paidPro = catalog.find((c) => c.appId === "land.naia.paid-pro");

		expect(relQuiz?.hostedEntryUrl).toBe(
			`${SHELL}/app/hosted-apps/rel-quiz/index.html`,
		);
		expect(absQuiz?.hostedEntryUrl).toBe(
			`${SHELL}/app/hosted-apps/abs-quiz/index.html`,
		);
		expect(paidPro).toMatchObject({
			appId: "land.naia.paid-pro",
			priceCredits: 1500,
			hostedEntryUrl: `${SHELL}/app/hosted-apps/land.naia.paid-pro/index.html`,
		});

		// Free admin registry apps launch without login, whereas paid store records still require login.
		await expect(
			adapter.checkEntitlement("land.naia.rel-quiz"),
		).resolves.toBe(true);
		await expect(
			adapter.checkEntitlement("land.naia.paid-pro"),
		).rejects.toThrow(/login is required/);

		expect(portalCatalogUrl(SHELL, "ja")).toBe(`${SHELL}/api/apps?lang=ja`);
		expect(
			resolvePortalHostedEntryUrl("https://evil.example/hosted-apps/a/index.html", {
				shellOrigin: SHELL,
				portalOrigin: SHELL,
				hostedAppsPrefix: "/app/hosted-apps/",
			}),
		).toBe("https://evil.example/hosted-apps/a/index.html");
	});

	it("R3 shares portal-compatible locale fallback and R42 credit price formatting", () => {
		const sample = {
			appId: "land.naia.sample",
			manifest: {
				id: "land.naia.sample",
				name: "Fallback Name",
				names: {
					ko: "한국어 이름",
					en: "English Name",
					ja: "日本語の名前",
				},
				descriptions: {
					ko: "한국어 설명",
					en: "English description",
				},
				version: "1.0.0",
			},
		};
		expect(localizeStoreProduct(sample, "ko-KR")).toEqual({
			title: "한국어 이름",
			description: "한국어 설명",
		});
		expect(localizeStoreProduct(sample, "ja")).toEqual({
			title: "日本語の名前",
			description: "English description",
		});
		expect(localizeStoreProduct(sample, "fr")).toEqual({
			title: "English Name",
			description: "English description",
		});
		expect(formatStoreProductPrice(0, "무료")).toBe("무료");
		expect(formatStoreProductPrice(3000, "무료")).toBe("3,000 Cr");
	});
});
