# graft step 1 — 온보딩 나이아 계정 (creds/auth 런타임 push) — 2026-06-16

session: ec74cc29 · 우선순위 ① (온보딩+나이아계정) · 표준: 계약먼저→graft→drift-gate→2-AI 리뷰→커밋

## 계약 판정 (계약에 의해)
- **신규계약 불필요(처음 판단 정정)**: 새 agent 는 creds 에서 `{provider, apiKey, naiaKey}` 만 소비(`ttsKeys`/`gatewayToken`/`auth_update` 미소비 — grep 0, TTS=os→provider WS 직결). core 의 기존 `ShellCredsPayload{provider,apiKey,naiaKey}` 객체가 옳은 설계(루크: "객체>key-map", "기존 과설계 아님"). 셸 `keys:{[provider]:apiKey}` 단일맵이 약한 설계.
- **단 keychain 신규계약 1건 도출**(리뷰 발견): old-baseline 의 "빈=unset" 시맨틱 충실 이식 위해 agent `keychain-secret-store` = **update=merge + get=빈overlay 권위적 unset**.

## graft 구현
- **os 셸** `chat-service.ts`: `sendCredsUpdate`/`sendAuthUpdate` 의 `isNewCore()` 분기 추가 → `coreChat().sendCredsUpdate({provider,apiKey|naiaKey})`. keys-map→객체 매핑, ttsKeys/gatewayToken 미전송(미소비), naiaKey=`provider:"nextain"`. old 경로 비파괴.
- **agent** `keychain-secret-store.ts`: update merge(타필드 보존) + get presence 권위(빈""=명시 unset, 키체인 fallback 차단).

## 리뷰 (open-loop 적대, 2-clean — T2 creds)
- **R1**: B1(BLOCKER nextain apiKey 슬롯 orphan) + H1(HIGH 빈키 unset 안됨). → 내 1차수정(정규화+스킵).
- **R2**: 1차수정 반증 — **B1=가짜**(nextain apiKey 항상 "", lab-proxy=naiaKey만 소비 → orphan 불가, 정규화=死분기) + **H1 스킵이 native 키 unset 깸 + overlay.set replace 가 naiaKey 소실**. → 근본수정(셸 단순화 + agent keychain merge/권위-unset).
- **R3 CLEAN**: 4주장(naiaKey보존·native unset·fallback보존·무회귀) 전부 해결, 새 결함 0. 실 transport=gRPC 확인 + **proto3 `optional`(oneofs:true) 빈문자열 왕복 실측**(""=present 보존, omit=undefined) — load-bearing presence 검증. 권고=회귀앵커 추가→`credsToDomain` presence lock 테스트 추가 완료.

## 검증 (drift-gate)
- os: chat-service 25 + 셸 830 pass · compile-integrity green
- agent: keychain 10(merge/unset 3 신규) + grpc-codec creds presence 3 + 전체 275 cases pass(raw vitest exit1=.mjs process.exit 아티팩트, benign) · compile-integrity green
- 교훈: closed-loop 단위테스트(R1 전 green)가 놓친 슬롯불일치·unset회귀를 open-loop 2-AI(정본=Old-Baseline+gRPC 실왕복)가 적발 = [[feedback_closed_loop_review_canon_conformance]] 실증. "되는건 의미없다 제대로" 적용.

## 잔여 (범위 밖)
- 비활성 provider 키 삭제 unset 미전송(SettingsTab 활성 provider만) = 기존 설계 scope.
- 온보딩 wizard step-flow(submit/assets) graft = 별도(현 old-path UI 네비, substrate-specific). 본 step = 계정/creds/키 경로 한정.
