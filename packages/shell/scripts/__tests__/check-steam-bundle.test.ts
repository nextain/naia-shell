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

	it("fails on CostDashboard actual call minified with esbuild", async () => {
		const { createRequire } = await import("node:module");
		const require = createRequire(import.meta.url);
		const vitePath = require.resolve("vite");
		const esbuild = createRequire(vitePath)("esbuild");

		const code = `
      function renderCharge(openUrl, naiaWebUrl, getLocale, NAIA_WEB_BASE_URL) {
        openUrl(naiaWebUrl(\`\${getLocale()}/billing\`, NAIA_WEB_BASE_URL)).catch(() => {});
      }
    `;
		const minified = esbuild.transformSync(code, { minify: true }).code;
		fs.writeFileSync(path.join(tempDir, "cost-dashboard-minified.js"), minified);

		const result = checkSteamBundle({ distDir: tempDir });
		expect(result.success).toBe(false);
		expect(result.violations.some((v) => v.patternId === "billing")).toBe(true);
	});

	it("detects route variants (${x}/route, ko/route, e+/route) minified with esbuild for billing, dashboard, apps", async () => {
		const { createRequire } = await import("node:module");
		const require = createRequire(import.meta.url);
		const vitePath = require.resolve("vite");
		const esbuild = createRequire(vitePath)("esbuild");

		for (const route of ["billing", "dashboard", "apps"] as const) {
			const routeDir = fs.mkdtempSync(path.join(os.tmpdir(), `variant-${route}-`));
			try {
				const code = `
          const a = \`\${x}/${route}\`;
          const b = "ko/${route}";
          const c = e + "/${route}";
        `;
				const minified = esbuild.transformSync(code, { minify: true }).code;
				fs.writeFileSync(path.join(routeDir, `${route}-variants.js`), minified);

				const result = checkSteamBundle({ distDir: routeDir });
				expect(result.success).toBe(false);
				expect(result.violations.some((v) => v.patternId === route)).toBe(true);
			} finally {
				fs.rmSync(routeDir, { recursive: true, force: true });
			}
		}
	});

	it("does not detect API routes (/v1/<route>, /api/<route>, /v1/internal/<route>, /api/ko/<route>, /v1/apps/products)", async () => {
		const { createRequire } = await import("node:module");
		const require = createRequire(import.meta.url);
		const vitePath = require.resolve("vite");
		const esbuild = createRequire(vitePath)("esbuild");

		const code = `
      fetch("/v1/billing");
      fetch("/api/billing");
      fetch("/v1/internal/billing");
      fetch("/api/ko/billing");

      fetch("/v1/dashboard");
      fetch("/api/dashboard");
      fetch("/v1/internal/dashboard");
      fetch("/api/ko/dashboard");

      fetch("/v1/apps");
      fetch("/api/apps");
      fetch("/v1/internal/apps");
      fetch("/api/ko/apps");
      fetch("/v1/apps/products");
    `;
		const minified = esbuild.transformSync(code, { minify: true }).code;
		fs.writeFileSync(path.join(tempDir, "api-routes.js"), minified);

		const result = checkSteamBundle({ distDir: tempDir });
		expect(result.success).toBe(true);
		expect(result.violations).toHaveLength(0);
	});
});
