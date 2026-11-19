import { useEffect } from "react";
import { useAppStore } from "../stores/app";
import { useChatStore } from "../stores/chat";
import { isWebMode } from "./web-runtime/web-assets";

/**
 * R12 (web): "이 캐릭터로 대화 시작" in the character-card mini app pushes a
 * `charcard` context. The shell then opens the chat and starts a fresh
 * conversation that begins with the card's opening greeting, so the user does
 * not have to find the chat and type first.
 */

export const CHARCARD_APP_ID = "land.naia.charcard";

const GREETING_MARKER =
	"[Opening Greeting — You have already started the conversation with this message]\n";
/** Sections the prompt builder may place after the greeting (prompt-builder.ts). */
const GREETING_END_MARKERS = [
	"\n\n[Post-History Instructions — ",
	"\n\n[Safety Rule]",
];

/** Pull the opening greeting out of the roleplay prompt built by the card app. */
export function extractCharcardGreeting(roleplay: unknown): string | null {
	if (typeof roleplay !== "string") return null;
	const start = roleplay.indexOf(GREETING_MARKER);
	if (start < 0) return null;
	const body = roleplay.slice(start + GREETING_MARKER.length);
	let end = body.length;
	for (const marker of GREETING_END_MARKERS) {
		const at = body.indexOf(marker);
		if (at >= 0 && at < end) end = at;
	}
	const greeting = body.slice(0, end).trim();
	return greeting.length > 0 ? greeting : null;
}

interface CharcardContextData {
	roleplay?: unknown;
	character?: unknown;
}

/**
 * Start the conversation for a newly pushed charcard context. Returns true when
 * the chat was (re)started. A repeated push of the same character and greeting
 * only reopens the chat so an ongoing roleplay is not wiped.
 */
export function startCharcardConversation(
	data: CharcardContextData,
	lastKey: { current: string | null },
): boolean {
	const greeting = extractCharcardGreeting(data.roleplay);
	const character = typeof data.character === "string" ? data.character : "";
	const key = `${character}\u0000${greeting ?? ""}`;
	if (lastKey.current === key) return false;
	lastKey.current = key;
	const chat = useChatStore.getState();
	chat.newConversation();
	if (greeting) {
		useChatStore.getState().setMessages([
			{
				id: crypto.randomUUID(),
				role: "assistant",
				content: greeting,
				timestamp: Date.now(),
			},
		]);
	}
	return true;
}

export function useCharcardChatStart(openChat: () => void): void {
	useEffect(() => {
		if (!isWebMode()) return;
		const lastKey = { current: null as string | null };
		return useAppStore.subscribe((state, prev) => {
			const ctx = state.activeAppContext;
			if (ctx === prev.activeAppContext) return;
			if (!ctx) {
				// "대화 종료" clears the context; a later start is a fresh roleplay.
				if (prev.activeAppContext?.type === "charcard") lastKey.current = null;
				return;
			}
			if (ctx.type !== "charcard") return;
			if (
				state.activeAppContextOwnerId !== null &&
				state.activeAppContextOwnerId !== CHARCARD_APP_ID
			) {
				return;
			}
			startCharcardConversation(
				(ctx.data ?? {}) as CharcardContextData,
				lastKey,
			);
			openChat();
			requestAnimationFrame(() => {
				document
					.querySelector<HTMLTextAreaElement>(".naia-chat-area .chat-input")
					?.focus({ preventScroll: true });
			});
		});
	}, [openChat]);
}
