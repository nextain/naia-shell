# PR #894 Windows 설치자 CI 조사

일꾼 보고. 같은 PR 머리에서 집중 시험이 한 번 실패하고 재실행에서 통과했다. PR 변경과 실패의 직접 연관을 뒷받침하는 증거는 확인되지 않았다. Win32 6이 어느 콘솔 연결에서 발생했는지와 원인은 미확인이다. [PR #894](https://github.com/nextain/naia-shell/pull/894) · [설치자 CI run](https://github.com/nextain/naia-shell/actions/runs/45790165716)

## 1. 원래 실패

PR 머리는 `4f6630c395c292c4d7400daa67e0e0b8e3ae3036`이고 비교 바탕 main은 `aaeb77a02bf0092f53cd35783bbf504fe5ad091b`다. Windows attempt 1 로그 2365행의 `ollama_runtime::tests::ollama_no_window_child_supports_ctrl_break_shutdown`이 실패했다. 2371행은 패닉 위치 `src\ollama_runtime.rs:6084:9`를, 2372행은 아래 오류를 기록한다. [Windows 실패 job](https://github.com/nextain/naia-shell/actions/runs/45790165716/job/139806874173)

```text
expected no console window after attaching, got Err(Os { code: 6, kind: Uncategorized, message: "The handle is invalid." })
```

2379행은 `0 passed; 1 failed`(0.63초)다. 2382행은 실패한 명령 `cargo test --manifest-path src-tauri/Cargo.toml ollama_no_window_child_supports_ctrl_break_shutdown --lib`를, 2383행은 `ELIFECYCLE` 종료 코드 1을, 2384행은 GitHub Actions의 `Process completed with exit code 1.`을 기록한다.

## 2. PR 변경 범위

`gh pr diff 894 -R nextain/naia-shell --name-only`와 `--patch`(각 종료 0), 그리고 바탕과 PR 머리의 GitHub compare(종료 0, `ahead_by=1`, `behind_by=0`)가 상단 막대 설정 기어 순서에 관련된 다섯 파일을 가리킨다.

- `docs/requirements.md`
- `docs/user-scenarios.md`
- `packages/shell/e2e/web-gpu-a-ui.spec.ts`
- `packages/shell/src/components/AppBar.tsx`
- `packages/shell/src/components/__tests__/AppBar.test.tsx`

실패 시험 본체 `packages/shell/src-tauri/src/ollama_runtime.rs:6028`의 blob은 `95593ed97967bd2287f55b64bf606d6ff8106aab`이고, 호출부 `packages/shell/scripts/stage-runtime.mjs:653`의 blob은 `bbd59db7a5f587d3f0833269cdd71490e5382936`이다. 로컬 바탕과 PR 머리의 GitHub 트리 조회(각 종료 0)에서 두 blob이 각각 일치했다. [바탕과 PR 머리 비교](https://github.com/nextain/naia-shell/compare/aaeb77a02bf0092f53cd35783bbf504fe5ad091b...4f6630c395c292c4d7400daa67e0e0b8e3ae3036)

## 3. 같은 집중 시험의 이력

다섯 Windows 로그에서 runner `2.338.2`, 이미지 `windows-2025-vs2026` 버전 `20261116.315.1`이 일치한다. job 로그 조회와 해당 시험 결과 추출은 각각 종료 0이었다.

| 실행 | 시험 SHA | 집중 시험 결과 | Windows job |
| --- | --- | --- | --- |
| 지정 바탕 main | `aaeb77a02bf0092f53cd35783bbf504fe5ad091b` | 통과, 0.55초, 로그 2314·2316행 | 시험 이후 ffmpeg 서명 오류로 실패, 4880–4881행. [job](https://github.com/nextain/naia-shell/actions/runs/45494756698/job/138842604487) |
| #893 | `1c2fb84ac9f4dcff477fe97d24bcd32db28f5e02` | 통과, 0.74초, 2418·2420행 | [성공](https://github.com/nextain/naia-shell/actions/runs/45785752011/job/139791977098) |
| 비교 브랜치 | `04e1bb7208202a7eb5a351f33267998527e9935e` | 통과, 0.55초, 2426·2428행 | [성공](https://github.com/nextain/naia-shell/actions/runs/45892434442/job/140174419983) |
| #894 attempt 1 | `4f6630c395c292c4d7400daa67e0e0b8e3ae3036` | 실패, 0.63초, 2365·2379행 | [실패](https://github.com/nextain/naia-shell/actions/runs/45790165716/job/139806874173) |
| #894 attempt 2 | `4f6630c395c292c4d7400daa67e0e0b8e3ae3036` | 통과, 0.55초, 2316·2318행 | [성공](https://github.com/nextain/naia-shell/actions/runs/45790165716/job/140392027630) |

## 4. 재실행 이력

1차 조사 `alpha-alpha-pr894-win-test-20261127/out.log:629–631`에 `gh run rerun 45790165716 --failed -R nextain/naia-shell` 실행 및 종료 0이 기록돼 있다. attempt 2는 2026-11-27 08:22:33 UTC에 시작했다. 2차 조사는 이미 진행 중이던 Windows job을 관측했고 09:27:47 UTC 완료를 확인했다. 시험 로그 2318행은 `1 passed; 0 failed`다. [Windows 재실행 job](https://github.com/nextain/naia-shell/actions/runs/45790165716/job/140392027630)

attempt 2의 API 조회(종료 0)에서 run 전체는 `success`다. 빌드 네 job(Windows, Ubuntu, macOS Intel, macOS ARM)은 `success`, 후속 세 job(`regression-gate`, `macos-universal`, `macos-universal-smoke`)은 `skipped`다. Windows 번들·아티팩트 검사·MSI 검증·NSIS 설치 단계는 모두 `success`다. [attempt 2](https://github.com/nextain/naia-shell/actions/runs/45790165716/attempts/2)

## 5. 원인 가설과 조건부 고침 제안

`ollama_runtime.rs:6051`의 500ms 고정 대기 후 `with_attached_child_console`이 실제 자식에 `AttachConsole(child_pid)`를 시도한다(1590행). Win32 6(`ERROR_INVALID_HANDLE`)은 연결 대상 프로세스에 콘솔이 없음을 뜻한다. 자식 연결이 실패하면 도우미는 창 검사 콜백 실행 전에 `Err`를 반환하며, 이전 콘솔 복구를 시도할 때 그 결과를 버린다(1590–1598행). 창 조회가 끝난 뒤 이전 콘솔 복구가 실패해도 도우미는 같은 형태의 `Err`를 반환할 수 있다(1600–1602행). 실패 로그에 연결 대상 PID나 실패 단계가 없어 두 경로를 가를 수 없다. 콘솔에 붙지 않은 호출 프로세스에서도 `GetConsoleWindow()`는 null일 수 있으므로 창 검사는 실제 자식 콘솔에 붙은 상태에서 실행해야 한다. [AttachConsole](https://learn.microsoft.com/en-us/windows/console/attachconsole) · [GetConsoleWindow](https://learn.microsoft.com/en-us/windows/console/getconsolewindow)

자식 콘솔의 준비 지연은 가설이다. 현재 로그에는 자식 콘솔이 준비된 시점이 없다. 시험은 콘솔 잠금을 잡고 창 검사 결과를 받은 뒤 종료 요청을 호출한다(6031, 6056–6061행). 6084행에서 패닉이 발생한 attempt의 로그에는 후속 CTRL_BREAK와 부모 콘솔 복원 검증 결과가 나오지 않았다.

준비 지연을 확인하면 시험의 고정 대기(6051행)와 시험용 attach 도우미(1571–1606행)에 제한 시간 내 재시도를 둔다. 살아 있는 자식에 대한 Win32 6만 재시도하고 다른 attach 오류, 자식 조기 종료, 시간 초과를 실패로 보고한다. 실제 attach에 성공한 뒤 자식 콘솔에서 창 핸들 부재를 확인한다(6055–6056행). 원래 콘솔 상태 복구를 성공·실패 경로 모두에서 확인하고 복구 실패를 오류로 남긴다. 그 뒤 기존 CTRL_BREAK 경로로 자식이 제한 시간 안에 종료하는지와 부모 콘솔 상태가 복원됐는지를 확인한다(6059–6098행). 이 조건은 [Windows 시험 계약](../user-scenarios.md#test-coverage-map-p02)을 따른다.
