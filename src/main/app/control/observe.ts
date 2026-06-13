// app/control/observe — F2 (contract §B.3). 포트만 사용. 인지 0.
import { isDenied } from "../../ports/f2.js";
import type { EnvironmentObservePort, ExpectedStateProviderPort, FileChangeEvent, ReadResult, DirEntryInfo, Unsubscribe } from "../../ports/f2.js";
import { resolveExpected, detectDrift, type DriftSignal, type ObservedState } from "../../domain/observe.js";

export interface ObservationPayload<T> {
  readonly result: ReadResult<T>;
  readonly timestamp: number; // 신선도 (NFR-transparency)
}

export class ObservationService {
  constructor(
    private readonly env: EnvironmentObservePort,
    private readonly now: () => number,
  ) {}

  /** 권한 밖=PermissionDenied 정직 반환 (FR-F2). 신선도 동반. */
  async readFile(path: string): Promise<ObservationPayload<string>> {
    return { result: await this.env.readFile(path), timestamp: this.now() };
  }
  async listDir(path: string): Promise<ObservationPayload<readonly DirEntryInfo[]>> {
    return { result: await this.env.listDir(path), timestamp: this.now() };
  }
}

export class DriftDetector {
  private unsub: Unsubscribe | null = null;
  constructor(
    private readonly env: EnvironmentObservePort,
    private readonly expectedProvider: ExpectedStateProviderPort,
    private readonly onDrift: (d: DriftSignal) => void,
  ) {}

  /** subscribeChanges 구독. 외부변경 → observed vs expected(권위 우선) → drift 보고(contain).
   *  ⚠️ Unsubscribe 를 *보관*해야 누수 안 됨(F2-3 review NI-1: 포트가 반환해도 소비자가 버리면 누수). */
  start(): void {
    this.unsub?.();
    this.unsub = this.env.subscribeChanges((evt) => { void this.handleChange(evt); });
  }

  /** 구독 해제(누수 방지). 재-start 시 자동 해제도 보장. */
  stop(): void {
    this.unsub?.();
    this.unsub = null;
  }

  /** FR-F2 drift: expected 권위 우선순위(goal>approvedIntent>lastSnapshot). 실패는 contain(상위 오염 X). */
  async handleChange(evt: FileChangeEvent): Promise<DriftSignal | null> {
    const status = await this.env.fileStatus(evt.file);
    if (isDenied(status)) return null; // 거부 = 권한 경계 밖, drift 판정 아님(contain, 상위 오염 X)
    const observed: ObservedState = { key: evt.file, value: status.value };
    const expected = resolveExpected(
      await this.expectedProvider.goal(),
      await this.expectedProvider.approvedIntent(),
      await this.expectedProvider.lastSnapshot(evt.file),
    );
    const drift = detectDrift(observed, expected);
    if (drift) this.onDrift(drift);
    return drift;
  }
}

