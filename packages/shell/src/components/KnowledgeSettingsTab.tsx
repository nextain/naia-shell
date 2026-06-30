import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { getAdkPath } from "../lib/adk-store";
import { t } from "../lib/i18n";
import {
	addSource,
	emptyKnowledgeConfig,
	type KnowledgeConfig,
	type KnowledgeKbStats,
	parseKbStats,
	parseKnowledgeConfig,
	removeSource,
	serializeKnowledgeConfig,
	sourceLabel,
} from "../lib/knowledge-config";
import { graphFromKbJson, type KnowledgeGraph } from "../lib/knowledge-result";
import { Logger } from "../lib/logger";
import { KnowledgeGraphOverlay } from "./KnowledgeGraphOverlay";

/** 설정>지식 탭 — 지식 소스(다중 폴더)·스코프 관리 + 컴파일 트리거 (FR-KB-OS.5~9, UC-KB-MANAGE).
 *  설정 정본 = naia-settings/knowledge.json(셸 전용 write). 컴파일/답변 지능 = naia-agent(별 레포). */
export function KnowledgeSettingsTab() {
	const [config, setConfig] = useState<KnowledgeConfig>(() =>
		emptyKnowledgeConfig(),
	);
	const [stats, setStats] = useState<KnowledgeKbStats | null>(null);
	const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
	const [kbRaw, setKbRaw] = useState(""); // 노드→출처 매핑용 원본 kb.json
	const [graphOpen, setGraphOpen] = useState(false);
	const [compiling, setCompiling] = useState(false);
	const [error, setError] = useState("");

	const loadStats = useCallback(async (scope: string) => {
		const adkPath = getAdkPath();
		if (!adkPath) return;
		try {
			const raw = await invoke<string>("read_naia_knowledge_kb", {
				adkPath,
				scope,
			});
			setStats(parseKbStats(raw));
			setGraph(graphFromKbJson(raw)); // 컴파일된 kb.json → 2D/3D 그래프 데이터
			setKbRaw(raw);
		} catch (err) {
			Logger.warn("KnowledgeSettings", "Failed to read kb stats", {
				error: String(err),
			});
			setStats(null);
			setGraph(null);
			setKbRaw("");
		}
	}, []);

	const loadConfig = useCallback(async () => {
		const adkPath = getAdkPath();
		if (!adkPath) return;
		try {
			const raw = await invoke<string>("read_naia_knowledge_config", {
				adkPath,
			});
			const parsed = parseKnowledgeConfig(raw);
			setConfig(parsed);
			await loadStats(parsed.scope);
		} catch (err) {
			Logger.warn("KnowledgeSettings", "Failed to read knowledge config", {
				error: String(err),
			});
		}
	}, [loadStats]);

	useEffect(() => {
		loadConfig();
	}, [loadConfig]);

	/** config 영속(naia-settings/knowledge.json, 셸 전용). 낙관적 setState 후 write. */
	const persist = useCallback(async (next: KnowledgeConfig) => {
		setConfig(next);
		const adkPath = getAdkPath();
		if (!adkPath) return;
		try {
			await invoke("write_naia_knowledge_config", {
				adkPath,
				json: serializeKnowledgeConfig(next),
			});
		} catch (err) {
			Logger.warn("KnowledgeSettings", "Failed to write knowledge config", {
				error: String(err),
			});
		}
	}, []);

	const handleAddFolder = useCallback(async () => {
		const selected = await open({
			directory: true,
			multiple: false,
			title: t("settings.knowledgeAddFolderTitle"),
		});
		if (!selected || typeof selected !== "string") return;
		await persist(addSource(config, selected));
	}, [config, persist]);

	const handleRemove = useCallback(
		async (path: string) => {
			await persist(removeSource(config, path));
		},
		[config, persist],
	);

	const handleCompile = useCallback(async () => {
		const adkPath = getAdkPath();
		if (!adkPath) return;
		setCompiling(true);
		setError("");
		try {
			await invoke("compile_knowledge", { adkPath });
			await loadStats(config.scope);
		} catch (err) {
			const msg = String(err);
			// 커맨드 미존재(에이전트 미배선) = unavailable, 그 외 = 정직 실패 표기(UI 무붕괴).
			const unavailable =
				msg.includes("not found") ||
				msg.includes("not allowed") ||
				msg.includes("missing") ||
				msg.includes("unavailable");
			setError(
				unavailable
					? t("settings.knowledgeCompileUnavailable")
					: `${t("settings.knowledgeCompileFailed")}: ${msg}`,
			);
			Logger.warn("KnowledgeSettings", "compile_knowledge failed", {
				error: msg,
			});
		} finally {
			setCompiling(false);
		}
	}, [config.scope, loadStats]);

	const statusText = stats
		? t("settings.knowledgeStatsFormat")
				.replace("%c", String(stats.cards))
				.replace("%e", String(stats.entities))
				.replace("%r", String(stats.relations))
				.replace("%a", String(stats.accepted))
		: t("settings.knowledgeStatusEmpty");

	return (
		<div className="knowledge-settings" data-testid="knowledge-settings">
			<div className="settings-section-divider">
				<span>{t("settings.tabKnowledge")}</span>
			</div>

			<div className="settings-field">
				<div className="settings-hint">{t("settings.knowledgeManageHint")}</div>
			</div>

			{/* 지식 스코프(프로젝트) */}
			<div className="settings-field">
				<label>{t("settings.knowledgeScopeLabel")}</label>
				<div className="knowledge-scope" data-testid="knowledge-scope">
					{config.scope}
				</div>
			</div>

			{/* 소스 폴더 레지스트리 */}
			<div className="settings-field">
				<label>{t("settings.knowledgeSourcesLabel")}</label>
				{config.sources.length === 0 ? (
					<div className="settings-hint knowledge-no-sources">
						{t("settings.knowledgeNoSources")}
					</div>
				) : (
					<ul
						className="knowledge-source-list"
						data-testid="knowledge-source-list"
					>
						{config.sources.map((src) => (
							<li
								className="knowledge-source-item"
								data-path={src.path}
								key={src.path}
							>
								<span className="knowledge-source-label" title={src.path}>
									{sourceLabel(src)}
								</span>
								<span className="knowledge-source-path">{src.path}</span>
								<button
									type="button"
									className="knowledge-source-remove"
									data-testid="knowledge-source-remove"
									onClick={() => handleRemove(src.path)}
								>
									{t("settings.knowledgeRemove")}
								</button>
							</li>
						))}
					</ul>
				)}
				<button
					type="button"
					className="knowledge-add-folder"
					data-testid="knowledge-add-folder"
					onClick={handleAddFolder}
				>
					{t("settings.knowledgeAddFolder")}
				</button>
			</div>

			{/* 컴파일 상태 + 트리거 */}
			<div className="settings-field">
				<label>{t("settings.knowledgeStatusLabel")}</label>
				<div className="knowledge-status" data-testid="knowledge-status">
					{statusText}
				</div>
				<div
					style={{
						display: "flex",
						gap: "8px",
						marginTop: "8px",
						alignItems: "center",
					}}
				>
					<button
						type="button"
						className="knowledge-compile"
						data-testid="knowledge-compile"
						disabled={compiling || config.sources.length === 0}
						onClick={handleCompile}
					>
						{compiling
							? t("settings.knowledgeCompiling")
							: t("settings.knowledgeCompile")}
					</button>
				</div>
				{error && (
					<div
						className="knowledge-compile-error settings-hint"
						data-testid="knowledge-compile-error"
					>
						{error}
					</div>
				)}
			</div>

			{/* 지식 그래프 — 평소엔 버튼만(렌더 안 함 = 부하 0). 누르면 작업영역을 채우는 오버레이로
			    열리고(닫으면 복귀·unmount), 노드 클릭 시 출처 문서 → 원문 열기. */}
			{graph && graph.nodes.length > 0 && (
				<div className="settings-field">
					<button
						type="button"
						className="knowledge-graph-open"
						data-testid="knowledge-graph-open"
						onClick={() => setGraphOpen(true)}
						style={{
							background: "rgba(76,139,245,0.12)",
							border: "1px solid var(--border, rgba(120,150,200,0.35))",
							borderRadius: 8,
							color: "var(--cream, #e8e0d0)",
							padding: "6px 12px",
							fontSize: 12,
							cursor: "pointer",
						}}
					>
						🕸 지식 그래프 보기 ({graph.nodes.length} 노드)
					</button>
				</div>
			)}
			{graphOpen && graph && (
				<KnowledgeGraphOverlay
					graph={graph}
					kbJson={kbRaw}
					onClose={() => setGraphOpen(false)}
				/>
			)}
		</div>
	);
}
