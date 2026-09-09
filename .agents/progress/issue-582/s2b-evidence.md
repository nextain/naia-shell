# S2b 증거 — Chromium 런처(`--remote-debugging-pipe`)·lease·시작 조정 (2026-09-09)

대상: 계약 `docs/progress/issue-582-ego-browser-host.md` 5판의 9절 S2b 행(4.6 (1)(3)·4.8·4.9·12절).
worktree `feat/582-ego-browser-host`. **이 슬라이스부터 실브라우저다** — 가짜 CDP 백엔드가 아니다.

## 만든 것

| 자리 | 무엇 |
|---|---|
| `src/supervisor/browser-discovery.mjs` | 세 OS 후보 탐색. `platform`·`env`·`fs` 주입, 명시 경로 최우선, Flatpak 감지·제외 |
| `src/supervisor/chrome-launcher.mjs` | `--headless=new --remote-debugging-pipe` spawn, 자식 fd 3·4 파이프, `\0` 구분 JSON, cdp-mux 백엔드 인터페이스 |
| `src/supervisor/lease.mjs` | `<ADK>/ego-host/lease.json` 원자적 쓰기, marker 확인 세 OS 분기 |
| `src/supervisor/reconcile.mjs` | 시작 조정 (a) 회수·입양 / (b) 불간섭 / (c) 삭제 + `unverified`·`unreadable` |
| `src/supervisor/supervisor.mjs` | 조정 → 탐색 → 런처 → lease → 소켓. `stop()` 은 `Browser.close` → 대기 → 파이프 닫기 → SIGKILL → lease 삭제 |
| `src/errors.mjs` | 코드 넷 추가(`BROWSER_NOT_FOUND`·`BROWSER_LAUNCH_FAILED`·`BROWSER_GONE`·`LEASE_INVALID`) |
| `test/discovery.test.mjs`·`launcher.test.mjs`·`lease.test.mjs` | 35건. `lease` 골격 todo 는 실제 테스트로 바뀌었다 |
| `test/helpers/live-browser.mjs`·`run-supervisor.mjs`·`marker-sleep.mjs` | 실브라우저 지그, 별도 프로세스 감독자, marker 를 단 대조군 프로세스 |

## 검증 (전부 종료 코드)

| 명령 | 결과 |
|---|---|
| `cd packages/ego-host && npm test` | **EXIT=0** — tests 102, pass 98, fail 0, todo 4 |
| `node scripts/sync-ego-lite.mjs --check` | EXIT=0 (126개 파일, 벤더 무변경) |
| `npx tsc -p tsconfig.json` (worktree 루트) | EXIT=0 |
| `pnpm test` (worktree 루트) | EXIT=1 — 실패 7건이 기준선과 **파일·테스트 이름까지 동일(diff 0)**, 1622 passed |
| `bash scripts/enforce-root-structure.sh` | EXIT=1 — 기존 위반 2건(`tmp/`, `tsconfig.build.json`)만, 증감 없음 |
| `node scripts/check-file-anchors.mjs` | EXIT=0 (69 파일) |
| `node scripts/check-traceability.mjs --enforce` | EXIT=0 |
| `pgrep -f 'naia-ego-[m]arker'` (테스트 뒤) | **0건** — 브라우저·감독자 잔존 없음 |

테스트 102건 내역: S1 `vendor-install` 6, S2a `conformance` 24 · `handshake` 11 · `rpc-transport` 16 ·
`provenance` 6, **S2b `discovery` 12 · `launcher` 7 · `lease` 16**, todo 4.
남은 todo 4건은 전부 S2b 범위 밖이다: `isolation`(S2d), `mediator`(S2d), `cancel`(S2e),
`no-interference`(S2e — 무간섭 (2) 활성 창 불변).

## 실측값

### 감독자 SIGKILL → Chromium 소멸

별도 프로세스(`test/helpers/run-supervisor.mjs`)로 감독자를 띄우고 그 PID 에 SIGKILL 을 보낸 뒤
Chromium PID 가 사라질 때까지 50ms 간격으로 확인했다. 제한 시간 10초.

| 회차 | 소멸까지 |
|---|---|
| 1 (`lease.test.mjs` 단독 실행) | **201ms** |
| 2 (`npm test` 전체) | **200ms** |

정리 코드는 한 줄도 돌지 않았다. Chromium 을 내린 것은 부모 쪽 파이프가 닫히며 생긴 EOF 다
(계약 4.8 이 추측으로 남겼던 항목이 실측으로 확정됐다). SIGKILL 뒤 lease 파일은 그대로 남고,
다음 시작의 조정이 `stale` 로 판정해 지운다 — 고아 0.

### 후손 fd 부재 (계약 4.8)

- 런처가 연 부모 쪽 익명 통로: **4개**(fd 3·4 CDP 파이프 + stdout·stderr).
- 런처 **뒤에** spawn 한 다른 자식(`node -e`, stdio 세 칸)의 `/proc/<pid>/fd`: 그 4개 중 **0개**.
- **탐침 반증 시험**: 같은 자식에게 `stdio` 4·5번으로 CDP 파이프를 일부러 넘기자 탐침이 2개를
  잡아냈다. 탐침이 "늘 통과하는 장식"이 아님을 확인했다.

### 무간섭 (계약 4.6)

- **(1) 명령줄**: 실제 `/proc/<pid>/cmdline` 에 `--headless=new`·`--remote-debugging-pipe`·marker 확인.
  `Browser.getVersion` 의 userAgent 도 `HeadlessChrome`.
- **(3) 창 소유**: `xdotool search --pid <chromium pid>` 결과 **빈 문자열**. `xdotool` 은 이 머신에
  `/usr/bin/xdotool` 로 있으며, 없으면 건너뛰지 않고 RED 가 되도록 테스트가 단언한다.
- **(2) 활성 창 불변**은 S2e 다(`no-interference.test.mjs` todo 로 남김).

## 계약과 달랐던 판단

1. **Playwright 리눅스 배치는 `chrome-linux64` 다.** 지시문·통설의 `chrome-linux/chrome` 은 이 머신에
   없다(실측: `~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`). 두 배치를 모두 후보로 두고,
   빌드 번호는 문자열이 아니라 **숫자로** 정렬한다(문자열이면 `chromium-999` 가 `chromium-1234` 를 이긴다).
2. **`google-chrome` 은 이름이 아니라 내용으로 걸러낸다.** 이 머신의 `~/.local/bin/google-chrome` 은
   `exec flatpak run com.google.Chrome "$@"` 두 줄짜리 래퍼다. 그대로 spawn 하면 Chromium 이 아니라
   flatpak 이 뜨고 fd 3·4 가 샌드박스 경계에서 사라진다. 파일 머리 512바이트에 `flatpak run` 이 있으면
   `usable:false` 로 내린다. 계약 12절의 "Flatpak 은 감지만"을 경로 목록이 아니라 판별로 옮긴 것이다.
3. **Chromium 은 `/proc/<pid>/cmdline` 을 공백으로 이어 붙인다.** Chromium 이 시작하며 argv 를 통째로
   다시 쓰고 `--ozone-platform=headless` 등을 덧붙이는 탓에 NUL 이 끝에 하나뿐이다(실측). 계약 4.9 의
   "`/proc/<pid>/cmdline` + marker" 를 `split("\0")` 로 구현하면 우리 브라우저가 **전부** "남의 프로세스"로
   판정돼 회수가 통째로 죽는다. 토큰 판정을 `\0` 과 공백 둘 다를 구분자로 보는 경계 일치로 바꿨다.
   같은 함수가 macOS 의 `ps -o command=`(공백 구분)도 덮는다.
4. **libuv 의 stdio 파이프는 socketpair 다.** `/proc/<pid>/fd` 에 `pipe:[N]` 이 아니라 `socket:[N]` 으로
   보인다(실측). `pipe:` 만 찾는 후손 fd 탐침은 영원히 빈손이라 **항상 통과**한다. 탐침이 둘 다 본다.
5. **win32 조정은 회수하지 않는다.** 계약 4.9 는 "생존만 확인하고 marker 는 미실측"이라고만 적었고
   처분을 적지 않았다. 확인하지 못한 프로세스를 죽이는 것은 "marker 일치만 회수"(4.8)와 정면으로
   어긋나므로 `unverified` 상태로 **기록만** 하고 고아 1 로 센다. 회수는 windows4060 실측 게이트 몫이다.
6. **(b) marker 불일치에서 lease 파일도 지우지 않는다.** 계약의 "절대 건드리지 않고 기록"을 문자 그대로
   따랐다. 다음 시작이 새 lease 를 원자적으로 덮어쓰므로 판정이 영구히 반복되지는 않는다.
7. **`unreadable` 상태를 하나 더 뒀다.** 계약은 세 갈래만 적는다. 깨진 lease 는 소유를 증명하지 못하므로
   아무 PID 도 건드리지 않고 파일만 치운다 — 그 상태에서 안전한 다른 행동이 없다.
8. **`stop()` 에 "파이프 닫기" 단계를 넣었다.** 계약은 `Browser.close` → 대기 → 프로세스 종료다.
   파이프 EOF 는 SIGKILL 보다 순한 회수이고 실측상 200ms 안에 듣는다. 그래서 대기와 SIGKILL 사이에 뒀다.
   정상 경로에서는 `Browser.close` 로 끝나며 테스트가 `forced === false` 를 단언한다.
9. **런처 반환 핸들은 child 객체도 스트림도 노출하지 않는다.** 계약 4.8 은 "부모 쪽 스트림을 감독자 내부
   클로저에만"이라고 적는다. `child` 를 돌려주면 `child.stdio` 로 그 규율이 무너지므로 핸들에 넣지 않았고,
   테스트가 핸들 값 중 스트림이 없음을 확인한다.
10. **파이프 스트림을 종료 시 명시적으로 파괴한다(`dispose`).** 넣기 전에는 모든 테스트가 통과한 뒤에도
    node 프로세스가 종료하지 못하고 매달렸다(실측 — 2분 넘게). 열린 스트림 핸들이 이벤트 루프를 붙잡는다.
    감독자를 데몬으로 돌릴 때 이 한 줄이 "정상 종료"와 "영원히 안 죽음"을 가른다.
11. **무간섭 (1)(3) 을 `launcher.test.mjs` 에 뒀다.** `no-interference.test.mjs` 는 (2) 활성 창 불변을
    포함한 S2e 묶음이라 골격 todo 로 남겼다. 이 슬라이스가 든 두 겹은 런처 옆에 있는 편이 읽기 쉽다.
12. **THIRD_PARTY_NOTICES 는 손대지 않았다.** #228 의 코드를 가져오지 않았고, 저장소에도 그 자료가 없다
    (`vendor/ego-lite/package/` 에는 `ego-browser` 뿐). Windows 후보 경로는 Chrome·Edge 의 일반 설치 관례로
    적었고, 계약 12절이 말한 "#228 을 따르되"는 **windows4060 실측 때 대조할 항목**으로 남는다.
    README 표에도 "이름만 참조했고 코드를 가져오지 않았다"고 적었다.

## 미실측 (명시)

- **win32**: 후보 경로·경로 구분자·`unverified` 분기까지 단위 검증만 했다. HANDLE 비상속, named pipe 위
  감독자 기동, `--remote-debugging-pipe` 의 fd 3·4 상속, marker 확인 수단 전부 windows4060 게이트다.
- **darwin**: 후보 경로와 `ps -p <pid> -o command=` 호출 형태만 주입 검증했다. 기기가 없어 기동·회수 미실측.
- **레지스트리 App Paths**: 상수만 두고 조회하지 않는다. 테스트가 "후보 목록에 섞이지 않음"을 확인한다.
- **Flatpak Chrome 으로의 실제 파이프 전달 실패**: 제외 판정만 했고 "정말 막히는지"는 재현하지 않았다.
  `EGO_HOST_BROWSER` 로 명시하면 시도는 할 수 있으며, fd 3·4 가 안 열리면 런처가
  `EGO_HOST_BROWSER_LAUNCH_FAILED` 로 형식 있게 죽는다.

## S2c 이후로 넘긴 것

- 정책·장부(`route` 훅)는 여전히 기본 허용이다. 기본 거부 행렬은 S2d.
- 격리 브라우저 컨텍스트·타깃 lease·세대·묘비는 S2c.
- 작업별 세션·취소 훅·스냅샷·캡처·무간섭 (2) 는 S2e.
- ADK 전환(A 종료 → B 조정)의 어댑터 강제는 S3b. 이 슬라이스는 같은 ADK 안의 재시작만 확인했다.
