#!/usr/bin/env node
/**
 * check-steam-bundle.mjs — Steam 빌드 프론트엔드 산출물 결제 UI/URL 누출 검사기 (#727).
 *
 * Steam 배포 정책에 따라 앱 내부에서 외부 결제(충전, 대시보드, 후원, 스폰서, 앱스토어 웹)로의
 * 연결이 완전히 제거되었는지 빌드 산출물 전체(dist)를 스캔한다.
 *
 * 단순 키워드가 아닌 실제 번들된 진입점/URL 조합식을 검출하며,
 * 일반 호스트명이나 모델 설정 속성(billing:"naia"), 번역 키 자체로는 오탐하지 않는다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function createRouteRegex(route) {
	return new RegExp(
		`(?:` +
			`[a-zA-Z0-9_$)\]}]\\s*\\+\\s*["'\`]\\/?${route}(?=["'\`\\/]|$)|` +
			`(?<=["'\`])(?!(?:[^"'\`]*?\\/)?(?:v1|api)\\/)[a-zA-Z0-9_\${}()\\-./]*\\/${route}(?=["'\`\\/]|$)` +
		`)`,
	);
}

export const PAYMENT_PATTERNS = [
	{
		id: "billing",
		description: "Billing URL / entrypoint (SettingsTab / CostDashboard)",
		// Matches URL combination ending in /billing, e.g. `${base}/${locale}/billing`, `${getLocale()}/billing`, "ko/billing", e+"/billing"
		regex: createRouteRegex("billing"),
	},
	{
		id: "dashboard",
		description: "Dashboard URL / entrypoint (SettingsTab)",
		// Matches URL combination ending in /dashboard, e.g. `${base}/${locale}/dashboard`, `${x}/dashboard`, "ko/dashboard", e+"/dashboard"
		regex: createRouteRegex("dashboard"),
	},
	{
		id: "apps",
		description: "App store web URL / entrypoint (AppBar)",
		// Matches web store URL combination ending in /apps, e.g. `${base}/${locale}/apps`, `${x}/apps`, "ko/apps", e+"/apps" (excluding /v1/apps, /api/apps, /v1/apps/products)
		regex: createRouteRegex("apps"),
	},
	{
		id: "donation",
		description: "Donation URL / entrypoint (OnboardingWizard)",
		// Matches naiaWebUrl("donation") or function call with "donation" route parameter
		regex: /(?:naiaWebUrl|[a-zA-Z0-9_$]+)\s*\(\s*["']donation["']/i,
	},
	{
		id: "sponsors",
		description: "GitHub Sponsors URL (SettingsTab)",
		// Matches github.com/sponsors/nextain
		regex: /(?:github\.com\/)?sponsors\/nextain/,
	},
];

export function scanBundleFiles(dir) {
	let files = [];
	if (!fs.existsSync(dir)) return files;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files = files.concat(scanBundleFiles(full));
		} else if (/\.(js|html|mjs|cjs)$/.test(entry.name)) {
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

	const violations = [];
	for (const file of files) {
		const content = fs.readFileSync(file, "utf8");
		for (const pattern of patterns) {
			const match = content.match(pattern.regex);
			if (match) {
				violations.push({
					file: path.relative(resolvedDist, file),
					patternId: pattern.id,
					description: pattern.description,
					matched: match[0],
				});
			}
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
