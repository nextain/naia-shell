/**
 * Naia OS 3-minute demo video — Scene definitions.
 *
 * Each scene has:
 *   id        — unique key (also used as TTS filename)
 *   narration — Korean narration text for TTS
 *   duration  — seconds this scene should last on screen
 *   phase     — "onboarding" | "main"
 */

export interface DemoScene {
	id: string;
	narration: string;
	duration: number;
	phase: "onboarding" | "main";
}

export const DEMO_SCENES: DemoScene[] = [
	// ── Phase 1: Onboarding (~55s) ──────────────────────────────
	{
		id: "intro",
		narration:
			"나이아 OS에 오신 것을 환영합니다. AI 아바타와 함께하는 개인 운영체제, 지금부터 설정을 시작합니다.",
		duration: 5,
		phase: "onboarding",
	},
	{
		id: "provider",
		narration:
			"먼저 AI 제공자를 선택합니다. Gemini, Claude, Grok 등 원하는 LLM을 고를 수 있습니다.",
		duration: 8,
		phase: "onboarding",
	},
	{
		id: "apikey",
		narration:
			"선택한 제공자의 API 키를 입력합니다. 키는 로컬에만 안전하게 저장됩니다.",
		duration: 7,
		phase: "onboarding",
	},
	{
		id: "agent-name",
		narration:
			'AI 에이전트의 이름을 정해줍니다. 여기서는 "나이아"로 설정하겠습니다.',
		duration: 6,
		phase: "onboarding",
	},
	{
		id: "user-name",
		narration: "사용자의 이름을 입력합니다. 나이아가 이 이름으로 불러줍니다.",
		duration: 6,
		phase: "onboarding",
	},
	{
		id: "character",
		narration:
			"나이아의 3D 아바타를 선택합니다. VRM 모델을 직접 추가할 수도 있습니다.",
		duration: 8,
		phase: "onboarding",
	},
	{
		id: "personality",
		narration:
			"나이아의 성격을 골라줍니다. 친근한 스타일, 전문가 스타일 등 다양한 옵션이 있습니다.",
		duration: 7,
		phase: "onboarding",
	},
	{
		id: "messenger",
		narration:
			"메신저 연동을 설정할 수 있습니다. 나중에 설정에서도 변경 가능합니다.",
		duration: 5,
		phase: "onboarding",
	},
	{
		id: "complete",
		narration: "설정이 완료되었습니다! 이제 나이아와 대화를 시작해 볼까요?",
		duration: 5,
		phase: "onboarding",
	},

	// ── Phase 2: Main App Tour (~128s) ──────────────────────────
	{
		id: "chat-hello",
		narration: '채팅 화면입니다. "안녕, 나이아!"라고 인사해 보겠습니다.',
		duration: 8,
		phase: "main",
	},
	{
		id: "chat-response",
		narration:
			"나이아가 반갑게 인사합니다. 실시간 스트리밍으로 응답이 나타납니다.",
		duration: 7,
		phase: "main",
	},
	{
		id: "chat-weather",
		narration:
			"이번에는 날씨를 물어보겠습니다. 나이아는 스킬을 사용해 실시간 정보를 가져옵니다.",
		duration: 10,
		phase: "main",
	},
	{
		id: "chat-tool-result",
		narration:
			"도구 실행 결과를 카드로 확인할 수 있습니다. 클릭하면 상세 내용이 펼쳐집니다.",
		duration: 8,
		phase: "main",
	},
	{
		id: "chat-time",
		narration:
			"시간 스킬도 사용해 보겠습니다. 다양한 내장 스킬을 자유롭게 활용할 수 있습니다.",
		duration: 10,
		phase: "main",
	},
	{
		id: "history-tab",
		narration:
			"기록 탭에서는 이전 대화 세션을 확인하고 이어서 대화할 수 있습니다.",
		duration: 10,
		phase: "main",
	},
	{
		id: "skills-list",
		narration:
			"스킬 탭입니다. 날씨, 시간, 메모, 파일 관리 등 다양한 스킬이 설치되어 있습니다.",
		duration: 8,
		phase: "main",
	},
	{
		id: "skills-detail",
		narration: "스킬 카드를 펼치면 상세 설명과 설정을 확인할 수 있습니다.",
		duration: 7,
		phase: "main",
	},
	{
		id: "channels-tab",
		narration: "채널 탭에서는 디스코드 등 메신저 연동 상태를 관리합니다.",
		duration: 10,
		phase: "main",
	},
	{
		id: "agents-tab",
		narration: "에이전트 탭에서는 실행 중인 에이전트와 세션을 모니터링합니다.",
		duration: 10,
		phase: "main",
	},
	{
		id: "diagnostics-tab",
		narration:
			"진단 탭에서 게이트웨이, 에이전트, 시스템 상태를 한눈에 확인합니다.",
		duration: 10,
		phase: "main",
	},
	{
		id: "settings-ai",
		narration:
			"설정 탭입니다. AI 제공자, 모델, API 키를 언제든 변경할 수 있습니다.",
		duration: 5,
		phase: "main",
	},
	{
		id: "settings-voice",
		narration: "음성 설정에서 TTS 음성과 대화 언어를 커스터마이즈합니다.",
		duration: 5,
		phase: "main",
	},
	{
		id: "settings-memory",
		narration: "기억 설정에서 나이아가 기억하는 사실들을 관리할 수 있습니다.",
		duration: 5,
		phase: "main",
	},
	{
		id: "progress-tab",
		narration: "작업 탭에서는 AI 사용량, 비용, 도구 실행 통계를 확인합니다.",
		duration: 8,
		phase: "main",
	},
	{
		id: "outro",
		narration: "나이아 OS, 당신만의 AI 파트너와 함께하세요. 감사합니다.",
		duration: 5,
		phase: "main",
	},
];

/** Total expected duration in seconds */
export const TOTAL_DURATION = DEMO_SCENES.reduce(
	(sum, s) => sum + s.duration,
	0,
);

/** Get cumulative start time (seconds) for each scene */
export function getSceneTimings(): {
	id: string;
	startSec: number;
	duration: number;
}[] {
	let offset = 0;
	return DEMO_SCENES.map((s) => {
		const entry = { id: s.id, startSec: offset, duration: s.duration };
		offset += s.duration;
		return entry;
	});
}
