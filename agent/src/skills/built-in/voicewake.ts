import * as fs from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { voicewakeDescriptor } from "@naia-adk/skills-builtin";
import {
	type VoiceWakeResult,
	getVoiceWakeTriggers,
	setVoiceWakeTriggers,
} from "../../gateway/voicewake-proxy.js";
import type { SkillDefinition, SkillResult } from "../types.js";

const DEFAULT_TRIGGERS = ["낸", "naia"];

function voiceWakeStorePath(): string {
	return process.env.NAIA_VOICEWAKE_PATH ?? `${homedir()}/.naia/voicewake.json`;
}

function readLocalVoiceWakeTriggers(): string[] {
	try {
		const raw = fs.readFileSync(voiceWakeStorePath(), "utf8");
		const parsed = JSON.parse(raw) as { triggers?: unknown } | unknown[];
		const triggers = Array.isArray(parsed) ? parsed : parsed.triggers;
		if (!Array.isArray(triggers)) return DEFAULT_TRIGGERS;
		return triggers.filter((item): item is string => typeof item === "string");
	} catch {
		return DEFAULT_TRIGGERS;
	}
}

function writeLocalVoiceWakeTriggers(triggers: string[]): void {
	const path = voiceWakeStorePath();
	fs.mkdirSync(dirname(path), { recursive: true });
	fs.writeFileSync(path, `${JSON.stringify({ triggers }, null, 2)}\n`, "utf8");
}

export function createVoiceWakeSkill(): SkillDefinition {
	return {
		name: `skill_${voicewakeDescriptor.name}`,
		description: voicewakeDescriptor.description,
		parameters: voicewakeDescriptor.inputSchema,
		tier: 0,
		requiresGateway: false,
		source: "built-in",
		execute: async (args, ctx): Promise<SkillResult> => {
			const action = args.action as string;
			const gateway = ctx.gateway;

			switch (action) {
				case "get": {
					let result: VoiceWakeResult | undefined;
					if (gateway?.isConnected()) {
						try {
							result = await getVoiceWakeTriggers(gateway);
						} catch {
							result = undefined;
						}
					}
					result ??= { triggers: readLocalVoiceWakeTriggers() };
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
					const normalized = triggers.filter(
						(item): item is string => typeof item === "string",
					);
					let result: VoiceWakeResult | undefined;
					if (gateway?.isConnected()) {
						try {
							result = await setVoiceWakeTriggers(gateway, normalized);
						} catch {
							result = undefined;
						}
					}
					if (!result) {
						writeLocalVoiceWakeTriggers(normalized);
						result = { triggers: normalized };
					}
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
