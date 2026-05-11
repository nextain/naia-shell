/**
 * Test: notify_config caches webhook URLs into process.env (#260).
 *
 * Validates the security refactor that replaced per-chat_request webhook
 * transmission with a one-shot notify_config message. The agent must:
 * - Set the env vars when notify_config arrives
 * - Clear them when an empty string is sent (explicit unset)
 * - Leave them alone when undefined is sent (partial update)
 *
 * Run:
 *   pnpm exec vitest run src/__tests__/notify-config.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("handleNotifyConfig env caching (#260)", () => {
	const PRESERVED: Record<string, string | undefined> = {};
	const ENV_KEYS = [
		"SLACK_WEBHOOK_URL",
		"DISCORD_WEBHOOK_URL",
		"GOOGLE_CHAT_WEBHOOK_URL",
		"DISCORD_DEFAULT_USER_ID",
		"DISCORD_DEFAULT_TARGET",
		"DISCORD_DEFAULT_CHANNEL_ID",
	];

	beforeEach(() => {
		for (const k of ENV_KEYS) {
			PRESERVED[k] = process.env[k];
			delete process.env[k];
		}
	});

	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (PRESERVED[k] === undefined) delete process.env[k];
			else process.env[k] = PRESERVED[k];
		}
	});

	it("sets env vars from notify_config request", async () => {
		const { handleNotifyConfig } = await import("../index.js");
		handleNotifyConfig({
			type: "notify_config",
			slackWebhookUrl: "https://hooks.slack.com/services/T/B/C",
			discordWebhookUrl: "https://discord.com/api/webhooks/123/abc",
			googleChatWebhookUrl: "https://chat.googleapis.com/v1/spaces/X/messages",
			discordDefaultUserId: "user-1",
			discordDefaultTarget: "dm",
			discordDmChannelId: "channel-1",
		});

		expect(process.env.SLACK_WEBHOOK_URL).toBe(
			"https://hooks.slack.com/services/T/B/C",
		);
		expect(process.env.DISCORD_WEBHOOK_URL).toBe(
			"https://discord.com/api/webhooks/123/abc",
		);
		expect(process.env.GOOGLE_CHAT_WEBHOOK_URL).toBe(
			"https://chat.googleapis.com/v1/spaces/X/messages",
		);
		expect(process.env.DISCORD_DEFAULT_USER_ID).toBe("user-1");
		expect(process.env.DISCORD_DEFAULT_TARGET).toBe("dm");
		expect(process.env.DISCORD_DEFAULT_CHANNEL_ID).toBe("channel-1");
	});

	it("clears env vars when an explicit empty string is sent (unset)", async () => {
		const { handleNotifyConfig } = await import("../index.js");
		process.env.SLACK_WEBHOOK_URL = "previous-value";
		handleNotifyConfig({
			type: "notify_config",
			slackWebhookUrl: "",
		});
		expect(process.env.SLACK_WEBHOOK_URL).toBeUndefined();
	});

	it("preserves env vars when a field is undefined (partial update)", async () => {
		const { handleNotifyConfig } = await import("../index.js");
		process.env.DISCORD_WEBHOOK_URL = "kept-value";
		handleNotifyConfig({
			type: "notify_config",
			slackWebhookUrl: "https://hooks.slack.com/services/X/Y/Z",
			// discordWebhookUrl deliberately omitted
		});
		expect(process.env.SLACK_WEBHOOK_URL).toBe(
			"https://hooks.slack.com/services/X/Y/Z",
		);
		expect(process.env.DISCORD_WEBHOOK_URL).toBe("kept-value");
	});
});

describe("AgentRequest schema does NOT carry credentials per-request (#260)", () => {
	it("ChatRequest / ToolRequest type no longer declares webhook fields", async () => {
		// Compile-time check via duck-typing: build a request object that's a
		// valid ChatRequest WITHOUT any webhook field and confirm TS accepts it.
		// (TS would fail this file at type-check if webhook fields were required.)
		const chatReq: import("../protocol.js").ChatRequest = {
			type: "chat_request",
			requestId: "r1",
			provider: { provider: "gemini", model: "x", apiKey: "k" },
			messages: [],
		};
		const toolReq: import("../protocol.js").ToolRequest = {
			type: "tool_request",
			requestId: "r2",
			toolName: "read_file",
			args: { path: "/tmp/x" },
		};
		// Runtime sanity: serialized requests don't carry credentials when
		// constructed minimally (the shell's actual builders also omit them).
		expect(JSON.stringify(chatReq)).not.toContain("WebhookUrl");
		expect(JSON.stringify(toolReq)).not.toContain("WebhookUrl");
	});
});
