import { describe, expect, it, vi } from "vitest";
import {
	type PlatformProbeEnv,
	applyMobileSafeAreaCssVars,
	detectMobileShellPlatform,
	isCapacitorNativeApp,
	isIosWebKitRuntime,
	resolveNvaMobileVideoStrategy,
	shouldForceMp4ChromaKeyNva,
	subscribeMobileDeepLinks,
} from "../platform";

describe("mobile/platform", () => {
	it("accurately classifies iOS/Android Capacitor, Tauri desktop, mobile web (including iPadOS), and desktop web", () => {
		const iosCap: PlatformProbeEnv = {
			window: {
				Capacitor: {
					getPlatform: () => "ios",
					isNativePlatform: () => true,
				},
			},
			navigator: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)" },
		};
		expect(detectMobileShellPlatform(iosCap)).toBe("ios-capacitor");
		expect(isCapacitorNativeApp(iosCap)).toBe(true);
		expect(isIosWebKitRuntime(iosCap)).toBe(true);

		const androidCap: PlatformProbeEnv = {
			window: {
				Capacitor: {
					getPlatform: () => "android",
					isNativePlatform: () => true,
				},
			},
			navigator: { userAgent: "Mozilla/5.0 (Linux; Android 15)" },
		};
		expect(detectMobileShellPlatform(androidCap)).toBe("android-capacitor");
		expect(isCapacitorNativeApp(androidCap)).toBe(true);
		expect(isIosWebKitRuntime(androidCap)).toBe(false);

		// Capacitor web polyfill (`getPlatform() === "web"`, `isNativePlatform() === false`) must NOT claim native app
		const capWeb: PlatformProbeEnv = {
			window: {
				Capacitor: {
					getPlatform: () => "web",
					isNativePlatform: () => false,
				},
			},
			navigator: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)" },
		};
		expect(detectMobileShellPlatform(capWeb)).toBe("desktop-web");
		expect(isCapacitorNativeApp(capWeb)).toBe(false);

		const tauriDesktop: PlatformProbeEnv = {
			window: { __TAURI_INTERNALS__: { invoke: vi.fn() } },
			navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
		};
		expect(detectMobileShellPlatform(tauriDesktop)).toBe("desktop-tauri");

		const ipadDesktopClassSafari: PlatformProbeEnv = {
			window: {},
			navigator: {
				userAgent:
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
				platform: "MacIntel",
				maxTouchPoints: 5,
			},
		};
		expect(detectMobileShellPlatform(ipadDesktopClassSafari)).toBe(
			"mobile-web",
		);
		expect(isIosWebKitRuntime(ipadDesktopClassSafari)).toBe(true);
	});

	it("forces H.264 MP4 chroma-key NVA on all iOS WKWebView runtimes and WebM-incapable WebViews", () => {
		// Even if an iOS WebView claims basic VP9 playback ("maybe"), alpha WebM is broken on WKWebView
		const iosWithVp9Maybe: PlatformProbeEnv = {
			window: {
				Capacitor: {
					getPlatform: () => "ios",
					isNativePlatform: () => true,
				},
			},
			navigator: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1)" },
			createVideoElement: () => ({ canPlayType: () => "maybe" }),
		};
		const iosStrategy = resolveNvaMobileVideoStrategy(iosWithVp9Maybe);
		expect(iosStrategy.forceMp4ChromaKey).toBe(true);
		expect(iosStrategy.preferredContainer).toBe("mp4-chromakey");
		expect(iosStrategy.reason).toBe("ios-wkwebview-no-alpha-webm");
		expect(shouldForceMp4ChromaKeyNva(iosWithVp9Maybe)).toBe(true);

		// Android Capacitor with VP9 support uses native alpha WebM
		const androidVp9Ok: PlatformProbeEnv = {
			window: {
				Capacitor: {
					getPlatform: () => "android",
					isNativePlatform: () => true,
				},
			},
			navigator: { userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9)" },
			createVideoElement: () => ({ canPlayType: () => "probably" }),
		};
		const androidStrategy = resolveNvaMobileVideoStrategy(androidVp9Ok);
		expect(androidStrategy.forceMp4ChromaKey).toBe(false);
		expect(androidStrategy.preferredContainer).toBe("webm-alpha");
		expect(androidStrategy.reason).toBe("native-alpha-webm-ok");

		// Legacy/embedded browser without VP9 WebM falls back to MP4 chroma-key
		const noWebmBrowser: PlatformProbeEnv = {
			window: {},
			navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" },
			createVideoElement: () => ({ canPlayType: () => "" }),
		};
		expect(resolveNvaMobileVideoStrategy(noWebmBrowser)).toMatchObject({
			forceMp4ChromaKey: true,
			reason: "webm-vp9-unsupported",
		});
	});

	it("injects Safe-Area & keyboard CSS variables and syncs Capacitor Keyboard + visualViewport events", async () => {
		const vvResize = { current: null as (() => void) | null };
		const keyboardHandlers: Record<
			string,
			(info: { keyboardHeight?: number }) => void
		> = {};
		const removedHandles: string[] = [];

		const viewport = {
			height: 812,
			width: 393,
			offsetTop: 0,
			addEventListener: vi.fn((type: string, cb: () => void) => {
				if (type === "resize") vvResize.current = cb;
			}),
			removeEventListener: vi.fn(),
		};

		const attrs = new Map<string, string>();
		const styles = new Map<string, string>();
		const mockRoot = {
			setAttribute: (k: string, v: string) => {
				attrs.set(k, v);
			},
			getAttribute: (k: string) => attrs.get(k) ?? null,
			style: {
				setProperty: (k: string, v: string) => {
					styles.set(k, v);
				},
				getPropertyValue: (k: string) => styles.get(k) ?? "",
			},
		};
		const mockDoc = { documentElement: mockRoot };

		const env: PlatformProbeEnv = {
			document: mockDoc,
			navigator: { userAgent: "Mozilla/5.0 (iPhone)" },
			window: {
				innerHeight: 812,
				visualViewport: viewport,
				Capacitor: {
					getPlatform: () => "ios",
					isNativePlatform: () => true,
					isPluginAvailable: (name) => name === "Keyboard",
					Plugins: {
						Keyboard: {
							addListener: (
								event: string,
								cb: (info: { keyboardHeight?: number }) => void,
							) => {
								keyboardHandlers[event] = cb;
								return {
									remove: () => {
										removedHandles.push(event);
									},
								};
							},
						},
					},
				},
			},
		};

		const dispose = applyMobileSafeAreaCssVars({
			env,
			insetOverrides: { topPx: 59, bottomPx: 34 },
		});

		await Promise.resolve();
		expect(mockRoot.getAttribute("data-naia-platform")).toBe("ios-capacitor");
		expect(mockRoot.style.getPropertyValue("--naia-safe-area-top")).toBe(
			"59px",
		);
		expect(mockRoot.style.getPropertyValue("--naia-safe-area-bottom")).toBe(
			"34px",
		);
		expect(mockRoot.style.getPropertyValue("--naia-safe-area-left")).toBe(
			"env(safe-area-inset-left, 0px)",
		);
		expect(mockRoot.style.getPropertyValue("--naia-vh")).toBe("812px");
		expect(
			mockRoot.style.getPropertyValue("--naia-keyboard-inset-bottom"),
		).toBe("0px");

		// Simulate iOS native keyboard opening (336px)
		keyboardHandlers.keyboardWillShow?.({ keyboardHeight: 336 });
		expect(
			mockRoot.style.getPropertyValue("--naia-keyboard-inset-bottom"),
		).toBe("336px");

		// Simulate visualViewport shrinking alongside keyboard
		viewport.height = 476;
		vvResize.current?.();
		expect(mockRoot.style.getPropertyValue("--naia-vh")).toBe("476px");

		// Keyboard hides
		viewport.height = 812;
		keyboardHandlers.keyboardWillHide?.({});
		expect(
			mockRoot.style.getPropertyValue("--naia-keyboard-inset-bottom"),
		).toBe("0px");

		dispose();
		expect(viewport.removeEventListener).toHaveBeenCalled();
		expect(removedHandles).toEqual(["keyboardWillShow", "keyboardWillHide"]);
	});

	it("subscribes to cold-start getLaunchUrl and warm appUrlOpen Capacitor deep links", async () => {
		const openedUrls: string[] = [];
		const urlOpen = {
			current: null as ((ev: { url?: string }) => void) | null,
		};
		const removeSpy = vi.fn();

		const env: PlatformProbeEnv = {
			window: {
				Capacitor: {
					getPlatform: () => "ios",
					isNativePlatform: () => true,
					Plugins: {
						App: {
							getLaunchUrl: async () => ({
								url: "naia://onboarding?from=radio",
							}),
							addListener: (
								eventName: string,
								cb: (ev: { url?: string }) => void,
							) => {
								if (eventName === "appUrlOpen") urlOpen.current = cb;
								return { remove: removeSpy };
							},
						},
					},
				},
			},
		};

		const unsubscribe = subscribeMobileDeepLinks(
			(url) => openedUrls.push(url),
			env,
		);
		await Promise.resolve();
		await Promise.resolve();

		expect(openedUrls).toEqual(["naia://onboarding?from=radio"]);
		urlOpen.current?.({ url: "https://www.naia.land/s/live?room=1" });
		expect(openedUrls).toEqual([
			"naia://onboarding?from=radio",
			"https://www.naia.land/s/live?room=1",
		]);

		unsubscribe();
		urlOpen.current?.({ url: "naia://ignored-after-dispose" });
		expect(openedUrls).toHaveLength(2);
		expect(removeSpy).toHaveBeenCalledTimes(1);
	});
});
