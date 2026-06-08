#!/usr/bin/env node
/**
 * gen-lists — `.agents/<kind>/` (SoT) 에서 `.users/<kind>-list.md` (사람용 단일 색인)를 결정론 생성.
 *   kind ∈ { skills, hooks, commands, workflows }.
 *
 * ⚠️ 모델: 각 kind 는 `.agents/<kind>/` 가 SoT. 사람용은 **색인 한 장**(<kind>-list.md).
 *   `.users/<kind>/<name>/...` 처럼 per-item 복사·번역은 하지 않는다 (중복·drift 원인).
 *
 * 사용:
 *   node scripts/gen-lists.mjs [kind...]          # 지정 kind 생성 (기본 4종 전부)
 *   node scripts/gen-lists.mjs --check [kind...]   # 최신인지만 (exit 1=갱신 필요), 쓰지 않음
 * env: LISTS_PROJECT_ROOT (기본 cwd)
 * ESM.
 */
import fs from "fs";
import path from "path";

const ROOT = process.env.LISTS_PROJECT_ROOT || process.cwd();
const KINDS = ["skills", "hooks", "commands", "workflows"];
const TITLE = { skills: "Skills", hooks: "Hooks", commands: "Commands", workflows: "Workflows" };

function frontmatter(txt) {
	const m = txt.match(/^---\n([\s\S]*?)\n---/);
	if (!m) return {};
	const o = {};
	for (const line of m[1].split("\n")) {
		const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
		if (kv) o[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
	}
	return o;
}

// best-effort 한 줄 설명: frontmatter description → JSDoc 첫 줄 → md 제목/다음줄 → 첫 의미 줄.
function extractDesc(txt) {
	const fm = frontmatter(txt);
	if (fm.description) return fm.description;
	const js = txt.match(/\/\*\*\s*\n\s*\*\s*(.+?)\s*\n/);        // /** \n * <첫 줄>
	if (js && js[1]) return js[1].replace(/^[-*]\s*/, "");
	const md = txt.match(/^#\s+(.+)$/m);
	if (md) {
		const after = txt.slice(txt.indexOf(md[0]) + md[0].length).match(/\n+([^\n#>].+)/);
		return after ? after[1].trim() : md[1].trim();
	}
	const yc = txt.match(/^#\s*(.+)$/m) || txt.match(/^name:\s*(.+)$/m) || txt.match(/^(\S.+)$/m);
	return yc ? yc[1].trim() : "";
}

const cell = (s) => String(s || "").replace(/\|/g, "\\|").replace(/\n+/g, " ").slice(0, 160).trim();

export function buildList(kind, root = ROOT) {
	const dir = path.join(root, ".agents", kind);
	const rows = [];
	if (fs.existsSync(dir)) {
		for (const name of fs.readdirSync(dir).sort()) {
			if (name === "lib" || name === "atoms" || name === "SKILL_TEMPLATE.md") continue;
			const full = path.join(dir, name);
			let file, label, txt;
			if (fs.statSync(full).isDirectory()) {                  // skills 처럼 <name>/SKILL.md
				const inner = path.join(full, "SKILL.md");
				if (!fs.existsSync(inner)) continue;
				file = `.agents/${kind}/${name}/SKILL.md`; label = name; txt = fs.readFileSync(inner, "utf8");
			} else {
				if (!/\.(md|mjs|js|ya?ml)$/.test(name) || name === "README.md") continue;
				file = `.agents/${kind}/${name}`; label = name.replace(/\.(md|mjs|js|ya?ml)$/, ""); txt = fs.readFileSync(full, "utf8");
			}
			const fm = frontmatter(txt);
			rows.push({ name: fm.name || label, file, desc: extractDesc(txt) });
		}
	}
	const header = `# ${TITLE[kind] || kind} 목록

> **SoT**: \`.agents/${kind}/\`. 이 파일은 **사람용 단일 색인**이다.
> ⚠️ per-item 복사(\`.users/${kind}/...\`)는 하지 않는다 — 이 색인 한 장만 둔다.
> 갱신: \`node scripts/gen-lists.mjs ${kind}\` (결정론 생성).

| 이름 | 파일 | 설명 |
|------|------|------|
`;
	const body = rows.length
		? rows.map((r) => `| ${cell(r.name)} | \`${r.file}\` | ${cell(r.desc)} |`).join("\n")
		: `| _(등록된 ${kind} 없음)_ | — | — |`;
	return header + body + "\n";
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith("gen-lists.mjs");
if (isMain) {
	const args = process.argv.slice(2);
	const check = args.includes("--check");
	const kinds = args.filter((a) => KINDS.includes(a));
	const targets = kinds.length ? kinds : KINDS;
	let stale = 0;
	for (const kind of targets) {
		const out = path.join(ROOT, ".users", `${kind}-list.md`);
		const content = buildList(kind);
		const cur = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : null;
		if (check) {
			if (cur !== content) { stale++; console.log(`[lists] ${kind}: 갱신 필요`); }
			else console.log(`[lists] ${kind}: 최신`);
		} else {
			fs.mkdirSync(path.dirname(out), { recursive: true });
			fs.writeFileSync(out, content);
			const n = (content.match(/^\| (?!_|이름|---)/gm) || []).length;
			console.log(`[lists] ${kind}: 생성 → .users/${kind}-list.md (${n}개)`);
		}
	}
	process.exit(check && stale ? 1 : 0);
}
