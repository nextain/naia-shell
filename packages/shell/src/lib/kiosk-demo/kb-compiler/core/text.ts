/** @spec SPEC-004/007 — 텍스트 정규화·토큰·매칭 (어댑터 비의존, 결정론).
 * 리뷰 반영(F1/F2): 숫자/단위 토큰은 정확 일치(1300원 ⊉ 300원), 한국어는 조사 stem + 양방향 부분일치(신분증이 = 신분증).
 */

export function normalize(s: string): string {
  return (s ?? "").normalize("NFC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** 의미 토큰(길이 ≥2, 공백·구두점 분리). */
export function tokens(s: string): string[] {
  return (s ?? "")
    .normalize("NFC")
    .toLowerCase()
    .split(/[\s\p{P}\p{S}]+/u)
    .filter((t) => t.length >= 2);
}

// 흔한 한국어 조사(어미는 미포함 — MVP). 끝에서 1회 제거.
const JOSA = /(으로서|으로써|에서는|에게서|에서|께서|이라고|라고|이라는|라는|입니다|이다|으로|은|는|이|가|을|를|에|의|와|과|도|로|만|께|한테|에게|까지|부터|보다|처럼|마다|이나|나)$/;

/** 숫자 포함 토큰은 변형 안 함(정확 매칭 대상). 그 외 조사 1회 절단. */
export function stem(t: string): string {
  if (/\d/.test(t)) return t;
  const m = t.match(JOSA);
  if (m && t.length - m[0].length >= 2) return t.slice(0, t.length - m[0].length);
  return t;
}

/** Conversational fillers that must not gate grounded answers.
 *  Product questions like "회사 이름이 뭐야?" still have to match compiled cards. */
const QUESTION_FILLERS = new Set([
  "뭐야", "뭐예요", "뭐에요", "무엇인가", "무엇인가요", "뭔가요", "뭔데", "뭐가", "뭐",
  "알려줘", "알려주세요", "인가요", "일까", "일까요",
  "어디", "어디야", "어디예요", "어디에요",
  "언제야", "언제",
  "누구", "누구야", "누구지", "누구예요", "누구에요",
  "어때", "어떻게",
  "있어", "있나요", "있습니까", "있니", "있나",
  "얼마", "얼마야", "얼마예요", "얼마에요", "얼마나", "얼마죠",
  "뭐였지", "뭐지", "뭐죠", "뭐였어", "왜",
  "what", "whats", "who", "where", "when", "how", "please", "tell",
  "the", "is", "are", "a", "an", "does", "do", "of", "in",
]);

export function tokenMatch(needle: string, hayTokens: string[], otherStems?: Set<string>): boolean {
  if (/\d/.test(needle)) {
    // 숫자/단위: 정확 일치만 (1300원이 300원을 포함으로 오탐 방지)
    return hayTokens.includes(needle);
  }
  const ns = stem(needle);
  if (ns.length < 2) return hayTokens.includes(needle);
  return hayTokens.some((h) => {
    const hs = stem(h);
    if (hs === ns || hs.includes(ns) || ns.includes(hs)) return true; // 붙여쓰기 양방향 부분일치
    if (ns === "이름" && otherStems && otherStems.size > 0) {
      const target = hs.endsWith("명") ? hs : (h.endsWith("명") ? h : "");
      if (target.endsWith("명") && target.length >= 3) {
        const prefix = target.slice(0, -1);
        if (otherStems.has(prefix) || otherStems.has(stem(prefix))) {
          return true;
        }
      }
    }
    return false;
  });
}

/** 제목의 내용 토큰이 모두 질의 needle 토큰에 적중하는지 판정(라벨 제목). */
export function isLabelHeading(headingLine: string, query: string): boolean {
  if (!/^#{1,6}\s/.test(headingLine)) return false;
  const headingText = headingLine.replace(/^#{1,6}\s+/, "");
  const rawHToks = tokens(headingText);
  const hToks = rawHToks.filter((t) => {
    const s = stem(t);
    return !QUESTION_FILLERS.has(t) && !QUESTION_FILLERS.has(s);
  });
  const headingContentToks = hToks.length > 0 ? hToks : rawHToks;
  if (headingContentToks.length === 0) return false;

  const nq = contentQuery(query);
  const needleToks = tokens(nq);
  if (needleToks.length === 0) return false;

  const needleStems = needleToks.map(stem);
  const otherStems = new Set(needleStems.filter((s) => s !== "이름"));

  return headingContentToks.every((ht) => {
    const hts = stem(ht);
    if (hts.endsWith("명") && hts.length >= 3) {
      if (needleStems.includes(hts)) return true;
      const prefix = hts.slice(0, -1);
      return needleStems.includes("이름") && (otherStems.has(prefix) || otherStems.has(stem(prefix)));
    }
    return tokenMatch(ht, needleToks, otherStems);
  });
}

/** haystack 안에 needle 토큰이 몇 개 들어있나. coverage와 동일한 tokenMatch 규칙. */
export function matchedTokenCount(needle: string, haystack: string): number {
  const ns = tokens(needle);
  if (ns.length === 0) return 0;
  const hayToks = tokens(haystack);
  const contentStems = ns
    .filter((t) => {
      const s = stem(t);
      return !QUESTION_FILLERS.has(t) && !QUESTION_FILLERS.has(s);
    })
    .map(stem);
  const otherStems = new Set(contentStems.filter((s) => s !== "이름"));
  let hit = 0;
  for (const t of ns) if (tokenMatch(t, hayToks, otherStems)) hit++;
  return hit;
}

/** haystack 안에 needle 토큰이 얼마나 들어있나 (0..1). 정답 재현/질문 관련성 공통. */
export function coverage(needle: string, haystack: string): number {
  const ns = tokens(needle);
  if (ns.length === 0) return 0;
  return matchedTokenCount(needle, haystack) / ns.length;
}

/** Drop interrogative/filler tokens. Empty result falls back to the original query. */
export function contentQuery(query: string): string {
  const kept = tokens(query).filter((t) => {
    const s = stem(t);
    return !QUESTION_FILLERS.has(t) && !QUESTION_FILLERS.has(s);
  });
  return kept.length ? kept.join(" ") : query;
}
