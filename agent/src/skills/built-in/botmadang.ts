import { botmadangDescriptor } from "@naia-adk/skills-builtin";
import type { SkillDefinition, SkillResult } from "../types.js";

const BOTMADANG_API_URL = "https://botmadang.org/api/v1";

export function createBotmadangSkill(): SkillDefinition {
	return {
		name: `skill_${botmadangDescriptor.name}`,
		description: botmadangDescriptor.description,
		parameters: botmadangDescriptor.inputSchema,
		tier: 2, // Writing to an external community requires approval
		requiresGateway: false,
		source: "built-in",
		execute: async (args): Promise<SkillResult> => {
			const action = args.action as string;

			try {
				switch (action) {
					case "register": {
						const { agent_name, description } = args;
						if (!agent_name || !description) {
							return {
								success: false,
								output: "",
								error: "agent_name and description are required",
							};
						}
						const res = await fetch(`${BOTMADANG_API_URL}/agents/register`, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ name: agent_name, description }),
						});
						const data = await res.json();
						return {
							success: res.ok,
							output: JSON.stringify(data),
							error: res.ok ? undefined : `Failed to register: ${res.status}`,
						};
					}

					case "post_article": {
						const { api_key, submadang, title, content } = args;
						if (!api_key || !submadang || !title || !content) {
							return {
								success: false,
								output: "",
								error: "api_key, submadang, title, and content are required",
							};
						}
						const res = await fetch(`${BOTMADANG_API_URL}/posts`, {
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								Authorization: `Bearer ${api_key}`,
							},
							body: JSON.stringify({ submadang, title, content }),
						});
						const data = await res.json();
						return {
							success: res.ok,
							output: JSON.stringify(data),
							error: res.ok
								? undefined
								: `Failed to post article: ${res.status}`,
						};
					}

					case "comment": {
						const { api_key, post_id, content } = args;
						if (!api_key || !post_id || !content) {
							return {
								success: false,
								output: "",
								error: "api_key, post_id, and content are required",
							};
						}
						const res = await fetch(
							`${BOTMADANG_API_URL}/posts/${post_id}/comments`,
							{
								method: "POST",
								headers: {
									"Content-Type": "application/json",
									Authorization: `Bearer ${api_key}`,
								},
								body: JSON.stringify({ content }),
							},
						);
						const data = await res.json();
						return {
							success: res.ok,
							output: JSON.stringify(data),
							error: res.ok
								? undefined
								: `Failed to add comment: ${res.status}`,
						};
					}

					default:
						return {
							success: false,
							output: "",
							error: `Unknown action: ${action}`,
						};
				}
			} catch (err) {
				return {
					success: false,
					output: "",
					error: `Botmadang API error: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
		},
	};
}
