# 0.2.6 WebGPU r8 독립 검토 요약 — #794 / #824

검토 대상은 `feat/026-webgpu-on-824`의 r7 웹 커밋 `23f0e208` 다음 변경이다. 원격 push·병합·게시 없음. 독립 검토 승인은 아직 받지 않았다.

## 문제·설계

ChatArea는 PermissionModal과 ChatMarkdown을 React.lazy로 불러온다. 기존 findByText/findByRole 기본 1초에는 모듈 변환·import·React commit 시간까지 포함되어 있었다. FileTree는 root/src/nested의 비동기 조회가 차례로 렌더링된다. 1초는 제품 요구사항이 아니다. 집중 실행 성공만으로 동작 결함이 없다고 결론 내리지 않고, 1.5초 지연 주입으로 같은 실패 세 건을 재현했다.

실제 lazy 모듈의 import Promise를 act 안에서 기다린 후 DOM을 검사한다. FileTree는 act로 즉시 완료되는 IPC/효과를 flush하고, 파일 표시 검사에만 5초 한도를 둔다. 클릭·workspace 활성화·선택·scroll 단언은 유지한다. 상대 경로/코드 블록 부정 검사도 실제 Markdown 로딩 후 수행해 빈 Suspense 화면을 잘못 통과시키지 않는다. 타임아웃 전역 변경·시험 재시도·제품 모듈 mock 대체 없음.

## 바뀐 파일

| 파일(웹 작업 트리 기준) | 변경 |
|---|---|
| packages/shell/src/components/__tests__/ChatArea.test.tsx | 실제 PermissionModal import와 React commit 대기 |
| packages/shell/src/components/__tests__/chat-deeplink.test.tsx | 실제 ChatMarkdown 완료 대기, 누락된 skills/core mock 계약 보충 |
| packages/shell/src/apps/workspace/__tests__/file-tree-reveal.test.tsx | 재귀 조회 렌더 flush·해당 파일 조회 5초 한도 |
| packages/shell/e2e/web-async-boundaries.spec.ts | 실제 Chromium 모듈 1.5초 지연·IPC 각500ms·390px·Alt+N·딥링크·Enter 선택 |
| docs/user-scenarios.md / docs/requirements.md | UC/FR-WEBGPU-CONTAINER-026-R8·P01~P05 |
| docs/progress/webgpu-container-026-20261103.md / 이 문서 | 원인·검증·한계 |
| .agents/context/process-status.json | 세션·게이트 현황 |

기본 가지 `/home/nextain/work/026-shell-gpu`에는 동일 세 시험 수정과 문서·상태만 반영한다. 제품 TS/TSX/CSS·Worker·Rust·compose·overlay·lockfile은 이번에 변경하지 않는다. r7 이미지/배포 바이트를 새 이미지 검증으로 재포장해 주장하지 않는다.

## 검증·위험

실행 폴더 `/home/nextain/work/codex-runs/026-webgpu/tmp`의 r8-delay-baseline.log는3FAIL, r8-delay-fixed2.log는3PASS(88비대상skip)다. 첫 보완안(dynamicImportSettled)은3FAIL이므로 폐기했다. r8-focused-before/after.log의91PASS는 첫 보완안 시점 결과이며 최종 전체 회귀가 판정 근거다. r8-browser-final.log는 Chromium 실제 컴포넌트 검증이다. 실제 ChatArea 결합은 전체 Vitest가 담당하고 browser probe는 실제 modal/markdown/tree 컴포넌트와 IPC fixture 경계다. 외부 네트워크 차단·GPU/모델 다운로드 없음.

최종 전체 웹2805PASS/20SKIP/0FAIL, 기본 가지2597PASS/21SKIP/0FAIL이다. 진행 문서 R8 P04에 로그를 연결했다. r8-web-before.log는 실행 중 진단 fixture 편집이 겹친 탐색 실행이므로 순수 baseline 판정에 쓰지 않는다. root 최초 전수 시험에서 딥링크2건·파일 트리1건 실패가 재현되어 같은 최소 수정을 반영했다. 트리 집중4case와 기본 가지 최종 전수2597PASS/21SKIP/0FAIL도 통과했다. 기존 루트 구조2건(tmp/, tsconfig.build.json) RED와 native/기기/품질 관문은 유지한다.

위험: 이 수정은 시험의 잘못된 시간 가정을 없애며 실제 느린 화면 UX 개선을 의미하지 않는다. FileTree가 끝내 나타나지 않으면5초 내 실패한다. 브라우저 시험은 Vite dev 실제 컴포넌트이며 최종 컨테이너·실 GPU·Windows/macOS 검증을 대신하지 않는다. 기존 modal에 dialog role/초기 focus 강제는 없으며 이 회차에서는 변경하지 않았다. 키보드 단축키·버튼·390px 가시성만 검증했다.

## 되돌리기·검토 순서

웹 r8 커밋을 `git revert <웹 r8 commit>`하면 시험/문서 변경만 되돌아간다. 기본 가지 기록 커밋도 별도 revert 가능하다. 데이터·모델 볼륨·OPFS migration이 없으므로 데이터 rollback은 없다. 먼저 세 시험 diff와 지연 전후 로그, 전체 회귀 수치를 확인하고 browser capture를 검토한다. 로컬 커밋 hash는 실행 폴더 result.md에 기록한다. 검토자가 승인하기 전 독립 리뷰 완료로 표시하지 않는다.
