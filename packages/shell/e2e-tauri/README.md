# Tauri Webview E2E Tests

실제 Tauri 앱 바이너리를 WebDriver로 자동화하는 진짜 E2E 테스트.
기존 `e2e/` (Playwright, Tauri IPC mock)와 달리 실제 webview를 조작합니다.

## 전제조건

```bash
# 1. WebKitWebDriver (Ubuntu)
sudo apt install webkit2gtk-driver

# 2. tauri-driver (Tauri WebDriver proxy)
cargo install tauri-driver --locked

# 3. Tauri 바이너리 빌드 (이미 빌드된 경우 생략)
cd shell && pnpm run tauri build --debug

# 4. Gateway 실행 중이어야 함
# lsof -ti:18789 으로 확인
```

## 환경변수

`shell/.env`에서 자동으로 로드합니다:

```
GEMINI_API_KEY=your-key-here
```

또는 직접 지정:

```bash
CAFE_E2E_API_KEY="your-key" pnpm run test:e2e:tauri
```

우선순위: `CAFE_E2E_API_KEY` > `GEMINI_API_KEY` (from .env)

## 실행

```bash
cd shell

# 기본 실행 (GUI 표시)
pnpm run test:e2e:tauri

# 헤드리스 (CI)
xvfb-run pnpm run test:e2e:tauri
```

## 동작 흐름

```
tauri-driver (port 4444)
  └→ naia-shell 바이너리 실행
       ├→ Gateway 연결 (ws://localhost:18789)
       ├→ Agent-core 스폰
       └→ WebKitGTK webview 렌더링
            └→ WebdriverIO가 CSS 셀렉터로 UI 조작
```

## 테스트 시나리오

| Spec | 설명 |
|------|------|
| 01-app-launch | 앱 실행, 설정 모달 표시 확인 |
| 02-configure | 설정 입력 (provider, API key, tools, gateway) + 저장 |
| 03-basic-chat | "안녕" → 응답 수신 확인 |
| 04-skill-time | skill_time 도구 실행 → 시간 정보 확인 |
| 06-skill-memo | skill_memo 저장 + 읽기 확인 |
| 07-cleanup | 메모 삭제 |

## 기술 스택

- **tauri-driver**: Tauri 바이너리 ↔ WebDriver 프록시
- **WebdriverIO v9**: WebDriver 클라이언트 (실제 WebKitGTK 조작)
- **Mocha**: 테스트 프레임워크 (180초 타임아웃)

## 트러블슈팅

- **tauri-driver 연결 실패**: `tauri-driver` 프로세스가 포트 4444에서 실행 중인지 확인
- **Gateway 연결 실패**: `lsof -ti:18789`로 Gateway 확인
- **LLM 응답 없음**: `.env`에 유효한 API 키가 있는지 확인
- **스킬 도구 미실행**: LLM이 도구를 사용하지 않을 수 있음 → 재실행 (비결정성)

## 단일 세션 배치 실행

여러 개의 작은 UI 시나리오를 같은 앱 세션에서 순서대로 실행해야 할 때는
명시적인 ADK plan을 사용합니다. plan은 `NAIA_E2E_ADK_PATH` 아래의
`e2e-batch-plan.json`이어야 하며, WDIO의 `--spec` 재정의와 glob은 허용되지
않습니다. 호출자는 `restartInstallExcluded: true`를 선언해야 합니다. 이 값은
plan의 계약을 검증하며, runner 자체는 앱 재시작이나 설치를 수행하지 않습니다.
개별 spec이 그 작업을 직접 호출하지 않는지는 spec 작성자가 보장합니다.

```json
{
  "version": 1,
  "contract": "single-session-ui",
  "restartInstallExcluded": true,
  "specs": [[
    "./specs/your-batch-case-a.spec.ts",
    "./specs/your-batch-case-b.spec.ts"
  ]]
}
```

위 두 경로는 예시 자리표시자입니다. 실행할 두 개의 작은 spec으로 바꾸고,
각 경로는 glob이 아닌 실제 파일을 가리켜야 합니다. 상대 경로는 이
`wdio.conf.batch.ts`가 있는 `e2e-tauri/` 디렉터리를 기준으로 해석되며,
runner가 WDIO를 시작하기 전에 파일 존재 여부를 확인합니다.

```bash
cd packages/shell
NAIA_E2E_ADK_PATH=/var/tmp/naia-adk \
NAIA_E2E_RUN_ID=batch-20260907-smoke \
pnpm exec wdio run e2e-tauri/wdio.conf.batch.ts
```

PowerShell:

```powershell
cd packages/shell
$env:NAIA_E2E_ADK_PATH = 'C:\qa\naia-adk'
$env:NAIA_E2E_RUN_ID = 'batch-smoke'
pnpm exec wdio run e2e-tauri/wdio.conf.batch.ts
```

The nested spec group is given to one WDIO worker with `bail: 0`, so an
independent test that WDIO schedules after a failed case can still run. A
	Mocha `before` or `beforeEach` failure may prevent later tests from starting.
	Hook failures and started-but-unfinished tests are recorded; the run summary
	flags unvisited scope, but does not enumerate tests that never started.
The batch reporter appends each case and hook result as it happens to
`<NAIA_E2E_ADK_PATH>/e2e-batch-results/<unique-run-id>/results.jsonl`; keep that
receipt with the plan and the other run artifacts. The reporter's failure
receipt and process status are the run result; do not infer success from an HTTP
response alone.
