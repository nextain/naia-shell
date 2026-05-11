/**
 * Test: tauri.conf.json assetProtocol.scope is restricted (no bare **).
 *
 * Security regression — #258 asset protocol full-filesystem read.
 * Validates that the static asset scope:
 * - does NOT contain bare "**" (would expose entire filesystem)
 * - does NOT contain drive-root patterns "C:\\**" etc. (Windows full-drive)
 * - DOES set requireLiteralLeadingDot true (blocks ~/.ssh, ~/.gnupg, ~/.aws)
 * - DOES include $RESOURCE/** for bundled VRMs/backgrounds/BGM
 *
 * Run:
 *   pnpm exec vitest run src/lib/__tests__/asset-protocol-scope.test.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function loadConfig(): {
	app?: {
		security?: {
			assetProtocol?: {
				enable?: boolean;
				scope?:
					| string[]
					| {
							allow?: string[];
							deny?: string[];
							requireLiteralLeadingDot?: boolean;
					  };
			};
		};
	};
} {
	const path = resolve(__dirname, "../../../src-tauri/tauri.conf.json");
	return JSON.parse(readFileSync(path, "utf-8"));
}

describe("assetProtocol.scope hardening (#258)", () => {
	it("assetProtocol is enabled (#277 — required for runtime scope extension)", () => {
		const cfg = loadConfig();
		expect(cfg.app?.security?.assetProtocol?.enable).toBe(true);
	});

	it("scope is the object form (allow/deny/requireLiteralLeadingDot)", () => {
		const cfg = loadConfig();
		const scope = cfg.app?.security?.assetProtocol?.scope;
		expect(scope).toBeTruthy();
		expect(Array.isArray(scope)).toBe(false);
		expect(typeof scope).toBe("object");
	});

	it("requireLiteralLeadingDot is true (blocks ~/.ssh, ~/.gnupg, ~/.aws on Unix AND Windows)", () => {
		const cfg = loadConfig();
		const scope = cfg.app?.security?.assetProtocol?.scope as {
			requireLiteralLeadingDot?: boolean;
		};
		expect(scope.requireLiteralLeadingDot).toBe(true);
	});

	it("allow list does NOT contain bare ** (would expose /etc/passwd, /root/, etc.)", () => {
		const cfg = loadConfig();
		const allow =
			(
				cfg.app?.security?.assetProtocol?.scope as { allow?: string[] }
			).allow ?? [];
		expect(allow).not.toContain("**");
		// Also reject "/**" which would have the same effect
		expect(allow).not.toContain("/**");
	});

	it("allow list does NOT contain drive-root patterns (C:\\**, D:\\**, etc.)", () => {
		const cfg = loadConfig();
		const allow =
			(
				cfg.app?.security?.assetProtocol?.scope as { allow?: string[] }
			).allow ?? [];
		for (const pattern of allow) {
			expect(pattern).not.toMatch(/^[A-Z]:\\\\\*\*$/);
		}
	});

	it("allow list does NOT contain bare /tmp/** (cross-app tmp exposure)", () => {
		const cfg = loadConfig();
		const allow =
			(
				cfg.app?.security?.assetProtocol?.scope as { allow?: string[] }
			).allow ?? [];
		expect(allow).not.toContain("/tmp/**");
	});

	it("allow list includes $RESOURCE/** (so bundled VRMs/backgrounds/BGM still load)", () => {
		const cfg = loadConfig();
		const allow =
			(
				cfg.app?.security?.assetProtocol?.scope as { allow?: string[] }
			).allow ?? [];
		expect(allow).toContain("$RESOURCE/**");
	});

	it("allow list includes $HOME/** (so user-chosen ADK paths under HOME work)", () => {
		const cfg = loadConfig();
		const allow =
			(
				cfg.app?.security?.assetProtocol?.scope as { allow?: string[] }
			).allow ?? [];
		expect(allow).toContain("$HOME/**");
	});
});
