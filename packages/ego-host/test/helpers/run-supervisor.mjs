// #582 S2b — **별도 프로세스**로 감독자를 띄우는 최소 스크립트.
// SIGKILL 실측이 목적이다. 같은 프로세스 안에서는 SIGKILL 을 흉내낼 수 없다 —
// 테스트 러너가 같이 죽기 때문이다.
//
// 사용: node run-supervisor.mjs <adkDir> <runtimeDir>
// stdout 첫 줄에 `{"browserPid":..., "socketPath":"...", "marker":"..."}` 한 줄을 낸다.
import { startSupervisor } from "../../src/supervisor/supervisor.mjs";

const [adkDir, runtimeDir] = process.argv.slice(2);
const supervisor = await startSupervisor({ adkDir, runtimeDir });
process.stdout.write(
  `${JSON.stringify({
    browserPid: supervisor.browserPid,
    socketPath: supervisor.socketPath,
    marker: supervisor.marker,
    supervisorPid: process.pid,
  })}\n`,
);
// SIGKILL 을 기다린다. 이 타이머가 유일한 생존 이유다.
setTimeout(() => {
  process.exit(0);
}, 120_000);
