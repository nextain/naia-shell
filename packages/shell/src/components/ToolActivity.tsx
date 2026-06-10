import { useState } from "react";
import { t } from "../lib/i18n";
import type { ToolCall } from "../lib/types";

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
