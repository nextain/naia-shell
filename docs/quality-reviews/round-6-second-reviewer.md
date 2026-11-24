조사를 마쳤습니다. 작업 트리는 시작 상태와 동일하게 되돌려 두었고(`git status --porcelain` 이 세션 시작 시점의 untracked 목록과 같습니다), 커밋이나 push 는 하지 않았습니다.

---

# 판정: NOT CLEAN

발견 다섯 가지입니다. 그중 둘은 게이트가 초록을 보고하면서 실제로는 보증하지 않는 부류이고, 하나는 문서가 정한 절차로는 완결성 게이트가 초록이 될 수 없는 자리입니다.

감사 중에 다른 세션이 이 저장소에 커밋을 하나 더 올렸습니다(`d8e5d24d` → `3c472bc3`). 아래 판정은 모두 `3c472bc3` 기준이며, 해당 시점에 `packages/shell/src/lib/db.ts` 가 다른 세션의 임시 편집으로 더러워져 있던 것은 제 발견에서 제외했습니다.

---

## 발견 1 — UC 추적 게이트가 깨끗한 체크아웃에서 붉습니다. 이 개발 기계에서만 초록입니다

**파일:** `scripts/check-uc-traceability.mjs:159` (`collectNames(".")`), `scripts/check-uc-traceability.mjs:191` (`BASELINE_BROKEN_REFS = 29`)

**무엇이 잘못되었나.** 게이트는 커버리지 표가 가리키는 파일이 실재하는지 봅니다. 그런데 파일 이름 목록을 만들 때 작업 디렉터리 전체를 걷습니다. 이 기계의 저장소 안에는 `naia-agent-worktrees/` 라는 **다른 저장소(naia-agent)의 체크아웃 여섯 벌**이 추적되지 않은 채 놓여 있고, 게이트가 그것까지 훑습니다. `docs/user-scenarios.md` 가 검증 지점으로 적어 둔 파일 두 개가 정확히 그 안에서만 발견됩니다.

- `docs/user-scenarios.md:141` — `conversation-log.contract.test.ts`
- `docs/user-scenarios.md:684` — `pi-role-runner.contract.test.ts`

두 파일 모두 `git ls-files` 에 없고, `find` 로도 `naia-agent-worktrees/shell-pair-*/src/test/` 안에서만 나옵니다.

**실제로 확인한 것.** `git archive HEAD` 로 깨끗한 체크아웃을 만들어 같은 스크립트를 돌렸습니다.

```
clean-checkout uc-trace EXIT=1   (표가 가리키는데 없는 파일 31 > baseline 29)
worktree     uc-trace EXIT=0
```

이 붉음은 최근 커밋 하나의 문제가 아닙니다. `3c472bc3`, `d8e5d24d`, `6be04c14`, `452d4635`, `09104d35` 다섯 시점 모두 깨끗한 체크아웃에서 31 대 29 로 붉습니다. 즉 baseline 29 는 처음부터 이 기계의 우연한 상태에 맞춰 잡힌 숫자입니다.

**왜 목표 미충족인가.** 이 게이트는 `.github/workflows/self-trust-gates.yml:106` 에 등록되어 있고, `docs/quality-process.md:197` 은 배포 전 절차의 첫 줄을 "게이트가 초록이다" 로 못박습니다. 그 첫 줄이 실제 CI 환경에서는 성립한 적이 없습니다. 같은 워크플로가 짝 naia-agent 를 받아 오기는 하지만 그것은 저장소 밖(`../naia-agent`)이고 이 게이트보다 예순여덟 줄 뒤(`self-trust-gates.yml:174`)입니다.

그리고 이것은 루크가 요구한 "추적 가능성" 자체의 구멍이기도 합니다. UC 두 자리가 이 저장소에 없는 파일을 가리키고 있는데, 그것을 잡으라고 만든 게이트가 스캔 범위를 저장소 밖까지 넓힌 탓에 못 잡았습니다. 지금까지 다섯 번의 적대리뷰가 반복해 짚은 "거짓 통과는 baseline 이 아니라 범위 조건에서 나온다" 와 정확히 같은 형태입니다.

**어떤 상황에서 문제가 되나.** 새로 clone 한 기계나 CI 러너에서 `node scripts/check-uc-traceability.mjs` 를 돌리는 순간 붉어집니다. `docs/quality-process.md:291` 의 열려 있는 것 5번이 적은 "스물아홉 개" 도 이 기계에서만 참인 숫자입니다.

---

## 발견 2 — 완결성 게이트에 기계 명단 검사가 없어, 명단 밖 기계의 지문 없는 기록이 커버리지로 세어집니다

**파일:** `scripts/check-regression-complete.mjs:57-88` (명단을 전혀 읽지 않음), `scripts/check-regression-complete.mjs:80-85` (지문 없는 기록을 통과시키는 예외)

**무엇이 잘못되었나.** 러너와 게이트의 판정 기준이 서로 다릅니다.

러너는 명단에 없는 기계를 거부합니다. 직접 확인했습니다.

```
$ node scripts/run-regression.mjs --machine=legacy-machine-3090 --tier=deterministic_ci --dry-run
docs/regression-runs/machines.json 에 이 기계(legacy-machine-3090)가 없다.
지금 도는 기계: naia-os-3090, win-rtx4060
```

그런데 완결성 게이트는 `docs/regression-runs/` 안의 모든 `.json` 을 읽을 뿐 명단을 참조하지 않습니다. `legacy-machine-3090` 는 `machines.json` 에 없고 이력에도 등장한 적이 없는데(`git log -p -- docs/regression-runs/machines.json` 에 그 이름이 없습니다), 기록 여섯 개가 커밋되어 있고 게이트가 그것을 판정 대상으로 셉니다.

더 나쁜 것은 그 여섯 개에 `ranOn` 지문이 아예 없다는 점입니다. `check-regression-complete.mjs:80-85` 는 "옛 형식 기록에는 지문이 없다 … 통과시키되" 라는 이유로 지문 없는 기록을 인벤토리 대조에서 면제합니다. 그래서 README 가 자신의 신뢰 근거로 내세우는 "인벤토리가 바뀐 뒤의 낡은 기록을 뺀다" 는 보호가, 지문을 안 적은 기록에는 적용되지 않습니다.

**실제로 확인한 것.** 지금 `node scripts/check-regression-complete.mjs --max-age-hours=24` 를 돌리면 이렇게 나옵니다.

```
기계 2대(naia-os-3090, legacy-machine-3090)
스펙 123 중 실제로 돈 것 14 … 아무도 맡지 않은 것 109
```

이 14 중 일곱이 `legacy-machine-3090` 에서 왔습니다. 그중 두 개가 특히 문제입니다.

- `13-nva-capability.spec.ts`
- `environment-dispatch.spec.ts`

두 스펙은 현재 인벤토리에서 `win-rtx4060` 의 몫이고, 그 기계의 가장 최근 기록(`win-rtx4060-2026-09-05T06-22-29-192Z.json`, 06:28 종료)이 둘 다 **실패**로 적어 두었습니다. 그런데 그 기록은 인벤토리 지문이 달라 판정에서 빠지고, 03:47 에 끝난 `legacy-machine-3090` 의 더 오래된 통과가 대신 커버리지로 세어집니다. 신선한 실패를 낡은 통과가 덮는 구조입니다. 이 프로세스가 없애려던 바로 그 형태입니다.

반대 방향도 확인했습니다. 명단의 두 기계가 세 등급 전부를 돌아 123개 전부를 통과시킨 합성 기록을 넣어 보았습니다.

```
스펙 123 중 실제로 돈 것 123 … 아무도 맡지 않은 것 0
❌ 실패한 기계: legacy-machine-3090(failed)
EXIT=1
```

즉 명단의 기계들이 무엇을 하든, 명단 밖 기계의 실패 기록이 창 안에 있는 동안에는 배포 게이트가 초록이 될 수 없습니다. (합성 기록은 전부 삭제했고 `docs/regression-runs/` 는 파일 스무 개로 원래대로입니다.)

**왜 목표 미충족인가.** 루크의 요구는 "다수의 pc로 나누어서 수행"이고, `machines.json` 은 그 나눔의 유일한 출처로 설계되었습니다. 게이트가 그 출처를 보지 않으면 나눔의 무결성이 판정되지 않습니다. 문서가 열려 있는 것 10번에서 인정한 "위조는 막지 못한다" 와는 다른 문제입니다. 이것은 악의가 아니라 실수로 생기는 부류이고, README 가 자기 신뢰 근거로 "여기서 막는 것은 실수다" 라고 적어 둔 바로 그 범주입니다.

---

## 발견 3 — 등급을 나눠 돌리면(문서의 예시가 보여주는 그 형태로) 앞 등급의 커버리지가 조용히 사라집니다

**파일:** `scripts/check-regression-complete.mjs:102-107` (기계별 최신 실행 하나만 봄), `docs/regression-runs/README.md`(명령 예시), `docs/quality-process.md:170,187`

**무엇이 잘못되었나.** 게이트는 기계마다 가장 최근 기록 하나만 봅니다. 그 이유는 주석에 잘 적혀 있습니다 — 오전 실패가 오후 수정 뒤에도 창에 남아 게이트를 계속 붉히지 않도록 하려는 것입니다. 그런데 같은 규칙이, 한 기계가 등급을 나눠 여러 번 돌린 경우에도 앞 실행을 통째로 버립니다.

문서의 명령 예시는 단일 등급 형태입니다.

```
node scripts/run-regression.mjs --machine=<명단의 이름> --tier=deterministic_ci
```

실제로도 두 기계 모두 `--tier=deterministic_ci` 하나만 지정해 돌았습니다(기록의 `tiers` 필드가 그렇습니다). 그리고 `credentialed_live` 는 키가 필요하고 `native_local` 은 장치가 필요하므로, 등급을 따로 돌리는 것이 자연스러운 운용입니다. `docs/quality-process.md:208` 은 오히려 한 기계에서 여러 종류를 동시에 돌리지 말라고까지 적습니다.

**실제로 확인한 것.** 명단의 두 기계 × 세 등급, 여섯 개 기록을 만들었습니다. 전부 `status: passed`, 전부 자기 몫을 `executed` 에 온전히 적었고, 여섯 개를 합치면 123개 전부가 실행·통과입니다.

```
스펙 123 중 실제로 돈 것 18 … 아무도 맡지 않은 것 105
EXIT=1
```

모든 스펙이 실제로 돌고 통과했는데도 게이트는 105개가 미실행이라고 말합니다. 마지막 등급의 기록만 살아남았기 때문입니다.

**왜 목표 미충족인가.** 감사 질문 3번이 정확히 이것을 묻습니다 — "문서가 정한 절차로 완결성 게이트가 초록이 될 수 있는가". 문서가 예시로 보여주고 두 기계가 실제로 따른 절차로는 초록이 되지 않습니다. 4회차 리뷰가 "집계가 전부-아니면-전무라 문서가 정한 절차로는 완결성 게이트가 원리적으로 초록이 될 수 없었다" 로 짚었던 것과 같은 결과가, 그 뒤 추가된 "최신 하나만 본다" 규칙 때문에 다른 경로로 되살아났습니다. README 는 `executed` 를 빠뜨리면 미실행으로 집계된다는 함정은 적어 두었지만, 이 함정은 어디에도 적혀 있지 않습니다.

---

## 발견 4 — 성능 축을 정의하는 절이 자기가 강제하는 수치를 부정합니다

**파일:** `docs/quality-process.md:87-90`

원문은 이렇습니다.

> **시간은 한도가 없다.** 첫 응답까지, 발화가 시작되기까지, 앱이 뜨기까지를 단정하는 곳이 없다. 지금은 타임아웃이 사실상의 한도인데, 그것은 "안 죽었다" 만 말한다.

그런데 한도는 있고, 실제로 작동합니다. 직접 확인했습니다.

```
$ pnpm exec playwright test e2e/900-startup-latency.spec.ts
[startup-latency] 콜드 1022ms (한도 2000ms) / 웜 중앙값 134ms (한도 500ms)
1 passed          EXIT=0
```

`packages/shell/src/App.tsx` 의 설정 하이드레이션에서 `setLocaleHydrated(true)` 직전에 1.5초를 넣었더니 이렇게 바뀝니다.

```
Error: 콜드 시작이 2713ms — 한도 2000ms 를 넘었다.
1 failed          EXIT=1
```

(주입은 즉시 원복했고 `git status` 로 확인했습니다.)

**왜 목표 미충족인가.** 루크가 요구한 산출물은 "퀄리티, 사용성, 성능에 대한 기준"입니다. 성능 기준을 읽으러 온 사람이 펼치는 절이 "앱이 뜨기까지를 단정하는 곳이 없다" 라고 말합니다. 실제 수치(콜드 2,000ms · 웜 500ms)는 열려 있는 것 3번과 `docs/user-scenarios.md:1620`, 그리고 스펙 파일 안에만 있습니다. 기준 문서가 자기 기준을 담고 있지 않습니다. 세 축 중 다른 둘은 이 절에서 재는 자리와 게이트를 지목하는데 성능 축만 그렇지 않습니다.

---

## 발견 5 — "지금 열려 있는 것" 목록의 2번·4번이 HEAD 상태와 어긋납니다

**파일:** `docs/quality-process.md:269-275`, `docs/quality-process.md:285`

2번은 이렇게 적혀 있습니다.

> **다수 기계로 나눈 실행이 아직 0회다.** 지금까지의 회귀 기록은 전부 한 기계(`naia-os-3090`)에서 `deterministic_ci` 만 돈 것이고 … `credentialed_live` 92개와 `native_local` 3개는 어느 기록에도 없다

HEAD 의 `docs/regression-runs/` 에는 커밋된 기록이 열여섯 개 있고, 그중 여섯 개가 `legacy-machine-3090`, 두 개가 `win-rtx4060` 입니다. 그리고 등급 수도 틀렸습니다 — 같은 문서 109~111줄의 표와 `docs/e2e-inventory.json` 이 모두 `credentialed_live` 90, `native_local` 8 이라고 말합니다. 4번의 "588줄(66파일)" 도 게이트가 실측하고 baseline 으로 박아 둔 585줄과 다릅니다.

**왜 목표 미충족인가.** 리뷰 자료가 이 목록을 정직성의 근거로 제시했고, 배포 판단을 하는 사람이 읽는 곳이 여기입니다. 2번을 읽은 사람은 두 번째 기계가 아직 한 줄도 남기지 않았다고 결론짓게 되는데, 실제로는 남겼고 그 기록이 (발견 2·3 때문에) 판정에서 빠지고 있다는 것이 지금의 진짜 상태입니다. 두 사실은 대응이 완전히 다릅니다.

---

## 목표 요구별로 확인한 결과

**세 축의 실패 수치.** 성능은 크기(`packages/shell/bundle-budget.json` 의 진입 원본 500KB · gzip 160KB · 배포본 170MiB)와 시간(콜드 2,000ms · 웜 500ms) 둘 다 실측으로 붉어지는 것을 확인했습니다. 사용성은 파괴 방어와 복구 경로 둘 다 실제로 붉어집니다 — `SettingsTab.tsx` 의 `handleDeleteAsset` 에서 `globalThis.confirm` 한 줄을 지우자 `delete_naia_asset` 이 무방비로 잡혔고(EXIT 1), `DeferredChatArea.tsx` 의 재시도 버튼을 지우자 막다른 화면으로 잡혔습니다(EXIT 1). 하드코딩 한국어 게이트도 `.tsx` 에 한 줄 넣자 585 → 586 으로 붉어졌습니다. 안정성은 `app_sandbox.rs:274` 의 여덟 스레드 경합 테스트가 실제로 반쪽 읽기를 감시하고 있습니다. **이름만 있고 실패시키는 수치가 없는 축은 없습니다.** 다만 복구 경로 게이트가 보는 막다른 화면은 저장소 전체에서 셋뿐이고 셋 다 지연 로드 청크 실패 화면입니다 — 게이트웨이나 에이전트가 죽은 자리를 보고 있지는 않습니다. 이 한계는 문서 9번이 스스로 적어 두었습니다.

**두 기계 분담의 실체.** 기록은 진짜로 보입니다. 리눅스 쪽은 `linux-x64` / Node v26.7.0 / 커밋 `a6355b18`, 윈도우 쪽은 `win32-x64` / Node v24.18.0 / 커밋 `bb84fc64` 로 플랫폼과 런타임이 갈리고, wdio 설정별 통과·실패 수와 종료 코드 문자열이 일관됩니다. 분담은 겹치지 않습니다 — 계획 13 대 12, 교집합 0, 합집합 25 로 현재 `deterministic_ci` 스물다섯 개와 정확히 일치합니다. 다만 두 가지가 사실과 다릅니다. 첫째, 합집합이 덮는 것은 **전체 123 이 아니라 `deterministic_ci` 25** 입니다. 나머지 98개(`credentialed_live` 90, `native_local` 8)는 아무 기록에도 없습니다. 둘째, 두 기록의 인벤토리 지문이 서로 다릅니다(`87740b9b…` 대 `4f9374b8…`). 두 기계가 **같은 스펙 목록을 두고 동시에 나눈 적은 아직 한 번도 없습니다.** 실제로 돈 것은 25 중 14 이고, 그중 일곱은 발견 2 에서 적은 명단 밖 기계에서 온 것입니다.

**층 구조와 개발 이후 단계.** 1층 단위·계약, 2층 통합, 3층 실기, 4층 회귀가 실제로 존재하고 각각 실행 수단이 있습니다. 개발 이후의 품질 단계도 순서로 분리되어 있습니다 — `self-trust-gates.yml` 의 `code-gates` 가 게이트를 테스트보다 앞에 두고, `build-installers.yml:19-31` 의 `regression-gate` 잡이 태그·수동 실행에서만 돌면서 붉으면 설치본을 만들지 않습니다. 이 부분은 요구대로 되어 있습니다.

**삭제된 스펙의 커버리지 공백.** 공백은 생기지 않았습니다. `26/27/62/63` 넷이 검사하던 `NaiaMetaArea` 는 자기 단위 테스트 말고는 어디에서도 import 되지 않는 죽은 컴포넌트입니다(`grep -rn "NaiaMetaArea"` 로 확인). 지워진 스펙들의 단정도 대부분 `expect(typeof exists).toBe("boolean")` 같은 자명한 것이었습니다. 음성 깨우기 화면 둘은 `SettingsTab.tsx:2220` 에 "Voice wake state removed (UI + handlers deleted)" 로 남아 있어 검사 대상이 실제로 없습니다. `96-w5-sold-out-ux` 는 삭제 커밋 자체가 남는 공백("화면이 실제로 매진 안내를 보여주는지는 여전히 아무도 재지 않는다")을 적어 두었습니다.

---

## 제가 실행한 것

`check-uc-traceability` · `check-vacuous-tests` · `check-untranslated-ui` · `check-destructive-affordance` · `check-recovery-affordance` · `check-dead-ui-specs` · `check-silent-clicks` · `build-e2e-inventory --check` 를 작업 트리와 `git archive`/`git clone` 으로 만든 깨끗한 체크아웃 양쪽에서 종료 코드로 판정했습니다. `check-regression-complete.mjs` 는 24시간·72시간 창으로, `run-regression.mjs` 는 두 명단 기계와 명단 밖 기계에 대해 `--dry-run` 으로 돌렸습니다. 실패시키는 주입은 다섯 번 했습니다 — 셸 설정 하이드레이션에 1.5초, `handleDeleteAsset` 의 확인 제거, `DeferredChatArea` 의 재시도 버튼 제거, `ChannelsTab` 의 `channel-card` 이름 변경, `.tsx` 에 한국어 한 줄 추가. 이 중 저장소 안에서 한 것은 앞의 둘뿐이고 즉시 원복했으며, 나머지 셋은 스크래치패드의 복제본에서 했습니다. 회귀 기록 합성 실험 두 벌(총 여덟 파일)도 만들고 전부 삭제했습니다. 최종 `git status --porcelain` 은 세션 시작 시점과 동일합니다.