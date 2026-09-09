# @nextain/naia-ego-host

에이전트 전용 백그라운드 브라우저 호스트. 이슈 **#582**(부모 #499)의 패키지다.

## 이 패키지가 있는 이유

에이전트가 웹 작업을 할 때 **사람의 화면과 브라우저를 건드리지 않게** 하려는 것이다.
공개 저장소 [ego-lite](https://github.com/citrolabs/ego-lite) 의 헬퍼 런타임은
Playwright 풍 헬퍼와 접근성 스냅샷을 이미 갖고 있지만, 그 아래 브라우저 본체는
macOS 전용 닫힌 바이너리다. 그래서 **런타임은 그대로 쓰고, 브라우저 자리에 일반
Chromium 을 CDP 로 붙이는 호스트를 우리가 만든다.**

지금(S1)은 그 런타임을 커밋 고정으로 들여오고, 무결성 검사와 설치 검증만 있다.

## 디렉터리

```
packages/ego-host/
├─ vendor/ego-lite/            업스트림 그대로 (수정 금지)
│  ├─ package/ego-browser/     헬퍼 런타임 (src, scripts, test, package.json …)
│  ├─ skills/ego-browser/      업스트림 스킬 원본 + 사이트 학습 예시
│  ├─ spec/agent-skills-spec.md
│  ├─ .github/workflows/publish-ego-browser-skill.yml
│  ├─ LICENSE, AGENTS.md
│  ├─ UPSTREAM.md              고정 커밋·허용 목록·재동기화 절차
│  └─ MANIFEST.sha256          파일별 sha256 (생성물)
├─ src/supervisor/             감독자 — 프레이밍·소켓·CDP 다중화·소켓 경로·임시 장부
├─ src/client/                 CLI 쪽 — 소켓 클라이언트·globalThis.ego 프록시·preload
├─ bin/ego-browser.mjs         런처 (`nodejs [--sdk-path <dist>]`)
├─ scripts/sync-ego-lite.mjs   --check / --provenance / --ref 동기화·출처 도구
├─ docs/ego-runtime-abi.md     런타임이 호스트에게 요구하는 실행 ABI (근거 줄 + 행별 테스트 이름)
├─ test/                       vendor-install · conformance · handshake · rpc-transport · provenance
├─ THIRD_PARTY_NOTICES.md
└─ package.json
```

`vendor/ego-lite/` 안의 두 경로(`package/ego-browser` 와 `skills/ego-browser`)는
**상대 위치를 바꾸면 안 된다.** 빌드 스크립트가 `package/ego-browser` 의 두 단계 위를
저장소 루트로 보고 거기서 `skills/ego-browser` 를 찾는다.

## 원칙: 벤더 파일은 수정하지 않는다

`vendor/ego-lite/` 아래 파일은 한 글자도 고치지 않는다. 필요한 변경은 호스트 쪽 래핑으로
흡수하거나 업스트림에 PR 한다. 스킬 문서만 예외로 파생본을 두되, 파생본은 벤더 밖
(`skill/SKILL.md`, S4 에서 생성)에 둔다. 자세한 내용은 `vendor/ego-lite/UPSTREAM.md`.

이 원칙은 문서가 아니라 **검사기가 지킨다.** 벤더 파일을 고치면 `vendor:check` 가
종료 코드 1 로 실패한다.

## 명령

```bash
# 벤더가 고정 커밋과 바이트 단위로 같은지 (네트워크 불필요, 판정은 종료 코드)
npm run vendor:check

# 출처 게이트 — 고정 커밋 트리를 실체화해 형식·모드·심링크·바이트까지 직접 비교
node scripts/sync-ego-lite.mjs --provenance [--source <로컬 클론 경로>]

# 이 패키지의 검증 — 무결성 + 임의 디렉터리 설치·빌드·단위 테스트 + bin 동작
npm test

# 벤더 런타임 자신의 단위 테스트를 벤더 디렉터리에서 그대로 실행
npm run vendor:test

# 새 업스트림 커밋으로 올린다
node scripts/sync-ego-lite.mjs --ref <커밋 해시>
```


## 런처와 감독자 (S2a)

### 실행 모양

```bash
# 감독자가 소켓 경로와 단일 사용 토큰을 환경으로 내려주고, 런처가 벤더 SDK 를 무수정 실행한다
EGO_HOST_SOCKET=/run/user/1000/naia-ego-host-<해시>.sock \
EGO_HOST_TOKEN=<단일 사용 토큰> \
EGO_HOST_GRANT='{"tier":"workspace-write","approvalRef":"a-1"}' \
node packages/ego-host/bin/ego-browser.mjs nodejs [--sdk-path <dist>] <<'JS'
const space = await taskSpaces.useOrCreate("조사");
console.log(await browser.listTabs());
JS
```

런처가 하는 일은 하나다: `node --import <preload.mjs> <dist>/index.js` 로 벤더 진입점을
**직접** 실행하고 stdin 을 그대로 넘긴다. 그래야 벤더 `index.js` 의 `process.argv[1]` 이
자기 자신이 되어 `isDirectCli()` 가 참이 되고 `runMain()` 경로로 들어간다. preload 는
벤더 모듈을 정적으로 import 하지 않고, 최상위 await 로 소켓 연결·핸드셰이크를 끝낸 뒤
`globalThis.ego` 만 세운다. 기본 SDK 경로는 벤더 `dist/out` 이며, 없으면 형식 있는
오류(`EGO_HOST_SDK_NOT_FOUND`)로 종료 코드 2 다.

### 핸드셰이크

첫 프레임이 `{type:"hello", token, grant, operationId, workspaceId, deadline}` 다.

| 규칙 | 이유 |
|---|---|
| 토큰은 **단일 사용** | Node 가 `--import` 를 worker·fork·cluster 자식에 전파한다. worker 는 `isMainThread` 로 막히고, 별도 프로세스인 fork·cluster 는 토큰 재사용 거부로 막힌다 |
| `grant` 가 없으면 **관측 RPC 만** | 임의 자바스크립트는 터미널 실행과 같은 등급이다. 승인 없는 연결의 CDP 는 원래 id 를 가진 오류 응답으로 거부되고 연결은 살아 있다 |
| `deadline` 은 **짧은 쪽이 이긴다** | 호출자가 긴 시한을 적어 감독자 상한을 늘리지 못한다. 감독자 상한은 13초로 런타임의 15초보다 반드시 먼저 만료한다 |
| 선택한 작업 공간은 **연결별 상태** | 두 CLI 가 동시에 요청 id 1 과 서로 다른 공간을 써도 섞이지 않는다 |

### 환경 변수

벤더 `state.ts` 가 **모듈 로드 시점에** `.env` 를 읽으므로, 아래는 전부 spawn 시점에
자리잡아야 한다. SDK import 뒤의 주입은 늦다.

| 변수 | 쓰임 |
|---|---|
| `EGO_HOST_SOCKET` | 감독자 소켓 경로(unix 소켓 또는 named pipe) |
| `EGO_HOST_TOKEN` | 단일 사용 핸드셰이크 토큰 |
| `EGO_HOST_GRANT` | 승인 JSON. 없으면 관측 전용 연결 |
| `EGO_HOST_OPERATION_ID` · `EGO_HOST_WORKSPACE_ID` · `EGO_HOST_DEADLINE_MS` | 작업 결속(선택) |
| `HOME` (Windows 는 `USERPROFILE`) | 벤더의 `~` 확장이 이 순서로 읽는다 |
| `EGO_BROWSER_AGENT_WORKSPACE` | 학습·헬퍼 디렉터리를 벤더 밖에 두는 유일한 수단 |

### OS 별 소켓 경로와 브라우저 후보

소켓 경로 결정은 `src/supervisor/socket-path.mjs` 한 곳에 모여 있다.
`process.platform` 분기는 그 파일과 런처 밖으로 나가지 않는다.

| OS | 소켓 | 경로 모양 | 브라우저 후보 탐색(S2b) | 실측 |
|---|---|---|---|---|
| linux | unix 도메인 소켓 | `$XDG_RUNTIME_DIR/naia-ego-host-<adk 해시 12자>.sock` (없으면 `os.tmpdir()`) | Playwright chromium → 시스템 `chromium`/`google-chrome`. Flatpak Chrome 은 감지만 | 이 머신에서 실측 |
| darwin | unix 도메인 소켓 | 같음. 경로 상한이 104바이트라 ADK 경로 대신 해시를 쓴다 | `/Applications/Google Chrome.app/…`, `…/Microsoft Edge.app/…` | **미실측** |
| win32 | named pipe | `\\.\pipe\naia-ego-host-<adk 해시 12자>` (디렉터리 없음, 길이 제한 없음) | `%ProgramFiles%` / `%LOCALAPPDATA%` 의 `msedge.exe`·`chrome.exe` (#228 경로 목록) | **미실측**, windows4060 게이트 |

이름은 ADK 루트의 sha256 앞 12자다. 같은 ADK 는 같은 소켓, 다른 ADK 는 다른 소켓이다.
브라우저 후보 탐색과 `--remote-debugging-pipe` 기동은 **S2b** 몫이며 이 슬라이스에 없다.

## 다음 (S2b~)

S2a 까지는 전송 계층과 ABI 표면이다. CDP 백엔드는 **가짜**이며 실브라우저는 없다.
남은 것은 S2b 런처·lease(`--remote-debugging-pipe`, 브라우저 후보 탐색, SIGKILL→PID 소멸),
S2c 장부(격리 브라우저 컨텍스트·타깃 lease·원자적 저장), S2d 중계기(4.3.2 메서드 행렬,
기본 거부), S2e 작업·취소·스냅샷·캡처, S2f 실브라우저 적합성이다.
그때 지켜야 할 계약이 `docs/ego-runtime-abi.md` 이며, 각 행에 그 행을 밟는 테스트 이름이
병기돼 있다.
