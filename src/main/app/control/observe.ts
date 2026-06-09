// app/control/observe — F2 (contract §B.3). 포트만 사용. 인지 0.
import type { EnvironmentObservePort, ExpectedStateProviderPort, FileChangeEvent, ReadResult } from "../../ports/f2.js";
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
  async listDir(path: string): Promise<ObservationPayload<readonly string[]>> {
    return { result: await this.env.listDir(path), timestamp: this.now() };
  }
}

export class DriftDetector {
  constructor(
    private readonly env: EnvironmentObservePort,
    private readonly expectedProvider: ExpectedStateProviderPort,
    private readonly onDrift: (d: DriftSignal) => void,
  ) {}

  /** subscribeChanges 구독. 외부변경 → observed vs expected(권위 우선) → drift 보고(contain). */
  start(): void {
    this.env.subscribeChanges((evt) => { void this.handleChange(evt); });
  }

  /** FR-F2 drift: expected 권위 우선순위(goal>approvedIntent>lastSnapshot). 실패는 contain(상위 오염 X). */
  async handleChange(evt: FileChangeEvent): Promise<DriftSignal | null> {
    const observed: ObservedState = { key: evt.file, value: (await this.env.fileStatus(evt.file)).value };
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

