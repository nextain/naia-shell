# 웹 IR 키오스크 공개 지식 원고 출처 표 (번들 제외)

`packages/shell/src/lib/kiosk-demo/knowledge/*.md` 21개 원고의 정본 출처 문서 목록입니다. 사내 경로·이름이 웹 번들(`kb.json` 및 `dist/`)에 포함되지 않도록 원고 본문 밖의 별도 문서로 관리합니다.

| 원고 파일 | 정본 근거 문서 |
|---|---|
| `adk.md` | `project_company_brand_line_20261020.md`, `docs/common/alpha/ir-gyeonggi-proofs-20261104.md`, `hub_naia_product_vision.md` |
| `agents.md` | `project_company_brand_line_20261020.md`, `docs/common/alpha/bluecollar-ir-merged-20261028.md` |
| `ax.md` | `project_company_brand_line_20261020.md`, `docs/common/alpha/ir-gyeonggi-proofs-20261104.md` |
| `brand.md` | `project_company_brand_line_20261020.md` |
| `character.md` | `project_company_brand_line_20261020.md`, `docs/common/alpha/ir-gyeonggi-update-20261102.md` |
| `company.md` | `project_company_brand_line_20261020.md` |
| `container.md` | `docs/common/naia/web-status-20261105.md`, `docs/common/naia/web-ir-demo-scope-20261105.md` |
| `desktop.md` | `project_naia_shell_web_first_memory_ownership_20261031.md`, `docs/common/alpha/ir-gyeonggi-proofs-20261104.md`, `docs/common/naia/web-status-20261105.md` |
| `difference.md` | `project_naia_shell_web_first_memory_ownership_20261031.md`, `docs/common/alpha/ir-challenge-qa-20261102.md` |
| `future.md` | `docs/common/alpha/ir-gyeonggi-proofs-20261104.md`, `docs/common/alpha/ir-challenge-qa-20261102.md`, `docs/common/naia/web-status-20261105.md` |
| `growth.md` | `docs/common/alpha/ir-gyeonggi-proofs-20261104.md`, `docs/common/alpha/ir-gyeonggi-update-20261102.md` |
| `harness.md` | `docs/common/alpha/ir-gyeonggi-proofs-20261104.md`, `docs/common/alpha/bluecollar-ir-merged-20261028.md` |
| `limits.md` | `docs/common/alpha/ir-challenge-qa-20261102.md`, `docs/common/alpha/ir-gyeonggi-proofs-20261104.md`, `docs/common/naia/web-ir-demo-scope-20261105.md` |
| `marketing.md` | `docs/common/alpha/bluecollar-ir-merged-20261028.md`, `docs/common/naia/regular-schedule-marketing.md` |
| `memory.md` | `project_naia_shell_web_first_memory_ownership_20261031.md`, `docs/common/alpha/ir-gyeonggi-proofs-20261104.md` |
| `migration.md` | `docs/common/alpha/ir-gyeonggi-proofs-20261104.md`, `docs/common/naia/web-status-20261105.md`, `project_naia_shell_web_first_memory_ownership_20261031.md` |
| `milestones.md` | `docs/common/alpha/ir-gyeonggi-proofs-20261104.md`, `docs/common/naia/web-status-20261105.md`, `docs/common/alpha/bluecollar-ir-merged-20261028.md` |
| `naia.md` | 기존 공개 원고(`company.md`, `difference.md`, `web.md`, `desktop.md`, `container.md`, `character.md`, `memory.md`) 재조합 — 정본: `project_company_brand_line_20261020.md`, `project_naia_shell_web_first_memory_ownership_20261031.md`, `docs/common/alpha/ir-challenge-qa-20261102.md`, `docs/common/alpha/ir-gyeonggi-proofs-20261104.md`, `docs/common/alpha/ir-gyeonggi-update-20261102.md`, `docs/common/naia/web-status-20261105.md`, `docs/common/naia/web-ir-demo-scope-20261105.md` |
| `smallbusiness.md` | `docs/common/alpha/bluecollar-ir-merged-20261028.md` |
| `transparency.md` | `docs/common/alpha/ir-gyeonggi-proofs-20261104.md`, `docs/common/alpha/ir-challenge-qa-20261102.md` |
| `web.md` | `project_naia_shell_web_first_memory_ownership_20261031.md`, `docs/common/naia/web-status-20261105.md`, `docs/common/naia/web-ir-demo-scope-20261105.md` |

## 2026-11-06 보강 — "나이아 서비스 소개"(`naia.md`) 추가 및 기본 정의 질의 개선

- **배경**: 실주소 시험에서 `"나이아는 어떤 서비스인가요? 한두 문장으로 알려 주세요."` 질문에 나이아 자체를 정의하는 독립 카드가 없어 `difference.md`(차별점)가 반환되고, 모델이 이를 직접 답으로 보지 않아 포기하는 현상과 `"나이아란?"` 질의에서 조사 `"란"`·`"이란"` 미분리로 검색 적중이 0이 되는 문제를 확인했습니다.
- **조치**:
  1. `naia.md`(`# 나이아 서비스 소개`)를 새로 추가하되 새 사실·수치를 지어내지 않고 기존 공개 원고(`company.md`, `difference.md`, `web.md`, `desktop.md`, `container.md`, `character.md`, `memory.md`)의 검증된 문장만 엮어 작성했습니다.
  2. `kb-compiler/core/text.ts`의 `JOSA` 정규식에 `이란|란`을 추가해(앞 어간 길이 2 이상 조건 유지) `"나이아란"`이 `"나이아"`로 어간 분리되도록 고쳤습니다.
  3. `KIOSK_DEMO_PERSONA`에 지식 검색 결과가 질문과 맞지 않으면 다른 낱말로 한 번 더 찾은 뒤 답한다는 안내를 추가했습니다(기존 지어내지 않는다는 규칙 유지).
  4. `eval-questions.json`에 `"나이아는 어떤 서비스인가요?"`와 `"나이아란?"` 두 문항을 추가해 총 22문항·21개 카드로 `kb.json`을 재컴파일했습니다.

