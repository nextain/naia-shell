import {
	createAgent,
	deleteAgent,
	getAgentFile,
	listAgentFiles,
	listAgents,
	setAgentFile,
	updateAgent,
} from "../../gateway/agents-proxy.js";
import { agentsDescriptor } from "@naia-adk/skills-builtin";
import type { SkillDefinition, SkillResult } from "../types.js";

export function createAgentsSkill(): SkillDefinition {
	return {
		name: `skill_${agentsDescriptor.name}`,
		description: agentsDescriptor.description,
		parameters: agentsDescriptor.inputSchema,
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
						"Gateway not connected. Agent management requires a running Gateway.",
				};
			}

			switch (action) {
				case "list": {
					const result = await listAgents(gateway);
					return {
						success: true,
						output: JSON.stringify(result),
					};
				}

				case "create": {
					const name = args.name as string;
					if (!name) {
						return {
							success: false,
							output: "",
							error: "name is required for create action",
						};
					}
					const result = await createAgent(gateway, {
						name,
						description: args.description as string | undefined,
						model: args.model as string | undefined,
					});
					return {
						success: true,
						output: JSON.stringify(result),
					};
				}

				case "update": {
					const id = args.id as string;
					if (!id) {
						return {
							success: false,
							output: "",
							error: "id is required for update action",
						};
					}
					const result = await updateAgent(gateway, id, {
						name: args.name as string | undefined,
						description: args.description as string | undefined,
						model: args.model as string | undefined,
					});
					return {
						success: true,
						output: JSON.stringify(result),
					};
				}

				case "delete": {
					const id = args.id as string;
					if (!id) {
						return {
							success: false,
							output: "",
							error: "id is required for delete action",
						};
					}
					const result = await deleteAgent(gateway, id);
					return {
						success: true,
						output: JSON.stringify(result),
					};
				}

				case "files_list": {
					const agentId = args.agentId as string;
					if (!agentId) {
						return {
							success: false,
							output: "",
							error: "agentId is required for files_list action",
						};
					}
					const result = await listAgentFiles(gateway, agentId);
					return {
						success: true,
						output: JSON.stringify(result),
					};
				}

				case "files_get": {
					const agentId = args.agentId as string;
					const path = args.path as string;
					if (!agentId) {
						return {
							success: false,
							output: "",
							error: "agentId is required for files_get action",
						};
					}
					if (!path) {
						return {
							success: false,
							output: "",
							error: "path is required for files_get action",
						};
					}
					const result = await getAgentFile(gateway, agentId, path);
					return {
						success: true,
						output: JSON.stringify(result),
					};
				}

				case "files_set": {
					const agentId = args.agentId as string;
					const path = args.path as string;
					const content = args.content as string;
					if (!agentId) {
						return {
							success: false,
							output: "",
							error: "agentId is required for files_set action",
						};
					}
					if (!path) {
						return {
							success: false,
							output: "",
							error: "path is required for files_set action",
						};
					}
					if (content == null) {
						return {
							success: false,
							output: "",
							error: "content is required for files_set action",
						};
					}
					const result = await setAgentFile(gateway, agentId, path, content);
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
