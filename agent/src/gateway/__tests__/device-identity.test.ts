import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPathResolver } from "../path-resolver.js";
import type { DeviceIdentity } from "../types.js";

// We'll mock os.homedir to point to a temp directory
vi.mock("node:os", async () => {
	const actual = await vi.importActual("node:os");
	return { ...actual, homedir: vi.fn() };
});

import { homedir } from "node:os";
import { loadDeviceIdentity } from "../device-identity.js";

describe("loadDeviceIdentity", () => {
	let tempHome: string;

	beforeEach(() => {
		tempHome = mkdtempSync("/tmp/device-identity-test-");
		vi.mocked(homedir).mockReturnValue(tempHome);
	});

	afterEach(() => {
		rmSync(tempHome, { recursive: true, force: true });
	});

	it("loads valid device identity from ~/.naia/identity/device.json (migrated path)", () => {
		const identityDir = join(tempHome, ".naia", "identity");
		mkdirSync(identityDir, { recursive: true });
		writeFileSync(
			join(identityDir, "device.json"),
			JSON.stringify({
				version: 1,
				deviceId: "abc123",
				publicKeyPem:
					"-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n",
				privateKeyPem:
					"-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n",
			}),
		);

		const identity = loadDeviceIdentity();
		expect(identity).toBeDefined();
		expect(identity?.id).toBe("abc123");
		expect(identity?.publicKey).toContain("PUBLIC KEY");
		expect(identity?.privateKeyPem).toContain("PRIVATE KEY");
	});

	it("default call uses DefaultPathResolver", () => {
		const spy = vi.spyOn(
			DefaultPathResolver.prototype,
			"deviceIdentityPath",
		);
		loadDeviceIdentity();
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});

	it("returns undefined when identity file does not exist", () => {
		const identity = loadDeviceIdentity();
		expect(identity).toBeUndefined();
	});

	it("returns undefined for malformed JSON", () => {
		const identityDir = join(tempHome, ".naia", "identity");
		mkdirSync(identityDir, { recursive: true });
		writeFileSync(join(identityDir, "device.json"), "not json");

		const identity = loadDeviceIdentity();
		expect(identity).toBeUndefined();
	});

	it("returns undefined when required fields are missing", () => {
		const identityDir = join(tempHome, ".naia", "identity");
		mkdirSync(identityDir, { recursive: true });
		writeFileSync(
			join(identityDir, "device.json"),
			JSON.stringify({ version: 1 }),
		);

		const identity = loadDeviceIdentity();
		expect(identity).toBeUndefined();
	});

	it("accepts a custom PathResolver via DI", () => {
		// Write identity to a non-default location
		const customDir = join(tempHome, "custom", "identity");
		mkdirSync(customDir, { recursive: true });
		writeFileSync(
			join(customDir, "device.json"),
			JSON.stringify({
				deviceId: "custom-device",
				publicKeyPem:
					"-----BEGIN PUBLIC KEY-----\ncustom\n-----END PUBLIC KEY-----\n",
				privateKeyPem:
					"-----BEGIN PRIVATE KEY-----\ncustom\n-----END PRIVATE KEY-----\n",
			}),
		);

		const customResolver = {
			deviceIdentityPath: () => join(customDir, "device.json"),
			configCandidates: () => [],
			memoryConfigPath: () => "",
		};

		const identity = loadDeviceIdentity(customResolver);
		expect(identity).toBeDefined();
		expect(identity?.id).toBe("custom-device");
	});

	it("returns undefined when custom PathResolver points to missing file", () => {
		const customResolver = {
			deviceIdentityPath: () => join(tempHome, "nonexistent", "device.json"),
			configCandidates: () => [],
			memoryConfigPath: () => "",
		};

		const identity = loadDeviceIdentity(customResolver);
		expect(identity).toBeUndefined();
	});
});
