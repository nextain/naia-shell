# S6c 증거 — 웹뷰 → Rust → Node 감독자 다리 (#582)

작성 2026-09-10. 계약: `docs/progress/issue-582-ego-browser-host.md` 4.2·4.4·4.5·4.8·4.9,
9절 S6a·S6b 행과 `.agents/progress/issue-582/s0-review-fable.md` 마지막 절(S6c 요구).
worktree `/var/home/luke/alpha-adk/.worktrees/naia-shell-582-ego-host`, 브랜치 `feat/582-ego-browser-host`.

커밋 셋: `af909a91`(ego-host 관리 채널·데몬), `669f874c`(Rust 다리), `bf831dbe`(웹뷰 어댑터·패키징·풀스택 e2e).

## 1. 이 슬라이스가 닫은 구멍

S6a 는 도구를, S6b 는 회수를 놓았지만 그 사이가 비어 있었다. 셸 웹뷰에는 node 가 없어 코어
어댑터의 기본 로더(`packages/ego-host/src/host-api.mjs` 동적 import)가 웹뷰에서는 늘 실패했다.
테스트가 초록이어도 사용자는 도구를 쓸 수 없었고, 그래서 S4·S6a·S6b 리뷰가 "완료가 아니다" 로
남긴 항목이 이것이다. 이제 경로가 이렇게 이어진다.

```
뇌/채팅 → 웹뷰 EnvironmentToolService(등급·승인)   ← 판정은 여기서만 한다
        → 코어 어댑터 ego-browser-env.ts            ← 안정 참조·개정·attach·증거 조립
        → ego-browser-env-ipc.ts (EgoHostApi over IPC)
        → ego_host_* Tauri 명령 (ego_host_bridge.rs)
        → 4바이트 길이 접두 프레임 / unix 소켓
        → packages/ego-host/bin/supervisord.mjs (Rust 의 소유 자식)
        → 감독자 → 실 Chromium
```

## 2. 무엇을 만들었나

| 파일 | 무엇 |
|---|---|
| `packages/ego-host/src/supervisor/rpc-server.mjs` | 관리 연결(`{admin:<secret>}` 핸드셰이크)과 `ADMIN_RPCS`. 작업 연결은 `issueToken`·`stop`·`switchAdk` 를 부를 수 없다 |
| `packages/ego-host/src/errors.mjs` | 안정 코드 셋(`EGO_HOST_ADMIN_REQUIRED`·`_DENIED`·`_UNAVAILABLE`) |
| `packages/ego-host/bin/supervisord.mjs` | 새 파일. 데몬 진입점 — 감독자 기동, 준비 줄(JSON) 한 줄, SIGTERM·stdin EOF 에 `stop()` |
| `packages/ego-host/test/admin-channel.test.mjs` | 새 파일. 9건(관리 통로 6 + 실 Chromium 데몬 3) |
| `packages/shell/src-tauri/src/ego_host_bridge.rs` | 새 파일. 소켓 경로 규칙·프레이밍·관리 연결·작업 연결(세션)·명령 아홉·데몬 소유. 단위 테스트 7건 |
| `packages/shell/src-tauri/src/lib.rs` | 새 모듈 선언 1 + `generate_handler!` 6 + 정리 훅 3 = **10줄**. 함수 정의 없음 |
| `packages/shell/src-tauri/Cargo.toml` | tokio 기능에 `io-util` 추가(§6) |
| `packages/shell/src-tauri/tauri.conf.json` | `bundle.resources` 4줄(§5) |
| `packages/shell/src/lib/ego-browser-env-ipc.ts` | 새 파일. `EgoHostApi` 의 IPC 구현 |
| `packages/shell/src/lib/browser-host-skill.ts` | 로더 선택(주입 > IPC 다리 > 없음), `browserHostApiSource()`, e2e 이음매 |
| `packages/shell/src/lib/__tests__/ego-browser-env-ipc.test.ts` | 새 파일. vitest 9건 |
| `packages/shell/src/lib/__tests__/browser-host-skill.test.ts` | 조립이 무는 면을 재는 3건 추가(22 → 25) |
| `packages/shell/e2e-tauri/specs/env-tool-browser-host-fullstack.spec.ts` | 새 파일. 풀스택 4건 |
| `packages/shell/e2e/env-tool-browser-host.spec.ts` | 대역에 `ego_host_*` 응답 + "DEV 에서는 다리로 가지 않는다" 단언 |
| `packages/shell/scripts/build-e2e-tauri.mjs` | 벤더 dist 확인·지난 심링크 회수(§7 사고) |
| `src/main/adapters/ego-browser-env.ts` | 세 자리를 `await` 로 넓힘(§4) |
| `src/main/composition/index.ts` | `EgoGrant`·`EgoHostApi` 타입 재노출 2줄 |
| `docs/e2e-inventory.json` | `build-e2e-inventory.mjs` 생성물 |

## 3. 공유 파일에 넣은 정확한 hunk

### `packages/shell/src-tauri/src/lib.rs` — 10줄 (주석 3줄 별도)

```
+mod ego_host_bridge;                                       (mod ego_host; 바로 뒤)

  .invoke_handler(tauri::generate_handler![ 바로 뒤:
+            // #582 S6c: 웹뷰 → Rust → node 감독자 다리. 판정은 웹뷰 서비스가 한다.
+            ego_host_bridge::ego_host_ensure, ego_host_bridge::ego_host_issue_token,
+            ego_host_bridge::ego_host_rpc, ego_host_bridge::ego_host_session_open,
+            ego_host_bridge::ego_host_session_rpc, ego_host_bridge::ego_host_session_cdp,
+            ego_host_bridge::ego_host_session_close, ego_host_bridge::ego_host_switch_adk,
+            ego_host_bridge::ego_host_stop,

  restart_agent() 안, ego_host::cleanup_current_adk("cleanup(restart)") 바로 앞:
+    ego_host_bridge::stop_blocking("cleanup(restart)"); // #582 S6c: 다리가 띄운 감독자 데몬 먼저

  reset_naia_config_files() 안, ego_host::cleanup_ego_host(...) 바로 앞:
+    ego_host_bridge::stop_blocking("cleanup(reset)"); // #582 S6c

  on_window_event 의 Destroyed 안, crate::ego_host::cleanup_current_adk("cleanup(shutdown)") 바로 앞:
+                    crate::ego_host_bridge::stop_blocking("cleanup(shutdown)"); // #582 S6c
```

순서에 뜻이 있다. **lease 회수(S6b)보다 다리의 데몬을 먼저 내린다.** 데몬은 우리가 띄운
자식이라 PID 추측 없이 확실히 회수되고, 데몬이 정상 종료하면 감독자가 Chromium 을 닫아
lease 자체가 사라진다. 순서를 뒤집으면 lease 회수가 Chromium 을 먼저 죽이고, 그 뒤 감독자가
"브라우저가 사라졌다" 를 만나 불필요한 오류 경로를 밟는다.

`platform/linux.rs`·`windows.rs`·`macos.rs`·`App.tsx`·`SettingsTab.tsx`·`adk-store.ts`·
`updater.ts`·`ChatArea.tsx` 는 **한 줄도 건드리지 않았다**.

### `src/main/composition/index.ts` — 2줄

```
+// #582 S6c: 셸이 감독자 모듈 자리에 IPC 구현을 꽂으려면 그 면의 타입이 필요하다.
+export type { EgoGrant, EgoHostApi } from "../adapters/ego-browser-env.js";
```

### `packages/shell/src-tauri/tauri.conf.json` — 6줄

`bundle` 안에 `resources` 하나. `ego-host` 의 `src`·`bin`·`package.json` 과 벤더 SDK
`dist` 만 담는다. 벤더 `node_modules`(68MB)는 개발 의존이라 담지 않는다.

## 4. 계약과 달랐던 판단

### 4.1 포트 셋을 다시 쓰지 않고 **그 아래 한 겹**을 IPC 로 바꿨다

브리프는 `ego-browser-env-ipc.ts` 가 `BrowserWorkspacePort`·`BrowserOperationPort`·
`CancellationPort` 를 `invoke` 로 구현하라고 적었다. 그러지 않았다.

세 포트는 코어 어댑터가 이미 구현하고 있고, 그 안에 안정 참조 검사(`assertLiveRef`)·개정
대조·attach·문서 로드 대기·증거 셋 조립이 들어 있다. 웹뷰에서 포트를 새로 쓰면 **같은 뜻의
구현이 둘**이 되고, 둘이 갈라지는 날 실 Chromium 으로 돌던 S3a 계약 테스트가 웹뷰의 동작을
더는 증명하지 못한다. S6b 가 marker 경계에서 겪은 것과 같은 종류의 위험이다.

그래서 이 파일이 채우는 것은 어댑터가 보는 좁은 면(`EgoHostApi`) 하나다. 그 위는 전부 실물이고
아래로는 Tauri 명령뿐이다. 브리프의 명령 목록(`ego_host_ensure`·`issue_token`·`rpc`·
`session_open/rpc/close`·`switch_adk`·`stop`)은 그대로이며, CDP 를 나르기 위해
`ego_host_session_cdp` 하나를 더했다.

### 4.2 비동기가 된 세 자리에 `await` 를 넣었다

node 안에서는 동기였던 `issueToken`·`ensureDirs`·`writeEnvFiles` 가 IPC 를 지나면 Promise 다.
어댑터의 세 호출부에 `await` 를 넣고 타입을 `T | Promise<T>` 로 넓혔다. 문자열을 await 해도
같은 문자열이라 node 조립(S3a 계약 테스트)은 그대로 돈다.

### 4.3 `ensureDirs` 는 감독자 전에는 아무 일도 하지 않는다

어댑터는 감독자를 띄우기 **전에** 자리를 만들라고 부르는데, 그 시점에는 관리 통로가 아직 없다.
첫 실기가 정확히 이 순서로 걸렸다(`감독자가 떠 있지 않다. ego_host_ensure 를 먼저 부른다`).
그 네 자리는 데몬이 기동하며 만든다(`supervisord.mjs` 의 `hostDirs`). 그래서 감독자 전에는
명령을 내보내지 않는다 — 없는 통로에 대고 실패를 만들지 않는다. 단위 테스트가 그 자리를
"명령 0회 → 감독자 뒤에는 1회" 로 고정한다.

### 4.4 `stop` 은 응답을 기다리지 않는다

감독자를 내리는 일이 소켓 서버를 함께 닫으므로, `stop` 의 응답이 돌아올 통로가 그 처리 도중에
사라진다(측정: 관리 연결이 2초 상한을 채우고 null 을 받았다). 그래서 판정은 응답이 아니라
**프로세스**가 한다 — Rust 는 관리 통로로 알린 뒤 stdin 을 닫고(EOF), 남으면 자식을 죽인다.

### 4.5 `operations.list()` 는 빈 목록을 돌려준다

장부 목록은 IPC 를 지나면 비동기라 동기 자리에 담을 수 없다. 어댑터의 `stateOf` 하나만 이것을
쓰고 서비스는 자기 장부로 상태를 판정한다. 지어낸 상태를 돌려주면 그 거짓이 어딘가에서 완료로
읽히므로 **비었다고 말한다**. 같은 이유로 `pidAlive` 는 불리면 던진다("이 다리에서 재지 않는다").

### 4.6 풀스택 실기의 도구 호출은 뇌를 거치지 않는다

브리프가 허용한 길이다. 실기에서 뇌를 부르면 LLM 이 그 도구를 고를 때까지 기다려야 하고 그
선택은 결정적이지 않다. 그래서 `browser-host-skill.ts` 에 이음매 하나를 두고
(`window.__NAIA_BROWSER_HOST_CALL__`), ChatArea 가 부르는 그 실행기를 같은 인자로 부른다.

대역이 아니다 — 서비스·등급표·승인 장부·감독자·Chromium 이 전부 실물이고, 승인 장부를 이
문이 채우지 않으므로 승인 없는 `env_browser_script` 는 이 길로도 거부된다((c) 케이스가 그것을
잰다). 권한도 늘지 않는다: 웹뷰에서 도는 코드는 이미 `invoke("ego_host_*")` 로 감독자에 직접
닿을 수 있고, 이 문은 반드시 서비스의 판정을 지나므로 **더 좁다**. ChatArea 의 분기 40줄은
S6a 의 Playwright 가 실 UI 에서 이미 밟는다.

### 4.7 `#[cfg]` 를 `platform/` 밖에 두었다

unix 도메인 소켓과 named pipe 는 같은 API 로 다룰 수 없다. `platform/linux.rs` 는 다른 세션이
고치는 중이라 새 함수를 더할 수 없어(브리프의 충돌 최소화 목록), 분기를 `ego_host_bridge.rs` 의
`connect_stream` **두 함수 안에만** 가뒀다. 다른 곳은 전부 `AsyncRead + AsyncWrite` 로만 말한다.

## 5. 패키징 경로

- **dev**: `NAIA_EGO_HOST_DIR` > `resource_dir/ego-host` > cwd 기준 `../../ego-host`·`../ego-host`·
  `packages/ego-host`. 사람이 정한 값이 가장 세고 소스 트리가 가장 약하다 — 소스를 먼저 보면
  설치된 앱이 개발자의 체크아웃을 물고 돈다.
- **번들·E2E**: `tauri.conf.json` 의 `bundle.resources` 가 `resource_dir/ego-host` 를 채운다.
  tauri-build 는 E2E 빌드에서도 리소스를 `CARGO_TARGET_DIR/debug` 로 복사하므로, 실기가 dev
  경로가 아니라 **번들과 같은 경로**를 밟는다(실측: `target-e2e/debug/ego-host/bin/supervisord.mjs`
  9,690바이트).
- 벤더 SDK dist 는 `env_browser_script` 만 쓴다. `build-e2e-tauri.mjs` 는 dist 가 없고
  `node_modules` 가 있을 때만 `npm run build` 를 돌린다. **`npm ci` 는 돌리지 않는다** — 네트워크를
  요구하고 이 실기는 오프라인이어야 한다. `node_modules` 가 없으면 그 사실을 찍고 넘어간다.

## 6. 의존성

새 크레이트를 더하지 않았다. tokio 기능에 **`io-util` 하나**를 더했다(`AsyncReadExt`·
`AsyncWriteExt`·`tokio::io::split`). unix 소켓은 이미 있던 `net`, 해시는 이미 있던 `sha2`,
난수는 이미 있던 `getrandom`, 임시 디렉터리는 이미 있던 `tempfile` 을 쓴다. Windows named pipe 도
tokio 의 `net` 이 든다 — `interprocess` 는 필요 없었다.

## 7. 실기가 잡은 것 — 리소스 심링크가 소스를 0바이트로 만든다

첫 패키징 시도는 `<target>/debug/ego-host` 를 `packages/ego-host` 로 **심링크**했다(벤더
node_modules 68MB 를 빌드마다 복사하지 않으려고). 그 상태로 `build:e2e:tauri` 를 다시 돌리자
`packages/ego-host` 의 소스 23개와 벤더 dist 51개가 **전부 0바이트가 됐다**.

원인: `bundle.resources` 를 선언한 순간 tauri-build 가 리소스를 `resource_dir` 로 복사하는데,
그 자리가 심링크라 **원본을 자기 자신 위에 복사**했다. 파일을 truncate 로 열고 같은 파일을 읽으니
남는 것은 0바이트다.

- 고친 것: 심링크 staging 을 걷어내고 tauri 의 리소스 복사가 그 자리를 소유하게 했다.
  `build-e2e-tauri.mjs` 는 지난 실행이 남긴 심링크가 있으면 걷어낸다(같은 사고 재발 방지).
- 회수: git 이 든 23개는 `HEAD` 에서 되살렸고(0바이트인 파일만), gitignore 대상인 벤더 dist 51개는
  `npm run build` 로 다시 만들었다. 회수 뒤 `packages/ego-host npm test` 164건이 다시 종료 0 이다.
- 남기는 교훈: 리소스 목적지에 소스를 가리키는 링크를 두지 않는다. 복사기는 링크를 따라간다.

## 8. 검증 (전부 종료 코드)

```
$ cd packages/ego-host && npm test
  tests 164 / pass 164 / fail 0                                        EXIT=0
  ↳ S6b 시점 155 + S6c 신규 9

$ cd packages/shell/src-tauri && NAIA_AGENT_SCRIPT=… NAIA_AGENT_PROTO_DIR=… \
    CARGO_TARGET_DIR=target-e2e cargo test ego_host
  21 passed; 0 failed; 319 filtered out                                EXIT=0
  ↳ S6b 14 + S6c 7(소켓 경로 3·프레이밍 3·관리 비밀 1)

$ npx tsc -p tsconfig.json                                             EXIT=0
$ cd packages/shell && npx tsc -b --noEmit                             EXIT=0

$ cd packages/shell && npx vitest run src/lib/__tests__/ego-browser-env-ipc.test.ts
  9 passed                                                             EXIT=0
$ cd packages/shell && npx vitest run src/lib/__tests__/browser-host-skill.test.ts
  25 passed                                                            EXIT=0

$ cd packages/shell && npx playwright test e2e/env-tool-browser-host.spec.ts
  7 passed                                                             EXIT=0

$ cd packages/shell && pnpm run build:e2e:tauri                        EXIT=0
$ cd packages/shell && env -u DISPLAY -u WAYLAND_DISPLAY \
    WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1 \
    cage -- pnpm exec wdio run e2e-tauri/wdio.conf.ts \
      --spec e2e-tauri/specs/env-tool-browser-host-fullstack.spec.ts
  ✓ (a) env_browser_open 이 실 Chromium 의 증거 셋을 돌려주고 캡처가 실제 PNG 다
  ✓ (b) env_browser_click 이 안정 참조로 실제 요소를 누른다
  ✓ (c) 승인 없는 env_browser_script 는 실기에서도 거부된다
  ✓ (d) 앱을 닫으면 감독자와 Chromium 이 남지 않는다
  4 passing / Spec Files: 1 passed                                     EXIT=0

$ cd packages/shell && pnpm test        (vitest 전체)
  Test Files 7 failed | 184 passed | 2 skipped (193)
  Tests 48 failed | 1905 passed | 21 skipped (1974)                    EXIT=1
  ↳ 기준선(S6a 증거 §6)의 7파일·48건과 **같다**. 통과가 1893 → 1905 로 12 늘었다(신규 9+3).

$ pnpm test        (루트)
  Test Files 5 failed | 100 passed | 1 skipped (106)
  Tests 7 failed | 1639 passed | 4 skipped (1650)                      EXIT=1
  ↳ `baseline-root-test-20260909.txt` 의 7건과 **이름까지 같다.** 새 실패 0.

$ node scripts/check-file-anchors.mjs           OK 70 파일          EXIT=0
$ node scripts/check-traceability.mjs --enforce dead-link 0·orphan 0 EXIT=0
$ node scripts/check-uc-traceability.mjs        새로 끊긴 UC 없음   EXIT=0
$ node scripts/build-e2e-inventory.mjs --check  108개 일치          EXIT=0
$ bash scripts/enforce-root-structure.sh        기존 위반 2건만(tmp, tsconfig.build.json)

$ pgrep -f 'supervisord.mjs'      출력 없음
$ pgrep -f 'naia-ego-marker'      출력 없음
$ pgrep -f '^cage'                출력 없음                          (잔류 0)
```

### 진입 번들 예산

`scripts/check-bundle-budget.mjs` 는 이 변경 **전에도** 실패한다. 같은 명령을 이 슬라이스의
웹뷰 변경을 걷어 낸 상태(`git stash push -- packages/shell/src src/main src/test`)에서 돌려
확인했다.

| | 이 변경 없이 | 이 변경 뒤 | 예산 |
|---|---|---|---|
| entryRawBytes | 518,770 | 519,144 | 500,000 |
| entryGzipBytes | 162,636 | 162,812 | 160,000 |

+374바이트다. IPC 구현을 **미룬 import** 로 둔 결과이며(브라우저 도구를 한 번도 안 쓰는
사용자의 첫 화면에 다리 코드가 실릴 이유가 없다), 정적으로 물었을 때는 +3,830바이트였다.
예산 초과 자체는 이 슬라이스가 만든 것이 아니고 고치지도 않았다.

## 9. 풀스택 e2e 가 실제로 무엇을 밟았나

```
[s6c] 증거 캡처=/tmp/naia-shell-e2e-<run>/adk/ego-host/evidence/e2e-306e4539-mtugq5nm-2.png (10291바이트)
      스냅샷=/tmp/naia-shell-e2e-<run>/adk/ego-host/evidence/e2e-306e4539-mtugq5nm-1.snapshot.txt
```

- (a) 로컬 픽스처(`http://127.0.0.1:<임의 포트>/fixture`, 스펙이 띄운다. 외부 네트워크 0)를 열고
  증거 셋 셋을 다 받는다. 캡처는 **PNG 매직 바이트**로 확인하고 증거 디렉터리 안인지 본다.
  스냅샷 파일에 픽스처의 `확인 단추` 가 들어 있다 — 실 Chromium 이 그 페이지를 실제로 그려
  접근성 트리를 낸 것이 아니면 나올 수 없는 문자열이다.
- (b) 스냅샷의 `ref=<backendNodeId>` 를 읽어 그 참조로 누른다. 눌렀다는 주장이 아니라
  `document.getElementById('out').textContent` 를 되읽어 `clicked` 로 바뀐 **사실**을 확인한다.
  없는 참조(`999999`)로는 통과하지 않는다.
- (c) 승인 없는 `env_browser_script` 가 `approval-missing` 으로 거부되고, 그 거부가 관측 도구를
  망가뜨리지 않는다.
- (d) `plugin:window|close` 로 창을 닫은 뒤 lease 의 Chromium PID 와 감독자 데몬 PID 가 둘 다
  사라지고 lease 파일이 정리된다. `browser.deleteSession()` 은 이 경로를 밟지 않는다(S6b 실측).

## 10. 미실측

- **win32 named pipe.** `connect_stream` 의 Windows 갈래는 코드만 있고 실기로 재지 않았다
  (계약 4.9 windows4060 게이트). 소켓 **경로 규칙**은 `socket-path.mjs` 를 실제로 실행해 세
  플랫폼 값을 대조했으므로 이름은 맞지만, 그 이름에 붙는 일은 재지 않았다.
- **darwin.** 기기가 없다. 경로 규칙만 대조했다.
- **번들 리소스 복사의 실제 산출물.** `bundle.resources` 는 E2E 빌드(`bundle.active:false`)에서
  `CARGO_TARGET_DIR/debug` 로 복사되는 것까지 확인했다. 설치용 번들(`tauri build`)은 이 세션에서
  만들지 않았으므로 설치본의 `resource_dir` 배치는 미실측이다.
- **`env_browser_script` 의 성공 경로.** 승인 참조가 있는 묶음 실행은 실기로 돌리지 않았다.
  승인 UI 가 아직 없어(S6a §4-3) 장부를 채울 사람 경로가 없다. 감독자 쪽 실행은 S3a 계약
  테스트가 실 Chromium 으로 돈다.
- **ADK 전환(`ego_host_switch_adk`)의 실기.** 데몬 쪽 순서(A 종료 → 소멸 확인 → B 조정 → B 시작)는
  구현했고 관리 RPC 로 열려 있으나, 실기에서 두 ADK 를 오가는 시나리오는 밟지 않았다.
  S3b 의 계약 테스트가 어댑터 수준에서 같은 순서를 잰다.

## 11. 남는 것

- 승인 UI 배선(FR-ENV-TOOL.14). 지금은 승인 장부를 채우는 사람 경로가 없어
  `env_browser_script` 가 항상 거부된다. 거부는 정확하지만 기능이 열리지는 않았다.
- `.agents/progress/issue-582/s6a-evidence.md` §6 이 적은 `e2e/env-tool-browser.spec.ts` (A) 의
  기존 실패는 그대로다. 다른 세션 파일이라 손대지 않았다.
- 진입 번들 예산 초과(§8)는 이 슬라이스 밖의 문제로 남는다.
