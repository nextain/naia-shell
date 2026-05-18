---
name: verify-browser-panel
description: Browser 패널(#102) 핵심 불변식 검증. setPendingApproval invoke-before-set, clearPendingApproval/finishStreaming/newConversation 대칭 show 패턴, E2E mock browser_check 명령 정확성 확인. Browser 패널 및 chat store 관련 파일 변경 후 사용.
---

# Browser Panel 검증

## 목적

#102에서 추가된 browser panel keepAlive + modal 타이밍 + toolbar 구현의 핵심 불변식을 검증합니다:

1. **setPendingApproval invoke-before-set** — `set()` 이전에 `browser_wv_hide` invoke (모달 앞에 WebView2 숨김 보장)
2. **clearPendingApproval guard** — `get().pendingApproval &&` guard 후 `browser_wv_show` (null 상태에서 show 발화 방지)
3. **finishStreaming show** — `pendingApproval` guard 후 `browser_wv_show` 호출 (set() 이전)
4. **newConversation show** — `pendingApproval` guard 후 `browser_wv_show` 호출 (set() 이전)
5. **E2E mock browser_check** — `browser_check` 명령 mock (browser_check_available 아님)

## When to Run

- `shell/src/stores/chat.ts` 수정 후
- `shell/src/panels/browser/` 수정 후
- `shell/e2e-tauri/specs/browser-panel.spec.ts` 수정 후
- pendingApproval 관련 로직 변경 후

## Related Files

| File | Purpose |
|------|---------|
| `shell/src/stores/chat.ts` | setPendingApproval, clearPendingApproval, finishStreaming, newConversation |
| `shell/src/stores/panel.ts` | activePanel 초기값 ("browser") |
| `shell/src/panels/browser/index.tsx` | keepAlive: true 설정 |
| `shell/e2e-tauri/specs/browser-panel.spec.ts` | E2E mock browser_check 명령 (optional) |
| `shell/e2e-tauri/specs/92-browser-panel-clicks.spec.ts` | 클릭 차단 회귀 E2E 테스트 |
| `shell/src/styles/global.css` | pointer-events 불변식 (L6417~6426) |

## Workflow

### Step 1: setPendingApproval invoke-before-set 검증

**파일:** `shell/src/stores/chat.ts`

**검사:** `invoke("browser_wv_hide")` 가 `set({ pendingApproval: approval })` 보다 앞에 있는지 확인.

```bash
grep -n "browser_wv_hide\|pendingApproval: approval\|set.*pendingApproval" shell/src/stores/chat.ts
```

**PASS:** `invoke("browser_wv_hide")` 줄 번호 < `set({ pendingApproval` 줄 번호.
**FAIL:** 순서 역전 → React 렌더 후 invoke → 1프레임 동안 Chrome이 모달 위에 남음.

수정: `invoke("browser_wv_hide").catch(() => {})` 를 `set({ pendingApproval: approval })` 이전으로 이동.

### Step 2: clearPendingApproval guard 검증

**파일:** `shell/src/stores/chat.ts`

**검사:** `clearPendingApproval` 내 `browser_wv_show` 호출 전에 `get().pendingApproval &&` 가드가 있는지 확인.

```bash
grep -A 5 "clearPendingApproval" shell/src/stores/chat.ts
```

**PASS:** `if (get().pendingApproval && usePanelStore.getState().activePanel === "browser")` 조건 후 show 호출.
**FAIL:** guard 없음 → pendingApproval이 null일 때도 show 호출 → hide 없이 show 발화.

수정: `if (get().pendingApproval && ...)` 조건으로 show 호출 래핑.

### Step 3: finishStreaming show 검증

**파일:** `shell/src/stores/chat.ts`

**검사:** `finishStreaming` 내 `pendingApproval` 변수가 `get()`에서 추출되고, `browser_wv_show` 가 `set(...)` 이전에 호출되는지 확인.

```bash
grep -n "pendingApproval\|browser_wv_show\|isStreaming" shell/src/stores/chat.ts | grep -A2 -B2 "browser_wv_show"
```

**PASS:** `const { ..., pendingApproval } = get()` 에서 추출 + `if (pendingApproval && activePanel === "browser") invoke("browser_wv_show")` 가 `set(...)` 이전에 위치.
**FAIL:** 누락 → 스트림 오류 종료 시 Chrome이 모달 뒤에 영구 숨김.

### Step 4: newConversation show 검증

**파일:** `shell/src/stores/chat.ts`

**검사:** `newConversation` 내 `browser_wv_show` 가 `set({ sessionId: null, ... })` 이전에 호출되는지 확인.

```bash
grep -n "browser_wv_show\|newConversation\|sessionId: null" shell/src/stores/chat.ts
```

**PASS:** `if (get().pendingApproval && ...)` guard 후 show 호출이 set() 앞에 위치.
**FAIL:** 누락 또는 set() 이후 → 새 대화 시작 시 Chrome이 숨겨진 채로 남음.

### Step 5: E2E mock browser_check 명령 검증

**파일:** `shell/e2e-tauri/specs/browser-panel.spec.ts` (파일 없으면 SKIP)

**검사:** mock에 `browser_check` 명령이 `true` 를 반환하도록 등록되어 있는지 확인. `browser_check_available` 는 실제 Rust 명령이 아님.

```bash
grep -n "browser_check" shell/e2e-tauri/specs/browser-panel.spec.ts 2>/dev/null || echo "SKIP (file not found)"
```

**PASS:** `if (cmd === "browser_check") return true;` 존재, `browser_check_available` 없음.
**FAIL:** `browser_check_available` 사용 → mock이 `undefined` 반환 → 패널이 "no-chrome" 상태에 고착.

수정: `browser_check_available` → `browser_check` 로 수정.

### Step 6: CSS pointer-events 불변식 검증 (클릭 차단 회귀 방지)

**파일:** `shell/src/styles/global.css`

**배경:** HRESULT(0x8007139F) race → status="error" → `.browser-panel__overlay--error` 렌더 →
`pointer-events:auto` 였을 때 비활성 browser 슬롯이 모든 패널 클릭 차단.
모든 슬롯이 `position:absolute;inset:0` 으로 스택 → 비활성 슬롯도 클릭 인터셉트 가능.

**검사 1:** `.browser-panel__overlay--error` 에 unconditional `pointer-events:auto` 없음.

```bash
grep -n "browser-panel__overlay--error" shell/src/styles/global.css
```

**PASS:** `.browser-panel__overlay--error` 블록에 `pointer-events: auto` 없거나, 있으면 반드시 `.content-panel__slot--active` 하위에만 있음.
**FAIL:** `.browser-panel__overlay--error { pointer-events: auto }` 가 단독 규칙으로 존재.

**검사 2:** `.content-panel__slot--active .browser-panel__overlay--error` 규칙 존재.

```bash
grep -n "content-panel__slot--active .browser-panel__overlay--error" shell/src/styles/global.css
```

**PASS:** 해당 선택자가 존재하며 `pointer-events: auto` 포함.
**FAIL:** 규칙 없음 → active 슬롯에서도 에러 오버레이 클릭 불가 (버튼 무반응).

**검사 3:** E2E 회귀 테스트 `92-browser-panel-clicks.spec.ts` 존재.

```bash
ls shell/e2e-tauri/specs/92-browser-panel-clicks.spec.ts
```

**PASS:** 파일 존재.
**FAIL:** 파일 없음 → 회귀 자동 감지 불가.

## Output Format

```markdown
## verify-browser-panel 검증 결과

| 검사 | 상태 | 상세 |
|------|------|------|
| setPendingApproval invoke-before-set | PASS/FAIL | ... |
| clearPendingApproval guard | PASS/FAIL | ... |
| finishStreaming show | PASS/FAIL | ... |
| newConversation show | PASS/FAIL | ... |
| E2E browser_check 명령 | PASS/FAIL | ... |
| CSS: error overlay no unconditional auto | PASS/FAIL | ... |
| CSS: active-slot scoped auto rule exists | PASS/FAIL | ... |
| E2E 92-browser-panel-clicks.spec.ts 존재 | PASS/FAIL | ... |
```

## 예외사항

다음은 **문제가 아닙니다**:

1. **invoke catch(() => {})** — `browser_wv_hide`/`browser_wv_show`의 에러 무시는 의도된 동작 (Tauri IPC 실패 시 조용히 넘어감, UI는 계속 동작)
2. **finishStreaming 내 get() 스냅샷** — `const { ..., pendingApproval } = get()` 후 `set()`에서 `pendingApproval: null` — JS 싱글스레드이므로 중간 상태 변이 없음, 이중 발화 없음
3. **activePanel === "browser" 초기값** — `panel.ts:21` 에서 `activePanel: "browser"` 로 초기화됨, E2E 테스트 전제 유효
4. **ChatPanel pendingApproval useEffect 부재** — 의도적으로 제거됨 (초기 마운트 시 null→show 오발화 방지). store action이 직접 처리
