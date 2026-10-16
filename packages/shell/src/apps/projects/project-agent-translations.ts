import { Logger } from "../../lib/logger";

Logger.debug("ProjectAgentTranslations", "loading fixed project app messages");

export const PROJECT_AGENT_ENGLISH_TRANSLATIONS = {
	"projects.agentChoicesLabel": "Coding app",
	"projects.agentCheckoutHint":
		"The agent starts in the selected project's verified checkout. It will not create or clone a checkout for you.",
	"projects.agentChecking": "Checking PATH…",
	"projects.agentNotInstalled": "Not found on PATH",
	"projects.agentStart": "Start {app}",
	"projects.agentStop": "Stop {app}",
	"projects.agentStarting": "Starting the coding app…",
	"projects.agentStopping": "Stopping the coding app…",
	"projects.agentRunning": "{app} is running for this project.",
	"projects.agentReattaching":
		"Reconnecting to this project's running session…",
	"projects.agentExited": "The coding app exited with code {code}.",
	"projects.agentUnknownExit": "unknown",
	"projects.agentErrorTitle": "The coding app could not start",
	"projects.agentCheckoutMissing": "The expected project checkout is missing.",
	"projects.agentExpectedCheckout": "checkouts/<repository-name>",
	"projects.agentExpectedCheckoutLabel": "Expected relative path:",
	"projects.agentRepositoryInvalid":
		"The project repository setting cannot identify a safe checkout folder.",
	"projects.agentCheckoutUnsafe":
		"The checkout path could not be verified as a safe project folder.",
	"projects.agentProjectUnverified":
		"The selected project source could not be verified. Rescan the project catalog and try again.",
	"projects.agentUnavailableHint":
		"The selected coding app was not found on PATH. Install it and make its executable available on PATH, then reopen the project.",
	"projects.agentInstallHint":
		"To use an app marked “Not found on PATH,” install it and make its executable available on PATH, then reopen the project.",
	"projects.agentInvalid": "The selected coding app is not supported.",
	"projects.agentSessionMismatch":
		"The existing session does not belong to this project and app, so it was not reattached.",
	"projects.agentSessionMissing":
		"The previous session is no longer available. Start a new session when ready.",
	"projects.agentUnknownError":
		"The coding app could not start. Check the project settings and try again.",
	"projects.agentRecoveryHint":
		"Check the project.repository value and the expected checkout folder. Create or clone the project checkout there yourself, then try again.",
	"projects.agentAvailabilityFailed":
		"Could not check which coding apps are available. Retry by reopening this project view.",
	"projects.agentTerminalLabel": "{app} terminal",
	"projects.panelLoading": "Loading project view…",
	"projects.webviewSectionLabel": "Project web view",
	"projects.webviewNotConfigured": "This address is not configured",
	"projects.webviewConfigure":
		"Add {key} to this project's project.yaml using an absolute http:// or https:// URL.",
	"projects.webviewInvalidTitle": "The configured address is invalid",
	"projects.webviewInvalidHint":
		"Set {key} in project.yaml to an absolute http:// or https:// URL with a host. The address was not opened.",
	"projects.webviewSeparateWindow":
		"This project view opens in a separate window and keeps Browser app state separate.",
	"projects.webviewOpenDashboard": "Open dashboard",
	"projects.webviewOpenIssues": "Open internal issues",
	"projects.webviewOpening": "Opening project window…",
	"projects.webviewOpened": "The project view is open in its separate window.",
	"projects.webviewTestSkipped":
		"The project window was not created in this test environment. The project URL remains configured.",
	"projects.webviewMissing":
		"The project URL is not configured. Add the matching address key to project.yaml.",
	"projects.webviewInvalid":
		"The project URL is invalid. Set it to an absolute http:// or https:// URL.",
	"projects.webviewUnavailable":
		"The project web view is unavailable in this environment.",
	"projects.webviewOpenFailed":
		"The separate project window could not be opened. Check the project address and try again.",
	"projects.webviewOriginChanged":
		"This project's address changed. Close its existing project window, then open it again.",
} as const;

type ProjectAgentTranslationKey =
	keyof typeof PROJECT_AGENT_ENGLISH_TRANSLATIONS;

export const PROJECT_AGENT_KOREAN_TRANSLATIONS: Record<
	ProjectAgentTranslationKey,
	string
> = {
	"projects.agentChoicesLabel": "코딩 앱",
	"projects.agentCheckoutHint":
		"에이전트는 확인된 프로젝트 체크아웃에서 실행됩니다. 체크아웃을 자동으로 만들거나 복제하지 않습니다.",
	"projects.agentChecking": "PATH에서 확인 중…",
	"projects.agentNotInstalled": "PATH에서 찾을 수 없음",
	"projects.agentStart": "{app} 시작",
	"projects.agentStop": "{app} 중단",
	"projects.agentStarting": "코딩 앱을 시작하는 중…",
	"projects.agentStopping": "코딩 앱을 중단하는 중…",
	"projects.agentRunning": "이 프로젝트에서 {app} 실행 중",
	"projects.agentReattaching":
		"이 프로젝트의 실행 중인 세션에 다시 연결하는 중…",
	"projects.agentExited": "코딩 앱이 종료되었습니다. 종료 코드: {code}.",
	"projects.agentUnknownExit": "알 수 없음",
	"projects.agentErrorTitle": "코딩 앱을 시작하지 못했습니다",
	"projects.agentCheckoutMissing": "기대하는 프로젝트 체크아웃이 없습니다.",
	"projects.agentExpectedCheckout": "checkouts/<repository-name>",
	"projects.agentExpectedCheckoutLabel": "기대하는 상대 경로:",
	"projects.agentRepositoryInvalid":
		"프로젝트 저장소 설정에서 안전한 체크아웃 폴더를 확인할 수 없습니다.",
	"projects.agentCheckoutUnsafe":
		"체크아웃 경로가 안전한 프로젝트 폴더인지 확인되지 않았습니다.",
	"projects.agentProjectUnverified":
		"선택한 프로젝트 출처를 확인하지 못했습니다. 프로젝트 목록을 다시 읽고 시도하세요.",
	"projects.agentUnavailableHint":
		"선택한 코딩 앱을 PATH에서 찾지 못했습니다. 앱을 설치하고 실행 파일을 PATH에 추가한 뒤 프로젝트 화면을 다시 여세요.",
	"projects.agentInstallHint":
		"‘PATH에서 찾을 수 없음’으로 표시된 앱을 사용하려면 해당 앱을 설치하고 실행 파일을 PATH에 추가한 뒤 프로젝트 화면을 다시 여세요.",
	"projects.agentInvalid": "지원하지 않는 코딩 앱입니다.",
	"projects.agentSessionMismatch":
		"기존 세션이 이 프로젝트와 앱에 속하지 않아 다시 연결하지 않았습니다.",
	"projects.agentSessionMissing":
		"이전 세션을 더는 사용할 수 없습니다. 준비되면 새 세션을 시작하세요.",
	"projects.agentUnknownError":
		"코딩 앱을 시작하지 못했습니다. 프로젝트 설정을 확인한 뒤 다시 시도하세요.",
	"projects.agentRecoveryHint":
		"project.repository 값과 기대 체크아웃 폴더를 확인하세요. 프로젝트 체크아웃을 직접 그 위치에 만들거나 복제한 뒤 다시 시도하세요.",
	"projects.agentAvailabilityFailed":
		"사용할 수 있는 코딩 앱을 확인하지 못했습니다. 프로젝트 화면을 다시 열어 시도하세요.",
	"projects.agentTerminalLabel": "{app} 터미널",
	"projects.panelLoading": "프로젝트 화면을 여는 중…",
	"projects.webviewSectionLabel": "프로젝트 웹 화면",
	"projects.webviewNotConfigured": "주소가 설정되지 않았습니다",
	"projects.webviewConfigure":
		"project.yaml에 {key} 값을 절대 http:// 또는 https:// 주소로 추가하세요.",
	"projects.webviewInvalidTitle": "설정한 주소가 올바르지 않습니다",
	"projects.webviewInvalidHint":
		"project.yaml의 {key}를 호스트가 있는 절대 http:// 또는 https:// 주소로 설정하세요. 주소를 열지 않았습니다.",
	"projects.webviewSeparateWindow":
		"이 프로젝트 화면은 별도 창에서 열리며 Browser 앱의 상태와 분리됩니다.",
	"projects.webviewOpenDashboard": "대시보드 열기",
	"projects.webviewOpenIssues": "내부 이슈 열기",
	"projects.webviewOpening": "프로젝트 창을 여는 중…",
	"projects.webviewOpened": "프로젝트 화면을 별도 창에서 열었습니다.",
	"projects.webviewTestSkipped":
		"테스트 환경에서는 프로젝트 창을 만들지 않았습니다. 프로젝트 주소 설정은 유지됩니다.",
	"projects.webviewMissing":
		"프로젝트 주소가 없습니다. project.yaml에 해당 주소 키를 추가하세요.",
	"projects.webviewInvalid":
		"프로젝트 주소가 올바르지 않습니다. 절대 http:// 또는 https:// 주소를 설정하세요.",
	"projects.webviewUnavailable":
		"이 환경에서는 프로젝트 웹 화면을 사용할 수 없습니다.",
	"projects.webviewOpenFailed":
		"별도 프로젝트 창을 열지 못했습니다. 주소를 확인한 뒤 다시 시도하세요.",
	"projects.webviewOriginChanged":
		"프로젝트 주소가 바뀌었습니다. 기존 프로젝트 창을 닫고 다시 여세요.",
};
