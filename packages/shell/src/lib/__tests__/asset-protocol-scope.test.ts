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

	it("every pattern's ** is a single path component (Tauri glob runtime rule)", () => {
		// Tauri parses scope patterns at runtime through the `glob` crate which
		// rejects patterns like `naia-**` or `foo**` — `**` (recursive wildcard)
		// must be its own path component. Catches the regression where this rule
		// was violated and the app paniced at startup with:
		//   GlobPattern(PatternError { msg: "recursive wildcards must form
		//   a single path component" })
		const cfg = loadConfig();
		const allow =
			(
				cfg.app?.security?.assetProtocol?.scope as { allow?: string[] }
			).allow ?? [];
		for (const pattern of allow) {
			// Find every occurrence of `**` and confirm the immediate neighbours
			// are either `/`, `$VAR` boundary, or string ends — never a non-slash
			// character glued to the wildcard.
			const re = /(.|^)\*\*(.|$)/g;
			for (const m of pattern.matchAll(re)) {
				const before = m[1];
				const after = m[2];
				// Allowed neighbours: '/' or empty (start/end of string).
				if (before !== "" && before !== "/") {
					throw new Error(
						`pattern "${pattern}" has '**' glued to '${before}' (not a single path component)`,
					);
				}
				if (after !== "" && after !== "/") {
					throw new Error(
						`pattern "${pattern}" has '**' glued to '${after}' (not a single path component)`,
					);
				}
			}
		}
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

	it("registers only naia-settings/{background,vrm-files,bgm-musics,nva-files} in runtime asset_protocol_scope and forbids data-private across base and canonicalized roots (#026-r2/r3 item 5)", () => {
		const libRs = readFileSync(
			resolve(__dirname, "../../../src-tauri/src/lib.rs"),
			"utf-8",
		);
		const contract = JSON.parse(
			readFileSync(resolve(__dirname, "../naia-asset-contract.json"), "utf-8"),
		);
		expect(contract.assetSubdirs).toEqual([
			"vrm-files",
			"background",
			"bgm-musics",
			"nva-files",
		]);
		expect(libRs).toContain(
			'include_str!("../../src/lib/naia-asset-contract.json")',
		);
		expect(libRs).toContain("fn collect_adk_asset_scope_directories(");
		expect(libRs).toContain("fn allow_adk_asset_protocol_scope(");
		expect(libRs).not.toContain("push_unique(root);");
		expect(libRs).not.toContain("push_unique(settings.clone());");
		expect(libRs).toContain("scope.forbid_directory(&secure_store_dir, true)");
		expect(libRs).toContain("scope.forbid_file(&secure_store_path)");
		expect(libRs).toContain(
			"scope.forbid_directory(&secure_store_temp_path, true)",
		);
		// Must be invoked during app startup (.setup) when read_naia_path_cache() returns Some,
		// as well as in write_naia_path_cache, init_naia_settings, list_naia_assets, import_naia_asset, and copy_bundled_assets.
		const callCount =
			libRs.split("allow_adk_asset_protocol_scope(").length - 1;
		// 1 definition + at least 6 call sites
		expect(callCount).toBeGreaterThanOrEqual(7);
	});
});
