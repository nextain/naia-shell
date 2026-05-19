import {
	getConfig,
	getConfigSchema,
	listModels,
	patchConfig,
	setConfig,
} from "../../gateway/config-proxy.js";
import { MODEL_PRICING } from "../../providers/cost.js";
import { configDescriptor } from "@naia-adk/skills-builtin";
import type { SkillDefinition, SkillResult } from "../types.js";

export function createConfigSkill(): SkillDefinition {
	return {
		name: `skill_${configDescriptor.name}`,
		description: configDescriptor.description,
		parameters: configDescriptor.inputSchema,
		tier: 1,
		requiresGateway: false,
		source: "built-in",
		execute: async (args, ctx): Promise<SkillResult> => {
			const action = args.action as string;
			const gateway = ctx.gateway;

			if (action !== "models" && !gateway?.isConnected()) {
				return {
					success: false,
					output: "",
					error:
						"Gateway not connected. Config management requires a running Gateway.",
				};
			}

			switch (action) {
				case "get": {
					const result = await getConfig(gateway!);
					return { success: true, output: JSON.stringify(result) };
				}

				case "set": {
					const patch = args.patch as Record<string, unknown> | undefined;
					if (!patch || Object.keys(patch).length === 0) {
						return {
							success: false,
							output: "",
							error: "patch is required for set action",
						};
					}
					const result = await setConfig(gateway!, patch);
					return { success: true, output: JSON.stringify(result) };
				}

				case "schema": {
					const result = await getConfigSchema(gateway!);
					return { success: true, output: JSON.stringify(result) };
				}

				case "models": {
					const localModels = [
						{
							id: "gemini-3-pro-preview",
							name: "Gemini 3 Pro",
							provider: "gemini",
						},
						{
							id: "gemini-3-flash-preview",
							name: "Gemini 3 Flash",
							provider: "gemini",
						},
						{
							id: "gemini-2.5-pro",
							name: "Gemini 2.5 Pro",
							provider: "gemini",
						},
						{
							id: "gemini-2.5-flash",
							name: "Gemini 2.5 Flash",
							provider: "gemini",
						},
						{ id: "gpt-5.2", name: "GPT-5.2", provider: "openai" },
						{ id: "gpt-5.1", name: "GPT-5.1", provider: "openai" },
						{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" },
						{ id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
						{ id: "o4-mini", name: "o4 Mini", provider: "openai" },
						{
							id: "claude-sonnet-4-5-20250929",
							name: "Claude Sonnet 4.5",
							provider: "anthropic",
						},
						{
							id: "claude-sonnet-4-20250514",
							name: "Claude Sonnet 4",
							provider: "anthropic",
						},
						{
							id: "claude-haiku-4-5-20251001",
							name: "Claude Haiku 4.5",
							provider: "anthropic",
						},
						{
							id: "claude-opus-4-5-20251101",
							name: "Claude Opus 4.5",
							provider: "anthropic",
						},
						{ id: "grok-4", name: "Grok 4", provider: "xai" },
						{
							id: "grok-4-1-fast-reasoning",
							name: "Grok 4.1 Fast",
							provider: "xai",
						},
						{ id: "grok-code-fast-1", name: "Grok Code Fast", provider: "xai" },
						{ id: "grok-3-mini", name: "Grok 3 Mini", provider: "xai" },
						{ id: "glm-5.1", name: "GLM 5.1", provider: "zai" },
						{ id: "glm-5-turbo", name: "GLM 5 Turbo", provider: "zai" },
						{ id: "glm-4.7", name: "GLM 4.7", provider: "zai" },
						{ id: "glm-4.5-air", name: "GLM 4.5 Air", provider: "zai" },
					].map((m) => {
						const price = MODEL_PRICING[m.id];
						return price ? { ...m, price } : m;
					});

					// Dynamically discover Ollama models
					let ollamaModels: any[] = [];
					try {
						const res = await fetch("http://localhost:11434/api/tags");
						if (res.ok) {
							const data = await res.json();
							ollamaModels = (data.models ?? []).map((m: any) => ({
								id: m.name,
								name: m.name,
								provider: "ollama",
							}));
						}
					} catch {
						// Ollama not running — skip
					}

					let gatewayModels: any[] = [];
					if (gateway?.isConnected()) {
						try {
							const res = await listModels(gateway);
							gatewayModels = res.models || [];
						} catch {
							// Ignore if gateway fails to list models
						}
					}

					// Merge, preferring gateway models if IDs conflict
					const merged = [...gatewayModels];
					for (const lm of [...localModels, ...ollamaModels]) {
						if (!merged.find((m) => m.id === lm.id)) {
							merged.push(lm);
						}
					}

					return { success: true, output: JSON.stringify({ models: merged }) };
				}

				case "patch": {
					const patch = (args.patch as Record<string, unknown>) ?? {};
					const result = await patchConfig(gateway!, patch);
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
