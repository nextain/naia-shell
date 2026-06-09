// domain/config — F0 (contract §B.1 NaiaConfig)
// 필드 분류 규칙 + forAgent() 순수 변환(secret+ui 제거). I/O 0.

/** 필드 분류: secret(키/크레덴셜)·ui(표시전용)·agent(노출 가능). */
export interface NaiaConfig {
  readonly agent: Readonly<Record<string, unknown>>; // 에이전트 노출 가능
  readonly secret: Readonly<Record<string, unknown>>; // 키/크레덴셜 (forAgent 에서 제거)
  readonly ui: Readonly<Record<string, unknown>>; // 표시전용 (forAgent 에서 제거)
  readonly workspaceRoot?: string; // persisted state normalization 대상
  readonly onboardingComplete?: boolean;
  readonly naiaKey?: string; // 외부키 (deferred 영역; 무키 UC12-min 엔 없음)
}

/** agent-facing 투영: secret+ui 제거. baseline `stripForAgent()` 의 순수 도메인 규칙. */
export interface AgentView {
  readonly agent: Readonly<Record<string, unknown>>;
}

export function forAgent(cfg: NaiaConfig): AgentView {
  return { agent: cfg.agent };
}

export function hasNaiaKey(cfg: NaiaConfig | null): boolean {
  return !!cfg?.naiaKey;
}

/** 최소 base config (setup load 에서 파일 config 가 null 일 때, 계약 `cfg or base`). */
export function baseConfig(): NaiaConfig {
  return { agent: {}, secret: {}, ui: {} };
}
