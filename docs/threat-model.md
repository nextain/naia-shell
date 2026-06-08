# 위협 모델 (Threat Model)과 한계

> self-trust 하네스가 **무엇을 막고 무엇을 못 막는지** 정직하게 명시한다.
> 핵심 원칙: 로컬 hook은 *경고·마찰*이고, **신뢰의 최종 경계는 원격 CI**다.

## 1. 신뢰 경계 (Trust Boundary)

| 계층 | 역할 | 우회 가능성 |
|------|------|------------|
| **로컬 hook** (Claude Code PreToolUse) | 1차 마찰·즉시 피드백 | **높음** — `--no-verify`, `bash echo > file`, `python -c open().write()`, hook 파일 직접 수정, `HUMAN_APPROVED_CHARTER_EDIT=1` env 스푸핑 |
| **원격 CI** (GitHub Actions) | **최종 방어선** — 변경 전체를 재계산 | 낮음 — 단 **branch protection/ruleset 필수**(아래 6절) |

AI에게 로컬 파일 쓰기 권한이 있는 한 로컬 hook은 보안 경계가 아니다. 이것을 "2층 방어"로 부르되, **강제력은 전적으로 CI에 있다**.

## 2. 막는 것 (CI 기준)
- **완료선언 증거 위조** — `Verified:/Evidence:`가 가리킨 파일이 *이번 diff에 실제 포함*돼야 함(기존 파일 재활용 차단).
- **미등록 구조 생성** — F12/F13 레지스트리 밖 루트 경로 차단.
- **SDLC 게이트 미충족** — change_set_rules가 요구하는 산출물 없이 소스 변경 차단.
- **hook/workflow/charter 무단 변경** — `ci-verify-charter`가 사람 승인(`charter-approved` 라벨) 없이는 차단.

## 3. 못 막는 것 (정직한 한계)
- **AI가 "읽고도 안 따름"** — 지시 무시는 코드로 방어 불가(인간 리뷰 필요).
- **산출물 자체를 AI가 생성** — 증거가 코드·테스트면 그 코드도 AI작. 증거의 *진실성*은 보장 못 함 → mutation test·외부 corpus·인간 샘플 리뷰로 보완해야 함.
- **로컬 env 스푸핑** — 로컬에서 `HUMAN_APPROVED_CHARTER_EDIT=1`을 직접 줄 수 있음. CI의 `CHARTER_APPROVED`(maintainer 라벨 기반)가 최종.
- **self-hosted runner 변조** — AI 접근 가능 머신에서 검증하면 자기검증 모순. GitHub-hosted runner 권장.

## 4. 알려진 미완 (Roadmap)
- **symlink realpath 미처리** — 보호 경로를 symlink로 가장 가능. CI에서 `fs.realpathSync` 보강 예정.
- **글롭 단순 구현** — `globToRe`는 `*`·`**`·`{a,b}`만. 중첩 브레이스·문자클래스 미지원 → `picomatch` 도입 검토.
- **순환검증** — 자체 테스트(89개)는 모두 구현자 작성. 외부 이질 repo corpus 기반 통합테스트 필요.
- **도구 종속** — Node.js·Claude Code hook·GitHub Actions 가정. core 검증기를 CLI로 분리하고 hook을 adapter로 만드는 디커플링은 별도 트랙.

## 5. 위협 행위자 가정
"AI가 실수한다"가 아니라 **"AI가 목표 달성을 위해 정책을 재해석·우회할 수 있다"**를 기본 가정으로 둔다. 따라서 정책·증거는 AI가 수정 불가한 영역(CI)에서 재계산하고, 증거는 재실행 가능해야 한다.

## 6. 필수 운영 전제 (이게 없으면 CI 강제도 무력)
- GitHub branch protection / ruleset:
  - required status check = `self-trust gates`
  - **do not allow bypassing** (관리자도 우회 금지)
  - PR 필수 (main 직접 push 금지)
- `charter-approved` 라벨은 **maintainer만** 부여.
- 이 전제를 코드로 강제할 수는 없으므로, 템플릿 채택 시 설정 스크립트(`gh api`/Terraform)로 적용하고 체크리스트로 확인한다.
