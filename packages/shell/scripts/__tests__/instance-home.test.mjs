import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	DEVELOPMENT_INSTANCE_HOME_NAME,
	PRODUCTION_INSTANCE_HOME_NAME,
	developmentInstanceHome,
	openerLogAllowPaths,
	productionInstanceHome,
} from "../instance-home.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const shellDir = resolve(scriptsDir, "..", "..");

describe("instance homes (FR-SHELL-ISO.1, #646)", () => {
	it("names the production and tauri:dev data homes", () => {
		expect(PRODUCTION_INSTANCE_HOME_NAME).toBe(".naia");
		expect(DEVELOPMENT_INSTANCE_HOME_NAME).toBe(".naia-dev");
		expect(productionInstanceHome("/home/luke")).toBe(
			resolve("/home/luke", ".naia"),
		);
		expect(developmentInstanceHome("/home/luke")).toBe(
			resolve("/home/luke", ".naia-dev"),
		);
		expect(developmentInstanceHome()).toBe(resolve(homedir(), ".naia-dev"));
	});

	it("allows opener to open both instance log dirs, including the folder itself", () => {
		expect(openerLogAllowPaths()).toEqual([
			{ path: "$HOME/.naia/logs" },
			{ path: "$HOME/.naia/logs/**" },
			{ path: "$HOME/.naia-dev/logs" },
			{ path: "$HOME/.naia-dev/logs/**" },
		]);
	});

	it("keeps capabilities opener scopes in lockstep with the instance-home helper", () => {
		const capabilities = JSON.parse(
			readFileSync(
				resolve(shellDir, "src-tauri", "capabilities", "default.json"),
				"utf8",
			),
		);
		const opener = capabilities.permissions.find(
			(entry) =>
				entry &&
				typeof entry === "object" &&
				entry.identifier === "opener:allow-open-path",
		);
		expect(opener).toBeTruthy();
		const allow = opener.allow.map((entry) => entry.path);
		for (const { path } of openerLogAllowPaths()) {
			expect(allow, path).toContain(path);
		}
		expect(allow).toContain("$TEMP/**");
	});

	it("is the helper tauri:dev uses for NAIA_HOME", () => {
		const launcher = readFileSync(
			resolve(shellDir, "scripts", "tauri-with-mode.mjs"),
			"utf8",
		);
		expect(launcher).toContain("developmentInstanceHome");
		expect(launcher).toContain('from "./instance-home.mjs"');
		expect(launcher).toMatch(
			/env\.NAIA_HOME\s*=\s*env\.NAIA_HOME\s*\?\?\s*developmentInstanceHome\(\)/,
		);
	});
});
