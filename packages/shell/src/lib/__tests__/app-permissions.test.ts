import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isKnownPermission, KNOWN_PERMISSIONS } from "../app-permissions";

describe("app-permissions", () => {
	it("matches the Rust KNOWN_PERMISSIONS list in app.rs exactly", () => {
		// Read Rust app.rs to extract KNOWN_PERMISSIONS constant
		const appRsPath = resolve(__dirname, "../../../src-tauri/src/app.rs");
		const appRsContent = readFileSync(appRsPath, "utf-8");

		// Locate pub const KNOWN_PERMISSIONS: &[&str] = &[ ... ];
		const match = appRsContent.match(
			/pub const KNOWN_PERMISSIONS:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/,
		);
		expect(match).not.toBeNull();

		const rawItems = match![1];
		// Extract quoted permission strings
		const rustPermissions = Array.from(rawItems.matchAll(/"([^"]+)"/g)).map(
			(m) => m[1],
		);

		expect(rustPermissions.length).toBeGreaterThan(0);
		expect(KNOWN_PERMISSIONS).toEqual(rustPermissions);
	});

	it("identifies known and unknown permissions correctly", () => {
		expect(isKnownPermission("fullscreen")).toBe(true);
		expect(isKnownPermission("speech")).toBe(true);
		expect(isKnownPermission("browser")).toBe(true);
		expect(isKnownPermission("unknown.permission")).toBe(false);
		expect(isKnownPermission("")).toBe(false);
	});
});
