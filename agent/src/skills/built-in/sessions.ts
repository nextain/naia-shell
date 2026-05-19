import {
	compactSession,
	deleteSession,
	listSessions,
	patchSession,
	previewSession,
	resetSession,
} from "../../gateway/sessions-proxy.js";
import { sessionsDescriptor } from "@naia-adk/skills-builtin";
import type { SkillDefinition, SkillResult } from "../types.js";

export function createSessionsSkill(): SkillDefinition {
	return {
		name: `skill_${sessionsDescriptor.name}`,
		description: sessionsDescriptor.description,
		parameters: sessionsDescriptor.inputSchema,
		tier: 1,
		requiresGateway: true,
		source: "built-in",
		execute: async (args, ctx): Promise<SkillResult> => {
			const action = args.action as string;
			const gateway = ctx.gateway;

			if (!gateway?.isConnected()) {
				return {
					success: false,
					output: "",
					error:
						"Gateway not connected. Session management requires a running Gateway.",
				};
			}

			switch (action) {
				case "list": {
					const result = await listSessions(gateway);
					return {
						success: true,
						output: JSON.stringify(result),
					};
				}

				case "history": {
					const key = args.key as string;
					if (!key) {
						return {
							success: false,
							output: "",
							error: "key is required for history action",
						};
					}
					try {
						const result = await gateway.request("chat.history", {
							sessionKey: key,
						});
						return {
							success: true,
							output: JSON.stringify(result),
						};
					} catch (err) {
						return {
							success: false,
							output: "",
							error: `chat.history failed: ${err instanceof Error ? err.message : String(err)}`,
						};
					}
				}

				case "delete": {
					const key = args.key as string;
					if (!key) {
						return {
							success: false,
							output: "",
							error: "key is required for delete action",
						};
					}
					const result = await deleteSession(gateway, key);
					return {
						success: true,
						output: JSON.stringify(result),
					};
				}

				case "compact": {
					const key = args.key as string;
					if (!key) {
						return {
							success: false,
							output: "",
							error: "key is required for compact action",
						};
					}
					const result = await compactSession(gateway, key);
					return {
						success: true,
						output: JSON.stringify(result),
					};
				}

				case "preview": {
					const key = args.key as string;
					if (!key) {
						return {
							success: false,
							output: "",
							error: "key is required for preview action",
						};
					}
					const result = await previewSession(gateway, key);
					return {
						success: true,
						output: JSON.stringify(result),
					};
				}

				case "patch": {
					const key = args.key as string;
					if (!key) {
						return {
							success: false,
							output: "",
							error: "key is required for patch action",
						};
					}
					const patchData = (args.patch as Record<string, unknown>) ?? {};
					const result = await patchSession(gateway, key, patchData);
					return {
						success: true,
						output: JSON.stringify(result),
					};
				}

				case "reset": {
					const key = args.key as string;
					if (!key) {
						return {
							success: false,
							output: "",
							error: "key is required for reset action",
						};
					}
					const result = await resetSession(gateway, key);
					return {
						success: true,
						output: JSON.stringify(result),
					};
				}

				default:
					return {
						success: false,
						output: "",
						error: `Unknown action: ${action}`,
					};
			}
		},
	};
}
