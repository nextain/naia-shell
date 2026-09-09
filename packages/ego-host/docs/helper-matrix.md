# 지원 헬퍼 행렬 (측정 결과)

이 파일은 **생성물이다.** 손으로 고치지 않는다 — `node scripts/probe-helpers.mjs` 가 벤더 스킬의 `Common helpers` 목록을 그 자리에서 파싱하고, 헬퍼마다 독립 heredoc 을 실 Chromium 위에서 돌려 다시 쓴다. `--check` 는 측정 결과가 이 파일과 다르면 종료 코드 1 이다.

대상 업스트림 커밋: `5ca3c36cba2240b8df2e22ba32127747029039d5`

판정은 셋뿐이다.

- `supported` — 호출이 감독자를 지나 실제로 동작했다.
- `rejected(<코드>)` — 우리 정책이 형식 있는 오류로 거부했다. 코드가 이유다.
- `unsupported(<이유>)` — 고정 커밋의 런타임에 그 이름이 없거나, 헤드리스에서 도달할 수 없다.

합계: 헬퍼 41 개 — supported 35, rejected 4, unsupported 2.

**벤더 스킬 문서가 런타임보다 낡았다**(ABI 문서 9절). 스킬의 평면 이름은 대부분 파사드로 옮겨졌으므로, 각 행에 고정 커밋 런타임에서 그 일을 하는 호출을 함께 적는다.

## Task spaces

| 스킬의 이름 | 고정 커밋 런타임의 호출 | 판정 |
|---|---|---|
| `listTaskSpaces` | `taskSpaces.list()` | supported |
| `useOrCreateTaskSpace` | `taskSpaces.useOrCreate(nameOrId)` | supported |
| `claimTaskSpace` | `taskSpaces.claim(nameOrId)` | rejected(EGO_HANDOFF_UNSUPPORTED_HEADLESS) |
| `handOffTaskSpace` | `taskSpaces.handOff(nameOrId)` | rejected(EGO_HANDOFF_UNSUPPORTED_HEADLESS) |
| `takeOverTaskSpace` | `taskSpaces.takeOver(nameOrId)` | rejected(EGO_HANDOFF_UNSUPPORTED_HEADLESS) |
| `waitForAgentControl` | `taskSpaces.waitForAgentControl(nameOrId, options)` | supported |
| `completeTaskSpace` | `taskSpaces.complete(nameOrId, {keep})` | supported |

## Navigation / state

| 스킬의 이름 | 고정 커밋 런타임의 호출 | 판정 |
|---|---|---|
| `listTabs` | `browser.listTabs()` | supported |
| `openOrReuseTab` | `browser.openOrReuseTab(url, options)` | supported |
| `closeTab` | `browser.closeTab(target)` | supported |
| `gotoAndWait` | `page.goto(url, {waitUntil:"load"})` | supported |
| `currentTab` | `browser.currentTab()` | supported |
| `switchTab` | `browser.switchTab(target)` | supported |
| `gotoUrl` | `page.goto(url, {waitUntil:"commit"})` | supported |
| `pageInfo` | `page.info()` | supported |
| `ensureRealTab` | `browser.ensureRealTab()` | supported |

## Observation

| 스킬의 이름 | 고정 커밋 런타임의 호출 | 판정 |
|---|---|---|
| `snapshotText` | `page.snapshot()` | supported |
| `captureScreenshot` | `page.screenshot(options)` | supported |
| `drainEvents` | `page.drainEvents()` | supported |

## Scroll / mouse

| 스킬의 이름 | 고정 커밋 런타임의 호출 | 판정 |
|---|---|---|
| `scrollBy` | `page.mouse.wheel(dx, dy)` | supported |
| `scrollToBottomUntil` | `(없음) — page.mouse.wheel + page.evaluate 로 직접 짠다` | unsupported(고정 커밋 런타임에 이 이름의 헬퍼가 없다(벤더 SKILL 이 런타임보다 낡았다)) |
| `scroll` | `page.locator(sel).scrollIntoViewIfNeeded()` | supported |
| `click` | `page.locator(sel).click()` | supported |
| `doubleClick` | `page.mouse.dblclick(x, y)` | supported |
| `hover` | `page.locator(sel).hover()` | supported |
| `dragMouse` | `page.mouse.drag(points)` | supported |

## Keyboard & input

| 스킬의 이름 | 고정 커밋 런타임의 호출 | 판정 |
|---|---|---|
| `typeText` | `page.keyboard.type(text)` | supported |
| `fillInput` | `page.locator(sel).fill(value)` | supported |
| `pressKey` | `page.keyboard.press(key)` | supported |
| `dispatchKey` | `page.keyboard.down(key) / page.keyboard.up(key)` | supported |

## File

| 스킬의 이름 | 고정 커밋 런타임의 호출 | 판정 |
|---|---|---|
| `uploadFile` | `page.locator(sel).setInputFiles(path)` | rejected(EGO_HOST_METHOD_DENIED) |

## Wait

| 스킬의 이름 | 고정 커밋 런타임의 호출 | 판정 |
|---|---|---|
| `wait` | `page.waitForTimeout(ms)` | supported |
| `waitForLoad` | `page.waitForLoadState(state)` | supported |
| `waitForElement` | `page.locator(sel).waitFor(options) / page.waitForSelector(sel)` | supported |
| `waitForNetworkIdle` | `page.waitForLoadState("networkidle")` | supported |

## Fetch

| 스킬의 이름 | 고정 커밋 런타임의 호출 | 판정 |
|---|---|---|
| `serverFetch` | `fetch.server(url, options)` | supported |
| `browserFetch` | `fetch.browser(url, options)` | supported |

## CDP / evaluate

| 스킬의 이름 | 고정 커밋 런타임의 호출 | 판정 |
|---|---|---|
| `js` | `page.evaluate(expression)` | supported |
| `cdp` | `cdp(method, params)` | supported |

## Output

| 스킬의 이름 | 고정 커밋 런타임의 호출 | 판정 |
|---|---|---|
| `cliLog` | `console.log(value)` | unsupported(고정 커밋 런타임에서 `cliLog` 전역이 없어졌다(src/index.ts:175-186). 출력 통로는 console.log 다) |
| `help` | `help(name)` | supported |

