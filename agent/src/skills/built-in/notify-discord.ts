import { notifyDiscordDescriptor } from "@naia-adk/skills-builtin";
import type { SkillDefinition } from "../types.js";
import { getNotifyWebhookUrl } from "./notify-config.js";

export function createNotifyDiscordSkill(): SkillDefinition {
	return {
		name: `skill_${notifyDiscordDescriptor.name}`,
		description: notifyDiscordDescriptor.description,
		parameters: notifyDiscordDescriptor.inputSchema,
		tier: 1,
		requiresGateway: false,
		source: "built-in",
		execute: async (args, ctx) => {
			const message = (args.message as string | undefined)?.trim();
			if (!message) {
				return {
					success: false,
					output: "",
					error: "message is required",
				};
			}

			// 1st: Try Gateway relay
			const gateway = ctx.gateway;
			if (gateway?.isConnected()) {
				try {
					const methods = (gateway as { availableMethods?: string[] })
						.availableMethods;
					if (Array.isArray(methods) && methods.includes("skills.invoke")) {
						await gateway.request("skills.invoke", {
							skill: "discord",
							args: { message },
						});
						return {
							success: true,
							output: "Message sent to Discord via Gateway relay",
						};
					}
				} catch {
					// Gateway relay failed — fall through to direct webhook
				}
			}

			// 2nd: Direct webhook
			const webhookUrl = await getNotifyWebhookUrl("discord");
			if (!webhookUrl) {
				return {
					success: false,
					output: "",
					error:
						"Discord webhook URL not configured. Set DISCORD_WEBHOOK_URL env var or add notifications.discord.webhookUrl to ~/.naia/config.json",
				};
			}

			try {
				const payload: Record<string, string> = { content: message };
				if (args.username) payload.username = args.username as string;

				const res = await fetch(webhookUrl, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(payload),
					signal: AbortSignal.timeout(10_000),
				});

				if (!res.ok) {
					return {
						success: false,
						output: "",
						error: `Discord webhook returned ${res.status}`,
					};
				}

				return {
					success: true,
					output: "Message sent to Discord successfully",
				};
			} catch (err) {
				return {
					success: false,
					output: "",
					error: `Discord notification failed: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
		},
	};
}
