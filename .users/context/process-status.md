<!-- src-sha: 727a1bc8c244f98e -->

## 서명 검증 스토어 앱 도구 동적 허용 — 2026-10-29

- P01–P05 완료: 서명된 Store 앱에서 활성 앱이 선언한 `skill_*`만 모델 경계에 동적으로 허용한다. Rust는 설치 당시 서명된 원본 ZIP과 현재 `app.json` 일치를 재검증한다. Shell 내장 도구·타 앱 중복은 기록 후 거부하고, 제거·비활성화 뒤 허용하지 않는다.
- `skill_blackjack_tutor`는 정적 Shell 목록에서 제거했다. Rust 확인된 Store 설치는 활성 앱 조건을 적용하고, 개발자 사이드로드는 설치 중인 기존 호환 경로를 유지한다.
- 검증: focused Vitest 35/35, Biome 6개 TS 파일, 코어 build, Shell tsc, Rust `app::tests` 23/23 통과. UI 표현 변경이 없어 visual UX 검토는 해당하지 않는다. 실 Gateway entitlement 설치를 통한 native Store E2E는 실행하지 않았다.
<!-- src-sha: 3f633f44ef08e32c -->

## 설치 앱 공용 연결·설치 화면 — 2026-10-29

- 검수 1차: 중복 ID 오류, 앱 질문 기록 격리와 표시, 설치 권한 고지 및 HTTPS 썸네일을 반영했다. 최종 Shell Vitest 2,565 통과/0 실패/21 제외, Playwright 2 통과, 실제 Tauri 1 통과, Rust 각 1 통과. 복원 원본에 앱 표시가 없어 복원 후 앱 턴 구분은 되지 않는다.

- P01–P05: 설치 앱의 권한별 모델 질의·낭독·언어 전달, 설치 상품 다국어 정보와 썸네일을 구현했다.
- 검증: 전체 Shell Vitest 2,558 통과/0 실패/21 제외, Playwright 2 통과, 실제 Tauri 매니페스트 IPC 1 통과, Rust 검사와 매니페스트 왕복 시험 통과. 실 계정·음성 장치는 모의했다. 기존 conform 게이트 비활성은 범위 밖이다.

## 0.2.4 설치판 YouTube 스트림 추출 제거 — 2026-10-27

- P01–P05 완료: `/yt/stream` 처리기와 URL 추출·형식 선택·decipher 제거. `/yt/search` 메타데이터 검색과 공식 iframe 재생은 유지하며 `<audio>`는 로컬 파일만 받는다.
- 설치 리소스 검증: staged sidecar 검색은 HTTP 200으로 메타데이터 2건(각각 id/title/thumbnail/duration/channel)을 반환했고 `/yt/stream`은 HTTP 404 `not found`를 반환했다. staged `dist`에는 추출 코드가 없다.
- 검증: sidecar build, root/Shell TypeScript, BGM Vitest 102/102, BGM Playwright 12/12, 실제 YouTube iframe 미디어 시계 30.1초 진행. 전체 Shell Vitest는 2,518 통과/21 제외/기존 agent-pairing assertion 1 실패.
- process-status.json 이번 가지 갱신은 조정자(민호)가 승인했다(대표님 상시 원문: “운영 배포 빼고는 내 승인은 필요 없어”).

## NVA 동작 Alt 단축키·채팅 배치 — 2026-10-25

- P01–P05 완료: `UC-NVA-ACTION-HOTKEYS-20261025`, FR-NVA-GESTURE.2~3, Alt+1~9/입력 근처 단추/AI 사용 제한과 TTS idle 지연을 구현했다.
- 검증: 루트·Shell TypeScript 검사 통과, 집중 Vitest 157/157, Shell 전체 Vitest 2,497 통과/1 실패/21 제외(유일한 실패 `platform-matrix.test.ts` ELF payload mode 0644 기대/0755 실제; 수정 전 `origin/main` 09e30c2b 기준도 2,463 통과/같은 1 실패/21 제외라 새 실패 0), Playwright `nva-prebaked.spec.ts` 2/2 통과.
- `verify-visual-ux`: 데스크톱과 360px 화면에서 입력 옆 단추, 입력 초안 보존, 키 표시·비겹침, 빈 목록, 로딩·오류 상태를 확인했다. 캡처는 `/var/mnt/hdd/tmp/nva-hotkeys/evidence/`에 저장했다.
- 단축키 판정은 `event.code`의 `Digit1`~`Digit9`만 사용하고 키패드는 제외한다. xterm 포커스는 통과시키고 CodeMirror는 허용한다. AI 제한은 최소 15초/같은 key 60초이며 수동 동작은 제한하지 않고 기록한다. TTS가 동작 영상을 끊는 renderer 회귀를 재현해 AI 동작을 idle까지 미루도록 했다.
- `check-assembly-coverage.mjs` 통과. `enforce-root-structure.sh`는 기존 미등록 `tmp/`와 `tsconfig.build.json` 2건을 보고했다. 둘은 이 작업에서 수정하지 않았다. 커밋하지 않았다.

## Studio NVA 쉘 적용 — 2026-10-22 (#105)

- 기준: Studio `dd69c873213fcfb1912a4116b491fd2c2dc5219d`; Shell `1d590cf2e257d2329e85312a194ad90352907ed1`. Shell은 progress/HANDOFF가 마지막 0.2.4 설치판의 소스로 가리킨 기준이다. 더 최신 canonical-NVA 가지는 마지막 전달 설치판 기준이 아니어서 고르지 않았다.
- Studio는 아바타 ID와 운영/개발 환경만 담은 `naia://studio-nva-apply` 링크를 만들고, 기존 다운로드는 보조 메뉴에 둔다. Shell은 로그인 자격으로 고정 HTTPS 게이트웨이에서 이름·미리보기를 읽고, 사용자 확인 뒤 크기·SHA-256·ZIP 매니페스트 및 기존 NVA 검사를 거쳐 적용한다.
- 검수 2회차 및 첫 묶음 분리: 쉘이 꺼진 윈도에서 링크를 누르면 쉘이 새로 뜨고, 같은 링크가 거듭 와도 한 번만 묻고, 내려받기는 임시 파일로 흘려 쓰며 해시를 계산한다. 딥링크 수신부와 적용 대화창은 첫 화면 렌더 뒤 동적 import로 불러와 진입 묶음(entry chunk) 밖으로 뺐다(`entryRawBytes 531815 / 540000`, `entryGzipBytes 166146 / 170000`).
- 검증: Shell 흐름·호스트·번들 상한 테스트 통과, Rust `studio_nva_apply`·단일 인스턴스 시험 통과(파서·대기열·ZIP 경로 탈출·크기 초과·해시 불일치·스트리밍 상한). Shell TypeScript 검사와 빌드 통과. Studio 화면은 로컬 headless 브라우저로 확인(내부 기록).
- P04 진행 중: Windows 실기기에 설치된 Shell 0.2.4에서 창 꺼짐/켜짐 전달 확인은 조정자 실기 수락으로 남아 있다. 푸시·설치판 배포는 하지 않았다.

## Qwen3.5 모델 받기 수명주기 — #759 단계 2

- 범위: FR-LLM-PULL.1 단계 2 검증 재개; P01–P03 산출물은 지시서·요구사항에 연결.
- P04: frozen install/build, focused Cargo 54/54, full parallel Cargo 583/583 twice, and specified Vitest 274/274 passed. Coordinator Playwright name comparison: 55=55, stage-specific 0; no rerun.
- P05: Muse code review pending. Completion claim: no.

## 가짜 Ollama HTTP 통합 — 2026-10-13 (#759 단계 4)

- 범위는 가짜 loopback Ollama HTTP 서버로 관리 자식 기동, 정확 태그 받기, tags/show/digest 사후 검증, 자식 회수와 LocalLlm 예약 반환을 잇는 통합 확인이다. 실제 Ollama·모델·GPU는 사용하지 않았다.
- 검증: 설정 화면 집중 Vitest 111 통과/8 제외. 전체 Vitest는 2,344 통과/21 제외/기존 `agent-pairing.test.ts` 임시 경로 필터 실패 1건(TMPDIR가 `/tmp`가 아닌 작업판 아래여서 발생; 범위 밖 수정 없음). `cargo test --lib ollama_runtime` 55 통과, 전체 병렬 Cargo 581 통과/4 기준 환경 시험 제외.
- Playwright 전체 실행은 193 실패(55개 기준명 + 앱 연결 거부로 보인 138개)였다. 기준 밖 36 specs 재실행은 139 통과/27 기존 기준 실패/7 제외; 실패명 27/27이 기준 목록과 같고 단계 전용 실패는 0개였다. 1421 health 점검 91/91 HTTP 200.
- Muse 코드 검수 대기, P04 진행 중/P05 대기. 루크 결정과 #759 전체 완료 주장은 남겨 두었다.

## VRAM 예약과 Ollama 공급자 연결 — 2026-10-13 (#758 단계 4)

- 작업 기준은 단계 3 병합판이다. kind-only `LocalLlm` 예약, Ollama 상태·provider 연결 및 chat admission을 구현하고 가짜 inventory/runner로 검증했다.
- 검증: `pnpm install --frozen-lockfile`, 루트·Shell production build, Shell tsc/Rust build 통과. 표적 Vitest 274 통과/8 제외, Ollama UI Playwright 3 통과, production Playwright 2 통과, 가짜 inventory Tauri 스펙 1 통과, Ollama Rust 40 통과/1 제외.
- 전체 Shell Playwright는 153 통과/49 제외/56 실패다. 새 Ollama 스펙은 통과했으며 나머지 실패의 원인과 기준판 여부는 확인되지 않았다. 전체 Cargo는 566 통과/4 기존 기준 실패/1 제외/3 GPU 관련 필터; 네 기준 실패는 `infer_repos_adk_root_returns_none_without_workspace_checkout`, `test_migration_excluded`, `test_resolve_cache_root`, `the_admin_secret_must_match_or_the_connection_is_refused`다.
- 실제 Ollama/GPU 시험은 하지 않았다. 설치 방식·Linux 권한·이미 실행 중인 Ollama·생각 모드 단계는 보수 기본값이며 루크 결정 대기다. P04는 진행 중, P05는 대기; Muse 검수와 단계 5 루크 실기 증거가 남아 완료 주장은 아니다.

## Ollama 서버 수명주기 — 2026-10-13 (#758 단계 3)

- Muse 코드 검수 r1의 회수 후 PGID 조회·신호 위험을 수정했다. 종료 감지는 비회수 방식으로 수행하고, Linux는 리더 회수 전에 자손 종료를 확인한다. Windows는 열린 Job Object 핸들만 사용한다.
- 검증: Ollama Rust 31 통과/1 fixture helper 제외, 지정 Vitest 209 통과/8 제외, Shell 타입체크·빌드와 Rust 빌드 통과. 전체 Cargo는 557 통과/4 기준 환경 실패/1 제외/3 하드웨어 시험 제외.
- 실제 Ollama 다운로드·설치·serve와 GPU 사용은 하지 않았다. Muse 재검수 대기이며 완료 주장은 아니다.

## Ollama 설치·찾기 — 2026-10-13 (#758 단계 2)

- 범위는 Ollama CLI 설치·발견과 status/start-install/remove IPC다. 실제 Ollama 다운로드·설치·serve·GPU 사용은 금지한다.
- 구현과 fixture 검증 완료: Ollama Rust 18/18, 지정 Vitest 209 passed/8 skipped, 지정 Cargo 544 passed/4 문서화된 기준 실패/3 filtered out. Muse 코드 검수 전 완료 주장은 하지 않는다.
- 설치 방식, Linux 권한, 이미 실행 중인 Ollama 처리, 생각 모드 단계 구분은 모두 루크 결정 대기다.
- 남은 일: Muse 코드 검수와 검수 반영. Cargo의 네 기존 실패는 해당 이슈 지시서의 기준 실패로 별도 기록했다.
## VoxCPM2 프로파일 선택 호출부 이동 — 2026-10-13 (#757 단계 3)

- 공통 가속기 인벤토리와 등록부 JSON을 설정·STT·음성 설치/시작 조회에 연결했다. Windows Vulkan 프로파일은 정본과 내보낸 셸 등록부 모두 `planned`다.
- 검증: Vitest 150 통과/9 제외, 참조 등록부 pytest 11 통과, 전체 Rust 502 통과/4 실패/3 제외. 실패 2건은 기존 Linux baseline, 2건은 worktree 루트 감지와 Unix 소켓 경로 제한 환경 문제다. TypeScript/build는 기존 의존성·ES target 오류로 실패. 실제 GPU 시험은 하지 않았다.
- P04 `in_progress`, P05 `pending`; 코드 검수 통과, DEV 실기 확인 전 완료 주장은 하지 않는다. 상세 결과는 비공개 조정 기록에 있다.

## 음성 VRAM 예약과 #758 접점 — 2026-10-13 (#757 단계 4)

- P01–P03: 사용자 시나리오, fixture 시험 매핑, 예약 요구사항을 기존 음성 흐름과 분리해 기록했다.
- 구현: 프로파일 승인량은 None/Pending으로 유지하고, Voice 시작은 그 값을 종류 단위 예약으로 전달한다. 이 경로는 가용량을 확인·차감하지 않으며 예약 조회의 바이트는 JSON `null`이다. `Some(bytes)` 경로는 바이트 기반 판정을 유지한다.
- 검증: 예약 fixture 14/14, released 프로파일 Voice 요청 1/1, Vitest 150 통과/9 제외. 전체 Cargo는 526 통과/4 기존 환경 실패/3 GPU 관련 시험 필터. workspace TypeScript, core/Shell 빌드, Rust build, targeted rustfmt, 미러·diff·충돌 표식 검사는 통과했다.
- 기존 Rust 실패 4건: `tests::infer_repos_adk_root_returns_none_without_workspace_checkout`, `voice_cache::tests::test_migration_excluded`, `voice_cache::tests::test_resolve_cache_root`, `ego_host_bridge::tests::the_admin_secret_must_match_or_the_connection_is_refused`. 새 예약 fixture 실패는 없다. 제품 보존 통합 검증은 불변 기준판·서명 계약·신뢰된 runner receipt가 없어 실행하지 못했다.
- 프로파일 용량과 8 GiB 초과 공존 정책은 Pending이다. P04 진행 중, P05 대기이며 실제 GPU 시험은 하지 않았다.
- 현재 상태: P04 진행 중, P05 대기. 프로파일별 승인 예약량과 8 GiB 초과 장치 공존 정책은 결정 전이며 완료 주장은 아니다. 실제 GPU 시험은 하지 않았다.

## BGM AI next/status observe — 2026-09-18 (#671)

- AI 다음곡은 UI와 같은 최신 플레이리스트 경로를 써서 로컬 파일도 재생한다.
- Tauri가 YouTube `source=null`로 메시지를 보내도 playing/infoDelivery를 관측한다.
- play 확인은 loading이 아니라 playing이며, 확인되면 곡 제목을 말해도 된다.
- 검증: BgmPlayer/bgm-skill/bgm-playback/observation 단위 77 통과. 4060 QA는 하지 않음(루크가 tauri:dev에서 증명).

## Slides #581 — 2026-09-10 메인 통합

- PPTX 로컬 변환·노트 가져오기, 대본 편집·다운로드, 설치 앱의 언어·테마·녹화 연결을 구현했다.
- 통합본 검증: Slides·다국어 91개, Rust 33개, 브라우저 7개 통과. 운영 빌드와 네이티브 컴파일 통과.
- Shell 전체 검사: 1,945 통과, 48 실패, 21 제외와 별도 파일 로딩 오류 1건. 코어: 1,513 통과, 54 실패, 17 제외. 실패 항목은 수정 전 main에서도 동일하게 재현됐으며 새 실패는 없었다.
- 사용자의 메인 병합·푸시 지시를 따르며, 실제 음성·녹화 및 정식 QC의 미검증 상태는 유지한다. 설치·스토어 배포는 별도다.
- 테스트·QC 시나리오 및 재실행 명령: `docs/user-scenarios.md#slides-quality-checks-581`.

## 시작 시 업데이트 확인 팝업 — 2026-08-20 (#468)

- 앱 시작 후 새 버전이 확인되면 현재/새 버전과 릴리스 노트를 보여 주는 다국어 팝업을 연다.
- 다운로드·설치·재실행은 사용자가 `지금 업데이트`를 명시적으로 선택한 뒤에만 시작한다.
- `한 달간 보지 않기`를 체크하고 `나중에`를 선택하면 같은 버전을 정확히 30일간 숨기며, 다른 새 버전은 즉시 다시 알린다.
- 일반 `나중에`는 기존 업데이트 배너를 보존하고, 설정의 수동 업데이트 확인 경로도 변경하지 않는다.
- 검증: 이슈 본문 UTF-8 복구 확인, Shell Vitest 1,626 통과, 표적 Vitest 9 통과, i18n 2 통과, Strict Mode 1회 확인을 포함한 Playwright 3 통과, 루트·Shell 빌드 및 assembly coverage 통과.
- 전달 상태: `REVIEW_ONLY`. 기존 #423 complexity waiver authority 해시 불일치와 외부 리뷰 어댑터 `NOT_RUN` 때문에 release eligibility는 주장하지 않는다.

## Naia 계정 일반 LLM 연결 — 2026-07-30 (#396)

- `grok-4.3`과 `deepseek-v4-pro`를 Naia provider의 Azure 모델로 카탈로그·선택·저장한다.
- gateway metadata의 `supports_tools`, `upstream_provider`, `lifecycle`를 소비하며, stale metadata에서도 DeepSeek는 무도구로 fail-closed 한다.
- 범위는 Settings와 일반 채팅 연결뿐이다. Coding Workers, Pi lifecycle, Workspace 코딩 UX는 다음 큰 작업으로 보류한다.
- 검증: 2026-07-31 registry/capability/Settings 105개 테스트와 Shell production build가 통과했다. 운영 `/health`와 모델 카탈로그에서 Grok·DeepSeek·Sol·Luna의 Azure live 상태를 확인했고, 동일 gateway를 쓰는 Agent Pi에서 실제 Grok·DeepSeek 계정 호출·사용량·크레딧 차감까지 통과했다.

## Coding Workers visual and UX gate — 2026-07-23

- Scope: hierarchy, saved-course-target feedback, narrow layout, and mutation/error states.
- Passed: 104 focused Shell tests; TypeScript and production builds; paired Agent/Shell native build; and isolated Tauri WebDriver with the exact paired Agent checkout.
- Native course acceptance passed: the Shell saved the exact `jeonju-discord-course.json` contract, Codex created only `index.html` and `hero.svg`, the student committed the result, and a second request modified only `hero.svg`.
- Adversarial review closed E2E isolation gaps for runtime-owned logs and the fixed Vite port. A real Discord server smoke still requires configured bot credentials and is separate from this isolated Shell acceptance.

## Coding Workers visual and UX gate — 2026-07-22

- Scope: hierarchy, saved-course-target feedback, narrow layout, and mutation/error states.
- Passed: focused React tests, browser Playwright E2E, TypeScript, production build, paired Agent/Shell native bundle, and the isolated Tauri WebDriver session with the exact paired Agent checkout.
- Not passed: the first real Codex course job did not reach a terminal state within the 300-second acceptance limit. The native UC remains incomplete.
- Adversarial review corrected the persisted-course-boundary second-request regression and two E2E wiring defects (WebDriver port and paired Agent checkout).
<!-- Human mirror of .agents/context/process-status.json -->
# 프로세스 현황 (Process Status) SoT

**스키마 버전**: 1.0

**목적**: 프로세스 현황의 정본 기록 — 세션 시작/종료 시 반드시 업데이트. 구조명세, 이슈, 리소스를 유기적으로 링크.

---

## 참조 (References)

| 항목 | 경로 |
|------|------|
| 프로젝트 구조 | `docs/project-structure.md` |
| 규칙 SoT | `.agents/context/agents-rules.json` |
| 이슈 문서 디렉토리 | `docs/progress/` |
| 스크립트 레지스트리 | `scripts/README.md` |

---

## 현재 작업

**이슈**: `naia-shell-transplant`

**제목**: naia-shell 헥사고날 이식 — foundation 계층 F0~F3 (제어평면/자기상태/관측/조작)
- 저장소: `naia-shell`
- 참고: `naia-os`는 배포판 계층 (별개 관심사)

**이슈 문서**: `docs/progress/` (F0-baseline, F0-contract, F{1,2,3}-baseline-contract, F0-graft) + 00-PHASES.md

**GitHub 이슈**: 없음

**시작**: 2026-06-08

**마지막 업데이트**: 2026-07-17 00:00 KST

**상태**: 진행 중 (in_progress)

### 2026-07-17 크로스플랫폼 설치 파일 (#377, S-INSTALL / FR-INSTALL.1~6)

- **배경**: Windows 설치 파일 검증 요청 → 조사 결과 설치 파일 0건 + clean checkout 재현 불가 (`node.exe`·MSVC 재배포 3종 = conf 선언만 있고 놓는 코드 부재, Windows 빌드가 `stage-cascade-loader` 누락한 채 딥머지 잔재로 우연 통과).
- **확정 설계 (루크 승인)**: 플랫폼 매트릭스(`src-tauri/platform-matrix.json`) = 유일 SoT → 단일 스크립트 `stage-runtime.mjs` 가 리소스 프로비저닝 + `tauri.conf.generated.json` 생성. Node 22 를 3 OS 모두 번들. WSL 불요 불변(NFR-noWSL). CI 3 OS 매트릭스(ubuntu 는 deb 설치 + xvfb 기동 스모크 — 판정 = 마커 **AND** 실사용 node 경로가 resource_dir 하위 2조건 + 변이 탐침. R5 에서 "PATH 에서 node 제거" 폐기). mac 완료선 = **arm64** CI 빌드 성공(미서명 · arm64 전용 정직 표기).
- **P01~P03 산출물**: `docs/user-scenarios.md` S-INSTALL 행 + `docs/requirements.md` FR-INSTALL 섹션 + `docs/glossary.md` 배포·설치 용어. 적대 리뷰 1회차 16건(BLOCKER: `createUpdaterArtifacts=false` 매트릭스 이주 등) + 2회차 12건(BLOCKER: vosk dll 4종(libvosk+MinGW 3종) 이주, `--config` 머지 시맨틱스 — base 훅 `pnpm build` 축소, node arch 맵, ubuntu 스모크 판정 기준 등) + 3회차 9건(BLOCKER: vosk 하드검사 순서모순 제거 — build.rs 가 번들 전 생성이라 안전, `--config` 리터럴 dangling 회피 — stage-runtime 이 tauri build 직접 spawn, agent 리소스 매핑 소유 결정) + 4회차 7건(BLOCKER: R3 의 "agent 4종 base 이주" 결정을 tauri-build 실소스로 반증 — `copy_resources` 는 `tauri dev`·`cargo check` 포함 무조건 실행이라 gitignored 스테이징 산출물을 base 에 두면 dev 즉사 → 매트릭스 3 OS 공통 그룹→생성 conf 소유로 개정, 분담 규칙 = 커밋 자산=base / 스테이징 산출·OS 델타·조건부=생성 conf. MINOR 6건 중 5건 반영: NAIA_MINIMAL 스모크 전제·nsis-hooks 귀속 교정·S-INSTALL 검증열 보강·glossary 6용어·매트릭스 초기값 출처) 반영.
- **게이트 규칙**: 각 phase 종료 시 적대적 리뷰 2회 연속 클린(루크 명시). R1~R8 모두 NOT CLEAN → 반영 완료. **P0 는 2026-07-17 루크 승인으로 '구현이 검증' 기준으로 조정하고 종료** — R5~R8 이 각각 직전 라운드의 개정에서 MAJOR 를 찾는 진자운동에 들어갔고(발견은 전부 실측 근거로 진짜였지만 성격이 '명세를 코드 수준으로 정밀화하다 생기는 실수'로 이동), 잔여 계열(로그 정규식·줄 개수·glob 형태)은 P1 구현 + vitest golden + 실제 CI 가 더 싸고 확실하게 잡는다는 판단. P1~P5 게이트는 각 phase 종료 시 원 규칙 유지 여부를 재확인한다. R4 잔여 MINOR 1건(`sdlc_gates` 구조화 필드에 #377 게이트 병기) = 2026-07-17 해소 — 아래 "병행 트랙: #377" 표.
- **적대 리뷰 5회차 (2026-07-17, 3렌즈 병렬 — tauri 실소스 대조 / 설계 정합·검증축 / 실현가능성·정직성)**: NOT CLEAN 7건 (MAJOR 2 + MINOR 5) 전부 반영.
  - **MAJOR ① 우분투 스모크가 번들 node 를 증명하지 못했다**: "PATH 에서 node 제거" 는 폴백을 못 막는다 — unix 폴백이 PATH 와 무관하게 사용자 홈 아래 `.nvm/versions/node` 를 직접 디렉토리 스캔한다(`lib.rs` 실측). 현 GitHub 러너가 통과하는 건 이미지가 우연히 비어 있어서일 뿐이라, 판정력을 외부 이미지에 위탁하는 셈이었다. 게다가 번들 node 가 최우선이라 PATH 제거는 정상 경로에 아무 영향이 없다. → 판정을 **"마커 출현 AND 실제 사용된 node 경로가 설치본 resource_dir 하위"** 2조건으로 교체하고, FR-INSTALL.3 에 `[Naia] node = <경로>` 로그 1줄을 신설했으며, 번들 node 를 일부러 지운 실행이 red 가 되는지 확인하는 변이 탐침(mutation probe)을 추가했다. 관측 대상이 "떴는가" 에서 **"무엇으로 떴는가"** 로 바뀌었다.
  - **MAJOR ② flatpak targets 이관 철회**: 이관하면 매트릭스 linux 행과 같은 사실이 **수기 파일에 두 번째 집**을 얻는데, 그 사본은 생성물이 아니라 어떤 검증 축에도 안 걸린다 — #377 이 근본원인으로 지목한 드리프트를 새로 만드는 것. repo 내 소비자도 0 건(실측)이라 보전할 것도 없었다. → `linux.json` 과 **동일한 외부 소비자 확인 규율**을 적용한 뒤, 소비자가 없으면 무변경(부활 시 매트릭스 flatpak 행).
  - **MINOR 5건**: 아이콘은 배열이라 머지가 병합이 아니라 **통째 대체**(RFC 7386) — mac 행은 전체 배열을 emit 하며 이는 겹침 금지의 명시적 예외 / vosk 빌드 순서의 진짜 보증자는 "번들러 수집 전" 이 아니라 **`links` 키** — 근거를 교정하고 `links` 실존을 게이트로 승격 / 단위 테스트 경로 확정(`scripts/__tests__/` — `src-tauri/**` 는 `vite.config.ts` 의 `test.exclude` 로 **영구 미수집**, 프로브로 실측 확인) / 추출 도구를 아카이브 포맷과 분리해 **3 OS 모두 OS 기본 `tar`** 로 명시 / mac 산출물이 **arm64 전용**(`macos-latest` = arm64 러너, Intel 몫 없음)임을 정직 표기.
  - **리뷰어 충돌 판정**: 렌즈 A 는 nvm 폴백이 스모크를 마스킹한다고 봤고 렌즈 C 는 러너 이미지 실측으로 반증했다. `lib.rs` 폴백 체인을 직접 읽어 판정 — 메커니즘은 A 가 맞고 현재 안 걸리는 건 C 가 맞다. 결론은 "지금은 우연히 통과하나 판정 근거가 외부에 있다" 이므로 A 의 교정을 채택했다.
- **적대 리뷰 6회차 (2026-07-17, 2렌즈 — R5 개정분 회귀 적대 / 구현 착수 가능성)**: NOT CLEAN 5건 (MAJOR 3 + MINOR 2) 전부 반영.
  - **MAJOR ① R5 가 폐기한 설계가 R5 자신의 커밋 안에 살아남았다**: 본문(requirements·user-scenarios)에서 "PATH 에서 node 제거" 를 폐기해 놓고, 같은 커밋이 새로 쓴 process-status 트랙 필드 4곳에는 그 문구가 그대로 남았다. 하필 process-status 는 매 세션 필수 읽기이자 헌장 파일이라, 다음 세션이 폐기된(판정력 없는) 게이트를 구현할 경로가 열려 있었다. → 4곳 모두 2조건 판정으로 치환. 개정은 본문만 고치고 끝나지 않는다는 교훈.
  - **MAJOR ② 위임과 수임이 어긋났다**: FR-INSTALL.3 이 "번들 분기 실행 증명은 FR-INSTALL.4·5 가 담당" 이라 위임했는데 FR-INSTALL.4 는 "기동+핸드셰이크 한정" 이라 받지 않았다. 게다가 Windows 실측 머신은 정의상 빌드 머신이라 시스템 node 가 반드시 있어(빌드 전제조건) PATH 폴백만으로 초록이 된다 — `node.exe` 동봉이 이 이슈의 출발점인데 Windows 번들 분기만 검증축 밖에 남을 뻔했다. → FR-INSTALL.4 에 FR-INSTALL.5 와 같은 2조건을 상속.
  - **MAJOR ③ "기대 산출물" 에 지시 대상이 없었다**: FR-INSTALL.6 은 "OS 분기 = 매트릭스" 라며 산출물을 확인한다는데, 매트릭스에는 산출물 경로·파일명 필드가 아예 없었고 "최소 크기" 도 값이 없어 무엇으로 잡든 명세를 만족했다(= 항상 통과 가능). → 매트릭스에 `artifacts: [{ glob, minBytes }]` 신설. 글롭을 쓰는 이유는 파일명의 버전이 `src-tauri/Cargo.toml` 에서 오기 때문 — 리터럴 파일명은 버전이라는 사실을 두 곳에 얽는다. `minBytes` 는 P3·P4 첫 실측 크기의 50% 로 핀하되 그전에는 null 로 두고, 검증 스크립트가 null 을 만나면 **명확한 에러로 중단**한다(임계 미정을 조용한 통과로 바꾸지 않고, 근거 없는 숫자를 먼저 적지도 않는다).
  - **MINOR 2건**: 클린 카운트 재개 지점이 한 파일 안에서 R5 와 R6 로 갈렸다(2연속 클린을 세는 카운터가 두 값을 가짐) → 통일 / `[Naia] node = …` 로그는 부팅당 **2줄**이다(agent·BGM 둘 다 무조건 스폰) — 판정이 1줄을 전제해 "하나라도/모두/첫 줄" 세 독법이 갈렸다 → **모든 줄이 resource_dir 하위** 로 확정(BGM 만 시스템 node 로 새어도 red) + 값은 env 오버라이드를 포함한 최종 확정 경로로 명시.
- **적대 리뷰 7회차 (2026-07-17, 2렌즈 — R6 개정분 회귀 / 리뷰 이력을 안 본 fresh 전체 통독)**: NOT CLEAN 4건 (MAJOR 3 + MINOR 1) 전부 반영.
  - **MAJOR ① 판정 근거로 삼은 로그가 누적 파일이었다 (두 렌즈가 독립적으로 발견 — 강한 신호)**: `naia.log` 는 `append` 전용이고 자르는 코드가 저장소에 하나도 없다(실측). 그래서 "`[Naia] node = ` 로 시작하는 **모든 줄**이 resource_dir 하위" 라는 조건에 세션 스코프가 없으면, 빌드 머신에 이미 남아 있는 이전 부팅(`tauri dev`·e2e-tauri)의 시스템 node 줄 때문에 **정상 설치본조차 영구히 red** 가 된다. 게다가 같은 CI job 에서 도는 변이 탐침이 스모크보다 먼저 실행되면 그 줄이 섞여 **실행 순서가 판정을 좌우**한다. → 판정 범위를 **마지막 `[Naia] === Session started ===` 이후 줄** 로 한정(이 구분자는 setup 최상단이라 두 spawn 보다 항상 먼저 — 실측 확인). 로그 파일 삭제로 대신하지 않는다(빌드 머신의 사용자 로그를 파괴하므로).
  - **MAJOR ② mac 산출물 검사가 실패할 수 없는 구조였다**: `macos/*.app` 는 파일이 아니라 **번들 디렉토리**라 크기가 디렉토리 아이노드(수십 바이트)로 잡히고, `minBytes` 를 "첫 성공 산출물 크기의 50%" 로 핀하는 방식이라 그 임계마저 수십 바이트로 굳는다 — 내용물이 비어도 통과한다. mac 은 실기기 실측이 없어 이 검증이 유일한 축인데 그 절반이 무력했다. → glob 을 `macos/*.app/Contents/MacOS/*`(번들 안의 실행 파일)로 교체하고 **모든 glob 은 단일 파일을 가리킨다** 는 규칙을 명시(빈 `.app` = 매치 0 = red).
  - **MAJOR ③ R6 의 교훈이 R6 자신에게서 재발했다**: R6 가 FR-INSTALL.4 에 상속시킨 Windows 2조건이 `user-scenarios.md` 와 process-status 트랙 필드 2곳에는 전파되지 않아 "설치본 기동" 으로 남아 있었다. 하필 그 파일이 P02 게이트의 산출물로 지정된 곳이라, 다음 세션이 그것을 읽고 구현하면 R6 가 막 닫은 구멍을 그대로 다시 연다. → 전 surface 전파.
  - **MINOR**: 신설한 `artifacts` 필드가 `glossary.md` 와 `user-scenarios.md` 의 매트릭스 정의 열거("타깃·동봉 리소스·설치자 설정")에 빠져 있었다 → "기대 산출물" 추가.
- **적대 리뷰 8회차 (2026-07-17, 2렌즈 — R7 개정분 회귀 / 모든 게이트의 반증가능성 전수)**: NOT CLEAN 4건 (MAJOR 2 + MINOR 2) 전부 반영.
  - **MAJOR ① 판정 술어 자체가 공허참이었다 (두 렌즈가 또 독립적으로 발견)**: 명세는 "`[Naia] node = ` **로 시작하는** 모든 줄" 이라고 썼지만, 파일에 쓰는 `log_to_file` 은 메시지 앞에 유닉스 초를 붙여 `[<unix_secs>] [Naia] node = …` 로 남긴다. 즉 `[Naia]` 를 줄 앵커로 잡으면 매치가 **0건**이고(실측: 앵커 0건 vs 포함 67건), "모든 줄이 하위" 는 공집합 위의 전칭이라 **무조건 참** — ② 의 판정력이 0 이 되고 변이 탐침조차 red 가 되지 않는다. 세션 구분자도 같은 오독이었다. → 술어를 **포함 매칭**(또는 `^\[[0-9]+\] \[Naia\] node = ` 정규식)으로 확정하고 FR-INSTALL.3 에 파일 줄 형식을 명시. 덧붙여 R7 의 "정상 설치본도 영구 red" 라는 논거 자체가 이 오독 위에 서 있었다(앵커 독법에선 오히려 영구 green) — 다만 세션 스코프라는 **처방은 유지**했다. 술어를 고치는 순간 누적 파일 문제가 진짜로 살아나기 때문.
  - **MAJOR ② 전칭 판정은 0줄이면 참이라, 줄이 사라지는 결함에 조용히 green 이 된다**: 로그 접두사 드리프트나 폴백 클로저 안쪽 기록으로 줄이 없어지면 ② 가 공허참이 되고 ①(핸드셰이크)만 남는데, 그건 R6 가 폐기한 상태 그대로다. Linux 는 변이 탐침이 이를 잡지만 **Windows 에는 탐침이 없어 이 게이트가 유일한 축**이다. → **"최소 2줄 AND 그 줄들이 전부 하위"** 로 개수 하한을 양쪽 대칭 추가 — 공허참이 원리적으로 불가능해진다. ("정확히" 로 쓰려다 자체 교정: `restart_agent` 가 `spawn_agent_core` 를 재호출하면 3번째 줄이 나와 상한은 정상 설치본을 거짓 red 로 만든다 — 실측 확인.)
  - **MINOR 2건**: S-INSTALL 의 Linux 절에만 세션 스코프가 빠져 비대칭이었다(process-status 는 "양쪽 모두" 라고 적음) → 병기 / FR-INSTALL.6 의 부정 케이스 테스트가 판정 로직을 **재구현**하면 실제 스크립트가 glob 0 매치를 건너뛰거나 크기 비교 부호를 뒤집어도 **영원히 green** 이다 — FR-INSTALL.2 에는 있는 "순수 함수로 분리" 제약이 .6 에는 없었고, 이 저장소 스크립트가 경로를 `import.meta.url` 로 자기 고정하는 관례가 재구현을 유인한다 → `verifyArtifacts({ bundleDir, artifacts })` 주입 가능 순수 함수로 분리하고 테스트는 그것을 **import 해 구동**(재구현 금지) 명시.
- **진행 (2026-07-17)**: P0 종료(루크 승인) → **P1 착수**. P1·P2·P5 는 **리눅스 머신에서 진행**(루크 지시). **P3 Windows 실측만 Windows PC 필요**(남겨둠). 리눅스 머신 = 시연 서버 — 상태 변경 실측(패키지 설치 등) 금지 유지, Linux 설치 스모크는 CI ubuntu job 담당.
- **트랙**: alpha-adk `.agents/progress/naia-shell-crossplatform-installer-2026-07-17.md` · GitHub #377.

### 2026-07-16 config SoT 클로버 픽스 (FR-CONFIG-SOT.5)

- **시연장 실측**: persona 21,187자 → 5,953자 클로버 4회 재발. App.tsx AdkSetup 분기가 하이드레이션 없이 게이트를 선개방(`configHydratedRef=true`) → mount-time `syncConfigToFile` 이 스테일 localStorage 를 config.json 에 되씀.
- **픽스**: 설정 화면 동안 게이트 닫힘 유지 — 설정 완료 후 하이드레이션 effect 재실행 시에만 개방.
- **검증**: 신규 `e2e/config-sot-boot.spec.ts` (Playwright 실 UI 3계약) 3/3 + config vitest 63/63 + tsc 0.
- **운영 수칙**: config.json 을 외부에서 수정할 땐 셸 종료 후 (떠 있는 셸의 unload flush 가 새 부팅 읽기보다 선행 — 캐시 오염 자기영속).
- **후속**: 에이전트 재스폰 시 패널 스킬 재등록 누락 / ollamaNumCtx 셸→에이전트 배선. 트랙 = alpha-adk `.agents/progress/naia-demo-knowledge-persona-clobber-2026-07-16.md`.

### 2026-07-16 시연 체크포인트

- **검증 구성**: 로컬 Ollama LLM + 원격 NVA full cascade `https://cascade.example.invalid:9449` (VoxCPM2 음성 + 아바타).
- **실기 결과**: 실제 Tauri Shell에서 음성과 입 모양 동기화가 정상이며, 해당 실행에서는 온라인 LLM과 클라우드 TTS를 사용하지 않았다.
- **라우팅 사실**: NVA Host가 명시되면 Shell은 해당 호스트의 `/stream_text`를 호출하고 Shell 측 `vllmTtsHost` 합성 전에 반환한다. 따라서 이 원격 NVA 발화 경로에서는 설정된 `:8910` 음성 호스트를 사용하지 않는다.
- **3090 운영 확인**: VoxCPM2 음성과 아바타를 합친 cascade는 `:9449` 단일 엔드포인트로 통일해도 된다고 확인받았다.
- **시연 전 동결**: 현재 Ollama + `:9449` 경로를 유지한다. 시연 전에는 배경 마스크/알파 처리만 허용하며 음성 또는 입 모양 동기화가 깨지면 적용하지 않는다.
- **마스크 이후**: 원격 서버의 character/bundle 계약으로 NVA 캐릭터를 추가한다. Windows 로컬 번들 경로를 원격 `/load_nva`에 보내지 않는다.
- **음색 변경 문제 담당**: 음성/캐릭터 음색 선택이 반영되지 않는 문제는 Shell이 아니라 RTX 3090 `:9449` cascade 서버 측 문제다. 시연용 Shell 라우팅은 유지하고 서버에서 해결한다.
- **미해결 종료 결함**: `로컬 프로파일 = 없음`을 선택해도 이전에 시작한 로컬 서비스가 종료되었다고 확인되지 않으며 GPU VRAM이 약 11.2GB로 유지된다. 합격 조건은 실행 중인 `tauri:dev`는 건드리지 않은 채 프로파일 소유 서비스가 종료되고 VRAM이 내려가는 것이다.

### 작업 노트 (2026-07-15 기준)

**S-VOICE-AVATAR (FR-VOICE.5)**: 부스 토폴로지 립싱크 배선 완료
- **두뇌**: 로컬 ollama DNA + **음성**: 원격 omni (vllmTtsHost → `/v1/audio/speech`, 음색 서버 해석 voice=naia-default) + **아바타**: 로컬 Ditto TRT (8GB 아바타 전용)
- 셸에서 합성한 WAV를 cascade `/stream` 립싱크로 직결
- `streamsAvatarPcm()` 순수함수 (synthesize.ts)
- naia-local-voice=true 기본값, synthesize.test.ts 검약 계약 4건 → 신 표면 계약 5건 + 게이트 3건 갱신
- FR-VOICE.4 (Rust CORS 프록시) stale 표기 (omni ACAO:* 실측, 프록시 코드 제거됨)
- **검증**: tsc 0 에러, 셸 vitest 1150 GREEN (107개 파일)
- **⚠️ 외부 블로커**: omni :8892 `/v1/audio/speech`에서 HTTP 500 (핸들러 크래시, 전 파라미터 변형 재현) — 런타임 팀에 채널 보고 예정
- realtime WS 경로는 정상 (ref_audio_url e2e 225KB)

**2026-07-10**: 검증·경화 (8GB 아바타 근본수정 확인)
- opencode GLM 5.2 이식분 리뷰 + 실측 완료
- **근본 진단**: 아바타 스폰 = `gpu.tier(EXCLUSIVE_8G_TIERS)` + localFocus 구동
- `buildSlotsManifest`가 localGpuTier auto를 해석된 tier id (resolveActiveTier → normalizeTierId)로 기록해야 wm(windows-manager)이 avatar_ditto_trt 시작 가능 (미해소 시 캐릭터 미표시)
- adk-store.writeSlotsManifest = VRAM 미전달 시 detectGpuVramGb 자동감지
- dev-setup + Rust (lib.rs/linux/macos/windows) = cascade 8910 고아(uvicorn 손자) 정리 kill_stale_cascade (EADDRINUSE 방지, R2.2b)
- GLM 잔여 TSC 실패 (계약테스트 레거시 tier id 캐스트) 수정
- vite.config test.exclude에 `src-tauri/**` 추가 (스테이징 agent 620 테스트 스코프 오염 제거)
- **검증**: tsc 0 에러, 셸 vitest 101개 파일/1096 GREEN, cargo check 0 에러, Playwright 전 스펙 격리(--workers=1) GREEN (workspace-panel 17/17, capability+slots 17/17; 전체 병렬 40 실패 = 8GB 부하 flakiness, 회귀 아님)

**2026-06-30**: Round 2 (로컬 cascade 임베딩, 멀티레포) FR-CASCADE.1~4
- R2.1: windows-manager loader launch 슈퍼바이저 + plan --json (wm 1756f4b, pytest 31)
- R2.2: naia-os: slots-manifest write (Rust write_slots_manifest + adk-store writeSlotsManifest) + Rust start/stop/cascade_status + spawn_cascade (CASCADE_READY 핸드셰이크) + CascadeProcess (Drop/WindowEvent/PID) + 설정 토글 UI + i18n 6개 언어
- cargo 0 에러, tsc 0 에러, SettingsTab + slots 66개 테스트
- 원격 금지, 로컬 사이드카만 지원
- 8GB 음성 단독: 6.9GB 적합 (RTF = R2.3 DEFER)
- 추적 파일: alpha-adk .agents/progress/naia-os-local-cascade-embedding-round2-2026-06-30.md

**2026-06-30**: Round 1 — 프로파일 UX 일관화 + VRAM 슬롯 추천 폐루프 + 로컬 음성 정직화
- FR-VRAM.4 (tier → 슬롯 로컬 추천 배지, 숨김 아님)
- FR-PROF.1 (프로파일 탭 토큰 일관화)
- FR-VOICE.1~3 (naia-local-voice → vllmTtsHost 라우팅, silent free 폴백 제거 → 명확 미가용 알림, voice picker 채움)
- 신규 lib/capabilities/tier-slots.ts (+ test 6/6)
- 적대적 리뷰 2개 벤더 PASS (blocker 0) + 수정 (채팅모드 알림 재무장, engine-capability-summary 토큰화, 공개레포 내부명칭 중립화)
- **검증**: tsc 0 에러, 셸 vitest 1008 GREEN, 영향 테스트 72/73
- 추적 파일: alpha-adk .agents/progress/naia-os-profile-design-gpu-voice-flow-2026-06-30.md
- Round 2 (로컬 cascade 라이프사이클 임베딩 + wm #1 M5) = DEFER

**초기 (F0~F3)**: 계약 + 스캐폴드 (async, src/main) — 계약 + 통합 테스트 67/67

**2026-06-29**: 세션 2~3 — S-SLOT FR-SLOT.4 설정 탭 9개 재구성 완료 (#1~#13 전체 구현)
- profile / brain / voice / avatar / persona / memory / knowledge / skills / general
- tsc clean, test 35/35, cargo check 통과
- 커밋 미수행 (8개 파일)
- 추적 파일: alpha-adk .agents/progress/naia-os-settings-tab-restructure-2026-06-29.md §7

**2026-06-30**: K2 지식 근거 → 원문 칩 (kb-compiler 통합 셸측)
- ToolActivity 지식 도구 (skill_knowledge_ask/search) 분기 → KnowledgeToolResult (답변 + sourceUris 칩)
- 칩 클릭 근거 → 원문 (URL = 브라우저 navigate / 파일 = 워크스페이스 openFile, 기존 패널 API 재사용)
- 게이트 FR-KB-OS.1~3 + 셸 feature 시나리오
- **검증**: knowledge-result.test.ts (파싱) + knowledge-tool-result.test.tsx (RTL 렌더 + dispatch) + e2e/chat-tools.spec.ts 지식도구 K2 (Playwright 실 UI 답변 + 칩 + 칩클릭 → 브라우저 패널)
- 셸 vitest 977 GREEN, tsc 0 에러, 구조 게이트 (enforce-root, file-anchors, assembly) PASS
- 백엔드 = naia-agent UC-KNOWLEDGE (live)
- 추적 파일: alpha-adk .agents/progress/naia-kb-compiler-agent-os-integration-2026-06-29.md (K2)

**2026-06-30**: K3 지식 그래프 2D/3D 뷰어
- ToolActivity skill_knowledge_graph 분기 → KnowledgeGraphView (캔버스 force, 군집색·degree 크기, 2D↔3D 토글·원근 + 자동회전, 의존성 0 엔진 examples/cms 포팅)
- 데이터 = kb-compiler toGraphData (2ecb342) + naia-agent skill_knowledge_graph (b7e3b8c)
- 게이트 FR-KB-OS.4
- **검증**: knowledge-result.test.ts parseKnowledgeGraph + e2e/chat-tools.spec.ts 지식그래프 K3 (Playwright 실 UI: 캔버스 렌더 + 노드 3개 + 2D/3D 토글 통과)
- tsc 0 에러

---

## SDLC 프로세스 게이트 (P01~P05)

| 게이트 | 상태 | 이름 | 산출물 (Deliverable) | 참조 |
|--------|------|------|---------------------|------|
| **P01** | 완료 | 사용자 시나리오 (user_scenarios) | `docs/user-scenarios.md` (UC1-14, S01~S71) | 완전성 13회 3연속 NONE |
| **P02** | 완료 | 테스트 시나리오 (test_scenarios) | `docs/user-scenarios.md` Test Coverage Map + `src/test/*.contract.test.ts` (계약 67/67) | 13회 |
| **P03** | 완료 | 요구사항 (requirements) | `docs/requirements.md` (FR-F0~F3, NFR) | 8회 |
| **P04** | 진행 중 | 통합 테스트 (integration_test) | `src/test/integration-reafference.test.ts` (인지흐름 관통 + negative + contamination) + `scripts/builds/f0-graft-smoke.sh` (Old-Baseline drift-gate 하네스) | 통합 67/67 통과; 라이브 trace (로컬 머신 graft) 대기 |
| **P05** | 보류 중 | 요구사항 완료 (requirements_complete) | — | 라이브 trace 등가 확인 + 후속 슬라이스 후 |

위 표의 상태·산출물은 **기본 트랙**(`current_work.issue` = naia-shell-transplant, F0~F3) 소유다. 병행 트랙은 아래에 따로 적는다 — 같은 사실을 두 곳에 적지 않기 위해 기본 트랙 상태를 여기에 복사하지 않는다.

### 병행 트랙: #377 크로스플랫폼 설치 파일 (installer_crossplatform_377)

| 게이트 | 상태 | 산출물 (Deliverable) | 참조 |
|--------|------|---------------------|------|
| **P01** | 완료 | `docs/user-scenarios.md` — 셸 feature 시나리오 표의 S-INSTALL 행 (#377, 2026-07-17) | **완료 2026-07-17** — 적대 리뷰 R1~R8 (8라운드, 실측 근거 결함 전부 반영). P0 종료 조건이 "리뷰 2연속 클린" 에서 **"구현이 검증"** 으로 조정됨 (루크 승인 2026-07-17, AI 임의 변경 아님) |
| **P02** | 완료 | `docs/user-scenarios.md` — S-INSTALL 행의 검증 열 (`scripts/__tests__/platform-matrix.test.ts` 단위 + `check-build-contract` 계약 + Windows 설치 실측(2조건: 핸드셰이크 AND node 줄 최소 2줄 AND 전부 `$INSTDIR` 하위) + ubuntu deb 설치·xvfb 기동 스모크(마커 AND node 줄 최소 2줄 AND 전부 resource_dir 하위 + 변이 탐침) — 양쪽 모두 판정 범위 = 마지막 `=== Session started ===` 포함 줄 이후(`naia.log` 는 누적 파일), 술어 = 앵커가 아닌 **포함** 매칭(파일 줄은 `[unix_secs] [Naia] …` 형식) + 산출물 검증 스크립트/부정 케이스) | **완료 2026-07-17** — P01 과 동일 (게이트 기준 조정, 루크 승인) |
| **P03** | 완료 | `docs/requirements.md` — FR-INSTALL.1~6 + NFR-noWSL (불변) · NFR-honesty | P01 과 동일. R4 개정 반영: agent 리소스 4종 = 매트릭스 3 OS 공통 그룹 → 생성 conf 소유 (base 금지 — tauri-build `copy_resources` 가 dev/cargo check 포함 무조건 실행) |
| **P04** | 완료 | `platform-matrix.test.ts` + `verify-artifacts.mjs` + `verify-installed-smoke.mjs` + 3 OS `build-installers.yml` | **완료 2026-07-19** — PR #379 merge `7ba15dc9`; exact 검증 head `de0e9e25`; installer CI 29658918546 Windows/Linux/macOS GREEN; Windows NSIS 실제 설치·실행·제거 후 Steam depot 독립 기동; Linux deb 설치·mutation/tamper probe; 적대 리뷰 2회 연속 CLEAN |
| **P05** | 완료 | README + platform matrix/manifest + artifact SHA report + GitHub #377 final report | **완료 2026-07-19** — FR-INSTALL.1~6, FR-STEAM.1~3, NFR-noWSL 충족. #377 종료; Steamworks 운영 단계는 #314에 이관 |

---

## 리소스 레지스트리 (Resource Registry)

| 항목 | 값 |
|------|-----|
| 마지막 enforce 실행 | 2026-06-10 00:06 UTC |
| 위반사항 | 없음 |

---

## 사용법 (Usage Guidelines)

### 세션 시작 시

1. 이 파일 읽기
2. current_work 섹션 확인
3. `last_updated`를 현재 시각으로 갱신
4. sdlc_gates 상태 확인 후 작업 시작

### 세션 종료 시

1. 완료된 게이트 status → "완료" (done)
2. deliverable 경로 기재
3. `last_updated` 갱신
4. `.users/context/process-status.md` 동기화
5. 이 파일을 커밋에 포함

### 신규 이슈 시작 시

1. current_work 필드 업데이트
2. `docs/progress/issue-{N}-{slug}.md` 신규 생성
3. sdlc_gates 전체 status → "보류 중" (pending)으로 리셋
4. resource_registry.violations 초기화


**2026-10-13**: #757 단계 2 가속기 확인 층 구현 진행 중
- 범위: Rust 내부 API와 Vulkan 경로. 기존 사용자 화면·호출부·프로파일 선택은 그대로 둔다.
- P01/P03: 기존 UC-WIN-NVA-8G와 FR-VRAM.1/FR-CASCADE.11, 승인된 단계 2 지시서를 근거로 한다.
- P02: fixture 기반 Rust 시험 계획과 구현을 기록한다.
- P04: accelerator fixture 11/11, UI 150개 통과, Linux build 및 Windows provider compile을 확인했다. 전체 Cargo와 Shell bundle budget의 실패·환경 한계는 별도 검수 증거에 기록했다.
- P05: Muse 코드 검수 전이므로 보류. 완료 주장은 아니오.
