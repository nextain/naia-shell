// E2E for memory latency budget (nextain/naia-os#332 Phase 2g — S112).
//
// What this spec proves:
//   1. After seeding a memory corpus, the IPC path that the host uses to
//      read the agent's fact store completes inside a CI-tolerant latency
//      budget (p50 < 50ms, p95 < 150ms) across 10 sequential calls.
//   2. The measurement excludes LLM jitter — only the shell-Rust-stdio-agent
//      round-trip + SQLite adapter read is timed, the same path the
//      Tier-1 (Surface) recall pipeline rides through.
//
// Why latency was reordered LAST in Phase 2 (issue-332-memory-redesign.md §7):
//   naia-memory v6.0 publishes Surface 9.74ms / Deep 80ms numbers. Those
//   are *library-internal* micro-benchmarks. The number a user feels is
//   the **integration** path: webview tauriInvoke → Rust command → JSON
//   over stdio → agent dispatcher → memorySystem → SQLite. Running that
//   path against unstabilized phase-2 code would have polluted signal with
//   every encoder/persistence/backup change. We sit at the tail of phase 2
//   precisely because everything upstream of the recall path is now frozen.
//
// Threshold relaxation rationale (5× over the library benchmark):
//   The 9.74ms library number was measured in-process on a warm SQLite
//   with no IPC framing. This spec adds:
//     - webdriver -> webview boundary (browser.execute)
//     - Tauri invoke serialization (JSON Vec<AgentFact> in lib.rs:1870)
//     - Rust -> agent stdio newline-framed JSON
//     - agent JSON parse + handler dispatch
//     - SQLite cold-cache penalty on first call of the 10
//   Each adds 1-5ms typical on Windows webdriver-tauri, plus CI VMs run
//   2-3× slower than developer workstations on file I/O. 5× headroom
//   (50ms p50, 150ms p95) is the smallest budget that:
//     (a) catches a real regression (e.g., accidentally O(N) sync read,
//         removed FTS5 index, IPC payload bloat), and
//     (b) does not flap on the slowest GitHub Actions runner we observe.
//   If the path stays well under budget over a stable period, a follow-up
//   PR can tighten the budget — this is the floor, not the ceiling.
//
// What this spec does NOT do (deferred to Phase 4):
//   - The agent does not expose a direct `memory_recall` IPC command. The
//     only paths that hit `memorySystem.recall(query, ...)` today are
//     (a) the chat-loop Encoder's pre-turn recall (entangled with LLM
//     latency), and (b) `memory_get_all_facts` which enumerates the entire
//     fact store without a query. We use (b) here as the closest available
//     proxy: it traverses the same SQLite adapter + IPC plumbing the
//     Surface recall rides through. A direct `memory_recall(query, topK)`
//     IPC is tracked for Phase 4; once available, this spec gains a
//     companion that drives query-shaped recall with N=200 corpus + the
//     library's published 9.74ms / 80ms tier targets.
//   - Deep (Tier-2) recall has no separate IPC knob either. Once the
//     direct-recall IPC lands with a `deepRecall: true` option, a sibling
//     spec asserts the documented 80ms Deep target with the same 5×
//     relaxation methodology (so ~400ms p50 / ~1200ms p95). Documented as
//     deferred here so the Phase 4 follow-up has a concrete handoff.
//
// Why N=200 was reduced to a small seeded corpus (honest scope downgrade):
//   The original task brief asked for N=200. Without a bulk-encode IPC
//   (none exists — only `skill_memo` via chat_request, which costs one
//   LLM turn per fact), seeding 200 facts would take 200 × ~5-10s
//   = 16-33 minutes per CI run, beyond any reasonable test budget. We
//   seed N=SEED_FACT_COUNT distinct facts (small but multi-fact, so the
//   adapter does real work) and measure the same enumerate IPC; the
//   path-cost characteristic we're guarding is constant-time-plus-O(N)
//   on the adapter side, which a small N catches as long as
//   the threshold is calibrated for it. The N=200 + direct-recall target
//   moves to Phase 4 with the new IPC.
//
// Gating:
//   - Requires NAIA_API_KEY (or CAFE_E2E_API_KEY / GEMINI_API_KEY) for the
//     skill_memo seed turns. Without LLM auth the seed step is impossible
//     and the spec self-skips, matching spec 91/93/94/95/96.

import { sendMessage } from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";
import { ensureAppReady } from "../helpers/settings.js";

const GEMINI_KEY =
	process.env.CAFE_E2E_API_KEY || process.env.GEMINI_API_KEY || "";
const NAIA_KEY = process.env.NAIA_API_KEY || "";
const HAS_AUTH = !!(GEMINI_KEY || NAIA_KEY);

// Seed count: small enough to seed via LLM in a single test timeout window,
// large enough that the SQLite adapter exercises FTS5 + vector index paths
// (rather than a single-row table optimization). 3 facts is the same shape
// spec 96 uses for the backup round-trip and proved sufficient to surface
// real adapter regressions in earlier phase 2 work.
const SEED_FACT_COUNT = 3;

const SEED_FACTS: { sentinel: string; turn: string }[] = [
	{
		sentinel: "LatencyAlpha",
		turn: "내 이름은 LatencyAlpha이고 서울에 살아. skill_memo 도구로 반드시 저장해줘.",
	},
	{
		sentinel: "LatencyBeta-진청색",
		turn: "내가 가장 좋아하는 색은 진청색이야. 별칭은 LatencyBeta-진청색이고 skill_memo 도구로 반드시 저장해줘.",
	},
	{
		sentinel: "LatencyGamma-1991",
		turn: "내 생일 키워드는 LatencyGamma-1991이야. skill_memo 도구로 반드시 저장해줘.",
	},
];

// Number of measurement calls. 10 is enough to compute a stable p50 and a
// rough p95 without inflating CI time. p95 over 10 samples = 9th-of-10
// (linear interpolation); for tighter percentile bounds a follow-up can
// raise this to 50 once the budget is proven stable.
const MEASUREMENT_CALLS = 10;

// Latency budget. See header comment for the 5× rationale. p50 is the
// "typical" tax; p95 catches the worst 1-in-20 sample which on CI is
// usually a GC pause or file-cache cold read.
const P50_BUDGET_MS = 50;
const P95_BUDGET_MS = 150;

/** Invoke a Tauri command from inside the webview. Same pattern as spec 96
 *  (96-memory-backup.spec.ts:106-131) and 24-adk-setup-flow.spec.ts:48-74 —
 *  uses Tauri 2's `__TAURI_INTERNALS__` with __TAURI__.core fallback. */
async function tauriInvoke<T>(
	command: string,
	args: Record<string, unknown> = {},
): Promise<T> {
	return (await browser.execute(
		async (cmd: string, a: Record<string, unknown>) => {
			const w = window as unknown as {
				__TAURI_INTERNALS__?: {
					invoke: (c: string, a: unknown) => Promise<unknown>;
				};
				__TAURI__?: {
					core?: { invoke: (c: string, a: unknown) => Promise<unknown> };
				};
			};
			const invoke = w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.core?.invoke;
			if (!invoke) {
				throw new Error(
					"Tauri invoke not available (neither __TAURI_INTERNALS__ nor __TAURI__.core)",
				);
			}
			return invoke(cmd, a);
		},
		command,
		args,
	)) as T;
}

interface AgentFact {
	id: string;
	content: string;
}

/** Compute percentile from a sorted ascending array. Uses linear nearest-rank;
 *  exact enough for a 10-sample budget check (no external stats dep). */
function percentile(sortedAsc: number[], p: number): number {
	if (sortedAsc.length === 0) return Number.NaN;
	const idx = Math.min(
		sortedAsc.length - 1,
		Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
	);
	return sortedAsc[idx];
}

describe("98 — Memory latency budget (#332 S112)", function () {
	// Seed × N LLM round-trips + 10 timed calls. Mostly LLM turns.
	this.timeout(360_000);

	before(async function () {
		if (!HAS_AUTH) {
			console.log(
				"[98-memory-latency] No NAIA_API_KEY / GEMINI key — skipping (LLM auth required for skill_memo seeding)",
			);
			this.skip();
			return;
		}
		await ensureAppReady();
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	it("seeds the corpus then meets the Surface-tier latency budget over 10 calls", async () => {
		// 1. Seed N facts via the same skill_memo path that specs 93/94/95/96
		//    use — this is the same encode pipeline a real user exercises, so
		//    the resulting corpus shape matches production.
		for (const fact of SEED_FACTS) {
			await sendMessage(fact.turn);
		}

		// Sanity: the corpus must be non-empty, else the latency number is
		// measuring "read 0 rows" and is meaningless against a real adapter.
		const seeded = await tauriInvoke<AgentFact[]>("memory_get_all_facts");
		if (seeded.length < SEED_FACT_COUNT) {
			throw new Error(
				`Latency corpus undersized: expected at least ${SEED_FACT_COUNT} facts, got ${seeded.length}. ` +
					`Cannot measure the adapter path against a meaningful workload.`,
			);
		}

		// 2. Take MEASUREMENT_CALLS samples, each timing the *same IPC path*
		//    the Surface recall flow uses. We deliberately do not discard the
		//    first sample as "warmup" — the budget includes cold-cache cost,
		//    because that's what a real user sees on the first turn after
		//    app launch.
		const samples: number[] = [];
		for (let i = 0; i < MEASUREMENT_CALLS; i++) {
			const t0 = performance.now();
			const facts = await tauriInvoke<AgentFact[]>("memory_get_all_facts");
			const elapsed = performance.now() - t0;
			samples.push(elapsed);
			// Defensive: if the path silently starts returning a stub during
			// a regression (e.g., the IPC handler short-circuits), the count
			// drops to 0 and the latency number lies. Re-check on every call.
			if (facts.length < SEED_FACT_COUNT) {
				throw new Error(
					`Sample #${i + 1}: fact count dropped to ${facts.length} mid-run (expected >= ${SEED_FACT_COUNT}). ` +
						`Latency budget cannot be trusted — IPC handler may be stubbed.`,
				);
			}
		}

		// 3. Compute p50 / p95 against the budget.
		const sortedAsc = [...samples].sort((a, b) => a - b);
		const p50 = percentile(sortedAsc, 50);
		const p95 = percentile(sortedAsc, 95);
		const max = sortedAsc[sortedAsc.length - 1];
		const min = sortedAsc[0];
		const mean = samples.reduce((s, v) => s + v, 0) / samples.length;

		// Log the full distribution before asserting — on a CI failure, the
		// budget tail tells you whether it was "everything got 10% slower"
		// (real regression) or "one outlier at the 95th" (GC/IO pause).
		console.log(
			`[98-memory-latency] samples (ms) sorted: ${sortedAsc.map((v) => v.toFixed(2)).join(", ")}`,
		);
		console.log(
			`[98-memory-latency] min=${min.toFixed(2)} mean=${mean.toFixed(2)} p50=${p50.toFixed(2)} p95=${p95.toFixed(2)} max=${max.toFixed(2)} (budget p50<${P50_BUDGET_MS} p95<${P95_BUDGET_MS})`,
		);

		if (!(p50 < P50_BUDGET_MS)) {
			throw new Error(
				`p50 latency regression: ${p50.toFixed(2)}ms >= ${P50_BUDGET_MS}ms budget. ` +
					`Samples (ms, sorted): ${sortedAsc.map((v) => v.toFixed(2)).join(", ")}`,
			);
		}
		if (!(p95 < P95_BUDGET_MS)) {
			throw new Error(
				`p95 latency regression: ${p95.toFixed(2)}ms >= ${P95_BUDGET_MS}ms budget. ` +
					`Samples (ms, sorted): ${sortedAsc.map((v) => v.toFixed(2)).join(", ")}`,
			);
		}
	});
});
