import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
	PAYMENT_PATTERNS,
	checkSteamBundle,
} from "../check-steam-bundle.mjs";
import * as checkerModule from "../check-steam-bundle.mjs";

const require = createRequire(import.meta.url);
const vitePath = require.resolve("vite");
const esbuild = createRequire(vitePath)("esbuild");

function minifyCode(code: string): string {
	return esbuild.transformSync(code, { minify: true }).code;
}

function checkFileSnippet(filename: string, content: string) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-snippet-"));
	try {
		fs.writeFileSync(path.join(dir, filename), content);
		return checkSteamBundle({ distDir: dir });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function checkSnippet(code: string) {
	return checkFileSnippet("entry.js", code);
}

function checkHtmlSnippet(html: string) {
	return checkFileSnippet("index.html", html);
}

// Canonical allowlist contexts defined by the threat model / Steam bundle inspection
const CANONICAL_ALLOWLIST = [
	{
		route: "apps",
		context: "src/apps/workspace/Editor.tsx",
		reason: "Internal source file path in build metadata",
	},
	{
		route: "apps",
		context: "src/apps/workspace/Terminal.tsx",
		reason: "Internal source file path in build metadata",
	},
	{
		route: "apps",
		context: "src/apps/browser/BrowserCenterArea.tsx",
		reason: "Internal source file path in build metadata",
	},
	{
		route: "apps",
		context: "src/apps/workspace/HerdrWorkspaceCenterArea.tsx",
		reason: "Internal source file path in build metadata",
	},
	{
		route: "apps",
		context: "/v1/apps/products",
		reason: "Internal API endpoint for installed apps in AppInstallDialog",
	},
];

const ALLOWLIST = (checkerModule as any).ALLOWLIST || CANONICAL_ALLOWLIST;

describe("check-steam-bundle detector tests", () => {
	it("passes on clean bundle without payment entrypoints", () => {
		const result = checkSnippet(`
      console.log("Welcome to Naia Shell");
      const config = { kind: "on", billing: "naia", provider: "nextain" };
      const trans = { "onboard.welcome.donationBtn": "Sponsor" };
      fetch("/v1/apps/products");
    `);
		expect(result.success).toBe(true);
		expect(result.violations).toHaveLength(0);
	});

	it("fails on sponsors entrypoint alone", () => {
		const result = checkSnippet(`
      const link = "https://github.com/sponsors/nextain";
      openUrl(link);
    `);
		expect(result.success).toBe(false);
		expect(result.violations.some((v) => v.patternId === "sponsors")).toBe(true);
	});

	it("fails on donation direct URL: openUrl('https://naia.land/ko/donation')", () => {
		const code = `openUrl("https://naia.land/ko/donation");`;
		const rawResult = checkSnippet(code);
		expect(rawResult.success).toBe(false);
		expect(rawResult.violations.some((v) => v.patternId === "donation")).toBe(true);

		const minResult = checkSnippet(minifyCode(code));
		expect(minResult.success).toBe(false);
		expect(minResult.violations.some((v) => v.patternId === "donation")).toBe(true);
	});

	const routes = ["billing", "dashboard", "apps"] as const;

	for (const route of routes) {
		describe(`route detection & verification: ${route}`, () => {
			// 1. Raw JS and minified JS independent detection
			it(`detects openUrl("https://naia.land/ko/<route>") in raw and minified form independently: ${route}`, () => {
				const code = `openUrl("https://naia.land/ko/${route}");`;
				const rawResult = checkSnippet(code);
				expect(rawResult.violations.some((v) => v.patternId === route)).toBe(true);

				const minResult = checkSnippet(minifyCode(code));
				expect(minResult.violations.some((v) => v.patternId === route)).toBe(true);
			});

			it(`detects \${x}/<route> in raw and minified form independently: ${route}`, () => {
				const code = `openUrl(\`\${x}/${route}\`);`;
				const rawResult = checkSnippet(code);
				expect(rawResult.violations.some((v) => v.patternId === route)).toBe(true);

				const minResult = checkSnippet(minifyCode(code));
				expect(minResult.violations.some((v) => v.patternId === route)).toBe(true);
			});

			it(`detects "ko/<route>" in raw and minified form independently: ${route}`, () => {
				const code = `openUrl("ko/${route}");`;
				const rawResult = checkSnippet(code);
				expect(rawResult.violations.some((v) => v.patternId === route)).toBe(true);

				const minResult = checkSnippet(minifyCode(code));
				expect(minResult.violations.some((v) => v.patternId === route)).toBe(true);
			});

			it(`detects e+"/<route>" in raw and minified form independently: ${route}`, () => {
				const code = `openUrl(e + "/${route}");`;
				const rawResult = checkSnippet(code);
				expect(rawResult.violations.some((v) => v.patternId === route)).toBe(true);

				const minResult = checkSnippet(minifyCode(code));
				expect(minResult.violations.some((v) => v.patternId === route)).toBe(true);
			});

			it(`detects "/<route>?ref=app" in raw and minified form independently: ${route}`, () => {
				const code = `openUrl("/${route}?ref=app");`;
				const rawResult = checkSnippet(code);
				expect(rawResult.violations.some((v) => v.patternId === route)).toBe(true);

				const minResult = checkSnippet(minifyCode(code));
				expect(minResult.violations.some((v) => v.patternId === route)).toBe(true);
			});

			it(`detects "/<route>" in raw and minified form independently: ${route}`, () => {
				const code = `openUrl("/${route}");`;
				const rawResult = checkSnippet(code);
				expect(rawResult.violations.some((v) => v.patternId === route)).toBe(true);

				const minResult = checkSnippet(minifyCode(code));
				expect(minResult.violations.some((v) => v.patternId === route)).toBe(true);
			});

			// Comment detection in raw; minified strips comment so non-detection affirmed
			it(`detects // see /<route> comment in raw, and affirms non-detection when minified: ${route}`, () => {
				const code = `// see /${route}\nopenUrl("safe");`;
				const rawResult = checkSnippet(code);
				expect(rawResult.violations.some((v) => v.patternId === route)).toBe(true);

				const minified = minifyCode(code);
				expect(minified).not.toContain(`/${route}`);
				const minResult = checkSnippet(minified);
				expect(minResult.violations.some((v) => v.patternId === route)).toBe(false);
			});

			// HTML inputs (raw tests)
			it(`detects <a href = "https://naia.land/ko/<route>"> in HTML independently: ${route}`, () => {
				const html = `<a href = "https://naia.land/ko/${route}">link</a>`;
				const result = checkHtmlSnippet(html);
				expect(result.violations.some((v) => v.patternId === route)).toBe(true);
			});

			it(`detects <a href=/<route>> in HTML independently: ${route}`, () => {
				const html = `<a href=/${route}>link</a>`;
				const result = checkHtmlSnippet(html);
				expect(result.violations.some((v) => v.patternId === route)).toBe(true);
			});

			it(`detects <a href="&#47;<route>"> in HTML independently: ${route}`, () => {
				const html = `<a href="&#47;${route}">link</a>`;
				const result = checkHtmlSnippet(html);
				expect(result.violations.some((v) => v.patternId === route)).toBe(true);
			});

			// Direct route argument call with actual naiaWebUrl implementation
			it(`detects direct route call with actual naiaWebUrl implementation in raw and minified form: ${route}`, () => {
				const code = `
          function naiaWebUrl(path, base) {
            const root = base.replace(/\\/+$/u, "");
            const suffix = path.replace(/^\\/+/u, "");
            return suffix ? \`\${root}/\${suffix}\` : root;
          }
          openUrl(naiaWebUrl("${route}", "https://naia.land"));
        `;
				const rawResult = checkSnippet(code);
				expect(rawResult.violations.some((v) => v.patternId === route)).toBe(true);

				const minified = minifyCode(code);
				const minResult = checkSnippet(minified);
				expect(minResult.violations.some((v) => v.patternId === route)).toBe(true);
			});

			// Negative cases (safe inputs)
			it(`does not detect "settings.<route>": ${route}`, () => {
				const result = checkSnippet(`openUrl("settings.${route}");`);
				expect(result.violations.some((v) => v.patternId === route)).toBe(false);
			});

			it(`does not detect {<route>: 1}: ${route}`, () => {
				const result = checkSnippet(`const data = { ${route}: 1 }; fetch(data);`);
				expect(result.violations.some((v) => v.patternId === route)).toBe(false);
			});

			it(`does not detect "/<route>hell": ${route}`, () => {
				const result = checkSnippet(`openUrl("/${route}hell");`);
				expect(result.violations.some((v) => v.patternId === route)).toBe(false);
			});

			it(`does not detect "/<route>_x": ${route}`, () => {
				const result = checkSnippet(`openUrl("/${route}_x");`);
				expect(result.violations.some((v) => v.patternId === route)).toBe(false);
			});
		});
	}

	describe("allowlist exact context verification", () => {
		for (const item of CANONICAL_ALLOWLIST) {
			it(`allows exact context: ${item.context} (${item.route})`, () => {
				const result = checkSnippet(`const path = "${item.context}";`);
				expect(result.violations.some((v) => v.patternId === item.route)).toBe(false);
			});
		}

		it("detects when context is one character different (/v1/apps/product)", () => {
			const result = checkSnippet(`fetch("/v1/apps/product");`);
			expect(result.violations.some((v) => v.patternId === "apps")).toBe(true);
		});

		it("detects when suffix is appended to context (/v1/apps/productsX)", () => {
			const result = checkSnippet(`fetch("/v1/apps/productsX");`);
			expect(result.violations.some((v) => v.patternId === "apps")).toBe(true);
		});

		it("detects when external host prefix is added to context", () => {
			const result = checkSnippet(`openUrl("https://external.com/v1/apps/products");`);
			expect(result.violations.some((v) => v.patternId === "apps")).toBe(true);
		});
	});
});
