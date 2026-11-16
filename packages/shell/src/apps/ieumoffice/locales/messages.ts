import { Logger } from "../../../lib/logger";
import type { StudioDocument } from "../zip-ooxml-engine";

Logger.debug("IeumOfficeLocale", "loading ieumoffice locale dictionary");

export const IEUMOFFICE_EN_MESSAGES = {
	"ieum.brandEyebrow": "OPEN-SOURCE AI OFFICE · APACHE-2.0",
	"ieum.title": "IeumOffice Studio",
	"ieum.subtitle":
		"Edit Word (.docx), Sheets (.xlsx), Slides (.pptx), Hangul (.hwpx), Mind Maps (.xmind), and Markdown right inside Naia, or auto-connect desktop IeumOffice MCP with one click.",
	"ieum.badgeFree": "Free · Apache-2.0",
	"ieum.badgeEmbedded": "Built-in Web Editor",
	"ieum.badgeMcp": "ieumoffice mcp Auto-Bridge",
	"ieum.tabStudio": "Web Document Studio",
	"ieum.tabConnect": "Naia & MCP Connection",
	"ieum.tabDownload": "Official Download & Formats",
	"ieum.docKindDocx": "Word (.docx)",
	"ieum.docKindXlsx": "Sheets (.xlsx)",
	"ieum.docKindPptx": "Slides (.pptx)",
	"ieum.docKindHwpx": "Hangul (.hwpx)",
	"ieum.docKindXmind": "Mind Map (.xmind)",
	"ieum.docKindMarkdown": "Markdown / HTML",
	"ieum.openFile": "Open File",
	"ieum.exportFile": "Export Original Format",
	"ieum.exportCsv": "Export .csv",
	"ieum.resetSample": "Load Sample",
	"ieum.fileNameLabel": "File name",
	"ieum.addParagraph": "+ Add Paragraph",
	"ieum.addHeading": "+ Add Heading",
	"ieum.addBullet": "+ Add Bullet",
	"ieum.removeItem": "Remove",
	"ieum.blockHeading1": "Heading 1",
	"ieum.blockHeading2": "Heading 2",
	"ieum.blockParagraph": "Body",
	"ieum.blockBullet": "Bullet",
	"ieum.addRow": "+ Add Row",
	"ieum.addCol": "+ Add Column",
	"ieum.formulaHint":
		"Supports formulas such as =SUM(B2:B4), =AVERAGE(B2:B4), =B2*1.1",
	"ieum.addSlide": "+ Add Slide",
	"ieum.slideTitle": "Slide Title",
	"ieum.slideBullets": "Slide Bullets (one per line)",
	"ieum.slideNotes": "Speaker Notes",
	"ieum.hwpxHint":
		"Edits open-standard Hangul OWPML (.hwpx) paragraphs directly in the browser. For binary legacy .hwp layout fidelity, connect desktop IeumOffice MCP.",
	"ieum.addBranch": "+ Add Main Topic",
	"ieum.addSubtopic": "+ Subtopic",
	"ieum.convertToSlides": "Convert Map → Slides (.pptx)",
	"ieum.convertToDocx": "Convert Map → Word (.docx)",
	"ieum.markdownWrite": "Markdown Source",
	"ieum.markdownPreview": "Formatted Preview",
	"ieum.aiPanelTitle": "Naia Document Co-Editor",
	"ieum.aiPanelDesc":
		"Ask Naia to draft, polish, summarize, or restructure the open document. Review changes before applying, and undo anytime.",
	"ieum.aiQuickPolish": "Polish tone clearly",
	"ieum.aiQuickSummary": "Add executive summary",
	"ieum.aiQuickExpand": "Expand with concrete items",
	"ieum.aiPlaceholder":
		"Tell Naia how to edit this document (e.g. 'Rewrite in concise public-report style')...",
	"ieum.aiAskBtn": "Ask Naia to Edit",
	"ieum.aiAsking": "Naia is drafting...",
	"ieum.aiSpeakBtn": "Read Aloud",
	"ieum.aiStopSpeakBtn": "Stop Voice",
	"ieum.diffTitle": "Proposed AI Document Edit",
	"ieum.diffApply": "Apply to Document",
	"ieum.diffDiscard": "Discard",
	"ieum.undoBtn": "Undo Last AI Apply",
	"ieum.connectHeader": "Desktop IeumOffice Installation & MCP Status",
	"ieum.statusChecking": "Checking PC installation...",
	"ieum.statusInstalled": "Installed on this PC",
	"ieum.statusMissing": "Desktop IeumOffice not detected yet",
	"ieum.recheckBtn": "Re-scan PC",
	"ieum.mcpConnectedBadge": "Naia MCP Connected",
	"ieum.mcpAutoBadge": "Auto-detected",
	"ieum.mcpPausedBadge": "MCP Paused",
	"ieum.mcpToggleOn": "Connect ieumoffice mcp to Naia",
	"ieum.mcpToggleOff": "Pause ieumoffice mcp",
	"ieum.mcpCommandLabel": "Resolved MCP Launch Command",
	"ieum.codingAgentsTitle": "Coding Agents MCP Registration (1-Click)",
	"ieum.codingAgentsDesc":
		"Runs `ieumoffice mcp install` so Claude Code, Codex, OpenCode, and Gemini CLI can also edit .docx, .xlsx, .pptx, .hwp, and .pdf files locally.",
	"ieum.codingAgentsBtn": "Register in Coding Agents",
	"ieum.dir1Title": "Direction 1 · Naia → IeumOffice (ieumoffice mcp)",
	"ieum.dir1Body":
		"Naia calls local `ieumoffice mcp` tools to create, read, and patch Word, Excel, PowerPoint, Hangul (.hwp/.hwpx), PDF, and XMind files directly on your PC.",
	"ieum.dir2Title": "Direction 2 · IeumOffice → Naia (AI Provider Preset)",
	"ieum.dir2Body":
		"In desktop IeumOffice, open Settings → AI → Local AI / OpenAI-Compatible Server → Add Server, and paste one of the presets below.",
	"ieum.cloudPresetTitle": "Naia Cloud Gateway (OpenAI-Compatible)",
	"ieum.localPresetTitle": "Naia Local AI (Ollama / vLLM)",
	"ieum.copyBtn": "Copy",
	"ieum.copiedNotice": "Copied to clipboard.",
	"ieum.downloadRepoTitle": "Official GitHub Repository & Releases",
	"ieum.downloadRepoDesc":
		"Download installers only from the official pblsketch/ieumoffice repository.",
	"ieum.downloadSiteTitle": "Official Website",
	"ieum.downloadSiteDesc":
		"Story behind IeumOffice, supported formats, and user guide.",
	"ieum.smartScreenWarn":
		"First-launch OS notice: Unsigned open-source installers show 'Windows protected your PC' (click More info → Run anyway) or macOS Gatekeeper (System Settings → Privacy & Security → Open Anyway). Or use the Built-in Web Document Studio tab immediately with zero installation!",
	"ieum.dismissNotice": "Dismiss",
	"ieum.archNote":
		"Architecture note: Built-in Web Studio runs pure browser OOXML/OWPML/XMind engines inside Naia's sandboxed iframe with zero Electron install. Desktop IeumOffice adds native Rust spreadsheet speed, binary .hwp rendering (rhwp WASM), and PDF conversion via `ieumoffice mcp`.",
} as const;

export type IeumMessageKey = keyof typeof IEUMOFFICE_EN_MESSAGES;

const IEUMOFFICE_KO_MESSAGES: Record<IeumMessageKey, string> = {
	"ieum.brandEyebrow": "무료 오픈소스 AI 오피스 · APACHE-2.0",
	"ieum.title": "이음오피스 스튜디오",
	"ieum.subtitle":
		"설치 없이 바로 여는 내장 웹 문서 편집기(.docx · .xlsx · .pptx · .hwpx · .xmind · .md)와 내 PC 데스크톱 이음오피스(`ieumoffice mcp`) 자동 연결을 한 창에서 제공합니다.",
	"ieum.badgeFree": "무료 · Apache-2.0",
	"ieum.badgeEmbedded": "내장 웹 편집기 포함",
	"ieum.badgeMcp": "ieumoffice mcp 자동 연결",
	"ieum.tabStudio": "웹 문서 편집기 (바로 실습)",
	"ieum.tabConnect": "나이아 & MCP 자동 연결",
	"ieum.tabDownload": "공식 내려받기 · 지원 형식",
	"ieum.docKindDocx": "워드 (.docx)",
	"ieum.docKindXlsx": "엑셀/시트 (.xlsx)",
	"ieum.docKindPptx": "슬라이드 (.pptx)",
	"ieum.docKindHwpx": "한글 (.hwpx)",
	"ieum.docKindXmind": "마인드맵 (.xmind)",
	"ieum.docKindMarkdown": "마크다운 / HTML",
	"ieum.openFile": "내 PC 문서 열기",
	"ieum.exportFile": "원래 형식으로 저장",
	"ieum.exportCsv": ".csv 내보내기",
	"ieum.resetSample": "예시 문서 불러오기",
	"ieum.fileNameLabel": "파일 이름",
	"ieum.addParagraph": "+ 본문 단락 추가",
	"ieum.addHeading": "+ 소제목 추가",
	"ieum.addBullet": "+ 글머리 추가",
	"ieum.removeItem": "삭제",
	"ieum.blockHeading1": "큰 제목",
	"ieum.blockHeading2": "소제목",
	"ieum.blockParagraph": "본문",
	"ieum.blockBullet": "글머리",
	"ieum.addRow": "+ 행 추가",
	"ieum.addCol": "+ 열 추가",
	"ieum.formulaHint":
		"수식 자동 계산 지원: =SUM(B2:B4), =AVERAGE(B2:B4), =MIN(B2:B4), =B2*1.1 등",
	"ieum.addSlide": "+ 새 슬라이드 추가",
	"ieum.slideTitle": "슬라이드 제목",
	"ieum.slideBullets": "핵심 내용 (줄바꿈으로 항목 구분)",
	"ieum.slideNotes": "발표자 노트",
	"ieum.hwpxHint":
		"개방형 한글 표준(.hwpx, OWPML) 문서를 브라우저 안에서 바로 열고 저장합니다. 구형 바이너리 .hwp 정밀 조판과 PDF 변환은 [나이아 & MCP 자동 연결] 탭에서 데스크톱 이음오피스를 연결해 함께 쓸 수 있습니다.",
	"ieum.addBranch": "+ 중심 가지 추가",
	"ieum.addSubtopic": "+ 하위 주제",
	"ieum.convertToSlides": "마인드맵 → PPT 슬라이드 변환",
	"ieum.convertToDocx": "마인드맵 → 워드 문서 변환",
	"ieum.markdownWrite": "마크다운 원문 편집",
	"ieum.markdownPreview": "실시간 문서 미리보기",
	"ieum.aiPanelTitle": "나이아 AI 문서 직접 고치기",
	"ieum.aiPanelDesc":
		"나이아에게 말로 부탁하면 현재 열린 문서를 읽고 고칠 초안을 제안합니다. 바뀐 내용을 눈으로 확인한 뒤 반영하거나 언제든 되돌릴 수 있습니다.",
	"ieum.aiQuickPolish": "공문서·보고서 문체로 다듬기",
	"ieum.aiQuickSummary": "맨 위에 핵심 요약 추가",
	"ieum.aiQuickExpand": "실무 항목 구체화하기",
	"ieum.aiPlaceholder":
		"나이아에게 문서 수정을 요청하세요 (예: '핵심 기대효과 3가지를 글머리로 추가해 줘')...",
	"ieum.aiAskBtn": "나이아에게 편집 요청",
	"ieum.aiAsking": "나이아가 문서 수정안을 작성 중입니다...",
	"ieum.aiSpeakBtn": "문서 요약 듣기",
	"ieum.aiStopSpeakBtn": "낭독 중지",
	"ieum.diffTitle": "나이아가 제안한 변경 내용 확인",
	"ieum.diffApply": "문서에 반영하기",
	"ieum.diffDiscard": "취소",
	"ieum.undoBtn": "직전 AI 반영 되돌리기",
	"ieum.connectHeader": "내 PC 데스크톱 이음오피스 감지 & MCP 연결 상태",
	"ieum.statusChecking": "내 PC 설치 경로를 확인하는 중...",
	"ieum.statusInstalled": "내 PC에 이음오피스 설치 감지됨",
	"ieum.statusMissing": "데스크톱 이음오피스 미설치 (내장 웹 편집기는 바로 사용 가능)",
	"ieum.recheckBtn": "다시 감지",
	"ieum.mcpConnectedBadge": "나이아 MCP 연결됨",
	"ieum.mcpAutoBadge": "자동 연결됨",
	"ieum.mcpPausedBadge": "MCP 일시 중지됨",
	"ieum.mcpToggleOn": "나이아 에이전트에 ieumoffice mcp 연결",
	"ieum.mcpToggleOff": "ieumoffice mcp 연결 끄기",
	"ieum.mcpCommandLabel": "감지된 MCP 실행 명령",
	"ieum.codingAgentsTitle": "코딩 에이전트 MCP 일괄 등록 (원클릭)",
	"ieum.codingAgentsDesc":
		"`ieumoffice mcp install`을 실행해 Claude Code, Codex, OpenCode, Gemini CLI에서도 한글·워드·엑셀·PPT·PDF 편집 도구를 바로 쓰게 합니다.",
	"ieum.codingAgentsBtn": "코딩 에이전트에 MCP 등록",
	"ieum.dir1Title": "방향 1 · 나이아 → 이음오피스 (ieumoffice mcp)",
	"ieum.dir1Body":
		"이음오피스가 설치되어 있으면 나이아 셸이 자동으로 감지해 `ieumoffice mcp`를 연결합니다. 나이아 대화창에서 '이 보고서 요약해서 PPT로 만들어 줘'라고 말하면 내 PC 안에서 바로 문서를 만듭니다.",
	"ieum.dir2Title": "방향 2 · 이음오피스 → 나이아 (AI 공급자에 Naia 연결)",
	"ieum.dir2Body":
		"데스크톱 이음오피스 [설정 → AI → 로컬 AI / OpenAI 호환 서버 → 서버 추가]에서 아래 나이아 게이트웨이 또는 로컬 모델 주소를 붙여 넣으면 이음오피스 안의 AI 창이 나이아로 동작합니다.",
	"ieum.cloudPresetTitle": "나이아 클라우드 게이트웨이 (OpenAI 호환)",
	"ieum.localPresetTitle": "나이아 로컬 AI (Ollama / vLLM)",
	"ieum.copyBtn": "복사",
	"ieum.copiedNotice": "클립보드에 복사했습니다.",
	"ieum.downloadRepoTitle": "공식 GitHub 저장소 & 릴리스 내려받기",
	"ieum.downloadRepoDesc":
		"데스크톱 전체판(Windows · macOS · Linux) 설치 파일은 공식 pblsketch/ieumoffice 릴리스에서 받으세요.",
	"ieum.downloadSiteTitle": "이음오피스 공식 누리집",
	"ieum.downloadSiteDesc": "만든 사람 이야기와 전체 기능 안내를 볼 수 있습니다.",
	"ieum.smartScreenWarn":
		"처음 데스크톱 설치 시 안내: 오픈소스 무서명 설치 파일이라 Windows는 'Windows의 PC 보호 → 추가 정보 → 실행', macOS는 '시스템 설정 → 개인정보 보호 및 보안 → 그래도 열기'로 허용합니다. 설치 전에도 상단 [웹 문서 편집기] 탭에서 바로 문서를 만들고 고칠 수 있습니다!",
	"ieum.dismissNotice": "닫기",
	"ieum.archNote":
		"구성 안내: 이 확장앱(v0.2.0)은 설치 없이 즉시 동작하는 순수 웹 OOXML·HWPX·XMind 문서 편집기(구현 A)와 데스크톱 이음오피스 CLI 자동 감지·MCP 연결 브리지(구현 B)를 함께 담고 있습니다.",
};

const TABLES: Record<string, Record<IeumMessageKey, string>> = {
	en: IEUMOFFICE_EN_MESSAGES,
	ko: IEUMOFFICE_KO_MESSAGES,
};

export function resolveIeumLocale(raw?: string): "ko" | "en" {
	const candidate = (
		raw ?? (typeof navigator !== "undefined" ? navigator.language : "ko")
	)
		.trim()
		.toLowerCase();
	return candidate.startsWith("ko") ? "ko" : "en";
}

export function ieumText(
	key: IeumMessageKey,
	localeOverride?: string,
): string {
	const lang = resolveIeumLocale(localeOverride);
	return TABLES[lang]?.[key] ?? IEUMOFFICE_EN_MESSAGES[key];
}

export function createSampleStudioDocument(localeRaw?: string): StudioDocument {
	const isKo = resolveIeumLocale(localeRaw) === "ko";
	if (!isKo) {
		return {
			kind: "docx",
			fileName: "ax-project-brief",
			title: "Public AX Project Brief",
			docxBlocks: [
				{
					id: "p-1",
					kind: "heading1",
					text: "2026 Departmental AI Document Workflow Plan",
				},
				{
					id: "p-2",
					kind: "heading2",
					text: "1. Background & Goal",
				},
				{
					id: "p-3",
					kind: "paragraph",
					text: "Connect Mind Maps, Word/Hangul drafts, Spreadsheets, and Presentation slides in one workspace while keeping human review before final approval.",
				},
				{
					id: "p-4",
					kind: "bullet",
					text: "Keep original files on the local PC (.docx, .xlsx, .pptx, .hwpx, .xmind)",
				},
				{
					id: "p-5",
					kind: "bullet",
					text: "Preview AI-suggested edits and revert anytime",
				},
			],
			sheet: {
				name: "Budget",
				rows: [
					["Item", "Q1", "Q2", "Total"],
					["Training Materials", "120", "150", "=B2+C2"],
					["Pilot Operations", "200", "240", "=B3+C3"],
					["Review Workshop", "80", "90", "=B4+C4"],
					["Sum", "=SUM(B2:B4)", "=SUM(C2:C4)", "=SUM(D2:D4)"],
				],
			},
			slides: [
				{
					id: "slide-1",
					title: "IeumOffice × Naia Workflow",
					bullets: [
						"One-window document studio with AI diff review",
						"Automatic local ieumoffice mcp tool bridge",
					],
					notes: "Introduce both built-in web studio and desktop MCP connection.",
				},
				{
					id: "slide-2",
					title: "Human-in-the-Loop Document Editing",
					bullets: [
						"AI drafts structured edits",
						"Author inspects changes and approves or reverts",
					],
					notes: "Highlight safe reversibility.",
				},
			],
			hwpxParagraphs: [
				"[Official Draft] Departmental Open Document Collaboration Plan",
				"1. Purpose: Streamline recurring report and slide preparation with local-first AI tools.",
				"2. Principle: Human reviewers verify citations and approve final documents.",
			],
			mindmap: {
				id: "root",
				title: "AI Document Workflow",
				children: [
					{
						id: "b-1",
						title: "1. Collect Sources",
						children: [
							{ id: "b-1-1", title: "Public regulations & notices", children: [] },
							{ id: "b-1-2", title: "Previous training deck", children: [] },
						],
					},
					{
						id: "b-2",
						title: "2. AI Co-Drafting",
						children: [
							{ id: "b-2-1", title: "Summarize key changes", children: [] },
							{ id: "b-2-2", title: "Generate slide outline", children: [] },
						],
					},
					{
						id: "b-3",
						title: "3. Human Review",
						children: [
							{ id: "b-3-1", title: "Verify numbers & citations", children: [] },
							{ id: "b-3-2", title: "Export .docx / .pptx / .hwpx", children: [] },
						],
					},
				],
			},
			markdownText:
				"# IeumOffice × Naia Note\n\n- Edit `.docx`, `.xlsx`, `.pptx`, `.hwpx`, and `.xmind` directly.\n- Connect desktop `ieumoffice mcp` for full local suite automation.",
		};
	}

	return {
		kind: "docx",
		fileName: "부서-업무자동화-기안문",
		title: "2026년 부서 AI 문서 협업 추진안",
		docxBlocks: [
			{
				id: "p-1",
				kind: "heading1",
				text: "2026년 부서 AI 문서 협업 및 요약 자동화 추진안",
			},
			{
				id: "p-2",
				kind: "heading2",
				text: "1. 추진 배경 및 목적",
			},
			{
				id: "p-3",
				kind: "paragraph",
				text: "마인드맵 구상부터 한글·워드 보고서, 엑셀 집계표, 발표용 파워포인트까지 흩어진 문서 작업을 한 흐름으로 잇고, AI 수정안을 사람이 직접 눈으로 확인해 반영합니다.",
			},
			{
				id: "p-4",
				kind: "bullet",
				text: "모든 파일은 내 PC에서 원래 형식(.docx, .xlsx, .pptx, .hwpx, .xmind) 그대로 보관",
			},
			{
				id: "p-5",
				kind: "bullet",
				text: "나이아 AI 수정 제안은 변경 전·후 비교 후 반영 및 언제든 되돌리기 지원",
			},
		],
		sheet: {
			name: "예산집계",
			rows: [
				["항목", "상반기(만원)", "하반기(만원)", "합계"],
				["교안 및 문서 표준화", "120", "150", "=B2+C2"],
				["시범 부서 실습 운영", "200", "240", "=B3+C3"],
				["성과 점검 워크숍", "80", "90", "=B4+C4"],
				["총계", "=SUM(B2:B4)", "=SUM(C2:C4)", "=SUM(D2:D4)"],
			],
		},
		slides: [
			{
				id: "slide-1",
				title: "이음오피스 × 나이아 문서 스튜디오",
				bullets: [
					"설치 즉시 열리는 웹 문서 편집기 (.docx · .xlsx · .pptx · .hwpx · .xmind)",
					"데스크톱 이음오피스 설치 시 ieumoffice mcp 자동 감지·연결",
				],
				notes: "내장 웹 편집기와 데스크톱 MCP 연결 두 가지를 모두 시연합니다.",
			},
			{
				id: "slide-2",
				title: "AI가 초안 잡고 사람이 확정하는 문서 흐름",
				bullets: [
					"마인드맵 개요에서 발표 슬라이드·보고서로 원클릭 변환",
					"나이아 AI 편집 제안 비교 확인 및 되돌리기",
				],
				notes: "사람이 최종 확인하고 승인하는 안전장치를 강조합니다.",
			},
		],
		hwpxParagraphs: [
			"[기안문] 공개 기준 자료 기반 부서 교육자료 갱신 계획",
			"1. 목적: 법령·지침 개정 시 기존 문서의 변경 대조 시간을 줄이고 출처 표기를 표준화함.",
			"2. 원칙: 개인정보가 없는 공개 자료만 입력하며, 최종 반영은 담당자가 원문 대조 후 확정함.",
		],
		mindmap: {
			id: "root",
			title: "부서 AI 문서 혁신 계획",
			children: [
				{
					id: "b-1",
					title: "1. 기초 자료 정리",
					children: [
						{ id: "b-1-1", title: "공개 법령·지침 원문 수집", children: [] },
						{ id: "b-1-2", title: "기존 한글·워드 양식 점검", children: [] },
					],
				},
				{
					id: "b-2",
					title: "2. 나이아 × 이음오피스 편집",
					children: [
						{ id: "b-2-1", title: "변경 조항 요약 초안 작성", children: [] },
						{ id: "b-2-2", title: "발표용 PPT 슬라이드 자동 구성", children: [] },
					],
				},
				{
					id: "b-3",
					title: "3. 사람 검토 및 배포",
					children: [
						{ id: "b-3-1", title: "수치·출처 원문 대조", children: [] },
						{ id: "b-3-2", title: ".hwpx · .docx · .pptx 최종 저장", children: [] },
					],
				},
			],
		},
		markdownText:
			"# 이음오피스 × 나이아 메모\n\n- 내장 웹 편집기에서 `.docx`, `.xlsx`, `.pptx`, `.hwpx`, `.xmind` 문서를 바로 열고 저장할 수 있습니다.\n- 데스크톱 이음오피스를 설치하면 나이아가 `ieumoffice mcp`로 내 PC 문서를 직접 다룹니다.",
	};
}

export function buildAiDocumentPrompt(
	doc: StudioDocument,
	serializedContent: string,
	instruction: string,
	localeRaw?: string,
): string {
	const isKo = resolveIeumLocale(localeRaw) === "ko";
	if (isKo) {
		return [
			`당신은 이음오피스 문서 편집 도우미 나이아입니다. 현재 열린 문서 형식은 '${doc.kind}'(파일명: ${doc.fileName})입니다.`,
			"사용자 요청에 맞춰 문서 내용을 직접 수정한 결과만 깔끔하게 줄바꿈으로 출력하세요. 불필요한 인사말이나 코드블록 기호(```) 없이 본문만 반환하세요.",
			"",
			"[현재 문서 내용]",
			serializedContent,
			"",
			`[편집 요청] ${instruction}`,
		].join("\n");
	}
	return [
		`You are Naia, co-editing an IeumOffice '${doc.kind}' document (${doc.fileName}).`,
		"Return ONLY the revised document lines without markdown code fences or extra commentary.",
		"",
		"[Current Document]",
		serializedContent,
		"",
		`[Instruction] ${instruction}`,
	].join("\n");
}
