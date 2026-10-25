import type { AppContext } from "../../lib/app-registry";
import { Logger } from "../../lib/logger";
import { PERSISTENT_CONTEXT_TYPES, useAppStore } from "../../stores/app";

const APP_CONTEXT_MESSAGE = "naia-app:context";
export const APP_CONTEXT_CLEARED_MESSAGE = "naia-app:context-cleared";
const MAX_TYPE_LENGTH = 64;
const MAX_CONTEXT_JSON_CHARS = 32_000;
const TAG = "InstalledAppContextBridge";

function resolveFrameTargetOrigin(
	frame: HTMLIFrameElement,
	htmlEntry?: string | null,
): string {
	const candidates = [frame.src, frame.getAttribute("src"), htmlEntry];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			const origin = new URL(candidate, window.location.href).origin;
			if (origin && origin !== "null") {
				return origin;
			}
		} catch {
			// Try next candidate
		}
	}
	return "*";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

export function inferInstalledAppIdFromEntry(
	htmlEntry?: string | null,
): string | null {
	if (!htmlEntry) return null;
	const normalized = htmlEntry.replace(/\\/g, "/");
	const match = /\/apps\/([^/]+)\/[^/]+$/.exec(normalized);
	return match?.[1]?.trim() || null;
}

export function validateInstalledAppContext(
	rawContext: unknown,
): { ok: true; context: AppContext | null } | { ok: false; reason: string } {
	if (rawContext === null) {
		return { ok: true, context: null };
	}
	if (!isPlainObject(rawContext)) {
		return { ok: false, reason: "context must be a plain object or null" };
	}
	const type = rawContext.type;
	if (
		typeof type !== "string" ||
		type.length < 1 ||
		type.length > MAX_TYPE_LENGTH
	) {
		return { ok: false, reason: "context.type must be a 1..64 char string" };
	}
	if (PERSISTENT_CONTEXT_TYPES.has(type)) {
		return {
			ok: false,
			reason: `context.type "${type}" is reserved for persistent shell contexts`,
		};
	}
	const data = rawContext.data;
	if (!isPlainObject(data)) {
		return { ok: false, reason: "context.data must be a plain object" };
	}
	let serialized: string;
	try {
		serialized = JSON.stringify({ type, data });
	} catch {
		return { ok: false, reason: "context is not JSON-serializable" };
	}
	if (
		typeof serialized !== "string" ||
		serialized.length > MAX_CONTEXT_JSON_CHARS
	) {
		return {
			ok: false,
			reason: `context JSON length exceeds ${MAX_CONTEXT_JSON_CHARS} chars`,
		};
	}
	return { ok: true, context: { type, data } };
}

export function installInstalledAppContextBridge(
	frame: HTMLIFrameElement,
	appId?: string | null,
	htmlEntry?: string | null,
): () => void {
	const ownerAppId =
		appId?.trim() || inferInstalledAppIdFromEntry(htmlEntry) || null;
	let lastPushedType: string | null = null;
	let clearingLocally = false;

	const isOwnedByThisBridge = (): boolean => {
		const state = useAppStore.getState();
		if (!state.activeAppContext) return false;
		if (ownerAppId !== null && state.activeAppContextOwnerId !== null) {
			return state.activeAppContextOwnerId === ownerAppId;
		}
		return (
			lastPushedType !== null && state.activeAppContext.type === lastPushedType
		);
	};

	const clearOwnedContextLocally = () => {
		clearingLocally = true;
		try {
			lastPushedType = null;
			useAppStore.getState().setActiveAppContext(null);
		} finally {
			clearingLocally = false;
		}
	};

	const notifyFrameContextCleared = () => {
		const contentWindow = frame.contentWindow;
		if (!contentWindow) return;
		const targetOrigin = resolveFrameTargetOrigin(frame, htmlEntry);
		try {
			contentWindow.postMessage(
				{ type: APP_CONTEXT_CLEARED_MESSAGE },
				targetOrigin,
			);
		} catch {
			// Ignore if detached frame rejects postMessage
		}
	};

	const unsubscribeStore = useAppStore.subscribe((state, prevState) => {
		if (clearingLocally) return;
		const prevOwned =
			prevState.activeAppContext !== null &&
			((ownerAppId !== null &&
				prevState.activeAppContextOwnerId === ownerAppId) ||
				(lastPushedType !== null &&
					prevState.activeAppContext.type === lastPushedType));
		if (!prevOwned) return;

		const stillOwned =
			state.activeAppContext !== null &&
			state.activeApp === ownerAppId &&
			((ownerAppId !== null && state.activeAppContextOwnerId === ownerAppId) ||
				(lastPushedType !== null &&
					state.activeAppContext.type === lastPushedType));

		if (!stillOwned) {
			Logger.debug(TAG, "notifying installed app that shell cleared context", {
				appId: ownerAppId,
			});
			lastPushedType = null;
			notifyFrameContextCleared();
		}
	});

	const onMessage = (event: MessageEvent) => {
		const contentWindow = frame.contentWindow;
		if (!contentWindow || event.source !== contentWindow) return;
		const payload = event.data;
		if (
			typeof payload !== "object" ||
			payload === null ||
			payload.type !== APP_CONTEXT_MESSAGE
		) {
			return;
		}

		const currentActiveApp = useAppStore.getState().activeApp;
		if (!ownerAppId || currentActiveApp !== ownerAppId) {
			Logger.debug(TAG, "ignoring context from inactive installed app", {
				ownerAppId,
				activeApp: currentActiveApp,
			});
			return;
		}

		const check = validateInstalledAppContext(
			(payload as Record<string, unknown>).context,
		);
		if (!check.ok) {
			Logger.warn(TAG, "rejected installed app context", {
				appId: ownerAppId,
				reason: check.reason,
			});
			if (isOwnedByThisBridge()) {
				clearOwnedContextLocally();
			}
			return;
		}
		if (check.context === null) {
			Logger.debug(TAG, "clearing installed app context", {
				appId: ownerAppId,
			});
			if (isOwnedByThisBridge()) {
				clearOwnedContextLocally();
			} else {
				lastPushedType = null;
			}
			return;
		}
		Logger.debug(TAG, "applying installed app context", {
			appId: ownerAppId,
			type: check.context.type,
		});
		lastPushedType = check.context.type;
		useAppStore.getState().setActiveAppContext(check.context, ownerAppId);
	};

	window.addEventListener("message", onMessage);

	return () => {
		window.removeEventListener("message", onMessage);
		unsubscribeStore();
		if (isOwnedByThisBridge()) {
			Logger.debug(TAG, "clearing context on installed app unmount", {
				appId: ownerAppId,
				type: lastPushedType,
			});
			clearOwnedContextLocally();
		}
		lastPushedType = null;
	};
}
