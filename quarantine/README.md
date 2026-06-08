# quarantine/ — 보류 격리 (처분 6번째 방식)

마이그레이션(harden) 중 만난 **방치 의심 자산**을 둘 곳이다.
"방치 의심" = 빌드에 연결 안 됐고(workspaces·참조 0), 한두 커밋 뒤 손 안 댄
스캐폴드/잔재인데, 그렇다고 **지금 지우기도 애매한** 회색 자산
(과거 AI 가 짜다 만 골격, 일회성 실험 서버, 재현 가능한 데이터 덤프 등).

5분류(채움/정렬/고유등록/추적제외/보안격리)는 전부 "지금 결정"을 강요한다.
이런 회색 케이스엔 **"보류 + 정책 기록 후 사용자 처분"** 칸이 필요해서 둔 6번째 방식이다.

## 동작 (`scripts/quarantine.mjs`)

| 명령 | 하는 일 |
|------|---------|
| `add <경로> [--reason …] [--retention <개월>] [--compress-now]` | 자산 → `quarantine/<name>/` 이동 + `git rm --cached`(이력·디스크 보존) + manifest 기록 |
| `check` | 만료(`review_by` 경과) 검출 → **자동 tar.gz 압축(비파괴)** → `status=archived` + `pending_notice`. **삭제 안 함.** (cron/verify-watch 가 호출) |
| `list` | 격리 자산 + 계산된 status |
| `restore <name>` | 격리 해제 — 압축 풀고 원위치 복원 (`git add` 로 재추적) |
| `extend <name> <개월>` | 보관기간 연장 + 처분 대기 해제 |
| `purge <name>` \| `purge --expired` | **영구 삭제 — 사용자가 의도적으로 호출할 때만** |

## 불변 원칙

- **백그라운드 = 검출·압축·보고만.** 자동 삭제 절대 없음 (보존 우선 directive 정합).
- **만료 처리 = 자동 압축**(디스크 절약, 비파괴)까지만. **삭제는 첫 세션 진입 때 권한 유저가 결정** —
  `SessionStart` hook(`quarantine-notice.js`)이 `pending_notice` 를 surface → AI 가 유저에게 질의 →
  유저 승인 시 `purge`(삭제) / `extend`(연장) / `restore`(복원).
- 기본 보관기간 = **3개월**, 만료 시 **자동 압축**(둘 다 격리 시 사용자가 바꿀 수 있음).

## git 추적

- `quarantine/` 실물(격리된 자산)은 **gitignore** — 죽은 골격으로 repo 안 불린다.
- `quarantine/MANIFEST.json` + 이 `README.md` 만 **추적** → 컨텍스트가 "백업 자산이 있었다"를 항상 안다.
- 격리는 `git rm --cached` 라 **이력은 git history 에 잔존**(완전 복구 가능). purge 해도 history 는 남는다.
