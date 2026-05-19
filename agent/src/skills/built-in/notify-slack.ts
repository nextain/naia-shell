import { notifySlackDescriptor } from "@naia-adk/skills-builtin";
import type { SkillDefinition } from "../types.js";
import { getNotifyWebhookUrl } from "./notify-config.js";

export function createNotifySlackSkill(): SkillDefinition {
	return {
		name: `skill_${notifySlackDescriptor.name}`,
		description: notifySlackDescriptor.description,
		parameters: notifySlackDescriptor.inputSchema,
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
							skill: "slack",
							args: { message },
						});
						return {
							success: true,
							output: "Message sent to Slack via Gateway relay",
						};
					}
				} catch {
					// Gateway relay failed — fall through to direct webhook
				}
			}

			// 2nd: Direct webhook
			const webhookUrl = await getNotifyWebhookUrl("slack");
			if (!webhookUrl) {
				return {
					success: false,
					output: "",
					error:
						"Slack webhook URL not configured. Set SLACK_WEBHOOK_URL env var or add notifications.slack.webhookUrl to ~/.naia/config.json",
				};
			}

			try {
				const payload: Record<string, string> = { text: message };
				if (args.channel) payload.channel = args.channel as string;
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
						error: `Slack webhook returned ${res.status}`,
					};
				}

				return {
					success: true,
					output: "Message sent to Slack successfully",
				};
			} catch (err) {
				return {
					success: false,
					output: "",
					error: `Slack notification failed: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
		},
	};
}
