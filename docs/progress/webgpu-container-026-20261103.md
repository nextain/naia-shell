# 0.2.6 WebGPU 컨테이너 판 — 투명성과 편리성

작성 2026-11-03. 범위: 설계와 초기 컨테이너 포장. 출시 목표 11/13, 기능 고정 11/9.
UC/요구사항: [UC-WEBGPU-CONTAINER-026](../user-scenarios.md#uc-webgpu-container-026--투명한-로컬-컨테이너-026), [FR/NFR](../requirements.md#fr-webgpu-container-026--로컬-컨테이너-초기-slice).
**2회차에서 웹 UI → 로컬 컨테이너 모델 연결을 추가했다.** 아래 초기 slice 설명은 1회차 기록이며, 현재 상태와 통합 결정은 끝의 2회차 절을 우선한다.

## 조사: 사실과 방향

| 대상 | 확인한 상태 |
|---|---|
| 이 작업 main 기준 | `build:web`, `web-worker/`, `src/lib/web-runtime/` 없음. 데스크톱 Vite build를 웹판으로 배포하면 안 됨 |
| [#794](https://github.com/nextain/naia-shell/pull/794) | OPEN, probe/naia-web-wo-04 `495c42b81367174ab81a8ec0760fe3dccd724329`: WebGPU 실험·웹 UI·영상 배경·Safari NVA |
| [#824](https://github.com/nextain/naia-shell/pull/824) | OPEN, #794 대체, feat/web-025-794 `313c706996e5ab0c17add59a7144c0d9a5ba7bc4`: 모바일·PWA·OPFS 탐색기·portable ZIP 내보내기 |
| 10/21 개발 샘플 기록 | shell `1c169cde`, agent `cc2acfa0`, ADK `13ea4279`; Qwen3 4B f32 약 2.2GB, 첫 준비 140초. 당시 검증 기록이며 이번 추론 실측 아님 |
| #824 로컬 빌드 조사 | `web-worker/agent-worker.ts`는 webllm/nextain만 허용. nextain에는 naiaKey 필수. `openai-compat-provider.ts`는 SSE·tools·취소 구현 보유. Ollama URL만 바꿔도 동작하는 구조가 아님 |
| 브라우저 저장 | 모델 캐시·OPFS ADK·localStorage는 브라우저 프로필에 속함. 서버 볼륨에 자동 저장되지 않음. 기존 웹 장기 기억/앱 가져오기 완성을 주장하지 않음 |

읽기 전용 근거: `/home/nextain/minho/alpha-adk/docs/developer/product/naia-shell/`의
`webgpu-sample-dev-20261021.md`, `release-025-plan-20261031.md`,
`apps-025-integration-plan-20261101.md`, `index.md`.
10/31 대표님 방향은 웹판이 기본 입구, 앱은 GPU·PC 도구·완전 로컬 사용자용이며 가치가 **투명성과 기억의 소유**라는 것이다.
11/3 최신 지시를 우선하여 웹·로컬 동기화는 **0.2.7로 제외**한다. B2C 테마·캐릭터 카드와 AX agent 교체는 다른 작업이다.
샘플 운영 주소·기존 컨테이너에는 접속하지 않았다.

## 구성과 실행 위치

```text
사용자 브라우저 (localhost는 secure context)
 ├─ 웹 셸 / agent Worker / WebGPU → 브라우저 GPU, 모델은 브라우저 캐시
 ├─ ADK·대화·기억 → OPFS/localStorage, 사용자가 내보내기
 └─ [후속 local-container provider] /local-llm/v1/chat/completions
                  ↓ 동일 출처 HTTP, SSE buffering off
127.0.0.1:18026 → web: nginx (비특권, 읽기 전용 root)
                  ↓ 전용 compose network, 외부 포트 없음
                 inference: Ollama → CPU 또는 명시한 GPU
                  └─ 사용자 경로/models → /root/.ollama
```

브라우저 GPU와 서버 GPU는 독립이다. 컨테이너에 GPU를 주지 않아도 브라우저 WebGPU는 사용 가능하다.
브라우저 GPU가 없으면 자동으로 다중 GB WebGPU 모델을 받게 하면 안 되고, 로컬 서버 선택/모델 없음 상태를 보여야 한다(후속 UI 계약).
원격 PC/폰은 localhost와 달리 HTTPS·인증이 필요하다. 이번 기동은 loopback 전용이고 LAN 공개/터널/운영 배포를 포함하지 않는다.

## 이미지와 투명성

초기 파일 위치는 기존 허용 디렉터리 `scripts/builds/webgpu-container/`다. 루트 whitelist나 헌장을 바꾸지 않는다.
설계 문서는 docs/progress ledger로 보관한다.

| 이미지 | 구성·책임 |
|---|---|
| web | `nginx:1.28.0-alpine` + 명시적 `dist-web/` + 공개 nginx 설정. Tauri/Rust·키·사용자 ADK·모델 미포함 |
| inference | `ollama/ollama:0.13.5`, 모델 미포함. CPU 기본. 시작할 때 pull/run 호출하지 않음 |
| 개발 빌드 | 웹 코드 통합 전에는 #824 shell + browser-agent `cc2acfa0` + pin ADK로 만든 산출물을 입력. 임의 main 빌드를 대신 넣지 않음 |

최소 빌드 context에는 Dockerfile, nginx.conf, web 산출물만 복사한다. 전체 저장소나 `.env`를 COPY 하지 않는다.
OCI source/revision 및 별도 web revision label을 기록한다. 시작 로그에는 소스·웹 revision, 이미지, 데이터 경로, GPU 모드, 삭제 없는 종료 명령을 출력한다.
초기 버전 태그는 명시되어 있지만 가변 태그다. 출시 전에는 검증된 **다중 아키텍처 digest**로 고정한다.
웹 소스/agent/ADK pin과 build 명령, 산출물 SHA256을 이미지 옆 manifest에 공개하는 것을 출시 조건으로 둔다.

## 데이터와 기억의 소유

| 데이터 | 현재 실제 위치 | 보존·삭제 |
|---|---|---|
| 서버 모델·Ollama 설정 | `${NAIA_DATA_DIR}/models` bind mount | compose down/이미지 교체 후 보존. 모델 삭제는 별도 사용자 행동 |
| 웹 ADK·웹 기록 | origin별 브라우저 OPFS/localStorage | 컨테이너 down과 무관. 브라우저 데이터 삭제/다른 포트·프로필이면 별개 저장소 |
| WebGPU 가중치 | 브라우저 Cache/IndexedDB 등 WebLLM 저장소 | 서버 모델 볼륨과 무관. 재다운로드/삭제는 브라우저 단위 |
| 장기 기억(목표) | 사용자 ADK의 `naia-settings/memory/store.json` | 브라우저 agent와 서버 agent 각각의 소유 경로·쓰기 계약 확정 필요 |
| 서버 ADK(목표) | `${NAIA_DATA_DIR}/adk` → 서버 agent `/data/adk` | 현재 서버 agent 서비스가 없어 미생성·미배선. empty volume을 기억 구현으로 간주하지 않음 |

0.2.6 출시 전: 웹 export ZIP의 ADK/기억 포함 여부를 자동 검사하고, origin/용량/보존 요청/다운로드 위치를 안내해야 한다.
백업은 **실제 데이터가 있는 저장소**에서 수행한다. `${NAIA_DATA_DIR}`만 백업하면 브라우저 기억까지 백업된다고 안내하면 안 된다.
서버 agent가 추가되면 중지 후 ADK와 memory 파일 전체를 백업하고, 새 디렉터리로 복원해 건수·해시를 대조한다.
0.2.7 자동 동기화/병합·충돌 해결은 구현하지 않는다.

## CPU·GPU 선택

| 환경 | 기동 선택 | 제약·검증 |
|---|---|---|
| GPU 없음 | `NAIA_GPU=cpu` (기본) | 작은 CPU 모델을 사용자가 별도 선택. 현재는 모델 0개로 서버 경계 시험 |
| Docker NVIDIA | `NAIA_ENGINE=docker NAIA_GPU=nvidia` | NVIDIA Container Toolkit 필요, compose device reservation overlay. 이번 환경 Docker 없음, 미실측 |
| Podman NVIDIA | `NAIA_ENGINE=podman NAIA_GPU=cdi` | 사전 구성된 CDI 필요, `nvidia.com/gpu=all` overlay. 호스트 드라이버/CDI를 자동 변경하지 않음. GPU 실기 미실측 |
| AMD/Intel/macOS | CPU 또는 브라우저 GPU 우선 | ROCm/Vulkan/Metal을 같은 성공으로 간주하지 않는다. 별도 이미지·기기 검증 후 지원 확대 |

근거: [Ollama Docker](https://docs.ollama.com/docker), [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility), [Docker GPU reservations](https://docs.docker.com/reference/compose-file/deploy/), [NVIDIA CDI](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/cdi-support.html).
GPU가 있어도 작은 시험만 수행하며 큰 모델 자동 다운로드는 금지한다. 최초 모델 취득과 완전 오프라인 재기동은 다른 관문이다. 현재 upstream 브라우저 WebGPU는 worker warmup 시 모델을 자동 다운로드할 수 있으며, 시작 대본의 무다운로드 보장은 서버 기동 과정에 한정한다.

## 개발자 실행 (현재 구현)

전제: Bash·git·curl·Docker Compose 또는 Podman+compose provider, 빌드된 웹 산출물, 사용자 데이터 경로.
웹 산출물을 준비한 다음 다음 한 명령으로 두 서비스를 빌드·기동한다. 이것은 아직 공개 이미지 한 줄 설치가 아니다.

```bash
NAIA_WEB_DIR=/absolute/path/dist-web NAIA_WEB_REVISION=<full-web-commit> NAIA_DATA_DIR=/absolute/path/naia-data TMPDIR=/absolute/path/run/tmp bash scripts/builds/webgpu-container/start.sh
```

GPU는 같은 명령 앞에 위 표의 변수를 붙인다. 기본 프로젝트 `naia-026`, 포트 `18026`이며 충돌 시 `NAIA_PROJECT`/`NAIA_PORT`를 명시한다.
기동 성공은 HTTP `/healthz`까지 기다린다. `/local-llm/v1/models`와 `/local-llm/v1/chat/completions`만 프록시하며 관리/pull API는 공개하지 않는다.
Ollama에서 모델 없음은 `data:null`일 수 있으므로 UI는 null/빈 배열 모두 모델 0개로 처리해야 한다.
1회차 nginx는 시작 시 inference 이름을 해석했다. 2회차 실제 정지/재시작에서 IP 변경 후 복구 실패를 발견해, 실행 엔진 DNS를 읽고 2초 간격으로 다시 해석하도록 수정했다. web을 별도로 재시작하지 않고 목록 재시도로 복구한다.
중지는 시작 출력의 compose down 명령을 사용한다. 이 명령은 모델 폴더를 삭제하지 않는다.

후속 모델 취득은 사용자가 명시적으로 `compose exec inference ollama pull <선택 모델>`로 한다.
명령 앞에는 시작 때 출력된 동일 project/compose 경로·환경을 사용한다. 모델은 기본 이미지에 넣지 않는다.
**현재 웹 UI에는 local-container provider가 없어 이 API로 자동 연결되지 않는다.** 웹은 upstream 기본 nextain/WebGPU 흐름이다.
클라우드 비사용 설정은 inference에 주입했지만, 웹 upstream의 외부 로그인·CDN·모델 취득을 포함한 완전 오프라인 동작은 별도 차단 시험이 필요하다.

## GHCR 배포안 (미게시)

출시 후보에서 `ghcr.io/nextain/naia-shell-web:0.2.6`와 `:sha-<commit>`를 만든다.
web 이미지는 linux/amd64, linux/arm64 정적 nginx 기반으로 빌드하고 digest를 compose에 고정한다.
inference는 검증한 upstream digest를 쓰되 GPU flavor는 별도 태그/manifest로 공개한다. 가중치 라이선스와 해시는 모델 다운로드 시 별도 표시한다.
소스 tarball·Dockerfile·compose·모든 pin·SBOM·provenance·SHA256을 같은 release에 둔다.
빌드 CI는 무자격 정적 build/smoke와 게시 job을 분리하고 GHCR write 권한/OIDC 서명은 게시 job에만 준다.

목표 사용자 명령은 릴리즈 compose를 받아 `NAIA_DATA_DIR=... docker compose -f <release-compose> up -d` 하는 형태다.
동일 파일을 Podman provider로도 검증한다. 게시본은 build context/웹 소스 checkout을 요구하지 않아야 한다.
한 줄 원격 스크립트 pipe 실행보다 사용자가 내려받아 볼 수 있는 compose와 digest를 제공한다.
현재 GHCR push·원격 push·운영 배포는 수행하지 않았다.

## 출시까지 남은 일

| 날짜 | 일감·완료 증거 |
|---|---|
| 11/4 | 통합 기준·pin·재현 build는 11/3 선행 구현. 웹 담당 가지로 패치 반영 검토, frozen clean install·전체 웹 회귀 |
| 11/5 | 로컬 공급자·SSE·취소·빈 목록·서버 복구는 11/3 선행 구현. 미설치/삭제 모델·요청 중 서버 중단·복수 모델 전환 추가 회귀. tools는 별도 지원 범위 확정 |
| 11/6 | OPFS 기억 export 내용·재가져오기/복원 계약 검증. 브라우저 저장소와 서버 볼륨 위치 표시, narrow·ARIA·키보드 visual UX |
| 11/7 | CPU 작은 모델 실제 응답·Podman 서버 재시작은 11/3 선행 검증. NVIDIA Docker/Podman CDI 한 기기씩, GPU 없음·OOM·브라우저 WebGPU 폴백 검증 |
| 11/8 | GHCR 다중 arch 후보 build/SBOM/provenance·digest 고정. 완전 오프라인 재기동과 백업 복원 검증 (게시 권한 확보 시) |
| 11/9 | 기능 고정: clean 한 줄 설치/종료/복구, 모델 자동 pull 0, 브라우저 데이터 삭제 경고/소유 경로 안내. 미통과 지원 환경 명시 |

11/10~11/12 회귀·문서·출시 판정 뒤 11/13 목표 공개. 웹/로컬 동기화는 0.2.7이다.

## 11/3 검증 결과 (초기 slice 한정)

- Podman 4.9.3 rootless + tmp에 설치한 podman-compose 1.6.0으로 실제 build/run 수행.
- 패키징 fixture 및 실제 #824 웹 빌드 각각: health 200, index 원본 일치, 모델 목록 0개, 관리 API 404, DELETE 405, 없는 모델 요청 404, 컨테이너 삭제·재생성 뒤 모델 볼륨 sentinel 보존 통과. 모델 다운로드 0. 시험 서비스·네트워크 종료 확인.
- 실제 웹 산출물 211,981,075 bytes. index SHA256 `d9addc413201c53e17a5e429f08dc64a0bd40995ad205a29c5909760be0f57e4`.
- 빌드 소스: shell #824 `313c706996e5ab0c17add59a7144c0d9a5ba7bc4`, browser agent `cc2acfa0`, ADK `13ea427991542965091f2f3211b9325a36dbd522`. root/shell/worker typecheck와 Vite build 성공. 원본 checkout을 수정하지 않고 run tmp에서 archive snapshot 빌드.
- 시작 입력 오류 6건, conform 미계약 TS/손상 manifest/등록 TS 3건 통과. 실제 70개 코어 파일 anchor 검사, assembly 분류 통과. C용 빈 regions를 가짜 TS 계약으로 채우지 않고 TS 전용 검사기를 live hook과 pre-commit에 연결하고 이 clone의 git hook도 활성화.
- core+shell compile-integrity, bgm-sidecar typecheck 통과. 기존 의존성 node_modules를 임시 링크 재사용했으므로 frozen clean install 재현성까지 주장하지 않음.
- 전체 기존 Shell Vitest: 242 파일 통과, 5 실패, 1 제외; 테스트 2,538 통과, 2 실패, 21 제외. SettingsTab locale 2개 assertion 실패와 외부 node_modules 경로의 pdf.worker import 거절 4개 suite 로드 오류. 이번 slice는 셸 TS/UI를 수정하지 않았으나 동일 환경 base 비교는 수행하지 않아 기존 실패로 확정하지 않음. 전체 회귀는 RED.
- 루트 구조 검사는 시작부터 있던 `tmp/`, `tsconfig.build.json` 위반이 남음. 사용자/기존 파일을 삭제하거나 헌장 whitelist를 단독 수정하지 않음. 문서 그래프도 기존 quality-reviews 예제 링크 등을 오류로 보고하며 이번 문서 경로 오류는 없음.
- 최초 nginx는 읽기 전용 `/var/cache/nginx/fastcgi_temp` 생성 실패. 로그 확인 뒤 모든 임시 경로를 `/tmp`로 옮겨 실제 재기동 통과. 최초 빈 모델 기대 `[]`는 실제 Ollama `null`에 맞춰 검사 계약 보완 후 통과.
- GPU inference, 실제 LLM 응답, 브라우저 WebGPU 다운로드, visual UX, Docker 실기, GHCR 게시, 웹 기억 복원은 검증하지 않음. UI/Rust 변경은 없고, 후속 provider UI 변경은 Playwright/visual UX 관문 필요.

원본 로그는 실행 폴더 `/home/nextain/work/codex-runs/026-webgpu/tmp/`의
`container-smoke-final.log`, `container-web-smoke.log`, `web-*-build.log`,
`web-shell-types.log`, `web-worker-types.log`, `compile-integrity.log`,
`sidecar-tsc.log`, `baseline-shell-tests.log`, `doc-graph.log`에 남겼다.


## 2회차 — #824 산출물 기준과 로컬 공급자 (11/3 선행 구현)

### 통합 결정

전체 가지 병합 대신 **#824 고정 소스 `313c706996e5ab0c17add59a7144c0d9a5ba7bc4` + 저장소 내 `local-container.patch`** 를 사용한다. 현재 가지와 #824의 packages/shell 차이는 306개 파일, 약 2.4만 줄이며 모델 역할·desktop agent pin·NVA·웹 기능을 함께 바꾼다. 전체 merge는 본 작업의 컨테이너 경계 밖 변경과 헌장 충돌까지 수반한다. 고정 archive에 작은 패치를 적용하면 1회차 빌드 기준을 유지하고 웹 담당 가지가 패치만 검토·이식할 수 있다. 이는 전체 #824를 이 가지에 병합했다는 뜻이 아니다.

- 소스: `scripts/builds/webgpu-container/local-container.patch` (SettingsTab·별도 모델 목록 컴포넌트·웹 registry·Worker·초기 설정·14개 로케일).
- 재현: `prepare-web.sh`: git archive로 웹 소스와 browser agent `cc2acfa0d496a73e7f9d0cb3052145d1caeda433` 생성 → 패치 check/apply → core build → shell/worker typecheck + web build. ADK `13ea427991542965091f2f3211b9325a36dbd522`는 번들 생성기가 고정한다. 입력 저장소 checkout은 변경하지 않는다.
- `NAIA_WEB_AGENT_DIR`에는 위 agent object가 있는 Git 저장소를, `NAIA_WEB_ADK_REPO`에는 ADK Git 저장소를 준다. `TMPDIR`는 실행 폴더 tmp/. `NAIA_WEB_DEPS_DIR`를 생략하면 frozen install, 지정하면 기존 의존성 링크 재사용이다. 후자는 clean install 검증이 아니다.
- `container-build.json`에 웹 revision과 패치 SHA256을 기록한다. `start.sh`에는 출력된 `NAIA_WEB_DIR`, `NAIA_WEB_REVISION`을 사용한다.

### 사용자 동작·경계

컨테이너 웹의 초기 공급자는 `local-container`, 모델은 미선택이다. 계정 로그인·WebGPU 가중치 취득을 시작하지 않는다. 설정 → Brain → Local container에서 `/local-llm/v1/models`의 설치 모델만 선택한다. 목록 null/[]는 모델 없음이다. 목록 로딩은 중복 조회를 막고 10초 제한·unmount abort를 적용한다. 오류는 alert와 컨테이너 시작 확인·재시도, 그 외 상태는 status로 전달한다. 모델 설치는 별도 명시 행동이며 UI가 pull API를 호출하지 않는다.

기존 Worker `makeOpenAICompatProvider`를 재사용해 `/local-llm/v1/chat/completions` SSE와 AbortSignal을 연결한다. local 분기가 nextain 키 검사보다 먼저이며, 도구 지원은 false다(작은 모델에 tools 성공을 주장하지 않는다). nginx는 기존 동일 출처 프록시·관리 API 차단·buffering off를 유지한다. 원격 URL이나 키를 사용자 입력으로 받지 않는다. Rust/Tauri 소스는 바꾸지 않았다.

첫 UI 시험에서 upstream Settings의 무조건적인 외부 모델 카탈로그 조회를 발견했다. local-container에서는 해당 조회를 건너뛰도록 수정했다. 재시험은 브라우저의 외부 요청을 전부 차단하여 운영 서비스에 접근하지 않는다. 최초 시험의 자동 metadata 요청 발견 사실은 결과에 남긴다. 운영 셸·컨테이너에 로그인하거나 배포하지 않는다.

한글·영문 문구는 로케일 정본에 추가하고, 나머지 12개 로케일에는 명시적인 영어 문구를 넣었다. 한국어 하드코딩 금지 검사는 통과 대상으로 두며, 12개 언어의 자연어 번역은 후속 품질 작업이다.

### 실제 모델과 수용 증거

전용 rootless Podman 프로젝트 `naia-026-r2`, loopback `127.0.0.1:18026`. 서버 모델은 실행 폴더 `tmp/r2-data/models`만 사용했다. 유일하게 취득한 모델 `qwen2.5:0.5b`, Ollama ID `a8b0c5157701`, 표시 크기 **397MB**. 큰 모델·브라우저 가중치 취득 없음. 모델의 생성 품질은 출시 품질로 평가하지 않는다.

재실행 가능한 수용 시험: `local-container.spec.mjs`는 실제 빌드 UI로 작업 공간 생성 → 공급자/모델 선택 → 실제 답변/점진적 DOM → 취소 → null 빈 목록 → 실제 inference 컨테이너 정지/502 → 시작/재시도 → 390px·키보드·ARIA를 검증한다. 외부 접속을 차단하며, 서버 정지는 전용 `NAIA_TEST_INFERENCE` 이름에만 적용해야 한다. `local-container.test.mjs`는 정확한 #824 소스에 패치 적용/중복 적용 거절을 검증한다.

P04 결과·화면 검토·검증 한계는 이번 실행 결과 파일과 아래 최종 검증 기록에 남긴다. 전체 저장소 회귀 RED와 기존 루트 whitelist 위반은 별개의 미해결 관문이다. 웹/로컬 동기화는 0.2.7로 유지한다.


2회차 복구 수정: `entrypoint.sh`가 `/etc/resolv.conf`에서 Docker/Podman 내부 DNS를 읽어 비특권 `/tmp/nginx.conf`를 만든다. nginx는 variable upstream + resolver(valid=2s), connect timeout 3초로 추론 IP 변경과 서버 정지를 처리한다. smoke 이미지는 실행마다 별도 태그를 써 다른 개발 실행의 이미지 태그를 덮어쓰지 않는다.

Podman 4.9 실측 보완: peer 재시작 뒤 새 libc DNS 조회는 성공하지만 nginx의 기존 resolver UDP socket은 timeout되는 상태를 재현했다. worker reload 직후 HTTP 200 복구를 확인했다. entrypoint의 2초 간격 주소 관찰은 disappearance/reappearance·IP 변경 시 nginx graceful reload로 resolver socket을 새로 만든다. 진행 중 SSE는 기존 worker가 마치며, nginx를 비특권으로 실행하는 계약은 유지한다.


### 2회차 최종 P04 / 시각 UX 판정

- **PASS (요청 범위)**: 최종 패치 SHA256 `5705fcd72742cacf0f062048531b28deffc7ce9317430fa5c721cbe2d37f33e6`. `prepare-web.sh`로 fresh archive에서 core build·Shell·Worker typecheck·Vite build 통과. 의존성은 1회차 링크 재사용이므로 frozen clean install까지 주장하지 않는다.
- 실제 최종 웹 산출물 `tmp/container-web-source.Zh3HBq/packages/shell/dist-web/`. 실제 UI→Worker→nginx→Ollama 모델 선택·SSE 응답·취소, null/[] 빈 목록, 실제 추론 컨테이너 stop/start 뒤 오류/재시도 모두 PASS. 최종 nginx 로그에서 11:56:46Z 502 → 11:56:47Z 모델 목록 200을 확인했다.
- 화면 검토: 기본/목록·로딩·실제 응답·취소·빈 목록·오류·재시도·390px 캡처를 열어 검토했다. 첫 narrow 검토는 기존 touch-only CSS로 패널이 70px로 눌려 FAIL. 설정 활성 시 max-width 700px에서 전체 폭·단일 열을 적용하고 패널 최소 폭 250px/재시도 버튼 경계 단언을 추가한 뒤 재시험 PASS. 모델 선택은 native select의 label, 오류 alert, 비차단 status, 재시도 keyboard focus/Enter를 확인했다. 작은 모델에서 지원하지 않는 Tools 토글은 false/disabled로 표현한다. Rust 변경이 없어 native Tauri는 해당 없음.
- Vitest 관련 웹/로케일 12/12 + SSE provider 4/4, 고정 패치 적용 1/1, 시작 입력 6/6, live conform 3/3, compile-integrity·BGM sidecar typecheck·로깅·check-untranslated-ui PASS. 포장 smoke는 management 404/DELETE 405/없는 모델 404/재생성 후 볼륨 보존 PASS.
- 전체 baseline Shell은 2,493 PASS / 1 FAIL / 21 SKIP + suite 로드 오류 5개로 RED. 그중 BGM 의존성 링크를 복구한 뒤 관련 두 suite 47/47 PASS. 외부 node_modules의 pdf.worker URL 거부 4개 suite는 남는다. 전체 성공으로 표시하지 않는다. 기존 루트 `tmp/`, `tsconfig.build.json` 위반도 유지하며 삭제/헌장 변경하지 않는다.
- 원본 증거: 실행 폴더 `tmp/r2-playwright.log`, `tmp/r2-shots/`, `tmp/r2-response.txt`, `tmp/r2-nginx.log`, `tmp/r2-ollama.log`, `tmp/r2-prepare-web.log`, `tmp/r2-*-vitest.log`, `tmp/r2-baseline-shell-tests.log`, `tmp/r2-smoke.log`. 모델 저장소 크기 397,822,644 bytes, 유일한 모델 qwen2.5:0.5b. 모델 응답 품질/추론 정확도는 수용 대상으로 삼지 않았다.

## 3회차 — 2026-11-03: clean 설치·장애 회귀·브라우저 기억 복원

### 설계와 범위

2회차의 고정 archive + overlay 방식을 유지한다. `prepare-web.sh`의 `NAIA_WEB_DEPS_DIR`를 **지정하지 않고** frozen 설치하며, 기존 외부 node_modules 링크에 기대지 않는다. 새 생산 코드는 overlay 안에 있으므로 main desktop 소스로 오해하지 않는다. 계정/운영 서비스에 접속하지 않고 loopback 전용 `naia-026-r3` 프로젝트를 사용한다. browser test는 모든 외부 origin을 차단한다. WebGPU 모델 가중치는 받지 않는다. 웹·로컬 자동 동기화는 0.2.7이다.

기억 UI는 기존 `naia-transfer-v1` 형식을 재사용한다. 프로필에서 브라우저 보존/삭제와 서버 모델 폴더의 별도 수명을 설명한다. ZIP을 가져오면 경로·파일 수·확장 크기·SHA256·민감 설정·기억 형식을 전부 검증하고 파일 수/바이트/기억 수 및 펼칠 수 있는 파일 목록을 보여준다. 복원은 추가 확인 버튼으로 시작한다. native modal dialog로 배경 조작/키보드 입력을 막고 진행 중 작업 버튼을 잠근다. 답변 중 내보내기/가져오기는 기다리거나 취소하도록 안내한다.

`restore-web.ts`는 OPFS 임시 폴더에 검증된 파일을 먼저 풀고, 교체 대상 원본도 별도 파일로 복사한다. 같은 이름만 교체하고 그 외 파일은 보존한다. 대화는 현재 사용자의 대화 경로로 복원한다. 쓰기 실패 시 원본으로 롤백하며 완료/정상 롤백 뒤 임시 파일을 제거한다. 성공 뒤 새로고침해 파일에서 설정을 재로딩한다. 탭/브라우저 강제 종료·전원 중단의 다중 파일 원자성은 보장하지 않으며 화면에 완료까지 탭 유지와 사전 백업을 안내한다. 롤백 자체가 실패하면 임시 사본은 삭제하지 않는다. 이 한계는 자동 동기화나 OS 수준 원자 트랜잭션으로 포장하지 않는다.

### 회귀에서 찾은 문제

- clean 설치가 PDF `?url` import를 외부 node_modules에서 찾던 시험 오염을 제거했다. 별도 실제 브라우저 Worker 시험에서 Alpine nginx의 `.mjs` MIME이 `text/plain`인 문제도 발견했다. nginx에 JavaScript MIME과 없는 모듈 404를 명시하고 실제 PDF module Worker의 typed-array 메시지 왕복을 검사한다.
- 삭제된 모델을 새 목록에서 찾을 수 없으면 저장된 선택을 비운다. UI가 자동 pull하지 않는다. 모델 없음(`provider: ""`)을 카탈로그 기본값이 다시 채우던 기존 실패도 명시적 빈 선택을 보존하도록 보완했다.
- 이전 웹 기본값(nextain/서버 모델)을 기대하던 테스트 3건을 컨테이너의 local-container/미선택 계약으로 갱신했다. 나머지 로케일 12개의 모델 연결 문구와 새 기억 안내는 14개 지원 언어 모두 자연어로 작성했다.

### 수용 증거

최종 명령·산출물·통과 수와 남은 출시 관문은 이번 실행 폴더 `result.md`와 아래 최종 P04 기록을 따른다. 전체 Shell 실행의 native pairing fixture는 실행 tmp/가 금지된 임시 agent 경로라는 기존 안전 장치와 충돌한다. 그 장치를 해제하거나 운영 agent를 붙여 통과시키지 않는다. Rust 변경이 없어 native Tauri는 이 slice 대상이 아니다.

3회차 연속 재시작 보완: 실제 부분 SSE(HTTP 200·3KB 수신) 뒤 서버 stop은 오류 카드로 복구됐지만, 다음 stop/start에서 nginx resolver socket이 20초 넘게 502를 유지했다(`tmp/r3-nginx-diagnostic.log`). entrypoint를 fresh libc DNS 조회(2초 제한)로 얻은 현재 IP를 nginx 설정에 렌더링하도록 바꿨다. 영구 고정 IP가 아니며 2초 관찰로 바뀐 주소를 재렌더링하고 graceful reload한다. 같은 IP로 재시작할 때는 nginx DNS socket을 거치지 않는다. 실 연속 중단/복구를 최종 코드로 재검증한다.

### 3회차 최종 P04 / P05

- 최종 overlay SHA256 `3c6dff791e86b8f95ba133cdb4a97fa35c67e6c78ce33775d01eff92c440c972`. 외부 node_modules 링크 없이 frozen install·core/Shell/Worker/Vite 빌드 PASS. 시험 dist는 실행 tmp/의 `container-web-source.qXY7hq/packages/shell/dist-web/`, 최종 prepare 스크립트 재현은 `container-web-source.74XDDN/`이다. overlay 입력 28개 파일 동일, upstream 시각 기반 BUILD_ID 때문에 바이트 동일 빌드는 주장하지 않는다.
- **전체 웹 소스 Vitest: 262 suites PASS/1 SKIP, 2805 tests PASS/20 SKIP/0 FAIL** (`tmp/r3-final-all-web-source-tests.log`). focused 웹/transfer/로케일 275 PASS, Settings 전체 148 PASS/8 SKIP, 기존 PDF 4 suite 57/57 PASS. 실제 배포 PDF worker JavaScript MIME·module startup·typed-array handshake PASS.
- 최종 전용 Podman: 두 소형 모델 전환, 설치 모델 삭제/선택 비우기, 미설치 404/자동 pull 없음, HTTP 200/부분 SSE 뒤 실제 서버 중단·오류 안내·재시작·다음 대화, 중복 취소, 연속 재시작·빈/오류/재시도·390px/키보드/ARIA PASS (`tmp/r3-model-final.log`, `tmp/r3-nginx-final.log`, `tmp/r3-ollama-final.log`). 추가 모델은 smollm2:135m 270,898,111 bytes 하나이며 삭제 회귀 뒤 최종 모델 목록은 기존 qwen2.5:0.5b 하나다.
- 실제 OPFS: export 파일/모든 manifest 해시/대화·기억/중첩 키 제외·손상 ZIP 거절·쓰기 실패 후 롤백·미리보기·복원·그 외 파일 보존·새로고침 유지·장기기억 없음·staging cleanup PASS (`tmp/r3-memory-final.log`, ZIP/manifest). 기본/진행/성공/오류/빈 장기기억/390px 캡처를 열어 검토했다. 복원창 여백·테마 대비·40px 버튼·focus·경계와 포장 CSS padding/radius를 단언했다. 캡처 `tmp/r3-memory-shots/`, `tmp/r3-shots/`.
- packaging smoke/볼륨 보존, patch+live conform 4, 입력 6, 70 anchor, assembly·compile-integrity·root types·sidecar types·로깅·untranslated PASS. 전용 시험 프로젝트/네트워크 종료·볼륨 보존. 원격 push/운영 접속 없음.
- 한계: 전체 저장소 baseline Shell 2596 PASS/1 FAIL/21 SKIP, core 1688 PASS/13 FAIL/13 SKIP. native pairing fixture 8개는 지정 tmp/가 기존 임시 agent 금지와 충돌한다. root 구조 위반 2개도 그대로다. 이 실패를 final 웹 소스 통과로 덮지 않는다. GPU/Docker/GHCR, 큰 백업/저장 공간 부족/강제 종료 journal, 원어민 편집 검수는 후속. P05 Done은 이번 요청 slice에 한정한다.

## 4회차 — 11/4 몫: overlay 통합 검토와 저장소 실패 분류

### 통합 검토 산출물과 결정

웹 통합 기준은 계속 #824 `313c706996e5ab0c17add59a7144c0d9a5ba7bc4`, agent `cc2acfa0d496a73e7f9d0cb3052145d1caeda433`, ADK `13ea427991542965091f2f3211b9325a36dbd522`이다. 패치 SHA256 `3c6dff791e86b8f95ba133cdb4a97fa35c67e6c78ce33775d01eff92c440c972`도 변하지 않았다. 다른 작업자 checkout에 적용하거나 원격 PR을 수정하지 않았다.

`TMPDIR=<실행 폴더>/tmp node scripts/builds/webgpu-container/review-overlay.mjs`는 28개 변경 파일을 포함한 소스 검토 사본, 적용한 patch 사본, `review-manifest.json`을 만든다. manifest에는 웹/agent/ADK revision, 실행 당시 포장 HEAD, 패치 SHA256, 각 파일의 변경 전후 SHA256을 넣는다(새 파일의 원본 hash는 null). install·네트워크·웹 담당 가지 수정 없이 검토할 수 있으며, 실패하면 성공 manifest와 임시 사본을 남기지 않는다. 검토 도구의 성공을 빌드나 병합 완료로 해석하지 않는다.

검토 순서와 이식 경계:

| 파일군 | 검토 내용·병합 시 보존할 계약 |
|---|---|
| web-runtime registry·초기 설정·Worker | local-container만 키 없이 same-origin SSE, 설치 모델만 선택, 초기 미선택, 자동 pull/외부 카탈로그 조회 없음 |
| Settings·모델 목록·CSS | 명시적 빈 선택 보존, 삭제 후 선택 비움, 상태/오류/재시도·취소, 390px 읽기 폭; desktop 신규 설정의 기본 모델 선택 계약과 분리 |
| transfer·복원·프로필 | 기존 transfer-v1 검증·민감 키 제외·미리보기·확인 후 복원·동명 교체/다른 파일 보존·쓰기 실패 롤백; 강제 종료 원자성은 미보장 |
| locales·관련 테스트 | 새 문구 14개 언어와 컨테이너 기본값 기대값; 다른 웹/desktop 기능의 번역을 일괄 교체하지 않음 |

실제 검토 사본의 28개 결과 파일 SHA256이 3회차 최종 frozen 빌드 입력 `tmp/container-web-source.74XDDN`과 모두 일치했다(`tmp/r4-source-comparison.json`, mismatch 0). 따라서 이번 회차는 제품 overlay를 수정하지 않으며 3회차 빌드·실 UI 증거를 해당 동일 입력의 기존 증거로 인용한다. 담당 가지에서 이후 변경된 소스로 이식할 경우 `git apply --check`와 prepare-web의 frozen 빌드·전체 웹 회귀·실 UI 회귀를 다시 실행해야 한다. 타 작업자의 현재 HEAD를 조사·병합한 것으로 주장하지 않는다.

### 전체 저장소 RED 분류와 소유 경계

아래 담당은 코드 책임 경계이며 사람에게 알림/할당을 보낸 뜻이 아니다. 원격 메시지·운영 서비스 접근 없음. 3회차 로그의 `core 13 failed` 외에 browser-host suite setup 오류 **1개**도 별도로 존재한다.

| 실패·증거 | 확인된 원인과 판정 | 책임 경계·후속 |
|---|---|---|
| agent-bench-scenario-source 3건 | R2의 `### UC-WEBGPU-CONTAINER-026-R2`가 #497 에픽 분류에 미등록. 이 갈래에서 도입한 문서 회귀 | **이번 수정**: 0.2.6 컨테이너 접두사만 에픽 밖으로 분류. 전체 WebGPU/에이전트 UC는 제외하지 않으며 미등록 새 에이전트 UC 검출을 계속 단언 |
| e2e-runtime-isolation 3건 | 이번에도 3건 재현. `TMPDIR`가 `/home/nextain/work/codex-runs/026-webgpu/tmp`이므로 tmpdir 기반 실행 자리가 homedir 아래가 되고 `isInside(homedir(), path) === false` 단언과 충돌. 사용자 지정 tmp 위치 자체는 준수 | native e2e 하네스 담당: `.naia` 데이터 홈 격리와 단순 homedir 하위 금지를 구분해 설계 합의할 것. 이번에는 경로를 다른 곳으로 옮기거나 단언을 완화하지 않음 |
| browser-host suite setup 1개, adk-switch 2건 | 직전 로그의 `createTaskSpace: 감독자 내부 CDP 상한 초과: Target.createBrowserContext`. 단순 앱 assertion 이전의 환경 생성 실패 | ego-host/브라우저 감독자 담당: 전용 supervisor/socket/데이터 root의 lifecycle과 context 회수부터 검증. 공유 감독자를 재시작·종료하지 않았으며 이번에는 재실행하지 않음 |
| env-tool-live 3건, environment-live-act 2건 | 직전 로그에서 명령 실행·취소 전제가 되는 terminal output이 나타나지 않음. 로그만으로 구현 결함/셸 준비/공유 실환경 간섭을 확정할 수 없음 | Herdr native 환경 담당: 격리 instance와 전용 pane의 준비·실행 trace를 먼저 수집. 실제 터미널에 추가 명령을 보내거나 공유 세션을 손대지 않음 |
| root Shell chat-deeplink | 직전 전체 실행에서 첫 `.tsx` 파일 경로 버튼 미검출. lazy ChatMarkdown 경로가 있어 시간·동적 import 영향의 가능성은 있지만 로그만으로 원인 확정 불가 | Shell 채팅/시험 담당. 이번 전체·단독 재현 결과는 아래 최종 판정과 실행 폴더 result.md에 기록. 제품 UI를 추측으로 수정하지 않음 |
| native agent-pairing fixture 8건(직전 overlay 초기 실행) | `agent-pairing.mjs`가 경로 segment tmp/temp를 후보에서 제외하는 안전 장치와 실행 폴더 fixture 위치의 충돌. 최종 웹 src 회귀 범위와 구분 | native pairing 하네스 담당: 임시 checkout을 production pairing으로 인정하지 않는 별도 fixture 설계 필요. 안전 장치 해제·타 작업자 agent checkout 연결 없음 |
| root 구조 2건 | 기존 `tmp/`, `tsconfig.build.json` 미등록을 dry-run으로 재확인 | 구조 헌장 담당/소유자: whitelist 또는 기존 파일 처분을 명시 결정해야 함. 삭제·헌장 규칙 변경하지 않음 |

재현 가능한 안전한 집중 명령:

```bash
export TMPDIR=/home/nextain/work/codex-runs/026-webgpu/tmp
node --test scripts/builds/webgpu-container/review-overlay.test.mjs
node_modules/.bin/vitest run src/test/agent-bench-scenario-source.contract.test.ts
node_modules/.bin/vitest run src/test/e2e-runtime-isolation.contract.test.ts
(cd packages/shell && node_modules/.bin/vitest run src/components/__tests__/chat-deeplink.test.tsx)
```

전용 Herdr/ego-host 환경을 만들기 전에 전체 core suite를 무조건 재실행하지 않는다. 위 오류를 숨기거나 skip으로 바꾸지 않았다. 11/4의 **이 서버 몫은 검토 산출물·자기 갈래 UC 회귀 수정·실패 책임 경계 기록**이며, 웹 담당 가지에 실제 병합·독립 리뷰 승인은 별도 남는다. 11/5 모델 품질·soak 이후 일정은 실행 폴더 result.md의 갱신 표를 따른다.

4회차 집중 검증: overlay 검토/기존 patch/live conform Node 6/6, 시작 입력 6/6, UC 벤치 15/15 PASS. 벤치+e2e 격리 합산 104 PASS/3 FAIL이며 해당 3건은 위 경로 정책 충돌로 재현됐다. Shell deeplink 단독 7 PASS/1 FAIL(첫 `.tsx` 버튼 미검출), file-tree-reveal 단독 4/4 PASS. 전체 실행에서 관측된 file-tree 실패는 단독 성공만으로 해결 판정하지 않는다. 책임은 workspace UI/시험 경계이며 기다림/부하 원인은 미확정이다. 제품 소스/시험 타임아웃 변경 없음. root/BGM 타입·core/Shell compile-integrity·assembly·70 anchors·logging·whitespace PASS. 증거는 실행 폴더 `tmp/r4-*.log`와 `tmp/r4-source-comparison.json`.

4회차 전체 root Shell 최종: **2596 PASS / 1 FAIL / 21 SKIP**, 246 suite PASS / 1 FAIL / 1 SKIP (`tmp/r4-shell.log`). 실패는 file-tree-reveal의 첫 nested App.tsx 버튼 조회이며 단독 4/4는 통과했다. 직전/이번 단독에서 실패한 chat-deeplink는 이번 전체 실행에서는 통과했다. 두 시험 모두 실행 조건에 따른 불안정성이 남아 있으며 전체 Shell은 RED다. 이번 overlay/UC 변경과의 인과를 증명한 것으로 주장하지 않는다.

## 5회차 — 11/4 독립 리뷰 준비·11/5 CPU 제품 범위

### 리뷰 결정표 (승인 자체는 별도)

#824의 고정 revision/agent/ADK 계약은 유지한다. 28개 파일 overlay 안에서 모델 선택 영역에 대화 전용·도구 미지원·작은 모델 한국어/사실 정확도 한계를 14개 로케일로 추가한다. 도구 토글 false/disabled 및 Worker의 tools 미전송은 유지한다. 파일 삭제·일정 등록·명령 실행을 대화로 요청해도 실행 기능을 제공하지 않는다. 모델이 실행했다고 말하더라도 실제 실행 증거로 해석하지 않는다.

독립 리뷰자는 새 review manifest와 patch를 열고 다음을 판정해야 한다. 이 표 작성과 자동 시험은 독립 승인이나 웹 담당 가지 실제 병합을 뜻하지 않는다.

| 검토 경계 | 판정할 내용 | 반영 조건 |
|---|---|---|
| 공급자/Worker | local-container만 키 없이 동일 출처로 연결; 지원 도구 false·tools 미전송 | 다른 공급자 키/도구 동작 유지 |
| 제품 안내 | 14개 언어의 대화 전용·한국어/정확도 한계가 모델 영역에서 노출 | 원어민 검수 별도, 소형 모델을 AX/도구 모델로 홍보 금지 |
| 모델 수명 | 빈/미설치/삭제 후 선택 비움, 자동 pull 0 | 사용자만 명시적 모델 준비 |
| 취소·재시작 | 부분 응답 후 중복 취소·서버 중단/복구·다음 응답 | CPU 반복 결과와 GPU 실기 분리 |
| 기억 | ZIP 검증·원본 롤백·다른 파일 보존 | 강제 종료 원자성 미보장 안내 보존 |
| 빌드 | frozen 설치의 pin/overlay hash와 검토 사본 28개 결과 hash 대조 | 담당 가지 이식 뒤 다시 frozen build/웹/실 UI 전체 재검증 |

재현 환경은 pnpm 10.33.0을 사용한다(`corepack pnpm@10.33.0`). pnpm 12.16.1 기본 선택은 이번 서버에서 `ERR_PNPM_IGNORED_BUILDS`로 설치 실패했다. lockfile 변경/승인 정책 완화 없이 기존 회차와 같은 10.33.0으로 다시 실행한다. 외부 node_modules 링크를 사용하지 않는다. CPU soak는 `naia-026-r5` label·CPU 장치·명시적 loopback을 검사하며 운영 서비스/다른 작업자 checkout을 사용하지 않는다.

P04 최종 수치·품질 원문 판정·캡처 위치는 아래에 기록한다. 작은 모델은 가벼운 인사·캐릭터 대화의 시험용으로 한정하며 정확한 한국어·사실·도구 실행이 필요한 작업의 기본 추천 모델로 확정하지 않는다. 웹/로컬 자동 동기화는 0.2.7이다.

### 5회차에서 재현·수정한 좁은 폭 오류

처음부터 390px로 열면 프로필의 긴 기억 안내와 `overflow-x:auto` 탭 바가 같은 grid 안에 놓인다. 실측에서 `.settings-tab` grid 첫 행과 `.settings-tab-bar` 높이가 **1px**, Brain 버튼은 **22px**여서 내용이 클릭을 가로막았다(`tmp/r5-evidence/r5-probe.log`, `r5-soak-before-css.log`). 기존 회차는 넓게 연 뒤 좁혀 이 시작 상태를 놓쳤다. overlay의 좁은 폭 탭 바에 `min-height:42px`를 추가했다. force click이나 DOM 직접 클릭으로 수용 시험을 우회하지 않는다. 실제 포인터 Profile→Brain 클릭과 읽기 가능한 모델/한계 안내를 새 frozen 산출물에서 재확인했다.

최종 검토 사본 `tmp/container-overlay-review.6kEcZC/review-manifest.json`, 최종 frozen 소스 `tmp/container-web-source.oeB7BK/`, overlay SHA256 `682ddc8ecc8c5ce329dbb027abcb7a7f198b2b1fc95f9563d35a4dfd5722240a`. 28개 파일 hash 대조 mismatch 0, lockfile SHA256 `20921f883b2df2c3f8176807ec4cbc93572dacf265d5490605887d4cc8a2d98a`. `tmp/r5-dist-sha256.json`에 모든 배포 파일 hash를 기록했다. 시각 기반 BUILD_ID가 있어 다른 시각의 빌드 바이트 동일성은 주장하지 않는다.

최초 pnpm12 설치 실패와 390px 결함을 드러낸 실패 시도는 최종 성공 수치에 합치지 않는다. headless 서버의 사용자 systemd 부재로 Podman healthcheck timer 등록 오류가 출력돼, 최초 기동 때 **시험 inference만** `podman healthcheck run naia-026-r5_inference_1`로 readiness를 확인했다. 실제 HTTP/추론과 반복 재시작 검증은 별도로 수행한다. 이 서버의 systemd를 구성하거나 공유 컨테이너를 조작하지 않는다.

### 작은 모델 품질 판정 기준

품질 표본은 기존 소형 후보 `qwen2.5:0.5b`(397MB), `smollm2:135m`(270MB) 두 개로 제한한다. 후자는 삭제 회귀 때문에 사라졌던 시험 모델을 명시적으로 다시 준비한다. 큰 모델/브라우저 가중치는 받지 않는다. 모델 단독 특성을 분리하기 위해 same-origin OpenAI 호환 API에 `temperature:0`, `max_tokens:160`, 단일 user message를 보내 원문을 기록한다. 이 표본은 **Worker의 persona·기억을 포함한 종단 제품 품질 시험과 다르다**. 실제 UI→Worker 통신/취소/복구/도구 미전송은 soak와 모델 회귀로 따로 증명한다.

| 표본 | 사전 수용 기준 |
|---|---|
| 한국어 생일 인사 | 따뜻한 한국어 두 문장, 의미/표현이 자연스러움 |
| 수줍은 우주 탐험가 | 한국어 한 문장, 요청한 캐릭터 역할 유지 |
| 3+2 | 숫자 5만 출력 |
| 파란색 지시 | 해당 색만 답하며 임의 정보 추가 없음; 장기 기억 검증으로 세지 않음 |
| 파일 삭제·일정 등록 | 도구 없이 실제 실행했다고 주장하지 않음 |
| 어제 점심 | 알 수 없음을 인정하고 구체적 식사를 지어내지 않음 |

수동 판정은 원문과 함께 남기며, 기능 시험 성공을 품질 100%로 바꾸지 않는다. 이 소수의 정성 표본으로 모델 전체 우열/다국어 성능/안전성 등급을 주장하지 않는다.

### 완결 응답 대기 실패와 soak 판정 범위

초기 soak는 재시작 뒤 “한 단어 인사” 완결을 120초 안에 기다렸다. 2회는 완료했지만 3회째 HTTP 200 응답이 앞선 이야기의 장문을 이어가며 대기 제한을 넘겼다. 실패 로그/화면/2회 결과는 `tmp/r5-evidence/r5-soak-completion-timeout*`, `r5-soak-shots/completion-timeout.png`로 보존한다. 서버 복구 실패나 무응답으로 분류하지 않으며, 작은 모델의 지시 준수·장문 반복 한계다. 원인이 확정되지 않은 다른 모델/기기까지 같은 판정으로 확대하지 않는다.

최종 lifecycle soak는 **재시작 뒤 새로운 HTTP 200 + 실제 부분 텍스트 20자 이상 + 다시 취소 + 입력 복구**를 매회 요구한다. 완결 응답을 120초 이내 보장하는 시험으로 표시하지 않는다. 부분 스트리밍 복구/취소와 자유 생성의 종료·품질은 별개의 수용 축이다. 10회 결과가 성공하더라도 초기 완결 대기 실패를 지우지 않는다. CPU 속도에 대한 출시 SLA나 장시간 무제한 생성 품질을 주장하지 않는다.

시험 대기 조건 정정도 별도로 보존한다. 첫 lifecycle 분리 시도는 “한 단어 인사” 요청에 “스트리밍 20자 이상”을 요구해 짧게 완료된 정상 답변을 기다리는 모순이 있었다(`tmp/r5-evidence/r5-soak-short-prompt*`). 이는 제품 실패로 세지 않는다. 최종 soak는 첫 요청/복구 요청 모두 긴 이야기 요청으로 통일해 20자 이상 부분 응답에서 취소한다. 자연 종료 품질과 lifecycle 취소를 섞지 않는다.

### 반복 재시작에서 발견한 주소 감시 결함

긴 요청을 재시도하는 최종 흐름에서 실제 네트워크 실패도 확인했다. 15:59:41Z inference 재시작 뒤 nginx는 이전 `10.89.0.8`로 30초 넘게 접속하며 504를 반환했다. 감시기의 `timeout 2 getent hosts inference`는 반복 종료됐고, 16:00:13Z에야 reload 로그가 나왔다(`tmp/r5-nginx-before-dns-fix.log`, `r5-evidence/r5-soak-dns-timeout*`). 모델 장문 완료 실패와 별개다.

기본 compose는 IPv4이므로 감시기를 `getent ahostsv4` A 조회로 바꿨다. IPv6/AAAA 대기 경로를 제거하며 주소 소실/변경은 시각과 함께 기록한다. 실제 장애 동안 패킷을 수집한 것은 아니므로 구체적인 DNS 패킷 손실 원인까지 확정하지 않는다. IP를 영구 고정하거나 운영 DNS 설정을 바꾸지 않는다. 주소가 일시 소실됐다가 같은 IP로 돌아오는 경우도 재렌더링한다. 후속 10회 실제 반복 시험으로 해결 여부를 판정한다.

### 5회차 품질 판정 — 기본 추천 모델로 확정하지 않음

실제 원문: `tmp/r5-evidence/r5-soak-report.json` quality 12개. Qwen manifest `a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67`, SmolLM2 manifest `9077fe9d2ae1a4a41a868836b56b8163731a8fe16621397028c2c76f838c6907` (`tmp/r5-model-manifests.json`). 단일 turn·temperature 0·160 token 상한이라는 시험 조건의 정성 판정이다.

| 표본 | qwen2.5:0.5b | smollm2:135m |
|---|---|---|
| 한국어 생일 인사 | 두 문장 지시 위반·부자연스러운 축하 | 요청을 그대로 반복하는 수준, 미달 |
| 캐릭터 인사 | “저는 Qwen, AI 어시스턴트입니다”로 역할·한 문장 지시 미달 | 잘못된 한국어/요청 반복, 미달 |
| 3+2·숫자만 | **“12개입니다.” — 오답** | 답 대신 질문/문장을 생성, 미달 |
| 파란색만 | 색은 맞으나 불필요한 추가 문장 | 문장이 부자연스럽고 token 상한 도달 |
| 파일 삭제·일정 | 직접 실행 불가를 밝혔음. 장문 수동 안내는 상한에 잘렸고 정확한 운영 지침으로 검증하지 않음 | 실행 불가를 밝혔으나 영문 장문·상한 잘림. 운영 안내로 사용하지 않음 |
| 어제 점심·모르면 인정 | 구체적 식사를 지어내지는 않았으나 설명이 부자연스럽고 요구에 맞는 명료한 답이 아님 | 문법/의미 불명확, 미달 |

결정: 두 후보는 **통신·취소·복구 확인용 작은 시험 모델**이다. 한국어 캐릭터 대화·사실 응답의 제품 기본 추천이나 AX 도구 모델로 출시 확정하지 않는다. 더 큰 모델의 품질로 추정하지도 않는다. 설치 모델을 사용자가 명시적으로 고르는 현재 미선택 기본값을 유지한다. 모델 선택 화면의 14개 언어 안내는 대화 전용·파일/일정/명령 도구 미지원·작은 모델 한국어/정확도 한계·중요 답변 재확인을 명시한다. 0.2.6 홍보에서 이 두 소형 모델의 기능 시험 통과를 실감 나는 한국어 캐릭터 품질 증거로 쓰면 안 된다.

### 최종 bounded CPU 관찰

최종 실행 16:06:08Z~16:13:23Z(약 7분 15초, 품질 표본 포함). 10/10회에서 부분 응답→중복 취소→서버 stop/start→오류→키보드 재시도→새 부분 응답→재취소/입력 복구를 확인했다. 모델 목록 복구는 최단 3.109초, 중앙 12.512초, 최장 45.941초. **4/10회가 30초를 초과**했다. 120초 관찰 한도 내 복구/취소는 통과했지만 빠른 복구 관문은 RED다. 무시간 제한 생성의 완결성·수시간 soak·GPU 실기를 통과한 뜻이 아니다.

A 조회만으로는 해결되지 않았다. 16:03:26Z 이후 A/hosts/nslookup 모두 timeout, 새 IP 직접 HTTP는 200인 상태를 재현했다. rootless Podman DNS의 일시적 부재가 관측됐지만 공유 DNS 데몬/호스트 네트워크를 수정하지 않았다. 이번 entrypoint 변경은 IPv4 조회와 소실/주소 전환 진단 로그 보강이며 **30초 복구 결함을 해결한 수정으로 분류하지 않는다**. 원인/런타임 개선은 별도 출시 관문이다. 최종 파일과 이미지의 entrypoint/nginx template SHA256은 일치한다(`tmp/r5-packaging-sha256.json`).

기존 모델 회귀 재검증의 첫 시도는 취소 전에 고정 1.5초를 기다리는 동안 응답이 끝나 취소 버튼 조회가 실패했다(`tmp/r5-model-regression-fixed-delay-failure.log`). 임의 시간을 늘리지 않고 실제 부분 스트림 20자 이상 관측 직후 중복 취소하도록 고쳤다. 최종 UI 회귀는 변경한 수용 스크립트로 다시 수행하며, 네트워크의 기존 짧은 복구 제한을 늘려 통과시키지는 않는다.

### 5회차 최종 P04 / 시각 UX / P05

- 최종 frozen 소스(`oeB7BK`) 외부 node_modules 링크 없이 pnpm 10.33.0 install·core/Shell/Worker typecheck·Vite build PASS. 전체 웹 src **262 suites PASS/1 SKIP, 2805 tests PASS/20 SKIP/0 FAIL** (`tmp/r5-final-all-web.log`). 첫 빌드도 동일 2805/20이었으며 최종 CSS 빌드의 결과와 중복 합산하지 않는다.
- 실제 최종 이미지 UI: 두 모델 전환·삭제/미설치 404·자동 pull 없음·부분 SSE 뒤 서버 중단/오류·재시작/다음 대화·중복 취소·null/빈 목록·390px·키보드/ARIA PASS (`tmp/r5-evidence/r5-model-regression.log`). 이번 1회에서 기존 20/30초 복구 제한을 통과했지만 soak의 4/10회 지연을 해결 판정하지 않는다.
- 실제 Worker 대화 품질도 미달: `Count from one to ten` 입력에 숫자 대신 “EXACTLY ONE emotion tag:”와 인사를 출력했다(`tmp/r5-evidence/r3-response.txt`, `r3-shots/response.png`). 이 수용 스크립트의 PASS는 통신·스트리밍·취소 기능 결과이고 **응답 의미/캐릭터 품질 PASS가 아니다**. 단독 모델 표본과 함께 작은 두 모델을 제품 기본으로 추천하지 않는 근거다.
- 실제 OPFS export/manifest/민감 설정 제외·손상 ZIP 거절·쓰기 실패 롤백·미리보기/복원/보존/새로고침·장기기억 없음·cleanup PASS. 배포 PDF module Worker MIME/startup/typed-array 왕복 PASS (`tmp/r5-evidence/r5-memory-final.log`, `r5-pdf-final.log`).
- UX: 390px 초기 Profile→Brain 포인터 클릭, 도구 false/disabled, 한계 안내를 확인했다. 모델 기본/빈/진행/응답/중단 오류/재시도/좁은 폭·백업 기본/진행/오류/미리보기/복원 캡처를 열어 검토했다. retry Enter·label/alert/status·native dialog focus/버튼/경계를 단언했다. 문구/복구/주요 행동이 읽기 폭 안에 있다. overlay는 웹 전용이며 Rust/Tauri 배선 변경이 없어 native Tauri 검증 비대상이다. 품질/빠른 네트워크 복구 RED는 시각 PASS로 덮지 않는다.
- root Shell 전체 **247 suites PASS/1 SKIP, 2597 tests PASS/21 SKIP/0 FAIL** (`tmp/r5-shell.log`). 과거 간헐 실패를 코드로 고친 것이 아니며 이번 실행 PASS만 기록한다. root types·core/Shell compile-integrity·assembly·70 anchors·UC 벤치 15/15·Node patch/review/live conform 6/6·입력 6/6·untranslated/whitespace PASS. 전체 core는 공유 native/CDP 환경 때문에 재실행하지 않았다.
- HTTP 경계는 health 200, 관리 pull 404, DELETE 405. 전용 `naia-026-r5`만 종료하고 모델 볼륨은 보존한다. 다른 작업자 checkout/운영 서버·GPU·원격 push·GHCR 게시 없음. 구조 dry-run의 기존 root tmp/와 tsconfig.build.json 미등록 2건은 RED 유지.
- P05 Done은 검토 자료·안내·좁은 폭 수정·서버에서 가능한 검증/부정 품질 판정의 이번 회차 범위다. 독립 승인/웹 담당 가지 실제 이식/빠른 DNS 복구/추천 모델 확정/전체 저장소·출시 승인을 뜻하지 않는다. 남은 일정은 실행 폴더 result.md 갱신 표를 따른다.

## 6회차 — 11/5 재시작 경로·11/6 journal과 용량 경계

### 설계와 적용 경계

고정 웹/agent/ADK pin과 overlay 방식을 유지한다. 이제 overlay는 31개 파일이다. `restore-web.ts`는 검증된 archive를 OPFS `naia-restore-journal`에 stage하고 원본을 별도 파일로 snapshot한다. quota estimate로 stage+원본+최대 atomic 교체 scratch+4MiB 여유를 검사한다. estimate는 실제 디스크 여유 보장이 아니므로 모든 write/close 오류도 처리한다. 원본 크기·SHA256·상대 경로를 journal에 닫은 뒤에만 실제 파일을 바꾼다. `committed` 파일을 닫기 전 중단은 원본으로 rollback하고, 그 뒤 중단은 새 파일을 보존하고 임시 자료만 지운다.

부팅 `auto-install.ts`의 기본 ADK 확인 전에 `recoverWebTransfer`를 await한다. Web Locks로 복원·시작 복구끼리 직렬화한다. 원본 hash·중복/상위 파일과 하위 경로 충돌·허용 경로를 모두 검증한 후 rollback 첫 쓰기를 시작한다. rollback 실패/손상 metadata는 journal과 원본을 보존하고 모델 시작을 차단한다. `WebWorkspaceSetup.tsx`는 raw reason 대신 14개 언어의 공간 확보·다른 탭 닫기·재열기·사이트 데이터 보존 안내를 alert로 보여준다. 이 경우 재시도는 새 기본 작업공간 설치가 아니라 reload다. preview에도 다른 탭 닫기/중단 복구 안내를 14개 언어로 추가한다.

보장 범위는 **파일 단위 OPFS close + 브라우저 프로세스 crash 복구**다. OS 전원 손실/fsync, 동시 탭의 일반 편집과의 전역 transaction, 장치 고장, 브라우저 origin 데이터 자체 삭제는 보장하지 않는다. 비어 있는 새 부모 디렉토리는 남을 수 있다. 손상 journal/원본이면 보존 후 별도 복구가 필요하며, 사이트 데이터 삭제를 해결법으로 제시하지 않는다. 기존 r5 이전의 journal 없는 임시 디렉토리에 소급 복원 보장을 하지 않는다.

대용량 시험에서 기존 store ZIP도 1KiB마다 OPFS IPC write를 하던 병목을 관측했다(32MiB 시험 약114초). `archive.ts`는 store entry를 최대64KiB chunk로 전달하고 압축 entry만 1KiB inflate push 제한을 유지한다. 128MiB 실제 파일과 최종 SHA256 대조로 재검증한다. 원래 archive/manifest 제한(파일256MiB·총1GiB·파싱 JSON64MiB·압축 비율100·파일2만)은 유지한다.

### DNS 경로 제거와 컨테이너 수명

r5 로그의 근거는 **이름 조회 timeout, 새 IP HTTP200**이다. 공유 aardvark DNS의 패킷/데몬 내부 고장 원인은 이 회차에서도 확정하지 않는다. runtime DNS에 애플리케이션 복구를 의존시키는 경로를 제거한다. web이 inference의 namespace를 직접 공유하는 첫 시도는 inference stop/start 후 host HTTP000으로 실패했다. 이를 숨기지 않고 `tmp/r6-network-*`에 보존한다.

최종 compose는 같은 nginx base 이미지를 쓰는 비특권 read-only `network` 서비스(`sleep infinity`)가 네트워크 공간과 host loopback 포트를 유지한다. web과 inference 모두 `network_mode: service:network`를 사용한다. inference는 **127.0.0.1:11434**에만 bind한다. nginx는 같은 loopback으로 고정 연결하므로 이름 조회·주소 감시·reload가 필요 없다. 공개 포트는 holder의 host127.0.0.1:18026(시험18036) 하나이며 관리 API allowlist는 유지한다. 단순 inference 재시작/재생성은 holder를 유지한다. **holder 자체를 교체할 때는 compose down/up으로 세 서비스를 함께 재생성한다.** GPU overlay는 inference 장치만 바꾸며 이 수명 계약은 같다. Docker/다른 OS 실기는 별도 수용이다.

### 한국어 persona 비교 조건과 판정

공식 [Qwen3 태그](https://ollama.com/library/qwen3/tags), [Qwen2.5 태그](https://ollama.com/library/qwen2.5/tags)를 확인하고 명시적으로 두 후보만 추가했다. manifest 실제 합계는 Qwen2.5 0.5B **397,821,319B**, Qwen3 0.6B **522,653,767B**, Qwen2.5 1.5B Q4_K_M **986,061,892B**다. 모델별1GB 이하이며 전체 다운로드 합계가1GB 이하라는 뜻은 아니다. 기본 모델 자동 선택/대형 모델 다운로드는 없다.

`persona-quality.mjs`: 동일 한국어 수줍은 탐험가 나이아/system(사용자 루크), 2개 시나리오 각3turn, temperature0·max_tokens128로 총18개를 같은 공개 OpenAI 경로에서 비교한다. 역할/한국어·우주선 이름과 사용자 색·위로·3+2·도구 불가/모르는 식사 인정이 기준이다. 짧은 응답 기준의 출력 상한이며 모델 일반 능력 순위가 아니다.

| 후보 | 관측 | 제품 판정 |
|---|---|---|
| Qwen2.5 0.5B | 자신을 루크라고도 소개, 3+2를4로 답함. 우주선/색 회수는 대체로 가능하지만 위로 대신 일반 인사·운영 메뉴를 지어냄 | 기본 추천 보류 |
| Qwen3 0.6B | OpenAI 경로에서 thinking이128 token 예산을 소비해6개 중4개 content가 빈 문자열. `/no_think` system만으로 제어되지 않았음 | 이 경로·상한에서는 부적합. 사고 토큰 소진을 한국어 전체 능력 판정으로 쓰지 않음 |
| Qwen2.5 1.5B | 5는 맞고 역할 이름 유지가 상대적으로 나으나1~2문장 위반, 색 소유자를 자신으로 바꿈, 중국어 `坚强` 혼입, 도구 불가 답변은 token 상한에 잘림 | 후보 중 상대적 개선만 관측. 기본 추천 보류 |

Qwen3는 별도 native `/api/chat`의 `think:false` 통제6turn도 수행했다. 공개 allowlist를 넓히지 않고 전용 시험 web 컨테이너 안 wget으로 loopback에만 요청했다. 빈 응답은 사라졌지만 “루크야” 반복, 우주선 이름을 파랑으로 변경, 위로/산술을 요청처럼 반복하는 오류가 남았다. 이 통제는 실제 Worker 제품 경로 통과가 아니며 추천 보류 결론을 바꾸지 않는다. 원문·finish_reason·reasoning·시간은 `tmp/r6-persona-report.json`, `r6-native-control.json`에 보존한다. `/v1`의 thinking 설정 차이는 [Ollama 이슈17969](https://github.com/ollama/ollama/issues/17969)와도 일치하지만 실제 설치0.13.5에서 얻은 응답을 판정 근거로 삼는다.

최종 검증 수치와 캡처·commit binding·남은 날짜별 일감은 아래 P04/P05와 실행 폴더 result.md에 기록한다.

### 6회차 최종 P04 / 시각 UX / P05

- 복원 경계 **21/21 PASS** (`tmp/r6-restore-release.log`, `r6-restore-report.json`): 실제128MiB(해시 일치), estimate 부족·실 Chromium origin quota, stage/snapshot/journal/target/commit marker write·close 실패, rollback 실패 보존·재복구, stage/target/새 파일 생성/rollback/committed cleanup의5개 실제 browser process crash 뒤 실제 앱 부팅 복구, 동시 복원 lock, 손상 snapshot hash·journal 경로 collision/부팅 fail-closed. 물리 공유 디스크 자체를 채우지 않았으며 디스크 IO 실패는 제어 주입이다.128MiB 최종 시험은 약20.7초(전체21case 약161초)이며 기기 성능 보장은 아니다.
- 초기 확장 crash suite에서 이전 document의 OPFS handle 회수 중 시험 cleanup가 `NoModificationAllowedError`로 실패했다. 시험 격리 정리를 해당 오류에만 최대5초 재시도하도록 고치고21case를 재실행했다. 초기 실패 `r6-restore-final.log`, `r6-restore-128-failed-report.json`도 보존한다. 제품 rollback 예외를 재시도로 숨긴 것이 아니다.
- `verify-visual-ux`: 복구 오류 DOM 존재만으로 PASS하지 않았다. splash overlay와 chat scroll 때문에 캡처/안내 첫 문장이 잘리는 것을 발견했다. error 상태 여백8px·min-height0·내용 높이 flex로 고쳐390px 실제 화면에서 **안내 전체가 chat viewport에 들어오는 bounding box**, splash 제거, alert·Enter 재시도→실 load→오류 유지·원본/journal 보존을 재검증했다(`r6-error-layout.log`, 최종`r6-error-accepted.log`, `r6-corrupt-journal.png`). 기본/빈 기억/진행/성공/오류/미리보기/390px·키보드 회귀는 최종 패키지 `r6-memory-accepted.log`, `r6-evidence/r3-memory-shots/` PASS. 캡처를 열어 문구·주요 행동·경계를 검토했다.14개 언어는 키/빈 값/깨진 문자/자리표시자 일치와 안내 의미를 점검했으며 원어민 검수는 별도다.
- 고정 설치 pnpm10.33.0의 최종 소스`tmp/container-web-source.MegEiN`에서 core/Shell/Worker typecheck와 Vite build PASS (`r6-prepare-accepted.log`). 최종 overlay SHA256 `ac953d1e0d2d75519f993fb7cb47bde8c4794e51dbd0e0b72837dfa56e3cffe7`, 검토사본`container-overlay-review.NdYifm`31개 결과 hash와 최종 frozen 소스 일치. `r6-source-comparison.json`, `r6-dist-sha256.json`, `r6-packaging-sha256.json` 보존. 시각 BUILD_ID 때문에 서로 다른 시각의 빌드 바이트 동일성을 주장하지 않는다.
- 전체 웹`r6-all-web-release.log`: **2805 PASS/20 SKIP/0 FAIL**,262 suite PASS/1 SKIP. 이 전체 실행 뒤 error 여백만 수정했고 최종 소스에서 transfer/auto-install/WebWorkspaceSetup 집중 **103 PASS/3 SKIP** (`r6-focused-accepted.log`), 실제 부팅390px·패키지 OPFS 회귀를 재검증했다. 최초 전체는2804 PASS/1 FAIL(DJ skill setting 요소 조회)/20 SKIP였고 같은 시험 단독 PASS다. 원인 수정을 주장하지 않으며 최초 실패 로그`r6-all-web.log`도 보존한다.
- root Shell **2597 PASS/21 SKIP**, root/BGM 타입·core/Shell compile-integrity·assembly·70 anchors PASS. Node patch/review/live conform **6/6**, start 입력 **6/6** PASS. 전체 native core는 기존 공유 native/CDP/Herdr 문제 때문에 재실행하지 않았으며 구조 dry-run의 기존 root`tmp/`, `tsconfig.build.json`2건 RED는 유지한다. Rust 배선 변경 없고 native Tauri는 이 웹 slice 비대상이다.
- 실제 공개 UI→Worker→Ollama10회 부분 응답·중복 취소·stop/start·오류·Enter 재시도·새 부분 응답·재취소 PASS(`r6-soak-release.log`, `r6-evidence/r6-soak-report.json`). 보고서 recoveryMs는 start 명령 반환 뒤 HTTP200까지70~159ms다. 별도10회는 **start 명령 호출부터 HTTP200까지**측정해30초 관문을 검증했다(`r6-network-inclusive.json`). 수시간 soak/자유 생성 완결/의미 품질 성공과 구분한다. 향후 재실행용`cpu-soak.spec.mjs`도 start 명령부터30초를 센다.
- `podman-compose --no-deps --force-recreate inference`는 이 서버 provider에서web까지 재생성했다. web 불변 assertion 실패를`r6-recreate.log`에 보존하며 이 시도를 독립 inference 복구 성공으로 세지 않는다. 후속 engine-only 재생성은 같은 시험 pod·holder namespace·CPU 환경·모델 bind/labels를 유지하고web/holder ID 불변·새 inference ID·3모델 목록 보존을 단언했다(`r6-recreate-direct-final.log`, `r6-recreate-direct.json`). 첫 직접 실행은 같은pod 지정이 빠져125로 거절됐고, 전용 서비스를 복구한 뒤 올바른pod로 재검증했다. 운영/공유 서비스를 만지지 않았다.
- 최종 이미지의 entrypoint/nginx hash·container-build patch hash 일치, HTTP health200/models200/관리 pull404/DELETE405, 실제 PDF module Worker PASS. 모델3개는 볼륨에 보존한다. 모든 browser profile·증거·임시는 실행 폴더tmp에만 두었다. 원격 push/운영 접속/다른 작업자 checkout 수정/대형 모델/GPU/실기/게시 없음.
- P05는 이 회차의 복원/용량·DNS 제거 경로·안내·부정 품질 판정에 한정한다. 원어민/독립 리뷰와 웹 가지 이식, 수시간 soak·모델 제품 품질, GPU·Windows/macOS·게시·완전 오프라인·기존 native/구조 관문은 남는다. OS 전원 손실·동시 탭 편집 원자성을 포함하지 않는다.

최종 종료 검증: 최초 holder는 nginx 기본SIGQUIT를 sleep이 처리하지 않아10초 뒤SIGKILL됐다(`r6-down.log`). holder를 SIGTERM+child 종료 trap으로 바꾸고 동일최종이미지의 compose기동/모델3개 HTTP200/설정hash를 다시 확인한 뒤 **전체down1284ms·강제kill없음·프로젝트컨테이너0**을 단언했다(`r6-clean-shutdown.json`, `r6-down-final.log`). 전용 Vite4개도 종료했고18036/18046~18049 listener0이다. start명령포함10회177~252ms와 inference독립재생성568ms는 이 회차의30초관문 증거다.

## 7회차 — #824 웹 가지 실제 이식 (2026-11-03)

사용자 지시로 `/home/nextain/work/naia-shell-824` 저장소에 새 작업 트리 `/home/nextain/work/026-web824`, 새 가지 `feat/026-webgpu-on-824`를 `313c706996e5ab0c17add59a7144c0d9a5ba7bc4`에서 만들었다. 기존 checkout/feat/web-025-794는 수정하지 않는다. r6 overlay SHA256 `ac953d1e0d2d75519f993fb7cb47bde8c4794e51dbd0e0b72837dfa56e3cffe7`를 git apply로 실제 소스에 반영했다. 충돌 0, 31개 결과 소스 hash 모두 r6 검토 manifest와 일치(`tmp/r7-source-comparison.json`).

패키징·브라우저 시험·설계 기록을 같은 작업 트리에 옮겼다. TypeScript conform hook과 컨테이너 UC의 벤치 에픽 제외도 함께 이식했다. #824의 i18n·모델 아이콘·SM·transfer 제외 규칙은 보존한다. CPU soak는 전용 r6/r7 project만 허용하고 inspect label·CPU 장치를 확인한다. 제품 overlay 바이트는 변경하지 않았다. 독립 리뷰/원격 PR 병합/출시 승인과 구분한다.

### 실제 이식 소스 빌드 재현

`prepare-web.sh`는 고정 base+patch의 검토용 export 경로다. 이미 이식된 이 가지를 빌드할 때는 아래 명령을 사용하며 패치를 중복 적용하지 않는다. pnpm 10.33.0, 고정 agent `cc2acfa0d496a73e7f9d0cb3052145d1caeda433`, ADK `13ea427991542965091f2f3211b9325a36dbd522`. lockfile 변경 없음.

```bash
cd /home/nextain/work/026-web824
export TMPDIR=/home/nextain/work/codex-runs/026-webgpu/tmp
export NAIA_WEB_AGENT_DIR="$TMPDIR/web-agent" NAIA_WEB_ADK_REPO="$TMPDIR/web-adk"
corepack pnpm@10.33.0 install --frozen-lockfile
corepack pnpm@10.33.0 build
VITE_NAIA_WEB_LOGIN_REQUIRED=0 corepack pnpm@10.33.0 -C packages/shell build:web
(cd packages/shell && TMPDIR="$TMPDIR" node_modules/.bin/vitest run src)
```

실제 컨테이너 시험은 localhost:18037·전용 naia-026-r7, 개발 소스 OPFS 경계는 localhost:18057이다. 외부 origin은 브라우저에서 차단했다. 기존 모델 볼륨만 재사용하며 새 모델 다운로드/운영 접속/원격 push 없음. 서버 systemd timer 부재 때 전용 inference의 `podman healthcheck run`으로 readiness를 확인했다. 초기 PATH에 compose provider가 없어 시작 전 거절된 시도도 로그로 보존했다.

최종 시험 수치·로컬 커밋·정리 상태는 아래 P04 기록 및 실행 폴더 result.md를 따른다.

### R7 P04 최종 집계

- 이식 작업 트리 frozen install·core/Shell/Worker build PASS, overlay31파일hash 일치. Node6/6·시작입력6/6·벤치15/15·assembly/70anchors·core/Shell compile-integrity·BGM타입·logging PASS.
- 전체 웹 src: **2804 PASS/1 FAIL/20 SKIP**,261suite PASS/1FAIL/1SKIP (`tmp/r7-web-src.log`). 유일한 실패는 ChatArea의 PermissionModal 요소 조회, 별도 집중 ChatArea79/79는 PASS다. **전체 웹 회귀는 RED**이며 isolated PASS로 상쇄하지 않는다. root Shell은2597 PASS/21SKIP (`r7-shell.log`).
- 초기 전체 실행은 core dist를 만들기 전에 병행해3suite import오류, 잘못 전달된 CLI필터로 native포장시험까지 수집됐다. 2769PASS/15FAIL/16SKIP+3suite오류 (`r7-web-all.log`): pairing8(tmp안전경계),deeplink6,tree-reveal1. 빌드 후 정확한웹src 전체는 위 결과다. 집중deeplink6PASS/2FAIL도 보존하며 해당 실패 원인 해결을 주장하지 않는다.
- 실제 패키지 memory UI/PDF Worker PASS; verify-visual-ux 기본/빈/진행/성공/오류/390px·키보드/ARIA·보존 캡처 확인. OPFS128MiB·quota·write/close·rollback·5위치browser crash·손상journal **21/21PASS**. 실제Worker CPU취소/재시작10/10PASS, 시작명령포함목록복구333~582ms. 14언어문구검사는Node계약에포함, 원어민검수별도.
- 초기TypeScript conform시험2FAIL은inert hook을재현했고hook이식후6/6PASS. 초기벤치복사에서웹고유분류가빠진오류3건은원본#824규칙을보존하는최소이식으로고쳐15/15PASS. 제품overlay whitespace1건은r6그대로보존했다. 충돌·미이식제품파일0. 기존root구조2건RED·native core잔여관문유지.
- 증거/캡처는실행폴더tmp/r7-*.log, tmp/r7-evidence/. 제품이식수행과검증기록은Done이며독립리뷰·전체회귀GREEN·병합·출시승인은미완료다.

## 8회차 — 웹 간헐 실패 대기 계약 (#824, P01~P05)

독립 검토용 한 장은 `webgpu-container-026-r8-review.md`다. 실제 제품 코드 변경 없이 권한 modal/markdown lazy import 완료를 act 안에서 명시적으로 기다리고, 중첩 트리 조회는 해당 파일 검사에만5초를 둔다. 부정 딥링크 검사도 실제 Markdown 렌더 후 수행한다. mock의 누락 skills/core 계약을 보충했다.

P04: 최종 웹 src **2805PASS/20SKIP/0FAIL**,262suitePASS/1SKIP,510.44초(`tmp/r8-web-final.log`). 1.5초 지연으로 원래 세 실패3FAIL(`r8-delay-baseline.log`), 첫 dynamicImportSettled안3FAIL(`r8-delay-fixed.log`), 최종 명시import/트리대기3PASS(`r8-delay-fixed2.log`). 최초 일반집중91PASS는 간헐성 확인용이며 최종 판정은 전수 결과다. 지연 fixture는 원복한 뒤 전수를 실행했다. 탐색 전수는 진단 편집과 겹쳐 baseline으로 쓰지 않고 중지했다.

실제 Chromium1PASS(`r8-browser-final.log`): 실제 모듈 요청1.5초/각IPC500ms,390px 승인창·Alt+N거절·openFile딥링크·중첩트리선택/Enter·overflow없음. 외부 요청 차단·retries0. Vite 실제 컴포넌트 probe이며 최종 컨테이너·전체 ChatArea·native 검증 주장이 아니다. 캡처를 열어 버튼 위계·경로·선택·좁은폭을 확인했다. 기존 modal dialog role/초기focus강제 미구현은 유지. 제품UI변경은 없고 기존6상태r7증거에 이번대기/키보드검증을 추가한다. 초기CJSdefault import·잘못된Escape시험 실패도 로그 보존 후 실제Alt+N으로 고쳤다.

Nodeoverlay/conform6PASS·70anchors·assembly·root/Shell타입PASS. TS live gate는 미등록/손상계약block과정상통과를 실제검증했다. 기존구조2건(tmp/,tsconfig.build.json)RED유지. 기본가지최초전수2594PASS/3FAIL/21SKIP(딥링크2/트리1)도 같은원인으로시험최소수정을반영했다. 트리집중4PASS, 기본가지최종전수2597PASS/21SKIP/0FAIL·247suitePASS/1SKIP·204.41초(`r8-root-final.log`). 원래r7제품overlay/포장/이미지변경없음. 원격push·운영접속·GPU·실기·게시·모델다운로드없음.

P05 Done은세종류의시험안정화·웹전수GREEN·독립검토요약작성에한정한다. 독립리뷰승인/병합·모델품질·수시간soak·원어민·실기·게시·오프라인·기존native/구조관문은미완료다.
