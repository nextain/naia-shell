// app/control/StatusReporter — F1 (contract §B.3 ①). 정직 자기상태. 인지 0.
import type { InteroceptivePort } from "../../ports/f1.js";
import { isDegraded, type DegradationSignal, type SystemStatus } from "../../domain/degradation.js";

export interface HonestStatusReport {
  readonly system: SystemStatus;
  readonly degraded: readonly DegradationSignal[]; // configured && !reachable 만
  readonly allClear: boolean;
}

export class StatusReporter {
  constructor(private readonly interoceptive: InteroceptivePort) {}

  /** 정직 보고: key-presence 를 connection 으로 승격 금지(오보 금지, FR-F1.1). */
  report(): HonestStatusReport {
    const system = this.interoceptive.systemStatus();
    const degraded = this.interoceptive.degradations().filter(isDegraded);
    return { system, degraded, allClear: degraded.length === 0 };
  }
  // FR-F1.3: 이 보고 실패/degradation 은 contain — planning/route/skill 입력 오염 전파 금지.
  // (오염 격리는 호출자가 report() 결과를 planning 입력에 직접 결합하지 않음으로 보장.)
}
