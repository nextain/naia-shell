# result-01: 0.2.4 YouTube 스트림 추출 제거

**요약:** `/yt/stream` 처리기와 스트림 URL 추출·형식 선택·decipher 구현을 삭제했다.
- 유지: `youtubei.js` 기반 `/yt/search` 메타데이터 검색, 공식 YouTube iframe 재생, 로컬 파일 전용 `<audio>`.
- 호출 확인: 셸·Rust·패키지 소스 검색 명령은 0건이다(테스트·dist 제외, 아래 재현 명령 참조).
- 설치 확인: 스테이징된 sidecar `dist`에 추출 참조가 없고, `/yt/search`는 HTTP 200과 5개 메타데이터 필드를, `/yt/stream`은 HTTP 404 `not found`를 반환했다.
- 검증: sidecar 빌드·루트/셸 TypeScript 통과, BGM Vitest 102/102, Playwright 12/12, 실제 YouTube iframe 시계 30.1초 진행. 전체 Shell Vitest는 2,518 통과·21 건너뜀·1 실패(기존 paired-agent resolver assertion).
- process-status.json: 조정자(민호)가 이번 작업 가지 갱신을 승인했다. 근거: 대표님 상시 원문 “운영 배포 빼고는 내 승인은 필요 없어”.

## 변경

- `packages/bgm-sidecar/src/youtube-server.ts`: `/yt/stream`, ID 검사, `getBasicInfo`, `chooseFormat`, `decipher`, 오디오/비디오 형식 선택과 URL 응답을 제거했다. `/yt/search`, `/edge-tts`, `/health`는 유지했다.
- 검색 매퍼 시험은 입력에 `url`·`streaming_data.formats`가 있어도 응답에 전달되지 않음을 확인한다.
- BgmPlayer 시험은 YouTube 재생이 공식 `youtube-nocookie.com/embed` iframe을 쓰고, `<audio>`는 YouTube 선택 시 src가 없으며 로컬 재생 시 로컬 Blob URL을 받는다고 확인한다.
- 요구사항·사용자 시나리오·환경 아키텍처 문서에 검색 메타데이터, iframe 재생, 로컬 전용 audio 경계를 기록했다.
- P05에 따라 FR-BGM.1을 Done으로 갱신하고 process-status.json에 이 작업 게이트를 기록했다. process-status 갱신은 위 조정자 승인에 근거한다.

## 호출 경로 확인

다음 명령은 출력이 없었다. 셸 TypeScript, Rust, sidecar production source 어디에도 처리기·호출 함수·스트림 URL 필드가 없다.

```bash
rg -n --hidden \
  --glob '!node_modules/**' --glob '!**/dist/**' --glob '!**/target/**' \
  --glob '!**/*test*' --glob '*.{ts,tsx,js,mjs,rs}' \
  '(/yt/stream|getBasicInfo|chooseFormat|decipher|handleStream|videoUrl|streaming_data)' \
  packages src
```

셸 재생 경로도 확인했다. YouTube 선택은 iframe으로 설정되고 source가 local일 때만 audio sync/play 함수가 동작한다. 실제 BgmPlayer 회귀 시험은 이 경계와 mixed playlist의 다음 곡 전환을 검증한다.

## 검증

| 명령 / 확인 | 결과 |
|---|---|
| `bash scripts/enforce-root-structure.sh` | 기존 미등록 `tmp/`, `tsconfig.build.json` 감지; dry-run, 삭제하지 않음 |
| `node scripts/check-assembly-coverage.mjs` | PASS — S 67 / UC 20 분류 완료 |
| `TMPDIR=<HDD-temp> pnpm -C packages/bgm-sidecar run build` | PASS |
| `TMPDIR=<HDD-temp> npx tsc -p tsconfig.json` (repo root) | PASS |
| `TMPDIR=<HDD-temp> npx tsc -p tsconfig.json && TMPDIR=<HDD-temp> pnpm test` (packages/shell) | 셸 TypeScript PASS; 전체 Vitest 244 파일 PASS / 1 skip, 2,518 tests PASS / 21 skip / 1 fail. 실패: `scripts/__tests__/agent-pairing.test.ts:211`, 예상한 “No clean paired naia-agent checkout” 예외가 발생하지 않음(기능 범위 밖). |
| BGM Vitest 5개 파일 (`BgmPlayer`, `bgm-skill`, `bgm-playback`, `bgm-observation-diagnosis`, `bgm-sidecar-url`) | PASS — 5 files / 102 tests |
| `TMPDIR=<HDD-temp> pnpm exec playwright test e2e/bgm-skill.spec.ts` | PASS — 12/12, 실 UI 스킬 배선과 iframe 재생 상태 |
| `RADIO_DJ_LIVE_YOUTUBE=1 RADIO_DJ_LIVE_WALL_MS=30000 TMPDIR=<HDD-temp> pnpm exec playwright test e2e/bgm-youtube-live-smoke.spec.ts` | PASS — 실 검색 결과를 공식 iframe에 재생, 실제 미디어 시계 30.1초 진행 |
| `cd packages/shell && TMPDIR=<HDD-temp> node scripts/stage-bgm-sidecar.mjs` | PASS — 설치 리소스 stage 완료 |
| 스테이징 `src-tauri/bgm-sidecar/dist` 검색 | PASS — `/yt/stream`, `getBasicInfo`, `chooseFormat`, `decipher`, `handleStream`, `videoUrl` 없음 |
| 스테이징 sidecar HTTP 실 요청 (port 18799) | PASS — `/yt/search?q=lofi&max=2` HTTP 200, 결과 2건, 각 결과는 `id/title/thumbnail/duration/channel`; `/yt/stream?id=abc123` HTTP 404 `{"error":"not found"}` |
| `git diff --check` | PASS |

## P05 / 커밋

FR-BGM.1과 process-status.json의 P01~P05 상태를 완료로 갱신했다. process-status.json 갱신은 조정자(민호)의 2026-10-27 승인에 따른다. 커밋 완료. 푸시·PR은 하지 않는다.
