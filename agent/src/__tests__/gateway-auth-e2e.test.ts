/**
 * Gateway Auth E2E — verifies login, chat, balance against PROD gateway.
 *
 * Reads naiaKey from DPAPI keychain (Windows) or env NAIA_TEST_KEY.
 * Skip when key unavailable.
 *
 * Run:
 *   pnpm exec vitest run src/__tests__/gateway-auth-e2e.test.ts
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PROD_GATEWAY = "https://api.nextain.io";

/** Read naiaKey from DPAPI keychain or env */
function loadNaiaKey(): string | null {
	if (process.env.NAIA_TEST_KEY) return process.env.NAIA_TEST_KEY;

	// Windows DPAPI path
	const dpapiPath = join(
		process.env.USERPROFILE || process.env.HOME || "",
		"dev",
		"alpha-adk",
		"naia-settings",
		".keys",
		"NAIA_ANYLLM_API_KEY.dpapi",
	);

	// Also try workspace-relative path
	const altPath = join(
		process.cwd(),
		"..",
		"..",
		"..",
		"naia-settings",
		".keys",
		"NAIA_ANYLLM_API_KEY.dpapi",
	);

	const keyPath = existsSync(dpapiPath)
		? dpapiPath
		: existsSync(altPath)
			? altPath
			: null;
	if (!keyPath) return null;

	try {
		const script = `
Add-Type -AssemblyName System.Security
$bytes = [System.IO.File]::ReadAllBytes('${keyPath.replace(/'/g, "''")}')
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[System.Text.Encoding]::UTF8.GetString($plain)
`;
		const key = execSync(`powershell -Command "${script}"`, {
			encoding: "utf-8",
			timeout: 10000,
		}).trim();
		return key.startsWith("gw-") ? key : null;
	} catch {
		return null;
	}
}

const naiaKey = loadNaiaKey();
const canRun = naiaKey !== null;

describe.skipIf(!canRun)(
	"Gateway Auth E2E (PROD)",
	() => {
		it("1. balance — shell direct fetch", async () => {
			const res = await fetch(`${PROD_GATEWAY}/v1/profile/balance`, {
				headers: { "X-AnyLLM-Key": `Bearer ${naiaKey}` },
				signal: AbortSignal.timeout(10000),
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.success).toBe(true);
			expect(data.data.balance).toBeGreaterThan(0);
		});

		it("2. chat — gateway auth accepted (200, not 401)", async () => {
			// Agent always uses streaming; verify gateway accepts the key for chat.
			const res = await fetch(`${PROD_GATEWAY}/v1/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-AnyLLM-Key": `Bearer ${naiaKey}`,
				},
				body: JSON.stringify({
					model: "vertexai:gemini-2.5-flash",
					messages: [{ role: "user", content: "say ok" }],
					max_tokens: 10,
					stream: true,
				}),
				signal: AbortSignal.timeout(15000),
			});
			expect(res.status).toBe(200);
		});

		it("3. chat — gateway completions (SSE streaming)", async () => {
			const res = await fetch(`${PROD_GATEWAY}/v1/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-AnyLLM-Key": `Bearer ${naiaKey}`,
				},
				body: JSON.stringify({
					model: "vertexai:gemini-2.5-flash",
					messages: [{ role: "user", content: "say hello" }],
					max_tokens: 10,
					stream: true,
				}),
				signal: AbortSignal.timeout(15000),
			});
			expect(res.status).toBe(200);
			expect(res.body).not.toBeNull();

			const reader = res.body!.getReader();
			const decoder = new TextDecoder();
			let sawDone = false;
			let textChunks = 0;

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				const chunk = decoder.decode(value, { stream: true });
				if (chunk.includes("[DONE]")) sawDone = true;
				if (chunk.includes('"delta"')) textChunks++;
			}

			expect(sawDone).toBe(true);
			expect(textChunks).toBeGreaterThan(0);
		});

		it("4. pricing — public endpoint (no auth)", async () => {
			const res = await fetch(`${PROD_GATEWAY}/v1/pricing`, {
				signal: AbortSignal.timeout(10000),
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(Array.isArray(data)).toBe(true);
			expect(data.length).toBeGreaterThan(0);
		});

		it("5. invalid key — returns 401", async () => {
			const res = await fetch(`${PROD_GATEWAY}/v1/profile/balance`, {
				headers: { "X-AnyLLM-Key": "Bearer gw-INVALID_KEY_12345" },
				signal: AbortSignal.timeout(10000),
			});
			expect(res.status).toBe(401);
		});
	},
	30000,
);
