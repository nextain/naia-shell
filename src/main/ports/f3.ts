// ports/f3 — F3 driven 인터페이스 (contract §B.2). domain 만 의존. async.
import type { MutationCommand, Ack } from "../domain/mutate.js";

export interface EnvironmentMutatePort {
  /** op별 라우팅(writeFile/applyDiff/execCommand/ptyWrite)은 adapter. 승인 게이트 통과 후에만 호출. */
  apply(cmd: MutationCommand): Promise<Ack>;
}

export type { MutationCommand, Ack };
