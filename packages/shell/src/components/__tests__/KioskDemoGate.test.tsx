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
	verifyAuth: vi.fn(),
	prep: vi.fn(),
	boot: vi.fn(),
	greeting: vi.fn(),
	install: vi.fn(),
	resetMemory: vi.fn(),
	clearConversations: vi.fn(),
}));
vi.mock("../../lib/web-runtime/web-auth", () => ({
	seedKioskDemoWebAuth: mocks.auth,
	verifyKioskDemoWebAuth: mocks.verifyAuth,
}));
vi.mock("../../lib/web-runtime/web-workspace-commands", () => ({
	clearWebConversations: mocks.clearConversations,
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
	localStorage.clear();
	sessionStorage.clear();
	vi.stubEnv("MODE", "web");
	vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
	vi.clearAllMocks();
	mocks.auth.mockReturnValue(true);
	mocks.verifyAuth.mockResolvedValue({ ok: true, credits: 100 });
	mocks.prep.mockResolvedValue(undefined);
	mocks.clearConversations.mockResolvedValue(undefined);
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
	await waitFor(() => expect(mocks.prep).toHaveBeenCalledOnce());
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
it("unlocks AudioContext and speechSynthesis synchronously inside the entry click gesture", async () => {
	const resumeAudio = vi.fn(() => Promise.resolve());
	class FakeAudioContext {
		state = "suspended";
		resume = resumeAudio;
	}
	const cancelSpeech = vi.fn();
	const resumeSpeech = vi.fn();
	vi.stubGlobal("AudioContext", FakeAudioContext);
	vi.stubGlobal("speechSynthesis", {
		cancel: cancelSpeech,
		resume: resumeSpeech,
	});
	mount();
	await waitFor(() =>
		expect((screen.getByText("들어가기") as HTMLButtonElement).disabled).toBe(
			false,
		),
	);
	fireEvent.click(screen.getByText("들어가기"));
	expect(resumeAudio).toHaveBeenCalledOnce();
	expect(cancelSpeech).toHaveBeenCalledOnce();
	expect(resumeSpeech).toHaveBeenCalledOnce();
	expect(resumeAudio.mock.invocationCallOrder[0]).toBeLessThan(
		mocks.greeting.mock.invocationCallOrder[0],
	);
	vi.unstubAllGlobals();
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

it("shows unavailable notice when gateway confirms zero credits", async () => {
	mocks.verifyAuth.mockResolvedValueOnce({ ok: false, reason: "unavailable" });
	mount();
	const alert = await screen.findByRole("alert");
	expect(
		screen.getByRole("heading", { name: "지금은 시연을 잠시 쉬고 있어요" }),
	).toBeTruthy();
	expect(alert.textContent).toContain("오늘 준비한 시연 사용량을 다 썼어요.");
	expect(alert.textContent).toContain("잠시 뒤 다시 들어와 주세요.");
	expect(alert.textContent).not.toContain("부스 직원");
	expect(screen.queryByText("지나와 이야기해 보세요")).toBeNull();
	expect(screen.queryByText("들어가기")).toBeNull();
	expect(screen.queryByText("conversation")).toBeNull();
	expect(mocks.boot).not.toHaveBeenCalled();
});

it("does not show unavailable screen when balance lookup fails transiently", async () => {
	mocks.verifyAuth.mockResolvedValueOnce({
		ok: false,
		reason: "lookup-failed",
	});
	mount();
	await waitFor(() =>
		expect((screen.getByText("들어가기") as HTMLButtonElement).disabled).toBe(
			false,
		),
	);
	expect(
		screen.queryByRole("heading", { name: "지금은 시연을 잠시 쉬고 있어요" }),
	).toBeNull();
});

it("cleans up previous visitor memory and conversations when previous visit was left without reset", async () => {
	localStorage.setItem("naia-kiosk-last-active-at", "1000");
	localStorage.setItem(
		"naia-config",
		JSON.stringify({
			agentName: "방문자설정",
			provider: "codex",
			model: "gpt-5.6-sol",
			apiKey: "",
		}),
	);
	mount();
	await waitFor(() =>
		expect((screen.getByText("들어가기") as HTMLButtonElement).disabled).toBe(
			false,
		),
	);
	expect(mocks.resetMemory).toHaveBeenCalledOnce();
	expect(mocks.clearConversations).toHaveBeenCalledOnce();
	expect(JSON.parse(localStorage.getItem("naia-config")!)).toMatchObject({
		agentName: "지나",
		provider: "nextain",
		model: "gpt-5.6-luna",
	});
});

it("transitions back to unavailable screen when credits run out mid-demo", async () => {
	const { notifyKioskDemoUnavailable } = await import(
		"../../lib/kiosk-demo/entry"
	);
	mount();
	await waitFor(() =>
		expect((screen.getByText("들어가기") as HTMLButtonElement).disabled).toBe(
			false,
		),
	);
	fireEvent.click(screen.getByText("들어가기"));
	expect(screen.getByText("conversation")).toBeTruthy();

	notifyKioskDemoUnavailable();
	const alert = await screen.findByRole("alert");
	expect(
		screen.getByRole("heading", { name: "지금은 시연을 잠시 쉬고 있어요" }),
	).toBeTruthy();
	expect(alert.textContent).toContain("오늘 준비한 시연 사용량을 다 썼어요.");
	expect(alert.textContent).toContain("잠시 뒤 다시 들어와 주세요.");
	expect(alert.textContent).not.toContain("부스 직원");
	expect(screen.queryByText("지나와 이야기해 보세요")).toBeNull();
	expect(screen.queryByText("들어가기")).toBeNull();
	expect(screen.queryByText("conversation")).toBeNull();
});
