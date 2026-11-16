import { Logger } from "../../../lib/logger";

Logger.debug("BlackjackLocale", "initializing blackjack studio locale catalog");

export type BlackjackLocale = "ko" | "en";

export interface StepLessonContent {
	step: 1 | 2 | 3 | 4 | 5;
	shortTitle: string;
	title: string;
	missionSummary: string;
	socraticQuestion: string;
	voiceScript: string;
	hints: readonly [string, string, string];
	agentPrompt: string;
}

export const BLACKJACK_ENGLISH_MESSAGES = {
	"bj.appTitle": "Naia Blackjack Coding Studio",
	"bj.appSubtitle":
		"Code 5 core Blackjack rules, verify with the deterministic auto-grader, and play on your live card table.",
	"bj.badgeVersion": "v0.3.0 Studio",
	"bj.mobileTabMission": "1. Mission & Tutor",
	"bj.mobileTabEditor": "2. Code Editor",
	"bj.mobileTabTable": "3. Live Table & Grader",
	"bj.stepProgressLabel": "Mission Progress ({passed}/5 passed)",
	"bj.stepLabel": "Step {step}",
	"bj.stepPassedBadge": "Passed",
	"bj.stepPendingBadge": "In Progress",
	"bj.socraticHeading": "Naia's Guiding Question",
	"bj.speakButton": "Listen to Naia's Explanation",
	"bj.speakActive": "Speaking...",
	"bj.speakStopButton": "Stop Voice",
	"bj.hintLadderTitle": "3-Level Socratic Hint Ladder",
	"bj.hintOpenButton": "Open Hint {level}",
	"bj.hintAllOpened": "All 3 hints opened for this step",
	"bj.hintLevelBadge": "Hint {level}",
	"bj.pedagogyToggle": "5 Teaching Principles Active (Socratic · Hint Ladder · Productive Failure)",
	"bj.askHeading": "Ask Naia Tutor About My Code",
	"bj.askPlaceholder":
		"Ask why a test failed or what edge case to check next...",
	"bj.askSendButton": "Ask Naia",
	"bj.askBusy": "Naia is thinking...",
	"bj.askPresetAce": "Why is my Ace (handValue) test failing?",
	"bj.askPresetNext": "Guide me on the next step with a question.",
	"bj.askPresetEdge": "What edge case am I missing in this step?",
	"bj.tutorReplyTitle": "Naia Tutor Response",
	"bj.tutorFallbackBadge": "Local Socratic Guide",
	"bj.copyAgentPromptButton": "Copy Coding Agent Prompt (OpenCode / Claude / Codex)",
	"bj.copiedNotice": "Copied coding agent prompt to clipboard.",
	"bj.copyFailedNotice": "Clipboard unavailable in this view; select and copy from the editor.",
	"bj.editorTitle": "blackjack-rules.js (CodeMirror 6)",
	"bj.editorShortcutHint": "Shortcut: Ctrl/Cmd + Enter to Run & Grade",
	"bj.runAndGradeButton": "Run Code & Auto-Grade",
	"bj.resetStarterButton": "Restore Starter Code",
	"bj.resetConfirmPrompt": "Replace current editor code with the initial starter scaffold?",
	"bj.resetConfirmYes": "Confirm Restore",
	"bj.resetConfirmCancel": "Cancel",
	"bj.localWorkspaceTitle": "Local Coding Agent Project Sync",
	"bj.provisionButton": "Provision Local Starter Project",
	"bj.syncToLocalButton": "Save Code to Local Project",
	"bj.readLocalButton": "Reload from Local File",
	"bj.openProjectsAppButton": "Open Projects App (OpenCode)",
	"bj.downloadStarterButton": "Download blackjack-rules.js",
	"bj.statusProvisioned":
		"Provisioned local project at {dir} (written: {written}, preserved: {skipped}).",
	"bj.statusSynced": "Saved editor changes to local project ({dir}).",
	"bj.statusReadBack": "Loaded latest blackjack-rules.js from local project.",
	"bj.statusOpenedProjects": "Switched Naia Shell to Projects App.",
	"bj.statusDownloaded": "Prepared blackjack-rules.js download.",
	"bj.statusResetDone": "Restored initial starter code scaffold.",
	"bj.errorDismiss": "Dismiss",
	"bj.errorStandaloneBridge":
		"Local project folder sync requires Naia desktop shell; use Download blackjack-rules.js in standalone browser mode.",
	"bj.tableTitle": "Live Blackjack Table",
	"bj.modeLearner": "Running My Code",
	"bj.modeReference": "Reference Solution Demo",
	"bj.fallbackWarning":
		"Your code threw or was incomplete in [{fns}]; fallback logic kept the table playable.",
	"bj.chipsLabel": "Chips",
	"bj.betLabel": "Current Bet",
	"bj.betPlus10": "+10",
	"bj.betPlus50": "+50",
	"bj.betPlus100": "+100",
	"bj.betReset": "Reset Bet",
	"bj.dealButton": "Deal Cards",
	"bj.hitButton": "Hit",
	"bj.standButton": "Stand",
	"bj.newRoundButton": "New Round",
	"bj.dealerHandLabel": "Dealer Hand",
	"bj.playerHandLabel": "Player Hand",
	"bj.hiddenTotal": "? (Hole Card Hidden)",
	"bj.phaseBetting": "Choose your bet and press Deal Cards to start.",
	"bj.phasePlayerTurn": "Your turn: Hit for another card or Stand to hold.",
	"bj.outcome.blackjack": "Natural Blackjack! 2.5x payout (+{payout} chips returned)",
	"bj.outcome.win": "You Win! 2x payout (+{payout} chips returned)",
	"bj.outcome.push": "Push (Tie)! Principal returned ({payout} chips)",
	"bj.outcome.lose": "Dealer Wins! Try another hand.",
	"bj.outcome.bust": "Bust (Over 21)! Dealer takes the round.",
	"bj.graderTitle": "Automated 5-Step Mission Grader",
	"bj.graderSummary": "{passedChecks}/{totalChecks} unit checks passed ({passedSteps}/5 steps complete)",
	"bj.graderCompileError": "Syntax / Compile Error: {error}",
	"bj.checkPass": "PASS",
	"bj.checkFail": "CHECK",
	"bj.gradeCheck.s1_count": "Step 1.1: createDeck() returns 52 cards",
	"bj.gradeCheck.s1_unique": "Step 1.2: Deck has all 4 suits x 13 unique ranks",
	"bj.gradeCheck.s1_values": "Step 1.3: Base card points map A=11, 2-10=face, J/Q/K=10",
	"bj.gradeCheck.s2_basic": "Step 2.1: handValue() sums number and face cards accurately",
	"bj.gradeCheck.s2_ace11": "Step 2.2: handValue() counts Ace as 11 when total <= 21",
	"bj.gradeCheck.s2_ace1": "Step 2.3: handValue() adjusts Ace from 11 to 1 when total > 21",
	"bj.gradeCheck.s2_canHit": "Step 2.4: canPlayerHit() is true below 21 and false at 21+",
	"bj.gradeCheck.s3_hit16": "Step 3.1: shouldDealerHit() returns true at 16 or below",
	"bj.gradeCheck.s3_stand17": "Step 3.2: shouldDealerHit() returns false at 17 or above",
	"bj.gradeCheck.s4_bust": "Step 4.1: judgeOutcome() returns 'bust' when player > 21",
	"bj.gradeCheck.s4_natural": "Step 4.2: judgeOutcome() detects 2-card 21 'blackjack' vs 3-card 21 & mutual natural push",
	"bj.gradeCheck.s4_dealerBust": "Step 4.3: judgeOutcome() returns 'win' when dealer busts (> 21)",
	"bj.gradeCheck.s4_compare": "Step 4.4: judgeOutcome() compares totals for 'win', 'lose', and 'push'",
	"bj.gradeCheck.s5_bjPayout": "Step 5.1: settleChips() returns 2.5x total on 'blackjack'",
	"bj.gradeCheck.s5_winPayout": "Step 5.2: settleChips() returns 2x total on 'win'",
	"bj.gradeCheck.s5_pushLose": "Step 5.3: settleChips() returns 1x bet on 'push' and 0 on 'lose'/'bust'",
} as const;

export type BlackjackMessageKey = keyof typeof BLACKJACK_ENGLISH_MESSAGES;

export const BLACKJACK_KOREAN_MESSAGES: Record<BlackjackMessageKey, string> = {
	"bj.appTitle": "나이아 블랙잭 실습 스튜디오",
	"bj.appSubtitle":
		"5단계 블랙잭 핵심 규칙을 직접 코딩하고 자동 채점으로 검증하며, 내 코드로 움직이는 카드 테이블과 나이아 튜터로 완성하세요.",
	"bj.badgeVersion": "v0.3.0 일체형 스튜디오",
	"bj.mobileTabMission": "1. 미션·나이아 튜터",
	"bj.mobileTabEditor": "2. 코드 편집기",
	"bj.mobileTabTable": "3. 실전 테이블·채점",
	"bj.stepProgressLabel": "5단계 미션 달성도 ({passed}/5 완료)",
	"bj.stepLabel": "{step}단계",
	"bj.stepPassedBadge": "통과",
	"bj.stepPendingBadge": "도전 중",
	"bj.socraticHeading": "나이아의 소크라테스식 핵심 질문",
	"bj.speakButton": "나이아 음성 설명 듣기",
	"bj.speakActive": "음성 설명 중...",
	"bj.speakStopButton": "중지",
	"bj.hintLadderTitle": "3단계 힌트 사다리 (막힐 때 한 칸씩 열기)",
	"bj.hintOpenButton": "힌트 {level} 열기",
	"bj.hintAllOpened": "이 단계의 3단계 힌트를 모두 열었습니다",
	"bj.hintLevelBadge": "힌트 {level}",
	"bj.pedagogyToggle": "5대 교수법 적용 중 (소크라테스 질문 · 힌트 사다리 · 생산적 실패)",
	"bj.askHeading": "내 코드를 나이아에게 질문하기",
	"bj.askPlaceholder":
		"막힌 부분이나 실패한 테스트 이유를 직접 적어 나이아에게 물어보세요...",
	"bj.askSendButton": "나이아에게 질문",
	"bj.askBusy": "나이아가 코드를 살피는 중...",
	"bj.askPresetAce": "왜 에이스 계산 테스트가 실패할까요?",
	"bj.askPresetNext": "다음 단계 힌트를 질문으로 이끌어 주세요",
	"bj.askPresetEdge": "지금 단계에서 놓치기 쉬운 예외 조건은 무엇인가요?",
	"bj.tutorReplyTitle": "나이아 튜터의 답변",
	"bj.tutorFallbackBadge": "소크라테스 로컬 가이드",
	"bj.copyAgentPromptButton": "코딩 에이전트(OpenCode/Claude/Codex) 프롬프트 복사",
	"bj.copiedNotice": "코딩 에이전트용 소크라테스 실습 프롬프트를 클립보드에 복사했습니다.",
	"bj.copyFailedNotice": "클립보드 권한을 사용할 수 없어 에디터에서 직접 복사해 주세요.",
	"bj.editorTitle": "blackjack-rules.js 코드 편집기 (CodeMirror 6)",
	"bj.editorShortcutHint": "단축키: Ctrl/Cmd + Enter 로 즉시 실행·자동 채점",
	"bj.runAndGradeButton": "코드 실행 & 자동 채점",
	"bj.resetStarterButton": "단계 기본 코드 복원",
	"bj.resetConfirmPrompt": "현재 작성한 코드를 초기 스타터 기본 코드로 되돌릴까요?",
	"bj.resetConfirmYes": "복원 확인",
	"bj.resetConfirmCancel": "취소",
	"bj.localWorkspaceTitle": "로컬 실습 프로젝트 연동 (OpenCode · 터미널)",
	"bj.provisionButton": "로컬 실습 프로젝트 세팅",
	"bj.syncToLocalButton": "로컬 파일에 저장",
	"bj.readLocalButton": "로컬 파일 불러오기",
	"bj.openProjectsAppButton": "프로젝트 앱(OpenCode) 열기",
	"bj.downloadStarterButton": "스타터 파일 다운로드",
	"bj.statusProvisioned":
		"로컬 실습 프로젝트를 준비했습니다: {dir} (생성 {written}개, 기존 보존 {skipped}개)",
	"bj.statusSynced": "편집기 코드를 로컬 프로젝트({dir})에 저장했습니다.",
	"bj.statusReadBack": "로컬 프로젝트의 최신 blackjack-rules.js 파일을 불러와 반영했습니다.",
	"bj.statusOpenedProjects": "나이아 프로젝트 앱(OpenCode) 화면으로 전환했습니다.",
	"bj.statusDownloaded": "blackjack-rules.js 파일을 내려받았습니다.",
	"bj.statusResetDone": "초기 스타터 기본 코드를 복원했습니다.",
	"bj.errorDismiss": "닫기",
	"bj.errorStandaloneBridge":
		"로컬 프로젝트 자동 세팅은 나이아 데스크톱 셸에서 동작합니다. 브라우저 단독 실행에서는 [스타터 파일 다운로드]를 이용해 주세요.",
	"bj.tableTitle": "실시간 블랙잭 카드 테이블",
	"bj.modeLearner": "내 코드로 실행 중",
	"bj.modeReference": "완성 기준본 체험",
	"bj.fallbackWarning":
		"내 코드의 [{fns}] 동작이 아직 미완성이거나 오류가 발생해 안전 폴백 규칙으로 테이블을 이어갑니다.",
	"bj.chipsLabel": "보유 칩",
	"bj.betLabel": "이번 판 베팅",
	"bj.betPlus10": "+10",
	"bj.betPlus50": "+50",
	"bj.betPlus100": "+100",
	"bj.betReset": "초기화",
	"bj.dealButton": "카드 배분(Deal)",
	"bj.hitButton": "카드 더 받기(Hit)",
	"bj.standButton": "멈추기(Stand)",
	"bj.newRoundButton": "새 판",
	"bj.dealerHandLabel": "딜러 패",
	"bj.playerHandLabel": "플레이어 패",
	"bj.hiddenTotal": "? (첫 카드 비공개)",
	"bj.phaseBetting": "베팅 칩을 고른 뒤 [카드 배분(Deal)]을 눌러 한 판을 시작하세요.",
	"bj.phasePlayerTurn": "내 차례입니다: [카드 더 받기(Hit)] 또는 [멈추기(Stand)]를 선택하세요.",
	"bj.outcome.blackjack": "내추럴 블랙잭! 2.5배 배당 정산 (총 +{payout}칩 반환)",
	"bj.outcome.win": "승리! 2배 배당 정산 (총 +{payout}칩 반환)",
	"bj.outcome.push": "무승부(Push)! 베팅 원금 반환 ({payout}칩)",
	"bj.outcome.lose": "딜러 승리! 다음 판을 노려 보세요.",
	"bj.outcome.bust": "버스트(21 초과)! 아쉬운 패배입니다.",
	"bj.graderTitle": "5단계 미션 자동 채점기",
	"bj.graderSummary": "단위 검증 {passedChecks}/{totalChecks} 통과 (미션 {passedSteps}/5 단계 완료)",
	"bj.graderCompileError": "코드 문법·실행 오류: {error}",
	"bj.checkPass": "통과",
	"bj.checkFail": "점검",
	"bj.gradeCheck.s1_count": "Step 1-1: createDeck()이 정확히 52장 배열을 반환하는가",
	"bj.gradeCheck.s1_unique": "Step 1-2: 4문양(♠♥♦♣) × 13랭크 중복 없는 52장인가",
	"bj.gradeCheck.s1_values": "Step 1-3: 카드 기본 점수가 A=11, 2~10=숫자, J/Q/K=10으로 매핑되는가",
	"bj.gradeCheck.s2_basic": "Step 2-1: handValue()가 숫자·그림 카드 합계를 정확히 계산하는가",
	"bj.gradeCheck.s2_ace11": "Step 2-2: 21 이하일 때 에이스(A)를 11점으로 계산하는가",
	"bj.gradeCheck.s2_ace1": "Step 2-3: 21 초과 시 에이스(A)를 11점에서 1점으로 유연하게 조정하는가",
	"bj.gradeCheck.s2_canHit": "Step 2-4: canPlayerHit()이 21 미만에서만 true, 21 이상이면 false인가",
	"bj.gradeCheck.s3_hit16": "Step 3-1: shouldDealerHit()이 딜러 합계 16 이하에서 true를 반환하는가",
	"bj.gradeCheck.s3_stand17": "Step 3-2: shouldDealerHit()이 딜러 합계 17 이상에서 false(Stand)를 반환하는가",
	"bj.gradeCheck.s4_bust": "Step 4-1: 플레이어 합계가 21을 넘으면 즉시 'bust'로 판정하는가",
	"bj.gradeCheck.s4_natural": "Step 4-2: 첫 2장 21점 내추럴 'blackjack'과 3장 21점·동시 블랙잭('push')을 구분하는가",
	"bj.gradeCheck.s4_dealerBust": "Step 4-3: 딜러가 21점을 넘으면 플레이어 'win'으로 판정하는가",
	"bj.gradeCheck.s4_compare": "Step 4-4: 양쪽 점수 비교로 'win' / 'lose' / 'push'를 정확히 가리는가",
	"bj.gradeCheck.s5_bjPayout": "Step 5-1: 내추럴 'blackjack'일 때 베팅액의 2.5배(원금+1.5배)를 반환하는가",
	"bj.gradeCheck.s5_winPayout": "Step 5-2: 일반 'win'일 때 베팅액의 2배를 반환하는가",
	"bj.gradeCheck.s5_pushLose": "Step 5-3: 'push'는 원금 그대로, 'lose'/'bust'는 0을 반환하는가",
};

const BLACKJACK_MESSAGES_BY_LOCALE: Record<
	string,
	Record<BlackjackMessageKey, string>
> = {
	en: BLACKJACK_ENGLISH_MESSAGES,
	ko: BLACKJACK_KOREAN_MESSAGES,
	de: BLACKJACK_ENGLISH_MESSAGES,
	es: BLACKJACK_ENGLISH_MESSAGES,
	fr: BLACKJACK_ENGLISH_MESSAGES,
	hi: BLACKJACK_ENGLISH_MESSAGES,
	id: BLACKJACK_ENGLISH_MESSAGES,
	ja: BLACKJACK_ENGLISH_MESSAGES,
	pt: BLACKJACK_ENGLISH_MESSAGES,
	ru: BLACKJACK_ENGLISH_MESSAGES,
	vi: BLACKJACK_ENGLISH_MESSAGES,
	zh: BLACKJACK_ENGLISH_MESSAGES,
};

export function resolveBlackjackLocale(rawLang?: string): BlackjackLocale {
	const candidate = (
		rawLang ?? (typeof navigator !== "undefined" ? navigator.language : "ko")
	)
		.trim()
		.toLowerCase();
	const prefix = candidate.split("-")[0];
	if (prefix === "ko") return "ko";
	if (prefix && prefix in BLACKJACK_MESSAGES_BY_LOCALE) return "en";
	return "en";
}

export function blackjackText(
	key: BlackjackMessageKey,
	params?: Readonly<Record<string, string | number>>,
	localeOverride?: string,
): string {
	const lang = resolveBlackjackLocale(localeOverride);
	const table =
		lang === "ko" ? BLACKJACK_KOREAN_MESSAGES : BLACKJACK_ENGLISH_MESSAGES;
	const template = table[key] ?? BLACKJACK_ENGLISH_MESSAGES[key];
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (whole, name) =>
		Object.prototype.hasOwnProperty.call(params, name)
			? String(params[name])
			: whole,
	);
}

const STEP_CURRICULUM_KO: readonly StepLessonContent[] = [
	{
		step: 1,
		shortTitle: "1. 덱 생성",
		title: "Step 1: 52장 표준 카드 덱 생성 (createDeck)",
		missionSummary:
			"4가지 문양(♠, ♥, ♦, ♣)과 13가지 랭크(A, 2~10, J, Q, K)를 조합해 52장 카드 객체 배열과 기본 점수(A=11, J/Q/K=10)를 완성합니다.",
		socraticQuestion:
			"지금 스타터 코드의 createDeck()을 실행하면 왜 52장이 아니라 26장만 만들어질까요? 중첩 반복문의 바깥 배열과 안쪽 배열 크기가 전체 카드 장수를 어떻게 결정하는지 살펴볼까요?",
		voiceScript:
			"1단계 미션은 카드 한 벌, 52장을 만드는 createDeck 함수입니다. 지금은 문양 배열에 스페이드와 하트 두 개만 들어 있어서 26장만 생성됩니다. 다이아몬드와 클로버까지 네 문양을 모두 채우면 4 곱하기 13, 52장이 완성됩니다. 에이스는 11점, 그림 카드는 10점으로 매핑되었는지도 함께 확인해 보세요.",
		hints: [
			"방향 힌트: createDeck() 안의 suits 배열에 몇 개의 문양이 들어 있는지 확인해 보세요.",
			"개념 힌트: 4개의 문양(♠, ♥, ♦, ♣) × 13개의 랭크가 이중 for-of 문을 돌면 총 52개의 { suit, rank, value } 카드가 만들어집니다.",
			"유사 예제: const suits = [\"♠\", \"♥\", \"♦\", \"♣\"]; 처럼 네 문양을 모두 넣은 뒤 [코드 실행 & 자동 채점]을 눌러 보세요.",
		],
		agentPrompt:
			"blackjack-rules.js의 Step 1(createDeck)을 보고 있어. 정답 코드를 바로 덮어쓰지 말고, 왜 지금 26장만 생성되는지 소크라테스식 질문으로 내가 스스로 찾도록 이끌어 줘.",
	},
	{
		step: 2,
		shortTitle: "2. 에이스 합계",
		title: "Step 2: 패 합계·에이스 유연 계산 & Hit 조건 (handValue, canPlayerHit)",
		missionSummary:
			"에이스(A)를 기본 11점으로 더하되 합계가 21점을 넘으면 에이스 개수만큼 10점씩 차감해 1점으로 바꾸고, 합계가 21 미만일 때만 Hit이 가능하도록 구현합니다.",
		socraticQuestion:
			"패에 에이스 두 장과 9가 들어오면(A, A, 9) 둘 다 11점으로 계산할 때 31점이 됩니다. 에이스 한 장만 1점으로 바꾸려면 총점에서 몇 점을 빼야 하고, 에이스가 여러 장일 때는 if와 while 중 무엇이 안전할까요?",
		voiceScript:
			"2단계는 블랙잭 규칙의 꽃인 에이스 유연 계산입니다. 처음에 에이스를 11점으로 더해 두었다가, 합계가 21을 넘고 아직 11점으로 센 에이스가 남아 있다면 10점을 빼서 1점으로 조정해 보세요. 에이스가 두 장 이상일 수도 있으니 반복 조건을 생각해보고, canPlayerHit은 합계가 21 미만일 때만 참이 되게 만들어 보세요.",
		hints: [
			"방향 힌트: handValue()에서 aces 변수에 에이스 개수를 세어 두었습니다. return 직전에 total > 21 인 경우를 처리하는 반복문을 넣어 보세요.",
			"개념 힌트: 11점으로 더한 에이스 한 장을 1점으로 바꾼다는 것은 total -= 10을 하고 남은 aces 개수를 1 줄인다는 뜻입니다.",
			"유사 예제: while (total > 21 && aces > 0) { total -= 10; aces -= 1; } 로 조정하고, canPlayerHit(cards)에서는 return handValue(cards) < 21; 을 반환해 보세요.",
		],
		agentPrompt:
			"blackjack-rules.js의 Step 2(handValue, canPlayerHit)에서 에이스(A) 유연 계산과 Hit 가능 조건을 구현 중이야. 에이스가 2장 이상일 때 왜 while 반복문이 필요한지 질문으로 설명해 줘.",
	},
	{
		step: 3,
		shortTitle: "3. 딜러 17 규칙",
		title: "Step 3: 딜러 의무 히트·스탠드 규칙 (shouldDealerHit)",
		missionSummary:
			"플레이어가 멈춘 뒤 딜러는 자신의 패 합계가 16 이하이면 무조건 카드를 더 뽑고(true), 17 이상이면 멈추도록(false) 구현합니다.",
		socraticQuestion:
			"플레이어는 원할 때 멈출 수 있지만 딜러는 정해진 숫자 규칙을 따릅니다. 딜러 합계가 딱 17점일 때 카드를 더 뽑아야 할까요, 멈춰야 할까요? 부등호(< 와 <=) 차이가 결과를 어떻게 바꿀까요?",
		voiceScript:
			"3단계는 딜러의 자동 진행 규칙인 shouldDealerHit 함수입니다. 카지노 표준 규칙에서 딜러는 16점 이하일 때 반드시 카드를 한 장 더 뽑고, 17점 이상이 되면 멈춥니다. 앞서 만든 handValue 함수를 재활용해 조건식 한 줄로 깔끔하게 표현해 보세요.",
		hints: [
			"방향 힌트: shouldDealerHit(dealerCards) 안에서 방금 완성한 handValue(dealerCards) 함수를 호출해 딜러의 점수를 구해 보세요.",
			"개념 힌트: 16점 이하(<= 16)는 정수 점수에서 17점 미만(< 17)과 같습니다. 17점일 때는 false가 나와야 합니다.",
			"유사 예제: return handValue(dealerCards) < 17; 한 줄이면 16 이하에서 true, 17 이상에서 false가 반환됩니다.",
		],
		agentPrompt:
			"blackjack-rules.js의 Step 3(shouldDealerHit)을 작성하고 있어. 딜러 합계가 16점일 때와 17점일 때 경계값 테스트를 어떻게 생각하면 좋을지 힌트를 줘.",
	},
	{
		step: 4,
		shortTitle: "4. 승패 판정",
		title: "Step 4: 내추럴 블랙잭·버스트·승무패 판정 (judgeOutcome)",
		missionSummary:
			"처음 받은 2장으로 21점을 만든 내추럴 블랙잭('blackjack')과 3장 이상으로 만든 21점을 구분하고, 버스트('bust'), 일반 승리('win'), 패배('lose'), 무승부('push')를 판정합니다.",
		socraticQuestion:
			"플레이어가 7 세 장(7+7+7=21)을 모은 경우와 첫 두 장(A+K=21)으로 21점을 만든 경우는 왜 다르게 판정해야 할까요? 그리고 플레이어와 딜러가 둘 다 첫 2장 블랙잭이면 누구의 승리일까요?",
		voiceScript:
			"4단계는 승패를 가리는 judgeOutcome 함수입니다. 가장 먼저 플레이어가 21점을 넘었는지 버스트부터 확인하고, 다음으로 카드 장수가 정확히 2장이면서 21점인 내추럴 블랙잭인지 살펴보세요. 만약 딜러도 동시에 2장 21점이면 무승부 푸시이고, 플레이어만 내추럴 블랙잭이면 블랙잭 승리입니다.",
		hints: [
			"방향 힌트: 내추럴 블랙잭 조건은 cards.length === 2 && score === 21 입니다. 플레이어와 딜러 각각 변수로 먼저 구해 보세요.",
			"개념 힌트: 판정 순서가 중요합니다! ① 플레이어 > 21 이면 'bust' → ② 양쪽 모두 내추럴이면 'push', 플레이어만 내추럴이면 'blackjack', 딜러만 내추럴이면 'lose' → ③ 딜러 > 21 이면 'win' → ④ 점수 비교('win' / 'lose' / 'push').",
			"유사 예제: const pNatural = playerCards.length === 2 && playerScore === 21; const dNatural = dealerCards.length === 2 && dealerScore === 21; 로 나눈 뒤 차례대로 분기해 보세요.",
		],
		agentPrompt:
			"blackjack-rules.js의 Step 4(judgeOutcome)를 구현 중이야. 버스트, 내추럴 블랙잭, 딜러 버스트, 동점(push) 판정 순서를 내가 빠뜨리지 않게 질문으로 점검해 줘.",
	},
	{
		step: 5,
		shortTitle: "5. 배당 정산",
		title: "Step 5: 칩 베팅 & 1.5배 블랙잭 배당 정산 (settleChips)",
		missionSummary:
			"베팅한 칩(bet)과 판정 결과(outcome)를 받아 플레이어에게 돌려줄 총 칩 수(블랙잭 2.5배, 일반 승리 2배, 무승부 1배 원금, 패배·버스트 0)를 계산합니다.",
		socraticQuestion:
			"이미 라운드 시작 때 보유 칩에서 베팅금 100칩을 테이블 위에 올려두었습니다. 일반 승리 때 100칩 이득을 보려면 테이블에서 총 몇 칩을 돌려받아야 하고, 1.5배 보너스를 주는 내추럴 블랙잭일 때는 총 몇 칩을 돌려받아야 할까요?",
		voiceScript:
			"마지막 5단계는 칩 배당을 정산하는 settleChips 함수입니다. 이미 베팅할 때 원금이 빠져나갔으므로, 돌려받는 총액에는 원금이 포함되어야 합니다. 무승부 푸시는 원금 1배 그대로, 일반 승리는 2배, 내추럴 블랙잭은 원금 더하기 1.5배인 2.5배를 Math.floor로 깔끔하게 반환해 보세요!",
		hints: [
			"방향 힌트: settleChips(bet, outcome)이 반환하는 값은 순수익이 아니라 테이블에서 플레이어 손으로 돌아오는 '원금 포함 총 반환 칩'입니다.",
			"개념 힌트: bet이 100일 때 'blackjack'은 250(원금 100 + 보너스 150), 'win'은 200, 'push'는 100, 'lose'나 'bust'는 0이 되어야 합니다.",
			"유사 예제: if (outcome === \"blackjack\") return Math.floor(bet * 2.5); if (outcome === \"win\") return bet * 2; if (outcome === \"push\") return bet; return 0;",
		],
		agentPrompt:
			"blackjack-rules.js의 Step 5(settleChips)를 마무리하고 있어. 베팅 원금이 이미 차감된 상태에서 왜 블랙잭 반환액이 1.5배가 아니라 2.5배인지 확인 질문을 던져 줘.",
	},
];

const STEP_CURRICULUM_EN: readonly StepLessonContent[] = [
	{
		step: 1,
		shortTitle: "1. Build Deck",
		title: "Step 1: Generate a 52-Card Deck (createDeck)",
		missionSummary:
			"Combine all 4 suits (♠, ♥, ♦, ♣) and 13 ranks (A, 2-10, J, Q, K) into 52 card objects with base values (A=11, J/Q/K=10).",
		socraticQuestion:
			"When you run the starter createDeck() right now, why does it produce 26 cards instead of 52? How do the outer suits array and inner ranks array determine the deck size?",
		voiceScript:
			"Step one builds your 52-card deck in createDeck. Right now the suits array only lists spades and hearts, producing 26 cards. Add diamonds and clubs so 4 suits times 13 ranks gives all 52 cards, keeping Aces at 11 and face cards at 10.",
		hints: [
			"Direction Hint: Inspect how many symbols are inside the suits array in createDeck().",
			"Concept Hint: Iterating over 4 suits (♠, ♥, ♦, ♣) and 13 ranks produces 4 x 13 = 52 unique { suit, rank, value } objects.",
			"Pattern Hint: Update suits to [\"♠\", \"♥\", \"♦\", \"♣\"] and press Run Code & Auto-Grade.",
		],
		agentPrompt:
			"I am working on Step 1 (createDeck) in blackjack-rules.js. Do not give me the finished code directly; ask me a Socratic question about why my deck currently has 26 cards.",
	},
	{
		step: 2,
		shortTitle: "2. Ace Totals",
		title: "Step 2: Flexible Ace Totals & Hit Rule (handValue, canPlayerHit)",
		missionSummary:
			"Count Aces as 11 first, downgrade Aces by 10 each while the hand exceeds 21, and allow hitting only while total < 21.",
		socraticQuestion:
			"If a hand holds (A, A, 9), counting both Aces as 11 gives 31. How many points do you subtract to turn one Ace from 11 into 1, and why is a while loop safer than a single if statement?",
		voiceScript:
			"Step two implements flexible Ace scoring in handValue and hit eligibility in canPlayerHit. Start with Aces at 11, then while the total is over 21 and you still have unadjusted Aces, subtract 10 and decrement your Ace count. Finally, allow hitting only below 21.",
		hints: [
			"Direction Hint: Look at the aces counter in handValue(cards) right before return total.",
			"Concept Hint: Converting one Ace from 11 down to 1 subtracts 10 from total and decrements aces by 1.",
			"Pattern Hint: Use while (total > 21 && aces > 0) { total -= 10; aces -= 1; } and in canPlayerHit return handValue(cards) < 21;",
		],
		agentPrompt:
			"I am working on Step 2 (handValue, canPlayerHit) in blackjack-rules.js. Guide me with questions on handling multiple Aces without busting.",
	},
	{
		step: 3,
		shortTitle: "3. Dealer 17",
		title: "Step 3: Dealer Stand-on-17 Rule (shouldDealerHit)",
		missionSummary:
			"Make the dealer hit when the dealer hand total is 16 or lower, and stand once the total reaches 17 or higher.",
		socraticQuestion:
			"Unlike the player, the dealer follows a strict threshold. When the dealer's hand equals exactly 17, should shouldDealerHit return true or false?",
		voiceScript:
			"Step three encodes the casino dealer rule in shouldDealerHit. Reuse your handValue function: if the dealer has 16 or less, return true to hit; at 17 or above, return false to stand.",
		hints: [
			"Direction Hint: Call handValue(dealerCards) inside shouldDealerHit(dealerCards).",
			"Concept Hint: Hitting on 16 or less is equivalent to total < 17 for integer card totals.",
			"Pattern Hint: Return handValue(dealerCards) < 17;",
		],
		agentPrompt:
			"I am implementing Step 3 (shouldDealerHit) in blackjack-rules.js. Help me verify the boundary between 16 and 17.",
	},
	{
		step: 4,
		shortTitle: "4. Judge Outcome",
		title: "Step 4: Natural Blackjack, Bust & Winner (judgeOutcome)",
		missionSummary:
			"Distinguish a 2-card 21 ('blackjack') from a 3-card 21, handle player/dealer busts, and return 'win', 'lose', or 'push'.",
		socraticQuestion:
			"Why is a 2-card (A + K) 21 treated differently from a 3-card (7 + 7 + 7) 21, and what should happen if both player and dealer open with a 2-card 21?",
		voiceScript:
			"Step four judges the round outcome. Check player bust first, then check whether either side has a natural two-card 21. Mutual naturals push, a solo player natural returns blackjack, dealer bust returns win, and otherwise compare scores.",
		hints: [
			"Direction Hint: Check playerCards.length === 2 && playerScore === 21 for a natural Blackjack.",
			"Concept Hint: Order matters: (1) player > 21 -> 'bust', (2) naturals -> mutual 'push', player 'blackjack', dealer 'lose', (3) dealer > 21 -> 'win', (4) compare totals.",
			"Pattern Hint: Add dealerScore > 21 -> 'win' and playerScore === dealerScore -> 'push' after handling natural 21s.",
		],
		agentPrompt:
			"I am working on Step 4 (judgeOutcome) in blackjack-rules.js. Walk me through the decision order for bust, natural blackjack, and push.",
	},
	{
		step: 5,
		shortTitle: "5. Chip Payouts",
		title: "Step 5: Bet Settlement & 3:2 Blackjack Bonus (settleChips)",
		missionSummary:
			"Calculate total chips returned to the player's stack: 2.5x on 'blackjack', 2x on 'win', 1x on 'push', and 0 on 'lose' or 'bust'.",
		socraticQuestion:
			"Because the player's bet was already deducted from their stack when dealing, how many total chips should come back on a 100-chip tie ('push') versus a 3:2 natural 'blackjack'?",
		voiceScript:
			"Step five settles chips at the end of a hand. Since the bet was already placed on the felt, push returns 1x principal, regular win returns 2x, natural blackjack returns 2.5x using Math.floor, and losses return zero.",
		hints: [
			"Direction Hint: settleChips(bet, outcome) returns the total chips handed back to the player (principal + profit).",
			"Concept Hint: For bet = 100, 'blackjack' returns 250, 'win' returns 200, 'push' returns 100, and 'lose'/'bust' return 0.",
			"Pattern Hint: Handle 'blackjack' with Math.floor(bet * 2.5) and 'push' with bet alongside 'win' -> bet * 2.",
		],
		agentPrompt:
			"I am finishing Step 5 (settleChips) in blackjack-rules.js. Ask me a quick check question to confirm my 2.5x natural blackjack payout math.",
	},
];

export const TEACHING_STYLE_KO = [
	"1) 소크라테스식 대화: 정답 코드를 바로 주지 말고 질문으로 먼저 생각하게 이끄세요.",
	"2) 힌트 사다리: 방향 힌트 → 개념 힌트 → 유사 예제 순서로 한 단계씩만 도우세요.",
	"3) 생산적 실패: 실패한 테스트를 실수가 아닌 단서로 읽도록 격려하세요.",
	"4) 오개념 교정: 표면 문법보다 에이스 조정·내추럴 조건 뒤의 원리를 짚어 주세요.",
	"5) 과정 칭찬: 과장된 칭찬 대신 조건 분기·경계값 확인 같은 구체적 시도를 인정하세요.",
].join("\n");

export const TEACHING_STYLE_EN = [
	"1) Socratic Dialogue: Ask a guiding question first instead of handing out the finished code.",
	"2) Hint Ladder: Progress gradually from direction hint -> concept hint -> analogous snippet.",
	"3) Productive Failure: Treat failing unit checks as diagnostic clues to explore.",
	"4) Misconception Correction: Address mental models (flexible Ace, 2-card natural) rather than surface syntax.",
	"5) Process Praise: Acknowledge specific reasoning steps without exaggerated praise.",
].join("\n");

export const STARTER_CODE_KO = `// 나이아 블랙잭 5단계 실습 규칙 파일 (blackjack-rules.js)
// 각 단계의 TODO를 완성한 뒤 [코드 실행 & 자동 채점]을 눌러 보세요!

// [Step 1] 4문양(♠, ♥, ♦, ♣) × 13랭크 = 52장 카드 덱 만들기
function createDeck() {
  // TODO(Step 1): 지금은 문양이 2개뿐이라 26장만 만들어집니다. ♦와 ♣를 추가해 52장을 완성하세요!
  const suits = ["♠", "♥"];
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const deck = [];

  for (const suit of suits) {
    for (const rank of ranks) {
      const value =
        rank === "A"
          ? 11
          : rank === "J" || rank === "Q" || rank === "K"
            ? 10
            : Number(rank);
      deck.push({ suit, rank, value });
    }
  }
  return deck;
}

// [Step 2] 패 합계 & 에이스(A) 유연 계산 + Hit 가능 조건
function handValue(cards) {
  let total = 0;
  let aces = 0;

  for (const card of cards) {
    if (card.rank === "A") {
      aces += 1;
      total += 11;
    } else if (card.rank === "J" || card.rank === "Q" || card.rank === "K") {
      total += 10;
    } else {
      total += Number(card.rank);
    }
  }

  // TODO(Step 2): total이 21을 넘고 aces가 남아 있는 동안 total에서 10을 빼고 aces를 1 줄이세요!
  return total;
}

function canPlayerHit(cards) {
  // TODO(Step 2): 패 합계(handValue(cards))가 21 미만일 때만 true를 반환하세요!
  return cards.length >= 0;
}

// [Step 3] 딜러 17 규칙 (16 이하면 Hit, 17 이상이면 Stand)
function shouldDealerHit(dealerCards) {
  // TODO(Step 3): 딜러 합계가 17 미만이면 true, 17 이상이면 false를 반환하세요!
  return false;
}

// [Step 3~4 연결] 승패 및 내추럴 블랙잭 판정 ("blackjack" | "win" | "lose" | "push" | "bust")
function judgeOutcome(playerCards, dealerCards) {
  const playerScore = handValue(playerCards);
  const dealerScore = handValue(dealerCards);

  if (playerScore > 21) {
    return "bust";
  }

  // TODO(Step 4):
  // 1) 첫 2장으로 21점인 내추럴 블랙잭 여부를 확인하세요 (양쪽 모두 내추럴이면 "push", 플레이어만 내추럴이면 "blackjack", 딜러만 내추럴이면 "lose").
  // 2) 딜러가 21점을 초과하면 "win", 점수가 같으면 "push"를 반환하세요.
  if (playerScore > dealerScore) {
    return "win";
  }
  return "lose";
}

// [Step 5] 칩 베팅 배당 정산 (반환 총액 계산)
function settleChips(bet, outcome) {
  // TODO(Step 5):
  // - "blackjack": 원금 + 1.5배 보너스 = Math.floor(bet * 2.5)
  // - "win": 원금의 2배 = bet * 2
  // - "push": 원금 그대로 = bet
  // - "lose" 또는 "bust": 0
  if (outcome === "win") {
    return bet * 2;
  }
  return 0;
}
`;

export const STARTER_CODE_EN = `// Naia Blackjack 5-Step Studio Rules (blackjack-rules.js)
// Complete each TODO mission and click [Run Code & Auto-Grade]!

// [Step 1] Create a 52-card deck (4 suits x 13 ranks)
function createDeck() {
  // TODO(Step 1): Add "♦" and "♣" so all 4 suits x 13 ranks = 52 cards are created!
  const suits = ["♠", "♥"];
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const deck = [];

  for (const suit of suits) {
    for (const rank of ranks) {
      const value =
        rank === "A"
          ? 11
          : rank === "J" || rank === "Q" || rank === "K"
            ? 10
            : Number(rank);
      deck.push({ suit, rank, value });
    }
  }
  return deck;
}

// [Step 2] Hand total with flexible Ace adjustment + Hit eligibility
function handValue(cards) {
  let total = 0;
  let aces = 0;

  for (const card of cards) {
    if (card.rank === "A") {
      aces += 1;
      total += 11;
    } else if (card.rank === "J" || card.rank === "Q" || card.rank === "K") {
      total += 10;
    } else {
      total += Number(card.rank);
    }
  }

  // TODO(Step 2): While total > 21 and aces > 0, subtract 10 from total and decrement aces!
  return total;
}

function canPlayerHit(cards) {
  // TODO(Step 2): Return true only when handValue(cards) < 21!
  return cards.length >= 0;
}

// [Step 3] Dealer 17 rule (Hit on 16 or below, Stand on 17+)
function shouldDealerHit(dealerCards) {
  // TODO(Step 3): Return true when handValue(dealerCards) < 17, otherwise false!
  return false;
}

// [Step 4] Judge round outcome ("blackjack" | "win" | "lose" | "push" | "bust")
function judgeOutcome(playerCards, dealerCards) {
  const playerScore = handValue(playerCards);
  const dealerScore = handValue(dealerCards);

  if (playerScore > 21) {
    return "bust";
  }

  // TODO(Step 4):
  // 1) Detect 2-card natural 21 ("push" if both natural, "blackjack" if player natural, "lose" if dealer natural).
  // 2) Return "win" if dealerScore > 21, and "push" when scores are tied.
  if (playerScore > dealerScore) {
    return "win";
  }
  return "lose";
}

// [Step 5] Settle chip payouts (total chips returned to player)
function settleChips(bet, outcome) {
  // TODO(Step 5):
  // - "blackjack": Math.floor(bet * 2.5)
  // - "win": bet * 2
  // - "push": bet
  // - "lose" | "bust": 0
  if (outcome === "win") {
    return bet * 2;
  }
  return 0;
}
`;

export const REFERENCE_SOLUTION_CODE = `function createDeck() {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      const value =
        rank === "A"
          ? 11
          : rank === "J" || rank === "Q" || rank === "K"
            ? 10
            : Number(rank);
      deck.push({ suit, rank, value });
    }
  }
  return deck;
}

function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    if (card.rank === "A") {
      aces += 1;
      total += 11;
    } else if (card.rank === "J" || card.rank === "Q" || card.rank === "K") {
      total += 10;
    } else {
      total += Number(card.rank);
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

function canPlayerHit(cards) {
  return handValue(cards) < 21;
}

function shouldDealerHit(dealerCards) {
  return handValue(dealerCards) < 17;
}

function judgeOutcome(playerCards, dealerCards) {
  const playerScore = handValue(playerCards);
  const dealerScore = handValue(dealerCards);
  if (playerScore > 21) return "bust";
  const playerNatural = playerCards.length === 2 && playerScore === 21;
  const dealerNatural = dealerCards.length === 2 && dealerScore === 21;
  if (playerNatural && dealerNatural) return "push";
  if (playerNatural) return "blackjack";
  if (dealerNatural) return "lose";
  if (dealerScore > 21) return "win";
  if (playerScore > dealerScore) return "win";
  if (playerScore < dealerScore) return "lose";
  return "push";
}

function settleChips(bet, outcome) {
  if (outcome === "blackjack") return Math.floor(bet * 2.5);
  if (outcome === "win") return bet * 2;
  if (outcome === "push") return bet;
  return 0;
}
`;

export function getStepCurriculum(
	localeOverride?: string,
): readonly StepLessonContent[] {
	return resolveBlackjackLocale(localeOverride) === "ko"
		? STEP_CURRICULUM_KO
		: STEP_CURRICULUM_EN;
}

export function getTeachingStyleGuide(localeOverride?: string): string {
	return resolveBlackjackLocale(localeOverride) === "ko"
		? TEACHING_STYLE_KO
		: TEACHING_STYLE_EN;
}

export function getStarterCode(localeOverride?: string): string {
	return resolveBlackjackLocale(localeOverride) === "ko"
		? STARTER_CODE_KO
		: STARTER_CODE_EN;
}

export function buildTutorAskPrompt(params: {
	step: number;
	question: string;
	code: string;
	failedCheckLabels: readonly string[];
	localeOverride?: string;
}): string {
	const lang = resolveBlackjackLocale(params.localeOverride);
	const lessons = getStepCurriculum(lang);
	const current = lessons[params.step - 1] ?? lessons[0];
	const trimmedCode = params.code.slice(0, 4500);
	const failures =
		params.failedCheckLabels.length > 0
			? params.failedCheckLabels.join("; ")
			: "All checks in current run passed";

	if (lang === "ko") {
		return [
			"[역할: 나이아 블랙잭 소크라테스식 코딩 튜터]",
			TEACHING_STYLE_KO,
			"",
			`현재 학습 단계: ${current.title}`,
			`미션 목표: ${current.missionSummary}`,
			`미통과 점검 항목: ${failures}`,
			`학습자 질문: ${params.question}`,
			"",
			"[학습자의 현재 blackjack-rules.js 코드]",
			trimmedCode,
			"",
			"지침: 전체 정답 코드를 통째로 주지 말고, 학습자 코드의 구체적인 줄이나 조건을 짚어 질문 1개와 다음 행동 힌트 1개를 4~6문장 이내로 친절하게 답하세요.",
		].join("\n");
	}

	return [
		"[Role: Naia Blackjack Socratic Coding Tutor]",
		TEACHING_STYLE_EN,
		"",
		`Current Step: ${current.title}`,
		`Mission Goal: ${current.missionSummary}`,
		`Failing Checks: ${failures}`,
		`Learner Question: ${params.question}`,
		"",
		"[Learner's Current blackjack-rules.js]",
		trimmedCode,
		"",
		"Instruction: Do not paste the full solution. Reference the learner's actual code, ask 1 Socratic guiding question, and give 1 concrete next hint in 4-6 sentences.",
	].join("\n");
}

export function buildFallbackTutorReply(params: {
	step: number;
	question: string;
	failedCheckLabels: readonly string[];
	localeOverride?: string;
}): string {
	const lang = resolveBlackjackLocale(params.localeOverride);
	const lessons = getStepCurriculum(lang);
	const current = lessons[params.step - 1] ?? lessons[0];
	const firstFailure = params.failedCheckLabels[0];

	if (lang === "ko") {
		return [
			`좋은 질문이에요! 지금 살펴보는 "${current.shortTitle}" 단계에서 스스로 원인을 짚어 보려는 접근이 아주 좋습니다.`,
			firstFailure
				? `현재 자동 채점에서 먼저 확인해 볼 지점은 「${firstFailure}」입니다.`
				: "현재 단계의 핵심 검증을 잘 통과하고 있어요! 다음 경계 조건도 점검해 볼까요?",
			`질문으로 먼저 생각해 볼까요? ${current.socraticQuestion}`,
			`첫 번째 단서: ${current.hints[0]}`,
		].join("\n\n");
	}

	return [
		`Great question! Checking your reasoning on "${current.shortTitle}" is the fastest way to master the rule.`,
		firstFailure
			? `First diagnostic check to inspect: "${firstFailure}".`
			: "Your current checks look solid—let's think through edge cases too!",
		`Guiding question: ${current.socraticQuestion}`,
		`Next clue: ${current.hints[0]}`,
	].join("\n\n");
}

export function buildStarterProjectBundle(
	currentCode: string,
	localeOverride?: string,
): Array<{ path: string; content: string }> {
	const lang = resolveBlackjackLocale(localeOverride);
	const agentsMd =
		lang === "ko"
			? `# AGENTS.md — 나이아 블랙잭 소크라테스식 튜터 지침\n\n${TEACHING_STYLE_KO}\n\n- 학습자가 blackjack-rules.js의 Step 1~5 함수를 직접 완성하도록 질문과 단계별 힌트로 안내하세요.\n`
			: `# AGENTS.md — Naia Blackjack Socratic Tutor Guide\n\n${TEACHING_STYLE_EN}\n\n- Guide the learner through Steps 1-5 in blackjack-rules.js using questions and incremental hints.\n`;

	const readmeMd =
		lang === "ko"
			? `# 나이아 블랙잭 실습 프로젝트 (naia-blackjack-studio)\n\n1. \`blackjack-rules.js\`의 Step 1 ~ Step 5 TODO를 완성하세요.\n2. 터미널에서 OpenCode / Claude Code / Codex로 질문하며 고친 뒤, 나이아 블랙잭 스튜디오에서 **[로컬 파일 불러오기]**를 누르면 즉시 채점·테이블에 반영됩니다.\n`
			: `# Naia Blackjack Starter Project (naia-blackjack-studio)\n\n1. Complete Steps 1-5 in \`blackjack-rules.js\`.\n2. Edit with OpenCode / Claude Code / Codex, then click **Reload from Local File** in Naia Blackjack Studio to grade and play immediately.\n`;

	const projectYaml = [
		"version: 1",
		"project:",
		"  id: naia-blackjack-studio",
		lang === "ko"
			? "  name: 나이아 블랙잭 코딩 실습"
			: "  name: Naia Blackjack Coding Studio",
		"  coding_app: opencode",
		"  docs_dirs:",
		"    - docs",
		"",
	].join("\n");

	const docsMissionMd = getStepCurriculum(lang)
		.map(
			(s) =>
				`## ${s.title}\n\n- ${s.missionSummary}\n- Q: ${s.socraticQuestion}\n`,
		)
		.join("\n");

	const standaloneHtml = `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8" />
  <title>Naia Blackjack Local Runner</title>
</head>
<body>
  <h1>Naia Blackjack Local Rules Runner</h1>
  <script src="./blackjack-rules.js"></script>
</body>
</html>
`;

	return [
		{ path: "AGENTS.md", content: agentsMd },
		{ path: "project.yaml", content: projectYaml },
		{ path: "README.md", content: readmeMd },
		{ path: "docs/missions.md", content: docsMissionMd },
		{ path: "index.html", content: standaloneHtml },
		{
			path: "blackjack-rules.js",
			content: `${currentCode.trimEnd()}\n`,
		},
	];
}
