import {
	getGatewayStatus,
	getHealth,
	getUsageCost,
	getUsageStatus,
	pollLogsTail,
} from "../../gateway/diagnostics-proxy.js";
import { diagnosticsDescriptor } from "@naia-adk/skills-builtin";
import type { SkillDefinition, SkillResult } from "../types.js";

export function createDiagnosticsSkill(): SkillDefinition {
	return {
		name: `skill_${diagnosticsDescriptor.name}`,
		description: diagnosticsDescriptor.description,
		parameters: diagnosticsDescriptor.inputSchema,
		tier: 0,
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
						"Gateway not connected. Diagnostics requires a running Gateway.",
				};
			}

			switch (action) {
				case "health": {
					const result = await getHealth(gateway);
					return { success: true, output: JSON.stringify(result) };
				}

				case "status": {
					const result = await getGatewayStatus(gateway);
					return { success: true, output: JSON.stringify(result) };
				}

				case "usage_status": {
					const result = await getUsageStatus(gateway);
					return { success: true, output: JSON.stringify(result) };
				}

				case "usage_cost": {
					const result = await getUsageCost(gateway);
					return { success: true, output: JSON.stringify(result) };
				}

				case "logs_poll":
				case "logs_start": {
					const cursor =
						typeof args.cursor === "number" ? args.cursor : undefined;
					const result = await pollLogsTail(gateway, cursor);
					return { success: true, output: JSON.stringify(result) };
				}

				case "logs_stop": {
					// No-op — polling is stateless, just return success
					return { success: true, output: JSON.stringify({ stopped: true }) };
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
