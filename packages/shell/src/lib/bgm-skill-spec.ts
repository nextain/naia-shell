import type { NaiaTool } from "./app-registry";

/** appExec 등록용 앱 id — 위젯 전용(앱 아님), app_skills_clear 대상 아님(항상 유지). */
export const BGM_APP_ID = "bgm-widget";

export const BGM_ACTIONS = [
	"play",
	"stop",
	"pause",
	"resume",
	"next",
	"prev",
	"favorite_add",
	"favorite_remove",
	"favorites_play",
	"like_add",
	"like_remove",
	"playlist_list",
	"playlist_create",
	"playlist_add_current",
	"playlist_play",
	"shuffle",
	"repeat",
	"status",
	"volume",
] as const;
export type BgmAction = (typeof BGM_ACTIONS)[number];

export const SKILL_YOUTUBE_BGM: NaiaTool = {
	name: "skill_youtube_bgm",
	description:
		"Naia 음악 플레이어 제어. 좋아요는 선호 표시일 뿐 재생 목록이 아니다. next/prev는 활성 플레이리스트(유튜브·로컬 파일 혼합 포함)와 실행 큐를 사용한다. playlist_list/create/add_current/play, like_add/remove, shuffle, repeat(off/all/one)를 구분해서 사용한다. announceTrack=true 이고 currentTrack이 있으면 그 제목을 말해도 된다. requested/loading/timeout이면 재생 중이라고 말하지 말고 JSON을 읽지 않는다.",
	parameters: {
		type: "object",
		properties: {
			action: {
				type: "string",
				enum: [...BGM_ACTIONS],
				description: BGM_ACTIONS.join(" | "),
			},
			query: {
				type: "string",
				description: "검색어 (play 에서 videoId 없을 때)",
			},
			videoId: { type: "string", description: "YouTube video id (play, 선택)" },
			title: { type: "string", description: "제목 (play+videoId, 선택)" },
			volume: { type: "number", description: "0.0~1.0 (volume)" },
			playlistId: { type: "string", description: "플레이리스트 ID" },
			name: { type: "string", description: "새 플레이리스트 이름" },
			index: { type: "number", description: "재생할 플레이리스트 항목 번호(0부터)" },
			enabled: { type: "boolean", description: "셔플 사용 여부" },
			repeat: {
				type: "string",
				enum: ["off", "all", "one"],
			},
			mode: {
				type: "string",
				enum: ["player", "radio_dj"],
				description:
					"Semantic intent chosen by the LLM in any language. Use radio_dj only when the user asks for an ongoing autonomous DJ/radio-host experience (including synonyms or similar phrasing); use player for ordinary song, playlist, or BGM playback.",
			},
		},
		required: ["action"],
	},
	tier: 0, // App.tsx 부팅 시 addAllowedTool("skill_youtube_bgm") — 저위험 환경 조작
};
