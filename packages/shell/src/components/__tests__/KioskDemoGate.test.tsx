// @vitest-environment jsdom
import { StrictMode } from "react";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KioskDemoGate } from "../KioskDemoGate";
const mocks = vi.hoisted(() => ({
	auth: vi.fn(),
	prep: vi.fn(),
	boot: vi.fn(),
	greeting: vi.fn(),
	install: vi.fn(),
	resetMemory: vi.fn(),
}));
vi.mock("../../lib/web-runtime/web-auth", () => ({
	seedKioskDemoWebAuth: mocks.auth,
}));
vi.mock("../../lib/onboarding-core", () => ({
	prepareKioskDemoOnboarding: mocks.prep,
}));
vi.mock("../../lib/web-runtime/auto-install", () => ({
	bootWebRuntimeAndModel: mocks.boot,
}));
vi.mock("../../lib/web-runtime/install", () => ({
	installWebRuntime: mocks.install,
}));
vi.mock("../../lib/kiosk-demo/entry", async () => ({
	...(await vi.importActual("../../lib/kiosk-demo/entry")),
	requestKioskGreeting: mocks.greeting,
}));
vi.mock("../../lib/kiosk-demo/memory", () => ({
	resetKioskMemory: mocks.resetMemory,
}));
beforeEach(() => {
	vi.stubEnv("MODE", "web");
	vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
	vi.clearAllMocks();
	mocks.auth.mockReturnValue(true);
	mocks.prep.mockResolvedValue(undefined);
});
afterEach(() => {
	cleanup();
	vi.unstubAllEnvs();
});
const mount = () =>
	render(
		<StrictMode>
			<KioskDemoGate>
				<div>conversation</div>
			</KioskDemoGate>
		</StrictMode>,
	);
it("OFF renders the ordinary app without seeding or greeting", () => {
	vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "0");
	mount();
	expect(screen.getByText("conversation")).toBeTruthy();
	expect(mocks.auth).not.toHaveBeenCalled();
	expect(mocks.greeting).not.toHaveBeenCalled();
});
it("blocks missing key without mounting the app or starting the model", async () => {
	mocks.auth.mockReturnValue(false);
	mount();
	expect(await screen.findByRole("alert")).toHaveProperty(
		"textContent",
		"시연 열쇠 없음",
	);
	expect(screen.queryByText("conversation")).toBeNull();
	expect(mocks.boot).not.toHaveBeenCalled();
});
it("waits for preparation and opens once only after a gesture", async () => {
	let finish!: () => void;
	mocks.prep.mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	mount();
	expect((screen.getByText("들어가기") as HTMLButtonElement).disabled).toBe(
		true,
	);
	expect(screen.getByRole("status").textContent).toContain("준비");
	expect(mocks.greeting).not.toHaveBeenCalled();
	finish();
	await waitFor(() =>
		expect((screen.getByText("들어가기") as HTMLButtonElement).disabled).toBe(
			false,
		),
	);
	expect((screen.getByText("처음으로") as HTMLButtonElement).disabled).toBe(
		false,
	);
	fireEvent.click(screen.getByText("들어가기"));
	expect(screen.getByText("conversation")).toBeTruthy();
	expect(mocks.greeting).toHaveBeenCalledOnce();
	expect(mocks.prep).toHaveBeenCalledOnce();
	expect(mocks.boot).toHaveBeenCalledOnce();
});
it("shows a safe preparation error and offers retry", async () => {
	mocks.prep.mockRejectedValueOnce(new Error("sensitive exception detail"));
	mount();
	expect((await screen.findByRole("alert")).textContent).not.toContain(
		"sensitive",
	);
	fireEvent.click(screen.getByText("다시 시도"));
	await waitFor(() =>
		expect((screen.getByText("들어가기") as HTMLButtonElement).disabled).toBe(
			false,
		),
	);
});

it("entry reset waits, blocks duplicates and offers a safe retry on failure", async () => {
	let rejectReset!: (e: Error) => void;
	mocks.resetMemory.mockImplementationOnce(
		() =>
			new Promise<void>((_, reject) => {
				rejectReset = reject;
			}),
	);
	mount();
	const reset = await screen.findByText("처음으로");
	await waitFor(() =>
		expect((reset as HTMLButtonElement).disabled).toBe(false),
	);
	fireEvent.click(reset);
	await waitFor(() => expect(mocks.resetMemory).toHaveBeenCalledOnce());
	expect((reset as HTMLButtonElement).disabled).toBe(true);
	expect((screen.getByText("들어가기") as HTMLButtonElement).disabled).toBe(
		true,
	);
	fireEvent.click(reset);
	expect(mocks.resetMemory).toHaveBeenCalledOnce();
	rejectReset(Error("private detail"));
	expect((await screen.findByRole("alert")).textContent).toContain(
		"기억을 초기화하지 못했어요",
	);
	expect(screen.queryByText(/private detail/)).toBeNull();
	expect((reset as HTMLButtonElement).disabled).toBe(false);
});
