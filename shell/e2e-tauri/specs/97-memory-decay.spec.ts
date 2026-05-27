// E2E for memory Ebbinghaus-decay ranking (nextain/naia-os#332 Phase 2e — S106).
//
// Status: BLOCKED placeholder (this.skip()). See "Blocking dependency" below.
//
// What this spec WOULD prove (target contract, once unblocked):
//   1. Three facts of comparable surface similarity are seeded via skill_memo
//      with deterministic timestamps t-7d, t-1d, t-0.
//   2. The mock clock is advanced forward via the agent diagnostic IPC
//      `advance_clock` (planned for Phase 4) so the recall layer observes
//      the three facts at distinct apparent ages — without relying on
//      wall-clock or sleep().
//   3. A single recall query that matches all three facts is issued.
//   4. The ranking reflects Ebbinghaus decay: the t-0 (freshest) fact ranks
//      first, the t-7d (stalest) fact ranks last.
//
// Blocking dependency:
//   The CLI memory provider wired into naia-agent's `buildCliMemory`
//   (bin/naia-agent.ts:542-578) is `LiteMemoryProvider` from
//   `@nextain/naia-memory`. As of `naia-memory` 6.x:
//     • `LiteMemoryProvider.recall` ranks by raw cosine similarity only —
//       there is no time-based decay component in scoring
//       (src/memory/lite-provider.ts:163-186).
//     • `LiteMemoryProvider.consolidate` is a deliberate no-op under
//       "preservation-first" anchor #6 — no decay/prune/merge runs
//       (src/memory/lite-provider.ts:189-197).
//     • The constructor accepts no `clock` / `now` injection point
//       (src/memory/lite-provider.ts:84-101), so even if decay were added,
//       a host-side mock clock could not be threaded through.
//   The heavier `MemorySystem` class (which DOES carry Ebbinghaus decay via
//   `src/memory/decay.ts`) is exported but NOT used by the CLI memory path
//   (only `examples/hardened-sqlite-host.ts` instantiates it).
//
//   Until either (a) `LiteMemoryProvider` grows a clock-injectable decay
//   ranker, or (b) `buildCliMemory` switches the CLI to `MemorySystem` and
//   adds a clock injection hook there, the proposed Phase 4 IPC
//   `advance_clock` has nothing in-process to advance — implementing it
//   would be a no-op against the CLI memory path and would give a falsely
//   passing test. See `.agents/plans/issue-332-memory-redesign.md` §7
//   Phase 4 and §8.3 item 1.
//
// Cross-review traps to honor when this lands (codex 2026-05-27):
//   - Rename the gate env from `NAIA_E2E_MOCK_CLONE` (clone-semantics
//     collision) to `NAIA_E2E_MOCK_CLOCK` to avoid accidental
//     enablement and reader confusion.
//   - Mock-clock must be threaded into every time source the decay path
//     reads: not just `Date.now()` but any SQLite `CURRENT_TIMESTAMP` /
//     `datetime('now')` defaults, triggers, worker-thread copies of
//     `now()`, and any `createdAt` produced upstream (skill_memo in the
//     webview/Rust before the agent IPC). Mocking only one layer gives
//     false confidence.
//   - The Tauri webview + Rust IPC + Node agent are three independent
//     time domains. Memory metadata authored in webview or Rust (e.g.
//     skill_memo's `createdAt`) is too early for an agent-side mock;
//     either move authoring to the agent before mocking, or mock at the
//     true write-site.
//   - Seed facts must be controlled so cosine similarity does NOT
//     dominate the decay term — use distinctive equally-similar phrasing
//     (or deterministic embeddings) so ranking changes ONLY because of
//     age, not semantic match variance.
//   - If recall mutates `lastAccessedAt`, sequencing matters: a single
//     deterministic recall after advance_clock; don't re-recall and
//     assert (state changes between calls).
//   - Reset the offset between specs (per-test isolated DB / explicit
//     `reset_clock` IPC) so module-level state doesn't bleed.
//
// Why we ship the placeholder anyway:
//   - Records the target contract while the upstream dependency is being
//     designed, so reviewers can see exactly which assertions are pending.
//   - Slots the spec file into the 9X memory-spec sequence
//     (93 persistence, 94 multi-turn, 95 encoder-fallback, 96 backup,
//     97 decay) so spec ordering matches scenario ordering at a glance.
//   - Self-skips cleanly — never flips to a false-positive PASS when run
//     before the dependency lands.
//
// Gating:
//   - Hard skip until naia-memory exposes a clock injection point AND the
//     CLI memory path actually applies decay to ranking. Both are
//     prerequisites — neither alone is sufficient.
//   - When that lands, drop the `before(this.skip(...))` block and wire
//     the seeding + advance_clock IPC + ranking assertions per the
//     "What this spec WOULD prove" section above.

describe("97 — Memory Ebbinghaus decay ranking (#332 S106)", function () {
	this.timeout(240_000);

	before(function () {
		// Blocked on naia-memory clock injection + decay-aware ranking in
		// LiteMemoryProvider (the CLI memory path). See file header for the
		// upstream gap. Tracked under #332 Phase 4 design.
		this.skip();
	});

	it("ranks freshest fact first, stalest last after advance_clock", async () => {
		// Placeholder. Implementation pending — see file header for the
		// target contract and the blocking upstream dependency.
	});
});
