# 0.2.6 B2C — NVA 테마와 캐릭터 카드 (2026-11-03)

기준 main `702b2c70`, 로컬 가지 `feat/026-charcard-nva`. 출시 목표 11/13, 기능 고정 11/9. 웹·로컬 동기화는 0.2.7. 운영 접속·푸시 없음.

## 조사

- [PR #792](https://github.com/nextain/naia-shell/pull/792), 현 head `e67184df`: land.naia.charcard는 실제 SillyTavern/TavernAI 계열 카드다. `src/apps/charcard/card-parser.ts`는 `chara_card_v2`/`chara_card_v3`, PNG tEXt/비압축 iTXt의 `ccv3` 우선, v1, CHARX도 지원한다. PR 설명은 초기판이고 현재 코드는 CHARX·CRC·이미지 상한까지 확장됐다. 앱은 IndexedDB 목록과 설치 앱 context bridge를 사용한다. 이번 slice는 parser/prompt와 시험만 이식하며 앱 전체 병합·상점 등록은 하지 않는다.
- [PR #811](https://github.com/nextain/naia-shell/pull/811): 설치 앱의 model.ask/speech/locale 권한, iframe source/origin·요청 ID 검사. #792 context와 별도 계약이다. 이번 native 설정 진입점은 iframe 우회나 새 브리지를 만들지 않고 기존 persona 경로를 사용한다. 두 PR 모두 조사 시 OPEN, main에 병합 완료로 보지 않는다.
- [PR #794](https://github.com/nextain/naia-shell/pull/794): 웹 NVA `/nva/<name>/`, VP9 alpha/stacked MP4, 배경 8종. Safari 실기·좁은 레이아웃 미완. 데스크톱 slice에 웹 가지 전체를 병합하지 않는다.
- [#714](https://github.com/nextain/naia-shell/issues/714): 절차적 호흡/흔들림, head_track, reduced-motion. 현재 `src/lib/avatar/nva-procedural-motion.ts`, `nva-layered-player.ts`가 존재한다.
- [#743](https://github.com/nextain/naia-shell/issues/743): NVA 조용한 실패·MP4 검은 배경·옛 기본 자산. 테마 출시 수용에서 실제 decode 성공 확인 후 commit/실패 rollback이 필요하다. 파일 목록에 뜬다는 것만으로 재생 성공이라 하지 않는다.
- [#760](https://github.com/nextain/naia-shell/issues/760): Ditto 발화 조각 정본·음성 시각 동기화. 테마는 플레이어를 추가하지 않는다. `nva-core.ts`, `nva-sync-driver.ts` 기존 경로를 사용하고 aiueo 반복을 도입하지 않는다.
- 기존 `SettingsTab.tsx`는 nvaModel/avatarProvider·ttsProvider/ttsVoice·backgroundVideo 및 persona를 개별 관리한다. `persona.ts` → ChatArea의 buildSystemPrompt 경로를 재사용한다. NVA 파일은 ADK `naia-settings/nva-files/<id>/manifest.json`와 clips, 설정은 `naia-settings/config.json`(페르소나)과 `ui-config.json`(아바타·배경·음성 UI)으로 나뉜다.
- 읽기 전용 제품 문서 release-025-plan-20261031/apps-025-integration-plan-20261101/webgpu-sample-dev-20261021/index를 대조했다. 이전 0.2.5 공동 출시·동기화 계획보다 이번 11/3 지시(0.2.6 B2C·동기화 0.2.7)가 우선한다.

## 화면 흐름

설정 → 페르소나 → 캐릭터 카드 파일 선택 → 읽는 중(재입력 잠금) → 이름·첫 인사 미리보기 → 적용 → 기존 persona/name 편집 가능. 오류는 원문/경로 대신 복구 안내, 이전 값 보존. 카드의 첫 인사는 이번 slice에서 프롬프트로 전달하며, 자동 assistant turn 삽입·음성 재생은 후속 대화 시작 버튼에서 수행한다. 기존 대화에 예고 없이 첫 인사를 삽입하지 않는다.

같은 화면에서 현재 선택한 NVA·음성·배경에 테마 이름 입력 → 현재 테마 저장 → 저장한 테마 선택 → 테마 적용. 기존 config writer로 즉시 저장한다. 모델 설정은 그대로이므로 로컬 Ollama/vLLM을 이미 고른 사용자는 별도 유료 API 없이 카드 문맥을 사용할 수 있다. 클라우드를 선택한 경우 무료라고 표시하지 않는다. 로컬 모델이 없는 경우 모델 탭에서 설치/선택하고 재시도하는 안내를 후속 추가한다.

## 데이터 계약과 위치

카드 외부 형식: `{spec:'chara_card_v2'|'chara_card_v3',spec_version:'2.0'|'3.0',data:{name,description,personality,scenario,first_mes,mes_example,...}}`. 원문은 parser의 rawJson으로 보존, 알려진 텍스트 필드는 정규화한다. v3의 확장값·assets는 실행하지 않는다. PNG 그림과 NVA는 별개다.

테마 내부 형식 v1: `{id,label,nvaModel,ttsProvider,ttsVoice,backgroundVideo}`. 이번 slice는 사용자가 현재 선택을 저장하는 로컬 카탈로그이며 `ui-config.json`의 `uiPreferences.b2cNvaThemes`에 `{version:1,id,name,nvaModel,ttsProvider,ttsVoice,backgroundVideo?}` 배열(최대 30개)을 저장한다. 파일명은 설치 목록과 대조하며 임의 원격 manifest/URL을 받지 않는다. 카드와 테마는 같은 활성 셸 설정에 함께 적용된다. 카드별 테마 연결 ID·원본 라이브러리는 후속이다. 이후 사용자 테마는 ADK `naia-settings/themes/<id>/theme.json`, 카드 원본 `naia-settings/characters/<uuid>/card.json`, 카드↔테마 연결 `{version:1,cardId,themeId}`로 별도 보관한다. 경로는 이름 대신 생성 ID만 쓴다. 원본 보관·다중 카드 라이브러리는 후속이며 이번에는 기존 config.persona/agentName에 적용본을 저장한다.

프롬프트는 #792의 budget 24,000자를 재사용한다. 본문/예시/첫 인사와 로어북을 텍스트로만 결합한다. 카드가 도구 권한·provider·system 안전 정책을 바꾸는 설정을 제공하지 않는다. 앱 브리지와 셸 persona는 동시에 같은 카드를 적용하지 않도록 후속 통합 시 소유권을 명시한다.

## 구현 순서와 수용 범위

1. 문서·시나리오/시험 매핑·요구사항(이 문서가 코드보다 먼저).
2. conform의 TS 파일 앵커 차단을 활성화. 기존 루트 위반 `tmp/`, `tsconfig.build.json`은 tracked baseline이라 임의 삭제하지 않음. 의존성 설치 후 기준 시험 기록.
3. #792 parser/prompt/시험 이식 → 타입 검사/단위 시험 → 셸 설정 연결 → Playwright 360/1100px 상태·키보드 검토.
4. 후속 native 수용: 저장/재시작·테마 실제 영상 decode·실패 rollback·실 로컬 모델 카드 대화·첫 인사 낭독. 이 증거 전 전체 제품 Done/출시 가능을 주장하지 않는다.

## P04 증거와 검토

- 기준 Shell: 247 파일 통과/1 제외, 2,597 통과/21 제외. 구현 후 전체: 250 파일 통과/1 제외, 2,621 통과/21 제외 (`tmp/final-shell.log`, 실행 폴더 아래). 이후 최종 로그 개인정보 제거·폭 보정은 관련 회귀 218 통과/8 제외와 아래 UI 재검증으로 확인했다.
- 카드/parser·prompt·config 집중 24/24. `SettingsTab`/`adk-store` 포함 관련 회귀 218 통과/8 제외 (`tmp/relevant-tests.log`). TypeScript core/Shell/BGM, compile-integrity 통과. Agent 짝 checkout `../naia-agent`가 없어 Agent 타입/실대화까지 통과라고 하지 않는다.
- `e2e/character-theme.spec.ts`: 1100px·360px 두 흐름 통과. 실제 셸 설정 진입, 잘못된 카드→재선택, 저장 실패→이전 페르소나 확인→재시도, busy 상태 input/button 잠금, 키보드 Enter 적용, 페르소나에 예시 포함, 모델 보존, 테마 저장·적용, config/UI config IPC 기록을 단언한다. IPC는 fixture이므로 native 저장 증거와 다르다.
- `verify-visual-ux`: 카드 불러오기→미리보기→적용이 첫 정보 위계이고 테마가 그 다음이다. 빈 카드/빈 테마 안내, 진행 output, 성공 output, 오류 alert·재시도가 있다. 360px에서 설정이 40px로 밀린 문제를 활성 Settings 한정 전체 폭 CSS로 보정하고, 탭은 가로 스크롤을 허용했다. screenshot을 직접 열어 입력·버튼·긴 본문·상태가 폭 안에 있는지 확인했다. 좁은 폭 수용 시험은 넓은 화면에서 설정을 연 뒤 줄이는 경로다. 설정이 아직 열리지 않은 360px의 기존 앱바 진입 문제는 남아 있으며 일반 모바일 지원 완료로 주장하지 않는다.
- 최종 UI 증거: 실행 폴더 `tmp/playwright-final-pass/character-theme-card-and-theme-settings-{1100,360}px-chromium/character-theme-{1100,360}.png`, `tmp/e2e-final-pass.log`.
- 구조/assembly/file-anchor/logging/UC trace 통과(기존 root whitelist 위반 2건은 별도). conform에 TS 편집→파일 앵커 oracle를 연결했고, 실행 폴더 격리 fixture에서 clean 허용/미계약 파일·손상 manifest 차단을 확인했다. C region 매니페스트는 여전히 비어 있으나 TS는 이 경로에 의존하지 않는다. 이 oracle의 계약 범위는 core `src/main`이며 Shell 전체 의미론 계약 검증으로 확대해 주장하지 않는다.
- 전체 문서 그래프는 기존 quality-reviews의 예제 문자열을 링크로 인식하는 오류가 남아 실패한다. 이번 설계는 기존 `progress/` 규약으로 추가했고 헌장 파일은 바꾸지 않았다.

## 11/4~11/9 후속

| 날짜 | 일감·완료 증거 |
|---|---|
| 11/4 | 카드 원본/라이브러리와 카드별 themeId 저장·복원, 테마 수정/삭제, 자동 assistant 첫 인사 턴 계약 정의·시험 |
| 11/5 | #792/#811 공통 context 소유권과 앱 통합, 실제 로컬 Agent 카드 대화·유료 provider 자동 선택 없음 증명 |
| 11/6 | native NVA decode·첫 인사 음성·립싱크·배경 재생, #743 실패 rollback 및 #760 정본 회귀 |
| 11/7 | Windows/Linux native 저장/재시작·ADK 전환·취소/경쟁·손상 카드, 360px 초기 설정 진입 보정 |
| 11/8 | 무료 테마 자산/라이선스·스토어 서명 묶음 후보 준비(공개 없음), 실제 기기 통합 회귀 |
| 11/9 | 기능 고정, 미통과 항목 분리·동결 후보 해시·11/13 출시 판정 자료 작성 |

최종 재검증: trace 소유권 표기 후 agent-bench scenario-source 계약 14/14 통과. 최종 production Vite build와 bundle budget 통과(entry raw 483,630 / 540,000 bytes, gzip 152,516 / 170,000 bytes). 이 빌드는 native installer가 아니다. 관련 로그는 실행 폴더 `tmp/harness-tests.log`, `tmp/final-build.log`, `tmp/final-bundle-budget.log`.

## 2회차 설계 — 11/4·11/5 (2026-11-03)

P01~P03 확장: 카드 라이브러리는 workspace ui-config의 uiPreferences.b2cCardLibrary v1로 저장한다. 원본 JSON(미지 확장 포함)을 보존하고 재선택 시 parser로 다시 검증한다. PNG·JSON 원본 바이트도 base64로 보존하고 원본 내보내기를 제공한다. 원본 포함 직렬화 JSON 총 2MB/30장 상한을 두어 설정 저장 폭증을 방지한다. 카드 ID는 UUID, themeId는 저장된 테마에만 연결한다. 삭제한 테마 참조는 같은 쓰기에서 해제한다. 카드 적용은 현재 대화를 수정하지 않으며, 명시적인 '새 카드 대화' 행동에서만 새 session과 assistant 첫 인사를 만든다. 기존 session의 카드 문맥 오염을 막기 위해 다른 카드 적용은 새 대화 시작과 결합한다. 모델·음성 공급자 선택은 기존 Settings와 Agent 설정 경로를 공유하며 별도 카드 provider를 만들지 않는다.

P02: 단위 시험은 원본 확장 보존/손상 데이터/상한/연결 해제/새 session 첫 인사/이전 메시지 분리를 확인한다. Playwright는 빈 목록→import→저장→카드 재선택→테마 연결/수정/삭제→새 대화→첫 인사 및 1100/360px, 진행 잠금·쓰기 오류 재시도를 확인한다. 재시작은 persisted config 재주입으로 검증하며 native 파일 저장과 구분한다. 실제 로컬 모델은 격리 실행 폴더에서 작은 모델 하나만 사용하고 Agent 응답·finish·선택 provider 유지 증거를 남긴다. 시각 검토는 verify-visual-ux를 적용한다.

세션 상태: 헌장 파일 수정 승인 없이 process-status.json을 갱신하지 않는다(F01 우선). 기존 root whitelist 2건은 baseline 유지. assembly와 conform TS file oracle를 먼저 실행한다. 전체 제품/네이티브 수용은 이번 slice 증거 범위와 분리한다.


앱 통합 P01~P03: #811의 host bridge를 선택 이식하여 installed app은 model.ask/speech/locale 권한과 source/origin/requestId 검증을 거친다. 모델·음성은 ChatArea의 기존 sendChatMessage와 sentence-pipeline을 공유한다. 앱 context는 활성 iframe 소유로 한정하고 닫힌/교체된 iframe의 지연 push를 거절한다. native 활성 카드가 있을 때 charcard 앱의 roleplay context를 이중 주입하지 않는다. P02 매핑은 host bridge 보안/공용 dispatch·context 소유권 Vitest 및 Playwright. Rust 권한 registry 변경은 TS와 parity 시험으로 확인하고 native 전체 수용과 구분한다.

## 2회차 P04·P05 증거 (2026-11-03)

- 카드 원본은 PNG·JSON 전체 바이트(base64), 원본 파일명, rawJson과 생성 ID로 보관/내보낸다. ADK `naia-settings/ui-config.json`의 `uiPreferences.b2cCardLibrary`(최대 30장/직렬화 2MB), `b2cActiveCardId`, 카드별 themeId를 사용한다. 선택 시 parser로 다시 해석하고, 저장 시 생성한 greeting을 보관한다. 기존 20MB parser 상한과 라이브러리 2MB 상한은 다르며 UI에 안내한다. 큰 원본을 개별 파일로 분리하는 확장은 별도다.
- 카드 적용과 명시적 새 대화가 결합되어 새 localSessionId/assistant 첫 인사를 만든다. 기존 메시지 배열은 덮어쓰지 않는다. 진행 중 모델 응답에서는 카드 적용을 잠근다. 현재 카드 모델/음성은 기존 공용 설정을 그대로 사용한다. 테마 삭제는 카드 참조를 같은 preferences 쓰기에서 해제한다.
- 360px 재시작 검증에서 다른 UI 설정 writer가 비동기 카드 저장 중 이전 config를 다시 저장하는 경쟁을 발견했다. pending 카드 설정을 bootstrap에 먼저 공표하고 쓰기 실패 시 이전 필드·config를 복구하며 UI preferences 쓰기 성공을 별도 확인하도록 보강했다. 복구 쓰기 자체가 실패하는 장치 장애까지 원자 트랜잭션을 보장한다는 뜻은 아니다.
- 최종 Shell 전체 253파일 통과/1제외, **2645 통과/21 제외**, 실패0: 실행 폴더 `tmp/r2-final-full-shell.log`. 카드/대화 40, 앱 연결 회귀 181 통과는 각각 `r2-focused-final.log`, `context-regression-final.log`. 초기 개발 중 mock Promise 계약 실패는 기존 fixture에서 정상 비동기 반환값을 복원한 후 재검증했다.
- Playwright 실제 셸 화면 1100/360px **2/2**: `tmp/r2-e2e-visual.log`, `tmp/r2-playwright-visual/`. 카드 두 장 전환·재시작 복원·원본 PNG 내보내기 바이트 일치·테마 연결/수정/삭제·첫 인사·기존 대화 분리·provider/model 유지·config/UI-config 쓰기 실패 재시도·진행 잠금·Enter·경계 검사. IPC 파일 저장은 fixture이며 실 native 저장 증거가 아니다.
- verify-visual-ux: 빈 목록/기본/import 진행/성공/오류·재시도/좁은 폭 상태 확인. import→preview→새 대화 적용과 테마 행동의 위계를 유지했고, 작던 보조 버튼을 40px 이상으로 보정했다. 원본 내보내기·테마 선택·대화 screenshot을 직접 열어 확인했다. 테스트 자산은 decode fixture이므로 실제 NVA 재생/TTS를 입증하지 않는다.
- 실제 로컬 모델 **qwen2.5:0.5b**, 397,821,319 bytes, CPU, 1개만 `tmp/local-model/models/`에 설치. 실제 Shell core→Agent gRPC→ADK config persona 조립→Ollama 두 턴, 연결거절 시 error/클라우드 fallback0을 확인했다. 실제 Chromium ChatArea→sendChatMessage→core→IPC 하네스→실 Agent→실 생성→DOM도 확인했다. 마지막 requestId `req-1793706651320-p0yil`, 414 input/23 output, cost0, finish1. 원문 “Mira, I am Mira, an astronomer from the Moon Garden. Vega is my favorite star.”. `tmp/local-model/{evidence.json,browser-evidence.json,real-local-card-browser-chat.png,README.md}`. loopback 외 모델 fetch를 차단했다. Rust/packaged Agent entry까지 검증한 것은 아니다.
- core/Shell/BGM TypeScript·compile-integrity·assembly·file-anchor·logging·UC trace·scenario-source14 통과. Agent 전체 원본 tsconfig도 실제 dependency 선언을 tmp에 빌드해 통과: `tmp/local-model/full-typecheck/evidence.json`(Agent a4aef165, memory008eac79, kb403edb02). 타입 stub 없음. 최종 production build/entry budget 통과: `tmp/r2-final-build.log`.
- native 차단 사실: 지정 Agent main a4aef165/proto20d9aa6e와 셸 핀 fdc6fcb5/proto71e4cb6b가 다르며 resolver가 거절했다(`tmp/r2-native-pairing.log`). cargo/tauri-driver/WebKitWebDriver/기존 바이너리도 없다. 핀을 우회하거나 다른 작업자의 Agent를 사용하지 않았다. native 설치판 저장·NVA·음성은 11/6~11/7 수용에 남긴다.
- 초기 root whitelist `tmp/`, `tsconfig.build.json` 2건은 그대로다. 헌장 파일과 외부 읽기전용 문서는 변경하지 않았다. 프로세스 갱신은 F01과 충돌해 이 ledger에 기록한다. 설치 앱 appName 태그는 세션 내 history에서 제외되지만 Agent 디스크 히스토리 복원 뒤 태그 보존은 후속이다. 운영 접속·자격 사용·push는 없다.

## 3회차 설계 — 11/6·11/7 당김

P01: 명시적 새 카드 대화는 기존 첫 인사 턴을 현재 테마 음성으로 한 번 낭독한다. uiPreferences.b2cGreetingAutoplay=false로 자동 낭독을 끈다. 전역 TTS 끄기도 존중한다. 재시작·기존 대화 열기는 낭독하지 않는다. 비동기 음성 설정 조회 중 대화 교체·사용자 입력·컴포넌트 해제는 이전 인사 발화를 취소한다.

P02: ChatArea 공용 sentence-pipeline 시험으로 테마 provider/voice·전역 및 카드 자동낭독 끄기·취소를 검증한다. 테마 적용은 manifest/영상 기본·발화·동작 클립과 선택 배경의 실제 decode를 사전 확인하고 기존 persistCharacterSettings 복구 경로를 사용한다. 브라우저에서 정상 WebM과 손상 파일을 사용해 실패 시 이전 모델·음성·배경·카드 유지와 재시도, 360px 최초 설정 진입을 검증한다. 정본 NVA sync-driver/core 회귀를 실행하며 새로운 aiueo 반복 플레이어를 만들지 않는다.

P03: 테마 검증 중 중복 행동을 잠그고 오류는 이전 테마 유지·재시도를 안내한다. decode 시간 제한 15초/자산, 자산은 순차 검증해 동시 디코더 폭증을 피한다. workspace가 바뀌면 적용하지 않는다. Windows/WebView2·네이티브 Tauri·2070 청취/투명도는 별도 수용 체크리스트로 남긴다. pin은 지정 짝 Agent의 clean HEAD/proto와 맞추고 계약 검사를 실행한다.

## 3회차 P04·P05 증거 (2026-11-03)

- 명시적 새 카드 대화의 첫 인사만 기존 sentence-pipeline에 보낸다. 전역 ttsEnabled와 uiPreferences.b2cGreetingAutoplay(기본 켜짐)를 함께 확인한다. 기존 assistant 턴을 다시 삽입하지 않는다. session/generation/새 사용자 메시지/해제 경계로 지연 발화를 폐기한다. 테마 변경 직후 새 renderer를 최대 3초 기다리고 modelId가 다른 이전 renderer의 저작 음원을 거절한다.
- 정본 utterance가 정확히 일치하면 기존 NVA의 자체 녹음 A/V 클립을 한 조각으로 재생한다. 다른 인사는 테마 provider/voice의 일반 TTS와 기존 talking visual을 사용한다. 새 aiueo 반복/별도 합성 경로는 없다. 임의 생성 문장의 Ditto 정밀 립싱크까지 구현했다고 주장하지 않는다.
- 테마 적용은 설치 목록→manifest→모든 clip 참조(중복 제거, 최대200)→선택 배경 순서로 검증한다. video는 loadeddata·양수 해상도·play 성공, image는 load·양수 폭을 확인한다(자산당 15초 제한). 검증 중 이전 테마가 계속 활성이고 실패 시 설정 저장을 시작하지 않는다. 이후 저장 실패는 기존 persistCharacterSettings의 복구 쓰기를 사용한다. 손상 영상·쓰기 실패·재시도·모델 보존을 Playwright에서 검증했다. 적용 이후 파일 삭제/장치 상실/렌더러의 늦은 GPU 실패까지 자동 복구하는 계약은 아니다.
- 지정 Agent clean HEAD a4aef165ed7e9d22d30f5b834931cb272f7e4654 / proto20d9aa6eb3a4396daef360f0155aa27c21b83b1faf0132691cb596a189c18b12로 JSON/Rust build 상수/설치 CI/self-trust CI/README를 일치시켰다. wire 차이는 ThinkingLevel XHIGH=4 추가뿐이다. resolver가 지정 checkout을 선택했고 pin drift 계약6/6 통과. memory 핀 e8cbd6f8/0.1.4는 변경하지 않았다.
- P04: 전체 Shell **2652 통과·21 제외**, 마지막 음성/VideoAvatarCanvas/renderer/카드 집중48 통과. core mirror/divergence·sync-driver 포함 NVA 집중23 통과. 로그는 실행 폴더 tmp/r3-full-final.log, r3-final-focused.log, r3-nva-unit.log. 개발 중 변환/편집과 겹친 첫 전체 실행은 중단하고 고정된 구현으로 전체를 재실행했다.
- Playwright1100/360px **2/2**: tmp/r3-e2e-av.log, tmp/r3-playwright-av/. 360px 최초 설정 진입, 자동낭독 끄기/켜기 저장, 카드/테마 기본·빈 목록·진행 잠금·성공·오류 재시도, 실제 WebM decode·PNG 배경 decode, 손상 영상→이전 설정 동일, 원본 내보내기·재시작 복원 검증. 실제 ChatArea→sentence-pipeline→PrebakedAvatarRenderer→WebM+Opus의 비음소거 playing/양수 해상도를 확인했다(자산은 시험 영상·음원, 사람의 청취/실 캐릭터 품질 증거와 다름). 설정 파일 IPC는 fixture다.
- 정본 브라우저 P3 sync-driver/P4 layered **3/3**: tmp/r3-e2e-final.log. P3 mean signed drift 8.6→2.5ms, p95 31.0→19.5ms. 이 별도 모듈 하네스 수치가 설치판 전체의 지연 보장이라는 뜻은 아니다.
- verify-visual-ux: 1100/360px 결과 화면을 직접 열어 확인. 카드 import→미리보기→적용이 먼저, 테마가 뒤다. 상태/alert·재시도·읽는 중 잠금·label/Enter와 버튼 경계를 검증했다. 360px에서 처음부터 설정 단추가 화면 안이다. 추가한 checkbox는 즉시 선택을 표시하고 쓰기 실패 때 이전 선택으로 복구한다.
- native 실행은 cargo/tauri-driver/WebKitWebDriver/기존 바이너리 부재로 수행하지 않았다. 사용자 지정 2070 체크리스트는 실행 폴더 result.md에 단계·기대 결과로 기록한다. #743/#760 전체 해결·Windows 수용·출시 가능을 선언하지 않는다.

최종 강화 Playwright도1100/360px 2/2 통과(tmp/r3-e2e-complete.log, tmp/r3-playwright-complete/). 이전 nvaModel=previous/voice=Aria와 다른 후보 naia/SunHi를 적용하면서 손상 clip 실패와 write_naia_config 실패를 각각 만들고 이전 설정 전체 동일→재시도 성공을 검증했다. production 최종 build/entry budget 통과(raw491641, gzip154739), core/Shell/BGM/Agent 원본 tsconfig 통과. Agent 타입검사용 임시 node_modules 링크는 제거했고 지정 Agent tracked 상태는 clean이다. 이 서버의 native 도구 부재와 사용자 요청의2070 수용은 별도이며 process-status는 사용자 제공 헌장 목록 때문에 변경하지 않았다.
