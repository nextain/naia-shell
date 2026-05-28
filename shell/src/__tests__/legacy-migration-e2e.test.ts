// #337 Phase 10 — S117/S118 legacy migration e2e tests.
//
// Sits one level above the unit test at
// `shell/src/lib/__tests__/legacy-migration.test.ts`. The unit test mocks
// every collaborator (agent-ipc + config + secure-store). This e2e test
// drives `runLegacyMigration()` against a stateful in-memory secure-store
// (real `secure-store.ts` reads/writes against a fake Tauri Store) plus a
// stubbed agent IPC layer that simulates the two relevant agent responses.
//
// Coverage:
//   * S117 — happy path: `secure-keys.dat:naiaKey` slot exists, agent is
//     not logged in, agent acks the migrate IPC → `runLegacyMigration()`
//     returns `kind: "migrated"`, both `naiaKey` and `apiKey` slots are
//     purged from secure-store (D3 garbage cleanup), and the migrate IPC
//     was invoked exactly once with the legacy key.
//   * S118 — ack failure: same precondition, but the agent returns
//     `{ ok: false, reason: "agent_disk_error" }`. Result is
//     `kind: "failed"`, the failure listener fires with the reason, the
//     `naiaKey` slot is LEFT INTACT so the user can retry, and no
//     `auth_changed` side effect is observable (we don't subscribe to one
//     here — agent-ipc-side concern, covered in the bin dispatcher).
//
// State isolation: the in-memory store is created fresh in each `beforeEach`
// and the `legacy-migration` module's in-process promise cache is reset via
// `__resetLegacyMigrationForTest()`. No real Tauri runtime / disk I/O.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory store stand-in for the real `@tauri-apps/plugin-store`. Stateful
// so the test exercises the REAL secure-store.ts file (which is what S117/S118
// in the task brief call for) instead of the unit test's per-method mock.
const storeData = new Map<string, unknown>();
vi.mock("@tauri-apps/plugin-store", () => {
	const store = {
		get: vi.fn(async (k: string) => storeData.get(k)),
		set: vi.fn(async (k: string, v: unknown) => {
			storeData.set(k, v);
		}),
		delete: vi.fn(async (k: string) => {
			storeData.delete(k);
		}),
	};
	return { load: vi.fn().mockResolvedValue(store) };
});

// Mock agent-ipc — this is the "agent IPC layer that simulates real
// responses" per task brief. We control whether the agent is logged-in and
// whether the migrate ack succeeds.
const mockAgentAuthQuery = vi.fn();
const mockAgentAuthLegacyMigrate = vi.fn();
vi.mock("../lib/agent-ipc.js", () => ({
	agentAuthQuery: (...args: unknown[]) =>
		(mockAgentAuthQuery as unknown as (...a: unknown[]) => unknown)(...args),
	agentAuthLegacyMigrate: (...args: unknown[]) =>
		(mockAgentAuthLegacyMigrate as unknown as (...a: unknown[]) => unknown)(
			...args,
		),
	resolveAuthMode: () => "prod",
}));

// Real localStorage is provided by happy-dom (default vitest env); loadConfig
// reads from there. We don't seed it for S117/S118 — userId stays undefined.
// Logger is real; route Logger debug/warn to noop to keep test output clean.
vi.mock("../lib/logger.js", () => ({
	Logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// Imports must come AFTER the vi.mock calls.
import {
	deleteSecretKey,
	getSecretKey,
	saveSecretKey,
} from "../lib/secure-store.js";
import {
	__resetLegacyMigrationForTest,
	onLegacyMigrationFailed,
	runLegacyMigration,
} from "../lib/legacy-migration.js";

beforeEach(() => {
	storeData.clear();
	mockAgentAuthQuery.mockReset();
	mockAgentAuthLegacyMigrate.mockReset();
	__resetLegacyMigrationForTest();
});

afterEach(() => {
	__resetLegacyMigrationForTest();
});

// --- S117 — happy path ------------------------------------------------------

describe("#337 Phase 10 — S117 legacy migration happy path", () => {
	it("legacy slot + agent not logged in + ack ok → migrated, slot purged, IPC called once", async () => {
		// Pre-populate the legacy state via the REAL secure-store API. Also seed
		// the D3 stale-garbage `apiKey` slot so we can verify it's purged too.
		await saveSecretKey("naiaKey", "gw-legacy-test-117");
		await saveSecretKey("apiKey", "garbage-1");
		expect(await getSecretKey("naiaKey")).toBe("gw-legacy-test-117");
		expect(await getSecretKey("apiKey")).toBe("garbage-1");

		// Agent IPC stubs: not logged in, ack the migrate call.
		mockAgentAuthQuery.mockResolvedValue({ loggedIn: false });
		const migrateCalls: unknown[] = [];
		mockAgentAuthLegacyMigrate.mockImplementation(async (args: unknown) => {
			migrateCalls.push(args);
			return { ok: true };
		});

		const result = await runLegacyMigration();

		expect(result).toEqual({ kind: "migrated", mode: "prod" });

		// Migrate IPC called exactly once with the legacy key.
		expect(mockAgentAuthLegacyMigrate).toHaveBeenCalledTimes(1);
		expect(migrateCalls[0]).toEqual({
			mode: "prod",
			naiaKey: "gw-legacy-test-117",
		});

		// Both the naiaKey AND the D3 stale-garbage apiKey slots are gone.
		expect(await getSecretKey("naiaKey")).toBeNull();
		expect(await getSecretKey("apiKey")).toBeNull();
	});

	it("no failure listener events on the happy path", async () => {
		await saveSecretKey("naiaKey", "gw-legacy-test-117b");
		mockAgentAuthQuery.mockResolvedValue({ loggedIn: false });
		mockAgentAuthLegacyMigrate.mockResolvedValue({ ok: true });

		const failures: string[] = [];
		onLegacyMigrationFailed((reason) => failures.push(reason));

		const result = await runLegacyMigration();
		expect(result.kind).toBe("migrated");
		expect(failures).toEqual([]);
	});
});

// --- S118 — ack failure -----------------------------------------------------

describe("#337 Phase 10 — S118 legacy migration ack failure", () => {
	it("legacy slot + agent not logged in + ack fail → failed, slot preserved, listener fires", async () => {
		// Pre-populate the legacy state.
		await saveSecretKey("naiaKey", "gw-legacy-test-118");
		await saveSecretKey("apiKey", "garbage-2");

		mockAgentAuthQuery.mockResolvedValue({ loggedIn: false });
		mockAgentAuthLegacyMigrate.mockResolvedValue({
			ok: false,
			reason: "agent_disk_error",
		});

		const failures: string[] = [];
		const unsub = onLegacyMigrationFailed((reason) => failures.push(reason));

		const result = await runLegacyMigration();

		expect(result.kind).toBe("failed");
		if (result.kind === "failed") {
			expect(result.reason).toBe("agent_disk_error");
		}

		// Listener fired exactly once with the agent-provided reason.
		expect(failures).toEqual(["agent_disk_error"]);

		// HARD-FAIL invariant: the legacy slot is left intact so the user can
		// retry. The D3 stale-garbage `apiKey` slot is also untouched (purge is
		// gated on a successful migration in legacy-migration.ts).
		expect(await getSecretKey("naiaKey")).toBe("gw-legacy-test-118");
		expect(await getSecretKey("apiKey")).toBe("garbage-2");

		unsub();
	});

	it("ack failure with missing reason field falls back to agent_returned_not_ok", async () => {
		await saveSecretKey("naiaKey", "gw-legacy-test-118c");

		mockAgentAuthQuery.mockResolvedValue({ loggedIn: false });
		mockAgentAuthLegacyMigrate.mockResolvedValue({ ok: false });

		const failures: string[] = [];
		onLegacyMigrationFailed((reason) => failures.push(reason));

		const result = await runLegacyMigration();
		expect(result.kind).toBe("failed");
		if (result.kind === "failed") {
			expect(result.reason).toBe("agent_returned_not_ok");
		}
		expect(failures).toEqual(["agent_returned_not_ok"]);

		// Slot still intact.
		expect(await getSecretKey("naiaKey")).toBe("gw-legacy-test-118c");
	});

	it("subsequent retry attempt after ack failure can succeed without re-seeding", async () => {
		// Establishes that a user can re-trigger the migration after a transient
		// agent failure — the slot is preserved exactly for this scenario.
		await saveSecretKey("naiaKey", "gw-legacy-test-118-retry");

		// Attempt #1 — fails.
		mockAgentAuthQuery.mockResolvedValueOnce({ loggedIn: false });
		mockAgentAuthLegacyMigrate.mockResolvedValueOnce({
			ok: false,
			reason: "agent_disk_error",
		});
		const first = await runLegacyMigration();
		expect(first.kind).toBe("failed");
		expect(await getSecretKey("naiaKey")).toBe("gw-legacy-test-118-retry");

		// Reset the in-process single-flight cache (simulates a user clicking
		// "retry" in the UI which re-invokes the migration entrypoint).
		__resetLegacyMigrationForTest();

		// Attempt #2 — succeeds.
		mockAgentAuthQuery.mockResolvedValueOnce({ loggedIn: false });
		mockAgentAuthLegacyMigrate.mockResolvedValueOnce({ ok: true });
		const second = await runLegacyMigration();
		expect(second.kind).toBe("migrated");
		expect(await getSecretKey("naiaKey")).toBeNull();
	});

	it("listener unsubscribe stops further failure events", async () => {
		await saveSecretKey("naiaKey", "gw-legacy-test-118-unsub");
		mockAgentAuthQuery.mockResolvedValue({ loggedIn: false });
		mockAgentAuthLegacyMigrate.mockResolvedValue({
			ok: false,
			reason: "boom",
		});

		const calls: string[] = [];
		const unsub = onLegacyMigrationFailed((r) => calls.push(r));
		unsub();

		await runLegacyMigration();
		expect(calls).toEqual([]);

		// Sanity: slot still preserved on hard fail.
		expect(await getSecretKey("naiaKey")).toBe("gw-legacy-test-118-unsub");

		// Cleanup: ensure no leaked listeners from this test reach other suites.
		await deleteSecretKey("naiaKey");
	});
});
