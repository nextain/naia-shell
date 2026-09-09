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
├─ scripts/sync-ego-lite.mjs   --check / --ref 동기화 도구
├─ docs/ego-runtime-abi.md     런타임이 호스트에게 요구하는 실행 ABI (근거 줄 포함)
├─ test/vendor-install.test.mjs 설치·무결성 검증
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

# 이 패키지의 검증 — 무결성 + 임의 디렉터리 설치·빌드·단위 테스트 + bin 동작
npm test

# 벤더 런타임 자신의 단위 테스트를 벤더 디렉터리에서 그대로 실행
npm run vendor:test

# 새 업스트림 커밋으로 올린다
node scripts/sync-ego-lite.mjs --ref <커밋 해시>
```

## 다음 (S2)

이 패키지는 슬라이스 S2 에서 **감독자(supervisor)와 CLI** 를 갖는다. 감독자는 셸이
lease 로 소유하는 장기 프로세스로 Chromium 을 헤드리스로 띄우고, 작업 공간(브라우저
컨텍스트) 장부와 CDP 중계기, 작업별 세션·취소·시간 제한, 접근성 스냅샷과 화면 캡처를
맡는다. CLI 의 `nodejs` 서브커맨드는 벤더 런타임에 `globalThis.ego` 를 소켓 프록시로
주입하는 얇은 클라이언트가 된다. 그때 지켜야 할 계약이 `docs/ego-runtime-abi.md` 다.
