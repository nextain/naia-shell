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

/** Model-facing workspace tools (#611 keep list + #687 open-file edit exception). */
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
			"현재 에디터에 열려 있는 파일의 경로·내용·sha256 을 반환한다. 파일이 없으면 { open: false }. 민감 경로나 1MB 초과 파일은 내용 없이 error 를 돌려준다.",
		parameters: { type: "object", properties: {}, required: [] },
		tier: 0, // auto (read-only)
	},
	{
		name: "skill_workspace_edit_open_file",
		description:
			"현재 에디터에 열려 있는 파일 한 개만 수정한다. 사용자가 에디터의 변경 미리보기를 보고 승인해야만 저장된다. path 는 skill_workspace_get_open_file 이 돌려준 path 와 같아야 한다. oldText(파일 안에서 정확히 한 번 나오는 원문)와 newText 로 부분 수정하거나, content 로 전체를 바꾼다. 결과 status: applied | rejected | stale | denied | invalid | error. rejected 면 저장되지 않았다. 편집기 안 승인 창이 유일한 승인 단계다(50초 안에 답이 없으면 저장하지 않는다).",
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
		description:
			"현재 열려 있는 파일 탭이나 지정한 경로의 파일 탭을 닫는다. path를 생략하면 현재 활성 파일 탭을 닫는다.",
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
		description:
			"워크스페이스 화면을 Herdr 터미널('herdr') 또는 파일 뷰어('viewer')로 전환한다.",
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
		description:
			"Herdr의 특정 워크스페이스/스페이스(이름, ID, 디렉토리)로 포커스를 이동한다.",
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
		description:
			"사용자가 보고 있는 Herdr 터미널로 명령이나 입력을 전송하여 실행한다. 실행 시 자동으로 터미널 화면으로 전환되어 사용자가 볼 수 있다.",
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
		description:
			"현재 Herdr 터미널 화면에 출력된 최근 텍스트 버퍼를 읽어온다.",
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
