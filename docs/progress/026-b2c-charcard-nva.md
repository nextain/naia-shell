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
