import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function loadConfig(filename: string): Record<string, any> {
	const path = resolve(__dirname, `../../../src-tauri/${filename}`);
	return JSON.parse(readFileSync(path, "utf-8"));
}

function parseDirectives(csp: string): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const chunk of csp.split(";").map((s) => s.trim()).filter(Boolean)) {
		const [name, ...values] = chunk.split(/\s+/);
		map.set(name, values);
	}
	return map;
}

describe("Workspace Quad CSP frame-src configuration (#732)", () => {
	const EXPECTED_TOKENS = [
		"http://asset.localhost",
		"https://asset.localhost",
		"https://www.youtube.com",
		"https://www.youtube-nocookie.com",
		"http://localhost:3142",
		"http://127.0.0.1:3142",
		"http://127.0.0.1:8896",
		"http://localhost:8896",
	];

	it("tauri.conf.json frame-src contains exact expected tokens", () => {
		const cfg = loadConfig("tauri.conf.json");
		const csp = cfg.app?.security?.csp ?? "";
		const directives = parseDirectives(csp);
		const frameSrc = directives.get("frame-src") ?? [];

		expect(frameSrc.slice().sort()).toEqual(EXPECTED_TOKENS.slice().sort());
	});

	it("tauri.e2e.conf.json frame-src includes both 8896 loopback entries", () => {
		const cfg = loadConfig("tauri.e2e.conf.json");
		const csp = cfg.app?.security?.csp ?? "";
		const directives = parseDirectives(csp);
		const frameSrc = directives.get("frame-src") ?? [];

		expect(frameSrc).toContain("http://127.0.0.1:8896");
		expect(frameSrc).toContain("http://localhost:8896");
		expect(frameSrc.slice().sort()).toEqual(EXPECTED_TOKENS.slice().sort());
	});
});
