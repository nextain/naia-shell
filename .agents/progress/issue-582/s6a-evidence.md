# S6a 증거 — 셸 도구·권한·기능 플래그 (#582)

작성 2026-09-10. 계약: `docs/progress/issue-582-ego-browser-host.md` 3절 4번·4.9·7절 P04·9절 S6a.
worktree `/var/home/luke/alpha-adk/.worktrees/naia-shell-582-ego-host`, 브랜치 `feat/582-ego-browser-host`.

## 1. 무엇을 만들었나

| 파일 | 무엇 | 줄 |
|---|---|---|
| `packages/shell/src/lib/browser-host-skill.ts` | 새 파일. 도구 선언 12개·기능 플래그·조립·승인 장부·실행기·결과 카드 조립 | 신규 |
| `packages/shell/src/components/BrowserHostResult.tsx` | 새 파일. 증거 카드 렌더와 거부 사유→복구 안내 매핑 | 신규 |
| `packages/shell/src/lib/__tests__/browser-host-skill.test.ts` | 새 파일. vitest 22건 | 신규 |
| `packages/shell/e2e/env-tool-browser-host.spec.ts` | fixme 3건 골격 → 실제 7건 | +343 |
| `packages/shell/src/components/ToolActivity.tsx` | 브라우저 호스트 결과를 카드로 넘기는 분기 | +20 |
| `packages/shell/src/components/ChatArea.tsx` | `dispatchAppToolCall` 의 전용 분기 | +45 |
| `packages/shell/src/App.tsx` | 상시 표면 등록 | +10 |
| `packages/shell/src/lib/config.ts` | `egoHostEnabled?: boolean` 설정 키 | +6 |
| `packages/shell/src/styles/global.css` | 카드 스타일과 1,100px 이하 접힘 | +185 |
| `src/main/composition/index.ts` | 셸이 쓸 타입·상수 재노출(`EnvOperationRequest`·`ElementTarget`·`BROWSER_RPC_TIERS` 등) | +15 |

## 2. 공유 파일에 넣은 정확한 hunk

다른 세션이 같은 파일을 고치는 중이라 **새 모듈을 부르는 최소 줄만** 넣었다. 새 함수 정의는 없다.

### `packages/shell/src/App.tsx` — 10줄 (import 1 + 등록 9)

```
+import { BROWSER_HOST_APP_ID, browserHostTools } from "./lib/browser-host-skill";
```

`refreshEnvironment().catch(() => {});` 로 끝나는 `if ((loadConfig()?.environmentAwareness ?? "auto") !== "off")` 블록 **바로 뒤**, `const all = appRegistry.list();` **바로 앞**:

```
+		// #582 S6a (FR-ENV-TOOL.13): 에이전트 브라우저 호스트도 상시 표면이다. 목록이 비면
+		// 기능 플래그가 꺼진 OS 라는 뜻이고, 그때는 **등록하지 않는다** — 뇌가 보지 못한다.
+		// 판정·조립·실행은 전부 lib/browser-host-skill.ts 에 있다.
+		const browserHost = browserHostTools();
+		if (browserHost.length > 0) {
+			sendAppSkills(BROWSER_HOST_APP_ID, [...browserHost]).catch((err) =>
+				Logger.warn("App", "startup browser host skills failed", { error: String(err) }),
+			);
+		}
```

### `packages/shell/src/components/ChatArea.tsx` — 45줄 (import 5 + 분기 40)

`dispatchAppToolCall` 안, `if (req.toolName === SKILL_ENVIRONMENT.name) {` **바로 앞**에 분기 하나. 몸통은
`executeBrowserHostSkill` 호출과 결과 전달뿐이고 판정·등급·승인은 전부 코어 서비스가 한다.
(ChatArea.tsx 는 브리프의 충돌 주의 목록에 없지만 같은 규율로 최소화했다.)

### `packages/shell/src/components/ToolActivity.tsx` — 20줄

`const icon = STATUS_ICON[tool.status];` 뒤에 카드 분기 하나(`browserHostCardFor` 가 null 이면 기존 렌더로 폴백).

### `packages/shell/src/lib/config.ts` — 6줄

`environmentAwareness?: EnvironmentAwareness;` 뒤에 `egoHostEnabled?: boolean;` 과 주석.

### `src/main/composition/index.ts` — 15줄

`export { EnvironmentToolService } …` 뒤에 **재노출 줄만**. 새 함수·로직 없음. 셸이 요청 객체를 만들려면
`EnvOperationRequest`·`ElementTarget`·`CapabilityTier`·`BROWSER_RPC_TIERS` 가 필요한데 조립 index 가
그것들을 내보내지 않았다.

## 3. 계약이 요구한 것과 실제

| 계약 | 실제 |
|---|---|
| 상시 표면 `BROWSER_HOST_APP_ID = "browser-host"` 로 12개 도구를 `sendAppSkills` 등록 | 그대로. e2e (A) 가 실 UI 에서 12개를 센다 |
| 도구 호출은 `EnvironmentToolService` 를 **거쳐서만** | 실행기가 서비스 메서드만 부른다. 어댑터·감독자를 직접 부르는 길이 없다 |
| 등급·승인은 서비스가 정하고 셸은 결과·거부 사유를 그대로 싣는다 | 결과 카드가 `refusals[{code, detail}]` 를 그대로 담고, 뇌에 가는 문자열이 그 카드의 JSON 이다 |
| `addAllowedTool` 자동 우회 금지 | `browser-host-skill.ts`·`BrowserHostResult.tsx` 에 `addAllowedTool` 없음 |
| 기능 플래그 `NAIA_EGO_HOST`(env) 또는 설정값, 기본은 리눅스 켬·win32·darwin 끔 | `browserHostEnabled(platform, source)` — 판정은 코어 `egoHostEnabled` 가 하고 셸은 값만 모은다 |
| 꺼져 있으면 등록하지 않는다 | `browserHostTools()` 가 빈 배열을 돌려주고 App.tsx 가 `length > 0` 일 때만 부른다 |
| 기존 `skill_browser_*` 이름·권한·동작 불변 | 그 파일들을 건드리지 않았다. vitest 와 e2e (D) 가 이름 비충돌과 동작 불변을 확인 |

## 4. 계약과 달랐던 판단

1. **e2e 의 대역 자리는 "어댑터 아래"다.** 셸 웹뷰에는 node 도 감독자도 Chromium 도 없다.
   그래서 `window.__NAIA_BROWSER_HOST_PORTS__` 로 **포트**를 대역으로 바꾼다. 그 위는 전부 실물이다 —
   도구 등록, `app_tool_call` 분기, `EnvironmentToolService` 의 등급표·승인 규칙, 결과 카드.
   감독자와 실 Chromium 을 지나는 경로는 `src/test/env-tool-browser-host.contract.test.ts`(S3a)가
   실 Chromium 으로 이미 돈다. 두 겹이 겹쳐야 "대역만 통과"가 아니다.
   이 자리는 `import.meta.env.DEV` 가 참일 때만 읽는다 — 프로덕션 번들에서는 코드가 보지도 않는다.
2. **웹뷰↔node 다리는 이 슬라이스에서 놓지 않았다.** 플래그가 켜진 리눅스 프로덕션 셸에서 도구를
   부르면 코어 기본 로더가 `packages/ego-host/src/host-api.mjs` 를 동적 import 하려다 실패하고,
   그 실패가 **형식 있는 거부 사유로 그대로** 뇌와 카드에 올라간다(조용한 성공이 아니다).
   다리(Tauri 명령 또는 사이드카)를 놓는 일은 S6a 범위 밖이며 여기 적어 둔다.
   `globalThis.__NAIA_EGO_HOST_API__` 가 있으면 그것을 쓴다(계약 테스트·개발용 자리).
3. **`env_browser_script` 의 승인 UI 는 붙이지 않았다.** 서비스가 `approvalRef` 없는 호출을
   `approval-missing` 으로 **포트 앞에서** 거부하고, 셸은 승인 장부(`grantBrowserHostApproval`)에
   기록이 있을 때만 참조를 싣는다. **셸이 스스로 채우는 길은 없다.** 승인 UI 배선은 별도 작업이다.
   vitest 가 승인 있는 경로(포트까지 감)와 없는 경로(포트 0회)를 둘 다 밟는다.
4. **결과 카드를 새로 만들었다.** 기존 `app_tool_call` 경로는 화면에 아무 자리도 만들지 않는다
   (`tool_call` 청크만 `streamingToolCalls` 에 들어간다). 백그라운드 브라우저는 화면이 없어 사용자가
   직접 볼 수 없으므로, 증거 셋이 유일한 확인 수단이다. 그래서 셸이 스스로 카드를 세운다.
5. **설정 UI 는 붙이지 않았다.** `egoHostEnabled` 키는 읽기만 한다. `SettingsTab.tsx` 는 다른 세션이
   고치는 중이라 브리프가 건드리지 말라고 한 파일이다.
6. **e2e 대역이 `read_naia_config` 를 실제 문자열로 돌려주게 했다.** 그러지 않으면 App 의 설정
   하이드레이션이 실패해 상시 표면 등록 효과 전체가 열리지 않는다. 이것이 기존
   `env-tool-browser.spec.ts` (A) 가 이 기계에서 실패하는 이유이기도 하다(§6 기준선).

## 5. 검증 (전부 종료 코드)

```
$ cd packages/shell && npx vitest run src/lib/__tests__/browser-host-skill.test.ts
  Test Files 1 passed / Tests 22 passed                             EXIT=0

$ cd packages/shell && npx playwright test e2e/env-tool-browser-host.spec.ts
  7 passed (A 등록 12개 · B 증거 카드 · B0 기본 · B2 빈 목록 · B3 진행 · C 거부 · D 기존 불변)
                                                                    EXIT=0

$ cd packages/shell && npx tsc -b --noEmit                           EXIT=0
$ npx tsc -p tsconfig.build.json                                     EXIT=0

$ cd packages/shell && pnpm test        (vitest 전체)
  Test Files 7 failed | 183 passed | 2 skipped (192)
  Tests 48 failed | 1893 passed | 21 skipped (1962)                 EXIT=1
  ↳ 기준선과 **같다**(§6). 같은 명령을 이 변경 없이 돌려 수치가 한 자리도 다르지 않음을 확인했다.

$ pnpm test        (루트)
  Test Files 5 failed | 100 passed | 1 skipped (106)
  Tests 7 failed | 1639 passed | 4 skipped (1650)                    EXIT=1
  ↳ 기준선 7건과 **같은 목록**. 새 실패 0.
```

## 6. 기준선 — 새 실패 0 을 어떻게 확인했나

수치만 비교하면 "우연히 같은 개수"를 놓친다. 그래서 두 번 쟀다.

- **셸 vitest 전체**: 같은 명령을 (1) 이 변경이 있는 상태 (2) `git stash push -- packages/shell/src src/main/composition/index.ts` 로
  변경을 걷어 낸 상태에서 각각 돌렸다. 두 번 다 `7 failed | 183 passed`, `48 failed | 1893 passed`.
- **`ChatArea.test.tsx` 단독**: 변경 전후 모두 `29 failed | 21 passed`. 내가 넣은 분기가 이 실패에 관여하지 않는다.
- **`e2e/env-tool-browser.spec.ts` (A)** 는 이 기계에서 **원래 실패한다.** 변경을 걷어 낸 상태에서도
  같은 지점에서 실패함을 확인했다(2026-09-10). 원인은 그 스펙의 Tauri 대역이 `read_naia_config` 로
  문자열이 아닌 값을 돌려줘 설정 하이드레이션이 실패하고, `descriptor.keepAlive` 등록 효과가
  열리지 않는 것이다. 같은 파일의 (B)(C)(C2)(D) 와 `197-browser-login.spec.ts` 는 통과한다.
  **이 슬라이스가 만든 실패가 아니며 고치지도 않았다** — 다른 세션이 그 파일을 볼 수 있어서다.
- 루트 `pnpm test` 는 `baseline-root-test-20260909.txt` 의 7건과 이름까지 같다.

## 7. 시각·UX 증거 (verify-visual-ux)

`.agents/progress/issue-582/s6a-visual/` — 상태 매트릭스 여섯 칸을 실 UI 에서 찍었다.
전체 화면(`*.png`)과 카드만(`*-card.png`)을 함께 남긴다. 셸 채팅 패널이 좁아 전체 화면에서는
카드가 스크롤에 잘리기 때문이다.

| 상태 | 파일 | 확인한 것 |
|---|---|---|
| 기본 | `00-default.png` | 도구를 부르기 전에는 카드가 없다(0개) |
| 빈 목록 | `01-empty.png` · `01-empty-card.png` | "열려 있는 작업 공간이 없습니다" + 시작 행동. 실패와 구분된다 |
| 진행 | `03-progress.png` · `03-progress-card.png` | 배지 "실행 중", `aria-live="polite"` 인 `<output>` 으로 "증거를 받는 중" |
| 성공 | `02-success.png` · `02-success-card.png` | 주소·개정 4·스냅샷 참조·캡처 경로 셋이 모두 보인다. 배지 "완료" |
| 오류 | `04-error-refused.png` · `04-error-refused-card.png` | `role="alert"`, 코드 `approval-missing` + 설명 + **다음 행동**("승인한 뒤 다시 요청하세요") |
| 좁은 폭 | `05-narrow-900.png` · `05-narrow-900-card.png` | 900px 에서 증거의 이름·값이 두 줄로 접히고 값이 잘리지 않는다 |

정적 검토에서 확인한 것: 상태는 배지(label)로 말하고 raw enum 을 그대로 내놓지 않는다.
거부는 코드만이 아니라 사람이 할 다음 행동을 같은 카드 안에 둔다(`recoveryHint`).
긴 경로·주소는 `overflow-wrap: anywhere` 로 접히고 가로 스크롤을 만들지 않는다.
카드 헤더는 클릭 대상이 아니라 정적 표시다(`tool-activity-header-static`) — 누를 수 없는 것을
단추처럼 보이게 하지 않는다.

## 8. S6b 로 넘긴 것

- 셸(Rust) 소유 런타임 정리에 감독자를 넣는 일.
- 웹뷰↔node 다리(§4-2). S6b 는 Rust 쪽 회수만 다루고, 도구 호출이 실제 감독자에 닿는 통로는
  여전히 어댑터가 node 안에서 도는 조립(계약 테스트)에서만 성립한다.
