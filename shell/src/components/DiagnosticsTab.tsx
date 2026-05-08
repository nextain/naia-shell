import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { openPath } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useRef, useState } from "react";
import { directToolCall } from "../lib/chat-service";
import {
	DEFAULT_GATEWAY_URL,
	loadConfig,
	resolveGatewayUrl,
} from "../lib/config";
import { t } from "../lib/i18n";
import { Logger } from "../lib/logger";
import type { GatewayStatus, LogEntry } from "../lib/types";
import { useLogsStore } from "../stores/logs";

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_STARTUP_RETRIES = 3; // 15s startup window (3 × 5s)
const RETRY_INTERVAL_MS = 5_000;
const HEALTH_POLL_INTERVAL_MS = 30_000;
const LOG_POLL_INTERVAL_MS = 2_000;
const MAX_LOG_ENTRIES = 500;

// ── Types ─────────────────────────────────────────────────────────────────────

type HealthState = "checking" | "connected" | "disconnected";
type LogTab = "agent" | "gateway" | "shell";

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseGatewayLogLine(
	line: string,
): LogEntry | null {
	try {
		const parsed = JSON.parse(line);
		const meta = parsed._meta || {};
		const level = (meta.logLevelName || "DEBUG").toUpperCase();
		const msg = parsed["0"] || JSON.stringify(parsed);
		const timestamp = parsed.time || meta.date || new Date().toISOString();
		return { level, message: msg, timestamp };
	} catch {
		return { level: "DEBUG", message: line, timestamp: new Date().toISOString() };
	}
}

function parseAgentLogLine(line: string): LogEntry | null {
	if (!line.trim()) return null;
	try {
		const obj = JSON.parse(line);
		const ts = obj.timestamp || obj.ts || new Date().toISOString();
		const level = (obj.level || "INFO").toUpperCase();
		// Format key fields for readability
		let msg = obj.type || obj.message || line;
		if (obj.provider) msg += ` [${obj.provider}/${obj.model ?? ""}]`;
		if (obj.requestId) msg += ` (${obj.requestId})`;
		if (obj.inputTokens != null) msg += ` in=${obj.inputTokens} out=${obj.outputTokens}`;
		return { level, message: msg, timestamp: ts };
	} catch {
		return { level: "DEBUG", message: line, timestamp: new Date().toISOString() };
	}
}

function levelColor(level: string): string {
	switch (level.toLowerCase()) {
		case "error": return "var(--error)";
		case "warn":
		case "warning": return "var(--amber)";
		case "info": return "var(--tech-blue)";
		default: return "var(--cream-dim)";
	}
}

function formatUptime(seconds?: number): string {
	if (!seconds) return "-";
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	return `${h}h ${m}m ${s}s`;
}

/** Read new bytes from a file (byte-offset cursor). Returns {entries, newOffset}. */
async function readNewLogLines(
	path: string,
	byteOffset: number,
	parser: (line: string) => LogEntry | null,
): Promise<{ entries: LogEntry[]; newOffset: number }> {
	try {
		const bytes = await invoke<number[]>("read_local_binary", { path });
		if (bytes.length <= byteOffset) return { entries: [], newOffset: byteOffset };

		const newBytes = new Uint8Array(bytes.slice(byteOffset));
		const text = new TextDecoder().decode(newBytes);
		const lines = text.split("\n");
		const entries: LogEntry[] = [];
		for (const line of lines) {
			const entry = parser(line.trim());
			if (entry) entries.push(entry);
		}
		return { entries, newOffset: bytes.length };
	} catch {
		return { entries: [], newOffset: byteOffset };
	}
}

// ── Component ─────────────────────────────────────────────────────────────────

export function DiagnosticsTab() {
	// Health
	const [healthState, setHealthState] = useState<HealthState>("checking");
	const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null);
	const retryCountRef = useRef(0);
	const retryTimerRef = useRef<ReturnType<typeof setTimeout>>();
	const healthPollRef = useRef<ReturnType<typeof setInterval>>();

	// Logs
	const [activeLogTab, setActiveLogTab] = useState<LogTab>("agent");
	const [isTailing, setIsTailing] = useState(true);
	const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null);
	const [agentEntries, setAgentEntries] = useState<LogEntry[]>([]);
	const [shellEntries, setShellEntries] = useState<LogEntry[]>([]);
	const agentOffsetRef = useRef(0);
	const shellOffsetRef = useRef(0);
	const gatewayLogCursorRef = useRef<number | undefined>(undefined);
	const logPollRef = useRef<ReturnType<typeof setInterval>>();
	const logsEndRef = useRef<HTMLDivElement>(null);

	// Paths
	const homeDirRef = useRef<string>("");
	const [logPaths, setLogPaths] = useState<Record<LogTab, string>>({
		agent: "",
		gateway: "",
		shell: "",
	});

	// Gateway store (for gateway tab)
	const gatewayEntries = useLogsStore((s) => s.entries);

	// ── Initialize log paths ─────────────────────────────────────────────────

	useEffect(() => {
		homeDir().then((home) => {
			homeDirRef.current = home;
			const sep = home.includes("\\") ? "\\" : "/";
			const base = `${home}${sep}.naia${sep}logs${sep}`;
			setLogPaths({
				agent: `${base}llm-debug.log`,
				gateway: `${base}gateway.log`,
				shell: `${base}naia.log`,
			});
		}).catch(() => {});
	}, []);

	// ── Health check ─────────────────────────────────────────────────────────

	const fetchGatewayStatus = useCallback(async () => {
		const config = loadConfig();
		const gatewayUrl = resolveGatewayUrl(config) || DEFAULT_GATEWAY_URL;
		try {
			const res = await directToolCall({
				toolName: "skill_diagnostics",
				args: { action: "status" },
				requestId: `diag-status-${Date.now()}`,
				gatewayUrl,
				gatewayToken: config?.gatewayToken,
			});
			if (res.success && res.output) {
				setGatewayStatus(JSON.parse(res.output));
			}
		} catch {
			// best-effort; health state already updated
		}
	}, []);

	const checkHealth = useCallback(async (isRetry = false) => {
		if (!isRetry) retryCountRef.current = 0;

		try {
			const alive = await invoke<boolean>("gateway_health");
			if (alive) {
				setHealthState("connected");
				retryCountRef.current = 0;
				void fetchGatewayStatus();
				return;
			}
		} catch {
			// treat invoke error as not alive
		}

		// Gateway not reachable
		if (retryCountRef.current < MAX_STARTUP_RETRIES) {
			retryCountRef.current++;
			setHealthState("checking");
			retryTimerRef.current = setTimeout(() => checkHealth(true), RETRY_INTERVAL_MS);
		} else {
			setHealthState("disconnected");
			setGatewayStatus(null);
		}
	}, [fetchGatewayStatus]);

	// Initial check + background health poll
	useEffect(() => {
		checkHealth();
		healthPollRef.current = setInterval(async () => {
			try {
				const alive = await invoke<boolean>("gateway_health");
				if (alive) {
					setHealthState("connected");
					void fetchGatewayStatus();
				} else {
					setHealthState("disconnected");
					setGatewayStatus(null);
				}
			} catch {
				setHealthState("disconnected");
				setGatewayStatus(null);
			}
		}, HEALTH_POLL_INTERVAL_MS);

		return () => {
			clearTimeout(retryTimerRef.current);
			clearInterval(healthPollRef.current);
		};
	}, [checkHealth, fetchGatewayStatus]);

	// ── Log polling ──────────────────────────────────────────────────────────

	const pollAgentLogs = useCallback(async () => {
		if (!logPaths.agent) return;
		const { entries, newOffset } = await readNewLogLines(
			logPaths.agent,
			agentOffsetRef.current,
			parseAgentLogLine,
		);
		if (entries.length > 0) {
			agentOffsetRef.current = newOffset;
			setAgentEntries((prev) => [...prev, ...entries].slice(-MAX_LOG_ENTRIES));
		}
	}, [logPaths.agent]);

	const pollShellLogs = useCallback(async () => {
		if (!logPaths.shell) return;
		const { entries, newOffset } = await readNewLogLines(
			logPaths.shell,
			shellOffsetRef.current,
			(line) => line.trim() ? { level: "DEBUG", message: line, timestamp: new Date().toISOString() } : null,
		);
		if (entries.length > 0) {
			shellOffsetRef.current = newOffset;
			setShellEntries((prev) => [...prev, ...entries].slice(-MAX_LOG_ENTRIES));
		}
	}, [logPaths.shell]);

	const pollGatewayLogs = useCallback(async () => {
		const config = loadConfig();
		const gatewayUrl = resolveGatewayUrl(config) || DEFAULT_GATEWAY_URL;
		try {
			const res = await directToolCall({
				toolName: "skill_diagnostics",
				args: {
					action: "logs_poll",
					...(gatewayLogCursorRef.current != null && { cursor: gatewayLogCursorRef.current }),
				},
				requestId: `diag-logs-poll-${Date.now()}`,
				gatewayUrl,
				gatewayToken: config?.gatewayToken,
			});
			if (res.success && res.output) {
				const result = JSON.parse(res.output);
				if (typeof result.cursor === "number") {
					gatewayLogCursorRef.current = result.cursor;
				}
				const lines: string[] = result.lines || [];
				const store = useLogsStore.getState();
				for (const line of lines) {
					const entry = parseGatewayLogLine(line);
					if (entry) store.addEntry(entry);
				}
			}
		} catch {
			Logger.warn("DiagnosticsTab", "Gateway log poll failed", {});
		}
	}, []);

	// Tailing loop
	useEffect(() => {
		if (!isTailing) {
			clearInterval(logPollRef.current);
			return;
		}

		const poll = async () => {
			if (activeLogTab === "agent") await pollAgentLogs();
			else if (activeLogTab === "shell") await pollShellLogs();
			else await pollGatewayLogs();
		};

		// Immediate first poll
		void poll();
		logPollRef.current = setInterval(poll, LOG_POLL_INTERVAL_MS);
		return () => clearInterval(logPollRef.current);
	}, [isTailing, activeLogTab, pollAgentLogs, pollShellLogs, pollGatewayLogs]);

	// Auto-scroll
	useEffect(() => {
		logsEndRef.current?.scrollIntoView?.({ behavior: "smooth" });
	}, [agentEntries, gatewayEntries, shellEntries]);

	// ── Actions ──────────────────────────────────────────────────────────────

	const handleRestart = useCallback(async () => {
		setHealthState("checking");
		setGatewayStatus(null);
		retryCountRef.current = 0;
		try {
			await invoke("restart_gateway");
			// Give gateway 2s to start then re-check
			setTimeout(() => checkHealth(), 2000);
		} catch (err) {
			Logger.warn("DiagnosticsTab", "restart_gateway failed", { error: String(err) });
			checkHealth();
		}
	}, [checkHealth]);

	const handleTabChange = useCallback((tab: LogTab) => {
		setActiveLogTab(tab);
		// Keep isTailing — useEffect restarts poll for new tab automatically
	}, []);

	const handleToggleTailing = useCallback(() => {
		setIsTailing((v) => !v);
	}, []);

	const handleClear = useCallback(() => {
		if (activeLogTab === "agent") {
			setAgentEntries([]);
			agentOffsetRef.current = 0; // re-read from start on next poll
		} else if (activeLogTab === "shell") {
			setShellEntries([]);
			shellOffsetRef.current = 0;
		} else {
			useLogsStore.getState().clear();
			gatewayLogCursorRef.current = undefined;
		}
	}, [activeLogTab]);

	const handleOpenInWindow = useCallback(async () => {
		try {
			if (activeLogTab === "gateway") {
				// Gateway logs have no file — export current entries to a temp file
				const text = gatewayEntries
					.map((e) => `${e.timestamp} [${e.level}] ${e.message}`)
					.join("\n");
				const exportPath = await invoke<string>("write_temp_text", {
					filename: "naia-gateway.log",
					content: text,
				});
				await openPath(exportPath);
			} else {
				const path = logPaths[activeLogTab];
				if (path) await openPath(path);
			}
		} catch (err) {
			Logger.warn("DiagnosticsTab", "openPath failed", { error: String(err) });
		}
	}, [activeLogTab, logPaths, gatewayEntries]);

	// ── Render ────────────────────────────────────────────────────────────────

	const activeEntries =
		activeLogTab === "agent" ? agentEntries :
		activeLogTab === "shell" ? shellEntries :
		gatewayEntries;

	const isConnected = healthState === "connected";

	return (
		<div className="diagnostics-tab" data-testid="diagnostics-tab">
			{/* ── Health Status ── */}
			<div className="diagnostics-section">
				<div className="diagnostics-section-header">
					<h3>{t("diagnostics.gatewayStatus")}</h3>
					<div style={{ display: "flex", gap: "8px" }}>
						<button
							type="button"
							className="diagnostics-refresh-btn"
							onClick={() => checkHealth()}
						>
							{t("diagnostics.refresh")}
						</button>
						<button
							type="button"
							className="diagnostics-refresh-btn"
							onClick={handleRestart}
						>
							{t("diagnostics.restart") || "재시작"}
						</button>
					</div>
				</div>

				<div className="diagnostics-status-grid">
					<div className="diagnostics-status-item">
						<span className="diagnostics-label">{t("diagnostics.gatewayStatus")}</span>
						<span className={`diagnostics-value ${isConnected ? "status-ok" : healthState === "checking" ? "status-warn" : "status-err"}`}>
							{healthState === "checking"
								? t("diagnostics.gatewayStarting")
								: isConnected
								? t("diagnostics.connected")
								: t("diagnostics.disconnected")}
						</span>
					</div>
					{gatewayStatus?.version && (
						<div className="diagnostics-status-item">
							<span className="diagnostics-label">{t("diagnostics.version")}</span>
							<span className="diagnostics-value">{gatewayStatus.version}</span>
						</div>
					)}
					{gatewayStatus?.uptime != null && (
						<div className="diagnostics-status-item">
							<span className="diagnostics-label">{t("diagnostics.uptime")}</span>
							<span className="diagnostics-value">{formatUptime(gatewayStatus.uptime)}</span>
						</div>
					)}
					{gatewayStatus?.methods && gatewayStatus.methods.length > 0 && (
						<div className="diagnostics-status-item diagnostics-methods">
							<span className="diagnostics-label">
								{t("diagnostics.methods")} ({gatewayStatus.methods.length})
							</span>
							<div className="diagnostics-methods-list">
								{gatewayStatus.methods.map((m) => (
									<span key={m} className="diagnostics-method-tag">{m}</span>
								))}
							</div>
						</div>
					)}
				</div>
			</div>

			{/* ── Log Tabs ── */}
			<div className="diagnostics-section diagnostics-section-logs">
				<div className="diagnostics-section-header">
					<div className="diagnostics-log-tabs">
						{(["agent", "gateway", "shell"] as LogTab[]).map((tab) => (
							<button
								key={tab}
								type="button"
								className={`diagnostics-log-tab ${activeLogTab === tab ? "active" : ""}`}
								onClick={() => handleTabChange(tab)}
							>
								{tab === "agent" ? "Agent" : tab === "gateway" ? "Gateway" : "Shell"}
							</button>
						))}
					</div>
					<div className="diagnostics-logs-controls">
						<button
							type="button"
							className={`diagnostics-log-btn ${isTailing ? "tailing" : ""}`}
							onClick={handleToggleTailing}
							title={isTailing ? t("diagnostics.logsStop") : t("diagnostics.logsStart")}
						>
							{isTailing ? t("diagnostics.logsStop") : t("diagnostics.logsStart")}
						</button>
						<button
							type="button"
							className="diagnostics-log-btn"
							onClick={handleClear}
							title={t("diagnostics.logsClear")}
						>
							{t("diagnostics.logsClear")}
						</button>
						<button
							type="button"
							className="diagnostics-log-btn"
							onClick={handleOpenInWindow}
							title="새창으로 열기"
						>
							↗
						</button>
					</div>
				</div>

				{isTailing && (
					<div className="diagnostics-tailing-indicator">
						{t("diagnostics.logsTailing")} — {activeLogTab === "agent" ? "~/.naia/logs/llm-debug.log" : activeLogTab === "shell" ? "~/.naia/logs/naia.log" : "gateway"}
					</div>
				)}

				<div className="diagnostics-logs-container">
					{activeEntries.length === 0 ? (
						<div className="diagnostics-logs-empty">
							{isTailing ? t("diagnostics.loading") : t("diagnostics.logsEmpty")}
						</div>
					) : (
						activeEntries.map((entry, i) => {
							const isImportant = entry.level === "ERROR" || entry.level === "WARN" || entry.level === "WARNING";
							const ts = entry.timestamp
								? (() => {
									const d = new Date(entry.timestamp);
									const hh = String(d.getHours()).padStart(2, "0");
									const mm = String(d.getMinutes()).padStart(2, "0");
									const ss = String(d.getSeconds()).padStart(2, "0");
									return `${hh}:${mm}:${ss}`;
								})()
								: "";
							const lvl = entry.level.slice(0, 3).toUpperCase();
							return (
								<div
									key={`${entry.timestamp}-${i}`}
									className={`diagnostics-log-line${isImportant ? " diagnostics-log-line--important" : ""}`}
									onClick={isImportant ? () => setSelectedLog(entry) : undefined}
									title={isImportant ? "클릭하여 상세 보기" : undefined}
								>
									<span
										className="log-prefix"
										style={{ color: levelColor(entry.level) }}
									>
										{ts} [{lvl}]
									</span>
									<span className="log-message">{entry.message}</span>
								</div>
							);
						})
					)}
					<div ref={logsEndRef} />
				</div>

				{/* ERROR/WARN detail modal */}
				{selectedLog && (
					<div
						className="diagnostics-log-modal-backdrop"
						onClick={() => setSelectedLog(null)}
					>
						<div
							className="diagnostics-log-modal"
							onClick={(e) => e.stopPropagation()}
						>
							<div
								className="diagnostics-log-modal-level"
								style={{ color: levelColor(selectedLog.level) }}
							>
								{selectedLog.level}
							</div>
							<div className="diagnostics-log-modal-ts">
								{selectedLog.timestamp ? new Date(selectedLog.timestamp).toLocaleString() : ""}
							</div>
							<pre className="diagnostics-log-modal-msg">{selectedLog.message}</pre>
							<button
								type="button"
								className="diagnostics-log-modal-close"
								onClick={() => setSelectedLog(null)}
							>
								닫기
							</button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
