import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	PAYMENT_PATTERNS,
	checkSteamBundle,
} from "../check-steam-bundle.mjs";

describe("check-steam-bundle detector tests", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-test-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("passes on clean bundle without payment entrypoints", () => {
		fs.writeFileSync(
			path.join(tempDir, "main.js"),
			`
      console.log("Welcome to Naia Shell");
      const config = { kind: "on", billing: "naia", provider: "nextain" };
      const api = "https://api.naia.land/v1/chat";
      const trans = { "onboard.welcome.donationBtn": "Sponsor" };
      fetch("/v1/apps/products");
    `,
		);

		const result = checkSteamBundle({ distDir: tempDir });
		expect(result.success).toBe(true);
		expect(result.violations).toHaveLength(0);
	});

	it("fails on billing entrypoint alone", () => {
		fs.writeFileSync(
			path.join(tempDir, "billing-only.js"),
			`
      const url = \`\${base}/\${locale}/billing\`;
      openUrl(url);
    `,
		);

		const result = checkSteamBundle({ distDir: tempDir });
		expect(result.success).toBe(false);
		expect(result.violations.some((v) => v.patternId === "billing")).toBe(true);
	});

	it("fails on dashboard entrypoint alone", () => {
		fs.writeFileSync(
			path.join(tempDir, "dashboard-only.js"),
			`
      const dashboardUrl = \`\${base}/\${locale}/dashboard\`;
      openUrl(dashboardUrl);
    `,
		);

		const result = checkSteamBundle({ distDir: tempDir });
		expect(result.success).toBe(false);
		expect(result.violations.some((v) => v.patternId === "dashboard")).toBe(true);
	});

	it("fails on apps web store entrypoint alone", () => {
		fs.writeFileSync(
			path.join(tempDir, "apps-only.js"),
			`
      const storeUrl = \`\${base}/\${locale}/apps\`;
      openUrl(storeUrl);
    `,
		);

		const result = checkSteamBundle({ distDir: tempDir });
		expect(result.success).toBe(false);
		expect(result.violations.some((v) => v.patternId === "apps")).toBe(true);
	});

	it("fails on donation entrypoint alone", () => {
		fs.writeFileSync(
			path.join(tempDir, "donation-only.js"),
			`
      openUrl(naiaWebUrl("donation", base));
    `,
		);

		const result = checkSteamBundle({ distDir: tempDir });
		expect(result.success).toBe(false);
		expect(result.violations.some((v) => v.patternId === "donation")).toBe(true);
	});

	it("fails on sponsors entrypoint alone", () => {
		fs.writeFileSync(
			path.join(tempDir, "sponsors-only.js"),
			`
      const link = "https://github.com/sponsors/nextain";
      openUrl(link);
    `,
		);

		const result = checkSteamBundle({ distDir: tempDir });
		expect(result.success).toBe(false);
		expect(result.violations.some((v) => v.patternId === "sponsors")).toBe(true);
	});

	it("does not false-positive on general host names, internal billing tags, or translation keys", () => {
		fs.writeFileSync(
			path.join(tempDir, "safe-strings.js"),
			`
      const apiHost = "https://api.naia.land";
      const modelConfig = { kind: "on", billing: "local", provider: "ollama" };
      const translations = {
        "cost.labCharge": "Credit Charge",
        "about.linkSponsor": "Sponsor",
        "appbar.appStore": "App Store"
      };
      const apiEndpoint = "/v1/apps/list";
    `,
		);

		const result = checkSteamBundle({ distDir: tempDir });
		expect(result.success).toBe(true);
		expect(result.violations).toHaveLength(0);
	});
});
