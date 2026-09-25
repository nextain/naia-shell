import { type RefObject, useMemo, useState } from "react";
import { t } from "../../lib/i18n";
import { FileTree } from "./FileTree";
import { WorkspaceContextApp } from "./WorkspaceContextApp";
import type { HerdrSnapshot } from "./herdr";
import type { ClassifiedDir } from "./types";

interface RailProps {
	workspaceRoot: string;
	surface?: "herdr" | "viewer";
	openFilePath: string;
	openDocs?: string[];
	classifiedDirs: ClassifiedDir[] | null;
	fileTreeRegionRef: RefObject<HTMLDivElement>;
	snapshot: HerdrSnapshot | null;
	onFileSelect: (path: string) => void;
	onSendToNaia: (path: string) => void;
	onShowHerdr: () => void;
	onShowViewer?: () => void;
	onFocusWorkspace: (workspaceId: string) => Promise<void>;
	onFocusAgent: (paneId: string) => Promise<void>;
}

export function HerdrWorkspaceRail(props: RailProps) {
	const [tab, setTab] = useState<"spaces" | "agents" | "context">("spaces");
	const agents = useMemo(
		() =>
			[...(props.snapshot?.agents ?? [])].sort((a, b) => {
				if (a.focused !== b.focused) return a.focused ? -1 : 1;
				return (a.label ?? a.agent ?? "").localeCompare(
					b.label ?? b.agent ?? "",
				);
			}),
		[props.snapshot],
	);
	const selectTab = (next: "spaces" | "agents" | "context") => {
		setTab(next);
		// 컨텍스트 탭은 Herdr 작업면을 요구하지 않는다 — Herdr 가 없어도 워크스페이스 규칙은 읽을 수 있어야 한다.
		if (next !== "context") props.onShowHerdr();
	};
	const workspaceName = props.workspaceRoot
		? props.workspaceRoot
				.replace(/[\\/]+$/, "")
				.split(/[\\/]/)
				.pop() || props.workspaceRoot
		: "";

	return (
		<aside
			className="herdr-workspace__rail"
			aria-label={t("workspace.herdrNavigation")}
		>
			<section
				ref={props.fileTreeRegionRef}
				tabIndex={-1}
				className="herdr-workspace__files"
				aria-label={t("workspace.herdrFileTree")}
			>
				<header className="herdr-workspace__section-title">
					<span>{t("workspace.herdrFileTree")}</span>
					{props.workspaceRoot && (
						<span
							className="herdr-workspace__root"
							title={props.workspaceRoot}
							data-testid="herdr-workspace-root"
						>
							{workspaceName}
						</span>
					)}
					{props.surface === "viewer" ? (
						<button
							type="button"
							className="herdr-workspace__toggle-btn"
							onClick={props.onShowHerdr}
							title={t("workspace.herdrBackLabel")}
						>
							{t("workspace.herdrBackButton")}
						</button>
					) : props.onShowViewer && (props.openFilePath || (props.openDocs && props.openDocs.length > 0)) ? (
						<button
							type="button"
							className="herdr-workspace__toggle-btn"
							onClick={props.onShowViewer}
							title={t("workspace.showViewerLabel")}
						>
							{t("workspace.showViewerButton")}
						</button>
					) : props.onShowViewer ? (
						<button
							type="button"
							className="herdr-workspace__toggle-btn"
							onClick={props.onShowViewer}
							title={t("workspace.showViewerLabel")}
						>
							{t("workspace.showViewerShort")}
						</button>
					) : null}
				</header>
				{props.workspaceRoot ? (
					<FileTree
						key={props.workspaceRoot}
						workspaceRoot={props.workspaceRoot}
						openFilePath={props.openFilePath}
						onFileSelect={props.onFileSelect}
						classifiedDirs={props.classifiedDirs ?? undefined}
						onSendToChat={props.onSendToNaia}
					/>
				) : (
					<div className="herdr-workspace__empty">
						{t("workspace.herdrWaiting")}
					</div>
				)}
			</section>
			<div className="herdr-workspace__tabs" role="tablist">
				<button
					type="button"
					role="tab"
					aria-selected={tab === "spaces"}
					onClick={() => selectTab("spaces")}
				>
					{t("workspace.herdrSpaces")}
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "agents"}
					onClick={() => selectTab("agents")}
				>
					{t("workspace.herdrAgents")}
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "context"}
					onClick={() => selectTab("context")}
					data-testid="workspace-context-tab"
				>
					{t("workspace.contextTitle")}
				</button>
			</div>
			<div className="herdr-workspace__items">
				{tab === "context" ? (
					<WorkspaceContextApp workspaceRoot={props.workspaceRoot} />
				) : tab === "spaces"
					? props.snapshot?.workspaces.map((space) => (
							<button
								type="button"
								key={space.workspace_id}
								className={space.focused ? "is-focused" : ""}
								onClick={() => void props.onFocusWorkspace(space.workspace_id)}
							>
								<span>{space.label}</span>
								<small>{space.pane_count}</small>
							</button>
						))
					: agents.map((agent) => (
							<button
								type="button"
								key={agent.pane_id}
								className={agent.focused ? "is-focused" : ""}
								onClick={() => void props.onFocusAgent(agent.pane_id)}
							>
								<span>
									{agent.label || agent.agent || agent.terminal_title_stripped}
								</span>
								<small data-status={agent.agent_status}>
									{agent.agent_status}
								</small>
							</button>
						))}
			</div>
		</aside>
	);
}
