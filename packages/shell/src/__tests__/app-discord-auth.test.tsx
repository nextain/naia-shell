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

// App 마운트 effect(secure-store via migrate*/loadConfig)가 @tauri-apps/plugin-store `load` 를 호출한다.
// 그 내부가 Tauri core invoke 를 부르는데 jsdom 엔 __TAURI_INTERNALS__ 가 없어 *unhandled rejection*
// (secure-store.ts:16 getStore→Store.load) 4건 → 케이스는 통과해도 vitest 'Errors' → exit 1.
// ⚠️ @tauri-apps/api/core 를 mock 해도 plugin-store 가 내부에서(다른 pnpm 물리경로) core 를 import 해 안 잡힌다.
// secure-store 가 직접 import 하는 경계 = plugin-store 의 load → 여기에 stub Store 를 줘 차단.
vi.mock("@tauri-apps/plugin-store", () => ({
	load: vi.fn(() =>
		Promise.resolve({
			get: vi.fn(() => Promise.resolve(null)),
			set: vi.fn(() => Promise.resolve()),
			delete: vi.fn(() => Promise.resolve()),
			save: vi.fn(() => Promise.resolve()),
		}),
	),
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
vi.mock("../lib/app-loader", () => ({
	loadInstalledApps: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/app-registry", () => ({
	appRegistry: {
		list: vi.fn().mockReturnValue([]),
		get: vi.fn().mockReturnValue(null),
		register: vi.fn(),
		unregister: vi.fn(),
	},
	ActiveAppBridge: class {
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
