# graft step 2 — UC-012 wizard step-flow (assets + submit 를 core 경유) — 2026-06-16

session: (재기동) · 우선순위 ① (온보딩+나이아계정) 잔여 · 표준: Old-Baseline→계약먼저→graft(수정❌)→drift-gate→2-AI 리뷰→커밋
선행: graft-uc12-naia-account-2026-06-16(creds/auth 런타임 push, 2-clean) — **본 step = 그 다음 잔여인 "wizard step-flow(submit/assets) UI 네비게이션" graft**.

## 범위 판정 (계약에 의해 — core 계약 변경 0)
new-core 는 step-flow 전체가 **이미 계약+테스트 완료**: `domain/onboarding.ts`(STEPS·advance·applyNaiaLogin·completeOnboarding) + `app/control/onboarding.ts` `OnboardingController`(submit/assets/startNaiaAuth/onNaiaAuthCallback/complete/completeWith/update) + `src/test/uc12-onboarding-controller.contract.test.ts`(8단계 submit→complete·assets·OAuth·가드·update). seam `makeShellOnboarding`(shell-compat)이 컨트롤러 전체 노출.
∴ 남은 graft = **순수 셸 측 배선**: live `OnboardingWizard` 가 `isNewCore()` 일 때 **assets 리스팅 + 단계 전이(submit/draft/gate)** 를 컨트롤러 경유. **신규 core 계약 불필요**.

## 설계 결정 (Old-Baseline 대조 + 회귀 차단)
- **flow=core, persist=snapshot 유지**: 영속은 기존 `completeWith(builtFlat)`(graft step1) 그대로. 셸 snapshot 이 persona 합성·backgroundVideo 파일명·memory provider 등 core draft 미포함 필드를 담음(§D 설계의도 = "셸 snapshot 으로 빌드→completeWith 동일 persist"). **submit 의 core draft 는 persist 에 안 쓰임** — 단계순서 불변식 + provider-naia 게이트 + 상태 일관성(미래 gRPC) 위한 core-owned flow.
- **★ nav 권위 = React, core = forward mirror (core 계약 = forward-only)**: domain `advance` 는 **전진 전용**(계약/contract test 가 forward 만 — back 없음). live wizard 는 `goBack` 지원. ∴ core 가 nav 권위가 되면 goBack 시 core.step lag(desync). 단 **persist=snapshot + 게이트(naiaLoginDone)=step-독립** → desync 는 **무해**(submit step-mismatch no-op, persist 무영향, 게이트 정확). 따라서 본 step = **React 가 nav 권위(back/skip 견고) + core 는 매 전진에 `submit(input)` 으로 draft 누적·순서 불변식·게이트 행사하는 mirror**. 완전 core-권위 양방향 nav = **core back-nav 신규계약 후속**(forward-only 계약 확장 = 사람 승인). submit 호출은 비차단(best-effort mirror) — UI nav/skip 을 막지 않음.
- **assets**: `ctrl.assets(kind)` 가 LISTING 소유(adkPath.get + invoke `list_naia_assets` + AssetRef{path,type}). 셸은 UI URL 전략(이미지=`toLocalBlobUrl(path)`, 영상=`toAssetUrl(path)`)을 AssetRef.path 에서 재유도해 **유지**(WebView large-file blob 회피 주석 보존) → 같은 파일 목록·같은 URL 전략 = parity.
- **provider-step EXIT 3경로 parity** (Old-Baseline = 셸):
  - apiKey 모드 / 로그인 완료 = provider 확정 → `ctrl.submit({step:"provider", provider, apiKey?})` (게이트: 비-naia or apiKey present = 통과).
  - **naia 로그인 성공** → `ctrl.onNaiaAuthCallback({naiaKey})`(컨트롤러 naiaLoginDone=게이트 해제 + NAIA_ANYLLM_API_KEY 키체인=idempotent, completeWith 와 동값) **그 후** `ctrl.submit({step:"provider", provider:"nextain"})` 로 core 를 complete 로 전이. React step mirror.
  - **"나중에 설정"(skip)** = Old-Baseline 은 provider/키 없이 complete 허용(snapshot 기본 provider=nextain, 키 없음). core `advance` 의 provider-naia 게이트는 이를 (자기 계약상 정당하게) 차단하므로 **skip 은 core submit 우회**(React step→complete 직접, core state 는 provider 유지). persist=completeWith(snapshot) 이라 무영향. = core `complete()` 가드는 pure-core flow 전용(contract test), 셸은 §D completeWith 가 설계상 escape. **Old-Baseline 권위**.
- **auth callback 비파괴**: 기존 `sendAuthUpdate`(런타임 wire push, graft step1) + `store_startup_message`(crash replay) **그대로 유지**. 본 step 은 거기에 `ctrl.onNaiaAuthCallback`(core state+키체인)만 **추가**(보완 — wire=runtime, keychain=restart read-back). 교체 아님 → creds graft 2-clean 회귀 0.

## 범위 밖 (회귀 위험 → 본 step 손대지 않음)
- **OAuth URL 빌드**: 셸 `handleNaiaLogin`(generate_oauth_state + redirect/app/redirect_uri params) 유지. core `oauth.launch` = `openUrl(loginUrl)` **스텁**(state/redirect 미빌드) → core 라우팅 시 callback 깨짐. ∴ `ctrl.startNaiaAuth` 미사용, 셸 OAuth 시작 경로 보존. (core OAuthPort 완성 = 별도 후속.)
- **persist / creds 런타임 push**: completeWith·sendCredsUpdate·sendAuthUpdate = graft step1 (2-clean) 그대로.

## 검증 게이트 (완료 — 2026-06-16)
- 셸 seam/컴포넌트 테스트(onboarding-core.test.ts: assets·submit·게이트·idempotency·snapshot 불변식 / OnboardingWizard.newcore.test.tsx: assets·submit mirror·onNaiaAuthCallback·completeWith 배선) + 기존 controller contract 20 + 전체 셸 840 pass, exit 0. compile-integrity PASS, verify-watch delta 0.
- T2 = **2-AI open-loop 3R 2-clean**(R3 양 리뷰어 CLEAN, mutation-probe 4건 RED 로 테스트 진정성 확인). 산출물 `.agents/reviews/r-uc12-stepflow-2026-06-16.json`.

## 사용자 테스트 절차 (루크-머신 실앱 e2e 게이트 — 잔여)
실앱 newCore 온보딩 e2e = 루크-머신 게이트(프로젝트 기존 framing `r-uc12-2026-06-13` UC12-2). 자동 e2e-tauri 불가 사유: (1) e2e-tauri 하네스에 newCore 플래그 미배선(현 스펙=old 경로) (2) naia OAuth=실 브라우저+callback(헤드리스 불가) (3) rust 빌드. **루크가 실 wayland 에서 클릭 검증**([[feedback_handoff_verified_runnable_state]]):
1. `VITE_NAIA_NEW_CORE=1` 로 셸 기동(isNewCore()=true → core 경유). `cd packages/shell && VITE_NAIA_NEW_CORE=1 pnpm run tauri:dev` (또는 해당 플래그 주입 방식 확인).
2. 온보딩 진입 → welcome→이름→말투→캐릭터(VRM 목록=core assets)→배경(목록=core assets)→provider.
3. **경로 A(naia 로그인)**: "Naia 로그인" → 브라우저 OAuth → callback → complete → "시작하기". 검증: `naia-settings/config.json` 에 agent-only(secret 없음) + 키체인에 NAIA_ANYLLM_API_KEY + onboardingComplete=true.
4. **경로 B(skip "나중에 설정")**: provider 건너뛰기 → complete → 시작. 검증: onboardingComplete=true, 기본 provider 영속.
5. **경로 C(apiKey)**: apiKey 입력 → complete. 검증: 키체인 envKey 기록.
6. 완료 후 대화(UC1)가 그 provider 로 동작 = 온보딩→설정→대화 end-to-end.
- ⚠️ 단위/컴포넌트/2-AI 는 graft *로직*을 검증했으나, "기동≠렌더≠기능"([[feedback_handoff_verified_runnable_state]]) — 실 Tauri webview 렌더+IPC 왕복은 위 절차로 루크가 확정.
