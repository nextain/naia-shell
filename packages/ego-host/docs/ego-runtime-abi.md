# 벤더 런타임이 호스트에게 기대하는 실행 ABI

대상 커밋 `5ca3c36cba2240b8df2e22ba32127747029039d5` (2026-08-24).
경로는 모두 `packages/ego-host/vendor/ego-lite/package/ego-browser/` 기준이다.

이 문서는 이슈 #582 계획(`docs/progress/issue-582-ego-browser-host.md` 4.2)의 표를 옮기되,
**근거 줄 번호를 벤더 파일에서 직접 확인해 정정**한 판이다. 계획의 줄 번호는 근사치였고
여러 행이 다른 함수를 가리키고 있었다. 정정 내역은 마지막 절에 있다.

호스트(감독자)는 벤더 런타임을 **한 글자도 고치지 않고** 돌린다. 따라서 아래는
협상 대상이 아니라 우리가 맞춰야 하는 계약이다.

각 행 끝의 **테스트**는 그 행을 실제로 밟는 테스트 파일과 이름이다(S2a 에서 붙였다).
`**S2b**`·`**S2c**` 처럼 슬라이스가 적힌 행은 아직 테스트가 없고 그 슬라이스가 든다.
`**헤드리스 도달 불가**` 는 우리 정책(계약 4.4)에서 그 상태가 생기지 않는다는 뜻이며,
테스트는 그 자리에 오는 거부를 대신 확인한다.

---

## 0. `globalThis.ego` 표면

`browserEgo()` 는 `globalThis.ego` 가 없으면 `browser runtime is not available` 로 던진다
(`src/browser-runtime.ts:31-36`). `isBrowserRuntime()` 은 `ego.sendCDPMessage` 가 함수인지만
본다(`src/browser-runtime.ts:25-29`) — 표면 존재 판정의 유일한 기준이다.

**반드시 구현해야 하는 12개 메서드**

| 메서드 | 호출 지점 |
|---|---|
| `sendCDPMessage(jsonString)` | `src/browser-runtime.ts:70` — 테스트: test/conformance.test.mjs "ABI 0: isBrowserRuntime 이 참이고 필수 12 메서드가 모두 함수다" |
| `listTabs()` | `src/browser-runtime.ts:116`, `src/driver/nav.ts:116` — 테스트: test/conformance.test.mjs "ABI 4: listTabs 는 {tabs} 를 주고 항목이 {targetId,title,url,active} 다" |
| `createTab(url)` | `src/driver/nav.ts:169`, 래핑 `src/index.ts:303-319` — 테스트: test/conformance.test.mjs "ABI 4: createTab 은 targetId 를 주고 새 탭이 목록에 들어온다" |
| `snapshot(options)` | `src/driver/observe.ts:52`, `src/helpers.ts:368` — 테스트: test/conformance.test.mjs "ABI 7: snapshot 은 {content, refs} 를 주고 ref 키가 backendNodeId 와 같다" |
| `listTaskSpaces()` | `src/helpers.ts:113` — 테스트: test/conformance.test.mjs "ABI 5: listTaskSpaces 는 {taskSpaces} 와 숫자 id, ownership 'agent' 를 준다" |
| `useTaskSpace(numericId)` | `src/helpers.ts:249` — 테스트: test/conformance.test.mjs "ABI 5: 선택 공간은 연결별이라 두 CLI 가 서로 다른 공간에서 일한다" |
| `createTaskSpace(name)` | `src/helpers.ts:177` — 테스트: test/conformance.test.mjs "ABI 5: listTaskSpaces 는 {taskSpaces} 와 숫자 id, ownership 'agent' 를 준다" |
| `claimTaskSpace(numericId, name)` | `src/helpers.ts:236` — 테스트: test/conformance.test.mjs "ABI 6: 헤드리스 인계·회수·claim 은 EGO_HANDOFF_UNSUPPORTED_HEADLESS 와 설명으로 거부된다" |
| `closeTaskSpace()` | `src/helpers.ts:314` — 테스트: **S2c** — 공간 닫기의 실제 컨텍스트 정리는 장부 슬라이스 |
| `completeTaskSpace()` | `src/helpers.ts:304` — 테스트: **S2c** — keep:true 유지 의미는 장부 슬라이스 |
| `handOffTaskSpace()` | `src/helpers.ts:338` — 테스트: test/conformance.test.mjs "ABI 6: 헤드리스 인계·회수·claim 은 EGO_HANDOFF_UNSUPPORTED_HEADLESS 와 설명으로 거부된다" |
| `takeOverTaskSpace()` | `src/helpers.ts:353` — 테스트: test/conformance.test.mjs "ABI 6: 헤드리스 인계·회수·claim 은 EGO_HANDOFF_UNSUPPORTED_HEADLESS 와 설명으로 거부된다" |

**런타임이 `ego` 객체에 써 넣는 두 콜백** — 호스트는 이 두 속성을 덮어쓰지 말고,
값이 설정되면 그쪽으로 밀어 넣어야 한다.

| 속성 | 대입 지점 | 의미 |
|---|---|---|
| `ego.onCDPMessage` | `src/browser-runtime.ts:45` | CDP 응답·이벤트 JSON 문자열을 런타임에 전달 — 테스트: test/conformance.test.mjs "ABI 0: 런타임이 대입한 onCDPMessage·onSendCDPMessageError 를 감독자가 덮어쓰지 않는다" |
| `ego.onSendCDPMessageError` | `src/browser-runtime.ts:46` | 로컬 송신 실패를 알림 — 테스트: test/conformance.test.mjs "ABI 2: 연결이 죽으면 onSendCDPMessageError 가 in-flight 전부를 같은 오류로 거부한다" |

**선택 메서드** — 없으면 조용히 degrade 한다. 없어도 된다.

| 메서드 | 호출 지점 | 없을 때 |
|---|---|---|
| `getBrowserVersion()` | `src/index.ts:192-195`, `src/update-notice.ts:136-149` | 업데이트 알림이 침묵 — 테스트: test/conformance.test.mjs "ABI 9: getBrowserVersion 이 고정 문자열이라 업데이트 알림이 침묵한다" |
| `animationHighlightMouseToPosition(x, y)` | `src/driver/pointer.ts:569` (`?.`) | 시각 강조 없음 — 테스트: **범위 밖** — 헤드리스에는 시각 강조가 없다. 없어도 degrade 한다 |
| `setAgentTaskState(label)` | `src/driver/pointer.ts:571` (`?.`) | 상태 표시 없음 — 테스트: **범위 밖** — 헤드리스에는 상태 표시가 없다. 없어도 degrade 한다 |

---

## 1. CDP 통로

| 기대 | 근거 | 호스트가 지킬 것 |
|---|---|---|
| 요청은 `JSON.stringify({id, method, params, sessionId?})` 문자열 하나로 온다 | `src/browser-runtime.ts:48-53` | 문자열을 그대로 파싱한다. 필드를 추가로 요구하지 않는다 — 테스트: test/conformance.test.mjs "ABI 1: 요청 id 를 보존한 응답이 대기 항목을 푼다" |
| **요청 `id` 보존** — 응답의 `data.id` 로만 대기 항목을 찾는다 | `src/browser-runtime.ts:47`(발번), `:239-250`(대조) | 응답 JSON 의 `id` 를 요청과 **같은 값**으로 되돌린다. 재발번 금지 — 테스트: test/conformance.test.mjs "ABI 1: 요청 id 를 보존한 응답이 대기 항목을 푼다" |
| `id` 가 없는 메시지는 이벤트로 취급한다 | `src/browser-runtime.ts:239`, `:252-306` | 이벤트에는 `id` 를 넣지 않는다 — 테스트: test/rpc-transport.test.mjs "아웃바운드 이벤트는 연결이 소유한 세션·타깃으로만 간다" |
| 오류 응답은 `{id, error:{message}}` | `src/browser-runtime.ts:245-248` | `error.message` 문자열을 채운다 — 테스트: test/conformance.test.mjs "ABI 1: 오류 응답 {id, error:{message}} 는 그 요청만 거부한다" |
| **응답 15초 제한** (`RESPONSE_TIMEOUT_MS = 15000`) | `src/browser-runtime.ts:4`, 타이머 `:55-58` | 15초 안에 모든 요청에 응답한다. 넘기면 런타임이 `CDP request timed out: <method>` 로 던지고 그 id 는 pending 에서 지워지므로, **늦게 도착한 응답은 조용히 버려진다** — 테스트: test/conformance.test.mjs "ABI 1: 감독자 상한이 런타임 15초 타임아웃보다 먼저 원래 id 오류를 돌려준다" |
| 송신 자체가 동기적으로 던지면 그 요청만 즉시 거부된다 | `src/browser-runtime.ts:69-75` | 즉시 실패는 throw 로 알려도 된다 — 테스트: test/rpc-transport.test.mjs "프레이밍: 상한을 넘는 프레임은 보내기 전에 형식 있는 오류로 거부된다" |
| `Target.*`·`Browser.*` 는 세션 주입 없이 브라우저 수준으로 보낸다 | `src/browser-runtime.ts:11-12`, `:91-93` | 중계기가 이 두 접두사를 브라우저 수준으로 받아 검증·재작성한다(계획 4.2.1) — 테스트: test/rpc-transport.test.mjs "sessionId 는 재작성하지 않는다 — 라우팅 키는 최상위 sessionId 뿐이다" |
| 세션 상실 문구를 정규식으로 판정해 한 번 재시도한다 | `src/browser-runtime.ts:9-10`, `:96-104` | 세션이 사라졌을 때의 오류 문구가 `Session not found` / `Session with given id not found` / `Target closed` / `No session` 중 하나여야 자동 재접속이 돈다. **다른 문구를 쓰면 재시도가 죽는다** — 테스트: test/conformance.test.mjs "ABI 1: 세션 상실 문구에 런타임의 자동 재접속이 돈다" |
| 이벤트 버퍼 상한 10000 | `src/browser-runtime.ts:8`, `:286-291` | 호스트가 이벤트를 과다 방출해도 런타임은 앞을 버린다. 순서 보장은 호스트 몫 — 테스트: test/rpc-transport.test.mjs "Chromium 에서 받은 응답·이벤트는 단일 FIFO 순서를 유지한다", test/rpc-transport.test.mjs "이벤트 폭주로 송신 큐가 넘치면 그 연결만 끊기고 다른 연결은 산다" |

## 2. 오류 통로: `onSendCDPMessageError` 에는 요청 id 가 없다

| 기대 | 근거 |
|---|---|
| 콜백 시그니처는 `(message, error_code)` 이고 **요청 id 가 없다** | `src/browser-runtime.ts:224` — 테스트: test/conformance.test.mjs "ABI 2: 연결이 죽으면 onSendCDPMessageError 가 in-flight 전부를 같은 오류로 거부한다" |
| 한 번 호출되면 **대기 중인 모든 요청이 같은 오류로 거부된다** | `src/browser-runtime.ts:225-230` (`pending.clear()` 후 전부 reject) — 테스트: test/conformance.test.mjs "ABI 2: 연결이 죽으면 onSendCDPMessageError 가 in-flight 전부를 같은 오류로 거부한다" |
| 오류는 `buildEgoError({error: message, error_code})` 로 만들어져 `error_code` 를 달고 올라간다 | `src/browser-runtime.ts:226`, `src/ego-errors.ts:142-160` — 테스트: test/conformance.test.mjs "ABI 2: 연결이 죽으면 onSendCDPMessageError 가 in-flight 전부를 같은 오류로 거부한다" |

**호스트가 지킬 것**: 이 통로는 작업 전체를 무너뜨린다. 특정 요청 하나만 실패했을 때는
**절대로** 쓰지 말고 `{id, error:{message}}` 응답으로 돌려준다. 이 통로는 작업 비활성,
사람 제어 중, 공간 미선택, 호스트 소실처럼 **모든 in-flight 송신이 같이 실패하는**
상황에만 쓴다(주석 `src/browser-runtime.ts:218-223`).

## 3. 세션 — flatten 과 `Page.enable` 후 이벤트 지속

| 기대 | 근거 |
|---|---|
| 세션 확보 절차는 `listTabs()` → 대상 선택 → `Target.attachToTarget({targetId, flatten:true})` | `src/browser-runtime.ts:114-132` — 테스트: test/conformance.test.mjs "ABI 3: attachToTarget flatten 뒤 Page.enable 은 세션당 한 번이고 이벤트가 계속 온다" |
| 응답에서 세션 id 를 `attached.result?.sessionId \|\| attached.sessionId` 로 읽는다 | `src/browser-runtime.ts:133` — 테스트: test/conformance.test.mjs "ABI 3: attachToTarget flatten 뒤 Page.enable 은 세션당 한 번이고 이벤트가 계속 온다" |
| 붙인 직후 그 세션에 `Page.enable` 을 보낸다. 실패해도 무시한다 | `src/browser-runtime.ts:136`, 정의 `:205-216` — 테스트: test/conformance.test.mjs "ABI 3: attachToTarget flatten 뒤 Page.enable 은 세션당 한 번이고 이벤트가 계속 온다" |
| `Page.enable` **한 번 뒤에는 이벤트가 계속 와야 한다** — 세션당 한 번만 보내고 다시 보내지 않는다 | `pageEnabledSessions` `src/browser-runtime.ts:23`, `:206`, `:211` — 테스트: test/conformance.test.mjs "ABI 3: attachToTarget flatten 뒤 Page.enable 은 세션당 한 번이고 이벤트가 계속 온다" |
| 세션 캐시 수명 2초(`SESSION_TTL_MS`). 2초마다 `listTabs()` 가 다시 온다 | `src/browser-runtime.ts:5`, `:108-110` — 테스트: test/conformance.test.mjs "ABI 4: listTabs 는 {tabs} 를 주고 항목이 {targetId,title,url,active} 다" |
| `Target.detachedFromTarget` / `Target.targetDestroyed` 를 받으면 세션을 버린다 | `src/browser-runtime.ts:252-265` — 테스트: test/rpc-transport.test.mjs "중첩 params.sessionId 는 Target.attachedToTarget 에서만 세션으로 해석된다" |
| `Page.javascriptDialogOpening` / `...Closed` 로 대기 중 대화상자를 추적한다 | `src/browser-runtime.ts:266-276` — 테스트: **S2e** — 대화상자 추적은 작업·취소 슬라이스 |

**호스트가 지킬 것**: flatten 세션이므로 이벤트 JSON 에 `sessionId` 필드를 그대로 실어야
한다(`src/browser-runtime.ts:280`, `:256`, `:267` 이 `data.sessionId` 를 읽는다).
호스트 자신의 CDP 연결과 에이전트용 연결을 분리한다(계획 4.2).

## 4. 탭

| 기대 | 근거 |
|---|---|
| `listTabs()` → **`{tabs:[...]}`**. 헬퍼 경로는 `result.tabs` 만 본다 | `src/driver/nav.ts:117` — 테스트: test/conformance.test.mjs "ABI 4: listTabs 는 {tabs} 를 주고 항목이 {targetId,title,url,active} 다" |
| 세션 확보 경로만 `{targetInfos:[...]}` 도 받아준다 — **헬퍼는 안 받으므로 `tabs` 로 통일한다** | `src/browser-runtime.ts:117` — 테스트: test/conformance.test.mjs "ABI 4: listTabs 는 {tabs} 를 주고 항목이 {targetId,title,url,active} 다" |
| 탭 항목은 `{targetId, title, url, active}` (선택 `index`) | `src/driver/nav.ts:23-29`, 매핑 `:126-132` — 테스트: test/conformance.test.mjs "ABI 4: listTabs 는 {tabs} 를 주고 항목이 {targetId,title,url,active} 다" |
| `active` 인 탭이 하나도 없으면 마지막 탭에 붙는다 | `src/browser-runtime.ts:121-122` — 테스트: test/conformance.test.mjs "ABI 4: listTabs 는 {tabs} 를 주고 항목이 {targetId,title,url,active} 다" |
| `active` 가 없으면 `currentTab()` 은 첫 탭을 쓴다 | `src/driver/nav.ts:141` — 테스트: test/conformance.test.mjs "ABI 4: listTabs 는 {tabs} 를 주고 항목이 {targetId,title,url,active} 다" |
| `createTab(url)` → `{targetId}` 를 반환한다. 없으면 `newTab returned no targetId` 로 던진다 | `src/driver/nav.ts:169-173` — 테스트: test/conformance.test.mjs "ABI 4: createTab 은 targetId 를 주고 새 탭이 목록에 들어온다" |
| 래퍼가 `value?.targetId \|\| value?.result?.targetId` 를 읽어 preferred target 으로 잡는다 | `src/index.ts:311-312` — 테스트: test/conformance.test.mjs "ABI 4: createTab 은 targetId 를 주고 새 탭이 목록에 들어온다" |
| `listTabs()` 가 `{error}` 를 담아 resolve 하면 오류로 승격된다 | `src/driver/nav.ts:116`, `src/ego-errors.ts:162-172` — 테스트: test/handshake.test.mjs "공간을 고르지 않은 연결의 listTabs 는 형식 있는 오류다" |
| 탭 전환·닫기는 CDP `Target.activateTarget` / `Target.closeTarget` 로 나간다 | `src/driver/nav.ts:157`, `:224` — 테스트: **S2d** — Target 장부 통과 행렬 |

## 5. 작업 공간 — `{taskSpaces}` 모양과 ownership 문자열

| 기대 | 근거 |
|---|---|
| `listTaskSpaces()` 는 반드시 **`{taskSpaces: [...]}`** 를 반환한다. 배열을 그냥 주면 `listTaskSpaces expected { taskSpaces: [...] }` 로 던진다 | `src/helpers.ts:411-416` — 테스트: test/conformance.test.mjs "ABI 5: listTaskSpaces 는 {taskSpaces} 와 숫자 id, ownership 'agent' 를 준다" |
| 항목은 `{taskId, id, name, createdBy?, ownership?, recentTabTitles?}` | `src/helpers.ts:105`, 정규화 `:418-429` — 테스트: test/conformance.test.mjs "ABI 5: listTaskSpaces 는 {taskSpaces} 와 숫자 id, ownership 'agent' 를 준다" |
| `id` 는 **유한한 숫자**여야 한다. 문자열 id 는 `... requires a numeric task space id` 로 던진다 | `src/helpers.ts:431-438` — 테스트: test/conformance.test.mjs "ABI 5: listTaskSpaces 는 {taskSpaces} 와 숫자 id, ownership 'agent' 를 준다" |
| `taskId`/`name` 은 없으면 서로에서 채워지지만 셋 다 비면 항목이 버려진다 | `src/helpers.ts:419-428` — 테스트: test/conformance.test.mjs "ABI 5: listTaskSpaces 는 {taskSpaces} 와 숫자 id, ownership 'agent' 를 준다" |
| **`ownership` 문자열은 정확히 `"agent"` / `"agentDelegatedToUser"` / `"user"`** 세 가지다 | `src/helpers.ts:118`, 판정 `:143-145`, `:205`, `:297`, `:306`, `:333` — 테스트: test/conformance.test.mjs "ABI 5: listTaskSpaces 는 {taskSpaces} 와 숫자 id, ownership 'agent' 를 준다" |
| `"agent"` 와 `"agentDelegatedToUser"` 는 둘 다 에이전트 소유다 | `src/helpers.ts:143-145` — 테스트: test/conformance.test.mjs "ABI 5: listTaskSpaces 는 {taskSpaces} 와 숫자 id, ownership 'agent' 를 준다" |
| `createTaskSpace(name)` / `claimTaskSpace(id, name)` 도 같은 모양의 **단일 공간 객체**를 반환하고 숫자 `id` 를 가져야 한다 | `src/helpers.ts:176-182`, `:235-241` — 테스트: test/conformance.test.mjs "ABI 5: listTaskSpaces 는 {taskSpaces} 와 숫자 id, ownership 'agent' 를 준다" |
| `useTaskSpace(numericId)` 는 숫자 id 를 받는다 | `src/helpers.ts:249` — 테스트: test/conformance.test.mjs "ABI 5: 선택 공간은 연결별이라 두 CLI 가 서로 다른 공간에서 일한다" |

**메서드별 resolve/reject 규칙** (사용자 소유 공간을 대상으로 할 때, `src/helpers.ts:118-133`
의 표를 코드에서 재확인한 것)

| 헬퍼 | 사용자 소유 공간에서의 동작 | 근거 |
|---|---|---|
| `switchTaskSpace` | 던진다(에이전트 소유만 허용) | `src/helpers.ts:158-162` — 테스트: test/conformance.test.mjs "ABI 5: 선택 공간은 연결별이라 두 CLI 가 서로 다른 공간에서 일한다" |
| `claimTaskSpace` | 소유권을 가져오고 선택한다 | `src/helpers.ts:224-243` — 테스트: test/conformance.test.mjs "ABI 6: 헤드리스 인계·회수·claim 은 EGO_HANDOFF_UNSUPPORTED_HEADLESS 와 설명으로 거부된다" |
| `useOrCreateTaskSpace` | 선택만 한다(claim 안 함) → 이후 조작에서 `EGO_TASK_SPACE_USER_IN_CONTROL` 이 드러난다 | `src/helpers.ts:205-211` — 테스트: test/conformance.test.mjs "ABI 5: listTaskSpaces 는 {taskSpaces} 와 숫자 id, ownership 'agent' 를 준다" |
| `handOffTaskSpace` | `{done:false, skipped:"user-owned"}` 로 **resolve** 한다 | `src/helpers.ts:333-335` — 테스트: test/conformance.test.mjs "ABI 6: 헤드리스 인계·회수·claim 은 EGO_HANDOFF_UNSUPPORTED_HEADLESS 와 설명으로 거부된다" |
| `completeTaskSpace {keep:true}` | `{done:false, skipped:"user-owned"}` 로 resolve | `src/helpers.ts:297-299` — 테스트: **헤드리스 도달 불가** — user 소유 상태가 없다 |
| `completeTaskSpace {keep:false}` | claim 한 뒤 닫는다 | `src/helpers.ts:306-314` — 테스트: **S2c** — 공간 닫기 |
| `takeOverTaskSpace` / `waitForAgentControl` | 소유권 검사 없이 그대로 실행 | `src/helpers.ts:347-354`, `:384-409` — 테스트: test/conformance.test.mjs "ABI 6: 헤드리스 인계·회수·claim 은 EGO_HANDOFF_UNSUPPORTED_HEADLESS 와 설명으로 거부된다" |
| 성공한 `handOffTaskSpace` | `{done:true}` | `src/helpers.ts:339` — 테스트: **헤드리스 도달 불가** — 인계 성공 경로가 없다 |

## 6. 오류 모양 `{error, error_code}`

| 기대 | 근거 |
|---|---|
| 실패는 **reject 가 아니라 `{error, error_code}` 를 담아 resolve** 해도 된다. `assertNoEgoError` 가 `error != null` 이면 던진다 | `src/ego-errors.ts:162-172` — 테스트: test/conformance.test.mjs "ABI 6: 헤드리스 인계·회수·claim 은 EGO_HANDOFF_UNSUPPORTED_HEADLESS 와 설명으로 거부된다" |
| `error_code` 는 안정 코드다. `EGO_TASK_SPACE_USER_IN_CONTROL` 등 | `src/ego-errors.ts:35`, `:57` — 테스트: test/conformance.test.mjs "ABI 7: snapshot 은 resolve 가 아니라 reject 로 사람 제어를 알린다" |
| 만들어진 Error 는 `error_code` 속성을 달고 올라간다 | `src/ego-errors.ts:155-159` — 테스트: test/conformance.test.mjs "ABI 6: 헤드리스 인계·회수·claim 은 EGO_HANDOFF_UNSUPPORTED_HEADLESS 와 설명으로 거부된다" |
| `snapshot` 만은 예외로 **직접 reject 한다**(resolve 로 `{error}` 를 주지 않는다) | `src/driver/observe.ts:54-59` 의 주석과 `buildEgoError(err, "snapshot")` — 테스트: test/conformance.test.mjs "ABI 7: snapshot 은 resolve 가 아니라 reject 로 사람 제어를 알린다" |

| 업스트림이 아는 안정 코드 목록은 16개다 | `src/ego-errors.ts:21-37` — 테스트: **문서 사실** — 코드 목록은 벤더 소유다 |
| 그중 **문구를 런타임이 덮어쓰는 코드는 둘뿐**이다: `EGO_TASK_SPACE_INACTIVE`, `EGO_TASK_SPACE_USER_IN_CONTROL` | `src/ego-errors.ts:48-56`, `:57-` — 테스트: test/conformance.test.mjs "ABI 7: snapshot 은 resolve 가 아니라 reject 로 사람 제어를 알린다" |
| 목록 밖의 **미지 코드는 그대로 통과**하고 우리가 준 `error` 문구가 그대로 쓰인다 | `src/ego-errors.ts:41-47`(주석이 명시), 해석 `:100-111` — 테스트: test/conformance.test.mjs "ABI 6: 헤드리스 인계·회수·claim 은 EGO_HANDOFF_UNSUPPORTED_HEADLESS 와 설명으로 거부된다" |
| 하드 스톱(재시도 금지) 판정은 위 두 코드에만 붙는다 | `src/ego-errors.ts:123-128` — 테스트: test/conformance.test.mjs "ABI 7: snapshot 은 resolve 가 아니라 reject 로 사람 제어를 알린다" |

**호스트가 지킬 것**: 헤드리스 인계 거부에 쓸 `EGO_HANDOFF_UNSUPPORTED_HEADLESS` 는
업스트림 목록에 없는 코드다. `src/ego-errors.ts:41-47` 의 주석이 "목록에 없는 코드(미래의
미지 코드 포함)는 네이티브 오류 문구를 따른다"고 명시하므로, **사람이 읽을 설명을 `error`
문자열에 반드시 담아야 한다.** 코드만 주면 아무 설명도 남지 않는다.

## 7. 스냅샷 refs 모양

| 기대 | 근거 |
|---|---|
| `snapshot(options)` → `{content, refs:[...]}` | `src/driver/observe.ts:52`, `:61`, `:79` — 테스트: test/conformance.test.mjs "ABI 7: snapshot 은 {content, refs} 를 주고 ref 키가 backendNodeId 와 같다" |
| `refs` 항목은 `{backendNodeId, role, name}`. `backendNodeId` 가 `undefined`/`null` 인 항목은 버려진다 | `src/browser-runtime.ts:309-326` — 테스트: test/conformance.test.mjs "ABI 7: snapshot 은 {content, refs} 를 주고 ref 키가 backendNodeId 와 같다" |
| ref 키는 `String(backendNodeId)` 다 — 본문 주석의 `ref=N` 과 이 값이 같아야 한다 | `src/browser-runtime.ts:318-324` — 테스트: test/conformance.test.mjs "ABI 7: snapshot 은 {content, refs} 를 주고 ref 키가 backendNodeId 와 같다" |
| `content` 가 없으면 빈 문자열로 degrade 한다 | `src/driver/observe.ts:79` — 테스트: test/conformance.test.mjs "ABI 7: snapshot 은 {content, refs} 를 주고 ref 키가 backendNodeId 와 같다" |
| `refs` 가 없어도 죽지 않는다(`result.refs \|\| []`) | `src/driver/observe.ts:61` — 테스트: test/conformance.test.mjs "ABI 7: snapshot 은 {content, refs} 를 주고 ref 키가 backendNodeId 와 같다" |
| **사람 제어 중이면 `snapshot` 이 `EGO_TASK_SPACE_USER_IN_CONTROL` 로 거부해야 한다.** 이것이 제어권 판정의 유일한 신호다 | `src/helpers.ts:364-374`, 코드 판정 `src/ego-errors.ts:115` — 테스트: test/conformance.test.mjs "ABI 7: snapshot 은 resolve 가 아니라 reject 로 사람 제어를 알린다" |
| `waitForAgentControl` 은 이 신호를 폴링한다. 다른 오류는 그대로 전파된다 | `src/helpers.ts:371-372`, `:384-409` — 테스트: test/conformance.test.mjs "ABI 7: snapshot 은 resolve 가 아니라 reject 로 사람 제어를 알린다" |
| 화면 캡처는 `ego` 메서드가 아니라 CDP `Page.captureScreenshot` 으로 나가며, 기본 저장 경로는 `os.tmpdir()` 아래다 | `src/driver/observe.ts:97-100` — 테스트: **S2e** — 캡처 경로는 증거 슬라이스 |

## 8. 환경·경로 의존

| 기대 | 근거 | 호스트가 지킬 것 |
|---|---|---|
| Node **22 이상** | `package.json` `engines.node` | 이 워크스페이스는 Node 26 — 테스트: test/vendor-install.test.mjs "(b) 임의 디렉터리에서 npm ci + build + test 가 0 으로 끝난다" |
| `~` 확장은 `HOME` → `USERPROFILE` → `"."` 순서 | `src/env.ts:21-26` | 두 변수 중 하나는 반드시 절대 경로로 주입한다 — 테스트: **S3a** — ADK 별 절대 경로 주입은 어댑터 몫 |
| `EGO_BROWSER_AGENT_WORKSPACE` 가 있으면 그것이 에이전트 작업 공간이다 | `src/env.ts:9-11` | 우리 학습 디렉터리를 **벤더 밖**에 두는 유일한 수단 — 테스트: test/conformance.test.mjs "ABI 8: EGO_BROWSER_AGENT_WORKSPACE 의 agent_helpers.js 가 spawn 시점 환경으로 잡힌다" |
| 없으면 `<번들 위치>/ego-browser` → 그것도 없으면 `<REPO_ROOT>/../../skills/ego-browser` | `src/env.ts:13-18` | 빌드가 스킬을 `dist/out/ego-browser` 로 복사하므로 기본값은 번들 안이다 (`scripts/build.mjs:31`, `:89`) — 테스트: test/vendor-install.test.mjs "(b) 임의 디렉터리에서 npm ci + build + test 가 0 으로 끝난다" |
| `REPO_ROOT` 는 **모듈 파일의 상위 디렉터리**다. 번들 bin 에서는 `dist/`, 소스에서는 `package/ego-browser/` | `src/env.ts:5-6` | 경로 가정을 bin 위치에 걸지 않는다 — 테스트: test/vendor-install.test.mjs "(b) 임의 디렉터리에서 npm ci + build + test 가 0 으로 끝난다" |
| `.env` 를 두 곳에서 읽는다: `<REPO_ROOT>/.env`, `<agentWorkspace>/.env` | `src/env.ts:46-49` | 우리 작업 공간에 `.env` 를 두면 읽힌다. 이미 설정된 변수는 덮어쓰지 않는다(`src/env.ts:40-42`) — 테스트: **S3a** — 작업 공간 .env 배치는 어댑터 몫 |
| `loadEnv()` 는 **`state.ts` 모듈 로드 시점에 즉시** 실행된다 | `src/state.ts:6` | 환경 변수는 프로세스 spawn 시점에 이미 자리잡아야 한다. 런타임 import 이후 주입은 늦다 — 테스트: test/conformance.test.mjs "ABI 8: EGO_BROWSER_AGENT_WORKSPACE 의 agent_helpers.js 가 spawn 시점 환경으로 잡힌다" |
| `EGO_BROWSER_NAME` 이 인스턴스 이름(기본 `"default"`) | `src/state.ts:8` | 작업 공간별 분리에 쓸 수 있다 — 테스트: **S2c** — 인스턴스 이름 분리는 장부 슬라이스 |
| `<agentWorkspace>/agent_helpers.js` 가 있으면 **매 실행마다 동적 import** 되어 헬퍼로 노출된다 | `src/helpers.ts:852-865` | 우리 작업 공간에 이 파일을 두면 우리 헬퍼를 주입할 수 있다. `_` 로 시작하는 이름은 제외된다 — 테스트: test/conformance.test.mjs "ABI 8: EGO_BROWSER_AGENT_WORKSPACE 의 agent_helpers.js 가 spawn 시점 환경으로 잡힌다" |
| 사이트 학습 루트는 `<agentWorkspace>/learnings` | `src/learning/check-domain-learning.ts:67-69` | S4 의 `learnings/naia-land/` 가 여기로 간다 — 테스트: test/vendor-install.test.mjs "(d) EGO_BROWSER_AGENT_WORKSPACE 가 학습 루트를 결정한다" |
| 빌드는 `package/ego-browser` 의 **두 단계 위**를 저장소 루트로 보고 `skills/ego-browser` 를 찾는다 | `scripts/build.mjs:24-31` | 벤더 트리가 업스트림 경로를 그대로 미러링해야 하는 이유 — 테스트: test/vendor-install.test.mjs "(b) 임의 디렉터리에서 npm ci + build + test 가 0 으로 끝난다" |
| 빌드는 `package/ego-browser/.build.lock` 을 배타 생성한다. 동시 빌드 두 개는 실패한다 | `scripts/build.mjs:32-42` | 병렬 테스트에서 같은 디렉터리를 두 번 빌드하지 않는다 — 테스트: package.json `test` 의 `--test-concurrency=1` |
| `npm ci` 시 `prepare` 스크립트가 `cd ../.. && lefthook install` 을 시도한다 | `package.json` `scripts.prepare` | `CI=true` 이거나 `--ignore-scripts` 여야 안전하다 — 테스트: test/vendor-install.test.mjs "(b) 임의 디렉터리에서 npm ci + build + test 가 0 으로 끝난다" |
| 캡처 임시 파일이 `os.tmpdir()` 에 쌓인다 | `src/driver/observe.ts:100` | 증거 경로(`<ADK>/ego-host/evidence/`)를 쓰려면 `options.path` 를 항상 지정한다 — 테스트: **S2e** — 증거 경로 지정은 캡처 슬라이스 |

## 9. CLI 진입점 — 계획 문서와 실제가 다른 부분

| 기대 | 근거 |
|---|---|
| bin 은 `dist/out/index.js` 다 | `package.json` `bin` — 테스트: test/conformance.test.mjs "ABI 9: 런처가 --sdk-path 로 받은 dist 를 쓴다" |
| **서브커맨드가 없다.** stdin 으로 JS 본문을 받는 것이 유일한 실행 형태다 | `src/run.ts:55-59`(USAGE), `:94-101` — 테스트: test/conformance.test.mjs "ABI 9: 런처가 nodejs 를 받아 stdin 을 그대로 넘기고 console.log 가 stdout 으로 나온다" |
| 인자가 하나라도 있으면 USAGE 를 stderr 에 찍고 **종료 코드 2** 로 끝난다. 예외는 `-h`/`--help`/`--doctor`/`--reload`/`--debug-clicks` 뿐 | `src/run.ts:73-92` — 테스트: test/conformance.test.mjs "ABI 9: 런처 인자가 틀리거나 sdk 가 없으면 형식 있는 오류로 끝난다" |
| **`cliLog` 전역은 더 이상 없다.** 에이전트의 출력 채널은 `console.log` 이며 출력 싱크로 라우팅된다 | `src/index.ts:175-186`, `src/run.ts:139-145` — 테스트: test/conformance.test.mjs "ABI 9: 런처가 nodejs 를 받아 stdin 을 그대로 넘기고 console.log 가 stdout 으로 나온다" |
| 스크립트가 던지면 버퍼를 버리고 오류를 전파해 프로세스가 **종료 코드 1** 로 끝난다 | `src/run.ts:116-130` — 테스트: test/conformance.test.mjs "ABI 9: 호스트가 없으면 첫 ego 접촉에서 형식이 맞는 오류로 죽는다" |
| 호스트가 없으면 첫 `ego` 접촉에서 `browser runtime is not available` 로 죽는다 | `src/browser-runtime.ts:31-36` — 테스트: test/conformance.test.mjs "ABI 9: 호스트가 없으면 첫 ego 접촉에서 형식이 맞는 오류로 죽는다" |
| 런처는 인자(`nodejs [--sdk-path]`)를 소비한 뒤 벤더 `dist/out/index.js` 를 `node --import <preload> <index.js>` 로 **직접 실행**한다. 그러면 `process.argv[1]` 이 벤더 index 라 `isDirectCli()` 가 참이 되어 `runMain()` 경로로 들어간다. `installEgoSdk()` 는 이 경로에서 호출되지 않는다(import 될 때만). preload 는 최상위 await 로 핸드셰이크를 끝내고 `globalThis.ego` 를 세우며 벤더 모듈을 정적으로 import 하지 않는다 | `src/index.ts:256-278`(isDirectCli·runMain), `src/index.ts:144-217`(installEgoSdk, 미사용 경로) — 테스트: test/conformance.test.mjs "ABI 9: 런처가 nodejs 를 받아 stdin 을 그대로 넘기고 console.log 가 stdout 으로 나온다", test/conformance.test.mjs "4.2.1: fork 자식은 토큰 재사용으로 거부돼 fail-closed 로 죽는다", test/conformance.test.mjs "4.2.1: worker 자식에서 preload 는 아무 핸드셰이크도 하지 않는다" |

> 계획 문서 4.2 와 S1 지시는 벤더 bin 에 `nodejs` 서브커맨드가 있고 `cliLog('x')` 가
> 전역이라고 적었지만, 고정 커밋의 **런타임 코드에서는 둘 다 사실이 아니다.** 벤더 bin 에
> `nodejs` 인자를 주면 USAGE 를 찍고 종료 코드 2 로 끝난다(`src/run.ts:89-92`). 설치
> 테스트는 이 사실에 맞춰 인자 없이 stdin 으로 실행한다.
>
> **출처는 벤더 스킬 문서다.** 같은 커밋에 들어 있는
> `skills/ego-browser/SKILL.md`(metadata `version: 1.2.6`, `date: 2026-07-20`)의 퀵스타트가
> 여전히 `ego-browser nodejs <<'EOF'` 와 `cliLog(...)` 를 쓴다(문서 안에 `cliLog` 7회,
> `ego-browser nodejs` 2회). 즉 **벤더 스킬 문서가 벤더 런타임(2026-08-24)보다 낡았다.**
> `nodejs` 서브커맨드는 ego 네이티브 앱 CLI 의 것이고, `cliLog` 전역은 런타임에서
> 없어졌다(`src/index.ts:175-186` 의 주석 "There is no dedicated cliLog global anymore").
> S4 의 파생 스킬은 이 두 표현을 우리 감독자 CLI 기준으로 다시 쓰고, 그 차이를
> `skill/UPSTREAM-DIFF.md` 에 로그인 상속·헤드리스 인계와 나란히 적어야 한다.

---

## 10. 계획 4.2 표의 줄 번호 정정 내역

| 항목 | 계획의 근거 | 실제 확인된 근거 | 왜 틀렸나 |
|---|---|---|---|
| CDP 통로 | `browser-runtime.ts 4~12, 38~76` | `browser-runtime.ts:4`(15초 상수), `:11-12`, `:38-77`(rawCdp), **`:239-250`(id 대조)** | rawCdp 는 77 행에서 끝난다. **요청 id 보존의 진짜 근거는 응답 대조부 239-250 이고 계획 범위 밖이었다** |
| 세션 | `browser-runtime.ts 107~144` | `:107-144`(ensureSession) + **`:205-216`(`Page.enable`)** + `:23`,`:206`,`:211`(중복 방지) | `Page.enable` 정의는 205-216 로 계획 범위 밖. `enablePageEvents` 호출만 136 행에 있다 |
| 오류 통로 | `browser-runtime.ts 218~307` | **`:218-230`** (주석 218-223 + `handleSendError` 224-230) | 232-307 은 `handleMessage` 라는 **다른 함수**다. 계획 범위가 두 함수를 뭉갰다 |
| 탭 | `index.ts 175~214` | **`browser-runtime.ts:116-117`**, **`driver/nav.ts:112-133`**, **`driver/nav.ts:168-173`**, `index.ts:303-319` | `index.ts:175-214` 는 `installEgoSdk` 의 console.log·업데이트 알림 구간으로 탭과 무관하다. 탭 계약은 전부 nav.ts 와 browser-runtime.ts 에 있다 |
| 작업 공간 | `index.ts 303~318, helpers.ts 304~415` | **`helpers.ts:411-416`**(`{taskSpaces}`), **`:418-429`**(정규화), **`:431-438`**(숫자 id), **`:118`,`:143-145`**(ownership 문자열), `:297-339`(메서드별 규칙), **`ego-errors.ts:142-172`**(`{error,error_code}`), `index.ts:201-213` | `index.ts:303-318` 은 `wrapCreateTab` 으로 **탭** 코드다. 작업 공간 래핑은 201-213. `helpers.ts` 범위도 시작이 늦어 ownership 정의(118, 143-145)를 빠뜨렸다 |
| 스냅샷 | `driver/observe.ts, helpers.ts 358~374` | **`driver/observe.ts:49-65`, `:73-79`**, **`browser-runtime.ts:309-326`**(refs 모양), `helpers.ts:364-374`(제어 판정) | refs 의 `{backendNodeId, role, name}` 모양은 observe.ts 가 아니라 browser-runtime.ts:309-326 에 있다. `probeAgentControl` 본체는 364-374(356-363 은 주석) |
| 환경·경로 | `env.ts 5~49, run.ts 61~87, helpers.ts 852~865` | `env.ts:5-49` ✔, `helpers.ts:852-865` ✔, **`run.ts:61-106`**, **`state.ts:6`(loadEnv 호출)** | `loadEnv()` 는 run.ts 에서 불리지 않는다 — `state.ts:6` 의 **모듈 로드 부수효과**다. 이것이 "환경 변수는 spawn 시점에 이미 있어야 한다"의 근거다. runMain 도 106 행까지다 |
| 브라우저 버전 | `update-notice.ts` | `update-notice.ts:136-149`(진입), `:70-85`(문구), `:50-54`(CI 억제), `index.ts:192-195`(호출) | 파일만 적혀 있어 줄을 채웠다. `CI` 나 `EGO_BROWSER_NO_UPDATE_NOTIFIER` 로 억제된다는 사실이 빠져 있었다 |

## 11. 추측으로 남긴 것

- `ego` 메서드 호출 실패를 reject 로 줄지 `{error}` resolve 로 줄지 **어느 쪽이든
  런타임은 받는다**고 읽었다(`assertNoEgoError` + `buildEgoError` 의 이중 경로). 다만
  `snapshot` 만은 reject 여야 한다는 것이 주석으로 명시돼 있다. 나머지 메서드에 대해
  두 경로가 실제로 동등한지는 **추측**이며 S2 적합성 테스트가 확정한다.
- `Target.attachToTarget` 응답을 `{result:{sessionId}}` 로 감쌀지 `{sessionId}` 로 줄지는
  런타임이 둘 다 받는다(`:133`). 어느 쪽이 관례인지는 **추측**이므로 우리는 CDP 원형인
  `{id, result:{sessionId}}` 를 쓴다.
- 이벤트 전달 순서 보장(응답보다 이벤트가 먼저 도착해도 되는가)은 코드에서 확인되지
  않는다. **추측**: 런타임은 순서를 가정하지 않으나, `Page.enable` 응답 전에 온 이벤트는
  버퍼에만 쌓인다.
