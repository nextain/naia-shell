import { Suspense, lazy } from "react";
import { invoke } from "@tauri-apps/api/core";
import { appRegistry } from "../../lib/app-registry";
import { getAdkPath } from "../../lib/adk-store";
import { t } from "../../lib/i18n";
import { WEB_ADK_PATH } from "../../lib/web-runtime/web-adk-path";
import { isWebMode } from "../../lib/web-runtime/web-assets";
import type { AppCenterProps, NaiaTool } from "../../lib/app-registry";

const HerdrWorkspaceCenterArea = lazy(() =>
	import("./HerdrWorkspaceCenterArea"),
);
const WebWorkspace = lazy(() => import("./WebWorkspace"));

export function DeferredHerdrWorkspaceCenterArea(props: AppCenterProps) {
	if (isWebMode()) {
		const path = getAdkPath();
		if (path === WEB_ADK_PATH) return <Suspense fallback={<code data-testid="web-workspace-path">{path}</code>}><WebWorkspace /></Suspense>;
		return (
			<section className="herdr-workspace__files" aria-label={t("workspace.herdrFileTree")}>
				<header className="herdr-workspace__section-title">{t("workspace.herdrFileTree")}</header>
				{path === WEB_ADK_PATH ? (
					<code data-testid="web-workspace-path" style={{ display: "block", padding: "10px", overflowWrap: "anywhere" }}>{path}</code>
				) : (
					<div className="herdr-workspace__empty">{t("workspace.herdrWaiting")}</div>
				)}
			</section>
		);
	}
	return (
		<Suspense fallback={null}>
			<HerdrWorkspaceCenterArea {...props} />
		</Suspense>
	);
}

/** Model-facing workspace tools (#611 keep list + #687 open-file edit exception). */
export const WORKSPACE_TOOLS: NaiaTool[] = [
	{
		name: "skill_workspace_get_sessions",
		get description() {
			return t("g1b.wsSessions");
		},
		parameters: { type: "object", properties: {}, required: [] },
		tier: 0, // auto (read-only)
	},
	{
		name: "skill_workspace_open_file",
		get description() {
			return t("g1b.wsOpenFile");
		},
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"열 파일의 절대 경로 (e.g. /path/to/workspace/naia-os/shell/src/App.tsx)",
				},
			},
			required: ["path"],
		},
		tier: 1, // notify
	},
	{
		name: "skill_workspace_get_open_file",
		get description() {
			return t("g1b.wsGetOpenFile");
		},
		parameters: { type: "object", properties: {}, required: [] },
		tier: 0, // auto (read-only)
	},
	{
		name: "skill_workspace_edit_open_file",
		get description() {
			return t("g1b.wsEditOpenFile");
		},
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "현재 열린 파일의 절대 경로" },
				oldText: {
					type: "string",
					description: "바꿀 원문(파일에서 정확히 한 번 나와야 함)",
				},
				newText: {
					type: "string",
					description: "oldText 를 대체할 새 텍스트",
				},
				content: {
					type: "string",
					description: "파일 전체를 바꿀 새 내용(oldText/newText 대신)",
				},
			},
			required: ["path"],
		},
		// tier 0 = no generic agent approval prompt. naia-agent main a1fb92d:
		// grpc-server.ts:489 maps tier>0 to "ask" and 0/unset to none; chat-turn-handler.ts:436 tierOf()
		// and :635 emit approvalRequest only for gated tools. The real, non-bypassable gate is the
		// in-editor diff review (every write needs its explicit Approve; there is no "always allow").
		tier: 0,
	},
	{
		name: "skill_workspace_close_file",
		get description() {
			return t("g1b.wsCloseFile");
		},
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "닫을 파일 경로 (생략 시 현재 활성 파일)",
				},
			},
			required: [],
		},
		tier: 1, // notify
	},
	{
		name: "skill_workspace_set_surface",
		get description() {
			return t("g1b.wsSetSurface");
		},
		parameters: {
			type: "object",
			properties: {
				surface: {
					type: "string",
					enum: ["herdr", "viewer"],
					description: "전환할 화면 ('herdr' 또는 'viewer')",
				},
			},
			required: ["surface"],
		},
		tier: 1, // notify
	},
	{
		name: "skill_workspace_focus_space",
		get description() {
			return t("g1b.wsFocusSpace");
		},
		parameters: {
			type: "object",
			properties: {
				target: {
					type: "string",
					description: "이동할 워크스페이스 ID, 라벨, 또는 디렉토리 경로",
				},
			},
			required: ["target"],
		},
		tier: 1, // notify
	},
	{
		name: "skill_workspace_terminal_exec",
		get description() {
			return t("g1b.wsTermExec");
		},
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: "실행할 셸 명령이나 입력 텍스트",
				},
				showTerminal: {
					type: "boolean",
					description:
						"명령 전송 시 터미널 화면으로 자동 전환할지 여부 (기본값 true)",
				},
			},
			required: ["command"],
		},
		tier: 1, // notify
	},
	{
		name: "skill_workspace_get_terminal_output",
		get description() {
			return t("g1b.wsTermOutput");
		},
		parameters: {
			type: "object",
			properties: {
				lines: {
					type: "number",
					description: "가져올 최대 라인 수 (기본값 50)",
				},
			},
			required: [],
		},
		tier: 0, // auto (read-only)
	},
];

function startWorkspaceWatcher() {
	if (isWebMode()) return;
	invoke("workspace_start_watch").catch(() => {});
}

function stopWorkspaceWatcher() {
	if (isWebMode()) return;
	invoke("workspace_stop_watch").catch(() => {});
}

appRegistry.register({
	id: "workspace",
	name: "워크스페이스",
	names: { ko: "워크스페이스", en: "Workspace" },
	icon: "💻",
	builtIn: true,
	source: "code",
	center: DeferredHerdrWorkspaceCenterArea,
	keepAlive: true, // PTY terminals must not unmount on tab switch
	tools: WORKSPACE_TOOLS,
	onActivate: startWorkspaceWatcher,
	onDeactivate: stopWorkspaceWatcher,
});
