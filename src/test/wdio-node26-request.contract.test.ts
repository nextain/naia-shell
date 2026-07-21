import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const configSource = readFileSync(
	new URL("../../packages/shell/e2e-tauri/wdio.conf.ts", import.meta.url),
	"utf8",
);

describe("native WebDriver Node 26 request compatibility", () => {
	it("lets fetch calculate Content-Length for WebDriver session requests", () => {
		expect(configSource).toContain("transformRequest: (request) =>");
		expect(configSource).toContain('request.headers.delete("Content-Length")');
		expect(configSource).toContain("return request");
	});
});
