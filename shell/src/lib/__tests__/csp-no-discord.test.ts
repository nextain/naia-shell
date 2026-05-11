/**
 * Test: tauri.conf.json CSP must not allow direct WebView access to discord.com.
 *
 * Security regression — #259 Discord webhook exfiltration channel.
 * All Discord API traffic must go through Rust's `discord_api` Tauri command,
 * which reads the bot token from gateway config and performs the request
 * server-side. WebView-side fetch to discord.com is an exfiltration vector
 * because prompt injection / XSS can POST conversation data to a
 * discord.com/api/webhooks/... URL with no local auditing.
 *
 * Run:
 *   pnpm exec vitest run src/lib/__tests__/csp-no-discord.test.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function loadCsp(): string {
	const path = resolve(__dirname, "../../../src-tauri/tauri.conf.json");
	const cfg = JSON.parse(readFileSync(path, "utf-8"));
	return cfg.app?.security?.csp ?? "";
}

describe("CSP no-direct-discord rule (#259)", () => {
	it("CSP does not list discord.com in any directive", () => {
		const csp = loadCsp();
		expect(csp).toBeTruthy();
		expect(csp.toLowerCase()).not.toContain("discord.com");
	});

	it("connect-src does not whitelist discord.com", () => {
		const csp = loadCsp();
		const connectSrc =
			csp
				.split(";")
				.map((s) => s.trim())
				.find((s) => s.startsWith("connect-src")) ?? "";
		expect(connectSrc).not.toMatch(/discord\.com/i);
	});

	it("connect-src still includes gateway endpoint (sanity)", () => {
		const csp = loadCsp();
		const connectSrc =
			csp
				.split(";")
				.map((s) => s.trim())
				.find((s) => s.startsWith("connect-src")) ?? "";
		// Gateway is the legitimate route — must still be reachable.
		expect(connectSrc).toMatch(/localhost:18789|naia-gateway/);
	});
});
