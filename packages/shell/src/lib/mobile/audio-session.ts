/**
 * Mobile WebView audio session manager:
 *  1. First-touch user-gesture `AudioContext` + iOS `AVAudioSession` silent-buffer unlocker
 *  2. Background / foreground transition audio & avatar lip-sync resynchronization hook
 *  3. Native Capacitor + WebView microphone permission preflight & request interface
 */

import {
	type CapacitorPluginListenerHandle,
	type CapacitorPluginObject,
	type PlatformProbeEnv,
	getCapacitorPlugin,
	isCapacitorNativeApp,
} from "./platform";

export type AudioContextStateLike =
	| "suspended"
	| "running"
	| "closed"
	| "interrupted";

export interface AudioBufferSourceNodeLike {
	buffer: unknown;
	connect: (destination: unknown) => void;
	disconnect?: () => void;
	start: (when?: number) => void;
}

export interface AudioContextLike {
	readonly state: AudioContextStateLike | string;
	readonly currentTime: number;
	readonly destination?: unknown;
	resume: () => Promise<void>;
	suspend?: () => Promise<void>;
	createBuffer?: (
		numberOfChannels: number,
		length: number,
		sampleRate: number,
	) => unknown;
	createBufferSource?: () => AudioBufferSourceNodeLike;
	addEventListener?: (type: string, listener: () => void) => void;
	removeEventListener?: (type: string, listener: () => void) => void;
}

export interface GestureEventTargetLike {
	addEventListener: (
		type: string,
		listener: () => void,
		options?: boolean | AddEventListenerOptions,
	) => void;
	removeEventListener: (
		type: string,
		listener: () => void,
		options?: boolean | EventListenerOptions,
	) => void;
}

export interface UnlockMobileAudioOptions {
	/** Lazily retrieve or create the shared `AudioContext`. */
	getAudioContext?: () => AudioContextLike | null;
	/** DOM target on which one-shot user gesture listeners are attached (defaults to `document`). */
	target?: GestureEventTargetLike | null;
	/** Gesture event types used to unlock mobile WebView audio. */
	gestureEvents?: readonly string[];
	/** Invoked once the `AudioContext` transitions to `"running"`. */
	onUnlocked?: (ctx: AudioContextLike) => void;
}

export interface MobileAudioUnlockController {
	isUnlocked: () => boolean;
	unlockNow: () => Promise<boolean>;
	dispose: () => void;
}

const DEFAULT_GESTURE_EVENTS = [
	"pointerdown",
	"touchend",
	"keydown",
	"click",
] as const;

function resolveDefaultAudioContext(): AudioContextLike | null {
	if (typeof globalThis === "undefined") return null;
	const g = globalThis as unknown as {
		AudioContext?: new () => AudioContextLike;
		webkitAudioContext?: new () => AudioContextLike;
	};
	const Ctor = g.AudioContext ?? g.webkitAudioContext;
	if (typeof Ctor !== "function") return null;
	return new Ctor();
}

function playSilentWarmupBuffer(ctx: AudioContextLike): void {
	if (
		typeof ctx.createBuffer !== "function" ||
		typeof ctx.createBufferSource !== "function" ||
		ctx.destination === undefined
	) {
		return;
	}
	try {
		const buffer = ctx.createBuffer(1, 1, 22050);
		const source = ctx.createBufferSource();
		source.buffer = buffer;
		source.connect(ctx.destination);
		source.start(0);
	} catch {
		/* Ignore warmup errors on minimal stubs */
	}
}

/**
 * Unlock a suspended/interrupted mobile WebView `AudioContext` on the first
 * trusted user gesture (`pointerdown` / `touchend` / `keydown` / `click`),
 * playing a 1-sample silent buffer to activate iOS `WKWebView` hardware output.
 */
export function unlockMobileAudioOnGesture(
	options: UnlockMobileAudioOptions = {},
): MobileAudioUnlockController {
	const events = options.gestureEvents ?? DEFAULT_GESTURE_EVENTS;
	const target: GestureEventTargetLike | null =
		options.target !== undefined
			? options.target
			: typeof globalThis.document !== "undefined"
				? globalThis.document
				: null;

	let cachedCtx: AudioContextLike | null = null;
	let unlocked = false;
	let disposed = false;
	let inFlight: Promise<boolean> | null = null;

	const getCtx = (): AudioContextLike | null => {
		if (options.getAudioContext) {
			return options.getAudioContext();
		}
		if (!cachedCtx) {
			cachedCtx = resolveDefaultAudioContext();
		}
		return cachedCtx;
	};

	const detachListeners = () => {
		if (!target) return;
		for (const ev of events) {
			target.removeEventListener(ev, onGesture, true);
		}
	};

	const unlockNow = async (): Promise<boolean> => {
		if (unlocked) return true;
		if (disposed) return false;
		if (inFlight) return await inFlight;

		inFlight = (async () => {
			try {
				const ctx = getCtx();
				if (!ctx) return false;
				if (ctx.state === "closed") return false;

				if (ctx.state !== "running") {
					await ctx.resume();
				}
				playSilentWarmupBuffer(ctx);

				if (ctx.state === "running") {
					unlocked = true;
					detachListeners();
					options.onUnlocked?.(ctx);
					return true;
				}
				return false;
			} catch {
				return false;
			} finally {
				inFlight = null;
			}
		})();

		return await inFlight;
	};

	function onGesture(): void {
		void unlockNow();
	}

	if (target) {
		for (const ev of events) {
			target.addEventListener(ev, onGesture, { capture: true, passive: true });
		}
	}

	return {
		isUnlocked: () => unlocked,
		unlockNow,
		dispose: () => {
			disposed = true;
			detachListeners();
		},
	};
}

export interface ForegroundResyncPayload {
	audioTimeSeconds: number;
	wasInterrupted: boolean;
}

export interface MobileAudioLifecycleSyncOptions {
	getAudioContext: () => AudioContextLike | null;
	/** Optional sentence audio playback clock (`() => seconds`) for exact lip-sync re-anchoring. */
	audioClock?: () => number;
	/** Keep `AudioContext` active in background (e.g. Naia Radio / background voice call mode). */
	keepAudioInBackground?: boolean;
	/** Pause GPU-heavy WebGL2/VRM visual lip-sync rendering while backgrounded (`gpusKillClient` guard). */
	onVisualLipSyncPause?: () => void;
	/** Invoked when audio is suspended on background entry (`keepAudioInBackground === false`). */
	onBackgroundSuspend?: () => void;
	/** Invoked upon foreground return after `AudioContext` resumes to resync avatar lip-sync. */
	onForegroundResync?: (payload: ForegroundResyncPayload) => void;
	env?: PlatformProbeEnv;
}

interface CapacitorAppStatePlugin extends CapacitorPluginObject {
	addListener?: (
		eventName: string,
		cb: (state: { isActive: boolean }) => void,
	) => Promise<CapacitorPluginListenerHandle> | CapacitorPluginListenerHandle;
}

/**
 * Bind mobile app background/foreground transitions and iOS `AudioContext`
 * `"interrupted"` events to cleanly pause background GPU rendering and
 * resynchronize audio + avatar lip-sync clocks on foreground return.
 */
export function bindMobileAudioLifecycleSync(
	options: MobileAudioLifecycleSyncOptions,
): () => void {
	const doc =
		options.env && "document" in options.env
			? (options.env.document ?? null)
			: typeof globalThis.document !== "undefined"
				? globalThis.document
				: null;
	const win =
		options.env && "window" in options.env
			? (options.env.window ?? null)
			: typeof globalThis.window !== "undefined"
				? globalThis.window
				: null;

	let disposed = false;
	let isBackgrounded = false;
	let sawInterruption = false;

	const handleBackground = () => {
		if (disposed || isBackgrounded) return;
		isBackgrounded = true;
		options.onVisualLipSyncPause?.();

		if (!options.keepAudioInBackground) {
			const ctx = options.getAudioContext();
			if (ctx && ctx.state === "running" && typeof ctx.suspend === "function") {
				ctx.suspend().catch(() => undefined);
			}
			options.onBackgroundSuspend?.();
		}
	};

	const handleForeground = async () => {
		if (disposed) return;
		const wasBg = isBackgrounded;
		isBackgrounded = false;

		const ctx = options.getAudioContext();
		const wasInterrupted =
			sawInterruption ||
			ctx?.state === "interrupted" ||
			ctx?.state === "suspended";
		sawInterruption = false;

		if (ctx && (ctx.state === "suspended" || ctx.state === "interrupted")) {
			try {
				await ctx.resume();
			} catch {
				/* User gesture may still be required if OS hard-locked session */
			}
		}

		if (wasBg || wasInterrupted) {
			const rawTime = options.audioClock
				? options.audioClock()
				: (ctx?.currentTime ?? 0);
			const audioTimeSeconds =
				Number.isFinite(rawTime) && rawTime >= 0 ? rawTime : 0;
			options.onForegroundResync?.({
				audioTimeSeconds,
				wasInterrupted,
			});
		}
	};

	const onVisibilityChange = () => {
		if (!doc) return;
		if (doc.visibilityState === "hidden") {
			handleBackground();
		} else if (doc.visibilityState === "visible") {
			void handleForeground();
		}
	};

	const onPageShow = () => {
		if (isBackgrounded || sawInterruption) {
			void handleForeground();
		}
	};

	const ctx = options.getAudioContext();
	const onCtxStateChange = () => {
		const current = options.getAudioContext();
		if (current?.state === "interrupted") {
			sawInterruption = true;
			options.onVisualLipSyncPause?.();
		} else if (
			current?.state === "running" &&
			sawInterruption &&
			!isBackgrounded
		) {
			void handleForeground();
		}
	};

	doc?.addEventListener?.("visibilitychange", onVisibilityChange);
	win?.addEventListener?.("pageshow", onPageShow);
	ctx?.addEventListener?.("statechange", onCtxStateChange);

	let capHandle: CapacitorPluginListenerHandle | null = null;
	const appPlugin = getCapacitorPlugin<CapacitorAppStatePlugin>(
		"App",
		options.env,
	);
	if (appPlugin && typeof appPlugin.addListener === "function") {
		Promise.resolve(
			appPlugin.addListener("appStateChange", (state) => {
				if (disposed) return;
				if (state.isActive) {
					void handleForeground();
				} else {
					handleBackground();
				}
			}),
		)
			.then((h) => {
				if (disposed) h?.remove?.();
				else capHandle = h;
			})
			.catch(() => undefined);
	}

	return () => {
		disposed = true;
		doc?.removeEventListener?.("visibilitychange", onVisibilityChange);
		win?.removeEventListener?.("pageshow", onPageShow);
		ctx?.removeEventListener?.("statechange", onCtxStateChange);
		try {
			capHandle?.remove?.();
		} catch {
			/* noop */
		}
	};
}

export type MicrophonePermissionState =
	| "granted"
	| "denied"
	| "prompt"
	| "unsupported";

export type MicrophonePermissionSource =
	| "capacitor-native"
	| "permissions-api"
	| "media-devices"
	| "unavailable";

export interface MicrophonePermissionResult {
	state: MicrophonePermissionState;
	source: MicrophonePermissionSource;
	canOpenAppSettings: boolean;
	reason?: string;
}

interface CapacitorMicPlugin extends CapacitorPluginObject {
	checkPermissions?: () => Promise<{
		microphone?: string;
		recordAudio?: string;
	}>;
	requestPermissions?: () => Promise<{
		microphone?: string;
		recordAudio?: string;
	}>;
	hasAudioRecordingPermission?: () => Promise<{ value?: boolean }>;
	requestAudioRecordingPermission?: () => Promise<{ value?: boolean }>;
}

export interface MicrophoneProbeEnv extends PlatformProbeEnv {
	permissions?: {
		query?: (desc: { name: string }) => Promise<{ state?: string }>;
	} | null;
	mediaDevices?: {
		getUserMedia?: (constraints: {
			audio: boolean;
		}) => Promise<{ getTracks?: () => Array<{ stop?: () => void }> }>;
	} | null;
}

function normalizePermString(raw?: string): MicrophonePermissionState | null {
	if (!raw) return null;
	const lower = raw.toLowerCase();
	if (lower === "granted") return "granted";
	if (lower === "denied") return "denied";
	if (
		lower === "prompt" ||
		lower === "prompt-with-rationale" ||
		lower === "undetermined"
	) {
		return "prompt";
	}
	return null;
}

function resolveNativeMicPlugin(
	env?: MicrophoneProbeEnv,
): CapacitorMicPlugin | null {
	return (
		getCapacitorPlugin<CapacitorMicPlugin>("Microphone", env) ??
		getCapacitorPlugin<CapacitorMicPlugin>("VoiceRecorder", env)
	);
}

/**
 * Non-intrusive preflight check for microphone permission across Capacitor
 * native iOS/Android shells and WebView `navigator.permissions`.
 */
export async function checkMobileMicrophonePermission(
	env?: MicrophoneProbeEnv,
): Promise<MicrophonePermissionResult> {
	const canOpenAppSettings = isCapacitorNativeApp(env);
	const nativePlugin = resolveNativeMicPlugin(env);

	if (nativePlugin) {
		if (typeof nativePlugin.checkPermissions === "function") {
			try {
				const res = await nativePlugin.checkPermissions();
				const mapped = normalizePermString(res.microphone ?? res.recordAudio);
				if (mapped) {
					return {
						state: mapped,
						source: "capacitor-native",
						canOpenAppSettings,
					};
				}
			} catch {
				/* Fall through to Permissions API */
			}
		}
		if (typeof nativePlugin.hasAudioRecordingPermission === "function") {
			try {
				const res = await nativePlugin.hasAudioRecordingPermission();
				return {
					state: res?.value ? "granted" : "prompt",
					source: "capacitor-native",
					canOpenAppSettings,
				};
			} catch {
				/* Fall through */
			}
		}
	}

	const perms =
		env && "permissions" in env
			? env.permissions
			: (
					globalThis.navigator as unknown as {
						permissions?: MicrophoneProbeEnv["permissions"];
					}
				)?.permissions;

	if (perms && typeof perms.query === "function") {
		try {
			const status = await perms.query({ name: "microphone" });
			const mapped = normalizePermString(status?.state);
			if (mapped) {
				return {
					state: mapped,
					source: "permissions-api",
					canOpenAppSettings,
				};
			}
		} catch {
			/* Safari/WKWebView may reject microphone query when not yet requested */
		}
	}

	const mediaDevices =
		env && "mediaDevices" in env
			? env.mediaDevices
			: globalThis.navigator?.mediaDevices;
	if (mediaDevices && typeof mediaDevices.getUserMedia === "function") {
		return {
			state: "prompt",
			source: "media-devices",
			canOpenAppSettings,
		};
	}

	return {
		state: "unsupported",
		source: "unavailable",
		canOpenAppSettings: false,
		reason: "microphone_api_unavailable",
	};
}

/**
 * Request microphone access via Capacitor native plugin or `getUserMedia`,
 * immediately stopping probe tracks so the OS mic indicator is released cleanly.
 */
export async function requestMobileMicrophonePermission(
	env?: MicrophoneProbeEnv,
): Promise<MicrophonePermissionResult> {
	const canOpenAppSettings = isCapacitorNativeApp(env);
	const nativePlugin = resolveNativeMicPlugin(env);

	if (nativePlugin) {
		if (typeof nativePlugin.requestPermissions === "function") {
			try {
				const res = await nativePlugin.requestPermissions();
				const mapped = normalizePermString(res.microphone ?? res.recordAudio);
				if (mapped) {
					return {
						state: mapped,
						source: "capacitor-native",
						canOpenAppSettings,
					};
				}
			} catch (err) {
				return {
					state: "denied",
					source: "capacitor-native",
					canOpenAppSettings,
					reason: err instanceof Error ? err.message : String(err),
				};
			}
		}
		if (typeof nativePlugin.requestAudioRecordingPermission === "function") {
			try {
				const res = await nativePlugin.requestAudioRecordingPermission();
				return {
					state: res?.value ? "granted" : "denied",
					source: "capacitor-native",
					canOpenAppSettings,
				};
			} catch (err) {
				return {
					state: "denied",
					source: "capacitor-native",
					canOpenAppSettings,
					reason: err instanceof Error ? err.message : String(err),
				};
			}
		}
	}

	const mediaDevices =
		env && "mediaDevices" in env
			? env.mediaDevices
			: globalThis.navigator?.mediaDevices;
	if (!mediaDevices || typeof mediaDevices.getUserMedia !== "function") {
		return {
			state: "unsupported",
			source: "unavailable",
			canOpenAppSettings: false,
			reason: "microphone_api_unavailable",
		};
	}

	try {
		const stream = await mediaDevices.getUserMedia({ audio: true });
		for (const track of stream.getTracks?.() ?? []) {
			try {
				track.stop?.();
			} catch {
				/* noop */
			}
		}
		return {
			state: "granted",
			source: "media-devices",
			canOpenAppSettings,
		};
	} catch (err) {
		const name = (err as { name?: string })?.name ?? "";
		const isDenied =
			name === "NotAllowedError" || name === "PermissionDeniedError";
		return {
			state: isDenied ? "denied" : "unsupported",
			source: "media-devices",
			canOpenAppSettings,
			reason: err instanceof Error ? err.message : String(err),
		};
	}
}
