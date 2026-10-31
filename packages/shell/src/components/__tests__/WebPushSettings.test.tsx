// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebPushSettings } from "../WebPushSettings";

vi.mock("../../lib/i18n", () => ({ getLocale: () => "en" }));

describe("web push settings", () => {
	afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
	function setup(permission: NotificationPermission, existing: unknown = null) {
		const getSubscription = vi.fn().mockResolvedValue(existing);
		const subscribe = vi.fn().mockResolvedValue({ toJSON: () => ({ endpoint: "https://push.example/sub" }) });
		vi.stubGlobal("Notification", { requestPermission: vi.fn().mockResolvedValue(permission) });
		vi.stubGlobal("PushManager", class {});
		vi.stubGlobal("navigator", { serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription, subscribe } }) } });
		render(<WebPushSettings />);
		fireEvent.click(screen.getByText("Web notifications (experimental)"));
		fireEvent.click(screen.getByText("Set up notifications"));
		return { getSubscription, subscribe };
	}
	it("waits for server configuration after permission without inventing a key", async () => {
		vi.stubEnv("VITE_WEB_PUSH_VAPID_PUBLIC_KEY", "");
		const { subscribe } = setup("granted");
		await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Waiting for push server"));
		expect(subscribe).not.toHaveBeenCalled();
	});
	it("does not access a subscription after permission is denied", async () => {
		const { getSubscription } = setup("denied");
		await waitFor(() => expect(screen.getByRole("status").textContent).toContain("not granted"));
		expect(getSubscription).not.toHaveBeenCalled();
	});
	it("displays an existing subscription and does not create a second one", async () => {
		const { subscribe } = setup("granted", { toJSON: () => ({ endpoint: "https://push.example/existing" }) });
		await screen.findByText(/push.example\/existing/);
		expect(subscribe).not.toHaveBeenCalled();
	});
	it("uses a configured public key to create a subscription", async () => {
		vi.stubEnv("VITE_WEB_PUSH_VAPID_PUBLIC_KEY", "example-public-key");
		const { subscribe } = setup("granted");
		await screen.findByText(/push.example\/sub/);
		expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: "example-public-key" });
	});
});
