/** @spec SPEC-002 — Ingest 어댑터: text 패스스루 + url(주입 fetch). */
import type { IngestPort, } from "../../domain/ports.js";
import type { Source, SourceInput } from "../../domain/types.js";

export type Fetcher = (url: string) => Promise<string>;

/**
 * text 소스는 그대로, url 소스는 fetcher로 본문을 가져온다.
 * fetcher 미주입 시 url 은 globalThis.fetch 로 텍스트 취득(네트워크). 테스트는 text 사용 또는 fetcher 주입.
 */
export class IngestAdapter implements IngestPort {
  constructor(private fetcher?: Fetcher) {}

  async ingest(inputs: SourceInput[]): Promise<Source[]> {
    const out: Source[] = [];
    let counter = 0; // 호출별 로컬 → 결정론
    const nextId = (prefix: string) => `${prefix}_${++counter}`;
    for (const inp of inputs) {
      if (inp.kind === "text" || inp.kind === "file") {
        const text = (inp.text ?? "").trim();
        if (!text) continue;
        out.push({ id: nextId("src"), kind: inp.kind, uri: inp.uri, title: inp.title, text });
      } else if (inp.kind === "url") {
        if (!inp.uri) continue;
        const text = inp.text?.trim() || (await this.fetch(inp.uri));
        if (!text) continue;
        out.push({ id: nextId("src"), kind: "url", uri: inp.uri, title: inp.title, text });
      }
    }
    return out;
  }

  private async fetch(url: string): Promise<string> {
    if (this.fetcher) return this.fetcher(url);
    const f = (globalThis as { fetch?: (u: string) => Promise<{ text(): Promise<string> }> }).fetch;
    if (!f) throw new Error("fetch 미지원 환경 — Fetcher 주입 필요");
    const res = await f(url);
    return res.text();
  }
}
