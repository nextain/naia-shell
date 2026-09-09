# BC250 support5-livefix — Bazzite PC 독립 교차검증 및 로컬 음성 인계 (2026-09-09)

다른 PC 세션이 support5-livefix를 만들어 32GB USB에 기록한 인계(커밋 `5d96f55`)에 이어, Bazzite PC(pc-bazzite)에서 같은 ISO를 독립으로 교차검증하고, 별도 USB에 라이브 영속 파티션까지 미리 만들어 기록했다. 실물 BC250 부팅·설치는 여전히 미검증이며 이슈는 열어 둔다.

## 1. VM 부팅 독립 교차검증 — 전 경로 PASS

인계 문서가 "independent review NOT_RUN"으로 비워 둔 칸을, Bazzite PC의 QEMU(UEFI/OVMF secboot, KVM)로 채웠다. 대상 ISO는 공개 R2본이며 SHA-256이 CI·사이드카·build-receipt·이슈 기대값 네 곳과 모두 `6461112cb12b0bb611ef1f19fdf448595ee3b497b62230b4546fac3dca3d57bd`로 일치한다.

- **영속 파티션 없음(#580 재현 경로)**: 30초에 이미 KDE 데스크톱 + Naia 온보딩. 게스트 내부에서 `var-home-liveuser.mount`가 generator로 `masked`(FragmentPath `/run/systemd/generator/...`), `naia-persist-system.service`도 masked, `/run/user/1000/wayland-0` 소켓 존재, 세션 1이 `plasmalogin-autologin`/`Type=wayland`/online, kwin_wayland·plasmashell 실행, `image-info.json` 런타임 모드 644. 로그인에서 멈추지 않았다.
- **영속 파티션 있음**: `findmnt`가 `/dev/vda btrfs naia-data /var/home/liveuser`. 마커 파일 기록 후 `system_reset` 재부팅에도 값 보존, 데스크톱 재진입. "This USB has a data partition, so your settings, conversations and Naia's memory are kept across reboots." 안내 확인.
- **설치 노출**: GRUB 메뉴는 기본·Basic Graphics 두 줄뿐이고 설치는 데스크톱 "Install to Hard Drive" 아이콘으로만 노출. `naia-liveinst-wrapper.sh` 실행비트·`liveinst.desktop`(NoDisplay=false) 확인. Anaconda 실행은 안 함.
- **naia-os#1 `:latest` 불일치 해소 확인**: Kickstart `ostreecontainer --url=ghcr.io/nextain/naia-os-amd:candidate-bc250-0.2.3-13980895-support4`와 `images.json`의 `names`가 문자 단위 동일, digest도 support4와 같음.

부수 발견(둘 다 로그인 비차단, 이번 수정과 무관):
- `bazzite-user-setup`에 문법 오류(201행 `else`, 199행 `then` 뒤 본문 비어 있음). 서비스는 `failed`(ExecMainStatus 2)지만 KDE 진입은 정상. mtime이 epoch인 상류 Bazzite 파일이라 원인·영향 미조사·미패치.
- 로그인 MOTD Greenboot RED. 원인은 `02_watchdog.sh` 실패 + "not booted via libostree"인 라이브 ISO 구조적 조건. `/usr/lib/greenboot` 안에 `image-info.json`을 읽는 스크립트는 없어, 0600→0644 수정과 무관하다. 오히려 MOTD에 이미지 참조가 정상 출력된 것이 그 수정이 동작한 증거.

## 2. 별도 USB 기록 — 라이브 영속 파티션 미리 생성

인계본의 32GB USB와는 다른 장치(SMI USB DISK, 시리얼 `CCYYMMDDHHmmSS2055HT`, 63,333,990,400바이트)에, 루크 지시(파티션 미리 만들기)에 따라 ISO 기록 + `naia-data` 파티션 사전 생성을 한 번에 수행했다. 기존 작업 파티션 데이터는 HDD에 tar 백업(검증 PASS) 후 대체했다.

- ISO SHA-256 일치, 기록 후 전체 읽기 검증 PASS(장치 = ISO).
- 파티션 조작 후 읽기 재검증: 본문 `[1MiB, ISO_SIZE−16896)` 바이트 일치(`75ce495e…`). 차이는 보호 MBR/주 GPT와 ISO 끝 백업 GPT 헤더뿐(parted의 GPT 재배치, 정상).
- 최종 배치: sdb1 Naia-OS-Live(iso9660) 7.9G / sdb2 EFI 25M / sdb3 Gap1 / **sdb4 naia-data(btrfs, 51.1G, 빈 상태)**. 라이브 부팅 시 `var-home-liveuser.mount`가 얹어 재부팅에도 작업 보존. 설치본은 일반 홈 사용(라이브 임베딩 vs 설치본 이원화, naia-shell#262).
- 기록·검증 스크립트와 영수증은 alpha-adk 로컬 진행 기록(`.agents/progress/naia-usb-bc250-20260909/support5-livefix/`, gitignore 대상)에 있다. 소스·ISO는 이 저장소와 R2에 있다.

## 3. 로컬 음성(VoxCPM2)은 BC250 실물에서 진행 — 결정

로컬 음성을 naia-os(BC250 AMD 이미지)에 포함하는 작업은 BC250 실물에서 하기로 했다(루크). 가속기 판별·VoxCPM2 동작·성능이 하드웨어에만 답이 있기 때문. 시작점은 #537 코멘트(issuecomment-5603139831)에 정리했다.

- 브랜치 `fix/linux-voice-installer-staging`, `packages/shell/src-tauri/src/voice_runtime.rs`의 OS×가속기 프로파일 등록부에서 이어간다.
- 순서: amdgpu 바인딩 확인 → `rocm-smi`/`/sys/class/drm`로 ROCm vs CPU 결정 → VoxCPM2 리눅스 경로 기동·측정. gfx1013 ROCm 제한으로 CPU 폴백 가능성 있음.
- 관련: #537(리눅스 음성·가속기 축), #453(Shell 소유 TRT 런타임 경계), #455(온보딩 설치 플로우).
- ISO는 계속 CI가 서명·발행(cosign 키·R2 자격증명이 CI에만). BC250에서 직접 굽지 않는다.

## 남은 것

실물 BC250 일반 부팅·KDE 진입·Anaconda 설치, 설치 후 SSD 부팅, BC250 가속기(ROCm/CPU) 결정과 VoxCPM2 실동작. 이 결과가 나오기 전까지 #580은 열어 둔다.
