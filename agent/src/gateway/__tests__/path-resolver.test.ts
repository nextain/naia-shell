import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultPathResolver, defaultPathResolver } from "../path-resolver.js";
import type { PathResolver } from "../types.js";

describe("DefaultPathResolver (no NAIA_SETTINGS_DIR)", () => {
	beforeEach(() => {
		delete process.env.NAIA_SETTINGS_DIR;
	});

	it("returns device identity path under ~/.naia/", () => {
		const resolver = new DefaultPathResolver();
		expect(resolver.deviceIdentityPath()).toBe(
			join(homedir(), ".naia", "identity", "device.json"),
		);
	});

	it("returns config candidates in correct order", () => {
		const resolver = new DefaultPathResolver();
		const candidates = resolver.configCandidates();
		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toBe(join(homedir(), ".naia", "gateway.json"));
	});

	it("returns memory config path under ~/.naia/", () => {
		const resolver = new DefaultPathResolver();
		expect(resolver.memoryConfigPath()).toBe(
			join(homedir(), ".naia", "memory-config.json"),
		);
	});

	it("returns memory db path under ~/.naia/memory/", () => {
		const resolver = new DefaultPathResolver();
		expect(resolver.memoryDbPath()).toBe(
			join(homedir(), ".naia", "memory", "alpha-memory-v5.db"),
		);
	});

	it("returns sessions path under ~/.naia/sessions/", () => {
		const resolver = new DefaultPathResolver();
		expect(resolver.sessionsPath()).toBe(join(homedir(), ".naia", "sessions"));
	});

	it("returns identity dir path under ~/.naia/identity/", () => {
		const resolver = new DefaultPathResolver();
		expect(resolver.identityDirPath()).toBe(
			join(homedir(), ".naia", "identity"),
		);
	});

	it("exports a singleton defaultPathResolver", () => {
		expect(defaultPathResolver).toBeInstanceOf(DefaultPathResolver);
	});
});

describe("DefaultPathResolver (with NAIA_SETTINGS_DIR)", () => {
	const SETTINGS = "/custom/naia-settings";

	beforeEach(() => {
		process.env.NAIA_SETTINGS_DIR = SETTINGS;
	});

	afterEach(() => {
		delete process.env.NAIA_SETTINGS_DIR;
	});

	it("resolves device identity under NAIA_SETTINGS_DIR/.identity/", () => {
		const resolver = new DefaultPathResolver();
		expect(resolver.deviceIdentityPath()).toBe(
			join(SETTINGS, ".identity", "device.json"),
		);
	});

	it("resolves memory db under NAIA_SETTINGS_DIR/.memory/", () => {
		const resolver = new DefaultPathResolver();
		expect(resolver.memoryDbPath()).toBe(
			join(SETTINGS, ".memory", "alpha-memory-v5.db"),
		);
	});

	it("resolves sessions under NAIA_SETTINGS_DIR/.sessions/", () => {
		const resolver = new DefaultPathResolver();
		expect(resolver.sessionsPath()).toBe(join(SETTINGS, ".sessions"));
	});

	it("resolves identity dir under NAIA_SETTINGS_DIR/.identity/", () => {
		const resolver = new DefaultPathResolver();
		expect(resolver.identityDirPath()).toBe(join(SETTINGS, ".identity"));
	});

	it("still resolves memory config under ~/.naia/ (written by Rust backend)", () => {
		const resolver = new DefaultPathResolver();
		expect(resolver.memoryConfigPath()).toBe(
			join(homedir(), ".naia", "memory-config.json"),
		);
	});

	it("still resolves config candidates under ~/.naia/", () => {
		const resolver = new DefaultPathResolver();
		expect(resolver.configCandidates()[0]).toBe(
			join(homedir(), ".naia", "gateway.json"),
		);
	});
});

describe("PathResolver interface", () => {
	it("allows custom implementations", () => {
		const custom: PathResolver = {
			deviceIdentityPath: () => "/custom/identity.json",
			configCandidates: () => ["/custom/config.json"],
			memoryConfigPath: () => "/custom/memory-config.json",
			memoryDbPath: () => "/custom/memory.db",
			sessionsPath: () => "/custom/sessions",
			identityDirPath: () => "/custom/identity",
		};
		expect(custom.deviceIdentityPath()).toBe("/custom/identity.json");
		expect(custom.configCandidates()).toEqual(["/custom/config.json"]);
		expect(custom.memoryConfigPath()).toBe("/custom/memory-config.json");
		expect(custom.memoryDbPath()).toBe("/custom/memory.db");
		expect(custom.sessionsPath()).toBe("/custom/sessions");
		expect(custom.identityDirPath()).toBe("/custom/identity");
	});
});
