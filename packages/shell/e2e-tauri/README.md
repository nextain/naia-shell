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
| 05-skill-system | skill_system_status → 메모리 정보 확인 |
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
