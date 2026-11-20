// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appRegistry } from "../../lib/app-registry";
import {
	type PlatformAppStoreAdapter,
	type StoreProductSummary,
	setPlatformAppStoreAdapterForTests,
} from "../../lib/app-store-adapter";
import { setLocale } from "../../lib/i18n";
import { setWebAssetsModeForTests } from "../../lib/web-runtime/web-assets";
import { useAppStore } from "../../stores/app";
import { WebAppStoreModal } from "../WebAppStoreModal";

vi.mock("../../lib/app-loader", () => ({
	loadInstalledApps: vi.fn(async () => []),
}));

const SAMPLE_ITEMS: StoreProductSummary[] = [
	{
		appId: "land.naia.slides",
		version: "0.1.2",
		priceCredits: 0,
		hostedEntryUrl: "https://dev.naia.land/app/hosted-apps/naia-slides/index.html",
		manifest: {
			id: "land.naia.slides",
			name: "Naia Slides",
			names: { ko: "슬라이드", en: "Naia Slides" },
			descriptions: {
				ko: "PDF·PPTX 발표 자료를 엽니다.",
				en: "Open a PDF or PPTX deck.",
			},
			icon: "▣",
			version: "0.1.2",
		},
	},
	{
		appId: "land.naia.cafelua-tarot",
		version: "0.1.5",
		priceCredits: 3000,
		hostedEntryUrl: "https://dev.naia.land/app/hosted-apps/cafelua-tarot/index.html",
		manifest: {
			id: "land.naia.cafelua-tarot",
			name: "Cafe Lua Tarot",
			names: { ko: "카페루아 타로", en: "Cafe Lua Tarot" },
			descriptions: {
				ko: "타로 리딩 미니앱",
				en: "Tarot reading mini-app",
			},
			icon: "🔮",
			version: "0.1.5",
		},
	},
];

function createStubAdapter(
	overrides: Partial<PlatformAppStoreAdapter> = {},
): PlatformAppStoreAdapter {
	return {
		kind: "web-http",
		listCatalog: vi.fn(async () => SAMPLE_ITEMS),
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
}

function openDrawer() {
	act(() => {
		window.dispatchEvent(
			new CustomEvent("naia-open-web-store-drawer", { cancelable: true }),
		);
	});
}

describe("WebAppStoreModal (R3 unified store UI)", () => {
	const origInnerWidth = window.innerWidth;
	const origInnerHeight = window.innerHeight;

	beforeEach(async () => {
		setWebAssetsModeForTests(true);
		useAppStore.setState({ activeApp: null });
		appRegistry.unregister("land.naia.slides");
		appRegistry.unregister("land.naia.cafelua-tarot");
		await setLocale("ko");
	});

	afterEach(() => {
		cleanup();
		setPlatformAppStoreAdapterForTests(null);
		setWebAssetsModeForTests(null);
		Object.defineProperty(window, "innerWidth", {
			configurable: true,
			value: origInnerWidth,
		});
		Object.defineProperty(window, "innerHeight", {
			configurable: true,
			value: origInnerHeight,
		});
		vi.restoreAllMocks();
	});

	for (const viewport of [
		{ width: 1280, height: 720 },
		{ width: 390, height: 844 },
	]) {
		it(`renders unified catalog with localized copy, price badges, Escape close, and app launch (${viewport.width}x${viewport.height})`, async () => {
			Object.defineProperty(window, "innerWidth", {
				configurable: true,
				value: viewport.width,
			});
			Object.defineProperty(window, "innerHeight", {
				configurable: true,
				value: viewport.height,
			});
			const installApp = vi.fn(async () => {});
			setPlatformAppStoreAdapterForTests(createStubAdapter({ installApp }));

			render(<WebAppStoreModal />);
			openDrawer();

			const dialog = await screen.findByRole("dialog", {
				name: "나이아 웹 미니앱 스토어",
			});
			expect(dialog.style.width).toBe("92vw");
			expect(dialog.style.maxWidth).toBe("560px");
			expect(
				await screen.findByTestId("web-store-price-land.naia.slides"),
			).toHaveTextContent("무료");
			expect(
				screen.getByTestId("web-store-price-land.naia.cafelua-tarot"),
			).toHaveTextContent("3,000 Cr");

			fireEvent.keyDown(window, { key: "Escape" });
			await waitFor(() =>
				expect(screen.queryByTestId("web-app-store-modal")).toBeNull(),
			);

			openDrawer();
			const launchBtn = await screen.findByTestId(
				"web-store-launch-land.naia.slides",
			);
			fireEvent.click(launchBtn);
			await waitFor(() => expect(installApp).toHaveBeenCalledWith("land.naia.slides"));
			expect(useAppStore.getState().activeApp).toBe("land.naia.slides");
		});
	}

	it("translates modal copy across non-Korean locales and falls back app text to English instead of Korean", async () => {
		await setLocale("ja");
		setPlatformAppStoreAdapterForTests(createStubAdapter());
		render(<WebAppStoreModal />);
		openDrawer();

		expect(
			await screen.findByRole("dialog", { name: "Naia ウェブ ミニアプリストア" }),
		).toBeInTheDocument();
		expect(
			await screen.findByTestId("web-store-price-land.naia.slides"),
		).toHaveTextContent("無料");
		expect(
			screen.getByTestId("web-store-item-land.naia.slides"),
		).toHaveTextContent("Naia Slides");
		expect(
			screen.getByTestId("web-store-item-land.naia.slides"),
		).not.toHaveTextContent("슬라이드");
	});

	it("shows empty state and recovers from catalog load error via Retry", async () => {
		let shouldFail = true;
		const listCatalog = vi.fn(async () => {
			if (shouldFail) throw new Error("catalog_offline");
			return [] as StoreProductSummary[];
		});
		setPlatformAppStoreAdapterForTests(createStubAdapter({ listCatalog }));

		render(<WebAppStoreModal />);
		openDrawer();

		expect(await screen.findByRole("alert")).toHaveTextContent("catalog_offline");
		shouldFail = false;
		fireEvent.click(screen.getByTestId("web-app-store-retry"));

		expect(await screen.findByText("표시할 앱이 없습니다.")).toBeVisible();
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
