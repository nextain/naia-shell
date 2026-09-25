/**
 * 게이트가 읽지 않기로 한 문법 형태가 저장소에 들어오지 못하게 막는다.
 *
 * 왜 필요한가: 정적 게이트는 "같은 뜻을 다르게 적기" 의 꼬리를 원리상 다 읽을
 * 수 없다. 뜻이 같고 적는 법이 다른 형태는 문법이 허용하는 만큼 있고, 열네
 * 번의 교차 리뷰가 그것을 하나씩 가져왔다 — `void 0`, 쉼표식, 대괄호 키,
 * 겹쳐 쌓은 `void`. 하나를 닫으면 다음 회차에 하나가 더 왔다.
 *
 * 그래서 오너가 경계를 옮겼다(2026-09-06): 그런 형태는 **저장소에 들어오지
 * 못한다.** 게이트의 "보증 밖" 절이 구멍이 아니라 경계가 되려면, 그 밖을
 * 막는 것이 있어야 한다. 이 파일이 그 자리다.
 *
 * 무엇을 막는가: `scripts/lib/lint-boundary-forms.mjs` 의 목록 그대로다. 이
 * 파일에 형태를 적지 않는다 — 목록이 두 벌이면 한쪽만 늘고 다른 쪽이 낡는다.
 *
 * 어떻게 막는가: 두 갈래다.
 *
 *   - biome 규칙으로 표현되는 형태는 **biome 이 판정한다**(`--only=<규칙>`).
 *     우리가 그 형태를 다시 구현하지 않는다.
 *   - biome 에 그만큼 좁은 규칙이 없는 형태만 TypeScript 파서로 센다. 넓은
 *     규칙을 켜면 정당한 관용구까지 잡혀 예외 목록이 커지고, 예외 목록이
 *     커지면 아무도 읽지 않는다 — 그 이유는 정본 파일에 적어 두었다.
 *
 * 무엇을 보증하지 않는가: 이것은 **형태**를 막는 것이지 뜻을 막는 것이
 * 아니다. 같은 난독화를 아직 목록에 없는 문법으로 적으면 여기서 통과한다.
 * 그때는 목록에 형태를 더하는 것이 답이고, 게이트를 넓히는 것이 아니다.
 *
 * 기준선 숫자가 없다. 지금 저장소에 위반이 0자리라서, 하나라도 생기면 붉어진다.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import {
	LINT_BOUNDARY_DETECTORS,
	LINT_BOUNDARY_EXCEPTIONS,
	LINT_BOUNDARY_EXTENSIONS,
	LINT_BOUNDARY_FORMS,
	LINT_BOUNDARY_SCOPE,
} from "./lib/lint-boundary-forms.mjs";

/** 이 저장소에 설치된 biome. 없으면 고정 버전을 내려받아 쓴다. */
const BIOME_VERSION = "1.9.4";
const BIOME_CANDIDATES = [
	"packages/shell/node_modules/.bin/biome",
	"node_modules/.bin/biome",
];

/**
 * 패키지의 JS 진입점. `.bin/biome` 은 sh 스크립트라 Windows 에서 execFileSync 가
 * 띄우지 못한다(ENOENT) — 그래서 Windows 로컬에서는 이 게이트가 늘 붉었다.
 * 진입점을 node 로 띄우면 두 운영체제에서 같다.
 */
const BIOME_ENTRIES = [
	"packages/shell/node_modules/@biomejs/biome/bin/biome",
	"node_modules/@biomejs/biome/bin/biome",
];

function biomeCommand() {
	for (const path of BIOME_ENTRIES) if (existsSync(path)) return [process.execPath, [path]];
	for (const path of BIOME_CANDIDATES) if (existsSync(path)) return [path, []];
	// 설치를 바꾸는 것은 사람의 몫이다. 게이트는 고정 버전을 그때그때 쓴다.
	return ["npx", ["--yes", `@biomejs/biome@${BIOME_VERSION}`]];
}

function tracked() {
	const out = [];
	for (const dir of LINT_BOUNDARY_SCOPE) {
		let listed = "";
		try {
			listed = execFileSync("git", ["ls-files", "--", dir], { encoding: "utf8" });
		} catch {
			continue;
		}
		for (const file of listed.split("\n")) {
			if (!file) continue;
			if (!LINT_BOUNDARY_EXTENSIONS.some((ext) => file.endsWith(ext))) continue;
			out.push(file);
		}
	}
	return out;
}

const files = tracked();

/* ─────────────── biome 이 판정하는 형태 ─────────────── */

/** 한 번에 넘기는 파일 수. Windows 명령줄은 32K 자에서 끊긴다. */
const BIOME_CHUNK = 200;

function biomeHits(rule) {
	const [bin, lead] = biomeCommand();
	let output = "";
	for (let start = 0; start < files.length; start += BIOME_CHUNK) {
		const chunk = files.slice(start, start + BIOME_CHUNK);
		try {
			output += execFileSync(
				bin,
				[...lead, "lint", `--only=${rule}`, "--reporter=github", "--max-diagnostics=1000", ...chunk],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
			);
		} catch (err) {
			// biome 은 진단이 있으면 0 이 아닌 코드로 끝난다. 출력은 그대로 쓴다.
			const got = `${err.stdout ?? ""}${err.stderr ?? ""}`;
			if (!got) {
				console.error(`  ⚠ biome 을 돌리지 못했다(${rule}): ${err.message}`);
				return null;
			}
			output += got;
		}
	}
	const cwd = `${process.cwd().replace(/\\/g, "/")}/`;
	const hits = [];
	for (const line of output.split("\n")) {
		const m = /^::(?:error|warning) title=lint\/([^,]+),file=([^,]+),line=(\d+)/.exec(line);
		if (!m) continue;
		if (m[1] !== rule) continue;
		hits.push({ file: m[2].replace(/\\/g, "/").replace(cwd, ""), line: Number(m[3]) });
	}
	return hits;
}

/* ─────────────── 파서가 세는 형태 ─────────────── */

// 형태의 **정의**는 정본(`scripts/lib/lint-boundary-forms.mjs`)에 있다. 여기에
// 다시 적으면 목록이 두 벌이 되고, 한쪽만 고쳐진 자리로 결함이 들어온다.

function parse(file, text) {
	return ts.createSourceFile(
		file,
		text,
		ts.ScriptTarget.Latest,
		true,
		/\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
}



function parserHits(names) {
	const found = new Map(names.map((name) => [name, []]));
	if (names.length === 0) return found;
	for (const file of files) {
		let text = "";
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		// 값싼 선별. 어느 형태의 글자도 없는 파일은 파싱하지 않는다.
		if (!/void|\[/.test(text)) continue;
		const tree = parse(file, text);
		const visit = (node) => {
			for (const name of names) {
				if (LINT_BOUNDARY_DETECTORS[name](node))
					found.get(name).push({
						file,
						line: text.slice(0, node.getStart(tree)).split("\n").length,
						text: node.getText(tree).slice(0, 48).replace(/\s+/g, " "),
					});
			}
			ts.forEachChild(node, visit);
		};
		visit(tree);
	}
	return found;
}

/* ─────────────── 판정 ─────────────── */

const excepted = new Set(
	LINT_BOUNDARY_EXCEPTIONS.map((hit) => `${hit.file}::${hit.form}`),
);
const usedExceptions = new Set();
const violations = [];
let unavailable = false;

const parserNames = LINT_BOUNDARY_FORMS.filter((f) => f.detector).map((f) => f.detector);
const parserFound = parserHits(parserNames);

for (const form of LINT_BOUNDARY_FORMS) {
	const hits = form.biome ? biomeHits(form.biome) : parserFound.get(form.detector);
	if (hits === null) {
		unavailable = true;
		continue;
	}
	for (const hit of hits) {
		const key = `${hit.file}::${form.id}`;
		if (excepted.has(key)) {
			usedExceptions.add(key);
			continue;
		}
		violations.push({ ...hit, form });
	}
}

console.log(
	`[lint-boundary] 금지 형태 ${LINT_BOUNDARY_FORMS.length}종 / 검사한 파일 ${files.length}개 / 위반 ${violations.length}곳`,
);

if (unavailable) {
	console.error(
		"❌ biome 을 돌리지 못했다. 이 게이트는 린터 없이는 경계를 보증하지 못한다.",
	);
	process.exit(1);
}

const stale = LINT_BOUNDARY_EXCEPTIONS.filter(
	(hit) => !usedExceptions.has(`${hit.file}::${hit.form}`),
);
if (stale.length > 0) {
	console.error("\n❌ 걸리지 않게 된 예외가 있다(알리바이):");
	for (const hit of stale) console.error(`  ${hit.file} — ${hit.form}`);
	console.error("  그 자리가 사라졌으면 예외도 지워라.");
	process.exit(1);
}

if (violations.length === 0) {
	console.log("  ✓ 게이트가 읽지 않기로 한 형태가 저장소에 없다");
	process.exit(0);
}

console.error("\n❌ 게이트가 읽지 않기로 한 형태가 들어왔다:");
const byForm = new Map();
for (const hit of violations) {
	if (!byForm.has(hit.form.id)) byForm.set(hit.form.id, []);
	byForm.get(hit.form.id).push(hit);
}
for (const [id, hits] of byForm) {
	const form = LINT_BOUNDARY_FORMS.find((f) => f.id === id);
	console.error(`\n  ${id} — ${form.title}`);
	console.error(`    왜: ${form.why}`);
	console.error(`    대신: ${form.instead}`);
	for (const hit of hits.slice(0, 12))
		console.error(`    ${hit.file}:${hit.line}${hit.text ? ` — ${hit.text}` : ""}`);
	if (hits.length > 12) console.error(`    … 그 밖 ${hits.length - 12}곳`);
}
console.error(
	"\n이 형태들은 게이트가 읽지 않기로 선언한 자리다. 고치거나, 정말 필요하면",
);
console.error(
	"scripts/lib/lint-boundary-forms.mjs 의 예외 목록에 파일·형태·이유를 함께 적어라.",
);
process.exit(1);
