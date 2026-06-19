// conversation-store — 로컬 대화 transcript read + delete(FR-CONV.3/4). `{adkPath}/conversations/*.jsonl` 를 Rust IPC 로 직접 read.
// content 단일 writer = agent(전두엽). shell 은 read + delete(세션 lifecycle)만 — content append/수정 안 함. agent 부재/죽음에도 동작(E1) — 죽은
// 게이트웨이 directToolCall(skill_sessions, new-core fail-fast) 대체. naia-memory 도 같은 파일을 독립 read(직교).
import { invoke } from "@tauri-apps/api/core";
import { getAdkPath } from "./adk-store";
import { Logger } from "./logger";
import type { ChatMessage } from "./types";

export interface ConversationSession {
	key: string;
	label: string;
	messageCount: number;
	createdAt: number;
	updatedAt: number;
}

/** 로컬 대화 transcript 세션 목록(updatedAt desc). adkPath 없음/실패 = 빈 목록(agent 부재여도 동작). */
export async function listConversations(): Promise<ConversationSession[]> {
	const adkPath = getAdkPath();
	if (!adkPath) return [];
	try {
		const json = await invoke<string>("list_conversations", { adkPath });
		const parsed = JSON.parse(json) as { sessions?: ConversationSession[] };
		return parsed.sessions ?? [];
	} catch (e) {
		Logger.warn("conversation-store", "list_conversations failed", {
			error: String(e),
		});
		return [];
	}
}

/** 한 세션 transcript → ChatMessage[]. JSONL(1줄=1메시지) 파싱; 손상 줄은 skip(부분쓰기/크래시 잔재 관용). */
export async function getConversationHistory(
	key: string,
): Promise<ChatMessage[]> {
	const adkPath = getAdkPath();
	if (!adkPath) return [];
	try {
		const jsonl = await invoke<string>("read_conversation", {
			adkPath,
			sessionId: key,
		});
		if (!jsonl) return [];
		const messages: ChatMessage[] = [];
		for (const line of jsonl.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const m = JSON.parse(trimmed) as {
					role?: string;
					content?: string;
					timestamp?: number;
				};
				if (m.role === "user" || m.role === "assistant") {
					messages.push({
						id: `conv-${m.timestamp ?? 0}-${messages.length}`,
						role: m.role,
						content: m.content ?? "",
						timestamp: m.timestamp ?? Date.now(),
					});
				}
			} catch {
				/* 손상 줄 skip — modality/audioRef 예약 필드(FR-CONV.5)도 optional 로 관용 */
			}
		}
		return messages;
	} catch (e) {
		Logger.warn("conversation-store", "read_conversation failed", {
			error: String(e),
		});
		return [];
	}
}

/** 한 세션 transcript 삭제. */
export async function deleteConversation(key: string): Promise<boolean> {
	const adkPath = getAdkPath();
	if (!adkPath) return false;
	try {
		await invoke("delete_conversation", { adkPath, sessionId: key });
		return true;
	} catch (e) {
		Logger.warn("conversation-store", "delete_conversation failed", {
			error: String(e),
		});
		return false;
	}
}
