// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn().mockResolvedValue({
		id: "land.naia.slides",
		name: "Naia Slides",
		path: "/tmp/apps/land.naia.slides",
}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../../lib/chat-service", () => ({
	sendAppInstall: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../lib/app-loader", () => ({
	loadInstalledApps: vi.fn().mockResolvedValue(undefined),
	refreshInstalledAppsIfChanged: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../lib/app-store-client", () => ({
	getStoreGatewayUrl: vi.fn(() => "https://api-dev.naia.land"),
	getStoreProductMetadata: vi.fn().mockResolvedValue({ name: "Naia Slides", description: "Present slides", thumbnailUrl: "/thumbnail.png" }),
	hasStoreEntitlement: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../lib/logger", () => ({
	Logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// 설치 성공 뒤 설치된 앱을 띄우는 경로가 getState 를 쓴다(#471). 목에 없으면
// 성공 메시지를 세운 직후 던져서 실패 메시지로 덮인다.
const mockSetActiveApp = vi.fn();
vi.mock("../../stores/app", () => {
	const store = (selector: (s: unknown) => unknown) =>
		selector({ pushModal: vi.fn(), popModal: vi.fn() });
	store.getState = () => ({ setActiveApp: mockSetActiveApp });
	return { useAppStore: store };
});

import { AppInstallDialog } from "../AppInstallDialog";
import { getStoreProductMetadata } from "../../lib/app-store-client";

const addButton = () =>
	screen.getByRole("button", { name: "추가" }) as HTMLButtonElement;

describe("AppInstallDialog — zip gating (#358 / #359)", () => {
	beforeEach(() => vi.clearAllMocks());
	afterEach(() => cleanup());

	it("Git URL tab: Add is disabled until a URL is entered, then enabled", () => {
		render(<AppInstallDialog onClose={() => {}} />);
		expect(addButton().disabled).toBe(true);
		fireEvent.change(screen.getByPlaceholderText(/github\.com/), {
			target: { value: "https://github.com/example/my-app.git" },
		});
		expect(addButton().disabled).toBe(false);
	});

	it("Zip tab is gated: shows an in-development notice and keeps Add disabled", () => {
		render(<AppInstallDialog onClose={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: /파일 \(Zip/ }));
		expect(screen.getByText(/보안 강화 작업 중/)).toBeTruthy();
		// Even after switching to the zip tab, install must stay disabled.
		expect(addButton().disabled).toBe(true);
	});
});

describe("AppInstallDialog — storefront install (#471)", () => {
	beforeEach(() => vi.clearAllMocks());
	afterEach(() => cleanup());

	it("shows localized catalog copy and the product thumbnail", async () => {
		render(<AppInstallDialog request={{appId: "land.naia.slides", state: "state", storeOrigin: "https://dev.naia.land"}} onClose={() => {}} />);
		await waitFor(() => expect(screen.getByText("Present slides")).toBeTruthy());
		expect(screen.getByAltText("").getAttribute("src")).toBe("https://dev.naia.land/thumbnail.png");
	});

	it.each(["javascript:alert(1)", "data:image/png;base64,AAAA", "file:///tmp/a.png"])("rejects unsafe thumbnail %s", async (thumbnailUrl) => {
		vi.mocked(getStoreProductMetadata).mockResolvedValueOnce({name: "Slides", description: "Unsafe image", thumbnailUrl, permissions: null});
		render(<AppInstallDialog request={{appId: "app", state: "state", storeOrigin: "https://dev.naia.land"}} onClose={() => {}} />);
		await screen.findByText("Unsafe image");
		expect(screen.queryByAltText("")).toBeNull();
	});

	it("shows declared permissions and omits the list when unavailable", async () => {
		vi.mocked(getStoreProductMetadata).mockResolvedValueOnce({name: "Slides", description: "With permissions", thumbnailUrl: null, permissions: ["model.ask", "speech", "locale"]});
		const request = {appId: "app", state: "state", storeOrigin: "https://dev.naia.land"};
		const view = render(<AppInstallDialog request={request} onClose={() => {}} />);
		await screen.findByText("With permissions");
		expect(screen.getByText("Ask the selected AI model")).toBeTruthy();
		expect(screen.getByText("Read text aloud")).toBeTruthy();
		view.unmount();
		vi.mocked(getStoreProductMetadata).mockResolvedValueOnce({name: "Slides", description: "Without permissions", thumbnailUrl: null, permissions: null});
		render(<AppInstallDialog request={request} onClose={() => {}} />);
		await screen.findByText("Without permissions");
		expect(screen.queryByRole("region", {name: "App permissions"})).toBeNull();
	});

	it("shows exactly one requested app and installs only after confirmation", async () => {
		render(
			<AppInstallDialog
				request={{
					appId: "land.naia.slides",
					name: "Naia Slides",
					state: "one-time-state",
					storeOrigin: "https://dev.naia.land",
				}}
				onClose={() => {}}
			/>,
		);

		expect(screen.getAllByTestId("app-install-product")).toHaveLength(1);
		expect(screen.getByText("Naia Slides")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "설치" }));
		await waitFor(() =>
			expect(
				screen.getByText(/(?:설치 완료|Installed): Naia Slides/),
			).toBeTruthy(),
		);
	});

	it("shows expanded permissions and retries only after explicit confirmation", async () => {
		mockInvoke.mockRejectedValueOnce('PERMISSION_EXPANSION:["permissions: browser","host_permissions: https://example.com/*"]');
		mockInvoke.mockResolvedValueOnce({ id: "land.naia.slides", name: "Naia Slides", path: "/tmp/apps/land.naia.slides" });
		render(<AppInstallDialog request={{ appId: "land.naia.slides", name: "Naia Slides", state: "state", storeOrigin: "https://dev.naia.land" }} onClose={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "설치" }));
		const warning = await screen.findByTestId("permission-expansion");
		expect(warning.textContent).toContain("permissions: browser");
		expect(mockInvoke).toHaveBeenCalledWith("app_install_store", expect.objectContaining({ allowPermissionExpansion: false }));
		fireEvent.click(screen.getByRole("button", { name: /Allow these permissions/ }));
		await waitFor(() => expect(mockInvoke).toHaveBeenLastCalledWith("app_install_store", expect.objectContaining({ allowPermissionExpansion: true })));
	});
});
