// harness/bench-execution — #498 실행부 (BenchExecutionPort 구현). node 전용이라 여기 둔다.
//
// 여태 이 자리가 비어 있었다. 시나리오 목록과 판정 규칙은 있는데 실제로 돌려 보는 것이
// 없어서 벤치는 "무엇을 확인해야 하는가"의 목록일 뿐이었다(2026-08-26 실측).
//
// 원칙 세 가지.
//   1) 증거는 실제로 돌린 결과에서만 나온다. 명령이 실패하면 영수증을 만들지 않는다.
//   2) 확인 수단이 없는 시나리오는 조용히 넘어가지 않고 증거 없음으로 남는다 — 벤치의
//      쓸모는 통과 개수가 아니라 "무엇이 아직 증명되지 않았나"를 정확히 말하는 것이다.
//   3) 완료 주장은 실행부가 만들지 않는다. `docs/requirements.md` 가 Done 이라고 적은 것을
//      주장으로 읽는다 — 문서가 완료를 말하고 벤치가 증거를 요구하는 구조라야
//      거짓 완료 탐지가 의미를 갖는다.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type {
  BenchScenario,
  CompletionClaim,
  EvidenceKind,
  EvidenceReceipt,
  SafetyObservation,
  TraceRecord,
} from "../../main/domain/agent-bench.js";
import type { BenchExecutionPort, ScenarioRun } from "../../main/ports/agent-bench.js";
import { parseScenarios } from "./agent-bench-scenarios.js";

/** 명령 하나를 돌리는 경계. 테스트에서 대역으로 바꿔 끼운다. */
export interface CommandRunnerPort {
  run(
    cmd: string,
    args: readonly string[],
    cwd: string,
    env?: Readonly<Record<string, string>>,
  ): Promise<{ readonly code: number; readonly stdout: string; readonly ms: number }>;
}

/** 시나리오 하나를 확인하는 수단 한 가지. */
export interface VerificationStep {
  /** 이 수단이 내는 증거의 등급. 실제로 무엇을 거쳤는지에 맞춘다. */
  readonly kind: EvidenceKind;
  readonly cmd: string;
  readonly args: readonly string[];
  /** 저장소 루트 기준 상대 경로. */
  readonly cwd: string;
  /** 이 수단이 붙은 이유. 보고서에 그대로 실린다. */
  readonly why: string;
  /**
   * 이 단계가 필요로 하는 환경. 저장소 루트를 받아 스스로 계산한다.
   * 주변 환경에 기대면 "내 셸에서는 되는데" 가 되어 벤치를 아무도 재현하지 못한다.
   */
  readonly env?: (repoRoot: string) => Readonly<Record<string, string>>;
  /**
   * 이 시나리오를 실제로 증명하는 테스트 케이스 이름(부분 문자열).
   *
   * 왜 필요한가: 파일 단위로만 묶으면 그 파일의 *무관한* 테스트가 통과해도 시나리오가
   * 증명된 것으로 셈된다. 종료 코드 0 은 "실행기가 떴다"는 뜻이지 "이 시나리오가
   * 확인됐다"는 뜻이 아니다(2026-08-27 적대리뷰 지적).
   * 여기 적힌 이름이 통과 목록에 없으면 영수증을 만들지 않는다.
   */
  readonly cases?: readonly string[];
  /**
   * 이 중 *하나라도* 통과 목록에 있으면 이 단계가 시나리오를 밟은 것으로 본다.
   *
   * 문서가 선언한 확인 수단에는 손으로 케이스 이름을 붙이지 않는다 — 그러면 작성자가
   * 관리하는 매핑이 하나 더 늘 뿐이다(2026-08-27 적대리뷰 지적). 대신 요구사항 문서가
   * 그 시나리오에 걸어 둔 FR 식별자를 쓴다. 테스트가 자기 이름에 FR 을 달고 있으므로
   * 그 FR 을 확인하는 테스트가 실제로 돌았는지 기계적으로 확인할 수 있다.
   */
  readonly anyCases?: readonly string[];
}

/**
 * e2e-tauri 가 필요로 하는 환경. 실행 파일과 음성 라이브러리 경로를 저장소에서 직접 찾는다.
 * 둘 다 target-e2e 안에 있고, 없으면 앱이 뜨다가 죽거나 엉뚱한 바이너리를 띄운다.
 */
/**
 * e2e 바이너리가 지금 Rust 소스로 빌드된 것인가.
 *
 * ⚠️ 실측(2026-08-27): 바이너리는 11:00 에 빌드됐는데 Rust 소스의 마지막 커밋은 13:17 이었다.
 *    "실 Rust 백엔드로 검증했다"는 말이 실제로는 옛 바이너리를 상대로 한 것이었다.
 *    벤치가 이 어긋남을 못 봤기 때문에 통과가 그대로 증거로 셈됐다.
 */
export function e2eBinaryIsCurrent(repoRoot: string): { readonly ok: boolean; readonly why: string } {
  const binary = resolve(repoRoot, "packages", "shell", "src-tauri", "target-e2e", "debug", "naia-shell");
  if (!existsSync(binary)) return { ok: false, why: "e2e 바이너리가 없다" };
  const built = statSync(binary).mtimeMs;
  let newest = 0;
  let newestFile = "";
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".rs") || entry.name === "Cargo.toml") {
        const m = statSync(full).mtimeMs;
        if (m > newest) {
          newest = m;
          newestFile = full;
        }
      }
    }
  };
  try {
    walk(resolve(repoRoot, "packages", "shell", "src-tauri", "src"));
  } catch {
    return { ok: false, why: "Rust 소스를 훑지 못했다" };
  }
  return newest > built
    ? { ok: false, why: `바이너리가 소스보다 오래됐다 — 다시 빌드해야 한다 (${newestFile})` }
    : { ok: true, why: "" };
}

export function e2eTauriEnv(repoRoot: string): Readonly<Record<string, string>> {
  const shell = resolve(repoRoot, "packages", "shell");
  const binary = resolve(shell, "src-tauri", "target-e2e", "debug", "naia-shell");
  const buildDir = resolve(shell, "src-tauri", "target-e2e", "debug", "build");
  let voskDir = "";
  if (existsSync(buildDir)) {
    for (const entry of readdirSync(buildDir)) {
      const candidate = resolve(buildDir, entry, "out", "vosk-lib");
      if (existsSync(resolve(candidate, "libvosk.so"))) {
        voskDir = candidate;
        break;
      }
    }
  }
  const env: Record<string, string> = {};
  if (existsSync(binary)) env.TAURI_BINARY = binary;
  if (voskDir) {
    const existing = process.env.LD_LIBRARY_PATH;
    env.LD_LIBRARY_PATH = existing ? `${voskDir}:${existing}` : voskDir;
  }
  return env;
}

/** 실행부가 부를 수 있는 실행 파일. 목록 밖은 무단 외부 효과로 남는다. */
export const ALLOWED_EXECUTABLES: readonly string[] = ["npx", "node"];

const VITEST = (spec: string, why: string, cwd = ".", cases?: readonly string[]): VerificationStep => ({
  kind: "mock",
  cmd: "npx",
  // 사람이 읽는 출력만으로는 어떤 케이스가 통과했는지 확실히 알 수 없다.
  args: ["vitest", "run", "--reporter=json", spec],
  cwd,
  why,
  ...(cases ? { cases } : {}),
});

const PLAYWRIGHT = (spec: string, why: string, cases?: readonly string[]): VerificationStep => ({
  // 실제 DOM 을 그리지만 Tauri IPC 는 대역이다 — native 가 아니라 browser 등급이다.
  kind: "browser",
  cmd: "npx",
  args: ["playwright", "test", spec],
  cwd: "packages/shell",
  why,
  ...(cases ? { cases } : {}),
});

/**
 * 실제 프로세스로 도는 작업자를 띄운다 — 대역 작업자가 아니므로 worker 등급이다.
 * 같은 파일이 실제 디스크도 쓰므로 native 단계와 짝으로 등록한다.
 */
const LIVE_WORKER = (spec: string, why: string, cases?: readonly string[]): VerificationStep => ({
  kind: "worker",
  cmd: "npx",
  args: ["vitest", "run", "--reporter=json", spec],
  cwd: ".",
  why,
  env: () => ({}),
  ...(cases ? { cases } : {}),
});

/** 살아 있는 Herdr 을 실제로 조회한다 — 대역이 아니므로 native 등급이다. */
const LIVE_HERDR = (spec: string, why: string, cases?: readonly string[]): VerificationStep => ({
  kind: "native",
  cmd: "npx",
  args: ["vitest", "run", "--reporter=json", spec],
  cwd: ".",
  why,
  // 이 단계는 herdr 실행 파일만 있으면 된다 — 따로 갖출 환경이 없다.
  env: () => ({}),
  ...(cases ? { cases } : {}),
});

const E2E_TAURI = (spec: string, why: string, cases?: readonly string[]): VerificationStep => ({
  // 실 Rust 백엔드까지 간다.
  kind: "native",
  cmd: "npx",
  args: ["wdio", "run", "e2e-tauri/wdio.conf.ts", "--spec", spec],
  cwd: "packages/shell",
  why,
  env: e2eTauriEnv,
  ...(cases ? { cases } : {}),
});

/**
 * 실행기는 vitest 지만 실제 환경을 건드리는 파일. 등급은 실행기가 아니라 무엇을
 * 건드리느냐로 정해지므로, 이 목록에 있는 것만 native 로 올린다.
 */
export const NATIVE_VITEST_SPECS: readonly string[] = [
  "src/test/environment-live-herdr.contract.test.ts",
  "src/test/environment-live-act.contract.test.ts",
  // 실제 디스크에 워크스페이스를 만들어 해석한다 — 대역 소스가 아니다.
  "src/test/workspace-context-real-fs.contract.test.ts",
  // 살아 있는 Herdr 에 실제로 붙어 제어면을 밟는다.
  "src/test/herdr-control-live.contract.test.ts",
  // 살아 있는 터미널에 실제로 명령을 넣는다.
  "src/test/env-tool-live.contract.test.ts",
  // 실제 프로세스가 임시 디렉터리에서 산출물을 남긴다.
  "src/test/orchestration-live.contract.test.ts",
];

/** 경로만 보고 등급과 실행 방식을 정한다. */
function stepForPath(spec: string, why: string, cwd: string): VerificationStep | null {
  // e2e 계열은 packages/shell 에서 돈다. 문서가 저장소 루트 기준으로 적었으면 접두사를 떼야
  // cwd 와 겹치지 않는다.
  const local = spec.startsWith("packages/shell/") ? spec.slice("packages/shell/".length) : spec;
  if (local.includes("e2e-tauri/")) return E2E_TAURI(local, why);
  if (local.startsWith("e2e/")) return PLAYWRIGHT(local, why);
  if (spec.endsWith(".test.ts") || spec.endsWith(".spec.ts")) {
    return NATIVE_VITEST_SPECS.includes(spec) ? LIVE_HERDR(spec, why) : VITEST(spec, why, cwd);
  }
  return null;
}

/**
 * 확인 수단을 `docs/user-scenarios.md` 의 Test Coverage Map 에서 읽는다.
 *
 * 왜 문서에서 읽는가: 손으로 옮겨 적으면 빠뜨린다. 실제로 그랬다 — 문서에는 네 계열의
 * 매핑이 다 있었는데 손으로 적은 목록에서 16개가 통째로 빠져 있었고, 벤치는 그것을
 * "확인 수단이 아예 없다"로 보고했다(2026-08-26). 구현이 없는 것과 매핑을 빠뜨린 것은
 * 완전히 다른 상태인데 보고서가 둘을 구분하지 못했다.
 */
export function deriveVerification(
  markdown: string,
  requirementIds: Readonly<Record<string, readonly string[]>>,
  /** 이 에픽이 소유한 시나리오만 받는다. 문서는 여러 슬라이스가 공유한다. */
  ownedScenarios: ReadonlySet<string>,
  /** 저장소 루트 기준으로 파일이 실제 있는지. 없는 경로는 문서 부패이므로 따로 모은다. */
  resolveSpec: (spec: string) => { readonly cwd: string; readonly spec: string } | null,
): { readonly steps: Record<string, VerificationStep[]>; readonly missing: readonly string[] } {
  const steps: Record<string, VerificationStep[]> = {};
  const missing: string[] = [];
  for (const line of markdown.split("\n")) {
    const ucs = [...new Set([...line.matchAll(/\b(UC-[A-Z0-9-]+)\b/g)].map((m) => m[1] as string))].filter((uc) =>
      ownedScenarios.has(uc),
    );
    if (ucs.length === 0) continue;
    const specs = [...line.matchAll(/`([A-Za-z0-9_./-]+\.(?:test|spec)\.ts)`/g)].map((m) => m[1] as string);
    for (const uc of ucs) {
      for (const spec of specs) {
        const located = resolveSpec(spec);
        if (!located) {
          missing.push(`${uc} → ${spec}`);
          continue;
        }
        const base = stepForPath(located.spec, `문서 Test Coverage Map 이 ${uc} 의 확인 수단으로 선언한 것`, located.cwd);
        if (!base) continue;
        // e2e 스펙 제목은 FR 이 아니라 UC 를 다는 관행이라 둘 다 선택자로 둔다.
        const ids = [...(requirementIds[uc] ?? []), uc];
        const step: VerificationStep = { ...base, anyCases: ids };
        const bucket = (steps[uc] ??= []);
        // 같은 파일이 서로 다른 등급의 증거를 낼 수 있다(실제 작업자 + 실제 디스크).
        // 경로만으로 묶으면 둘 중 하나가 조용히 사라진다.
        const key = `${step.kind}:${step.cwd}/${step.args[step.args.length - 1]}`;
        if (!bucket.some((x) => `${x.kind}:${x.cwd}/${x.args[x.args.length - 1]}` === key)) bucket.push(step);
      }
    }
  }
  return { steps, missing };
}

/**
 * 요구사항 문서에서 시나리오별 FR 식별자를 뽑는다.
 * 행의 어딘가에 UC 가 적혀 있으면 그 행의 FR/NFR 식별자가 그 시나리오의 것이다.
 */
export function requirementIdsByScenario(requirementsMarkdown: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of requirementsMarkdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const ids = [...line.matchAll(/\b((?:FR|NFR)-[A-Z0-9-]+\.[0-9]+)\b/g)].map((m) => m[1] as string);
    if (ids.length === 0) continue;
    for (const uc of [...new Set([...line.matchAll(/\b(UC-[A-Z0-9-]+)\b/g)].map((m) => m[1] as string))]) {
      const bucket = (out[uc] ??= []);
      for (const id of ids) if (!bucket.includes(id)) bucket.push(id);
    }
  }
  return out;
}

/** 저장소 루트와 packages/shell 두 곳을 훑어 실제 파일을 찾는다. */
export function specResolver(repoRoot: string) {
  return (spec: string): { cwd: string; spec: string } | null => {
    // ⚠️ 파일이 루트에서 보인다고 루트에서 돌릴 수 있는 것은 아니다. packages/shell 의
    //    테스트는 그 워크스페이스의 vitest 설정으로 돌아야 한다 — 루트에서 부르면
    //    설정이 그 파일을 모르고 종료 코드 1 이 난다(2026-08-27 실측).
    if (spec.startsWith("packages/shell/")) {
      const local = spec.slice("packages/shell/".length);
      if (existsSync(resolve(repoRoot, spec))) return { cwd: "packages/shell", spec: local };
    }
    if (existsSync(resolve(repoRoot, spec))) return { cwd: ".", spec };
    if (existsSync(resolve(repoRoot, "packages", "shell", spec))) return { cwd: "packages/shell", spec };
    return null;
  };
}

export const EXTRA_VERIFICATION: Readonly<Record<string, readonly VerificationStep[]>> = {
  "UC-ORCHESTRATION-CLASSIFY": [
    LIVE_WORKER("src/test/orchestration-live.contract.test.ts", "분류가 실제 작업 흐름 위에서 성립하는지",
      ["저장소를 바꾸는 일은 이슈로 분류된다"],
    ),
    LIVE_HERDR("src/test/orchestration-live.contract.test.ts", "결속과 산출물이 실제 디스크에 남는지",
      ["저장소를 바꾸는 일은 이슈로 분류된다"],
    ),
  ],
  "UC-ORCHESTRATION-ISSUE-LEAD": [
    LIVE_WORKER("src/test/orchestration-live.contract.test.ts", "실제 작업자가 돌고 완료 선언이 판정에 쓰이지 않는지",
      ["이슈를 열고 리더를 세우고 실제 작업자가 돈다", "작업자의 완료 선언과 권한 요구는 반영되지 않는다"],
    ),
    LIVE_HERDR("src/test/orchestration-live.contract.test.ts", "결속과 산출물이 실제 디스크에 남는지",
      ["이슈를 열고 리더를 세우고 실제 작업자가 돈다", "작업자의 완료 선언과 권한 요구는 반영되지 않는다"],
    ),
  ],
  "UC-ORCHESTRATION-WORKER-REPLACE": [
    LIVE_WORKER("src/test/orchestration-live.contract.test.ts", "실제로 도는 작업자를 멈추고 교체해도 증거가 남는지",
      ["작업자를 교체해도 이슈 증거가 유지된다"],
    ),
    LIVE_HERDR("src/test/orchestration-live.contract.test.ts", "결속과 산출물이 실제 디스크에 남는지",
      ["작업자를 교체해도 이슈 증거가 유지된다"],
    ),
  ],
  "UC-ORCHESTRATION-RESTART-RESUME": [
    LIVE_WORKER("src/test/orchestration-live.contract.test.ts", "실제 작업자 상태를 관측해 재개 태도를 정하는지",
      ["재시작 뒤 찾으면 실제 작업자 상태로 태도를 정한다"],
    ),
    LIVE_HERDR("src/test/orchestration-live.contract.test.ts", "결속과 산출물이 실제 디스크에 남는지",
      ["재시작 뒤 찾으면 실제 작업자 상태로 태도를 정한다"],
    ),
  ],
  "UC-ENV-TOOL-BROWSE": [
    E2E_TAURI(
      "e2e-tauri/specs/env-tool-browser-native.spec.ts",
      "참조 기반 조작 명령이 실 Rust 에 등록돼 있고 좌표 명령은 열려 있지 않은지",
      ["등록돼 있지 않다"],
    ),
  ],
  "UC-ENV-TOOL-TERMINAL-EXEC": [
    LIVE_HERDR("src/test/env-tool-live.contract.test.ts", "구조화된 명령이 실제 터미널에서 실행되고 결과가 함께 돌아오는지",
      ["구조화된 명령이 실제로 실행되고 결과가 함께 돌아온다"],
    ),
  ],
  "UC-ENV-TOOL-CANCEL": [
    LIVE_HERDR(
      "src/test/env-tool-live.contract.test.ts",
      "터미널 쪽: 진행 중인 작업이 실제로 멈추고 취소가 실패와 구별되는지",
      ["취소하면 진행 중인 작업이 실제로 멈춘다"],
    ),
    PLAYWRIGHT("e2e/env-tool-browser.spec.ts", "브라우저 쪽: 중단 신호가 실제로 나가는지",
      ["멈추라고 하면 중단 요청이 실제로 나간다"],
    ),
  ],
  "UC-ENV-TOOL-BOUNDARY-DENY": [
    LIVE_HERDR("src/test/env-tool-live.contract.test.ts", "등급과 승인이 실제 실행 앞에서 지켜지는지",
      ["파일을 고칠 수 있다고 메시지를 보낼 수 있는 것은 아니다", "자격증명을 쓰는 호출은 별도 승인이 필요하다"],
    ),
  ],
  // UC-CHANNEL-SESSION-* 의 실 백엔드 수단이던 e2e-tauri/specs/channel-reboot.spec.ts 는
  // #610 이 Discord 채널 표면과 함께 지웠다. 남은 수단은 문서 Test Coverage Map 의 계약
  // 테스트뿐이고, 계열이 요구하는 native 증거는 지금 없다 — 없는 파일을 가리켜 두지 않는다.
  "UC-HERDR-CONTROL-OBSERVE": [
    LIVE_HERDR("src/test/herdr-control-live.contract.test.ts", "살아 있는 Herdr 의 자원과 개정을 실제로 읽는다",
      ["자원을 타입이 선언된 값으로 읽는다", "스냅샷에 개정이 실려 있고 단조 증가한다"],
    ),
  ],
  "UC-HERDR-CONTROL-MUTATE": [
    LIVE_HERDR("src/test/herdr-control-live.contract.test.ts", "구조화된 요청이 실제 환경에서 실행되고 멱등이 지켜진다",
      ["구조화된 요청이 실제로 실행된다", "같은 멱등 키를 다시 보내도 두 번 실행하지 않는다"],
    ),
  ],
  "UC-HERDR-CONTROL-STALE-REVISION": [
    LIVE_HERDR("src/test/herdr-control-live.contract.test.ts", "낡은 개정이 실제 환경에서도 충돌로 거절된다",
      ["낡은 개정으로 온 요청은 충돌로 거절된다"],
    ),
  ],
  "UC-HERDR-CONTROL-RECONNECT": [
    LIVE_HERDR("src/test/herdr-control-live.contract.test.ts", "실제 재접속 뒤 태도가 증거에 따라 정해진다",
      ["재접속하면 현재 상태를 다시 확인한다"],
    ),
  ],
  "UC-WORKSPACE-CONTEXT-DISCOVER": [
    LIVE_HERDR("src/test/workspace-context-real-fs.contract.test.ts", "실제 디스크의 진입점을 읽는다",
      ["진입점이 선언한 문서를 실제 파일에서 읽는다"],
    ),
  ],
  "UC-WORKSPACE-CONTEXT-ENTER-PROJECT": [
    LIVE_HERDR("src/test/workspace-context-real-fs.contract.test.ts", "실제 디렉터리로 프로젝트에 진입한다",
      ["프로젝트에 들어가면 범위와 개정이 함께 바뀐다"],
    ),
  ],
  "UC-WORKSPACE-CONTEXT-SWITCH-PROJECT": [
    LIVE_HERDR("src/test/workspace-context-real-fs.contract.test.ts", "실제 디렉터리 사이를 전환한다",
      ["프로젝트를 바꾸면 이전 지역 컨텍스트가 남지 않는다"],
    ),
  ],
  "UC-WORKSPACE-CONTEXT-BROKEN-ENTRYPOINT": [
    LIVE_HERDR("src/test/workspace-context-real-fs.contract.test.ts", "없는 진입점을 실제 디스크에서 확인한다",
      ["없는 진입점을 성공으로 말하지 않는다"],
    ),
  ],
  "UC-ENV-LIVE-OBSERVE": [
    LIVE_HERDR(
      "src/test/environment-live-herdr.contract.test.ts",
      "살아 있는 Herdr 이 실제로 내는 모양으로 관측 경로를 끝까지 밟는다 — 읽기 전용",
      ["실제 관측이 대화에 실을 세그먼트가 된다", "실제 pane 식별자가 뇌에 올라가지 않는다"],
    ),
  ],
  "UC-ENV-LIVE-ACT": [
    LIVE_HERDR(
      "src/test/environment-live-act.contract.test.ts",
      "전용 워크스페이스를 만들어 실제 터미널에 명령을 넣고 멈춘다 — 사용자 터미널은 건드리지 않는다",
      ["run 의도가 실제 터미널에서 실행된다", "interrupt 의도가 돌고 있는 것을 실제로 멈춘다"],
    ),
  ],
  "UC-ENV-SURFACE-OBSERVE": [
    LIVE_HERDR("src/test/environment-live-herdr.contract.test.ts", "살아 있는 Herdr 이 내는 실제 모양으로 관측",
      ["실제 스냅샷이 보고로 바뀐다"],
    ),
  ],
  "UC-ENV-SURFACE-ACT": [
    LIVE_HERDR("src/test/environment-live-act.contract.test.ts", "번역된 호출이 실제 터미널에서 효과를 낸다",
      ["run 의도가 실제 터미널에서 실행된다"],
    ),
  ],
  "UC-ENV-SURFACE-DENY": [
    LIVE_HERDR("src/test/environment-live-act.contract.test.ts", "도달 경로가 없는 의도가 실제 환경에서도 거절되는지",
      ["허용되지 않은 의도는 실제 환경에 닿지 못한다"],
    ),
  ],
  "UC-ENV-SURFACE-DATA": [
    LIVE_HERDR("src/test/environment-live-act.contract.test.ts", "실제 터미널이 만든 지시문 같은 이름이 자료로만 올라오는지",
      ["환경이 만든 이름이 지시문이 아니라 자료로 올라간다"],
    ),
  ],
  "UC-ENV-DISPATCH-STRUCTURED": [
    E2E_TAURI("e2e-tauri/specs/environment-dispatch.spec.ts", "구조화 전달이 실 Rust 경계를 통과하는지",
      ["herdr_run_pane 이 등록돼 있다"],
    ),
  ],
  "UC-ENV-DISPATCH-TERMINAL": [
    E2E_TAURI("e2e-tauri/specs/environment-dispatch.spec.ts", "터미널 입력 인자를 Rust 가 실제로 검증하는지",
      ["플래그로 해석될 수 있는 키", "키 개수 상한"],
    ),
  ],
  "UC-ENV-DISPATCH-REFUSE": [
    E2E_TAURI("e2e-tauri/specs/environment-dispatch.spec.ts", "열지 않은 명령이 등록돼 있지 않은지",
      ["이 슬라이스가 열지 않은 herdr 명령은 등록돼 있지 않다"],
    ),
  ],
};

/** 문서에서 읽은 것과 손으로 더한 것을 합친다. 같은 파일은 한 번만 돈다. */
export function buildVerification(
  markdown: string,
  ownedScenarios: ReadonlySet<string>,
  repoRoot: string,
  requirementIds: Readonly<Record<string, readonly string[]>> = {},
): Readonly<Record<string, readonly VerificationStep[]>> {
  const merged = deriveVerification(markdown, requirementIds, ownedScenarios, specResolver(repoRoot)).steps;
  for (const [uc, steps] of Object.entries(EXTRA_VERIFICATION)) {
    const bucket = (merged[uc] ??= []);
    for (const step of steps) {
      const key = `${step.kind}:${step.cwd}/${step.args[step.args.length - 1]}`;
      if (!bucket.some((x) => `${x.kind}:${x.cwd}/${x.args[x.args.length - 1]}` === key)) bucket.push(step);
    }
  }
  return merged;
}

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const DOC_PATH = resolve(REPO_ROOT, "docs", "user-scenarios.md");
const DOC_MARKDOWN = readFileSync(DOC_PATH, "utf8");

/** 이 저장소의 실제 문서로 만든 목록. */
const REQUIREMENT_IDS = requirementIdsByScenario(
  readFileSync(resolve(REPO_ROOT, "docs", "requirements.md"), "utf8"),
);

export const VERIFICATION: Readonly<Record<string, readonly VerificationStep[]>> = buildVerification(
  DOC_MARKDOWN,
  new Set(parseScenarios(DOC_MARKDOWN).map((x) => x.id)),
  REPO_ROOT,
  REQUIREMENT_IDS,
);

/** 문서가 선언했는데 실제로 없는 파일. 문서 부패를 조용히 넘기지 않기 위해 노출한다. */
export const MISSING_SPECS: readonly string[] = deriveVerification(
  DOC_MARKDOWN,
  REQUIREMENT_IDS,
  new Set(parseScenarios(DOC_MARKDOWN).map((x) => x.id)),
  specResolver(REPO_ROOT),
).missing;

/**
 * 통과한 테스트 케이스 이름을 읽는다.
 * 기계가 읽는 출력이 있으면 그것을 쓰고, 없으면 사람이 읽는 출력의 통과 표시를 읽는다.
 * 아무것도 못 읽으면 빈 집합이다 — 지어내지 않는다.
 */
export function parsePassedCases(stdout: string): ReadonlySet<string> {
  const names = new Set<string>();
  // vitest --reporter=json / playwright --reporter=json
  const jsonStart = stdout.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(stdout.slice(jsonStart)) as {
        testResults?: { assertionResults?: { status?: string; fullName?: string; title?: string }[] }[];
        suites?: unknown;
      };
      for (const file of parsed.testResults ?? []) {
        for (const a of file.assertionResults ?? []) {
          if (a.status === "passed") names.add(String(a.fullName ?? a.title ?? ""));
        }
      }
    } catch {
      // JSON 이 아니면 아래 텍스트 경로로 내려간다.
    }
  }
  // 사람이 읽는 출력의 통과 표시(playwright, wdio/mocha).
  for (const m of stdout.matchAll(/[✓✔]\s+(?:\d+\s+)?(?:\[[^\]]*\]\s+›\s+)?(.+?)(?:\s+\(\d+(?:\.\d+)?m?s\))?\s*$/gm)) {
    const name = (m[1] ?? "").trim();
    if (name) names.add(name);
  }
  return names;
}

/** vitest·playwright·wdio 출력에서 통과한 테스트 수를 읽는다. 못 읽으면 0. */
export function parseTestCount(stdout: string): number {
  // 기계 판독 출력이면 통과 케이스를 직접 센다. 사람이 읽는 요약줄이 없기 때문이다 —
  // 이걸 빠뜨려서 JSON 으로 바꾼 순간 모든 영수증이 사라졌다(2026-08-27).
  const machine = parsePassedCases(stdout);
  if (machine.size > 0) return machine.size;
  const vitest = /Tests\s+(?:\d+\s+failed\s+\|\s+)?(\d+)\s+passed/.exec(stdout);
  if (vitest) return Number(vitest[1]);
  const playwright = /(\d+)\s+passed/.exec(stdout);
  if (playwright) return Number(playwright[1]);
  const mocha = /(\d+)\s+passing/.exec(stdout);
  if (mocha) return Number(mocha[1]);
  return 0;
}

/**
 * `docs/requirements.md` 에서 이 UC 를 출처로 적은 FR 행을 찾아 완료 주장을 읽는다.
 * 행이 하나도 없으면 주장 자체가 없는 것이다 — 실행부가 대신 주장하지 않는다.
 */
export function readClaim(requirementsMarkdown: string, scenario: BenchScenario): CompletionClaim | undefined {
  const rows = requirementsMarkdown
    .split("\n")
    .filter((line) => line.startsWith("|") && line.includes(scenario.uc));
  if (rows.length === 0) return undefined;
  const allDone = rows.every((line) => /\|\s*Done\s*\|?\s*$/.test(line.trimEnd()));
  return { scenarioId: scenario.id, claimedComplete: allDone };
}

export interface BenchExecutionDeps {
  readonly runner: CommandRunnerPort;
  readonly repoRoot: string;
  /** 추적 기록에 남길 컨텍스트 판본. 보통 git HEAD. */
  readonly contextRevision: string;
  readonly requirementsMarkdown: string;
  readonly verification?: Readonly<Record<string, readonly VerificationStep[]>>;
  /**
   * 실 Rust 백엔드 증거의 최신성 판정. 기본값은 실제 바이너리를 보는
   * `e2eBinaryIsCurrent` 다.
   *
   * 주입 가능하게 둔 이유: 이 판정은 디스크에 빌드된 바이너리가 있느냐에 달려
   * 있다. 그런데 영수증·허용목록 같은 다른 성질을 확인하는 계약 테스트도
   * wdio 단계를 대역으로 쓰기 때문에, 빌드 상태에 따라 그 테스트들의 결과가
   * 같이 흔들렸다. CI 처럼 바이너리를 만들지 않는 환경에서는 전부 실패한다.
   * 최신성 자체를 확인하는 곳에서만 실제 판정을 쓰고, 나머지는 고정한다.
   */
  readonly binaryIsCurrent?: (repoRoot: string) => {
    readonly ok: boolean;
    readonly why: string;
  };
}

/** 실제로 명령을 돌려 증거를 모으는 실행부. */
export class CommandBenchExecution implements BenchExecutionPort {
  constructor(private readonly deps: BenchExecutionDeps) {}

  /**
   * 실환경 등급(native·worker)은 그 실행이 실제로 무엇을 만졌는지 증명서를 남겨야 한다.
   * 경로 허용목록만으로 등급을 주면 벤치가 자기 설정을 검증하는 셈이다.
   */
  private attested(step: VerificationStep, since: number, artifacts: string[], label: string): boolean {
    if (step.kind !== "native" && step.kind !== "worker") return true;
    // 증명서 이름은 저장소 기준 경로로 맞춘다. 쓰는 쪽(packages/shell/...)과 읽는 쪽
    // (e2e-tauri/...)이 다른 키를 만들면 증명서가 있는데도 없다고 읽는다(2026-08-27 실측).
    const raw = String(step.args[step.args.length - 1] ?? "");
    const spec = step.cwd === "." ? raw : `${step.cwd}/${raw}`;
    const att = readFreshAttestation(this.deps.repoRoot, spec, since);
    if (!att) {
      artifacts.push(`${label} → 실환경 관측 증명서가 없다(등급 ${step.kind})`);
      return false;
    }
    if (!att.kinds.includes(step.kind)) {
      artifacts.push(`${label} → 증명서에 없는 등급: 선언 ${step.kind} vs 관측 ${att.kinds.join("+")}`);
      return false;
    }
    // 증명서가 자기 신고인 이상, 신고한 자원이 말이 되는지는 벤치가 따로 본다
    // (2026-08-27 5차 적대리뷰 지적). 형태가 맞지 않는 신고는 증거로 세지 않는다.
    const bad = att.touched.filter((t) => !plausibleResource(t));
    if (bad.length > 0) {
      artifacts.push(`${label} → 증명서가 신고한 자원이 형태에 맞지 않는다: ${bad.join(" / ")}`);
      return false;
    }
    // 등급은 파일이 아니라 케이스에 붙는다. 이 단계가 지목한 케이스가 실제로 환경을 밟은
    // 케이스 목록에 없으면, 그 케이스는 실환경 증거가 아니다.
    // 케이스 신고가 없으면 대조 자체가 우회된다 — 그러면 파일 하나 쓰는 것만으로 등급이
    // 생긴다(2026-08-27 7차 적대리뷰 지적). 실환경 등급은 케이스 신고를 반드시 요구한다.
    if (!att.cases || att.cases.length === 0) {
      artifacts.push(`${label} → 증명서에 환경을 밟은 케이스 신고가 없다(등급 ${step.kind})`);
      return false;
    }
    const declared = step.cases && step.cases.length > 0 ? step.cases : (step.anyCases ?? []);
    if (declared.length > 0) {
      const anyEnv = declared.some((c) => att.cases?.some((a) => a.includes(c) || c.includes(a)));
      if (!anyEnv) {
        artifacts.push(
          `${label} → 환경을 밟지 않은 케이스로 ${step.kind} 등급을 주장한다: ${declared.join(" / ")}`,
        );
        return false;
      }
    }
    return true;
  }

  async run(scenario: BenchScenario): Promise<ScenarioRun> {
    const startedAt = Date.now();
    const steps = (this.deps.verification ?? VERIFICATION)[scenario.id] ?? [];
    const receipts: EvidenceReceipt[] = [];
    const operations: string[] = [];
    const artifacts: string[] = [];
    const tests: string[] = [];
    const completionEvidence: string[] = [];
    const unauthorizedEffects: string[] = [];
    const allPassed = new Set<string>();
    // ⚠️ 선언된 요구사항은 단계가 성공했든 실패했든 그대로다. 성공한 단계에서만 모으면,
    //    어떤 FR 을 담당한 명령이 실패했을 때 그 FR 이 확인 목록에서 조용히 사라지고
    //    다른 단계의 영수증만으로 시나리오가 수용된다(2026-08-27 5차 적대리뷰 지적).
    // 요구사항은 단계가 아니라 문서에서 직접 모은다. 단계의 anyCases 에서 모으면
    // 손으로 더한 단계(EXTRA)만 있는 시나리오는 요구사항이 통째로 빠진다
    // (2026-08-27 7차 적대리뷰 지적).
    const scenarioRequirements = new Set<string>(
      requirementIdsByScenario(this.deps.requirementsMarkdown)[scenario.id] ?? [],
    );
    let latencyMs = 0;
    let testCount = 0;

    for (const step of steps) {
      const label = `${step.cmd} ${step.args.join(" ")} (cwd=${step.cwd})`;
      operations.push(label);
      tests.push(step.args[step.args.length - 1] ?? label);
      if (step.args.includes("wdio")) {
        // 실 Rust 백엔드 증거는 지금 소스로 빌드된 바이너리여야 한다.
        const fresh = (this.deps.binaryIsCurrent ?? e2eBinaryIsCurrent)(
          this.deps.repoRoot,
        );
        if (!fresh.ok) {
          artifacts.push(`${label} → ${fresh.why}`);
          unauthorizedEffects.push(`옛 바이너리로 실 백엔드 증거를 만들 뻔했다: ${fresh.why}`);
          continue;
        }
      }
      if (!ALLOWED_EXECUTABLES.includes(step.cmd)) {
        // 목록 밖 실행 파일은 돌리지 않는다. 돌린 척도 하지 않는다.
        unauthorizedEffects.push(label);
        continue;
      }
      const result = await this.deps.runner.run(
        step.cmd,
        step.args,
        resolve(this.deps.repoRoot, step.cwd),
        step.env?.(this.deps.repoRoot),
      );
      latencyMs += result.ms;
      testCount += parseTestCount(result.stdout);
      artifacts.push(`${label} → exit ${result.code}`);
      if (result.code !== 0) continue; // 실패는 영수증을 만들지 않는다.

      const passed = parsePassedCases(result.stdout);
      const parsedCount = parseTestCount(result.stdout);
      if (parsedCount === 0) {
        // 종료 코드 0 은 "실행기가 떴다"는 뜻이다. 통과한 테스트를 하나도 못 읽었으면
        // 이 실행은 증거가 아니다 — 실행기 기동만으로 증거를 만들지 않는다.
        artifacts.push(`${label} → 통과한 테스트를 읽지 못해 증거로 세지 않음`);
        continue;
      }
      if (step.anyCases && step.anyCases.length > 0) {
        // 이 단계가 시나리오의 어느 조각이라도 확인했는지. 선언된 FR 을 *전부* 확인했는지는
        // 시나리오 단위로 아래에서 본다 — 한 파일이 그 시나리오의 모든 FR 을 이름에 달 이유가
        // 없기 때문이다(2026-08-27 3차 적대리뷰 지적의 적용 단위 교정).
        const hit = step.anyCases.some((c) => [...passed].some((n) => n.includes(c)));
        if (!hit) {
          artifacts.push(`${label} → 이 시나리오를 확인하는 케이스가 돌지 않음: ${step.anyCases.join(" / ")}`);
          continue;
        }
        if (!this.attested(step, startedAt, artifacts, label)) continue;
        // 증명서 검증을 통과한 뒤에만 확인으로 센다. 앞서는 검증 실패한 단계의 케이스가
        // 그대로 확인 목록에 남아, 그 FR 을 담당한 단계가 거절됐는데도 확인된 것으로
        // 읽혔다(2026-08-27 6차 적대리뷰 지적).
        for (const n of passed) allPassed.add(n);
        receipts.push({ scenarioId: scenario.id, kind: step.kind, ref: label });
        completionEvidence.push(`${label} — ${step.why}`);
        continue;
      }
      if (!step.cases || step.cases.length === 0) {
        // 케이스 선택자가 없으면 그 파일의 무관한 테스트가 통과해도 시나리오가 증명된 것으로
        // 셈된다 — 조건부로 두면 대부분의 단계가 그 구멍으로 빠진다(2026-08-27 적대리뷰 지적).
        artifacts.push(`${label} → 케이스 선택자가 없어 증거로 세지 않음`);
        continue;
      }
      {
        const missing = step.cases.filter((c) => ![...passed].some((n) => n.includes(c)));
        if (missing.length > 0) {
          // 파일은 통과했지만 이 시나리오를 증명하는 케이스가 돌지 않았다.
          artifacts.push(`${label} → 시나리오 케이스 미확인: ${missing.join(" / ")}`);
          continue;
        }
      }
      if (!this.attested(step, startedAt, artifacts, label)) continue;
      for (const n of passed) allPassed.add(n);
      receipts.push({ scenarioId: scenario.id, kind: step.kind, ref: label });
      completionEvidence.push(`${label} — ${step.why}`);
    }

    // 시나리오가 선언한 요구사항은 전부 이름으로 추적되고 실제로 돌아야 한다.
    //
    // 앞서는 이것을 조건으로 걸 수 없었다 — 확인 수단들이 자기 FR 을 제목에 달지 않아
    // "추적이 없는 것"과 "확인이 지워진 것"이 구별되지 않았기 때문이다. 그래서 먼저
    // 추적을 만들었고(매핑된 파일 제목에 UC·FR 부착, 2026-08-27 실측 미추적 17 → 0),
    // 이제 조건으로 건다. 테스트를 지우거나 이름을 바꾸면 여기서 잡힌다.
    const uncheckedRequirements = [...scenarioRequirements].filter(
      (id) => ![...allPassed].some((n) => n.includes(id)),
    );
    const requirementsUnmet = uncheckedRequirements.length > 0 && receipts.length > 0;
    if (requirementsUnmet) {
      artifacts.push(
        `선언한 요구사항이 확인되지 않았다: ${uncheckedRequirements.join(" / ")}`,
      );
    }
    const finalReceipts = requirementsUnmet ? [] : receipts;

    // 안전 관측을 상수로 두면 자기충족이다 — 아무것도 안 보고 "깨끗하다"고 말하게 된다
    // (2026-08-27 적대리뷰 지적). 실행 뒤 실제 잔재를 훑어 채운다.
    const residue = auditResidue(this.deps.repoRoot);
    const safety: SafetyObservation = {
      leakedProjects: residue.leakedProjects,
      unauthorizedEffects: [...unauthorizedEffects, ...residue.unauthorizedEffects],
    };
    const trace: TraceRecord = {
      intent: scenario.uc,
      contextRevision: this.deps.contextRevision,
      operations,
      artifacts,
      tests,
      completionEvidence,
    };
    return {
      receipts: finalReceipts,
      sample: { scenarioId: scenario.id, latencyMs, tokenCost: 0, interventions: 0 },
      safety,
      claim: readClaim(this.deps.requirementsMarkdown, scenario),
      trace,
      testCount,
    };
  }
}

/** 실제 프로세스를 띄우는 실행기. */
export const nodeCommandRunner: CommandRunnerPort = {
  run(cmd, args, cwd, env) {
    const started = Date.now();
    return new Promise((resolveRun) => {
      const child = spawn(cmd, [...args], { cwd, env: { ...process.env, ...env }, shell: false });
      let stdout = "";
      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr?.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      // 이 저장소의 코어 tsconfig 는 브라우저 안전을 위해 node 타입을 좁게 잡는다 —
      // ChildProcess 의 EventEmitter 상속이 안 보이므로 쓰는 만큼만 좁혀 받는다.
      const proc = child as unknown as {
        on(event: "error", cb: () => void): void;
        on(event: "close", cb: (code: number | null) => void): void;
      };
      proc.on("error", () => resolveRun({ code: 127, stdout, ms: Date.now() - started }));
      proc.on("close", (code) => resolveRun({ code: code ?? 1, stdout, ms: Date.now() - started }));
    });
  },
};

/**
 * 실행이 남긴 잔재를 실제로 훑는다.
 *
 * 여기서 보는 것은 이 벤치가 만들 수 있는 흔적이다 — 테스트가 만든 Herdr 워크스페이스와
 * 임시 디렉터리. 하나라도 남아 있으면 "아무 일 없었다"가 아니다.
 */
export function auditResidue(repoRoot: string): {
  readonly leakedProjects: readonly string[];
  readonly unauthorizedEffects: readonly string[];
} {
  const PREFIXES = ["naia-act-", "naia-ctl-", "naia-envtool-", "naia-bench-", "naia-orch-", "naia-timing"];
  const effects: string[] = [];
  // 살아 있는 Herdr 에 테스트 워크스페이스가 남았는가.
  try {
    const listed = execFileSync("herdr", ["workspace", "list"], { encoding: "utf8", timeout: 20_000 });
    for (const p of PREFIXES) {
      if (listed.includes(p)) effects.push(`herdr 워크스페이스 잔재: ${p}`);
    }
  } catch (e) {
    // 확인 불능은 깨끗함이 아니다. 조용히 넘기면 "안 봤다"가 "괜찮다"로 읽힌다
    // (2026-08-27 3차 적대리뷰 지적).
    effects.push(`herdr 잔재를 확인하지 못했다: ${e instanceof Error ? e.message : String(e)}`);
  }
  // 임시 디렉터리 잔재.
  try {
    for (const entry of readdirSync(tmpdir())) {
      if (PREFIXES.some((p) => entry.startsWith(p))) effects.push(`임시 디렉터리 잔재: ${entry}`);
    }
  } catch (e) {
    effects.push(`임시 디렉터리를 훑지 못했다: ${e instanceof Error ? e.message : String(e)}`);
  }
  // 저장소 밖 프로젝트 정보가 벤치 산출물에 섞였는가.
  const leaked: string[] = [];
  const reportPath = resolve(repoRoot, "benchmark", "agent-bench-report.md");
  if (existsSync(reportPath)) {
    const body = readFileSync(reportPath, "utf8");
    for (const other of ["onmam", "naia-memory", "data-private"]) {
      if (body.includes(other)) leaked.push(other);
    }
  }
  return { leakedProjects: leaked, unauthorizedEffects: effects };
}

/**
 * 실환경 단계가 남기는 관측 증명서.
 *
 * 등급이 경로 허용목록과 작성자가 적은 kind 로만 정해지면 그것은 설정을 검증하는 것이다
 * (2026-08-27 3차 적대리뷰 지적). 실제 환경을 밟은 테스트가 자기가 무엇을 만졌는지를
 * 파일로 남기게 하고, 영수증은 그 증명서가 있어야 발급된다.
 */
export interface BoundaryAttestation {
  readonly spec: string;
  /** 이 실행이 실제로 밟은 경계들. 한 실행이 실제 프로세스와 실제 디스크를 함께 밟을 수 있다. */
  readonly kinds: readonly EvidenceKind[];
  /** 실제로 만진 외부 자원 식별자(pane, 워크스페이스, 프로세스, 경로). */
  readonly touched: readonly string[];
  /**
   * 실제로 환경을 밟은 케이스 이름.
   *
   * 파일 단위 증명서만으로 등급을 주면, 같은 파일의 *순수 함수* 테스트가 그 파일의 다른
   * 테스트가 만든 증명서로 native 등급을 받는다(2026-08-27 6차 적대리뷰 지적).
   * 단계가 지목한 케이스가 여기 없으면 그 단계는 실환경 증거가 아니다.
   */
  readonly cases?: readonly string[];
  readonly at: number;
}

/**
 * 증명서가 신고한 자원이 이 환경에서 실제로 있을 법한 모양인가.
 *
 * 증명서는 테스트가 자기 손으로 쓴다. 그것만으로는 대역이 신선한 JSON 을 써서 native 를
 * 자처할 수 있다. 벤치가 독립적으로 볼 수 있는 것은 "신고한 값이 이 환경의 자원 모양인가"다 —
 * Herdr 식별자는 `w<영숫자>[:p<n>]` 꼴이고, 경로는 절대 경로여야 하며, 프로세스는 pid 다.
 * 완전한 방어는 아니다. 무엇을 막고 무엇을 못 막는지 여기 적어 둔다.
 */
export function plausibleResource(token: string): boolean {
  // 실측(2026-08-27): pane 은 `p1`·`p12` 뿐 아니라 `p1A`·`pM` 처럼 영숫자다.
  // 숫자만 허용하던 첫 판본이 실제 자원을 형태 불일치로 거절했다 — 규칙을 환경에서 재고 맞춘다.
  if (/^w[A-Za-z0-9]+(:[pt][A-Za-z0-9]+)?$/.test(token)) return true; // Herdr 워크스페이스·pane·tab
  if (/^pid:[0-9]+$/.test(token)) return true;
  if (token.startsWith("/") && token.length > 1) return true; // 절대 경로
  if (/\.(test|spec)\.ts$/.test(token)) return true; // 자기 스펙 경로
  return false;
}

export function attestationPath(repoRoot: string, spec: string): string {
  return resolve(repoRoot, "benchmark", ".attest", `${spec.replace(/[^A-Za-z0-9]+/g, "_")}.json`);
}

/** 테스트가 부른다. 자기가 실제로 만진 것을 남긴다. */
export function writeAttestation(repoRoot: string, att: BoundaryAttestation): void {
  const path = attestationPath(repoRoot, att.spec);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(att, null, 2)}\n`, "utf8");
}

/** 이 실행에서 갓 남긴 증명서인가. 오래된 것은 이번 실행의 증거가 아니다. */
export function readFreshAttestation(
  repoRoot: string,
  spec: string,
  notBefore: number,
): BoundaryAttestation | null {
  const path = attestationPath(repoRoot, spec);
  if (!existsSync(path)) return null;
  try {
    const att = JSON.parse(readFileSync(path, "utf8")) as BoundaryAttestation;
    if (typeof att.at !== "number" || att.at < notBefore) return null;
    if (!Array.isArray(att.touched) || att.touched.length === 0) return null;
    if (!Array.isArray(att.kinds) || att.kinds.length === 0) return null;
    return att;
  } catch {
    return null;
  }
}

export function readRequirements(repoRoot: string): string {
  return readFileSync(resolve(repoRoot, "docs", "requirements.md"), "utf8");
}
