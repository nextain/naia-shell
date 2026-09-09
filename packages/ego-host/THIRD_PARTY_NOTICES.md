# 제3자 고지 (Third-Party Notices)

`packages/ego-host` 는 아래 제3자 소프트웨어를 포함하거나 참조한다.

<!-- 참조 구현 citrolabs/ego-lite PR #228(커밋 4f99b181960a)에서 코드를 가져오면
     그 출처와 MIT 저작권 표시를 이 문서에 추가한다 — 이슈 #582 슬라이스 S2. -->

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
