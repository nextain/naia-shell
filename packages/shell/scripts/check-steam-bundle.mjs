#!/usr/bin/env node
/**
 * check-steam-bundle.mjs — Steam 빌드 프론트엔드 산출물 결제 UI/URL 누출 검사기 (#727).
 *
 * 위협 모델:
 * 개발자가 실수로 결제·충전·대시보드·앱스토어·후원 진입점을 Steam 빌드에 다시 넣는 회귀를 막는다.
 * 문법을 해석하지 않고 텍스트 단위로 검사하며, "전부 잡고 승인 목록만 통과" 규칙을 따른다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PAYMENT_PATTERNS = [
	{
		id: "billing",
		description: "Billing URL / entrypoint (SettingsTab / CostDashboard)",
	},
	{
		id: "dashboard",
		description: "Dashboard URL / entrypoint (SettingsTab)",
	},
	{
		id: "apps",
		description: "App store web URL / entrypoint (AppBar)",
	},
	{
		id: "donation",
		description: "Donation URL / entrypoint (OnboardingWizard)",
	},
	{
		id: "sponsors",
		description: "GitHub Sponsors URL (SettingsTab)",
	},
];

/**
 * 승인 목록 (Allowlist):
 * 실제 Steam 빌드 번들을 이 규칙으로 돌려 확인된 후보만 등록.
 * 정규식/와일드카드 없이 후보 위치의 완전 문자열(context)과 정확히 1:1 일치해야 통과.
 */
export const ALLOWLIST = [
	{
		route: "apps",
		context: "src/apps/workspace/Editor.tsx",
		reason: "Internal source file path in build metadata (.vite/manifest.json)",
	},
	{
		route: "apps",
		context: "src/apps/workspace/Terminal.tsx",
		reason: "Internal source file path in build metadata (.vite/manifest.json, bundle-budget-report.json)",
	},
	{
		route: "apps",
		context: "src/apps/browser/BrowserCenterArea.tsx",
		reason: "Internal source file path in build metadata (.vite/manifest.json, bundle-budget-report.json)",
	},
	{
		route: "apps",
		context: "src/apps/workspace/HerdrWorkspaceCenterArea.tsx",
		reason: "Internal source file path in build metadata (bundle-budget-report.json)",
	},
	{
		route: "apps",
		context: "/v1/apps/products",
		reason: "Internal API endpoint for installed apps in AppInstallDialog",
	},
];

// Normalize helper:
// 1) Replace /, \x2f, \/, &#47;, &#x2f;, &sol; with /
// 2) Decode \uXXXX and \xXX where hex code is ASCII alphanumeric or slash
export function normalizeContent(str) {
	let s = str.replace(/\\x2f|\\\/|&#47;|&#x2f;|&sol;/gi, "/");

	s = s.replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => {
		const cp = Number.parseInt(hex, 16);
		if (cp === 0x2f) return "/";
		if (
			(cp >= 0x30 && cp <= 0x39) ||
			(cp >= 0x41 && cp <= 0x5a) ||
			(cp >= 0x61 && cp <= 0x7a)
		) {
			return String.fromCharCode(cp);
		}
		return match;
	});

	s = s.replace(/\\x([0-9a-fA-F]{2})/g, (match, hex) => {
		const cp = Number.parseInt(hex, 16);
		if (cp === 0x2f) return "/";
		if (
			(cp >= 0x30 && cp <= 0x39) ||
			(cp >= 0x41 && cp <= 0x5a) ||
			(cp >= 0x61 && cp <= 0x7a)
		) {
			return String.fromCharCode(cp);
		}
		return match;
	});

	return s;
}

// Bounded context extractor:
// Finds full string bounded by quotes (", '), backtick (`), interpolation (${, }), or whitespace.
export function extractBoundedContext(text, matchStart, matchEnd) {
	let left = matchStart;
	while (left > 0) {
		const ch = text[left - 1];
		if (ch === '"' || ch === "'" || ch === "`" || /\s/.test(ch)) {
			break;
		}
		if (left >= 2 && text.slice(left - 2, left) === "${") {
			break;
		}
		if (ch === "}") {
			break;
		}
		left--;
	}

	let right = matchEnd;
	while (right < text.length) {
		const ch = text[right];
		if (ch === '"' || ch === "'" || ch === "`" || /\s/.test(ch)) {
			break;
		}
		if (right + 2 <= text.length && text.slice(right, right + 2) === "${") {
			break;
		}
		if (ch === "}") {
			break;
		}
		right++;
	}

	return text.slice(left, right);
}

function isApproved(route, fullContext) {
	const r = route.toLowerCase();
	return ALLOWLIST.some(
		(item) => item.route.toLowerCase() === r && item.context === fullContext,
	);
}

export function scanBundleFiles(dir) {
	let files = [];
	if (!fs.existsSync(dir)) return files;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files = files.concat(scanBundleFiles(full));
		} else if (/\.(js|html|mjs|cjs|css|json)$/i.test(entry.name)) {
			files.push(full);
		}
	}
	return files;
}

export function checkSteamBundle({ distDir, patterns = PAYMENT_PATTERNS } = {}) {
	const resolvedDist =
		distDir ||
		path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
	const files = scanBundleFiles(resolvedDist);
	if (files.length === 0) {
		return {
			success: false,
			error: `No bundle files found in ${resolvedDist}`,
			violations: [],
		};
	}

	const patternMap = new Map(patterns.map((p) => [p.id, p]));
	const checkRouteBilling = patternMap.has("billing");
	const checkRouteDashboard = patternMap.has("dashboard");
	const checkRouteApps = patternMap.has("apps");
	const checkRouteDonation = patternMap.has("donation");
	const checkSponsors = patternMap.has("sponsors");

	const activeRoutes = [];
	if (checkRouteBilling) activeRoutes.push("billing");
	if (checkRouteDashboard) activeRoutes.push("dashboard");
	if (checkRouteApps) activeRoutes.push("apps");
	if (checkRouteDonation) activeRoutes.push("donation");

	const routeRegexPart = activeRoutes.join("|");
	const CANDIDATE_RE =
		activeRoutes.length > 0
			? new RegExp(`/(${routeRegexPart})(?![a-zA-Z0-9_\\-])`, "gi")
			: null;

	const DIRECT_CALL_RE =
		activeRoutes.length > 0
			? new RegExp(
					`(?:naiaWebUrl|[a-zA-Z0-9_$]+)\\s*\\(\\s*["'](${routeRegexPart})["']`,
					"gi",
				)
			: null;

	const SPONSORS_RE = /(?:github\.com\/)?sponsors\/nextain/gi;

	const violations = [];

	for (const file of files) {
		const rawContent = fs.readFileSync(file, "utf8");
		const normContent = normalizeContent(rawContent);
		const relFile = path.relative(resolvedDist, file);

		const fileViolations = new Map();

		const scanText = (text, isNormalized) => {
			// 1. Route slash candidates: /billing, /dashboard, /apps, /donation
			if (CANDIDATE_RE) {
				CANDIDATE_RE.lastIndex = 0;
				let m;
				while ((m = CANDIDATE_RE.exec(text)) !== null) {
					const route = m[1].toLowerCase();
					const fullContext = extractBoundedContext(
						text,
						m.index,
						m.index + m[0].length,
					);
					if (!isApproved(route, fullContext)) {
						const key = `${route}::${fullContext}`;
						if (!fileViolations.has(key)) {
							const pat = patternMap.get(route);
							fileViolations.set(key, {
								file: relFile,
								patternId: route,
								description: pat?.description || route,
								matched: fullContext,
							});
						}
					}
				}
			}

			// 2. Direct route argument call (e.g. naiaWebUrl("billing", ...))
			if (DIRECT_CALL_RE) {
				DIRECT_CALL_RE.lastIndex = 0;
				let m;
				while ((m = DIRECT_CALL_RE.exec(text)) !== null) {
					const route = m[1].toLowerCase();
					const key = `direct-call::${route}::${m[0]}`;
					if (!fileViolations.has(key)) {
						const pat = patternMap.get(route);
						fileViolations.set(key, {
							file: relFile,
							patternId: route,
							description: pat?.description || route,
							matched: m[0],
						});
					}
				}
			}

			// 3. Sponsors pattern
			if (checkSponsors) {
				SPONSORS_RE.lastIndex = 0;
				let m;
				while ((m = SPONSORS_RE.exec(text)) !== null) {
					const key = `sponsors::${m[0]}`;
					if (!fileViolations.has(key)) {
						const pat = patternMap.get("sponsors");
						fileViolations.set(key, {
							file: relFile,
							patternId: "sponsors",
							description: pat?.description || "sponsors",
							matched: m[0],
						});
					}
				}
			}
		};

		scanText(rawContent, false);
		scanText(normContent, true);

		for (const v of fileViolations.values()) {
			violations.push(v);
		}
	}

	return {
		success: violations.length === 0,
		scannedFilesCount: files.length,
		violations,
	};
}

// CLI entrypoint
const isMain =
	process.argv[1] &&
	(pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url ||
		process.argv[1].endsWith("check-steam-bundle.mjs"));

if (isMain) {
	const customDist = process.argv[2];
	const result = checkSteamBundle({ distDir: customDist });
	if (result.error) {
		console.error(`[check-steam-bundle] ERROR: ${result.error}`);
		process.exit(1);
	}
	console.log(`[check-steam-bundle] Scanned ${result.scannedFilesCount} files.`);
	if (!result.success) {
		console.error(
			`[check-steam-bundle] FAILED: Found ${result.violations.length} payment link violation(s):`,
		);
		for (const v of result.violations) {
			console.error(
				`  - [${v.patternId}] in ${v.file}: "${v.matched}" (${v.description})`,
			);
		}
		process.exit(1);
	}
	console.log(
		"[check-steam-bundle] PASSED: No payment links or entrypoints found in bundle.",
	);
	process.exit(0);
}
