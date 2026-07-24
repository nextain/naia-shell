import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const tauriConfig = JSON.parse(
	readFileSync(
		resolve(repoRoot, "packages/shell/src-tauri/tauri.conf.json"),
		"utf8",
	),
) as { app: { security: { csp: string } } };

describe("FR-VOICE.8 packaged Tauri CSP", () => {
	it("allows only the Azure preset origin and removes the former GCS origin", () => {
		const csp = tauriConfig.app.security.csp;
		const mediaSrc = csp.match(/(?:^|;)\s*media-src\s+([^;]+)/)?.[1];

		expect(mediaSrc).toBeDefined();
		expect(mediaSrc).toContain(
			"https://stnaiapub83b29893.blob.core.windows.net",
		);
		expect(mediaSrc).not.toContain("https://storage.googleapis.com");
		const sources = mediaSrc?.trim().split(/\s+/) ?? [];
		expect(
			sources.filter((source) => source.includes("blob.core.windows.net")),
		).toEqual(["https://stnaiapub83b29893.blob.core.windows.net"]);
		expect(sources).not.toContain("https:");
		expect(sources).not.toContain("*");
	});
});
