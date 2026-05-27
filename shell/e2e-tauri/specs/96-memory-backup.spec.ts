// E2E for memory backup export/import round-trip (nextain/naia-os#332 Phase 2f — S111).
//
// What this spec proves:
//   1. Seed 3 distinct facts via `skill_memo` natural language (same encode
//      path that specs 93/94/95 exercise).
//   2. Snapshot the agent's fact set via `memory_get_all_facts` IPC (id +
//      content). This is the canonical baseline the round-trip must restore.
//   3. Export an encrypted backup blob via `memory_export_backup` IPC with
//      a session-local password (AES-256-GCM + PBKDF2-SHA256 per naia-memory
//      v6.0 — see naia-memory/GEMINI.md §6 and agent/index.ts:1204-1218).
//   4. Wipe local memory by iterating `memory_delete_fact` over every fact id
//      until `memory_get_all_facts` returns []. (factory_reset would also
//      wipe non-memory state; per-fact delete keeps the wipe scoped to the
//      assertion under test.)
//   5. Import the same blob via `memory_import_backup` with the same password.
//   6. Re-query `memory_get_all_facts`: count must equal the pre-wipe count,
//      and every pre-wipe `content` string must reappear.
//
// Why this matters (issue-332-memory-redesign.md §7):
//   The Settings UI's backup panel (SettingsTab.tsx:48-50 imports
//   exportMemoryBackup/importMemoryBackup from src/lib/db.ts) is the user's
//   only "move my memory to another machine" / "snapshot before a risky
//   change" surface. Encryption is assumed valid (naia-memory v6.0 spec —
//   AES-256-GCM round-trip is unit-tested in the library); this spec proves
//   the *integration* path: shell IPC → Rust → agent stdio → memorySystem
//   → adapter export/import, and back, without losing facts.
//
// Backup password lifecycle (issue-332-memory-redesign.md §8.2 decision):
//   Per cross-review consensus, the password is **session-local only** in
//   Phase 2 — never persisted to secure-store, never written to localStorage,
//   never logged. This spec mirrors that decision: the password lives in a
//   `const` inside this `describe` block, is passed by value into the two
//   IPC calls, and falls out of scope when the suite ends. No cleanup needed
//   because nothing persisted it in the first place. (If Phase 3 ever adds
//   a "background backup" toggle that opts into secure-store, a follow-up
//   spec will assert the persistence behavior — out of scope here.)
//
//   Gemini cross-review (2026-05-27, on this spec) flagged 3 incidental
//   serialization paths where the password value *could* surface even
//   though we never persist it intentionally:
//     (a) webdriver/ndjson trace artifacts under e2e-tauri/.artifacts/ if
//         the `browser.execute` argument is logged by the driver,
//     (b) Tauri IPC tracing / Rust debug logs that dump payloads,
//     (c) mocha assertion-failure messages echoing the IPC args.
//   For this *test* password — freshly generated per run, never reused,
//   backing only the transient blob created in (3) and discarded in (6) —
//   the leak risk is bounded: an attacker who exfiltrates the trace also
//   has the blob (both live in the same artifacts dir) so the password
//   reveals nothing they don't already have. We therefore accept (a)/(b)/(c)
//   for this e2e spec. The same shortcut would NOT be acceptable in
//   production Settings UI code, where Phase 3 will route the password
//   through a `<input type="password">` UI element rather than a raw IPC
//   payload visible to dev tooling.
//
// Deferred dependency (out of scope for this spec):
//   #327 disabled the backup-panel UI controls. The IPC layer
//   (memory_export_backup / memory_import_backup in lib.rs:1883-1977 and
//   src/lib/db.ts:32-47) is still wired and callable — this spec drives it
//   directly through tauriInvoke, so it does NOT depend on the UI being
//   re-enabled. Once #327's separate fix re-exposes the UI buttons, a
//   UI-level click-through spec can be added; this lower-level contract
//   test is the floor.
//
// Gating:
//   - Requires NAIA_API_KEY (or CAFE_E2E_API_KEY/GEMINI_API_KEY). Without an
//     LLM key, the agent cannot route `skill_memo` reliably during the seed
//     turns — spec self-skips, matching specs 91/93/94/95.

import { sendMessage } from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";
import { ensureAppReady } from "../helpers/settings.js";

const GEMINI_KEY =
	process.env.CAFE_E2E_API_KEY || process.env.GEMINI_API_KEY || "";
const NAIA_KEY = process.env.NAIA_API_KEY || "";
const HAS_AUTH = !!(GEMINI_KEY || NAIA_KEY);

// Three distinct seed facts — phrased so they share no content tokens, so a
// missing-content assertion (every pre-wipe content reappears) is meaningful.
// Each is volunteered as a natural-language self-description so the agent's
// memory pipeline encodes it via the normal Encoder path (same code path the
// production Settings → Backup flow restores into).
const SEED_FACTS: { sentinel: string; turn: string }[] = [
	{
		sentinel: "BackupTesterAlpha",
		turn: "내 이름은 BackupTesterAlpha이고 부산에 살아. skill_memo 도구로 반드시 저장해줘.",
	},
	{
		sentinel: "BackupTesterBeta-청록색",
		turn: "내가 가장 좋아하는 색은 청록색이야. 별칭은 BackupTesterBeta-청록색이고 skill_memo 도구로 반드시 저장해줘.",
	},
	{
		sentinel: "BackupTesterGamma-1987",
		turn: "내 생일 키워드는 BackupTesterGamma-1987이야. skill_memo 도구로 반드시 저장해줘.",
	},
];

// Session-local password — generated fresh per suite run, lives only inside
// this closure. Not persisted, not logged at INFO level. (Print masked tail
// only if the spec fails for triage, never the full value.)
const BACKUP_PASSWORD = `e2e-backup-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/** Invoke a Tauri command from inside the webview.
 *  Same pattern as 24-adk-setup-flow.spec.ts:48-74 — uses Tauri 2's
 *  `__TAURI_INTERNALS__` (always present) with __TAURI__.core fallback. */
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

// AgentFact shape matches src/lib/db.ts:6-18 (agent/src/memory/types.ts Fact).
interface AgentFact {
	id: string;
	content: string;
}

async function getAllFacts(): Promise<AgentFact[]> {
	return tauriInvoke<AgentFact[]>("memory_get_all_facts");
}

/** Assert that every sentinel token appears somewhere in the fact set's
 *  content strings. Returns the list of sentinels that were missing
 *  (empty = all present). */
function missingSentinels(facts: AgentFact[], sentinels: string[]): string[] {
	const blob = facts
		.map((f) => f.content)
		.join("\n")
		.toLowerCase();
	return sentinels.filter((s) => !blob.includes(s.toLowerCase()));
}

describe("96 — Memory backup export/import round-trip (#332 S111)", function () {
	// Seed × 3 LLM round-trips + export + per-fact wipe + import = long.
	this.timeout(360_000);

	// Captured before wipe; verified after import.
	let preWipeFacts: AgentFact[] = [];
	let backupBlob: number[] = [];

	before(async function () {
		if (!HAS_AUTH) {
			console.log(
				"[96-memory-backup] No NAIA_API_KEY / GEMINI key — skipping (LLM auth required for skill_memo seeding)",
			);
			this.skip();
			return;
		}
		await ensureAppReady();
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	it("seeds three distinct facts via skill_memo", async () => {
		for (const fact of SEED_FACTS) {
			await sendMessage(fact.turn);
		}

		// Read the resulting fact set straight from the agent's memory store.
		// We don't compare against the LLM's transcribed acknowledgements —
		// the actual encode is what's under test here.
		preWipeFacts = await getAllFacts();

		// The Encoder may collapse synonyms or split one turn into multiple
		// facts, so we don't pin an exact count. We DO assert each sentinel
		// landed somewhere in the corpus — that's the necessary precondition
		// for the round-trip assertion below to be meaningful.
		const missing = missingSentinels(
			preWipeFacts,
			SEED_FACTS.map((f) => f.sentinel),
		);
		if (missing.length > 0) {
			throw new Error(
				`skill_memo seeding did not record sentinels: ${missing.join(", ")}. ` +
					`Cannot run backup round-trip without a baseline. Fact count=${preWipeFacts.length}.`,
			);
		}
		// At least one fact per seed turn must exist.
		if (preWipeFacts.length < SEED_FACTS.length) {
			throw new Error(
				`Expected at least ${SEED_FACTS.length} facts after seeding, got ${preWipeFacts.length}`,
			);
		}
	});

	it("exports an encrypted backup with a session-local password", async () => {
		// memory_export_backup returns Vec<u8> on the Rust side, which arrives
		// as `number[]` over the IPC bridge (lib.rs:1912-1923 maps the
		// agent's Array.from(Uint8Array) back to bytes).
		backupBlob = await tauriInvoke<number[]>("memory_export_backup", {
			password: BACKUP_PASSWORD,
		});

		// Sanity bounds: AES-256-GCM ciphertext + PBKDF2 salt + IV + auth tag
		// adds a non-trivial floor even for an empty payload. With 3+ facts
		// the blob must be comfortably larger than the framing overhead.
		// 64 bytes is well below any realistic encrypted payload — anything
		// smaller is "empty / framing-only", which would mean facts didn't
		// reach the export path.
		if (!Array.isArray(backupBlob) || backupBlob.length < 64) {
			throw new Error(
				`Backup blob suspiciously small (length=${backupBlob?.length ?? "n/a"}); ` +
					`expected encrypted ciphertext with ${preWipeFacts.length} facts inside.`,
			);
		}
	});

	it("wipes local memory via per-fact deletion", async () => {
		// Use per-fact delete (memory_delete_fact) instead of factory_reset:
		// factory_reset would also clear session state, secure-store, etc.,
		// which would pollute this spec's signal. We want a memory-only wipe
		// so the post-import assertion is "did the backup restore the facts"
		// and nothing else.
		for (const fact of preWipeFacts) {
			await tauriInvoke<boolean>("memory_delete_fact", { factId: fact.id });
		}

		const remaining = await getAllFacts();
		if (remaining.length !== 0) {
			// Some facts may have been added by the agent between our snapshot
			// and the wipe loop (e.g., a system-generated fact from a prior
			// turn). Retry once for the residue before failing.
			for (const fact of remaining) {
				await tauriInvoke<boolean>("memory_delete_fact", { factId: fact.id });
			}
			const stillRemaining = await getAllFacts();
			if (stillRemaining.length !== 0) {
				throw new Error(
					`Memory wipe incomplete: ${stillRemaining.length} fact(s) survived two delete passes.`,
				);
			}
		}
	});

	it("imports the backup and restores every pre-wipe fact", async () => {
		// Same password as export — by design these are coupled in the same
		// session-local variable. A mismatch would surface as decryption
		// failure from the agent's importBackup (naia-memory raises
		// "Backup decryption failed" — the user-facing string in the manual
		// at .users/guides/manual/memory.md once it ships).
		await tauriInvoke<void>("memory_import_backup", {
			blob: backupBlob,
			password: BACKUP_PASSWORD,
		});

		const postImportFacts = await getAllFacts();

		// Count check — must match the pre-wipe baseline. If the import
		// dropped facts on the floor the count diverges here.
		if (postImportFacts.length !== preWipeFacts.length) {
			throw new Error(
				`Fact count diverged after import: pre-wipe=${preWipeFacts.length}, ` +
					`post-import=${postImportFacts.length}. Backup round-trip lost data.`,
			);
		}

		// Content check — every original `content` string must reappear
		// somewhere in the restored set. We compare on content (not id)
		// because the import path may legitimately rewrite ids while
		// preserving semantic content; what the user cares about is "my
		// facts came back", not "my row ids came back".
		const preContents = new Set(preWipeFacts.map((f) => f.content));
		const postContents = new Set(postImportFacts.map((f) => f.content));
		const missing: string[] = [];
		for (const c of preContents) {
			if (!postContents.has(c)) missing.push(c);
		}
		if (missing.length > 0) {
			throw new Error(
				`Content diverged after import. Missing ${missing.length} fact(s): ` +
					`${missing.map((m) => JSON.stringify(m.slice(0, 60))).join(", ")}`,
			);
		}

		// Spot-check sentinels too — defensive, in case content normalization
		// (whitespace, trim) silently moved tokens around between encode and
		// re-import. Sentinels are unique enough to survive any sane
		// normalization.
		const missingSentinelTokens = missingSentinels(
			postImportFacts,
			SEED_FACTS.map((f) => f.sentinel),
		);
		if (missingSentinelTokens.length > 0) {
			throw new Error(
				`Post-import sentinels missing: ${missingSentinelTokens.join(", ")}`,
			);
		}
	});
});
