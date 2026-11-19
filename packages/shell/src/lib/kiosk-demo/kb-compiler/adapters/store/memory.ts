/** @spec SPEC-005 — Store 어댑터(in-memory) + 표준 JSON export/import(무손실·가반). */
import type { StorePort } from "../../domain/ports.js";
import type { Kb } from "../../domain/types.js";

const EMPTY: Kb = { cards: [], entities: [], relations: [] };

export class MemoryStoreAdapter implements StorePort {
  private kb: Kb = structuredClone(EMPTY);

  async save(kb: Kb): Promise<void> {
    this.kb = structuredClone(kb);
  }
  async load(): Promise<Kb> {
    return structuredClone(this.kb);
  }
  async export(): Promise<string> {
    return JSON.stringify({ version: 1, kb: this.kb });
  }
  async import(json: string): Promise<void> {
    const parsed = JSON.parse(json) as { version: number; kb: Kb };
    if (!parsed.kb) throw new Error("잘못된 KB export 포맷");
    this.kb = parsed.kb;
  }
}
