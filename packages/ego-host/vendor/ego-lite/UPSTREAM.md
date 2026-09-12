# ego-lite 벤더 트리 — 업스트림 추적

이 디렉터리는 공개 저장소 ego-lite 의 일부를 **커밋 고정으로 그대로 복사**한 것이다.
naia-shell 이슈 #582(에이전트 브라우저 호스트) 의 슬라이스 S1 산출물이며,
계약 문서는 `docs/progress/issue-582-ego-browser-host.md` 6절이다.

## 고정된 업스트림

- 업스트림 URL: <https://github.com/citrolabs/ego-lite>
- 라이선스: MIT (`LICENSE`, Copyright (c) 2026 CitroLabs)
- 고정 커밋: `5ca3c36cba2240b8df2e22ba32127747029039d5`
- 커밋 날짜: `2026-08-24`
- 마지막 동기화: `2026-09-09` — 실행자 Opus (이슈 #582 S1)
- 벤더 파일 수: `126`

## 복사 허용 목록

업스트림 저장소 루트를 기준으로 아래 경로만 복사한다. 경로 구조는 업스트림 그대로
미러링한다 — 벤더 런타임의 빌드 스크립트(`package/ego-browser/scripts/build.mjs:25`)가
`package/ego-browser` 의 두 단계 위를 저장소 루트로 보고 거기서 `skills/ego-browser` 를
찾기 때문에, 두 경로의 상대 위치를 바꾸면 빌드가 깨진다.

| 업스트림 경로 | 내용 |
|---|---|
| `package/ego-browser/**` | 헬퍼 런타임 전체 — `src/`, `scripts/`, `test/`, `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore` |
| `skills/ego-browser/**` | 업스트림 스킬 원본과 사이트 학습 예시(`learnings/`) |
| `spec/agent-skills-spec.md` | 에이전트 스킬 형식 명세 |
| `LICENSE` | MIT 전문 |
| `AGENTS.md` | 업스트림 저장소의 에이전트 규칙 (참고용) |
| `.github/workflows/publish-ego-browser-skill.yml` | **계획 문서에 빠져 있던 항목** — 아래 참조 |

허용 목록 밖의 업스트림 파일(`README.md`, `docs/`, `assets/`, `install.md`,
`lefthook.yml`, `CONTRIBUTING.md`, `.claude/`, `.codex/`, 그리고 위 하나를 뺀 `.github/`
전부)은 복사하지 않는다.

### 계획 문서 6절의 허용 목록 정정

계획(`docs/progress/issue-582-ego-browser-host.md` 6절)은 허용 목록을 다섯 항목으로
적었지만, 그대로 복사하면 벤더 런타임의 자체 단위 테스트가 299건 중 1건 실패한다.
`package/ego-browser/test/skill-publish-workflow.test.js:6-12` 가 저장소 루트의
`.github/workflows/publish-ego-browser-skill.yml` 을 읽어 그 내용을 검사하기 때문이다.

같은 계획이 "벤더 `npm test` 종료 코드 0" 을 S1 의 게이트로 요구하므로, 두 조항을
동시에 만족시키는 길은 이 파일 **하나**를 허용 목록에 넣는 것뿐이다. `.github/` 전체를
가져오지는 않는다. 이 파일은 `packages/ego-host/vendor/ego-lite/.github/workflows/`
아래에 있어 저장소 루트의 `.github/workflows/` 가 아니므로 우리 CI 가 실행하지 않는다.

빌드 산출물은 복사 대상이 아니고 추적도 하지 않는다:
`package/ego-browser/` 아래의 `dist/`, `node_modules/`, `artifacts/`, `.build.lock`,
`bin/`, `ego-browser.js`. (업스트림도 이들을 `.gitignore` 한다.)

## 원칙: 벤더 파일은 수정하지 않는다

이 트리의 **어떤 파일도 편집하지 않는다.** 한 글자라도 고치면
`node scripts/sync-ego-lite.mjs --check` 가 종료 코드 1 로 실패한다.

필요한 변경은 셋 중 하나로 처리한다.

1. 호스트 쪽 래핑으로 흡수한다(`packages/ego-host/src/`).
2. 업스트림에 PR 한다.
3. 스킬 문서에 한해 파생본을 둔다(아래).

### 예외 하나: 스킬은 파생본을 둔다

업스트림 스킬(`skills/ego-browser/SKILL.md`)은 "현재 사용자의 로그인 상태를 상속한다"고
안내하지만, 우리 정책은 비로그인 격리 공간과 헤드리스 인계 불가다. 이 충돌 때문에
스킬만 파생본을 갖는다.

- 파생본 위치: `packages/ego-host/skill/SKILL.md` — **벤더 밖이다.**
- 차이 근거: `packages/ego-host/skill/UPSTREAM-DIFF.md` (바꾼 문장과 이유)
- 이 두 파일은 아직 없다. 이슈 #582 **슬라이스 S4** 에서 만든다.
- 파생본이 생기면 `--ref` 동기화가 업스트림 이전판·신판·파생본의 3자 diff 를 출력한다.
  파생본이 없는 동안에는 건너뛴 사실만 출력한다.

## 무결성 검사

`MANIFEST.sha256` 에 허용 목록 파일 각각의 sha256 이 들어 있다(헤더 주석에 고정 커밋).
`--check` 는 네트워크 없이 이 목록과 대조하며, 다음을 모두 실패로 본다.

- 벤더 파일의 내용이 다르다(수정됨)
- MANIFEST 에 있는 파일이 벤더에 없다(삭제됨)
- MANIFEST 에 없는 파일이 벤더에 있다(추가됨)
- 허용 목록 밖 경로가 벤더에 있다
- MANIFEST 헤더 커밋과 이 문서의 고정 커밋이 다르다

판정은 **종료 코드**다. 0 이면 같고, 1 이면 다르다.

```bash
cd packages/ego-host && node scripts/sync-ego-lite.mjs --check
```

`MANIFEST.sha256` 은 GNU `sha256sum -c` 형식과 호환된다(주석 줄은 건너뛴다).

## 재동기화 절차

새 업스트림 커밋으로 올릴 때는 한 줄이면 된다.

```bash
cd packages/ego-host && node scripts/sync-ego-lite.mjs --ref <새 커밋 해시>
```

이 명령이 하는 일:

1. 업스트림을 임시 디렉터리에 얕게 받는다(`git fetch --depth 1 --filter=blob:none`).
2. `git archive` 로 허용 목록 경로만 꺼내 vendor 로 복사한다(허용 목록 밖이면 실패).
3. `MANIFEST.sha256` 과 이 문서의 고정 커밋·커밋 날짜·동기화 날짜·파일 수를 갱신한다.
4. 파생 스킬이 있으면 3자 diff 를 출력한다.
5. `git diff --stat` 으로 무엇이 바뀌었는지 보여준다.

그 다음 사람이 할 일: 3자 diff 를 읽고 파생 스킬을 갱신할지 판단하고,
`npm test`(벤더 설치 테스트)와 `--check` 를 다시 돌린 뒤 커밋한다.
동기화 커밋에는 이 문서의 갱신을 반드시 포함한다.
