# S6b 증거 — Rust 생명주기 편입 (#582)

작성 2026-09-10. 계약: `docs/progress/issue-582-ego-browser-host.md` 4.8·4.9, 9절 S6b.
worktree `/var/home/luke/alpha-adk/.worktrees/naia-shell-582-ego-host`, 브랜치 `feat/582-ego-browser-host`.

## 1. 무엇을 만들었나

| 파일 | 무엇 |
|---|---|
| `packages/shell/src-tauri/src/ego_host.rs` | 새 모듈. lease 파싱·marker 경계 판정·조정(회수/보존)·플랫폼 프로세스 조회와 종료. 단위 테스트 14건 포함 |
| `packages/shell/src-tauri/src/lib.rs` | 새 모듈 선언 1줄 + 호출 4줄(주석 4줄). **함수 정의 없음** |
| `packages/shell/e2e-tauri/specs/env-tool-browser-host-lifecycle.spec.ts` | skip 3건 골격 → 실 Tauri 바이너리 4건 |
| `docs/e2e-inventory.json` | 스펙이 읽는 환경 변수(`NAIA_E2E_ADK_PATH`) 반영 — `build-e2e-inventory.mjs` 생성물 |

## 2. 공유 파일(`lib.rs`)에 넣은 정확한 hunk — 9줄

```
+mod ego_host;                                          (mod data_home; 와 mod gemini_live; 사이)

  restart_agent() 안, log_both("[Naia] Restarting agent-core...") 바로 뒤:
+    // #582 S6b: 재시작은 소유 런타임 정리 경로다. 감독자도 그 목록에 있다.
+    ego_host::cleanup_current_adk("cleanup(restart)");

  reset_naia_config_files() 안, reset_naia_config_files_at(...) 바로 앞:
+    // #582 S6b: Reset 은 소유 런타임 정리 경로다. 감독자·Chromium 을 marker 로 회수한다.
+    ego_host::cleanup_ego_host(std::path::Path::new(&adk_path));

  .setup() 안, "Then spawn Agent ..." 주석 바로 앞:
+            // #582 S6b: 시작 조정 — 크래시가 남긴 감독자·Chromium 을 marker 로 회수한다 (계약 4.8).
+            crate::ego_host::reap_current_adk();

  on_window_event 의 WindowEvent::Destroyed 안, browser_embed_kill() 바로 뒤:
+                    // #582 S6b: 정상 종료도 소유 런타임 정리 경로다 (계약 4.8).
+                    crate::ego_host::cleanup_current_adk("cleanup(shutdown)");
```

`platform/linux.rs`·`windows.rs`·`macos.rs` 는 **한 줄도 건드리지 않았다**(§4-1).

## 3. 규칙

- lease 형식은 감독자 쪽 `packages/ego-host/src/supervisor/lease.mjs` 의 `createLease` 가 쓰는 필드
  이름 그대로 읽는다(`nonce`·`marker`·`startedAt`·`pid`·`executable`·`profileDir`·`socketPath`·`supervisorPid`).
  `pid`·`nonce` 가 없으면 형식 오류이며 그때는 **아무 PID 도 건드리지 않고 파일만** 치운다.
- marker 경계는 `\0` 과 공백류 **둘 다**다. Chromium 이 시작하며 argv 를 공백으로 재작성하기
  때문이다(S2b 실측). 같은 규칙이 `lease.mjs` 의 `cmdlineHasToken` 에도 있다 — 두 구현이 갈라지면
  셸과 감독자가 같은 프로세스를 다르게 판정한다.
- 판정은 다섯이고 감독자 쪽 `RECONCILE_STATUS` 와 같은 뜻이다:
  `no-lease` · `unreadable` · `stale` · `foreign` · `unverified` · `reclaimed`.
- Windows 는 `unverified` 로 기록하고 **회수하지 않는다**(계약 4.9 windows4060 게이트).
  판정은 `std::env::consts::OS` 로 하며 `#[cfg]` 를 쓰지 않는다 — `platform/` 밖에 `#[cfg]` 를 두지
  않는다는 이 저장소 규칙(`platform/mod.rs` 머리말)을 지키기 위해서다.

## 4. 계약과 달랐던 판단

1. **`platform` 모듈의 기존 함수를 재사용하지 않았다.** 브리프는 재사용을 지시했지만
   `platform::agent_process_marker` 는 `/proc/<pid>/cmdline` 을 **`\0` 로만** 나눈다
   (`linux.rs:64-84`). Chromium 은 argv 를 공백으로 재작성하므로 그 함수로는 우리 브라우저가
   전부 `foreign` 이 되어 회수가 죽는다. 그렇다고 `linux.rs` 에 함수를 더할 수도 없다 —
   그 파일은 다른 세션이 고치는 중이고 브리프가 새 함수 정의를 금지했다. 그래서 `ego_host.rs`
   안에 `marker_matches`(두 경계)와 `probe_real`(sysinfo)을 두었다. sysinfo 는 이 크레이트가
   이미 쓰는 의존이고(`workspace.rs`·`stt_models.rs`), 세 OS 에서 `#[cfg]` 없이 같은 코드로 돈다.
2. **`supervisorPid` 도 marker 로 검증한 뒤에만 내린다.** 감독자는 지금 셸의 node 프로세스 안에서
   돌기 때문에(S3a) 그 PID 의 명령줄에는 우리 marker 가 없다. 그러면 판정이 `mismatch` 가 되어
   **건드리지 않는다.** 이것이 옳다 — marker 없이 PID 만 보고 죽이면 언젠가 남의 프로세스를 죽인다.
   단위 테스트 `a_supervisor_without_our_marker_is_never_terminated` 가 그 자리를 고정한다.
   나중에 감독자가 별도 프로세스로 나가면서 marker 를 달면 같은 코드가 그때 회수한다.
3. **`browser.deleteSession()` 은 "정상 종료"가 아니다.** 실측(2026-09-10): 세션을 지우면
   tauri-driver 가 프로세스를 그냥 내려 창 파괴 이벤트가 오지 않고 lease 가 그대로 남았다.
   계약이 말하는 정상 종료는 사람이 창을 닫는 길이므로, 스펙은 `plugin:window|close` 를 실 IPC 로
   부른다. 그 뒤 `WindowEvent::Destroyed` → `cleanup_current_adk("cleanup(shutdown)")` 이 돈다.
4. **재시작 케이스를 마지막에 둔다.** `browser.reloadSession()` 뒤에는 이 세션의 `execute` 가
   `invalid session id` 로 계속 실패한다(실측). 앱은 실제로 다시 뜨고 시작 조정도 도는데
   웹뷰만 못 잡는다. 그래서 그 케이스는 웹뷰가 아니라 **파일과 프로세스**로 판정하고 순서상 끝에 둔다.
5. **실 Chromium 을 띄우지 않는다.** 이 스펙이 답하는 질문은 "브라우저가 도는가"가 아니라
   "우리 표식이 붙은 프로세스만 골라 회수하는가"다. 그래서 표식만 달고 자는 프로세스
   (`packages/ego-host/test/helpers/marker-sleep.mjs`, S2b 가 쓰던 것)를 쓴다.
   실 Chromium 회수는 ego-host 패키지의 lease·조정 테스트가 실 브라우저로 돈다.
6. **`xvfb-run` 대신 `cage`.** 이 기계에 Xvfb 가 없다(S2e 가 같은 이유로 cage 를 골랐다).
   사람의 Wayland 세션에 창을 띄우지 않기 위해 `WLR_BACKENDS=headless` 인 cage 안에서 돌렸다.
   `DISPLAY`·`WAYLAND_DISPLAY` 를 지우고 들어가 사람의 `:0` 으로 샐 길을 막았다.

## 5. e2e-tauri 가 잡은 실제 결함 (S6b 의 값)

첫 실기에서 Reset 케이스가 **RED** 였다. marker 가 맞는 프로세스가 살아남았다.

원인: `sysinfo` 의 `System::refresh_processes(...)` 기본 갱신 묶음에는 `cmd` 가 **없다**
(`sysinfo-0.34.2/src/common/system.rs:304-316` — memory·cpu·disk_usage·exe 만).
그래서 `process.cmd()` 가 늘 비었고, 모든 프로세스가 `mismatch`(= 남의 것)로 판정돼 회수가
한 번도 일어나지 않았다. **주입 단위 테스트로는 잡을 수 없는 결함이다** — 그 테스트들은 판정
규칙만 보고 명령줄을 어디서 읽는지는 보지 않는다.

고친 것: `refresh_processes_specifics(..., ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always))`.

그 자리를 지키는 테스트를 추가했다 — `probe_real_reads_the_command_line_of_a_live_process` 는
표식을 단 **진짜 프로세스**를 띄워 `Match`·`Mismatch`·`Gone` 세 판정을 전부 밟는다.
**변이 탐침**: 고친 줄을 원래대로 되돌리면 이 테스트가 즉시 실패한다(2026-09-10 확인).

(딸린 발견: `sh -c "sleep 30" …` 은 쉘이 마지막 명령을 `exec` 로 갈아치워 표식이 사라진다.
테스트는 `sh -c "sleep 30; :"` 로 그 최적화를 막는다.)

## 6. 검증 (전부 종료 코드)

```
$ cd packages/shell/src-tauri && NAIA_AGENT_SCRIPT=… NAIA_AGENT_PROTO_DIR=… \
    CARGO_TARGET_DIR=target-e2e cargo test ego_host
  test result: ok. 14 passed; 0 failed; 319 filtered out                EXIT=0

$ cd packages/shell && pnpm run build:e2e:tauri                          EXIT=0
$ cd packages/shell && env -u DISPLAY -u WAYLAND_DISPLAY \
    WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1 \
    cage -- pnpm exec wdio run e2e-tauri/wdio.conf.ts \
      --spec e2e-tauri/specs/env-tool-browser-host-lifecycle.spec.ts
  ✓ Reset 뒤 marker 가 맞는 감독자와 브라우저가 남지 않는다
  ✓ marker 가 다른 프로세스는 건드리지 않고 lease 도 지우지 않는다
  ✓ 정상 종료 뒤 lease 가 정리된다
  ✓ 재시작 뒤 이전 lease 가 조정된다
  4 passing (5.6s) / Spec Files: 1 passed, 1 total                       EXIT=0

$ node scripts/build-e2e-inventory.mjs --check                           EXIT=0
$ node scripts/check-file-anchors.mjs                                    EXIT=0
$ node scripts/check-traceability.mjs --enforce                          EXIT=0
$ node scripts/check-uc-traceability.mjs                                 EXIT=0
$ bash scripts/enforce-root-structure.sh   기존 위반 2건만(tmp, tsconfig.build.json)
$ cd packages/shell && npx tsc -b --noEmit                               EXIT=0

$ pgrep -f 'naia-ego-[m]arker'    출력 없음                               (잔류 0)
$ pgrep -f 'marker-sleep.mjs'     출력 없음                               (잔류 0)
```

빌드 시간: Rust 증분 빌드 7~18초(의존은 이미 캐시). 첫 전체 빌드는 이 세션 시작 시점에
`target-e2e` 가 이미 있어 약 55초였다. tauri-driver·WebKitWebDriver·cage 는 이 기계에 있다.

### 실기가 실제로 네 경로를 밟았다는 증거

실기 로그의 `[Naia] ego-host …` 네 줄 — 네 삽입 지점이 각각 한 번씩 돌았다.

```
ego-host reclaimed orphans=0 cleanup(reset):    PID 3227070 를 회수했다 — 고아 0
ego-host foreign   orphans=0 cleanup(reset):    PID 3227101 … 우리 marker 가 없다 … 종료도 lease 삭제도 하지 않는다
ego-host reclaimed orphans=0 cleanup(shutdown): PID 3227380 를 회수했다 — 고아 0
ego-host reclaimed orphans=0 reap:              PID 3227435 를 회수했다 — 고아 0
```

라벨을 경로별로 나눈 이유가 이것이다. 처음에는 셋 다 `cleanup` 으로 찍혀 재시작·종료·Reset 을
로그에서 구별할 수 없었다.

## 7. 남는 것

- **웹뷰↔node 다리는 여전히 없다**(S6a §4-2). S6b 는 Rust 쪽 회수만 다룬다. 도구 호출이 실제
  감독자에 닿는 경로는 어댑터가 node 안에서 도는 조립(계약 테스트)에서만 성립한다.
- **Windows·macOS 는 미실측이다.** `unverified` 분기는 단위 테스트로만 밟았다. 실기 게이트는
  windows4060(계약 4.9)과 macOS 기기 확보 뒤다.
- **Reset 은 ADK 의 설정 파일을 실제로 지운다.** 이 스펙을 다른 스펙과 같은 묶음에서 돌리면
  뒤 스펙이 설정 없는 ADK 를 본다. 그래서 `--spec` 하나로 돌렸고, 전체 묶음에 넣을 때는
  순서를 정해야 한다.
- 실기에서 `browser.reloadSession()` 뒤 웹뷰 세션이 죽는 것은 이 슬라이스가 만든 문제가 아니며
  고치지 않았다(#583 의 e2e 포커스·세션 주제에 가깝다). 판정 수단을 파일·프로세스로 바꿔 우회했다.
