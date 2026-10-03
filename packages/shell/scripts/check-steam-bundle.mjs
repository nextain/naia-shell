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
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let ts;
try {
	ts = require("typescript");
} catch {
	ts = null;
}

export const PAYMENT_PATTERNS = [
	{
		id: "billing",
		description: "Billing URL / entrypoint (SettingsTab / CostDashboard)",
		// Fallback / legacy regex representation
		regex: /\/(?!(?:v1|api)\/)[a-zA-Z0-9_${}()\-./]*\/billing(?=[/?#"'`\\]|$)/,
	},
	{
		id: "dashboard",
		description: "Dashboard URL / entrypoint (SettingsTab)",
		regex: /\/(?!(?:v1|api)\/)[a-zA-Z0-9_${}()\-./]*\/dashboard(?=[/?#"'`\\]|$)/,
	},
	{
		id: "apps",
		description: "App store web URL / entrypoint (AppBar)",
		regex: /\/(?!(?:v1|api)\/)[a-zA-Z0-9_${}()\-./]*\/apps(?=[/?#"'`\\]|$)/,
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

const CANDIDATE_RE = /(?:\/)(billing|dashboard|apps)(?=$|[/?#"'`\\])/g;
const API_RE = /(?:^|\/)(?:v1|api)(?:\/|$)/;

function flattenPlus(expr) {
	if (!ts) return [];
	if (ts.isParenthesizedExpression(expr)) {
		return flattenPlus(expr.expression);
	}
	if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		return [...flattenPlus(expr.left), ...flattenPlus(expr.right)];
	}
	if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
		return [{ type: "static", text: expr.text }];
	}
	if (ts.isTemplateExpression(expr)) {
		const list = [{ type: "static", text: expr.head.text }];
		for (const span of expr.templateSpans) {
			list.push({ type: "dynamic", expr: span.expression });
			list.push({ type: "static", text: span.literal.text });
		}
		return list;
	}
	return [{ type: "dynamic", expr }];
}

function checkStaticAndDynamicChain(elements, targetRoutes) {
	const folded = [];
	for (const el of elements) {
		if (el.type === "static") {
			if (folded.length > 0 && folded[folded.length - 1].type === "static") {
				folded[folded.length - 1].text += el.text;
			} else {
				folded.push({ type: "static", text: el.text });
			}
		} else {
			folded.push(el);
		}
	}

	const violations = [];
	let hasApiPrefix = false;

	for (const el of folded) {
		if (el.type === "static") {
			const text = el.text;
			CANDIDATE_RE.lastIndex = 0;
			let match;
			while ((match = CANDIDATE_RE.exec(text)) !== null) {
				const route = match[1];
				if (!targetRoutes.includes(route)) continue;
				const matchIndex = match.index;
				const prefix = text.slice(0, matchIndex);

				if (hasApiPrefix || API_RE.test(prefix)) {
					// Excluded as API context
					continue;
				}
				violations.push({ patternId: route, matched: match[0] });
			}

			if (API_RE.test(text)) {
				hasApiPrefix = true;
			}
		}
	}

	return violations;
}

function analyzeJsWithTs(content, targetRoutes) {
	if (!ts) return null;
	const sf = ts.createSourceFile("bundle.js", content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const violations = [];

	function visit(node, parentIsPlus = false) {
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
			if (!parentIsPlus) {
				const elements = flattenPlus(node);
				violations.push(...checkStaticAndDynamicChain(elements, targetRoutes));
				for (const el of elements) {
					if (el.type === "dynamic" && el.expr) {
						visit(el.expr, false);
					}
				}
				return;
			}
		} else if (ts.isTemplateExpression(node) && !parentIsPlus) {
			const elements = flattenPlus(node);
			violations.push(...checkStaticAndDynamicChain(elements, targetRoutes));
			for (const el of elements) {
				if (el.type === "dynamic" && el.expr) {
					visit(el.expr, false);
				}
			}
			return;
		} else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !parentIsPlus) {
			const elements = [{ type: "static", text: node.text }];
			violations.push(...checkStaticAndDynamicChain(elements, targetRoutes));
			return;
		}

		ts.forEachChild(node, (child) => {
			const isPlus = ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
			visit(child, isPlus);
		});
	}

	visit(sf, false);
	return violations;
}

function analyzeJsFallback(content, targetRoutes) {
	// Strip comments and regex literals
	const stripped = content
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^\\:])\/\/.*$/gm, "$1")
		.replace(/\/(?![*\/])(?:\\.|[^\\\/\r\n])+\/[gimsuy]*/g, " ");

	// Extract string literals and templates
	const STR_RE = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
	const violations = [];
	let match;
	while ((match = STR_RE.exec(stripped)) !== null) {
		let unescaped = match[2];
		try {
			unescaped = JSON.parse(`"${unescaped.replace(/"/g, '\\"')}"`);
		} catch {}
		const chainViolations = checkStaticAndDynamicChain([{ type: "static", text: unescaped }], targetRoutes);
		violations.push(...chainViolations);
	}
	return violations;
}

function analyzeJs(content, targetRoutes) {
	const result = analyzeJsWithTs(content, targetRoutes);
	if (result !== null) return result;
	return analyzeJsFallback(content, targetRoutes);
}

function analyzeHtml(content, targetRoutes) {
	const violations = [];
	const noComments = content.replace(/<!--[\s\S]*?-->/g, "");

	const SCRIPT_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
	let scriptMatch;
	while ((scriptMatch = SCRIPT_RE.exec(noComments)) !== null) {
		const scriptCode = scriptMatch[1];
		if (scriptCode && scriptCode.trim()) {
			violations.push(...analyzeJs(scriptCode, targetRoutes));
		}
	}

	const ATTR_RE = /\b[a-zA-Z0-9_\-]+=(?:"([^"]*)"|'([^']*)')/g;
	let attrMatch;
	while ((attrMatch = ATTR_RE.exec(noComments)) !== null) {
		const val = attrMatch[1] ?? attrMatch[2] ?? "";
		violations.push(...checkStaticAndDynamicChain([{ type: "static", text: val }], targetRoutes));
	}

	return violations;
}

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

	const patternMap = new Map(patterns.map((p) => [p.id, p]));
	const activeRouteIds = ["billing", "dashboard", "apps"].filter((id) => patternMap.has(id));
	const otherPatterns = patterns.filter(
		(p) => p.id !== "billing" && p.id !== "dashboard" && p.id !== "apps",
	);

	const violations = [];
	for (const file of files) {
		const content = fs.readFileSync(file, "utf8");
		const ext = path.extname(file).toLowerCase();
		const relFile = path.relative(resolvedDist, file);

		// 1. Route violations (billing, dashboard, apps)
		if (activeRouteIds.length > 0) {
			let routeViolations = [];
			if (ext === ".html") {
				routeViolations = analyzeHtml(content, activeRouteIds);
			} else {
				routeViolations = analyzeJs(content, activeRouteIds);
			}

			for (const rv of routeViolations) {
				const pat = patternMap.get(rv.patternId);
				violations.push({
					file: relFile,
					patternId: rv.patternId,
					description: pat?.description || rv.patternId,
					matched: rv.matched,
				});
			}
		}

		// 2. Other patterns (donation, sponsors, etc.)
		for (const pattern of otherPatterns) {
			const match = content.match(pattern.regex);
			if (match) {
				violations.push({
					file: relFile,
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
