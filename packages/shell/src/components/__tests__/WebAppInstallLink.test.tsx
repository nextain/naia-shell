// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadInstalledApps } from "../../lib/app-loader";
import { appRegistry } from "../../lib/app-registry";
import {
	AppStoreHttpError,
	type PlatformAppStoreAdapter,
	type StoreProductSummary,
	setPlatformAppStoreAdapterForTests,
} from "../../lib/app-store-adapter";
import { setLocale } from "../../lib/i18n";
import { resetWebAdkStatusForTests, setWebAdkStatus } from "../../lib/web-runtime/web-adk-status";
import { setWebAssetsModeForTests } from "../../lib/web-runtime/web-assets";
import { onWebLoginPrompt } from "../../lib/web-runtime/web-login-prompt";
import { useAppStore } from "../../stores/app";
import { WebAppInstallLink } from "../WebAppInstallLink";

vi.mock("../../lib/app-loader", () => ({ loadInstalledApps: vi.fn() }));

const appId = "land.naia.slides";
const item: StoreProductSummary = {
	appId,
	version: "1.0.0",
	priceCredits: 500,
	manifest: { id: appId, name: "Naia Slides", version: "1.0.0" },
};

function createAdapter(overrides: Partial<PlatformAppStoreAdapter> = {}) {
	const adapter: PlatformAppStoreAdapter = {
		kind: "web-http",
		listCatalog: vi.fn(async () => [item]),
		listEntitlements: vi.fn(async () => []),
		listInstalledManifests: vi.fn(async () => []),
		checkEntitlement: vi.fn(async () => true),
		verifyAppTrust: vi.fn(async () => true),
		purchaseApp: vi.fn(async () => {}),
		installApp: vi.fn(async () => {}),
		uninstallApp: vi.fn(async () => {}),
		openStoreSurface: vi.fn(async () => {}),
		resolveFrameSrc: (url) => url,
		...overrides,
	};
	setPlatformAppStoreAdapterForTests(adapter);
	return adapter;
}

function registerApp() {
	appRegistry.register({ id: appId, name: "Naia Slides", center: () => null });
}

async function showLink() {
	render(<WebAppInstallLink ready />);
	return screen.findByTestId("web-app-install-accept");
}

describe("web catalog install handoff", () => {
	beforeEach(async () => {
		setWebAssetsModeForTests(true);
		setWebAdkStatus({ phase: "ready" });
		await setLocale("en");
		window.history.replaceState(null, "", "/app/?installApp=naia-slides&keep=1#section");
		useAppStore.getState().setActiveApp(null);
		vi.mocked(loadInstalledApps).mockReset();
	});

	afterEach(() => {
		cleanup();
		appRegistry.unregister(appId);
		setPlatformAppStoreAdapterForTests(null);
		setWebAssetsModeForTests(null);
		resetWebAdkStatusForTests();
		window.history.replaceState(null, "", "/");
	});

	it("canonicalizes the app, shows only one result and installs only after confirmation", async () => {
		const adapter = createAdapter();
		vi.mocked(loadInstalledApps).mockImplementation(async () => registerApp());
		const accept = await showLink();

		expect(screen.getByTestId("web-app-install-confirm")).toHaveTextContent("Naia Slides");
		expect(adapter.installApp).not.toHaveBeenCalled();

		fireEvent.click(accept);
		fireEvent.click(accept);
		await waitFor(() => expect(useAppStore.getState().activeApp).toBe(appId));
		expect(adapter.installApp).toHaveBeenCalledExactlyOnceWith(appId, { purchaseIfNeeded: false });
		expect(adapter.purchaseApp).not.toHaveBeenCalled();
		expect(loadInstalledApps).toHaveBeenCalledOnce();
		expect(window.location.search + window.location.hash).toBe("?keep=1#section");
	});

	it("leaves first workspace setup accessible and waits for config hydration", async () => {
		const adapter = createAdapter();
		setWebAdkStatus({ phase: "needs-setup" });
		const { rerender } = render(<WebAppInstallLink ready={false} />);
		expect(screen.queryByTestId("web-app-install-confirm")).not.toBeInTheDocument();
		expect(adapter.listCatalog).not.toHaveBeenCalled();
		expect(window.location.search).toContain("installApp=naia-slides");

		rerender(<WebAppInstallLink ready />);
		expect(screen.queryByTestId("web-app-install-confirm")).not.toBeInTheDocument();
		act(() => setWebAdkStatus({ phase: "ready" }));
		expect(await screen.findByTestId("web-app-install-accept")).toBeInTheDocument();
		expect(adapter.installApp).not.toHaveBeenCalled();
	});

	it("opens an installed app only after a strict entitlement check", async () => {
		const adapter = createAdapter();
		registerApp();
		const accept = await showLink();
		expect(accept).toHaveTextContent("Open");
		fireEvent.click(accept);
		await waitFor(() => expect(useAppStore.getState().activeApp).toBe(appId));
		expect(adapter.checkEntitlement).toHaveBeenCalledExactlyOnceWith(appId, { requireExplicit: true });
		expect(adapter.installApp).not.toHaveBeenCalled();
		expect(adapter.purchaseApp).not.toHaveBeenCalled();
	});

	it.each(["auth_required", "unauthorized"] as const)("keeps the app request during sign-in for %s", async (code) => {
		createAdapter({
			installApp: vi.fn(async () => { throw new AppStoreHttpError(code, "auth"); }),
		});
		const prompt = vi.fn();
		const dispose = onWebLoginPrompt(prompt);
		try {
			fireEvent.click(await showLink());
			expect(await screen.findByTestId("web-app-install-error")).toHaveTextContent("Sign in");
			expect(prompt).toHaveBeenCalledExactlyOnceWith(
				code === "unauthorized" ? { reason: "app-store", reauthenticate: true } : { reason: "app-store" },
			);
			expect(window.location.search).toContain("installApp=naia-slides");
			expect(useAppStore.getState().activeApp).toBeNull();
		} finally {
			dispose();
		}
	});

	it("sends an unowned app back to the official store without purchasing", async () => {
		const adapter = createAdapter({
			installApp: vi.fn(async () => { throw new AppStoreHttpError("not_entitled", "not owned"); }),
		});
		fireEvent.click(await showLink());
		expect(await screen.findByTestId("web-app-install-error")).toHaveTextContent("not in your library");
		const store = new URL((await screen.findByTestId("web-app-install-shop"))!.getAttribute("href")!);
		expect(store.pathname).toBe("/en/apps");
		expect(store.searchParams.get("target")).toBe("web");
		expect(screen.queryByTestId("web-app-install-accept")).not.toBeInTheDocument();
		expect(adapter.purchaseApp).not.toHaveBeenCalled();
	});

	it("does not look up conflicting parameters", () => {
		const adapter = createAdapter();
		window.history.replaceState(null, "", "/app/?installApp=naia-slides&installApp=land.naia.elsewhere");
		render(<WebAppInstallLink ready />);
		expect(screen.getByTestId("web-app-install-error")).toBeInTheDocument();
		expect(screen.queryByTestId("web-app-install-accept")).not.toBeInTheDocument();
		expect(adapter.listCatalog).not.toHaveBeenCalled();
	});

	it("rechecks the current catalog and declines an app hidden before confirmation", async () => {
		const adapter = createAdapter({ listCatalog: vi.fn().mockResolvedValueOnce([item]).mockResolvedValueOnce([]) });
		fireEvent.click(await showLink());
		expect(await screen.findByTestId("web-app-install-error")).toHaveTextContent("unavailable");
		expect(adapter.installApp).not.toHaveBeenCalled();
	});

	it("cancels without changing unrelated address parameters or installing", async () => {
		const adapter = createAdapter();
		await showLink();
		fireEvent.click(screen.getByTestId("web-app-install-cancel"));
		expect(screen.queryByTestId("web-app-install-confirm")).not.toBeInTheDocument();
		expect(window.location.search + window.location.hash).toBe("?keep=1#section");
		expect(adapter.installApp).not.toHaveBeenCalled();
	});
});
