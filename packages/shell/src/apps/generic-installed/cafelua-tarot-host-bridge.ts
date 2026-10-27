import { getLocale } from "../../lib/i18n";
import { useAppStore } from "../../stores/app";

export const CAFE_LUA_TAROT_APP_ID = "land.naia.cafelua-tarot";
export const CAFE_LUA_TAROT_ASK_EVENT = "naia:cafelua-tarot:ask";
export const CAFE_LUA_TAROT_RESPONSE_EVENT = "naia:cafelua-tarot:response";
const CHILD_ASK = "naia-cafelua-tarot:ask";
const CHILD_REPLY = "naia-cafelua-tarot:response";
const CHILD_LOCALE = "naia-app:locale";
const MAX_PROMPT_LENGTH = 9_000;

function validRequestId(value: unknown): value is string {
	return typeof value === "string" && /^[\w-]{1,100}$/.test(value);
}

/** Narrow iframe→Shell event path for Tarot's card interpretation requests. */
export function installCafeLuaTarotHostBridge(
	frame: HTMLIFrameElement,
	frameSrc: string,
): () => void {
	const target = frame.contentWindow;
	if (!target) return () => {};
	let origin: string;
	try {
		origin = new URL(frameSrc).origin;
	} catch {
		return () => {};
	}
	const pendingReplies = new Set<string>();

	const postLocale = () =>
		target.postMessage({ type: CHILD_LOCALE, locale: getLocale() }, origin);
	const onLoad = () => postLocale();
	const onMessage = (event: MessageEvent) => {
		if (
			event.source !== target ||
			event.origin !== origin ||
			useAppStore.getState().activeApp !== CAFE_LUA_TAROT_APP_ID
		)
			return;
		const message = event.data;
		if (!message || typeof message !== "object" || message.type !== CHILD_ASK)
			return;
		if (message.appId !== CAFE_LUA_TAROT_APP_ID || !validRequestId(message.id))
			return;
		if (
			typeof message.prompt !== "string" ||
			message.prompt.trim().length === 0 ||
			message.prompt.length > MAX_PROMPT_LENGTH
		)
			return;
		pendingReplies.add(message.id);
		window.dispatchEvent(
			new CustomEvent(CAFE_LUA_TAROT_ASK_EVENT, {
				detail: { requestId: message.id, prompt: message.prompt },
			}),
		);
	};
	const onShellLocale = () => postLocale();
	const onReply = (event: Event) => {
		const detail = (
			event as CustomEvent<{
				requestId?: string;
				text?: string;
				error?: string;
			}>
		).detail;
		if (
			!detail ||
			!validRequestId(detail.requestId) ||
			!pendingReplies.has(detail.requestId)
		)
			return;
		pendingReplies.delete(detail.requestId);
		target.postMessage(
			{
				type: CHILD_REPLY,
				id: detail.requestId,
				text: (detail.text ?? "").slice(0, 30_000),
				error: detail.error,
			},
			origin,
		);
	};

	frame.addEventListener("load", onLoad);
	window.addEventListener("message", onMessage);
	window.addEventListener("naia:locale-change", onShellLocale);
	window.addEventListener("naia-config-changed", onShellLocale);
	window.addEventListener(CAFE_LUA_TAROT_RESPONSE_EVENT, onReply);
	postLocale();
	return () => {
		frame.removeEventListener("load", onLoad);
		window.removeEventListener("message", onMessage);
		window.removeEventListener("naia:locale-change", onShellLocale);
		window.removeEventListener("naia-config-changed", onShellLocale);
		window.removeEventListener(CAFE_LUA_TAROT_RESPONSE_EVENT, onReply);
		pendingReplies.clear();
	};
}
