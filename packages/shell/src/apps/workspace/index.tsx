import { Suspense, lazy } from "react";
import { invoke } from "@tauri-apps/api/core";
import { appRegistry } from "../../lib/app-registry";
import type { AppCenterProps, NaiaTool } from "../../lib/app-registry";

const HerdrWorkspaceCenterArea = lazy(() =>
	import("./HerdrWorkspaceCenterArea"),
);

function DeferredHerdrWorkspaceCenterArea(props: AppCenterProps) {
	return (
		<Suspense fallback={null}>
			<HerdrWorkspaceCenterArea {...props} />
		</Suspense>
	);
}

/** Model-facing workspace tools — read surfaces only (#611). */
export const WORKSPACE_TOOLS: NaiaTool[] = [
	{
		name: "skill_workspace_get_sessions",
		description:
			"현재 Herdr Spaces와 그 안의 에이전트 상태를 반환한다. { sessions: SessionInfo[], summary: { total, active, idle, stopped, error, description } } 형태로 반환한다.",
		parameters: { type: "object", properties: {}, required: [] },
		tier: 0, // auto (read-only)
	},
	{
		name: "skill_workspace_open_file",
		description:
			"지정한 파일을 에디터에 연다. 절대 경로 또는 WORKSPACE_ROOT 기준 상대 경로를 받는다.",
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
		description:
			"현재 에디터에 열려 있는 파일의 경로와 내용을 반환한다. 파일이 없으면 { open: false }를 반환한다.",
		parameters: { type: "object", properties: {}, required: [] },
		tier: 0, // auto (read-only)
	},
];

function startWorkspaceWatcher() {
	invoke("workspace_start_watch").catch(() => {});
}

function stopWorkspaceWatcher() {
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
