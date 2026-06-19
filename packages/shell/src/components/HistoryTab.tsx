import { useEffect, useState } from "react";
import {
	type ConversationSession,
	deleteConversation,
	getConversationHistory,
	listConversations,
} from "../lib/conversation-store";
import { t } from "../lib/i18n";
import { Logger } from "../lib/logger";
import { useChatStore } from "../stores/chat";

function formatDate(timestamp: number): string {
	const d = new Date(timestamp);
	return d.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function isDiscordSession(key: string): boolean {
	// Legacy: "discord:dm:<channelId>" / "discord:channel:<channelId>"
	// per-channel-peer dmScope: "agent:main:discord:direct:<peerId>"
	return (
		/^discord:(?:dm|channel):\d+$/.test(key) ||
		/^agent:[^:]+:discord:direct:/.test(key)
	);
}

export function HistoryTab({
	onLoadSession,
	onLoadDiscordSession,
}: {
	onLoadSession: () => void;
	onLoadDiscordSession?: () => void;
}) {
	const [sessions, setSessions] = useState<ConversationSession[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const currentSessionId = useChatStore((s) => s.sessionId);

	useEffect(() => {
		loadSessions();
	}, []);

	async function loadSessions() {
		setIsLoading(true);
		setLoadError(null);
		try {
			const result = await listConversations();
			setSessions(result);
		} catch (err) {
			Logger.warn("HistoryTab", "Failed to load sessions", {
				error: String(err),
			});
			setLoadError(String(err));
		} finally {
			setIsLoading(false);
		}
	}

	async function handleLoadSession(key: string) {
		if (isDiscordSession(key)) {
			onLoadDiscordSession?.();
			return;
		}

		if (key === currentSessionId) return;
		try {
			const messages = await getConversationHistory(key);
			const store = useChatStore.getState();
			store.newConversation();
			store.setSessionId(key);
			store.setMessages(messages);
			onLoadSession();
		} catch (err) {
			Logger.warn("HistoryTab", "Failed to load session", {
				error: String(err),
			});
		}
	}

	async function handleDeleteSession(key: string) {
		if (!window.confirm(t("history.deleteConfirm"))) return;
		try {
			await deleteConversation(key);
			setSessions((prev) => prev.filter((s) => s.key !== key));
			if (key === currentSessionId) {
				useChatStore.getState().newConversation();
			}
		} catch (err) {
			Logger.warn("HistoryTab", "Failed to delete session", {
				error: String(err),
			});
		}
	}

	if (isLoading) {
		return <div className="history-tab-loading">{t("progress.loading")}</div>;
	}

	if (loadError) {
		return (
			<div className="history-tab-error">
				<span>{t("history.agentUnreachable")}</span>
				<button type="button" className="history-retry-btn" onClick={() => void loadSessions()}>
					{t("common.retry")}
				</button>
			</div>
		);
	}

	if (sessions.length === 0) {
		return <div className="history-tab-empty">{t("history.empty")}</div>;
	}

	return (
		<div className="history-tab">
			<div className="history-list">
				{sessions.map((s) => {
					const isDiscord = isDiscordSession(s.key);
					return (
						<div
							key={s.key}
							className={`history-item${s.key === currentSessionId ? " current" : ""}${isDiscord ? " discord" : ""}`}
						>
							<button
								type="button"
								className="history-item-main"
								onClick={() => handleLoadSession(s.key)}
							>
								<span className="history-item-title">
									{isDiscord && (
										<span className="history-discord-badge">Discord</span>
									)}
									{s.label ||
										(isDiscord ? "Discord DM" : t("history.untitled"))}
									{s.key === currentSessionId && (
										<span className="history-current-badge">
											{t("history.current")}
										</span>
									)}
								</span>
								<span className="history-item-meta">
									{formatDate(s.updatedAt || s.createdAt)} · {s.messageCount}{" "}
									{t("history.messages")}
								</span>
							</button>
							<button
								type="button"
								className="history-delete-btn"
								onClick={() => handleDeleteSession(s.key)}
								title={t("history.delete")}
							>
								×
							</button>
						</div>
					);
				})}
			</div>
		</div>
	);
}
