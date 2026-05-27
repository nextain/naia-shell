<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->
<!-- `.agents/context/e2e-scenarios.yaml` 의 한국어 미러 — 같이 갱신. -->

# E2E 테스트 시나리오

naia-os e2e 커버리지의 정본: 어떤 spec이 있고, 무엇을 검증하고, 무엇이 빠져있는지. `.agents/context/e2e-scenarios.yaml` 의 YAML 매니페스트와 1:1 매핑.

분류: setup · llm · skills · ui · channels · voice · memory · infra · e2e-meta

## 기존 spec

위치: `shell/e2e-tauri/specs/`. 2026-05-27 기준 30개 (29개 + #328 에서 추가한 24-adk-setup).

| ID | Spec | 기능 | 상태 |
|----|------|---------|:---:|
| S001 | `01-app-launch` | 앱 실행 + Tauri webview 기준선 | ✓ |
| S002 | `02-configure` | Settings 탭 초기 구성 | ✓ |
| S003 | `03-basic-chat` | 단일 턴 채팅 | ✓ |
| S004 | `04-skill-time` | Skill: 시간 | ✗ (LLM이 잘못된 tool 선택; #332 제안 참조) |
| S005 | `05-skill-system` | Skill: 시스템 상태 | ✓ |
| S006 | `06-skill-memo` | Skill: 메모 | ✓ |
| S007 | `07-cleanup` | 초기화 / 세션 정리 | ✓ |
| S008 | `08-memory` | 메모리: 기록/회상 (SQLite v6) | ✓ |
| S009 | `09-onboarding` | 온보딩 마법사 | ✓ |
| S010 | `10-history-tab` | 히스토리 탭 | ✗ (#320 OPEN) |
| S011 | `11-cost-dashboard` | 비용 대시보드 | ✓ |
| S012 | `12-skills-gateway` | 게이트웨이 스킬 | ✓ |
| S013 | `13-lab-login` | Lab 로그인 (OAuth 딥링크) | ✓ |
| S014 | `14-skills-tab` | 스킬 탭 UI | ✓ |
| S015 | `15-skill-manager-ai` | AI 주도 skill_manager | ✓ |
| S016 | `16-skill-weather` | Skill: 날씨 | ✓ |
| S017 | `17-skill-notify` | Skill: 알림 (Slack/Discord) | ✓ |
| S018 | `18-provider-tool-calling` | 프로바이더 tool-calling 매트릭스 | ✓ (nextain 경로는 #329로 차단) |
| S019 | `19-skills-bulk` | 스킬 일괄 작업 | ✓ |
| S020 | `20-cron-basic` | Cron: 일회성 | ✓ |
| S021 | `21-cron-recurring` | Cron: 반복 | ✓ |
| S022 | `22-channels-config` | 채널 구성 | ✓ |
| S023 | `23-channels-status` | 채널 상태 | ✓ |
| S024a | `24-adk-setup-flow` | ADK 셋업 플로우 (#324/#325/#327) | ✗ (#328 webview cycle) |
| S024b | `24-tts-providers` | TTS 프로바이더 | ✓ |
| S025 | `25-voice-wake` | 보이스 wake (porcupine) | ✓ |
| S026 | `26-sessions-management` | 세션 CRUD | ✓ |
| S027 | `27-multi-agent` | 멀티 에이전트 오케스트레이션 | ✓ |
| S028 | `28-skills-install` | 마켓플레이스 스킬 설치 | ✓ |
| S029 | `29-cron-gateway` | Cron 게이트웨이 (cloud) | ✓ |

## 제안된 새 시나리오 (2026-05-27 감사 + #329 발견 기반)

| ID | 기능 | 근거 |
|----|---------|-----------|
| S101 | 멀티턴 채팅 (N 턴 컨텍스트 유지) | S003은 단일 턴만 |
| S102 | 프로바이더 전환 시 secure-store 위생 | #329 root cause 직접 fix surface |
| S103 | OAuth 콜백 경로 커버 (딥링크 → secure store) | e2e가 prod OAuth 우회 |
| S104 | 결정론적 LLM 프롬프트로 skill_time end-to-end | S004 fix — tool 리스트 제한 / 시스템 프롬프트 강화 |
| S105 | 앱 재시작 간 메모 영속성 | S006은 동일 세션만 |
| S106 | Ebbinghaus 망각이 오래된 메모리를 down-rank 검증 | spec 97 placeholder (proposed-blocked); CLI 메모리 경로가 사용하는 LiteMemoryProvider는 decay 랭킹/clock 주입 모두 없음 — Phase 4 `advance_clock` IPC가 의미를 가지려면 naia-memory 상류 변경 선행 필요 |
| S107 | 비용 대시보드 fetch 실패 시 우아한 UX | S011은 정상 경로만 |
| S108 | 일시적 webhook 429에 notify skill 재시도 | S017은 단발 POST만 |
| S109 | Voice clone (ElevenLabs voice ID) | S024b는 프로바이더 전환만 |
| S110 | Browser 패널 — naia.nextain.io 탭 임베드 | skill_browser_* 존재하나 panel UI 커버 없음 |
| S111 | 메모리 백업 export/import 라운드트립 (AES-256-GCM) | spec 96 추가; memory_export_backup/memory_import_backup IPC 직접 구동. UI 재활성화는 #327 후속작업으로 지연. |
| S113 | 게이트웨이 임베딩 5xx 시 오프라인 ONNX 폴백 | spec 95 추가; 런타임 폴백 배선은 Phase 4로 지연 |

## 교차 참조

- 교훈: `.agents/context/lessons-learned.yaml` (L059가 #329 root cause 다룸)
- 열린 이슈: #320, #328, #329, #330, #331
- 사용자 매뉴얼: `.users/guides/manual/` (작성 중)

🤖 AI 보조로 작성. 이상한 부분 있으면 discussion 열어 알려주세요.
