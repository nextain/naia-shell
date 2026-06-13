// adapters/tauri/f1 — F1 driven adapter STUBS (contract §B.4). 라이브 배선 대기 (async).
import type {
  InteroceptivePort, ApprovalPort, PersistentGrantPort,
  SystemStatus, DeviceStatus, DegradationSignal, Tier, ApprovalRequest, ApprovalBinding, ApprovalDecision,
} from "../../ports/f1.js";

class NotWired extends Error {
  constructor(cmd: string) { super(`Tauri adapter not wired (라이브 trace 대기): ${cmd}`); }
}

export const tauriInteroceptive: InteroceptivePort = {
  async systemStatus(): Promise<SystemStatus> { throw new NotWired("gateway_health/skill_system_status"); },
  async diagnostics(): Promise<readonly unknown[]> { throw new NotWired("skill_diagnostics"); },
  async devices(): Promise<readonly DeviceStatus[]> { throw new NotWired("list_audio_output_devices"); },
  async degradations(): Promise<readonly DegradationSignal[]> { throw new NotWired("registry.fetchModels(connected)+probe"); },
};

export const agentWireApproval: ApprovalPort = {
  async classify(_t: string, _a: Readonly<Record<string, unknown>>): Promise<Tier> { throw new NotWired("tool-tiers classify"); },
  async request(_r: ApprovalRequest, _b: ApprovalBinding): Promise<ApprovalDecision> { throw new NotWired("waitForApproval/send_to_agent_command"); },
};

export const configGrant: PersistentGrantPort = {
  async isAllowed(_t: string): Promise<boolean> { throw new NotWired("isToolAllowed"); },
  async add(_t: string): Promise<void> { throw new NotWired("addAllowedTool"); },
};

// ── 실배선 어댑터 (graft) — old invoke/config 주입. F2/F0 와 동일 철학(@tauri-apps 미import). ──
// Old-Baseline(F1 §A): devices=list_audio_output_devices, grant=isToolAllowed/addAllowedTool(config.allowedTools).
// ⚠️ 정정(F1 리뷰): systemStatus/degradations 는 **지금 배선 가능** — old gateway_health(lib.rs:2179 child.try_wait())는
//    RPC 아니라 os-local agent 프로세스 liveness 였음. 새 arch 도 agent 를 child+GRPC_LISTENING 으로 spawn → 동일 신호 존재.
//    → graft 시 `agentReachable = () => (child-alive || grpc-ready)` 주입하면 정직 보고. 미주입 시 빈 결과="모름"(false-healthy 절대 금지, FR-F1.1).
//    **신규 gRPC Diagnostics RPC 가 필요한 것은 rich payload 뿐**(gateway version/uptime/methods = old skill_diagnostics→gateway).
//    diagnostics: os-local 로그 tail(read_local_binary)은 후속 이식 가능, gateway status 만 RPC. approval.request 라이브 = UC13/F3 gRPC chat-approval.

export interface F1LiveDeps {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  isToolAllowed: (tool: string) => boolean;        // old config.ts:534
  addAllowedTool: (tool: string) => void;          // old config.ts:539
  /** os-local gRPC agent 연결 도달성(있으면 systemStatus/degradation 을 정직 보고; 없으면 "모름"=빈 결과). */
  agentReachable?: () => Promise<boolean>;
  /** agent provider/설정이 구성됐는가(degradation: configured&&!reachable 판정용). 기본 true(설정 로딩 후 호출 전제). */
  agentConfigured?: () => boolean;
}

interface OldAudioDevice { readonly id: string; readonly label: string }

/** old 함수 주입 → F1 자기상태 read(devices) + 영구 grant 실배선. */
export function makeF1LiveAdapters(d: F1LiveDeps): { interoceptive: InteroceptivePort; grant: PersistentGrantPort } {
  return {
    interoceptive: {
      // ⚠️ agent/gateway 컴포넌트 health 는 gRPC Diagnostics 계약(후속). 현재 os-local agent 연결만 정직 보고.
      async systemStatus(): Promise<SystemStatus> {
        if (!d.agentReachable) return { components: [] }; // 모름(오보 금지)
        return { components: [{ name: "agent", healthy: await d.agentReachable() }] };
      },
      // diagnostics(health+로그 요약) = gRPC Diagnostics RPC 부재 → 신규 계약 전까지 빈 결과(deferred).
      async diagnostics(): Promise<readonly unknown[]> { return []; },
      // device: list_audio_output_devices(PipeWire, Linux) → DeviceStatus. (browser perm 은 별도 facet.)
      async devices(): Promise<readonly DeviceStatus[]> {
        const list = (await d.invoke("list_audio_output_devices")) as OldAudioDevice[];
        return list.map((x) => ({ kind: x.label, available: true }));
      },
      // degradation probe(도달성)=adapter, isDegraded 판정=domain. agentReachable 없으면 빈 결과(모름).
      async degradations(): Promise<readonly DegradationSignal[]> {
        if (!d.agentReachable) return [];
        return [{ component: "agent", configured: d.agentConfigured ? d.agentConfigured() : true, reachable: await d.agentReachable() }];
      },
    },
    grant: {
      async isAllowed(tool: string): Promise<boolean> { return d.isToolAllowed(tool); },
      async add(tool: string): Promise<void> { d.addAllowedTool(tool); },
    },
  };
}
