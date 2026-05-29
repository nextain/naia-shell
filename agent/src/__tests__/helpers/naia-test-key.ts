/**
 * Shared test helper — load a naiaKey for live-gateway E2E tests.
 *
 * Resolution order:
 *   1. NAIA_TEST_KEY env (CI / manual)
 *   2. Windows DPAPI keychain (NAIA_ANYLLM_API_KEY.dpapi, CurrentUser scope)
 *
 * Returns null when no key is available (tests should `it.skipIf(!key)`).
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** PROD by default; override with NAIA_TEST_GATEWAY for the dev gateway. */
export const GATEWAY_URL =
	process.env.NAIA_TEST_GATEWAY ||
	"https://naia-gateway-181404717065.asia-northeast3.run.app";

export function loadNaiaKey(): string | null {
	if (process.env.NAIA_TEST_KEY) return process.env.NAIA_TEST_KEY;
	const candidates = [
		join(
			process.env.USERPROFILE || process.env.HOME || "",
			"dev",
			"alpha-adk",
			"naia-settings",
			".keys",
			"NAIA_ANYLLM_API_KEY.dpapi",
		),
		"D:/alpha-adk/naia-settings/.keys/NAIA_ANYLLM_API_KEY.dpapi",
	];
	const keyPath = candidates.find((p) => existsSync(p));
	// Diagnostic (no key value leaked — only path/length/prefix-ok booleans).
	console.log("[naia-test-key] keyPath:", keyPath ?? "(none found)");
	if (!keyPath) return null;
	try {
		// Single-line (semicolon-separated) — a multi-line `-Command` string
		// gets truncated to empty output through node execSync's shell.
		const p = keyPath.replace(/'/g, "''");
		const script = `Add-Type -AssemblyName System.Security; $b=[System.IO.File]::ReadAllBytes('${p}'); $d=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [System.Text.Encoding]::UTF8.GetString($d)`;
		const key = execSync(`powershell -NoProfile -Command "${script}"`, {
			encoding: "utf-8",
			timeout: 10000,
		}).trim();
		console.log(
			"[naia-test-key] unsealed len:",
			key.length,
			"prefix-ok(gw-):",
			key.startsWith("gw-"),
		);
		return key.startsWith("gw-") ? key : null;
	} catch (e) {
		console.log("[naia-test-key] unseal error:", String(e).slice(0, 120));
		return null;
	}
}
