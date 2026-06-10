import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { t } from "../lib/i18n";
import { Logger } from "../lib/logger";
import type { AuditEvent, AuditFilter } from "../lib/types";
import { useProgressStore } from "../stores/progress";

const EVENT_TYPE_ICONS: Record<string, string> = {
	tool_use: "T",
	tool_result: "R",
	usage: "$",
	error: "E",
	approval_request: "?",
};

function formatTime(timestamp: string): string {
	try {
		const d = new Date(timestamp);
		return d.toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
	} catch {
		return timestamp;
	}
}

function formatCost(cost: number): string {
	if (cost < 0.001) return `$${cost.toFixed(6)}`;
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(3)}`;
}

export function WorkProgressPanel() {
	const events = useProgressStore((s) => s.events);
	const stats = useProgressStore((s) => s.stats);
	const isLoading = useProgressStore((s) => s.isLoading);
	const [expandedId, setExpandedId] = useState<number | null>(null);
	const [errorFilterActive, setErrorFilterActive] = useState(false);

	const displayEvents = errorFilterActive
		? events.filter((e) => e.event_type === "error")
		: events;

	function handleRefresh() {
		const store = useProgressStore.getState();
		store.setLoading(true);

		const filter: AuditFilter = { limit: 100 };

		Promise.all([
			invoke("get_audit_log", { filter }),
			invoke("get_audit_stats"),
		])
			.then(([eventsResult, statsResult]) => {
				const s = useProgressStore.getState();
				s.setEvents(eventsResult as AuditEvent[]);
				s.setStats(statsResult as Parameters<typeof s.setStats>[0]);
			})
			.catch((err) => {
				Logger.warn("WorkProgressPanel", "Failed to load audit data", {
					error: String(err),
				});
			})
			.finally(() => {
				useProgressStore.getState().setLoading(false);
			});
	}

	if (isLoading) {
		return (
			<div className="work-progress-panel">
				<div className="work-progress-header">
					<span className="work-progress-title">{t("progress.title")}</span>
				</div>
				<div className="work-progress-loading">{t("progress.loading")}</div>
			</div>
		);
	}

	const hasData = events.length > 0 || stats !== null;

	// Derive tool count and error count from stats
	const toolCount = stats?.by_tool_name.length ?? 0;
	const errorCount =
		stats?.by_event_type.find(([type]) => type === "error")?.[1] ?? 0;

	return (
		<div className="work-progress-panel">
			<div className="work-progress-header">
				<span className="work-progress-title">{t("progress.title")}</span>
				<button
					type="button"
					className="work-progress-refresh-btn"
					onClick={handleRefresh}
					title={t("progress.refresh")}
				>
					&#8635;
				</button>
			</div>

			{!hasData ? (
				<div className="work-progress-empty">{t("progress.empty")}</div>
			) : (
				<>
					{stats && (
						<div className="work-progress-stats">
							<div className="work-progress-stat">
								<span className="stat-value">{stats.total_events}</span>
								<span className="stat-label">{t("progress.totalEvents")}</span>
							</div>
							<div className="work-progress-stat">
								<span className="stat-value">
									{formatCost(stats.total_cost)}
								</span>
								<span className="stat-label">{t("progress.totalCost")}</span>
							</div>
							<div className="work-progress-stat">
								<span className="stat-value">{toolCount}</span>
								<span className="stat-label">{t("progress.toolCount")}</span>
							</div>
							<button
								type="button"
								className={`work-progress-stat clickable${errorFilterActive ? " active-filter" : ""}`}
								onClick={() => setErrorFilterActive((v) => !v)}
							>
								<span className="stat-value">{errorCount}</span>
								<span className="stat-label">
									{errorFilterActive
										? t("progress.filteredErrors")
										: t("progress.errorCount")}
								</span>
							</button>
						</div>
					)}

					<div className="work-progress-events">
						{errorFilterActive && (
							<button
								type="button"
								className="error-filter-label"
								onClick={() => setErrorFilterActive(false)}
							>
								{t("progress.showAll")}
							</button>
						)}
						{displayEvents.map((ev) => (
							<div key={ev.id} className="work-progress-event">
								<button
									type="button"
									className="work-progress-event-header"
									onClick={() =>
										setExpandedId(expandedId === ev.id ? null : ev.id)
									}
								>
									<span
										className={`event-type-icon event-type-${ev.event_type}`}
									>
										{EVENT_TYPE_ICONS[ev.event_type] ?? "?"}
									</span>
									<span className="event-tool-name">
										{ev.tool_name ?? ev.event_type}
									</span>
									<span className="event-time">{formatTime(ev.timestamp)}</span>
								</button>
								{expandedId === ev.id && ev.payload && (
									<div className="work-progress-event-payload">
										<pre>{ev.payload}</pre>
									</div>
								)}
							</div>
						))}
					</div>
				</>
			)}
		</div>
	);
}
