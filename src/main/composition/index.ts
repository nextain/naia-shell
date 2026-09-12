// composition root — F0 (contract §B.5). 와이어링은 이 1곳에만.
// 슬라이스는 Factory/Registry 포트만 노출 → 여기서 주입.
import { ControlPlaneBoot, type ControlPlanePorts } from "../app/control/boot.js";
import {
  tauriConfig, tauriBootState, tauriAdkPath, tauriWorkspace,
  tauriStartup, tauriApps, tauriSetup,
} from "../adapters/tauri/index.js";

/** Tauri 어댑터 주입한 control-plane (라이브). */
export function wireControlPlaneTauri(): ControlPlaneBoot {
  const ports: ControlPlanePorts = {
    config: tauriConfig,
    bootState: tauriBootState,
    adkPath: tauriAdkPath,
    workspace: tauriWorkspace,
    startup: tauriStartup,
    apps: tauriApps,
    setup: tauriSetup,
  };
  return new ControlPlaneBoot(ports);
}

/** 임의 포트 주입 (테스트/대체 substrate). */
export function wireControlPlane(ports: ControlPlanePorts): ControlPlaneBoot {
  return new ControlPlaneBoot(ports);
}

// ── F1 슬라이스 (자기상태/진단 + 승인) ──
import { StatusReporter } from "../app/control/status.js";
import { ApprovalGate } from "../app/control/approval.js";
import { tauriInteroceptive, agentWireApproval, configGrant, makeF1LiveAdapters, type F1LiveDeps } from "../adapters/tauri/f1.js";

export function wireStatusReporterTauri(): StatusReporter {
  return new StatusReporter(tauriInteroceptive);
}
export function wireApprovalGateTauri(): ApprovalGate {
  return new ApprovalGate({ approval: agentWireApproval, grant: configGrant });
}

// F1 실배선(graft): 자기상태(devices/agent-health) + 영구 grant. ⚠️ approval.request 라이브 = UC13/F3 gRPC chat-approval.
export function wireStatusReporterLive(deps: F1LiveDeps): StatusReporter {
  return new StatusReporter(makeF1LiveAdapters(deps).interoceptive);
}
export function wireApprovalGateLive(deps: F1LiveDeps): ApprovalGate {
  // grant=live(config), approval=locked 계약 stub(UC13 에서 gRPC chat-approval 로 라이브). F1 = 선잠금.
  return new ApprovalGate({ approval: agentWireApproval, grant: makeF1LiveAdapters(deps).grant });
}

// ── F2 슬라이스 (host-system 관측 + drift) ──
import { ObservationService, DriftDetector } from "../app/control/observe.js";
import {
  tauriEnvObserve, expectedStateProvider,
  makeF2EnvObserve, makeF2ExpectedState, type F2LiveDeps,
} from "../adapters/tauri/f2.js";
import type { DriftSignal } from "../domain/observe.js";

export function wireObservationServiceTauri(now: () => number): ObservationService {
  return new ObservationService(tauriEnvObserve, now);
}
export function wireDriftDetectorTauri(onDrift: (d: DriftSignal) => void): DriftDetector {
  return new DriftDetector(tauriEnvObserve, expectedStateProvider, onDrift);
}

// F2 실배선 (graft: old invoke/listen 주입) — F0 live(wireControlPlaneLive)와 동일 패턴.
export function wireObservationServiceLive(deps: F2LiveDeps, now: () => number): ObservationService {
  return new ObservationService(makeF2EnvObserve(deps), now);
}
export function wireDriftDetectorLive(deps: F2LiveDeps, onDrift: (d: DriftSignal) => void): DriftDetector {
  return new DriftDetector(makeF2EnvObserve(deps), makeF2ExpectedState(deps), onDrift);
}

// ── F0 실배선 (graft: old 함수 주입) ──
import { makeF0LiveAdapters, type LiveDeps } from "../adapters/tauri/live.js";
export function wireControlPlaneLive(deps: LiveDeps): ControlPlaneBoot {
  return new ControlPlaneBoot(makeF0LiveAdapters(deps));
}

// ── F3 슬라이스 (승인먼저 mutate + reafference) ──
import { MutationGate } from "../app/control/mutate.js";
import { tauriMutate, makeF3LiveMutate } from "../adapters/tauri/f3.js";
export function wireMutationGateTauri(approvalGate: ApprovalGate): MutationGate {
  return new MutationGate({ approvalGate, mutate: tauriMutate, observe: tauriEnvObserve });
}

// F3 실배선(graft): 승인먼저(approvalGate)→mutate(live)→observe(live F2 reafference). ⚠️ 고위험 mutating.
// approvalGate 는 caller 가 조립(F1 wireApprovalGateLive — approval=UC13 라이브 전 잠금 stub=fail-closed).
export function wireMutationGateLive(deps: F2LiveDeps, approvalGate: ApprovalGate): MutationGate {
  return new MutationGate({ approvalGate, mutate: makeF3LiveMutate(deps), observe: makeF2EnvObserve(deps) });
}

// ── UC1 수평 슬라이스 (ChatPort + transport + demux router) ──
import { ChatService } from "../app/chat/chat-service.js";
import { InMemoryClientSession } from "../app/chat/client-session.js";
import { MessageRouter } from "../adapters/message-router.js";
import { stdioTransport, makeLiveStdioTransport, type LiveTransportDeps } from "../adapters/tauri/uc1.js";
import { ChatBridge } from "../adapters/chat-bridge.js";
import type { AgentTransportPort, PendingRouteSink, DiagnosticSink } from "../ports/uc1.js";

/**
 * UC1 대화 와이어링. transport·sessions·router·sink 주입.
 * - `opts.live` 주입 시 = 라이브 Tauri 어댑터(실 invoke/listen). 미주입 = NotWired stdioTransport(테스트/배선 전).
 * - router.start() 호출 = AgentTransportPort.onMessage 단일 구독 개시(라이브 trace 시작).
 */
export function wireChatUC1(opts?: {
  live?: LiveTransportDeps;
  pending?: PendingRouteSink;
  diagnostic?: DiagnosticSink;
  /** 이 클라이언트 신원(bridge). 미주입 시 "shell". */
  clientId?: string;
  /** turn 마다 고유 requestId 생성(§B.4.1). 미주입 시 baseline 패턴(req-ts-rand). shell 은 crypto.randomUUID 권장. */
  newRequestId?: () => string;
}): { chat: ChatService; router: MessageRouter; sessions: InMemoryClientSession; bridge: ChatBridge } {
  const sessions = new InMemoryClientSession();
  const transport: AgentTransportPort = opts?.live ? makeLiveStdioTransport(opts.live) : stdioTransport;
  const chat = new ChatService(transport, sessions);
  const pending: PendingRouteSink = opts?.pending ?? { pending: (m) => console.warn("[UC1 pending route]", m.type) };
  const diagnostic: DiagnosticSink = opts?.diagnostic ?? { diagnose: (m, reason) => console.error("[UC1 diagnostic]", m.type, reason) };
  const router = new MessageRouter({ transport, chat, sessions, pending, diagnostic });
  const bridge = new ChatBridge({
    chat,
    clientId: opts?.clientId ?? "shell",
    newRequestId: opts?.newRequestId ?? defaultRequestId,
  });
  return { chat, router, sessions, bridge };
}

// fallback 생성기 — shell 미주입 시만 사용(실 shell 은 crypto.randomUUID 주입 권장, §B.4.1).
// ⚠️ `__reqSeq` = **모듈 전역**(composition 마다 초기화 X — 모든 wireChatUC1 호출이 공유) → 프로세스 내 단조 고유.
//    프로세스 *간*(다중 창/인스턴스) 충돌 완화 위해 Date.now 결합(baseline generateRequestId 등가). 강한 보장이 필요하면 shell 이 randomUUID 주입.
let __reqSeq = 0;
function defaultRequestId(): string {
  __reqSeq += 1;
  return `req-${Date.now()}-${__reqSeq}-${Math.random().toString(36).slice(2, 7)}`;
}

// ── UC12 슬라이스 (온보딩/설정) — 기존 F0 live 어댑터 + UC12 live 어댑터 조립 ──
import { OnboardingController } from "../app/control/onboarding.js";
import { makeUC12LiveAdapters, type UC12LiveDeps } from "../adapters/tauri/uc12.js";

/** shell 이 old 함수(F0 LiveDeps) + UC12 deps 주입 → OnboardingController 실배선.
 *  config/bootState/adkPath = F0 live 재사용, assets/gateway/oauth = UC12 live, creds = write_agent_key invoke. */
export function wireOnboardingLive(f0: LiveDeps, uc12: UC12LiveDeps): OnboardingController {
  const base = makeF0LiveAdapters(f0);
  const u = makeUC12LiveAdapters(uc12);
  return new OnboardingController({
    assets: u.assets,
    oauth: u.oauth,
    config: base.config,
    bootState: base.bootState,
    adkPath: base.adkPath,
    creds: {
      async writeAgentKey(envKey, value) {
        const p = f0.getAdkPath();
        if (p) await uc12.invoke("write_agent_key", { adkPath: p, envKey, value });
      },
    },
  });
}

// ── #501 슬라이스 (워크스페이스 컨텍스트 해석) ──
import { WorkspaceContextService } from "../app/control/workspace-context.js";
import { ObservePortWorkspaceContextAdapter } from "../adapters/workspace-context-observe.js";
import type { EnvironmentObservePort } from "../ports/f2.js";
import type { LoadLimits } from "../domain/workspace-context.js";

/** 기본 로드 상한. 대화 한 번에 워크스페이스 전체를 밀어 넣지 않기 위한 값이다. */
export const DEFAULT_CONTEXT_LIMITS: LoadLimits = { maxDocuments: 20, maxBytes: 512 * 1024 };

/** 셸에서 쓰는 실배선 — 파일 접근은 이미 있는 F2 관측 포트를 재사용한다. */
export function wireWorkspaceContext(env: EnvironmentObservePort, limits: LoadLimits = DEFAULT_CONTEXT_LIMITS): WorkspaceContextService {
  return new WorkspaceContextService(new ObservePortWorkspaceContextAdapter(env), limits);
}

/** Tauri 실배선 — F2 관측 어댑터를 그대로 재사용한다. 파일 접근 경로를 두 벌 만들지 않는다. */
export function wireWorkspaceContextLive(deps: F2LiveDeps, limits: LoadLimits = DEFAULT_CONTEXT_LIMITS): WorkspaceContextService {
  return new WorkspaceContextService(new ObservePortWorkspaceContextAdapter(makeF2EnvObserve(deps)), limits);
}

export { WorkspaceContextService, StaleRevisionError } from "../app/control/workspace-context.js";
export { canonicalRoot } from "../domain/workspace.js";
export type { CanonicalRoot } from "../domain/workspace.js";
export type { ContextManifest, ContextRevision, ContextScope, Diagnostic, LoadIntent, LoadedDocument, Selection } from "../domain/workspace-context.js";
export type { ResolveOutcome } from "../app/control/workspace-context.js";

// ── #502 환경 접점 (실배선) ──
// 셸 UI 가 세션 하나를 들고 관측·조작을 이 경계로만 한다. Herdr 어휘는 여기서 멈춘다.
export { EnvironmentSession, PERMITTED_INTENTS, WATCH_TURN_BUDGET, type ActOutcome, type EnvironmentAwareness } from "../app/control/environment-session.js";
export { ALLOWED_METHODS, type DispatchGrants, type DispatchOutcome } from "../app/control/environment-dispatch.js";
export { surfaceRef, type EnvironmentIntent, type EnvironmentReport, type SurfaceReport } from "../domain/environment-intent.js";
export type { EnvironmentCommandPort } from "../ports/environment-dispatch.js";

// ── #582 환경 도구 브라우저 (실배선) ──
// 감독자 어댑터는 어디에서 조립되는지가 계약이다. 여기 한 곳에서만 만든다 — 셸이 자기 자리에서
// `new EgoBrowserEnvironment` 를 부르기 시작하면 기능 플래그를 지나지 않는 두 번째 길이 생긴다.
import { EnvironmentToolService } from "../app/control/env-tool.js";
import {
  createEgoBrowserEnvironment,
  unsupportedBrowserPorts,
  type EgoBrowserEnvironment,
  type EgoHostApi,
  type EgoPlatform,
} from "../adapters/ego-browser-env.js";
import type { BrowserOperationPort, BrowserScriptPort, BrowserWorkspacePort, CancellationPort, TerminalOperationPort } from "../ports/env-tool.js";
import { ALL_TIERS, type CapabilityTier } from "../domain/capability.js";
import { EnvOperationFailure } from "../domain/env-tool.js";

/**
 * 기능 플래그 (계약 4.9). 리눅스는 실측을 통과했으므로 기본이 켬이고, 윈도우·macOS 는
 * 실측 게이트를 통과하기 전이라 기본이 끔이다. 값이 있으면 사람이 정한 값이 이긴다.
 */
export function egoHostEnabled(platform: EgoPlatform, flag?: string | boolean): boolean {
  if (typeof flag === "boolean") return flag;
  if (typeof flag === "string" && flag !== "") {
    const value = flag.trim().toLowerCase();
    if (["1", "true", "on", "yes"].includes(value)) return true;
    if (["0", "false", "off", "no"].includes(value)) return false;
  }
  return platform === "linux";
}

export interface EnvironmentToolLiveDeps {
  /** `<ADK>` 루트. 감독자의 lease·프로필·소켓·증거가 전부 이 아래다. */
  readonly adkDir: string;
  readonly platform?: EgoPlatform;
  /** 상대 ADK 경로를 풀 자리. 셸은 절대 경로를 주는 편이 낫다. */
  readonly cwd?: string;
  readonly home?: string;
  readonly baseEnv?: Readonly<Record<string, string>>;
  readonly executable?: string;
  readonly runtimeDir?: string;
  /** `NAIA_EGO_HOST`. 셸이 환경에서 읽어 그대로 넘긴다. */
  readonly egoHostFlag?: string | boolean;
  readonly grantedTiers?: readonly CapabilityTier[];
  /** Herdr 쪽 터미널 포트. 없으면 터미널 실행은 형식 있는 오류로 끝난다. */
  readonly terminal?: TerminalOperationPort;
  readonly loadApi?: () => Promise<EgoHostApi>;
}

export interface EnvironmentToolWiring {
  readonly service: EnvironmentToolService;
  /** 플래그가 꺼졌으면 null. 셸 종료 경로가 `stop()` 을 부를 대상이 없다는 뜻이다. */
  readonly environment: EgoBrowserEnvironment | null;
  readonly enabled: boolean;
}

const NOT_WIRED_TERMINAL: TerminalOperationPort = {
  async exec() {
    throw new EnvOperationFailure("method-denied", "이 조립에는 터미널 포트가 없다");
  },
};

/**
 * #499·#582 환경 도구 실배선. 플래그가 꺼진 OS 에서는 어댑터 대신 **형식 있는 미지원** 포트를
 * 꽂는다 — 조용히 성공하는 대역을 꽂으면 미검증 OS 에서 "브라우저가 됐다"는 거짓 증거가 나온다.
 */
export function makeEnvironmentToolService(deps: EnvironmentToolLiveDeps): EnvironmentToolWiring {
  const platform = deps.platform ?? "linux";
  const enabled = egoHostEnabled(platform, deps.egoHostFlag);
  const terminal = deps.terminal ?? NOT_WIRED_TERMINAL;
  const tiers = deps.grantedTiers ?? ALL_TIERS;
  if (!enabled) {
    const denied = unsupportedBrowserPorts(
      `에이전트 브라우저 호스트는 ${platform} 에서 아직 켜지지 않았다(#582 계약 4.9 OS 게이트).`,
    );
    return {
      service: new EnvironmentToolService(denied, terminal, denied, tiers, denied, denied),
      environment: null,
      enabled: false,
    };
  }
  const environment = createEgoBrowserEnvironment({
    adkDir: deps.adkDir,
    platform,
    ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
    ...(deps.home !== undefined ? { home: deps.home } : {}),
    ...(deps.baseEnv !== undefined ? { baseEnv: deps.baseEnv } : {}),
    ...(deps.executable !== undefined ? { executable: deps.executable } : {}),
    ...(deps.runtimeDir !== undefined ? { runtimeDir: deps.runtimeDir } : {}),
    ...(deps.loadApi !== undefined ? { loadApi: deps.loadApi } : {}),
  });
  const browser: BrowserOperationPort = environment.operationPort();
  const workspaces: BrowserWorkspacePort = environment.workspacePort();
  const scripts: BrowserScriptPort = environment;
  const cancellation: CancellationPort = environment;
  return {
    service: new EnvironmentToolService(browser, terminal, cancellation, tiers, workspaces, scripts),
    environment,
    enabled: true,
  };
}

export { EnvironmentToolService } from "../app/control/env-tool.js";
export { BROWSER_RPC_TIERS, BROWSER_RPCS_REQUIRING_APPROVAL, TERMINAL_EXEC_TIER_FLOOR } from "../app/control/env-tool.js";
export type { BrowserRpc, CompletedOperation, EnvOutcome, OperationSnapshot, ResourceOutcome } from "../app/control/env-tool.js";
export type {
  BrowserEvidence,
  BrowserWorkspace,
  ElementTarget,
  EnvFailureReason,
  EnvOperationRequest,
  EnvRejection,
  Evidence,
  OperationState,
  Termination,
} from "../domain/env-tool.js";
export { ALL_TIERS } from "../domain/capability.js";
export type { CapabilityTier } from "../domain/capability.js";
export { createEgoBrowserEnvironment, unsupportedBrowserPorts } from "../adapters/ego-browser-env.js";
export type { EgoBrowserEnvOptions, EgoPlatform, EgoSwitchReport } from "../adapters/ego-browser-env.js";
// #582 S6c: 셸이 감독자 모듈 자리에 IPC 구현을 꽂으려면 그 면의 타입이 필요하다.
export type { EgoGrant, EgoHostApi } from "../adapters/ego-browser-env.js";
