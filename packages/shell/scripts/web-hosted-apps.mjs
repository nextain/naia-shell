import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const shellDir = fileURLToPath(new URL("../", import.meta.url));
const repoDir = resolve(shellDir, "../..");
const miniAppsRepo = "https://github.com/nextain/naia-shell.git";
const miniAppsCommit = "0912f5016a2ae81c028d375dfc7dbd837d9ba6bb";
const apps = [
	{ name: "charcard", slug: "naia-charcard", id: "land.naia.charcard" },
	{ name: "slides", slug: "naia-slides", id: "land.naia.slides" },
	{ name: "ieumoffice", slug: "ieumoffice", id: "land.naia.ieumoffice" },
	{
		name: "cafelua-tarot",
		slug: "cafelua-tarot",
		id: "land.naia.cafelua-tarot",
	},
];

function git(cwd, ...args) {
	execFileSync("git", args, {
		cwd,
		stdio: "inherit",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		timeout: 120_000,
	});
}

function extractMiniAppSources(scratchDir) {
	let sourceRepo = repoDir;
	const local = spawnSync(
		"git",
		["cat-file", "-e", `${miniAppsCommit}^{commit}`],
		{
			cwd: repoDir,
			stdio: "ignore",
		},
	);
	if (local.status !== 0) {
		console.log(`[web-hosted-apps] Fetching source commit ${miniAppsCommit}`);
		sourceRepo = join(scratchDir, "git-source");
		mkdirSync(sourceRepo);
		git(sourceRepo, "init", "--quiet");
		git(
			sourceRepo,
			"fetch",
			"--quiet",
			"--depth=1",
			"--no-tags",
			miniAppsRepo,
			miniAppsCommit,
		);
	} else {
		console.log(
			`[web-hosted-apps] Using local source commit ${miniAppsCommit}`,
		);
	}

	const archive = join(scratchDir, "mini-apps.tar");
	const files = ["src", "package.json", "tsconfig.json"];
	for (const { name } of apps.filter(({ name }) => name !== "slides")) {
		files.push(`${name}.html`, `vite.${name}.config.ts`);
	}
	git(
		sourceRepo,
		"archive",
		`--output=${archive}`,
		miniAppsCommit,
		...files.map((file) => `packages/shell/${file}`),
	);
	execFileSync("tar", ["-xf", archive, "-C", scratchDir], { stdio: "inherit" });

	const sourceDir = join(scratchDir, "packages", "shell");
	// The pinned builds use the Shell's existing, lockfile-installed Vite dependencies.
	symlinkSync(
		join(shellDir, "node_modules"),
		join(sourceDir, "node_modules"),
		"junction",
	);
	return sourceDir;
}

function requireBuiltFile(appDir, asset) {
	const base = new URL("https://example.invalid/hosted-app/");
	const url = new URL(asset, base);
	const filePath = decodeURIComponent(url.pathname.slice(base.pathname.length));
	if (
		asset.startsWith("/") ||
		/^[a-z][a-z\d+.-]*:/i.test(asset) ||
		!url.href.startsWith(base.href) ||
		isAbsolute(filePath) ||
		filePath.split(/[/\\]/).includes("..")
	) {
		throw new Error(`Asset must stay under the hosted app directory: ${asset}`);
	}
	const file = join(appDir, filePath);
	const stat = statSync(file, { throwIfNoEntry: false });
	if (!stat?.isFile() || stat.size === 0) {
		throw new Error(`Missing or empty hosted app file: ${asset}`);
	}
	return file;
}

export function verifyWebHostedApps(hostedDir) {
	for (const { slug, id } of apps) {
		const appDir = join(hostedDir, slug);
		try {
			const manifest = JSON.parse(
				readFileSync(requireBuiltFile(appDir, "app.json"), "utf8"),
			);
			if (
				manifest.id !== id ||
				typeof manifest.version !== "string" ||
				!manifest.version.trim()
			) {
				throw new Error(`Expected a versioned manifest for ${id}`);
			}
			if (
				typeof manifest.iconUrl !== "string" ||
				!manifest.iconUrl.endsWith(".svg")
			) {
				throw new Error("Expected a bundled SVG icon in the app manifest");
			}
			requireBuiltFile(appDir, manifest.iconUrl);
			const html = readFileSync(requireBuiltFile(appDir, "index.html"), "utf8");
			const scripts = [
				...html.matchAll(/<script\s[^>]*\bsrc=["']([^"']+)["']/gi),
			];
			if (!/<html[\s>]/i.test(html) || scripts.length === 0) {
				throw new Error("index.html is missing a built script entry");
			}
			const styles = html.matchAll(
				/<link\s+rel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["']/gi,
			);
			for (const [, asset] of [...scripts, ...styles])
				requireBuiltFile(appDir, asset);
		} catch (error) {
			throw new Error(`[web-hosted-apps] ${slug}: ${error.message}`, {
				cause: error,
			});
		}
	}
}

export function stageWebHostedApps(outDir) {
	const scratchDir = mkdtempSync(join(tmpdir(), "naia-web-hosted-apps-"));
	try {
		const sourceDir = extractMiniAppSources(scratchDir);
		const staged = mkdtempSync(join(outDir, ".hosted-apps-"));
		const vite = join(shellDir, "node_modules/vite/bin/vite.js");
		try {
			for (const { name, slug } of apps) {
				const isSlides = name === "slides";
				const cwd = isSlides ? shellDir : sourceDir;
				const target = join(staged, slug);
				console.log(`[web-hosted-apps] Building ${slug}`);
				execFileSync(
					process.execPath,
					[
						vite,
						"build",
						"--config",
						`vite.${name}.config.ts`,
						...(isSlides ? ["--mode", "web", "--outDir", target] : []),
					],
					{ cwd, stdio: "inherit" },
				);
				if (!isSlides) {
					// The pinned configs rename the HTML inside their default dist-*.
					cpSync(join(cwd, `dist-${name}`), target, { recursive: true });
				}
			}
			verifyWebHostedApps(staged);
			chmodSync(staged, 0o755);
			const hostedDir = join(outDir, "hosted-apps");
			rmSync(hostedDir, { recursive: true, force: true });
			renameSync(staged, hostedDir);
			console.log(`[web-hosted-apps] Staged ${apps.length} app bundles`);
		} finally {
			rmSync(staged, { recursive: true, force: true });
		}
	} finally {
		rmSync(scratchDir, { recursive: true, force: true });
	}
}
