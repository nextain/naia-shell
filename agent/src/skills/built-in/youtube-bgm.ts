/**
 * skill_youtube_bgm - AI skill for YouTube BGM control.
 *
 * Actions:
 *   search    : search YouTube for BGM videos and auto-play the first result
 *   play      : send bgm_youtube_play command to shell
 *   stop      : stop playback
 *   pause     : pause playback
 *   resume    : resume playback
 *   next      : next favorite
 *   prev      : previous favorite
 *   volume    : set player volume
 *   trending  : search ambient/trending music
 *   fav_add   : add currently playing track to favorites
 *   fav_remove: remove currently playing track from favorites
 *   fav_list  : list BGM favorites from shell context
 */
import { getInnertube } from "../../youtube-server.js";
import type { SkillDefinition, SkillResult } from "../types.js";

function sendShellCommand(payload: Record<string, unknown>): void {
	process.stdout.write(JSON.stringify(payload) + "\n");
}

export function createYoutubeBgmSkill(): SkillDefinition {
	return {
		name: "skill_youtube_bgm",
		tier: 0,
		requiresGateway: false,
		source: "built-in",
		description:
			"Control the YouTube BGM player. Search music/ambient videos, play them as background music, or stop playback. Use this when the user wants background music or ambient sound from YouTube.",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"search",
						"play",
						"stop",
						"pause",
						"resume",
						"next",
						"prev",
						"volume",
						"trending",
						"fav_add",
						"fav_remove",
						"fav_list",
					],
					description:
						"search: find and play first result | play: play by videoId | stop: stop and clear | pause: pause | resume: resume | next: next in favorites | prev: previous in favorites | volume: set volume (0.0-1.0) | trending: trending ambient | fav_add: add to favorites | fav_remove: remove from favorites | fav_list: read BGM context",
				},
				query: {
					type: "string",
					description: "Search query (required for search action)",
				},
				videoId: {
					type: "string",
					description: "YouTube video ID (required for play action)",
				},
				title: {
					type: "string",
					description: "Video title (for play action, optional)",
				},
				volume: {
					type: "number",
					description: "Volume level 0.0-1.0 (required for volume action)",
				},
			},
			required: ["action"],
		},
		async execute(args, _ctx): Promise<SkillResult> {
			const action = String(args.action ?? "");

			if (action === "search" || action === "trending") {
				const query =
					action === "trending"
						? "ambient relaxing music 1 hour"
						: String(args.query ?? "").trim();

				if (!query) {
					return { success: false, output: "query is required for search" };
				}

				try {
					const yt = await getInnertube();
					const search = await yt.search(query, { type: "video" });

					// biome-ignore lint/suspicious/noExplicitAny: youtubei.js types vary
					const results = (search.videos ?? []).slice(0, 10).map((v: any, i: number) => ({
						index: i + 1,
						id: v.id ?? v.video_id ?? "",
						title: typeof v.title === "string" ? v.title : (v.title?.text ?? ""),
						duration:
							typeof v.duration === "string" ? v.duration : (v.duration?.text ?? ""),
						channel: v.author?.name ?? v.channel?.name ?? "",
					}));

					const top = results[0];
					if (top?.id) {
						const thumbnail = `https://i.ytimg.com/vi/${top.id}/mqdefault.jpg`;
						sendShellCommand({
							type: "bgm_youtube_play",
							videoId: top.id,
							title: top.title,
							thumbnail,
						});
						return {
							success: true,
							output: `Now playing: "${top.title}" (${top.duration}) by ${top.channel}`,
						};
					}

					return { success: false, output: `No results found for: "${query}"` };
				} catch (err) {
					return { success: false, output: `Search failed: ${String(err)}` };
				}
			}

			if (action === "play") {
				const videoId = String(args.videoId ?? "").trim();
				if (!videoId || !/^[A-Za-z0-9_-]{1,20}$/.test(videoId)) {
					return { success: false, output: "invalid videoId" };
				}

				const title = String(args.title ?? "").trim();
				const thumbnail = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
				sendShellCommand({ type: "bgm_youtube_play", videoId, title, thumbnail });

				return {
					success: true,
					output: `Playing: "${title || videoId}"`,
				};
			}

			if (action === "stop") {
				sendShellCommand({ type: "bgm_youtube_stop" });
				return { success: true, output: "BGM stopped" };
			}

			if (action === "pause") {
				sendShellCommand({ type: "bgm_youtube_pause" });
				return { success: true, output: "BGM paused" };
			}

			if (action === "resume") {
				sendShellCommand({ type: "bgm_youtube_resume" });
				return { success: true, output: "BGM resumed" };
			}

			if (action === "next") {
				sendShellCommand({ type: "bgm_youtube_next" });
				return { success: true, output: "Skipped to next track in favorites" };
			}

			if (action === "prev") {
				sendShellCommand({ type: "bgm_youtube_prev" });
				return { success: true, output: "Went to previous track in favorites" };
			}

			if (action === "volume") {
				const volume = Number(args.volume ?? -1);
				if (volume < 0 || volume > 1) {
					return { success: false, output: "volume must be 0.0-1.0" };
				}
				sendShellCommand({ type: "bgm_youtube_volume", volume });
				return { success: true, output: `Volume set to ${Math.round(volume * 100)}%` };
			}

			if (action === "fav_add") {
				sendShellCommand({ type: "bgm_youtube_fav_add" });
				return { success: true, output: "Added current track to favorites" };
			}

			if (action === "fav_remove") {
				sendShellCommand({ type: "bgm_youtube_fav_remove" });
				return { success: true, output: "Removed current track from favorites" };
			}

			if (action === "fav_list") {
				// This skill runs in the agent process and cannot read the Shell's
				// favorites store. The real list is injected into the system prompt
				// as BGM context (favoritesList). Point the model there instead of
				// returning fabricated data.
				return {
					success: true,
					output:
						"Do not call this action to read favorites. The favorites list is in the BGM context 'favoritesList' field ([{id,title}]). Read it directly from context. If favoritesList is absent or empty, the favorites are empty — do not invent titles.",
				};
			}

			return { success: false, output: `Unknown action: ${action}` };
		},
	};
}
