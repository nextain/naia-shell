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


## 4회차 설계 — 11/5 설치 앱 회귀

P01~P03: UC-B2C-026-R4/FR-B2C-026-R4. #792의 실제 git snapshot을 실행 폴더 tmp에 빌드해 설치 디렉터리를 만들고 셸 app-loader/iframe을 통해 회귀한다. Tauri IPC·상점 서명은 모의 경계와 실제 검증을 구분한다. #811은 공용 host protocol이며 소비 앱 패키지 확보 여부와 실제 모델/음성 증거를 따로 기록한다. 지정 Agent a4aef165의 ConversationTurnRecord와 ChatRequest wire에는 appName이 없으므로 셸 단독으로 디스크 태그 저장 성공을 주장할 수 없다. transcript writer는 Agent 한 곳으로 유지한다. 셸 reader는 유효 태그를 보존하도록 수정하고 Agent 미지원 재현을 인수 자료로 남긴다. 실패 안내의 하드코딩/원시 예외를 locale key로 교체한다.


## 4회차 P04·P05 판정 (2026-11-03)

- **셸 수정 slice Done / 실제 설치판 전체 수용 미충족.** 앱 요청 busy·등록/연결 실패·provider 실패·낭독 예외를14개 locale key로 연결했다. 앱 provider 실패는 iframe 응답과 채팅 failure detail 모두 원시 예외를 숨기며 Logger에는 원인을 남긴다. 프로토콜 오류 코드 호환은 유지한다. transcript reader는 유효 appName을 보존한다. Agent 단일 writer는 변경하지 않았다.
- P04 전체 Shell: **2663 통과·21 제외**, 253파일 통과/1제외(`tmp/r4-full-stable.log`). 최초 실행은 기존 Herdr 타이밍 실패1, 다음 실행은 core dist 컴파일과 겹쳐 unrelated composition/onboarding25실패가 나왔다. 같은25개는 분리 실행32/32에서 통과했고, compile 작업 종료 후 고정된 전체를 재실행해 위 결과를 확인했다. 이를 새 기능 실패가 없다는 증거로 쓰며 최초 실패 로그도 보존했다.
- 변경 집중 **44/44**: `tmp/r4-focused-complete.log`. appName 복원/비문자·과대·빈 태그 거절/일반 모델 history 제외, host/context 소유권, ko/en 등록 실패·provider 원시 예외 차단·선택 모델/음성 회귀. 원본 #792 snapshot의 parser/prompt/UI 시험 **25/25**(`tmp/r4-package-tests-complete.log`).
- 실제 #792 snapshot **e67184df1993107d47539bc33e536010e28792e3**, `land.naia.charcard`0.1.0을 실행 폴더 tmp에 추출해 production 빌드/zip/설치 디렉터리를 만들었다. sha256/파일 목록은 `tmp/r4-package-manifest.json`. 셸 app-loader→GenericInstalledApp iframe→원본 앱 JSON import/Enter로 시작→context1개→실 Shell core/Agent gRPC/ChatTurnHandler→실 CPU Ollama qwen2.5:0.5b→DOM 응답을 확인했다. native 카드 활성 시 설치 charcard entry0개, 비활성 iframe 지연 context 거절도 확인했다.
- #811 공용 연결의 소비 앱은 **시험용 test.bridge**다(실 타로 등 상품 아님). Agent 실제 register/clear RPC ACK→공용 model.ask→DOM, 직접 speak→공용 sentence-pipeline/AudioQueue→실 로컬 CPU Flite WAV→비음소거 playing/양수 duration→speech-result finished, 설정 General에서 한국어 선택→locale ko→모의 provider 오류의 한국어 안내→정상 로컬 모델 재시도를 검증했다. 최종 run은 모델 요청5개(실생성4/의도적 오류1), 실제 WAV4개, provider HTTP는 loopback만. `tmp/r4-live-final-acceptance.log`, `tmp/r4-browser-evidence.json`, `tmp/r4-agent-evidence.json`, `tmp/r4-speech-*.wav`. IPC와 TTS endpoint의 Flite facade는 하네스이며 packaged Agent entry·Rust·VoxCPM·사람 청취 수용은 아니다.
- verify-visual-ux: 실제 카드1100/360px 화면을 직접 열어 import→카드 목록→역할극 시작의 위계와 Enter·버튼 경계를 확인했다. 오류/재시도는 공용 소비 fixture의 alert/status와 한국어 안내로 확인했고 시험 fixture의 저대비 글자를 보정했다. 원본 카드의 저장/import busy·오류 복구는 원본 UI 시험25개에 포함된다. 빈 카드 라이브러리·기본/진행/오류/좁은 폭 전체의 native 수용은 이전2070 목록과4회차 추가11~14에 남긴다. 실제 #792 원본 manifest는 locale 권한이 없으며, 셸 언어 변경 뒤 원본 카드 UI가 즉시 바뀌는 계약까지 통과로 주장하지 않는다.
- **appName 디스크 재시작 FAIL**: 지정 Agent a4aef165의 ConversationTurnRecord/ChatRequest/handler append/writer에 appName 지원이 없다. 실제 writer에 tag를 추가 전달한 write/read 별도 프로세스도 JSONL 두 행에서 tag가 사라진다(`tmp/r4-history/restart-evidence.json`). 실제 브라우저 앱 요청의 Agent 기록에서도 누락됐다(`tmp/r4-real-transcript-evidence.json`). 셸 reader 준비만으로 전체 해결이 아니며, Agent wire·writer·Rust 전달을 짝으로 보강한 뒤 pin 갱신·실 재시작 시험이 필요하다.
- core/Shell/BGM TypeScript·compile-integrity·assembly·file-anchor·UC trace 통과. 최종 production build/entry budget raw491942/gzip154809 통과. 기존 root whitelist2건과 untranslated-ui의 기존 CharacterThemeSettings 언어 분기 등은 남아 있다. C conform region은 비어 있고 TS file oracle는 core src/main 범위다. 헌장/process-status/외부 읽기전용 문서·다른 작업자 폴더·Agent tracked 소스는 변경하지 않았다.
- `tmp/r4-native-preflight.json`: cargo/tauri-driver/WebKitWebDriver/기존 native 바이너리 없음. signed Store 실제 상품·권리/서명 검증과 Windows/2070 수용은 별도다. 결과 원문과 날짜별11/4~11/9 일감 및 기존2070 목록+추가11~14는 실행 폴더 result.md에 기록한다. 원격 push/운영 접속 없음.


## 5회차 설계 — 11/4 상품·자산 인수 준비

P01~P03: UC-B2C-026-R5 / FR-B2C-026-R5. signed 상품·권리 증빙이 없으므로 제공된 unsigned #792 묶음의 누락을 실측하고, 이후 전달받을 파일을 오프라인 검사할 CLI를 작성한다. 표준 Node crypto와 Python zipfile만 사용한다. ZIP은 디스크에 풀지 않으며 실제 스트림 바이트를 상한 내에서 읽어 CRC/hash를 검증한다. 신뢰 키는 Rust 정본에서 파생하고 시험 키 주입은 import된 함수의 단위 시험에만 허용한다. 결과의 offlineChecksPassed는 출시·설치·법적 권리 승인과 별개다. Agent checkout·핀은 바꾸지 않는다. 외부 Agent wire/writer 보강과 GPU/Windows/macOS/native 수용은 남은 일로 유지한다. 헌장 F01 우선에 따라 process-status 대신 이 ledger에 세션 상태를 기록한다.


### 오프라인 인수 도구 사용법

Node와 Python 3 표준 라이브러리만 필요하다. `node scripts/b2c-package-audit.mjs /absolute/path/intake.json > /absolute/path/audit.json`을 실행한다. 입력·영수증·권리 증빙은 실행 폴더 tmp에만 두고 제품 자격/키는 넣지 않는다. 상대 파일 경로는 intake.json 위치 기준이다. 결과가 false면 exit 1이다. JSON 출력은 검사 결과이며 installer receipt를 생성하지 않는다.

```json
{
  "appId": "land.naia.charcard",
  "version": "0.1.0",
  "archive": "received.zip",
  "receipt": "received-store-receipt.json",
  "expectedPermissions": [],
  "rights": [
    {
      "path": "received-license.txt",
      "sha256": "수령한 증빙 파일의 실제 SHA-256 64자리",
      "covers": ["app.json", "index.html", "assets/실제파일명.js"]
    }
  ]
}
```

`covers`는 예시이며 실제 ZIP의 모든 파일을 개별 나열해야 한다. 여러 권리 증빙을 사용할 수 있다. 권리자의 허락 문서를 임의 작성하거나 creator_notes·저장소 전체 LICENSE를 모든 음성/영상의 배포 허락으로 추측하지 않는다. Store 영수증 형식은 Rust와 같은 `{app_id,sha256,signature}`이며 `signature`는 `ed25519:<base64>`다. 보유자가 전달한 실제 파일을 사용한다. CLI는 Rust의 배포 공개 키만 신뢰하고 키 override 옵션을 제공하지 않는다. 별도 키로 빌드한 native installer, entitlement 유효성·상품 공개 자격·실제 렌더링/청취는 이 검사 결과로 대체하지 않는다.

재현 시험: `TMPDIR=/실행폴더/tmp node --test scripts/b2c-package-audit.test.mjs`. 시험은 임시 키를 메모리에서 생성하며 private key를 파일로 저장하지 않는다. 시험 키로 서명한 묶음은 CLI에서 거절되는 것도 확인한다.


### 5회차 P04·P05 판정

- **오프라인 인수 도구 slice Done / 실제 signed 상품 인수 Pending.** `scripts/b2c-package-audit.test.mjs` 최종12/12 통과(`tmp/r5-audit-tests-complete.log`). 실제 ZIP·Ed25519 digest 검증, 다른 키/ID/변조/hex 문자열 서명 거절, 유효하게 다시 서명한 CRC 손상 ZIP 거절, 권리 누락·빈 증빙·변조·coverage, unsafe/중복/대소문자/링크/파일-디렉터리 충돌·상한·CLI 실패 포함. 시험 키는 메모리에서만 생성하고 CLI에서 거절한다.
- 실제 r4 #792 ZIP sha256 `78af70ea61e92e4b6eb34a200bf3dddc93ce7ec82f6297b3f3574023feb91a83`,9개 파일 hash가 r4 기록과 일치한다. `tmp/r5-charcard-audit.json`은 서명/권리 누락으로false/exit1. `tmp/r5-consumer-811-audit.json`은 실제 소비 상품 미제공을 누락 파일/서명/권리로 기록한 placeholder 입력이며 실제 상품 ID/버전 판정이 아니다. 상품·무료 NVA 영상/목소리 배포 허락을 임의 생성하지 않았다.
- 전체 Shell **2663 통과·21 제외/실패0**,253파일 통과/1제외(`tmp/r5-full-final.log`). 초기 전체2661/2fail/21skip은 기존 deeplink2개를 찾지 못한 실패였고 분리8/8, 최종 전체도 통과. 초기 compile-integrity core emit 중첩 사실과 실패 로그(`tmp/r5-baseline-shell.log`)를 보존한다. 집중30/30(`tmp/r5-focused.log`).
- 전체 Shell 타입 검사에서 기존 R4 fixture의 `PROVIDER_ERROR`가 실제 wire union에 없어 실패했다(`tmp/r5-shell-tsc.log`). fixture1곳을 `PROVIDER_NETWORK`로 정렬한 뒤 같은 ko/en 원시 예외 차단·전체 타입 검사가 통과했다(`tmp/r5-shell-tsc-final.log`). 제품 UI/Rust 동작 변경 없음.
- core·Shell 전체·BGM·지정 Agent 원본 전체 tsconfig 모두 통과. Agent a4aef165 git archive를 실행 tmp에 복사해 기존 실제 dependency 선언으로 --noEmit 검사했으며 외부 checkout에는 링크/소스도 쓰지 않았다(`tmp/r5-agent-tsc.log`). 해당 dependency 선언은 r2의 memory008eac79/kb403edb02이며 설치판의 exact memory pin 수용과 구분한다. assembly·file-anchor·trace·logging·compile-integrity 통과. root whitelist 기존2건, C region 비어 있음/TS core oracle 범위는 유지. 헌장/process-status 변경 없음.
- 실제 signed 상품·라이선스/entitlement 자료·native 도구 및 Windows/macOS/GPU 실기 수용은 미완료. appName Agent 영속 계약 FAIL도 유지. 운영/컨테이너 접속·다른 작업자 폴더 수정·pin 우회·원격 push 없음. 11/4~11/9 남은 일 및 단계/기대 결과 기기 목록은 실행 폴더의 이번 result.md에 기록한다. 이번에 실제 모델/TTS/시각 검토를 다시 실행한 것으로 주장하지 않는다.

## 6회차 설계 — 11/5 appName 준비·11/6 #743 서버 판정
P01/P02/P03: UC-B2C-026-R6 / FR-B2C-026-R6. Agent 읽기 전용 HEAD 681a775에는 appName 필드가 없다. proto optional string app_name 추가 및 wire/handler/writer 완료 커밋 전 pin 유지. Shell 경로 ChatArea → chat-service/core chat_request.appName → agent_grpc::try_json_to_chat_request → ChatRequest.app_name → Agent append 단일 writer를 사용한다. 이후 Rust ChatRequest initializer에 `app_name: s("appName"),`를 추가한다. 일반 턴은 None, 앱 턴만 Some; systemPrompt나 messages 본문에 태그를 삽입하지 않는다. 필드 번호는 Agent 소유 계약 확정 후 결정. build.rs의 exact commit/proto SHA, agent-pairing.json, marker·drift 시험을 한 묶음 갱신하고 native JSONL 재시작을 검증해야 한다. 현재 proto에 없는 필드를 넣어 빌드를 깨거나 unknown field 우회하지 않는다.
#743 도구는 ffprobe/ffmpeg를 timeout/maxBuffer로 제한하고 원본에 쓰지 않는다. 전체 프레임 decode 실패를 거절하며 첫 프레임 rgba의 alpha 또는 stacked 하단 회색 mask 범위를 기록한다. alpha는 혼합 alpha가 필요하다. stacked는 실제 플레이어 합성 검증이 아니며 opaque/chroma 합성·GPU 품질은 기기 목록으로 남긴다. 실패 보존은 외부에서 수집한 전후 설정 snapshot 두 파일이 실제로 동일한지만 증명한다. fixture는 실제 상품이 아니다.

### 6회차 사용법·Rust 전달 초안

`node scripts/b2c-media-audit.mjs /절대경로/input.json`. 입력 예: `{"file":"alpha.webm","mode":"alpha","codec":"vp9","expected":"success"}`. mode는 alpha/stacked/opaque. codec은 선택적인 정확 비교다. chroma는 opaque의 decode 확인까지만 가능하며 key 합성은 기기 수용에 남는다. 실패 입력: `{"file":"broken.mp4","mode":"alpha","expected":"decode-failure","before":"before.json","after":"after.json"}`. 경로는 입력 파일 기준. 모든 입력은 로컬 신뢰 자료만 사용한다. 결과 passed/exit0은 지정한 서버 검사만 통과이며 nativeAcceptance는 항상 false다. snapshot은 실패 실험에서 외부 수집한 실제 파일을 제공해야 하며 도구가 UI 행동을 실행하거나 snapshot 출처를 인증하지 않는다. 입력 미제공/누락/제한시간·실행 오류는 실패 증거로 인정하지 않는다. 전체 디코드는 30초, 50MiB/4096² 크기 제한이다. 긴 실제 자산의 제한 초과는 수용 보류다. 첫 프레임 표본은 모든 프레임 합성 품질을 보장하지 않는다.

계약 초안 적용 위치 `packages/shell/src-tauri/src/agent_grpc.rs`의 `try_json_to_chat_request`:

```diff
     Ok(ChatRequest {
         request_id: s("requestId").unwrap_or_default(),
         session_id: s("sessionId"),
+        app_name: s("appName"),
         messages,
```

위 diff는 proto 필드 확정 후 적용하는 초안이다. Rust 시험에 appName 있음/없음/다국어 이름 roundtrip, 일반 턴 None을 추가하고 Agent writer 실제 JSONL 두 행 및 별도 프로세스 재시작에서 동일 이름을 확인한다. paired proto 원본에 필드가 없으므로 현재 소스에는 적용하지 않았다. pin 준비 목록: Agent 완료 clean commit + LF-normalized proto SHA256 + exact memory pin, build.rs REQUIRED_AGENT_COMMIT/REQUIRED_PROTO_SHA256/REQUIRED_PROTO_MARKERS, packages/shell/agent-pairing.json, src/test/agent-pairing-drift.contract.test.ts. 이전 pin의 일부만 갱신하지 않는다.

추적 중 추가 확인: 현재 appName은 ChatArea의 addMessage/startStreaming과 reader에만 있다. sendChatMessage 호출·SendChatOptions·core ShellSendOptions·ChatRequest domain에는 아직 전달 필드가 없다. 따라서 위 Rust 한 줄만으로 전달 완료가 아니다. 계약 확정 후 함께 적용할 셸 초안은 다음과 같다.

- ChatArea `sendChatMessage({ ... })`: `...(appName !== undefined ? { appName } : {})`. 앱 이름은 기존 활성 앱/installedAppTurn 검증 결과에서만 가져온다.
- `packages/shell/src/lib/chat-service.ts` SendChatOptions 및 `src/main/adapters/shell-compat.ts` ShellSendOptions, `src/main/adapters/chat-bridge.ts` 입력, `src/main/domain/chat.ts` ChatRequest에 `appName?: string` 추가. 각 sessionId 전달 지점과 동일하게 appName도 조건부 전달한다. legacy request와 new-core 양쪽을 시험한다.
- core 직렬화가 구조 분해/재구성할 때 metadata를 잃지 않는지 IPC 최종 wire 캡처로 확인한다. 이름은 모델 프롬프트가 아닌 writer 메타데이터이며 일반 history 제외는 기존 reader 정책을 유지한다.
- 필수 회귀: 앱 이름 다국어/없음, 활성 앱→일반 대화 전환 때 이전 이름 유출0, native 카드 소유권 우선, 앱 context1개, appName과 requestId가 같은 턴임을 ChatArea→core→Rust→Agent JSONL 전 경로에서 확인. 현재 준비 상태는 Draft이며 전달/영속 성공으로 표시하지 않는다.

6회차 중 Agent 소유 작업의 uncommitted 초안이 생긴 것을 읽기 전용 확인했다: `ChatRequest.app_name = 16`, `Message.app_name = 5`, domain/writer appName. 완료 커밋은 여전히 없으므로 필드 번호도 확정 계약으로 보지 않으며 pin을 유지한다. Rust Message initializer에도 `app_name: m.get("appName").and_then(|x| x.as_str()).map(str::to_string),` 추가가 필요하다. Message 필드가 생긴 계약에서는 ChatRequest뿐 아니라 Message 모든 initializer를 점검해야 한다.

### 6회차 계약 확정 후 구현 (P01~P03 확장)
작업 중 appName 계약 Agent clean 완료 커밋이 생겼다(현재 후속 짝은 ecb879b080aa7e9bff7402687478dc16bdc6c49f; 당시 시험 판은 실행 폴더 result-r6.md 참조). 위 초안 단계 기록을 보존하되 이제 필드16/5 계약으로 Shell TS→Rust 전달과 exact pin 묶음을 구현한다. P02: 앱 기본/빈history/진행/성공/오류/360px는 기존 installed-app 및 character-theme Playwright 회귀, 추가 wire capture/ChatArea 요청 assertions, Rust JSON→proto unit tests. native는 사용자 지시대로 이 서버 미지원 기기 목록으로 남기며 완료로 주장하지 않는다.

### 6회차 서버 검증 중 발견
당시 Agent archive 전체 tsconfig 빌드와 grpc codec/handler/writer 계약14/14, 별도 프로세스 실제 JSONL writer/read에서 앱 user/assistant 두 행의 appName 보존·일반 턴 태그 없음 확인(`tmp/r6-agent-contracts.log`, `tmp/r6-transcript-restart.json`). Shell seam·pin26/26, Shell ChatArea/legacy59/59. resolver는 당시 clean Agent 선택. Rust unit test는 추가했으나 cargo/rustc/tauri-driver/WebKitWebDriver 부재로 미실행이며 native 수용 Pending이다.
Playwright의 기존360px 실패 주입이 비동기 일반 설정 writer에 소비되는 것을 오류 컨텍스트에서 확인했다(전역 Could not save settings vs 테마 alert 없음). 테마 후보의 nvaModel/ttsVoice를 지정해 모든 해당 쓰기만 실패시키고 rollback 이전값은 허용하는 fixture로 보강했다. 직접 주입한 이전 배경은 현재 UI와 같은 garden.png로 일치시켰다. 캐시 전체 문자열 비교는 빈 자격 필드 제거/BGM runtime 키 변경까지 포함해 오탐하므로 모델·페르소나·아바타·목소리·배경·카드 라이브러리를 구조적으로 비교한다. 실제 파일 전체 바이트 비교는 media-audit snapshot 도구에서 별도로 엄격 유지한다. 이전 실패 로그 `tmp/r6-playwright-final.log`, `tmp/r6-playwright-recheck.log` 보존.

후속 fixture 정정: agent config/UI config는 분리 저장되어 agent config JSON에는 nvaModel/ttsVoice가 없다. 후보 필드로 agent config 쓰기를 고르는 시도는 실패 주입이 되지 않아 거절 시험이 실패했다(`tmp/r6-playwright-fixed-final.log`). 최종 fixture는 `__denyConfigWrites` 동안 모든 write_naia_config를 거절해 다른 writer가 단발 플래그를 소비하지 못하게 한다. rollback 파일 쓰기도 같은 장애 동안 거절되며, 이 경우 로컬 설정 복구·오류/재시도를 검사하는 범위다. native 파일 원자성/복구쓰기 성공 증거와 구분한다.

최종 browser P04: 수정 fixture와 실제 browser sendChatMessage→IPC appName 캡처를 포함한1100/360px **2/2 통과**, `tmp/r6-playwright-verified.log` 및 `tmp/r6-playwright-verified/`. verify-visual-ux: 기본/빈 목록·import 진행 잠금·성공·decode/쓰기 오류·재시도·Enter·컨트롤 경계를 실제 DOM으로 확인했다.1100px와360px screenshot을 직접 열어 카드 import→preview→Apply, 다음 NVA themes 위계·가로 잘림 없음 확인. browser 범위 수용이며 Rust/native 전체 시각·UX 게이트는 Pending이다. 초기 baseline 화면2/2와 중간 실패를 최종 증거로 대체해 숨기지 않는다.
P05: 도구 slice Done, appName 전달/pin 서버 slice 구현. native 저장/재시작·실제 모델/청취·WebView alpha/stacked/chroma·GPU 수용 및 signed 실제 상품/권리 인수는 미완료.

최종 변경 후 Shell 전체 **2663 통과/21 제외/실패0**,253파일 통과/1제외,342.38초(`tmp/r6-shell-after.log`). core UC1/wire108/108·별도pin drift6/6·Shell 집중59/59·Agent 계약14/14·도구13/13. core/Shell/BGM/새Agent 전체 타입 빌드와 compile-integrity·assembly·file-anchor·UC trace·logging 통과. root whitelist 기존2건/빈 C regions·TS core oracle 범위는 유지. 헌장 수정·운영 접근·외부 checkout 수정·원격push 없음.

## 7회차 설계/P01~P03
UC-B2C-026-R7 / FR-B2C-026-R7. process-status는 F01 헌장 명시 승인 부재로 수정하지 않고 이 ledger에 세션 상태를 남긴다. 가장 먼저 배포 판0.2.6 정렬. 11/4 실제 signed 자산은 여전히 자격/자료가 없어 진행 불가. 11/7 서버 회귀와 당시 AX host adapter 초안을 진행한다. host object capability는 wire로 보내지 않으며 인증 RPC를 임의로 추가하지 않는다. UI는 독립 초안 컴포넌트+host port 시험이고 앱에 활성화하지 않는다. 준 안내문만 존재.

### 7회차 구현·서버 검증
- 배포 metadata: root/Shell package.json, Tauri explicit version, Cargo.toml 및 lock의 naia-shell만0.2.6. 제3자 Cargo 의존성0.2.4/0.2.5는 그대로이며 과거 release 문서는 이력이다. CI installer는 Shell package.version을 읽는다. 태그/게시 없음.
- `lib/ax-approval-adapter.ts`는 당시 Agent host-only object port를 받는다. 표시 전/ACK 실패/위조 evidence/이전 proposal/단회 재전송을 거절하며 invalidation/disposal을 노출한다. 로그에는 mode/boolean만, 코드·preview·입력·토큰은 기록하지 않는다. 반환 false도 chat으로 보내지 않는다.
- `components/AxApprovalDraft.tsx`는 이 port를 받는 독립 승인 화면 초안이다. 일반 PermissionModal/always grant/approval_response를 재사용하지 않는다. 실제 앱 composition에 활성화하지 않았다. 인증된 RPC·표시 ACK roundtrip·input provenance는 Agent와 별도 계약이 필요하다. host는 새 의도·내용/설정/scope 변경 전에 invalidate, disconnect/종료에 dispose해야 한다. code는 host 별도 전달 경로이며 화면 props/로그/저장소에 코드가 없다.
- 화면은 payload를 React text로 출력하며 입력은 로컬 state에만 유지한다. Agent 대화 승인 고정 입력 ‘보내’를 한/영 모두 안내한다. 빈 화면→review→입력→단회 전달, 거절/미인증의 alert와 재입력·취소, 새 요청 안내를 구분한다.
- 집중 회귀174/8skip, ADK/취소/기존 첫 인사/adapter104/104, 최종 변경부86/86, 판/pin7/7. 브라우저 카드·테마1100/360px2/2, AX 한/영×1100/360px4/4. 당시 실제 Agent archive broker+셸 adapter8/8: approve/reject/cancel/scope/dispose/code/wrong-code/untrusted. 이 시험은 메모리 내 실제 실행 경계이며 외부 전송은 fixture executor로 대체한다. authenticated RPC/native 시험이 아니다.
- 새 ADK 시험은 pending/rejected rebind 동안 카드 원본 base64·확장·테마·locale·이전 workspace의 exact localStorage bytes를 비교한다. 기존 locale 동시변경/쓰기 실패/Agent reload 실패와 greeting replace/unmount·모델교체 회귀를 재실행했다. 브라우저 reload는 mock 파일 저장소 복원이며 native 파일 영속성으로 승격하지 않는다.
- 최초 전체 호출은 root cwd 때문에 잘못된 config를 읽어 중단했다. 올바른 Shell cwd 첫 전체2672pass/1fail/21skip(370초): cold lazy markdown 원문 fallback이 기본1초 안에 버튼으로 바뀌지 않았다. 실패 DOM/로그를 확인하고 최초 버튼 대기5초 및 누락 fetchAgentSkills mock을 추가했다. 분리8/8. 전체 재검증은 별도 로그 r7-shell-verified.log에 기록한다.
- core/Shell/BGM/paired Agent 전체 tsc, compile-integrity, assembly, file-anchor, UC trace, logging 통과. production build2808 modules·entry492113/gzip154861 bytes로 budget 통과. 새 AX 초안은 미활성이라 출시 entry에 포함되지 않는다.
- root 구조 dry-run은 기존 test-results/·tracked tmp/·tsconfig.build.json3건이다. 자동 삭제나 헌장 변경 없음. C manifest regions는 비어 있고 TS core file oracle70개는 활성; Shell 전체 파일 계약 미검출 범위는 남아 있다. 이를 전역 conform 완료로 주장하지 않는다.

7회차 AX lifecycle 보강: React StrictMode의 mount-effect replay를 실제 browser fixture에 켰다. 로컬 capture/ref는 cleanup에서 즉시 폐기하고 host invalidation만 같은 host의 재mount 여부를 microtask로 확인한다. host 교체는 이전 host를 invalidate한다. 사용자 취소/scope 변경 invalidate는 동기 호출이며 disconnect dispose는 composition 소유다. 최초 표시 ACK를 StrictMode cleanup이 잘못 무효화하지 않으며 unmount 후 입력·권한이 남지 않는 browser4/4(`tmp/r7-ax-lifecycle.log`).

7회차 P04/P05 최종: Shell 전체 재실행 **2673pass/21skip/실패0**,254파일pass/1skip,291.52초(`tmp/r7-shell-verified.log`). AX 최종 StrictMode 한/영×1100/360px4/4(`tmp/r7-ax-final-verified.log`), 취소 후 오래된 입력 오류 안내 제거도 단언. 최종360px screenshot을 직접 열어 payload/승인 입력/취소·새 요청 안내의 순서·줄바꿈과 잘림 없음을 검토했다. browser slice PASS이며 authenticated AX RPC/native 수용은 Pending. metadata·서버 회귀·adapter 초안 Done, 실제 상품/기기/게시 전체 수용은 Pending 유지.

## 8회차 시작/P01~P03
직전 result.md를 result-r7.md로 보존. 4060 옛 빌드41654453352/2d7794b 실기 step4.jsonl에서300ms 입력 뒤 user행0,2500ms에는user행1 확인. UC/FR-B2C-026-R8로 재현/수정한다. 11/4 signed 실제 상품/권리 자료 미제공은 계속 보류. process-status.json은 사용자 헌장 불변 지시로 변경하지 않고 이 ledger에 상태 기록. 기존 core file oracle 활성·C regions 비어 있음·Shell 전체 미계약 탐지 갭은 그대로 기록하며 전역 완료 주장 안 함.

### 8회차 구현·검증/P04~P05
- 설정 Center의 초점 초기화·lazy load 후 첫 입력 이동·Tab/역Tab 순환·Esc 닫기/설정 단추 복귀. 비활성 keepAlive slot은 inert/aria-hidden/visibility:hidden으로 DOM 초점과 페인트에서 제외하되 lifecycle은 유지한다. 360px textarea의 기본 최소너비를0으로 내려 보내기 단추를 보장한다.
- 카드 적용은 설정 저장 직전 characterTransitionPending을 켜고, 새 대화 이벤트 처리 후 finally 해제한다. pending 중 Enter는 입력을 비우지 않고 상태 안내/보내기 잠금, 준비 완료 후 재전송 가능. 명령 분류 await 사이 카드/세션이 바뀌어도 입력을 유지한다. 기존 greeting generation/session/messages guard도300ms 실제 browser 전송으로 검증한다.
- 보관함은 sourceBase64 원본 바이트를 정확 비교한다(동일hash 원본을 충돌 없이 동일시, 파일명 제외). 재import는 기존ID를 사용하고 해당 원본의 기존 중복들을 합친 뒤30장/2MB를 판단한다. 새로 불러온 같은 카드의 theme 연결은 보존하고, 현재 카드에서 사용자가 명시 해제하면 해제를 존중한다. 이름만 같은 다른 원본은 별도 카드다. 저장된 모든 과거 중복을 부팅만으로 migration하지는 않는다.
- 빈/공백 사용자 이름은14개 locale의 speechStyleNoName 문장을 사용한다. 준비 상태 문구도14개 locale에 추가했다.
- red: 설정1100/360 모두 초점 이동 실패, 카드 pending Enter 입력 보존 실패. 새 병합 함수 전 단위시험도 실패. 이름 시험 초안은 Wizard 단독에 없는 chat DOM을 찾는 실수가 있어 실제 ChatStore에 기록된 문장을 단언하도록 고쳤고 locale 변경으로 다른 시험을 오염시키던 시도도 제거했다. 최종 회귀51pass/1skip.
- Shell 전체 최종2678pass/21skip/실패0,254파일pass/1skip (`tmp/r8-shell-final.log`). 중간 before 호출은 수정 전 모듈을 포함해5fail/2673pass/21skip이며 최종과 구분한다.
- browser 최초1100/3602/2, 추가300ms 포함 회귀에서1회 theme snapshot 불일치: 캐시만 바꾼 시험 준비가 이전 file writer 재hydration과 경쟁. 실제 writeNaiaConfigAtPath로 파일·캐시를 순서대로 준비한 뒤2/2 (`tmp/r8-browser-verified.log`). 마지막 visibility/inert assertion 및 screenshot은 `tmp/r8-browser-last.log`/`tmp/r8-browser-last/`.
- core/Shell/BGM/당시 paired Agent archive tsc, compile-integrity, assembly/file-anchor/UC trace/logging, production build/budget 검사. core 전체 추가 호출은 실제 환경/live terminal/CDP·짝 checkout 표본9fail/1692pass/15skip이며 Shell 전체 통과와 혼동하지 않는다. 생성된 benchmark/.attest 출력은 원복했다.
- native preflight: cargo/rustc/tauri-driver/WebKitWebDriver 없음. 사용자 지시대로 Windows/macOS/GPU·signed 실제 상품은 기기 확인 목록/인수 대기. 다른 작업자 checkout 변경·운영 접속·게시·push 없음. process-status 헌장 파일은 변경하지 않았다. 구조 기존3건 위반 및 Shell 전역 file-anchor 미포함/C regions 빈 상태는 그대로이며 전역 gate 통과로 주장하지 않는다.

8회차 종료 검증: 마지막 browser1100/360px2/2(58.2초), `tmp/r8-browser-last.log`. 360px의 닫힌 설정 잔상 없음·입력칸/보내기 노출·300ms 전송 user 행 보존 screenshot을 직접 열어 검토했다. 기본/빈 목록/진행 잠금/성공/오류 재시도/좁은 폭 및 Tab140회·역Tab·Enter·Esc·비활성slot inert/visibility를 DOM으로 확인했다. 실제 GPU/청취/native UI는 사용자 지시대로 기기 확인 Pending. 최종 build/budget도 `tmp/r8-build-last.log` PASS. P05 서버 수정 Done.

## 9회차 — 메모 데이터 홈 수정 Agent 짝 (P01~P04)
현재 pin: ecb879b080aa7e9bff7402687478dc16bdc6c49f. 6~8회차 시험은 당시 판의 이력이며 이번 판의 증거로 바꾸어 해석하지 않는다. UC-B2C-026-R9 / FR-B2C-026-R9. manifest·Rust 상수·양 CI·README·marker를 함께 갱신한다. proto SHA와 memory pin은 변경 없음. 다른 기능 변경 없음. process-status.json은 헌장 명시 승인 부재로 수정하지 않고 본 ledger에 세션 현황을 기록한다. 기존 root 구조 위반·빈 C conform regions와 Shell 파일 계약 탐지 갭은 범위 밖으로 기록한다.

9회차 P04/P05 Done (서버 짝 갱신): 짝/wire17/17, 준비/플랫폼77/77, 새 Agent memo15/15·appName23/23·AX 정책99/99. 셸 전체254파일통과/1제외,2678시험통과/21제외/실패0(176.63초), 실행 폴더 tmp/r9-shell-full.log. core/Shell/BGM/새 Agent 전체 타입 및 compile-integrity·assembly·core70파일anchor 통과. 격리 clean clone의 exact HEAD/proto를 실제 resolver로 검증(tmp/r9-resolver.json). 초기 node_modules symlink untracked 거절은 격리 clone git info/exclude만 보완해 해소. 저장소 옛 짝 해시 잔존0. 새 Agent 사이 변경 중 AX 정책도 계약99개로 확인했으며 Shell 기능 활성화/변경은 없음. Windows/macOS/GPU/installer/실자산 인수는 Pending.

## 10회차 — ADK 복원 수명·AX host 장애 (2026-11-03)

UC/FR-B2C-026-R10. 시작 HEAD864f1356, 직전 result-r9 보존. process-status는 사용자 헌장 불변 지시로 변경하지 않는다. 11/4 실제 signed 상품/무료 NVA/권리자료는 미제공이다.

ADK restore는 파일 읽기를 기다리는 동안 binding이 바뀌거나 더 최신 restore가 완료되어도 이전 결과를 썼다. binding 세대·restore 순서·현재 path를 commit 직전 대조해 폐기한다. A→B뿐 아니라 A→B→A, 같은 path의 최신 restore, 캐시 유실 뒤 두 workspace의 원본 카드/확장/테마 복원과 읽기 실패 보존 회귀를 추가했다. UI/IPC/Rust 계약 변경은 없다.

AX adapter는 host displayed/beginInput/submit 예외를 false로 소비하고 invalidate/dispose 예외에도 로컬 입력을 폐기한다. 예외 원문/승인 입력을 로그·대화로 보내지 않는다. 실제 paired Agent ecb879b broker와 셸 adapter 연결8/8은 실행 폴더 tmp/r10-ax-real-agent.mjs/log/json에 남긴다. 외부 effect executor는 fixture다. Agent 작업 트리의 미커밋 변경은 읽기만 하고 pin에 반영하지 않았다.

**활성화 차단 근거**: Agent docs/ARCHITECTURE.md §7.12는 trusted backend가 Agent 프로세스 안에 control lane을 만들고 executor를 codex-ax에 주입하도록 요구한다. 객체 token을 wire로 보내거나 renderer에서 받는 것은 금지한다. paired proto에는 해당 host 채널이 없고 공용 composition도 opt-in factory만 있다. 셸의 별도 Rust 프로세스/renderer만으로 해당 객체를 호출할 수 없다. 따라서 앱 승인 화면의 실제 활성화는 완료하지 않았다. 필요한 인계는 Agent backend composition(연결별 lane/executor·scope lifecycle) + 전용 인증 host transport(렌더 ACK·입력 시작 provenance·backend token 보관·종료 시 dispose)다. 일반 approval_response/chat로 우회하지 않는다.

P04 중간: 집중87/87, 실제 Agent broker8/8, UC trace 새 단절0(R9 누락 표 행도 보완), logging PASS. 기존 root3건/C regions 빈 상태/Shell 파일단위 oracle 갭은 유지되며 전역 구조 완료를 주장하지 않는다. 최종 전체/브라우저/타입 결과는 아래 추가한다.

P04/P05: 최종 집중88/88(tmp/r10-focused-final.log), 실제 Agent8/8, AX browser4/4·카드1100px 통과. 카드360px 최초 실행은 전체60초 제한에서 실패했으며 DOM은 reload 뒤 카드 option2개였다. 같은 assertion을 유지한120초 분리 재실행은50.5초 통과(tmp/r10-browser-recheck.log); 최초 실패를 삭제하지 않는다. core/Shell 타입·compile integrity·anchors·logging·UC trace 통과. UI 자체 변경은 없고 기존 browser 회귀로 수용 경계를 확인했다. 새 paired installer41697964598 실기 결과는 준 폴더에 없었다. 서버 slice Done, 실제 앱 AX 연결 및 native/자산/기기 수용 Pending.

전체 회귀 중 FileTree open-file reveal 1건 실패가 나와 분리 재실행에서도1fail/3pass였다. 시작 HEAD864f1356의 git archive를 실행 tmp/r10-baseline에 풀어 같은 시험을 실행해 동일1fail/3pass 재현(tmp/r10-file-tree-baseline.log). 이번 수정의 회귀가 아닌 기존 실패로 분리하며 파일 트리 코드는 변경하지 않았다.

10회차 최종 전체: **2687pass/1fail/21skip**,253파일pass/1fail/1skip,596.31초(tmp/r10-shell-full.log). 실패는 위 시작HEAD에서도 재현된 FileTree1건이다. baseline2678에서 신규 회귀10개 포함 전체2709개가 실행됐다. 전체 green이라고 쓰지 않는다. TMPDIR를 실행 tmp로 지정한 최종 집중88/88도 통과(tmp/r10-focused-tmpdir.log). 초기 시험은 TMPDIR를 빠뜨려 라이브러리 내부 임시 경로가 OS 기본값이었을 수 있다는 예외를 결과에 기록한다. 코드/문서 서버slice Done, AX 실제 앱 연결·기기/자산 수용 Pending.
