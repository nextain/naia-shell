/** @spec SPEC-001 — 포트(교체 가능 경계). 코어는 어떤 어댑터인지 모른다. */
import type { Source, SourceInput, ServiceCard, Entity, Relation, Kb } from "./types.js";

export interface IngestPort {
  ingest(inputs: SourceInput[]): Promise<Source[]>;
}

export interface ExtractResult {
  cards: ServiceCard[];
  entities: Entity[];
  relations: Relation[];
}

export interface ExtractPort {
  extract(sources: Source[]): Promise<ExtractResult>;
}

export interface EmbedPort {
  embed(texts: string[]): Promise<number[][]>;
}

export interface RetrievalPort {
  index(kb: Kb): Promise<void>;
  search(query: string, k?: number): Promise<ServiceCard[]>;
}

export interface StorePort {
  save(kb: Kb): Promise<void>;
  load(): Promise<Kb>;
  export(): Promise<string>; // 표준 JSON (무손실, 가반)
  import(json: string): Promise<void>;
}

export interface GeneratePort {
  answer(query: string, cards: ServiceCard[]): Promise<{ text: string; citations: string[]; abstained: boolean }>;
}

/** compile 오케스트레이션에 주입되는 어댑터 묶음. retrieval/store 미지정 시 코어가 기본(in-memory) 사용. */
export interface Adapters {
  ingest: IngestPort;
  extract: ExtractPort;
  retrieval: RetrievalPort;
  store: StorePort;
  generate?: GeneratePort;
  embed?: EmbedPort;
}
