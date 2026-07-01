<!-- src-sha: 9ca11b69fa066f2f -->
<!-- 자동 번역 미러 (M13-mirror). 원본: .agents/context/project-index.yaml -->

---
프로젝트: "naia-os"
버전: "0.1.0"
갱신일: "2026-06-08"
설명: |
  바자이트(Bazzite) 기반의 배포형 비주얼 에이전트(visual agent) — 나이아(naia) 템플릿 프로젝트를 헥사고날 아키텍처(Hexagonal Architecture)로 다시 구축. 내부 구조는 인공지능 운영체제(AI OS, agent=커널) 은유.

# 세션 시작 시 반드시 읽는 파일 (순서 중요)
필수_읽기_항목:
  - 파일: .agents/context/process-status.json
    목적: "현재 진행 중인 문제 및 소프트웨어 개발 생명주기(SDLC) 단계 상태 확인. 세션 시작 시 마지막 갱신 일자(last_updated) 업데이트 필수."
  - 파일: .agents/context/agents-rules.json
    목적: "규칙의 단일 정보원(SoT) — 프로젝트의 모든 금지 사항 및 필수 규칙 포함."
  - 파일: docs/project-structure.md
    목적: "허용된 최상위 디렉토리 및 파일 구조 명세."

# 진입점
진입점:
  - 파일: AGENTS.md
    목적: "AI 도구 연동을 위한 기준 정보(canonical SoT)."
  - 파일: CLAUDE.md
    목적: "클로드 코드(Claude Code)에서 사용하는 AGENTS.md의 복제본(mirror)."

# 필요 시 불러오기 (온디맨드 로딩)
필요시_불러오기:
  프로세스:
    - 파일: docs/user-scenarios.md
      주제: [사용자 사례(UC), 테스트 커버리지]
    - 파일: docs/requirements.md
      주제: [기능 요구사항(FR), 비기능 요구사항(NFR)]
    - 파일: docs/glossary.md
      주제: [용어 정의]
  아키텍처:
    - 파일: docs/ARCHITECTURE.md
      주제: [시스템 아키텍처, 패키지 구성, 의존성]
  진행_중인_이슈:
    - 파일: docs/progress/
      주제: [이슈, 진행 현황, SDLC 단계]
  격리_보관소:
    - 파일: quarantine/MANIFEST.json
      주제: [격리(quarantine), 보류 자산, 방치 자산]
      참고: "시스템 안전을 위해 별도로 격리한 방치 의심 자산 목록. 비어있지 않은 경우 보존된 자산이 있음을 의미하며, 대기 중인 항목(pending_notice)은 관리자의 확인이 필요함. (도구: scripts/quarantine.mjs)"

# 컨텍스트 정보 우선순위
정보_우선순위:
  - .agents/context/agents-rules.json
  - AGENTS.md
  - .agents/context/project-index.yaml
