import type { AppContext } from "../../lib/app-registry";
import { Logger } from "../../lib/logger";
import { PERSISTENT_CONTEXT_TYPES, useAppStore } from "../../stores/app";

const APP_CONTEXT_MESSAGE = "naia-app:context";
const MAX_TYPE_LENGTH = 64;
const MAX_CONTEXT_JSON_CHARS = 32_000;
const TAG = "InstalledAppContextBridge";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
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
): () => void {
	let lastPushedType: string | null = null;

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
		const check = validateInstalledAppContext(
			(payload as Record<string, unknown>).context,
		);
		if (!check.ok) {
			Logger.warn(TAG, "rejected installed app context", {
				reason: check.reason,
			});
			return;
		}
		if (check.context === null) {
			Logger.debug(TAG, "clearing installed app context");
			lastPushedType = null;
			useAppStore.getState().setActiveAppContext(null);
			return;
		}
		Logger.debug(TAG, "applying installed app context", {
			type: check.context.type,
		});
		lastPushedType = check.context.type;
		useAppStore.getState().setActiveAppContext(check.context);
	};

	window.addEventListener("message", onMessage);

	return () => {
		window.removeEventListener("message", onMessage);
		if (lastPushedType !== null) {
			const current = useAppStore.getState().activeAppContext;
			if (current && current.type === lastPushedType) {
				Logger.debug(TAG, "clearing context on installed app unmount", {
					type: lastPushedType,
				});
				useAppStore.getState().setActiveAppContext(null);
			}
			lastPushedType = null;
		}
	};
}
