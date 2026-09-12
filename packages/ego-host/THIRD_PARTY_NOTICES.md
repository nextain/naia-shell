# 제3자 고지 (Third-Party Notices)

`packages/ego-host` 는 아래 제3자 소프트웨어를 포함하거나 참조한다.

---

## ego-lite PR #228 (`package/ego-windows-host`) — 참조 구현

- 출처: <https://github.com/citrolabs/ego-lite/pull/228>
- 커밋: `4f99b181960afa4602706345ff2b09d32f3f42a3` (2026-08-24)
- 저자: hotragn
- 라이선스: MIT (ego-lite 저장소와 동일. 전문은 아래 ego-lite 절)
- 가져온 위치: `packages/ego-host/src/supervisor/cdp-mux.mjs` 의 pending 맵·요청 타이머·응답
  id 대조 골격. 파일 머리 주석에 같은 출처를 적어 두었다.
- **가져오지 않은 것**: #228 의 핵심 설계인 *원문 통과*(에이전트 연결 하나를 그대로 relay 하는
  `sendRaw`)는 쓰지 않는다. 우리 감독자는 연결마다 독립 id 공간을 두고 Chromium 쪽 id 만
  재작성하며, 라우팅·이벤트 필터·정책 훅을 통과한 것만 위로 올린다(#582 계약 4.3).
  `ego-bridge.ts` 의 작업 공간 표면은 모양(ownership 문자열, `{taskSpaces}`, `{error,error_code}`)
  만 참고했고 헤드리스 정책은 우리 것이다(인계·회수·claim 거부).

---

## ego-lite

- 출처: <https://github.com/citrolabs/ego-lite>
- 고정 커밋: `5ca3c36cba2240b8df2e22ba32127747029039d5` (2026-08-24)
- 포함 위치: `packages/ego-host/vendor/ego-lite/`
- 포함 범위: `package/ego-browser/**`, `skills/ego-browser/**`,
  `spec/agent-skills-spec.md`, `LICENSE`, `AGENTS.md` (허용 목록은
  `vendor/ego-lite/UPSTREAM.md` 참조)
- 수정 여부: **없음.** 벤더 트리는 업스트림 그대로이며
  `node scripts/sync-ego-lite.mjs --check` 가 sha256 으로 이를 강제한다.
- 라이선스: MIT

```
MIT License

Copyright (c) 2026 CitroLabs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### ego-lite 의 런타임 의존성

벤더 런타임(`package/ego-browser`)의 실행 시 의존성은 `acorn` 하나다(MIT).
나머지는 개발 의존성(esbuild, rollup, typescript, prettier, lefthook 등)이며
`npm ci` 로 각자의 저장소에서 받는다. 이 저장소는 그 코드를 포함하지 않는다.

ego-lite 의 브라우저 **앱 바이너리**는 이 저장소에 포함되지 않으며 사용하지도
않는다. 우리는 헬퍼 런타임만 쓰고 브라우저 자리는 일반 Chromium 을 CDP 로
붙이는 자체 호스트가 맡는다(#582 S2).
