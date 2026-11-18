#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const shellDir = resolve(__dirname, "..");

const APPS = [
	{
		appId: "land.naia.slides",
		hostedSlug: "naia-slides",
		buildScript: "build:slides",
		distDir: "dist-slides",
	},
	{
		appId: "land.naia.ieumoffice",
		hostedSlug: "ieumoffice",
		buildScript: "build:ieumoffice",
		distDir: "dist-ieumoffice",
	},
	{
		appId: "land.naia.cafelua-tarot",
		hostedSlug: "cafelua-tarot",
		buildScript: "build:cafelua-tarot",
		distDir: "dist-cafelua-tarot",
	},
	{
		appId: "land.naia.charcard",
		hostedSlug: "naia-charcard",
		buildScript: "build:charcard",
		distDir: "dist-charcard",
	},
];

const targetRoot = process.argv[2]
	? resolve(process.cwd(), process.argv[2])
	: resolve(shellDir, "dist-hosted-apps");
const skipBuild = process.argv.includes("--skip-build");

mkdirSync(targetRoot, { recursive: true });

const catalog = [];

for (const app of APPS) {
	if (!skipBuild) {
		execFileSync("pnpm", ["run", app.buildScript], {
			cwd: shellDir,
			stdio: "inherit",
		});
	}

	const builtPath = resolve(shellDir, app.distDir);
	const indexHtml = resolve(builtPath, "index.html");
	const appJson = resolve(builtPath, "app.json");
	if (!existsSync(indexHtml) || !existsSync(appJson)) {
		throw new Error(`Missing index.html or app.json in ${builtPath}`);
	}

	const manifest = JSON.parse(readFileSync(appJson, "utf8"));

	for (const dirName of [app.appId, app.hostedSlug]) {
		const dest = resolve(targetRoot, dirName);
		rmSync(dest, { recursive: true, force: true });
		cpSync(builtPath, dest, { recursive: true });
	}

	catalog.push({
		id: app.appId,
		appId: app.appId,
		hostedSlug: app.hostedSlug,
		version: manifest.version,
		entryPath: `/hosted-apps/${app.appId}/index.html`,
		slugEntryPath: `/hosted-apps/${app.hostedSlug}/index.html`,
		manifest,
	});
}

writeFileSync(
	resolve(targetRoot, "catalog.json"),
	`${JSON.stringify({ generatedAt: new Date().toISOString(), apps: catalog }, null, 2)}\n`,
);

console.log(
	`[stage-web-hosted-apps] Staged ${catalog.length} apps (${catalog.map((c) => `${c.appId}@${c.version}`).join(", ")}) -> ${targetRoot}`,
);
