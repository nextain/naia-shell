import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const shellPackage = JSON.parse(
	readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };
const e2eInventory = JSON.parse(
	readFileSync(
		new URL("../../../../../../docs/e2e-inventory.json", import.meta.url),
		"utf8",
	),
) as {
	specs: Array<{
		spec: string;
		tier: string;
		platforms?: string[];
	}>;
};

describe("project-agent PTY e2e regression registration", () => {
	it("connects the Linux Tauri spec to a package script and regression tier", () => {
		expect(shellPackage.scripts?.["test:e2e:tauri:project-agent-pty"]).toBe(
			"pnpm run build:e2e:tauri && wdio run e2e-tauri/wdio.conf.project-agent-pty.ts",
		);
		expect(
			e2eInventory.specs.find(
				({ spec }) => spec === "project-agent-pty-input.spec.ts",
			),
		).toMatchObject({
			tier: "deterministic_ci",
			platforms: ["linux"],
		});
	});
});
