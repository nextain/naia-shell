/**
 * self-trust 게이트 공통 코어.
 *
 * 목적: 로컬 hook과 원격 CI 스크립트가 **동일 판정 로직**을 공유한다(중복 제거 → 로컬↔CI 불일치 제거).
 *       모든 정책(완료 키워드·변경 규칙·산출물·강도)은 agents-rules.json `self_trust_config`에서 로드한다
 *       (언어·경로·파일명 하드코딩 제거 = 과적합 완화).
 *
 * 비판 반영: C1(경로 외부화)·C3(다국어 키워드·부정문)·C4(NFC 정규화)·도구일관(로컬=CI).
 * ESM (naia-adk type:module).
 */
import fs from "fs";
import path from "path";

const DEFAULTS = {
	enforcement_level: "enforced",
	completion: { keywords: [], negations: [], evidence_patterns: [], strong_evidence_patterns: [] },
	change_set_rules: [],
	artifact_min_meaningful_chars: 100,
};

export function loadConfig(root) {
	const rules = JSON.parse(fs.readFileSync(path.join(root, ".agents/context/agents-rules.json"), "utf8"));
	const c = { ...DEFAULTS, ...(rules.self_trust_config || {}) };
	return {
		level: c.enforcement_level || "enforced",
		completion: { ...DEFAULTS.completion, ...(c.completion || {}) },
		changeSetRules: c.change_set_rules || [],
		minChars: c.artifact_min_meaningful_chars ?? 100,
		F12: new Set(rules?.F12?.allowed_root_dirs || []),
		F13: new Set(rules?.F13?.allowed_root_files || []),
		charterFiles: new Set(rules?.charter_immutability?.charter_files || []),
		terminology: c.terminology || {},
	};
}

// 용어 게이트(M13-term): glossary 미정의 약어(불친절한 약자) + 금지 신조어(forbidden_terms) 탐지.
// 한계(정직): "신조어 자동 판별"은 불가 — forbidden 블랙리스트 + glossary 미정의 약어 경고까지만.
export function checkTerminology(text, glossaryText, cfg) {
	const t = cfg.terminology || {};
	const minLen = t.acronym_min_len || 3;
	const whitelist = new Set((t.acronym_whitelist || []).map((s) => s.toUpperCase()));
	const glossary = String(glossaryText || "");
	const body = String(text || "");

	const forbidden = (t.forbidden_terms || []).filter((term) => body.includes(term));

	const re = new RegExp(`\\b[A-Z][A-Z0-9]{${minLen - 1},}\\b`, "g");
	const undefinedAcronyms = [];
	const seen = new Set();
	let m;
	while ((m = re.exec(body)) !== null) {
		const a = m[0];
		if (whitelist.has(a) || seen.has(a)) continue;
		seen.add(a);
		if (!new RegExp(`\\b${a}\\b`).test(glossary)) undefinedAcronyms.push(a);
	}
	return { forbidden, undefinedAcronyms };
}

function pathExists(p) {
	try {
		fs.lstatSync(p);
		return true;
	} catch {
		return false;
	}
}
// 존재하는 최장 조상을 realpath로 해소(symlink 우회 차단), 나머지 세그먼트는 그대로 append.
// gemini 지적: 보호 경로를 symlink로 가리켜 정규식 필터를 우회하는 것을 막는다.
function realResolve(abs) {
	let p = abs;
	const tail = [];
	while (!pathExists(p) && path.dirname(p) !== p) {
		tail.unshift(path.basename(p));
		p = path.dirname(p);
	}
	try {
		p = fs.realpathSync(p);
	} catch {
		/* best-effort */
	}
	return tail.length ? path.join(p, ...tail) : p;
}

// 경로를 루트 기준 상대경로로 정규화 (NFC + 슬래시 통일 + symlink realpath 해소)
export function normalizeRel(fp, root) {
	const norm = String(fp).normalize("NFC");
	const abs = realResolve(path.resolve(root, norm));
	let rootReal = root;
	try {
		rootReal = fs.realpathSync(root);
	} catch {
		/* best-effort */
	}
	return path.relative(rootReal, abs).replace(/\\/g, "/");
}

function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 키워드 매칭: ASCII는 단어경계(\b), CJK/한글 등 비-ASCII는 부분일치(\b가 작동 안 하므로)
function keywordHit(text, kw) {
	const k = kw.normalize("NFC");
	if (/^[\x00-\x7F]+$/.test(k)) return new RegExp(`\\b${escapeRe(k)}\\b`, "i").test(text);
	return text.includes(k);
}

// 완료선언 + 증거 판정
export function checkCompletion(message, cfg, opts = {}) {
	if (cfg.level === "off") return { ok: true, reason: "off" };
	const m = String(message || "").normalize("NFC");
	const negated = (cfg.completion.negations || []).some((n) => keywordHit(m, n));
	const completed = (cfg.completion.keywords || []).some((k) => keywordHit(m, k));
	if (!completed || negated) return { ok: true, reason: negated ? "부정문(미완료)" : "완료선언 아님" };
	// 증거 등급: 강(존재 검증된 아티팩트 인용) > 약(키워드만) > 없음.
	// ⚠️ 적대검증(gemini, 2026-05-30) 교훈: 'review-pass: CLEAN' 텍스트는 위조 가능 →
	//   strong 은 인용된 **검증 리포트 파일이 실제 존재**해야 인정(opts.fileExists 주입 시).
	//   텍스트가 아닌 상호참조 아티팩트라야 위조가 어렵다. (내용/commit_hash 대조는 CI 몫.)
	const ml = m.toLowerCase();
	const hasStrong = (cfg.completion.strong_evidence_patterns || []).some((p) => ml.includes(p.toLowerCase()));
	const hasWeak = (cfg.completion.evidence_patterns || []).some((p) => ml.includes(p.toLowerCase()));
	if (hasStrong) {
		if (typeof opts.fileExists === "function") {
			const refs = extractEvidenceRefs(m);
			if (refs.some((r) => opts.fileExists(r))) return { ok: true, reason: "강한 증거(검증 아티팩트 존재 확인)", tier: "strong" };
			// 인용은 했으나 파일 부재 = 위조 의심 → 약한 증거로 강등
			return { ok: true, reason: "검증 인용했으나 아티팩트 부재 — 약한 증거로 강등", tier: "weak", note: "cited-ref-missing" };
		}
		return { ok: true, reason: "강한 증거(참조 인용)", tier: "strong" };
	}
	if (hasWeak) return { ok: true, reason: "약한 증거(키워드만) — 재실행 가능 검증 인용 권고", tier: "weak" };
	return { ok: false, reason: "완료선언 + 증거없음", tier: "none" };
}

// 완료 메시지에서 검증 아티팩트 경로 후보 추출 (.agents/reviews/.. , *.json/md/txt/log 경로).
export function extractEvidenceRefs(message) {
	const m = String(message || "");
	const refs = new Set();
	for (const x of m.match(/[\w./\-]+\.(?:json|md|txt|log)\b/g) || []) refs.add(x);
	for (const x of m.match(/\.agents\/reviews\/[\w./\-]+/g) || []) refs.add(x);
	return [...refs];
}

// 글롭(**, *, {a,b}) → 정규식
function globToRe(glob) {
	const g = glob.normalize("NFC");
	let re = "";
	for (let i = 0; i < g.length; i++) {
		const ch = g[i];
		if (ch === "*") {
			if (g[i + 1] === "*") {
				// **/ = 0개 이상 디렉터리(0개 포함, 표준 minimatch). ** 단독(끝/중간) = 모든 문자.
				if (g[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } // **/  (뒤 / 까지 소비)
				else { re += ".*"; i++; } // **
			} else re += "[^/]*"; // *
		} else if (ch === "{") {
			const end = g.indexOf("}", i);
			if (end > i) { re += "(" + g.slice(i + 1, end).split(",").map(escapeRe).join("|") + ")"; i = end; }
			else re += "\\{";
		} else {
			re += escapeRe(ch);
		}
	}
	return new RegExp("^" + re + "$");
}
function matchAny(file, globs) {
	const f = file.normalize("NFC");
	return (globs || []).some((g) => globToRe(g).test(f));
}

// 산출물이 의미있게 작성됐는가 (템플릿 placeholder/주석 제거 후 minChars 이상)
export function meaningful(absPath, minChars) {
	try {
		const raw = fs.readFileSync(absPath, "utf8");
		const stripped = raw.replace(/\{\{[^}]*\}\}/g, "").replace(/<!--[\s\S]*?-->/g, "").trim();
		return stripped.length >= minChars;
	} catch {
		return false;
	}
}

// SDLC: 변경파일이 change_set_rule을 트리거하면 산출물 충족 여부 판정
export function checkSdlc(changedFiles, root, cfg) {
	if (cfg.level === "off") return { status: "off" };
	const files = changedFiles.map((f) => normalizeRel(f, root));
	for (const rule of cfg.changeSetRules) {
		const triggered = files.some((f) => matchAny(f, rule.when_changed_glob) && !matchAny(f, rule.exempt_glob));
		if (!triggered) continue;
		const reqs = (rule.requires || []).map((r) => ({ r, ok: meaningful(path.join(root, r), cfg.minChars) }));
		const present = reqs.filter((x) => x.ok).length;
		if (present === 0) return { status: "bootstrap", rule: rule.id, reqs };
		if (present === reqs.length) return { status: "ok", rule: rule.id };
		return { status: "violation", rule: rule.id, reqs };
	}
	return { status: "n/a" };
}

// 구조: 변경파일 중 미등록 루트 경로(F12 디렉토리/F13 파일)
export function checkStructure(changedFiles, root, cfg) {
	const violations = [];
	for (const f of changedFiles) {
		const rel = normalizeRel(f, root);
		if (rel === "" || rel === ".." || rel.startsWith("../")) continue;
		const segs = rel.split("/").filter(Boolean);
		if (segs.length === 1) {
			if (!cfg.F13.has(segs[0])) violations.push({ file: f, kind: "root-file", name: segs[0] });
		} else if (!cfg.F12.has(segs[0])) {
			violations.push({ file: f, kind: "root-dir", name: segs[0] });
		}
	}
	return violations;
}

function charterMatch(rel, cfg) {
	if (cfg.charterFiles.has(rel)) return true;
	// hook/설정/CI워크플로우 자체도 보호 (AI가 하네스를 무력화하지 못하게)
	return /^\.agents\/hooks\//.test(rel) || rel === ".claude/settings.json" || /^\.github\/workflows\//.test(rel);
}

// charter 파일(헌장)인지 — AI 단독 수정 금지 대상
export function isCharterFile(fp, root, cfg) {
	// 정방향 우회(비보호→보호 symlink) + 역방향 우회(보호경로 자체를 비보호 symlink로) 둘 다 차단(codex 라운드6):
	// realpath 해소 경로와 논리(repo) 경로를 둘 다 검사해, 둘 중 하나라도 보호 대상이면 차단한다.
	const realRel = normalizeRel(fp, root);
	const logicalRel = path
		.relative(root, path.resolve(root, String(fp).normalize("NFC")))
		.replace(/\\/g, "/");
	return charterMatch(realRel, cfg) || charterMatch(logicalRel, cfg);
}
