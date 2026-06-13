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

// ── 실배선 어댑터 (graft) — old invoke 주입. ⚠️ mutating(고위험): 승인 게이트(MutationGate) 통과 후에만 호출됨. ──
// Old-Baseline(F3 §A): writeFile=workspace_write_file{path,content}, execCommand=pty_execute_sync{dir,command},
//   ptyWrite=pty_write{ptyId,data}. ⚠️ applyDiff = os 명령 없음(agent-side tool 'tool.apply_diff') → os mutate 아님.
export interface F3LiveDeps {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

export function makeF3LiveMutate(d: F3LiveDeps): EnvironmentMutatePort {
  return {
    async apply(cmd: MutationCommand): Promise<Ack> {
      switch (cmd.op) {
        case "writeFile":
          // workspace_write_file 은 경로를 validate_in_workspace 로 검증(경계 밖=Err→throw→MutationGate abort).
          await d.invoke("workspace_write_file", { path: cmd.target, content: cmd.body });
          return { accepted: true };
        case "execCommand":
          // ⚠️ 보안 FAIL-CLOSED (F3 리뷰 B-1): pty_execute_sync 는 bash -lc 를 Rust 허용목록 없이 실행하고,
          //    유일 게이트 isBlockedCommand(정규식 blocklist)는 우회 가능(rm -rf /*, fork bomb, curl|bash -s …).
          //    arbitrary shell exec 을 우회가능 blocklist 만으로 라이브 금지 → **신규 계약 전까지 차단**.
          //    신규 계약(GOAL ⑥): (1) Rust 경계 allowlist/capability (2) per-command T3 승인(라이브 approval=UC13)
          //    (3) MutationCommand.cwd(절대경로) 필드. 셋 충족 후 라이브. 그 전엔 정직 거부(가짜 안전 금지).
          throw new Error(`execCommand 보안 미충족(fail-closed): Rust allowlist + T3 승인 + 절대 cwd 신규계약 필요. cmd=${cmd.target}`);
        case "ptyWrite":
          // ⚠️ arg=pty_id (snake). old Terminal.tsx:204 invoke('pty_write',{pty_id,data}) + Rust pty.rs:170. Tauri 미변환(F3 리뷰 BLOCKER).
          await d.invoke("pty_write", { pty_id: cmd.target, data: cmd.body });
          return { accepted: true };
        case "applyDiff":
          // os-local apply_diff 명령 없음 = agent-side tool. os mutate 경로 아님(정직 거부). diff=writeFile(전체) 또는 agent tool.
          throw new Error(`applyDiff 는 os mutate 아님(agent-side tool) — writeFile 또는 agent 경로: ${cmd.target}`);
      }
    },
  };
}
