import { useCallback, useEffect, useState } from "react";
import { directToolCall } from "../lib/chat-service";
import { loadConfig, resolveGatewayUrl } from "../lib/config";
import { t } from "../lib/i18n";
import { Logger } from "../lib/logger";

interface AgentItem {
	id: string;
	name: string;
	description?: string;
	model?: string;
}

interface SessionItem {
	key: string;
	label?: string;
	messageCount?: number;
	status?: string;
}

interface AgentFile {
	path: string;
	size?: number;
}

export function AgentsTab() {
	const [agents, setAgents] = useState<AgentItem[]>([]);
	const [sessions, setSessions] = useState<SessionItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
	const [agentFiles, setAgentFiles] = useState<AgentFile[]>([]);
	const [filesLoading, setFilesLoading] = useState(false);
	const [fileContent, setFileContent] = useState<string | null>(null);
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [fileSaveStatus, setFileSaveStatus] = useState<string | null>(null);

	const fetchData = useCallback(async () => {
		setLoading(true);
		setError(null);

		const config = loadConfig();
		const gatewayUrl = resolveGatewayUrl(config);
		if (!gatewayUrl) {
			setLoading(false);
			setError(t("agents.gatewayRequired"));
			return;
		}

		try {
			const [agentsRes, sessionsRes] = await Promise.all([
				directToolCall({
					toolName: "skill_agents",
					args: { action: "list" },
					requestId: `ag-list-${Date.now()}`,
					gatewayUrl,
				}),
				directToolCall({
					toolName: "skill_sessions",
					args: { action: "list" },
					requestId: `ss-list-${Date.now()}`,
					gatewayUrl,
				}),
			]);

			if (agentsRes.success && agentsRes.output) {
				const parsed = JSON.parse(agentsRes.output);
				setAgents(parsed.agents || []);
			}
			if (sessionsRes.success && sessionsRes.output) {
				const parsed = JSON.parse(sessionsRes.output);
				setSessions(parsed.sessions || []);
			}
		} catch (err) {
			Logger.warn("AgentsTab", "Failed to fetch data", {
				error: String(err),
			});
			setError(t("agents.error"));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchData();
	}, [fetchData]);

	const handleDeleteSession = useCallback(
		async (key: string) => {
			if (!confirm(t("agents.deleteSessionConfirm"))) return;
			const config = loadConfig();
			const gatewayUrl = resolveGatewayUrl(config);
			try {
				await directToolCall({
					toolName: "skill_sessions",
					args: { action: "delete", key },
					requestId: `ss-del-${Date.now()}`,
					gatewayUrl,
				});
				fetchData();
			} catch (err) {
				Logger.warn("AgentsTab", "Delete session failed", {
					error: String(err),
				});
			}
		},
		[fetchData],
	);

	const fetchAgentFiles = useCallback(async (agentId: string) => {
		setFilesLoading(true);
		setSelectedAgent(agentId);
		setFileContent(null);
		setSelectedFile(null);
		const config = loadConfig();
		const gatewayUrl = resolveGatewayUrl(config);
		try {
			const res = await directToolCall({
				toolName: "skill_agents",
				args: { action: "files_list", agentId },
				requestId: `ag-files-${Date.now()}`,
				gatewayUrl,
			});
			if (res.success && res.output) {
				const parsed = JSON.parse(res.output);
				setAgentFiles(parsed.files || []);
			}
		} catch (err) {
			Logger.warn("AgentsTab", "Failed to list agent files", {
				error: String(err),
			});
		} finally {
			setFilesLoading(false);
		}
	}, []);

	const handleViewFile = useCallback(async (agentId: string, path: string) => {
		setSelectedFile(path);
		const config = loadConfig();
		const gatewayUrl = resolveGatewayUrl(config);
		try {
			const res = await directToolCall({
				toolName: "skill_agents",
				args: { action: "files_get", agentId, path },
				requestId: `ag-fget-${Date.now()}`,
				gatewayUrl,
			});
			if (res.success && res.output) {
				const parsed = JSON.parse(res.output);
				setFileContent(parsed.content ?? res.output);
			}
		} catch (err) {
			Logger.warn("AgentsTab", "Failed to get file", {
				error: String(err),
			});
		}
	}, []);

	const handleSaveFile = useCallback(async () => {
		if (!selectedAgent || !selectedFile || fileContent === null) return;
		const config = loadConfig();
		const gatewayUrl = resolveGatewayUrl(config);
		setFileSaveStatus(null);
		try {
			const res = await directToolCall({
				toolName: "skill_agents",
				args: {
					action: "files_set",
					agentId: selectedAgent,
					path: selectedFile,
					content: fileContent,
				},
				requestId: `ag-fset-${Date.now()}`,
				gatewayUrl,
			});
			setFileSaveStatus(
				res.success ? t("agents.filesSaved") : t("agents.filesFailed"),
			);
		} catch (err) {
			setFileSaveStatus(t("agents.filesFailed"));
			Logger.warn("AgentsTab", "Failed to save file", {
				error: String(err),
			});
		}
	}, [selectedAgent, selectedFile, fileContent]);

	const handleCompactSession = useCallback(
		async (key: string) => {
			const config = loadConfig();
			const gatewayUrl = resolveGatewayUrl(config);
			try {
				await directToolCall({
					toolName: "skill_sessions",
					args: { action: "compact", key },
					requestId: `ss-compact-${Date.now()}`,
					gatewayUrl,
				});
				fetchData();
			} catch (err) {
				Logger.warn("AgentsTab", "Compact session failed", {
					error: String(err),
				});
			}
		},
		[fetchData],
	);

	if (loading) {
		return (
			<div className="agents-tab" data-testid="agents-tab">
				<div className="agents-loading">{t("agents.loading")}</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="agents-tab" data-testid="agents-tab">
				<div className="agents-error">
					<span>{error}</span>
					<button type="button" onClick={fetchData}>
						{t("agents.refresh")}
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="agents-tab" data-testid="agents-tab">
			{/* Agents section */}
			<div className="agents-section">
				<div className="agents-section-header">
					<h3>{t("agents.agentsTitle")}</h3>
					<button
						type="button"
						className="agents-refresh-btn"
						onClick={fetchData}
					>
						{t("agents.refresh")}
					</button>
				</div>
				{agents.length === 0 ? (
					<div className="agents-empty">{t("agents.noAgents")}</div>
				) : (
					<div className="agents-list">
						{agents.map((agent) => (
							<div
								key={agent.id}
								className={`agent-card${selectedAgent === agent.id ? " selected" : ""}`}
								data-testid="agent-card"
							>
								<div className="agent-card-header">
									<div className="agent-card-name">{agent.name}</div>
									<button
										type="button"
										className="agent-files-btn"
										onClick={() => fetchAgentFiles(agent.id)}
									>
										{t("agents.filesTitle")}
									</button>
								</div>
								{agent.description && (
									<div className="agent-card-desc">{agent.description}</div>
								)}
								{agent.model && (
									<div className="agent-card-model">{agent.model}</div>
								)}
							</div>
						))}
					</div>
				)}
			</div>

			{/* Agent files section */}
			{selectedAgent && (
				<div className="agents-files-section">
					<h3>
						{t("agents.filesTitle")} — {selectedAgent}
					</h3>
					{filesLoading ? (
						<div className="agents-loading">{t("agents.filesLoading")}</div>
					) : agentFiles.length === 0 ? (
						<div className="agents-empty">{t("agents.filesEmpty")}</div>
					) : (
						<div className="agents-files-list">
							{agentFiles.map((f) => (
								<button
									type="button"
									key={f.path}
									className={`agent-file-item${selectedFile === f.path ? " selected" : ""}`}
									onClick={() => handleViewFile(selectedAgent, f.path)}
								>
									{f.path}
									{f.size != null && (
										<span className="agent-file-size">{f.size}B</span>
									)}
								</button>
							))}
						</div>
					)}

					{selectedFile && fileContent !== null && (
						<div className="agent-file-editor">
							<textarea
								className="agent-file-textarea"
								value={fileContent}
								onChange={(e) => setFileContent(e.target.value)}
								rows={12}
							/>
							<div className="agent-file-actions">
								<button
									type="button"
									className="agent-file-save-btn"
									onClick={handleSaveFile}
								>
									{t("agents.filesSave")}
								</button>
								{fileSaveStatus && (
									<span className="agent-file-status">{fileSaveStatus}</span>
								)}
							</div>
						</div>
					)}
				</div>
			)}

			{/* Sessions section */}
			<div className="agents-section">
				<h3>{t("agents.sessionsTitle")}</h3>
				{sessions.length === 0 ? (
					<div className="agents-empty">{t("agents.noSessions")}</div>
				) : (
					<div className="sessions-list">
						{sessions.map((session) => (
							<div
								key={session.key}
								className="session-card"
								data-testid="session-card"
							>
								<div className="session-card-info">
									<span className="session-card-label">
										{session.label || session.key}
									</span>
									<span className="session-card-meta">
										{session.messageCount ?? 0} msgs
										{session.status && ` · ${session.status}`}
									</span>
								</div>
								<div className="session-card-actions">
									<button
										type="button"
										className="session-action-btn compact"
										onClick={() => handleCompactSession(session.key)}
									>
										{t("agents.compact")}
									</button>
									<button
										type="button"
										className="session-action-btn delete"
										onClick={() => handleDeleteSession(session.key)}
									>
										{t("agents.deleteSession")}
									</button>
								</div>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
