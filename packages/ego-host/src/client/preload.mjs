// #582 S2a — 벤더 런타임 preload (계약 4.2.1).
//
// 불변식 셋.
//  (1) **벤더 모듈을 정적으로 import 하지 않는다.** import 하면 index.js 가
//      `isDirectCli()` 를 거짓으로 보고 `installEgoSdk()` 경로로 새며, 우리가 원하는
//      `runMain()` 경로가 아니게 된다.
//  (2) 최상위 await 로 소켓 연결·핸드셰이크를 끝낸 뒤 `globalThis.ego` 를 세운다.
//      벤더 `state.ts` 는 모듈 로드 시점에 `.env` 를 읽으므로 환경은 spawn 시점에 이미 있어야
//      하고, `ego` 는 첫 헬퍼 호출 전에 있어야 한다.
//  (3) Node 는 `--import` 를 worker·fork·cluster 자식에도 전파한다. worker 는
//      `isMainThread` 로 즉시 빠지고, fork·cluster 는 별도 프로세스라 그 검사에 안 걸리므로
//      **토큰의 단일 사용**이 막는다. 거부는 던져서 자식을 죽인다 — 반쪽 `ego` 를 남기면
//      그 자식은 남의 세션에 붙은 채로 돈다.
import { isMainThread } from "node:worker_threads";

const socketPath = process.env.EGO_HOST_SOCKET;
const token = process.env.EGO_HOST_TOKEN;

if (isMainThread && socketPath && token) {
  const { connectSupervisor } = await import("./rpc-client.mjs");
  const { createEgoProxy } = await import("./ego-proxy.mjs");
  const grant = process.env.EGO_HOST_GRANT ? JSON.parse(process.env.EGO_HOST_GRANT) : null;
  const client = await connectSupervisor({
    socketPath,
    token,
    grant,
    operationId: process.env.EGO_HOST_OPERATION_ID || null,
    workspaceId: process.env.EGO_HOST_WORKSPACE_ID || null,
    deadline: process.env.EGO_HOST_DEADLINE_MS ? Number(process.env.EGO_HOST_DEADLINE_MS) : null,
  });
  globalThis.ego = createEgoProxy(client);
}
