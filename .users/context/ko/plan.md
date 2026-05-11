# 구현 계획

## 핵심 전략: 배포 먼저, 기능은 점진적으로

```
❌ 기존: 기능 완성 → 배포
✅ 변경: 배포 파이프라인 먼저 → 기능을 계속 추가
```

BlueBuild + GitHub Actions는 push할 때마다 자동으로 OS 이미지를 빌드한다.
즉, **Day 1부터 배포 가능**. 매 Phase마다 새 ISO가 나온다.

---

## Phase 0: 배포 파이프라인 (Day 1-3)

> **결과물**: GitHub에 push하면 Naia 이미지가 자동 빌드됨

### 0-1. BlueBuild 템플릿 세팅

**작업:**
- `os/` 디렉토리에 BlueBuild recipe 생성
- GitHub Actions 워크플로우 설정
- Bazzite를 base-image로 지정

```yaml
# os/recipe.yml
name: naia-os
description: Personal AI OS with Alpha
base-image: ghcr.io/ublue-os/bazzite
image-version: latest

modules:
  - type: rpm-ostree
    install: [nodejs20]
  - type: files
    files:
      - source: usr/
        destination: /usr/
```

### 0-2. GitHub Actions 자동 빌드

**작업:**
- BlueBuild GitHub Action 설정
- push → 이미지 빌드 → ghcr.io 게시
- ISO 생성 (ublue-os/isogenerator)

**결과:**
```
git push → GitHub Actions → ghcr.io/luke-n-alpha/naia-os:latest
                          → naia-os.iso (Releases)
```

### Phase 0 완료 = 배포 가능
```
✅ BlueBuild recipe 동작
✅ push마다 OS 이미지 자동 빌드
✅ ISO 다운로드 가능 (GitHub Releases)
✅ USB에 구워서 부팅 확인 (아직 Bazzite 그대로)
```

**이 시점에 공유 가능:** "Naia 첫 이미지 나왔다" (아직은 Bazzite + Node.js뿐이지만)

---

## Phase 1: Alpha가 화면에 나타난다 (Week 1)

> **결과물**: Bazzite 부팅 → Alpha 아바타가 자동으로 화면에 등장

### 스택
- **Tauri 2** (데스크탑 앱)
- **React 18+ / TypeScript / Vite**
- **Three.js r0.182 + @pixiv/three-vrm ^3.4.5**
- **shadcn/ui** (UI 컴포넌트)
- **Zustand** (상태관리)
- **Biome** (포맷터: 탭, 더블쿼트, 세미콜론)

### 1-1. Tauri 2 + React 프로젝트 초기화

**작업:**
- `shell/`에 React + TS + Vite 프로젝트 셋업
- Biome 설정, shadcn/ui 설치
- Three.js + @pixiv/three-vrm + zustand 설치
- Tauri 2 백엔드 (Cargo.toml, tauri.conf.json, main.rs, lib.rs)

### 1-2. AIRI VRM 코어 추출

**AIRI에서 그대로 복사 (순수 Three.js):**
| 원본 | 대상 |
|------|------|
| `stage-ui-three/composables/vrm/core.ts` | `src/lib/vrm/core.ts` |
| `stage-ui-three/composables/vrm/loader.ts` | `src/lib/vrm/loader.ts` |
| `stage-ui-three/composables/vrm/utils/eye-motions.ts` | `src/lib/vrm/eye-motions.ts` |
| `stage-ui-three/assets/vrm/animations/idle_loop.vrma` | `public/animations/idle_loop.vrma` |

**순수 함수 추출:**
- `animation.ts` → `loadVRMAnimation`, `clipFromVRMAnimation`, `reAnchorRootPositionTrack`

### 1-3. Vue → React 훅 포팅

| 훅 | 원본 | 변경 내용 |
|-----|------|-----------|
| `useBlink.ts` | `animation.ts`의 `useBlink()` | Vue `ref()` → React `useRef` |
| `useIdleEyes.ts` | `animation.ts`의 `useIdleEyeSaccades()` | Vue `ref()` → React `useRef`, `Ref<>` 제거 |

### 1-4. AvatarCanvas 컴포넌트

**작업:**
- Three.js WebGLRenderer + Scene + Camera 셋업
- VRM 로딩 (core.ts 사용)
- idle 애니메이션 재생 (idle_loop.vrma)
- 렌더 루프 순서: animation → humanoid → lookAt → blink → saccade → expression → springBone

### 1-5. Tauri 윈도우 설정
- 기본 윈도우 (투명/borderless는 Phase 2에서)
- 앱 타이틀: "Naia Shell"

### 1-6. 통합 확인
- `pnpm tauri dev` 실행 → 아바타 표시 확인

### Phase 1 완료 = 첫 데모
```
✅ USB 부팅하면 Alpha가 화면에 나타남
✅ VRM 3D 아바타, 눈 깜빡임, idle 모션, 눈 미세 움직임
✅ Spring Bone 물리 (머리카락 흔들림)
✅ 아직 대화 불가 (다음 Phase)
```

**이 시점에 공유 가능:** "USB 꽂으면 AI 캐릭터가 맞이하는 OS" (스크린샷/영상)

---

## Phase 2: Alpha와 대화할 수 있다 (Week 2)

> **결과물**: 채팅 패널에서 Alpha와 텍스트 대화. 표정 변화 + 립싱크.

### 핵심 호환성 요구사항

| 표준 | 설명 | 참조 |
|------|------|------|
| **AAIF** | Agentic AI Foundation (리눅스 재단, 2025.12) 3대 표준 준수 | project-careti F06 |
| **AGENTS.md** | 컨텍스트 레이어 (OpenAI 기증) — 계층적 적용 | AAIF Pillar 1 |
| **SKILL.md** | 실행 레이어 — 절차적 지식 패키지 | AAIF Pillar 2 |
| **MCP** | 연결성 레이어 (Anthropic 기증) — 외부 도구 연결 | AAIF Pillar 3 |
| **Claude Code 호환** | CLAUDE.md, `.claude/` ↔ `.agents/` 상호운용 | project-careti F06 |
| **Careti 컨텍스트 호환** | project-careti의 `.agents/` 컨텍스트를 그대로 소비 가능 | project-careti F06 |

**기본 프로바이더:** Google (Gemini) — 채팅/TTS/비전 통합; Claude는 코딩 작업용
**과금 표시:** 요청별 비용 표시 (project-careti 패턴 참고)

### 2-1. Agent Core 최소 구현

**LLM 프로바이더:** xAI (Grok), Google (Gemini), Anthropic (Claude) — project-careti 프로바이더 참고

**작업:**
- `agent/`에 Node.js 프로젝트
- LLM 3개 연결 (xAI/Google/Claude) — Careti 프로바이더 코드 참고
- AAIF 컨텍스트 소비 (.agents/ + AGENTS.md 계층)
- stdio JSON lines 프로토콜 — Careti stdio-adapter 참고
- Alpha 페르소나 시스템 프롬프트
- API 사용량/과금 표시 (project-careti 참고)

**결과:** `node agent/core.js --stdio` 로 대화 가능

### 2-2. Shell ↔ Agent 연결

**작업:**
- Tauri Rust에서 agent-core spawn — Careti `lib.rs` 복사
- stdio 브릿지 (자동 재시작 포함)
- 채팅 패널 UI + 과금 표시
- 스트리밍 응답 표시

**결과:** 채팅 패널에서 Alpha와 실시간 대화

### 2-3. Avatar 감정 + 립싱크 + TTS (멀티 프로바이더)

**작업:**
- LLM 응답에서 감정 추출
- VRM 표정 변경 (기쁨, 놀람, 생각 중)
- 응답 중 립싱크

**결과:** Alpha가 말하면서 표정이 바뀌고 입이 움직임

### 2-4. OS 이미지 업데이트

**작업:**
- agent-core 바이너리를 OS 이미지에 포함
- 첫 부팅 시 API 키 입력 화면 (온보딩)
- recipe.yml 업데이트 → 자동 빌드 → 새 ISO

**결과:** 새 ISO로 USB 부팅 → 키 입력 → Alpha와 대화

### Phase 2 완료 = 사용 가능한 데모
```
✅ USB 부팅 → API 키 설정 → Alpha와 대화
✅ 스트리밍 응답
✅ 아바타 표정 변화 + 립싱크
✅ ISO 자동 빌드 (push마다)
```

**이 시점에 공유 가능:** "USB 꽂으면 AI와 대화할 수 있는 OS" (데모 영상)
**관심 끌기에 충분한 지점.**

---

## Phase 3: Alpha가 일을 한다 (Week 3-4)

> **결과물**: Alpha가 파일 편집, 터미널 실행, 웹 검색 가능

### 3-1. 도구 시스템

**작업:**
- Careti 도구 코드 복사 + 정리:
  - `file_read`, `file_write`, `apply_diff` (SmartEditEngine)
  - `execute_command` (터미널)
  - `browser_action` (웹)
  - `search_files` (ripgrep)
- LLM tool calling 연동

**결과:** "메모 만들어줘", "npm install 해줘" → Alpha가 실행

### 3-2. 권한 + 감사

**작업:**
- Tier 0-3 권한 시스템
- 승인 요청 UI
- 감사 로그 (SQLite)

**결과:** 위험 작업은 승인 요청, 전체 이력 기록

### 3-3. 작업 UI

**작업:**
- 작업 진행 패널 (Alpha가 뭘 하고 있는지)
- 터미널 출력 실시간 표시
- 파일 변경 diff

**결과:** Alpha의 작업을 시각적으로 확인

### Phase 3 완료 = 실용적인 AI OS
```
✅ Alpha가 파일 읽기/쓰기/편집
✅ 터미널 명령 실행
✅ 웹 검색
✅ 권한 시스템 + 감사 로그
✅ 작업 진행 UI
```

**이 시점에 공유 가능:** "AI가 실제로 컴퓨터를 조작하는 OS" (데모 영상)

---

## Phase 4: Alpha가 항상 켜져있다 (Week 5-7)

> **결과물**: 데몬으로 항상 실행. 외부 채널에서도 접근 가능.
> **전략**: Gateway 먼저 → Phase 3 실행 검증 → 이후 신규 기능

### 4-0. Naia Gateway 로컬 설정 (선행) — obsolete (#201 로 superseded)

**상태**: 본 단계는 #201 에서 OpenClaw gateway daemon 자체가 제거되며 폐기됨.
naia-agent 가 shell 의 child process 로 임베드되어 직접 도구 실행. 자세한
현재 wire 는 `.agents/context/agent-bridges.yaml` 참조.

**(historical) 원래 작업:**
- OpenClaw 설치 + 설정 (`setup-openclaw.sh` — `#271 Phase 1` 에서 삭제됨)
- Gateway 로컬 기동 (`naia-gateway-wrapper` — 사용 안 함)
- Shell → Agent → Gateway WebSocket 연결 (이젠 stdio JSON 직접)
- Gateway 자동 라이프사이클 (Tauri 앱이 agent child process 직접 spawn)
  - Hybrid 전략: 이미 실행 중이면 재사용, 아니면 자동 spawn
  - Node.js 22+ 탐지 (system PATH + nvm fallback)
  - Health check 폴링 (5초 타임아웃, 500ms 간격)
  - 종료 시 자동 spawn한 Gateway만 kill (systemd 서비스는 유지)
  - `gateway_status` 이벤트를 frontend로 emit

**결과:** `gateway_health()` = true, Agent가 WebSocket으로 연결

### 4-1. Phase 3 E2E 검증 ✅

**작업:**
- 8개 도구 런타임 테스트 (read/write/diff/command/search/web_search/browser/spawn) ✅
- 승인 UI 실제 동작 확인 (Tier 1-2 모달) ✅
- Sub-agent 병렬 실행 실제 검증 ✅
- Audit log 실제 기록 확인 ✅
- 런타임 테스트 중 발견되는 버그 수정 ✅

**결과:** 8개 도구 전부 Gateway를 통해 성공적으로 실행

### 4-2. 사용자 테스트 (수동)

**작업:**
- `pnpm tauri dev` → 채팅 → 도구 호출 → 결과 확인
- 파일 읽기/쓰기/편집 시나리오
- 명령 실행 시나리오
- 에러 케이스 (권한 거부, 타임아웃 등)

**결과:** Phase 3 도구 정상 동작 사용자 확인

### 4-3. Skills 시스템 ✅

**작업:**
- Skill 레지스트리 + 매칭 ✅
- 기본 Skills (시간 ✅, 메모 ✅, 시스템 상태 ✅) — Gateway 내장 스킬 활용
- 커스텀 Skills 로더 (~/.naia/skills/) ✅
- E2E 테스트: 04-skill-time, 05-skill-system, 06-skill-memo ✅

**알려진 이슈:**
- skill_memo "전체 목록 보기"가 간헐적으로 행(Gateway 응답 타임아웃)

### 4-3b. 스킬 생태계 (7 built-in + 63 custom) ✅

> 7개 기본 스킬 (Rust `list_skills()` 하드코딩) + 63개 커스텀 스킬 (`~/.naia/skills/` skill.json)
> 기본 스킬: time, memo, weather, system_status, naia_discord, soul, exit
> 커스텀: 13개 Naia 전용 + 50개 커뮤니티

**전략:** 기본 스킬은 Rust에서 하드코딩 (비활성화 불가). 커스텀 스킬은 `agent/assets/default-skills/`에서 `~/.naia/skills/`로 bootstrap 복사 후 런타임 로드.

#### 전체 스킬 목록 (51개)

| 카테고리 | 스킬 |
|---------|------|
| 지식/노트 | 1password, apple-notes, bear-notes, notion, obsidian, nano-pdf, trello |
| 작업/리마인더 | apple-reminders, things-mac, oracle |
| 커뮤니케이션 | slack, discord, bluebubbles, imsg, himalaya, wacli |
| 미디어/콘텐츠 | video-frames, openai-image-gen, nano-banana-pro, gifgrep, songsee, summarize |
| 오디오/음성 | openai-whisper, openai-whisper-api, sherpa-onnx-tts, sag, voice-call |
| 음악/스피커 | sonoscli, blucli, spotify-player |
| 스마트홈/IoT | openhue, eightctl, camsnap |
| 개발/코딩 | coding-agent, github, mcporter, skill-creator |
| 생산성 | gog, goplaces, blogwatcher, food-order, ordercli |
| AI/모델 | gemini, model-usage, clawhub |
| 시스템/터미널 | tmux, healthcheck, session-logs, weather, canvas |

#### 테스트 계획
- E2E spec: `shell/e2e-tauri/specs/09-skills-*.spec.ts`
- 각 스킬: invoke → 응답 형식 검증

**완료 조건**: 7개 기본 + 63개 커스텀 스킬 등록 + SkillsTab에서 토글 가능

---

### 4-4. 메모리 + UX + 온보딩

> **궁극적 목표**: Alpha가 사용자를 기억하고 성장하는 진짜 개인 AI 에이전트

#### 실행 순서

```
4.4a ✅ → 4.4-ui → 4.4-onboard → 4.4b → 4.4c
(영속성)   (탭 구조)  (첫인상)     (기억)   (학습)
```

**순서 근거:**
- **4.4-ui 먼저**: 탭 아키텍처가 히스토리/설정/온보딩의 구조적 기반
- **4.4-onboard 다음**: 새 탭 UI 위에 구축, 사용자 프로필(이름) 생성 → context recall이 활용
- **4.4b 세번째**: 온보딩 프로필 + 세션 요약 활용
- **4.4c 마지막**: 4.4b 요약 파이프라인 위에 fact 추출 확장

#### 아키텍처

```
┌─────────────────────────────────────────────────────┐
│  단기기억 (Short-Term Memory)                        │
│  = 현재 세션 전체 메시지                              │
│  = Zustand (메모리) + SQLite messages 테이블          │
│  수명: 현재 세션 ~ 최근 7일                           │
└────────────┬────────────────────────────────────────┘
             │ 세션 종료 시 consolidate()
             ▼
┌─────────────────────────────────────────────────────┐
│  장기기억 (Long-Term Memory)                         │
│  ┌──────────────┐  ┌─────────────────────────────┐  │
│  │ Episodic     │  │ Semantic                    │  │
│  │ (에피소드)    │  │ (사실/선호)                  │  │
│  │ = 세션 요약   │  │ = "사용자는 Rust 선호"       │  │
│  │ sessions     │  │ = facts 테이블               │  │
│  │ .summary     │  │ (key, value, source,        │  │
│  │              │  │  updated_at)                │  │
│  └──────────────┘  └─────────────────────────────┘  │
│                                                      │
│  사용자 프로필 (온보딩에서 생성):                      │
│  user_profile 테이블 (name, provider, persona)       │
│                                                      │
│  검색 엔진 (교체 가능 — MemoryProcessor 인터페이스):  │
│  4.4a: SQLite LIKE → 4.4b: FTS5 BM25               │
│  4.5: Gemini Embedding → 5+: sLLM (Ollama)          │
└─────────────────────────────────────────────────────┘
```

#### 단계별 구현

**4-4a. 대화 영속성 (단기기억)** ✅ 완료
- Rust `memory.rs`: sessions + messages 테이블 (rusqlite) ✅
- `sessions.summary` 컬럼 미리 준비 (비워둠, 4.4b에서 채움) ✅
- Tauri commands: 8개 메모리 커맨드 등록 ✅
- Frontend `db.ts`: invoke() 래퍼 + ChatMessage↔MessageRow 변환 ✅
- Chat store: sessionId, setMessages, newConversation ✅
- ChatPanel: 이전 대화 로드, 새 대화(+) 버튼 ✅
- ChatPanel: ESC 키 / ■ 버튼으로 스트리밍 취소 ✅
- 아바타 감정 리셋 (스트리밍 종료 시 neutral 복귀) ✅
- E2E 테스트: 08-memory.spec.ts (4 테스트: 영속/새로고침/새대화/독립세션) ✅
- 테스트: Rust 53, Vitest 143, E2E 8 specs (15 tests) — 전부 통과

---

**4-4-ui. Shell UX 개편** ← 다음 작업
> UI를 모달 기반에서 탭 기반으로 전면 개편.
> 온보딩과 히스토리의 구조적 기반이 되는 작업.

| 항목 | 설명 |
|------|------|
| 탭 시스템 | 채팅 \| 작업 \| 설정 (설정 모달 제거) |
| 비용 대시보드 | 비용 배지 클릭 → 상세 비용 내역 탭 |
| 세션 히스토리 | 과거 대화 목록 사이드바, 재개 가능 |
| 에러 필터링 | 작업 탭에서 에러 수 클릭 → 에러만 필터 |
| 메시지 큐 | AI 작업 중 메시지 편집/재정렬 (careti 스타일) |

**완료 조건**: 설정/히스토리/비용이 모달이 아닌 탭으로 접근 가능

---

**4-4-onboard. 온보딩 위자드 (첫 실행 경험)** — 계획됨
> OpenClaw CLI 온보딩의 GUI 버전. Alpha와의 첫 만남.
> 의존: 4.4-ui (탭 구조 위에 구축)

| 단계 | 화면 | 설명 |
|------|------|------|
| 1 | Welcome | Alpha 아바타 애니메이션 + "안녕!" |
| 2 | 이름 입력 | "뭐라고 불러줄까요?" → 사용자 이름 |
| 3 | Provider 설정 | 시각적 카드 선택 (Gemini/xAI/Claude) + API 키 입력 |
| 4 | API 키 검증 | 테스트 호출로 키 유효성 확인 |
| 5 | 페르소나 (선택) | Alpha 성격 프리셋 또는 커스텀 |
| 6 | 첫 대화 | "[HAPPY] 반가워요, {이름}! 무엇을 도와줄까요?" |

**저장 위치:** SQLite `user_profile` 테이블 (name, provider, persona)
**건너뛰기:** 파워 유저는 스킵 → 설정 탭으로 직접 이동 가능
**참조:** OpenClaw CLI 온보딩 (이름 선택 + "무얼 할까요?" 플로우)

**완료 조건**: 첫 부팅 → 위자드 → 이름 + API 키 → Alpha가 이름 불러줌

---

**4-4b. 세션 요약 + 컨텍스트 리콜** — 계획됨
> 의존: 4.4-onboard (사용자 프로필이 이름/컨텍스트 제공)

- FTS5 전문검색 활성화
- 세션 종료 시 LLM으로 요약 생성 → sessions.summary
- 새 대화 시 system prompt에 주입: 사용자 이름 + 선호 + 최근 세션 요약
- MemoryProcessor.summarize() 구현 (Gemini API)
- **완료 조건**: 새 대화에서 이전 대화 맥락 + 사용자 이름을 알고 있음

---

**4-4c. 시맨틱 메모리 (facts)** — 계획됨
> 의존: 4.4b (요약 파이프라인 위에 구축)

- facts 테이블: 키-값 시맨틱 메모리
- LLM이 대화에서 fact 추출 (사용자 선호, 학습된 정보)
- facts도 system prompt에 주입 (세션 요약과 함께)
- MemoryProcessor.extractFacts() 구현
- **완료 조건**: Alpha가 세션 간 사용자 선호를 기억함

#### 미래 확장

| Phase | 내용 |
|-------|------|
| 4.5 | Gemini Embedding API로 의미 검색 |
| 5+ | sLLM (Ollama, llama.cpp)으로 로컬 요약/임베딩 |

#### MemoryProcessor 인터페이스 (교체 가능)

```typescript
interface MemoryProcessor {
  summarize(messages: ChatMessage[]): Promise<string>;
  extractFacts?(messages: ChatMessage[]): Promise<Fact[]>;
  semanticSearch?(query: string, limit: number): Promise<MessageRow[]>;
}
// 4.4a: 미구현 (SQLite LIKE만)
// 4.4b: GeminiMemoryProcessor.summarize()
// 4.5: GeminiMemoryProcessor.semanticSearch()
// 5+: LocalLLMMemoryProcessor (Ollama)
```

### 4-5. 채널 통합 ✅

**완료:**
- Discord DM 봇 ✅ — Naia 전용 DM 봇 (naia-discord 스킬), OAuth 연동
  - `discord-auth.ts`: OAuth → `discoverDmChannelId()` → Shell config 저장
  - `naia-discord.ts`: DM 전용 스킬 (send/status/history)
  - `gateway-sync.ts`: `syncDiscordToGateway()` → Gateway runtime config.patch
- Gateway에 `provider_account_id` 컬럼 + `GET /v1/auth/lookup` 엔드포인트 추가 ✅
- 연동 설정 UI (settings/integrations) ✅

**예정:**
- Google Chat — webhook 준비, 앱 등록 미완

**결과:** 밖에서 "집 PC 상태?" → Alpha 응답

### 4-6. systemd 자동시작 통합

**작업:**
- Gateway 부팅 시 자동 시작
- 헬스 모니터링

### Phase 4 완료 = 완성된 AI OS
```
✅ 부팅 시 자동 시작, 항상 실행
✅ 외부 채널 접근
✅ 대화 기억
✅ Skills 시스템
```

---

## Phase 5: Nextain 계정 연동 (Week 8-9) ✅ 완료

> **결과물**: Nextain OAuth 로그인으로 API 키 입력 없이 편리하게 사용. 기존 수동 키 입력 유지.
> **현황**: Deep link (5-1) ✅, Auth flow UI (5-2) ✅, LLM proxy (5-3) ✅, Credit display (5-4) ✅, Discord 연동 ✅.

### 아키텍처

```
┌────────────────┐    OAuth     ┌─────────────────────┐
│  Naia Shell    │ ──────────→  │  naia.nextain.io      │
│  (Tauri 앱)    │  ←────────── │  (Next.js 포털)       │
│                │  deep link   │                       │
│  gatewayKey    │  naia://  │  POST desktop-key     │
│  stored local  │              │  → virtual key 발급   │
└───────┬────────┘              └──────────┬────────────┘
        │ X-AnyLLM-Key: Bearer {key}       │
        ▼                                   ▼
┌─────────────────────────────────────────────────┐
│            any-llm Gateway (GCP)                 │
│  LLM 프록시 + 크레딧 차감 + 사용량 추적           │
└─────────────────────────────────────────────────┘
```

### 5-1. Deep Link 핸들러 (Tauri)

**Tauri `naia://` URI 스킴 등록 + 처리.**

- `shell/src-tauri/tauri.conf.json`: deep-link 플러그인 + 스킴 등록
- `shell/src-tauri/Cargo.toml`: tauri-plugin-deep-link 의존성
- `shell/src-tauri/src/lib.rs`: deep-link 이벤트 → `naia://auth?key=xxx` 파싱 → emit
- `shell/src-tauri/capabilities/default.json`: deep-link 퍼미션
- `shell/package.json`: @tauri-apps/plugin-deep-link 프론트엔드 바인딩

### 5-2. 인증 흐름 UI

- `config.ts`: `labKey?`, `labUserId?` 필드 + `hasLabKey()` 유틸
- `OnboardingWizard.tsx`: "Nextain" 버튼 (기존 프로바이더 선택과 병행)
- 브라우저 → naia.nextain.io 로그인 → deep link 콜백 → 키 저장 → apiKey 스텝 건너뛰기
- `SettingsTab.tsx`: "Nextain 계정" 섹션 (연결 상태 표시, 해제 버튼)

### 5-3. LLM 프록시 연동

- **신규** `agent/src/providers/lab-proxy.ts`: OpenAI-compatible 프록시 프로바이더
- Lab 키 설정 시 → any-llm Gateway 경유 LLM 호출
- 헤더: `X-AnyLLM-Key: Bearer {labKey}`
- 기존 직접 호출 로직은 apiKey 설정 시 그대로 유지

### 5-4. 크레딧 잔액 표시

- `CostDashboard.tsx`: Nextain 연결 시 서버 잔액 조회 + 표시
- 잔액 API: `GET /v1/profile/balance` (labKey 인증)
- "크레딧 충전" 버튼 → naia.nextain.io/billing 링크

### 5-5. 테스트

- `shell/src/__tests__/lab-auth.test.ts` — deep link 파싱, config 저장
- `agent/src/__tests__/lab-proxy.test.ts` — 프록시 프로바이더 단위 테스트
- `shell/e2e-tauri/specs/13-lab-login.spec.ts` — E2E (deep link 시뮬레이션)

### Phase 5 완료 = 크레딧 기반 서비스 모드
```
✅ Nextain 로그인 → 자동 키 발급 → Gateway 경유 LLM 호출
✅ 크레딧 잔액 실시간 표시
✅ 기존 로컬 모드 (직접 API 키) 병행 유지
```

---

## Phase 6: Tauri 앱 배포 — Linux 패키지 (Week 10) — 완료

> **결과물**: ISO 없이 기존 Linux에 설치 가능한 독립 앱
> **현황**: 모든 포맷 GitHub Releases에 배포 완료 (Flatpak, AppImage, DEB, RPM). CI: release-app.yml.

### 6-1. Tauri 번들 설정

- `tauri.conf.json`: bundle 섹션 (deb, rpm, AppImage)
- 아이콘, 카테고리, 라이센스 설정
- deep-link URI 스킴 패키지 등록

### 6-2. AppImage 빌드 + GitHub Release

- `.github/workflows/release-app.yml` (신규)
- `cargo tauri build` → AppImage, deb, rpm
- GitHub Release 업로드, Linux x86_64 타겟

### 6-3. Flathub (선택) — 부분 완료 ✅

- `flatpak/io.nextain.naia.yml` 매니페스트 완성 ✅
  - GNOME 47 런타임 (Tauri 2의 webkit2gtk-4.1 호환)
  - `npx pnpm` + `CI=true`로 SDK 읽기 전용 파일시스템 대응
  - `cargo build --release`로 바이너리 빌드 (번들링 건너뛰기)
  - 빌드 성공: x86-64 ELF 204.9 MB
- Flathub submission (별도 리포) — 미완

### Phase 6 완료 = 독립 앱 배포
```
✅ AppImage 다운로드 → 더블클릭으로 실행
✅ deb/rpm 패키지 매니저로 설치 가능
✅ GitHub Releases에서 다운로드
```

---

## Phase 7: OS ISO 빌드 (Week 11) — 완료

> **결과물**: USB 부팅 → 설치 가능한 완전한 Naia
> **현황**: ISO 빌드 라이브 (iso-77, iso-78). R2 CDN 다운로드. CI: iso.yml.

### 7-1. Recipe에 Tauri 앱 포함

- `recipes/recipe.yml`: Phase 6 AppImage/바이너리 포함
- `config/files/usr/bin/naia-shell` 또는 AppImage 배치
- `config/scripts/`: 첫 부팅 설정 스크립트 업데이트

### 7-2. ISO 빌드 테스트

- GitHub Actions `iso.yml` workflow dispatch
- ISO 다운로드 → VM 부팅 테스트 (QEMU/VirtualBox)
- Smoke test 실행

### Phase 7 완료 = 완전한 AI OS ISO
```
✅ USB 부팅 → Naia 설치
✅ Naia Shell 자동 시작
✅ Nextain 로그인 또는 로컬 모드 선택
```

---

## Phase 8: Alpha와 게임을 한다 (Week 12+)

> **결과물**: Minecraft 같이 플레이, 게임 중 아바타 반응

### 8-1. Minecraft (AIRI 포팅)

- Mineflayer 서버 접속
- 자율 행동 (채굴, 건축, 전투)
- 게임 상황 → 대화 반영

### 8-2. 범용 게임

- 화면 캡처 + 비전 모델
- 키/마우스 제어
- 게임별 프로필

### 8-3. 게임 오버레이

- Alpha 아바타 오버레이 표시
- 게임 상황 감정 반응
- 음성 채팅

### Phase 8 완료 = 차별화
```
✅ Minecraft에서 Alpha와 함께 플레이
✅ 게임 중 대화/반응
```

---

## 배포 타임라인

```
Day 1-3:   Phase 0 (파이프라인) → 빈 ISO 나옴
Week 1:    Phase 1 (아바타)     → Alpha가 보이는 ISO
Week 2:    Phase 2 (대화)       → Alpha와 대화하는 ISO  ← 공개 데모
Week 3-4:  Phase 3 (도구)       → Alpha가 일하는 ISO
Week 5-7:  Phase 4 (데몬)       → 완성된 AI OS ISO
Week 8-9:  Phase 5 (Nextain 연동) → 크레딧 서비스 모드 추가
Week 10:   Phase 6 (앱 배포)    → 독립 Linux 앱 배포
Week 11:   Phase 7 (OS ISO)     → 최종 ISO 빌드
Week 12+:  Phase 8 (게임)       → 게임하는 AI OS ISO
```

**매 Phase마다 새 ISO가 나온다.**
push → GitHub Actions → 빌드 → ISO → 다운로드 가능.

## 관심 끌기 포인트

| 시점 | 공유 가능한 것 | 임팩트 |
|------|--------------|--------|
| Phase 0 | "AI OS 프로젝트 시작" | 낮음 (관심자만) |
| Phase 1 | 스크린샷: 부팅하면 아바타가 나타남 | **중간** |
| **Phase 2** | **데모 영상: AI와 대화하는 OS** | **높음 — 여기서 공개** |
| Phase 3 | 데모: AI가 터미널/파일 제어 | 매우 높음 |
| Phase 4 | "Discord에서 집 AI에게 명령" | 높음 |
| **Phase 5** | **"Nextain 로그인으로 API 키 없이 AI OS"** | **높음 — 크레딧 서비스** |
| Phase 6 | "AppImage로 기존 Linux에 설치" | 중간 |
| Phase 7 | "완성된 AI OS ISO" | 매우 높음 |
| Phase 8 | "AI랑 마인크래프트" | 바이럴 가능성 |
