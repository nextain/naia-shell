#!/usr/bin/env node
// check-logging — 로깅 표준 강제(docs/logging.md, 계약 F-LOG-3). "표준만, 다른 방식 금지"를 결정론으로 차단.
//
// 규칙: shell src 의 모든 .ts/.tsx 는 표준 로거 `Logger`(src/lib/logger.ts)만 쓴다. `console.*` 직접 사용 금지.
// 발견 시 RED → `Logger.debug/info/warn/error` 로 교정. 표준 로거 정의/브리지 파일은 allow-list.
//   - 테스트(__tests__/*.test.{ts,tsx})·e2e 는 제외.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), ".."); // packages/shell
const SRC = join(ROOT, "src");

// 표준 로거 그 자체(console 을 한 곳에서 감싸는 경계) — allow-list.
const ALLOW = new Set([
	"src/lib/logger.ts", // 표준 Logger 정의(console 을 여기서만 래핑)
]);

const FORBIDDEN = [
	{ re: /\bconsole\.(log|debug|info|warn|error|trace)\s*\(/, msg: "console.* 직접 사용 — 표준 Logger.debug/info/warn/error 사용" },
];

function walk(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) out.push(...walk(p));
		else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
	}
	return out;
}

const violations = [];
for (const file of walk(SRC)) {
	const rel = relative(ROOT, file).replaceAll("\\", "/");
	if (rel.includes("__tests__") || /\.test\.(ts|tsx)$/.test(rel) || ALLOW.has(rel)) continue;
	const lines = readFileSync(file, "utf8").split("\n");
	lines.forEach((line, i) => {
		const t = line.trimStart();
		if (t.startsWith("//") || t.startsWith("*")) return;
		for (const f of FORBIDDEN) {
			if (f.re.test(line)) violations.push(`  ✗ ${rel}:${i + 1} — ${f.msg}`);
		}
	});
}

if (violations.length) {
	console.error(`[check-logging] RED — 표준 외 로깅 ${violations.length}건 (docs/logging.md · 계약 F-LOG-3):`);
	console.error(violations.join("\n"));
	process.exit(1);
}
console.error("[check-logging] OK — shell src 전부 표준 Logger. console.* 직접 사용 0건.");
