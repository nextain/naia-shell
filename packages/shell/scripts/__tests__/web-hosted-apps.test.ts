import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STAGE1_HOSTED_MINI_APPS } from "../../src/lib/app-store-adapter";
import { verifyWebHostedApps } from "../web-hosted-apps.mjs";

describe("R35 hosted web build artifacts", () => {
	let root: string;
	const entry = '<html><script defer src="./assets/app.js"></script></html>';

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "web-hosted-apps-test-"));
		for (const { appId, hostedSlug } of STAGE1_HOSTED_MINI_APPS) {
			const app = join(root, hostedSlug);
			mkdirSync(join(app, "assets"), { recursive: true });
			writeFileSync(
				join(app, "app.json"),
				JSON.stringify({ id: appId, version: "1.0.0", iconUrl: "icon.svg" }),
			);
			writeFileSync(join(app, "icon.svg"), "<svg/>");
			writeFileSync(join(app, "index.html"), entry);
			writeFileSync(
				join(app, "assets/app.js"),
				"document.body.textContent = 'ready';",
			);
		}
	});

	afterEach(() => rmSync(root, { force: true, recursive: true }));

	it("requires a valid bundle for every built-in store app", () => {
		expect(() => verifyWebHostedApps(root)).not.toThrow();
		for (const { hostedSlug } of STAGE1_HOSTED_MINI_APPS) {
			const html = join(root, hostedSlug, "index.html");
			rmSync(html);
			expect(() => verifyWebHostedApps(root)).toThrow(
				`${hostedSlug}: Missing or empty hosted app file: index.html`,
			);
			writeFileSync(html, entry);
		}
	});

	it("rejects a shell fallback with rooted assets", () => {
		writeFileSync(
			join(root, "naia-slides/index.html"),
			entry.replace("./assets/", "/app/assets/"),
		);
		expect(() => verifyWebHostedApps(root)).toThrow(
			"Asset must stay under the hosted app directory",
		);
	});

	it.each(["app.json", "icon.svg", "assets/app.js"])(
		"rejects a bundle missing %s",
		(file) => {
			rmSync(join(root, "cafelua-tarot", file));
			expect(() => verifyWebHostedApps(root)).toThrow(
				/cafelua-tarot: Missing or empty hosted app file/,
			);
		},
	);
});
