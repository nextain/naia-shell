/** @spec SPEC-008 — 서빙(검색·질의응답). 빌드된 KB 위에서 retrieval + 추출형 grounded 답변/기권.
 * naia-agent(RAG/툴) · naia-omni(툴 호출) · CMS 가 공용으로 쓰는 서빙 진입점. 오프라인·결정론(LLM 선택).
 */
import type { RetrievalPort, GeneratePort } from "../domain/ports.js";
import type { Kb, ServiceCard } from "../domain/types.js";
import { contentQuery, coverage, isLabelHeading, matchedTokenCount, tokens } from "./text.js";

export interface SearchHit {
  title: string;
  snippet: string;
  score: number;
  sourceUris: string[];
}
export interface AskResult {
  abstained: boolean;
  answer: string;
  sources: { title: string; sourceUris: string[] }[];
}

const cardText = (c: ServiceCard) => [c.title, ...Object.values(c.fields)].join(" ");

/** Canonical serve rule: compiled cards are searchable unless marked `gap`.
 *  `accepted` is gold-QA verification (D04), not the serve gate. Product compile
 *  has no goldQA, so extract leaves `draft` — those cards must still be served. */
export function isServeReady(card: Pick<ServiceCard, "status">): boolean {
  return card.status !== "gap";
}

export function serveReadyKb(kb: Kb): Kb {
  return { ...kb, cards: kb.cards.filter(isServeReady) };
}

function isContentLine(l: string): boolean {
  if (/^#{1,6}\s/.test(l)) return false;
  if (/^`{3,}/.test(l)) return false;
  if (/^[-*_]{3,}$/.test(l)) return false;
  return /[\p{L}\p{N}]/u.test(l);
}

/** 카드 본문에서 질의와 가장 관련된 문장/줄을 뽑음(추출형 근거). */
export function bestSnippet(card: ServiceCard, q: string, max = 300): string {
  const lines = String(card.fields.content ?? cardText(card))
    .split(/\r?\n|(?<=[.!?。])\s+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 1);

  let best = lines[0] ?? card.title;
  let bestIdx = 0;
  let bs = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const s = coverage(q, l);
    if (s > bs) {
      bs = s;
      best = l;
      bestIdx = i;
    }
  }

  if (/^#{1,6}\s/.test(best)) {
    const hasDigits = /\p{N}/u.test(best);
    const strictlyBest = lines.every((l, idx) => idx === bestIdx || bs > coverage(q, l));

    let bestContentLine: string | null = null;
    let maxSectionScore = -1;
    for (let j = bestIdx + 1; j < lines.length; j++) {
      const line = lines[j];
      if (/^#{1,6}\s/.test(line)) {
        break;
      }
      if (isContentLine(line)) {
        const s = coverage(q, line);
        if (s > maxSectionScore) {
          maxSectionScore = s;
          bestContentLine = line;
        }
      }
    }

    const condition3 =
      isLabelHeading(best, contentQuery(q)) || (bestContentLine !== null && maxSectionScore > 0);

    const canReplace = !hasDigits && strictlyBest && condition3;

    if (canReplace && bestContentLine !== null) {
      return bestContentLine.slice(0, max);
    }
    return best.slice(0, max);
  }

  return best.slice(0, max);
}

export interface KnowledgeServiceOptions {
  answerThreshold?: number; // 기권 임계(질의-카드 관련성). 기본 0.4
  generate?: GeneratePort; // 주입 시 추출 대신 LLM grounded 생성(선택)
}

/** 빌드된 KB + RetrievalPort 를 감싼 서빙 서비스. agent/omni/CMS 공용. */
export class KnowledgeService {
  private constructor(_kb: Kb, private retrieval: RetrievalPort, private opts: KnowledgeServiceOptions = {}) {}

  static async create(kb: Kb, retrieval: RetrievalPort, opts: KnowledgeServiceOptions = {}): Promise<KnowledgeService> {
    const served = serveReadyKb(kb);
    await retrieval.index(served);
    return new KnowledgeService(served, retrieval, opts);
  }

  async search(query: string, k = 8): Promise<SearchHit[]> {
    const hits = await this.retrieval.search(query, k);
    return hits.map((c) => ({
      title: c.title,
      snippet: bestSnippet(c, query),
      score: +coverage(query, cardText(c)).toFixed(2),
      sourceUris: c.sourceUris,
    }));
  }

  /** 추출형 grounded 답변 + 근거없으면 기권. generate 주입 시 LLM 생성. */
  async ask(query: string): Promise<AskResult> {
    const hits = await this.retrieval.search(query, 5);
    const threshold = this.opts.answerThreshold ?? 0.4;
    const needle = contentQuery(query);
    const needleToks = tokens(needle);
    const best = hits.find((c) => {
      const text = cardText(c);
      if (coverage(query, text) >= threshold) return true;
      if (coverage(needle, text) >= threshold) {
        if (needleToks.length >= 2) {
          return matchedTokenCount(needle, text) >= 2;
        }
        return true;
      }
      return false;
    });
    if (!best) {
      return { abstained: true, answer: "관련 근거를 찾지 못했습니다.", sources: [] };
    }
    const sources = hits.slice(0, 3).map((c) => ({ title: c.title, sourceUris: c.sourceUris }));
    if (this.opts.generate) {
      const g = await this.opts.generate.answer(query, hits);
      return { abstained: g.abstained, answer: g.text, sources };
    }
    return { abstained: false, answer: bestSnippet(best, query), sources };
  }
}
