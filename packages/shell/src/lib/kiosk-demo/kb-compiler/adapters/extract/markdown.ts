/** @spec SPEC-003 — Extract 어댑터(markdown): 프로즈 md → 섹션 카드 + 엔티티·관계 그래프. 로컬·결정론(클라우드 미전송). */
import type { ExtractPort, ExtractResult } from "../../domain/ports.js";
import type { Source, ServiceCard, Entity, Relation } from "../../domain/types.js";
import lexicon from "../../ko-lexicon.json";

const HEADING = /^(#{1,4})\s+(.+?)\s*#*$/;
const BOLD = /\*\*([^*\n]{2,40})\*\*/g;
const LINK = /\[([^\]]{1,60})\]\(([^)\s]+)\)/g;

// 보일러플레이트 — 표·양식 라벨/구조어. 굵게 표기돼도 지식 엔티티가 아니라 노이즈 허브가 됨.
// (운영자 튜닝 대상. 고유명사·제품명은 절대 넣지 않는다.)
const BOILERPLATE = new Set(lexicon.markdownBoilerplate);
// 숫자로 시작하고 나머지가 단위/구두점뿐 → 수치값(엔티티 아님). 예: 8건·100억원·2026-05-19·1위·5~8건
const VALUE_UNIT = new Set(lexicon.markdownValueUnits);
function isValueTerm(n: string): boolean {
  if (!/^\d/.test(n)) return false;
  const rest = n.replace(/[\d.,~\-/\s]/g, "");
  return [...rest].every((c) => VALUE_UNIT.has(c));
}
function isNoiseTerm(raw: string): boolean {
  const n = raw.trim();
  if (n.length < 2) return true;
  if (BOILERPLATE.has(n)) return true;
  return isValueTerm(n);
}

interface Section {
  title: string;
  body: string;
}

const MIN_SECTION_CHARS = 200;

function splitSections(text: string, fallbackTitle: string): Section[] {
  const lines = text.split(/\r?\n/);
  const sections: Section[] = [];
  let cur: Section = { title: fallbackTitle, body: "" };
  for (const line of lines) {
    const m = line.match(HEADING);
    // H1/H2 에서만 분할(H3+ 는 본문 포함) → 과편화 방지
    if (m && m[1].length <= 2) {
      if (cur.body.trim() || cur.title !== fallbackTitle) sections.push(cur);
      cur = { title: m[2].trim(), body: "" };
    } else {
      cur.body += line + "\n";
    }
  }
  if (cur.body.trim() || cur.title !== fallbackTitle) sections.push(cur);

  // 작은 섹션을 직전 섹션에 병합
  const merged: Section[] = [];
  for (const s of sections) {
    const prev = merged[merged.length - 1];
    if (prev && s.body.trim().length < MIN_SECTION_CHARS) prev.body += `\n## ${s.title}\n${s.body}`;
    else merged.push(s);
  }
  return merged.filter((s) => s.title || s.body.trim());
}

export class MarkdownExtractAdapter implements ExtractPort {
  constructor(private maxConceptsPerCard = 8, private coOccurMin = 2) {}

  async extract(sources: Source[]): Promise<ExtractResult> {
    const cards: ServiceCard[] = [];
    const entities: Entity[] = [];
    const relations: Relation[] = [];
    const conceptId = new Map<string, string>();
    // 공출현 누적 — 같은 섹션에 함께 나온 Concept쌍 → co_occurs 관계(주제 군집 형성)
    const coCount = new Map<string, number>();
    const coPair = new Map<string, [string, string]>();
    let cardN = 0;
    let entN = 0;
    const ent = () => `ent_${++entN}`;

    for (const s of sources) {
      const fileTitle = s.title || s.uri || `doc`;
      const sections = splitSections(s.text, fileTitle);

      for (const sec of sections) {
        const body = sec.body.trim();
        if (body.length < 10 && sections.length > 1) continue;
        const title = sec.title === fileTitle ? fileTitle : `${fileTitle} / ${sec.title}`;
        const firstPara = body.split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").slice(0, 280) ?? "";
        const id = `card_${++cardN}`;
        const structured = /^#{1,4}\s/m.test(s.text) ? 0.7 : 0.5;

        cards.push({
          id,
          title: title.slice(0, 200),
          fields: { content: body.slice(0, 4000), summary: firstPara },
          sourceUris: s.uri ? [s.uri] : [],
          confidence: structured,
          status: "draft",
        });

        // Topic 노드
        const topic: Entity = { id: ent(), type: "Topic", name: title.slice(0, 120) };
        entities.push(topic);

        // 굵은 용어 → Concept 노드 + mentions 관계 (dedup, 노이즈 제외)
        const seen = new Set<string>();
        const sectionCids: string[] = [];
        let added = 0;
        for (const m of body.matchAll(BOLD)) {
          const name = m[1].trim();
          if (isNoiseTerm(name) || seen.has(name) || added >= this.maxConceptsPerCard) continue;
          seen.add(name);
          added++;
          let cid = conceptId.get(name);
          if (!cid) {
            cid = ent();
            conceptId.set(name, cid);
            entities.push({ id: cid, type: "Concept", name });
          }
          relations.push({ from: topic.id, type: "mentions", to: cid });
          sectionCids.push(cid);
        }

        // 섹션 내 Concept 공출현 → 무방향 쌍 카운트 누적
        const uniq = [...new Set(sectionCids)];
        for (let i = 0; i < uniq.length; i++) {
          for (let j = i + 1; j < uniq.length; j++) {
            const [a, b] = uniq[i] < uniq[j] ? [uniq[i], uniq[j]] : [uniq[j], uniq[i]];
            const k = `${a}|${b}`;
            coCount.set(k, (coCount.get(k) ?? 0) + 1);
            if (!coPair.has(k)) coPair.set(k, [a, b]);
          }
        }

        // 링크 → references 관계
        for (const m of body.matchAll(LINK)) {
          const refName = m[1].trim();
          let cid = conceptId.get(refName);
          if (!cid) {
            cid = ent();
            conceptId.set(refName, cid);
            entities.push({ id: cid, type: "Reference", name: refName, attrs: { url: m[2] } });
          }
          relations.push({ from: topic.id, type: "references", to: cid });
        }
      }
    }

    // 임계값 이상 공출현한 Concept쌍만 co_occurs 관계로 (약한 1회 공출현 노이즈 제외)
    for (const [k, [a, b]] of coPair) {
      const w = coCount.get(k) ?? 0;
      if (w >= this.coOccurMin) relations.push({ from: a, type: "co_occurs", to: b, weight: w });
    }

    return { cards, entities, relations };
  }
}
