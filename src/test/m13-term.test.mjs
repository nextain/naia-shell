#!/usr/bin/env node
/** M13-term — 용어 게이트(checkTerminology): 금지 신조어 + glossary 미정의 약어. */
import { checkTerminology } from "../../.agents/hooks/lib/self-trust-core.mjs";

const cfg = {
	terminology: {
		acronym_min_len: 3,
		acronym_whitelist: ["API", "JSON", "CLI"],
		forbidden_terms: ["콘텍스트게이팅", "자가신뢰화"],
	},
};
const GLOSSARY = "# 용어집\n- SDLC: 소프트웨어 개발 생명주기\n- RBAC: 역할 기반 접근 제어\n";

let pass = 0, fail = 0;
const check = (n, c) => { console.log(`${c ? "✅ PASS" : "❌ FAIL"} — ${n}`); c ? pass++ : fail++; };

// 금지 신조어
check("금지 신조어('콘텍스트게이팅') → forbidden 검출", checkTerminology("이건 콘텍스트게이팅 기법이다", GLOSSARY, cfg).forbidden.length === 1);
check("금지 신조어 없음 → forbidden 0", checkTerminology("일반 문장입니다", GLOSSARY, cfg).forbidden.length === 0);

// glossary 미정의 약어
check("glossary 정의 약어(SDLC, RBAC) → 경고 없음", checkTerminology("SDLC와 RBAC를 따른다", GLOSSARY, cfg).undefinedAcronyms.length === 0);
check("glossary 미정의 약어(XYZ) → 경고", checkTerminology("XYZ 프로토콜을 쓴다", GLOSSARY, cfg).undefinedAcronyms.includes("XYZ"));
check("whitelist 약어(API, JSON, CLI) → 경고 제외", checkTerminology("API가 JSON을 CLI로 반환", GLOSSARY, cfg).undefinedAcronyms.length === 0);
check("2자 약어는 min_len(3) 미만 → 검사 제외", checkTerminology("OS와 UI", GLOSSARY, cfg).undefinedAcronyms.length === 0);
check("미정의 약어 중복 제거", (() => { const r = checkTerminology("ABC ABC ABC", GLOSSARY, cfg); return r.undefinedAcronyms.filter((x) => x === "ABC").length === 1; })());

console.log(`\n결과: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
