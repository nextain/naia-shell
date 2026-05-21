import {
	compactSession,
	deleteSession,
	listSessions,
	patchSession,
	previewSession,
	resetSession,
} from "../../gateway/sessions-proxy.js";
import {
	deleteLocalSession,
	getLocalSession,
	listLocalSessions,
} from "../../local-sessions.js";
import { sessionsDescriptor } from "@naia-adk/skills-builtin";
import type { SkillDefinition, SkillResult } from "../types.js";

export function createSessionsSkill(): SkillDefinition {
	return {
		name: `skill_${sessionsDescriptor.name}`,
		description: sessionsDescriptor.description,
		parameters: sessionsDescriptor.inputSchema,
		tier: 1,
		requiresGateway: false,
		source: "built-in",
		execute: async (args, ctx): Promise<SkillResult> => {
			const action = args.action as string;
			const gateway = ctx.gateway;
			const gatewayConnected = !!gateway?.isConnected();

			switch (action) {
				case "list": {
					if (!gatewayConnected) {
						// Local fallback: read from ~/.naia/sessions/
						const limit =
							typeof args.limit === "number" ? args.limit : 50;
						const localSessions = listLocalSessions(limit);
						return {
							success: true,
							output: JSON.stringify({
								sessions: localSessions.map((s) => ({
									key: s.id,
									label: s.label,
									messageCount: s.messages.length,
									createdAt: s.createdAt,
									updatedAt: s.updatedAt,
								})),
							}),
						};
					}
					const result = await listSessions(gateway!);
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
					if (!gatewayConnected) {
						// Local fallback: read from ~/.naia/sessions/{key}.json
						const session = getLocalSession(key);
						if (!session) {
							return {
								success: false,
								output: "",
								error: `Session not found: ${key}`,
							};
						}
						return {
							success: true,
							output: JSON.stringify({
								messages: session.messages.map((m) => ({
									role: m.role,
									content: [{ type: "text", text: m.content }],
									timestamp: m.timestamp,
								})),
							}),
						};
					}
					try {
						const result = await gateway!.request("chat.history", {
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
					if (!gatewayConnected) {
						// Local fallback: delete from ~/.naia/sessions/{key}.json
						const deleted = deleteLocalSession(key);
						return {
							success: true,
							output: JSON.stringify({ deleted, key }),
						};
					}
					const result = await deleteSession(gateway!, key);
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
					if (!gatewayConnected) {
						return {
							success: false,
							output: "",
							error: "compact requires a Gateway connection.",
						};
					}
					const result = await compactSession(gateway!, key);
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
					if (!gatewayConnected) {
						// Return label from local session as summary
						const session = getLocalSession(key);
						return {
							success: !!session,
							output: session
								? JSON.stringify({ key, summary: session.label })
								: "",
							error: session ? undefined : `Session not found: ${key}`,
						};
					}
					const result = await previewSession(gateway!, key);
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
					if (!gatewayConnected) {
						return {
							success: false,
							output: "",
							error: "patch requires a Gateway connection.",
						};
					}
					const patchData = (args.patch as Record<string, unknown>) ?? {};
					const result = await patchSession(gateway!, key, patchData);
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
					if (!gatewayConnected) {
						// For local sessions reset means delete (no Gateway to reset)
						deleteLocalSession(key);
						return {
							success: true,
							output: JSON.stringify({ key, reset: true }),
						};
					}
					const result = await resetSession(gateway!, key);
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
