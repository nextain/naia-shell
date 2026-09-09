import { type Locale, setLocale } from "./i18n";

/**
 * Host protocol used by the installed Slides entry.
 *
 * The installed app is an unprivileged asset iframe.  It may ask the Shell to
 * perform the two fixed recording operations, but it never supplies a path,
 * command, credential, or other native argument.  Environment messages carry
 * only the small allow-list below so a deck can update its presentation in
 * place when the Shell changes language or theme.
 */
export const SLIDES_HOST = "naia-slides:host";
export const SLIDES_HOST_ENVIRONMENT_EVENT = "naia-slides:environment";
/**
 * The current desktop asset origin.  Frame validation uses the exact URL
 * returned by `convertFileSrc` instead of this constant so Linux's
 * `asset://localhost` form remains valid without accepting arbitrary origins.
 */
export const SLIDES_ASSET_ORIGIN = "http://asset.localhost";

export const SLIDES_HOST_ACTIONS = {
	hello: "hello",
	init: "init",
	sync: "sync",
	recordingStart: "recording-start",
	recordingStop: "recording-stop",
	recordingCancelStart: "recording-cancel-start",
	recordingResult: "recording-result",
} as const;

/** Only these custom properties can cross the installed-app boundary. */
export const SLIDES_THEME_TOKENS = [
	"--bg-primary",
	"--bg-secondary",
	"--text-primary",
	"--text-secondary",
	"--border-color",
	"--accent-color",
	"--font-family",
	"--font-mono",
] as const;

export type SlidesThemeToken = (typeof SLIDES_THEME_TOKENS)[number];
export type SlidesThemeTokens = Partial<Record<SlidesThemeToken, string>>;

export interface SlidesHostState {
	locale: Locale;
	theme: SlidesThemeTokens;
}

export interface SlidesHostClientHandle {
	readonly ready: Promise<void>;
	request(
		action:
			| typeof SLIDES_HOST_ACTIONS.recordingStart
			| typeof SLIDES_HOST_ACTIONS.recordingStop,
	): Promise<unknown>;
	dispose(): void;
}

const SUPPORTED_LOCALES = new Set<Locale>([
	"ko",
	"en",
	"ja",
	"zh",
	"fr",
	"de",
	"ru",
	"es",
	"ar",
	"hi",
	"bn",
	"pt",
	"id",
	"vi",
]);
const MAX_MESSAGE_ID_LENGTH = 128;
const CLIENT_HANDSHAKE_ATTEMPTS = 8;
const CLIENT_HANDSHAKE_INTERVAL_MS = 250;
const CLIENT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_CAPABILITY_LENGTH = 128;

let installedClient: SlidesHostClientHandle | null = null;
let localRecordingState: "idle" | "starting" | "active" | "stopping" = "idle";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function validMessageId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_MESSAGE_ID_LENGTH
	);
}

function validCapability(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_CAPABILITY_LENGTH
	);
}

function validLocale(value: unknown): value is Locale {
	return typeof value === "string" && SUPPORTED_LOCALES.has(value as Locale);
}

function isSafeThemeValue(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 256) return false;
	// Values are data for a known custom property.  Reject CSS injection and
	// resource loads while allowing colors, rgb(), and font-family lists.
	if (/[;{}<>`\\\r\n]/u.test(trimmed)) return false;
	if (/(?:url|expression|javascript|import)\s*\(/iu.test(trimmed)) return false;
	return /^[\w\s#(),.%'"/+\-:]+$/u.test(trimmed);
}

/** Drop unknown properties and unsafe CSS values from a host payload. */
export function sanitizeSlidesThemeTokens(value: unknown): SlidesThemeTokens {
	if (!isRecord(value)) return {};
	const output: SlidesThemeTokens = {};
	for (const token of SLIDES_THEME_TOKENS) {
		const candidate = value[token];
		if (typeof candidate === "string" && isSafeThemeValue(candidate)) {
			output[token] = candidate.trim();
		}
	}
	return output;
}

/** Read only the allow-listed values from the Shell document root. */
export function readSlidesThemeTokens(
	documentRef: Document = document,
): SlidesThemeTokens {
	const root = documentRef.documentElement;
	const computed = documentRef.defaultView?.getComputedStyle(root);
	const values: Record<string, unknown> = {};
	for (const token of SLIDES_THEME_TOKENS) {
		const computedValue = computed?.getPropertyValue(token).trim() ?? "";
		const inlineValue = root.style.getPropertyValue(token).trim();
		const value = computedValue || inlineValue;
		if (value) values[token] = value;
	}
	return sanitizeSlidesThemeTokens(values);
}

/**
 * Installed entries are filesystem paths, never remote URLs.  Keep the
 * package basename exact so a similarly named app cannot receive host powers.
 */
export function isTrustedSlidesEntry(htmlEntry: string): boolean {
	if (typeof htmlEntry !== "string" || !htmlEntry || htmlEntry.includes("://"))
		return false;
	const normalized = htmlEntry.replaceAll("\\", "/");
	if (normalized.includes("/../") || normalized.endsWith("/..")) return false;
	return /(?:^|\/)land\.naia\.slides\/index\.html$/iu.test(normalized);
}

interface TauriAssetInternals {
	convertFileSrc?: (path: string) => unknown;
}

function convertedSlidesFrameSrc(htmlEntry: string): string | null {
	if (typeof window === "undefined") return null;
	const internals = (
		window as Window & { __TAURI_INTERNALS__?: TauriAssetInternals }
	).__TAURI_INTERNALS__;
	if (typeof internals?.convertFileSrc !== "function") return null;
	try {
		const source = internals.convertFileSrc(htmlEntry);
		return typeof source === "string" && source ? source : null;
	} catch {
		return null;
	}
}

function isLegacyAssetFrame(
	frame: HTMLIFrameElement,
	htmlEntry: string,
): boolean {
	try {
		const url = new URL(frame.src);
		const isAssetOrigin =
			url.origin === SLIDES_ASSET_ORIGIN ||
			(url.protocol === "asset:" && url.hostname === "localhost");
		if (!isAssetOrigin || url.search || url.hash) return false;
		const pathname = decodeURIComponent(url.pathname).replaceAll("\\", "/");
		const normalizedEntry = htmlEntry.replaceAll("\\", "/");
		const expectedPath = normalizedEntry.startsWith("/")
			? normalizedEntry
			: `/${normalizedEntry}`;
		return pathname === expectedPath;
	} catch {
		return false;
	}
}

/** Validate both the declared entry and the live asset-protocol frame. */
export function isTrustedSlidesFrame(
	frame: HTMLIFrameElement,
	htmlEntry: string,
	expectedFrameSrc?: string,
): boolean {
	if (!isTrustedSlidesEntry(htmlEntry)) return false;
	const convertedSource = convertedSlidesFrameSrc(htmlEntry);
	if (expectedFrameSrc) {
		// GenericInstalledApp supplies this exact value from convertFileSrc. If
		// Tauri is available, verify the caller did not substitute another URL.
		if (convertedSource && convertedSource !== expectedFrameSrc) return false;
		return frame.src === expectedFrameSrc;
	}
	if (convertedSource) return frame.src === convertedSource;
	// Keep the picker bridge's unit-test seam strict without accepting arbitrary
	// localhost URLs when no Tauri converter is present.
	return isLegacyAssetFrame(frame, htmlEntry);
}

export function isNativeSlidesHost(): boolean {
	return (
		typeof window !== "undefined" &&
		window.parent === window &&
		"__TAURI_INTERNALS__" in window
	);
}

function randomId(): string {
	if (
		typeof crypto !== "undefined" &&
		typeof crypto.randomUUID === "function"
	) {
		return crypto.randomUUID();
	}
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function immediateClientHandle(): SlidesHostClientHandle {
	return {
		ready: Promise.resolve(),
		request: async () => {
			throw new Error("slides_host_unavailable");
		},
		dispose() {},
	};
}

function installClientBridge(): SlidesHostClientHandle {
	if (
		typeof window === "undefined" ||
		window.parent === window ||
		!window.parent
	) {
		return immediateClientHandle();
	}

	const parentWindow = window.parent;
	const helloId = randomId();
	let parentOrigin: string | null = null;
	let capability: string | null = null;
	let disposed = false;
	let handshakeAttempts = 0;
	let handshakeTimer: number | undefined;
	let resolveReady!: () => void;
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});
	const pending = new Map<
		string,
		{
			resolve: (value: unknown) => void;
			reject: (reason?: unknown) => void;
			timer: number;
		}
	>();
	let localeQueue = Promise.resolve();
	let appliedThemeTokens = new Set<SlidesThemeToken>();

	const postToParent = (message: Record<string, unknown>) => {
		if (disposed) return;
		parentWindow.postMessage(message, parentOrigin ?? "*");
	};

	const finishHandshake = () => {
		if (handshakeTimer !== undefined) {
			window.clearInterval(handshakeTimer);
			handshakeTimer = undefined;
		}
		resolveReady();
	};

	const applyEnvironment = (data: Record<string, unknown>): Promise<void> => {
		const nextLocale = validLocale(data.locale) ? data.locale : null;
		const theme = sanitizeSlidesThemeTokens(data.theme);
		for (const token of appliedThemeTokens) {
			if (!(token in theme))
				document.documentElement.style.removeProperty(token);
		}
		for (const [token, value] of Object.entries(theme) as [
			SlidesThemeToken,
			string,
		][]) {
			document.documentElement.style.setProperty(token, value);
		}
		appliedThemeTokens = new Set(Object.keys(theme) as SlidesThemeToken[]);
		localeQueue = localeQueue
			.then(async () => {
				if (nextLocale) await setLocale(nextLocale);
				if (disposed) return;
				window.dispatchEvent(
					new CustomEvent(SLIDES_HOST_ENVIRONMENT_EVENT, {
						detail: { locale: nextLocale, theme },
					}),
				);
			})
			.catch(() => {
				// A locale chunk failure must not stop later host updates.
			});
		return localeQueue;
	};

	const listener = (event: MessageEvent) => {
		if (disposed || event.source !== parentWindow) return;
		if (!isRecord(event.data) || event.data.type !== SLIDES_HOST) return;
		const data = event.data;
		const action = typeof data.action === "string" ? data.action : "";
		if (parentOrigin === null) {
			if (
				action !== SLIDES_HOST_ACTIONS.init ||
				data.id !== helloId ||
				!validCapability(data.capability)
			)
				return;
			parentOrigin = event.origin;
			capability = data.capability;
		} else if (event.origin !== parentOrigin) {
			return;
		}

		if (
			action === SLIDES_HOST_ACTIONS.init &&
			(!validCapability(data.capability) || data.capability !== capability)
		)
			return;
		if (
			action === SLIDES_HOST_ACTIONS.init ||
			action === SLIDES_HOST_ACTIONS.sync
		) {
			if (action === SLIDES_HOST_ACTIONS.init && data.id !== helloId) return;
			const environment = applyEnvironment(data);
			if (action === SLIDES_HOST_ACTIONS.init) {
				void environment.then(finishHandshake, finishHandshake);
			}
			return;
		}
		if (
			action !== SLIDES_HOST_ACTIONS.recordingResult ||
			!validMessageId(data.id)
		)
			return;
		const entry = pending.get(data.id);
		if (!entry) return;
		pending.delete(data.id);
		window.clearTimeout(entry.timer);
		if (data.ok === true) entry.resolve(data.result);
		else
			entry.reject(
				new Error(
					typeof data.error === "string" ? data.error : "recording_failed",
				),
			);
	};
	window.addEventListener("message", listener);

	const sendHello = () => {
		if (disposed) return;
		if (++handshakeAttempts > CLIENT_HANDSHAKE_ATTEMPTS) {
			finishHandshake();
			return;
		}
		postToParent({
			type: SLIDES_HOST,
			action: SLIDES_HOST_ACTIONS.hello,
			id: helloId,
		});
	};
	handshakeTimer = window.setInterval(sendHello, CLIENT_HANDSHAKE_INTERVAL_MS);
	sendHello();

	const handle: SlidesHostClientHandle = {
		ready,
		request(action) {
			return new Promise((resolve, reject) => {
				if (disposed) {
					reject(new Error("slides_host_disposed"));
					return;
				}
				void ready.then(() => {
					if (disposed || parentOrigin === null || capability === null) {
						reject(new Error("slides_host_unavailable"));
						return;
					}
					const id = randomId();
					const timer = window.setTimeout(() => {
						pending.delete(id);
						if (action === SLIDES_HOST_ACTIONS.recordingStart) {
							postToParent({
								type: SLIDES_HOST,
								action: SLIDES_HOST_ACTIONS.recordingCancelStart,
								id,
								capability,
							});
						}
						reject(new Error("slides_host_timeout"));
					}, CLIENT_REQUEST_TIMEOUT_MS);
					pending.set(id, { resolve, reject, timer });
					postToParent({ type: SLIDES_HOST, action, id, capability });
				});
			});
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			finishHandshake();
			window.removeEventListener("message", listener);
			for (const entry of pending.values()) {
				window.clearTimeout(entry.timer);
				entry.reject(new Error("slides_host_disposed"));
			}
			pending.clear();
			if (installedClient === handle) installedClient = null;
		},
	};
	return handle;
}

/** Start the installed-app side of the environment/recording protocol. */
export function startSlidesHostClientBridge(): SlidesHostClientHandle {
	if (!installedClient) installedClient = installClientBridge();
	return installedClient;
}

/** Alias matching the Shell's other `install*Bridge` helpers. */
export const installSlidesHostClientBridge = startSlidesHostClientBridge;

async function nativeStartSlidesRecording(): Promise<void> {
	const module = await import("./app-sandbox");
	await module.startSlidesRecording();
}

async function nativeStopSlidesRecording(): Promise<string> {
	const module = await import("./app-sandbox");
	return module.stopSlidesRecording();
}

/** Start one fixed host recording operation, with a single-flight client guard. */
export async function startSlidesRecording(): Promise<void> {
	if (localRecordingState !== "idle")
		throw new Error("recording_already_active");
	localRecordingState = "starting";
	try {
		if (isNativeSlidesHost()) await nativeStartSlidesRecording();
		else
			await startSlidesHostClientBridge().request(
				SLIDES_HOST_ACTIONS.recordingStart,
			);
		localRecordingState = "active";
	} catch (error) {
		localRecordingState = "idle";
		throw error;
	}
}

/** Stop the active host recording and return its host-generated output path. */
export async function stopSlidesRecording(): Promise<string> {
	if (localRecordingState !== "active") throw new Error("recording_not_active");
	localRecordingState = "stopping";
	try {
		const output = isNativeSlidesHost()
			? await nativeStopSlidesRecording()
			: await startSlidesHostClientBridge().request(
					SLIDES_HOST_ACTIONS.recordingStop,
				);
		localRecordingState = "idle";
		return typeof output === "string" ? output : "";
	} catch (error) {
		// A failed stop leaves the host recording owned and retryable. Keep the
		// client in the same state so a second stop can complete it safely.
		localRecordingState = "active";
		throw error;
	}
}
