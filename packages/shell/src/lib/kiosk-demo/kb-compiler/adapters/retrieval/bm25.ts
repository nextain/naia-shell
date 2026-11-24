/** @spec SPEC-007 — Retrieval 어댑터(BM25 Okapi). 결정론·오프라인·의존성0. 키워드 표준 베이스라인.
 * IDF 단순합 대비 문서길이 정규화 + TF 포화 → 긴 문서 편향 완화. RetrievalPort 로 교체 가능.
 */
import type { RetrievalPort } from "../../domain/ports.js";
import type { Kb, ServiceCard } from "../../domain/types.js";
import { tokens, stem } from "../../core/text.js";

interface Doc { card: ServiceCard; tf: Map<string, number>; len: number; }

export class Bm25RetrievalAdapter implements RetrievalPort {
  private docs: Doc[] = [];
  private df = new Map<string, number>();
  private n = 0;
  private avgdl = 1;
  constructor(private k1 = 1.5, private b = 0.75) {}

  async index(kb: Kb): Promise<void> {
    this.n = kb.cards.length;
    this.df.clear();
    let tot = 0;
    this.docs = kb.cards.map((card) => {
      const toks = tokens([card.title, ...Object.values(card.fields)].join(" ")).map(stem);
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      tot += toks.length;
      return { card, tf, len: toks.length };
    });
    this.avgdl = this.n ? tot / this.n : 1;
  }

  private idf(t: string): number {
    const d = this.df.get(t) ?? 0;
    return Math.log(1 + (this.n - d + 0.5) / (d + 0.5));
  }

  async search(query: string, k = 5): Promise<ServiceCard[]> {
    const qToks = [...new Set(tokens(query).map(stem))];
    const scored = this.docs
      .map((d) => {
        let s = 0;
        for (const t of qToks) {
          const tf = d.tf.get(t);
          if (tf) s += this.idf(t) * ((tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * (d.len / this.avgdl))));
        }
        return { c: d.card, s };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    return scored.slice(0, k).map((x) => x.c);
  }
}
