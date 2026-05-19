import {
	getVoiceWakeTriggers,
	setVoiceWakeTriggers,
} from "../../gateway/voicewake-proxy.js";
import { voicewakeDescriptor } from "@naia-adk/skills-builtin";
import type { SkillDefinition, SkillResult } from "../types.js";

export function createVoiceWakeSkill(): SkillDefinition {
	return {
		name: `skill_${voicewakeDescriptor.name}`,
		description: voicewakeDescriptor.description,
		parameters: voicewakeDescriptor.inputSchema,
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
						"Gateway not connected. Voice wake management requires a running Gateway.",
				};
			}

			switch (action) {
				case "get": {
					const result = await getVoiceWakeTriggers(gateway);
					return {
						success: true,
						output: JSON.stringify(result),
					};
				}

				case "set": {
					const triggers = args.triggers as string[] | undefined;
					if (!triggers || !Array.isArray(triggers)) {
						return {
							success: false,
							output: "",
							error: "triggers array is required for set action",
						};
					}
					const result = await setVoiceWakeTriggers(gateway, triggers);
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
