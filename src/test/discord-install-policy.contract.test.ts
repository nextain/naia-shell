import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DISCORD_BOT_PERMISSIONS,
	DISCORD_GATEWAY_INTENTS,
	buildDiscordInstallUrl,
	isCanonicalPositiveUint64Decimal,
} from "../main/domain/discord-setup.js";

const TAURI_LIB_RS = readFileSync(
	"packages/shell/src-tauri/src/lib.rs",
	"utf8",
);
const REQUIREMENTS_MD = readFileSync("docs/requirements.md", "utf8");

function sourceFilesUnder(root: string, options: { includeTests?: boolean } = {}) {
	const files: string[] = [];
	const visit = (dir: string) => {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			const stat = statSync(path);
			if (stat.isDirectory()) {
				visit(path);
				continue;
			}
			if (!/\.(?:ts|tsx|js|jsx)$/.test(entry)) continue;
			if (!options.includeTests && /\.(?:test|spec)\.(?:ts|tsx|js|jsx)$/.test(entry)) {
				continue;
			}
			files.push(path);
		}
	};
	visit(root);
	return files;
}

function forbiddenMatches(files: string[], patterns: RegExp[]) {
	return files.flatMap((path) => {
		const text = readFileSync(path, "utf8");
		return patterns
			.filter((pattern) => pattern.test(text))
			.map((pattern) => `${relative(".", path).replaceAll("\\", "/")}: ${pattern}`);
	});
}

describe("Discord install policy", () => {
	it("uses fixed intents and minimum bot permissions", () => {
		expect(DISCORD_GATEWAY_INTENTS).toEqual([1, 512, 32_768]);
		expect(DISCORD_BOT_PERMISSIONS).toBe(68_608);
		const url = new URL(buildDiscordInstallUrl("123456789012345678"));
		expect(url.origin + url.pathname).toBe(
			"https://discord.com/oauth2/authorize",
		);
		expect(url.searchParams.get("client_id")).toBe("123456789012345678");
		expect(url.searchParams.get("scope")).toBe("bot");
		expect(url.searchParams.get("permissions")).toBe("68608");
		expect([...url.searchParams.keys()].sort()).toEqual([
			"client_id",
			"permissions",
			"scope",
		]);
	});

	it("allows only canonical positive uint64 snowflakes", () => {
		expect(isCanonicalPositiveUint64Decimal("123456789012345678")).toBe(true);
		for (const value of ["abc", "0", "0123", "18446744073709551616"]) {
			expect(isCanonicalPositiveUint64Decimal(value)).toBe(false);
		}
		expect(() => buildDiscordInstallUrl("not-a-snowflake")).toThrow(
			"invalid_discord_client_id_format",
		);
	});

	it("does not move raw bot tokens over WebView IPC", () => {
		const webviewFiles = [
			...sourceFilesUnder("packages/shell/src", { includeTests: true }),
			...sourceFilesUnder("packages/shell/e2e", { includeTests: true }),
		];
		expect(
			forbiddenMatches(webviewFiles, [
				/\/api\/discord\/bot-token/,
				/\binvoke(?:<[^>]+>)?\(\s*["']read_discord_bot_token["']/,
				/\binvoke(?:<[^>]+>)?\(\s*["']write_discord_bot_token["']/,
				/\bcmd\s*={2,3}\s*["']read_discord_bot_token["']/,
				/\bcmd\s*={2,3}\s*["']write_discord_bot_token["']/,
				/\bmock-discord-token\b/,
				/\bbotToken\s*[:=]/,
			]),
		).toEqual([]);
		const handlerList =
			TAURI_LIB_RS.match(/generate_handler!\[\s*([\s\S]*?)\s*\]/)?.[1] ?? "";
		expect(handlerList).not.toContain("read_discord_bot_token");
		expect(handlerList).not.toContain("write_discord_bot_token");
		expect(TAURI_LIB_RS).not.toMatch(
			/#\[tauri::command\]\s*async fn read_discord_bot_token/,
		);
		expect(TAURI_LIB_RS).not.toContain("write_discord_bot_token");
		expect(TAURI_LIB_RS).not.toContain("naia-discord.json");
		expect(TAURI_LIB_RS).not.toContain("openclaw.json");
		expect(TAURI_LIB_RS).toContain("discord_bot_token_available");
		expect(TAURI_LIB_RS).toContain("async fn discord_capture_bot_token(");
		expect(TAURI_LIB_RS).toContain("capture_discord_token_native()");
		expect(TAURI_LIB_RS).not.toMatch(
			/async fn discord_capture_bot_token\([^)]*(?:token|secret)\s*:/s,
		);
	});

	it("does not claim the hidden production wizard is implemented", () => {
		const section = REQUIREMENTS_MD.split("## Discord setup/preflight policy (#388)")[1]
			?.split("## Steam Windows launch-readiness requirements (#314)")[0];
		expect(section).toContain("Status: Contract frozen");
		expect(section).toContain("production setup must supply native preflight facts");
		expect(section).not.toContain("Status: Implemented");
	});
});
