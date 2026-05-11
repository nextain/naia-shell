import {
	getApprovalRules,
	resolveApproval,
	setApprovalRules,
} from "../../gateway/approvals-proxy.js";
import { approvalsDescriptor } from "@naia-adk/skills-builtin";
import type { SkillDefinition, SkillResult } from "../types.js";

export function createApprovalsSkill(): SkillDefinition {
	return {
		name: `skill_${approvalsDescriptor.name}`,
		description: approvalsDescriptor.description,
		parameters: approvalsDescriptor.inputSchema,
		tier: 2,
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
						"Gateway not connected. Approval management requires a running Gateway.",
				};
			}

			switch (action) {
				case "get_rules": {
					const result = await getApprovalRules(gateway);
					return { success: true, output: JSON.stringify(result) };
				}

				case "set_rules": {
					const allowedTools = args.allowedTools as string[] | undefined;
					const blockedPatterns = args.blockedPatterns as string[] | undefined;
					const result = await setApprovalRules(gateway, {
						allowedTools,
						blockedPatterns,
					});
					return { success: true, output: JSON.stringify(result) };
				}

				case "resolve": {
					const requestId = args.requestId as string;
					const decision = args.decision as string;
					if (!requestId) {
						return {
							success: false,
							output: "",
							error: "requestId is required for resolve action",
						};
					}
					if (decision !== "approve" && decision !== "reject") {
						return {
							success: false,
							output: "",
							error: "decision must be 'approve' or 'reject'",
						};
					}
					const result = await resolveApproval(gateway, requestId, decision);
					return { success: true, output: JSON.stringify(result) };
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
