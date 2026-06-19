<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->
# Naia OS에 기여하기

> Naia OS는 내 컴퓨터에서 동작하는 개인 AI를 함께 만들어 가는 오픈소스 프로젝트입니다.
> 이 문서는 처음 오신 분이 "무엇을, 어떻게" 도울 수 있는지 안내합니다.

## 1. 누구의 허락도 필요 없습니다

먼저 저장소를 내려받습니다.

```bash
git clone https://github.com/nextain/naia-os.git
cd naia-os
```

그다음 사용하는 AI 코딩 도구(Claude Code, Cursor, GitHub Copilot, Gemini CLI 등)에서 이 폴더를 열고, 모국어로 이렇게 물어보세요.

> 이 프로젝트는 무엇이고, 제가 처음으로 도울 수 있는 일은 무엇인가요?

저장소의 [`.agents/`](../.agents/) 디렉토리에는 프로젝트의 비전·구조·규칙이 정리돼 있습니다. AI 도구가 이 내용을 읽고 **당신의 언어로** 설명해 줍니다. 그래서 문서를 처음부터 끝까지 읽지 않아도 시작할 수 있습니다.

막히면 [Discord](https://discord.gg/FGYJN7auty)에서 물어보세요. 가장 빠르게 도움받을 수 있습니다.

## 2. 어떤 언어로 참여해도 됩니다

- **이슈, 풀 리퀘스트(Pull Request, 이하 PR), 토론** — 어떤 언어로 써도 됩니다. 메인테이너가 AI 번역으로 읽습니다.
- **코드 주석, 커밋 메시지, [`.agents/`](../.agents/) 컨텍스트 파일** — 영어를 권장합니다. 영어 작성이 어렵다면 모국어로 제출해도 됩니다. 리뷰 과정에서 메인테이너가 영어 표현을 함께 다듬습니다.

## 3. 이 프로젝트의 핵심 — "스스로 점검하는 구조(하네스)"

Naia OS는 코드 대부분을 AI가 작성하는 프로젝트입니다. AI가 만든 코드는 빠르게 나오지만, 요구사항을 놓치거나 프로젝트 구조를 어길 수 있습니다. 그래서 사람이 매번 기억해서 확인하는 대신, **문서로 정한 절차와 자동 점검 스크립트**로 품질을 지킵니다. 이 묶음(절차 문서 + 체크리스트 + 점검 스크립트)을 이 프로젝트에서는 **하네스(harness)**라고 부릅니다.

기여 규칙도 여기서 나옵니다. 처음에는 낯설어 보여도, 이 구조가 있어야 사람이든 AI든 한 조각씩 안전하게 고칠 수 있습니다.

- **개발 절차 게이트 (P01~P05)** — 코드를 바로 쓰기 전에 *시나리오 → 테스트 계획 → 요구사항*을 먼저 적습니다. 자세한 단계는 아래 [6. 코드 기여 절차](#6-코드-기여-절차)에 있습니다.
- **구조 규칙 (F12·F13)** — 프로젝트 최상위 폴더(루트)에는 미리 허용된 파일·디렉토리만 둘 수 있습니다. 새 파일이 필요하면 규칙에 먼저 등록합니다.
- **헌장(charter) 문서** — [`AGENTS.md`](../AGENTS.md), [`agents-rules.json`](../.agents/context/agents-rules.json), [`project-structure.md`](../docs/project-structure.md) 같은 핵심 규칙 문서는 AI가 단독으로 바꿀 수 없고, 사람의 승인이 필요합니다.

> 처음이라면 [`AGENTS.md`](../AGENTS.md) → [`agents-rules.json`](../.agents/context/agents-rules.json) → [`project-structure.md`](../docs/project-structure.md) 순서로 읽어 보세요.

## 4. 기여하는 방법

코드만 기여가 아닙니다. 아래 어느 한 곳에서 시작하면 됩니다.

| 기여 유형 | 난이도 | 시작 위치 |
|---|---|---|
| 번역 | 낮음 | [`.users/context/`](../.users/context/) 에 언어 추가 (초벌은 자동 번역이 만들어 줍니다) |
| 버그 리포트 | 낮음 | [GitHub Issues](https://github.com/nextain/naia-os/issues) 에 재현 절차와 함께 등록 |
| 문서 개선 | 낮음 | [`docs/`](../docs/), [`.users/`](../.users/) |
| 사용 후기·테스트 | 낮음 | 앱을 써 보고 [Issues](https://github.com/nextain/naia-os/issues) 또는 [Discord](https://discord.gg/FGYJN7auty)에 피드백·로그 공유 |
| 코드 / PR | 중간~높음 | 아래 [6. 코드 기여 절차](#6-코드-기여-절차) 참고 |
| 컨텍스트 개선 | 중간 | [`.agents/`](../.agents/) 의 규칙·설명 다듬기 — 좋은 컨텍스트 하나가 저품질 AI PR 100건을 막습니다 |

> **보안 취약점**은 공개 이슈에 올리지 말고, [보안 정책](SECURITY.md)에 따라 `security@nextain.io`로 비공개 제보해 주세요.

## 5. 개발 환경 준비

현재 **검증된 개발·빌드 환경은 Linux**입니다. Naia OS는 [Tauri](https://tauri.app/)로 만든 데스크톱 앱이라 빌드하려면 아래가 필요합니다. Windows·macOS에서도 동작할 수 있지만, 이 문서는 아직 그 환경의 설치 절차를 보장하지 않습니다 — 문제가 생기면 [Discord](https://discord.gg/FGYJN7auty)에 사용 중인 OS와 오류 로그를 함께 공유해 주세요.

**준비물**

- Linux (Bazzite, Fedora, Ubuntu 등)
- [Node.js](https://nodejs.org/) 22 이상, [pnpm](https://pnpm.io/) 9 이상
- [Rust](https://www.rust-lang.org/) stable (Tauri 빌드에 필요)
- 시스템 패키지 (Fedora 예시): `webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel`

**설치와 실행**

```bash
pnpm install                        # 의존성 설치 (저장소 루트에서)
cd packages/shell && pnpm tauri:dev # 앱 실행 (아바타 셸이 뜹니다)
```

**테스트**

```bash
pnpm test                       # 순수 로직 단위 테스트 (vitest)
cd packages/shell
pnpm test:e2e                   # 실제 화면을 자동 구동하는 테스트 (Playwright)
xvfb-run pnpm test:e2e:tauri    # 실제 앱 전체 동작 테스트 (화면 → 백엔드)
```

**구조 점검 (코드 작성 전에 한 번)**

```bash
./scripts/enforce-root-structure.sh        # 루트 구조 규칙 위반 확인
node scripts/check-assembly-coverage.mjs   # 시나리오 누락 확인
```

## 6. 코드 기여 절차

코드를 바로 작성하기 전에 다음 순서를 따릅니다. 이 순서를 **개발 절차 게이트(P01~P05)**라고 부릅니다. 이 절차는 **코드를 바꾸는 PR**에 적용됩니다 — 작은 문서 수정이나 번역처럼 코드 동작에 영향이 없는 기여는 필요한 단계만 따르면 됩니다. 코드 변경에서는 각 단계의 산출물을 먼저 남기는 것을 원칙으로 합니다.

| 단계 | 할 일 | 산출물 |
|---|---|---|
| 0 | 작업할 이슈를 고르거나 새로 등록 | [GitHub Issue](https://github.com/nextain/naia-os/issues) |
| P01 | 사용자 시나리오(누가·무엇을·왜) 작성 | [`docs/user-scenarios.md`](../docs/user-scenarios.md) |
| P02 | 무엇을 테스트할지 계획 (위 파일의 Test Coverage Map) | 같은 파일 |
| P03 | 기능 요구사항(Functional Requirement, FR)·비기능 요구사항(Non-Functional Requirement, NFR) 작성 | [`docs/requirements.md`](../docs/requirements.md) |
| 구현 | 코드 작성 (새 파일·폴더는 구조 규칙에 먼저 등록) | — |
| P04 | 테스트 작성·실행 | 테스트 파일 |
| P05 | 완료 표시 (요구사항 상태를 Done으로) | [`docs/requirements.md`](../docs/requirements.md), [`process-status.json`](../.agents/context/process-status.json) |
| PR | 풀 리퀘스트 제출 | 제목 형식 `type(scope): 설명` |

**PR 체크리스트**

- [ ] 시나리오·테스트 계획·요구사항(P01~P03)을 먼저 적었다
- [ ] 테스트를 포함했고 통과한다 (`pnpm test`)
- [ ] 앱이 실제로 실행된다 (타입 검사만 한 것이 아니다)
- [ ] 새 파일·디렉토리를 구조 규칙에 등록했다
- [ ] 헌장 문서를 임의로 바꾸지 않았다
- [ ] 커밋 메시지를 영어로, `type(scope): 요약` 형식으로 썼다

## 7. AI 도구 사용

AI 도구 사용을 환영하고 권장합니다. 사용했다면 커밋 메시지 끝에 어떤 도구를 썼는지 적어 주세요(권장, 필수는 아닙니다).

```
feat(history): 대화 이력 저장 기능 추가

Assisted-by: Claude Code
```

`Assisted-by:` 뒤에는 사용한 도구 이름을 적습니다 (예: `Claude Code`, `ChatGPT`, `Cursor`, `Gemini`).

## 8. 더 깊은 주제

다음과 같은 더 깊은 주제가 있습니다.

- **제공자(provider)** — 음성 인식, 음성 합성, 대규모 언어 모델(Large Language Model, LLM)을 연결하는 모듈
- **AI 스킬** — AI가 반복 작업을 수행할 때 따르는 절차·도구 묶음
- **아키텍처** — 뇌·몸·환경 분리(추론 / 화면 입출력 / 외부 도구 연결을 나누는 설계)

아직 이 주제들에 대한 별도 가이드 문서는 없습니다. 작업을 시작하려면 [GitHub Issues](https://github.com/nextain/naia-os/issues)에 제안 이슈를 먼저 열거나 [Discord](https://discord.gg/FGYJN7auty)에서 문의해 주세요.

## 9. 보상

Naia OS는 아직 초기 단계 오픈소스라 바운티나 보상 프로그램이 없습니다. 지금의 모든 기여는 자발적인 참여입니다.
프로젝트와 회사가 자리를 잡으면 기여자 보상(버그 바운티·기능 바운티)을 도입할 계획입니다. 작은 기여라도 진심으로 감사드립니다.

## 10. 라이선스

- **소스 코드** — [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)
- **AI 컨텍스트** (`.agents/`, `.users/`, `AGENTS.md` 등) — [CC-BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)

기여하시면 위 라이선스 조건에 동의하는 것으로 간주합니다.
