# naia-web-wo-01 작업 보고서

## 1. 커밋 sha 목록

- `44c372ead52578e9ef90f79d31777b503c0ee53d` (feat(web-runtime): add web build scripts and tauri ipc router)

## 2. 바꾼 파일 목록

- `packages/shell/package.json`
- `packages/shell/src/main.tsx`
- `packages/shell/src/lib/web-runtime/auto-install.ts`
- `packages/shell/src/lib/web-runtime/command-table.ts`
- `packages/shell/src/lib/web-runtime/event-bus.ts`
- `packages/shell/src/lib/web-runtime/install.ts`
- `packages/shell/src/lib/web-runtime/router.ts`
- `packages/shell/src/lib/web-runtime/__tests__/command-table.test.ts`
- `packages/shell/src/lib/web-runtime/__tests__/event-sdk.test.ts`
- `packages/shell/src/lib/web-runtime/__tests__/router.test.ts`
- `packages/shell/e2e/web-runtime-boot.spec.ts`
- `.agents/progress/naia-web-wo-01-report.md`

## 3. 분류표의 명령 수

- `web`: 3개
  - `plugin:event|listen`
  - `plugin:event|unlisten`
  - `plugin:event|emit`
- `stub`: 25개
  - `plugin:store|load`
  - `plugin:store|get`
  - `plugin:store|set`
  - `plugin:store|delete`
  - `plugin:store|save`
  - `plugin:store|has`
  - `plugin:store|entries`
  - `plugin:window|show`
  - `plugin:window|inner_size`
  - `plugin:window|get_cursor_position`
  - `plugin:window|start_resize_dragging`
  - `plugin:app|version`
  - `plugin:updater|check`
  - `plugin:dialog|open`
  - `plugin:dialog|save`
  - `plugin:dialog|message`
  - `plugin:dialog|ask`
  - `plugin:dialog|confirm`
  - `plugin:opener|open_url`
  - `plugin:opener|open_path`
  - `plugin:deep-link|get_current`
  - `plugin:process|exit`
  - `plugin:process|restart`
  - `frontend_log`
  - `read_naia_config`
- `desktop-only`: 136개
  - `packages/shell/src` 비시험 파일 추출 명령 138개 중 `frontend_log`, `read_naia_config`를 제외한 136개
- 전체 명령 수: 164개

## 4. 4.2-3 규칙으로 stub 에 옮긴 명령과 근거 tauri-base-mock.ts 줄 번호

- `plugin:store|load`: 줄 46 (`return 1`)
- `plugin:store|get`: 줄 47 (`return [null, false]`)
- `plugin:store|set`: 줄 48 (`return null`)
- `plugin:store|delete`: 줄 48 (`return null`)
- `plugin:store|save`: 줄 48 (`return null`)
- `plugin:store|has`: 줄 48 (`return null`)
- `plugin:store|entries`: 줄 48 (`return null`)
- `plugin:window|show`: 줄 50 (`return null`)
- `plugin:window|inner_size`: 줄 50 (`return null`)
- `plugin:window|get_cursor_position`: 줄 50 (`return null`)
- `plugin:window|start_resize_dragging`: 줄 50 (`return null`)
- `plugin:app|version`: 줄 51 (`return "0.1.3"`)
- `plugin:updater|check`: 줄 52 (`return null`)
- `plugin:dialog|open`: 줄 53 (`return null`)
- `plugin:dialog|save`: 줄 53 (`return null`)
- `plugin:dialog|message`: 줄 53 (`return null`)
- `plugin:dialog|ask`: 줄 53 (`return null`)
- `plugin:dialog|confirm`: 줄 53 (`return null`)
- `plugin:opener|open_url`: 줄 54 (`return null`)
- `plugin:opener|open_path`: 줄 54 (`return null`)
- `plugin:deep-link|get_current`: 줄 55 (`return []`)
- `plugin:process|exit`: 줄 56 (`return null`)
- `plugin:process|restart`: 줄 56 (`return null`)
- `frontend_log`: 줄 58 (`return null`)
- `read_naia_config`: 줄 72 (`return null`)

※ e2e 실행 중 `pageerror`가 발생한 `secure_store_get`은 `tauri-base-mock.ts`에 정의되어 있지 않아 4.2-3 규칙("mock 에 없으면 옮기지 않고")에 따라 `stub`에 옮기지 않음.

## 5. 3번 e2e 가 본 첫 화면과 pageerror 메시지 전부

- 첫 화면 관측 내용:
  - `[data-app-ready="true"]` 요소 부착 확인 (충족)
  - `.splash-screen` 0개 (스플래시 제거 충족)
  - `.naia-chat-area .chat-input` 화면 노출 확인 (메인 대화 입력창 표시 충족)
  - 렌더링 소요 시간: 4.7초 (10초 이내 충족)
  - 온보딩 화면(`[data-testid="onboarding"]`) 개수: 0 (미표시 충족)
  - ADK 설정 화면(`.adk-setup-screen`) 개수: 0 (미표시 충족)
- `pageerror` 메시지 전부 (4건):
  - `desktop_only:secure_store_get`
  - `desktop_only:secure_store_get`
  - `desktop_only:secure_store_get`
  - `desktop_only:secure_store_get`

## 6. 6절 명령별 종료 코드와 출력 끝 20줄

### 1. 웹 빌드
명령: `pnpm build:web && test -f dist-web/index.html; echo "exit=$?"`
종료 코드: `exit=0`
출력 끝 20줄:
```
dist-web/assets/sequenceDiagram-3UESZ5HK-CaxZ9hVe.js        117.36 kB │ gzip:  31.21 kB
dist-web/assets/SettingsTab-wcrt2KDU.js                     143.46 kB │ gzip:  39.26 kB
dist-web/assets/architectureDiagram-3BPJPVTR-C7kls0RY.js    149.80 kB │ gzip:  42.34 kB
dist-web/assets/katex-C5jXJg4s.js                           261.33 kB │ gzip:  77.57 kB
dist-web/assets/Terminal-CFjKUJQ4.js                        340.53 kB │ gzip:  87.48 kB
dist-web/assets/MarkdownCodeBlock-COYwNEoL.js               352.29 kB │ gzip: 113.21 kB
dist-web/assets/cytoscape.esm-DTSO7Bv0.js                   443.72 kB │ gzip: 142.37 kB
dist-web/assets/index-CPyek44d.js                           546.80 kB │ gzip: 170.98 kB
dist-web/assets/mermaid.core-Jn-_r-k3.js                    592.07 kB │ gzip: 138.33 kB
dist-web/assets/wardley-L42UT6IY-Badf2qT0.js                615.46 kB │ gzip: 148.57 kB
dist-web/assets/AvatarCanvas-DqY2Zsu8.js                    773.27 kB │ gzip: 196.66 kB
dist-web/assets/Editor-BQXrjMZU.js                        1,206.01 kB │ gzip: 407.04 kB

(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.
✓ built in 7.27s
exit=0
```

### 2. 웹 런타임 단위 시험
명령: `pnpm vitest run src/lib/web-runtime; echo "exit=$?"`
종료 코드: `exit=0`
출력 끝 20줄:
```
 RUN  v4.1.8 packages/shell

(node:4073490) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)
(node:4073533) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)
(node:4073597) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)

 Test Files  3 passed (3)
      Tests  5 passed (5)
   Start at  19:00:59
   Duration  836ms (transform 62ms, setup 114ms, import 50ms, tests 29ms, environment 437ms)

exit=0
```

### 3. 웹 첫 화면 e2e
명령: `NAIA_E2E_WEB=1 PLAYWRIGHT_PORT=17421 PLAYWRIGHT_WEB_SERVER_TIMEOUT=180000 PLAYWRIGHT_SERVER_COMMAND="pnpm -w build && pnpm dev:web" pnpm exec playwright test e2e/web-runtime-boot.spec.ts --reporter=list; echo "exit=$?"`
종료 코드: `exit=1`
출력 끝 20줄:
```
  1) [chromium] › e2e/web-runtime-boot.spec.ts:8:1 › boots into main screen within 10s without uncaught page errors in web mode

    Error: Unexpected page errors during boot:
    desktop_only:secure_store_get
    desktop_only:secure_store_get
    desktop_only:secure_store_get
    desktop_only:secure_store_get

    expect(received).toHaveLength(expected)

    Expected length: 0
    Received length: 4
    Received array:  [[Error: desktop_only:secure_store_get], [Error: desktop_only:secure_store_get], [Error: desktop_only:secure_store_get], [Error: desktop_only:secure_store_get]]

      45 | 		pageErrors,
      46 | 		`Unexpected page errors during boot:\n${pageErrors.map((e) => e.message || String(e)).join("\n")}`,
    > 47 | 	).toHaveLength(0);
         | 	  ^
      48 |
      49 | 	// Neither onboarding nor ADK setup screen should be visible
      50 | 	const onboardingCount = await page
        at packages/shell/e2e/web-runtime-boot.spec.ts:47:4

    Error Context: test-results/web-runtime-boot-boots-int-54623-ght-page-errors-in-web-mode-chromium/error-context.md

  1 failed
    [chromium] › e2e/web-runtime-boot.spec.ts:8:1 › boots into main screen within 10s without uncaught page errors in web mode
exit=1
```

### 4. 데스크톱 산출물 오염 검사
명령: `pnpm build && test -d dist && { grep -rq naia-web-runtime dist/; rc=$?; test "$rc" -eq 1; }; echo "exit=$?"`
종료 코드: `exit=0`
출력 끝 20줄:
```
PASS deferred module src/components/AnnouncementBanner.tsx: assets/AnnouncementBanner-t2RjJhDz.js
PASS deferred module src/components/AdkSetupScreen.tsx: assets/AdkSetupScreen-Ghs8fFnP.js
PASS deferred module src/components/AppInstallDialog.tsx: assets/AppInstallDialog-XksMMMyK.js
PASS deferred module src/components/AvatarCanvas.tsx: assets/AvatarCanvas-BSeYp2cX.js
PASS deferred module src/components/AtMentionPopover.tsx: assets/AtMentionPopover-DtnAfHr_.js
PASS deferred module src/components/ChatArea.tsx: assets/ChatArea-D_kJLvHi.js
PASS deferred module src/components/ChatMarkdown.tsx: assets/ChatMarkdown-BDAOUlCE.js
PASS deferred module src/components/OnboardingWizard.tsx: assets/OnboardingWizard-CtMLGmze.js
PASS deferred module src/components/PermissionModal.tsx: assets/PermissionModal-Crj3wwFo.js
PASS deferred module src/components/SettingsTab.tsx: assets/SettingsTab-DN1XTOXm.js
PASS deferred module src/components/ToolActivity.tsx: assets/ToolActivity-B1u-6I3x.js
PASS deferred module src/components/UpdateBanner.tsx: assets/UpdateBanner-ChORvpHx.js
PASS deferred module src/components/UpdatePrompt.tsx: assets/UpdatePrompt-BEE-b6Zj.js
PASS deferred module src/components/VideoAvatarCanvas.tsx: assets/VideoAvatarCanvas-7s9bP3au.js
exit=0
```

### 5. 셸 단위 시험 전체
명령: `pnpm test; echo "exit=$?"`
종료 코드: `exit=0`
출력 끝 20줄:
```
(Use `node --trace-warnings ...` to show where the warning was created)
(node:3877832) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)
(node:3877839) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)
(node:3877848) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)

 Test Files  222 passed | 1 skipped (223)
      Tests  2257 passed | 21 skipped (2278)
   Start at  18:34:26
   Duration  72.97s (transform 3.39s, setup 5.50s, import 8.33s, tests 22.77s, environment 19.83s)

exit=0
```

### 6. 기존 데스크톱 e2e 전체
포트 점검:
`ss -ltn | grep -E ':(17420|17421|1421) ' ; echo "port-check=$?"`
출력:
```
port-check=1
```

일반 e2e 실행:
명령: `PLAYWRIGHT_PORT=17420 pnpm exec playwright test; echo "exit-e2e=$?"`
종료 코드: `exit-e2e=1`
통계: 145 passed, 55 failed, 50 skipped, 0 flaky (23.7m)
실패한 시험 55개: 기준선(`naia-web-baseline-shell-e2e-d140dac8.md`)의 55개 목록과 정확히 일치 (기준선 대비 추가 실패 없음)
출력 끝 20줄:
```
    [chromium] › e2e/startup-update-prompt.spec.ts:67:1 › startup update requires consent and Later preserves the existing banner
    [chromium] › e2e/startup-update-prompt.spec.ts:100:1 › one-month deferral hides the same version but not a newer version
    [chromium] › e2e/startup-update-prompt.spec.ts:124:1 › explicit confirmation installs and relaunches
    [chromium] › e2e/store-certification.spec.ts:40:1 › Store reviewer journey keeps a zero-token provider failure actionable
    [chromium] › e2e/tts-fallback.spec.ts:108:2 › TTS keyless fallback (chat path always speaks) › edge → bgm sidecar /edge-tts (real neural path) → audio plays
    [chromium] › e2e/tts-fallback.spec.ts:163:2 › TTS provider path wiring (real module, no mock) › google REST path reaches the API (no CORS/wiring break)
    [chromium] › e2e/uc1-new-core-variants.spec.ts:123:2 › UC1 변종 — 새 core 경유 › 멀티턴: 2번째 turn 의 chat_request 에 이전 대화 history 포함
    [chromium] › e2e/uc13-approval.spec.ts:75:3 › UC13 승인 게이트 — 실 UI outbound › approve(once) → wire approval_response decision 'approve'(vocab 버그 회귀 가드)
    [chromium] › e2e/uc13-approval.spec.ts:83:3 › UC13 승인 게이트 — 실 UI outbound › always → 'approve'
    [chromium] › e2e/uc13-approval.spec.ts:90:3 › UC13 승인 게이트 — 실 UI outbound › reject → 'reject'
    [chromium] › e2e/voxcpm2-local-voice-journey.spec.ts:60:1 › golden journey: local voice ready, default voice present, no error (#453)
  50 skipped
  145 passed (23.7m)
exit-e2e=1
```

Production e2e 실행:
명령: `PLAYWRIGHT_PORT=17420 pnpm exec playwright test --config playwright.production.config.ts; echo "exit-e2e-prod=$?"`
종료 코드: `exit-e2e-prod=0`
통계: 2 passed (19.5s)
출력 끝 20줄:
```
Running 2 tests using 1 worker

(node:4065041) [DEP0205] DeprecationWarning: `module.register()` is deprecated. Use `module.registerHooks()` instead.
(Use `node --trace-deprecation ...` to show where the warning was created)
     1 …a boundary › shows loading, renders chat, and preserves the narrow shell
  ✓  1 …ary › shows loading, renders chat, and preserves the narrow shell (3.0s)     2 …ea boundary › reloads the shell after the first production chunk failure
  ✓  2 …dary › reloads the shell after the first production chunk failure (2.2s)
  2 passed (19.5s)
exit-e2e-prod=0
```

## 7. 막힌 곳과 그 이유

- **막힌 곳**: 3번 웹 첫 화면 e2e 시험(`e2e/web-runtime-boot.spec.ts`)에서 `pageerror` 4건 검출로 인한 실패 (`exit=1`)
- **발생한 명령**: `secure_store_get`
- **예외 메시지**: `Error: desktop_only:secure_store_get`
- **호출 파일 및 경로**:
  - `packages/shell/src/lib/secure-store.ts:59` (`nativeSecureStoreGet`)
  - `packages/shell/src/lib/config.ts:835` (`loadConfigWithSecrets`)
  - `packages/shell/src/components/AiControlBar.tsx:39` (`void loadConfigWithSecrets().then(...)`)
  - `packages/shell/src/components/ChatArea.tsx:1343` (`void loadConfigWithSecrets().then(...)`)
- **원인 분석**:
  - 웹 런타임 초기화 시 `installWebRuntime()`에 의해 `localStorage["naia-adk-path"]`가 `"opfs://naia-adk"`로 설정됨.
  - `src/lib/secure-store.ts`의 `secureStorePath()`가 truthy 경로(`opfs://naia-adk/data-private/secure-keys.dat`)를 반환함.
  - 컴포넌트 마운트 시 `AiControlBar`와 `ChatArea`에서 `loadConfigWithSecrets()`를 호출하고, 내부에서 `SECRET_KEYS`(`apiKey`, `naiaKey` 등)를 순회하며 `getSecretKeyAtPath`를 통해 `invoke("secure_store_get", ...)`를 호출함.
  - `secure_store_get`은 데스크톱 전용(`desktop-only`) 명령이며, `packages/shell/e2e/helpers/tauri-base-mock.ts`에 정의되어 있지 않음.
  - 지시서 4.2-3 규칙("그 명령이 tauri-base-mock.ts 에 값이 있을 때만 그 값으로 stub 에 옮긴다. mock 에 없으면 옮기지 않고, 명령 이름·예외 메시지·부른 파일을 보고 파일의 '막힌 곳'에 적는다. 앱 코드(src/lib 기존 파일, 컴포넌트)를 고쳐 예외를 삼키지 않는다")에 따라 stub으로 옮기지 않고 `desktop-only`로 유지함.
  - 그 결과 거부된 Promise가 처리되지 않는 예외(unhandled rejection)가 되어 브라우저 콘솔의 `pageerror` 4건으로 기록됨.
