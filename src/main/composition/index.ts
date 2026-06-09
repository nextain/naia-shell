// composition root — F0 (contract §B.5). 와이어링은 이 1곳에만.
// 슬라이스는 Factory/Registry 포트만 노출 → 여기서 주입.
import { ControlPlaneBoot, type ControlPlanePorts } from "../app/control/boot.js";
import {
  tauriConfig, tauriBootState, tauriAdkPath, tauriWorkspace,
  tauriStartup, tauriPanels, tauriSetup,
} from "../adapters/tauri/index.js";

/** Tauri 어댑터 주입한 control-plane (라이브). */
export function wireControlPlaneTauri(): ControlPlaneBoot {
  const ports: ControlPlanePorts = {
    config: tauriConfig,
    bootState: tauriBootState,
    adkPath: tauriAdkPath,
    workspace: tauriWorkspace,
    startup: tauriStartup,
    panels: tauriPanels,
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
import { tauriInteroceptive, agentWireApproval, configGrant } from "../adapters/tauri/f1.js";

export function wireStatusReporterTauri(): StatusReporter {
  return new StatusReporter(tauriInteroceptive);
}
export function wireApprovalGateTauri(): ApprovalGate {
  return new ApprovalGate({ approval: agentWireApproval, grant: configGrant });
}

// ── F2 슬라이스 (host-system 관측 + drift) ──
import { ObservationService, DriftDetector } from "../app/control/observe.js";
import { tauriEnvObserve, expectedStateProvider } from "../adapters/tauri/f2.js";
import type { DriftSignal } from "../domain/observe.js";

export function wireObservationServiceTauri(now: () => number): ObservationService {
  return new ObservationService(tauriEnvObserve, now);
}
export function wireDriftDetectorTauri(onDrift: (d: DriftSignal) => void): DriftDetector {
  return new DriftDetector(tauriEnvObserve, expectedStateProvider, onDrift);
}

// ── F0 실배선 (graft: old 함수 주입) ──
import { makeF0LiveAdapters, type LiveDeps } from "../adapters/tauri/live.js";
export function wireControlPlaneLive(deps: LiveDeps): ControlPlaneBoot {
  return new ControlPlaneBoot(makeF0LiveAdapters(deps));
}

// ── F3 슬라이스 (승인먼저 mutate + reafference) ──
import { MutationGate } from "../app/control/mutate.js";
import { tauriMutate } from "../adapters/tauri/f3.js";
export function wireMutationGateTauri(approvalGate: ApprovalGate): MutationGate {
  return new MutationGate({ approvalGate, mutate: tauriMutate, observe: tauriEnvObserve });
}

// ── UC1 수평 슬라이스 (ChatPort + transport + demux router) ──
import { ChatService } from "../app/chat/chat-service.js";
import { InMemoryClientSession } from "../app/chat/client-session.js";
import { MessageRouter } from "../adapters/message-router.js";
import { stdioTransport } from "../adapters/tauri/uc1.js";
import type { PendingRouteSink, DiagnosticSink } from "../ports/uc1.js";

/**
 * UC1 대화 와이어링. transport(stdio)·sessions·router·sink 주입.
 * router.start() 호출 = AgentTransportPort.onMessage 단일 구독 개시.
 * sink 미주입 시 console 기본(라이브 trace 전까지). 실배선 = stdioTransport 가 NotWired(send/onMessage) 풀리면 동작.
 */
export function wireChatUC1(sinks?: { pending?: PendingRouteSink; diagnostic?: DiagnosticSink }): {
  chat: ChatService; router: MessageRouter; sessions: InMemoryClientSession;
} {
  const sessions = new InMemoryClientSession();
  const chat = new ChatService(stdioTransport, sessions);
  const pending: PendingRouteSink = sinks?.pending ?? { pending: (m) => console.warn("[UC1 pending route]", m.type) };
  const diagnostic: DiagnosticSink = sinks?.diagnostic ?? { diagnose: (m, reason) => console.error("[UC1 diagnostic]", m.type, reason) };
  const router = new MessageRouter({ transport: stdioTransport, chat, sessions, pending, diagnostic });
  return { chat, router, sessions };
}
