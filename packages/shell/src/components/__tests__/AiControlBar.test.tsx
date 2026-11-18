// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadConfigWithSecrets = vi.fn();
const mockWriteNaiaUiConfig = vi.fn();
const mockStartBroadcast = vi.fn();
const mockStopBroadcast = vi.fn();
const mockRequiresBroadcastConfirmation = vi.fn();

vi.mock("../../lib/config", async () => {
	const actual =
		await vi.importActual<typeof import("../../lib/config")>(
			"../../lib/config",
		);
	return {
		...actual,
		loadConfig: vi.fn(),
		loadConfigWithSecrets: (...args: unknown[]) =>
			mockLoadConfigWithSecrets(...args),
		saveConfig: vi.fn(),
	};
});

vi.mock("../../lib/adk-store", () => ({
	getAdkPath: () => null,
	writeNaiaUiConfig: (...args: unknown[]) => mockWriteNaiaUiConfig(...args),
}));

vi.mock("../../lib/broadcast-client", async () => {
	const actual =
		await vi.importActual<typeof import("../../lib/broadcast-client")>(
			"../../lib/broadcast-client",
		);
	return {
		...actual,
		startBroadcast: (...args: unknown[]) => mockStartBroadcast(...args),
		stopBroadcast: (...args: unknown[]) => mockStopBroadcast(...args),
		requiresBroadcastConfirmation: (...args: unknown[]) =>
			mockRequiresBroadcastConfirmation(...args),
	};
});

import {
	clearCameraActions,
	registerCameraActions,
} from "../../lib/avatar/camera-actions";
import { setBroadcastBridgeSnapshot } from "../../lib/broadcast-audio-bridge";
import { useAppStore } from "../../stores/app";
import { useCascadeAvatarStore } from "../../stores/cascade-avatar";
import { AiControlBar } from "../AiControlBar";
import {
	hydrateUiPreferences,
	resetUiPreferencesForTests,
} from "../../lib/ui-preferences";

const baseConfig = {
	provider: "nextain" as const,
	model: "test",
	apiKey: "",
	ttsEnabled: true,
	proactiveSpeechProfile: "personal_radio_dj" as const,
};

describe("AiControlBar proactive cost control", () => {
	beforeEach(() => {
		resetUiPreferencesForTests();
		useAppStore.setState({ ttsEnabled: true, aiInterferenceEnabled: true });
		useCascadeAvatarStore.getState().setRenderer(null);
		clearCameraActions();
		mockWriteNaiaUiConfig.mockResolvedValue(true);
	});

	afterEach(() => {
		cleanup();
		useCascadeAvatarStore.getState().setRenderer(null);
		clearCameraActions();
		vi.clearAllMocks();
	});

	it("keeps zoom controls in the avatar overlay and excludes NVA gestures", async () => {
		const zoom = vi.fn();
		const save = vi.fn();
		const playAction = vi.fn().mockResolvedValue(true);
		registerCameraActions({
			zoom,
			save,
			getGestureActions: () => [{ key: "wave", label: "Wave" }],
			playAction,
		});
		useCascadeAvatarStore.getState().setRenderer({} as never);
		mockLoadConfigWithSecrets.mockResolvedValue(baseConfig);

		render(<AiControlBar />);
		fireEvent.click(screen.getByRole("button", { name: "Avatar controls" }));
		const zoomIn = screen.getByRole("button", { name: "Zoom in" });
		const zoomOut = screen.getByRole("button", { name: "Zoom out" });
		fireEvent.click(zoomIn);
		fireEvent.click(zoomOut);
		expect(zoom).toHaveBeenNthCalledWith(1, 0.1);
		expect(zoom).toHaveBeenNthCalledWith(2, -0.1);
		expect(save).toHaveBeenCalledTimes(2);
		expect(screen.queryByRole("button", { name: "Wave" })).toBeNull();
		expect(document.querySelector("[data-nva-gesture-key]")).toBeNull();
		expect(playAction).not.toHaveBeenCalled();
	});

	it("does not duplicate active NVA gestures over the avatar", async () => {
		registerCameraActions({
			getGestureActions: () => [{ key: "wave", label: "Wave" }],
		});
		useCascadeAvatarStore.getState().setRenderer({} as never);
		mockLoadConfigWithSecrets.mockResolvedValue(baseConfig);

		render(<AiControlBar />);

		fireEvent.click(screen.getByRole("button", { name: "Avatar controls" }));
		expect(screen.getByRole("button", { name: "Zoom in" })).toBeVisible();
		expect(screen.queryByRole("group", { name: "Avatar gestures" })).toBeNull();
		expect(document.querySelector("[data-nva-gesture-key]")).toBeNull();
	});

	it("folds avatar controls by default and restores the saved choice", async () => {
		mockLoadConfigWithSecrets.mockResolvedValue(baseConfig);
		await hydrateUiPreferences(
			{ uiPreferences: {} },
			{ adkPath: "/fixture", canPersist: true },
		);
		const view = render(<AiControlBar />);
		const toggle = screen.getByRole("button", { name: "Avatar controls" });
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();
		fireEvent.click(toggle);
		await waitFor(() =>
			expect(mockWriteNaiaUiConfig).toHaveBeenCalledWith(
				{ uiPreferences: { avatarControlsExpanded: true } },
				"/fixture",
			),
		);
		const controls = document.getElementById("avatar-camera-controls")!;
		expect(
			[...controls.querySelectorAll("button")].map((button) =>
				button.getAttribute("aria-label"),
			),
		).toEqual([
			"Drag to rotate avatar",
			"Drag to pan avatar",
			"Zoom in",
			"Zoom out",
			"Reset avatar view",
		]);
		view.unmount();
		render(<AiControlBar />);
		expect(
			screen.getByRole("button", { name: "Avatar controls" }),
		).toHaveAttribute("aria-expanded", "true");
	});

	it("puts NVA zoom first without rotation, including after hydration", async () => {
		mockLoadConfigWithSecrets.mockResolvedValue(baseConfig);
		await hydrateUiPreferences({
			uiPreferences: { avatarControlsExpanded: true },
		});
		render(<AiControlBar isNva />);
		const names = [
			...document.querySelectorAll("#avatar-camera-controls button"),
		].map((button) => button.getAttribute("aria-label"));
		expect(names).toEqual([
			"Zoom in",
			"Zoom out",
			"Drag to pan avatar",
			"Reset avatar view",
		]);
	});

	it("shows accessible AI and TTS icons with an off slash", () => {
		mockLoadConfigWithSecrets.mockResolvedValue(baseConfig);
		render(<AiControlBar />);
		for (const [on, off] of [
			[
				"Turn off AI interference (Ctrl+Alt+A)",
				"Turn on AI interference (Ctrl+Alt+A)",
			],
			["Turn off TTS", "Turn on TTS"],
		]) {
			const button = screen.getByRole("button", { name: on });
			expect(button).toHaveAttribute("title", on);
			expect(button.querySelector("svg")).not.toBeNull();
			expect(button.querySelector("[data-off-slash]")).toBeNull();
			fireEvent.click(button);
			const disabled = screen.getByRole("button", { name: off });
			expect(disabled).toHaveAttribute("aria-pressed", "false");
			expect(disabled.querySelector("[data-off-slash]")).not.toBeNull();
		}
	});

	it("shows a blocked control when no profile is configured", async () => {
		mockLoadConfigWithSecrets.mockResolvedValue({
			...baseConfig,
			proactiveSpeechProfile: "disabled",
		});
		render(<AiControlBar />);
		const button = await screen.findByRole("button", {
			name: /requires a profile/i, // #510 — TTS 는 더 이상 게이트가 아니다
		});
		expect(button).toHaveAttribute("data-proactive-state", "blocked");
		expect(button).toHaveAttribute("aria-pressed", "false");
		expect(button.querySelector("svg")).not.toBeNull();
		expect(button).toHaveAttribute(
			"aria-describedby",
			"proactive-control-tooltip",
		);
	});

	it("keeps the proactive toggle usable when TTS is off (#510)", async () => {
		useAppStore.setState({ ttsEnabled: false });
		mockLoadConfigWithSecrets.mockResolvedValue({
			...baseConfig,
			ttsEnabled: false,
		});
		render(<AiControlBar />);
		const button = await screen.findByRole("button", {
			name: /Allow proactive speech/i,
		});
		// TTS 꺼짐은 발화만 생략(텍스트 도착) — 버튼을 잠그지 않는다.
		expect(button).toHaveAttribute("data-proactive-state", "off");
	});

	it("keeps a saved profile off unless permission was explicitly persisted", async () => {
		mockLoadConfigWithSecrets.mockResolvedValue(baseConfig);
		render(<AiControlBar />);
		const button = await screen.findByRole("button", {
			name: /Allow proactive speech/i,
		});
		expect(button).toHaveAttribute("aria-pressed", "false");
		expect(button).toHaveAttribute("data-proactive-state", "off");
	});

	it("persists visible permission and requests profile start", async () => {
		mockLoadConfigWithSecrets.mockResolvedValue({
			...baseConfig,
			proactiveSpeechPermitted: false,
		});
		const requested: boolean[] = [];
		window.addEventListener("naia-proactive-permission-change", (event) => {
			requested.push(
				(event as CustomEvent<{ permitted: boolean }>).detail.permitted,
			);
		});
		render(<AiControlBar />);
		const button = await screen.findByRole("button", {
			name: /Allow proactive speech/i,
		});
		fireEvent.click(button);
		await waitFor(() => expect(mockWriteNaiaUiConfig).toHaveBeenCalled());
		expect(requested).toEqual([true]);
	});

	it("reflects an active activity without changing permission", async () => {
		mockLoadConfigWithSecrets.mockResolvedValue({
			...baseConfig,
			proactiveSpeechPermitted: true,
		});
		render(<AiControlBar />);
		await screen.findByRole("button", { name: /Stop proactive speech/i });
		act(() =>
			window.dispatchEvent(
				new CustomEvent("naia-proactive-activity-state", {
					detail: { active: true },
				}),
			),
		);
		expect(
			screen.getByRole("button", { name: /Stop proactive speech/i }),
		).toHaveAttribute("data-proactive-state", "active");
	});

	it("publishes an immediate cancellation event when TTS is turned off", async () => {
		mockLoadConfigWithSecrets.mockResolvedValue(baseConfig);
		const states: boolean[] = [];
		window.addEventListener("naia:tts-enabled-change", (event) => {
			states.push((event as CustomEvent<{ enabled: boolean }>).detail.enabled);
		});
		render(<AiControlBar />);
		fireEvent.click(screen.getByRole("button", { name: "Turn off TTS" }));
		expect(states).toEqual([false]);
	});

	it("shows pre-broadcast confirmation dialog on Windows (destination masked + Naia window) and only connects on confirm", async () => {
		mockRequiresBroadcastConfirmation.mockReturnValue(true);
		mockStartBroadcast.mockResolvedValue(undefined);
		setBroadcastBridgeSnapshot({
			state: "idle",
			elapsedSeconds: 0,
			hasStreamKey: true,
			lastError: null,
		});
		mockLoadConfigWithSecrets.mockResolvedValue({
			...baseConfig,
			broadcastPlatform: "youtube",
			broadcastServerUrl: "rtmps://a.rtmp.youtube.com/live2",
			broadcastStreamKey: "win-stream-secret-key",
		});

		render(<AiControlBar />);
		const toggleBtn = await screen.findByTestId("ai-bar-broadcast-btn");
		await waitFor(() => expect(toggleBtn).not.toBeDisabled());

		fireEvent.click(toggleBtn);
		const dialog = await screen.findByTestId("broadcast-confirm-dialog");
		expect(dialog).toBeVisible();
		expect(mockStartBroadcast).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(
				screen.getByTestId("broadcast-confirm-destination").textContent,
			).toBe("rtmps://a.rtmp.youtube.com/live2/••••••••"),
		);
		expect(
			screen.getByTestId("broadcast-confirm-destination").textContent,
		).not.toContain("win-stream-secret-key");
		expect(
			screen.getByTestId("broadcast-confirm-target").textContent,
		).toMatch(/Naia/);

		fireEvent.click(screen.getByTestId("broadcast-confirm-cancel-btn"));
		expect(screen.queryByTestId("broadcast-confirm-dialog")).toBeNull();
		expect(mockStartBroadcast).not.toHaveBeenCalled();

		fireEvent.click(toggleBtn);
		await screen.findByTestId("broadcast-confirm-dialog");
		fireEvent.click(screen.getByTestId("broadcast-confirm-start-btn"));
		await waitFor(() => expect(mockStartBroadcast).toHaveBeenCalledTimes(1));
	});

	it("starts broadcast directly on Linux without showing the Windows confirmation modal", async () => {
		mockRequiresBroadcastConfirmation.mockReturnValue(false);
		mockStartBroadcast.mockResolvedValue(undefined);
		setBroadcastBridgeSnapshot({
			state: "idle",
			elapsedSeconds: 0,
			hasStreamKey: true,
			lastError: null,
		});
		mockLoadConfigWithSecrets.mockResolvedValue({
			...baseConfig,
			broadcastPlatform: "youtube",
			broadcastServerUrl: "rtmps://a.rtmp.youtube.com/live2",
			broadcastStreamKey: "linux-stream-secret",
		});

		render(<AiControlBar />);
		const toggleBtn = await screen.findByTestId("ai-bar-broadcast-btn");
		await waitFor(() => expect(toggleBtn).not.toBeDisabled());
		fireEvent.click(toggleBtn);

		expect(screen.queryByTestId("broadcast-confirm-dialog")).toBeNull();
		await waitFor(() => expect(mockStartBroadcast).toHaveBeenCalledTimes(1));
	});

	it("renders broadcast_start failure message visibly in AiControlBar and clears on dismiss", async () => {
		setBroadcastBridgeSnapshot({
			state: "idle",
			elapsedSeconds: 0,
			hasStreamKey: true,
			lastError:
				"방송용 FFmpeg 실행 파일이 올바르지 않아요(설치본 손상 또는 개발용 자리표시 파일).",
		});
		mockLoadConfigWithSecrets.mockResolvedValue({
			...baseConfig,
			broadcastStreamKey: "configured-key",
		});

		render(<AiControlBar />);
		const alert = await screen.findByTestId("broadcast-error-alert");
		expect(alert).toBeVisible();
		expect(alert.textContent).toContain("FFmpeg");

		fireEvent.click(screen.getByTestId("broadcast-error-dismiss-btn"));
		await waitFor(() =>
			expect(screen.queryByTestId("broadcast-error-alert")).toBeNull(),
		);
	});

	it("renders AI, TTS, and Broadcast controls as icon buttons with accessible labels and distinct on/off SVG shapes", async () => {
		useAppStore.setState({ aiInterferenceEnabled: true, ttsEnabled: true });
		mockLoadConfigWithSecrets.mockResolvedValue(baseConfig);
		render(<AiControlBar />);

		const aiBtn = screen.getByTestId("ai-bar-interference-btn");
		const ttsBtn = screen.getByTestId("ai-bar-tts-btn");
		const broadcastBtn = screen.getByTestId("ai-bar-broadcast-btn");

		expect(aiBtn).toHaveClass("bgm-ai-toggle--icon");
		expect(ttsBtn).toHaveClass("bgm-ai-toggle--icon");
		expect(broadcastBtn).toHaveClass("bgm-ai-toggle--icon");

		expect(aiBtn.getAttribute("aria-label")).toBeTruthy();
		expect(aiBtn.getAttribute("title")).toBe(aiBtn.getAttribute("aria-label"));
		expect(ttsBtn.getAttribute("aria-label")).toBeTruthy();
		expect(ttsBtn.getAttribute("title")).toBe(ttsBtn.getAttribute("aria-label"));
		expect(broadcastBtn.getAttribute("aria-label")).toBeTruthy();
		expect(broadcastBtn.getAttribute("title")).toBe(
			broadcastBtn.getAttribute("aria-label"),
		);

		const ttsOnSvg = ttsBtn.querySelector("svg")?.innerHTML;
		expect(ttsOnSvg).toBeTruthy();
		fireEvent.click(ttsBtn);
		const ttsOffSvg = ttsBtn.querySelector("svg")?.innerHTML;
		expect(ttsOffSvg).not.toBe(ttsOnSvg);
		expect(ttsBtn).toHaveAttribute("data-control-state", "off");
	});

	it("FR-WEB-KIOSK-FIX7B.7 hides Broadcast and AI interference buttons in kiosk demo mode while keeping TTS and layout orientation toggle visible", async () => {
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		try {
			mockLoadConfigWithSecrets.mockResolvedValue(baseConfig);
			render(<AiControlBar />);

			expect(screen.queryByTestId("ai-bar-interference-btn")).toBeNull();
			expect(screen.queryByTestId("ai-bar-proactive-btn")).toBeNull();
			expect(screen.queryByTestId("ai-bar-broadcast-btn")).toBeNull();
			expect(screen.getByTestId("ai-bar-tts-btn")).toBeInTheDocument();
			expect(screen.getByTestId("layout-orientation-toggle")).toBeInTheDocument();
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("renders broadcast confirmation dialog and error alert when showCameraControls is false (NVA/header mode, #879)", async () => {
		mockRequiresBroadcastConfirmation.mockReturnValue(true);
		mockStartBroadcast.mockResolvedValue(undefined);
		setBroadcastBridgeSnapshot({
			state: "idle",
			elapsedSeconds: 0,
			hasStreamKey: true,
			lastError: "broadcast test error",
		});
		mockLoadConfigWithSecrets.mockResolvedValue({
			...baseConfig,
			broadcastPlatform: "youtube",
			broadcastServerUrl: "rtmps://a.rtmp.youtube.com/live2",
			broadcastStreamKey: "nva-stream-secret-key",
		});

		render(<AiControlBar showCameraControls={false} isNva />);
		expect(screen.queryByRole("button", { name: "Avatar controls" })).toBeNull();

		const alert = await screen.findByTestId("broadcast-error-alert");
		expect(alert).toBeVisible();
		expect(alert.textContent).toContain("broadcast test error");

		const toggleBtn = await screen.findByTestId("ai-bar-broadcast-btn");
		await waitFor(() => expect(toggleBtn).not.toBeDisabled());
		fireEvent.click(toggleBtn);
		const dialog = await screen.findByTestId("broadcast-confirm-dialog");
		expect(dialog).toBeVisible();

		fireEvent.click(screen.getByTestId("broadcast-confirm-start-btn"));
		await waitFor(() => expect(mockStartBroadcast).toHaveBeenCalledTimes(1));
	});
});
