import { describe, expect, it, vi } from "vitest";
import {
	type AudioContextLike,
	bindMobileAudioLifecycleSync,
	checkMobileMicrophonePermission,
	requestMobileMicrophonePermission,
	unlockMobileAudioOnGesture,
} from "../audio-session";

describe("mobile/audio-session", () => {
	it("unlocks suspended mobile AudioContext on first user gesture, plays silent warmup buffer, and detaches listeners", async () => {
		const listeners = new Map<string, () => void>();
		const target = {
			addEventListener: vi.fn((type: string, cb: () => void) => {
				listeners.set(type, cb);
			}),
			removeEventListener: vi.fn((type: string) => {
				listeners.delete(type);
			}),
		};

		let state = "suspended";
		const startSpy = vi.fn();
		const connectSpy = vi.fn();
		const ctx: AudioContextLike = {
			get state() {
				return state;
			},
			currentTime: 0,
			destination: { kind: "speakers" },
			resume: vi.fn(async () => {
				state = "running";
			}),
			createBuffer: vi.fn(() => ({ frames: 1 })),
			createBufferSource: vi.fn(() => ({
				buffer: null,
				connect: connectSpy,
				start: startSpy,
			})),
		};

		const onUnlocked = vi.fn();
		const controller = unlockMobileAudioOnGesture({
			getAudioContext: () => ctx,
			target,
			onUnlocked,
		});

		expect(controller.isUnlocked()).toBe(false);
		expect(listeners.size).toBe(4);

		// Simulate user first tap (`pointerdown`)
		listeners.get("pointerdown")?.();
		await new Promise((r) => setTimeout(r, 10));

		expect(controller.isUnlocked()).toBe(true);
		expect(ctx.resume).toHaveBeenCalledTimes(1);
		expect(connectSpy).toHaveBeenCalledWith(ctx.destination);
		expect(startSpy).toHaveBeenCalledWith(0);
		expect(onUnlocked).toHaveBeenCalledWith(ctx);
		// All gesture listeners detached after unlock!
		expect(listeners.size).toBe(0);
	});

	it("pauses GPU lip-sync on background entry and resynchronizes audio clock on foreground return", async () => {
		let state = "running";
		const appState = {
			current: null as ((s: { isActive: boolean }) => void) | null,
		};
		let clockSeconds = 4.25;

		const ctx: AudioContextLike = {
			get state() {
				return state;
			},
			currentTime: 4.0,
			resume: vi.fn(async () => {
				state = "running";
			}),
			suspend: vi.fn(async () => {
				state = "suspended";
			}),
		};

		const onVisualLipSyncPause = vi.fn();
		const onBackgroundSuspend = vi.fn();
		const onForegroundResync = vi.fn();

		const dispose = bindMobileAudioLifecycleSync({
			getAudioContext: () => ctx,
			audioClock: () => clockSeconds,
			keepAudioInBackground: false,
			onVisualLipSyncPause,
			onBackgroundSuspend,
			onForegroundResync,
			env: {
				window: {
					Capacitor: {
						getPlatform: () => "ios",
						isNativePlatform: () => true,
						Plugins: {
							App: {
								addListener: (
									event: string,
									cb: (s: { isActive: boolean }) => void,
								) => {
									if (event === "appStateChange") appState.current = cb;
									return { remove: vi.fn() };
								},
							},
						},
					},
				},
			},
		});

		await Promise.resolve();

		// Enter background -> pauses visual GPU lip-sync & suspends AudioContext
		appState.current?.({ isActive: false });
		expect(onVisualLipSyncPause).toHaveBeenCalledTimes(1);
		expect(onBackgroundSuspend).toHaveBeenCalledTimes(1);
		expect(ctx.suspend).toHaveBeenCalledTimes(1);
		expect(state).toBe("suspended");

		// Return to foreground -> resumes AudioContext & fires exact clock resync
		clockSeconds = 7.62;
		appState.current?.({ isActive: true });
		await new Promise((r) => setTimeout(r, 10));

		expect(ctx.resume).toHaveBeenCalledTimes(1);
		expect(onForegroundResync).toHaveBeenCalledWith({
			audioTimeSeconds: 7.62,
			wasInterrupted: true,
		});

		dispose();
	});

	it("checks and requests microphone permissions via Capacitor native plugin or getUserMedia with immediate track stop", async () => {
		// 1. Native Capacitor Microphone plugin preflight + request
		const nativeEnv = {
			window: {
				Capacitor: {
					getPlatform: () => "android",
					isNativePlatform: () => true,
					Plugins: {
						Microphone: {
							checkPermissions: async () => ({ microphone: "prompt" }),
							requestPermissions: async () => ({ microphone: "granted" }),
						},
					},
				},
			},
		};

		const preflight = await checkMobileMicrophonePermission(nativeEnv);
		expect(preflight).toEqual({
			state: "prompt",
			source: "capacitor-native",
			canOpenAppSettings: true,
		});

		const granted = await requestMobileMicrophonePermission(nativeEnv);
		expect(granted).toEqual({
			state: "granted",
			source: "capacitor-native",
			canOpenAppSettings: true,
		});

		// 2. WebView MediaDevices fallback stops probe tracks immediately
		const stopTrackSpy = vi.fn();
		const webGrant = await requestMobileMicrophonePermission({
			window: {},
			navigator: { userAgent: "Mozilla/5.0 (iPhone)" },
			mediaDevices: {
				getUserMedia: async () => ({
					getTracks: () => [{ stop: stopTrackSpy }],
				}),
			},
		});
		expect(webGrant.state).toBe("granted");
		expect(webGrant.source).toBe("media-devices");
		expect(stopTrackSpy).toHaveBeenCalledTimes(1);

		// 3. Denied getUserMedia maps NotAllowedError -> "denied"
		const deniedErr = Object.assign(new Error("Permission dismissed"), {
			name: "NotAllowedError",
		});
		const webDenied = await requestMobileMicrophonePermission({
			window: {},
			mediaDevices: {
				getUserMedia: async () => {
					throw deniedErr;
				},
			},
		});
		expect(webDenied.state).toBe("denied");
	});
});
