import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("opener log scope (#646)", () => {
	it("allows both production and tauri:dev instance log dirs, including the folder itself", () => {
		const raw = readFileSync(
			resolve(process.cwd(), "src-tauri/capabilities/default.json"),
			"utf8",
		);
		const cap = JSON.parse(raw);
		const opener = cap.permissions.find(
			(entry: { identifier?: string }) =>
				entry?.identifier === "opener:allow-open-path",
		);
		const paths = opener.allow.map((row: { path: string }) => row.path);
		expect(paths).toEqual(
			expect.arrayContaining([
				"$HOME/.naia/logs",
				"$HOME/.naia/logs/**",
				"$HOME/.naia-dev/logs",
				"$HOME/.naia-dev/logs/**",
			]),
		);
	});
});
