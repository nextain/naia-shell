import * as os from "node:os";
import { systemStatusDescriptor } from "@naia-adk/skills-builtin";
import type { SkillDefinition } from "../types.js";

export function createSystemStatusSkill(): SkillDefinition {
	return {
		name: `skill_${systemStatusDescriptor.name}`,
		description: systemStatusDescriptor.description,
		parameters: systemStatusDescriptor.inputSchema,
		tier: 0,
		requiresGateway: false,
		source: "built-in",
		execute: async (args) => {
			const section = (args.section as string) || "all";

			const getMemory = () => {
				const totalMB = Math.round(os.totalmem() / 1024 / 1024);
				const freeMB = Math.round(os.freemem() / 1024 / 1024);
				return { totalMB, freeMB, usedMB: totalMB - freeMB };
			};

			const getCpu = () => {
				const cpus = os.cpus();
				return {
					count: cpus.length,
					model: cpus[0]?.model ?? "unknown",
				};
			};

			const getOs = () => ({
				platform: os.platform(),
				release: os.release(),
				hostname: os.hostname(),
				arch: os.arch(),
			});

			let data: unknown;
			switch (section) {
				case "memory":
					data = getMemory();
					break;
				case "cpu":
					data = getCpu();
					break;
				case "os":
					data = getOs();
					break;
				default:
					data = {
						os: getOs(),
						memory: getMemory(),
						cpus: getCpu(),
						uptime: Math.round(os.uptime()),
					};
					break;
			}

			return { success: true, output: JSON.stringify(data) };
		},
	};
}
