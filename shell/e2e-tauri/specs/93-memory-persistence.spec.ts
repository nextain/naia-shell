// E2E for memory persistence across app restarts (nextain/naia-os#332 Phase 2b — S105).
//
// What this spec proves:
//   1. A `skill_memo`-recorded fact survives a webview reload (Phase 2a wired
//      LiteMemoryProvider with `writesEnabled: true` against a SQLite file
//      on disk, so the DB outlives the React/webview lifecycle).
//   2. After the reload, an LLM recall query can see the fact via the
//      memory-retrieval pipeline.
//
// Why `safeRefresh()` is a fair proxy for "app restart":
//   - The Tauri webview is the React surface only. Memory writes go through
//     the agent process via IPC, then into LiteMemoryProvider → SqliteAdapter
//     → `~/.naia-agent/memory/cli.sqlite` (durable, not in-memory).
//   - `browser.refresh()` recreates the entire React tree (loadOrCreateSession
//     re-runs, naia-config re-reads from localStorage, agent IPC connection
//     re-binds). What it does NOT do is kill the agent process — so this is
//     "frontend restart" not "full process restart". For the SQLite
//     persistence we want to verify, that is sufficient: writes flushed to
//     disk before refresh must be readable after refresh via a fresh agent
//     query session. Spec 08-memory already relies on this same primitive
//     for conversation-thread persistence.
//   - True full-process restart would require killing the Tauri shell PID,
//     which wdio-tauri-service does not expose mid-suite. That gap is
//     tracked under Phase 4 (agent diagnostic IPC).
//
// Gating:
//   - Requires NAIA_API_KEY (or CAFE_E2E_API_KEY/GEMINI_API_KEY). On
//     environments without a Naia gateway key + an LLM key, the recall step
//     cannot run — the spec self-skips, matching spec 91's pattern.

import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { ensureAppReady, safeRefresh } from "../helpers/settings.js";

const GEMINI_KEY =
	process.env.CAFE_E2E_API_KEY || process.env.GEMINI_API_KEY || "";
const NAIA_KEY = process.env.NAIA_API_KEY || "";
const HAS_AUTH = !!(GEMINI_KEY || NAIA_KEY);

const PERSISTENCE_NAME = "PersistenceTester";

describe("93 — Memory persistence across app restart (#332 S105)", function () {
	// Memo encode + safeRefresh + recall + LLM round-trip can run long.
	this.timeout(240_000);

	before(async function () {
		if (!HAS_AUTH) {
			// No LLM auth available — recall step is meaningless. Skip whole suite
			// (mirrors spec 91 Suite-3/4 gating).
			console.log(
				"[93-memory-persistence] No NAIA_API_KEY / GEMINI key — skipping",
			);
			this.skip();
			return;
		}
		await ensureAppReady();
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	it("should record a memorable fact via skill_memo (pre-restart)", async () => {
		await sendMessage(
			`내 이름은 ${PERSISTENCE_NAME}이야. skill_memo 도구로 반드시 저장해줘.`,
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			`사용자가 자기 이름이 '${PERSISTENCE_NAME}'라고 알려주고 skill_memo로 저장해 달라고 했다`,
			`AI가 이름 '${PERSISTENCE_NAME}'을 인지하고 저장/기억하겠다고 응답했는가? 에러 메시지·빈 응답·"저장할 수 없다"는 FAIL. 저장 완료/기억하겠다는 응답이면 PASS`,
		);
	});

	it("should recall the fact after a webview reload (post-restart)", async () => {
		// Webview reload — keeps SQLite store on disk, drops React tree.
		// safeRefresh is retry-safe against WebKitGTK UND_ERR_HEADERS_TIMEOUT.
		await safeRefresh();

		// Wait for app shell + chat input to be live again.
		const appRoot = await $(S.appRoot);
		await appRoot.waitForDisplayed({ timeout: 30_000 });
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 30_000 });

		// Start a fresh conversation so the LLM cannot cheat by reading the
		// pre-restart turn from its in-context window. Memory recall must
		// come from the persistent SQLite store, not the running chat thread.
		await browser.execute((sel: string) => {
			const btn = document.querySelector(sel) as HTMLButtonElement | null;
			if (btn) btn.click();
		}, S.newChatBtn);

		// Wait for messages to be cleared.
		await browser.waitUntil(
			async () => {
				const count = await browser.execute(
					(sel: string) => document.querySelectorAll(sel).length,
					S.userMessage,
				);
				return count === 0;
			},
			{
				timeout: 10_000,
				timeoutMsg: "New conversation did not clear after restart",
			},
		);
		await chatInput.waitForEnabled({ timeout: 10_000 });

		// Ask the agent to recall. The fact was persisted to SQLite pre-restart
		// (see test 1) — the agent's memory retrieval pipeline must surface it.
		await sendMessage("내 이름이 뭐라고 했지? 기억하는 대로 알려줘.");

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			`사용자가 자기 이름을 묻는다. 사용자는 이전 세션(앱 리프레시 이전)에 자기 이름이 '${PERSISTENCE_NAME}'라고 알려준 적이 있다.`,
			`AI가 '${PERSISTENCE_NAME}' 이름을 응답에 포함했는가? 이름이 정확히 들어가면 PASS, 아니면 FAIL. 에러나 빈 응답도 FAIL.`,
		);
	});
});
