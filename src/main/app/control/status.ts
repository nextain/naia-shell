// app/control/StatusReporter — F1 (contract §B.3 ①). 정직 자기상태. 인지 0.
import type { InteroceptivePort } from "../../ports/f1.js";
import { isDegraded, type DegradationSignal, type SystemStatus } from "../../domain/degradation.js";

export interface HonestStatusReport {
  readonly system: SystemStatus | null; // 조회 실패 시 null (contain)
  readonly degraded: readonly DegradationSignal[]; // configured && !reachable 만
  readonly probeErrors: readonly string[]; // contain 된 포트 예외 (정직 표면화)
  readonly allClear: boolean; // degradation 0 + 모든 component healthy + probe 에러 0
}

export class StatusReporter {
  constructor(private readonly interoceptive: InteroceptivePort) {}

  /**
   * 정직 보고: key-presence 를 connection 으로 승격 금지(오보 금지, FR-F1.1).
   * FR-F1.3: 포트 예외는 contain(throw 전파 금지) + 정직 표면화 → planning 오염 차단.
   */
  async report(): Promise<HonestStatusReport> {
    const probeErrors: string[] = [];
    let system: SystemStatus | null = null;
    try { system = await this.interoceptive.systemStatus(); } catch (e) { probeErrors.push(`systemStatus: ${String(e)}`); }
    let degraded: DegradationSignal[] = [];
    try { degraded = (await this.interoceptive.degradations()).filter(isDegraded); } catch (e) { probeErrors.push(`degradations: ${String(e)}`); }

    const componentsHealthy = system ? system.components.every((c) => c.healthy) : false;
    const allClear = degraded.length === 0 && probeErrors.length === 0 && componentsHealthy;
    return { system, degraded, probeErrors, allClear };
  }
}
