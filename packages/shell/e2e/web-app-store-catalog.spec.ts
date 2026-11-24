import { expect, test, type Page } from "@playwright/test";
import { prepareStoreWorkspace, webAppInstallUrl } from "./helpers/web-store";

// R3/R4 use the portal storefront and an explicit one-app handoff to the web shell.
test.skip(process.env.NAIA_E2E_WEB !== "1", "requires the web shell");
test.setTimeout(180_000);
test.use({ locale: "ko-KR", serviceWorkers: "block" });

const FREE_APP = "land.naia.quiz";
const PAID_APP = "land.naia.paid-quiz";
const PRIVATE_APP = "land.naia.private-quiz";
const BUILTIN = [
	"land.naia.charcard",
	"land.naia.slides",
	"land.naia.ieumoffice",
	"land.naia.cafelua-tarot",
];
const PORTAL = new URL(
	process.env.VITE_NAIA_WEB_BASE_URL || "https://dev.naia.land",
);
const headers = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Headers": "content-type,x-anyllm-key,authorization",
	"Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

async function prepareWebStore(
	page: Page,
	baseURL: string,
	account: "guest" | "unowned" | "owned" = "guest",
) {
	const shell = new URL(baseURL);
	const purchasePosts: string[] = [];
	const entitlementPaths: string[] = [];
	const context = page.context();
	await context.route("**/*", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (url.pathname === "/v1/apps/purchases") {
			if (request.method() === "OPTIONS")
				return route.fulfill({ status: 204, headers });
			if (request.method() === "POST") purchasePosts.push(url.pathname);
			return route.fulfill({
				status: 500,
				headers,
				json: { error: "unexpected purchase" },
			});
		}
		if (url.pathname === "/v1/apps/products") {
			return route.fulfill({
				headers,
				json: {
					data: [
						{
							app_id: PAID_APP,
							version: "1.0.0",
							price_credits: 300,
							manifest: { name: "Paid Quiz" },
						},
					],
				},
			});
		}
		if (url.pathname === "/api/apps") {
			return route.fulfill({
				headers,
				json: {
					apps: [
						{
							id: FREE_APP,
							name: "Free Quiz",
							visibility: "public",
							version: "1.0.0",
						},
						{ id: PRIVATE_APP, name: "Private Quiz", visibility: "draft" },
					],
				},
			});
		}
		if (url.pathname.startsWith("/v1/apps/entitlements/")) {
			if (request.method() === "OPTIONS")
				return route.fulfill({ status: 204, headers });
			entitlementPaths.push(url.pathname);
			return route.fulfill({
				headers,
				json: { entitled: account === "owned" },
			});
		}
		if (url.pathname === "/v1/profile/balance") {
			if (request.method() === "OPTIONS")
				return route.fulfill({ status: 204, headers });
			return route.fulfill({ headers, json: { credits: 500 } });
		}
		if (url.origin === PORTAL.origin && url.pathname === "/ko/apps") {
			return route.fulfill({
				contentType: "text/html",
				body: "<!doctype html><h1>Portal storefront fixture</h1>",
			});
		}
		if (url.origin === shell.origin) return route.continue();
		return route.abort();
	});
	await page.route(
		/\/hosted-apps\/land\.naia\.(?:paid-)?quiz\/index\.html$/,
		(route) =>
			route.fulfill({
				contentType: "text/html",
				body: "<!doctype html><h1>Quiz fixture is running</h1>",
			}),
	);
	await page.route("**/web-adk/*.json", async (route) => {
		const response = await route.fetch({ maxRetries: 1 });
		const bundle = await response.json();
		const agents = bundle.files.find(
			(file: { path: string }) => file.path === "AGENTS.md",
		);
		if (!agents) throw new Error("workspace bundle lacks AGENTS.md");
		await route.fulfill({ json: { ...bundle, files: [agents], dirs: [] } });
	});
	await page.addInitScript(
		({ origin, authenticated }) => {
			if (window.top !== window || location.origin !== origin) return;
			if (authenticated)
				localStorage.setItem("naia-remote-key", "fixture-storefront-test-key");
			if (!localStorage.getItem("naia-config")) {
				localStorage.setItem(
					"naia-config",
					JSON.stringify({
						provider: "webllm",
						model: "Qwen3-4B-q4f32_1-MLC",
						ttsEnabled: false,
						locale: "ko",
					}),
				);
			}
		},
		{ origin: shell.origin, authenticated: account !== "guest" },
	);
	return { purchasePosts, entitlementPaths };
}

async function bootShell(page: Page, baseURL: string) {
	await page.goto(baseURL);
	await expect(page.locator("html")).toHaveAttribute("data-naia-web", "true");
	await prepareStoreWorkspace(page);
	await expect(page.locator('[data-app-ready="true"]')).toBeAttached();
}

function launcher(page: Page, id: string) {
	return page.locator(`button.app-bar-tab[data-app-id="${id}"]`);
}

function appFrame(page: Page, id: string) {
	return page.locator(`iframe[src*="/hosted-apps/${id}/"]`);
}

async function clickAppStore(page: Page) {
	const menu = page.getByRole("button", { name: "Menu", exact: true });
	if (await menu.isVisible()) {
		await menu.click();
		await page
			.locator(".web-mobile-menu-list")
			.getByRole("button", { name: /앱스토어/ })
			.click();
	} else {
		await page.getByRole("button", { name: "앱스토어", exact: true }).click();
	}
}

for (const viewport of [
	{ width: 1280, height: 720 },
	{ width: 390, height: 844 },
]) {
	test(`R3 R4 opens the portal storefront and confirms a free app on the shell (${viewport.width}px)`, async ({
		page,
		baseURL,
	}) => {
		if (!baseURL) throw new Error("a local Web Shell baseURL is required");
		await page.setViewportSize(viewport);
		const { purchasePosts } = await prepareWebStore(page, baseURL);
		await bootShell(page, baseURL);
		for (const id of BUILTIN) await expect(launcher(page, id)).toBeAttached();

		const newTab = page.context().waitForEvent("page", { timeout: 15_000 });
		await clickAppStore(page);
		const storefront = await newTab;
		const expected = new URL("/ko/apps?target=web", PORTAL);
		await expect(storefront).toHaveURL(expected.href);
		await expect(
			storefront.getByRole("heading", { name: "Portal storefront fixture" }),
		).toBeVisible();
		await storefront.close();
		await expect(page.getByTestId("web-app-store-modal")).toHaveCount(0);

		await page.goto(webAppInstallUrl(baseURL, FREE_APP).href);
		const confirmation = page.getByTestId("web-app-install-confirm");
		await expect(confirmation).toBeVisible();
		await expect(confirmation).toContainText("Free Quiz");
		await expect(confirmation).not.toContainText(/Paid Quiz|Private Quiz/);
		await expect(launcher(page, FREE_APP)).toHaveCount(0);
		await expect(appFrame(page, FREE_APP)).toHaveCount(0);
		const accept = confirmation.getByTestId("web-app-install-accept");
		await expect(accept).toHaveAccessibleName(
			/설치하고 열기|Install and open/i,
		);
		await expect(confirmation).toBeInViewport();
		await accept.press("Enter");
		await expect(
			appFrame(page, FREE_APP).contentFrame().getByRole("heading"),
		).toHaveText("Quiz fixture is running");
		await expect(confirmation).toHaveCount(0);
		await expect(page).not.toHaveURL(/installApp=/);
		for (const id of [...BUILTIN, FREE_APP])
			await expect(launcher(page, id)).toBeAttached();
		expect(purchasePosts).toEqual([]);
	});
}

for (const account of ["guest", "unowned", "owned"] as const) {
	test(`R4 paid install link checks existing entitlement without purchasing (${account})`, async ({
		page,
		baseURL,
	}) => {
		if (!baseURL) throw new Error("a local Web Shell baseURL is required");
		const { purchasePosts, entitlementPaths } = await prepareWebStore(
			page,
			baseURL,
			account,
		);
		const confirmation = page.getByTestId("web-app-install-confirm");
		if (account !== "guest") await bootShell(page, baseURL);
		await page.goto(webAppInstallUrl(baseURL, PAID_APP).href);
		if (account === "guest") {
			await expect(page.getByTestId("web-workspace-start-default")).toBeVisible(
				{ timeout: 90_000 },
			);
			await expect(confirmation).toHaveCount(0);
			await prepareStoreWorkspace(page);
		}
		await expect(confirmation).toContainText("Paid Quiz");
		await expect(appFrame(page, PAID_APP)).toHaveCount(0);
		await confirmation.getByTestId("web-app-install-accept").click();
		if (account === "guest") {
			await expect(page.getByTestId("web-login-prompt-card")).toBeVisible();
			await expect(page).toHaveURL(/installApp=land\.naia\.paid-quiz/);
		} else if (account === "unowned") {
			await expect(page.getByTestId("web-app-install-error")).toBeVisible();
			await expect(page.getByTestId("web-app-install-shop")).toBeVisible();
		} else {
			await expect(
				appFrame(page, PAID_APP).contentFrame().getByRole("heading"),
			).toHaveText("Quiz fixture is running");
			await expect(page).not.toHaveURL(/installApp=/);
		}
		if (account !== "owned") {
			await expect(launcher(page, PAID_APP)).toHaveCount(0);
			await expect(appFrame(page, PAID_APP)).toHaveCount(0);
		}
		if (account === "guest")
			expect(entitlementPaths).not.toContain(
				`/v1/apps/entitlements/${PAID_APP}`,
			);
		else
			expect(entitlementPaths).toContain(`/v1/apps/entitlements/${PAID_APP}`);
		for (const id of BUILTIN) await expect(launcher(page, id)).toBeAttached();
		expect(purchasePosts).toEqual([]);
	});
}

test("R4 rejects duplicate and private install links, and cancel leaves a public app uninstalled", async ({
	page,
	baseURL,
}) => {
	if (!baseURL) throw new Error("a local Web Shell baseURL is required");
	const { purchasePosts } = await prepareWebStore(page, baseURL);
	await bootShell(page, baseURL);
	const duplicate = webAppInstallUrl(baseURL, FREE_APP);
	duplicate.searchParams.append("installApp", PAID_APP);
	for (const url of [duplicate, webAppInstallUrl(baseURL, PRIVATE_APP)]) {
		await page.goto(url.href);
		await expect(page.getByTestId("web-app-install-error")).toBeVisible();
		await expect(page.getByTestId("web-app-install-accept")).toHaveCount(0);
		await expect(launcher(page, FREE_APP)).toHaveCount(0);
		await expect(launcher(page, PRIVATE_APP)).toHaveCount(0);
	}

	await page.goto(webAppInstallUrl(baseURL, FREE_APP).href);
	const confirmation = page.getByTestId("web-app-install-confirm");
	await confirmation.getByTestId("web-app-install-cancel").click();
	await expect(confirmation).toHaveCount(0);
	await expect(page).not.toHaveURL(/installApp=/);
	await expect(launcher(page, FREE_APP)).toHaveCount(0);
	await expect(appFrame(page, FREE_APP)).toHaveCount(0);
	expect(purchasePosts).toEqual([]);
});
