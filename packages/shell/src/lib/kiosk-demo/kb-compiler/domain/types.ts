/** @spec SPEC-001 — 도메인 모델. 어댑터 비의존(코어). */

export type SourceKind = "text" | "url" | "file";

export interface SourceInput {
  kind: SourceKind;
  uri?: string;
  title?: string;
  text?: string; // kind=text 또는 미리 추출된 본문
}

export interface Source {
  id: string;
  kind: SourceKind;
  uri?: string;
  title?: string;
  text: string;
}

export interface Entity {
  id: string;
  type: string; // Service | Department | Document | Fee | Condition ...
  name: string;
  attrs?: Record<string, unknown>;
}

/** 경량 그래프 데이터의 간선. from/to = Entity id. */
export interface Relation {
  from: string;
  type: string; // requires_document | handled_by | has_condition | costs | refers_to | mentions | co_occurs
  to: string;
  weight?: number; // 관계 강도(예: co_occurs 공출현 횟수). 옵션 — 미설정 시 1로 취급.
}

/** draft = compiled, unverified · accepted = gold-QA verified (D04) · gap = failed/blocked, not served.
 *  Serve-ready = not `gap` (`src/core/serve.ts` `isServeReady`). */
export type CardStatus = "draft" | "accepted" | "gap";

/** 서비스 카드 = 큐레이트 지식 단위(= 경량 그래프 노드 + 필드). */
export interface ServiceCard {
  id: string;
  title: string;
  fields: Record<string, string>; // eligibility/documents/department/fee/hours/url ...
  sourceUris: string[];
  confidence: number; // 0..1 (자동추출 신뢰도)
  effectiveDate?: string;
  expiryDate?: string;
  status: CardStatus;
}

/** 운영자 정답 앵커(루프 밖 합격 기준). */
export interface GoldQA {
  q: string;
  a: string;
}

/** 지식베이스 정본 = 표준·가반 포맷(JSON export 가능). */
export interface Kb {
  cards: ServiceCard[];
  entities: Entity[];
  relations: Relation[];
}

export type GapKind = "unanswered" | "mismatch" | "low_confidence" | "contradiction";

export interface Gap {
  kind: GapKind;
  detail: string;
  gold?: GoldQA;
  cardId?: string;
}

export interface VerifyResult {
  score: number; // gold 재현율 0..1
  acceptedCardIds: string[];
  gaps: Gap[];
}

export type SafetyMode = "warn" | "redact" | "block";

export interface CompileInput {
  sources: SourceInput[];
  goldQA?: GoldQA[];
  lowConfidenceThreshold?: number; // 기본 0.5
  /** 개인정보·대외비 처리: warn(경고만, 기본) | redact(PII 마스킹 후 추출) | block(발견 시 중단). */
  safety?: SafetyMode;
}

export interface Report {
  sourceCount: number;
  cardCount: number;
  entityCount: number;
  relationCount: number;
  acceptedCount: number;
  gapCount: number;
  /** 게이트에 안 걸린 미검증 카드 수. 서빙은 `gap`만 제외 (`isServeReady`) — draft 도 컴파일 산출이면 검색된다. */
  draftCount: number;
  score?: number;
}

export interface SafetyFinding {
  kind: string;
  severity: "pii" | "confidential";
  sample: string;
  count: number;
  sourceId?: string;
}
export interface SafetySummary {
  findings: SafetyFinding[];
  piiCount: number;
  confidentialCount: number;
  mode: SafetyMode;
  redactedCount: number;
}

export interface CompileResult {
  kb: Kb;
  report: Report;
  verify?: VerifyResult;
  safety?: SafetySummary;
}
