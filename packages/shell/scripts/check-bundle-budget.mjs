import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const REPORT_NAME = "bundle-budget-report.json";
const REQUIRED_DEFERRED_MODULES = [
	"src/apps/browser/BrowserCenterArea.tsx",
	"src/apps/workspace/HerdrWorkspaceCenterArea.tsx",
	"src/apps/workspace/Terminal.tsx",
	"src/components/AnnouncementBanner.tsx",
	"src/components/AdkSetupScreen.tsx",
	"src/components/AppInstallDialog.tsx",
	"src/components/AvatarCanvas.tsx",
	"src/components/AtMentionPopover.tsx",
	"src/components/ChatArea.tsx",
	"src/components/ChatMarkdown.tsx",
	"src/components/OnboardingWizard.tsx",
	"src/components/PermissionModal.tsx",
	"src/components/SettingsTab.tsx",
	"src/components/ToolActivity.tsx",
	"src/components/UpdateBanner.tsx",
	"src/components/UpdatePrompt.tsx",
	"src/components/VideoAvatarCanvas.tsx",
];

function directoryBytes(directory) {
	let total = 0;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === REPORT_NAME) continue;
		const path = resolve(directory, entry.name);
		total += entry.isDirectory() ? directoryBytes(path) : statSync(path).size;
	}
	return total;
}

function collectStaticImports(manifest, root) {
	const imports = new Set();
	const pending = [...(root.imports ?? [])];
	while (pending.length > 0) {
		const moduleName = pending.pop();
		if (typeof moduleName !== "string" || imports.has(moduleName)) continue;
		imports.add(moduleName);
		pending.push(...(manifest[moduleName]?.imports ?? []));
	}
	return imports;
}

function collectDeferredImports(manifest, root) {
	const deferred = new Set();
	const visited = new Set();
	const pending = [{ chunk: root, deferred: false }];
	while (pending.length > 0) {
		const next = pending.pop();
		if (!next?.chunk) continue;
		const stateKey = `${next.chunk.file ?? "<entry>"}:${next.deferred}`;
		if (visited.has(stateKey)) continue;
		visited.add(stateKey);
		const chunk = next.chunk;
		for (const moduleName of chunk?.imports ?? []) {
			if (next.deferred) deferred.add(moduleName);
			pending.push({ chunk: manifest[moduleName], deferred: next.deferred });
		}
		for (const moduleName of chunk?.dynamicImports ?? []) {
			deferred.add(moduleName);
			pending.push({ chunk: manifest[moduleName], deferred: true });
		}
	}
	return deferred;
}

function collectModulePreloads(html) {
	const preloads = new Set();
	for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
		const attributes = Object.fromEntries(
			[...tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map(
				([, name, value]) => [name.toLowerCase(), value],
			),
		);
		const relations = attributes.rel?.toLowerCase().split(/\s+/) ?? [];
		if (relations.includes("modulepreload") && attributes.href) {
			const pathname = new URL(attributes.href, "https://bundle.invalid")
				.pathname;
			preloads.add(pathname.replace(/^\//, ""));
		}
	}
	return preloads;
}

function resolveManifestChunk(manifest, moduleName) {
	if (manifest[moduleName]) return [moduleName, manifest[moduleName]];
	const expectedName = moduleName
		.split("/")
		.at(-1)
		?.replace(/\.[^.]+$/, "");
	return (
		Object.entries(manifest).find(
			([, chunk]) =>
				chunk?.isDynamicEntry === true && chunk.name === expectedName,
		) ?? [moduleName, undefined]
	);
}

export function measureBundle({
	distDirectory,
	budget,
	requiredDeferredModules = REQUIRED_DEFERRED_MODULES,
}) {
	const indexPath = resolve(distDirectory, "index.html");
	if (!existsSync(indexPath))
		throw new Error(`Missing build entry: ${indexPath}`);
	const html = readFileSync(indexPath, "utf8");
	const match = html.match(
		/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+\.js)["']/i,
	);
	if (!match)
		throw new Error(
			"Unable to resolve the module entry script from dist/index.html",
		);
	const entryPath = resolve(distDirectory, match[1].replace(/^\//, ""));
	if (!existsSync(entryPath))
		throw new Error(`Missing module entry script: ${entryPath}`);
	const entry = readFileSync(entryPath);
	const manifestPath = resolve(distDirectory, ".vite/manifest.json");
	if (!existsSync(manifestPath)) {
		// 매니페스트가 없는 가장 흔한 이유는 설정이 꺼진 것이 아니라, 컴파일된
		// vite.config.js 가 남아 원본 vite.config.ts 를 가리는 것이다. Vite 는
		// .js 를 .ts 보다 먼저 로드하므로 낡은 설정이 조용히 이긴다. 그 파일은
		// gitignore 대상이라 다른 기계에는 없고, 그래서 "여기서만 깨진다".
		const shadow = ["vite.config.js", "vite.config.mjs"]
			.map((name) => resolve(distDirectory, "..", name))
			.find((candidate) => existsSync(candidate));
		throw new Error(
			shadow
				? `Missing Vite manifest: ${manifestPath}\n` +
					`  ${shadow} 가 vite.config.ts 를 가리고 있다. Vite 는 .js 를 먼저 읽는다.\n` +
					"  그 파일은 옛 tsc 산출물이며 gitignore 대상이다 — 지우고 다시 빌드하라."
				: `Missing Vite manifest: ${manifestPath}\n` +
					"  vite.config 의 build.manifest 가 켜져 있는지 확인하라.",
		);
	}
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const entryFile = relative(distDirectory, entryPath).replaceAll("\\", "/");
	const entryManifest = Object.values(manifest).find(
		(item) => item?.isEntry === true && item.file === entryFile,
	);
	if (!entryManifest)
		throw new Error(`Missing Vite manifest entry for: ${entryFile}`);
	const modulePreloads = collectModulePreloads(html);
	const staticImports = collectStaticImports(manifest, entryManifest);
	const deferredImports = collectDeferredImports(manifest, entryManifest);
	const deferredChunks = Object.fromEntries(
		requiredDeferredModules.map((moduleName) => {
			const [chunkKey, chunk] = resolveManifestChunk(manifest, moduleName);
			const staticallyImported = staticImports.has(chunkKey);
			const dynamicallyImported =
				!staticallyImported && deferredImports.has(chunkKey);
			const modulePreloaded =
				typeof chunk?.file === "string" &&
				[...modulePreloads].some(
					(path) => path === chunk.file || path.endsWith(`/${chunk.file}`),
				);
			const fileExists =
				typeof chunk?.file === "string" &&
				chunk.file !== entryFile &&
				existsSync(resolve(distDirectory, chunk.file));
			return [
				moduleName,
				{
					file: chunk?.file ?? null,
					dynamicallyImported,
					staticallyImported,
					modulePreloaded,
					passed:
						fileExists &&
						dynamicallyImported &&
						!staticallyImported &&
						!modulePreloaded,
				},
			];
		}),
	);
	const measurements = {
		entryRawBytes: entry.byteLength,
		entryGzipBytes: gzipSync(entry).byteLength,
		distBytes: directoryBytes(distDirectory),
	};
	const checks = Object.fromEntries(
		Object.entries(budget).map(([name, limit]) => [
			name,
			{
				actual: measurements[name],
				limit,
				passed: measurements[name] <= limit,
			},
		]),
	);
	return {
		passed:
			Object.values(checks).every((check) => check.passed) &&
			Object.values(deferredChunks).every((check) => check.passed),
		entry: entryFile,
		deferredChunks,
		measurements,
		budget,
		checks,
	};
}

export function checkBundleBudget({
	shellDirectory = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
} = {}) {
	const distDirectory = resolve(shellDirectory, "dist");
	const budgetPath = resolve(shellDirectory, "bundle-budget.json");
	const reportPath = resolve(distDirectory, REPORT_NAME);
	try {
		if (!existsSync(budgetPath))
			throw new Error(`Missing bundle budget: ${budgetPath}`);
		const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
		for (const name of ["entryRawBytes", "entryGzipBytes", "distBytes"]) {
			if (!Number.isSafeInteger(budget[name]) || budget[name] <= 0) {
				throw new Error(`Invalid bundle budget ${name}: ${budget[name]}`);
			}
		}
		const report = measureBundle({ distDirectory, budget });
		writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
		return report;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		mkdirSync(distDirectory, { recursive: true });
		writeFileSync(
			reportPath,
			`${JSON.stringify({ passed: false, error: message }, null, 2)}\n`,
		);
		throw error;
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		const report = checkBundleBudget();
		for (const [name, check] of Object.entries(report.checks)) {
			console.log(
				`${check.passed ? "PASS" : "FAIL"} ${name}: ${check.actual} / ${check.limit} bytes`,
			);
		}
		for (const [name, check] of Object.entries(report.deferredChunks)) {
			console.log(
				`${check.passed ? "PASS" : "FAIL"} deferred module ${name}: ${check.file ?? "missing"}`,
			);
		}
		if (!report.passed) process.exitCode = 1;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
