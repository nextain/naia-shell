# S3b 증거 — ADK 전환 순서 (2026-09-10)

대상: `EgoBrowserEnvironment.switchAdk`, `src/test/env-tool-adk-switch.contract.test.ts`.
계약: `docs/progress/issue-582-ego-browser-host.md` 4.8, 9절 S3b 행.

## 1. 검증 (전부 종료 코드)

| 명령 | 결과 |
|---|---|
| `npx tsc -p tsconfig.json` | `EXIT=0` |
| `npx vitest run src/test/env-tool-adk-switch.contract.test.ts` | `EXIT=0`, 4건 통과, todo 0 |
| `pnpm test` | `EXIT=1`, 실패 7건 — 기준선 7건과 같은 이름, 새 실패 0. 1650건 중 1639 통과·4 skip·**todo 0** (S3a·S3b 골격 두 파일의 todo 10건이 전부 실제 테스트가 됐다) |
| `cd packages/ego-host && npm test` | `EXIT=0`, 148건 전부 통과 |
| `node scripts/check-file-anchors.mjs` | `EXIT=0` |
| `node scripts/check-traceability.mjs --enforce` | `EXIT=0` |
| `node scripts/check-uc-traceability.mjs` | `EXIT=0` |
| `pgrep -f 'naia-ego-[m]arker'` (전체 실행 뒤) | 종료 코드 1 — 남은 프로세스 없음 |

## 2. 순서를 무엇으로 강제했나

```
A 정상 종료  →  A 의 Chromium PID 소멸 확인  →  B 의 lease 조정  →  B 시작
```

가운데 칸이 이 슬라이스의 전부다. **"종료를 요청했다"를 기준으로 삼지 않는다.** A 의 Chromium 이
살아 있는데 B 를 시작하면 그 순간 고아가 하나 생기고, B 의 lease 가 A 의 것을 덮어써 영영 회수할
수 없게 된다(계약 4.8). 그래서 `switchAdk` 는 `waitForPidExit(stoppedPid)` 가 참일 때만 다음
칸으로 넘어가고, 거짓이면 `disconnected` 로 던진다 — **B 의 lease 를 건드리지도 않는다.**

전환한 어댑터는 되살아나지 않는다. 성공한 전환은 A 어댑터에 `lostReason` 을 세워, 다음 요청이
A 를 조용히 다시 띄워 ADK 가 둘이 되는 길을 막는다. 어댑터 하나는 ADK 하나에 묶이므로
`switchAdk` 는 B 용 어댑터(`report.next`)를 만들어 돌려준다.

## 3. 순서 위반을 어떻게 시험했나

어기는 길이 없으면 "어기면 오류"는 확인할 수 없는 문장이다. 실제 Chromium 을 억지로 살려 두는
대신, 어댑터의 `loadApi` 이음매에 **내려가지 않는 감독자**를 꽂았다 — `stop()` 은 성공한 척하고
`browserPid` 는 이 테스트 프로세스 자신의 PID(확실히 살아 있다)를 준다. 그 위에서
`switchAdk` 는 `disconnected` 로 실패하고, `reconcileLease` 호출 횟수는 **0**, B 의 lease 파일도
생기지 않는다. 실패했을 때 사람의 프로세스를 건드리지 않는다는 점도 이 방식이 낫다.

## 4. 계약 테스트가 실제로 밟은 것

임시 ADK 두 개(둘 다 경로에 공백이 있다)와 실제 Chromium 이다.

1. **A 종료 → B 조정 → B 시작.** A 의 Chromium PID 가 실제로 사라졌고, A 의 lease 파일은
   지워졌으며 B 의 lease 가 생겼다. B 의 조정 결과는 `no-lease`·고아 0 이다. 전환 뒤 A 어댑터의
   요청은 `disconnected` 이고, B 어댑터는 자기 자리에서 새로 돌며 증거도 B 아래에 남는다.
2. **lease 가 새지 않는다.** B 의 lease 는 A 와 nonce·PID·소켓 경로가 모두 다르고, 프로필은 B
   아래다. B 의 lease 파일 안에 A 의 `ego-host` 경로가 한 글자도 없다.
3. **전환 중 진행 중 작업.** 응답하지 않는 페이지로 이동을 걸어 둔 채 전환하면 그 작업이
   `cancelled` 또는 `disconnected` 로 끝난다 — 성공으로 끝나지 않고, 문자열로 뭉개지지도 않는다.
4. **순서 위반**(3절).

## 5. 계약과 달랐던 판단

- **`switchAdk` 가 B 를 시작까지 한다.** 계약 4.8 은 "A 종료 → B 조정" 까지만 적었지만, 조정만
  하고 멈추면 "조정한 뒤 누군가 B 를 시작한다"는 순서가 계약 밖에 남는다. 시작까지 한 함수 안에
  두어야 순서가 코드로 강제된다. `{ start: false }` 로 끌 수 있게 열어 뒀다(조정만 필요한 자리용).
- **전환 뒤 A 어댑터를 죽은 것으로 표시한다.** 계약에 없던 규칙이다. 표시하지 않으면 A 어댑터의
  다음 요청이 `ensureSupervisor` 를 지나 A 를 다시 띄우고, 그 순간 ADK 두 개가 동시에 산다.
- **연결이 끊기면 대기 중인 CDP 를 바로 끊는다.** 3번 케이스를 짜다 발견했다. 감독자가 내려가도
  각 요청이 자기 상한(기본 60초)을 다 채우고서야 실패해 전환이 몇 분씩 매달렸다. 이제
  `client.onClose` 가 대기 중인 CDP 를 즉시 `disconnected` 로 끊는다.
- **고아 판정을 `pgrep` 에서 PID 로 바꿨다.** `pgrep -f naia-ego-marker` 는 기계 전체를 훑기
  때문에, vitest 가 파일을 병렬로 돌리는 동안 나란히 도는 다른 테스트 파일의 **살아 있는**
  브라우저를 우리 고아로 읽는다(실제로 그렇게 한 번 빨갛게 났다). 각 파일은 자기가 띄운 PID 만
  잰다. 기계 전체를 훑는 `pgrep` 은 전체 실행이 끝난 **뒤** 사람이 한 번 돌리는 검사로 남긴다.

## 6. S4·S6 으로 넘긴 것

- 셸(Rust)의 ADK 전환 경로에서 `switchAdk` 를 부르고 `report.next` 로 어댑터를 갈아 끼우는 일은
  **S6b** 다. 이 슬라이스는 순서를 지키는 함수와 그 함수가 순서를 어기지 못한다는 증거까지다.
- Windows·macOS 의 전환은 미실측이다. `waitForPidExit` 는 `process.kill(pid, 0)` 만 쓰므로 세 OS
  에서 같은 코드로 돌지만, win32 는 marker 를 확인할 수단이 없어 조정이 `unverified` 로 남는
  경로(계약 4.9)가 그대로 있다. windows4060 게이트 항목이다.
