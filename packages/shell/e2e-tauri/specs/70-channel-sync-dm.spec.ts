import { S } from "../helpers/selectors.js";
import { safeRefresh } from "../helpers/settings.js";

/**
 * 70 — Channel Sync: DM Channel ID Refresh
 *
 * Tests the channel sync flow end-to-end:
 *   1. BFF linked-channels API returns Discord channel
 *   2. Rust discord_api invoke resolves DM channel ID
 *   3. Config persists across refresh
 *
 * Note: Tauri deep-link events (listen/emit) cannot be simulated
 * in WebDriver E2E. Instead, we directly call the APIs and verify
 * the downstream results (same pattern as 13-lab-login.spec.ts).
 *
 * Requires:
 *   - LAB_KEY + LAB_USER_ID env vars
 *   - Discord bot token in Naia config (for openDmChannel via Rust)
 *   - naia.nextain.io BFF reachable
 *
 * Skips gracefully if credentials are missing.
 */

const LAB_KEY = process.env.LAB_KEY || "";
const LAB_USER_ID = process.env.LAB_USER_ID || "";

describe("70 — Channel Sync (DM Channel ID)", () => {
	if (!LAB_KEY || !LAB_USER_ID) {
		it("(skipped — no LAB_KEY / LAB_USER_ID env vars)", () => {});
		return;
	}

	it("should fetch linked channels from BFF", async () => {
		// Call the BFF directly from the browser context
		const result = await browser.execute(
			async (key: string, userId: string) => {
				try {
					const res = await fetch(
						"https://naia.nextain.io/api/gateway/linked-channels",
						{
							headers: {
								"X-Desktop-Key": key,
								"X-User-Id": userId,
							},
						},
					);
					if (!res.ok) return { error: `HTTP ${res.status}`, channels: [] };
					const data = await res.json();
					return { error: null, channels: data.channels || [] };
				} catch (err) {
					return { error: String(err), channels: [] };
				}
			},
			LAB_KEY,
			LAB_USER_ID,
		);

		console.log("[e2e] BFF response:", JSON.stringify(result));
		expect(result.error).toBeNull();
		expect(result.channels.length).toBeGreaterThan(0);

		const discord = result.channels.find(
			(ch: { type: string }) => ch.type === "discord",
		);
		expect(discord).toBeTruthy();
		expect(discord.userId).toMatch(/^\d{17,20}$/); // Discord snowflake

		console.log(`[e2e] Discord user ID from BFF: ${discord.userId}`);
	});

	it("should resolve DM channel ID via Rust discord_api", async () => {
		// First get the discord user ID from BFF
		const bffResult = await browser.execute(
			async (key: string, userId: string) => {
				const res = await fetch(
					"https://naia.nextain.io/api/gateway/linked-channels",
					{
						headers: {
							"X-Desktop-Key": key,
							"X-User-Id": userId,
						},
					},
				);
				const data = await res.json();
				const discord = (data.channels || []).find(
					(ch: { type: string }) => ch.type === "discord",
				);
				return discord?.userId || "";
			},
			LAB_KEY,
			LAB_USER_ID,
		);

		expect(bffResult).toBeTruthy();

		// Call Rust discord_api to open DM channel
		// discord_api(endpoint, method, body) — POST /users/@me/channels
		const dmChannelResult = await browser.execute(
			async (discordUserId: string) => {
				try {
					// @ts-expect-error — Tauri 2 internal API
					const internals = (window as any).__TAURI_INTERNALS__;
					if (!internals?.invoke)
						return { error: "No Tauri internals", channelId: "" };
					const raw = await internals.invoke("discord_api", {
						endpoint: "/users/@me/channels",
						method: "POST",
						body: JSON.stringify({ recipient_id: discordUserId }),
					});
					const parsed = JSON.parse(raw);
					return { error: null, channelId: parsed.id || "" };
				} catch (err) {
					return { error: String(err), channelId: "" };
				}
			},
			bffResult,
		);

		console.log("[e2e] DM channel result:", JSON.stringify(dmChannelResult));
		expect(dmChannelResult.error).toBeNull();
		expect(dmChannelResult.channelId).toMatch(/^\d{17,20}$/);

		// Save to config (simulating what syncLinkedChannels does)
		await browser.execute(
			(discordUserId: string, channelId: string) => {
				const raw = localStorage.getItem("naia-config");
				const config = raw ? JSON.parse(raw) : {};
				config.discordDefaultUserId = discordUserId;
				config.discordDmChannelId = channelId;
				config.discordDefaultTarget =
					config.discordDefaultTarget || `user:${discordUserId}`;
				localStorage.setItem("naia-config", JSON.stringify(config));
			},
			bffResult,
			dmChannelResult.channelId,
		);

		console.log(
			`[e2e] Channel sync verified: discordUserId=${bffResult}, dmChannelId=${dmChannelResult.channelId}`,
		);
	});

	it("should persist DM channel ID across page refresh", async () => {
		const beforeRefresh = await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			if (!raw) return "";
			return JSON.parse(raw).discordDmChannelId || "";
		});
		expect(beforeRefresh).toBeTruthy();

		await safeRefresh();

		const appRoot = await $(S.appRoot);
		await appRoot.waitForDisplayed({ timeout: 15_000 });

		const afterRefresh = await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			if (!raw) return "";
			return JSON.parse(raw).discordDmChannelId || "";
		});
		expect(afterRefresh).toBe(beforeRefresh);
	});
});
