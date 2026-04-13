import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultPathResolver, defaultPathResolver } from "../path-resolver.js";
import type { PathResolver } from "../types.js";

describe("DefaultPathResolver", () => {
	it("returns device identity path under ~/.naia/", () => {
		const resolver = new DefaultPathResolver();
		expect(resolver.deviceIdentityPath()).toBe(
			join(homedir(), ".naia", "identity", "device.json"),
		);
	});

	it("returns config candidates in correct order", () => {
		const resolver = new DefaultPathResolver();
		const candidates = resolver.configCandidates();
		expect(candidates).toHaveLength(2);
		expect(candidates[0]).toBe(join(homedir(), ".naia", "gateway.json"));
		expect(candidates[1]).toBe(
			join(homedir(), ".naia", "openclaw", "openclaw.json"),
		);
	});

	it("returns memory config path under ~/.naia/", () => {
		const resolver = new DefaultPathResolver();
		expect(resolver.memoryConfigPath()).toBe(
			join(homedir(), ".naia", "memory-config.json"),
		);
	});

	it("exports a singleton defaultPathResolver", () => {
		expect(defaultPathResolver).toBeInstanceOf(DefaultPathResolver);
	});
});

describe("PathResolver interface", () => {
	it("allows custom implementations", () => {
		const custom: PathResolver = {
			deviceIdentityPath: () => "/custom/identity.json",
			configCandidates: () => ["/custom/config.json"],
			memoryConfigPath: () => "/custom/memory-config.json",
		};
		expect(custom.deviceIdentityPath()).toBe("/custom/identity.json");
		expect(custom.configCandidates()).toEqual(["/custom/config.json"]);
		expect(custom.memoryConfigPath()).toBe("/custom/memory-config.json");
	});
});
