# #570 디바이스 조작 커버리지

- Branch: `issue/570-device-operation-coverage`
- Session: `rtx3090-naisos` / Grok on naia3090
- Issue: https://github.com/nextain/naia-shell/issues/570

## 자리

게이트웨이 `skill_device` 는 없다. 설정 `DevicePairingSection` 은 2026-06-30
`13cef2c5` 에서 VRAM 작업과 섞여 빠졌고 CSS·문구만 남아 있었다.

지금 경로는 ADK 로컬 저장소다.

- 저장: `{adkPath}/naia-settings/devices/registry.json` (토큰·코드는 해시만)
- IPC: `device_node_list` · `device_node_describe` · `device_node_rename` ·
  `device_token_rotate` · `device_token_revoke` · `device_token_verify` ·
  `device_pair_request` · `device_pair_verify` · `device_pair_approve` ·
  `device_pair_reject`
- 화면: Settings > 두뇌, 도구가 켜져 있을 때
- 스펙: `34-device-pairing` 은 섹션이 보이는지, `43-device-management` 은
  페어링 뒤 교체한 토큰으로 이전 토큰이 거절되는지를 잰다

## 검증 (2026-09-13, naia3090)

- `cargo test --lib device_registry`: 8 passed (pair/describe/rename/rotate 이전 토큰 거절/revoke/wrong code/traversal/평문 미저장)
- vitest `device-store` + `DevicePairingSection`: 8 passed
- e2e-tauri 34: 1 passing (Settings > 두뇌에 디바이스 섹션이 보인다)
- e2e-tauri 43: 5 passing (pair/verify/approve, describe, rename, rotate 후 이전 토큰 거절, revoke 후 교체 토큰 거절)
- 실기 전제: 자격증명 없는 격리 ADK 에도 스모크 `config.json` 을 심고, App 씨앗에 `llmRoles.main` 을 넣었다. 빈 ADK 첫 실행 온보딩에 막히지 않게.
