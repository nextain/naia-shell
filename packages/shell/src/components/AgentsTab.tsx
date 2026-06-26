import { useCallback, useEffect, useState } from "react";
import {
	deleteConversation,
	listConversations,
	type ConversationSession,
} from "../lib/conversation-store";
import { t } from "../lib/i18n";
import { Logger } from "../lib/logger";

// AgentsTab — 대화 세션 목록/삭제. **E1 셸-직결**(로컬 `{adk}/conversations/`, conversation-store).
// ⚠️ 구코어 경로 폐기: directToolCall(skill_sessions/skill_agents)는 신코어에서 standalone tool_request 미지원
//    → 즉시 error(깨짐). 셸-직결로 이관해 정상화(부채 없이; tool_request 부활 안 함).
//    · sessions = 로컬 transcript(E1, agent 부재여도 동작) — list/delete.
//    · compact = agent 내부 예산(compaction) 작업이라 셸 UI op 아님 → 제거.
//    · "agents"(구 게이트웨이 에이전트 + 파일 편집)는 재구축에서 백엔드 드롭 → UI 보류. 신아키텍처 에이전트
//      모델 확정 후 워크스페이스-직결로 재정착(추측 배선 금지). 현재는 빈 상태로 표기.
export function AgentsTab() {
	const [sessions, setSessions] = useState<ConversationSession[]>([]);
	const [loading, setLoading] = useState(true);

	const fetchData = useCallback(async () => {
		setLoading(true);
		setSessions(await listConversations());
		setLoading(false);
	}, []);

	useEffect(() => {
		fetchData();
	}, [fetchData]);

	const handleDeleteSession = useCallback(
		async (key: string) => {
			if (!confirm(t("agents.deleteSessionConfirm"))) return;
			const ok = await deleteConversation(key);
			if (ok) fetchData();
			else Logger.warn("AgentsTab", "delete session failed", { key });
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

	return (
		<div className="agents-tab" data-testid="agents-tab">
			{/* Agents section — 백엔드 미이식(신아키텍처 확정 후 워크스페이스-직결 재정착). 빈 상태. */}
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
				<div className="agents-empty">{t("agents.noAgents")}</div>
			</div>

			{/* Sessions section — E1 셸-직결(로컬 conversations/) */}
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
									</span>
								</div>
								<div className="session-card-actions">
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
