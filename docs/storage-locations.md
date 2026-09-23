# 셸이 무엇을 어디에 저장하는가

2026-09-05 실측. 리눅스(Bazzite, RTX 3090 ×2)에서 확인했다.

## 규칙 두 가지

저장 위치는 두 규칙이 정한다. 둘은 다른 것을 말하므로 함께 읽어야 한다.

**설정과 사용자 데이터는 ADK 안에 산다.** `FR-CONFIG-SOT.1`(UC-CONFIG-SOT)이
정본을 파일에 두고 localStorage 를 캐시로 내린다. 브라우저 저장소에 정당하게
남는 것은 `naia-adk-path` 하나뿐이다. 어느 ADK 를 볼지 알아야 파일을 열 수
있으니 그것만은 밖에 있어야 한다. 나머지는 `naia-settings/config.json` 과
`naia-settings/ui-config.json` 이 정본이고, 부팅할 때 파일이 캐시를 이긴다.

**실행 중에 생기는 부산물은 데이터 홈에 남는다.** `FR-SHELL-ISO`(#425)가
`~/.naia`(또는 `NAIA_HOME`)를 그 자리로 정했다. adk-path 캐시, 임차 파일,
로그, PID 파일, 설치된 앱과 스킬이 여기 산다. 격리된 개발 인스턴스가
`~/.naia-dev` 를 쓰는 것도 이 규칙이다.

그래서 "모든 저장은 naia-settings 로" 와 "홈에도 남는 것이 있다" 는 부딪히지
않는다. 갈라야 할 것은 **설정·데이터**와 **실행 부산물**이다.

## 지금 홈에 있는 것

파일 시각으로 현역과 잔재를 갈랐다. 규칙이 인정하는 자리인지도 함께 적는다.

| 항목 | 최근 갱신 | 파일 수 | 판정 |
|---|---|---|---|
| `adk-path` | 2026-09-04 | 1 | 현역 · 규칙이 인정하는 자리 |
| `agent-child-lease.json` | 2026-09-04 | 1 | 현역 · 임차 파일 |
| `logs/` | 2026-09-05 | 9 | 현역 · 로그 |
| `run/` | 2026-09-05 | 6 | 현역 · PID 파일 |
| `voxcpm2-runtime/` | 2026-09-05 | 45,590 | 현역 · 음성 런타임 |
| `memory/` | 2026-08-22 | 119 | **확인 필요** |
| `memory-config.json` | 2026-06-18 | 1 | 잔재로 보임 |
| `skills/` | 2026-04-03 | 66 | 잔재로 보임 |
| `credentials/` | 2026-04-02 | 1 | 잔재로 보임 |
| `identity/` | 2026-04-06 | 1 | 잔재로 보임 |
| `memos/` | 2026-04-12 | 3 | 잔재로 보임 |
| `naia.db` | 2026-04-05 | 1 | 잔재로 보임 |
| `gateway/` | 2026-04-03 | 45,290 | 잔재로 보임 · 부피 큼 |
| `openclaw/`, `openclaw.json` | 2026-04-06 | 74,954 | 잔재로 보임 · 부피 큼 |
| `apps/`, `sessions/`, `workspace/`, `chrome-profile/` | — | 0 | 비어 있음 |

넉 달째 손대지 않은 것을 잔재로 적었지만, 지우는 일은 이 문서가 정하지
않는다. 목록과 근거를 남기고 판단은 사람에게 맡긴다.

`memory/` 만 애매하다. 코드는 이미 ADK 를 본다 —
`memory.rs:agent_memory_path_from_adk` 가 `<ADK>/naia-settings/memory/store.json`
을 열고, 주석이 "기억 화면이 옛 홈 경로로 흘러가지 않게 한다" 고 못박아 두었다.
그렇다면 홈의 119 개는 그 이전에 쌓인 것이다. 다만 8월까지 갱신된 흔적이 있어
단정하지 않는다.

## 코드가 실제로 어디를 보는가

| 저장물 | 결정 지점 | 향하는 곳 |
|---|---|---|
| 기억 | `memory.rs:98` | ADK `naia-settings/memory/store.json` |
| 자격증명 목록 | `lib.rs:11118` | 설정 디렉터리의 `credentials` |
| 스킬 | `workspace.rs:808` | 워크스페이스 루트의 `skills/` |
| 설치된 앱 | `app.rs:115` | `<데이터 홈>/apps` |
| 옛 앱(패널) | `app.rs:119` | `<데이터 홈>/panels` |
| 로그 | `lib.rs:1499` | `<데이터 홈>/logs` |
| PID | `lib.rs:1628` | `<데이터 홈>/run` |
| 데이터 홈 자체 | `data_home.rs:naia_data_home_from` (비공개) | `NAIA_HOME` 또는 `~/.naia` |

데이터 홈은 이미 한 함수가 정한다. 홈 경로를 여기저기서 조립하지 않는다는
뜻이고, 이 축은 이미 단일 출처를 갖췄다.

## 앱 설치와 샌드박스

여기는 아직 비어 있다.

앱은 `<데이터 홈>/apps/<앱 id>` 에 설치된다. 그런데 **지금 그 디렉터리가
비어 있다**(2026-09-04 18:23 이후). 밋업 슬라이드 서버
(`naia-meetup-slides-20260904.service`)가 `~/.naia/apps/land.naia.slides` 를
서빙하도록 떠 있지만 그 경로는 존재하지 않고, `:18766` 은 404 를 돌려준다.
슬라이드 앱을 실기로 확인하려면 설치부터 다시 해야 한다.

앱이 실행 중에 파일을 읽고 쓰는 **샌드박스 경로 추상화는 저장소에 없다.**
Rust 쪽에 그 개념이 없고(`sandbox` 로 걸리는 것은 Flatpak 관련 주석 둘뿐),
TypeScript 쪽에서는 `src/lib/app-sandbox` 를 부르는 곳만 있고 그 파일 자체가
없다. 부르는 쪽이 기대하는 것은 다음과 같다.

- `getAppSandboxRoot`, `writeAppSandboxFile`, `openAppSandboxFileInWorkspace`
- `startSlidesRecording`, `stopSlidesRecording`

이름이 말하듯 "앱마다 제 구역을 주고 그 안에서만 읽고 쓰게 한다" 는 추상화다.
슬라이드 앱이 그 규칙을 지키는지도 이 파일이 있어야 판정할 수 있다. 지금은
`SlidesCenterArea.tsx` 가 그것을 부르기만 하고 파일이 없어 타입 검사가 멎는다.

## 남은 판단

1. 잔재로 보이는 항목을 지울지 — 특히 `openclaw/`(74,954 개)와
   `gateway/`(45,290 개). 목록은 위에 있고 결정은 사람 몫이다.
2. `memory/` 119 개가 정말 옛것인지 — 코드는 ADK 를 보는데 8월까지 갱신 흔적이 있다.
3. 앱 샌드박스 추상화 — 파일이 저장소에 들어와야 판정도 완성도 가능하다.

## 벤치마크 산출물이 기억과 섞여 있다

2026-09-05 정리 중에 드러났다. `~/.naia/memory/` 한 디렉터리에 성격이 다른
셋이 함께 있었다.

| 파일 | 크기 | 성격 |
|---|---|---|
| `naia-memory.json` | 7.9M | 사용자의 실제 기억 |
| `perf-bench-latency.db` | 404M | 지연 벤치가 만드는 데이터셋 |
| `stress-test-tiered-100k.db` | 198M | 10만 건 스트레스 테스트 데이터셋 |
| `test-epoch-*.json-{wal,shm}` | 118개 | 테스트 실행 부산물 |

경로를 정하는 쪽은 `naia-memory` 의 도구다. 예컨대
`src/__tests__/stress-test-tiered-100k.ts:13` 이
`join(homedir(), ".naia", "memory", "stress-test-tiered-100k.db")` 를 직접
만든다. 결과 리포트는 저장소의 `reports/perf/` 에 따로 쌓이므로, 홈에 남는
것은 재실행하면 다시 생기는 중간 산출물이다.

문제는 그 사실이 파일 이름에만 적혀 있다는 것이다. 정리하는 쪽에서 무엇이
사용자 데이터이고 무엇이 재생성 가능한 산출물인지 가릴 근거가 이름뿐이면,
언젠가 이름이 애매한 파일에서 잘못 판단한다. 실제로 이번 정리에서 그 둘을
지웠고, 리포트가 저장소에 남아 있었던 덕분에 손실이 데이터셋 재생성 비용에
그쳤다.

벤치마크 산출물은 사용자 데이터와 다른 자리에 두는 편이 옳다. 저장소의
`.cache/benchmark-runs` 처럼 이미 그런 자리가 있으므로, 홈의 기억 디렉터리를
쓰는 도구를 그쪽으로 옮기면 구분이 이름이 아니라 위치로 선다. 다만
`naia-memory` 는 다른 계약이 소유하므로 이 문서는 사실만 적고 변경은 그쪽에
맡긴다.

## 규칙이 바뀌었다 (2026-09-05, 루크 지시)

추적 이슈는 [nextain/naia-agent#127](https://github.com/nextain/naia-agent/issues/127)
("저장 경계: 사용자 설정·데이터를 ADK(adkPath) 밑으로 — 홈 누수 정리")이다.
이 문서가 사실을, 그 이슈가 결정과 진행을 든다.

위 "규칙 두 가지" 중 둘째가 바뀌었다. 루크가 이렇게 정했다 — **`~/.naia` 에는
`adk-path` 하나만 둔다.** 실행 부산물(로그, 임차 파일, PID, 설치된 앱과 스킬,
음성 런타임)도 그 파일이 가리키는 ADK 아래로 가야 하고, 그 위치는 `adk-path`
에서 **파생**돼야 한다. 코드가 홈을 직접 짚으면 ADK 를 옮겼을 때 데이터가
따라가지 못한다.

이것은 `FR-SHELL-ISO`(#425)가 정한 "실행 부산물은 데이터 홈에 남는다" 와
**부딪힌다.** 요구사항 문서는 아직 옛 규칙이다. 두 문서가 다른 말을 하면
사람은 반드시 한쪽만 읽으므로, 요구사항을 새 규칙으로 고치는 일이 남았다.
그 판단은 요구사항의 주인이 한다 — 이 문서는 어긋남을 기록만 한다.

### 코드가 홈 아래에 만드는 자리 — 열넷

손으로 세었을 때는 다섯이었는데 검사기(`scripts/check-data-home-boundary.mjs`)
를 만들어 돌리니 열셋이었다. 파일 시스템에 아직 나타나지 않은 것들이 더
있었다. 2026-09-06 에 검사기를 정규식 창에서 토크나이저로 옮기면서 하나가 더
나왔다 — `workspace` 다. 그것은 경로가 아니라 `~/.naia/workspace` **문자열**로
게이트웨이 기본 설정에 실려 나가는 자리라, 창을 보던 옛 검사가 볼 수 없었다.

자리는 이제 `packages/shell/src-tauri/src/data_home.rs` 의 `DataHomeChild` 열넷이
정본이다. 아래 표의 이름은 그 대응표와 정확히 같아야 하고, 다르면 검사기가
붉어진다.

| 이름 | 부르는 곳 | 옮길 때 함께 풀 것 |
|---|---|---|
| `adk-path` | `lib.rs` (adk 경로 캐시) | **여기 남는 유일한 것** |
| `logs` | `lib.rs:log_dir` | |
| `run` | `lib.rs:run_dir` | |
| `skills` | `lib.rs` (스킬 스캔) | |
| `voxcpm2-runtime` | `lib.rs:voxcpm2_runtime_root` | 음성 서비스가 지금 쓰고 있다 — 사람이 중단 창을 잡아야 한다 (#703 이후 이 자리는 모드별 상태(state·hf-cache·목소리·설치 로그)만 남고, 고정 패키지는 사용자별 캐시 `NaiaRuntimeCache` 로 이전된다) |
| `apps` | `app.rs:apps_root` | |
| `panels` | `app.rs:legacy_apps_root` | #472 이전의 앱 자리 |
| `agent-child-lease.json` | `lib.rs:agent_child_lease_path` | |
| `agent-child-lease.lock` | `lib.rs:agent_child_lease_lock_path` | |
| `chrome-profile` | `browser.rs` | 사용자 로그인 상태가 들어 있다 — 옮기면 다시 로그인해야 한다 |
| `login-profile` | `browser.rs` | 위와 같다 |
| `deep-link-pending.txt` | `platform/macos.rs`, `platform/windows.rs`, `main.rs` | 앱이 뜨기 전에 쓰이므로 ADK 위치를 아직 모를 수 있다 — 순서를 함께 풀어야 한다 |
| `dev-deeplink` | `platform/macos.rs` | 위와 같다 |
| `workspace` | `lib.rs` (게이트웨이 기본 설정) | 경로가 아니라 문자열이라 `NAIA_HOME` 도 타지 않는다 |

`.naia` 자체를 직접 짚던 자리(옛 표의 열셋째 줄)는 이름이 아니라 **방식**이었다.
지금은 `data_home` 안의 비공개 `direct_root_of` 와 밖에 내주는 `direct_child_of` 가
그 방식을 들고 있고, `NAIA_HOME` 을 존중하는 쪽(`child_of`)과 갈라 두어 어느 자리가
어느 쪽인지 코드에서 보인다. 데이터 홈 뿌리와 그 이름(`.naia`)은 모듈 밖에 없다 —
밖에서는 이름표를 받는 `child`·`child_of`·`child_from_dirs_home`·
`read_child_from_dirs_home`·`direct_child`·`direct_child_of`·`tilde_child` 만 쓴다.

검사기는 옮기는 일을 대신하지 않는다. **새로 늘어나는 것을 막는다.** 자리마다
사유를 적어 두었고, 옮기고 나면 그 항목을 지우면 된다. 목록이 낡으면(옮겼는데
남아 있으면) 그것도 붉어진다. 양쪽 다 결함을 심어 확인했다.

### 사용자별 음성 런타임 캐시 (#703)

개발 인스턴스와 운영 인스턴스가 대용량 고정 패키지를 중복 다운로드하지 않고 한 번만 내려받아 안전하게 공유하는 사용자별 캐시 디렉터리다.

- **OS별 경로**:
  - Windows: `%LOCALAPPDATA%\NaiaRuntimeCache` (dirs의 known-folder가 아닌 `LOCALAPPDATA` 환경 변수를 우선 읽어 E2E harness 리다이렉트를 따름)
  - Linux: `$XDG_DATA_HOME/naia-runtime-cache` (기본값 `~/.local/share/naia-runtime-cache`)
- **포함되는 자산 (고정 패키지 바이트)**:
  - 다운로드 아카이브 ZIP (`downloads/<sha256>.zip`)
  - 추출된 payload 아티팩트 (`payload/artifact/`)
  - 사전 빌드/설치된 NVIDIA 패키지 (`python-packages/`)
  - 모델 리비전 가중치 (`models/VoxCPM2/`)
  - 기본 참조 음성 팔레트 (`voices/<id>`)
  - GPU·드라이버·TensorRT 버전별 컴파일 엔진 세대 (`engines/<stamp>/`)
  - 슬롯 식별 레코드 (`slot.json`) 및 네이티브 모듈 해시 검증 장부 (`native-hashes.json`)
- **포함되지 않는 자산 (모드별 데이터 홈에만 보존)**:
  - 사용자 맞춤 음색 (`PUT /voice` 대상, `naia-current.wav` 등)은 공유 슬롯이 아닌 모드별 `state/voices/`에 독립 보존
  - 모드별 임시 스크래치 및 numba 캐시 (`state/cache/numba/`, `hf-cache/`)
  - 설치 로그 (`voxcpm2-install.log`)
  - 런타임 PID 및 lock owner stamp
- **제거 시 보존 (Uninstall does not delete)**:
  - Windows NSIS 언인스톨러(`windows/installer-hooks.nsh:72`)는 `$INSTDIR`인 `%LOCALAPPDATA%\Naia`만 삭제하므로, 별도 형제 폴더인 `%LOCALAPPDATA%\NaiaRuntimeCache`는 앱 제거 시 삭제되지 않고 보존된다.
- **Flatpak/샌드박스 빌드**:
  - Flatpak 등 샌드박스 배포판은 자체 격리된 XDG 데이터 디렉터리를 사용하므로 독립된 캐시 사본을 보게 된다.
- **보존 정책 (Retention)**:
  - 프로파일별로 현재 활성(active) 슬롯과 직전(previous) 슬롯만 유지(`active.json`)하며, 그 외 오래된 슬롯 중 실행 중인 서버 프로세스의 공유 잠금(`Shared`)이 걸려 있지 않은 슬롯만 안전하게 프루닝한다.

### 두 기계 실측 (2026-09-05)

naia-os-3090 은 `~/.naia` 가 17GB, win-rtx4060 은 `%USERPROFILE%\.naia` 가
25.5GB 다. 지배하는 항목은 같다 — 음성 런타임이 각각 17GB·23.5GB 다. 두 기계
합쳐 42.5GB 중 40.5GB 가 그 하나다. 옮길 때 가장 먼저 볼 것이다. 윈도우에는
`openclaw` 1.2GB, `chrome-profile` 210MB, `cron-jobs.json`, `node-host.log` 가
더 있다.

### e2e 실행 자리 격리 (2026-09-06)

일반 wdio 설정이 리스·PID·로그를 운영 앱과 같은 `~/.naia/run`·`~/.naia/logs`
에 쓰고 있었다. 그래서 앞 스펙의 에이전트 자식이 리스를 쥔 채 살아남아 다음
스펙이 에이전트 없이 돌았고(이 기계에 고아 30개가 쌓여 있었다), e2e 가 위
규칙을 매 실행 어겼다. 이제 `<OS 임시 디렉터리>/naia-shell-e2e-<포트>` 에
만들고 끝나면 지운다. 스펙을 두 번 돌려도 `~/.naia/run`·`logs` 안 파일 76개의
mtime 이 그대로였다. 계약 테스트
(`src/test/e2e-runtime-isolation.contract.test.ts`)가 배선을 지우면 붉어진다.

**남은 둘.** `codex-e2e-environment.ts` 는 자기 격리 자리를 `~/.naia/run/`
아래에 만든다 — 격리는 되지만 자리가 홈이라 규칙 위반이고, 지금 그런
디렉터리 다섯이 쌓여 있다. 그리고 일반 설정은 `NAIA_E2E_ADK_PATH` 를 밖에서
줄 때만 워크스페이스를 격리해서, 안 주면 에이전트가 `~/.naia/adk-path` 가
가리키는 **실제 ADK** 를 워크스페이스로 잡는다. 리스·로그와 다른 축이라
따로 풀어야 한다.

### FR-SHELL-ISO(#425) 를 이렇게 고치자 — 초안 (2026-09-06, 루크 결정 대기)

지금 문장은 개발 인스턴스가 "별도 데이터 홈(`NAIA_HOME`, 기본 `~/.naia-dev`) — adk-path
캐시·lease·logs·run·skills" 를 쓴다고 적어, 실행 부산물이 홈에 사는 것을 규칙으로
못박고 있다. 루크의 새 규칙과 맞추려면 그 문장을 이렇게 바꾸면 된다.

> **데이터 홈(`NAIA_HOME`, 기본 `~/.naia`)에는 `adk-path` 하나만 둔다.** 그것은 어느
> ADK 를 볼지 알려 주는 부트스트랩 포인터라 ADK 밖에 있어야 한다. 로그·임차(lease)·PID·
> 설치된 앱과 스킬·음성 런타임을 포함한 **모든 실행 부산물은 `adk-path` 가 가리키는
> ADK 아래**(`<ADK>/naia-settings/...` 또는 `<ADK>/.naia/...` — 자리 이름은 별도
> 결정)에 두고, 그 위치는 `adk-path` 에서 파생한다. 격리된 개발 인스턴스(`~/.naia-dev`)도
> 같은 규칙을 따른다 — 홈에는 자기 `adk-path` 만 두고 나머지는 자기 ADK 아래로 간다.
> 네이티브 E2E 격리(`e2e_runtime_dir`)는 그대로 상위다.

바뀌지 않는 것: 개발 인스턴스와 운영 인스턴스의 **분리** 자체(FR-SHELL-ISO 의 본뜻)는
그대로다. 바뀌는 것은 분리된 데이터가 **어디에** 사는가 — 홈 두 개가 아니라 ADK 두 개다.

루크가 정할 것 둘. 첫째, 위 문안을 그대로 쓸지. 둘째, ADK 아래 부산물 자리의 이름
(`naia-settings/` 아래로 모을지, `<ADK>/.naia/` 처럼 따로 둘지). 이름이 정해져야
열넷 자리를 옮기는 코드 변경을 시작할 수 있다.
