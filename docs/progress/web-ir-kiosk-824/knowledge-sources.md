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
4. **음성 상태 표시·공급자 선택 일관성 (`Naia Cloud TTS` 기본 + 브라우저 대체)**: 키오스크 판(`isKioskDemo()`) 기본 말하기를 `Naia Cloud TTS`(`ttsProvider: "nextain"`, 목소리 `"ko-KR-SunHi:DragonHDLatestNeural"`, 시연 열쇠로 게이트웨이 `POST /v1/audio/speech` 호출)로 두며, 프로필 탭과 음성 탭 모두에서 `Naia Cloud TTS`와 `"브라우저 음성 합성"`(`"browser"`)을 고를 수 있고 같은 값을 표시합니다. 게이트웨이 TTS 실패 시에는 브라우저 음성(`speechSynthesis`)으로 자동 대체하며, 웹/키오스크 판에서 `"naia-local-voice : 시동중 .."` 배지는 표시하지 않습니다.
5. **파일 탐색기 탭·문구 정리**: `WebWorkspace.tsx`에서 `"온라인 (준비 중)"` 단추를 제거하고, `locales/ko.ts`의 `"webExplorer.offline"` 문구를 `"브라우저 안 오프라인 공간"`으로 풀어 씁니다.
6. **파일 탐색기 내부 규칙 파일 숨김·제거**: 키오스크 판(`isKioskDemo()`)에서 `.agents`, `.users`, `naia-settings`, `CLAUDE.md`, `GEMINI.md`, `AGENTS.md`, `README.md`, `agents-rules*` 등 ADK 내부 규칙 파일을 파일 탐색기 목록·파일 읽기(`WebWorkspace.tsx`, `web-workspace-files.ts`)와 키오스크 웹 빌드 번들(`vite.config.ts`, `web-adk-bundle.mjs`, `web-adk.ts`)에서 숨기거나 제외하고 시연용 파일(`kiosk-demo/knowledge/*.md`, `conversations` 등)만 보이게 합니다.
7. **키오스크 판 `"지식"` 탭 제공, 마크다운 렌더링 및 미리보기 제목 한 줄 정돈**: 상단 앱 막대(`AppBar.tsx` / `workspace`)와 설정(`SettingsTab.tsx` → `KnowledgeSettingsTab.tsx`)에서 `"지식"` 탭을 열어 시연 지식 묶음(`knowledge/*.md` 21개 원고 목록·본문)을 열람할 수 있게 하며, 설정 > 지식 탭 오른쪽 원고 본문도 탐색기 뷰어와 동일하게 마크다운(`MarkdownPreview`)으로 렌더링하고 목록 폭 축소 및 미리보기 제목·머리줄 글자 크기 조정으로 `"나이아 서비스 소개"` 등이 한 줄에 표시되게 합니다.
8. **오른쪽 파일 뷰어 폭 확장·대화창 비겹침·한 줄 경로·도구줄 잘림 방지**: 파일을 열면 탐색기 영역(`.app-layout:has(.content-app__slot--active .web-workspace-viewer)`)을 `left: max(38vw, var(--naia-width, 520px))`로 배치해 `1920×1080`에서는 화면 폭의 62%(`left: 38vw`) 모양을 그대로 유지하고 `1280×720`에서는 왼쪽 대화창(`right: 504px`)과 겹치지 않게 남는 자리(`left: 520px`)를 쓰도록 하며, 상단 경로 막대와 편집기 도구줄은 파일 이름만 한 줄(말줄임)로 표시해 줄바꿈이나 `"op…"` 잘림이 생기지 않게 합니다.
9. **탐색기 열기/닫기 시 아바타·대화창 위치 고정, 대화창 상단 잘림 제거 및 배경 불투명도 강화**: `KioskDemoGate.css`에서 앱 슬롯 활성 여부에 따라 `--nva-center-offset: 16vw`로 바뀌던 규칙을 제거해 아바타와 대화창이 항상 왼쪽 같은 자리에 머물도록 고정하고, `.chat-messages`의 고정 `min-height: 280px`를 `min-height: 0; flex: 1 1 0;`으로 바로잡아 대화창 위쪽 헤더(`.chat-header` 탭·단추)나 아래쪽 입력창이 잘리지 않게 하며, 대화창(`.naia-chat-wrapper`) 배경을 `rgba(20, 24, 34, 0.94)`(`saturate(110%)`)로 높여 지나의 진한 빨간 치마가 반투명 배경 뒤로 번져 보라색 얼룩처럼 보이지 않게 합니다.
10. **지나 캐릭터 머리 빈 곳·팔/다리 사이 검은 영역·클립 전환 시 크기/발 위치 일치**:
    - `idle.webm`·`talking-ko.webm`(및 `.stacked.mp4`): `studio_nva_matting.py` 경계 정제 단계(`_refine_edges_in_box`)에서 검은 머리카락(`RGB ≈ [15,17,18]`)이 남색 배경(`RGB ≈ [1,21,33]`)과의 유클리드 거리 `< 22`로 판정되어 오른쪽 윗머리(`y=60..100, x=380..415`)와 목 옆이 파여 보이던 원인을 찾아, 중립 어두운 머리카락(`B - R < 10`, `u2net seed >= 110`) 알파를 보존해 클립을 재생성했습니다.
    - `motion.webm`(및 `.stacked.mp4`, `"부드러운 움직임"`): `idle.webm`과 동일한 캐릭터 크기·머리 비율·발 위치(`ymax = 1241`)를 유지하도록 정합하고 하체·발 위치를 고정한 채 상체 호흡·스웨이만 반영해, 대기(`idle`)에서 `"부드러운 움직임"`(`motion`)으로 바뀔 때 크기나 발 위치가 튀지 않으면서 부드러운 움직임 세기는 유지되도록 맞췄습니다.



