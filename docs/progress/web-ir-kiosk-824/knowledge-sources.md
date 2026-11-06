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

## 2026-11-06 3판 1회차 — 대표님 시연 지적 10건 반영 (R3-1)

1. **대화창 도구 입력·출력 원문 JSON 숨김**: `ToolActivity.tsx`에서 `isKioskDemo()`일 때 펼침/접힘 화살표와 `.tool-activity-body`(JSON 인자·출력 원문)를 렌더링하지 않고 한 줄 요약(`"자료 찾는 중"` / `"자료 찾음"`)만 정적으로 표시합니다. `visible-chat-text.ts` `TOOL_DUMP_KEYS`에 `"query"`, `"sourceUris"`를 추가해 본문 유입도 차단합니다(답변 끝 `"근거: …"` 줄은 유지).
2. **시연판 로그아웃 단추 제거**: `SettingsTab.tsx`에서 `isKioskDemo()`일 때 `web-logout-btn`(일반 탭 웹 로그아웃)과 `.lab-disconnect-btn`(프로필 연결 해제)을 렌더링하지 않습니다.
3. **`desktop_only:secure_store_set` 설정 저장 오류 제거**: `secure-store.ts`에서 `isWebMode()` 또는 `opfs://` 경로일 때 Tauri 네이티브 `secure_store_get`/`secure_store_set`/`secure_store_delete` IPC를 호출하지 않고 브라우저 저장소(`localStorage`)로 처리해 설정 저장 시 오류가 뜨지 않게 합니다.
4. **음성 상태 표시·공급자 선택 일관성**: `SettingsTab.tsx`에서 웹/키오스크 판일 때 프로필 슬롯의 `"naia-local-voice : 시동중 .."` 표시를 숨기고, 프로필 탭과 음성 탭 모두에서 실제 사용 가능한 `"브라우저 음성 합성"`(`"browser"`)만 노출·동일 값으로 표시합니다.
5. **파일 탐색기 탭·문구 정리**: `WebWorkspace.tsx`에서 `"온라인 (준비 중)"` 단추를 제거하고, `locales/ko.ts`의 `"webExplorer.offline"` 문구를 `"브라우저 안 오프라인 공간"`으로 풀어 씁니다.
6. **파일 탐색기 내부 규칙 파일 숨김·제거**: 키오스크 판(`isKioskDemo()`)에서 `.agents`, `.users`, `naia-settings`, `CLAUDE.md`, `GEMINI.md`, `AGENTS.md`, `README.md`, `agents-rules*` 등 ADK 내부 규칙 파일을 파일 탐색기 목록·파일 읽기(`WebWorkspace.tsx`, `web-workspace-files.ts`)와 키오스크 웹 빌드 번들(`vite.config.ts`, `web-adk-bundle.mjs`, `web-adk.ts`)에서 숨기거나 제외하고 시연용 파일(`kiosk-demo/knowledge/*.md`, `conversations` 등)만 보이게 합니다.
7. **키오스크 판 `"지식"` 탭 제공**: 상단 앱 막대(`AppBar.tsx` / `workspace`)와 설정(`SettingsTab.tsx` → `KnowledgeSettingsTab.tsx`)에서 `"지식"` 탭을 열어 시연 지식 묶음(`knowledge/*.md` 21개 원고 목록·본문)을 바로 열람할 수 있게 합니다.
8. **오른쪽 파일 뷰어 폭 확장 및 드래그 조절**: `web-mode.css`에서 `.herdr-workspace__files`의 `flex: 1 1 55%` 상속을 덮어써 왼쪽 트리 기본 폭을 줄이고 오른쪽 뷰어(`.web-workspace-viewer`)가 화면 절반 가까이 넓게 나오도록 하며, 트리와 뷰어 사이에 드래그 분할 막대(`.web-workspace-resizer`)를 추가해 폭을 조절할 수 있게 합니다.
9. **탐색기 열기/닫기 시 아바타·대화창 위치 고정**: `KioskDemoGate.css`에서 앱 슬롯 활성 여부에 따라 `--nva-center-offset: 16vw`로 바뀌던 규칙을 제거해 탐색기나 설정을 열고 닫아도 아바타와 대화창이 항상 왼쪽 같은 자리에 일관되게 머물도록 고정합니다.
10. **지나 캐릭터 머리 빈 곳·팔/다리 사이 검은 영역·부드러운 움직임 개선**:
    - `idle.webm`·`talking-ko.webm`(및 `.stacked.mp4`): `studio_nva_matting.py` 경계 정제 단계(`_refine_edges_in_box`)에서 검은 머리카락(`RGB ≈ [15,17,18]`)이 남색 배경(`RGB ≈ [1,21,33]`)과의 유클리드 거리 `< 22`로 판정되어 오른쪽 윗머리(`y=60..100, x=380..415`)와 목 옆이 파여 보이던 원인을 찾아, 중립 어두운 머리카락(`B - R < 10`, `u2net seed >= 110`) 알파를 보존해 클립을 재생성했습니다.
    - `motion.webm`(및 `.stacked.mp4`, `"부드러운 움직임"`): S4 후처리가 누락되어 오른팔-허리 사이와 다리 사이에 원본 남색 배경(`#00131f`, `alpha=255`)이 그대로 남아 검게 보이던 원인을 찾아 남색 배경 포켓을 완전 투명화하고 자연스러운 호흡·스웨이를 반영해 재생성했습니다.
    - `public/nva/jina/manifest.json`에 `"motion"` 파라미터를 추가하고 `prebaked-renderer.ts`에서 동작(`playAction`) 재생 중 절차적 호흡·스웨이 진폭을 키워 `"부드러운 움직임"` 실행 시 움직임이 분명하게 보이도록 개선했습니다.


