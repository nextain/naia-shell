import { getLocale } from "../../lib/i18n";
import { Logger } from "../../lib/logger";

export const INSTALLED_APP_ASK_EVENT = "naia:installed-app:ask";
export const INSTALLED_APP_RESPONSE_EVENT = "naia:installed-app:response";
export const INSTALLED_APP_ASK_ABORT_EVENT = "naia:installed-app:ask-abort";
export const INSTALLED_APP_SPEAK_EVENT = "naia:installed-app:speak";
export const INSTALLED_APP_CANCEL_EVENT = "naia:installed-app:cancel";
export const INSTALLED_APP_SPEECH_RESULT_EVENT =
	"naia:installed-app:speech-result";
const CHILD_ASK = "naia-app:ask";
const CHILD_REPLY = "naia-app:response";
const CHILD_LOCALE = "naia-app:locale";
const MAX_PROMPT_LENGTH = 9_000;

function validRequestId(value: unknown): value is string {
	return typeof value === "string" && /^[\w-]{1,100}$/.test(value);
}

/** Permission-scoped iframe to Shell requests. */
export function installInstalledAppHostBridge(
	frame: HTMLIFrameElement,
	frameSrc: string,
	appId: string,
	permissions: readonly string[],
): () => void {
	const target = frame.contentWindow;
	if (!target) return () => {};
	let origin: string;
	try {
		origin = new URL(frameSrc).origin;
	} catch {
		return () => {};
	}
	Logger.debug("InstalledAppHostBridge", "install", { appId, permissions });
	const pendingReplies = new Map<string, ReturnType<typeof setTimeout>>();
	const pendingSpeech = new Map<string, ReturnType<typeof setTimeout>>();
	const send = (message: object) => target.postMessage(message, origin);
	const settle = (pending: Map<string, ReturnType<typeof setTimeout>>, id: string) => {
		const timer = pending.get(id);
		if (!timer) return false;
		clearTimeout(timer);
		pending.delete(id);
		return true;
	};

	const postLocale = () =>
		permissions.includes("locale") && send({ type: CHILD_LOCALE, locale: getLocale() });
	const onLoad = () => postLocale();
	const onMessage = (event: MessageEvent) => {
		if (
			event.source !== target ||
			event.origin !== origin
		)
			return;
		const message = event.data;
		if (!message || typeof message !== "object") return;
		if (
			message.type === "naia-app:speak" ||
			message.type === "naia-app:speak-cancel"
		) {
			if (
				message.appId !== appId ||
				!validRequestId(message.id)
			)
				return;
			if (!permissions.includes("speech")) {
				send({ type: "naia-app:speech-result", id: message.id, status: "failed", error: "permission_denied" });
				return;
			}
			if (message.type === "naia-app:speak-cancel") {
				if (pendingSpeech.has(message.id))
					window.dispatchEvent(
						new CustomEvent(INSTALLED_APP_CANCEL_EVENT, {
							detail: { appId, requestId: message.id },
						}),
					);
				return;
			}
			if (pendingSpeech.has(message.id)) {
				send({ type: "naia-app:speech-result", id: message.id, status: "failed", error: "duplicate_id" });
				return;
			}
			if (
				typeof message.text !== "string" ||
				!message.text.trim() ||
				message.text.length > 2000
			) {
				send({ type: "naia-app:speech-result", id: message.id, status: "failed", error: "invalid_text" });
				return;
			}
			pendingSpeech.set(message.id, setTimeout(() => {
				if (!settle(pendingSpeech, message.id)) return;
				window.dispatchEvent(new CustomEvent(INSTALLED_APP_CANCEL_EVENT, { detail: { appId, requestId: message.id } }));
				send({ type: "naia-app:speech-result", id: message.id, status: "failed", error: "timeout" });
			}, 120_000));
			window.dispatchEvent(
				new CustomEvent(INSTALLED_APP_SPEAK_EVENT, {
					detail: {
						requestId: message.id,
						generation: 0,
						page: 1,
						appId,
						text: message.text,
					},
				}),
			);
			return;
		}
		if (message.type !== CHILD_ASK) return;
		if (message.appId !== appId || !validRequestId(message.id))
			return;
		if (!permissions.includes("model.ask")) {
			send({ type: CHILD_REPLY, id: message.id, text: "", error: "permission_denied" });
			return;
		}
		if (pendingReplies.has(message.id)) {
			send({ type: CHILD_REPLY, id: message.id, text: "", error: "duplicate_id" });
			return;
		}
		if (
			typeof message.prompt !== "string" ||
			message.prompt.trim().length === 0 ||
			message.prompt.length > MAX_PROMPT_LENGTH
		) {
			send({ type: CHILD_REPLY, id: message.id, text: "", error: "invalid_prompt" });
			return;
		}
		pendingReplies.set(message.id, setTimeout(() => {
			if (settle(pendingReplies, message.id)) {
				send({ type: CHILD_REPLY, id: message.id, text: "", error: "timeout" });
				window.dispatchEvent(new CustomEvent(INSTALLED_APP_ASK_ABORT_EVENT, { detail: { appId, requestId: message.id } }));
			}
		}, 120_000));
		target.postMessage(
			{ type: "naia-app:accepted", id: message.id },
			origin,
		);
		window.dispatchEvent(
			new CustomEvent(INSTALLED_APP_ASK_EVENT, {
				detail: { appId, requestId: message.id, prompt: message.prompt },
			}),
		);
	};
	const onShellLocale = () => postLocale();
	const onReply = (event: Event) => {
		const detail = (
			event as CustomEvent<{
				appId?: string;
				requestId?: string;
				text?: string;
				error?: string;
			}>
		).detail;
		if (
			!detail ||
			detail.appId !== appId ||
			!validRequestId(detail.requestId) ||
			!pendingReplies.has(detail.requestId)
		)
			return;
		settle(pendingReplies, detail.requestId);
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

	const onSpeechResult = (event: Event) => {
		const detail = (
			event as CustomEvent<{ appId?: string; requestId?: string; status?: string; error?: string }>
		).detail;
		if (
			!detail ||
			detail.appId !== appId ||
			!validRequestId(detail.requestId) ||
			!settle(pendingSpeech, detail.requestId)
		)
			return;
		target.postMessage(
			{
				type: "naia-app:speech-result",
				id: detail.requestId,
				status: detail.status,
				error: detail.error,
			},
			origin,
		);
	};
	frame.addEventListener("load", onLoad);
	window.addEventListener("message", onMessage);
	window.addEventListener("naia:locale-change", onShellLocale);
	window.addEventListener("naia-config-changed", onShellLocale);
	window.addEventListener(INSTALLED_APP_RESPONSE_EVENT, onReply);
	window.addEventListener(INSTALLED_APP_SPEECH_RESULT_EVENT, onSpeechResult);
	postLocale();
	return () => {
		frame.removeEventListener("load", onLoad);
		window.removeEventListener("message", onMessage);
		window.removeEventListener("naia:locale-change", onShellLocale);
		window.removeEventListener("naia-config-changed", onShellLocale);
		window.removeEventListener(INSTALLED_APP_RESPONSE_EVENT, onReply);
		window.removeEventListener(
			INSTALLED_APP_SPEECH_RESULT_EVENT,
			onSpeechResult,
		);
		for (const requestId of pendingSpeech.keys())
			window.dispatchEvent(
				new CustomEvent(INSTALLED_APP_CANCEL_EVENT, { detail: { appId, requestId } }),
			);
		for (const timer of pendingSpeech.values()) clearTimeout(timer);
		for (const [requestId, timer] of pendingReplies) {
			clearTimeout(timer);
			window.dispatchEvent(new CustomEvent(INSTALLED_APP_ASK_ABORT_EVENT, { detail: { appId, requestId } }));
		}
		pendingSpeech.clear();
		pendingReplies.clear();
	};
}
