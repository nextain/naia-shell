import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkBundleBudget } from "../check-bundle-budget.mjs";

const temporaryDirectories = [];
const deferredModules = [
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

function fixture({
	entry = "export const answer = 42;",
	budget,
	manifestEntry = {},
} = {}) {
	const shellDirectory = mkdtempSync(resolve(tmpdir(), "naia-bundle-budget-"));
	temporaryDirectories.push(shellDirectory);
	const distDirectory = resolve(shellDirectory, "dist");
	mkdirSync(resolve(distDirectory, "assets"), { recursive: true });
	writeFileSync(
		resolve(distDirectory, "index.html"),
		'<script type="module" crossorigin src="/assets/index-test.js"></script>',
	);
	writeFileSync(resolve(distDirectory, "assets/index-test.js"), entry);
	for (const moduleName of deferredModules) {
		const chunkName = moduleName.split("/").at(-1).replace(".tsx", "-test.js");
		writeFileSync(
			resolve(distDirectory, "assets", chunkName),
			"export const deferred = true;",
		);
	}
	mkdirSync(resolve(distDirectory, ".vite"), { recursive: true });
	writeFileSync(
		resolve(distDirectory, ".vite/manifest.json"),
		JSON.stringify({
			"index.html": {
				file: "assets/index-test.js",
				isEntry: true,
				dynamicImports: deferredModules,
				...manifestEntry,
			},
			...Object.fromEntries(
				deferredModules.map((moduleName) => [
					moduleName,
					{
						file: `assets/${moduleName.split("/").at(-1).replace(".tsx", "-test.js")}`,
						isDynamicEntry: true,
					},
				]),
			),
		}),
	);
	writeFileSync(
		resolve(shellDirectory, "bundle-budget.json"),
		JSON.stringify(
			budget ?? { entryRawBytes: 1000, entryGzipBytes: 1000, distBytes: 5000 },
		),
	);
	return { shellDirectory, distDirectory };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("bundle budget", () => {
	it("measures the HTML module entry and writes a passing JSON report", () => {
		const { shellDirectory, distDirectory } = fixture();
		const report = checkBundleBudget({ shellDirectory });
		expect(report.passed).toBe(true);
		expect(report.entry).toBe("assets/index-test.js");
		expect(
			report.deferredChunks["src/components/OnboardingWizard.tsx"],
		).toEqual({
			file: "assets/OnboardingWizard-test.js",
			dynamicallyImported: true,
			staticallyImported: false,
			modulePreloaded: false,
			passed: true,
		});
		expect(report.measurements.entryRawBytes).toBeGreaterThan(0);
		expect(
			JSON.parse(
				readFileSync(
					resolve(distDirectory, "bundle-budget-report.json"),
					"utf8",
				),
			),
		).toEqual(report);
	});

	it("fails closed when any measured size exceeds its budget", () => {
		const { shellDirectory, distDirectory } = fixture({
			entry: "x".repeat(200),
			budget: { entryRawBytes: 100, entryGzipBytes: 1000, distBytes: 2000 },
		});
		const report = checkBundleBudget({ shellDirectory });
		expect(report.passed).toBe(false);
		expect(report.checks.entryRawBytes).toEqual({
			actual: 200,
			limit: 100,
			passed: false,
		});
	});

	it("rejects a build without an explicit module entry", () => {
		const { distDirectory } = fixture();
		writeFileSync(resolve(distDirectory, "index.html"), "<main>missing</main>");
		expect(() =>
			checkBundleBudget({ shellDirectory: resolve(distDirectory, "..") }),
		).toThrow("Unable to resolve the module entry script");
		expect(
			JSON.parse(
				readFileSync(
					resolve(distDirectory, "bundle-budget-report.json"),
					"utf8",
				),
			),
		).toMatchObject({
			passed: false,
			error: expect.stringContaining(
				"Unable to resolve the module entry script",
			),
		});
	});

	it("fails closed when the deferred module is absent from the manifest", () => {
		const { shellDirectory, distDirectory } = fixture();
		writeFileSync(
			resolve(distDirectory, ".vite/manifest.json"),
			JSON.stringify({
				"index.html": { file: "assets/index-test.js", isEntry: true },
			}),
		);
		const report = checkBundleBudget({ shellDirectory });
		expect(report.passed).toBe(false);
		expect(
			report.deferredChunks["src/components/OnboardingWizard.tsx"],
		).toEqual({
			file: null,
			dynamicallyImported: false,
			staticallyImported: false,
			modulePreloaded: false,
			passed: false,
		});
	});

	it("rejects an onboarding chunk imported by the entry synchronously", () => {
		const { shellDirectory } = fixture({
			manifestEntry: {
				dynamicImports: [],
				imports: ["src/components/OnboardingWizard.tsx"],
			},
		});
		const report = checkBundleBudget({ shellDirectory });
		expect(
			report.deferredChunks["src/components/OnboardingWizard.tsx"],
		).toMatchObject({
			dynamicallyImported: false,
			staticallyImported: true,
			passed: false,
		});
	});

	it("rejects a deferred chunk eagerly module-preloaded by the HTML", () => {
		const { shellDirectory, distDirectory } = fixture();
		writeFileSync(
			resolve(distDirectory, "index.html"),
			'<link rel="modulepreload" href="/assets/OnboardingWizard-test.js"><script type="module" src="/assets/index-test.js"></script>',
		);
		const report = checkBundleBudget({ shellDirectory });
		expect(
			report.deferredChunks["src/components/OnboardingWizard.tsx"],
		).toMatchObject({ modulePreloaded: true, passed: false });
	});

	it("rejects a modulepreload even when href appears before rel", () => {
		const { shellDirectory, distDirectory } = fixture();
		writeFileSync(
			resolve(distDirectory, "index.html"),
			'<link href="/assets/OnboardingWizard-test.js" rel="modulepreload"><script type="module" src="/assets/index-test.js"></script>',
		);
		const report = checkBundleBudget({ shellDirectory });
		expect(
			report.deferredChunks["src/components/OnboardingWizard.tsx"],
		).toMatchObject({ modulePreloaded: true, passed: false });
	});

	it("rejects token-list modulepreloads with a base path and URL suffix", () => {
		const { shellDirectory, distDirectory } = fixture();
		writeFileSync(
			resolve(distDirectory, "index.html"),
			'<link rel="preload MODULEPRELOAD" href="/desktop/assets/OnboardingWizard-test.js?v=1#chunk"><script type="module" src="/assets/index-test.js"></script>',
		);
		const report = checkBundleBudget({ shellDirectory });
		expect(
			report.deferredChunks["src/components/OnboardingWizard.tsx"],
		).toMatchObject({ modulePreloaded: true, passed: false });
	});

	it("rejects a deferred module reachable through transitive static imports", () => {
		const { shellDirectory, distDirectory } = fixture({
			manifestEntry: { imports: ["src/startup.ts"] },
		});
		const manifestPath = resolve(distDirectory, ".vite/manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		manifest["src/startup.ts"] = {
			file: "assets/startup.js",
			imports: ["src/components/OnboardingWizard.tsx"],
		};
		writeFileSync(manifestPath, JSON.stringify(manifest));
		const report = checkBundleBudget({ shellDirectory });
		expect(
			report.deferredChunks["src/components/OnboardingWizard.tsx"],
		).toMatchObject({ staticallyImported: true, passed: false });
	});

	it("accepts nested and generated-key dynamic entries reachable from the entry", () => {
		const { shellDirectory, distDirectory } = fixture({
			manifestEntry: { dynamicImports: ["src/apps/workspace/index.tsx"] },
		});
		const manifestPath = resolve(distDirectory, ".vite/manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		delete manifest["src/apps/workspace/HerdrWorkspaceCenterArea.tsx"];
		manifest["_HerdrWorkspaceCenterArea-test.js"] = {
			file: "assets/HerdrWorkspaceCenterArea-test.js",
			name: "HerdrWorkspaceCenterArea",
			isDynamicEntry: true,
			imports: ["index.html"],
			dynamicImports: ["src/apps/workspace/Terminal.tsx"],
		};
		manifest["src/apps/workspace/index.tsx"] = {
			file: "assets/workspace-index.js",
			dynamicImports: ["_HerdrWorkspaceCenterArea-test.js"],
		};
		manifest["src/apps/workspace/Terminal.tsx"].isDynamicEntry = true;
		writeFileSync(manifestPath, JSON.stringify(manifest));

		const report = checkBundleBudget({ shellDirectory });
		expect(
			report.deferredChunks["src/apps/workspace/HerdrWorkspaceCenterArea.tsx"],
		).toMatchObject({ dynamicallyImported: true, passed: true });
		expect(
			report.deferredChunks["src/apps/workspace/Terminal.tsx"],
		).toMatchObject({ dynamicallyImported: true, passed: true });
	});

	it("accepts a dynamic boundary below the entry's static dependency", () => {
		const { shellDirectory, distDirectory } = fixture({
			manifestEntry: {
				dynamicImports: deferredModules.filter(
					(moduleName) => moduleName !== "src/components/ChatArea.tsx",
				),
				imports: ["src/startup.ts"],
			},
		});
		const manifestPath = resolve(distDirectory, ".vite/manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		manifest["src/startup.ts"] = {
			file: "assets/startup.js",
			dynamicImports: ["src/components/ChatArea.tsx"],
		};
		writeFileSync(manifestPath, JSON.stringify(manifest));

		const report = checkBundleBudget({ shellDirectory });
		expect(report.deferredChunks["src/components/ChatArea.tsx"]).toMatchObject({
			dynamicallyImported: true,
			staticallyImported: false,
			passed: true,
		});
	});

	it("rejects an orphan dynamic entry that is unreachable from the entry", () => {
		const { shellDirectory, distDirectory } = fixture();
		const manifestPath = resolve(distDirectory, ".vite/manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		manifest["index.html"].dynamicImports = manifest[
			"index.html"
		].dynamicImports.filter(
			(moduleName) => moduleName !== "src/components/OnboardingWizard.tsx",
		);
		writeFileSync(manifestPath, JSON.stringify(manifest));

		const report = checkBundleBudget({ shellDirectory });
		expect(
			report.deferredChunks["src/components/OnboardingWizard.tsx"],
		).toMatchObject({ dynamicallyImported: false, passed: false });
	});

	it("rejects a missing or entry-identical deferred chunk file", () => {
		const { shellDirectory, distDirectory } = fixture();
		const manifestPath = resolve(distDirectory, ".vite/manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		manifest["src/components/OnboardingWizard.tsx"].file =
			"assets/index-test.js";
		writeFileSync(manifestPath, JSON.stringify(manifest));
		expect(checkBundleBudget({ shellDirectory }).passed).toBe(false);

		manifest["src/components/OnboardingWizard.tsx"].file = "assets/missing.js";
		writeFileSync(manifestPath, JSON.stringify(manifest));
		expect(checkBundleBudget({ shellDirectory }).passed).toBe(false);
	});
});
