import { welcomeDescriptor } from "@naia-adk/skills-builtin";
import type { SkillDefinition, SkillResult } from "../types.js";

/**
 * welcome — channel-onboarding greeting template generator.
 *
 * Ported from OpenClaw container/skills/welcome via #274. Unlike OpenClaw's
 * prompt-only skill, this returns a structured template that the LLM can
 * embed into a send_message/notify-* call. The 8-capability ladder is the
 * same drip-feed order OpenClaw used; copy is rewritten for Naia's persona.
 *
 * Tier 0: composes text only. Caller must use a separate skill (notify-*,
 * naia_discord, etc.) to actually send.
 */

const CAPABILITY_LADDER_KO = [
	{
		title: "기억과 맥락",
		body: "대화 사이에도 너의 프로젝트, 선호, 결정을 기억해. 매번 새로 설명할 필요 없어.",
	},
	{
		title: "지속적 에이전트 (create_agent)",
		body: "이름 있는 다른 에이전트를 만들 수 있어 — Researcher, Builder, Calendar agent 같이. 각자의 기억, 작업 공간, 인격을 가지고 백그라운드에서 일해.",
	},
	{
		title: "예약 작업과 백그라운드",
		body: "정기 작업, 모니터, 알림. 큰 작업은 에이전트가 따로 돌면서 대화가 끊기지 않아.",
	},
	{
		title: "리서치와 웹 브라우징",
		body: "사람처럼 웹을 봐. 기사 읽고, 실시간 데이터 가져오고, 상품 비교해. 'X 최신 정보' 또는 'Z 에 좋은 Y 찾아줘' 같이.",
	},
	{
		title: "코드와 빌드",
		body: "스크립트, API, 프론트엔드. dev 서버 띄우고, 실 브라우저에서 테스트하고, 배포까지.",
	},
	{
		title: "구조화된 UI",
		body: "카드, 선택 버튼을 채팅에 직접 보낼 수 있어. 결정이나 결과를 깔끔하게 보여줄 때.",
	},
	{
		title: "파일과 산출물",
		body: "리포트, PDF, 차트, 이미지 — 다운로드 가능한 파일로 채팅에 보내.",
	},
	{
		title: "자가 확장",
		body: "필요한 기능이 없으면 도구, MCP 서버를 자체적으로 추가할 수 있어.",
	},
];

const CAPABILITY_LADDER_EN = [
	{
		title: "Memory & context over time",
		body: "I remember projects, preferences, decisions across conversations. You don't have to re-explain.",
	},
	{
		title: "Persistent agents (create_agent)",
		body: "I can spin up named agents — Researcher, Builder, Calendar — each with their own memory and workspace.",
	},
	{
		title: "Scheduled & background tasks",
		body: "Daily briefings, monitors that alert only when something matters, recurring reminders.",
	},
	{
		title: "Research & web browsing",
		body: "I can read articles, pull live data, summarize. Ask 'what's the latest on X' and I look it up.",
	},
	{
		title: "Code & building things",
		body: "Write, debug, deploy. Dev server, real-browser test, deploy to production.",
	},
	{
		title: "Interactive UI",
		body: "Structured cards and multiple-choice buttons in chat — not just plain text.",
	},
	{
		title: "Files & artifacts",
		body: "Real deliverables — reports, PDFs, charts, generated images — as downloadable files in chat.",
	},
	{
		title: "Self-customization",
		body: "I can add new tools and MCP servers to myself when a capability isn't built in.",
	},
];

export function createWelcomeSkill(): SkillDefinition {
	return {
		name: `skill_${welcomeDescriptor.name}`,
		description: welcomeDescriptor.description,
		parameters: welcomeDescriptor.inputSchema,
		tier: 0, // descriptor.tier = "T0"
		requiresGateway: false,
		source: "built-in",
		execute: async (args): Promise<SkillResult> => {
			const channel = (args.channel as string | undefined) ?? "generic";
			const locale = (args.locale as string | undefined) ?? "ko";

			const ladder = locale.startsWith("ko") ? CAPABILITY_LADDER_KO : CAPABILITY_LADDER_EN;
			const greeting =
				locale.startsWith("ko")
					? "안녕! 새 채널에 연결된 거 알아. 짧게 인사하고, 뭐 도와줄지 물어볼게."
					: "Hi! I see we just got connected on a new channel. Let me say hi and ask what you'd like to do.";
			const ask =
				locale.startsWith("ko")
					? "내가 뭘 할 수 있는지 천천히 보여줄까, 아니면 바로 뭔가 시작할까?"
					: "Would you like me to show what I can do, or jump straight into something?";

			return {
				success: true,
				output: JSON.stringify({
					channel,
					locale,
					greeting,
					ask,
					capability_ladder: ladder,
					note:
						"This is a TEMPLATE. Compose into a real send via notify-* or naia_discord. " +
						"Reveal capabilities one at a time, never all at once.",
				}),
			};
		},
	};
}
