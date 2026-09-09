// adapters/ego-browser-env — #582 S3a. 감독자(packages/ego-host) 클라이언트.
// 계약: docs/progress/issue-582-ego-browser-host.md (4.2·4.4·4.5·4.7·4.8·4.9).
//
// 이 파일이 #499 가 비워 둔 브라우저 포트 셋을 채운다. 여기서부터 아래로는 CDP·소켓·프로세스
// 어휘이고, 위로는 작업·자원·증거뿐이다.
//
// ## 감독자를 어떻게 무는가 — 동적 import 이지 자식 프로세스가 아니다
//
// 감독자는 Chromium 의 장기 소유자이고 그 소유자는 셸이다(계약 4.8). 파이프 부모 끝의 유일한
// 소유자가 감독자여야 감독자가 SIGKILL 로 죽어도 브라우저가 남지 않는데, 감독자를 또 하나의
// 자식 프로세스로 두면 셸→감독자→Chromium 3단이 되어 **가운데 단이 죽는 경우**가 새로 생긴다.
// 셸 프로세스 안에서 감독자를 돌리면 그 경우가 아예 없다. 취소도 소켓 왕복 없이 장부에 바로
// 닿는다(`CancellationPort`).
//
// 코어 tsconfig 는 `rootDir: src` 라 패키지의 `.mjs` 를 정적 import 할 수 없고, 배포 표면 가드는
// `src/main` 에 `node:` import 을 한 줄도 허용하지 않는다. 그래서 **계산된 지정자의 동적
// import** 하나(`packages/ego-host/src/host-api.mjs`)만 두고, 프로세스·파일을 만지는 일은 전부
// 그 패키지 안에 남긴다. 지정자는 소스에서도 dist 에서도 저장소 루트로부터 세 단계 아래라
// 같은 상대 경로가 맞는다.
import {
  EnvOperationFailure,
  isEnvFailureReason,
  revisionMatches,
  type BrowserEvidence,
  type BrowserWorkspace,
  type ElementTarget,
  type EnvFailureReason,
  type EnvOperationRequest,
  type OperationState,
} from "../domain/env-tool.js";
import { BROWSER_RPC_TIERS, type BrowserRpc } from "../app/control/env-tool.js";
import type {
  BrowserEvaluation,
  BrowserOperationPort,
  BrowserScript,
  BrowserScriptPort,
  BrowserWorkspacePort,
  CancellationPort,
} from "../ports/env-tool.js";
import type { CapabilityTier } from "../domain/capability.js";

/** 지원하는 세 OS (계약 4.9). 값이 셋뿐이라는 것이 "OS 의존은 두 곳에만"의 근거다. */
export type EgoPlatform = "linux" | "win32" | "darwin";

// ── 경로 (순수) ─────────────────────────────────────────────────────────────
// `node:path` 를 쓸 수 없으므로 필요한 만큼만 직접 만든다. 순수 함수라 세 OS 를 이 기계에서
// 전부 시험할 수 있다 — 그것이 계약 4.9 가 "플랫폼 값을 주입해" 라고 적은 이유다.

export function pathSeparator(platform: EgoPlatform): string {
  return platform === "win32" ? "\\" : "/";
}

export function isAbsolutePath(path: string, platform: EgoPlatform): boolean {
  if (path === "") return false;
  if (platform === "win32") return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
  return path.startsWith("/");
}

/**
 * `.` 과 `..` 을 걷어내고 구분자를 하나로 만든다. 문자열이 다르면 같은 자리를 가리켜도 다른
 * 소켓·다른 lease 가 되므로, 어댑터가 보는 ADK 경로는 언제나 이 형태 하나다.
 */
export function normalizePath(path: string, platform: EgoPlatform): string {
  const sep = pathSeparator(platform);
  const raw = platform === "win32" ? path.replace(/\//g, "\\") : path;
  const isAbsolute = isAbsolutePath(raw, platform);
  const uncPrefix = platform === "win32" && raw.startsWith("\\\\") ? "\\\\" : "";
  const drive = platform === "win32" ? (/^[A-Za-z]:/.exec(raw)?.[0] ?? "") : "";
  const body = raw.slice(uncPrefix.length + drive.length);
  const out: string[] = [];
  for (const segment of body.split(platform === "win32" ? "\\" : "/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!isAbsolute) out.push("..");
      continue;
    }
    out.push(segment);
  }
  const joined = out.join(sep);
  if (platform === "win32") {
    if (uncPrefix) return `${uncPrefix}${joined}`;
    if (drive) return `${drive}${sep}${joined}`;
    return joined;
  }
  return isAbsolute ? `${sep}${joined}` : joined;
}

export function joinPath(platform: EgoPlatform, ...parts: readonly string[]): string {
  const sep = pathSeparator(platform);
  const joined = parts.filter((part) => part !== "").join(sep);
  return normalizePath(joined, platform);
}

/**
 * ADK 경로를 절대 경로로 못 박는다.
 *
 * 상대 경로로 두면 셸의 작업 디렉터리가 바뀌는 순간 같은 ADK 가 다른 소켓·다른 lease 를 갖고,
 * 그때 감독자는 둘이 되며 어느 쪽도 상대를 회수하지 못한다. 공백이 든 경로는 인용하지 않는다 —
 * 인자를 배열로만 넘기므로 인용이 필요한 자리가 없다.
 */
export function resolveAdkDir(adkDir: string, cwd: string, platform: EgoPlatform): string {
  if (adkDir === "") {
    throw new EnvOperationFailure("workspace-escape", "ADK 경로가 비었다 — 자리 없는 감독자는 두지 않는다");
  }
  if (isAbsolutePath(adkDir, platform)) return normalizePath(adkDir, platform);
  if (cwd === "" || !isAbsolutePath(cwd, platform)) {
    throw new EnvOperationFailure(
      "workspace-escape",
      `상대 ADK 경로(${adkDir})를 풀 절대 작업 디렉터리가 없다 — 추측해서 자리를 정하지 않는다`,
    );
  }
  return joinPath(platform, cwd, adkDir);
}

export interface EgoHostPaths {
  readonly adkDir: string;
  readonly egoHostDir: string;
  readonly evidenceDir: string;
  readonly agentWorkspace: string;
  readonly learnings: string;
  readonly leasePath: string;
}

/** `<ADK>/ego-host` 아래의 자리들. 감독자(lease.mjs·ax-snapshot.mjs)와 같은 규칙이다. */
export function egoHostPaths(adkDir: string, platform: EgoPlatform): EgoHostPaths {
  const host = joinPath(platform, adkDir, "ego-host");
  const agentWorkspace = joinPath(platform, host, "agent-workspace");
  return {
    adkDir,
    egoHostDir: host,
    evidenceDir: joinPath(platform, host, "evidence"),
    agentWorkspace,
    learnings: joinPath(platform, agentWorkspace, "learnings"),
    leasePath: joinPath(platform, host, "lease.json"),
  };
}

// ── spawn 시점 환경 (계약 4.2 "환경·경로" 행, ABI 8) ────────────────────────

export interface EgoLaunchEnvInput {
  readonly adkDir: string;
  readonly platform: EgoPlatform;
  /** 사람의 홈이 아니라 **ADK 안**이 기본이다. 에이전트가 사람의 `~` 를 읽을 이유가 없다. */
  readonly home?: string;
  readonly socketPath: string;
  readonly token: string;
  readonly grant: EgoGrant | null;
  readonly operationId: string;
  readonly workspaceId: string;
  readonly deadlineMs: number;
  /** 셸이 물려주는 최소 환경. 비워도 런처는 돈다(자식은 `process.execPath` 로 뜬다). */
  readonly base?: Readonly<Record<string, string>>;
}

/**
 * 벤더 런타임이 **모듈 로드 시점에** 읽는 값들이라 전부 spawn 시점에 자리잡아야 한다
 * (ABI 8: `state.ts` 가 `loadEnv()` 를 즉시 부른다). SDK import 뒤의 주입은 늦다.
 *
 * 순수 함수다. 같은 입력이면 상대 경로였든 공백이 들었든 빈 cwd 였든 **같은 환경**이 나온다 —
 * 경로 해석은 `resolveAdkDir` 가 이미 끝냈기 때문이다.
 */
export function egoLaunchEnv(input: EgoLaunchEnvInput): Record<string, string> {
  const paths = egoHostPaths(input.adkDir, input.platform);
  const home = input.home ?? paths.egoHostDir;
  const homeKey = input.platform === "win32" ? "USERPROFILE" : "HOME";
  const env: Record<string, string> = {
    ...(input.base ?? {}),
    // `~` 확장은 HOME → USERPROFILE → "." 순서다(ABI 8). 둘 중 하나는 반드시 절대 경로여야
    // 하며, 그러지 않으면 벤더가 `"."` 로 떨어져 셸의 작업 디렉터리에 파일을 만든다.
    [homeKey]: home,
    // 학습·헬퍼 루트를 벤더 밖에 두는 유일한 수단이다(ABI 8).
    EGO_BROWSER_AGENT_WORKSPACE: paths.agentWorkspace,
    // 증거 디렉터리. 우리 `screenshot` RPC 는 감독자가 경로를 정하지만, 벤더 헬퍼를 그대로
    // 쓰는 heredoc 은 호출자가 경로를 정한다 — 그 자리에 넣을 값을 환경으로 알려 준다.
    EGO_HOST_EVIDENCE_DIR: paths.evidenceDir,
    EGO_HOST_SOCKET: input.socketPath,
    EGO_HOST_TOKEN: input.token,
    EGO_HOST_OPERATION_ID: input.operationId,
    EGO_HOST_WORKSPACE_ID: input.workspaceId,
    EGO_HOST_DEADLINE_MS: String(input.deadlineMs),
  };
  if (input.grant) env.EGO_HOST_GRANT = JSON.stringify(input.grant);
  return env;
}

// ── 감독자 쪽 상태를 #499 의 5상태로 (S2f 가 넘긴 것) ───────────────────────

/** 감독자 작업 장부의 상태 문자열. 두 벌이 되지 않게 여기 한 곳에서만 옮긴다. */
export function mapSupervisorState(status: string): OperationState {
  switch (status) {
    case "accepted":
      return "accepted";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    default:
      // 모르는 상태를 완료로 읽지 않는다. 모르면 실패다.
      return "failed";
  }
}

/** 안정 오류 코드 → 형식 있는 실패 사유 (계약 4.4). 문자열로 뭉개면 원인을 못 짚는다. */
export const EGO_CODE_REASONS: Readonly<Record<string, EnvFailureReason>> = {
  EGO_HOST_DISCONNECTED: "disconnected",
  EGO_HOST_NOT_CONNECTED: "disconnected",
  EGO_HOST_BROWSER_GONE: "disconnected",
  EGO_HOST_BACKPRESSURE: "disconnected",
  EGO_OPERATION_CANCELLED: "cancelled",
  EGO_OPERATION_TIMEOUT: "timeout",
  EGO_HOST_DEADLINE_EXCEEDED: "timeout",
  EGO_HOST_METHOD_DENIED: "method-denied",
  EGO_HOST_GRANT_REQUIRED: "method-denied",
  EGO_HANDOFF_UNSUPPORTED_HEADLESS: "method-denied",
  EGO_RESOURCE_NOT_OWNED: "method-denied",
  EGO_SESSION_SLOT_BUSY: "method-denied",
  EGO_DOMAIN_IN_USE: "method-denied",
  EGO_CONTEXT_MISMATCH: "context-mismatch",
  EGO_TARGET_BUSY: "context-mismatch",
  EGO_TASK_SPACE_NOT_FOUND: "context-mismatch",
  EGO_TASK_SPACE_NOT_SELECTED: "context-mismatch",
  EGO_OPERATION_NOT_FOUND: "context-mismatch",
  EGO_HOST_EVIDENCE_FAILED: "partial",
};

/**
 * 감독자가 준 실패를 형식 있는 사유로 옮긴다.
 *
 * 코드가 문구 **끝**에 오는 경우까지 본다 — 벤더 런타임이 CDP 오류의 `error.code` 를 버리므로
 * 중계기는 안정 코드를 메시지 끝에 넣는다(계약 4.3.2, S2f).
 */
export function egoFailureReason(code: string | undefined, message: string): EnvFailureReason {
  if (code && EGO_CODE_REASONS[code]) return EGO_CODE_REASONS[code];
  if (code && isEnvFailureReason(code)) return code;
  for (const known of Object.keys(EGO_CODE_REASONS)) {
    if (message.includes(known)) return EGO_CODE_REASONS[known];
  }
  // 사유를 못 읽었다. 지어내지 않고 "연결 너머에서 온 알 수 없는 실패"로 남긴다.
  return "disconnected";
}

function failure(code: string | undefined, message: string): EnvOperationFailure {
  return new EnvOperationFailure(egoFailureReason(code, message), message);
}

// ── 감독자 모듈의 좁은 표면 ─────────────────────────────────────────────────
// 패키지 전체를 타입으로 옮기지 않는다. 어댑터가 실제로 부르는 것만 적는다 — 그래야 감독자가
// 바뀔 때 무엇이 계약이었는지 이 목록만 보면 된다.

export interface EgoGrant {
  readonly tier: CapabilityTier;
  readonly approvalRef?: string;
}

interface EgoErrorShape {
  readonly error?: string;
  readonly error_code?: string;
}

interface EgoClient {
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown> & EgoErrorShape>;
  sendCdp(payload: string, options?: { operationId?: string | null }): void;
  onCdp(handler: (raw: string) => void): () => void;
  onClose(handler: (error: Error) => void): () => void;
  close(): void;
}

interface EgoOperationsLedger {
  cancel(id: string, options?: { reason?: string }): Promise<{ changed: boolean; status: string; cleanup: unknown }>;
  complete(id: string, options?: { status?: string; reason?: string | null }): Promise<{ changed: boolean; status: string; cleanup: unknown }>;
  list(): readonly { id: string; status: string; failureReason: string | null }[];
}

interface EgoSupervisorHandle {
  readonly socketPath: string;
  readonly browserPid: number;
  readonly server: {
    /**
     * 토큰 하나. **동기일 수도 비동기일 수도 있다.** 감독자가 이 프로세스 안에 있으면
     * 문자열이 곧바로 나오고(S3a 계약 테스트), 웹뷰에서 Tauri 명령을 지나면 Promise 다(S6c).
     * 호출부는 언제나 `await` 한다 — 문자열을 await 해도 같은 문자열이다.
     */
    issueToken(options: { operationId?: string; workspaceId?: string | null; grant?: EgoGrant | null }): string | Promise<string>;
    operations: EgoOperationsLedger;
  };
  readonly browser: { on(event: "exit", handler: () => void): void };
  stop(options?: { graceMs?: number }): Promise<unknown>;
}

export interface EgoHostApi {
  startSupervisor(options: Record<string, unknown>): Promise<EgoSupervisorHandle>;
  connectSupervisor(options: Record<string, unknown>): Promise<EgoClient>;
  reconcileLease(options: Record<string, unknown>): Promise<{ status: string; orphans: number; note: string }>;
  /** 자리를 만든다. IPC 를 지나는 조립에서는 비동기다(S6c). */
  ensureDirs(dirs: readonly string[]): void | Promise<void>;
  pidAlive(pid: number): boolean;
  waitForPidExit(pid: number, timeoutMs?: number, stepMs?: number): Promise<boolean>;
  writeEnvFiles(files: readonly { path: string; values: Record<string, string> }[]): readonly string[] | Promise<readonly string[]>;
  runEgoScript(options: Record<string, unknown>): Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }>;
  readonly DEFAULT_SDK_DIR: string;
}

/** 기본 로더. 소스에서도 dist 에서도 저장소 루트로부터 세 단계 아래라 같은 상대 경로가 맞는다. */
export function defaultEgoHostApi(): Promise<EgoHostApi> {
  const specifier = new URL("../../../packages/ego-host/src/host-api.mjs", import.meta.url).href;
  return import(specifier) as Promise<EgoHostApi>;
}

export interface EgoBrowserEnvOptions {
  readonly adkDir: string;
  readonly platform?: EgoPlatform;
  /** 상대 ADK 경로를 풀 자리. 절대 경로만 받는다 — 없으면 상대 경로는 거부다. */
  readonly cwd?: string;
  readonly home?: string;
  readonly baseEnv?: Readonly<Record<string, string>>;
  /** 주면 브라우저 탐색을 건너뛴다(테스트·고정 배포). */
  readonly executable?: string;
  /** unix 소켓 경로 상한(104바이트) 때문에 짧은 자리를 줄 수 있다. */
  readonly runtimeDir?: string;
  readonly loadApi?: () => Promise<EgoHostApi>;
}

// ── CDP 통로 ────────────────────────────────────────────────────────────────

interface CdpResponse {
  readonly id: number;
  readonly result?: Record<string, unknown>;
  readonly error?: { message?: string; code?: number | string };
}

/**
 * 연결 하나의 CDP 요청·응답. 요청 id 는 **연결마다 1 부터**다(벤더 런타임과 같은 규칙).
 * 이벤트는 버린다 — 형식 있는 도구는 이벤트를 쓰지 않는다(FR-ENV-TOOL.2b Pending).
 */
function cdpChannel(client: EgoClient, timeoutMs: number): {
  call(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  dispose(): void;
} {
  let nextId = 1;
  const pending = new Map<number, (response: CdpResponse) => void>();
  const off = client.onCdp((raw) => {
    let data: CdpResponse;
    try {
      data = JSON.parse(raw) as CdpResponse;
    } catch {
      return;
    }
    if (typeof data.id !== "number") return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    entry(data);
  });
  return {
    call(method, params = {}, sessionId) {
      const id = nextId++;
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new EnvOperationFailure("timeout", `${method} 응답이 ${timeoutMs}ms 안에 오지 않았다`));
        }, timeoutMs);
        pending.set(id, (data) => {
          clearTimeout(timer);
          if (data.error) {
            const message = data.error.message ?? `${method} 실패`;
            reject(failure(typeof data.error.code === "string" ? data.error.code : undefined, message));
            return;
          }
          resolve(data.result ?? {});
        });
        try {
          client.sendCdp(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(failure((error as EgoErrorShape).error_code, error instanceof Error ? error.message : String(error)));
        }
      });
    },
    dispose() {
      off();
      for (const [, entry] of pending) {
        entry({ id: -1, error: { message: "연결이 닫혔다", code: "EGO_HOST_DISCONNECTED" } });
      }
      pending.clear();
    },
  };
}

interface OperationContext {
  readonly client: EgoClient;
  readonly cdp: ReturnType<typeof cdpChannel>;
  readonly workspaceId: string;
}

/** RPC 하나의 등급·승인을 감독자 grant 로 옮긴다. 관측 등급은 grant 없이 붙는다(계약 4.4). */
export function grantFor(rpc: BrowserRpc, request: EnvOperationRequest): EgoGrant | null {
  const tier: CapabilityTier = BROWSER_RPC_TIERS[rpc];
  if (tier === "observe") return null;
  return request.approvalRef ? { tier, approvalRef: request.approvalRef } : { tier };
}

// ── 어댑터 ──────────────────────────────────────────────────────────────────

/**
 * 감독자 클라이언트 하나. 포트 셋을 한 몸이 든다.
 *
 * 클래스가 `BrowserWorkspacePort` 와 `BrowserOperationPort` 를 **동시에 구현하지 않는** 이유:
 * 두 포트의 `close` 는 이름이 같고 뜻이 다르다(공간 닫기 대 페이지 닫기). 한 이름에 두 뜻을
 * 얹으면 조립에서 어느 쪽이 불렸는지 읽을 수 없다. 그래서 메서드 이름을 갈라 두고
 * `workspacePort()`·`operationPort()` 가 각각의 얼굴을 만든다.
 */
export class EgoBrowserEnvironment implements BrowserScriptPort, CancellationPort {
  private readonly platform: EgoPlatform;
  private readonly adkDir: string;
  private readonly paths: EgoHostPaths;
  private api: EgoHostApi | null = null;
  private supervisor: EgoSupervisorHandle | null = null;
  private starting: Promise<EgoSupervisorHandle> | null = null;
  /** 감독자가 죽었다는 사실. 다음 요청은 `disconnected` 로 실패하고 재시작은 명시 호출뿐이다. */
  private lostReason: string | null = null;

  constructor(private readonly options: EgoBrowserEnvOptions) {
    this.platform = options.platform ?? "linux";
    this.adkDir = resolveAdkDir(options.adkDir, options.cwd ?? "", this.platform);
    this.paths = egoHostPaths(this.adkDir, this.platform);
  }

  get adkRoot(): string {
    return this.adkDir;
  }

  get hostPaths(): EgoHostPaths {
    return this.paths;
  }

  /** 감독자가 살아 있는가. 죽은 뒤에는 명시적 `restart()` 전까지 거짓이다. */
  get isRunning(): boolean {
    return this.supervisor !== null && this.lostReason === null;
  }

  /** 지금 이 어댑터가 소유한 Chromium 의 PID. 내린 뒤에는 null 이다(고아 판정의 축). */
  get browserPid(): number | null {
    return this.supervisor?.browserPid ?? null;
  }

  private async loadApi(): Promise<EgoHostApi> {
    if (!this.api) this.api = await (this.options.loadApi ?? defaultEgoHostApi)();
    return this.api;
  }

  /**
   * 첫 사용에 감독자를 띄운다. 죽은 뒤에는 조용히 되살리지 않는다 —
   * 되살리면 그 사이의 작업 공간·탭이 사라진 것을 아무도 모른 채 다음 작업이 돈다.
   */
  private async ensureSupervisor(): Promise<EgoSupervisorHandle> {
    if (this.lostReason) throw new EnvOperationFailure("disconnected", this.lostReason);
    if (this.supervisor) return this.supervisor;
    if (this.starting) return this.starting;
    const starting = (async (): Promise<EgoSupervisorHandle> => {
      const api = await this.loadApi();
      await api.ensureDirs([this.paths.egoHostDir, this.paths.evidenceDir, this.paths.agentWorkspace, this.paths.learnings]);
      const supervisor = await api.startSupervisor({
        adkDir: this.adkDir,
        platform: this.platform,
        ...(this.options.executable ? { executable: this.options.executable } : {}),
        ...(this.options.runtimeDir ? { runtimeDir: this.options.runtimeDir } : {}),
      });
      supervisor.browser.on("exit", () => {
        this.lostReason =
          `감독자의 Chromium(PID ${supervisor.browserPid})이 사라졌다. 재시작은 명시 호출로만 한다 ` +
          "(#582 계약 4.8).";
        this.supervisor = null;
      });
      this.supervisor = supervisor;
      return supervisor;
    })();
    this.starting = starting;
    try {
      return await starting;
    } catch (error) {
      this.lostReason = error instanceof Error ? error.message : String(error);
      throw failure((error as EgoErrorShape).error_code, this.lostReason);
    } finally {
      this.starting = null;
    }
  }

  /** 명시적 재시작. 죽은 감독자를 대신할 새 감독자를 세운다(조정 → 런처 → lease). */
  async restart(): Promise<void> {
    await this.stop();
    this.lostReason = null;
    await this.ensureSupervisor();
  }

  /** 셸 종료 경로. 감독자를 정상 종료하고 Chromium 소멸까지 기다린다. */
  async stop(): Promise<void> {
    const supervisor = this.supervisor;
    this.supervisor = null;
    if (!supervisor) return;
    await supervisor.stop();
  }

  // ── 작업 하나의 연결 ──────────────────────────────────────────────────────

  /**
   * 작업 하나 = 연결 하나 = 토큰 하나.
   *
   * 토큰은 감독자가 **승인에 결박해** 발급한다(단일 사용). 형식 도구는 등급표의 등급을 grant 로
   * 쓰고, 관측 등급은 grant 없이 붙어 원시 CDP 를 아예 보낼 수 없다.
   *
   * 끝에 `endOperation` 을 부르는 이유: 부르지 않고 연결만 닫으면 감독자가 그 작업을
   * `failed(process-exit)` 로 적는다(계약 4.8). 성공한 작업이 장부에 실패로 남으면 장부가 거짓이 된다.
   */
  private async withOperation<T>(
    request: EnvOperationRequest,
    rpc: BrowserRpc,
    body: (ctx: OperationContext) => Promise<T>,
    { selectSpace = true }: { selectSpace?: boolean } = {},
  ): Promise<T> {
    const supervisor = await this.ensureSupervisor();
    const api = await this.loadApi();
    const grant = grantFor(rpc, request);
    const token = await supervisor.server.issueToken({
      operationId: request.operationId,
      workspaceId: request.workspaceId,
      grant,
    });
    let client: EgoClient;
    try {
      client = await api.connectSupervisor({
        socketPath: supervisor.socketPath,
        token,
        grant,
        operationId: request.operationId,
        workspaceId: request.workspaceId,
        deadline: request.timeoutMs,
        unref: false,
      });
    } catch (error) {
      throw failure((error as EgoErrorShape).error_code, `감독자에 붙지 못했다: ${describe(error)}`);
    }
    const cdp = cdpChannel(client, request.timeoutMs);
    // 연결이 끊기면 대기 중인 CDP 를 **바로** 끊는다. 안 그러면 감독자가 내려간 뒤에도 요청
    // 하나하나가 자기 상한을 다 채우고 나서야 실패해, ADK 전환이 몇 분씩 매달린다(S3b).
    client.onClose(() => cdp.dispose());
    let ok = false;
    let thrown: unknown = null;
    try {
      if (selectSpace) await rpcCall(client, "useTaskSpace", { id: Number(request.workspaceId) });
      const value = await body({ client, cdp, workspaceId: request.workspaceId });
      ok = true;
      return value;
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      // 장부에 결과를 적는 것은 **소켓이 아니라 감독자 장부에 바로** 한다. RPC 로 적으면
      // 관측 등급 연결(grant 없음)이 그 RPC 를 부를 수 없어 성공한 작업이 장부에
      // `failed(process-exit)` 로 남는다. 종결은 CAS 라 이미 만료·취소된 작업은 그대로다.
      try {
        const reason = thrown instanceof EnvOperationFailure ? thrown.reason : "partial";
        await (ok
          ? supervisor.server.operations.complete(request.operationId, { status: "completed" })
          : supervisor.server.operations.complete(request.operationId, {
              status: reason === "cancelled" ? "cancelled" : "failed",
              reason,
            }));
      } catch {
        /* 이미 종결됐거나 감독자가 사라졌다. 장부의 사실이 이겨야 하므로 여기서 덮지 않는다. */
      }
      cdp.dispose();
      client.close();
    }
  }

  // ── BrowserWorkspacePort ─────────────────────────────────────────────────

  /**
   * 작업 공간 하나. **멱등 키를 감독자까지 내린다** (#582 S0 리뷰 2번) —
   * 어댑터가 재연결한 뒤 같은 키로 다시 부르면 공간이 둘 생기던 자리다.
   */
  async createWorkspace(request: EnvOperationRequest, signal?: AbortSignal): Promise<BrowserWorkspace> {
    throwIfAborted(signal);
    return this.withOperation(
      request,
      "createWorkspace",
      async ({ client }) => {
        const created = await rpcCall(client, "createTaskSpace", {
          name: request.workspaceId,
          idempotencyKey: request.idempotencyKey,
        });
        return toWorkspace(created.resource);
      },
      { selectSpace: false },
    );
  }

  async listWorkspaces(signal?: AbortSignal): Promise<readonly BrowserWorkspace[]> {
    throwIfAborted(signal);
    const request: EnvOperationRequest = {
      operationId: `list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      idempotencyKey: "",
      capability: "observe",
      timeoutMs: 10_000,
      workspaceId: "",
    };
    return this.withOperation(
      request,
      "listWorkspaces",
      async ({ client }) => {
        const listed = await rpcCall(client, "listTaskSpaces", {});
        const resources = Array.isArray(listed.resources) ? listed.resources : [];
        return resources.map((resource) => toWorkspace(resource));
      },
      { selectSpace: false },
    );
  }

  async closeWorkspace(request: EnvOperationRequest, workspaceId: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await this.withOperation(
      request,
      "closeWorkspace",
      async ({ client }) => {
        await rpcCall(client, "useTaskSpace", { id: Number(workspaceId) });
        await rpcCall(client, "closeTaskSpace", {});
      },
      { selectSpace: false },
    );
  }

  // ── BrowserOperationPort ─────────────────────────────────────────────────

  async open(request: EnvOperationRequest, url: string, signal?: AbortSignal): Promise<BrowserEvidence> {
    return this.withOperation(request, "open", async (ctx) => {
      throwIfAborted(signal);
      const created = await rpcCall(ctx.client, "createTab", { url });
      const targetId = String(created.targetId ?? "");
      const sessionId = await attach(ctx, targetId);
      await settle(ctx, sessionId, signal);
      return this.evidence(ctx, request);
    });
  }

  async navigate(request: EnvOperationRequest, url: string, signal?: AbortSignal): Promise<BrowserEvidence> {
    return this.withOperation(request, "navigate", async (ctx) => {
      throwIfAborted(signal);
      const targetId = await this.checkedTarget(ctx, request);
      const sessionId = await attach(ctx, targetId);
      await ctx.cdp.call("Page.navigate", { url }, sessionId);
      await settle(ctx, sessionId, signal);
      return this.evidence(ctx, request);
    });
  }

  async snapshot(request: EnvOperationRequest, signal?: AbortSignal): Promise<BrowserEvidence> {
    return this.withOperation(request, "snapshot", async (ctx) => {
      throwIfAborted(signal);
      await this.checkedTarget(ctx, request);
      return this.evidence(ctx, request);
    });
  }

  async click(request: EnvOperationRequest, target: ElementTarget, signal?: AbortSignal): Promise<BrowserEvidence> {
    return this.withOperation(request, "click", async (ctx) => {
      throwIfAborted(signal);
      const targetId = await this.checkedTarget(ctx, request);
      const sessionId = await attach(ctx, targetId);
      const point = await pointOf(ctx, sessionId, target);
      await ctx.cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }, sessionId);
      await ctx.cdp.call(
        "Input.dispatchMouseEvent",
        { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 },
        sessionId,
      );
      await ctx.cdp.call(
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 },
        sessionId,
      );
      return this.evidence(ctx, request);
    });
  }

  async fill(request: EnvOperationRequest, target: ElementTarget, value: string, signal?: AbortSignal): Promise<BrowserEvidence> {
    return this.withOperation(request, "fill", async (ctx) => {
      throwIfAborted(signal);
      const targetId = await this.checkedTarget(ctx, request);
      const sessionId = await attach(ctx, targetId);
      if (target.kind === "reference") {
        // 참조로 잡은 요소에 초점을 준다. `DOM.resolveNode` 가 준 objectId 는 감독자 장부에
        // 이 작업의 것으로 등록되므로 바로 뒤의 `Runtime.callFunctionOn` 이 통과한다.
        const objectId = await resolveRef(ctx, sessionId, target.ref);
        await ctx.cdp.call(
          "Runtime.callFunctionOn",
          {
            objectId,
            functionDeclaration: "function () { this.focus(); if ('value' in this) this.value = ''; }",
            returnByValue: true,
          },
          sessionId,
        );
      } else {
        const point = await pointOf(ctx, sessionId, target);
        await ctx.cdp.call(
          "Input.dispatchMouseEvent",
          { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 },
          sessionId,
        );
        await ctx.cdp.call(
          "Input.dispatchMouseEvent",
          { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 },
          sessionId,
        );
      }
      await ctx.cdp.call("Input.insertText", { text: value }, sessionId);
      return this.evidence(ctx, request);
    });
  }

  /**
   * 효과가 고정된 평가. 감독자의 `Runtime.evaluate` 를 그 작업이 소유한 세션에서만 부른다 —
   * 임의 묶음 실행(`script`)과는 등급도 통로도 다르다.
   */
  async evaluate(request: EnvOperationRequest, script: BrowserScript, signal?: AbortSignal): Promise<BrowserEvaluation> {
    return this.withOperation(request, "evaluate", async (ctx) => {
      throwIfAborted(signal);
      const targetId = await this.checkedTarget(ctx, request);
      const sessionId = await attach(ctx, targetId);
      const evaluated = await ctx.cdp.call(
        "Runtime.evaluate",
        { expression: script.expression, returnByValue: true, awaitPromise: true },
        sessionId,
      );
      const details = evaluated.exceptionDetails as { text?: string } | undefined;
      if (details) {
        throw new EnvOperationFailure("partial", `평가가 예외로 끝났다: ${details.text ?? "설명 없음"}`);
      }
      const remote = (evaluated.result ?? {}) as { value?: unknown };
      return { evidence: await this.evidence(ctx, request), result: JSON.stringify(remote.value ?? null) };
    });
  }

  async screenshot(request: EnvOperationRequest, signal?: AbortSignal): Promise<BrowserEvidence> {
    return this.withOperation(request, "screenshot", async (ctx) => {
      throwIfAborted(signal);
      await this.checkedTarget(ctx, request);
      return this.evidence(ctx, request);
    });
  }

  /** 페이지 닫기. 자원이 사라지므로 증거가 아니라 결과 없음으로 끝난다. */
  async closePage(request: EnvOperationRequest, signal?: AbortSignal): Promise<void> {
    await this.withOperation(request, "close", async (ctx) => {
      throwIfAborted(signal);
      const targetId = await this.checkedTarget(ctx, request);
      await ctx.cdp.call("Target.closeTarget", { targetId });
    });
  }

  // ── BrowserScriptPort ────────────────────────────────────────────────────

  /**
   * 묶음 실행. 런처를 **자식 프로세스**로 띄우고 stdin 에 코드를 넣는다 — 벤더 런타임의 유일한
   * 실행 형태다. 승인 없는 호출은 여기 오기 전에 서비스가 막고, 그래도 온 것은 감독자가
   * 핸드셰이크에서 막는다(승인 없는 연결에는 grant 가 없다).
   */
  async script(request: EnvOperationRequest, code: string, signal?: AbortSignal): Promise<BrowserEvaluation> {
    throwIfAborted(signal);
    if (!request.approvalRef) {
      throw new EnvOperationFailure("approval-missing", "묶음 실행은 터미널 실행과 같은 등급이며 승인이 먼저다");
    }
    const supervisor = await this.ensureSupervisor();
    const api = await this.loadApi();
    const grant = grantFor("script", request);
    const token = await supervisor.server.issueToken({
      operationId: request.operationId,
      workspaceId: request.workspaceId,
      grant,
    });
    const env = egoLaunchEnv({
      adkDir: this.adkDir,
      platform: this.platform,
      ...(this.options.home ? { home: this.options.home } : {}),
      socketPath: supervisor.socketPath,
      token,
      grant,
      operationId: request.operationId,
      workspaceId: request.workspaceId,
      deadlineMs: request.timeoutMs,
      ...(this.options.baseEnv ? { base: this.options.baseEnv } : {}),
    });
    // `.env` 는 spawn 환경 **아래**에 깔리는 기본값이다(벤더는 이미 설정된 변수를 덮지 않는다).
    // 벤더는 두 곳을 읽지만(ABI 8) 우리는 **작업 공간 쪽 한 곳에만** 놓는다. 다른 한 곳인
    // `<SDK REPO_ROOT>/.env` 는 이 기계의 모든 ADK 가 공유하는 자리라, 거기에 ADK 별 경로를
    // 적으면 마지막에 쓴 ADK 가 다른 ADK 의 기본값이 된다. 실측으로 확인한 사실이다 —
    // 한 번 그렇게 적었더니 그 뒤의 모든 벤더 실행이 남의 작업 id 를 물고 돌았다(S3a).
    await api.ensureDirs([this.paths.agentWorkspace, this.paths.learnings, this.paths.evidenceDir]);
    await api.writeEnvFiles([{ path: joinPath(this.platform, this.paths.agentWorkspace, ".env"), values: envFileValues(env) }]);
    const run = await api.runEgoScript({ code, env, timeoutMs: request.timeoutMs, ...(signal ? { signal } : {}) });
    if (run.timedOut) throw new EnvOperationFailure("timeout", `묶음 실행이 ${request.timeoutMs}ms 를 넘겼다`);
    if (run.status !== 0) {
      throw new EnvOperationFailure(
        "process-exit",
        `묶음 실행이 종료 코드 ${run.status} 로 끝났다: ${run.stderr.trim() || run.stdout.trim()}`,
      );
    }
    // 증거는 형식 도구와 같은 자리에서 모은다 — heredoc 이라고 증거가 헐거워지지 않는다.
    const evidence = await this.withOperation(
      { ...request, capability: "observe" },
      "snapshot",
      async (ctx) => this.evidence(ctx, request),
    );
    return { evidence, result: run.stdout };
  }

  // ── CancellationPort ─────────────────────────────────────────────────────

  /**
   * 취소는 소켓을 거치지 않는다. 감독자가 같은 프로세스에 있으므로 작업 장부에 바로 닿는다 —
   * 취소가 늦게 도착하는 통로를 하나 줄이는 것이 계약 4.7 의 요점이다.
   */
  async cancel(operationId: string): Promise<readonly string[]> {
    if (!this.supervisor) return [];
    const result = await this.supervisor.server.operations.cancel(operationId);
    if (!result.changed) return [];
    return describeCleanup(result.cleanup);
  }

  /** 감독자 장부가 보는 그 작업의 상태. #499 의 5상태로 옮겨 돌려준다(S2f 가 넘긴 것). */
  stateOf(operationId: string): OperationState | undefined {
    const found = this.supervisor?.server.operations.list().find((op) => op.id === operationId);
    return found ? mapSupervisorState(found.status) : undefined;
  }

  // ── ADK 전환 (S3b) ───────────────────────────────────────────────────────

  /**
   * ADK 를 바꾼다. 순서가 계약이다 (계약 4.8).
   *
   *   A 의 감독자 정상 종료(Chromium 소멸 확인) → B 의 lease 조정 → B 의 감독자 시작
   *
   * 순서를 어기면 그 순간 고아가 하나 생기고, B 의 lease 가 A 의 것을 덮어써 영영 회수할 수
   * 없게 된다. 그래서 A 가 살아 있는 동안 B 를 시작하는 길을 **형식 오류**로 막는다.
   */
  async switchAdk(fromDir: string, toDir: string, { start = true }: { start?: boolean } = {}): Promise<EgoSwitchReport> {
    const from = resolveAdkDir(fromDir, this.options.cwd ?? "", this.platform);
    const to = resolveAdkDir(toDir, this.options.cwd ?? "", this.platform);
    if (from === to) {
      throw new EnvOperationFailure("context-mismatch", `같은 ADK 로는 전환하지 않는다: ${to}`);
    }
    if (from !== this.adkDir) {
      throw new EnvOperationFailure(
        "context-mismatch",
        `전환 출발지(${from})가 이 어댑터의 ADK(${this.adkDir})가 아니다`,
      );
    }
    const api = await this.loadApi();

    // (1) A 를 내린다.
    const stoppedPid = this.supervisor?.browserPid ?? null;
    await this.stop();

    // (2) **정말 내려갔는지** 를 판정 기준으로 삼는다. "종료를 요청했다"는 기준이 아니다 —
    //     A 의 Chromium 이 살아 있는데 B 를 시작하면 그 순간 고아가 하나 생기고, B 의 lease 가
    //     A 의 것을 덮어써 영영 회수할 수 없게 된다(계약 4.8).
    if (stoppedPid !== null && !(await api.waitForPidExit(stoppedPid, 10_000))) {
      throw new EnvOperationFailure(
        "disconnected",
        `이전 ADK(${from})의 Chromium(PID ${stoppedPid})이 아직 살아 있다. ` +
          "A 가 살아 있는 동안에는 B 의 lease 를 건드리지도, B 를 시작하지도 않는다(#582 계약 4.8).",
      );
    }
    // 전환한 어댑터는 되살아나지 않는다. 다음 요청이 A 를 조용히 다시 띄우면 ADK 가 둘이 된다.
    this.lostReason = `이 어댑터의 ADK(${from})는 ${to} 로 전환하며 내려갔다`;

    // (3) B 의 lease 조정 — 이전 감독자의 흔적을 치운 뒤에야 (4) B 를 시작한다.
    const reconciliation = await api.reconcileLease({ adkDir: to, platform: this.platform });
    const next = start
      ? createEgoBrowserEnvironment({ ...this.options, adkDir: to })
      : null;
    if (next) await next.start();
    return { from, to, stoppedPid, reconciliation, next };
  }

  /** 감독자를 미리 띄운다. 첫 사용까지 기다리지 않아도 되는 자리(전환·부팅)를 위한 문. */
  async start(): Promise<void> {
    await this.ensureSupervisor();
  }

  // ── 포트 얼굴 ─────────────────────────────────────────────────────────────

  workspacePort(): BrowserWorkspacePort {
    return {
      create: (request, signal) => this.createWorkspace(request, signal),
      list: (signal) => this.listWorkspaces(signal),
      close: (request, workspaceId, signal) => this.closeWorkspace(request, workspaceId, signal),
    };
  }

  operationPort(): BrowserOperationPort {
    return {
      open: (request, url, signal) => this.open(request, url, signal),
      navigate: (request, url, signal) => this.navigate(request, url, signal),
      snapshot: (request, signal) => this.snapshot(request, signal),
      click: (request, target, signal) => this.click(request, target, signal),
      fill: (request, target, value, signal) => this.fill(request, target, value, signal),
      evaluate: (request, script, signal) => this.evaluate(request, script, signal),
      screenshot: (request, signal) => this.screenshot(request, signal),
      close: (request, signal) => this.closePage(request, signal),
    };
  }

  // ── 증거 ─────────────────────────────────────────────────────────────────

  /**
   * 증거 셋 (계약 4.5, FR-ENV-TOOL.6). 스냅샷 참조·캡처 파일·주소 개정이 한 번에 모인다.
   * 셋 중 하나라도 비면 서비스가 완료로 받지 않는다 — 증거 없는 완료를 막는 자리다.
   */
  private async evidence(ctx: OperationContext, request: EnvOperationRequest): Promise<BrowserEvidence> {
    const snapshot = await rpcCall(ctx.client, "snapshot", { options: {}, operationId: request.operationId });
    const shot = await rpcCall(ctx.client, "screenshot", { operationId: request.operationId });
    const info = await rpcCall(ctx.client, "pageInfo", {});
    return {
      snapshotRef: String(snapshot.path ?? ""),
      screenshotRef: String(shot.path ?? ""),
      url: String(info.url ?? ""),
      urlRevision: Number(info.urlRevision ?? 0),
    };
  }

  /**
   * 지금 보고 있는 탭. 요청이 개정을 적어 왔는데 그 사이 주소가 바뀌었으면 **작용하지 않는다**
   * (#582 S3a stale ref). 낡은 참조로 다른 페이지를 누르는 것이 이 검사가 막는 일이다.
   */
  private async checkedTarget(ctx: OperationContext, request: EnvOperationRequest): Promise<string> {
    const info = await rpcCall(ctx.client, "pageInfo", {});
    const targetId = String(info.targetId ?? "");
    if (targetId === "") {
      throw new EnvOperationFailure("context-mismatch", "이 작업 공간에는 볼 탭이 없다");
    }
    if (request.pageId !== undefined && request.pageId !== targetId) {
      throw new EnvOperationFailure(
        "context-mismatch",
        `요청한 페이지(${request.pageId})가 지금 보고 있는 탭(${targetId})이 아니다`,
      );
    }
    const actual = Number(info.urlRevision ?? 0);
    if (!revisionMatches(request.expectedRevision, actual)) {
      throw new EnvOperationFailure(
        "context-mismatch",
        `주소 개정이 다르다 — 기대 ${request.expectedRevision}, 실제 ${actual}. 낡은 참조는 작용시키지 않는다`,
      );
    }
    return targetId;
  }
}

export interface EgoSwitchReport {
  readonly from: string;
  readonly to: string;
  readonly stoppedPid: number | null;
  readonly reconciliation: { readonly status: string; readonly orphans: number; readonly note: string };
  /** 전환한 뒤 쓰는 어댑터. 어댑터 하나는 ADK 하나에 묶인다 — 옛 것은 다시 쓰지 않는다. */
  readonly next: EgoBrowserEnvironment | null;
}

/** 조립에서 쓰는 팩토리. 클래스를 직접 부르는 자리를 하나로 모은다. */
export function createEgoBrowserEnvironment(options: EgoBrowserEnvOptions): EgoBrowserEnvironment {
  return new EgoBrowserEnvironment(options);
}

// ── 보조 (모듈 사설) ────────────────────────────────────────────────────────

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = signal.reason;
    throw reason instanceof EnvOperationFailure ? reason : new EnvOperationFailure("cancelled", "작업이 취소됐다");
  }
}

/** RPC 하나. 감독자는 실패를 던지지 않고 `{error, error_code}` 로 resolve 한다(ABI 6). */
async function rpcCall(
  client: EgoClient,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const value = await client.call(method, params);
  if (value && typeof value === "object" && value.error != null) {
    throw failure(value.error_code, `${method}: ${String(value.error)}`);
  }
  return value;
}

function toWorkspace(resource: unknown): BrowserWorkspace {
  const shape = (resource ?? {}) as { id?: unknown; revision?: unknown };
  return {
    id: String(shape.id ?? ""),
    mode: "headless",
    ownership: "agent",
    revision: Number(shape.revision ?? 0),
  };
}

/**
 * `.env` 에 남겨도 되는 값 (ABI 8).
 *
 * 파일에 남는 것은 **ADK 를 따라다니는 자리**뿐이다. 소켓·토큰·작업 id·시한은 실행마다 다르고
 * 토큰은 단일 사용 비밀이라 파일에 남기지 않는다 — 남기면 다음 실행이 남의 작업에 붙는다.
 */
export const ENV_FILE_KEYS: readonly string[] = ["HOME", "USERPROFILE", "EGO_BROWSER_AGENT_WORKSPACE", "EGO_HOST_EVIDENCE_DIR"];

export function envFileValues(env: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ENV_FILE_KEYS) if (env[key] !== undefined) out[key] = env[key];
  return out;
}

/** 이 작업의 세션 하나. 첫 attach 가 세션을 만들고 그 세션은 작업이 끝날 때 감독자가 걷는다. */
async function attach(ctx: OperationContext, targetId: string): Promise<string> {
  const attached = await ctx.cdp.call("Target.attachToTarget", { targetId, flatten: true });
  const sessionId = String(attached.sessionId ?? "");
  if (sessionId === "") {
    throw new EnvOperationFailure("disconnected", `탭 ${targetId} 에 붙지 못했다`);
  }
  return sessionId;
}

/** 문서가 다 뜰 때까지. 이동이 끝나기 전에 찍은 증거는 이전 페이지의 것이다. */
async function settle(ctx: OperationContext, sessionId: string, signal?: AbortSignal): Promise<void> {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    throwIfAborted(signal);
    const state = await ctx.cdp.call(
      "Runtime.evaluate",
      { expression: "document.readyState", returnByValue: true },
      sessionId,
    );
    if ((state.result as { value?: unknown } | undefined)?.value === "complete") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // 다 안 떴다는 사실을 감춘 채 증거를 만들지 않는다.
  throw new EnvOperationFailure("partial", "페이지가 제한 시간 안에 다 뜨지 않았다");
}

/**
 * 참조가 **지금 이 페이지에** 살아 있는가 (#582 S3a stale ref).
 *
 * `DOM.resolveNode` 만으로는 부족하다 — backendNodeId 는 문서가 바뀌어도 재사용되므로, 옛
 * 페이지에서 딴 참조가 새 페이지의 엉뚱한 요소로 풀리는 일이 실제로 일어난다(이 기계에서 실측).
 * 그래서 지금 스냅샷의 `refs` 에 그 값이 있는지 먼저 본다. 없으면 조작하지 않는다.
 */
async function assertLiveRef(ctx: OperationContext, ref: string): Promise<number> {
  const backendNodeId = Number(ref);
  if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) {
    throw new EnvOperationFailure("context-mismatch", `참조 형식이 아니다: ${ref}`);
  }
  const snapshot = await rpcCall(ctx.client, "snapshot", { options: { record: false } });
  const refs = Array.isArray(snapshot.refs) ? (snapshot.refs as { backendNodeId?: unknown }[]) : [];
  if (!refs.some((entry) => Number(entry.backendNodeId) === backendNodeId)) {
    throw new EnvOperationFailure(
      "context-mismatch",
      `낡은 참조다 — ref=${ref} 는 지금 페이지의 접근성 트리에 없다. 다시 관측하고 다시 고른다`,
    );
  }
  return backendNodeId;
}

async function resolveRef(ctx: OperationContext, sessionId: string, ref: string): Promise<string> {
  const backendNodeId = await assertLiveRef(ctx, ref);
  let resolved: Record<string, unknown>;
  try {
    resolved = await ctx.cdp.call("DOM.resolveNode", { backendNodeId }, sessionId);
  } catch (error) {
    // 사라진 노드는 CDP 가 "찾을 수 없다"로 답한다. 그것이 낡은 참조의 얼굴이다.
    throw new EnvOperationFailure("context-mismatch", `낡은 참조다 — 그 요소가 지금 페이지에 없다 (${describe(error)})`);
  }
  const objectId = ((resolved.object ?? {}) as { objectId?: unknown }).objectId;
  if (typeof objectId !== "string" || objectId === "") {
    throw new EnvOperationFailure("context-mismatch", `낡은 참조다 — 원격 객체를 얻지 못했다: ${ref}`);
  }
  return objectId;
}

/** 참조는 상자 모형의 가운데, 좌표는 적힌 그대로. 좌표를 쓴 사실은 서비스가 결과에 남긴다. */
async function pointOf(
  ctx: OperationContext,
  sessionId: string,
  target: ElementTarget,
): Promise<{ x: number; y: number }> {
  if (target.kind === "coordinate") return { x: target.x, y: target.y };
  const backendNodeId = await assertLiveRef(ctx, target.ref);
  let box: Record<string, unknown>;
  try {
    box = await ctx.cdp.call("DOM.getBoxModel", { backendNodeId }, sessionId);
  } catch (error) {
    throw new EnvOperationFailure("context-mismatch", `낡은 참조다 — 그 요소가 지금 페이지에 없다 (${describe(error)})`);
  }
  const quad = ((box.model ?? {}) as { content?: unknown }).content;
  if (!Array.isArray(quad) || quad.length < 8) {
    throw new EnvOperationFailure("context-mismatch", `요소의 자리를 읽지 못했다: ${target.ref}`);
  }
  const xs = [Number(quad[0]), Number(quad[2]), Number(quad[4]), Number(quad[6])];
  const ys = [Number(quad[1]), Number(quad[3]), Number(quad[5]), Number(quad[7])];
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

/** 감독자의 정리 보고를 사람이 읽는 부분 효과 목록으로. 빈 항목은 싣지 않는다. */
export function describeCleanup(cleanup: unknown): readonly string[] {
  if (!cleanup || typeof cleanup !== "object") return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(cleanup as Record<string, unknown>)) {
    if (!Array.isArray(value) || value.length === 0) continue;
    out.push(`${key}: ${value.map((item) => String(item)).join(", ")}`);
  }
  return out;
}

// ── 기능 플래그가 꺼졌을 때 (계약 4.9) ──────────────────────────────────────

/**
 * "형식 있는 미지원". 플래그가 꺼진 OS 에서 브라우저 포트 자리에 꽂힌다.
 *
 * 아무것도 안 꽂으면 조립이 터지고, 조용히 성공하는 대역을 꽂으면 미검증 OS 에서
 * "브라우저가 됐다"는 거짓 증거가 나온다. 둘 다 아닌 셋째 길이 이것이다.
 */
export function unsupportedBrowserPorts(detail: string): BrowserOperationPort & BrowserWorkspacePort & BrowserScriptPort & CancellationPort {
  const deny = (): never => {
    throw new EnvOperationFailure("method-denied", detail);
  };
  return {
    async create() {
      return deny();
    },
    async list() {
      return deny();
    },
    async close() {
      return deny();
    },
    async open() {
      return deny();
    },
    async navigate() {
      return deny();
    },
    async snapshot() {
      return deny();
    },
    async click() {
      return deny();
    },
    async fill() {
      return deny();
    },
    async evaluate() {
      return deny();
    },
    async screenshot() {
      return deny();
    },
    async script() {
      return deny();
    },
    async cancel() {
      // 취소는 거부하지 않는다. 시작하지 못한 작업의 취소는 "일어난 일 없음"이 정직하다.
      return [];
    },
  };
}
