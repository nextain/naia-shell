import { Suspense, lazy, useState } from "react";
import { t } from "../lib/i18n";
import {
	isKnowledgeGraphTool,
	isKnowledgeTool,
	parseKnowledgeGraph,
	parseKnowledgeResult,
} from "../lib/knowledge-result";
import type { ToolCall } from "../lib/types";
import { BrowserHostResult, browserHostCardFor } from "./BrowserHostResult";
import { KnowledgeToolResult } from "./KnowledgeToolResult";

const KnowledgeGraphView = lazy(() =>
	import("./KnowledgeGraphView").then((module) => ({
		default: module.KnowledgeGraphView,
	})),
);

const TOOL_NAME_KEYS: Record<string, string> = {
	execute_command: "tool.execute_command",
	read_file: "tool.read_file",
	write_file: "tool.write_file",
	search_files: "tool.search_files",
	web_search: "tool.web_search",
};

const STATUS_ICON: Record<ToolCall["status"], string> = {
	running: "⟳",
	success: "✓",
	error: "✗",
};

const MAX_OUTPUT_LENGTH = 500;

function getToolLabel(toolName: string): string {
	const key = TOOL_NAME_KEYS[toolName];
	if (key) return t(key as Parameters<typeof t>[0]);
	return t("tool.unknown");
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}…`;
}

interface Props {
	tool: ToolCall;
}

export function ToolActivity({ tool }: Props) {
	const [expanded, setExpanded] = useState(false);

	const label = getToolLabel(tool.toolName);
	const icon = STATUS_ICON[tool.status];

	// #582 S6a — 브라우저 호스트 결과는 증거 카드로 그린다. 백그라운드 브라우저는 화면이 없어
	// 사용자가 직접 볼 수 없고, 증거(스냅샷·캡처·주소 개정)가 유일한 확인 수단이다.
	// 파싱 실패 시 기본 렌더로 폴백 — 못 읽은 것을 빈 증거로 그리지 않는다.
	const browserHost = browserHostCardFor(tool.toolName, tool.output);
	if (browserHost) {
		return (
			<div
				className={`tool-activity tool-${tool.status} tool-browser-host`}
				data-tool-name={tool.toolName}
			>
				<div className="tool-activity-header tool-activity-header-static">
					<span className="tool-status-icon">{icon}</span>
					<span className="tool-name">{browserHost.tool}</span>
				</div>
				<BrowserHostResult card={browserHost} status={tool.status} />
			</div>
		);
	}

	// 지식 도구(skill_knowledge_ask/search) = 답변 + 출처 칩 렌더(K2). 파싱 실패 시 기본 렌더로 폴백.
	if (isKnowledgeTool(tool.toolName) && tool.status === "success") {
		const parsed = parseKnowledgeResult(tool.toolName, tool.output);
		if (parsed) {
			return (
				<div
					className={`tool-activity tool-${tool.status} tool-knowledge`}
					data-tool-name={tool.toolName}
				>
					<KnowledgeToolResult data={parsed} />
				</div>
			);
		}
	}

	// 지식 그래프(skill_knowledge_graph) = 2D/3D 캔버스 뷰어(K3). 파싱 실패 시 기본 렌더로 폴백.
	if (isKnowledgeGraphTool(tool.toolName) && tool.status === "success") {
		const g = parseKnowledgeGraph(tool.toolName, tool.output);
		if (g) {
			return (
				<div
					className={`tool-activity tool-${tool.status} tool-knowledge-graph`}
					data-tool-name={tool.toolName}
				>
					<Suspense
						fallback={
							<output aria-live="polite">{t("progress.loading")}</output>
						}
					>
						<KnowledgeGraphView graph={g} />
					</Suspense>
				</div>
			);
		}
	}

	return (
		<div
			className={`tool-activity tool-${tool.status}`}
			data-tool-name={tool.toolName}
		>
			<button
				type="button"
				className="tool-activity-header"
				onClick={() => setExpanded((v) => !v)}
			>
				<span className="tool-status-icon">{icon}</span>
				<span className="tool-name">{label}</span>
				<span className="tool-expand">{expanded ? "▾" : "▸"}</span>
			</button>
			{expanded && (
				<div className="tool-activity-body">
					<div className="tool-args">{JSON.stringify(tool.args, null, 2)}</div>
					{tool.output && (
						<div className="tool-output">
							{truncate(tool.output, MAX_OUTPUT_LENGTH)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
