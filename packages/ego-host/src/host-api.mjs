// #582 S3a — 셸 코어 어댑터가 보는 이 패키지의 유일한 면.
//
// `src/main/adapters/ego-browser-env.ts` 는 이 파일 **하나만** 동적 import 한다. 어댑터가
// 감독자 내부 파일을 여러 개 집어 오면 그 순간 패키지 내부 구조가 코어의 계약이 되고,
// S2 의 파일을 옮기는 일이 코어를 깨뜨린다.
//
// 왜 자식 프로세스가 아니라 동적 import 인가(증거 문서 참조):
//  - 감독자는 Chromium 의 **장기 소유자**이고 그 소유자는 셸이다(계약 4.8). 파이프 부모 끝의
//    유일한 소유자가 감독자여야 SIGKILL 뒤에도 고아가 남지 않는데, 감독자를 또 하나의 자식
//    프로세스로 두면 셸→감독자→Chromium 3단이 되어 가운데 단이 죽는 경우가 새로 생긴다.
//  - 코어 tsconfig 는 `rootDir: src` 이고 `.mjs` 를 컴파일 대상에 넣지 않는다. 정적 import 는
//    애초에 불가능하고, 계산된 지정자의 동적 import 만이 tsc 를 지나면서 런타임에 실물을 문다.
export { startSupervisor, STOP_GRACE_MS } from "./supervisor/supervisor.mjs";
export { connectSupervisor } from "./client/rpc-client.mjs";
export { reconcileLease, RECONCILE_STATUS } from "./supervisor/reconcile.mjs";
export { egoHostDir, leasePath, readLease } from "./supervisor/lease.mjs";
export { evidenceDir } from "./supervisor/ax-snapshot.mjs";
export {
  DEFAULT_SDK_DIR,
  LAUNCHER,
  ensureDirs,
  runEgoScript,
  writeEnvFiles,
} from "./client/script-runner.mjs";
