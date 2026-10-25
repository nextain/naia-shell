import type { Locale } from "../../../lib/i18n";
import { Logger } from "../../../lib/logger";

Logger.debug(
	"ProjectAgentLocale",
	"loading fixed project agent locale strings",
);

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
	"projects.agentNaiaLoginRequired": "Naia login required.",
	"projects.agentNaiaLoginHint":
		"Sign in to Naia in Settings, then restart OpenCode to use your account.",
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
	"projects.agentClassResetInProgress":
		"Class checkout reset is in progress. Wait for the reset to finish before starting the coding app.",
	"projects.agentInputFailed":
		"Terminal input was not delivered. Start a new session to retry.",
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
	"projects.webviewOpenDashboard": "Open docs",
	"projects.webviewOpenIssues": "Open tasks",
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
	"projects.reloadCatalog": "Reload",
	"projects.reloadingCatalog": "Reloading projects…",
	"projects.docsSectionLabel": "Project documents",
	"projects.docsListLabel": "Document list",
	"projects.docsPreviewLabel": "Document preview",
	"projects.docsRefresh": "Refresh",
	"projects.docsRefreshing": "Refreshing…",
	"projects.docsLoadingList": "Loading project documents…",
	"projects.docsLoadingFile": "Loading document…",
	"projects.docsEmptyTitle": "No documents found",
	"projects.docsEmptyHint":
		"Add Markdown (.md) files under the configured docs_dirs folders in the project checkout, then press Refresh.",
	"projects.docsSelectHint":
		"Select a document from the list to preview its contents.",
	"projects.docsListErrorTitle": "Could not load project documents",
	"projects.docsReadErrorTitle": "Could not read the selected document",
	"projects.docsErrorTooLarge":
		"This document exceeds the 1 MiB preview limit.",
	"projects.docsErrorNotFound":
		"The selected document was not found. Refresh the document list and try again.",
	"projects.docsErrorOutside":
		"The document path is outside the configured docs_dirs folders or uses a symlink.",
	"projects.docsErrorRecovery":
		"Check the project checkout and docs_dirs settings in project.yaml, then press Refresh.",
	"projects.classResetButton": "Reset class",
	"projects.classResetDialogTitle": "Reset class practice files?",
	"projects.classResetDialogStopAgent":
		"Any running coding agent for this project will be stopped first.",
	"projects.classResetDialogBackup":
		"Student work will be backed up to class-backups/…/files/ under the project folder.",
	"projects.classResetDialogRestore":
		"Practice files in the checkout will return to the class start state.",
	"projects.classResetConfirm": "Reset",
	"projects.classResetCancel": "Cancel",
	"projects.classResetting": "Resetting class checkout…",
	"projects.classResetSuccessTitle": "Class checkout reset complete",
	"projects.classResetSuccessDetail":
		"Backed up {count} file(s) to {path}/files.",
	"projects.classResetErrorTitle": "Could not reset the class checkout",
	"projects.classResetErrorNotClass":
		"This project does not have a valid class.baseline_ref setting in project.yaml.",
	"projects.classResetErrorAgentRunning":
		"A coding agent session is still running. Stop the coding agent and try again.",
	"projects.classResetErrorNotGitRepo":
		"The project checkout is not its own Git repository (.git is missing or invalid).",
	"projects.classResetErrorBaselineMissing":
		"The configured class.baseline_ref commit was not found in the checkout repository.",
	"projects.classResetErrorGitUnavailable":
		"Git is not available on PATH. Install Git and try again.",
	"projects.classResetErrorBackupExists":
		"A backup folder for this timestamp already exists. Wait a moment and try again.",
	"projects.classResetErrorBackupFailed":
		"Could not back up current files, so the checkout was left unchanged.",
	"projects.classResetErrorResetFailed":
		"Backup succeeded, but git reset/clean failed in the checkout.",
	"projects.classResetErrorUnknown":
		"Could not reset the class project. Check the project settings and checkout, then try again.",
} as const;

export type ProjectAgentTranslationKey =
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
	"projects.agentNaiaLoginRequired": "Naia 로그인이 필요합니다.",
	"projects.agentNaiaLoginHint":
		"Settings에서 Naia에 로그인한 뒤 OpenCode를 다시 시작하세요.",
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
	"projects.agentClassResetInProgress":
		"수업 체크아웃 초기화가 진행 중입니다. 초기화가 끝난 뒤 코딩 앱을 시작하세요.",
	"projects.agentInputFailed":
		"터미널 입력을 전달하지 못했습니다. 새 세션을 시작해 다시 시도하세요.",
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
	"projects.webviewOpenDashboard": "문서 열기",
	"projects.webviewOpenIssues": "작업 열기",
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
	"projects.reloadCatalog": "다시 읽기",
	"projects.reloadingCatalog": "프로젝트 목록을 다시 읽는 중…",
	"projects.docsSectionLabel": "프로젝트 문서",
	"projects.docsListLabel": "문서 목록",
	"projects.docsPreviewLabel": "문서 미리보기",
	"projects.docsRefresh": "새로 고침",
	"projects.docsRefreshing": "새로 고치는 중…",
	"projects.docsLoadingList": "프로젝트 문서를 불러오는 중…",
	"projects.docsLoadingFile": "문서를 읽는 중…",
	"projects.docsEmptyTitle": "문서가 없습니다",
	"projects.docsEmptyHint":
		"프로젝트 체크아웃의 설정된 docs_dirs 폴더에 마크다운(.md) 파일을 추가한 뒤 새로 고침을 누르세요.",
	"projects.docsSelectHint":
		"목록에서 문서를 선택하면 내용을 미리 볼 수 있습니다.",
	"projects.docsListErrorTitle": "프로젝트 문서 목록을 불러오지 못했습니다",
	"projects.docsReadErrorTitle": "선택한 문서를 읽지 못했습니다",
	"projects.docsErrorTooLarge": "이 문서는 1 MiB 미리보기 제한을 초과합니다.",
	"projects.docsErrorNotFound":
		"선택한 문서를 찾을 수 없습니다. 문서 목록을 새로 고친 뒤 다시 시도하세요.",
	"projects.docsErrorOutside":
		"문서 경로가 설정된 docs_dirs 폴더 바깥이거나 심볼릭 링크를 포함합니다.",
	"projects.docsErrorRecovery":
		"프로젝트 체크아웃과 project.yaml의 docs_dirs 설정을 확인한 뒤 새로 고침을 누르세요.",
	"projects.classResetButton": "수업 초기화",
	"projects.classResetDialogTitle": "수업 실습 파일을 초기화할까요?",
	"projects.classResetDialogStopAgent":
		"실행 중인 코딩 에이전트가 있으면 먼저 중지됩니다.",
	"projects.classResetDialogBackup":
		"작성한 파일은 프로젝트 폴더 아래 class-backups/…/files/ 경로에 백업됩니다.",
	"projects.classResetDialogRestore":
		"실습 체크아웃의 파일이 수업 시작 상태로 돌아갑니다.",
	"projects.classResetConfirm": "초기화",
	"projects.classResetCancel": "취소",
	"projects.classResetting": "수업 체크아웃을 초기화하는 중…",
	"projects.classResetSuccessTitle": "수업 초기화를 완료했습니다",
	"projects.classResetSuccessDetail":
		"{path}/files에 파일 {count}개를 백업했습니다.",
	"projects.classResetErrorTitle": "수업 체크아웃을 초기화하지 못했습니다",
	"projects.classResetErrorNotClass":
		"이 프로젝트의 project.yaml에 올바른 class.baseline_ref 설정이 없습니다.",
	"projects.classResetErrorAgentRunning":
		"코딩 에이전트 세션이 아직 실행 중입니다. 에이전트를 중단한 뒤 다시 시도하세요.",
	"projects.classResetErrorNotGitRepo":
		"프로젝트 체크아웃이 독립된 Git 저장소가 아닙니다(.git 폴더를 확인하세요).",
	"projects.classResetErrorBaselineMissing":
		"설정한 class.baseline_ref 커밋을 체크아웃 저장소에서 찾을 수 없습니다.",
	"projects.classResetErrorGitUnavailable":
		"PATH에서 git 실행 파일을 찾을 수 없습니다. Git을 설치한 뒤 다시 시도하세요.",
	"projects.classResetErrorBackupExists":
		"같은 시각의 백업 폴더가 이미 있습니다. 잠시 후 다시 시도하세요.",
	"projects.classResetErrorBackupFailed":
		"현재 파일을 백업하지 못해 체크아웃을 변경하지 않았습니다.",
	"projects.classResetErrorResetFailed":
		"백업은 완료되었으나 체크아웃을 초기 상태로 되돌리지 못했습니다.",
	"projects.classResetErrorUnknown":
		"수업 프로젝트를 초기화하지 못했습니다. 프로젝트 설정과 체크아웃을 확인한 뒤 다시 시도하세요.",
};

export const PROJECT_AGENT_LOCALE_OVERRIDES: Partial<
	Record<Locale, Record<ProjectAgentTranslationKey, string>>
> = {
	ko: PROJECT_AGENT_KOREAN_TRANSLATIONS,
};
