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
├─ skill/                      파생 SKILL.md + UPSTREAM-DIFF.md + learnings/ (S4)
├─ src/supervisor/             감독자 — 프레이밍·소켓·CDP 다중화·소켓 경로·브라우저 탐색·런처·lease·조정·조립
├─ src/client/                 CLI 쪽 — 소켓 클라이언트·globalThis.ego 프록시·preload
├─ bin/ego-browser.mjs         런처 (`nodejs [--sdk-path <dist>]`)
├─ scripts/sync-ego-lite.mjs   --check / --provenance / --ref 동기화·출처 도구
├─ docs/ego-runtime-abi.md     런타임이 호스트에게 요구하는 실행 ABI (근거 줄 + 행별 테스트 이름)
├─ test/                       vendor-install · conformance · handshake · rpc-transport · provenance · discovery · launcher · lease
├─ THIRD_PARTY_NOTICES.md
└─ package.json
```

`vendor/ego-lite/` 안의 두 경로(`package/ego-browser` 와 `skills/ego-browser`)는
**상대 위치를 바꾸면 안 된다.** 빌드 스크립트가 `package/ego-browser` 의 두 단계 위를
저장소 루트로 보고 거기서 `skills/ego-browser` 를 찾는다.

## 원칙: 벤더 파일은 수정하지 않는다

`vendor/ego-lite/` 아래 파일은 한 글자도 고치지 않는다. 필요한 변경은 호스트 쪽 래핑으로
흡수하거나 업스트림에 PR 한다. 스킬 문서만 예외로 파생본을 두되, 파생본은 벤더 밖
(`skill/SKILL.md`)에 둔다. 자세한 내용은 `vendor/ego-lite/UPSTREAM.md`.

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
| linux | unix 도메인 소켓 | `$XDG_RUNTIME_DIR/naia-ego-host-<adk 해시 12자>.sock` (없으면 `os.tmpdir()`) | Playwright chromium → 시스템 `chromium`/`google-chrome`. Flatpak Chrome 은 감지만 | 이 머신에서 실측(S2a 소켓·S2b 기동) |
| darwin | unix 도메인 소켓 | 같음. 경로 상한이 104바이트라 ADK 경로 대신 해시를 쓴다 | `/Applications/Google Chrome.app/…`, `…/Microsoft Edge.app/…` | **미실측** |
| win32 | named pipe | `\\.\pipe\naia-ego-host-<adk 해시 12자>` (디렉터리 없음, 길이 제한 없음) | `%ProgramFiles%` / `%LOCALAPPDATA%` 의 `msedge.exe`·`chrome.exe` (#228 경로 목록) | **미실측**, windows4060 게이트 |

이름은 ADK 루트의 sha256 앞 12자다. 같은 ADK 는 같은 소켓, 다른 ADK 는 다른 소켓이다.
브라우저 후보 탐색과 `--remote-debugging-pipe` 기동은 **S2b** 몫이며 아래 절이 정본이다.
(위 표의 후보 열은 요약이다 — `#228 경로 목록` 은 이름만 참조했고 코드를 가져오지 않았다.)

## 런처·lease·시작 조정 (S2b)

여기서부터는 **실제 Chromium** 이다. 가짜 백엔드가 아니다.

### 무엇이 브라우저를 내리는가

```
감독자 정상 종료(stop)      Browser.close → 대기 → 파이프 닫기 → 그래도 남으면 SIGKILL → lease 삭제
감독자 크래시(SIGKILL)      파이프 EOF → Chromium 이 스스로 종료          ← 코드가 아니라 커널이 한다
다음 시작(조정)             lease 를 읽어 marker 가 일치하는 것만 회수     ← 크래시가 남긴 것을 치운다
```

가운데 줄이 핵심이다. Chromium 을 `--remote-debugging-pipe` 로 띄우면 자식의 fd 3·4 가 CDP 통로가
되고, Chromium 은 그 파이프의 EOF 를 연결 해제로 읽어 스스로 닫는다. 감독자가 SIGKILL 로 죽어
정리 코드가 한 줄도 못 돌아도 브라우저는 남지 않는다. **이 머신에서 실측: 200~201ms.**

이것이 성립하려면 부모 쪽 파이프 끝의 유일한 소유자가 감독자여야 한다(계약 4.8). 그래서
`chrome-launcher.mjs` 는 부모 쪽 스트림을 클로저 밖으로 내보내지 않고(반환 핸들에 child 객체도
스트림도 없다), 다른 모든 spawn 은 stdio 를 세 칸으로 명시한다. 테스트가 런처 뒤에 자식을 하나
띄워 그 자식의 `/proc/<pid>/fd` 에 CDP 통로가 없음을 실측한다. (libuv 는 stdio 파이프를
socketpair 로 만들어 `/proc` 에 `socket:[N]` 으로 보인다 — `pipe:` 만 찾는 탐침은 늘 빈손이다.)

### lease

`<ADK>/ego-host/lease.json` 에 원자적으로(임시 파일 + rename) 쓴다.

```json
{ "nonce": "…", "marker": "--naia-ego-marker=…", "startedAt": "…", "pid": 1234,
  "executable": "…", "profileDir": "…", "socketPath": "…", "supervisorPid": 5678 }
```

PID 는 재사용된다. 그래서 nonce 를 Chromium 명령줄에 `--naia-ego-marker=<nonce>` 로 심고,
회수 전에 그 PID 의 명령줄에 같은 nonce 가 있는지 본다. **Chromium 은 시작하며 argv 를 통째로
다시 써서 `/proc/<pid>/cmdline` 이 NUL 이 아니라 공백으로 이어 붙는다**(실측) — 그래서 토큰
판정이 `\0` 과 공백을 둘 다 구분자로 본다.

### 시작 조정

| 상태 | 판정 | 하는 일 |
|---|---|---|
| PID 살아 있고 marker 일치 | `reclaimed` (기본) / `adopted` (`adopt: true`) | SIGTERM → 대기 → SIGKILL, lease 삭제 / 그대로 물려받음 |
| PID 살아 있으나 marker 불일치 | `foreign` | **아무것도 하지 않는다.** 남의 프로세스다. 기록만 남긴다 |
| marker 를 확인할 수 없음(win32) | `unverified` | 회수하지 않는다. 고아 1 로 기록 (windows4060 게이트) |
| PID 없음 | `stale` | lease 만 지운다 — 고아 0 |
| lease 가 깨짐 | `unreadable` | 아무 PID 도 건드리지 않고 파일만 치운다 |

`stop()` 은 lease 와 소켓 파일을 지우고 **프로필 디렉터리는 남긴다**. 프로필을 지우는 것은
사람의 결정이다.

### OS 별 브라우저 후보 (계약 4.9)

`EGO_HOST_BROWSER` 가 있으면 언제나 최우선이다. 없으면 아래 순서로 **존재하는 첫 후보**를 쓴다.

| OS | 후보 순서 | 프로세스 확인 | 실측 |
|---|---|---|---|
| linux | Playwright chromium(`$PLAYWRIGHT_BROWSERS_PATH` 또는 `~/.cache/ms-playwright`, `chrome-linux64`·`chrome-linux` 둘 다, 빌드 번호 큰 것부터) → PATH 의 `chromium`·`chromium-browser`·`google-chrome`·`google-chrome-stable` → Flatpak Chrome(**감지만**) | `/proc/<pid>/cmdline` + marker | **실측** |
| win32 | Playwright chromium(`%LOCALAPPDATA%\ms-playwright\…\chrome-win\chrome.exe`) → `%ProgramFiles(x86)%`·`%ProgramFiles%` 의 `Microsoft\Edge\Application\msedge.exe` → `%ProgramFiles%`·`%ProgramFiles(x86)%`·`%LOCALAPPDATA%` 의 `Google\Chrome\Application\chrome.exe`. 레지스트리 App Paths 는 **상수만 두고 조회하지 않는다** | `process.kill(pid, 0)` 생존만. marker 는 `unverified` | **미실측** (windows4060 게이트) |
| darwin | Playwright chromium(`~/Library/Caches/ms-playwright/…/Chromium.app`) → `/Applications/Google Chrome.app` → `Microsoft Edge.app` → `Chromium.app` | `ps -p <pid> -o command=` + marker | **미실측** (기기 없음) |

Flatpak Chrome 이 제외되는 이유는 샌드박스가 fd 3·4 를 넘겨주지 못할 수 있어서다(계약 12절).
경로 이름이 아니라 **파일 내용**으로 판별한다 — 이 머신의 `~/.local/bin/google-chrome` 은
`exec flatpak run com.google.Chrome "$@"` 두 줄짜리 래퍼다. 쓰려면 `EGO_HOST_BROWSER` 로 명시한다.

세 OS 의 후보 목록·경로 구분자·marker 확인 분기는 `platform`·`env`·`fs` 를 주입한 단위 테스트로
이 머신에서 전부 검증한다. **기동 실측은 linux 뿐이다.**

## 다음 (S2c~)

S2b 까지가 "브라우저를 띄우고, 소유하고, 어떻게 죽어도 고아를 남기지 않는다"이다.
남은 것은 S2c 장부(격리 브라우저 컨텍스트·타깃 lease·원자적 저장), S2d 중계기(4.3.2 메서드 행렬,
기본 거부), S2e 작업·취소·스냅샷·캡처(무간섭 (2) 활성 창 불변 포함), S2f 실브라우저 적합성이다.
그때 지켜야 할 계약이 `docs/ego-runtime-abi.md` 이며, 각 행에 그 행을 밟는 테스트 이름이
병기돼 있다.


## 파생 스킬과 사이트 학습 (S4)

```
skill/
├─ SKILL.md                파생 스킬 — 에이전트가 읽는 문서
├─ UPSTREAM-DIFF.md        바꾼 문장마다 원문·파생문·이유
└─ learnings/<site>/       사이트 학습 (manifest.json · notes · tools · browser-tools)
```

파생 결정은 넷이다. 비로그인 격리(로그인 상속 문장 삭제), 헤드리스 인계 불가(인계·회수·claim 은
거부되고 사람이 필요하면 멈추고 보고), 지원 범위는 `docs/helper-matrix.md` 의 측정 결과, 두
진입점의 승인 등급(형식 도구 대 heredoc 건별 승인). 근거는 `skill/UPSTREAM-DIFF.md` 의 표다.

```bash
# 파생본·표·학습을 한 번에 검사 (지원 목록 누출, cliLog 자리, 로그인 상속, 표의 인용, 학습 형식)
node --test test/skill.test.mjs

# 벤더 검사기로 학습 형식만 따로
cd vendor/ego-lite/package/ego-browser \
  && EGO_BROWSER_AGENT_WORKSPACE=../../../../skill node dist/scripts/validate-site-skills.js

# 업스트림이 올라가면 3자 diff 로 파생 결정을 다시 본다
node scripts/sync-ego-lite.mjs --ref <커밋>
```

학습 루트는 `EGO_BROWSER_AGENT_WORKSPACE` 로 지정한다. 어댑터는 ADK 별 작업 공간을 주므로,
저장소의 `skill/learnings/` 는 **원본**이고 실행 시 루트는 ADK 안이다.
