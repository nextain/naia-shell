import { invoke } from "@tauri-apps/api/core";
import { panelRegistry } from "../../lib/panel-registry";
import type { NaiaTool } from "../../lib/panel-registry";
import { WorkspaceCenterPanel } from "./WorkspaceCenterPanel";

export const WORKSPACE_TOOLS: NaiaTool[] = [
	{
		name: "skill_workspace_get_sessions",
		description:
			"현재 모니터링 중인 모든 Claude Code 세션의 상태를 반환한다. { sessions: SessionInfo[], summary: { total, active, idle, stopped, error, description } } 형태로 반환. summary.description은 '내가 뭐 하고 있어?' 질문에 답할 수 있는 자연어 설명을 포함한다.",
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
						"열 파일의 절대 경로 (e.g. /var/home/luke/dev/naia-os/shell/src/App.tsx)",
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
	{
		name: "skill_workspace_edit_open_file",
		description:
			"현재 에디터에 열려 있는 파일의 내용을 replaceAll로 치환한다. search와 replace를 제공하면 파일 내용에서 해당 텍스트를 모두 바꾼다. 전체 교체는 content 인자를 사용한다.",
		parameters: {
			type: "object",
			properties: {
				search: {
					type: "string",
					description: "찾을 텍스트",
				},
				replace: {
					type: "string",
					description: "바꿀 텍스트",
				},
				content: {
					type: "string",
					description: "파일 전체 내용으로 교체 (search/replace보다 우선)",
				},
			},
			required: [],
		},
		tier: 2, // confirm (file write)
	},
	{
		name: "skill_workspace_focus_session",
		description:
			"워크스페이스 패널을 활성화하고 지정한 세션 카드로 스크롤·하이라이트한다. 3초 후 하이라이트 자동 해제. open_recent_file: true이면 세션의 마지막 작업 파일도 에디터에 연다.",
		parameters: {
			type: "object",
			properties: {
				dir: {
					type: "string",
					description:
						"세션의 dir 식별자 (skill_workspace_get_sessions 반환값의 sessions[].dir 필드)",
				},
				open_recent_file: {
					type: "boolean",
					description:
						"true이면 세션의 recent_file을 에디터에 연다. 성공 시 반환값: 'Focused: {dir}, opened: {path}'. recent_file이 없으면 파일 열기를 건너뛰고 'Focused: {dir}'만 반환된다.",
				},
			},
			required: ["dir"],
		},
		tier: 1, // notify
	},
	{
		name: "skill_workspace_new_session",
		description:
			"지정한 디렉토리에 새 PTY 터미널 세션을 시작한다. 워크스페이스 패널이 활성화되고 새 터미널 탭이 열린다. 같은 dir의 터미널이 이미 열려 있으면 해당 탭으로 전환만 한다. 반환값: 'Started: {dir}, pid: {pid}' 또는 'Already open: {dir}, pid: {pid}'",
		parameters: {
			type: "object",
			properties: {
				dir: {
					type: "string",
					description:
						"터미널을 열 디렉토리 절대 경로 (e.g. /var/home/luke/dev/naia-os)",
				},
			},
			required: ["dir"],
		},
		tier: 2, // confirm (process spawn)
	},
	{
		name: "skill_workspace_send_to_session",
		description:
			"실행 중인 PTY 세션의 stdin에 텍스트를 전송한다. skill_workspace_new_session으로 시작된 터미널 세션에만 동작한다. text에 \\n을 포함하면 Enter 입력. 반환값: 'Sent to: {dir}'",
		parameters: {
			type: "object",
			properties: {
				dir: {
					type: "string",
					description:
						"세션의 dir 식별자 (skill_workspace_get_sessions 반환값의 sessions[].dir 필드)",
				},
				text: {
					type: "string",
					description: "PTY stdin에 전송할 텍스트 (\\n 포함 시 Enter 입력)",
				},
			},
			required: ["dir", "text"],
		},
		tier: 2, // confirm (PTY 입력)
	},
	{
		name: "skill_workspace_execute",
		description:
			"지정한 디렉토리에서 셸 명령을 실행하고 출력을 캡처하여 반환한다. 새 임시 PTY에서 실행되며, 명령 완료 후 자동 정리된다. 기존 터미널 세션에 영향 없음. 반환값: { success, output, exit_code }",
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: "실행할 셸 명령",
				},
				dir: {
					type: "string",
					description:
						"명령을 실행할 디렉토리 절대 경로 (기본값: 워크스페이스 루트)",
				},
				timeout_secs: {
					type: "number",
					description: "명령 실행 타임아웃 (초, 기본값: 60)",
				},
			},
			required: ["command"],
		},
		tier: 2, // confirm (command execution)
	},
	{
		name: "skill_workspace_classify_dirs",
		description:
			"dev 디렉토리의 하위 폴더를 분류(project/worktree/reference/docs/other)한다. 인자 없이 호출하면 추천 분류 결과를 반환하고, confirmed 배열을 넘기면 해당 분류를 적용하고 저장한다.",
		parameters: {
			type: "object",
			properties: {
				confirmed: {
					type: "array",
					description:
						"사용자가 확인한 분류 결과 배열 (각 요소: {name, path, category}). 없으면 추천만 반환.",
					items: {
						type: "object",
						properties: {
							name: { type: "string" },
							path: { type: "string" },
							category: {
								type: "string",
								enum: ["project", "worktree", "reference", "docs", "other"],
							},
						},
					},
				},
			},
			required: [],
		},
		tier: 0, // auto for read, but saving triggers notify
	},
];

function startWorkspaceWatcher() {
	invoke("workspace_start_watch").catch(() => {});
}

function stopWorkspaceWatcher() {
	invoke("workspace_stop_watch").catch(() => {});
}

panelRegistry.register({
	id: "workspace",
	name: "워크스페이스",
	names: { ko: "워크스페이스", en: "Workspace" },
	icon: "💻",
	builtIn: true,
	source: "code",
	center: WorkspaceCenterPanel,
	keepAlive: true, // PTY terminals must not unmount on tab switch
	tools: WORKSPACE_TOOLS,
	onActivate: startWorkspaceWatcher,
	onDeactivate: stopWorkspaceWatcher,
});
