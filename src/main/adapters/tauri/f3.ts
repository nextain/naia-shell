// adapters/tauri/f3 — F3 driven adapter STUB (contract §B.4). 라이브 배선 대기 (async).
import type { EnvironmentMutatePort, MutationCommand, Ack } from "../../ports/f3.js";

class NotWired extends Error {
  constructor(cmd: string) { super(`Tauri adapter not wired (라이브 trace 대기): ${cmd}`); }
}

/** op별 라우팅 = 실배선 시 write_file/apply_diff/execute_command/pty_write 로. */
export const tauriMutate: EnvironmentMutatePort = {
  async apply(cmd: MutationCommand): Promise<Ack> {
    throw new NotWired(`mutate:${cmd.op}`);
  },
};
