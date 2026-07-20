import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { Logger } from "../lib/logger";

interface InboxRecord {
	readonly recordId: string;
	readonly direction: "incoming" | "outgoing";
	readonly bindingId: string;
	readonly guildId: string;
	readonly channelId: string;
	readonly sourceMessageId: string;
	readonly authorId?: string;
	readonly content: string;
	readonly createdAt: number;
}

interface InboxChannel {
	readonly bindingId: string;
	readonly guildId: string;
	readonly guildName: string;
	readonly channelId: string;
	readonly channelName: string;
	readonly participation: "mentions" | "all" | "paused";
	readonly records: readonly InboxRecord[];
	readonly unread: number;
	readonly lastActivity?: number;
}

function formatTime(timestamp?: number): string {
	if (!timestamp) return "";
	try {
		return new Date(timestamp).toLocaleString([], {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return "";
	}
}

function latestChannelBindingId(
	channels: readonly InboxChannel[],
): string | null {
	return (
		channels.reduce<InboxChannel | null>((latest, channel) => {
			if (channel.lastActivity === undefined) return latest;
			if (!latest) return channel;
			const latestActivity = latest.lastActivity as number;
			const channelActivity = channel.lastActivity;
			if (channelActivity !== latestActivity) {
				return channelActivity > latestActivity ? channel : latest;
			}
			return channel.bindingId.localeCompare(latest.bindingId) < 0
				? channel
				: latest;
		}, null)?.bindingId ?? null
	);
}

function mergeChannelRecords(
	history: readonly InboxRecord[],
	inbox: readonly InboxRecord[],
): readonly InboxRecord[] {
	const bySourceMessage = new Map<string, InboxRecord>();
	for (const record of [...history, ...inbox]) {
		bySourceMessage.set(
			`${record.direction}:${record.sourceMessageId}`,
			record,
		);
	}
	return [...bySourceMessage.values()].sort(
		(left, right) => left.createdAt - right.createdAt,
	);
}

export function ChannelsTab() {
	const [channels, setChannels] = useState<readonly InboxChannel[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const selectedIdRef = useRef<string | null>(null);
	const visibleBindingIdsRef = useRef<readonly string[]>([]);
	const preferenceHydratedRef = useRef(false);
	const selectionVersionRef = useRef(0);
	const preferenceQueueRef = useRef<Promise<void>>(Promise.resolve());
	const [historyByBinding, setHistoryByBinding] = useState<
		Readonly<Record<string, readonly InboxRecord[]>>
	>({});
	const [detailOpen, setDetailOpen] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(false);

	const syncChannelHistory = useCallback(async (bindingId: string) => {
		try {
			const records = await invoke<InboxRecord[]>(
				"discord_fetch_channel_history",
				{ bindingId },
			);
			setHistoryByBinding((current) => ({
				...current,
				[bindingId]: records,
			}));
		} catch (cause) {
			Logger.warn("ChannelsTab", "Discord channel history fetch failed", {
				error: String(cause),
			});
		}
	}, []);

	const refresh = useCallback(async (syncHistory = false) => {
		try {
			const snapshot = await invoke<InboxChannel[]>("discord_inbox_snapshot");
			let persisted: string | null = null;
			const hydratePreference = !preferenceHydratedRef.current;
			preferenceHydratedRef.current = true;
			if (hydratePreference) {
				try {
					persisted = await invoke<string | null>(
						"discord_get_last_binding",
					);
				} catch (cause) {
					Logger.warn("ChannelsTab", "Discord channel preference read failed", {
						error: String(cause),
					});
				}
			}
			const current = selectedIdRef.current;
			const nextSelected =
				persisted &&
				snapshot.some((channel) => channel.bindingId === persisted)
					? persisted
					: current &&
						  snapshot.some((channel) => channel.bindingId === current)
						? current
						: latestChannelBindingId(snapshot);
			visibleBindingIdsRef.current = snapshot.map(
				(channel) => channel.bindingId,
			);
			setChannels(snapshot);
			selectedIdRef.current = nextSelected;
			setSelectedId(nextSelected);
			if (syncHistory && nextSelected) {
				setDetailOpen(true);
				await syncChannelHistory(nextSelected);
				const newestIncoming = snapshot
					.find((channel) => channel.bindingId === nextSelected)
					?.records.filter((record) => record.direction === "incoming")
					.at(-1);
				if (newestIncoming) {
					try {
						await invoke("discord_mark_inbox_read", {
							bindingId: nextSelected,
							createdAt: newestIncoming.createdAt,
						});
						setChannels((currentChannels) =>
							currentChannels.map((channel) =>
								channel.bindingId === nextSelected
									? { ...channel, unread: 0 }
									: channel,
							),
						);
					} catch (cause) {
						Logger.warn(
							"ChannelsTab",
							"Discord automatic read cursor update failed",
							{ error: String(cause) },
						);
					}
				}
			}
			if (
				persisted &&
				!snapshot.some((channel) => channel.bindingId === persisted)
			) {
				try {
					await invoke("discord_set_last_binding", { bindingId: null });
				} catch (cause) {
					Logger.warn(
						"ChannelsTab",
						"Discord invalid channel preference clear failed",
						{ error: String(cause) },
					);
				}
			}
			setError(false);
		} catch (cause) {
			Logger.warn("ChannelsTab", "Discord inbox snapshot failed", {
				error: String(cause),
			});
			setChannels([]);
			selectedIdRef.current = null;
			setSelectedId(null);
			setError(true);
		} finally {
			setLoading(false);
		}
	}, [syncChannelHistory]);

	const refreshCached = useCallback(async () => {
		const bindingIds = visibleBindingIdsRef.current;
		if (bindingIds.length === 0) return;
		try {
			const snapshot = await invoke<InboxChannel[]>(
				"discord_inbox_snapshot_cached",
				{ bindingIds },
			);
			const current = selectedIdRef.current;
			const nextSelected =
				current && snapshot.some((channel) => channel.bindingId === current)
					? current
					: latestChannelBindingId(snapshot);
			setChannels(snapshot);
			selectedIdRef.current = nextSelected;
			setSelectedId(nextSelected);
			setError(false);
		} catch (cause) {
			// Keep the last authoritative live snapshot during transient local
			// writes. A watcher event must not empty the list or hit Discord REST.
			Logger.warn("ChannelsTab", "Discord cached inbox refresh failed", {
				error: String(cause),
			});
		}
	}, []);

	useEffect(() => {
		void refresh(true);
		let refreshTimer: ReturnType<typeof setTimeout> | undefined;
		const unlisten = listen("discord_inbox_changed", () => {
			if (refreshTimer !== undefined) clearTimeout(refreshTimer);
			refreshTimer = setTimeout(() => void refreshCached(), 100);
		});
		return () => {
			if (refreshTimer !== undefined) clearTimeout(refreshTimer);
			void unlisten.then((stop) => stop());
		};
	}, [refresh, refreshCached]);

	const displayChannels = useMemo(
		() =>
			channels.map((channel) => {
				const records = mergeChannelRecords(
					historyByBinding[channel.bindingId] ?? [],
					channel.records,
				);
				return {
					...channel,
					records,
					lastActivity: records.at(-1)?.createdAt ?? channel.lastActivity,
				};
			}),
		[channels, historyByBinding],
	);

	const selected = useMemo(
		() =>
			displayChannels.find((channel) => channel.bindingId === selectedId) ??
			null,
		[displayChannels, selectedId],
	);

	async function selectChannel(channel: InboxChannel) {
		const selectionVersion = ++selectionVersionRef.current;
		selectedIdRef.current = channel.bindingId;
		setSelectedId(channel.bindingId);
		setDetailOpen(true);
		const persistPreference = preferenceQueueRef.current.then(async () => {
			await invoke("discord_set_last_binding", {
				bindingId: channel.bindingId,
			});
		});
		preferenceQueueRef.current = persistPreference.catch(() => {});
		try {
			await persistPreference;
		} catch (cause) {
			Logger.warn("ChannelsTab", "Discord channel preference update failed", {
				error: String(cause),
			});
		}
		await syncChannelHistory(channel.bindingId);
		if (selectionVersionRef.current !== selectionVersion) return;
		const newestIncoming = [...channel.records]
			.reverse()
			.find((record) => record.direction === "incoming");
		if (newestIncoming) {
			try {
				await invoke("discord_mark_inbox_read", {
					bindingId: channel.bindingId,
					createdAt: newestIncoming.createdAt,
				});
				await refreshCached();
			} catch (cause) {
				Logger.warn("ChannelsTab", "Discord read cursor update failed", {
					error: String(cause),
				});
			}
		}
	}

	function showChannelList() {
		setDetailOpen(false);
	}

	if (loading) {
		return (
			<div className="channels-tab" data-testid="channels-tab">
				<div className="dm-loading-more">{t("channels.loading")}</div>
			</div>
		);
	}

	if (error || channels.length === 0) {
		return (
			<div className="channels-tab" data-testid="channels-tab">
				<div className="dm-empty">
					<span>{error ? t("channels.error") : t("channels.empty")}</span>
					<button type="button" onClick={() => void refresh(true)}>
						{t("channels.refresh")}
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="channels-tab" data-testid="channels-tab">
			<div className="dm-header">
				<div className="dm-header-title">
					<span>{t("channels.title")}</span>
					<span className="dm-header-status connected">
						{t("channels.connected")}
					</span>
				</div>
				<button
					type="button"
					className="channels-refresh-btn"
					onClick={() => void refresh(true)}
				>
					{t("channels.refresh")}
				</button>
			</div>
			<div
				className={`channels-inbox-layout${detailOpen ? " detail-open" : ""}`}
			>
				<nav aria-label={t("channels.title")} className="channels-inbox-list">
					{displayChannels.map((channel) => {
						const preview = channel.records.at(-1)?.content ?? "";
						return (
							<button
								type="button"
								key={channel.bindingId}
								className={
									channel.bindingId === selectedId ? "selected" : undefined
								}
								aria-current={
									channel.bindingId === selectedId ? "page" : undefined
								}
								onClick={() => void selectChannel(channel)}
							>
								<strong>
									{channel.guildName} · #{channel.channelName}
								</strong>
								<span>{preview}</span>
								<time
									dateTime={new Date(channel.lastActivity ?? 0).toISOString()}
								>
									{formatTime(channel.lastActivity)}
								</time>
								{channel.unread > 0 && (
									<span aria-label={`${channel.unread}`}>{channel.unread}</span>
								)}
							</button>
						);
					})}
				</nav>
				<section
					className="dm-messages"
					aria-live="polite"
					aria-label={
						selected
							? `${selected.guildName} #${selected.channelName}`
							: t("channels.title")
					}
				>
					<button
						type="button"
						className="channels-inbox-back"
						onClick={showChannelList}
					>
						{t("onboard.back")}
					</button>
					{!selected && (
						<div className="dm-empty">{t("channels.selectChannel")}</div>
					)}
					{selected?.records.map((record) => (
						<article
							key={record.recordId}
							className={`dm-message ${
								record.direction === "outgoing" ? "outbound" : "inbound"
							}`}
						>
							<div className="dm-message-bubble">{record.content}</div>
							<time className="dm-message-time">
								{formatTime(record.createdAt)}
							</time>
						</article>
					))}
				</section>
			</div>
		</div>
	);
}
