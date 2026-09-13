#!/usr/bin/env node
/**
 * check-excluded-traces — 제외한 제공자·기능의 흔적 검사 (nextain/naia-shell#589).
 *
 * 지원 경로는 나이아 계정·CLI·로컬뿐이다. 타사 클라우드 API, Discord·cron, 보조·전문가·기억 역할은
 * 숨기지 않고 지운다. 이 검사는 지운 뒤 흔적이 남았는지를 (제공자, 파일, 줄) 단위로 찾는다.
 *
 * 판정
 *   - 적중은 자동으로 지우지 않는다. 적중마다 "남김" 또는 "흔적" 으로 분류한다.
 *   - 남김 1: 설정의 allow 규칙(경로·검색어·줄 안 문자열)에 맞는 적중.
 *   - 남김 2: 지원 경로가 쓰는 의존성. keepRoots 파일에서 import 를 따라가(동적·문자열 import 포함)
 *     닿은 외부 패키지 이름은, 어느 파일에 나오든 그 이름 안의 적중을 남김으로 친다.
 *     예: claude CLI 경로의 `@anthropic-ai/claude-agent-sdk` 안의 `anthropic`.
 *   - mustExist: 남기기로 한 파일이 사라지면 결함으로 보고한다.
 *
 * 모드
 *   기본(보고): 결과만 출력하고 exit 0.
 *   --strict <묶음,...>: 지정한 묶음의 흔적이나 mustExist 결함이 있으면 exit 1.
 *
 * 사용
 *   node scripts/check-excluded-traces.mjs [--config <json>] [--repo name=<path> ...] [--strict 1,2] [--json]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = join(HERE, "excluded-traces.config.json");
const TEXT_EXT = /\.(c|m)?(t|j)sx?$|\.(rs|json|ya?ml|toml|md|proto|html|css|sh|ps1)$/i;
const MAX_BYTES = 2 * 1024 * 1024;

/** 이름 표기 변형: camelCase·snake_case·SCREAMING_CASE·kebab-case. 한 단어면 그대로. */
export function nameVariants(term) {
	const words = term
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[\s_\-]+/)
		.filter(Boolean)
		.map((w) => w.toLowerCase());
	if (words.length < 2) return [term];
	const camel = words[0] + words.slice(1).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
	return [...new Set([term, camel, words.join("_"), words.join("_").toUpperCase(), words.join("-")])];
}

function globToRegExp(glob) {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			out += ".*";
			i++;
			if (glob[i + 1] === "/") i++;
		} else if (c === "*") out += "[^/]*";
		else if (".+?^${}()|[]\\".includes(c)) out += `\\${c}`;
		else out += c;
	}
	return new RegExp(`^${out}$`);
}

export function matchesAny(path, globs = []) {
	return globs.some((g) => globToRegExp(g).test(path));
}

function listFiles(root, include, exclude) {
	let tracked;
	try {
		tracked = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
			.split("\0")
			.filter(Boolean);
	} catch {
		throw new Error(`not a git repository: ${root}`);
	}
	return tracked.filter((p) => TEXT_EXT.test(p) && matchesAny(p, include) && !matchesAny(p, exclude));
}

const IMPORT_RE = [
	/\bfrom\s+["']([^"']+)["']/g,
	/\bimport\s*\(\s*["']([^"']+)["']/g,
	/\bimport\s+["']([^"']+)["']/g,
	/\brequire\s*\(\s*["']([^"']+)["']/g,
];

function packageName(spec) {
	if (spec.startsWith("node:")) return null;
	const parts = spec.split("/");
	return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** keepRoots 에서 상대 import 를 따라가 닿은 파일과 외부 패키지 이름을 모은다. */
export function keepClosure(root, roots) {
	const files = new Set();
	const packages = new Set();
	const queue = roots.map((p) => normalize(p));
	const candidates = (base) => [
		base,
		...[".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs"].map((e) => base + e),
		...[".ts", ".tsx", ".js"].map((e) => join(base, `index${e}`)),
		base.replace(/\.js$/, ".ts"),
		base.replace(/\.js$/, ".tsx"),
	];
	while (queue.length) {
		const rel = queue.shift();
		if (files.has(rel)) continue;
		const abs = join(root, rel);
		if (!existsSync(abs) || !statSync(abs).isFile()) continue;
		files.add(rel);
		const text = readFileSync(abs, "utf8");
		for (const re of IMPORT_RE) {
			for (const m of text.matchAll(re)) {
				const spec = m[1];
				if (spec.startsWith(".")) {
					const target = candidates(normalize(join(dirname(rel), spec))).find((c) => {
						const a = join(root, c);
						return existsSync(a) && statSync(a).isFile();
					});
					if (target) queue.push(target);
				} else {
					const name = packageName(spec);
					if (name) packages.add(name);
				}
			}
		}
	}
	return { files, packages };
}

function compileTerms(terms) {
	return terms.flatMap((t) =>
		(t.variants === false ? [t.term] : nameVariants(t.term)).map((v) => ({
			...t,
			text: v,
			re: new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), t.caseSensitive ? "g" : "gi"),
		})),
	);
}

function allowReason(rules, repo, path, term, line) {
	for (const r of rules) {
		if (r.repo && r.repo !== repo) continue;
		if (r.paths && !matchesAny(path, r.paths)) continue;
		if (r.terms && !r.terms.includes(term.term)) continue;
		if (r.lineContains && !r.lineContains.some((s) => line.includes(s))) continue;
		return r.reason;
	}
	return null;
}

/** 줄 안에서 남길 패키지 이름이 차지하는 구간을 가린다. 그 구간의 적중은 남김이다. */
function maskKeptPackages(line, packages) {
	let masked = line;
	for (const name of packages) {
		if (!name || !masked.includes(name)) continue;
		masked = masked.split(name).join(" ".repeat(name.length));
	}
	return masked;
}

export function scan({ config, repos }) {
	const terms = compileTerms(config.terms);
	const hits = [];
	const missing = [];
	// 지원 경로 의존성은 저장소를 가로질러 쓰인다(에이전트 패키지를 셸 빌드 설정이 감싼다). 모두 모은 뒤 검사한다.
	const packages = new Set();
	for (const [repo, root] of Object.entries(repos)) {
		const repoCfg = config.repos?.[repo];
		if (!repoCfg) continue;
		for (const name of keepClosure(root, repoCfg.keepRoots ?? []).packages) packages.add(name);
	}
	const keptPackages = [...packages].filter((p) =>
		terms.some((t) => p.toLowerCase().includes(t.text.toLowerCase())),
	);
	for (const [repo, root] of Object.entries(repos)) {
		const repoCfg = config.repos?.[repo];
		if (!repoCfg) continue;
		for (const rel of listFiles(root, repoCfg.include, repoCfg.exclude)) {
			const abs = join(root, rel);
			if (statSync(abs).size > MAX_BYTES) continue;
			const lines = readFileSync(abs, "utf8").split(/\r?\n/);
			lines.forEach((line, index) => {
				const masked = maskKeptPackages(line, keptPackages);
				const seen = new Set();
				for (const t of terms) {
					t.re.lastIndex = 0;
					const rawHit = t.re.test(line);
					t.re.lastIndex = 0;
					if (!rawHit || seen.has(t.term)) continue;
					seen.add(t.term);
					const maskedHit = t.re.test(masked);
					t.re.lastIndex = 0;
					const reason = !maskedHit
						? "지원 경로 의존성"
						: allowReason(config.allow ?? [], repo, rel, t, line);
					hits.push({
						repo,
						file: rel,
						line: index + 1,
						term: t.term,
						bundle: t.bundle,
						status: reason ? "keep" : "trace",
						...(reason ? { reason } : {}),
					});
				}
			});
		}
		for (const path of repoCfg.mustExist ?? []) {
			if (!existsSync(join(root, path))) missing.push({ repo, path });
		}
	}
	return { hits, missing };
}

function parseArgs(argv) {
	const out = { config: DEFAULT_CONFIG, repos: {}, strict: null, json: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--config") out.config = resolve(argv[++i]);
		else if (a === "--repo") {
			const [name, path] = argv[++i].split("=");
			out.repos[name] = resolve(path);
		} else if (a === "--strict") out.strict = argv[++i].split(",").map((s) => s.trim());
		else if (a === "--json") out.json = true;
		else throw new Error(`unknown argument: ${a}`);
	}
	return out;
}

export function summarize(result, strict) {
	const traces = result.hits.filter((h) => h.status === "trace");
	const blocking = strict ? traces.filter((h) => strict.includes(String(h.bundle))) : [];
	const failed = Boolean(strict) && (blocking.length > 0 || result.missing.length > 0);
	return { traces, blocking, failed };
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const config = JSON.parse(readFileSync(args.config, "utf8"));
	if (!Object.keys(args.repos).length) args.repos.shell = resolve(HERE, "..");
	const result = scan({ config, repos: args.repos });
	const { traces, blocking, failed } = summarize(result, args.strict);
	if (args.json) {
		process.stdout.write(`${JSON.stringify({ ...result, failed }, null, 2)}\n`);
	} else {
		const byTerm = new Map();
		for (const h of traces) byTerm.set(`${h.bundle}\t${h.term}`, (byTerm.get(`${h.bundle}\t${h.term}`) ?? 0) + 1);
		console.log(`흔적 ${traces.length}건, 남김 ${result.hits.length - traces.length}건, 사라진 남김 파일 ${result.missing.length}건`);
		for (const [key, n] of [...byTerm].sort()) {
			const [bundle, term] = key.split("\t");
			console.log(`  묶음 ${bundle}  ${term}  ${n}건`);
		}
		for (const m of result.missing) console.log(`  ✗ 남길 파일 없음: ${m.repo}:${m.path}`);
		if (args.strict) {
			for (const h of blocking.slice(0, 50)) console.log(`  ✗ ${h.repo}:${h.file}:${h.line} ${h.term}`);
			console.log(failed ? `엄격 모드 실패(묶음 ${args.strict.join(",")})` : "엄격 모드 통과");
		}
	}
	process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
