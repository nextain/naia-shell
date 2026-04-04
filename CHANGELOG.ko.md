# 변경 이력

Naia OS의 주요 변경 사항을 기록합니다.
원본 데이터: [`releases/v*.yaml`](releases/)

[English](CHANGELOG.md)

---

## v0.1.4 (2026-04-04)

Alpha Memory System v1, 지식 그래프, 메모리 벤치마크

- **feat(agent)**: Alpha Memory System v1 — 4-스토어 아키텍처 (에피소드/의미/절차/작업기억) + Ebbinghaus 망각 곡선, Hebbian 연상, 통합(consolidation) 파이프라인 ([#145](https://github.com/nextain/naia-os/issues/145))
- **feat(agent)**: 지식 그래프(Knowledge Graph) 통합 — TF-IDF 인덱싱, Louvain 커뮤니티 탐지, 중심성 점수 ([#173](https://github.com/nextain/naia-os/issues/173))
- **feat(agent)**: 메모리 시스템 와이어링 — encode/recall/sessionRecall을 에이전트 대화 루프에 통합 ([#150](https://github.com/nextain/naia-os/issues/150))
- **feat(shell)**: 메모리 관리 UI — 설정 탭에서 팩트 목록 보기/삭제/전체 초기화 ([#174](https://github.com/nextain/naia-os/issues/174))
- **feat(agent)**: mem0 어댑터 — 로컬 JSON 대신 선택적으로 사용 가능한 클라우드 백엔드(mem0.ai) ([#148](https://github.com/nextain/naia-os/issues/148))
- **feat(agent)**: 임베딩 지원 — 메모리 recall을 위한 로컬/API 기반 벡터 유사도 검색 ([#149](https://github.com/nextain/naia-os/issues/149))
- **fix(agent)**: sessionRecall이 팩트와 함께 항상 에피소드도 반환하도록 수정 ([#151](https://github.com/nextain/naia-os/issues/151))
- **fix(agent)**: 빠른 팩트 추출을 위해 통합(consolidation) 임계값을 1시간에서 5분으로 단축 ([#151](https://github.com/nextain/naia-os/issues/151))

## v0.1.3 (2026-03-23)

워크스페이스 패널, 브라우저 패널, PTY 터미널, 프로바이더 레지스트리, 인스톨러 개선

- **feat(shell)**: 워크스페이스 패널 — 세션 대시보드, 파일 탐색기, 코드 에디터 ([#99](https://github.com/nextain/naia-os/issues/99))
- **feat(workspace)**: xterm.js 기반 PTY 터미널 탭 ([#119](https://github.com/nextain/naia-os/issues/119))
- **feat(workspace)**: 이미지·CSV·로그 파일 뷰어 및 채팅 딥링크 ([#116](https://github.com/nextain/naia-os/issues/116))
- **feat(workspace)**: 세션 대시보드 git 워크트리 그룹핑 ([#121](https://github.com/nextain/naia-os/issues/121))
- **feat(shell)**: 브라우저 패널 — Chrome X11 임베드, CDP 툴, 음성 툴, 테마 지원 ([#95](https://github.com/nextain/naia-os/issues/95))
- **feat(panels)**: 패널 통신을 위한 iframe 브릿지 및 NaiaContextBridge 확장 ([#122](https://github.com/nextain/naia-os/issues/122))
- **feat(shell)**: Panel API — panelRegistry를 통한 프로그래매틱 인터페이스 ([#118](https://github.com/nextain/naia-os/issues/118))
- **feat(shell)**: 설치된 패널 동적 iframe 렌더링 ([#89](https://github.com/nextain/naia-os/issues/89))
- **feat(shell)**: STT/TTS 프로바이더 레지스트리 (Web Speech API, Browser TTS 지원) ([#51](https://github.com/nextain/naia-os/issues/51))
- **feat(shell)**: vLLM STT/TTS 프로바이더 + STT 모델 선택기 + 오디오 장치 설정 ([#79](https://github.com/nextain/naia-os/issues/79))
- **feat(shell)**: 마이크 테스트 포함 오디오 입출력 장치 선택 ([#81](https://github.com/nextain/naia-os/issues/81))
- **fix(installer)**: GRUB USB 부팅 수정 — insmod iso9660 추가로 부팅 메뉴 미표시 해결
- **fix(browser)**: 브라우저 패널 keepAlive, 모달 타이밍, 툴바 오버플로우 수정 ([#102](https://github.com/nextain/naia-os/issues/102))

## v0.1.2 (2026-03-10)

인앱 자동 업데이트, 음성 프로바이더 리팩토링, 스킬/음성 버그 수정, CI 품질 게이트 및 OS 개선

- **feat(shell)**: 배너 알림 및 설정 버전 푸터가 포함된 인앱 업데이트 체커 ([#30](https://github.com/nextain/naia-os/issues/30))
- **feat(ci)**: Tauri 업데이터 서명, latest.json 생성 및 itch.io butler 자동 배포 ([#30](https://github.com/nextain/naia-os/issues/30))
- **feat(web)**: releases/*.yaml 기반 naia.nextain.io 다운로드 페이지 changelog 섹션 ([#30](https://github.com/nextain/naia-os/issues/30))
- **feat(voice)**: 라이브 대화를 프로바이더 패턴으로 추상화 (Gemini Live, OpenAI Realtime) ([#25](https://github.com/nextain/naia-os/issues/25))
- **fix(shell)**: 음성 대화 에코 억제 및 VRM 성별 기반 음성 기본값 추가 ([#22](https://github.com/nextain/naia-os/issues/22))
- **refactor(shell)**: 미사용 STT 코드 및 레거시 SettingsModal 제거 ([#25](https://github.com/nextain/naia-os/issues/25))
- **fix(agent)**: 비영어 환경에서 커스텀 스킬 탐색 실패 수정 ([#28](https://github.com/nextain/naia-os/issues/28))
- **fix(skills)**: 스킬 설치 피드백, 이벤트 릭, i18n 수정 및 20개 빌트인 스킬 동기화 ([#28](https://github.com/nextain/naia-os/issues/28))
- **refactor(agent)**: 시스템 프롬프트 파이프라인 중복 제거
- **feat(agent)**: Ollama 호스트 설정 지원
- **feat(shell)**: Shell-OpenClaw 간 양방향 메모리 동기화
- **fix(shell)**: AI 응답 언어가 로케일 설정을 따르도록 수정
- **feat(ci)**: CI 품질 게이트 (lint, typecheck, build-test) 및 Biome 적용 ([#12](https://github.com/nextain/naia-os/issues/12))
- **feat(ci)**: 파이프라인 체인: Release → Build OS → Generate ISO, 주간 자동 리빌드 ([#12](https://github.com/nextain/naia-os/issues/12))
- **fix(installer)**: DNS 삼중 fallback 복원, CJK 폰트 수정, Plymouth two-step 모듈
- **fix(branding)**: 설치된 시스템에 태스크바 핀, 배경화면, 잠금화면 추가

## v0.1.1 (2026-03-05)

Flatpak 지원 및 OpenClaw 통합이 포함된 첫 공개 릴리스

- **feat(shell)**: OpenClaw 번들 Flatpak 패키징
- **feat(shell)**: 감정 표현이 있는 VRM 3D 아바타
- **feat(agent)**: 멀티 프로바이더 LLM 지원 (Gemini, Claude, OpenAI, xAI, Ollama)
- **feat(shell)**: Edge, Google, OpenAI, ElevenLabs TTS 음성 대화
- **feat(shell)**: 14개 언어 UI 다국어 지원 ([#1](https://github.com/nextain/naia-os/issues/1))
