// domain/degradation — F1 (contract §B.1 DegradationSignal). 순수. 오보 금지의 핵심.

/** key-presence(configured) 와 connection-state(reachable) 분리. */
export interface DegradationSignal {
  readonly component: string;
  readonly configured: boolean; // 설정/키 저장됨
  readonly reachable: boolean; // 실제 연결됨
}

/** 정직 규칙: 키 있어도 unreachable = degraded (FR-F1.1 오보 금지). */
export function isDegraded(s: DegradationSignal): boolean {
  return s.configured && !s.reachable;
}

export interface SystemStatus {
  readonly components: readonly { name: string; healthy: boolean }[];
}

export interface DeviceStatus {
  readonly kind: string;
  readonly available: boolean;
}
