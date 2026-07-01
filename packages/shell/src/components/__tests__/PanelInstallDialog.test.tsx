// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../../lib/chat-service", () => ({
	sendPanelInstall: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../lib/app-loader", () => ({
	loadInstalledApps: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../lib/logger", () => ({
	Logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../stores/app", () => ({
	useAppStore: (selector: (s: unknown) => unknown) =>
		selector({ pushModal: vi.fn(), popModal: vi.fn() }),
}));

import { AppInstallDialog } from "../AppInstallDialog";

const addButton = () =>
	screen.getByRole("button", { name: "추가" }) as HTMLButtonElement;

describe("AppInstallDialog — zip gating (#358 / #359)", () => {
	beforeEach(() => vi.clearAllMocks());
	afterEach(() => cleanup());

	it("Git URL tab: Add is disabled until a URL is entered, then enabled", () => {
		render(<AppInstallDialog onClose={() => {}} />);
		expect(addButton().disabled).toBe(true);
		fireEvent.change(screen.getByPlaceholderText(/github\.com/), {
			target: { value: "https://github.com/example/my-panel.git" },
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
