import { invoke } from "@tauri-apps/api/core";

export const SLIDES_FILES = "naia-slides:files";
export const SLIDES_IMPORT_PROGRESS = "naia-slides:import-progress";
export interface SlidesPdfPayload {
	pdfName: string;
	pdfBase64: string;
	scriptName: string | null;
	scriptText: string | null;
	scriptReadFailed: boolean;
}
export interface SlidesOpenedPdf {
	file: File;
	script: { name: string; text: string } | null;
	scriptReadFailed: boolean;
}
export interface SlidesImportProgress {
	requestId: string;
	phase: string;
}

let parentCapability: string | null = null;
let parentPort: MessagePort | null = null;
const nativeWindow = () =>
	window.parent === window && "__TAURI_INTERNALS__" in window;
const requestId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function isValidCapability(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 160 &&
		/^[a-zA-Z0-9._:/-]+$/.test(value)
	);
}

/** Capability negotiation keeps the existing browser input usable on old hosts. */
export function watchSlidesPickerAvailable(
	onAvailable: (available: boolean) => void,
): () => void {
	if (window.parent === window) {
		onAvailable(nativeWindow());
		return () => {};
	}
	if (typeof MessageChannel === "undefined") {
		onAvailable(false);
		return () => {};
	}
	const id = requestId();
	let attempts = 0;
	let stopped = false;
	const probePorts = new Set<MessagePort>();
	const handleAvailable = (port: MessagePort, event: MessageEvent) => {
		if (
			stopped ||
			event.data?.type !== SLIDES_FILES ||
			event.data.id !== id ||
			event.data.action !== "available" ||
			!isValidCapability(event.data.capability)
		)
			return;
		for (const candidate of probePorts) {
			if (candidate !== port) candidate.close();
		}
		probePorts.clear();
		parentCapability = event.data.capability;
		parentPort = port;
		onAvailable(true);
		clearInterval(timer);
	};
	const probe = () => {
		if (++attempts > 6) {
			clearInterval(timer);
			return;
		}
		const channel = new MessageChannel();
		const port = channel.port1;
		probePorts.add(port);
		port.addEventListener("message", (event) => handleAvailable(port, event));
		port.start();
		window.parent.postMessage(
			{ type: SLIDES_FILES, action: "probe", id },
			"*",
			[channel.port2],
		);
	};
	const timer = setInterval(probe, 500);
	const initialProbeTimer = setTimeout(probe, 0);
	return () => {
		stopped = true;
		clearTimeout(initialProbeTimer);
		clearInterval(timer);
		for (const port of probePorts) port.close();
		probePorts.clear();
		parentPort?.close();
		parentPort = null;
		parentCapability = null;
	};
}

export function decodeSlidesPdf(payload: SlidesPdfPayload): SlidesOpenedPdf {
	if (
		typeof payload.pdfName !== "string" ||
		typeof payload.pdfBase64 !== "string"
	)
		throw new Error("slides_invalid_selection");
	const bytes = Uint8Array.from(atob(payload.pdfBase64), (char) =>
		char.charCodeAt(0),
	);
	return {
		file: new File([bytes], payload.pdfName, { type: "application/pdf" }),
		script:
			typeof payload.scriptName === "string" &&
			typeof payload.scriptText === "string"
				? { name: payload.scriptName, text: payload.scriptText }
				: null,
		scriptReadFailed: payload.scriptReadFailed === true,
	};
}

/** Native selection accepts no pathname from the webview or installed app. */
export async function openSlidesPdf(
	signal?: AbortSignal,
): Promise<SlidesOpenedPdf | null> {
	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
	let payload: SlidesPdfPayload | null;
	if (nativeWindow()) {
		payload = await invoke<SlidesPdfPayload | null>("slides_open_pdf");
	} else {
		const capability = parentCapability;
		const port = parentPort;
		if (!capability || !port)
			throw new Error("slides_picker_unavailable");
		const id = requestId();
		payload = await new Promise<SlidesPdfPayload | null>((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				port.removeEventListener("message", listener);
				signal?.removeEventListener("abort", abort);
			};
			const abort = () => {
				port.postMessage({ type: SLIDES_FILES, action: "cancel", id, capability });
				cleanup();
				reject(new DOMException("Aborted", "AbortError"));
			};
			const listener = (event: MessageEvent) => {
				if (
					event.data?.type !== SLIDES_FILES ||
					event.data.id !== id ||
					event.data.action !== "result"
				)
					return;
				cleanup();
				if (event.data.error) reject(new Error("slides_picker_failed"));
				else resolve(event.data.selection ?? null);
			};
			const timer = setTimeout(() => {
				port.postMessage({ type: SLIDES_FILES, action: "cancel", id, capability });
				cleanup();
				reject(new Error("slides_picker_timeout"));
			}, 300_000);
			port.addEventListener("message", listener);
			port.start();
			signal?.addEventListener("abort", abort, { once: true });
			port.postMessage({ type: SLIDES_FILES, action: "open", id, capability });
		});
	}
	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
	return payload === null ? null : decodeSlidesPdf(payload);
}

async function listenForNativeProgress(
	request: string,
	onProgress?: (phase: string) => void,
): Promise<() => void> {
	if (!onProgress || !nativeWindow()) return () => {};
	try {
		const { listen } = await import("@tauri-apps/api/event");
		return await listen<SlidesImportProgress>(SLIDES_IMPORT_PROGRESS, (event) => {
			if (event.payload?.requestId === request)
				onProgress(event.payload.phase);
		});
	} catch {
		// Browser tests and older hosts do not expose the Tauri event bridge.
		return () => {};
	}
}

/**
 * Open a PDF or PPTX through the native document picker.  The browser path
 * intentionally remains PDF-only; a browser file input cannot convert PPTX.
 * `requestId` is generated here and is the only cancellation capability sent
 * to the host.
 */
export async function openSlidesDocument(
	signal?: AbortSignal,
	onProgress?: (phase: string) => void,
): Promise<SlidesOpenedPdf | null> {
	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
	const id = requestId();
	if (nativeWindow()) {
		const stopProgress = await listenForNativeProgress(id, onProgress);
		if (signal?.aborted) {
			stopProgress();
			throw new DOMException("Aborted", "AbortError");
		}
		let abortHandler: (() => void) | undefined;
		try {
			const operation = invoke<SlidesPdfPayload | null>("slides_open_document", {
				requestId: id,
			});
			const cancelled = new Promise<never>((_, reject) => {
				abortHandler = () => {
					void invoke("slides_cancel_open", { requestId: id }).catch(() => {});
					reject(new DOMException("Aborted", "AbortError"));
				};
				signal?.addEventListener("abort", abortHandler, { once: true });
			});
			const payload = await Promise.race([operation, cancelled]);
			if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
			return payload === null ? null : decodeSlidesPdf(payload);
		} finally {
			if (abortHandler) signal?.removeEventListener("abort", abortHandler);
			stopProgress();
		}
	}

	const capability = parentCapability;
	const port = parentPort;
	if (!capability || !port)
		throw new Error("slides_picker_unavailable");
	return await new Promise<SlidesOpenedPdf | null>((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			clearTimeout(timer);
			port.removeEventListener("message", listener);
			signal?.removeEventListener("abort", abort);
		};
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};
		const abort = () => {
			port.postMessage({ type: SLIDES_FILES, action: "cancel", id, capability });
			finish(() => reject(new DOMException("Aborted", "AbortError")));
		};
		const listener = (event: MessageEvent) => {
			if (
				event.data?.type !== SLIDES_FILES ||
				event.data.id !== id
			)
				return;
			if (event.data.action === "progress") {
				if (typeof event.data.phase === "string") onProgress?.(event.data.phase);
				return;
			}
			if (event.data.action !== "result") return;
			finish(() => {
				try {
					if (event.data.error) reject(new Error(String(event.data.error)));
					else
						resolve(
							event.data.selection == null
								? null
								: decodeSlidesPdf(event.data.selection),
						);
				} catch (error) {
					reject(error);
				}
			});
		};
		const timer = setTimeout(() => {
			port.postMessage({ type: SLIDES_FILES, action: "cancel", id, capability });
			finish(() => reject(new Error("slides_picker_timeout")));
		}, 300_000);
		port.addEventListener("message", listener);
		port.start();
		signal?.addEventListener("abort", abort, { once: true });
		port.postMessage({ type: SLIDES_FILES, action: "open", id, capability });
	});
}
