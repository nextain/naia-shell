import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	LONG_CACHE_CONTROL,
	MEDIA_CACHE_CONTROL,
	NO_CACHE_CONTROL,
	buildUploadPlan,
	classifyDeployCacheControl,
	deployWebDemo,
	formatDryRunPlan,
} from "../deploy-web-demo.mjs";

let siteDir: string;

beforeEach(() => {
	siteDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-web-demo-"));
	fs.mkdirSync(path.join(siteDir, "assets"), { recursive: true });
	fs.mkdirSync(path.join(siteDir, "kiosk-slides", "private"), {
		recursive: true,
	});
	fs.mkdirSync(path.join(siteDir, "web-adk"), { recursive: true });
	fs.mkdirSync(path.join(siteDir, "nva", "jina", "speech"), {
		recursive: true,
	});
	fs.mkdirSync(path.join(siteDir, ".vite"), { recursive: true });

	fs.writeFileSync(path.join(siteDir, "index.html"), "<html></html>");
	fs.writeFileSync(path.join(siteDir, "sw.js"), "/* sw */");
	fs.writeFileSync(path.join(siteDir, "manifest.webmanifest"), "{}");
	fs.writeFileSync(path.join(siteDir, ".vite", "manifest.json"), "{}");
	fs.writeFileSync(
		path.join(siteDir, "assets", "index-CoAXdThm.js"),
		"console.log(1);",
	);
	fs.writeFileSync(
		path.join(siteDir, "assets", "pdf.worker.min-qwK7q_zL.mjs"),
		"export default {};",
	);
	fs.writeFileSync(
		path.join(siteDir, "kiosk-slides", "private", "0a815c0b4003be18.jpg"),
		"jpg",
	);
	fs.writeFileSync(
		path.join(siteDir, "web-adk", "13ea427991542965091f2f3211b9325a36dbd522.json"),
		"{}",
	);
	fs.writeFileSync(
		path.join(siteDir, "nva", "jina", "speech", "atlas.bin"),
		"atlas",
	);
});

afterEach(() => {
	fs.rmSync(siteDir, { recursive: true, force: true });
});

describe("deploy-web-demo", () => {
	it("classifies index.html, sw.js, and separate SW registration files as no-cache and hashed assets as long immutable cache", () => {
		expect(classifyDeployCacheControl("index.html")).toEqual({
			relPath: "index.html",
			tier: "no-cache",
			cacheControl: NO_CACHE_CONTROL,
		});
		expect(classifyDeployCacheControl("sw.js")).toEqual({
			relPath: "sw.js",
			tier: "no-cache",
			cacheControl: NO_CACHE_CONTROL,
		});
		expect(classifyDeployCacheControl("registerSW.js")).toEqual({
			relPath: "registerSW.js",
			tier: "no-cache",
			cacheControl: NO_CACHE_CONTROL,
		});
		expect(classifyDeployCacheControl("sw-register.mjs")).toEqual({
			relPath: "sw-register.mjs",
			tier: "no-cache",
			cacheControl: NO_CACHE_CONTROL,
		});
		expect(classifyDeployCacheControl("assets/index-CoAXdThm.js")).toEqual({
			relPath: "assets/index-CoAXdThm.js",
			tier: "immutable",
			cacheControl: LONG_CACHE_CONTROL,
		});
		expect(
			classifyDeployCacheControl("assets/pdf.worker.min-qwK7q_zL.mjs"),
		).toEqual({
			relPath: "assets/pdf.worker.min-qwK7q_zL.mjs",
			tier: "immutable",
			cacheControl: LONG_CACHE_CONTROL,
		});
		expect(classifyDeployCacheControl("nva/jina/speech/atlas.bin")).toEqual({
			relPath: "nva/jina/speech/atlas.bin",
			tier: "media",
			cacheControl: MEDIA_CACHE_CONTROL,
		});
	});

	it("orders upload steps with immutable hashed assets first and no-cache entry files last", () => {
		const plan = buildUploadPlan({ siteDir });
		expect(plan.totalFiles).toBe(9);
		expect(plan.steps.map((s) => s.tier)).toEqual([
			"immutable",
			"media",
			"no-cache",
		]);
		expect(plan.steps[0].cacheControl).toBe(LONG_CACHE_CONTROL);
		expect(plan.steps[0].files).toEqual([
			"assets/index-CoAXdThm.js",
			"assets/pdf.worker.min-qwK7q_zL.mjs",
			"kiosk-slides/private/0a815c0b4003be18.jpg",
			"web-adk/13ea427991542965091f2f3211b9325a36dbd522.json",
		]);
		expect(plan.steps[2].cacheControl).toBe(NO_CACHE_CONTROL);
		expect(plan.steps[2].files).toEqual([
			".vite/manifest.json",
			"index.html",
			"manifest.webmanifest",
			"sw.js",
		]);
	});

	it("fails closed when index.html or sw.js is missing", () => {
		fs.unlinkSync(path.join(siteDir, "sw.js"));
		expect(() => buildUploadPlan({ siteDir })).toThrow(/sw\.js/);
	});

	it("supports CLI --dry-run without executing az and cleans up staging dirs after mock execution", () => {
		const scriptPath = path.resolve(
			import.meta.dirname,
			"../deploy-web-demo.mjs",
		);
		const cliOutput = execFileSync(
			process.execPath,
			[scriptPath, "--site-dir", siteDir, "--dry-run"],
			{ encoding: "utf8" },
		);
		expect(cliOutput).toContain("--content-cache-control no-cache");
		expect(cliOutput).toContain(
			"--content-cache-control 'public, max-age=31536000, immutable'",
		);
		expect(cliOutput).toContain("index.html => Cache-Control: no-cache");
		expect(cliOutput).toContain("sw.js => Cache-Control: no-cache");

		const runner = vi.fn((_cmd: string, args: string[]) => {
			const sIdx = args.indexOf("-s");
			expect(fs.existsSync(args[sIdx + 1])).toBe(true);
		});
		const execRes = deployWebDemo({ siteDir, dryRun: false, runner });
		expect(runner).toHaveBeenCalledTimes(3);
		expect(execRes.dryRun).toBe(false);
		expect(fs.existsSync(execRes.plan.steps[0].stageDir)).toBe(false);
		expect(formatDryRunPlan(execRes.plan)).toContain("dry-run plan");
	});
});
