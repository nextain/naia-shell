import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	PAYMENT_PATTERNS,
	checkSteamBundle,
} from "../check-steam-bundle.mjs";

const require = createRequire(import.meta.url);
const vitePath = require.resolve("vite");
const esbuild = createRequire(vitePath)("esbuild");

function minifyCode(code: string): string {
	return esbuild.transformSync(code, { minify: true }).code;
}

function checkSnippet(code: string) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-snippet-"));
	try {
		fs.writeFileSync(path.join(dir, "entry.js"), code);
		return checkSteamBundle({ distDir: dir });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

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
		const code = `
      function renderCharge(openUrl, naiaWebUrl, getLocale, NAIA_WEB_BASE_URL) {
        openUrl(naiaWebUrl(\`\${getLocale()}/billing\`, NAIA_WEB_BASE_URL)).catch(() => {});
      }
    `;
		const minified = minifyCode(code);
		fs.writeFileSync(path.join(tempDir, "cost-dashboard-minified.js"), minified);

		const result = checkSteamBundle({ distDir: tempDir });
		expect(result.success).toBe(false);
		expect(result.violations.some((v) => v.patternId === "billing")).toBe(true);
	});

	const routes = ["billing", "dashboard", "apps"] as const;

	for (const route of routes) {
		describe(`must detect route variants independently: ${route}`, () => {
			const escapeMap: Record<typeof routes[number], string> = {
				billing: "\\u0062illing",
				dashboard: "\\u0064ashboard",
				apps: "\\u0061pps",
			};

			const internalSplitMap: Record<typeof routes[number], [string, string]> = {
				billing: ["/bill", "ing"],
				dashboard: ["/dash", "board"],
				apps: ["/ap", "ps"],
			};

			const cases: Array<{ name: string; code: string; expectedSubstring: string }> = [
				{
					name: `openUrl("https://naia.land/ko/<route>")`,
					code: `openUrl("https://naia.land/ko/${route}");`,
					expectedSubstring: `/${route}`,
				},
				{
					name: `"https://naia.land/<route>"`,
					code: `openUrl("https://naia.land/${route}");`,
					expectedSubstring: `/${route}`,
				},
				{
					name: `\${x}/<route>`,
					code: `openUrl(\`\${x}/${route}\`);`,
					expectedSubstring: `/${route}`,
				},
				{
					name: `"ko/<route>"`,
					code: `openUrl("ko/${route}");`,
					expectedSubstring: `/${route}`,
				},
				{
					name: `e+"/<route>"`,
					code: `openUrl(e + "/${route}");`,
					expectedSubstring: `/${route}`,
				},
				{
					name: `"/<route>?ref=app"`,
					code: `openUrl("/${route}?ref=app");`,
					expectedSubstring: `/${route}?ref=app`,
				},
				{
					name: `openUrl("https://naia.land/ko/\\uXXXX<route>") (escaped)`,
					code: `openUrl("https://naia.land/ko/${escapeMap[route]}");`,
					expectedSubstring: route,
				},
				{
					name: `split inside spelling: openUrl("${internalSplitMap[route][0]}" + "${internalSplitMap[route][1]}")`,
					code: `openUrl("${internalSplitMap[route][0]}" + "${internalSplitMap[route][1]}");`,
					expectedSubstring: route,
				},
				{
					name: `split after slash: openUrl("ko/" + "${route}")`,
					code: `openUrl("ko/" + "${route}");`,
					expectedSubstring: route,
				},
			];

			for (const c of cases) {
				it(`detects ${c.name} in raw and minified form independently`, () => {
					const minified = minifyCode(c.code);
					expect(minified).toContain(c.expectedSubstring);

					const rawResult = checkSnippet(c.code);
					expect(
						rawResult.violations.some((v) => v.patternId === route),
						`Expected raw code to trigger ${route} violation, got: ${JSON.stringify(rawResult.violations)}`,
					).toBe(true);

					const minResult = checkSnippet(minified);
					expect(
						minResult.violations.some((v) => v.patternId === route),
						`Expected minified code to trigger ${route} violation, got: ${JSON.stringify(minResult.violations)}`,
					).toBe(true);
				});
			}
		});

		describe(`must NOT detect API or non-target routes independently: ${route}`, () => {
			const safeCases: Array<{ name: string; code: string }> = [
				{
					name: `/v1/<route>`,
					code: `fetch("/v1/${route}");`,
				},
				{
					name: `/api/<route>`,
					code: `fetch("/api/${route}");`,
				},
				{
					name: `/v1/internal/<route>`,
					code: `fetch("/v1/internal/${route}");`,
				},
				{
					name: `/api/ko/<route>`,
					code: `fetch("/api/ko/${route}");`,
				},
				{
					name: `/v1/apps/products`,
					code: `fetch("/v1/apps/products");`,
				},
				{
					name: `\${base}/v1/\${id}/<route>`,
					code: `fetch(\`\${base}/v1/\${id}/${route}\`);`,
				},
				{
					name: `"settings.<route>"`,
					code: `openUrl("settings.${route}");`,
				},
				{
					name: `{<route>: 1}`,
					code: `const data = { ${route}: 1 }; fetch(data);`,
				},
				{
					name: `fetch(base+"/v1/"+id+"/<route>")`,
					code: `fetch(base + "/v1/" + id + "/${route}");`,
				},
				{
					name: `comment // see /<route>`,
					code: `// see /${route}\nfetch("https://naia.land");`,
				},
				{
					name: `regex literal /\\/<route>/`,
					code: `const re = /\\/${route}/; fetch(re.source);`,
				},
				{
					name: `split API path fetch(base+"/v"+"1/"+id+"/<route>")`,
					code: `fetch(base + "/v" + "1/" + id + "/${route}");`,
				},
			];

			for (const c of safeCases) {
				it(`does not detect ${c.name} in raw or minified form`, () => {
					const minified = minifyCode(c.code);

					const rawResult = checkSnippet(c.code);
					expect(rawResult.success).toBe(true);
					expect(rawResult.violations).toHaveLength(0);

					const minResult = checkSnippet(minified);
					expect(minResult.success).toBe(true);
					expect(minResult.violations).toHaveLength(0);
				});
			}
		});
	}

	it("does not detect non-target segment openUrl('/apps' + 'hell')", () => {
		const code = `openUrl("/apps" + "hell");`;
		const minified = minifyCode(code);

		const rawResult = checkSnippet(code);
		expect(rawResult.success).toBe(true);
		expect(rawResult.violations).toHaveLength(0);

		const minResult = checkSnippet(minified);
		expect(minResult.success).toBe(true);
		expect(minResult.violations).toHaveLength(0);
	});

	describe("HTML bundle scanning tests", () => {
		it("detects payment URL in HTML tag attribute", () => {
			const html = `
        <!DOCTYPE html>
        <html>
          <body>
            <a href="https://naia.land/ko/billing">Billing</a>
          </body>
        </html>
      `;
			fs.writeFileSync(path.join(tempDir, "index.html"), html);
			const result = checkSteamBundle({ distDir: tempDir });
			expect(result.success).toBe(false);
			expect(result.violations.some((v) => v.patternId === "billing")).toBe(true);
		});

		it("detects payment URL in HTML inline script", () => {
			const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <script>
              window.go = () => openUrl("https://naia.land/dashboard");
            </script>
          </head>
        </html>
      `;
			fs.writeFileSync(path.join(tempDir, "index.html"), html);
			const result = checkSteamBundle({ distDir: tempDir });
			expect(result.success).toBe(false);
			expect(result.violations.some((v) => v.patternId === "dashboard")).toBe(true);
		});

		it("ignores HTML comments and allows safe API links in HTML", () => {
			const html = `
        <!DOCTYPE html>
        <html>
          <!-- <a href="/billing">commented out</a> -->
          <head>
            <link rel="prefetch" href="/v1/billing" />
            <link rel="prefetch" href="/api/apps" />
          </head>
          <body>
            <p>settings.billing key text</p>
          </body>
        </html>
      `;
			fs.writeFileSync(path.join(tempDir, "index.html"), html);
			const result = checkSteamBundle({ distDir: tempDir });
			expect(result.success).toBe(true);
			expect(result.violations).toHaveLength(0);
		});
	});
});

