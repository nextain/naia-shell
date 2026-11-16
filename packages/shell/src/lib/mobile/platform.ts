/**
 * Mobile shell platform detection, iOS WKWebView NVA chroma-key video strategy,
 * Safe-Area / virtual-keyboard CSS variable injection, and Capacitor deep-link bridge.
 *
 * Pure TypeScript with zero mandatory external npm runtime dependencies —
 * interacts with Capacitor 7 via the standard `window.Capacitor` runtime bridge.
 */

export type MobileShellPlatform =
	| "ios-capacitor"
	| "android-capacitor"
	| "mobile-web"
	| "desktop-tauri"
	| "desktop-web";

export interface CapacitorPluginListenerHandle {
	remove: () => Promise<void> | void;
}

export type CapacitorPluginObject = Record<string, unknown>;

/** Runtime shape of `window.Capacitor` injected by Capacitor iOS / Android native bridge. */
export interface CapacitorGlobalLike {
	getPlatform?: () => string;
	isNativePlatform?: () => boolean;
	isPluginAvailable?: (pluginName: string) => boolean;
	Plugins?: Record<string, CapacitorPluginObject | undefined>;
}

export interface VisualViewportLike {
	readonly height: number;
	readonly width: number;
	readonly offsetTop?: number;
	addEventListener?: (type: string, listener: () => void) => void;
	removeEventListener?: (type: string, listener: () => void) => void;
}

export interface DocumentElementLike {
	setAttribute: (name: string, value: string) => void;
	getAttribute?: (name: string) => string | null;
	style: {
		setProperty: (property: string, value: string) => void;
		getPropertyValue?: (property: string) => string;
	};
}

export interface DocumentLike {
	readonly documentElement?: DocumentElementLike | null;
	readonly visibilityState?: string;
	addEventListener?: (type: string, listener: () => void) => void;
	removeEventListener?: (type: string, listener: () => void) => void;
}

export interface PlatformProbeEnv {
	window?: {
		Capacitor?: CapacitorGlobalLike;
		__TAURI_INTERNALS__?: unknown;
		__TAURI__?: unknown;
		innerHeight?: number;
		visualViewport?: VisualViewportLike | null;
		addEventListener?: (type: string, listener: () => void) => void;
		removeEventListener?: (type: string, listener: () => void) => void;
	} | null;
	navigator?: {
		userAgent?: string;
		platform?: string;
		maxTouchPoints?: number;
	} | null;
	document?: DocumentLike | null;
	createVideoElement?: () => { canPlayType?: (mime: string) => string } | null;
}

function defaultEnv(overrides?: PlatformProbeEnv): Required<PlatformProbeEnv> {
	return {
		window:
			overrides && "window" in overrides
				? (overrides.window ?? null)
				: typeof globalThis.window !== "undefined"
					? (globalThis.window as unknown as NonNullable<
							PlatformProbeEnv["window"]
						>)
					: null,
		navigator:
			overrides && "navigator" in overrides
				? (overrides.navigator ?? null)
				: typeof globalThis.navigator !== "undefined"
					? globalThis.navigator
					: null,
		document:
			overrides && "document" in overrides
				? (overrides.document ?? null)
				: typeof globalThis.document !== "undefined"
					? globalThis.document
					: null,
		createVideoElement:
			overrides?.createVideoElement ??
			(() => {
				if (typeof globalThis.document?.createElement === "function") {
					return globalThis.document.createElement("video");
				}
				return null;
			}),
	};
}

/** Retrieve `window.Capacitor` safely when running inside Capacitor. */
export function getCapacitorBridge(
	env?: PlatformProbeEnv,
): CapacitorGlobalLike | null {
	const resolved = defaultEnv(env);
	const cap = resolved.window?.Capacitor;
	if (!cap || typeof cap !== "object") return null;
	return cap;
}

/** Retrieve a named Capacitor plugin (`window.Capacitor.Plugins[name]`) if registered. */
export function getCapacitorPlugin<T extends CapacitorPluginObject>(
	pluginName: string,
	env?: PlatformProbeEnv,
): T | null {
	const cap = getCapacitorBridge(env);
	if (!cap) return null;
	if (
		typeof cap.isPluginAvailable === "function" &&
		!cap.isPluginAvailable(pluginName)
	) {
		return null;
	}
	const plugin = cap.Plugins?.[pluginName];
	if (!plugin || typeof plugin !== "object") return null;
	return plugin as T;
}

/**
 * Detect whether the current runtime is a native Capacitor mobile app
 * (`ios-capacitor` / `android-capacitor`), mobile web browser, Tauri desktop, or desktop web.
 */
export function detectMobileShellPlatform(
	env?: PlatformProbeEnv,
): MobileShellPlatform {
	const resolved = defaultEnv(env);
	const win = resolved.window;
	const nav = resolved.navigator;

	const cap = win?.Capacitor;
	if (cap && typeof cap === "object") {
		const rawPlatform =
			typeof cap.getPlatform === "function"
				? cap.getPlatform().toLowerCase()
				: "";
		const explicitNative =
			typeof cap.isNativePlatform === "function"
				? cap.isNativePlatform()
				: rawPlatform === "ios" || rawPlatform === "android";

		if (explicitNative || rawPlatform === "ios" || rawPlatform === "android") {
			if (rawPlatform === "ios") return "ios-capacitor";
			if (rawPlatform === "android") return "android-capacitor";
		}
	}

	if (
		win &&
		("__TAURI_INTERNALS__" in win || "__TAURI__" in win) &&
		(Boolean(win.__TAURI_INTERNALS__) || Boolean(win.__TAURI__))
	) {
		return "desktop-tauri";
	}

	const ua = nav?.userAgent ?? "";
	const navPlatform = nav?.platform ?? "";
	const touchPoints = nav?.maxTouchPoints ?? 0;

	// iPadOS 13+ desktop-mode Safari reports platform "MacIntel" with multi-touch (>1).
	const isIpadDesktopClass = navPlatform === "MacIntel" && touchPoints > 1;
	const isMobileUa =
		/iPhone|iPad|iPod|Android|Mobile|WebOS|BlackBerry|IEMobile|Opera Mini/i.test(
			ua,
		);

	if (isIpadDesktopClass || isMobileUa) {
		return "mobile-web";
	}

	return "desktop-web";
}

/** True when running inside a packaged Capacitor iOS or Android native shell. */
export function isCapacitorNativeApp(env?: PlatformProbeEnv): boolean {
	const p = detectMobileShellPlatform(env);
	return p === "ios-capacitor" || p === "android-capacitor";
}

/**
 * True on any Apple iOS / iPadOS WebKit runtime (`ios-capacitor`, Mobile Safari,
 * iOS Chrome `CriOS`, iOS Firefox `FxiOS`, and iPadOS desktop-class Safari).
 */
export function isIosWebKitRuntime(env?: PlatformProbeEnv): boolean {
	const platform = detectMobileShellPlatform(env);
	if (platform === "ios-capacitor") return true;
	if (platform === "android-capacitor" || platform === "desktop-tauri") {
		return false;
	}
	const resolved = defaultEnv(env);
	const ua = resolved.navigator?.userAgent ?? "";
	const navPlatform = resolved.navigator?.platform ?? "";
	const touchPoints = resolved.navigator?.maxTouchPoints ?? 0;

	if (/iPhone|iPad|iPod/i.test(ua)) return true;
	if (navPlatform === "MacIntel" && touchPoints > 1) return true;
	return false;
}

const WEBM_VP9_MIME = 'video/webm; codecs="vp9"';

/**
 * Probe whether transparent VP9 `.webm` video textures work reliably.
 * Note: Apple iOS `WKWebView` either blocks VP9 WebM or drops its alpha plane
 * during `<video>` decode, so iOS runtimes always return `false`.
 */
export function probeAlphaWebmSupport(env?: PlatformProbeEnv): boolean {
	if (isIosWebKitRuntime(env)) {
		return false;
	}
	const resolved = defaultEnv(env);
	try {
		const video = resolved.createVideoElement();
		const res = video?.canPlayType?.(WEBM_VP9_MIME) ?? "";
		return res === "probably" || res === "maybe";
	} catch {
		return false;
	}
}

export type NvaMobileVideoReason =
	| "ios-wkwebview-no-alpha-webm"
	| "webm-vp9-unsupported"
	| "native-alpha-webm-ok";

export interface NvaMobileVideoStrategy {
	platform: MobileShellPlatform;
	forceMp4ChromaKey: boolean;
	preferredContainer: "mp4-chromakey" | "webm-alpha";
	reason: NvaMobileVideoReason;
}

/**
 * Determine whether NVA video avatars MUST select H.264/HEVC `.mp4` green-screen
 * assets + `nva-chromakey-gl.ts` WebGL2 shader instead of VP9 alpha `.webm`.
 */
export function resolveNvaMobileVideoStrategy(
	env?: PlatformProbeEnv,
): NvaMobileVideoStrategy {
	const platform = detectMobileShellPlatform(env);
	if (isIosWebKitRuntime(env)) {
		return {
			platform,
			forceMp4ChromaKey: true,
			preferredContainer: "mp4-chromakey",
			reason: "ios-wkwebview-no-alpha-webm",
		};
	}
	if (!probeAlphaWebmSupport(env)) {
		return {
			platform,
			forceMp4ChromaKey: true,
			preferredContainer: "mp4-chromakey",
			reason: "webm-vp9-unsupported",
		};
	}
	return {
		platform,
		forceMp4ChromaKey: false,
		preferredContainer: "webm-alpha",
		reason: "native-alpha-webm-ok",
	};
}

/** Boolean helper returning `true` when H.264 MP4 chroma-key NVA must be forced. */
export function shouldForceMp4ChromaKeyNva(env?: PlatformProbeEnv): boolean {
	return resolveNvaMobileVideoStrategy(env).forceMp4ChromaKey;
}

export interface SafeAreaInsetOverrides {
	topPx?: number;
	rightPx?: number;
	bottomPx?: number;
	leftPx?: number;
}

export interface ApplySafeAreaOptions {
	env?: PlatformProbeEnv;
	insetOverrides?: SafeAreaInsetOverrides;
}

interface CapacitorKeyboardPlugin extends CapacitorPluginObject {
	addListener?: (
		eventName: string,
		cb: (info: { keyboardHeight?: number }) => void,
	) => Promise<CapacitorPluginListenerHandle> | CapacitorPluginListenerHandle;
}

function formatInsetCss(overridePx?: number, envName?: string): string {
	if (typeof overridePx === "number" && Number.isFinite(overridePx)) {
		return `${Math.max(0, Math.round(overridePx))}px`;
	}
	return `env(${envName}, 0px)`;
}

/**
 * Inject `--naia-safe-area-*`, `--naia-keyboard-inset-bottom`, `--naia-vh`,
 * and `data-naia-platform` onto `document.documentElement`, keeping keyboard
 * and dynamic viewport height synchronized across rotations and virtual keyboards.
 */
export function applyMobileSafeAreaCssVars(
	options: ApplySafeAreaOptions = {},
): () => void {
	const resolved = defaultEnv(options.env);
	const doc = resolved.document;
	const win = resolved.window;
	if (!doc?.documentElement) {
		return () => undefined;
	}

	const root = doc.documentElement;
	const platform = detectMobileShellPlatform(options.env);
	root.setAttribute("data-naia-platform", platform);

	const ov = options.insetOverrides;
	root.style.setProperty(
		"--naia-safe-area-top",
		formatInsetCss(ov?.topPx, "safe-area-inset-top"),
	);
	root.style.setProperty(
		"--naia-safe-area-right",
		formatInsetCss(ov?.rightPx, "safe-area-inset-right"),
	);
	root.style.setProperty(
		"--naia-safe-area-bottom",
		formatInsetCss(ov?.bottomPx, "safe-area-inset-bottom"),
	);
	root.style.setProperty(
		"--naia-safe-area-left",
		formatInsetCss(ov?.leftPx, "safe-area-inset-left"),
	);
	root.style.setProperty("--naia-keyboard-inset-bottom", "0px");

	let nativeKeyboardHeight = 0;

	const syncViewportVars = () => {
		const vv = win?.visualViewport;
		const innerH = win?.innerHeight ?? 0;
		if (vv && Number.isFinite(vv.height) && vv.height > 0) {
			root.style.setProperty("--naia-vh", `${Math.round(vv.height)}px`);
			const offsetTop = vv.offsetTop ?? 0;
			const inferredKeyboard = Math.max(
				0,
				Math.round(innerH - vv.height - offsetTop),
			);
			const effectiveKeyboard = Math.max(
				nativeKeyboardHeight,
				inferredKeyboard,
			);
			root.style.setProperty(
				"--naia-keyboard-inset-bottom",
				`${effectiveKeyboard}px`,
			);
		} else if (innerH > 0) {
			root.style.setProperty("--naia-vh", `${Math.round(innerH)}px`);
			root.style.setProperty(
				"--naia-keyboard-inset-bottom",
				`${nativeKeyboardHeight}px`,
			);
		} else {
			root.style.setProperty("--naia-vh", "100dvh");
		}
	};

	syncViewportVars();

	const vv = win?.visualViewport;
	vv?.addEventListener?.("resize", syncViewportVars);
	win?.addEventListener?.("resize", syncViewportVars);

	const handles: CapacitorPluginListenerHandle[] = [];
	let disposed = false;
	const keyboardPlugin = getCapacitorPlugin<CapacitorKeyboardPlugin>(
		"Keyboard",
		options.env,
	);
	if (keyboardPlugin && typeof keyboardPlugin.addListener === "function") {
		Promise.resolve(
			keyboardPlugin.addListener("keyboardWillShow", (info) => {
				if (disposed) return;
				nativeKeyboardHeight = Math.max(
					0,
					Math.round(info?.keyboardHeight ?? 0),
				);
				syncViewportVars();
			}),
		)
			.then((h) => {
				if (disposed) h?.remove?.();
				else if (h) handles.push(h);
			})
			.catch(() => undefined);

		Promise.resolve(
			keyboardPlugin.addListener("keyboardWillHide", () => {
				if (disposed) return;
				nativeKeyboardHeight = 0;
				syncViewportVars();
			}),
		)
			.then((h) => {
				if (disposed) h?.remove?.();
				else if (h) handles.push(h);
			})
			.catch(() => undefined);
	}

	return () => {
		disposed = true;
		vv?.removeEventListener?.("resize", syncViewportVars);
		win?.removeEventListener?.("resize", syncViewportVars);
		for (const h of handles) {
			try {
				h.remove();
			} catch {
				/* noop */
			}
		}
	};
}

interface CapacitorAppPlugin extends CapacitorPluginObject {
	addListener?: (
		eventName: string,
		cb: (event: { url?: string }) => void,
	) => Promise<CapacitorPluginListenerHandle> | CapacitorPluginListenerHandle;
	getLaunchUrl?: () => Promise<{ url?: string } | undefined>;
}

/**
 * Subscribe to `naia://` custom scheme & Universal/App Links on Capacitor mobile shells
 * (including cold-start launch URLs for deferred onboarding from Naia Radio).
 */
export function subscribeMobileDeepLinks(
	onOpenUrl: (url: string) => void,
	env?: PlatformProbeEnv,
): () => void {
	const appPlugin = getCapacitorPlugin<CapacitorAppPlugin>("App", env);
	if (!appPlugin) {
		return () => undefined;
	}

	let disposed = false;
	let handle: CapacitorPluginListenerHandle | null = null;

	if (typeof appPlugin.getLaunchUrl === "function") {
		appPlugin
			.getLaunchUrl()
			.then((res) => {
				if (!disposed && res?.url) {
					onOpenUrl(res.url);
				}
			})
			.catch(() => undefined);
	}

	if (typeof appPlugin.addListener === "function") {
		Promise.resolve(
			appPlugin.addListener("appUrlOpen", (ev) => {
				if (!disposed && ev?.url) {
					onOpenUrl(ev.url);
				}
			}),
		)
			.then((h) => {
				if (disposed) {
					h?.remove?.();
				} else {
					handle = h;
				}
			})
			.catch(() => undefined);
	}

	return () => {
		disposed = true;
		try {
			handle?.remove?.();
		} catch {
			/* noop */
		}
	};
}
