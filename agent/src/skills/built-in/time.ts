import { timeDescriptor } from "@naia-adk/skills-builtin";
import type { SkillDefinition } from "../types.js";

export function createTimeSkill(): SkillDefinition {
	return {
		name: `skill_${timeDescriptor.name}`,
		description: timeDescriptor.description,
		parameters: timeDescriptor.inputSchema,
		tier: 0, // descriptor.tier = "T0"
		requiresGateway: false,
		source: "built-in",
		execute: async (args) => {
			const format = (args.format as string) || "locale";
			const tz = args.timezone as string | undefined;
			const now = new Date();

			let output: string;
			switch (format) {
				case "unix":
					output = String(Math.floor(now.getTime() / 1000));
					break;
				case "iso": {
					if (tz) {
						const formatter = new Intl.DateTimeFormat("en-US", {
							timeZone: tz,
							year: "numeric",
							month: "2-digit",
							day: "2-digit",
							hour: "2-digit",
							minute: "2-digit",
							second: "2-digit",
							hour12: false,
							fractionalSecondDigits: 3,
							timeZoneName: "longOffset",
						});
						const parts = formatter.formatToParts(now);
						const get = (t: string) =>
							parts.find((p) => p.type === t)?.value ?? "";
						const offset = get("timeZoneName").replace("GMT", "");
						output = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${offset || "Z"}`;
					} else {
						output = now.toISOString();
					}
					break;
				}
				default: {
					const options: Intl.DateTimeFormatOptions = tz
						? { timeZone: tz, dateStyle: "full", timeStyle: "long" }
						: { dateStyle: "full", timeStyle: "long" };
					output = new Intl.DateTimeFormat("ko-KR", options).format(now);
					break;
				}
			}

			return { success: true, output };
		},
	};
}
