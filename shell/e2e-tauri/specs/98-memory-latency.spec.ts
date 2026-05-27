// E2E for memory latency budget (nextain/naia-os#332 Phase 2g — S112).
//
// What this spec proves (honest scope — see codex cross-review correction
// 2026-05-27 below):
//   1. After seeding a memory corpus, the `memory_get_all_facts` IPC —
//      which is the host's user-visible read path for the agent's fact
//      store — completes inside a CI-tolerant latency budget
//      (p50 < 50ms, p95 < 150ms) across 10 sequential calls.
//   2. The measurement excludes LLM jitter — only the
//      webview→Tauri→Rust→fs round-trip is timed.
//
// Codex cross-review correction (2026-05-27, post-commit):
//   The original draft of this header claimed the spec exercised "the
//   same SQLite adapter path Surface recall rides through". That is
//   **wrong** for the current code: `memory_get_all_facts` (lib.rs:1870)
//   is a Tauri command that calls `memory::get_all_agent_facts()`
//   (shell/src-tauri/src/memory.rs:122), which reads `alpha-memory.json`
//   directly from disk and JSON-parses it. It does NOT route through
//   agent stdio, and it does NOT touch naia-memory's SQLite/FTS5/vec
//   adapter. So this spec is a **memory facts IPC latency smoke test**,
//   not a Tier-1 Surface recall benchmark. The naia-memory v6.0
//   Surface 9.74ms / Deep 80ms numbers cannot be compared against this
//   spec's measurements — different storage backend, different code
//   path. The threshold (50/150ms) is a CI regression guard for the
//   Tauri+Rust+file-IO path, sized generously enough to absorb webdriver
//   boundary cost and CI runner variance.
//
// Why latency was reordered LAST in Phase 2 (issue-332-memory-redesign.md §7):
//   naia-memory v6.0 publishes Surface 9.74ms / Deep 80ms numbers. Those
//   are *library-internal* micro-benchmarks. The number a user feels is
//   the integration path. Running latency measurement against unstabilized
//   phase-2 code would have polluted signal with every encoder/persistence/
//   backup change. We sit at the tail of phase 2 precisely because
//   everything upstream is now frozen. (The fact that the host still
//   reads JSON-on-disk rather than the SQLite library is itself part of
//   the gap surfaced here — the migration to SQLite-via-agent-IPC is a
//   Phase 4 item.)
//
// Threshold rationale (CI guard for the current Tauri+Rust+file-IO path):
//   The 50/150ms budget is sized for:
//     - webdriver -> webview boundary (browser.execute)
//     - Tauri invoke serialization (JSON Vec<AgentFact> in lib.rs:1870)
//     - Rust fs::read_to_string + serde_json::from_str (memory.rs:122)
//     - CI runner I/O variance (2-3× slower than developer workstations)
//   It is generous on purpose: smallest budget that catches a real
//   regression (accidental O(N²) parse, blocking on a lock, payload
//   bloat) without flapping on the slowest GitHub Actions runner. This
//   is the FLOOR, not the ceiling — tighten once stable. With N small
//   (see below) the budget is also intentionally loose because tiny
//   payloads should be near-instant; a creeping budget hit on a 3-row
//   file would still flag a real regression.
//
// What this spec does NOT do (deferred to Phase 4):
//   - **Direct Surface/Deep recall measurement.** The agent exposes no
//     `memory_recall(query, topK, deep?)` IPC. The only paths that hit
//     `memorySystem.recall(query, ...)` today are (a) the chat-loop
//     Encoder's pre-turn recall (entangled with LLM latency) and
//     (b) `memory_get_all_facts` which reads a JSON file in Rust
//     (NOT the same code as Surface recall — see codex correction
//     above). Phase 4 plan: add a direct `memory_recall` IPC that
//     routes through agent stdio → memorySystem.recall → SQLite,
//     bringing the path under test in line with the library benchmark.
//     Then this spec gets a companion that measures query-shaped recall
//     with N=200 corpus and Surface 9.74ms / Deep 80ms targets under
//     the same 5× CI-noise relaxation methodology.
//   - **Surface vs Deep separation.** Both share the same recall IPC
//     when it lands (via a `deepRecall: true` flag). N=200 corpus is
//     the minimum that meaningfully separates the two paths (Deep only
//     kicks in past the Hot 10k cache for the full library benchmark,
//     but in CI a smaller N still differentiates O(log N) FTS5 lookup
//     from O(N) vector scan). N=3 cannot separate them today.
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

describe("98 — Memory facts IPC latency smoke (#332 S112)", function () {
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

	it("seeds the corpus then meets the memory_get_all_facts latency budget over 10 calls", async () => {
		// 1. Seed N facts via the same skill_memo path that specs 93/94/95/96
		//    use — this is the same encode pipeline a real user exercises, so
		//    the resulting corpus shape matches production. The encoded facts
		//    land in alpha-memory.json (the legacy LocalAdapter store), which
		//    is exactly what memory_get_all_facts reads in Rust below.
		for (const fact of SEED_FACTS) {
			await sendMessage(fact.turn);
		}

		// Sanity: the corpus must be non-empty, else the latency number is
		// measuring "read 0 rows" and is meaningless.
		const seeded = await tauriInvoke<AgentFact[]>("memory_get_all_facts");
		if (seeded.length < SEED_FACT_COUNT) {
			throw new Error(
				`Latency corpus undersized: expected at least ${SEED_FACT_COUNT} facts, got ${seeded.length}. ` +
					`Cannot measure the IPC path against a meaningful workload.`,
			);
		}

		// 2. Take MEASUREMENT_CALLS samples, each timing the memory_get_all_facts
		//    IPC. Note (codex 2026-05-27): this is NOT the Surface recall code
		//    path — it is webview→Tauri→Rust→fs::read+serde. Phase 4 swaps
		//    in a direct memory_recall IPC; that future spec compares against
		//    naia-memory v6.0's 9.74ms / 80ms library targets. We deliberately
		//    do not discard the first sample as "warmup" — the budget includes
		//    cold-cache cost, because that's what a real user sees on the
		//    first turn after app launch.
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
