import { test } from "@playwright/test";

/**
 * 미구현 UC 백로그 — *명시적 fixme 표식*. 통과/커버리지 위장이 아니라, 시나리오 구조를 미리 박아두고
 * 해당 UC 가 새 core 에 배선되면 fixme 를 풀어 실 UI 자동구동 통합테스트로 채운다.
 *
 * 현재 새 core 런타임 배선 완료 = UC1(텍스트 + chat-turn 변종)뿐. 아래는 assembly-matrix-2026-06-10.md
 * 기준 pending — 미구현 상태로 통과 테스트를 쓰면 vapor 테스트가 되므로 fixme 로만 둔다.
 * (`빈슬롯=RED` 원칙 — 미실현 시나리오는 초록으로 위장하지 않는다.)
 *
 * 채우는 방법: 해당 UC 포트가 배선되면 uc1-new-core.spec.ts 패턴(실 UI 구동 + 실 계약 동일 바이트 mock)
 * 으로 test.fixme → test 로 전환.
 */

test.describe("UC 백로그 (새 core 미배선 — 구현 시 fixme 해제)", () => {
	// UC2 음성대화 — H-sensory(SensoryPort, STT/오디오 입력) → … → H-express(ExpressionPort, TTS/아바타).
	// 현재 음성은 옛 경로(naia_realtime_server :8892 → naia-omni)로 직행, 새 core 미경유.
	// 시나리오: 사용자 음성 입력 → STT → chat → TTS 응답 + 아바타 립싱크. (matrix UC2 / S14 omni·S17 tts)
	test.fixme("UC2 음성대화: 음성 입력 → 응답 음성/아바타 (SensoryPort/ExpressionPort 배선 후)", async () => {});

	// UC3 기억대화 — Chat + memory(naia-memory 트랙). 시나리오: 과거 대화 사실을 회상해 응답에 반영.
	test.fixme("UC3 기억대화: 이전 세션 사실 회상 반영 (memory 포트 배선 후)", async () => {});

	// UC4 능동회상 — memory + temporal. 시나리오: 기념일/시간 앵커로 AI 가 먼저 회상 주입.
	test.fixme("UC4 능동회상: 시간 앵커 → 능동 기억 주입 (배선 후)", async () => {});

	// UC5 도구사용 — ToolPort + Environment(실 도구 실행). 현 새 core 는 tool_use/tool_result *표시*까지만
	// (uc1-new-core-variants 에서 검증); 실제 도구 실행/승인 라운드트립은 미배선.
	test.fixme("UC5 도구사용: 실 도구 실행 라운드트립 (ToolPort 배선 후)", async () => {});

	// UC13 승인게이트 — ApprovalPort. 시나리오: 위험 도구 → 승인 요청 UI → 사용자 승인/거부 → 진행/중단.
	test.fixme("UC13 승인게이트: approval_request → 사용자 결정 → 반영 (ApprovalPort 배선 후)", async () => {});
});
