import { invoke } from "@tauri-apps/api/core";
import { Logger } from "./logger";
import {
	SLIDES_FILES,
	SLIDES_IMPORT_PROGRESS,
	type SlidesImportProgress,
	type SlidesPdfPayload,
} from "./slides-files";
import { isTrustedSlidesFrame } from "./slides-host";

/** Scoped to the trusted installed Slides entry, exact frame and asset origin. */
export function isSlidesEntry(htmlEntry: string): boolean {
	return /(?:^|[\\/])land\.naia\.slides[\\/]index\.html$/i.test(htmlEntry);
}

function isValidRequestId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 160 &&
		/^[a-zA-Z0-9._:/-]+$/.test(value)
	);
}

function isValidCapability(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 160 &&
		/^[a-zA-Z0-9._:/-]+$/.test(value)
	);
}

function createCapability(): string {
	if (
		typeof crypto !== "undefined" &&
		typeof crypto.randomUUID === "function"
	) {
		return crypto.randomUUID();
	}
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cancelNativeOpen(requestId: string): void {
	try {
		void Promise.resolve(
			invoke("slides_cancel_open", { requestId }),
		).catch(() => {});
	} catch {
		// The browser fallback may not expose Tauri's invoke bridge.
	}
}

function isMessagePort(value: unknown): value is MessagePort {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as {
		postMessage?: unknown;
		addEventListener?: unknown;
		start?: unknown;
	};
	return (
		typeof candidate.postMessage === "function" &&
		typeof candidate.addEventListener === "function" &&
		typeof candidate.start === "function"
	);
}

export function installSlidesFilesBridge(
	frame: HTMLIFrameElement,
	htmlEntry: string,
): () => void {
	if (!isSlidesEntry(htmlEntry) || !isTrustedSlidesFrame(frame, htmlEntry))
		return () => {};
	let active = true;
	let hasLoaded = false;
	let documentReady = false;
	let documentGeneration = 0;
	let documentCapability: string | null = null;
	let probeId: string | null = null;
	let documentPort: MessagePort | null = null;
	let portListener: ((event: MessageEvent) => void) | null = null;
	let picking = false;
	let currentRequestId: string | null = null;
	let stopProgress: (() => void) | null = null;

	const closeDocumentPort = () => {
		const port = documentPort;
		const listener = portListener;
		documentPort = null;
		portListener = null;
		if (!port) return;
		if (listener) port.removeEventListener("message", listener);
		port.close();
	};
	const cancelCurrentRequest = () => {
		const requestId = currentRequestId;
		if (!requestId) return;
		currentRequestId = null;
		picking = false;
		stopProgress?.();
		stopProgress = null;
		cancelNativeOpen(requestId);
	};

	const onFrameLoad = () => {
		if (!active) return;
		if (hasLoaded) {
			// A second load means the trusted document was replaced or reloaded.
			// The WindowProxy is stable across navigation, so permanently revoke
			// this bridge instead of granting the replacement document a token.
			active = false;
			documentReady = false;
			documentGeneration += 1;
			documentCapability = null;
			probeId = null;
			cancelCurrentRequest();
			closeDocumentPort();
			frame.removeEventListener("load", onFrameLoad);
			window.removeEventListener("message", onWindowMessage);
			return;
		}
		hasLoaded = true;
		documentGeneration += 1;
		documentReady = isTrustedSlidesFrame(frame, htmlEntry);
		documentCapability = null;
		probeId = null;
	};

	const handleMessage = async (data: unknown, port: MessagePort) => {
		if (
			!active ||
			!documentReady ||
			documentPort !== port ||
			typeof data !== "object" ||
			data === null
		)
			return;
		const message = data as Record<string, unknown>;
		if (
			message.type !== SLIDES_FILES ||
			!isValidRequestId(message.id)
		)
			return;
		const requestGeneration = documentGeneration;
		const reply = (body: Record<string, unknown>) => {
			if (
				!active ||
				!documentReady ||
				requestGeneration !== documentGeneration ||
				documentPort !== port ||
				!isTrustedSlidesFrame(frame, htmlEntry)
			)
				return;
			const response = {
				type: SLIDES_FILES,
				id: message.id,
				...body,
				...(body.action === "available" && documentCapability
					? { capability: documentCapability }
					: {}),
			};
			try {
				port.postMessage(response);
			} catch {
				// Navigation can close the port between the guard and post.
			}
		};
		if (message.action === "probe") {
			if (!documentCapability) {
				documentCapability = createCapability();
				probeId = message.id;
			}
			if (probeId !== message.id) return;
			reply({ action: "available" });
			return;
		}
		if (
			!isValidCapability(message.capability) ||
			message.capability !== documentCapability
		)
			return;
		if (message.action === "cancel") {
			if (picking && currentRequestId === message.id) {
				cancelNativeOpen(message.id);
			}
			return;
		}
		if (message.action !== "open") return;
		if (picking) {
			reply({ action: "result", error: "picker_busy" });
			return;
		}
		picking = true;
		currentRequestId = message.id;
		try {
			Logger.debug("SlidesFilesBridge", "opening user-selected document");
			try {
				if (!("__TAURI_INTERNALS__" in window)) throw new Error("not_native");
				const { listen } = await import("@tauri-apps/api/event");
				const unlisten = await listen<SlidesImportProgress>(
					SLIDES_IMPORT_PROGRESS,
					(progress) => {
						if (progress.payload?.requestId === message.id)
							reply({ action: "progress", phase: progress.payload.phase });
					},
				);
				if (
					!active ||
					!documentReady ||
					documentGeneration !== requestGeneration ||
					currentRequestId !== message.id
				) {
					unlisten();
					return;
				}
				stopProgress = unlisten;
			} catch {
				stopProgress = null;
			}
			if (
				!active ||
				!documentReady ||
				documentGeneration !== requestGeneration ||
				currentRequestId !== message.id
			)
				return;
			const selection = await invoke<SlidesPdfPayload | null>(
				"slides_open_document",
				{ requestId: message.id },
			);
			reply({ action: "result", selection });
		} catch (error) {
			Logger.warn("SlidesFilesBridge", "document picker failed", {
				error: String(error),
			});
			reply({ action: "result", error: String(error) });
		} finally {
			if (
				documentGeneration === requestGeneration &&
				currentRequestId === message.id
			) {
				stopProgress?.();
				stopProgress = null;
				picking = false;
				currentRequestId = null;
			}
		}
	};

	const onWindowMessage = (event: MessageEvent) => {
		const target = frame.contentWindow;
		if (
			!active ||
			!documentReady ||
			documentPort ||
			!target ||
			event.source !== target ||
			!isTrustedSlidesFrame(frame, htmlEntry)
		)
			return;
		const origin = new URL(frame.src).origin;
		const data = event.data;
		if (
			event.origin !== origin ||
			data?.type !== SLIDES_FILES ||
			data.action !== "probe" ||
			!isValidRequestId(data.id) ||
			event.ports.length !== 1
		)
			return;
		const port = event.ports[0];
		if (!isMessagePort(port)) return;
		documentPort = port;
		portListener = (portEvent) => {
			void handleMessage(portEvent.data, port);
		};
		port.addEventListener("message", portListener);
		port.start();
		void handleMessage(data, port);
	};

	frame.addEventListener("load", onFrameLoad);
	window.addEventListener("message", onWindowMessage);
	return () => {
		active = false;
		documentReady = false;
		documentGeneration += 1;
		documentCapability = null;
		probeId = null;
		frame.removeEventListener("load", onFrameLoad);
		window.removeEventListener("message", onWindowMessage);
		cancelCurrentRequest();
		closeDocumentPort();
	};
}
