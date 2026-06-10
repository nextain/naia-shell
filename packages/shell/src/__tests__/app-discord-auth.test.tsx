// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const listeners: Record<
	string,
	((event: { payload: any }) => void) | undefined
> = {};

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn((name: string, cb: (event: { payload: any }) => void) => {
		listeners[name] = cb;
		return Promise.resolve(() => {
			delete listeners[name];
		});
	}),
}));

vi.mock("../components/OnboardingWizard", () => ({
	OnboardingWizard: ({ onComplete }: { onComplete: () => void }) => (
		<button type="button" onClick={onComplete}>
			onboarding
		</button>
	),
}));

vi.mock("../components/AvatarCanvas", () => ({
	AvatarCanvas: () => <div>avatar</div>,
}));

vi.mock("../components/ChatPanel", () => ({
	ChatPanel: () => <div>chat</div>,
}));

vi.mock("../components/TitleBar", () => ({
	TitleBar: () => <div>title</div>,
}));

// Mock panel system to prevent built-in panels from loading Tauri APIs
vi.mock("../lib/panel-loader", () => ({
	loadInstalledPanels: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/panel-registry", () => ({
	panelRegistry: {
		list: vi.fn().mockReturnValue([]),
		get: vi.fn().mockReturnValue(null),
		register: vi.fn(),
		unregister: vi.fn(),
	},
	ActivePanelBridge: class {
		pushContext = vi.fn();
		onToolCall = vi.fn().mockReturnValue(() => {});
		callTool = vi.fn().mockResolvedValue("");
	},
}));
vi.mock("../lib/active-bridge", () => ({
	activeBridge: {
		pushContext: vi.fn(),
		onToolCall: vi.fn().mockReturnValue(() => {}),
		callTool: vi.fn().mockResolvedValue(""),
	},
	getBridgeForPanel: vi.fn().mockReturnValue({
		pushContext: vi.fn(),
		onToolCall: vi.fn().mockReturnValue(() => {}),
		callTool: vi.fn().mockResolvedValue(""),
	}),
}));

import { App } from "../App";

describe("App discord deep-link persistence", () => {
	afterEach(() => {
		localStorage.clear();
		Object.keys(listeners).forEach((key) => delete listeners[key]);
	});

	it("persists discord defaults from global listener", () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "gemini",
				model: "gemini-3-flash-preview",
				apiKey: "",
				onboardingComplete: true,
			}),
		);
		render(<App />);

		expect(typeof listeners.discord_auth_complete).toBe("function");
		listeners.discord_auth_complete?.({
			payload: {
				discordUserId: "865850174651498506",
			},
		});

		const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(saved.discordDefaultUserId).toBe("865850174651498506");
		expect(saved.discordDefaultTarget).toBe("user:865850174651498506");
	});

	it("registers naia_auth_complete listener for channel sync", () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "gemini",
				model: "gemini-3-flash-preview",
				apiKey: "",
				onboardingComplete: true,
			}),
		);
		render(<App />);
		expect(typeof listeners.naia_auth_complete).toBe("function");
	});
});
