# ADK Boundary Decision

Date: 2026-05-17

## 결정

### naia-adk — 개인 AI 개발 인프라 (solo)

- 혼자 사용하는 AI 개발 도구
- ctx engine: 개인 지식 그래프 (knowledge atomization)
  - atom store, graph traversal, search (CLI / MCP)
  - AI-agnostic — Claude Code, Codex, naia-agent 모두 접근 가능
- 개인 스킬 셋
- RBAC 불필요
- alpha-adk는 이 위에 올라가는 개인 workspace

### naia-business-adk — 팀 협업 AI 인프라 (team)

- 팀/비즈니스 협업 AI 도구
- ctx engine 확장: 공유 지식 그래프
  - RBAC (atom 단위 접근 제어)
  - 멀티유저 충돌 해결
  - 팀 공유 지식
- 팀 SDLC 워크플로우
- 비즈니스 스킬 셋

## 계층 구조

```
naia-adk          (개인 기반 인프라)
  └── naia-business-adk  (팀 확장 레이어)

alpha-adk         (Luke 개인 workspace, naia-adk 기반)
```

## ctx 시스템 위치

- ctx engine 핵심 → naia-adk
- 팀 공유/RBAC 확장 → naia-business-adk
- 어떤 AI든 CLI/MCP로 접근 — 런타임 종속 없음

## 다음 단계

- [ ] naia-adk에 ctx 이니셔티브 이슈 오픈
- [ ] atom schema 설계
- [ ] naia-adk / naia-business-adk 프로젝트 문서 업데이트
