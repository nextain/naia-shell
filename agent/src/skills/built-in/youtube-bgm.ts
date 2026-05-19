/**
 * skill_youtube_bgm — AI skill for YouTube BGM control.
 *
 * Actions:
 *   search    : search YouTube for BGM videos
 *   play      : send bgm_youtube_play command to shell (shell fetches stream URL via /yt/stream)
 *   stop      : stop playback
 *   trending  : get trending music/ambient videos
 *   fav_add   : add currently playing track to favorites
 *   fav_remove: remove currently playing track from favorites
 *   fav_list  : list BGM favorites (returned from shell context)
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
					enum: ["search", "play", "stop", "trending", "fav_add", "fav_remove", "fav_list"],
					description:
						"search: find videos | play: play a video by ID | stop: stop playback | trending: get trending ambient/music | fav_add: add current track to favorites | fav_remove: remove current track from favorites | fav_list: list saved favorites",
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
					description: "Video title (for play action, optional — displayed in player)",
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

					const lines = results.map(
						(r) => `${r.index}. [${r.id}] ${r.title} (${r.duration}) — ${r.channel}`,
					);
					return {
						success: true,
						output: `YouTube search results for "${query}":\n${lines.join("\n")}\n\nTo play, use action=play with the video ID.`,
					};
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
				// Thumbnail via ytimg CDN — available for any public video without an API call
				const thumbnail = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

				// Delegate stream URL resolution to the shell's /yt/stream endpoint.
				// This keeps resolution logic in one place (youtube-server.ts).
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

			if (action === "fav_add") {
				sendShellCommand({ type: "bgm_youtube_fav_add" });
				return { success: true, output: "Added current track to favorites" };
			}

			if (action === "fav_remove") {
				sendShellCommand({ type: "bgm_youtube_fav_remove" });
				return { success: true, output: "Removed current track from favorites" };
			}

			if (action === "fav_list") {
				return {
					success: true,
					output: "Favorites list is available in BGM context (favoritesList field). Use it to see what the user has saved.",
				};
			}

			return { success: false, output: `Unknown action: ${action}` };
		},
	};
}
