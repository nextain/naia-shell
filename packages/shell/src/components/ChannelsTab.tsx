import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadConfig, saveConfig } from "../lib/config";
import {
	type DiscordMessage,
	fetchDiscordMessages,
	getBotUserId,
	isDiscordApiAvailable,
	openDmChannel,
} from "../lib/discord-api";
import { onDiscordMessages } from "../lib/discord-relay";
import { discoverAndPersistDiscordDmChannel } from "../lib/gateway-sessions";
import { t } from "../lib/i18n";
import { Logger } from "../lib/logger";

interface ChannelsTabProps {
	onAskAI?: (message: string) => void;
}

const POLL_INTERVAL_MS = 10_000;

export function ChannelsTab(_props: ChannelsTabProps) {
	const [messages, setMessages] = useState<DiscordMessage[]>([]);
	const [loading, setLoading] = useState(true);
	const [channelId, setChannelId] = useState<string | null>(null);
	const [botId, setBotId] = useState<string | null>(null);
	const [apiAvailable, setApiAvailable] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [initError, setInitError] = useState<string | null>(null);
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	// Resolve DM channel: config → auto-open from userId → Gateway session discovery
	const resolveChannel = useCallback(async (): Promise<string | null> => {
		const config = loadConfig();
		if (config?.discordDmChannelId) return config.discordDmChannelId;

		if (config?.discordDefaultUserId) {
			const id = await openDmChannel(config.discordDefaultUserId);
			if (id && config) {
				saveConfig({ ...config, discordDmChannelId: id });
			}
			return id;
		}

		// Fallback: discover from Gateway sessions (works after reset when bot is still connected)
		const discovered = await discoverAndPersistDiscordDmChannel();
		if (discovered) return discovered;

		return null;
	}, []);

	const initDiscord = useCallback(async () => {
		setLoading(true);
		setInitError(null);

		const apiOk = await isDiscordApiAvailable();
		setApiAvailable(apiOk);
		if (!apiOk) {
			setInitError("봇 토큰을 찾을 수 없습니다.");
			setLoading(false);
			return;
		}

		const dmChannelId = await resolveChannel();
		if (!dmChannelId) {
			setInitError(
				"Discord DM 채널을 찾을 수 없습니다. 설정에서 Discord 연동을 확인하세요.",
			);
			setLoading(false);
			return;
		}

		setChannelId(dmChannelId);
		const bid = await getBotUserId();
		setBotId(bid);
	}, [resolveChannel]);

	// Initialize on mount
	useEffect(() => {
		initDiscord();
	}, [initDiscord]);

	// Re-initialize when Discord OAuth completes
	useEffect(() => {
		const unlisten = listen("discord_auth_complete", () => {
			Logger.info("ChannelsTab", "Discord auth completed, re-initializing");
			initDiscord();
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, [initDiscord]);

	const fetchHistory = useCallback(async () => {
		if (!channelId) return;

		try {
			const msgs = await fetchDiscordMessages(channelId, 50);
			setMessages(msgs);
			setError(null);
		} catch (err) {
			Logger.warn("ChannelsTab", "Failed to fetch Discord messages", {
				error: String(err),
			});
			setError(String(err));
		} finally {
			setLoading(false);
		}
	}, [channelId]);

	// Fetch history once channel ID is set
	useEffect(() => {
		if (!channelId) return;
		fetchHistory();
	}, [channelId, fetchHistory]);

	// Subscribe to discord-relay messages (primary) + fallback poll
	useEffect(() => {
		if (!channelId) return;

		// Primary: subscribe to relay for real-time updates
		const unsubscribe = onDiscordMessages((msgs) => {
			if (msgs.length > 0) {
				setMessages((prev) => {
					const existingIds = new Set(prev.map((m) => m.id));
					const newMsgs = msgs.filter((m) => !existingIds.has(m.id));
					return newMsgs.length > 0 ? [...prev, ...newMsgs] : prev;
				});
			}
		});

		// Fallback: slower poll to catch anything missed
		pollRef.current = setInterval(fetchHistory, POLL_INTERVAL_MS);
		return () => {
			unsubscribe();
			if (pollRef.current) {
				clearInterval(pollRef.current);
				pollRef.current = null;
			}
		};
	}, [channelId, fetchHistory]);

	// Auto-scroll to bottom
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView?.({ behavior: "smooth" });
	}, [messages]);

	function formatTime(ts: string): string {
		try {
			const d = new Date(ts);
			return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		} catch {
			return "";
		}
	}

	// Not connected
	if (!loading && !channelId) {
		return (
			<div className="channels-tab" data-testid="channels-tab">
				<div className="dm-empty">
					<span>{initError ?? "Discord DM 연결이 필요합니다."}</span>
				</div>
			</div>
		);
	}

	return (
		<div className="channels-tab" data-testid="channels-tab">
			{/* Header */}
			<div className="dm-header">
				<div className="dm-header-title">
					<span>Discord DM</span>
					<span
						className={`dm-header-status ${apiAvailable ? "connected" : ""}`}
					>
						{apiAvailable
							? t("channels.connected")
							: t("channels.disconnected") || "연결 안됨"}
					</span>
				</div>
				<button
					type="button"
					className="channels-refresh-btn"
					onClick={fetchHistory}
				>
					{t("channels.refresh")}
				</button>
			</div>

			{/* Messages (read-only) */}
			<div className="dm-messages">
				{loading ? (
					<div className="dm-loading-more">{t("channels.loading")}</div>
				) : messages.length === 0 ? (
					<div className="dm-empty">
						<span>아직 메시지가 없습니다.</span>
						<span style={{ fontSize: 11, color: "var(--cream-dim)" }}>
							Discord에서 봇에게 DM을 보내보세요.
						</span>
					</div>
				) : (
					messages.map((msg) => {
						const isBot = msg.author.bot === true || msg.author.id === botId;
						return (
							<div
								key={msg.id}
								className={`dm-message ${isBot ? "outbound" : "inbound"}`}
							>
								<span className="dm-message-sender">{msg.author.username}</span>
								<div className="dm-message-bubble">{msg.content}</div>
								<span className="dm-message-time">
									{formatTime(msg.timestamp)}
								</span>
							</div>
						);
					})
				)}
				<div ref={messagesEndRef} />
			</div>

			{/* Error bar */}
			{error && (
				<div
					style={{
						padding: "4px 12px",
						fontSize: 11,
						color: "var(--error)",
						borderTop: "1px solid var(--espresso-light)",
					}}
				>
					{error}
				</div>
			)}
		</div>
	);
}
