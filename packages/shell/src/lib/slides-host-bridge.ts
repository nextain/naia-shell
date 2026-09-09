import { getLocale } from "./i18n";
import { Logger } from "./logger";
import {
	SLIDES_HOST,
	SLIDES_HOST_ACTIONS,
	type SlidesHostState,
	isTrustedSlidesFrame,
	readSlidesThemeTokens,
	startSlidesRecording,
	stopSlidesRecording,
} from "./slides-host";

type RecordingStart = () => Promise<void>;
type RecordingStop = () => Promise<string>;

const ORPHAN_RETRY_LIMIT = 3;
const ORPHAN_RETRY_DELAY_MS = 250;

interface OrphanedRecording {
	stop: RecordingStop;
	retries: number;
	inFlight: Promise<boolean> | null;
	timer: ReturnType<typeof setTimeout> | null;
}

let orphanedRecording: OrphanedRecording | null = null;

function scheduleOrphanRetry(recording: OrphanedRecording): void {
	if (recording.timer || recording.retries >= ORPHAN_RETRY_LIMIT) return;
	recording.timer = setTimeout(() => {
		recording.timer = null;
		void attemptOrphanedStop(recording);
	}, ORPHAN_RETRY_DELAY_MS);
}

function attemptOrphanedStop(recording: OrphanedRecording): Promise<boolean> {
	if (recording.inFlight) return recording.inFlight;
	const operation = Promise.resolve()
		.then(() => recording.stop())
		.then(
			() => {
				if (recording.timer) {
					clearTimeout(recording.timer);
					recording.timer = null;
				}
				if (orphanedRecording === recording) orphanedRecording = null;
				return true;
			},
			(error) => {
				recording.retries += 1;
				Logger.warn(
					"SlidesHostBridge",
					"Orphaned Slides recording stop failed",
					{
						error: String(error),
						retries: recording.retries,
					},
				);
				if (recording.retries < ORPHAN_RETRY_LIMIT) {
					scheduleOrphanRetry(recording);
				} else {
					Logger.warn(
						"SlidesHostBridge",
						"Orphaned Slides recording cleanup exhausted retries",
					);
				}
				return false;
			},
		);
	const promise = operation.finally(() => {
		recording.inFlight = null;
	});
	recording.inFlight = promise;
	return promise;
}

function retainOrphanedRecording(stop: RecordingStop): void {
	if (!orphanedRecording) {
		orphanedRecording = { stop, retries: 0, inFlight: null, timer: null };
	}
	scheduleOrphanRetry(orphanedRecording);
}

export interface SlidesHostBridgeOptions {
	/** Exact URL produced by convertFileSrc(htmlEntry) for this iframe. */
	expectedFrameSrc?: string;
	/** Test seam; production uses the fixed Shell host wrappers. */
	startRecording?: RecordingStart;
	/** Test seam; production uses the fixed Shell host wrappers. */
	stopRecording?: RecordingStop;
	/** Test seam; production reads the Shell's live i18n state. */
	getState?: () => SlidesHostState;
}

const MAX_MESSAGE_ID_LENGTH = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isMessageId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_MESSAGE_ID_LENGTH
	);
}

function isCapability(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function newCapability(): string {
	if (
		typeof crypto !== "undefined" &&
		typeof crypto.randomUUID === "function"
	) {
		return crypto.randomUUID();
	}
	return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random()
		.toString(36)
		.slice(2)}`;
}

function makeState(): SlidesHostState {
	return { locale: getLocale(), theme: readSlidesThemeTokens() };
}

function stateChanged(left: SlidesHostState, right: SlidesHostState): boolean {
	if (left.locale !== right.locale) return true;
	const keys = new Set([
		...Object.keys(left.theme),
		...Object.keys(right.theme),
	]);
	for (const key of keys) {
		if (
			left.theme[key as keyof typeof left.theme] !==
			right.theme[key as keyof typeof right.theme]
		)
			return true;
	}
	return false;
}

/**
 * Install the privileged side of the Slides host protocol.
 *
 * The declared path and the exact URL emitted by `convertFileSrc` are both
 * checked.
 * Every request is then bound to the exact `contentWindow` and origin captured
 * at installation.  The recording payload intentionally contains no user
 * supplied values; the native host chooses the fixed app sandbox destination.
 */
export function installSlidesHostBridge(
	frame: HTMLIFrameElement,
	htmlEntry: string,
	options: SlidesHostBridgeOptions = {},
): () => void {
	const expectedFrameSrc = options.expectedFrameSrc;
	if (!isTrustedSlidesFrame(frame, htmlEntry, expectedFrameSrc))
		return () => {};
	// Keep one normalized URL binding for every later message and reply check.
	// GenericInstalledApp passes convertFileSrc(htmlEntry) explicitly; the
	// helper's strict converter/fallback validation makes the current frame safe
	// when callers use the optional test seam.
	const boundFrameSrc = expectedFrameSrc ?? frame.src;
	const target = frame.contentWindow;
	if (!target) return () => {};
	let origin: string;
	let replyOrigin: string;
	try {
		origin = new URL(frame.src).origin;
		replyOrigin = origin === "null" ? "*" : origin;
	} catch {
		return () => {};
	}

	let active = true;
	let frameLoaded = false;
	let handshakeHelloId: string | null = null;
	let handshakeCapability: string | null = null;
	let lastState = options.getState?.() ?? makeState();
	let recordingOwner: Window | null = null;
	let recordingStartPending = false;
	let recordingActive = false;
	let recordingStopPending = false;
	let startPromise: Promise<void> | null = null;
	let stopPromise: Promise<string> | null = null;
	let cleanupPromise: Promise<void> | null = null;
	let recordingStartRequestId: string | null = null;
	let recordingCancelRequested = false;
	let orphanStopPending = false;
	let observer: MutationObserver | null = null;
	let revokeBridge: () => void = () => {};
	const startRecording = options.startRecording ?? startSlidesRecording;
	const stopRecording = options.stopRecording ?? stopSlidesRecording;

	const cleanupOwnedRecording = (): Promise<void> => {
		if (cleanupPromise) return cleanupPromise;
		cleanupPromise = (async () => {
			if (recordingOwner !== target) return;
			// A settled start promise must not be replayed here: disposal can
			// race a successful stop, and reviving `recordingActive` would cause a
			// second native stop. Only await a start that is still pending.
			if (recordingStartPending && startPromise) {
				const pendingStart = startPromise;
				try {
					await pendingStart;
				} catch {
					return;
				}
				// The start completion handler normally sets this before the await
				// resumes. Keep the invariant explicit for a late completion.
				if (recordingStartPending) recordingStartPending = false;
				if (!recordingActive) recordingActive = true;
			}
			if (!recordingActive) return;
			if (stopPromise) {
				try {
					await stopPromise;
				} catch {
					// The normal stop handler retains ownership for a retry. A
					// disposed bridge cannot retry, so leave the state intact.
				}
				return;
			}
			recordingStopPending = true;
			stopPromise = Promise.resolve().then(() => stopRecording());
			try {
				await stopPromise;
				recordingStopPending = false;
				recordingActive = false;
				recordingOwner = null;
				recordingStartRequestId = null;
				recordingCancelRequested = false;
			} catch (error) {
				recordingStopPending = false;
				retainOrphanedRecording(stopRecording);
				Logger.warn(
					"SlidesHostBridge",
					"Failed to stop recording during iframe disposal",
					{
						error: String(error),
					},
				);
			}
		})();
		return cleanupPromise;
	};

	const canReply = () =>
		active &&
		frame.contentWindow === target &&
		frame.src === boundFrameSrc &&
		(() => {
			try {
				return new URL(frame.src).origin === origin;
			} catch {
				return false;
			}
		})();
	const reply = (message: Record<string, unknown>) => {
		if (canReply())
			target.postMessage({ type: SLIDES_HOST, ...message }, replyOrigin);
	};
	const sendState = (
		action: typeof SLIDES_HOST_ACTIONS.init | typeof SLIDES_HOST_ACTIONS.sync,
		id?: string,
	) => {
		lastState = options.getState?.() ?? makeState();
		reply({
			action,
			...(id ? { id } : {}),
			...(action === SLIDES_HOST_ACTIONS.init && handshakeCapability
				? { capability: handshakeCapability }
				: {}),
			locale: lastState.locale,
			theme: lastState.theme,
		});
	};
	const errorReply = (id: string, error: string) =>
		reply({
			action: SLIDES_HOST_ACTIONS.recordingResult,
			id,
			ok: false,
			error,
		});

	const onMessage = (event: MessageEvent) => {
		if (
			!active ||
			!frameLoaded ||
			frame.src !== boundFrameSrc ||
			event.source !== target ||
			event.origin !== origin ||
			!isRecord(event.data)
		)
			return;
		const data = event.data;
		if (data.type !== SLIDES_HOST || !isMessageId(data.id)) return;
		const requestId = data.id;
		const action = typeof data.action === "string" ? data.action : "";
		if (action === SLIDES_HOST_ACTIONS.hello) {
			if (handshakeCapability === null) {
				handshakeHelloId = requestId;
				handshakeCapability = newCapability();
				sendState(SLIDES_HOST_ACTIONS.init, requestId);
				return;
			}
			if (requestId !== handshakeHelloId) {
				revokeBridge();
				return;
			}
			sendState(SLIDES_HOST_ACTIONS.init, requestId);
			return;
		}
		if (
			handshakeCapability === null ||
			!isCapability(data.capability) ||
			data.capability !== handshakeCapability
		)
			return;
		if (action === SLIDES_HOST_ACTIONS.recordingCancelStart) {
			if (
				recordingStartRequestId !== requestId ||
				(!recordingStartPending && !recordingActive)
			)
				return;
			recordingCancelRequested = true;
			if (recordingActive && !recordingStopPending)
				void cleanupOwnedRecording();
			return;
		}
		if (action === SLIDES_HOST_ACTIONS.recordingStart) {
			if (
				recordingStartPending ||
				recordingActive ||
				recordingStopPending ||
				orphanedRecording
			) {
				errorReply(requestId, "recording_already_active");
				return;
			}
			recordingStartPending = true;
			recordingOwner = target;
			recordingStartRequestId = requestId;
			recordingCancelRequested = false;
			startPromise = Promise.resolve().then(() => startRecording());
			void startPromise
				.then(() => {
					startPromise = null;
					recordingStartPending = false;
					recordingActive = true;
					if (!active || recordingCancelRequested) {
						void cleanupOwnedRecording();
						return;
					}
					reply({
						action: SLIDES_HOST_ACTIONS.recordingResult,
						id: requestId,
						ok: true,
					});
				})
				.catch((error) => {
					startPromise = null;
					recordingStartPending = false;
					recordingOwner = null;
					recordingStartRequestId = null;
					recordingCancelRequested = false;
					if (!active) {
						Logger.warn(
							"SlidesHostBridge",
							"Slides recording start failed after iframe disposal",
							{
								error: String(error),
							},
						);
						return;
					}
					errorReply(requestId, "recording_failed");
				});
			return;
		}
		if (action !== SLIDES_HOST_ACTIONS.recordingStop) return;
		if (recordingStartPending || recordingStopPending) {
			errorReply(requestId, "recording_busy");
			return;
		}
		if (!recordingActive || recordingOwner !== target) {
			if (
				!recordingActive &&
				!recordingStartPending &&
				orphanedRecording &&
				!orphanStopPending
			) {
				const orphan = orphanedRecording;
				orphanStopPending = true;
				void attemptOrphanedStop(orphan).then((ok) => {
					orphanStopPending = false;
					if (!active) return;
					if (ok) {
						reply({
							action: SLIDES_HOST_ACTIONS.recordingResult,
							id: requestId,
							ok: true,
						});
					} else {
						errorReply(requestId, "recording_failed");
					}
				});
				return;
			}
			errorReply(requestId, "recording_not_active");
			return;
		}
		recordingStopPending = true;
		stopPromise = Promise.resolve().then(() => stopRecording());
		void stopPromise
			.then(() => {
				stopPromise = null;
				recordingStopPending = false;
				recordingActive = false;
				recordingOwner = null;
				recordingStartRequestId = null;
				recordingCancelRequested = false;
				if (!active) return;
				reply({
					action: SLIDES_HOST_ACTIONS.recordingResult,
					id: requestId,
					ok: true,
				});
			})
			.catch((error) => {
				stopPromise = null;
				recordingStopPending = false;
				// Keep active ownership after a failed stop so the same trusted
				// frame can retry without opening a second recording.
				if (!active) {
					retainOrphanedRecording(stopRecording);
					Logger.warn(
						"SlidesHostBridge",
						"Slides recording stop failed after iframe disposal",
						{
							error: String(error),
						},
					);
					return;
				}
				errorReply(requestId, "recording_failed");
			});
	};

	const syncEnvironment = () => {
		const next = options.getState?.() ?? makeState();
		if (!stateChanged(lastState, next)) return;
		lastState = next;
		if (handshakeCapability === null) return;
		reply({
			action: SLIDES_HOST_ACTIONS.sync,
			locale: next.locale,
			theme: next.theme,
		});
	};

	observer =
		typeof MutationObserver === "function"
			? new MutationObserver(syncEnvironment)
			: null;
	observer?.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["data-theme", "style"],
	});
	revokeBridge = () => {
		if (!active) return;
		active = false;
		window.removeEventListener("message", onMessage);
		window.removeEventListener("naia:locale-change", syncEnvironment);
		window.removeEventListener("naia-config-changed", syncEnvironment);
		frame.removeEventListener("load", onFrameLoad);
		observer?.disconnect();
		// Removing the iframe while a recording is in flight must not leave the
		// host sandbox running. The cleanup path waits for a late start and then
		// performs one best-effort stop; a failed stop retains ownership in the
		// closure for retry semantics and diagnostics.
		void cleanupOwnedRecording();
	};
	const onFrameLoad = () => {
		if (!frameLoaded) {
			frameLoaded = true;
			return;
		}
		// A load after the first document is a navigation. The WindowProxy and
		// frame.src can remain unchanged, so revoke the old capability explicitly.
		revokeBridge();
	};
	window.addEventListener("message", onMessage);
	window.addEventListener("naia:locale-change", syncEnvironment);
	window.addEventListener("naia-config-changed", syncEnvironment);
	frame.addEventListener("load", onFrameLoad);

	return revokeBridge;
}

/** Alias matching the existing speech bridge naming. */
export const startSlidesHostBridge = installSlidesHostBridge;
