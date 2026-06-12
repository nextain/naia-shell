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

/** UC12: 로컬 영속용 secret 제거 투영(secret:{} + top-level naiaKey 제거). secret 은 CredentialStore 전담(R4/R6/R8). 순수. */
export function stripSecret(cfg: NaiaConfig): NaiaConfig {
  const { naiaKey: _naiaKey, ...rest } = cfg;
  return { ...rest, secret: {} };
}

/** UC12: provider+keyField → 키체인 envKey (도메인 소유, R10). 키 없는 provider(gemini=naia-cloud·ollama/vllm=open·claude-code-cli)=null → writeAgentKey skip. */
export function resolveAgentEnvKey(provider: string, keyField: "apiKey" | "naiaKey"): string | null {
  if (keyField === "naiaKey") return "NAIA_ANYLLM_API_KEY";
  switch (provider) {
    case "anthropic": return "ANTHROPIC_API_KEY";
    case "openai": return "OPENAI_API_KEY";
    case "glm": return "GLM_API_KEY";
    default: return null; // ollama·vllm·gemini·claude-code-cli·nextain — 직접 키 없음
  }
}
