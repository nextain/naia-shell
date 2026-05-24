# 배포 트러블슈팅

Naia OS 개발 중 발생한 빌드 및 런타임 문제들.

## pnpm Store 손상

**증상**: `pnpm dev` / `cargo tauri dev` 실행 시 `Invalid package config ... Unexpected end of JSON input` 또는 `ERR_INVALID_PACKAGE_CONFIG` 에러. `node_modules` 내 다수의 `package.json` 파일이 0바이트.

**원인**: pnpm content-addressable store(`~/.local/share/pnpm/store/v10`)가 손상됨. pnpm은 store → `node_modules`로 hardlink를 생성하므로, store 파일이 깨지면 이후 `pnpm install`마다 0바이트 hardlink가 복사됨. `pnpm store prune` + `pnpm install --force`로도 해결 안 됨 — prune은 고아 파일만 제거하고 손상된 콘텐츠 파일은 건드리지 않음.

**진단**:
```bash
# node_modules 내 빈 package.json 확인 (0이어야 정상)
find node_modules -name 'package.json' -empty | wc -l

# store 손상 확인 (거의 0이어야 정상)
find ~/.local/share/pnpm/store/v10 -empty -type f | wc -l
```

**수정**:
```bash
rm -rf ~/.local/share/pnpm/store/v10
rm -rf shell/node_modules agent/node_modules shell/src-tauri/target/debug/agent/node_modules
cd shell && pnpm install
cd agent && pnpm install
cd shell/src-tauri/target/debug/agent && CI=true pnpm install --shamefully-hoist
```

**재발 방지**: 재발 시 `node-linker=hoisted`로 hardlink 대신 복사 방식 사용:
```bash
pnpm install --config.node-linker=hoisted
```
store 손상에 영향 안 받음. 단, hoisted 레이아웃은 phantom dependency 접근을 허용하는 부작용 있음.

**사례**: 2026-03-03 — store에 2300개 빈 파일 발견, shell + agent node_modules 전체 영향.

---

## Agent node_modules ws 패키지 누락

**증상**: agent-core 시작 시 `Cannot find package 'ws'` 에러. 경로: `shell/src-tauri/target/debug/agent/node_modules/ws`

**원인**: `target/debug/agent/`의 번들 에이전트가 pnpm 기본 격리 node_modules를 사용. `ws`는 간접 의존성이라 최상위로 호이스트되지 않음.

**수정**:
```bash
cd shell/src-tauri/target/debug/agent
CI=true pnpm install --shamefully-hoist
```

> `--shamefully-hoist`는 번들 에이전트에 필수 (ws, p-retry 등 간접 의존성 때문).

---

## cargo build 후 흰 화면

**증상**: 앱은 실행되지만 화면이 비어있음 (흰 화면).

**원인**: `npx tauri build --no-bundle` 대신 `cargo build --release`를 사용.

**수정**: 반드시 `npx tauri build --no-bundle` 사용 (WebKitGTK asset protocol은 Tauri 빌드 파이프라인을 거쳐야 함).

---

## Linux 릴리스: `.deb`는 빌드되지만 실행 시 실패

**증상**: GitHub Actions Linux release job은 성공하지만, 추출한 `.deb`를 실행하면 다음과 같이 실패:
```text
error while loading shared libraries: libvosk.so: cannot open shared object file
```

**원인**:
- Linux release workflow가 `src-tauri/tauri.conf.linux.json`이 아니라 기본 Tauri config로 빌드됨
- `libvosk.so`가 `.deb` 패키지 안에 포함되지 않음
- CI가 빌드 완료만 확인하고 패키지 런타임 링크 검증은 하지 않았음

**수정**:
```bash
pnpm run tauri build --config src-tauri/tauri.conf.linux.json --bundles deb,rpm
```

추가로 다음을 보장해야 함:
- `shell/src-tauri/tauri.conf.linux.json`에 `resources/libvosk.so` 포함
- Linux rpath에 패키지 라이브러리 경로 포함 (`$ORIGIN:$ORIGIN/../lib/Naia`)
- release workflow에서 `dpkg-deb -x` + `ldd`로 패키지 `.deb` smoke test 수행

**CI 가드**:
```bash
dpkg-deb -x Naia-Shell-x86_64.deb linux-smoke
test -f linux-smoke/usr/lib/Naia/libvosk.so
ldd linux-smoke/usr/bin/naia-shell
```

**사례**: 2026-05-22 — run `26265448860`에서 Linux smoke step이 `libvosk.so missing from deb`로 실패.

---

## Windows: Gateway 모드 미설정

**증상**: 새 WSL 프로비저닝 후 `Gateway start blocked: set gateway.mode=local (current: unset)`.

**원인**: OpenClaw 프로비저닝에서 `/root/.openclaw/openclaw.json`에 `gateway.mode=local`을 설정하지 않음.

**수정**: `wsl.rs`의 `provision_distro()`에 Step 5 추가 — 프로비저닝 중 node 스크립트로 `gateway.mode=local` 설정.

**사례**: 2026-03-11

---

## Windows: restart_gateway 레이스 컨디션

**증상**: Naia 로그인 후 Gateway 연결 실패 — Gateway 프로세스가 스폰 도중 종료됨.

**원인**: 딥링크 인증이 Rust 쪽 재진입 방지 없이 `restartGateway()`를 여러 번 호출.

**수정**: `restarting_gateway` AtomicBool에 `compare_exchange` atomic guard 적용 (SeqCst). guard 해제는 agent 재시작 완료 후.

**사례**: 2026-03-11

---

## Windows: Git Bash 경로 변환

**증상**: MSYS가 `/opt/naia/...`를 `C:/Program Files/Git/opt/naia/...`로 자동 변환.

**수정**: 명령어 앞에 `MSYS_NO_PATHCONV=1` 접두사 추가.

---

## Windows: pnpm Non-TTY 에러

**증상**: WSL에서 `pnpm install` 실행 시 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`.

**수정**: `CI=true pnpm install` 사용.

---

## Windows: .wslconfig localhostForwarding 폐기

**증상**: `networkingMode=mirrored`에서 `localhostForwarding` 미지원 경고.

**수정**: `config/defaults/wslconfig-template`에서 `localhostForwarding=true` 제거.
