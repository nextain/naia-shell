// E2E for multi-turn memory recall in a single chat session
// (nextain/naia-os#332 Phase 2d — S101).
//
// What this spec proves:
//   1. Turn 1: user volunteers a fact ("내 이름은 MultiTurnTester").
//   2. Turn 2 (same session, no refresh, no new conversation):
//      user asks "내 이름이 뭐였지?" and the agent surfaces
//      "MultiTurnTester" in its reply.
//
//   This is the canonical memory-encode → memory-recall use case
//   inside one chat session — the simplest happy-path for the
//   retrieval pipeline that Phase 2a wired up via LiteMemoryProvider
//   with `writesEnabled: true`.
//
// Relationship to spec 93 (Phase 2b — S105):
//   - Spec 93 exercises cross-restart recall: encode → safeRefresh
//     → new conversation → recall. That spec deliberately cuts the
//     in-context window so retrieval must come from the SQLite store
//     on disk.
//   - This spec exercises the in-session multi-turn flow. Recall here
//     may legitimately come from either (a) the in-context chat
//     window the LLM already sees, or (b) the memory pipeline kicking
//     in via skill_recall / mem retrieval. Either is acceptable for
//     S101 — the assertion is "the agent surfaces the name", not
//     "the agent must hit SQLite".
//
//   The two specs together cover both legs of the encode/recall
//   pipeline (live window + persistent store) without overlapping
//   what they assert.
//
// Why semantic assertion (not literal string match):
//   - LLMs paraphrase. Acceptable responses include:
//       "당신의 이름은 MultiTurnTester입니다."
//       "MultiTurnTester 라고 하셨네요."
//       "방금 MultiTurnTester라고 알려주셨어요."
//   - The semantic judge (helpers/semantic.ts) compares against
//     the criteria string, which explicitly anchors on the
//     unique sentinel "MultiTurnTester" appearing in the response.
//
// Gating:
//   - Requires NAIA_API_KEY (or CAFE_E2E_API_KEY / GEMINI_API_KEY).
//     On environments without an LLM key the recall step cannot run —
//     the suite self-skips, mirroring spec 91 / spec 93.

import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { ensureAppReady } from "../helpers/settings.js";

const GEMINI_KEY =
	process.env.CAFE_E2E_API_KEY || process.env.GEMINI_API_KEY || "";
const NAIA_KEY = process.env.NAIA_API_KEY || "";
const HAS_AUTH = !!(GEMINI_KEY || NAIA_KEY);

const MULTITURN_NAME = "MultiTurnTester";

describe("94 — Multi-turn chat with memory (#332 S101)", function () {
	// Two sequential LLM round-trips can run long under load.
	this.timeout(240_000);

	before(async function () {
		if (!HAS_AUTH) {
			console.log(
				"[94-multi-turn-with-memory] No NAIA_API_KEY / GEMINI key — skipping",
			);
			this.skip();
			return;
		}
		await ensureAppReady();
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	it("turn 1: user volunteers a memorable name", async () => {
		await sendMessage(`내 이름은 ${MULTITURN_NAME}이야.`);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			`사용자가 자기 이름이 '${MULTITURN_NAME}'라고 알려주는 자기소개를 했다.`,
			"AI가 사용자의 자기소개를 받아들이는 자연스러운 응답을 했는가? 인사·확인·반가움 표현 모두 PASS. 에러 메시지·빈 응답·이해 못 했다는 응답은 FAIL.",
		);
	});

	it("turn 2: agent recalls the name in the same session", async () => {
		// No refresh, no new conversation — same session as turn 1.
		// The agent's recall may come from either the in-context window
		// or the memory pipeline; either route is acceptable for S101.
		await sendMessage("내 이름이 뭐였지?");

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			`사용자가 직전 턴에 자기 이름이 '${MULTITURN_NAME}'라고 알려준 적이 있고, 이번 턴에 자기 이름이 뭐였는지 묻는다.`,
			// Per gemini cross-review (2026-05-27): token-presence alone is not
			// safe — "기억 안 나, ${MULTITURN_NAME}이 뭔지 모르겠어" would pass.
			// Criteria must require affirmative identification.
			`AI가 사용자의 이름을 '${MULTITURN_NAME}'라고 명확히 긍정 응답(affirm)하는가? 대소문자 무관, 한국어 조사(님·이에요·라고 등)·마크다운 강조(**${MULTITURN_NAME}**)·패러프레이즈("당신의 이름은 ${MULTITURN_NAME}입니다", "${MULTITURN_NAME}라고 하셨네요") 모두 PASS. 단, '${MULTITURN_NAME}' 토큰이 응답에 포함되어 있더라도 (a) 기억나지 않는다/모른다 등 부정·회피, (b) 다른 이름을 말한 경우, (c) 사용자에게 다시 묻는 응답은 FAIL. 에러 메시지·빈 응답도 FAIL.`,
		);
	});
});
