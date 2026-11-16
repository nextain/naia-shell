import { Logger } from "../../../lib/logger";

Logger.debug("AxLectureLocale", "initializing public-sector AX studio locale catalog");

export type AxLocale = "ko" | "en";

export type PresetId = "nts_tax" | "local_gov" | "hr_faq" | "custom";

export type ChecklistCategoryId =
	| "privacy"
	| "security"
	| "accuracy"
	| "accountability"
	| "human_oversight"
	| "fairness";

export type ChecklistStatus = "verified" | "pending" | "unverified";

export interface ChecklistEntry {
	id: ChecklistCategoryId;
	status: ChecklistStatus;
	note: string;
}

export interface AxWorkbookFields {
	presetId: PresetId;
	agencyName: string;
	serviceName: string;
	targetUser: string;
	sourceDocs: string;
	bottleneckRisk: string;
	noPiiPrinciple: string;
	approvalStopRule: string;
	checklist: ChecklistEntry[];
	purpose: string;
	aiRole: string;
	humanRole: string;
	approvalGate: string;
	screenAreas: string;
}

export interface ChapterMeta {
	id: string;
	startSlide: number;
	endSlide: number;
	label: string;
	sessionSummary: string;
}

export const TOTAL_SLIDES = 97;
export const OPENCODE_SCENE_SLIDES: readonly number[] = [
	2, 8, 14, 32, 70, 71, 77,
];

export const AX_ENGLISH_MESSAGES = {
	"ax.appTitle": "Public-Sector AX Planning Studio",
	"ax.appSubtitle":
		"Follow the 7-session (97-slide) NTS lecture with Naia voice narration while building your agency's 2-page AI service plan and interactive HTML wireframe.",
	"ax.badgeVersion": "v0.2.0 AX Studio",
	"ax.mobileTabLecture": "1. 97-Slide Lecture & Voice",
	"ax.mobileTabWorkbook": "2. 3-Stage AX Workbook",
	"ax.openCodeFilter": "OpenCode Scenes Only ({count})",
	"ax.slideCounter": "{current} / {total}",
	"ax.slideCounterOpenCode": "OpenCode {index} / {total} (Slide {current})",
	"ax.prevSlide": "← Prev",
	"ax.nextSlide": "Next →",
	"ax.slideJumpLabel": "Slide",
	"ax.keyboardHint": "Arrow keys ← / → navigate slides",
	"ax.narrationHeading": "Instructor Narration & Naia Voice Presenter",
	"ax.speakSlideBtn": "Listen with Naia Voice",
	"ax.speakingBtn": "Presenting...",
	"ax.stopSpeakBtn": "Stop Voice",
	"ax.continuousToggle": "Continuous Slide Narration",
	"ax.narrationEditLabel": "Editable Presenter Notes for Slide {slide}",
	"ax.agencyBarTitle": "My Agency & Target Workflow Setup",
	"ax.presetLabel": "Domain Preset",
	"ax.preset.nts_tax": "National Tax Service · Tax Law Training Update (Reference)",
	"ax.preset.local_gov": "Municipal Civil Affairs · Ordinance Guide Update",
	"ax.preset.hr_faq": "Public Agency HR · Service Rules FAQ Audit",
	"ax.preset.custom": "Custom Agency Workflow",
	"ax.field.agencyName": "Agency / Division",
	"ax.field.serviceName": "AI Service Name",
	"ax.field.targetUser": "Target Staff User",
	"ax.field.sourceDocs": "Public Evidence Sources (No PII)",
	"ax.stageTab1": "Stage 1 · Problem & Public AI Checklist",
	"ax.stageTab2": "Stage 2 · Product & Screen Plan",
	"ax.stageTab3": "Stage 3 · Live HTML Wireframe",
	"ax.stage1Hint": "Linked to Sessions 1-4: Define bottlenecks, exclude PII, set the one-line human stop rule, and audit 6 risk categories.",
	"ax.field.bottleneckRisk": "Current Workflow Bottleneck & Mistake Risk",
	"ax.field.noPiiPrinciple": "Input Scope & Personal Data Exclusion Rule",
	"ax.field.approvalStopRule": "Core One-Line Human Approval Rule (Where human stops & verifies original text)",
	"ax.askStage1Btn": "Draft Problem Statement with Naia AI",
	"ax.checklistHeading": "6-Category Public AI Review Checklist",
	"ax.cat.privacy": "1. Personal Data",
	"ax.cat.security": "2. Security & Network",
	"ax.cat.accuracy": "3. Hallucination & Citations",
	"ax.cat.accountability": "4. Accountability & Logs",
	"ax.cat.human_oversight": "5. Human-in-the-Loop",
	"ax.cat.fairness": "6. Fairness & Appeal",
	"ax.status.verified": "Verified",
	"ax.status.pending": "On Hold",
	"ax.status.unverified": "Unverified",
	"ax.checklistNotePlaceholder": "Evidence section or mitigation note...",
	"ax.stage2Hint": "Linked to Session 5: Write the 2-page Product & Screen Plan with citations, [[Needs Confirmation]] separation, and human approval gates.",
	"ax.field.purpose": "1. Workflow Objective",
	"ax.field.aiRole": "3. What AI Does (Citations, [[Needs Confirmation]], Never Self-Completes)",
	"ax.field.humanRole": "4. What Human Does (Source Cross-Check, Approve / Reject)",
	"ax.field.approvalGate": "5. Human Approval Gate (Target Version, Approver, Rejection Loop)",
	"ax.field.screenAreas": "6. Screen Areas ①-⑦ Layout",
	"ax.askStage2Btn": "Draft Custom 2-Page Service Plan with Naia AI",
	"ax.toggleMdPreview": "Preview Compiled Markdown",
	"ax.hideMdPreview": "Hide Markdown Preview",
	"ax.copyMdBtn": "Copy Markdown",
	"ax.stage3Hint": "Linked to Sessions 6-7: Synthesize an interactive ①-⑦ HTML screen wireframe immediately or refine it with Naia AI.",
	"ax.synthWireframeBtn": "Generate Instant HTML Screen Wireframe from My Plan",
	"ax.askWireframeBtn": "Enhance HTML Wireframe with Naia AI",
	"ax.undoWireframeBtn": "Undo Previous Wireframe",
	"ax.subTabPreview": "Live Interactive Preview (iframe)",
	"ax.subTabSource": "HTML Source Editor (04-screen.html)",
	"ax.busyGenerating": "Naia AI is drafting...",
	"ax.exportBarTitle": "Export Deliverables & Local OpenCode Project Bridge",
	"ax.downloadMdBtn": "Download Plan (.md)",
	"ax.downloadHtmlBtn": "Download Wireframe (04-화면.html)",
	"ax.provisionLocalBtn": "Provision Full Package to Local Project",
	"ax.openProjectsBtn": "Open Projects App (OpenCode)",
	"ax.statusDraftUpdated": "Updated draft fields for your agency workflow.",
	"ax.statusWireframeGenerated": "Generated interactive ①-⑦ HTML wireframe from your plan.",
	"ax.statusWireframeRestored": "Restored previous HTML wireframe version.",
	"ax.statusCopiedMd": "Copied 2-page AX service plan Markdown to clipboard.",
	"ax.statusDownloadedMd": "Prepared AX service plan (.md) download.",
	"ax.statusDownloadedHtml": "Prepared wireframe (04-화면.html) download.",
	"ax.statusProvisioned":
		"Provisioned local AX project at {dir} (written: {written}, preserved: {skipped}).",
	"ax.statusOpenedProjects": "Switched Naia Shell to Projects App.",
	"ax.errorStandalone":
		"Local project provisioning requires Naia desktop shell; use Download (.md / .html) in standalone browser mode.",
	"ax.errorClipboard": "Clipboard permission unavailable in this view.",
	"ax.dismiss": "Dismiss",
} as const;

export type AxMessageKey = keyof typeof AX_ENGLISH_MESSAGES;

export const AX_KOREAN_MESSAGES: Record<AxMessageKey, string> = {
	"ax.appTitle": "공공 AX기획 강의 실습 스튜디오",
	"ax.appSubtitle":
		"7교시 97장 국세청 강의 슬라이드와 나이아 음성 발표를 들으며, 내 기관의 2장 AI 서비스 기획서와 인터랙티브 HTML 화면 시안을 한 화면에서 완성합니다.",
	"ax.badgeVersion": "v0.2.0 일체형 스튜디오",
	"ax.mobileTabLecture": "1. 강의 슬라이드·음성 발표",
	"ax.mobileTabWorkbook": "2. 3단계 AX 기획 실습장",
	"ax.openCodeFilter": "오픈코드 실행 장면만 ({count})",
	"ax.slideCounter": "{current} / {total}",
	"ax.slideCounterOpenCode": "오픈코드 {index} / {total} ({current}쪽)",
	"ax.prevSlide": "← 이전",
	"ax.nextSlide": "다음 →",
	"ax.slideJumpLabel": "슬라이드 이동",
	"ax.keyboardHint": "키보드 ← / → 화살표로 슬라이드 이동",
	"ax.narrationHeading": "강사 발표 노트 & 나이아 음성 발표 바",
	"ax.speakSlideBtn": "나이아 음성 강의 듣기",
	"ax.speakingBtn": "나이아 발표 중...",
	"ax.stopSpeakBtn": "발표 중지",
	"ax.continuousToggle": "연속 슬라이드 낭독",
	"ax.narrationEditLabel": "{slide}쪽 강사 발표 대본 (편집 가능)",
	"ax.agencyBarTitle": "내 기관 · 대상 업무 설정",
	"ax.presetLabel": "기관·업무 예시 선택",
	"ax.preset.nts_tax": "국세청 · 세법 개정 교육자료 갱신(기준 예시)",
	"ax.preset.local_gov": "지자체 민원과 · 자치법규 민원안내문 갱신",
	"ax.preset.hr_faq": "공공기관 인사팀 · 복무규정 FAQ 점검",
	"ax.preset.custom": "직접 입력",
	"ax.field.agencyName": "기관 / 부서명",
	"ax.field.serviceName": "서비스 이름",
	"ax.field.targetUser": "대상 사용자",
	"ax.field.sourceDocs": "입력 공개 근거자료",
	"ax.stageTab1": "Stage 1 · 문제정의 & 체크리스트",
	"ax.stageTab2": "Stage 2 · 상위기획 · 화면기획",
	"ax.stageTab3": "Stage 3 · 화면 와이어프레임 프리뷰",
	"ax.stage1Hint": "1~4교시 연동: 현행 병목과 개인정보 배제 원칙을 정하고, 한 줄 사람 승인 규칙과 공공 AI 6대 체크리스트를 점검합니다.",
	"ax.field.bottleneckRisk": "현행 업무 병목과 실수 위험",
	"ax.field.noPiiPrinciple": "입력 자료 및 개인정보 배제 원칙",
	"ax.field.approvalStopRule": "핵심 한 줄 승인 규칙 (어디서 사람이 멈춰 원문 대조·승인하는가)",
	"ax.askStage1Btn": "나이아와 내 기관 문제정의서 초안 생성",
	"ax.checklistHeading": "공공 AI 6대 체크리스트 점검",
	"ax.cat.privacy": "1. 개인정보",
	"ax.cat.security": "2. 보안",
	"ax.cat.accuracy": "3. 오류·출처",
	"ax.cat.accountability": "4. 책임",
	"ax.cat.human_oversight": "5. 사람 개입",
	"ax.cat.fairness": "6. 공정성",
	"ax.status.verified": "확인됨",
	"ax.status.pending": "보류",
	"ax.status.unverified": "미확인",
	"ax.checklistNotePlaceholder": "기획서 근거 번호 또는 보완 조치 메모...",
	"ax.stage2Hint": "5교시 연동: 출처 표기 · [[확인 필요]] 분리 · 스스로 완료 금지 원칙이 담긴 상위기획·화면기획을 작성합니다.",
	"ax.field.purpose": "1. 업무 목적",
	"ax.field.aiRole": "3. AI가 하는 일 (출처 표기 · [[확인 필요]] 분리 · 스스로 완료 금지)",
	"ax.field.humanRole": "4. 사람이 하는 일 (대표 주장 원문 대조 · 승인/반려)",
	"ax.field.approvalGate": "5. 사람 승인 지점 (대상 버전 · 승인자 · 반려 시 재검토 흐름)",
	"ax.field.screenAreas": "6. 화면 영역 ①~⑦ 구성",
	"ax.askStage2Btn": "나이아와 맞춤형 서비스 기획서 작성",
	"ax.toggleMdPreview": "마크다운 미리보기 열기",
	"ax.hideMdPreview": "마크다운 미리보기 닫기",
	"ax.copyMdBtn": "마크다운 복사",
	"ax.stage3Hint": "6~7교시 연동: 작성한 Stage 1·2 기획서로 ①~⑦ 인터랙티브 HTML 화면 시안(승인/반려 로그 동작 포함)을 즉시 생성하거나 고도화합니다.",
	"ax.synthWireframeBtn": "내 기획서로 HTML 화면 시안 즉시 생성",
	"ax.askWireframeBtn": "나이아 AI에게 맞춤형 HTML 와이어프레임 고도화 요청",
	"ax.undoWireframeBtn": "이전 와이어프레임으로 되돌리기",
	"ax.subTabPreview": "실시간 화면 미리보기 (iframe)",
	"ax.subTabSource": "HTML 소스 편집기",
	"ax.busyGenerating": "나이아 AI가 초안을 작성 중...",
	"ax.exportBarTitle": "실습 산출물 내보내기 & 로컬 프로젝트 브리지",
	"ax.downloadMdBtn": "기획서(.md) 내려받기",
	"ax.downloadHtmlBtn": "와이어프레임(04-화면.html) 내려받기",
	"ax.provisionLocalBtn": "전체 실습 패키지 로컬 프로젝트로 세팅",
	"ax.openProjectsBtn": "프로젝트 앱(OpenCode) 열기",
	"ax.statusDraftUpdated": "내 기관·대상 업무 맞춤형 초안을 반영했습니다.",
	"ax.statusWireframeGenerated": "내 기획서 항목을 반영한 ①~⑦ 인터랙티브 HTML 화면 시안을 생성했습니다.",
	"ax.statusWireframeRestored": "직전 버전의 HTML 와이어프레임으로 되돌렸습니다.",
	"ax.statusCopiedMd": "통합 서비스 기획서 마크다운을 클립보드에 복사했습니다.",
	"ax.statusDownloadedMd": "기획서(.md) 내려받기를 준비했습니다.",
	"ax.statusDownloadedHtml": "와이어프레임(04-화면.html) 내려받기를 준비했습니다.",
	"ax.statusProvisioned":
		"로컬 AX 실습 프로젝트를 세팅했습니다: {dir} (생성 {written}개, 보존 {skipped}개)",
	"ax.statusOpenedProjects": "나이아 프로젝트 앱(OpenCode)으로 전환했습니다.",
	"ax.errorStandalone":
		"로컬 프로젝트 폴더 세팅은 나이아 데스크톱 셸에서 동작합니다. 단독 브라우저에서는 [.md / 04-화면.html 내려받기]를 이용해 주세요.",
	"ax.errorClipboard": "클립보드 쓰기 권한을 사용할 수 없습니다.",
	"ax.dismiss": "닫기",
};

export function resolveAxLocale(rawLang?: string): AxLocale {
	const candidate = (
		rawLang ?? (typeof navigator !== "undefined" ? navigator.language : "ko")
	)
		.trim()
		.toLowerCase();
	return candidate.split("-")[0] === "ko" ? "ko" : "en";
}

export function axText(
	key: AxMessageKey,
	params?: Readonly<Record<string, string | number>>,
	localeOverride?: string,
): string {
	const lang = resolveAxLocale(localeOverride);
	const table = lang === "ko" ? AX_KOREAN_MESSAGES : AX_ENGLISH_MESSAGES;
	const template = table[key] ?? AX_ENGLISH_MESSAGES[key];
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (whole, name) =>
		Object.prototype.hasOwnProperty.call(params, name)
			? String(params[name])
			: whole,
	);
}

const CHAPTERS_KO: readonly ChapterMeta[] = [
	{
		id: "intro",
		startSlide: 1,
		endSlide: 2,
		label: "처음(1)",
		sessionSummary:
			"강의 도입과 한 줄 핵심 메시지: 에이전트에게 일을 맡기려면 무엇을 근거로 일하고 어디서 사람이 멈춰 승인할지를 기획서 두 장에 먼저 적어야 합니다.",
	},
	{
		id: "s1",
		startSlide: 3,
		endSlide: 22,
		label: "1교시 AI 에이전트 이해(3)",
		sessionSummary:
			"1교시 AI Agent 개념: 답만 하는 챗봇과 도구를 써서 파일을 읽고 초안을 저장한 뒤 멈추는 에이전트를 비교하고, 결과에서 근거·[[확인 필요]]·사람 승인을 읽습니다.",
	},
	{
		id: "s2",
		startSlide: 23,
		endSlide: 39,
		label: "2교시 검색·분석·보고 자동화(23)",
		sessionSummary:
			"2교시 검색·분석·보고서 자동화: 조세특례제한법 제126조의2 개정 원문에서 시행일과 적용 시점을 구분해 출처 있는 갱신 초안을 만들고, 대표 주장 두 개를 원문과 직접 대조합니다.",
	},
	{
		id: "s3",
		startSlide: 40,
		endSlide: 49,
		label: "3교시 국내외 AI 사례(40)",
		sessionSummary:
			"3교시 국내외 공공 AI 사례: 한국 국세청 AI 챗봇, 미국 IRS와 GAO 감사, 영국 HMRC 생성형 AI 원칙을 근거·측정·책임 세 기준으로 비교합니다.",
	},
	{
		id: "s4",
		startSlide: 50,
		endSlide: 64,
		label: "4교시 공공 AI 고려사항(50)",
		sessionSummary:
			"4교시 공공 AI 고려사항: 인공지능기본법 투명성·고영향 AI 검토·개인정보·보안을 살피고, 위험은 없애는 것이 아니라 근거와 사람 승인 규칙 한 줄로 통제함을 익힙니다.",
	},
	{
		id: "s5",
		startSlide: 65,
		endSlide: 73,
		label: "5교시 기획 실습 ① 만들기(65)",
		sessionSummary:
			"5교시 기획 실습 1(상위기획): 우리 부서 업무 목적, 사용자, 공개 입력 자료, AI와 사람의 역할 분담, 사람 승인 지점을 상위기획 한 장에 직접 작성합니다.",
	},
	{
		id: "s6",
		startSlide: 74,
		endSlide: 82,
		label: "6교시 기획 실습 ② 바꾸기와 관리(74)",
		sessionSummary:
			"6교시 기획 실습 2(화면기획·검토·생성): 화면 영역 ①~⑦과 예외 흐름을 적고 공공 AI 체크리스트로 검토한 뒤, 요구사항 요약과 정적 화면(04-화면.html)을 생성합니다.",
	},
	{
		id: "s7",
		startSlide: 83,
		endSlide: 97,
		label: "7교시 발표·종합(83)",
		sessionSummary:
			"7교시 발표·종합: 팀별 기획서와 화면 시안을 공유하고, 피드백 수집 → 분류 → 수정 → 재측정 → 사람 승인 뒤 반영하는 운영 루프와 단기·중기 도입 조건을 정리합니다.",
	},
];

const CHAPTERS_EN: readonly ChapterMeta[] = [
	{
		id: "intro",
		startSlide: 1,
		endSlide: 2,
		label: "Start (1)",
		sessionSummary:
			"Course introduction & core thesis: Before delegating work to an AI agent, specify on two planning pages what evidence it reads and where a human stops to approve.",
	},
	{
		id: "s1",
		startSlide: 3,
		endSlide: 22,
		label: "S1 AI Agents (3)",
		sessionSummary:
			"Session 1 — Understanding AI Agents: Contrast a plain chatbot with a tool-using agent loop, and inspect citations, [[Needs Confirmation]], and human approval gates.",
	},
	{
		id: "s2",
		startSlide: 23,
		endSlide: 39,
		label: "S2 Evidence & RAG (23)",
		sessionSummary:
			"Session 2 — Search, Analysis & Reporting: Distinguish effective date vs. application timing in Tax Law Art. 126-2, generate cited drafts, and cross-check key claims against source text.",
	},
	{
		id: "s3",
		startSlide: 40,
		endSlide: 49,
		label: "S3 Global Cases (40)",
		sessionSummary:
			"Session 3 — Domestic & International Cases: Compare Korea NTS, US IRS / GAO audits, and UK HMRC generative AI principles across evidence, measurement, and accountability.",
	},
	{
		id: "s4",
		startSlide: 50,
		endSlide: 64,
		label: "S4 Public AI Governance (50)",
		sessionSummary:
			"Session 4 — Public-Sector AI Considerations: Distinguish statutory duties, agency rules, and guidelines across privacy, security, hallucinations, and human approval stop rules.",
	},
	{
		id: "s5",
		startSlide: 65,
		endSlide: 73,
		label: "S5 Lab 1 Product Plan (65)",
		sessionSummary:
			"Session 5 — Planning Lab 1: Draft your agency's Product Plan covering workflow purpose, users, public inputs, AI vs. human duties, and approval checkpoints.",
	},
	{
		id: "s6",
		startSlide: 74,
		endSlide: 82,
		label: "S6 Lab 2 Screen & HTML (74)",
		sessionSummary:
			"Session 6 — Planning Lab 2: Map screen areas ①-⑦, audit with the 6-category Public AI Checklist, and generate an interactive static screen wireframe (04-화면.html).",
	},
	{
		id: "s7",
		startSlide: 83,
		endSlide: 97,
		label: "S7 Wrap-Up & Ops (83)",
		sessionSummary:
			"Session 7 — Presentation & Operations: Review team deliverables and establish the operational feedback loop (collect -> classify -> revise -> re-measure -> human approval).",
	},
];

const SLIDE_SPECIFIC_NOTES_KO: Readonly<Record<number, string>> = {
	1: "안녕하십니까. 공공 AX기획 심화 과정을 함께할 나이아 강의 스튜디오입니다. 오늘 하루 붙들고 갈 핵심 문장은 하나입니다. 에이전트에게 일을 맡기려면 무엇을 근거로 일하고, 어디서 사람이 멈춰 승인할지를 기획서 두 장에 먼저 적어야 합니다.",
	2: "오픈코드 코딩 에이전트 실행 장면입니다. 터미널의 코딩 에이전트는 대화창에서 말만 끝내는 것이 아니라 공개 법령 폴더를 직접 열어 읽고, 출처가 달린 초안 문서를 파일로 저장한 뒤 사람의 검토를 기다립니다.",
	3: "1교시 AI 에이전트 이해를 시작합니다. 오전에는 조세특례제한법 제126조의2 개정 자료로 에이전트가 어떻게 일하는지 확인하고, 오후에는 오른쪽 실습장에서 여러분 부서의 기획서 두 장과 화면 시안을 직접 완성합니다.",
	8: "챗봇과 에이전트에 똑같은 요청과 똑같은 법령 발췌문을 주었을 때 무엇이 달라지는지 비교하는 실행 장면입니다. 에이전트는 문서마다 조항 출처를 붙이고 확인되지 않은 해석을 분리해 적습니다.",
	14: "에이전트 결과물에서 사람이 꼭 읽어야 할 세 가지는 첫째 조항 출처, 둘째 자료로 확인되지 않아 분리해 둔 확인 필요 표시, 셋째 사람이 승인하기 전까지 완료로 치지 않는 멈춤 지점입니다.",
	23: "2교시 검색·분석·보고서 자동화입니다. 세법 개정에서 가장 흔한 실수는 법 시행일과 실제 소득공제 적용 시점을 섞어 쓰는 것입니다. 부칙 제1조와 제47조를 근거로 정확히 나누어 적는 법을 실습합니다.",
	32: "근거 있는 교육자료 갱신 초안을 에이전트로 생성하는 장면입니다. 출처가 달려 있어도 숫자와 적용 대상을 사람이 대표 주장 두 개만이라도 반드시 원문과 직접 대조해야 합니다.",
	40: "3교시 국내외 공공기관 AI 사례입니다. 국세청 세무 상담, 미국 국세청과 감사원 보고서, 영국 국세청의 생성형 AI 원칙을 살펴보며 왜 모든 기관이 근거·측정·책임 세 단어로 모이는지 확인합니다.",
	50: "4교시 공공 AI 고려사항입니다. 공공기관이 AI 서비스를 기획할 때는 개인정보 배제, 망 분리와 보안, 출처 표기, 책임 주체, 사람 개입, 공정성 여섯 가지 체크리스트로 위험을 통제해야 합니다. 오른쪽 Stage 1 탭에서 바로 점검해 보세요.",
	65: "5교시 기획 실습 첫 시간입니다. 오른쪽 Stage 2 탭을 열어 우리 기관의 상위기획을 작성해 보세요. 모르는 규정은 빈칸으로 두지 말고 확인 필요 표시와 물어볼 부서를 적는 것이 핵심입니다.",
	70: "상위기획 문서를 바탕으로 코딩 에이전트가 요구사항 요약과 화면기획 초안을 이어 쓰는 오픈코드 실행 장면입니다.",
	71: "AI가 만든 초안을 다른 AI가 반대 입장에서 한 번 더 꼬집어 검토하는 적대적 검토 장면입니다. 숫자 누락이나 용어 차이를 사람이 한눈에 볼 수 있게 돕습니다.",
	74: "6교시 화면기획과 산출물 관리입니다. 화면 영역에 동그라미 1번부터 7번까지 번호를 매기고, 특히 5번 승인과 6번 반려 단추는 오직 사람만 누를 수 있도록 설계합니다.",
	77: "기획서 두 장에서 한 장짜리 정적 화면 시안 04-화면.html을 생성하는 장면입니다. 오른쪽 Stage 3 탭에서 내 기획서로 HTML 화면 시안 즉시 생성을 눌러 똑같이 체험해 보세요!",
	83: "7교시 발표 및 종합입니다. AI 서비스는 한 번 만들고 끝나는 것이 아니라, 현장의 반려 사유와 오류 기록을 모아 고치고 다시 재어 사람 승인 뒤 반영하는 운영 루프로 완성됩니다.",
};

const SLIDE_SPECIFIC_NOTES_EN: Readonly<Record<number, string>> = {
	1: "Welcome to the Public-Sector AX Planning Studio. Our single guiding principle today: before delegating work to an AI agent, write down on two planning pages what evidence it reads and where a human stops to approve.",
	2: "OpenCode agent execution scene: unlike a chat-only window, a coding agent opens public statute files directly, writes a cited draft file, and pauses for human review.",
	3: "Session 1 begins: we examine how an AI agent processes Tax Law Article 126-2 updates in the morning, and build your own agency's 2-page plan and HTML wireframe in the right-hand studio.",
	8: "Side-by-side execution comparing a standard chatbot and a tool-using agent given identical statutory excerpts.",
	14: "Three essentials to read in every agent output: (1) clause-level citations, (2) [[Needs Confirmation]] markers for unverified interpretations, and (3) the human approval checkpoint.",
	23: "Session 2 covers evidence-grounded automation: separating the statutory effective date from the actual deduction application period using Addendum Articles 1 and 47.",
	32: "Live OpenCode scene generating a cited training-material update draft ready for human cross-checking.",
	40: "Session 3 compares public tax agencies—Korea NTS, US IRS/GAO, and UK HMRC—through the lens of evidence, measurement, and human accountability.",
	50: "Session 4 addresses Public AI Governance across 6 checklist pillars: Personal Data, Security, Citations, Accountability, Human-in-the-Loop, and Fairness. Try auditing them in Stage 1 on the right!",
	65: "Session 5 Planning Lab 1: Open Stage 2 on the right to draft your agency's Product Plan, marking unknown rules explicitly as [[Needs Confirmation]].",
	70: "OpenCode scene synthesizing structured requirements and screen plans from the Product Plan.",
	71: "Adversarial AI review scene where a second verifier checks citations, numbers, and terminology before human inspection.",
	74: "Session 6 Screen Planning: Number screen zones ① through ⑦ and ensure ⑤ Approve and ⑥ Reject belong exclusively to a human reviewer.",
	77: "OpenCode scene generating the single-page HTML wireframe (04-화면.html). Click Generate Instant HTML Screen Wireframe in Stage 3 to build yours live!",
	83: "Session 7 Wrap-Up: Sustainable public AI relies on an auditable feedback loop—collect rejection logs, revise prompts/docs, re-measure, and deploy only after human approval.",
};

export function getChapters(localeOverride?: string): readonly ChapterMeta[] {
	return resolveAxLocale(localeOverride) === "ko" ? CHAPTERS_KO : CHAPTERS_EN;
}

export function getChapterForSlide(
	slide: number,
	localeOverride?: string,
): ChapterMeta {
	const list = getChapters(localeOverride);
	let matched = list[0]!;
	for (const ch of list) {
		if (slide >= ch.startSlide) {
			matched = ch;
		}
	}
	return matched;
}

export function getDefaultSlideNarration(
	slide: number,
	localeOverride?: string,
): string {
	const lang = resolveAxLocale(localeOverride);
	const specific =
		lang === "ko"
			? SLIDE_SPECIFIC_NOTES_KO[slide]
			: SLIDE_SPECIFIC_NOTES_EN[slide];
	if (specific) return specific;

	const chapter = getChapterForSlide(slide, lang);
	const isOpenCode = OPENCODE_SCENE_SLIDES.includes(slide);
	if (lang === "ko") {
		return `${chapter.label} (${slide}/97쪽)${isOpenCode ? " · [오픈코드 실행 장면]" : ""} — ${chapter.sessionSummary}`;
	}
	return `${chapter.label} (Slide ${slide}/97)${isOpenCode ? " · [OpenCode Scene]" : ""} — ${chapter.sessionSummary}`;
}

export function getPresetWorkbookFields(
	presetId: PresetId,
	localeOverride?: string,
): AxWorkbookFields {
	const lang = resolveAxLocale(localeOverride);
	if (lang === "en") {
		if (presetId === "local_gov") {
			return {
				presetId,
				agencyName: "Municipal Civil Affairs Division",
				serviceName: "Ordinance Civil Guide Update Assistant",
				targetUser: "Civil affairs desk officer updating citizen guides",
				sourceDocs:
					"Municipal Fee Ordinance (Public), Civil Application Checklist Guide (Internal, No PII)",
				bottleneckRisk:
					"When local ordinances change fee tables or required documents, manual updates across citizen leaflets risk mixing effective dates.",
				noPiiPrinciple:
					"Only public ordinance text and blank guide templates are read; citizen resident IDs and applications are strictly excluded.",
				approvalStopRule:
					"AI saves the redlined guide draft with article citations and halts; the desk officer cross-checks fee amounts and approves before publishing.",
				checklist: [
					{ id: "privacy", status: "verified", note: "No citizen PII in ordinance or guide templates" },
					{ id: "security", status: "verified", note: "Uses public ordinance portal files only" },
					{ id: "accuracy", status: "verified", note: "Clause citations + [[Needs Confirmation]] separation" },
					{ id: "accountability", status: "verified", note: "Desk officer & team lead 2-step approval log" },
					{ id: "human_oversight", status: "verified", note: "AI cannot publish; human presses ⑤ Approve" },
					{ id: "fairness", status: "pending", note: "[[Needs Confirmation — Check accessibility phrasing]]" },
				],
				purpose:
					"Generate cited redline drafts whenever municipal ordinances change so staff verify and update civil guides without missing effective dates.",
				aiRole:
					"Compare amended ordinance articles against current civil guide, output Before -> After with article citations, mark uncertain operational dates as [[Needs Confirmation]], and stop.",
				humanRole:
					"Cross-check fee figures and effective dates against the official gazette, then Approve (⑤) or Reject with reason (⑥).",
				approvalGate:
					"Step 1: Civil affairs officer approves Draft vN -> Step 2: Division head approves final leaflet before portal upload.",
				screenAreas:
					"① Service Header · ② Ordinance & Guide Selector · ③ Create Draft Button · ④ Cited Diff + [[Needs Confirmation]] + Adversarial Review · ⑤ Approve · ⑥ Reject · ⑦ Audit Log",
			};
		}
		if (presetId === "hr_faq") {
			return {
				presetId,
				agencyName: "Public Agency HR & Operations Team",
				serviceName: "Service Regulations FAQ Consistency Checker",
				targetUser: "HR policy manager maintaining internal leave/service FAQs",
				sourceDocs:
					"Public Officials Service Regulations (Public), Agency Internal FAQ Wiki (No employee PII)",
				bottleneckRisk:
					"Annual revisions to parental leave and flexible work rules leave outdated answers in internal FAQ pages.",
				noPiiPrinciple:
					"Reads published regulations and generic FAQ Q&A items only; individual personnel records are never entered.",
				approvalStopRule:
					"AI flags outdated FAQ answers with article citations and stops; HR manager verifies statute clauses and approves each revision.",
				checklist: [
					{ id: "privacy", status: "verified", note: "Zero personnel records or individual leave requests used" },
					{ id: "security", status: "pending", note: "[[Needs Confirmation — Internal wiki network policy]]" },
					{ id: "accuracy", status: "verified", note: "Every revised answer cites regulation article" },
					{ id: "accountability", status: "verified", note: "HR policy manager recorded in audit log" },
					{ id: "human_oversight", status: "verified", note: "Manual approval required per FAQ version" },
					{ id: "fairness", status: "verified", note: "Applies identical statutory criteria across job grades" },
				],
				purpose:
					"Detect stale internal FAQ entries after regulation updates and prepare cited replacement drafts for HR review.",
				aiRole:
					"Match revised regulation clauses against FAQ items, propose Before -> After text with citations, isolate ambiguous cases in [[Needs Confirmation]], and pause.",
				humanRole:
					"Verify statutory exceptions against original text and click Approve (⑤) or Reject (⑥).",
				approvalGate:
					"HR manager approves FAQ Draft vN; rejected items record revision reason and trigger v(N+1) review.",
				screenAreas:
					"① Title Banner · ② Regulation & FAQ Picker · ③ Generate Draft · ④ Cited Diff & Adversarial Review · ⑤ Approve · ⑥ Reject · ⑦ Approval History Table",
			};
		}
		if (presetId === "custom") {
			return {
				presetId,
				agencyName: "My Public Agency · Planning Team",
				serviceName: "Policy Document Review & Draft Assistant",
				targetUser: "Program officer reviewing public policy updates",
				sourceDocs: "Public statute / notice files and blank department template (No PII)",
				bottleneckRisk:
					"Manual cross-checking of amended guidelines takes hours and risks overlooking effective-date exceptions.",
				noPiiPrinciple:
					"Strictly public notices and anonymized templates; personal data is never uploaded.",
				approvalStopRule:
					"AI produces a cited draft and stops; the responsible officer verifies key claims against original text before approval.",
				checklist: [
					{ id: "privacy", status: "verified", note: "Public notices only; zero PII" },
					{ id: "security", status: "pending", note: "[[Needs Confirmation — Information security review]]" },
					{ id: "accuracy", status: "verified", note: "Mandatory source citation per claim" },
					{ id: "accountability", status: "verified", note: "Named officer approval log" },
					{ id: "human_oversight", status: "verified", note: "Human approval button required" },
					{ id: "fairness", status: "unverified", note: "Check impact across citizen groups" },
				],
				purpose: "Assist officers in drafting cited policy updates while keeping final verification and approval in human hands.",
				aiRole: "Read source notices, draft Before -> After updates with citations, tag uncertain interpretations as [[Needs Confirmation]], and halt.",
				humanRole: "Cross-check core claims against the source notice and Approve or Reject with reasons.",
				approvalGate: "Officer approves Draft vN before internal circulation; rejection logs reason and creates v(N+1).",
				screenAreas:
					"① Header · ② Source & Target Selector · ③ Draft Button · ④ Cited Draft + [[Needs Confirmation]] · ⑤ Approve · ⑥ Reject · ⑦ Audit Log",
			};
		}
		return {
			presetId: "nts_tax",
			agencyName: "National Tax Service · Training Division",
			serviceName: "Tax Law Training Material Update Assistant",
			targetUser: "Department training officer (knows tax rules, short on clause-by-clause diff time)",
			sourceDocs:
				"Restriction of Special Taxation Act Art. 126-2, Law No. 21223 Addendum Art. 1 & 47 (Public), Dept Training Material (No taxpayer PII)",
			bottleneckRisk:
				"Hand-updating training slides after tax law revisions takes hours and risks confusing the effective date (Jan 1, 2026) with practical year-end filing timing.",
			noPiiPrinciple:
				"Inputs are strictly public statutes from the National Law Information Center and department training text; taxpayer data is never used.",
			approvalStopRule:
				"AI writes a cited Before -> After draft and stops; the training officer cross-checks deduction limits and Addendum Art. 47 against source text before approving.",
			checklist: [
				{ id: "privacy", status: "verified", note: "Product Plan §3 — Public statutes only, zero taxpayer PII" },
				{ id: "security", status: "pending", note: "[[Needs Confirmation — IT security review for external model]]" },
				{ id: "accuracy", status: "verified", note: "Product Plan §4 — Clause citations + [[Needs Confirmation]] box" },
				{ id: "accountability", status: "verified", note: "Screen Plan ⑦ — 5-field approval log recorded" },
				{ id: "human_oversight", status: "verified", note: "Screen Plan ⑤⑥ — Only human can approve or reject" },
				{ id: "fairness", status: "verified", note: "Statutory child-deduction brackets applied verbatim" },
			],
			purpose:
				"Find amended clauses in Restriction of Special Taxation Act Art. 126-2 (child-based credit-card deduction cap increase), draft cited updates, and apply only human-approved versions.",
			aiRole:
				"Compare amended statute and current training material into Before -> After items with file/article citations, separate unconfirmed filing-year interpretations as [[Needs Confirmation]], run adversarial AI review, and stop without declaring completion.",
			humanRole:
				"Cross-check two representative claims (deduction cap amounts and Addendum Art. 47 timing) against original statute text, then Approve (⑤) or Reject with feedback (⑥).",
			approvalGate:
				"Stage 1: Training officer approves Draft vN -> Stage 2: Division director approves updated training package [[Needs Confirmation — internal sign-off rule]].",
			screenAreas:
				"① Service Title · ② Public Statute & Training File Picker · ③ Create Draft · ④ Cited Diff + [[Needs Confirmation]] + Adversarial AI Review · ⑤ Approve · ⑥ Reject & Revise · ⑦ 5-Field Audit Log",
		};
	}

	if (presetId === "local_gov") {
		return {
			presetId,
			agencyName: "지자체 민원여권과",
			serviceName: "자치법규 민원안내문 갱신 도우미",
			targetUser: "민원 안내 편람 담당 주무관",
			sourceDocs:
				"자치법규 수수료·구비서류 개정 조례 원문(공개), 부서 민원안내문 양식(개인정보 없음)",
			bottleneckRisk:
				"조례가 개정될 때마다 민원실 비치 안내문과 누리집 안내표를 수작업으로 대조하다가 시행일·수수료 숫자를 누락하기 쉽다.",
			noPiiPrinciple:
				"국가법령정보센터·자치법규 공개 조문과 빈 안내문 서식만 입력하며, 실제 민원인 신청서·주민등록번호는 절대 넣지 않는다.",
			approvalStopRule:
				"AI는 개정 조례 출처가 달린 변경 전·후 초안까지만 만들고 멈추며, 주무관이 수수료·시행일을 원문과 대조해 승인한 버전만 반영한다.",
			checklist: [
				{ id: "privacy", status: "verified", note: "공개 자치법규·안내문 양식만 사용 (민원인 개인정보 0건)" },
				{ id: "security", status: "verified", note: "공개 공포 조례 기준 작업 · 내부 비공개 문서 제외" },
				{ id: "accuracy", status: "verified", note: "조항 출처 필수 표기 및 미확인 사항 [[확인 필요]] 분리" },
				{ id: "accountability", status: "verified", note: "주무관 1차 검토 · 민원팀장 배포 승인 기록 유지" },
				{ id: "human_oversight", status: "verified", note: "⑤ 승인 단추는 사람만 조작 가능, AI 완료 선언 금지" },
				{ id: "fairness", status: "pending", note: "[[확인 필요 — 고령자·다문화 민원인 쉬운 용어 병기 기준 확인]]" },
			],
			purpose:
				"자치법규(조례·규칙) 개정 시 민원안내문의 바뀐 구비서류·수수료·시행일을 출처와 함께 추출해 주무관이 빠르게 대조·승인하도록 돕는다.",
			aiRole:
				"개정 조례와 현행 민원안내문을 비교해 '변경 전 → 변경 후'와 조항 출처를 달고, 경과조치 해석이 모호한 문장은 [[확인 필요]]로 분리한 뒤 멈춘다.",
			humanRole:
				"수수료 금액과 부칙 시행일 대표 항목을 자치법규 원문과 직접 대조하고 ⑤ 승인 또는 ⑥ 반려 사유를 기록한다.",
			approvalGate:
				"1차: 민원 담당 주무관이 갱신 초안 vN 승인 → 2차: 민원여권과장이 누리집 게시본 최종 결재 [[확인 필요 — 부서 전결 규정]].",
			screenAreas:
				"① 서비스 제목 · ② 개정 조례 및 민원안내문 선택 · ③ 초안 만들기 · ④ 변경 전/후·출처·[[확인 필요]]·반대 검토 · ⑤ 승인 · ⑥ 반려·수정 요청 · ⑦ 처리 기록 표",
		};
	}

	if (presetId === "hr_faq") {
		return {
			presetId,
			agencyName: "공공기관 인사혁신팀",
			serviceName: "복무·휴가 규정 FAQ 정합성 점검 도우미",
			targetUser: "복무·인사 규정 담당자(가상 직원 B)",
			sourceDocs:
				"국가공무원 복무규정 개정안(공개), 기관 내부 복무 FAQ 문서(개인 인사기록 제외)",
			bottleneckRisk:
				"육아시간·유연근무 등 복무규정이 바뀔 때 사내 게시판 FAQ 수십 건에 옛 기준이 남아 직원 혼선과 재문의가 반복된다.",
			noPiiPrinciple:
				"공개 법령과 일반화된 FAQ 문답만 입력하며, 개별 직원의 휴가 신청 내역이나 인사기록은 절대 넣지 않는다.",
			approvalStopRule:
				"AI는 개정 조문과 어긋나는 FAQ 문항의 수정 초안과 조항 출처를 제시하고 멈추며, 인사 담당자가 원문 대조 후 승인한 문항만 게시한다.",
			checklist: [
				{ id: "privacy", status: "verified", note: "개별 직원 성명·사번·복무기록 일절 미포함" },
				{ id: "security", status: "pending", note: "[[확인 필요 — 정보보호팀 내부 FAQ 반입·모델 이용 규정 확인]]" },
				{ id: "accuracy", status: "verified", note: "모든 답변에 복무규정 제○조 출처 표기 강제" },
				{ id: "accountability", status: "verified", note: "승인자·대상 FAQ 버전·시각·반려 사유 5개 항목 기록" },
				{ id: "human_oversight", status: "verified", note: "인사 담당자 승인 전 사내 게시판 자동 반영 금지" },
				{ id: "fairness", status: "verified", note: "직렬·직급별 예외 조건 누락 여부 반대 검토 포함" },
			],
			purpose:
				"복무규정 개정 시 기존 사내 FAQ 중 바뀐 조항과 충돌하는 문답을 찾아 출처 달린 수정 초안을 만들고, 담당자 승인본만 반영한다.",
			aiRole:
				"개정 복무규정과 기존 FAQ를 비교해 수정 문장·조항 출처를 작성하고, 기관장 재량 위임 사항은 [[확인 필요]]로 분리한 뒤 검토 요청을 올린다.",
			humanRole:
				"개정 조문 원문과 기관 내부 지침을 대조해 ⑤ 승인하거나 사유를 적어 ⑥ 반려한다.",
			approvalGate:
				"1차: 인사 담당자가 FAQ 갱신 초안 vN 승인 → 2차: 인사혁신팀장 확인 후 사내 포털 게시.",
			screenAreas:
				"① 서비스 제목 · ② 개정 복무규정 및 FAQ 선택 · ③ 초안 만들기 · ④ 수정 문답·출처·[[확인 필요]]·반대 검토 · ⑤ 승인 · ⑥ 반려·수정 요청 · ⑦ 처리 기록 표",
		};
	}

	if (presetId === "custom") {
		return {
			presetId,
			agencyName: "우리 기관 · 기획담당관실",
			serviceName: "법령·지침 개정 안내자료 갱신 도우미",
			targetUser: "부서 지침·안내자료 담당 실무자",
			sourceDocs: "공개 법령·고시 개정 원문 및 부서 표준 안내자료 서식(개인정보 없음)",
			bottleneckRisk:
				"상위 법령이나 지침이 바뀔 때마다 기존 안내자료를 일일이 눈으로 찾아 고치느라 시간이 걸리고 적용 시점 실수가 생긴다.",
			noPiiPrinciple:
				"공개된 법령·고시와 개인정보가 없는 표준 서식만 입력하며, 민원인·납세자 실명 자료는 넣지 않는다.",
			approvalStopRule:
				"AI는 조항 출처와 [[확인 필요]]가 분리된 갱신 초안을 저장한 뒤 멈추고, 담당자가 대표 주장을 원문과 대조해 승인해야만 반영한다.",
			checklist: [
				{ id: "privacy", status: "verified", note: "공개 법령·표준 서식만 입력, 개인정보 배제" },
				{ id: "security", status: "pending", note: "[[확인 필요 — 정보화 부서 외부 AI 활용 보안성 검토]]" },
				{ id: "accuracy", status: "verified", note: "문장별 출처 표기 및 미확인 해석 [[확인 필요]] 분리" },
				{ id: "accountability", status: "verified", note: "승인자·버전·시각·반려 사유 처리 기록 유지" },
				{ id: "human_oversight", status: "verified", note: "사람 승인 없이 원본 덮어쓰기·외부 배포 금지" },
				{ id: "fairness", status: "unverified", note: "대상 집단별 안내 누락 여부 추가 점검 필요" },
			],
			purpose:
				"개정 법령·지침에서 바뀐 조항을 찾아 출처 있는 안내자료 갱신 초안을 만들고, 실무자가 원문 대조·승인한 내용만 안전하게 반영한다.",
			aiRole:
				"개정 원문과 현재 안내자료를 비교해 변경 전·후 문장과 출처를 작성하고, 자료로 확인되지 않는 해석은 [[확인 필요]]로 표시한 뒤 멈춘다.",
			humanRole:
				"핵심 수치와 적용 시점을 원문과 직접 대조한 뒤 ⑤ 승인하거나 수정 사유를 적어 ⑥ 반려한다.",
			approvalGate:
				"실무 담당자가 갱신 초안 vN 승인 → 부서장 결재 후 새 파일로 배포 준비.",
			screenAreas:
				"① 서비스 제목 · ② 공개 근거자료·대상 문서 선택 · ③ 초안 만들기 · ④ 갱신 초안·출처·[[확인 필요]]·반대 검토 · ⑤ 승인 · ⑥ 반려·수정 요청 · ⑦ 처리 기록",
		};
	}

	return {
		presetId: "nts_tax",
		agencyName: "국세청 · 교육원/세원관리 담당 부서",
		serviceName: "교육자료 갱신 도우미",
		targetUser:
			"부서 교육 담당 직원(가상 직원 A — 세법 내용은 알지만 개정 조문·부칙·시행령을 매번 끝까지 대조할 시간이 부족함)",
		sourceDocs:
			"조세특례제한법 제126조의2 현행 조문, 법률 제21223호 부칙 제1조·제47조·개정이유(공개), 현재 부서 교육자료(개인정보 없음)",
		bottleneckRisk:
			"세법 개정 때마다 담당 직원이 옛 교육자료 문장을 손으로 찾아 고치느라 시간이 걸리고, 법 시행일(2026.1.1.)과 적용 시점을 섞어 쓰는 실수가 생기기 쉽다.",
		noPiiPrinciple:
			"입력 자료는 국가법령정보센터 공개 원문과 부서 교육자료로 한정하며, 실제 납세자 정보나 개별 신고 자료는 절대 넣지 않는다.",
		approvalStopRule:
			"AI는 출처와 [[확인 필요]]가 표시된 갱신 초안을 저장한 뒤 확인 요청을 올리고 멈추며, 교육 담당 직원이 대표 주장 두 개를 원문과 대조해 승인한 것만 반영한다.",
		checklist: [
			{
				id: "privacy",
				status: "verified",
				note: "상위기획 3번 — 공개 세법 원문·교육자료만 사용, 납세자 개인정보 배제",
			},
			{
				id: "security",
				status: "pending",
				note: "[[확인 필요 — 정보화·보안 담당 부서에 외부 모델 이용 규정 확인]]",
			},
			{
				id: "accuracy",
				status: "verified",
				note: "상위기획 4번 — 조항 출처 필수 표기 및 실무 반영 연도 [[확인 필요]] 분리",
			},
			{
				id: "accountability",
				status: "verified",
				note: "화면기획 ⑦ — 승인자·대상 버전·시각·다음 행동·반려 사유 5항목 기록",
			},
			{
				id: "human_oversight",
				status: "verified",
				note: "화면기획 ⑤⑥ — AI 스스로 완료 선언 금지, 사람만 승인·반려 단추 조작",
			},
			{
				id: "fairness",
				status: "verified",
				note: "조특법 제126조의2 제10항 자녀 수·총급여 구간 기준을 원문 그대로 반영",
			},
		],
		purpose:
			"공개된 세법 개정 원문(조특법 제126조의2 신용카드 소득공제 자녀 수별 한도 상향)에서 바뀐 부분을 찾아 출처를 단 갱신 초안을 만들고, 사람이 대조·승인한 것만 교육자료에 반영하게 한다.",
		aiRole:
			"개정 원문과 현재 교육자료를 비교해 '변경 전 → 변경 후' 문장과 파일명·조항 출처를 달고, 자료로 확인되지 않는 실무 반영 연도는 [[확인 필요]]로 분리하며, 다른 AI 반대 검토를 거친 뒤 스스로 완료를 선언하지 않고 멈춘다.",
		humanRole:
			"대표 주장 두 개(자녀 수별 공제 한도 금액 한 줄, 부칙 제47조 적용 시점 한 줄)를 원문과 직접 대조하고, 초안을 ⑤ 승인하거나 사유를 적어 ⑥ 반려한다.",
		approvalGate:
			"1단계 초안 검토: 교육 담당 직원이 갱신 초안 vN 승인 → 2단계 부서 배포: 교육 담당 부서장이 반영 교육자료 최종 승인 [[확인 필요 — 부서 결재 규정]].",
		screenAreas:
			"① 제목(서비스 이름) · ② 개정 자료 넣기(공개 원문·교육자료 선택) · ③ 초안 만들기 단추 · ④ 갱신 초안(변경 전/후·출처·[[확인 필요]]·다른 AI 반대 검토) · ⑤ 승인(사람 전용) · ⑥ 반려·수정 요청(사람 전용) · ⑦ 처리 기록 표",
	};
}

export function buildStage1Prompt(
	fields: AxWorkbookFields,
	localeOverride?: string,
): string {
	const lang = resolveAxLocale(localeOverride);
	if (lang === "ko") {
		return [
			"[역할: 공공기관 AX 서비스 기획 강사 나이아]",
			`기관/부서: ${fields.agencyName}`,
			`서비스 이름: ${fields.serviceName}`,
			`대상 사용자: ${fields.targetUser}`,
			`입력 공개 근거자료: ${fields.sourceDocs}`,
			"",
			"요청: 위 공공기관 업무에 맞춰 아래 3가지 항목을 공공 AI 원칙(개인정보 배제, 출처 표기, [[확인 필요]] 분리, 사람 승인 지점 명시)에 맞게 각 2문장 이내로 다듬어 제안해 주세요.",
			"형식:",
			"병목위험: ...",
			"개인정보원칙: ...",
			"한줄승인규칙: ...",
		].join("\n");
	}
	return [
		"[Role: Public-Sector AX Planning Instructor Naia]",
		`Agency: ${fields.agencyName}`,
		`Service: ${fields.serviceName}`,
		`User: ${fields.targetUser}`,
		`Public Sources: ${fields.sourceDocs}`,
		"",
		"Task: Refine the 3 Stage-1 problem statement fields under public-sector AI rules (no PII, mandatory citations, [[Needs Confirmation]] separation, explicit human stop rule).",
		"Format:",
		"BOTTLENECK: ...",
		"NO_PII: ...",
		"APPROVAL_RULE: ...",
	].join("\n");
}

export function buildStage2Prompt(
	fields: AxWorkbookFields,
	localeOverride?: string,
): string {
	const lang = resolveAxLocale(localeOverride);
	if (lang === "ko") {
		return [
			"[역할: 공공기관 AX 서비스 기획 강사 나이아]",
			`기관/부서: ${fields.agencyName}`,
			`서비스 이름: ${fields.serviceName}`,
			`대상 사용자: ${fields.targetUser}`,
			`입력 자료: ${fields.sourceDocs}`,
			`현행 병목: ${fields.bottleneckRisk}`,
			`한 줄 승인 규칙: ${fields.approvalStopRule}`,
			"",
			"요청: 5교시 상위기획·화면기획 양식에 맞춰 아래 항목을 구체적이고 간결하게 작성해 주세요. 확인되지 않은 기관 내부 규정은 반드시 [[확인 필요]]로 표시하세요.",
			"형식:",
			"업무목적: ...",
			"AI역할: ...",
			"사람역할: ...",
			"승인지점: ...",
			"화면구성: ...",
		].join("\n");
	}
	return [
		"[Role: Public-Sector AX Planning Instructor Naia]",
		`Agency: ${fields.agencyName}`,
		`Service: ${fields.serviceName}`,
		`User: ${fields.targetUser}`,
		`Sources: ${fields.sourceDocs}`,
		`Bottleneck: ${fields.bottleneckRisk}`,
		`Stop Rule: ${fields.approvalStopRule}`,
		"",
		"Task: Draft Stage-2 Product & Screen Plan fields with explicit citations, [[Needs Confirmation]] markers, and human approval checkpoints.",
		"Format:",
		"PURPOSE: ...",
		"AI_ROLE: ...",
		"HUMAN_ROLE: ...",
		"APPROVAL_GATE: ...",
		"SCREEN_AREAS: ...",
	].join("\n");
}

export function buildStage3WireframePrompt(
	fields: AxWorkbookFields,
	localeOverride?: string,
): string {
	const lang = resolveAxLocale(localeOverride);
	if (lang === "ko") {
		return [
			"[역할: 공공기관 AX 화면 와이어프레임 생성기]",
			`기관/부서: ${fields.agencyName}`,
			`서비스 이름: ${fields.serviceName}`,
			`입력 자료: ${fields.sourceDocs}`,
			`AI 역할: ${fields.aiRole}`,
			`사람 역할: ${fields.humanRole}`,
			`승인 지점: ${fields.approvalGate}`,
			`화면 영역 ①~⑦: ${fields.screenAreas}`,
			"",
			"요청: 외부 스크립트 없이 단일 HTML 문서(<!doctype html> ... </html>)로 동작하는 ①~⑦ 공공 AX 화면 와이어프레임을 작성해 주세요. ⑤ 승인 단추와 ⑥ 반려 단추를 누르면 ⑦ 처리 기록 표에 버전·시각·결정이 실제로 추가되어야 하며, [[확인 필요]] 경고 상자를 반드시 포함하세요.",
		].join("\n");
	}
	return [
		"[Role: Public-Sector AX HTML Wireframe Generator]",
		`Agency: ${fields.agencyName}`,
		`Service: ${fields.serviceName}`,
		`Sources: ${fields.sourceDocs}`,
		`AI Role: ${fields.aiRole}`,
		`Human Role: ${fields.humanRole}`,
		`Approval Gate: ${fields.approvalGate}`,
		"",
		"Task: Output a complete self-contained <!doctype html>...</html> wireframe implementing zones ①-⑦ where clicking ⑤ Approve or ⑥ Reject appends a timestamped row to ⑦ Audit Log, including a [[Needs Confirmation]] warning box.",
	].join("\n");
}
